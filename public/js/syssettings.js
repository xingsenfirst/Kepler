/** 系统设置 —— 文件加密（隐私保护）：加密方式 / 魔数 / 查看密码 / 用户管理（管理员） */
import { API } from './api.js';
import { toast, escapeHtml, confirmDialog, openModal, fmtTime } from './util.js';
import { App } from './main.js';
import { registerWindowsHello, webauthnReadiness } from './webauthn.js';
import { loadPayment, resetPaymentView } from './paysettings.js';

let wired = false;
let current = null; // 服务端当前生效设置

const MODE_LABEL = { none: '不加密', crypto: 'crypto（AES-256-GCM）', magic: '文件头魔数（轻量混淆）' };

/** 渲染期角色判断（真正的强制校验在服务端；此处仅避免发起注定 403 的请求与闪现错误） */
function isAdmin() {
  return !!(App.state.user && App.state.user.role === 'admin');
}

/**
 * 仅管理员可见的卡片。
 *
 * **用户管理卡片（`sysset-user-card`）也在其中** —— 普通用户根本不应该看到它，
 * 其自助资料编辑改由右上角账户菜单的「编辑资料」承载（独立的弹窗，互不干扰）。
 *
 * 这样设计的关键收益：**同一张卡片不再需要同时服务两种角色**。
 * 此前它要在「用户管理 / 我的资料」之间来回切换，只要有一个分支漏改，
 * 换账号时就会残留上一个角色的 DOM（越权显示用户列表）。整卡按角色显隐之后，
 * 角色切换只是"显示 / 隐藏一个整块"，不存在需要还原的中间状态。
 */
const ADMIN_ONLY_CARDS = ['sysset-user-card', 'sysset-enc-card', 'sysset-excludes-card', 'sysset-webdav-card', 'sysset-captcha-card', 'sysset-payment-card'];

/** 隐藏仅管理员可见的卡片（非管理员直接不渲染其内容） */
function setAdminCardVisible(cardId, visible) {
  const el = document.getElementById(cardId);
  if (el) el.hidden = !visible;
  if (!visible) {
    const card = document.getElementById(cardId);
    // 隐藏时顺带清空动态内容，避免 DOM 里仍留着上一角色的用户列表
    if (card && cardId === 'sysset-user-card') {
      const table = document.getElementById('user-table');
      if (table) table.innerHTML = '';
      const countEl = document.getElementById('user-count');
      if (countEl) countEl.textContent = '';
    }
  }
}

/** 当前是否应显示用户管理卡片（唯一判据，避免多处判断不一致） */
function canManageUsers() {
  return isAdmin();
}

export function refresh() {
  wire();
  const sec = document.getElementById('systemsettings');
  if (!sec) return;
  const admin = isAdmin();

  // 非管理员：整块隐藏全部管理类卡片（含用户管理），只保留「关于」。
  // 普通用户要改自己的资料 → 右上角账户菜单「编辑资料」。
  if (!admin) {
    ADMIN_ONLY_CARDS.forEach((id) => setAdminCardVisible(id, false));
    resetPaymentView(); // 整卡隐藏时一并复位，避免残留上一个账号的凭证表单
    let tip = sec.querySelector('.sysset-nonadmin');
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'sysset-nonadmin lk-empty';
      tip.textContent = '普通用户仅可管理由管理员分配的存储桶。用户管理、文件加密、上传排除、WebDAV 服务、登录验证、支付设置等功能是否可操作由管理员决定。';
      sec.appendChild(tip);
    }
    return;
  }

  // 管理员：清除只读提示并正常加载全部卡片
  const oldTip = sec.querySelector('.sysset-nonadmin');
  if (oldTip) oldTip.remove();
  ADMIN_ONLY_CARDS.forEach((id) => setAdminCardVisible(id, true));

  loadUsers();
  API.encSettings().then((s) => {
    current = s;
    render(s);
  }).catch((e) => {
    const box = document.getElementById('sysset-enc-body');
    if (box) box.innerHTML = `<div class="lk-empty">加密设置加载失败：${escapeHtml(e.message)}</div>`;
  });
  loadExcludes();
  loadWebdav();
  loadCaptcha();
  loadPayment();
}

function wire() {
  if (wired) return;
  wired = true;
  const save = document.getElementById('btn-enc-save');
  if (save) save.onclick = saveSettings;
  const saveEx = document.getElementById('btn-excludes-save');
  if (saveEx) saveEx.onclick = saveExcludes;
  document.querySelectorAll('input[name="enc-mode"]').forEach((r) => {
    r.addEventListener('change', toggleBlocks);
  });
  const magic = document.getElementById('enc-magic');
  if (magic) magic.addEventListener('input', previewMagic);
  // WebDAV
  const wEnabled = document.getElementById('webdav-enabled');
  if (wEnabled) wEnabled.addEventListener('change', () => toggleWebdav(wEnabled.checked));
  const wAdd = document.getElementById('btn-webdav-add');
  if (wAdd) wAdd.onclick = () => showAccountForm(null);
  const wCopy = document.getElementById('btn-webdav-copy-url');
  if (wCopy) wCopy.onclick = copyWebdavUrl;
  // 用户管理
  const btnUserAdd = document.getElementById('btn-user-add');
  if (btnUserAdd) btnUserAdd.onclick = () => showUserForm(null);
  // 验证码服务
  const capEnabled = document.getElementById('captcha-enabled');
  if (capEnabled) capEnabled.addEventListener('change', () => {
    const t = document.getElementById('captcha-enabled-text');
    if (t) t.textContent = capEnabled.checked ? '启用' : '停用';
  });
  const capSave = document.getElementById('btn-captcha-save');
  if (capSave) capSave.onclick = saveCaptchaSettings;
  // 分段选择（服务商 / 失败策略）
  ['captcha-provider', 'captcha-onerror'].forEach((id) => {
    const wrap = document.getElementById(id);
    if (!wrap) return;
    wrap.querySelectorAll('.chip').forEach((b) => {
      b.addEventListener('click', () => {
        wrap.querySelectorAll('.chip').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
      });
    });
  });
}

function toggleBlocks() {
  const mode = document.querySelector('input[name="enc-mode"]:checked');
  const v = mode ? mode.value : 'none';
  const magicBlock = document.getElementById('enc-magic-block');
  const cryptoBlock = document.getElementById('enc-crypto-block');
  if (magicBlock) magicBlock.hidden = v !== 'magic';
  if (cryptoBlock) cryptoBlock.hidden = v !== 'crypto';
}

/** 魔数十六进制预览 */
function previewMagic() {
  const input = document.getElementById('enc-magic');
  const out = document.getElementById('enc-magic-preview');
  if (!input || !out) return;
  const s = input.value.trim();
  if (!s) { out.textContent = '当前默认：ENCRYPTED（9 字节）'; return; }
  let hex;
  if (/^0x[0-9a-f]*$/i.test(s)) {
    if (s.length % 2 !== 0) { out.textContent = '⚠️ 十六进制长度须为偶数个字符'; return; }
    hex = s.slice(2);
  } else {
    hex = Array.from(new TextEncoder().encode(s)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  const bytes = hex.length / 2;
  if (bytes > 64) { out.textContent = `⚠️ 魔数过长（${bytes} 字节，上限 64 字节）`; return; }
  out.textContent = `预览：${bytes} 字节 → ${hex.toUpperCase() || '（空）'}`;
}

function render(s) {
  const radio = document.querySelector(`input[name="enc-mode"][value="${s.mode}"]`);
  if (radio) radio.checked = true;
  const magic = document.getElementById('enc-magic');
  if (magic) magic.value = s.mode === 'magic' && s.magicText && !/^[0-9a-f]+$/i.test(s.magicText) ? s.magicText : '';
  const pw = document.getElementById('enc-password');
  if (pw) pw.value = '';
  const status = document.getElementById('enc-status');
  if (status) {
    status.textContent = s.mode === 'none'
      ? (s.encryptedCount ? `（当前不加密 · 历史加密文件 ${s.encryptedCount} 个）` : '（当前不加密）')
      : `（当前：${MODE_LABEL[s.mode] || s.mode} · 已加密 ${s.encryptedCount} 个文件${s.passwordSet ? ' · 已设查看密码' : ''}）`;
  }
  const pwInput = document.getElementById('enc-password');
  if (pwInput) pwInput.placeholder = s.passwordSet ? '已设置（留空保持不变，输入新值则更换）' : '设置后查看 / 下载加密文件需先验证此密码';
  toggleBlocks();
  previewMagic();
}

async function saveSettings() {
  const modeEl = document.querySelector('input[name="enc-mode"]:checked');
  const mode = modeEl ? modeEl.value : 'none';
  const magic = (document.getElementById('enc-magic').value || '').trim();
  const pwEl = document.getElementById('enc-password');
  const pw = pwEl.value;

  // 随机盐默认恒开，不再由前端提交（服务端强制 useSalt=true）
  const body = { mode };
  if (magic) body.magic = magic;
  // 密码语义：留空 = 保持现状（未设置时留空 = 不设置）
  if (pw !== '') body.password = pw;

  // 开启加密时明确提醒密文现象与密钥备份
  if (mode !== 'none' && (!current || current.mode !== mode)) {
    const ok = await confirmDialog({ allowHtml: true,
      title: '开启文件加密',
      message: `即将以「<b>${MODE_LABEL[mode]}</b>」加密之后上传的文件。<br>
        <ul class="bm-cond-list">
          <li>文件在本地加密后才上传，<b>服务商控制台中看到的同样是密文</b>（无法直接预览内容）。</li>
          <li>加密密钥与元数据保存在本地 <code>data/enc.key</code> / <code>data/enc-meta.json</code>，<b>请立即备份</b>——密钥丢失后密文将无法解密。</li>
          <li>已上传的文件不受影响（保持明文）；修改方式只对新上传生效。</li>
        </ul>
        确认开启吗？`,
      okText: '开启加密', danger: true,
    });
    if (!ok) return;
  }

  try {
    const s = await API.updateEncSettings(body);
    current = s;
    render(s);
    toast(`已保存：${MODE_LABEL[s.mode] || s.mode}`, { type: 'success' });
    window.dispatchEvent(new CustomEvent('enc-settings-changed'));
  } catch (e) {
    toast('保存失败：' + e.message, { type: 'error', duration: 6000 });
  }
}

/* ------------------------- 上传排除设置 ------------------------- */

const DEFAULT_EXCLUDES = { dsStore: false, thumbsDb: false, gitignore: false };

function loadExcludes() {
  API.uploadExcludes().then((s) => {
    App.state.uploadExcludes = Object.assign({}, DEFAULT_EXCLUDES, s || {});
    renderExcludes();
  }).catch(() => { /* 服务不可用时保持默认 */ });
}

function renderExcludes() {
  const ex = Object.assign({}, DEFAULT_EXCLUDES, App.state.uploadExcludes || {});
  const set = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.checked = !!v;
  };
  set('ex-dsstore', ex.dsStore);
  set('ex-thumbsdb', ex.thumbsDb);
  set('ex-gitignore', ex.gitignore);
}

async function saveExcludes() {
  const body = {
    dsStore: document.getElementById('ex-dsstore').checked,
    thumbsDb: document.getElementById('ex-thumbsdb').checked,
    gitignore: document.getElementById('ex-gitignore').checked,
  };
  try {
    const s = await API.saveUploadExcludes(body);
    App.state.uploadExcludes = Object.assign({}, DEFAULT_EXCLUDES, s || {});
    toast('上传排除设置已保存，上传时即时生效', { type: 'success' });
  } catch (e) {
    toast('保存失败：' + e.message, { type: 'error', duration: 6000 });
  }
}

/* ------------------------- WebDAV 服务 ------------------------- */

let webdavState = null; // { enabled, accounts, mount, port, serverUrl, running }

function loadWebdav() {
  API.webdav().then((w) => {
    webdavState = w;
    renderWebdav(w);
  }).catch(() => { /* 服务不可用时静默 */ });
}

function renderWebdav(w) {
  const sw = document.getElementById('webdav-enabled');
  const swText = document.getElementById('webdav-enabled-text');
  if (sw) sw.checked = !!w.enabled;
  if (swText) swText.textContent = w.enabled ? '启用' : '停用';

  const urlEl = document.getElementById('webdav-url');
  if (urlEl) urlEl.textContent = w.serverUrl || (w.enabled ? `https://<本机IP>:${w.port}${w.mount}` : '—');

  const hint = document.getElementById('webdav-run-hint');
  if (hint) {
    if (w.running) {
      hint.textContent = `服务运行中 · 端口 ${w.port} · 挂载点 ${w.mount}（强制 HTTPS）。`;
      hint.style.color = '#16a34a';
    } else if (w.enabled && (!w.accounts || w.accounts.length === 0)) {
      hint.textContent = '已启用，但尚无账户。请添加至少一个账户后服务将自动启动。';
      hint.style.color = '#b45309';
    } else if (w.enabled) {
      hint.textContent = '已启用，服务正在启动…';
      hint.style.color = '#6b7280';
    } else {
      hint.textContent = '服务未运行。启用开关且至少存在一个账户后，服务将在 HTTPS 端口启动。';
      hint.style.color = '#999';
    }
  }

  const panel = document.getElementById('webdav-panel');
  if (panel) panel.hidden = !w.enabled;

  const list = document.getElementById('webdav-account-list');
  if (list) {
    if (!w.accounts || w.accounts.length === 0) {
      list.innerHTML = '';
    } else {
      list.innerHTML = w.accounts.map((a) => accountCardHTML(a, w)).join('');
      // 绑定每张卡片的按钮事件
      list.querySelectorAll('[data-act]').forEach((btn) => {
        const act = btn.getAttribute('data-act');
        const id = btn.getAttribute('data-id');
        if (act === 'edit') btn.onclick = () => showAccountForm(getAccountById(id));
        else if (act === 'reveal') btn.onclick = () => revealPassword(id, btn);
        else if (act === 'delete') btn.onclick = () => deleteAccount(id);
      });
    }
  }
}

function getAccountById(id) {
  if (!webdavState || !webdavState.accounts) return null;
  return webdavState.accounts.find((a) => a.id === id) || null;
}

function accountCardHTML(a, w) {
  const accName = escapeHtml(a.appName || '');
  const username = escapeHtml(a.username || '');
  const serverUrl = escapeHtml(w.serverUrl || `https://<本机IP>:${w.port}${w.mount}`);
  const hasPw = a.hasPassword ? '已设置' : '未设置';
  return `<div class="wd-card">
    <div class="wd-card-main">
      <div class="wd-card-app">${accName}<span class="wd-badge ${w.running ? 'run' : ''}">${w.running ? '运行中' : '已停用'}</span></div>
      <div class="wd-card-sub">
        <span>用户名：<code>${username}</code></span>
        <span>服务器：<code>${serverUrl}</code></span>
        <span>密码：<span class="wd-pw" data-pw="${a.id}">${'•'.repeat(8)}（${hasPw}）</span></span>
      </div>
    </div>
    <div class="wd-acts">
      <button class="mini-btn" data-act="reveal" data-id="${a.id}" type="button">${a.hasPassword ? '显示密码' : '—'}</button>
      <button class="mini-btn" data-act="edit" data-id="${a.id}" type="button">编辑</button>
      <button class="mini-btn danger" data-act="delete" data-id="${a.id}" type="button">删除</button>
    </div>
  </div>`;
}

async function toggleWebdav(enabled) {
  if (enabled && (!webdavState || !webdavState.accounts || webdavState.accounts.length === 0)) {
    toast('请先添加至少一个 WebDAV 账户再启用服务', { type: 'warn', duration: 4000 });
    const sw = document.getElementById('webdav-enabled');
    if (sw) sw.checked = false;
    const swText = document.getElementById('webdav-enabled-text');
    if (swText) swText.textContent = '停用';
    showAccountForm(null);
    return;
  }
  try {
    const w = await API.setWebdavEnabled(enabled);
    webdavState = w;
    renderWebdav(w);
    toast(`WebDAV 服务已${enabled ? '启用' : '停用'}`, { type: 'success' });
  } catch (e) {
    toast('操作失败：' + e.message, { type: 'error', duration: 6000 });
    loadWebdav(); // 回滚状态
  }
}

function showAccountForm(account) {
  const isEdit = !!account;
  const form = document.createElement('div');
  form.className = 'wd-form';
  form.innerHTML = `
    <div class="form-item">
      <label>应用名称 <span class="req">*</span></label>
      <input type="text" id="wd-f-appname" maxlength="64" placeholder="如：Raidrive / Finder / Rclone" value="${isEdit ? escapeHtml(account.appName || '') : ''}" autocomplete="off">
      <div class="hint">用于标识此账户对应的第三方应用，方便管理。</div>
    </div>
    <div class="form-item">
      <label>用户名 <span class="req">*</span></label>
      <input type="text" id="wd-f-username" maxlength="64" placeholder="WebDAV 登录用户名" value="${isEdit ? escapeHtml(account.username || '') : ''}" autocomplete="off">
    </div>
    <div class="form-item">
      <label>密码 ${isEdit ? '<span class="hint" style="margin-left:6px">留空则不修改</span>' : '<span class="req">*</span>'}</label>
      <input type="password" id="wd-f-password" maxlength="128" placeholder="${isEdit ? '留空保持原密码不变' : 'WebDAV 登录密码'}" autocomplete="new-password">
    </div>
    <div class="form-item">
      <label>确认密码 ${isEdit ? '<span class="hint" style="margin-left:6px">留空则不修改</span>' : '<span class="req">*</span>'}</label>
      <input type="password" id="wd-f-confirm" maxlength="128" placeholder="${isEdit ? '留空保持原密码不变' : '再次输入密码'}" autocomplete="new-password">
    </div>
    ${!isEdit ? `<div class="hint"><b> 此功能可能产生大量读、上传和下载流量。</b></div>` : ''}
  `;

  const m = openModal({
    title: isEdit ? '编辑 WebDAV 账户' : '添加 WebDAV 账户',
    body: form,
    wide: true,
    foot: [
      { text: '取消', onClick: (o, close) => close() },
      { text: isEdit ? '保存修改' : '创建账户', cls: 'primary', onClick: (o, close) => saveAccountFromForm(o, close, account) },
    ],
  });

  // 回车提交
  form.querySelectorAll('input').forEach((inp) => {
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveAccountFromForm(m.overlay, m.close, account); } });
  });
}

async function saveAccountFromForm(overlay, close, account) {
  const appName = (overlay.querySelector('#wd-f-appname') || {}).value || '';
  const username = (overlay.querySelector('#wd-f-username') || {}).value || '';
  const password = (overlay.querySelector('#wd-f-password') || {}).value || '';
  const confirm = (overlay.querySelector('#wd-f-confirm') || {}).value || '';
  const isEdit = !!account;

  // 必填校验
  if (!appName.trim()) { toast('应用名称不能为空', { type: 'error' }); return; }
  if (!username.trim()) { toast('用户名不能为空', { type: 'error' }); return; }
  if (!isEdit && !password) { toast('密码不能为空', { type: 'error' }); return; }
  // 密码一致性
  if (password !== confirm) { toast('两次输入的密码不一致', { type: 'error' }); return; }
  // 编辑时若填写了密码，也需一致
  if (isEdit && password && password !== confirm) { toast('两次输入的密码不一致', { type: 'error' }); return; }

  const body = { appName: appName.trim(), username: username.trim() };
  if (password) body.password = password;
  if (password) body.confirmPassword = confirm;

  try {
    let w;
    if (isEdit) {
      w = await API.updateWebdavAccount(account.id, body);
    } else {
      w = await API.addWebdavAccount(body);
    }
    webdavState = w;
    renderWebdav(w);
    close();
    toast(isEdit ? '账户已更新' : '账户已创建', { type: 'success' });
  } catch (e) {
    toast('保存失败：' + e.message, { type: 'error', duration: 6000 });
  }
}

async function revealPassword(id, btn) {
  try {
    const result = await API.revealWebdavPassword(id);
    const pwSpan = document.querySelector(`[data-pw="${id}"]`);
    if (pwSpan && result.password != null) {
      const showing = pwSpan.getAttribute('data-showing') === '1';
      if (showing) {
        pwSpan.textContent = '•'.repeat(8) + '（已设置）';
        pwSpan.setAttribute('data-showing', '0');
        if (btn) btn.textContent = '显示密码';
      } else {
        pwSpan.textContent = result.password || '(空)';
        pwSpan.setAttribute('data-showing', '1');
        if (btn) btn.textContent = '隐藏密码';
      }
    }
  } catch (e) {
    toast('获取密码失败：' + e.message, { type: 'error', duration: 6000 });
  }
}

async function deleteAccount(id) {
  const acc = getAccountById(id);
  const name = acc ? acc.appName : '此账户';
  const ok = await confirmDialog({ allowHtml: true,
    title: '删除 WebDAV 账户',
    message: `确定要删除账户「<b>${escapeHtml(name)}</b>吗？<br>删除后使用此账户的客户端将无法继续访问 WebDAV 服务。`,
    okText: '删除', danger: true,
  });
  if (!ok) return;
  try {
    const w = await API.deleteWebdavAccount(id);
    webdavState = w;
    renderWebdav(w);
    toast('账户已删除', { type: 'success' });
  } catch (e) {
    toast('删除失败：' + e.message, { type: 'error', duration: 6000 });
  }
}

async function copyWebdavUrl() {
  const url = (webdavState && webdavState.serverUrl) || '';
  if (!url || url === '—') { toast('服务未运行，暂无地址可复制', { type: 'warn' }); return; }
  try {
    await navigator.clipboard.writeText(url);
    toast('服务器地址已复制到剪贴板', { type: 'success' });
  } catch (e) {
    // 降级方案
    const ta = document.createElement('textarea');
    ta.value = url;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('服务器地址已复制', { type: 'success' }); }
    catch (_) { toast('复制失败，请手动选择地址复制', { type: 'error' }); }
    document.body.removeChild(ta);
  }
}

/* ============================ 登录人机验证（CAPTCHA） ============================ */

let captchaCfg = null;

function chipValue(id) {
  const el = document.querySelector('#' + id + ' .chip.active');
  return el ? el.dataset.v : '';
}

function chipSelect(id, val) {
  const wrap = document.getElementById(id);
  if (!wrap) return;
  wrap.querySelectorAll('.chip').forEach((b) => b.classList.toggle('active', b.dataset.v === String(val)));
}

function renderCaptcha(c) {
  c = c || {};
  const en = document.getElementById('captcha-enabled');
  if (en) en.checked = !!c.enabled;
  const enText = document.getElementById('captcha-enabled-text');
  if (enText) enText.textContent = c.enabled ? '启用' : '停用';
  chipSelect('captcha-provider', c.provider || 'recaptcha');
  const siteKey = document.getElementById('captcha-sitekey');
  if (siteKey) siteKey.value = c.siteKey || '';
  const secret = document.getElementById('captcha-secretkey');
  if (secret) secret.value = '';
  const secState = document.getElementById('captcha-secret-state');
  if (secState) secState.textContent = c.hasSecret ? '（已设置，留空保持不变）' : '（未设置）';
  const timeout = document.getElementById('captcha-timeout');
  if (timeout) timeout.value = c.timeoutMs || 5000;
  chipSelect('captcha-onerror', c.onError || 'block');
  const eff = c.effective || {};
  const effEl = document.getElementById('captcha-effective');
  if (effEl) {
    if (eff.available) {
      const name = eff.provider === 'turnstile' ? 'Cloudflare Turnstile' : 'Google reCAPTCHA';
      const envHit = c.envOverridden && (c.envOverridden.provider || c.envOverridden.siteKey || c.envOverridden.secretKey);
      effEl.textContent = `当前生效：${name}（登录页已启用）` + (envHit ? ' · 部分配置被环境变量覆盖' : '');
    } else {
      effEl.textContent = '当前登录页未启用人机验证';
    }
  }
}

async function loadCaptcha() {
  const card = document.getElementById('sysset-captcha-card');
  try {
    const c = await API.captchaConfig();
    captchaCfg = c;
    if (card) card.hidden = false;
    renderCaptcha(c);
  } catch (e) {
    if (e && e.status === 403) {
      if (card) card.hidden = true; // 非管理员隐藏该卡片
      return;
    }
    const msg = document.getElementById('captcha-msg');
    if (msg) { msg.textContent = '验证码配置加载失败：' + e.message; msg.className = 'form-msg show bad'; }
  }
}

async function saveCaptchaSettings() {
  const msg = document.getElementById('captcha-msg');
  const showMsg = (t, cls) => { if (msg) { msg.textContent = t; msg.className = 'form-msg show ' + cls; } };
  const enabled = document.getElementById('captcha-enabled').checked;
  const provider = chipValue('captcha-provider') || 'recaptcha';
  const siteKey = (document.getElementById('captcha-sitekey').value || '').trim();
  const secretKey = document.getElementById('captcha-secretkey').value || '';
  const timeoutMs = Number(document.getElementById('captcha-timeout').value) || 5000;
  const onError = chipValue('captcha-onerror') || 'block';

  if (enabled) {
    if (!siteKey) { showMsg('启用验证码需填写站点密钥（Site Key）', 'bad'); return; }
    if (!secretKey && !(captchaCfg && captchaCfg.hasSecret)) {
      showMsg('启用验证码需填写服务端密钥（Secret Key），或通过环境变量 CAPTCHA_SECRET_KEY 注入', 'bad');
      return;
    }
  }

  try {
    const r = await API.saveCaptchaConfig({ enabled, provider, siteKey, secretKey, timeoutMs, onError });
    captchaCfg = r;
    renderCaptcha(r);
    showMsg('验证码配置已保存', 'ok');
    toast('验证码配置已保存，登录页下次进入时生效', { type: 'success' });
  } catch (e) {
    showMsg('保存失败：' + e.message, 'bad');
  }
}

/* ============================ 用户管理（仅管理员） ============================ */
/*
 * **这张卡片只有管理员会看到**：普通用户进来时整卡被 hidden（见 refresh()），
 * 其自助资料编辑走账户菜单「编辑资料」（profile.js）。
 *
 * 因此这里的渲染无需在「用户管理 / 我的资料」两套形态间切换 —— 单一形态、单一文案，
 * 不存在需要还原的中间状态，从根上消除"换账号后残留上一次渲染"的可能。
 */

let usersState = [];
let usersRenderId = 0; // 单调递增的渲染序号：丢弃过期响应，避免慢请求覆盖新状态

/**
 * 清空用户卡片的动态内容（登出时调用）。
 *
 * 卡片本身按角色整体显隐，这里只负责把已渲染的列表抹掉 —— 双保险，
 * 确保 DOM 里不留上一账号的用户数据。
 */
export function reset() {
  usersRenderId++; // 使所有在途请求的响应作废
  usersState = [];
  const table = document.getElementById('user-table');
  if (table) table.innerHTML = '';
  const countEl = document.getElementById('user-count');
  if (countEl) countEl.textContent = '';
  // 支付凭证表单同样要丢弃（登出 / 换账号时调用，避免残留上一账号已渲染的凭证字段）
  resetPaymentView();
}

async function loadUsers() {
  // 只有管理员需要（也应该）拉取用户列表；普通用户即便被误调用也不发请求
  if (!canManageUsers()) { reset(); return; }

  const card = document.getElementById('sysset-user-card');
  const table = document.getElementById('user-table');
  const countEl = document.getElementById('user-count');
  const myId = ++usersRenderId;

  try {
    const r = await API.users();
    // 期间又发起了新的加载（或已登出）→ 丢弃本次响应，避免旧数据覆盖新状态
    if (myId !== usersRenderId) return;
    usersState = r.users || [];
    if (card) card.hidden = false;
    if (countEl) countEl.textContent = usersState.length ? `（${usersState.length}）` : '';
    renderUsers();
  } catch (e) {
    if (myId !== usersRenderId) return;
    if (e && e.status === 403) {
      // 服务端拒绝（理论上不会发生，因为入口已按角色收口）→ 整卡隐藏
      if (card) card.hidden = true;
      return;
    }
    if (table) table.innerHTML = `<div class="lk-empty">用户列表加载失败：${escapeHtml(e.message)}</div>`;
  }
}

function renderUsers() {
  const table = document.getElementById('user-table');
  if (!table) return;
  const users = usersState || [];
  const currentId = App.state.user ? App.state.user.id : null;

  if (!users.length) {
    table.innerHTML = `<div class="lk-empty">暂无用户</div>`;
    return;
  }

  table.innerHTML = `
    <table class="lk-table user-tbl">
      <thead><tr>
        <th>用户名</th><th>角色</th><th>Windows Hello</th><th>创建时间</th><th>最后更新</th><th style="width:140px;text-align:right">操作</th>
      </tr></thead>
      <tbody>
        ${users.map((u) => {
          const isSelf = u.id === currentId;
          const roleBadge = u.role === 'admin'
            ? '<span class="lk-badge admin">管理员</span>'
            : '<span class="lk-badge">普通用户</span>';
          const selfMark = isSelf ? '<span class="lk-badge self" style="margin-left:6px">当前账户</span>' : '';
          const helloBadge = u.webauthnEnabled
            ? '<span class="lk-badge ok" title="已启用：登录时需通过 Windows Hello 验证">已启用</span>'
            : '<span class="bk-sub">未启用</span>';
          // 本卡片仅管理员可见，因此编辑按钮文案恒为「编辑」；
          // 管理员编辑自己时由 showUserForm 内部限制不可改角色，仍可管理自己的 Windows Hello。
          // 删除按钮：自己的行禁用（不能删除当前登录账户）
          const delBtn = `<button class="mini-btn danger" data-act="del" data-id="${escapeHtml(u.id)}" type="button" ${isSelf ? 'disabled title="不能删除当前登录账户"' : ''}>删除</button>`;
          return `<tr>
            <td><b>${escapeHtml(u.username)}</b>${selfMark}</td>
            <td>${roleBadge}</td>
            <td>${helloBadge}</td>
            <td class="bk-sub">${fmtTime(u.createdAt)}</td>
            <td class="bk-sub">${fmtTime(u.updatedAt)}</td>
            <td class="lk-acts" style="text-align:right">
              <button class="mini-btn" data-act="edit" data-id="${escapeHtml(u.id)}" type="button">编辑</button>
              ${delBtn}
            </td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;

  // 绑定操作按钮
  table.querySelectorAll('[data-act]').forEach((btn) => {
    const id = btn.getAttribute('data-id');
    const act = btn.getAttribute('data-act');
    const user = users.find((x) => x.id === id);
    if (!user) return;
    if (act === 'edit') {
      btn.onclick = () => showUserForm(user);
    } else if (act === 'del') {
      btn.onclick = () => deleteUser(user);
    }
  });
}

/**
 * 用户表单（**管理员专用** —— 普通用户走 profile.js 的「编辑资料」弹窗）。
 *
 * 两种形态：
 *  1. 新增用户 —— 用户名 / 密码 / 角色
 *  2. 编辑用户 —— 同上 + Windows Hello 开关；编辑自己时不可改角色
 */
function showUserForm(user) {
  const isEdit = !!user;
  const isSelf = isEdit && App.state.user && user.id === App.state.user.id;
  const admin = isAdmin();
  // 防御性兜底：本卡片仅管理员可见，普通用户正常到不了这里（服务端也会 403）
  if (!admin) {
    toast('仅管理员可编辑用户', { type: 'warn' });
    return;
  }
  // 角色选择：仅管理员且非自己时可改（防止管理员把自己降级后失去管理能力）
  const canEditRole = admin && !isSelf;
  const helloEnabled = !!(isEdit && user.webauthnEnabled);

  // Windows Hello 自助开关**只在自己编辑自己时**出现。
  // 逻辑与 profile.js 完全一致（同一份 webauthnReadiness 判定），
  // 因此管理员从「用户管理」点自己那一行的「编辑」，与从账户菜单点「编辑资料」，
  // 看到的开关、状态与失败原因都一模一样 —— 不再出现"一处有一处没有"的困扰。
  const readiness = webauthnReadiness();
  const helloUsable = readiness.ok;
  const helloHint = readiness.hint;

  const form = document.createElement('div');
  form.innerHTML = `
    <div class="form-item">
      <label>用户名 <span class="req">*</span></label>
      <input type="text" id="u-f-username" maxlength="32" placeholder="2-32 位，支持中英文/数字/@.-_"
        value="${isEdit ? escapeHtml(user.username || '') : ''}" autocomplete="off" spellcheck="false">
      <div class="hint">用户名用于登录，2-32 个字符，支持中文、英文字母、数字及 @ . - _ 符号。</div>
    </div>
    <div class="form-item">
      <label>密码 ${isEdit ? '<span class="hint" style="margin-left:6px">留空则不修改密码</span>' : '<span class="req">*</span>'}</label>
      <input type="password" id="u-f-password" maxlength="128" placeholder="${isEdit ? '留空保持原密码不变' : '6-128 位'}" autocomplete="new-password">
    </div>
    <div class="form-item">
      <label>确认密码 ${isEdit ? '<span class="hint" style="margin-left:6px">留空则不修改</span>' : '<span class="req">*</span>'}</label>
      <input type="password" id="u-f-confirm" maxlength="128" placeholder="${isEdit ? '留空保持原密码不变' : '再次输入密码'}" autocomplete="new-password">
    </div>
    ${canEditRole ? `
    <div class="form-item">
      <label>角色</label>
      <select id="u-f-role">
        <option value="user" ${isEdit && user.role === 'user' ? 'selected' : ''}>普通用户</option>
        <option value="admin" ${isEdit && user.role === 'admin' ? 'selected' : ''}>管理员</option>
      </select>
      <div class="hint">管理员可访问用户管理与系统全部功能；普通用户仅可登录使用文件操作。</div>
    </div>` : (isEdit ? `
    <div class="form-item">
      <label>角色</label>
      <input type="text" value="${user.role === 'admin' ? '管理员' : '普通用户'}" disabled>
      <div class="hint">不能修改自己的角色（防止失去管理权限）。如需调整请联系其他管理员。</div>
    </div>` : '')}
    ${isEdit ? (isSelf ? `
    <div class="form-item">
      <label class="u-hello-label">
        <input type="checkbox" id="u-f-hello" ${helloEnabled ? 'checked' : ''} ${helloUsable ? '' : 'disabled'}>
        <span>启用 Windows Hello 验证</span>
      </label>
      <div class="hint">
        ${helloUsable
          ? '启用后，登录时在输入密码之后<b>还需通过本机 Windows Hello</b>验证才能真正进入系统。需输入当前密码才能绑定 Windows Hello。'
          : '当前环境不可用：' + escapeHtml(helloHint)}
      </div>
      <div id="u-f-hello-msg" class="form-msg"></div>
    </div>` : `
    <div class="form-item">
      <label>Windows Hello 验证</label>
      <div style="display:flex;align-items:center;gap:10px">
        <span>${helloEnabled ? '<span class="lk-badge ok">已启用</span>' : '<span class="bk-sub">未启用</span>'}</span>
        ${helloEnabled ? '<button type="button" class="mini-btn danger" id="u-f-hello-reset">清除其 Windows Hello 凭据</button>' : ''}
      </div>
      <div class="hint">Windows Hello 必须由用户本人在自己的设备上启用（需 Windows Hello 硬件与安全上下文）。若用户更换设备后无法验证，可在此清除其凭据以恢复密码登录。</div>
    </div>`) : ''}
    <div id="u-f-msg" class="form-msg"></div>
  `;

  const m = openModal({
    title: isEdit ? '编辑用户' : '添加用户',
    body: form,
    foot: [
      { text: '取消', onClick: (o, close) => close() },
      { text: isEdit ? '保存修改' : '创建用户', cls: 'primary', onClick: (o, close) => saveUserFromForm(o, close, user) },
    ],
  });

  form.querySelectorAll('input[type="text"], input[type="password"]').forEach((inp) => {
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveUserFromForm(m.overlay, m.close, user); } });
  });

  // 编辑自己时：勾选即唤起 Windows Hello 完成注册（与 profile.js 同一套流程）
  const helloBox = form.querySelector('#u-f-hello');
  const helloMsg = form.querySelector('#u-f-hello-msg');
  if (helloBox) {
    helloBox.addEventListener('change', async () => {
      if (!helloBox.checked) return; // 取消勾选只改 UI，真正关闭在保存时处理
      const pwd = (form.querySelector('#u-f-password') || {}).value || '';
      if (!pwd) {
        helloBox.checked = false;
        if (helloMsg) {
          helloMsg.textContent = '请先在上方「密码」栏输入当前密码，用于确认是本人在操作';
          helloMsg.className = 'form-msg show bad';
        }
        return;
      }
      if (helloMsg) { helloMsg.textContent = '正在唤起 Windows Hello，请按系统提示完成验证…'; helloMsg.className = 'form-msg show'; }
      try {
        const r = await registerWindowsHello(API, pwd);
        if (r && r.user) {
          user.webauthnEnabled = true;
          if (App.state.user && App.state.user.id === user.id) App.state.user.webauthnEnabled = true;
          if (helloMsg) { helloMsg.textContent = '已启用：登录时将要求 Windows Hello 验证'; helloMsg.className = 'form-msg show ok'; }
          toast('Windows Hello 已启用', { type: 'success' });
        }
      } catch (e) {
        helloBox.checked = false;
        if (helloMsg) { helloMsg.textContent = e.message || '启用失败'; helloMsg.className = 'form-msg show bad'; }
      }
    });
  }

  // 管理员清除他人凭据（自助启用 / 关闭走 profile.js）
  const helloReset = form.querySelector('#u-f-hello-reset');
  if (helloReset) {
    helloReset.onclick = async () => {
      const ok = await confirmDialog({ allowHtml: true,
        title: '清除 Windows Hello 凭据',
        message: `确定清除用户「<b>${escapeHtml(user.username)}</b>」的 Windows Hello 凭据吗？<br>清除后该用户将回到<b>仅密码登录</b>，可重新自行启用。`,
        okText: '清除', danger: true,
      });
      if (!ok) return;
      try {
        await API.adminDisableWebauthn(user.id);
        toast('已清除该用户的 Windows Hello 凭据', { type: 'success' });
        m.close();
        await loadUsers();
      } catch (e) {
        toast('操作失败：' + e.message, { type: 'error', duration: 6000 });
      }
    };
  }
}

async function saveUserFromForm(overlay, close, existing) {
  const username = (overlay.querySelector('#u-f-username') || {}).value || '';
  const password = (overlay.querySelector('#u-f-password') || {}).value || '';
  const confirm = (overlay.querySelector('#u-f-confirm') || {}).value || '';
  const roleSel = overlay.querySelector('#u-f-role');
  const role = roleSel ? roleSel.value : 'user';
  const isEdit = !!existing;
  const msgEl = overlay.querySelector('#u-f-msg');

  const showMsg = (text, cls) => {
    if (!msgEl) return;
    msgEl.textContent = text;
    msgEl.className = 'form-msg show ' + cls;
  };

  if (!username.trim()) { showMsg('用户名不能为空', 'bad'); return; }
  if (!isEdit && !password) { showMsg('密码不能为空', 'bad'); return; }
  if (password && password.length < 6) { showMsg('密码长度不能少于 6 位', 'bad'); return; }
  if (password !== confirm) { showMsg('两次输入的密码不一致', 'bad'); return; }

  const body = { username: username.trim() };
  if (roleSel) body.role = role;
  if (password) { body.password = password; body.confirmPassword = confirm; }

  try {
    if (isEdit) {
      await API.updateUser(existing.id, body);
    } else {
      await API.addUser(body);
    }
    close();
    await loadUsers();
    toast(isEdit ? '用户已更新' : '用户已创建', { type: 'success' });
  } catch (e) {
    showMsg(e.message || '保存失败', 'bad');
  }
}

async function deleteUser(user) {
  if (!user) return;
  if (!isAdmin()) { toast('仅管理员可删除用户', { type: 'warn' }); return; }
  const isSelf = App.state.user && user.id === App.state.user.id;
  if (isSelf) { toast('不能删除当前登录的账户', { type: 'warn' }); return; }
  const ok = await confirmDialog({ allowHtml: true,
    title: '删除用户',
    message: `确定要删除用户「<b>${escapeHtml(user.username)}</b>」吗？此操作不可撤销。`,
    okText: '删除', danger: true,
  });
  if (!ok) return;
  try {
    await API.deleteUser(user.id);
    await loadUsers();
    toast('用户已删除', { type: 'success' });
  } catch (e) {
    toast('删除失败：' + e.message, { type: 'error', duration: 6000 });
  }
}
