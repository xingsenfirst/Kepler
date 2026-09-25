/**
 * 公开分享页路由 —— 挂载于根路径（/s/:id）
 *
 *  - GET  /s/:id      链接信息页：过期 / 次数用尽 / 密码表单 / 下载页
 *  - POST /s/:id      提交访问密码（表单），通过后种 Cookie 并回跳
 *  - GET  /s/:id/dl   执行下载：校验全部限制 -> 占用名额 -> 流式转发对象存储对象
 *
 * 三种限制（有效期 / 次数 / 密码）由 share-store 统一判定，可任意组合。
 * 第四种限制「付费下载」见下方 —— 未支付 / 支付中 / 支付失败一律禁止下载。
 */
const express = require('express');
const shareStore = require('./share-store');
const configStore = require('./config-store');
const statsStore = require('./stats-store');
const encStore = require('./enc-store');
const security = require('./security');
const paymentProviders = require('./payment-providers');
const paymentRules = require('./payment-rules');
const paymentOrders = require('./payment-orders');
const paymentGateway = require('./payment-gateway');
const { getClient, p, tracked } = require('./cos');
const { streamDownload } = require('./download-stream');
const { classifyDownloadSource } = require('./share-origin');
const { singleFlight } = require('./coalesce'); // R14-10：并发合并读（唯一实现点）

const router = express.Router();
router.use(express.urlencoded({ extended: false }));
// 异步通知是 JSON（微信 / PayPal），支付宝则是表单；两者都要能解析
router.use(express.json({ limit: '256kb' }));

/**
 * SEC-04：`/s/*` 的非安全方法同源校验。
 *
 * `csrfGuard`（要求自定义头 `X-Requested-With`）只挂在 `/api` 上，于是
 * `POST /s/:id`（提交访问密码）、`POST /s/:id/pay`（创建订单）、
 * `POST /s/:id/pay/check`（手动查单）可以被任意第三方页面的自动提交表单触发。
 * 危害有限（不会真的扣款），但会污染订单列表并消耗网关下单配额。
 *
 * 排除 `/pay/notify/*`：那是**支付网关**主动回调，天然跨站，且另有验签 + 限流（SEC-03）。
 *
 * 判定只在**有确凿跨站证据**时拒绝（Sec-Fetch-Site / Origin / Referer 三者任一
 * 表明来自别的站）。无来源提示的请求按直连客户端放行 —— 那不是 CSRF 场景，
 * 拒绝只会误伤脚本化使用。
 */
const SAFE_METHOD_SET = new Set(security.SAFE_METHODS || ['GET', 'HEAD', 'OPTIONS']);
router.use((req, res, next) => {
  if (SAFE_METHOD_SET.has(req.method)) return next();
  if (String(req.path || '').indexOf('/pay/notify/') === 0) return next();

  const origin = String(req.headers.origin || '').trim();
  //
  // `Origin: null`（**字符串** "null"，不透明来源）必须落到下面那套判定，不能在这里硬拒：
  // 沙箱 iframe（`<iframe sandbox>`、各类内置预览面板）、`file://` 页面、
  // https→http 降级，浏览器都会发这个字面量。它是「拿不到来源」，不是「来自别的站」——
  // 而 `new URL('null')` 会抛异常 → `ok=false` → 直接 403，于是密码页 / 支付页的
  // 表单一律提交失败（页面上只看到一句「请求来源校验失败」）。
  //
  // 安全上并不因此放松：真正的跨站证据（`Sec-Fetch-Site: cross-site`、
  // 跨站 Referer、可解析的跨站 Origin）仍由下面的 `classifyDownloadSource` 拦掉；
  // 攻击者用沙箱 iframe 造出 `Origin: null` 时，浏览器同样会带 `Sec-Fetch-Site: cross-site`。
  if (origin && origin !== 'null') {
    let ok = false;
    try {
      const u = new URL(origin);
      const proto = req.secure ? 'https:' : 'http:';
      ok = u.protocol === proto && u.host === String(req.headers.host || '');
    } catch (e) { ok = false; }
    if (!ok) {
      statsStore.addLog({ action: 'share.csrf', level: 'warn', detail: `跨站 ${req.method} ${req.path} 已拒绝（Origin：${origin}）` });
      return res.status(403).json({ error: '请求来源校验失败，已拒绝（CSRF 防护）' });
    }
    return next(); // Origin 明确同源，直接放行
  }

  const v = classifyDownloadSource({
    secFetchSite: req.headers['sec-fetch-site'],
    referer: req.headers.referer || req.headers.referrer,
    host: req.headers.host,
    secure: req.secure,
    hasTicket: false,
  });
  if (!v.allow) {
    statsStore.addLog({ action: 'share.csrf', level: 'warn', detail: `跨站 ${req.method} ${req.path} 已拒绝（${v.reason}）` });
    return res.status(403).json({ error: '请求来源校验失败，已拒绝（CSRF 防护）' });
  }
  return next();
});

const COOKIE_MAX_AGE = 7 * 24 * 3600 * 1000; // 密码通过后的 Cookie 有效期 7 天
const cookieName = (id) => 'sp_' + id;
/** 已支付订单票据（与密码票据分开存放，互不干扰） */
const payCookieName = (id) => 'sp_' + id + '_pay';

/** 轮询查单的最小间隔（毫秒）—— 与页面轮询间隔一致，避免被刷成网关压力 */
const STATUS_QUERY_MIN_GAP_MS = 3000;
const statusQueryAt = new Map(); // orderId -> 上次查单时间戳

/**
 * FUN-12：节流表必须自己收敛。
 *
 * 旧实现每个微信订单永久留一条 —— 订单只增不减，这张表就是一条单调上升的内存曲线。
 * 节流窗口只有 3 秒，超过 RETAIN 的条目再也不会被读到，留着毫无意义。
 */
const STATUS_QUERY_RETAIN_MS = 60 * 60 * 1000; // 保留 1 小时，足够覆盖最长支付会话
const STATUS_QUERY_MAX = 5000;
function noteStatusQuery(orderId) {
  const now = Date.now();
  statusQueryAt.set(orderId, now);
  if (statusQueryAt.size < 64) return; // 小规模时不做清扫，避免每次轮询都全表遍历
  for (const [k, t] of statusQueryAt) {
    if (now - t > STATUS_QUERY_RETAIN_MS) statusQueryAt.delete(k);
  }
  while (statusQueryAt.size > STATUS_QUERY_MAX) {
    const oldest = statusQueryAt.keys().next();
    if (oldest.done) break;
    statusQueryAt.delete(oldest.value);
  }
}

/* ---------------------- 付费状态判定 ---------------------- */

/**
 * 当前支付能力快照：总开关 / 渠道开关 / 凭证完整 / 可用渠道。
 * 任何异常都降级为「不可用」—— 支付读不出来时宁可让链接免费，也不要把下载者卡死。
 */
function paySnapshot() {
  try {
    const stored = configStore.getPayment();
    return Object.assign({ enabled: stored.enabled }, paymentRules.snapshot(
      stored.platforms, paymentProviders.ORDER,
      (id) => paymentProviders.isConfigured(id, stored.platforms[id]),
    ));
  } catch (e) {
    return { enabled: false, states: {}, configuredMap: {}, available: [] };
  }
}

/** 该链接「当前是否真的要付费」（全局开关与链接配置的唯一联动点） */
function paidStateFor(l) {
  const snap = paySnapshot();
  return paymentRules.resolvePaidState({
    globalEnabled: snap.enabled,
    channelStates: snap.states,
    configuredMap: snap.configuredMap,
    linkPaid: l.paid,
  });
}

/** 访问者对该链接的支付状态 */
function payerStateFor(l, req) {
  return paymentOrders.payerState(l.id, getCookie(req, payCookieName(l.id)));
}

/** 手动解析请求头中的 Cookie（避免引入 cookie-parser 依赖） */
function getCookie(req, name) {
  const h = req.headers.cookie || '';
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch (e) { return part.slice(i + 1).trim(); }
    }
  }
  return '';
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtSize(bytes) {
  bytes = Number(bytes) || 0;
  if (bytes < 1024) return bytes + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return v.toFixed(v >= 100 ? 0 : 1) + ' ' + units[i];
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ------------------------------ 页面模板 ------------------------------ */

function renderPage(res, status, { title, head, body }) {
  /**
   * R13-07：状态码白名单。全部调用方都传本地字面量（含 401 = 分享密码错误页，属本地语义），
   * 白名单把这份「本地性」变成机器可查的凭据 —— 上游状态若意外渗入（例如把云端错误码
   * 直接当页面状态）会被收敛成 500，而不会占用本地 401/403 语义。
   */
  const code = [200, 400, 401, 402, 403, 404, 410, 429, 503].indexOf(status) >= 0 ? status : 500;
  res.status(code).type('html').send(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<title>${esc(title)} - 文件分享</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
    background: #f2f5f9; color: #1b1b1b; min-height: 100vh;
    display: flex; align-items: center; justify-content: center; padding: 24px; }
  .card { background: #fff; border-radius: 14px; box-shadow: 0 8px 32px rgba(15,35,70,.08);
    width: 100%; max-width: 460px; padding: 34px 34px 28px; }
  .brand { display: flex; align-items: center; gap: 8px; color: #0067c0;
    font-weight: 600; font-size: 13px; margin-bottom: 22px; }
  .brand .logo { width: 22px; height: 22px; border-radius: 6px; background: #0067c0;
    display: inline-flex; align-items: center; justify-content: center; color: #fff; font-size: 12px; }
  h1 { font-size: 19px; margin-bottom: 6px; }
  .sub { color: #8a8f98; font-size: 13px; line-height: 1.7; }
  .meta { margin: 18px 0; border-top: 1px solid #eef1f5; }
  .meta div { display: flex; justify-content: space-between; padding: 10px 0;
    border-bottom: 1px solid #eef1f5; font-size: 13px; }
  .meta span { color: #8a8f98; }
  .meta b { font-weight: 500; max-width: 65%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .btn { display: block; width: 100%; border: 0; border-radius: 8px; cursor: pointer;
    padding: 12px; font-size: 15px; margin-top: 20px; }
  .btn.primary { background: #0067c0; color: #fff; }
  .btn.primary:hover { background: #005da8; }
  .warn { background: #fff7ed; color: #b45309; border: 1px solid #fed7aa;
    border-radius: 8px; padding: 10px 12px; font-size: 13px; margin-bottom: 14px; }
  .ok { background: #ecfdf5; color: #047857; border: 1px solid #a7f3d0;
    border-radius: 8px; padding: 10px 12px; font-size: 13px; margin-bottom: 14px; }
  input[type=password] { width: 100%; border: 1px solid #d5dbe3; border-radius: 8px;
    padding: 11px 12px; font-size: 15px; outline: none; }
  input[type=password]:focus { border-color: #0067c0; box-shadow: 0 0 0 3px rgba(0,103,192,.12); }
  .foot { margin-top: 22px; text-align: center; color: #b3b9c2; font-size: 11px; }
  .icon-big { width: 46px; height: 46px; border-radius: 12px; margin-bottom: 16px;
    display: flex; align-items: center; justify-content: center; }
  /* 卡片内的标题块统一居中：金额（.pay-amount）与二维码（.qr-box）本就是居中的，
     若标题块左对齐，同一张卡片里会出现「左标题 + 居中金额」的排版错位。
     .icon-big 是定宽 flex，text-align 管不到它，必须靠 margin 居中。 */
  .center-head { text-align: center; }
  .center-head .icon-big { margin-left: auto; margin-right: auto; }
  .pay-amount { font-size: 27px; font-weight: 600; color: #b45309; text-align: center; margin: 4px 0 2px; }
  .pay-cap { text-align: center; color: #8a8f98; font-size: 12px; }
  .pay-opts { margin: 16px 0 2px; }
  .pay-opt { display: flex; align-items: center; gap: 9px; padding: 11px 12px;
    border: 1px solid #d5dbe3; border-radius: 8px; margin-bottom: 8px; cursor: pointer; font-size: 14px; }
  .pay-opt:hover { border-color: #0067c0; background: #f6faff; }
  .pay-note { background: #fff7ed; color: #b45309; border: 1px solid #fed7aa;
    border-radius: 8px; padding: 10px 12px; font-size: 12px; margin-top: 14px; line-height: 1.7; }
  .row2 { display: flex; gap: 10px; }
  .row2 .btn { margin-top: 12px; }
  .btn.ghost { background: #fff; color: #616161; border: 1px solid #d5dbe3; }
  .btn.ghost:hover { background: #f6f8fb; }
  .qr-box { display: flex; justify-content: center; margin: 16px 0 4px; }
  .qr-box svg { width: 208px; height: 208px; border: 1px solid #e5e8ec; border-radius: 10px; padding: 6px; background: #fff; }
</style>
</head>
<body>
  <div class="card">
    <div class="brand">文件分享</div>
    ${head || ''}
    ${body || ''}
    <div class="foot">注意：该链接由分享者的存储管理系统生成，任何下载行为都会被记录。</div>
  </div>
</body>
</html>`);
}

/**
 * 状态页。
 * @param {string} state notfound | deleted | expired | exhausted | limited | crosssite
 * @param {object} l 链接视图（用于文案变量）
 * @param {string} [customMsg] 覆盖默认副标题（如限流/跨站拦截提示）
 */
function statePage(res, state, l, customMsg) {
  const map = {
    notfound: { code: 404, title: '链接不存在', sub: '该分享链接不存在或已被分享者删除。', icon: '?', bg: '#eef1f5', fg: '#8a8f98' },
    deleted: { code: 410, title: '文件已被删除', sub: '该分享链接指向的文件已被分享者删除，无法继续下载。', icon: '🗑', bg: '#f3f4f6', fg: '#6b7280' },
    expired: { code: 410, title: '链接已过期', sub: `该分享链接已于 ${l ? fmtDate(l.expiresAt) : '—'} 到期，已自动失效。`, icon: '⏱', bg: '#fff7ed', fg: '#b45309' },
    exhausted: { code: 410, title: '链接已关闭', sub: `该分享链接的下载次数已达上限（${l ? l.maxDownloads : 0} 次），已停止提供下载。`, icon: '✕', bg: '#fef2f2', fg: '#b91c1c' },
    limited: { code: 429, title: '请求过于频繁', sub: '下载请求过于频繁，请稍后重试。本次请求未占用下载次数。', icon: '⏳', bg: '#fff7ed', fg: '#b45309' },
    crosssite: { code: 403, title: '请求来源不受信任', sub: '该下载请求来自其它站点，已被拒绝。请在分享页面内点击下载。', icon: '⛔', bg: '#fef2f2', fg: '#b91c1c' },
  };
  const s = map[state] || map.notfound;
  const sub = (typeof customMsg === 'string' && customMsg) ? customMsg : s.sub;
  renderPage(res, s.code, {
    title: s.title,
    body: `
      <div class="center-head">
      <div class="icon-big" style="background:${s.bg};color:${s.fg};font-size:22px">${s.icon}</div>
      <h1>${s.title}</h1>
      <p class="sub">${esc(sub)}如有疑问，请联系分享者重新获取链接。</p>
      </div>`,
  });
}

/* ------------------------------ 信息页 ------------------------------ */

/**
 * 信息页（含下载按钮）。
 * @param {object} opts {extraRows: [[label, html]], note: string, noteKind: 'ok'|'warn'}
 */
function infoPage(res, l, opts = {}) {
  const v = shareStore.view(l);
  const remain = v.maxDownloads > 0 ? `剩余 ${Math.max(0, v.maxDownloads - v.downloads)} 次` : '不限次数';
  const extra = (opts.extraRows || []).map((r) => `<div><span>${esc(r[0])}</span><b>${r[1]}</b></div>`).join('');
  const note = opts.note ? `<div class="${opts.noteKind === 'ok' ? 'ok' : 'warn'}">${esc(opts.note)}</div>` : '';
  renderPage(res, 200, {
    title: v.fileName,
    head: `<div class="center-head">
      <div class="icon-big" style="background:#e8f1fb;color:#0067c0;font-size:20px">📄</div>
      <h1 style="word-break:break-all">${esc(v.fileName)}</h1>
      </div>`,
    body: `
      ${note}
      <div class="meta">
        <div><span>文件大小</span><b>${fmtSize(v.size)}</b></div>
        ${v.expiresAt ? `<div><span>有效期至</span><b>${fmtDate(v.expiresAt)}</b></div>` : '<div><span>有效期</span><b>永久有效</b></div>'}
        <div><span>允许被下载的次数</span><b>${remain}</b></div>
        ${v.hasPassword ? '<div><span>密码保护</span><b>已启用</b></div>' : ''}
        ${extra}
      </div>
      <a class="btn primary" href="/s/${esc(l.id)}/dl" style="text-align:center;text-decoration:none">下载文件</a>`,
  });
}

/** 付费页：展示金额与可选渠道，提交后创建订单 */

function payPage(res, l, ps, available, err, note = '') {
  const opts = available.map((id, i) => {
    const p = paymentProviders.platform(id);
    return `<label class="pay-opt"><input type="radio" name="platform" value="${esc(id)}"${i === 0 ? ' checked' : ''}> <span>${esc(p.name)}</span></label>`;
  }).join('');
  renderPage(res, err ? 400 : 200, {
    title: '付费下载',
    head: `<div class="center-head">
    
      <h1>${note ? '订单已退款，需重新支付' : '分享者要求该文件必须付费才可下载'}</h1>
      <p class="sub">${note ? '退款后的订单不再作为下载凭证，重新支付即可继续下载。' : '完成支付后即可下载，支付结果仅对该链接与当前浏览器有效。'}</p>
      </div>`,
    body: `
      ${err ? `<div class="warn">${esc(err)}</div>` : ''}
      ${note ? `<div class="warn">${esc(note)}</div>` : ''}
      <div class="pay-amount">¥${paymentRules.formatAmount(ps.amountFen)}</div>
      <div class="pay-cap">人民币（CNY）</div>
      <form method="POST" action="/s/${esc(l.id)}/pay">
        <div class="pay-opts">${opts}</div>
        <button class="btn primary" type="submit">立即支付</button>
      </form>`,
  });
}

/**
 * 已退款订单的统一提示文案（面向下载者）。
 *
 * 刻意不提"退款已到账"——本系统不知道钱是否真的退回去了，只知道管理员做了标记。
 */
function refundNote() {
  return '该笔订单已被分享者标记为已退款，原支付凭证已失效。请重新支付后再下载。';
}

/** 订单摘要（支付中 / 二维码两页共用） */
function orderMetaRows(order, extra) {
  const p = paymentProviders.platform(order.platform);
  return `
      <div><span>支付金额</span><b>¥${paymentRules.formatAmount(order.amountFen)}</b></div>
      <div><span>支付方式</span><b>${esc(p ? p.name : order.platform)}</b></div>
      <div><span>订单号</span><b>${esc(order.id)}</b></div>
      ${extra || ''}`;
}

/**
 * 支付中：等待支付结果。
 *
 * 页面每 3 秒轮询一次 `/s/:id/pay/status`；服务端在轮询时**主动向网关查单**
 * （见 payment-gateway 的设计说明），确认到账后置为已支付，页面随即自动放行。
 * 轮询只解决"能不能自动刷新"，**不参与支付结果的判定**。
 */
function payingPage(res, l, order, ps) {
  const p = paymentProviders.platform(order.platform);
  renderPage(res, 200, {
    title: '等待支付结果',
    head: `<div class="center-head">
      <div class="icon-big" style="background:#e8f1fb;color:#0067c0;font-size:20px">⏳</div>
      <h1>等待支付结果</h1>
      <p class="sub">订单已创建，请在<b>${esc(p ? p.name : order.platform)}</b>完成支付后返回本页。</p>
      </div>`,
    body: `
      <div class="meta">
        ${orderMetaRows(order, '<div><span>支付状态</span><b id="pay-state">支付中…</b></div>')}
      </div>
      <div class="pay-note">请在<b>${esc(p ? p.name : order.platform)}</b>完成支付。支付成功后本页会自动放行，无需其他操作。</div>
      <form method="POST" action="/s/${esc(l.id)}/pay/check">
        <button class="btn primary" type="submit">我已完成支付，立即查询</button>
      </form>
      <script src="/js/pay-poll.js" data-link-id="${esc(l.id)}" defer></script>`,
  });
}

/** 微信支付 Native：展示二维码并轮询支付结果 */
function qrPayPage(res, l, order, ps, charge) {
  const p = paymentProviders.platform(order.platform);
  renderPage(res, 200, {
    title: '扫码支付',
    head: `<div class="center-head">
      <div class="icon-big" style="background:#e8f1fb;color:#0067c0;font-size:20px">⏳</div>
      <h1>请使用${esc(p ? p.name : '微信')}扫码支付</h1>
      <p class="sub">支付完成后本页会自动放行，无需刷新。</p>
      </div>`,
    body: `
      <div class="pay-amount">¥${paymentRules.formatAmount(ps.amountFen)}</div>
      <div class="pay-cap">人民币（CNY）</div>
      <div class="qr-box">${charge.svg || ''}</div>
      <div class="meta">
        ${orderMetaRows(order, '<div><span>支付状态</span><b id="pay-state">等待扫码…</b></div>')}
      </div>
      <div class="pay-note">二维码由本服务本地生成，有效期以${esc(p ? p.name : '微信支付')}为准；若二维码过期，请返回上一步重新发起支付。</div>
      <a class="btn ghost" href="/s/${esc(l.id)}" style="text-align:center;text-decoration:none">放弃并重新发起</a>
      <script src="/js/pay-poll.js" data-link-id="${esc(l.id)}" defer></script>`,
  });
}

/** 支付失败：给出原因并允许重新发起 */
function payFailedPage(res, l, order, ps) {
  renderPage(res, 402, {
    title: '支付未完成',
    head: `<div class="center-head">
      <div class="icon-big" style="background:#fef2f2;color:#b91c1c;font-size:20px">✕</div>
      <h1>上一次支付未完成</h1>
      <p class="sub">${esc(order.failReason || '支付未完成或被取消')}。请重新发起支付。</p>
      </div>`,
    body: `
      <div class="meta">
        <div><span>需付金额</span><b>¥${paymentRules.formatAmount(ps.amountFen)}</b></div>
      </div>
      <a class="btn primary" href="/s/${esc(l.id)}" style="text-align:center;text-decoration:none">重新支付</a>`,
  });
}

/** 下载被拦截（未支付 / 支付中 / 支付失败） */
function payBlockedPage(res, l, ps, payer) {
  const map = {
    none: { code: 402, icon: '💰', bg: '#fdf6ec', fg: '#b45309', title: '需要付费后才能下载', sub: `该文件需支付 ¥${paymentRules.formatAmount(ps.amountFen)} 后方可下载。` },
    pending: { code: 402, icon: '⏳', bg: '#e8f1fb', fg: '#0067c0', title: '支付尚未完成', sub: '我们尚未收到支付成功的通知，请完成支付后再试。' },
    failed: { code: 402, icon: '✕', bg: '#fef2f2', fg: '#b91c1c', title: '支付未完成', sub: `上一次支付未成功：${payer.order && payer.order.failReason ? payer.order.failReason : '支付失败或被取消'}。` },
    refunded: { code: 402, icon: '↩', bg: '#f1f2f4', fg: '#616a75', title: '订单已退款', sub: refundNote() },
  };
  const s = map[payer.state] || map.none;
  renderPage(res, s.code, {
    title: s.title,
    body: `
      <div class="center-head">
      <div class="icon-big" style="background:${s.bg};color:${s.fg};font-size:22px">${s.icon}</div>
      <h1>${s.title}</h1>
      <p class="sub">${esc(s.sub)}${payer.state === 'none' ? '' : ''}</p>
      </div>
      <a class="btn primary" href="/s/${esc(l.id)}" style="text-align:center;text-decoration:none">${payer.state === 'pending' ? '查看支付状态' : '前往支付'}</a>`,
  });
}

/* --------------------- 云端对象存在性探测 --------------------- */

/**
 * 只有「云端明确回答 404」才认定对象已被删除。
 *
 * 网络抖动 / 密钥失效 / 桶不存在都会走进同一个 catch，但那**不代表文件被删** ——
 * 一律按「文件仍然存在」处理（fail-open）：最坏的结果无非是页面照常显示、点击下载时才报错。
 * 反过来误标成已删除，会让一条本来好用的链接被永久判死，代价大得多。
 */
function isNotFound(e) {
  const status = Number(e && (e.statusCode || e.status));
  if (status === 404) return true;
  const code = String((e && (e.code || e.Code)) || '');
  return code === 'NoSuchKey' || code === 'NotFound' || code === 'NoSuchObject';
}

const EXISTS_TTL_MS = 60 * 1000;
/**
 * R14-10：**探测失败**时的短 TTL。
 *
 * 失败（凭据失效 / 桶被删 / 端点不可达 / 超时）此前既不留痕、也不与成功区分，
 * 于是同一链接的每个并发请求都各打一次云端、各挂最长 120 秒（COS SDK 的
 * `Timeout`），云端调用数与费用被 N 倍放大（匿名可达、无需任何凭据）。
 *
 * 两条同时成立才算解决：① 失败也要留下**短期**缓存，把重试频率压到有界；
 * ② 窗口必须远短于成功的 60 秒 —— 一次瞬时抖动不该让整分钟的访客都看到
 * 「已删除」。5 秒既挡住了洪泛，也让故障恢复后最多 5 秒就自动重探。
 */
const EXISTS_FAIL_TTL_MS = 5 * 1000;
const EXISTS_MAX = 2000;
const existsProbe = new Map(); // linkId -> {at, ttl, missing}

/** 节流表必须自己收敛（与 statusQueryAt 同样的纪律：有 TTL 就要有清扫 + 硬上限） */
function noteExistsProbe(id, missing, now, ttl) {
  const life = Number.isFinite(ttl) && ttl > 0 ? ttl : EXISTS_TTL_MS;
  existsProbe.set(id, { at: now, ttl: life, missing });
  if (existsProbe.size <= 64) return; // 小规模不扫全表
  for (const [k, v] of existsProbe) {
    if (now - v.at > (Number.isFinite(v.ttl) && v.ttl > 0 ? v.ttl : EXISTS_TTL_MS)) existsProbe.delete(k);
  }
  while (existsProbe.size > EXISTS_MAX) {
    const it = existsProbe.keys().next();
    if (it.done) break;
    existsProbe.delete(it.value);
  }
}

/** 取命中的探测结果；每条自带 TTL（成功 60 秒 / 失败 5 秒），过期或不存在都返回 null */
function existsHit(id, now) {
  const e = existsProbe.get(id);
  if (!e) return null;
  const life = Number.isFinite(e.ttl) && e.ttl > 0 ? e.ttl : EXISTS_TTL_MS;
  return now - e.at < life ? e : null;
}

/**
 * 惰性探测：链接指向的云端对象是否还在。
 *
 * 站内删除（`/fs/delete` 等）会**当场**把链接标成 missingAt，那条路径零额外调用；
 * 这里补的是**站外删除**（控制台、生命周期规则、别的工具）—— 否则分享页照样
 * 显示下载按钮，访客点了才被告知文件没了。
 *
 * 探测结果缓存 60 秒（`EXISTS_TTL_MS`），因此每个链接对云端的探测上限是 1 次/分钟。
 *
 * R8-06：**已标记 missing 的链接同样要探测**。旧实现第一行就是
 * `if (l.missingAt) return true`，于是下面 `else if (l.missingAt) clearMissing()`
 * 永远不可达 —— `deleted` 成了不可逆的假终态：把同名文件重新上传回同一个 key，
 * 分享页恒为 410、管理页恒显示「文件已删除」，而管理页那条「若把同名文件重新上传
 * 到同一位置，链接会自动恢复」的承诺与实现完全相反。已分发的 URL 只能删链接重建。
 *
 * R14-10：再加两层 ——
 *  ① **并发去重**：旧实现把结果写进缓存的动作在 `await` **之后**，于是同一链接的
 *     一批并发请求各自发起一次 `headObject`（缓存只在探测**完成之后**才生效）。
 *     现在整段探测包在 `singleFlight` 里，并发请求共享同一次云端往返；
 *  ② **失败留痕**：非 404 的异常（凭据失效 / 桶被删 / 网络不可达）此前被外层
 *     的 `catch (e) { /* 探测失败按「文件还在」继续 *\/ }` **完全吞掉、零日志**，
 *     真实的凭据/桶故障对运维不可见。现在补一条 `share.probe` warn 日志，
 *     并写一条 5 秒的失败缓存（见 {@link EXISTS_FAIL_TTL_MS}）。
 *
 * 「非 404 一律 fail-open」的取舍**保持不变**：只有明确的 404 才算文件没了，
 * 其余按现状维持可用（同一个链接被重新上传回来时才能自动恢复）。
 */
async function probeObjectMissing(l) {
  const hit = existsHit(l.id, Date.now());
  if (hit) return hit.missing;

  return singleFlight(`share-exists:${l.id}`, async () => {
    // 排队期间可能已有结果（去重窗口内到达的请求不必再探一次）
    const again = existsHit(l.id, Date.now());
    if (again) return again.missing;

    let cfg = null;
    try { cfg = configStore.effectiveForBucket(l.bucket, l.region); } catch (e) { cfg = null; }
    // 配置不可用（密钥被解绑 / 桶被删除）时**不探测、也不改判**：
    // 若在这里把 missing 当作 false 回传并走 clearMissing，一次临时故障就会把
    // 已确认缺失的链接误恢复成「有效」。fail-open 只适用于「不确定」，
    // 不适用于「连探都没探成」—— 后者按现状维持原判。
    if (!cfg || !cfg.secretId) return Boolean(l.missingAt);

    let missing = false;
    let failed = null;
    try {
      const cos = getClient(cfg);
      await p(cos, 'headObject', { Bucket: l.bucket, Region: cfg.region || l.region, Key: l.key });
    } catch (e) {
      if (isNotFound(e)) missing = true;
      else failed = e; // 非 404：网络 / 鉴权 / 超时 —— 不改判，但必须留痕
    }
    noteExistsProbe(l.id, missing, Date.now(), failed ? EXISTS_FAIL_TTL_MS : EXISTS_TTL_MS);
    if (failed) {
      statsStore.addLog({
        action: 'share.probe', level: 'warn',
        detail: `分享链接存在性探测失败（链接 ${l.id}，桶 ${l.bucket}）：`
          + `${(failed && (failed.message || failed.code || failed.name)) || failed}`,
      });
    }
    if (missing) shareStore.markMissing(l.id);
    else if (l.missingAt) shareStore.clearMissing(l.id); // 对象被重新传回来了
    return missing;
  });
}

router.get('/s/:id', async (req, res) => {
  const l = shareStore.get(req.params.id);
  if (!l) return statePage(res, 'notfound');
  /**
   * R14-10①：本端点此前**没有任何限流器**（全文件的 limiter 调用点都不含它）。
   *
   * 它是分享页的唯一入口：渲染 + 一次惰性 `headObject` 存在性探测。匿名访客
   * 只要并发请求同一个 URL 就能把云端调用数与费用放大 N 倍，慢桶场景下还会
   * 各持一条连接最长挂满 SDK 的 120 秒超时（主站与 WebDAV 共用同一进程）。
   * 按 IP 限流（300 次/10 分钟），命中时给出与其他限流路径一致的 429 页面。
   */
  const viewRl = security.shareViewLimiter(security.clientIp(req));
  if (!viewRl.ok) {
    res.setHeader('Retry-After', String(viewRl.retryAfter));
    return statePage(res, 'limited', shareStore.view(l),
      `请求过于频繁，请 ${viewRl.retryAfter} 秒后重试。`);
  }
  let st = shareStore.status(l);
  // 只有「有效」与「已标记删除」两种状态需要探测：过期 / 次数用尽的链接
  // 本来就不提供下载，没必要为此多打一次云端；而标记过的要再探一次，
  // 因为对象可能被重新上传到同一个 key（那时应恢复为有效）。
  if (st === 'active' || st === 'deleted') {
    // 探测只是锦上添花，任何意外都不能把公开页面打挂（Express 4 不接 async 抛错）
    try {
      await probeObjectMissing(l);
      st = shareStore.status(l); // 探测可能已改写 missingAt
    } catch (e) { /* 探测失败按「文件还在」继续 */ }
  }
  if (st !== 'active') return statePage(res, st, shareStore.view(l));

  // 密码保护：校验 Cookie
  if (l.passwordHash) {
    const token = getCookie(req, cookieName(l.id));
    if (!shareStore.verifyToken(l, token)) return passwordPage(res, l, req.query.e === '1');
  } else {
    // SEC-08：无密码链接也要下发访问票据。
    //
    // 下载端点是「有副作用的 GET」，`/s/*` 不经过 CSRF 校验。若从不下发票据，
    // 任何第三方页面的 `<img src="/s/ID/dl">` 都能静默消耗下载额度。
    // 下发后 `/s/:id/dl` 可要求"先访问过分享页"—— 而票据 Cookie 是
    // `SameSite=Lax`，**跨站子资源请求不会携带**，于是 img/prefetch 天然被挡。
    const token = getCookie(req, cookieName(l.id));
    if (!shareStore.verifyToken(l, token)) {
      res.cookie(cookieName(l.id), shareStore.accessToken(l), shareCookieOptions(l.id));
    }
  }

  // ---- 付费下载（第四种限制）----
  const ps = paidStateFor(l);
  if (ps.effective) {
    const payer = payerStateFor(l, req);
    if (payer.state === 'paid') {
      return infoPage(res, l, {
        extraRows: [['付费下载', `<b>已支付 ¥${paymentRules.formatAmount(payer.order.amountFen)}</b>`]],
        note: '支付已完成，可直接下载。',
        noteKind: 'ok',
      });
    }
    if (payer.state === 'pending') return payingPage(res, l, payer.order, ps);
    if (payer.state === 'failed') return payFailedPage(res, l, payer.order, ps);
    // 已退款：票据仍然有效（能认出这个人），但不再放行下载 —— 复用付费页让他重新支付
    if (payer.state === 'refunded') {
      return payPage(res, l, ps, paySnapshot().available, '', refundNote());
    }
    const snap = paySnapshot();
    return payPage(res, l, ps, snap.available, '');
  }

  // 配置了付费但当前不生效（支付停用 / 无可用渠道）：明确告知当前免费，配置仍在
  if (ps.required) {
    return infoPage(res, l, {
      note: paymentRules.REASON_TEXT[ps.reason] || '该文件当前可免费下载。',
    });
  }

  return infoPage(res, l);
});

/* ------------------------------ 支付 ------------------------------ */

/**
 * 站点对外地址 —— 支付网关回调（notify_url）与支付完成回跳（return_url）的目标。
 *
 * 优先取管理员在支付设置里填的「站点对外地址」；未填时按当前请求的 Host 兜底。
 * 本机 127.0.0.1 收不到公网回调，因此生产环境**必须**显式配置，
 * 否则支付网关无法通知我们（页面轮询仍可用，但关掉浏览器的支付就会挂起）。
 */
function siteUrlFor(req) {
  let base = '';
  try { base = String((configStore.getPayment().siteUrl || '')).trim(); } catch (e) { base = ''; }
  if (!base) {
    const proto = (req.secure || (security.IS_DEPLOY && security.TRUST_PROXY)) ? 'https' : 'http';
    base = proto + '://' + (req.headers.host || '127.0.0.1');
  }
  return base.replace(/\/+$/, '');
}

/** 订单标题（各网关对长度有要求，统一截断） */
function chargeSubject(l) {
  return `付费下载：${l.fileName || '文件'}`.slice(0, 100);
}

/** 发起支付：创建 pending 订单 → 调网关下单 → 跳转收银台或展示二维码 */
router.post('/s/:id/pay', async (req, res) => {
  const l = shareStore.get(req.params.id);
  if (!l) return statePage(res, 'notfound');
  const st = shareStore.status(l);
  if (st !== 'active') return statePage(res, st, shareStore.view(l));
  if (l.passwordHash && !shareStore.verifyToken(l, getCookie(req, cookieName(l.id)))) {
    return res.redirect(303, '/s/' + l.id);
  }

  const ps = paidStateFor(l);
  if (!ps.effective) return res.redirect(303, '/s/' + l.id); // 已转免费，无需支付

  // 限流：同一 IP 对同一链接的支付发起（防止刷订单）
  const ip = security.clientIp(req);
  const rl = security.shareLimiter(`${ip}:${l.id}`);
  if (!rl.ok) return payPage(res, l, ps, paySnapshot().available, `操作过于频繁，请 ${rl.retryAfter} 秒后重试`);

  const platform = String((req.body && req.body.platform) || '');
  const available = paySnapshot().available;
  if (!available.includes(platform)) {
    return payPage(res, l, ps, available, '请选择一个可用的支付方式');
  }

  // R14-05：动单之前先问「这个人现在是什么支付态」—— 与 `GET /s/:id`（:571）和
  // `/s/:id/dl`（:1052）同源。此前唯独发起支付不查，属「同一状态多个入口」的漏网：
  //   ① 已付用户再点一次付费 → 新 pending 的票据**覆盖**已付票据，支付态由 paid 退回
  //      pending；而 paid 订单永不裁，于是管理页显示「已支付」、用户手上却没有任何
  //      可用凭证 —— 状态与凭证永久脱节，只能人工介入；
  //   ② 每次点击都新建订单，是 R14-03「灌单挤出在途订单」的直接推手。
  const payer = payerStateFor(l, req);
  if (payer.state === 'paid') {
    // 已付即放行：不再建单，也不动票据
    return res.redirect(303, '/s/' + l.id);
  }

  let order;
  if (payer.state === 'pending' && payer.order) {
    // 复用在途订单。网关侧商户单号就是 order.id（payment-gateway 用 out_trade_no: order.id），
    // 因此重复下单是幂等的，不会在网关侧产生第二笔。
    order = payer.order;
  } else {
    // 文件名 / 对象键一并快照进订单：链接删除后订单管理页仍要能回答"付的什么"
    order = paymentOrders.create({
      linkId: l.id, platform, amountFen: ps.amountFen,
      currency: ps.currency, payerIp: ip,
      fileName: l.fileName, fileKey: l.key,
    });
    res.cookie(payCookieName(l.id), paymentOrders.orderToken(order), shareCookieOptions(l.id));
    statsStore.addLog({
      action: 'share.pay', detail: `分享链接 ${l.id} 创建支付订单 ${order.id}（${platform}，¥${paymentRules.formatAmount(order.amountFen)}，IP：${ip}）`,
    });
  }

  // 在途订单沿用其**原始**支付渠道：换渠道属于新单（走上面的 else 分支），
  // 否则商户单号对应的网关与本次请求的渠道会对不上。
  const chargePlatform = order.platform;
  if (!available.includes(chargePlatform)) {
    return payPage(res, l, ps, available, '原支付方式已停用，请重新发起支付');
  }

  const cfg = (configStore.getPayment().platforms || {})[chargePlatform] || {};
  const base = siteUrlFor(req);
  const charge = await paymentGateway.createCharge(chargePlatform, cfg, {
    order,
    subject: chargeSubject(l),
    returnUrl: `${base}/s/${encodeURIComponent(l.id)}/pay/return`,
    notifyUrl: `${base}/pay/notify/${encodeURIComponent(platform)}`,
    cancelUrl: `${base}/s/${encodeURIComponent(l.id)}`,
  });

  if (!charge.ok) {
    paymentOrders.markFailed(order.id, charge.error || '下单失败');
    statsStore.addLog({
      action: 'share.pay', level: 'error',
      detail: `分享链接 ${l.id} 订单 ${order.id} 下单失败（${chargePlatform}）：${charge.error || '未知原因'}`,
    });
    return payPage(res, l, ps, available, `创建支付订单失败：${charge.error || '未知原因'}`);
  }
  if (charge.tradeNo) paymentOrders.setTradeNo(order.id, charge.tradeNo);

  if (charge.kind === 'qrcode') return qrPayPage(res, l, order, ps, charge);
  if (charge.kind === 'redirect' && charge.url) return res.redirect(302, charge.url);
  return payingPage(res, l, order, ps);
});

/**
 * 向网关查单并落地订单状态 —— **支付结果判定的唯一入口**。
 *
 * 无论是异步通知、支付完成回跳、还是页面轮询，最终都汇到这里。
 * 判定依据是网关返回的真实状态，不是任何来自客户端的说法。
 */
async function finalizeOrder(l, order) {
  // 退款同样是终态：网关查单仍会回答"已支付"，放行就等于把钱退了还能下载
  if (!order || order.status === 'paid' || order.status === 'refunded') return order;
  const cfg = (configStore.getPayment().platforms || {})[order.platform] || {};
  const r = await paymentGateway.queryCharge(order.platform, cfg, order);
  if (r.tradeNo) paymentOrders.setTradeNo(order.id, r.tradeNo);
  if (r.paid) {
    paymentOrders.markPaid(order.id);
    statsStore.addLog({
      action: 'share.pay',
      detail: `分享链接 ${l.id} 订单 ${order.id} 支付成功（${order.platform}，¥${paymentRules.formatAmount(order.amountFen)}${r.tradeNo ? '，网关单号 ' + r.tradeNo : ''}）`,
    });
  } else if (r.state === 'failed') {
    paymentOrders.markFailed(order.id, r.failReason || '支付失败或被取消');
    statsStore.addLog({
      action: 'share.pay', level: 'warn',
      detail: `分享链接 ${l.id} 订单 ${order.id} 支付失败（${order.platform}）：${r.failReason || '未知原因'}`,
    });
  }
  return paymentOrders.get(order.id);
}

/**
 * 带上「同一订单最快 3 秒查一次」节流的查单（`/pay/status` 原本就有的机制）。
 *
 * R8-20：`/pay/check`（「我已完成支付」按钮）与 `/pay/return`（网关回跳）
 * 原本**没有任何节流**，而 `finalizeOrder` 对 `pending`/`failed` 订单每次都真的
 * 去打网关。持票据者只要循环重放这两个端点，就能拿商户凭据把网关的查单配额
 * 刷光（PayPal 一次 = 取 token + 查订单两步），进而把真实支付的确认挤掉。
 * 这与 `/pay/notify` 处已写明的推理是同一件事 —— 那里补了限流，这里漏了。
 *
 * @returns {Promise<boolean>} 本轮是否真的发起了查单（节流命中则为 false）
 */
async function finalizeOrderThrottled(l, order) {
  if (!statusQueryDue(order)) return false;
  noteStatusQuery(order.id);
  await finalizeOrder(l, order);
  return true;
}

/**
 * R10-09：本轮**是否真的会**向网关发起查单（订单级节流未命中）。
 *
 * 抽出来是为了让调用方能先问一次再决定要不要消耗「按 IP 的查单预算」——
 * 被订单级节流拦下的轮询一次网关请求都不会发出，不该计入预算。
 */
function statusQueryDue(order) {
  return Date.now() - (statusQueryAt.get(order.id) || 0) >= STATUS_QUERY_MIN_GAP_MS;
}

/**
 * 手动查单类端点的统一前置守卫：按 IP 限流（R8-20）。
 * @returns {boolean} true = 已限流并回答，调用方应立即 return
 */
function payCheckRateLimited(req, res, l) {
  const ip = security.clientIp(req);
  const rl = security.payCheckLimiter(ip);
  if (rl.ok) return false;
  res.setHeader('Retry-After', String(rl.retryAfter));
  statsStore.addLog({
    action: 'share.pay', level: 'warn',
    detail: `手动查单被限流（链接 ${l ? l.id : '-'}，IP：${ip}）`,
  });
  statePage(res, 'limited', l ? shareStore.view(l) : null,
    `查询过于频繁，请 ${rl.retryAfter} 秒后重试。`);
  return true;
}

/** 支付完成后的回跳（支付宝 return_url / PayPal return_url） */
router.get('/s/:id/pay/return', async (req, res) => {
  const l = shareStore.get(req.params.id);
  if (!l) return statePage(res, 'notfound');
  const order = paymentOrders.verifyToken(l.id, getCookie(req, payCookieName(l.id)));
  if (!order || order.linkId !== l.id) return res.redirect(303, '/s/' + l.id);
  if (payCheckRateLimited(req, res, l)) return undefined; // R8-20
  await finalizeOrderThrottled(l, order);
  return res.redirect(303, '/s/' + l.id);
});

/** 手动触发一次查单（「我已完成支付」按钮） */
router.post('/s/:id/pay/check', async (req, res) => {
  const l = shareStore.get(req.params.id);
  if (!l) return statePage(res, 'notfound');
  const order = paymentOrders.verifyToken(l.id, getCookie(req, payCookieName(l.id)));
  if (!order || order.linkId !== l.id) return res.redirect(303, '/s/' + l.id);
  if (payCheckRateLimited(req, res, l)) return undefined; // R8-20
  await finalizeOrderThrottled(l, order);
  return res.redirect(303, '/s/' + l.id);
});

/**
 * 轮询支付状态（供支付中 / 二维码页面使用）。
 *
 * 微信 Native 没有回跳，只能靠这里推进：每次被轮询时主动向网关查单。
 * 为避免被刷成网关压力，同一订单最快 3 秒查一次网关（页面轮询间隔同为 3 秒）。
 */
router.get('/s/:id/pay/status', async (req, res) => {
  const l = shareStore.get(req.params.id);
  if (!l) return res.status(404).json({ error: '链接不存在' });
  const order = paymentOrders.verifyToken(l.id, getCookie(req, payCookieName(l.id)));
  if (!order || order.linkId !== l.id) return res.json({ state: 'none', paid: false });

  if (order.status === 'pending' && order.platform === 'wechat') {
    // R8-20：节流逻辑与 /pay/check、/pay/return 收敛到同一处（原先三处各写一份，
    // 结果只有这里带了节流）。节流命中时静默返回当前状态，页面下一轮再问。
    //
    // R9-05：上述节流的键是**订单**（3 秒一次），没有按 IP 的总量上限 ——
    // 持票据者可造多个订单再逐个轮询，把网关查单预算放大到约 66 倍。这里补一道
    // **按 IP 的查单预算**（见 security.payStatusLimiter）：超限时
    // 同样静默返回当前状态，既不打断正常轮询的 UX，也把多订单并行的放大倍数压住。
    //
    // R10-09：只有「本轮真的会查单」才消耗该预算。旧写法无条件按压限流器，
    // 于是被订单级节流拦下的轮询（一次网关请求都没发）也照样扣 —— 页面每 3 秒
    // 轮询一次时，200 次预算恰好在 10 分钟窗口内被"什么都没做的轮询"用光
    // （零余量），多人共用出口 IP 时更早触发，之后页面再也无法主动推进状态。
    // 预算的语义是"网关查单次数"，就该只在真的要查单时扣。
    const ip = security.clientIp(req);
    if (statusQueryDue(order) && security.payStatusLimiter(ip).ok) {
      await finalizeOrderThrottled(l, order);
    }
  }
  const o = paymentOrders.get(order.id) || order;
  res.json({ state: o.status, paid: o.status === 'paid' });
});

/**
 * 网关异步通知（仅作**触发信号**，不采信其内容判定结果）。
 *
 * 放在 `/pay/*` 而不是 `/api/*`：后者对非安全方法强制同源头与登录态，
 * 网关回调两样都没有，放过去必然 403。
 */
router.post('/pay/notify/:platform', async (req, res) => {
  const platform = String(req.params.platform || '');
  if (!paymentProviders.isKnown(platform)) return res.status(404).end();

  // 各网关的响应要求不同：支付宝要看到 success 字样，微信与 PayPal 只要 2xx
  const done = () => (platform === 'alipay' ? res.type('text/plain').send('success') : res.status(200).json({ code: 'SUCCESS' }));

  // SEC-03 ①：限流必须**先于**任何凭据使用。通知会触发带真实商户密钥的网关查单，
  // 匿名可达的端点若不限流，等于把商户查单配额暴露给任何人。
  const ip = security.clientIp(req);
  const rl = security.payNotifyLimiter(ip);
  if (!rl.ok) {
    statsStore.addLog({ action: 'share.pay', level: 'warn', detail: `支付回调被限流（平台：${platform}，IP：${ip}）` });
    res.setHeader('Retry-After', String(rl.retryAfter));
    return res.status(429).end();
  }

  // SEC-03 ②：验签。通知只被当作"该去查一次单"的信号，伪造通知**本身**造不出
  // 已支付状态（判定仍来自服务端主动查单）；但它能白嫖商户的查单配额并污染日志，
  // 所以能验的平台一律验，验不过直接丢掉。
  const sig = verifyNotified(platform, req);
  if (!sig.ok) {
    statsStore.addLog({ action: 'share.pay', level: 'warn', detail: `支付回调验签未通过已丢弃（平台：${platform}，IP：${ip}，原因：${sig.reason}）` });
    return res.status(403).end();
  }

  const order = await resolveNotifiedOrder(platform, req);
  if (order) {
    const l = shareStore.get(order.linkId);
    if (l) await finalizeOrder(l, order);
  }
  return done();
});

/**
 * 异步通知的真实性校验（SEC-03）
 *
 * 各平台能力不同，逐一看待：
 *  - 支付宝：RSA2 / RSA 验签（公钥本地校验，离线可完成）—— 验不过即拒绝；
 *  - 微信：通知体是 APIv3 密钥下的 AES-256-GCM 密文，**解不出来就说明对方没有
 *    密钥**，解密成功本身即是认证（GCM 带认证标签）。因此这里要求 apiV3Key 已配置，
 *    解密失败由 resolveNotifiedOrder 一并判定；
 *  - PayPal：官方仅提供「回调验签 API」，本地无法离线验签（需一次网络往返）。
 *    这里不做伪验签（那只会给出虚假的安全感），交由上面的限流兜底。
 *
 * @returns {{ok: boolean, reason?: string}}
 */
function verifyNotified(platform, req) {
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const cfg = (configStore.getPayment().platforms || {})[platform] || {};
  if (platform === 'alipay') {
    if (!cfg.alipayPublicKey) return { ok: false, reason: '未配置支付宝公钥' };
    if (!b.sign) return { ok: false, reason: '通知缺少签名字段' };
    if (paymentGateway.alipayVerify(b, cfg.alipayPublicKey, cfg.signType || b.sign_type)) return { ok: true };
    return { ok: false, reason: '签名校验失败' };
  }
  if (platform === 'wechat') {
    if (!cfg.apiV3Key) return { ok: false, reason: '未配置 APIv3 密钥' };
    if (!b.resource || !b.resource.ciphertext) return { ok: false, reason: '通知缺少加密资源' };
    return { ok: true };
  }
  return { ok: true }; // PayPal：本地不可验签，依赖限流
}

/**
 * 从异步通知里定位订单。
 *  - 支付宝：表单字段 out_trade_no
 *  - PayPal：JSON 的 resource.id（即创建订单时拿到的网关订单号）
 *  - 微信：resource 经 APIv3 密钥解密后取 out_trade_no
 * 定位不到就直接返回 null —— 通知只是提醒，查不到订单不做任何状态变更。
 */
async function resolveNotifiedOrder(platform, req) {
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  if (platform === 'alipay') {
    const no = String(b.out_trade_no || '');
    return no ? paymentOrders.get(no) : null;
  }
  if (platform === 'paypal') {
    const id = String((b.resource && b.resource.id) || b.id || '');
    return id ? paymentOrders.findByTradeNo(id) : null;
  }
  if (platform === 'wechat') {
    const resource = b.resource;
    if (!resource || !resource.ciphertext) return null;
    const cfg = (configStore.getPayment().platforms || {}).wechat || {};
    let plain = '';
    try {
      plain = paymentGateway.wechatDecryptResource(cfg.apiV3Key, resource);
    } catch (e) {
      statsStore.addLog({ action: 'share.pay', level: 'warn', detail: `微信支付通知解密失败：${e.message}` });
      return null;
    }
    try {
      const obj = JSON.parse(plain);
      return obj.out_trade_no ? paymentOrders.get(obj.out_trade_no) : null;
    } catch (e) {
      return null;
    }
  }
  return null;
}

/** 密码输入页；wrong 为提示文案（true 用默认文案，字符串为自定义文案，如限流/冻结提示） */
function passwordPage(res, l, wrong, customMsg) {
  const msg = typeof customMsg === 'string' && customMsg
    ? esc(customMsg)
    : (wrong ? '密码不正确，请重试。' : '');
  renderPage(res, wrong ? 401 : 200, {
    title: '密码保护',
    head: `<div class="center-head">
      <div class="icon-big" style="background:#fdf6ec;color:#b45309;font-size:20px">🔒</div>
      <h1>此链接受密码保护</h1>
      <p class="sub">请输入分享者提供的访问密码。</p>
      </div>`,
    body: `
      <form method="POST" action="/s/${esc(l.id)}" style="margin-top:16px">
        ${msg ? `<div class="warn">${msg}</div>` : ''}
        <input type="password" name="password" placeholder="访问密码" autofocus autocomplete="off" required>
        <button class="btn primary" type="submit">验证并查看文件</button>
      </form>`,
  });
}

/** 分享密码 Cookie 的统一选项（SEC-10：部署模式下必须带 Secure，与主会话一致） */
function shareCookieOptions(id) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: !!security.IS_DEPLOY, // 部署模式（非回环）下强制仅经 HTTPS 传输
    maxAge: COOKIE_MAX_AGE,
    path: '/',
  };
}

router.post('/s/:id', async (req, res) => {
  const l = shareStore.get(req.params.id);
  if (!l) return statePage(res, 'notfound');
  const st = shareStore.status(l);
  if (st !== 'active') return statePage(res, st, shareStore.view(l));
  if (!l.passwordHash) return res.redirect(303, '/s/' + l.id);

  // 限流（按 IP + 链接）+ 连续失败冻结，防匿名暴力破解（S2）
  //
  // FUN-04：冻结键必须是 **IP + 链接**，与限流器同维度。
  // 曾经只以 linkId 为键 —— 链接 ID 本身就在传播，任何拿到链接的人连错 5 次
  // 就能让该链接对**所有**合法访问者冻结 30 分钟，换 IP 还能持续触发，
  // 等于一条随手可用的针对性 DoS。
  const ip = security.clientIp(req);
  const scope = `${ip}:${l.id}`;
  const rl = security.shareLimiter(scope);
  if (!rl.ok) return passwordPage(res, l, true, `尝试过于频繁，请 ${rl.retryAfter} 秒后重试`);
  const frozenLeft = security.shareLock.locked(scope);
  if (frozenLeft > 0) return passwordPage(res, l, true, `密码错误次数过多，请 ${frozenLeft} 秒后重试`);

  const pw = String((req.body && req.body.password) || '');
  // SEC-05：口令校验为异步（旧 scryptSync 会被用于阻塞事件循环）
  if (await shareStore.checkPassword(l, pw)) {
    security.shareLock.reset(scope);
    res.cookie(cookieName(l.id), shareStore.accessToken(l), shareCookieOptions(l.id));
    return res.redirect(303, '/s/' + l.id);
  }
  const left = security.shareLock.fail(scope);
  statsStore.addLog({ action: 'share.auth', detail: `分享链接 ${l.id} 密码验证失败（IP：${ip}）`, level: 'warn' });
  if (left > 0) return passwordPage(res, l, true, `密码错误次数过多，该链接已临时冻结，请 ${left} 秒后重试`);
  return passwordPage(res, l, true);
});

/* ------------------------------ 下载 ------------------------------ */

/**
 * HEAD `/s/:id/dl` —— 只回答「能不能下、有多大」，**不产生任何副作用**。
 *
 * 必须显式注册：Express 在没有 HEAD 路由时会把 HEAD 请求**交给 GET handler 处理**
 * （只丢弃响应体）。而 GET handler 是「有副作用的 GET」—— 它会占用一次下载名额、
 * 向云端发起完整 getObject。于是下载器先发一个 HEAD 做探测（Range 支持、文件大小）
 * 就会：① 白扣一次额度；② 白跑一遍全量流量。浏览器预取、断点续传客户端同理。
 *
 * 这里刻意只做**廉价检查**（读链接记录 + 状态判定），不触云端、不计数、不解密：
 * 探测就该是探测。也因此它不复用 GET 的流程 —— 复用即等于把副作用带回来。
 * 状态码与 GET 的状态页保持一致（404 / 410）。
 */
router.head('/s/:id/dl', (req, res) => {
  const l = shareStore.get(req.params.id);
  if (!l) { res.status(404).end(); return; }
  const st = shareStore.status(l);
  if (st !== 'active') {
    // 与 statePage 的映射保持一致：deleted / expired / exhausted 一律 410
    res.status(410).end();
    return;
  }

  /* R8-23 ①：HEAD 必须复用 GET 的门禁判定（密码票据 / 付费状态）。
   *
   * 旧实现只做 `status()` 判定，于是**未持密码票据**者发一个 HEAD 就能以
   * 200/404/410 三态确认链接是否有效，并直接读到 `Content-Length`（精确文件大小）——
   * 而对同一 URL 发 GET 只会 303 回密码页。探测与真实下载必须看到同一结果。
   * 仍然保持「无副作用」：不占用下载名额、不触云端、不解密。 */
  if (l.passwordHash) {
    const token = getCookie(req, cookieName(l.id));
    if (!shareStore.verifyToken(l, token)) return res.redirect(303, '/s/' + l.id); // 与 GET 一致
  }
  const ps = paidStateFor(l);
  if (ps.effective && payerStateFor(l, req).state !== 'paid') {
    return res.status(402).end(); // 与 payBlockedPage 的状态码一致
  }

  /* R8-23 ②：**不**宣告 `Accept-Ranges`。
   *
   * `GET /s/:id/dl` 走 `streamDownload`，恒为完整 200 + 完整 body，从不读
   * `req.headers.range`。广播一个未实现的能力会让续传客户端把 200 的整段内容
   * 拼到已下载的分片之后，产出**损坏的文件**。诚实的做法是什么都不声明。 */
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', String(Number(l.size) || 0));
  res.status(200).end();
});

router.get('/s/:id/dl', async (req, res) => {
  const l = shareStore.get(req.params.id);
  if (!l) return statePage(res, 'notfound');
  const st = shareStore.status(l);
  if (st !== 'active') return statePage(res, st, shareStore.view(l));
  if (l.passwordHash) {
    const token = getCookie(req, cookieName(l.id));
    if (!shareStore.verifyToken(l, token)) return res.redirect(303, '/s/' + l.id);
  }

  // ---- 付费下载拦截 ----
  // 必须**早于** tryAcquire：未支付的请求不应消耗下载次数，
  // 否则反复尝试支付失败就能把额度刷光。
  const ps = paidStateFor(l);
  let paidOrder = null; // 本次下载所依据的已支付订单（用于事后标记「已下载」）
  if (ps.effective) {
    const payer = payerStateFor(l, req);
    if (payer.state !== 'paid') {
      statsStore.addLog({
        action: 'share.download', level: 'warn',
        detail: `已拦截未完成的付费下载（链接 ${l.id}，状态：${payer.state}）`,
      });
      return payBlockedPage(res, l, ps, payer);
    }
    paidOrder = payer.order;
  }

  // SEC-08：本端点是「有副作用的 GET」（访问即占用一次下载名额），
  // 而 `/s/*` 不在 `/api` 之下、不经过 CSRF 校验。任何外部页面的
  // `<img src="https://host/s/ID/dl">` 或链接预取都能静默消耗额度。
  // 这里补两层防护：
  //  ① 按 IP + 链接限流，限制被刷爆的速度；
  //  ② 校验 Sec-Fetch-Site —— 跨站发起的子资源/预取请求一律拒绝，
  //     同时显式禁止直接导航（Sec-Fetch-Mode: navigate 的顶层跳转仍允许）。
  const ip = security.clientIp(req);
  const dlRl = security.shareDownloadLimiter(`${ip}:${l.id}`);
  if (!dlRl.ok) {
    res.setHeader('Retry-After', String(dlRl.retryAfter));
    return statePage(res, 'limited', shareStore.view(l),
      `请求过于频繁，请 ${dlRl.retryAfter} 秒后重试（本次未占用下载次数）。`);
  }
  /* ---- SEC-08：来源判定（纯函数，见 server/share-origin.js） ----
   *
   * 该端点是"有副作用的 GET"，命中即扣减下载次数。第三方的 `<img src=.../dl>`
   * 能让任何访客默默刷掉额度，因此必须分层判定来源。
   * 判定逻辑集中在 share-origin.js，既便于行为测试，也避免把安全策略埋在路由里。
   */
  const hasValidTicket = shareStore.verifyToken(l, getCookie(req, cookieName(l.id)));
  const src = classifyDownloadSource({
    secFetchSite: req.headers['sec-fetch-site'],
    referer: req.headers.referer || req.headers.referrer,
    host: req.headers.host,
    secure: Boolean(req.secure || (security.IS_DEPLOY && security.TRUST_PROXY)),
    hasTicket: hasValidTicket,
  });
  if (!src.allow) {
    statsStore.addLog({
      action: 'share.download', level: 'warn',
      detail: `已拦截来源不受信任的分享下载（链接 ${l.id}，IP：${ip}，原因：${src.reason}，referer=${String(req.headers.referer || '').slice(0, 120)}）`,
    });
    return statePage(res, 'crosssite', shareStore.view(l),
      '该下载请求来自其它站点，已被拒绝。请在分享页面内点击下载。');
  }
  if (src.reason === 'no-source-hint') {
    // 直连客户端（curl / wget）：保留可用性，但落审计便于追溯
    statsStore.addLog({
      action: 'share.download', level: 'warn',
      detail: `分享下载缺少来源标识（链接 ${l.id}，IP：${ip}）—— 疑似脚本直连，已放行但仅依赖限流保护`,
    });
  }

  // 占用下载名额（先计数后传输，保证并发不超限）
  const acq = shareStore.tryAcquire(l.id);
  if (!acq.ok) return statePage(res, acq.reason, shareStore.view(acq.link || l));

  try {
    const cfg = configStore.effectiveForBucket(l.bucket, l.region);
    if (!cfg || !cfg.secretId) {
      // R8-09：配置失效 = 用户一字节都没拿到，与 catch 分支的服务端错误同性质，
      // 必须回滚刚占用的名额。旧实现直接 return，于是「管理员解绑桶/删密钥」期间
      // 访客每点一次下载就白扣一次：maxDownloads=3 的链接点 3 次即转 exhausted
      // **终态**，重新绑定桶后仍 410，只能靠人工「重置下载计数」救回。
      shareStore.release(l.id);
      return renderPage(res, 503, {
        title: '服务暂不可用',
        body: '<h1>服务暂不可用</h1><p class="sub">分享者尚未配置有效的访问密钥，无法下载。请联系分享者。本次访问不占用下载次数。</p>',
      });
    }
    const cos = getClient(cfg);
    const region = cfg.region || l.region;
    const traffic = { bytesDown: 0 };
    const encMeta = encStore.getMeta(l.bucket, l.key); // 密文对象：解密后下发（分享密码即为权限验证）
    await tracked('download', async () => {
      await streamDownload({ cos, bucket: l.bucket, region, key: l.key, fileName: l.fileName, encMeta, req, res, traffic });
    }, traffic);
    // 传输**结束后**才标记已下载：传输中途失败若提前标记，
    // 管理页会显示"已下载"而用户其实没拿到文件，对账就失真了。
    if (paidOrder) paymentOrders.markDownloaded(paidOrder.id);
    statsStore.addLog({ action: 'share.download', detail: `分享下载 ${l.key}（${traffic.bytesDown} 字节，链接 ${l.id}${encMeta ? '，已解密' : ''}）` });
  } catch (e) {
    statsStore.addLog({ action: 'share.download', detail: `分享下载失败 ${l.key}（链接 ${l.id}）: ${e.message}`, level: 'error' });
    // 云端明确回答"没有这个对象" → 顺手把链接标成已删除，
    // 让下一次访问（以及管理页）直接给出确定答案，不用再白跑一趟。
    if (isNotFound(e)) shareStore.markMissing(l.id);
    if (!res.headersSent) {
      shareStore.release(l.id); // 启动前失败：回滚计数
      return renderPage(res, 404, {
        title: '文件不存在',
        body: '<h1>文件不存在或已被删除</h1><p class="sub">云端未找到该文件，可能已被分享者删除。本次失败的下载不占用次数额度。</p>',
      });
    }
    // SEC-06：响应已发出后才失败 —— 区分是谁的锅。
    //  · 客户端主动中断（用户取消 / 网络断开）：文件已经（至少部分）发出，
    //    扣减一次是合理的，"先计数后传输"本就是为防并发超限而设计的取舍；
    //  · **服务端错误**（云端中断、解密失败、配置失效）：用户一字节都没拿到，
    //    这时必须回滚，否则"还剩 3 次"会因为服务端自己的故障凭空变成 2 次。
    //    旧实现两种情况都不回滚，属于被注释承认、却始终没做的补偿。
    const clientGone = req.aborted || (req.socket && req.socket.destroyed)
      || res.writableEnded || res.destroyed;
    if (!clientGone) {
      shareStore.release(l.id);
      statsStore.addLog({
        action: 'share.download', level: 'warn',
        detail: `分享下载 ${l.key}（链接 ${l.id}）在传输中因服务端错误中断，已回滚本次下载次数`,
      });
    }
    res.destroy();
  }
});

module.exports = router;
