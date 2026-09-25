/**
 * 真实支付网关适配器（零依赖，基于 Node 内置 crypto + 全局 fetch）
 *
 * 支持三个渠道，各自选用**最适合 PC 浏览器场景**的下单方式：
 *   alipay  电脑网站支付 alipay.trade.page.pay → 跳转支付宝收银台（无需二维码）
 *   wechat  Native 支付 APIv3 → 返回 code_url，由自研 qrcode.js 渲染二维码
 *   paypal  Orders v2 → 跳转 PayPal 审批页，回调后再 capture 收款
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ 关键设计：支付结果一律以「服务端主动查单」为准，不采信异步通知的内容。      │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * 常见做法是「收到异步通知 → 验签 → 置为已支付」。但验签要自研三套（支付宝 RSA2、
 * 微信 APIv3 平台证书、PayPal Webhook），**任一处写错都是直接的安全漏洞**：
 * 伪造一条"支付成功"通知就能白嫖文件，且这类漏洞在开发期完全测不出来。
 *
 * 改成：通知/回跳只当作"去查一下"的触发信号，真正的判定由服务端**主动调用网关查单**，
 * 结果来自我们与网关之间的 TLS 连接，不依赖对通知内容的信任。
 * 代价是每个渠道多一个查单接口，换来的是「宁可慢一点确认，也绝不被伪造」。
 *
 * 安全约定：
 *  - 出站请求固定官方域名（不走 endpoint-guard，那是防 SSRF 的对内请求）
 *  - 全部请求带超时（默认 10 秒），失败一律当作"未确认"，绝不乐观置为已支付
 *  - 私钥只进本模块，绝不写日志、绝不回传前端
 */
'use strict';

const crypto = require('crypto');
const qrcode = require('./qrcode');

const TIMEOUT_MS = 10000;
const ALIPAY_GATEWAY = 'https://openapi.alipay.com/gateway.do';
const WECHAT_HOST = 'https://api.mch.weixin.qq.com';

/** PayPal 的沙箱 / 生产域名（凭证不通用，由配置里的 mode 决定） */
function paypalHost(mode) {
  return String(mode || '').toLowerCase() === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
}

/**
 * 私钥归一化：允许 PEM，也允许「裸 Base64 密钥体」（支付设置页的校验器两者都放行）。
 * 裸 Base64 一律按 PKCS#8 包裹 —— 支付宝与微信商户平台下载的私钥都是 PKCS#8。
 */
function normalizePrivateKey(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (/-----BEGIN/.test(s)) return s;
  const body = s.replace(/[\s\r\n]/g, '');
  const wrapped = body.replace(/(.{64})/g, '$1\n');
  return `-----BEGIN PRIVATE KEY-----\n${wrapped}\n-----END PRIVATE KEY-----`;
}

function rsaSign(content, privateKey, signType) {
  const algo = String(signType || 'RSA2').toUpperCase() === 'RSA' ? 'RSA-SHA1' : 'RSA-SHA256';
  return crypto.createSign(algo).update(content, 'utf8').sign(normalizePrivateKey(privateKey), 'base64');
}

/** 与 normalizePrivateKey 对称：裸 Base64 按 X.509 SubjectPublicKeyInfo 包裹 */
function normalizePublicKey(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (/-----BEGIN/.test(s)) return s;
  const body = s.replace(/[\s\r\n]/g, '');
  const wrapped = body.replace(/(.{64})/g, '$1\n');
  return `-----BEGIN PUBLIC KEY-----\n${wrapped}\n-----END PUBLIC KEY-----`;
}

/**
 * 校验支付宝异步通知/响应签名（SEC-03）
 *
 * 这里是 rsaSign 的镜像，用于**确认通知确实来自支付宝**：没有它，任何人在
 * 知道回调地址后都能 POST 一条假通知，逼本系统用真实商户凭据去向网关查单
 * （查单配额消耗、日志污染，极端情况下把商户查单接口刷到限流）。
 *
 * 待签串存在两个历史变体 —— 支付宝官方 SDK 的 V1 只剔除 `sign`，V2 还会额外
 * 剔除 `sign_type`。两个变体都试一遍：能通过其一即视为验签通过。
 * 这不构成安全削弱（攻击者仍必须持有应用私钥），只是为了兼容两种 SDK 版本。
 *
 * @param {object} params 通知参数（含 sign）
 * @param {string} publicKey 支付宝公钥（PEM 或裸 Base64）
 * @param {string} [signType] RSA2（默认）| RSA；SM2 无法在本地验签，一律返回 false
 * @returns {boolean}
 */
function alipayVerify(params, publicKey, signType) {
  const p = params && typeof params === 'object' ? params : {};
  const sign = String(p.sign || '');
  const key = normalizePublicKey(publicKey);
  if (!sign || !key) return false;
  const st = String(signType || (p.sign_type) || 'RSA2').toUpperCase();
  if (st === 'SM2') return false; // 国密需 SM2 实现，本地不具备 —— 明确拒绝而非放行
  const algo = st === 'RSA' ? 'RSA-SHA1' : 'RSA-SHA256';
  const withoutType = Object.assign({}, p);
  delete withoutType.sign_type;
  const variants = [alipaySignPayload(p), alipaySignPayload(withoutType)];
  for (const content of new Set(variants)) {
    if (!content) continue;
    try {
      if (crypto.createVerify(algo).update(content, 'utf8').verify(key, sign, 'base64')) return true;
    } catch (e) { /* 换下一个变体继续 */ }
  }
  return false;
}

/* ============================ 支付宝 ============================ */

/**
 * 待签名串：参数按 key 升序，剔除 sign 本身与空值，k=v 用 & 连接（值**不做** URL 编码）。
 * 导出以便行为测试直接驱动 —— 这里的排序与过滤规则错一格，签名就永远对不上。
 */
function alipaySignPayload(params) {
  const keys = Object.keys(params)
    .filter((k) => k !== 'sign' && params[k] !== undefined && params[k] !== null && params[k] !== '')
    .sort();
  return keys.map((k) => `${k}=${params[k]}`).join('&');
}

/** 组装支付宝网关跳转 URL（含 sign） */
function alipayBuildUrl(gateway, params, privateKey, signType) {
  const payload = alipaySignPayload(params);
  const sign = rsaSign(payload, privateKey, signType);
  const all = Object.assign({}, params, { sign });
  const query = Object.keys(all)
    .filter((k) => all[k] !== undefined && all[k] !== null && all[k] !== '')
    .sort()
    .map((k) => `${k}=${encodeURIComponent(all[k])}`)
    .join('&');
  const base = String(gateway || ALIPAY_GATEWAY);
  return base + (base.includes('?') ? '&' : '?') + query;
}

function alipayTimestamp() {
  // 支付宝要求 yyyy-MM-dd HH:mm:ss，且时区与北京时间一致
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} `
    + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

async function alipayCreate(cfg, { order, subject, returnUrl, notifyUrl }) {
  const params = {
    app_id: cfg.appId,
    method: 'alipay.trade.page.pay',
    format: 'JSON',
    charset: 'utf-8',
    sign_type: cfg.signType || 'RSA2',
    timestamp: alipayTimestamp(),
    version: '1.0',
    return_url: returnUrl,
    notify_url: notifyUrl,
    biz_content: JSON.stringify({
      out_trade_no: order.id,
      total_amount: (order.amountFen / 100).toFixed(2),
      subject: subject,
      product_code: 'FAST_INSTANT_TRADE_PAY',
    }),
  };
  if (cfg.appCertSn) params.app_cert_sn = cfg.appCertSn;
  if (cfg.rootCertSn) params.alipay_root_cert_sn = cfg.rootCertSn;
  const url = alipayBuildUrl(cfg.gateway || ALIPAY_GATEWAY, params, cfg.privateKey, cfg.signType);
  return { kind: 'redirect', url, tradeNo: '' };
}

async function alipayQuery(cfg, order) {
  const params = {
    app_id: cfg.appId,
    method: 'alipay.trade.query',
    format: 'JSON',
    charset: 'utf-8',
    sign_type: cfg.signType || 'RSA2',
    timestamp: alipayTimestamp(),
    version: '1.0',
    biz_content: JSON.stringify({ out_trade_no: order.id }),
  };
  const url = alipayBuildUrl(cfg.gateway || ALIPAY_GATEWAY, params, cfg.privateKey, cfg.signType);
  const res = await fetchWithTimeout(url);
  const json = await res.json();
  const node = json && json.alipay_trade_query_response;
  if (!node) return { paid: false, state: 'error', tradeNo: '', failReason: '支付宝返回内容无法识别' };
  if (node.code !== '10000') {
    // 交易不存在（还未在支付宝侧创建）也算未支付，不该报成错误
    if (node.sub_code === 'ACQ.TRADE_NOT_EXIST') return { paid: false, state: 'pending', tradeNo: '', failReason: '' };
    return { paid: false, state: 'error', tradeNo: '', failReason: `${node.sub_msg || node.msg || '查询失败'}` };
  }
  const st = node.trade_status;
  if (st === 'TRADE_SUCCESS' || st === 'TRADE_FINISHED') {
    return { paid: true, state: 'paid', tradeNo: node.trade_no || '', failReason: '' };
  }
  if (st === 'TRADE_CLOSED') return { paid: false, state: 'failed', tradeNo: node.trade_no || '', failReason: '交易已关闭' };
  return { paid: false, state: 'pending', tradeNo: node.trade_no || '', failReason: '' };
}

/* ============================ 微信支付（APIv3） ============================ */

/**
 * APIv3 待签名串：`方法\n路径\n时间戳\n随机串\n报文主体\n`
 * 注意 **GET 请求也要带最后的换行**（主体为空串），漏掉会恒定 401。
 */
function wechatSignPayload(method, canonicalUrl, timestamp, nonce, body) {
  return `${method}\n${canonicalUrl}\n${timestamp}\n${nonce}\n${body || ''}\n`;
}

/** 组装 Authorization 头：WECHATPAY2-SHA256-RSA2048 mchid="",nonce_str="",signature="",timestamp="",serial_no="" */
function wechatAuthorization(method, canonicalUrl, body, cfg, { timestamp, nonce }) {
  const payload = wechatSignPayload(method, canonicalUrl, timestamp, nonce, body);
  const signature = rsaSign(payload, cfg.privateKey, 'RSA2');
  return `WECHATPAY2-SHA256-RSA2048 mchid="${cfg.mchId}",nonce_str="${nonce}",`
    + `signature="${signature}",timestamp="${timestamp}",serial_no="${cfg.certSerialNo}"`;
}

async function wechatRequest(method, path, cfg, body) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(16).toString('hex');
  const raw = body === undefined || body === null ? '' : JSON.stringify(body);
  const headers = {
    // R8-01：签名函数是五参数（…, body, cfg, {timestamp, nonce}）。旧实现漏传 body，
    // 实参整体左移一位 → cfg 收到 body、第五参解构 undefined → 每次调用必抛 TypeError。
    // 微信渠道的下单与查单都经过这里，因此该渠道此前 100% 不可用。
    Authorization: wechatAuthorization(method, path, raw, cfg, { timestamp, nonce }),
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': 'cos-manager',
  };
  if (cfg.subMchId) headers['Wechatpay-Serial'] = cfg.certSerialNo;
  const res = await fetchWithTimeout(WECHAT_HOST + path, {
    method,
    headers,
    body: method === 'GET' ? undefined : raw,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { /* 非 JSON */ }
  if (!res.ok) {
    const msg = (json && (json.message || json.detail)) || text || `HTTP ${res.status}`;
    throw new Error(String(msg).slice(0, 300));
  }
  return json || {};
}

async function wechatCreate(cfg, { order, subject, notifyUrl }) {
  const payload = {
    appid: cfg.appId,
    mchid: cfg.mchId,
    description: subject,
    out_trade_no: order.id,
    notify_url: notifyUrl,
    amount: { total: Number(order.amountFen), currency: 'CNY' },
  };
  if (cfg.subMchId) { payload.sub_mchid = cfg.subMchId; if (cfg.subAppId) payload.sub_appid = cfg.subAppId; }
  const r = await wechatRequest('POST', '/v3/pay/transactions/native', cfg, payload);
  const codeUrl = r.code_url;
  if (!codeUrl) throw new Error('微信支付未返回 code_url');
  return { kind: 'qrcode', url: '', codeUrl, svg: qrcode.toSvg(codeUrl, { scale: 6, margin: 3 }), tradeNo: '' };
}

/**
 * 解密微信支付通知里的 resource（AES-256-GCM，密钥即 APIv3 密钥）。
 *
 * 只用于**从通知里取出订单号**去定位订单，解密结果不参与"是否已支付"的判定
 * —— 判定仍然由随后的主动查单给出。所以即使这里的实现有偏差，
 * 最坏结果是"通知没能触发查单"，而不会造成误判已支付。
 */
function wechatDecryptResource(apiV3Key, resource) {
  const key = Buffer.from(String(apiV3Key || ''), 'utf8');
  if (key.length !== 32) throw new Error('APIv3 密钥长度不是 32 字节，无法解密通知');
  const buf = Buffer.from(String((resource && resource.ciphertext) || ''), 'base64');
  if (buf.length <= 16) throw new Error('通知密文长度不足');
  const iv = Buffer.from(String((resource && resource.nonce) || ''), 'utf8');
  const aad = Buffer.from(String((resource && resource.associated_data) || ''), 'utf8');
  const tag = buf.slice(buf.length - 16);
  const data = buf.slice(0, buf.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAAD(aad);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}

async function wechatQuery(cfg, order) {
  const path = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(order.id)}?mchid=${encodeURIComponent(cfg.mchId)}`;
  const r = await wechatRequest('GET', path, cfg);
  const st = r.trade_state;
  const tradeNo = r.transaction_id || '';
  if (st === 'SUCCESS') return { paid: true, state: 'paid', tradeNo, failReason: '' };
  if (st === 'CLOSED' || st === 'PAYERROR' || st === 'REVOKED') {
    return { paid: false, state: 'failed', tradeNo, failReason: '交易已关闭或支付失败' };
  }
  return { paid: false, state: 'pending', tradeNo, failReason: '' };
}

/* ============================ PayPal ============================ */

function paypalBasic(cfg) {
  return 'Basic ' + Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
}

async function paypalToken(cfg) {
  const res = await fetchWithTimeout(`${paypalHost(cfg.mode)}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: paypalBasic(cfg),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || !json.access_token) throw new Error('PayPal 获取访问令牌失败');
  return json.access_token;
}

async function paypalCreate(cfg, { order, subject, returnUrl, cancelUrl }) {
  const token = await paypalToken(cfg);
  const body = {
    intent: 'CAPTURE',
    purchase_units: [{
      reference_id: order.id,
      description: subject.slice(0, 127),
      amount: { currency_code: order.currency || 'CNY', value: (order.amountFen / 100).toFixed(2) },
    }],
    application_context: { return_url: returnUrl, cancel_url: cancelUrl, user_action: 'PAY_NOW' },
  };
  const res = await fetchWithTimeout(`${paypalHost(cfg.mode)}/v2/checkout/orders`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || !json.id) throw new Error((json && (json.message || json.name)) || 'PayPal 创建订单失败');
  const approve = (json.links || []).find((l) => l.rel === 'approve');
  if (!approve || !approve.href) throw new Error('PayPal 未返回审批链接');
  return { kind: 'redirect', url: approve.href, tradeNo: json.id };
}

/** PayPal 的「查单」= 查询订单状态；若已获批准则顺带 capture（真正扣款） */
async function paypalQuery(cfg, order) {
  const id = order.tradeNo;
  if (!id) return { paid: false, state: 'pending', tradeNo: '', failReason: '' };
  const token = await paypalToken(cfg);
  const res = await fetchWithTimeout(`${paypalHost(cfg.mode)}/v2/checkout/orders/${encodeURIComponent(id)}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json) return { paid: false, state: 'error', tradeNo: id, failReason: 'PayPal 查询订单失败' };
  const status = json.status;
  if (status === 'COMPLETED') return { paid: true, state: 'paid', tradeNo: id, failReason: '' };
  if (status === 'VOIDED') return { paid: false, state: 'failed', tradeNo: id, failReason: '订单已作废' };
  if (status === 'APPROVED') {
    // 买家已同意，尚未扣款 —— 由我们主动 capture 完成收款
    const cap = await fetchWithTimeout(`${paypalHost(cfg.mode)}/v2/checkout/orders/${encodeURIComponent(id)}/capture`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    const capJson = await cap.json().catch(() => null);
    if (cap.ok && capJson && capJson.status === 'COMPLETED') {
      return { paid: true, state: 'paid', tradeNo: id, failReason: '' };
    }
    const reason = (capJson && (capJson.message || capJson.name)) || '扣款未完成';
    if (capJson && capJson.status === 'PAYER_ACTION_REQUIRED') {
      return { paid: false, state: 'pending', tradeNo: id, failReason: '' };
    }
    return { paid: false, state: 'failed', tradeNo: id, failReason: String(reason).slice(0, 200) };
  }
  return { paid: false, state: 'pending', tradeNo: id, failReason: '' };
}

/* ============================ 统一入口 ============================ */

async function fetchWithTimeout(url, init) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, Object.assign({}, init, { signal: ctrl.signal }));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 下单
 * @param {string} platform alipay | wechat | paypal
 * @param {object} cfg     该平台保存的凭证
 * @param {object} opts    { order, subject, returnUrl, notifyUrl, cancelUrl }
 * @returns {Promise<{ok: boolean, kind?: string, url?: string, codeUrl?: string, svg?: string, tradeNo?: string, error?: string}>}
 */
async function createCharge(platform, cfg, opts) {
  const run = { alipay: alipayCreate, wechat: wechatCreate, paypal: paypalCreate }[platform];
  if (!run) return { ok: false, error: `未知的支付平台：${platform}` };
  try {
    const r = await run(cfg, opts);
    return Object.assign({ ok: true }, r);
  } catch (e) {
    // 网关错误信息可能含内部细节，统一截断；私钥等敏感值不会进入这里
    return { ok: false, error: String((e && e.message) || e).slice(0, 300) };
  }
}

/**
 * 主动查单（支付结果判定的唯一可信来源）
 * @returns {Promise<{paid: boolean, state: 'paid'|'pending'|'failed'|'error', tradeNo: string, failReason: string, error?: string}>}
 */
async function queryCharge(platform, cfg, order) {
  const run = { alipay: alipayQuery, wechat: wechatQuery, paypal: paypalQuery }[platform];
  if (!run) return { paid: false, state: 'error', tradeNo: '', failReason: `未知的支付平台：${platform}` };
  try {
    return await run(cfg, order);
  } catch (e) {
    // 查单失败一律当作"没能确认"，绝不乐观判定为已支付
    return { paid: false, state: 'error', tradeNo: '', failReason: String((e && e.message) || e).slice(0, 300) };
  }
}

module.exports = {
  TIMEOUT_MS, ALIPAY_GATEWAY, WECHAT_HOST,
  paypalHost, normalizePrivateKey, normalizePublicKey,
  alipaySignPayload, alipayBuildUrl, alipayTimestamp, alipayVerify,
  wechatSignPayload, wechatAuthorization, wechatDecryptResource,
  createCharge, queryCharge,
};
