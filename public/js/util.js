/** 通用工具：格式化 / Toast / 弹窗 / 图标 / Canvas 图表 */

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function fmtSize(bytes) {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes < 1024) return bytes + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return v.toFixed(v >= 100 ? 0 : 1) + ' ' + units[i];
}

export function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function debounce(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/**
 * R33：账户被封禁时的登录提示文案（需求 5：登录时能看到封禁原因与解封时间）。
 *
 * 服务端是在**密码校验通过之后**才下发 `reason` / `until` 的（见 `server/routes/auth.js`），
 * 因此把这两项展示出来**不会**变成「该用户名是否存在」的枚举通道。
 * `until` 为空串表示**永久封禁**，需管理员手动解除。
 *
 * ⚠️ 刻意放在 util.js 而不是 main.js：main.js 是带副作用的入口模块（import 即引导
 * 整个应用、要 DOM 要 fetch），测试里无法单独载入；这里是纯函数，能被真实断言
 * （见 tests/audit33-regressions.test.js），以免这段"给用户看的文案"长期没有护栏。
 */
export function banNotice(err) {
  const reason = String((err && err.reason) || '').trim();
  const until = String((err && err.until) || '').trim();
  let text = '该账户已被封禁，无法登录。';
  if (reason) text += `封禁原因：${reason}。`;
  text += until ? `解封时间：${fmtTime(until)}。` : '解封时间：永久封禁（需管理员手动解除）。';
  return text;
}

/**
 * R34：「关于」卡片「检查更新」的结果文案。
 *
 * 需求给定的两句原文：
 *  - 已是最新 → 「当前已是最新版本。」
 *  - 有新版本 → 「当前版本：xxx，最新版：xxx。若要更新，请前往服务器终端执行重新安装的命令。」
 *
 * ⚠️ 与 `banNotice` 同因放在 util.js：纯函数才能被测试**真实断言** ——
 * 只断言源码字样挡不住「两个版本号写反位」「拼错一个标点」这类事故，
 * 而这两句正是用户唯一能看到的信息。
 */
export function updateNotice(r) {
  if (!r || !r.latest) return '未能获取版本信息。';
  if (r.hasUpdate) {
    return `当前版本：${r.current}，最新版：${r.latest}。若要更新，请前往服务器终端执行重新安装的命令。`;
  }
  return '当前已是最新版本。';
}

/* ------------------- 用户列表：预览上限与搜索（R35） ------------------- */

/**
 * 「用户管理」卡片列表的**预览条数上限**（需求：卡片列表最多展示 10 个用户）。
 *
 * 放在 util.js 而不是 syssettings.js：卡片截断与「全部用户」对话框的提示语
 * 都要引用同一个数 —— 两处各写一个字面量 10，改一处就会出现
 * 「卡片显示 10 条、提示却写 20 条」这种自相矛盾的界面。
 */
export const USER_PREVIEW_LIMIT = 10;

/**
 * 关键词匹配 —— **所有列表筛选的唯一判据**（R36）。
 *
 * 规则：
 *  - 关键词去掉首尾空白；空关键词 → **恒为真**（等于「不过滤」）；
 *  - 大小写不敏感的子串匹配（`ali` 能命中 `Alice`）；
 *  - 可以一次给多个字段（`texts` 数组），**任一命中即算命中** —— 存储桶卡片要
 *    「一个搜索框同时搜桶名与备注」、分享链接要搜「文件名与分享者」，都走它；
 *  - 字段缺失 / 非字符串 → 安全降级为空串比较，绝不抛错（数据来自服务端，
 *    一条脏数据不该让整个对话框白屏）。
 *
 * 之所以提取出来，是因为四张卡片的筛选必须**同一条规则**：各写一份的必然结果是
 * 「密钥列表能搜大写、桶列表搜不到」这种没人会想到去核对的不一致。
 */
export function matchesQuery(query, texts) {
  const q = String(query == null ? '' : query).trim().toLowerCase();
  if (!q) return true;
  const list = Array.isArray(texts) ? texts : [texts];
  return list.some((t) => String(t == null ? '' : t).toLowerCase().indexOf(q) !== -1);
}

/**
 * 「显示全部」按钮的显隐判据与提示文案（**唯一实现点**，R36）。
 *
 * 判据用**严格大于**：正好等于上限时卡片已经完整展示了全部条目，此时再摆一个
 * 「显示全部」，点开只能看到与卡片一字不差的一份副本 —— 用户点了个寂寞。
 */
export function previewMoreState(total, limit, unit) {
  const over = total > limit;
  return { over, hint: over ? `卡片仅显示前 ${limit} ${unit}，共 ${total} ${unit}` : '' };
}

/**
 * 按用户名搜索过滤（R35 的「全部用户」对话框；R36 起支持按角色再筛一层）。
 *
 * 规则（**单一实现点**，卡片 / 对话框 / 将来的任何用户列表都走它）：
 *  - 关键词规则见 {@link matchesQuery}；
 *  - `role` 为空 → 不按角色过滤；给定 `'admin'` / `'user'` 时再做一次精确匹配；
 *  - **不修改入参**：调用方持有的是模块级 `usersState`，就地截断/排序会让
 *    下一次过滤基于已被改过的数据，且"刷新前"的列表被悄悄改掉。
 */
export function filterUsersByName(list, query, role) {
  const all = Array.isArray(list) ? list.slice() : [];
  const wantRole = String(role == null ? '' : role).trim();
  return all.filter((u) => matchesQuery(query, (u && u.username) || '')
    && (!wantRole || String((u && u.role) || '') === wantRole));
}

/* ------------------------------ Toast ------------------------------ */
export function toast(msg, opt = {}) {
  const root = document.getElementById('toast-root');
  const el = document.createElement('div');
  el.className = 'toast ' + (opt.type || '');
  el.textContent = msg;
  root.appendChild(el);
  const dur = opt.duration || (opt.type === 'error' ? 5000 : 2600);
  setTimeout(() => {
    el.style.transition = 'opacity .25s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 260);
  }, dur);
}

/* ------------------------------ 弹窗 ------------------------------ */

/**
 * 通用弹窗。
 *
 * body 三种形态（**安全默认**）：
 *  - HTMLElement —— 推荐：直接挂载，天然无注入风险
 *  - { text: string } —— 纯文本，内部自动转义
 *  - { html: string } —— 显式声明「我保证这段 HTML 是安全的」，调用方必须自行转义所有插值
 *
 * 为向后兼容仍接受裸字符串 body，但会**按 HTML 处理**（等价于 { html }）。
 * 新代码请勿使用裸字符串；含用户数据的请用 { text } 或传 DOM 节点。
 *
 * `wide` 给出 720px 的通用宽版；`cls`（R35 新增）用于**个别**弹窗的专属尺寸，
 * 例如「全部用户」要放下 7 列表格 → `cls: 'user-all-dialog'`（见 style.css）。
 * 用参数而不是调用后 `querySelector('.dialog').classList.add(...)`，是为了让
 * 「这个弹窗长什么样」和「它装了什么东西」在同一处声明，且能在测试里被断言。
 */
export function openModal({ title, body, foot, wide, cls, onClose }) {
  const root = document.getElementById('modal-root');
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `
    <div class="dialog ${wide ? 'wide' : ''} ${cls ? escapeHtml(cls) : ''}">
      <div class="dialog-head"><b>${escapeHtml(title || '')}</b><button class="icon-btn" data-x title="关闭">✕</button></div>
      <div class="dialog-body"></div>
      <div class="dialog-foot"></div>
    </div>`;
  const bodyEl = overlay.querySelector('.dialog-body');
  const footEl = overlay.querySelector('.dialog-foot');
  if (typeof body === 'string') {
    bodyEl.innerHTML = body;                        // 兼容旧调用（按 HTML 处理）
  } else if (body && typeof body === 'object' && !(body instanceof Node)) {
    if (body.text !== undefined) bodyEl.textContent = String(body.text);   // 安全：纯文本
    else if (body.html !== undefined) bodyEl.innerHTML = String(body.html); // 显式声明可信 HTML
  } else if (body) {
    bodyEl.appendChild(body);                       // DOM 节点
  }
  const btns = [];
  function close(result) {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    if (onClose) onClose(result);
    btns.resolve && btns.resolve(result);
  }
  (foot || []).forEach((f) => {
    const b = document.createElement('button');
    b.className = 'btn ' + (f.cls || '');
    b.textContent = f.text;
    b.onclick = () => (f.onClick ? f.onClick(overlay, close) : close(f.value));
    footEl.appendChild(b);
  });
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); }
  }
  overlay.querySelector('[data-x]').onclick = () => close(null);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(null); });
  document.addEventListener('keydown', onKey, true);
  root.appendChild(overlay);
  btns.resolve = null;
  return { close, overlay, bodyEl, footEl };
}

/**
 * 确认对话框。
 *
 * message 两种形态：
 *  - 默认（不传 allowHtml）：**纯文本**，内部自动转义，调用方无需处理
 *  - { allowHtml: true }：message 作为可信 HTML 渲染（需调用方自行转义插值）
 *
 * SEC-14：默认已改为**纯文本**（旧的 `allowHtml = true` 是极易复发的危险默认值 ——
 * 一旦某个调用点把服务端错误消息塞进 message，就是一个现成的 XSS 入口）。
 * 需要富文本时必须**显式**传 `allowHtml: true` 并自行转义插值，
 * 这样"没转义就渲染"从一个沉默的默认行为变成一处显眼的、可被 review 的声明。
 */
export function confirmDialog({ title = '确认', message, okText = '确定', danger, allowHtml = false }) {
  return new Promise((resolve) => {
    const content = allowHtml ? String(message || '') : escapeHtml(message || '');
    const m = openModal({
      title, body: { html: `<p style="line-height:1.7;font-size:13px">${content}</p>` },
      foot: [
        { text: '取消', onClick: (o, close) => { close(); resolve(false); } },
        { text: okText, cls: danger ? 'danger' : 'primary', onClick: (o, close) => { close(); resolve(true); } },
      ],
    });
    m.overlay.addEventListener('keydown', (e) => { if (e.key === 'Enter') { m.close(); resolve(true); } });
  });
}

export function promptDialog({ title, label, value = '', okText = '确定', hint }) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="form-item">
        <label>${escapeHtml(label || '')}</label>
        <input type="text" value="${escapeHtml(value)}">
        ${hint ? `<div class="hint">${hint}</div>` : ''}
      </div>`;
    const input = wrap.querySelector('input');
    const m = openModal({
      title, body: wrap,
      foot: [
        { text: '取消', onClick: (o, close) => { close(); resolve(null); } },
        { text: okText, cls: 'primary', onClick: (o, close) => { const v = input.value.trim(); if (!v) { input.focus(); return; } close(); resolve(v); } },
      ],
    });
    setTimeout(() => { input.focus(); input.select(); }, 30);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { const v = input.value.trim(); if (v) { m.close(); resolve(v); } }
    });
  });
}

/* ------------------------------ 配额超限提示（R25） ------------------------------ */

/**
 * 服务端配额超限的两枚机器可读码
 * （与 `server/bucket-stats.js` 的 `QUOTA_EXCEEDED_CODE` / `BUCKET_QUOTA_EXCEEDED_CODE`
 * **必须一致**，改一处就要改另一处）。
 *
 * R28-02：桶级配额此前只是展示值，本轮补上了服务端闸门，于是多了一枚码 ——
 * 两者的"出路"不同（一个去「系统设置 → 负载均衡」，一个去「存储桶管理」），
 * 所以对话框必须按 `scope` 分开说。
 */
export const QUOTA_EXCEEDED_CODE = 'CREDENTIAL_QUOTA_EXCEEDED';
export const BUCKET_QUOTA_EXCEEDED_CODE = 'BUCKET_QUOTA_EXCEEDED';

/**
 * 把「超出配额」的服务端错误渲染成**对话框**（其余错误返回 false 由调用方自理）。
 *
 * 放在 util.js 而不是 syssettings.js：它是纯展示助手（只用 openModal / escapeHtml / fmtSize），
 * 而 syssettings.js 与 main.js 互相 import —— 上传模块再去 import 它就会绕成
 * `upload → syssettings → main → upload` 的三方环。util.js 不依赖任何业务模块，零环风险。
 *
 * 为什么是对话框而不是 toast：需求要求「超出大小后…即弹窗告知」，且这个提示要给出
 * 已用 / 上限 / 本次待写三个数字与可执行出路；toast 一闪而过，用户往往还没来得及看清，
 * 就被后续每个文件各自的失败提示淹没。
 *
 * @param {Error & {code?: string, quota?: object}} err
 * @returns {boolean} true 表示已按配额错误处理（调用方不要再弹通用提示）
 */
export function showQuotaDialog(err) {
  if (!err) return false;
  const isBucket = err.code === BUCKET_QUOTA_EXCEEDED_CODE;
  if (err.code !== QUOTA_EXCEEDED_CODE && !isBucket) return false;
  const q = err.quota || {};
  const rows = [
    ['已使用', fmtSize(q.usedBytes || 0)],
    ['空间上限', fmtSize(q.quotaBytes || 0)],
  ];
  if (q.addBytes) rows.push(['本次待写入', fmtSize(q.addBytes)]);
  if (q.estimated) rows.push(['用量口径', '估算（桶内对象过多，未全量列举）']);
  /**
   * 出路按作用层级分开：桶级配额去「存储桶管理」调该桶上限；凭据级去「负载均衡」。
   * `scope` 由服务端下发（R28-02 起桶级错误带 `scope: 'bucket'`），老响应没有该字段时
   * 按凭据级处理，保持向后兼容。
   */
  const hint = isBucket
    ? '可在「存储桶管理」中编辑该桶的容量配额（填 0 表示无限制），或清理桶内文件后重试。'
    : '可在「系统设置 → 负载均衡」中调大该密钥的上限（填 0 表示无限制），或清理该密钥下的文件后重试。';
  openModal({
    title: isBucket ? '超出存储桶容量配额' : '超出 API Key 空间上限',
    body: { html: `<p style="line-height:1.7;font-size:13px">${escapeHtml(err.message || '存储空间已达上限。')}</p>
      <ul class="note-list" style="margin:8px 0 0">
        ${rows.map(([k, v]) => `<li>${escapeHtml(k)}：<b>${escapeHtml(v)}</b></li>`).join('')}
      </ul>
      <div class="hint" style="margin-top:8px">${escapeHtml(hint)}</div>` },
    foot: [{ text: '我知道了', cls: 'primary', onClick: (o, close) => close() }],
  });
  return true;
}

/* ------------------------------ 文件类型 ------------------------------ */

export const TYPE_LABEL = { folder: '文件夹', image: '图片', video: '视频', audio: '音频', doc: '文档', archive: '压缩包', other: '文件' };

const EXT_COLOR = { image: '#8e6ee0', video: '#e5484d', audio: '#0ea5a4', doc: '#4f8ef7', archive: '#d97706', other: '#98a1ad' };

export function extOf(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toUpperCase().slice(0, 4) : '';
}

/** 通用图标（SVG 徽标） */
export function iconHtml(item, badgeCls = 'badge') {
  if (item.isFolder) {
    return `<svg class="folder" viewBox="0 0 24 24" fill="currentColor"><path d="M4 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/></svg>`;
  }
  const ext = extOf(item.name) || '文件';
  return `<span class="${badgeCls} t-${item.type}">${escapeHtml(ext)}</span>`;
}

/* --------------------------- 属性面板（R36） --------------------------- */

/**
 * 「创建者 / 上传者」的展示值（R36 需求 1）。
 *
 * 数据来自**对象自身的元数据** —— 网页上传、分片上传、WebDAV 写入与新建文件夹时写入，
 * 因此**重命名 / 移动不会改变它**（服务器端复制默认保留元数据）。
 *
 * 而本版之前创建的对象云端根本没有这项元数据，此处如实显示「—」并说明原因：
 * **不拿「当前登录用户」或「最后操作者」顶替** —— 那是在编造一个看起来合理的事实，
 * 而属性面板的全部价值就在于它说的是真的。
 */
export function ownerText(u) {
  const name = String(u == null ? '' : u).trim();
  if (name) return escapeHtml(name);
  return '<span class="lk-dash" title="该对象创建于「记录上传者」功能之前，云端没有这项元数据">—</span>';
}

/**
 * 属性面板的正文 HTML（R36）—— **唯一渲染器**，卡片与各分支共用。
 *
 * 需求 1 是「文件夹显示**创建者**、文件显示**上传者**」：这条「标签随对象类型变」的规则
 * 只在这里出现一次。若照旧在两个 `if` 分支里各写一行 `row(...)`，将来给文件多加一行
 * （比如「加密」）时只改一处、另一处静默落后，就会出现「文件夹属性里有的项，文件属性里没有」
 * ——而两处看起来都"写了"。
 *
 * @param {object} st    `/fs/stat` 的返回（`isFolder` 决定走哪一支）
 * @param {string} type 文件类型的展示文案（由调用方按列表项给出，如「图片」）
 */
export function propertyBodyHtml(st, type) {
  const row = (label, value) =>
    `<div class="prop-row"><span class="prop-label">${label}</span><span class="prop-value">${value}</span></div>`;
  const fullPath = `<div class="prop-path" title="${escapeHtml(st.key)}">${escapeHtml(st.key)}</div>`;
  // ⚠️ 这一行是本需求的核心：文件夹 → 创建者，文件 → 上传者
  const ownerRow = row(st.isFolder ? '创建者' : '上传者', ownerText(st.uploader));
  if (st.isFolder) {
    return fullPath +
      row('名称', escapeHtml(st.name)) +
      row('类型', '文件夹') +
      ownerRow +
      row('创建时间', st.lastModified ? fmtTime(st.lastModified) : '—') +
      row('对象总数', st.reachedCap ? `≥ ${st.objectCount}（已达统计上限）` : String(st.objectCount));
  }
  return fullPath +
    row('名称', escapeHtml(st.name)) +
    row('类型', type) +
    ownerRow +
    row('创建时间', st.lastModified ? fmtTime(st.lastModified) : '—') +
    row('大小', `${fmtSize(st.size)}（${Number(st.size).toLocaleString()} 字节）`) +
    (st.encrypted ? row('加密', '已加密（云端存储为密文，此为解密后大小）') : '');
}

/* ------------------------------ Canvas 图表 ------------------------------ */

function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(300, rect.width || canvas.clientWidth || 300);
  const h = Number(canvas.getAttribute('height')) || 200;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

function niceBytes(v) {
  if (v < 1024) return v.toFixed(0) + 'B';
  if (v < 1048576) return (v / 1024).toFixed(0) + 'KB';
  if (v < 1073741824) return (v / 1048576).toFixed(1) + 'MB';
  return (v / 1073741824).toFixed(2) + 'GB';
}

/** 环形图（存储用量；total 为 0 表示无限制，仅展示已用） */
export function drawDonut(canvas, used, total) {
  const { ctx, w, h } = setupCanvas(canvas);
  const cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2 - 10;
  ctx.clearRect(0, 0, w, h);
  const unlimited = !(total > 0);
  const pct = unlimited ? 0 : Math.min(1, used / total);
  // 底环
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.lineWidth = 18; ctx.strokeStyle = '#eef1f5'; ctx.stroke();
  // 数据环
  if (unlimited) {
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.lineWidth = 18; ctx.strokeStyle = '#dce8f7'; ctx.stroke();
  } else if (pct > 0) {
    const grad = ctx.createLinearGradient(cx - r, cy, cx + r, cy);
    grad.addColorStop(0, pct > 0.85 ? '#e5484d' : '#4f8ef7');
    grad.addColorStop(1, pct > 0.85 ? '#f0a13c' : '#39b97b');
    ctx.beginPath();
    ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0.004, pct));
    ctx.lineWidth = 18; ctx.strokeStyle = grad; ctx.lineCap = 'round'; ctx.stroke();
  }
  // 中心文字
  ctx.fillStyle = '#1b1b1b';
  ctx.textAlign = 'center';
  if (unlimited) {
    ctx.font = '600 17px "Segoe UI","Microsoft YaHei",sans-serif';
    ctx.fillText(fmtSize(used), cx, cy + 2);
    ctx.fillStyle = '#8a8f98';
    ctx.font = '11px "Segoe UI","Microsoft YaHei",sans-serif';
    ctx.fillText('已用 · 无限制', cx, cy + 20);
  } else {
    ctx.font = '600 22px "Segoe UI","Microsoft YaHei",sans-serif';
    ctx.fillText((pct * 100).toFixed(pct >= 0.1 ? 1 : 2) + '%', cx, cy + 2);
    ctx.fillStyle = '#8a8f98';
    ctx.font = '11px "Segoe UI","Microsoft YaHei",sans-serif';
    ctx.fillText('已用容量', cx, cy + 20);
  }
}

/** 分组柱状图 */
export function drawGroupedBars(canvas, labels, series, { format = niceBytes } = {}) {
  const { ctx, w, h } = setupCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  const padL = 56, padB = 26, padT = 16, padR = 10;
  const iw = w - padL - padR, ih = h - padT - padB;
  const maxV = Math.max(1, ...series.flatMap((s) => s.values));
  // Y 轴刻度
  ctx.font = '10px "Segoe UI","Microsoft YaHei",sans-serif';
  ctx.fillStyle = '#8a8f98';
  ctx.strokeStyle = '#eef1f5';
  for (let i = 0; i <= 4; i++) {
    const y = padT + ih - (ih * i) / 4;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
    ctx.textAlign = 'right';
    ctx.fillText(format(maxV * i / 4), padL - 6, y + 3);
  }
  const groups = labels.length;
  const groupW = iw / groups;
  const barW = Math.max(3, Math.min(18, (groupW - 10) / series.length));
  labels.forEach((lab, gi) => {
    const gx = padL + groupW * gi + groupW / 2;
    series.forEach((s, si) => {
      const v = s.values[gi] || 0;
      const bh = (v / maxV) * ih;
      const x = gx - (series.length * barW) / 2 + si * barW;
      ctx.fillStyle = s.color;
      ctx.beginPath();
      ctx.roundRect(x, padT + ih - bh, barW - 2, Math.max(v > 0 ? 2 : 0, bh), 2);
      ctx.fill();
    });
    ctx.fillStyle = '#5a5f66';
    ctx.textAlign = 'center';
    ctx.fillText(lab, gx, h - 8);
  });
}

/** 堆叠柱状图 */
export function drawStackedBars(canvas, labels, series, { format = (v) => String(Math.round(v)) } = {}) {
  const { ctx, w, h } = setupCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  const padL = 46, padB = 26, padT = 16, padR = 10;
  const iw = w - padL - padR, ih = h - padT - padB;
  const totals = labels.map((_, i) => series.reduce((s, sr) => s + (sr.values[i] || 0), 0));
  const maxV = Math.max(1, ...totals);
  ctx.font = '10px "Segoe UI","Microsoft YaHei",sans-serif';
  for (let i = 0; i <= 4; i++) {
    const y = padT + ih - (ih * i) / 4;
    ctx.strokeStyle = '#eef1f5';
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
    ctx.fillStyle = '#8a8f98';
    ctx.textAlign = 'right';
    ctx.fillText(format(maxV * i / 4), padL - 6, y + 3);
  }
  const groupW = iw / labels.length;
  const barW = Math.max(6, Math.min(36, groupW - 14));
  labels.forEach((lab, gi) => {
    const gx = padL + groupW * gi + groupW / 2 - barW / 2;
    let y = padT + ih;
    series.forEach((s) => {
      const v = s.values[gi] || 0;
      if (v <= 0) return;
      const bh = (v / maxV) * ih;
      y -= bh;
      ctx.fillStyle = s.color;
      ctx.fillRect(gx, y, barW, Math.max(1, bh - 1));
    });
    ctx.fillStyle = '#5a5f66';
    ctx.textAlign = 'center';
    ctx.fillText(lab, gx + barW / 2, h - 8);
  });
}

/** 水平条形图（请求类型分布） */
export function drawHBars(canvas, rows, { color = '#4f8ef7', failColor = '#e5484d' } = {}) {
  const { ctx, w, h } = setupCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  const rowsH = 30;
  const maxLen = Math.min(rows.length, Math.floor((h - 10) / rowsH));
  const shown = rows.slice(0, maxLen);
  const padL = 64, padR = 150;
  const maxV = Math.max(1, ...shown.map((r) => r.ok + r.fail));
  ctx.font = '11px "Segoe UI","Microsoft YaHei",sans-serif';
  shown.forEach((r, i) => {
    const y = 8 + i * rowsH;
    ctx.fillStyle = '#444';
    ctx.textAlign = 'left';
    ctx.fillText(r.type, 4, y + 12);
    const total = r.ok + r.fail;
    const bw = ((w - padL - padR) * total) / maxV;
    const okw = total ? (bw * r.ok) / total : 0;
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.roundRect(padL, y + 2, okw, 14, 3); ctx.fill();
    if (r.fail > 0) {
      ctx.fillStyle = failColor;
      ctx.beginPath(); ctx.roundRect(padL + okw, y + 2, Math.max(2, bw - okw), 14, 3); ctx.fill();
    }
    ctx.fillStyle = '#5a5f66';
    ctx.textAlign = 'left';
    const rate = total ? ((r.ok / total) * 100).toFixed(1) : '—';
    ctx.fillText(`${total} 次 · 成功率 ${rate}%`, padL + bw + 10, y + 13);
  });
}
