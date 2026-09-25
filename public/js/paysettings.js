/**
 * 支付设置 —— 系统设置页中的「支付设置」卡片
 *
 * 本模块只负责三件事：渲染各支付平台的凭证表单、调用服务端校验、保存 / 清除。
 * 表单结构与校验规则全部来自服务端（server/payment-providers.js），前端不做任何规则硬编码：
 * 界面拿到的 pattern 只是同一份规则的可序列化副本，用于即时提示，最终裁定永远在服务端。
 *
 * 角色边界：该卡片整体属于管理员专属（见 syssettings.js 的 ADMIN_ONLY_CARDS），
 * 普通用户整卡不可见且不会发起任何请求；服务端各接口也一律 requireAdmin。
 */
import { API } from './api.js';
import { toast, escapeHtml, confirmDialog, fmtTime } from './util.js';
import { App } from './main.js';
import { paymentLogo } from './payment-logos.js';

let wired = false;
let schema = []; // 平台定义（服务端下发）
let settings = {}; // { [platformId]: { values, configured, complete, enabled, available } }
let currentId = null; // 当前选中的平台
let updatedAt = '';
let globalEnabled = false; // 支付功能总开关
let availableChannels = []; // 当前真正可收款的渠道
let siteUrl = ''; // 站点对外地址（网关回调 / 支付完成回跳的目标）

/** 渲染期角色判断（真正的强制校验在服务端） */
function isAdmin() {
  return !!(App.state.user && App.state.user.role === 'admin');
}

function $(id) {
  return document.getElementById(id);
}

function currentPlatform() {
  return schema.find((p) => p.id === currentId) || null;
}

function currentSetting() {
  return settings[currentId] || { values: {}, configured: {}, complete: false };
}

/* ------------------------------ 加载 ------------------------------ */

export async function loadPayment() {
  if (!isAdmin()) return; // 普通用户整卡不可见，不发请求
  try {
    const r = await API.paymentConfig();
    schema = Array.isArray(r.platforms) ? r.platforms : [];
    settings = r.settings && typeof r.settings === 'object' ? r.settings : {};
    updatedAt = r.updatedAt || '';
    globalEnabled = !!r.enabled;
    availableChannels = Array.isArray(r.availableChannels) ? r.availableChannels : [];
    siteUrl = typeof r.siteUrl === 'string' ? r.siteUrl : '';
    if (!currentId || !schema.some((p) => p.id === currentId)) {
      currentId = schema.length ? schema[0].id : null;
    }
    wire();
    renderTabs();
    renderGlobalSwitch();
    renderChannelSwitch();
    renderForm();
    renderStatus();
    renderSiteUrl();
  } catch (e) {
    const el = $('payment-form');
    if (el) el.innerHTML = `<div class="hint">加载支付配置失败：${escapeHtml(e.message)}</div>`;
  }
}

/* ------------------------------ 渲染 ------------------------------ */

function renderSiteUrl() {
  const input = $('payment-site-url');
  if (!input) return;
  // 正在输入时不覆盖用户尚未保存的内容
  if (document.activeElement !== input) input.value = siteUrl;
}

/** 平台切换标签：图标 + 名称 + 配置状态圆点 */
function renderTabs() {
  const box = $('payment-tabs');
  if (!box) return;
  box.innerHTML = schema
    .map((p) => {
      const st = settings[p.id] || {};
      // 三态：可用（绿）/ 已启用但凭证待补全（橙）/ 未启用或未配置（灰）
      let dot = '';
      let tip = '未启用';
      if (st.enabled && st.complete) { dot = 'on'; tip = '已启用 · 可用于收款'; }
      else if (st.enabled) { dot = 'part'; tip = '已启用 · 待补全凭证'; }
      return `<button type="button" class="pay-tab${p.id === currentId ? ' active' : ''}${st.enabled ? '' : ' off'}" data-id="${escapeHtml(p.id)}" title="${tip}">
        ${paymentLogo(p.id, { size: 'sm' })}
        <span>${escapeHtml(p.name)}</span>
        <i class="pay-dot ${dot}"></i>
      </button>`;
    })
    .join('');
}

function renderStatus() {
  const el = $('payment-status');
  if (!el) return;
  const done = schema.filter((p) => (settings[p.id] || {}).complete).length;
  el.textContent = done ? `已配置 ${done} / ${schema.length}` : `共 ${schema.length} 个平台待配置`;
}

/* ------------------------------ 开关 ------------------------------ */

/** 总开关（卡片右上角） */
function renderGlobalSwitch() {
  const box = $('payment-enabled');
  const txt = $('payment-enabled-text');
  if (!box) return;
  box.checked = globalEnabled;
  if (txt) txt.textContent = globalEnabled ? '启用' : '停用';
}

async function toggleGlobal(on) {
  try {
    const r = await API.setPaymentEnabled(on);
    globalEnabled = !!r.enabled;
    availableChannels = Array.isArray(r.availableChannels) ? r.availableChannels : [];
    renderGlobalSwitch();
    renderTabs();
    renderChannelSwitch();
    renderStatus();
    setMsg(on ? '支付功能已启用。' : '支付功能已停用，所有付费链接已转为免费下载（原配置保留）。', 'ok');
    toast(on ? '支付功能已启用' : '支付功能已停用', { type: 'success' });
  } catch (e) {
    renderGlobalSwitch(); // 失败回滚开关显示
    setMsg('操作失败：' + e.message, 'bad');
    toast(e.message, { type: 'error', duration: 6000 });
  }
}

/** 当前渠道的独立开关 */
function renderChannelSwitch() {
  const box = $('payment-channel-on');
  const state = $('payment-channel-state');
  const hint = $('payment-channel-hint');
  const row = $('payment-channel-row');
  if (!box || !row) return;
  if (!currentId) { row.hidden = true; return; }
  row.hidden = false;

  const st = settings[currentId] || {};
  box.checked = !!st.enabled;

  // 三态区分：已启用且凭证完整 = 可用；已启用但凭证没填完 = 待补全；未启用 = 已停用
  let label = '已停用';
  if (st.enabled) label = st.complete ? '已启用 · 可用' : '已启用 · 待补全凭证';
  if (state) state.textContent = label;

  if (hint) {
    hint.innerHTML = st.enabled && !st.complete
      ? '该渠道已启用，但凭证尚未填写完整，下载者暂时无法选择它付款。'
      : (globalEnabled
        ? '关闭后下载者将无法通过该渠道付款。'
        : '支付功能当前处于停用状态，渠道开关不影响实际下载。');
  }
}

async function toggleChannel(on) {
  if (!currentId) return;
  try {
    const r = await API.setPaymentChannelEnabled(currentId, on);
    settings[currentId] = Object.assign({}, settings[currentId], { enabled: !!r.enabled, available: !!r.available });
    renderTabs();
    renderChannelSwitch();
    renderStatus();
    setMsg(`已${on ? '启用' : '停用'}该支付渠道。`, 'ok');
    toast(`支付渠道已${on ? '启用' : '停用'}`, { type: 'success' });
  } catch (e) {
    renderChannelSwitch(); // 失败回滚
    setMsg('操作失败：' + e.message, 'bad');
    toast(e.message, { type: 'error', duration: 6000 });
  }
}

/** 单个字段的控件 */
function fieldControl(f, value, configured) {
  const ph = escapeHtml(f.placeholder || '');

  if (f.input === 'select') {
    const opts = (f.options || [])
      .map((o) => `<option value="${escapeHtml(o.value)}"${o.value === value ? ' selected' : ''}>${escapeHtml(o.label)}</option>`)
      .join('');
    return `<select id="pay-f-${escapeHtml(f.key)}" data-key="${escapeHtml(f.key)}" class="pay-input">${opts}</select>`;
  }
  if (f.input === 'textarea') {
    const phText = f.secret && configured ? '已配置，留空保持不变' : ph;
    return `<textarea id="pay-f-${escapeHtml(f.key)}" data-key="${escapeHtml(f.key)}" class="pay-input pay-mono" rows="4" spellcheck="false" placeholder="${escapeHtml(phText)}"></textarea>`;
  }
  const type = f.input === 'secret' ? 'password' : 'text';
  const phText = f.secret && configured ? '已配置，留空保持不变' : ph;
  const ac = f.secret ? ' autocomplete="new-password"' : ' autocomplete="off" spellcheck="false"';
  return `<input type="${type}" id="pay-f-${escapeHtml(f.key)}" data-key="${escapeHtml(f.key)}" class="pay-input" placeholder="${escapeHtml(phText)}"${f.maxLength ? ` maxlength="${f.maxLength}"` : ''}${ac}>`;
}

/** 当前平台的表单 */
function renderForm() {
  const box = $('payment-form');
  if (!box) return;
  const p = currentPlatform();
  if (!p) {
    box.innerHTML = '';
    return;
  }
  const st = currentSetting();
  const hint = $('payment-hint');
  if (hint) {
    hint.textContent = updatedAt ? `上次更新 ${fmtTime(updatedAt)}` : '';
  }

  const html = `
    <div class="pay-doc">凭证来源：${escapeHtml(p.doc || '')}</div>
    <div class="pay-grid">
      ${p.fields
        .map((f) => {
          const v = st.values ? st.values[f.key] || '' : '';
          const cfg = st.configured ? !!st.configured[f.key] : false;
          const state = f.secret && cfg ? '<span class="pay-state">已配置</span>' : '';
          return `<div class="form-item" data-field="${escapeHtml(f.key)}">
            <label for="pay-f-${escapeHtml(f.key)}">${escapeHtml(f.label)}
              ${f.required ? '<span class="req">*</span>' : '<span class="pay-opt">选填</span>'}
              ${f.official ? `<code class="pay-official">${escapeHtml(f.official)}</code>` : ''}
              ${state}
            </label>
            ${fieldControl(f, v, cfg)}
            <div class="pay-err" data-err="${escapeHtml(f.key)}"></div>
            ${f.hint ? `<div class="hint">${escapeHtml(f.hint)}</div>` : ''}
          </div>`;
        })
        .join('')}
    </div>`;
  box.innerHTML = html;

  // 用 .value 回填非敏感字段（不走 HTML 拼接，避免任何转义问题）
  for (const f of p.fields) {
    const el = $(`pay-f-${f.key}`);
    if (!el) continue;
    const v = st.values ? st.values[f.key] || '' : '';
    if (f.input !== 'select' && v) el.value = v;

    // 失焦即时提示：pattern 与服务端同源，仅作参考，最终以服务端裁定为准
    el.addEventListener('blur', () => {
      const val = String(el.value || '').trim();
      const errBox = document.querySelector(`.pay-err[data-err="${cssEscape(f.key)}"]`);
      let msg = '';
      if (val && f.pattern && !new RegExp(f.pattern).test(val)) {
        msg = f.patternHint ? `格式不正确，应为${f.patternHint}` : '格式不正确';
      }
      if (errBox) {
        errBox.textContent = msg;
        errBox.classList.toggle('show', !!msg);
      }
      el.classList.toggle('pay-bad', !!msg);
    });
    el.addEventListener('input', () => {
      // 开始修改即清掉上一次的服务端错误标记，避免"已改对还飘红"
      const errBox = document.querySelector(`.pay-err[data-err="${cssEscape(f.key)}"]`);
      if (errBox) {
        errBox.textContent = '';
        errBox.classList.remove('show');
      }
      el.classList.remove('pay-bad');
    });
  }
}

function cssEscape(s) {
  return String(s).replace(/["\\]/g, '\\$&');
}

/* ------------------------------ 收集与提交 ------------------------------ */

function collectValues() {
  const p = currentPlatform();
  const out = {};
  if (!p) return out;
  for (const f of p.fields) {
    const el = $(`pay-f-${f.key}`);
    if (!el) continue;
    const v = String(el.value || '').trim();
    // 敏感字段留空 = 保持不变，交给服务端合并；此处仍提交空串，语义一致
    out[f.key] = v;
  }
  return out;
}

function clearErrors() {
  document.querySelectorAll('#payment-form .pay-err').forEach((el) => {
    el.textContent = '';
    el.classList.remove('show');
  });
  document.querySelectorAll('#payment-form .pay-input').forEach((el) => el.classList.remove('pay-bad'));
}

/** 把服务端返回的错误逐字段标注 */
function applyErrors(errors) {
  clearErrors();
  const list = Array.isArray(errors) ? errors : [];
  for (const e of list) {
    const errBox = document.querySelector(`.pay-err[data-err="${cssEscape(e.field)}"]`);
    if (errBox) {
      errBox.textContent = e.message || '校验未通过';
      errBox.classList.add('show');
    }
    const input = document.querySelector(`#payment-form [data-key="${cssEscape(e.field)}"]`);
    if (input) input.classList.add('pay-bad');
  }
  return list.length;
}

function setMsg(msg, kind) {
  const el = $('payment-msg');
  if (!el) return;
  if (!msg) {
    el.className = 'form-msg';
    el.textContent = '';
    return;
  }
  el.className = `form-msg show ${kind || 'info'}`;
  el.textContent = msg;
}

async function doValidate() {
  if (!currentId) return;
  setMsg('正在校验…', 'info');
  try {
    const r = await API.validatePayment(currentId, collectValues());
    const n = applyErrors(r.errors);
    if (r.ok) {
      setMsg('校验通过：必填项与格式均符合要求。', 'ok');
      toast('支付凭证校验通过', { type: 'success' });
    } else {
      setMsg(`校验未通过，共 ${n} 处需要修正（已在对应字段下方标出）。`, 'bad');
      toast(`校验未通过：${n} 处需要修正`, { type: 'error', duration: 5000 });
    }
  } catch (e) {
    setMsg('校验失败：' + e.message, 'bad');
  }
}

async function doSave() {
  if (!currentId) return;
  const p = currentPlatform();
  setMsg('正在保存…', 'info');
  try {
    const r = await API.savePayment(currentId, collectValues());
    settings[currentId] = { values: r.values, configured: r.configured, complete: r.complete, enabled: !!r.enabled, available: !!r.available };
    updatedAt = r.updatedAt || updatedAt;
    clearErrors();
    renderTabs();
    renderChannelSwitch();
    renderStatus();
    const empty = !(r.configured && Object.values(r.configured).some(Boolean));
    setMsg(
      empty
        ? '已清除该平台的凭证。'
        : `已保存${p ? p.name : ''}凭证${r.complete ? '，必填项完整。' : '，仍有必填项未填写，可继续补充。'}`,
      'ok',
    );
    toast('支付凭证已保存', { type: 'success' });
  } catch (e) {
    if (Array.isArray(e.errors)) {
      const n = applyErrors(e.errors);
      setMsg(`保存失败：${e.message}（共 ${n} 处）`, 'bad');
    } else {
      setMsg('保存失败：' + e.message, 'bad');
    }
    toast('保存失败，请检查标红的字段', { type: 'error', duration: 5000 });
  }
}

async function doClear() {
  if (!currentId) return;
  const p = currentPlatform();
  const ok = await confirmDialog({ allowHtml: true,
    title: '清除支付凭证',
    message: `确定要清除「<b>${escapeHtml(p ? p.name : currentId)}</b>」的全部凭证吗？此操作不可撤销。`,
    okText: '清除',
    danger: true,
  });
  if (!ok) return;
  try {
    await API.clearPayment(currentId);
    settings[currentId] = { values: {}, configured: {}, complete: false, enabled: false, available: false };
    clearErrors();
    renderTabs();
    renderChannelSwitch();
    renderForm();
    renderStatus();
    setMsg('已清除该平台的凭证。', 'ok');
    toast('支付凭证已清除', { type: 'success' });
  } catch (e) {
    setMsg('清除失败：' + e.message, 'bad');
  }
}

/* ------------------------------ 事件绑定 ------------------------------ */

function wire() {
  if (wired) return;
  const tabs = $('payment-tabs');
  const btnV = $('btn-payment-validate');
  const btnS = $('btn-payment-save');
  const btnC = $('btn-payment-clear');
  if (!tabs || !btnV || !btnS || !btnC) return;

  tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.pay-tab');
    if (!btn) return;
    const id = btn.getAttribute('data-id');
    if (!id || id === currentId) return;
    currentId = id;
    setMsg('', '');
    renderTabs();
    renderChannelSwitch();
    renderForm();
  });
  const gSwitch = $('payment-enabled');
  if (gSwitch) gSwitch.addEventListener('change', () => toggleGlobal(gSwitch.checked));
  const cSwitch = $('payment-channel-on');
  if (cSwitch) cSwitch.addEventListener('change', () => toggleChannel(cSwitch.checked));
  btnV.addEventListener('click', doValidate);
  btnS.addEventListener('click', doSave);
  btnC.addEventListener('click', doClear);
  const btnU = $('btn-payment-site-url');
  if (btnU) btnU.addEventListener('click', doSaveSiteUrl);
  wired = true;
}

/** 保存「站点对外地址」——单独一个接口，与平台凭证的保存互不干扰 */
async function doSaveSiteUrl() {
  const input = $('payment-site-url');
  if (!input) return;
  const v = input.value.trim();
  try {
    const r = await API.setPaymentSiteUrl(v);
    siteUrl = r.siteUrl || '';
    input.value = siteUrl;
    toast(siteUrl ? '站点对外地址已保存' : '已清除站点对外地址（改为按访问 Host 兜底）', { type: 'success' });
  } catch (e) {
    toast('保存失败：' + e.message, { type: 'error' });
  }
}

/** 登出 / 切换账号时复位，避免残留上一个账号的表单内容 */
export function resetPaymentView() {
  wired = false;
  schema = [];
  settings = {};
  currentId = null;
  updatedAt = '';
  globalEnabled = false;
  availableChannels = [];
  siteUrl = '';
  const su = $('payment-site-url');
  if (su) su.value = '';
  const form = $('payment-form');
  if (form) form.innerHTML = '';
  const tabs = $('payment-tabs');
  if (tabs) tabs.innerHTML = '';
  const st = $('payment-status');
  if (st) st.textContent = '';
  const row = $('payment-channel-row');
  if (row) row.hidden = true;
  const g = $('payment-enabled');
  if (g) g.checked = false;
  const gt = $('payment-enabled-text');
  if (gt) gt.textContent = '停用';
  setMsg('', '');
}
