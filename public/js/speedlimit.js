/**
 * 下载限速对话框 + 单位换算（R37）
 *
 * ## 为什么单独一个模块
 *
 * 与 `listdialog.js` 同一个理由（见那里的文件头）：对话框要能在测试沙箱里**原样运行**，
 * 而沙箱会把 `util.js` 的 `openModal` 换成桩 —— 写进 util.js 就会被一起换掉，
 * 测到的只是「测试自己写的一份副本」。所以对话框与换算都是本模块的导出，
 * 只从 util.js 取 `openModal` / `escapeHtml` / `toast` 三个原语。
 *
 * ## 谁在这里做「上层更严」的提示
 *
 * 需求：在「文件分享」里设 20 MB/s，而「API Key 管理」已设 5 MB/s 时，要提示
 * 「已在 API Key 管理中设置限速为 5 MB/S」。**提示值来自服务端**
 * （`GET /throttle/ceiling`，见 `server/routes/throttle.js`）—— 前端不自己拼：
 * 「这个桶归哪把密钥」的判据在服务端（`config-store.activeCredential`），
 * 在浏览器里重写一份必然与下载时真正生效的那份分叉。
 *
 * ⚠️ 提示**不是拦截**：仍然允许填更大的值并保存（等上层放宽后自然生效）。
 * 这一条是刻意的 —— 否则用户没法「先按计划配置好、再由管理员放开上层」。
 *
 * ## 单位口径（与后端 `server/limits.js` 必须同基数）
 *
 * 界面用 **MB/s**，存储与传输用 **字节/秒**整数（0 = 不限速）。
 * `1 MB = 1024 × 1024` 字节 —— 与 `util.fmtSize()` 同基数，否则「限速 1.5 MB/s
 * 传 150 MB 要多久」这种账用户算不平。
 */
import { openModal, escapeHtml, toast } from './util.js';
import { API } from './api.js';

/** 与 `server/limits.js` 的 `MB` 必须一致（1024 基数，非 1000） */
export const MB = 1024 * 1024;

/** 字节/秒 → MB/s（保留一位小数，0 = 不限速） */
export function toMBps(bytesPerSec) {
  const n = Number(bytesPerSec);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round((n / MB) * 10) / 10;
}

/** MB/s → 字节/秒整数 */
export function fromMBps(mbps) {
  const n = Number(mbps);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n * MB);
}

/**
 * 解析输入框里的 MB/s 文本 —— **唯一判据**。
 *
 * 与服务端 `limits.parseSpeedLimitInput` 是同一套语义（非法一律报错，绝不静默归零）：
 * 空串 / `0` 是合法的「不限速」；负数、非数字一律拒绝。
 * 前端这一层只是为了**当场给用户看得懂的提示**，服务端仍会再校验一次。
 *
 * @returns {{ok: true, bytes: number} | {ok: false, error: string}}
 */
export function parseMbpsInput(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (s === '') return { ok: true, bytes: 0 };
  const n = Number(s);
  if (!Number.isFinite(n)) return { ok: false, error: '请输入数字（0 表示不限速）' };
  if (n < 0) return { ok: false, error: '限速值不能为负数（0 表示不限速）' };
  if (n > 1024 * 1024) return { ok: false, error: '限速值过大' };
  return { ok: true, bytes: fromMBps(n) };
}

/** 限速值的展示文案：`不限速` / `5 MB/s`（四个列表卡片共用这一个实现点） */
export function speedText(bytesPerSec) {
  const mbps = toMBps(bytesPerSec);
  return mbps > 0 ? mbps + ' MB/s' : '不限速';
}

/**
 * 「上层更严」的提示文案 —— **唯一实现点**。
 *
 * 需求原文的句式：*「已在 API Key 管理中设置限速为 xx MB/S」*。写两遍就会出现
 * 「限速对话框里是全角、文件分享对话框里是半角」这类不可控的分叉，因此文案与
 * 比较逻辑都放这里。
 *
 * 语义（已与用户确认）：多层限速**取最小值**，下层只能更严。注意措辞必须精确 ——
 * 填更大的值**是允许保存的**（等上层放宽后自然生效），只是**不生效**；
 * 若写成「不能填更大」就成了一个并不存在的限制。
 *
 * @param {{limit:number, sourceLabel:string}|null} ceiling 服务端返回的上层限制
 * @param {number} bytes 用户当前填写的值（字节/秒）
 * @returns {string} 空串表示没有可提示的内容
 */
export function ceilingText(ceiling, bytes) {
  if (!ceiling || !(Number(ceiling.limit) > 0)) return '';
  const label = ceiling.sourceLabel || '';
  const base = `已在 ${label} 中设置限速为 ${toMBps(ceiling.limit)} MB/S`;
  if (Number(bytes) > Number(ceiling.limit)) {
    return `${base}；此处填更大的值不会生效，实际按 ${toMBps(ceiling.limit)} MB/s 传输。`;
  }
  return `上层限制：${base}；实际速率取两者中更小的那个。`;
}

/**
 * 查询上层限速（`GET /throttle/ceiling`）。
 *
 * 失败一律降级为 `null`（= 当作「没有上层限制」）：提示只是**锦上添花**，
 * 不能成为保存功能的前置条件 —— 查不到就让用户填不了限速，是拿可用性换取
 * 一句可有可无的说明。
 *
 * @param {{scope:string, id?:string, bucket?:string}} q
 */
export async function fetchCeiling(q) {
  try {
    const r = await API.throttleCeiling(q);
    return r && Number(r.limit) > 0 ? r : null;
  } catch (e) {
    return null;
  }
}

/**
 * 四张列表卡片的「限速」单元格 —— 当前值 + 打开对话框的按钮（**唯一实现点**）。
 *
 * 四张卡片（用户 / 访问密钥 / 存储桶 / 分享链接）与它们各自的「显示全部」对话框
 * 共用这一个渲染器（对话框复用卡片的 `rowHtml`，所以这里写一次、八个地方同时生效）。
 *
 * @param {string} scope `'credential'|'bucket'|'user'|'link'`
 * @param {string} id    实体 id（按钮自己带 `data-id` —— 扁平 `[data-act]` 查询拿不到行元素）
 * @param {number} current 当前限速（字节/秒）
 * @param {boolean} canEdit 当前用户是否有权修改（无权的只显示数值，不摆一个点了就 403 的按钮）
 */
export function speedCellHtml(scope, id, current, canEdit) {
  const on = toMBps(current) > 0;
  const badge = on
    ? `<span class="lk-badge warn" title="下载限速">${escapeHtml(speedText(current))}</span>`
    : '<span class="bk-sub">不限速</span>';
  const btn = canEdit
    ? `<button class="mini-btn" data-act="speed" data-id="${escapeHtml(id)}" data-scope="${escapeHtml(scope)}">限速</button>`
    : '';
  return badge + btn;
}

/**
 * 四类实体的保存入口（scope → 既有接口）。
 *
 * 刻意**复用各实体既有的 PUT**（`speedLimit` 只是又一个普通字段），而不是新开
 * 「设置限速」专用接口：同一字段两条写路径必然出现校验 / 审计 / 权限各写一份，
 * 正是本项目反复修掉的「同一状态多入口」。服务端各 PUT 已经挂了对应守卫
 * （密钥 / 存储桶 / 用户为管理员专属，链接为「创建者或管理员」）。
 */
export const SAVE_BY_SCOPE = {
  credential: (id, bytes) => API.updateCredential(id, { speedLimit: bytes }),
  bucket: (id, bytes) => API.updateBucket(id, { speedLimit: bytes }),
  user: (id, bytes) => API.updateUser(id, { speedLimit: bytes }),
  link: (id, bytes) => API.updateLink(id, { speedLimit: bytes }),
};

/** 每类实体在提示里怎么称呼（用于「已为「xxx」设置下载限速」这类文案） */
const SCOPE_LABELS = {
  credential: 'API Key 管理',
  bucket: '存储桶管理',
  user: '用户管理',
  link: '分享链接',
};

/**
 * 打开「下载限速」对话框。
 *
 * @param {object} o
 *  - `scope`    `'credential' | 'bucket' | 'user' | 'link'`
 *  - `id`       实体 id（修改现有条目时必填）
 *  - `name`     实体名称（标题里显示，便于确认改的是哪一条）
 *  - `current`  当前限速（字节/秒，0 = 不限速）
 *  - `bucket`   仅 `scope === 'link'` 且**新建**分享时用：此刻链接还不存在，
 *               只能按对话框里选中的桶名去查上层（服务端再解析出它绑定的密钥）
 *  - `onSaved`  保存成功回调（卡片据此刷新列表）
 */
export function openSpeedLimitDialog(o) {
  const scope = o.scope;
  const label = SCOPE_LABELS[scope] || scope;

  const wrap = document.createElement('div');
  wrap.className = 'sl-form';
  wrap.innerHTML = `
    <div class="sl-line">
      <span class="sl-name">${escapeHtml(o.name || '')}</span>
      <span class="sl-sub">下载限速</span>
    </div>
    <div class="sl-line">
      <input type="number" class="sl-input" min="0" step="0.1" value="${escapeHtml(String(toMBps(o.current) || ''))}" placeholder="0" autocomplete="off">
      <span class="sl-unit">MB/s</span>
    </div>
    <div class="sl-note">填 <b>0</b> 或留空表示<b>不限速</b>。限速按<b>实体聚合</b>：同一对象上的并发下载共享这一份带宽。</div>
    <div class="sl-ceil" hidden></div>
    <div class="sl-err" hidden></div>`;

  const input = wrap.querySelector('.sl-input');
  const ceilEl = wrap.querySelector('.sl-ceil');
  const errEl = wrap.querySelector('.sl-err');
  /** 上层（更高优先层）的生效限速，来自服务端；`null` 表示还没查到 */
  let ceiling = null;

  function renderCeil() {
    const r = parseMbpsInput(input.value);
    const txt = ceilingText(ceiling, r.ok ? r.bytes : 0);
    ceilEl.hidden = !txt;
    ceilEl.textContent = txt;
  }

  input.addEventListener('input', renderCeil);

  const modal = openModal({
    title: `下载限速 · ${escapeHtml(label)}`,
    body: wrap,
    cls: 'speedlimit-dialog',
    foot: [
      { text: '取消' },
      {
        text: '保存',
        cls: 'primary',
        onClick: async (overlay, close) => {
          const r = parseMbpsInput(input.value);
          if (!r.ok) { errEl.hidden = false; errEl.textContent = r.error; return; }
          errEl.hidden = true;
          try {
            await SAVE_BY_SCOPE[scope](o.id, r.bytes);
            toast(r.bytes > 0 ? `已设置下载限速 ${toMBps(r.bytes)} MB/s` : '已取消下载限速', { type: 'success' });
            close(true);
            if (o.onSaved) o.onSaved(r.bytes);
          } catch (e) {
            errEl.hidden = false;
            errEl.textContent = '保存失败：' + (e && e.message ? e.message : e);
          }
        },
      },
    ],
  });

  // 上层限制异步查（不阻塞弹窗打开）：失败就当「没有上层限制」，只影响提示文案，
  // 不影响保存 —— 提示不应成为功能可用性的前置条件。
  (async () => {
    const q = { scope };
    if (scope === 'link' && !o.id) q.bucket = o.bucket || '';
    else q.id = o.id;
    ceiling = await fetchCeiling(q);
    renderCeil();
  })();

  renderCeil();
  if (input.focus) input.focus();
  return modal;
}
