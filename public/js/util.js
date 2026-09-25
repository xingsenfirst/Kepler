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
 */
export function openModal({ title, body, foot, wide, onClose }) {
  const root = document.getElementById('modal-root');
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `
    <div class="dialog ${wide ? 'wide' : ''}">
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
