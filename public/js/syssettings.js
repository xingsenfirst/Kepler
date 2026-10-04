/** 系统设置 —— 文件加密（隐私保护）：加密方式 / 魔数 / 查看密码 / 用户管理（管理员） */
import { API } from './api.js';
import { toast, escapeHtml, confirmDialog, openModal, fmtTime, fmtSize, updateNotice, USER_PREVIEW_LIMIT, filterUsersByName } from './util.js';
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
const ADMIN_ONLY_CARDS = ['sysset-user-card', 'sysset-lb-card', 'sysset-enc-card', 'sysset-excludes-card', 'sysset-webdav-card', 'sysset-captcha-card', 'sysset-payment-card'];

/** 隐藏仅管理员可见的卡片（非管理员直接不渲染其内容） */
function setAdminCardVisible(cardId, visible) {
  const el = document.getElementById(cardId);
  if (el) el.hidden = !visible;
  // 隐藏时顺带清空动态内容，避免 DOM 里仍留着上一角色的用户列表
  if (!visible && cardId === 'sysset-user-card') clearUserDom();
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
  loadLoadBalance();
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
  const btnUserAll = document.getElementById('btn-user-all');
  if (btnUserAll) btnUserAll.onclick = showAllUsers;
  // 负载均衡（仅管理员）：刷新用量
  const lbRefresh = document.getElementById('btn-lb-refresh');
  if (lbRefresh) lbRefresh.onclick = () => loadLoadBalance();
  // 关于卡片：检查更新（**所有登录用户**可见 —— 关于卡片不属 ADMIN_ONLY_CARDS）
  const btnUpdate = document.getElementById('btn-check-update');
  if (btnUpdate) btnUpdate.onclick = checkUpdate;
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

/**
 * R34：「关于」卡片 → 「检查更新」。
 *
 * 两句文案由 `updateNotice()`（util.js，纯函数、可被测试断言）决定；
 * 这里只负责「禁用按钮 → 请求 → 渲染 → 恢复按钮」的交互，且 `finally` 里**必然**
 * 恢复按钮 —— 否则一次网络失败就会把按钮永久禁用，用户再也点不动。
 */
async function checkUpdate() {
  const btn = document.getElementById('btn-check-update');
  const out = document.getElementById('update-result');
  if (btn) btn.disabled = true;
  if (out) {
    out.classList.remove('ok', 'warn');
    out.textContent = '正在检查…';
  }
  try {
    const r = await API.checkUpdate();
    if (out) {
      out.textContent = updateNotice(r);
      out.classList.add(r && r.hasUpdate ? 'warn' : 'ok');
    }
  } catch (e) {
    if (out) {
      out.textContent = '检查更新失败：' + ((e && e.message) || '未知错误');
      out.classList.add('warn');
    }
  } finally {
    if (btn) btn.disabled = false;
  }
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

/**
 * 后端没给出对外地址时的兜底。
 * 旧实现写死 `https://<本机IP>:${port}${mount}` —— 那是**服务器自己**的地址，
 * 用户复制到资源管理器里必然连不上（端口通常也不对外放行）。
 * 改按「此刻打开面板的地址」推断：面板本身就在域名（或内网 IP）上可达，
 * 同一来源 + 挂载点才是客户端真正能用的地址。
 */
function webdavFallbackUrl(w) {
  const mount = (w && w.mount) || '/dav';
  const origin = (typeof location !== 'undefined' && location.origin && location.origin !== 'null')
    ? location.origin : '';
  return origin ? `${origin}${mount}/` : `${mount}/`;
}

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
  if (urlEl) urlEl.textContent = w.serverUrl || (w.enabled ? webdavFallbackUrl(w) : '—');

  const hint = document.getElementById('webdav-run-hint');
  if (hint) {
    if (w.running) {
      hint.textContent = `服务运行中 · 内部端口 ${w.port} · 挂载点 ${w.mount}（强制 HTTPS）；客户端填上方「服务器地址」即可，无需直连该端口。`;
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
  const serverUrl = escapeHtml(w.serverUrl || webdavFallbackUrl(w));
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
  // 与界面上显示的地址保持一致：serverUrl 为空（自建反代未设 WEBDAV_PUBLIC_URL）时
  // 界面显示的是兜底推断地址，这里也必须能复制同一串，否则「看得见、复制不了」。
  const w = webdavState;
  const url = w ? (w.serverUrl || (w.enabled ? webdavFallbackUrl(w) : '')) : '';
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
  const checked = document.getElementById('captcha-enabled').checked;
  const provider = chipValue('captcha-provider') || 'recaptcha';
  const siteKey = (document.getElementById('captcha-sitekey').value || '').trim();
  const secretKey = document.getElementById('captcha-secretkey').value || '';
  const timeoutMs = Number(document.getElementById('captcha-timeout').value) || 5000;
  const onError = chipValue('captcha-onerror') || 'block';

  // 服务端密钥是否可用：本次填了新的，或此前已配置 / 环境变量注入
  const hasSecret = !!secretKey || !!(captchaCfg && captchaCfg.hasSecret);

  /**
   * R31-02：保存成功后「自动启用」。
   *
   * 报障场景：功能本来是停用状态，管理员把站点密钥 / 服务端密钥填好、点「保存设置」——
   * 旧行为只是把 enabled:false 原样再存一遍，功能依旧停用，而管理员以为「保存即生效」，
   * 登录页其实仍无任何验证；必须再回来手动拨一次开关（很多人就此以为配置没生效）。
   *
   * 三个闸门**同时**满足才自动启用：
   *  ① 保存前就是停用状态（`captchaCfg.enabled` 为假）—— 功能已在启用态时，
   *     用户的任何操作都不该被我们改判；
   *  ② 本次提交里用户**真的新填了信息**（站点密钥与已保存值不同，或填入了服务端密钥）——
   *     这一条专门保护「手动停用后仍要保存别的改动」：只把开关拨到停用再点保存时
   *     typedNew 为假，仍按停用提交，绝不会「关了又被自动打开」而再也停不下来；
   *  ③ 凭证完整（站点密钥 + 服务端密钥都在）—— 与下面那段启用前校验同源，避免出现
   *     「自动启用了一个必然不可用的配置」。
   * 自动启用只作用在**本次提交的入参**上（把 enabled 一并提交），不额外发一次请求，
   * 因此不会产生「已保存但启用失败」的半途状态。
   */
  const typedNew = siteKey !== String((captchaCfg && captchaCfg.siteKey) || '') || !!secretKey;
  const autoEnable = !checked && !(captchaCfg && captchaCfg.enabled)
    && typedNew && !!siteKey && hasSecret;
  const enabled = checked || autoEnable;

  if (enabled) {
    if (!siteKey) { showMsg('启用验证码需填写站点密钥（Site Key）', 'bad'); return; }
    if (!hasSecret) {
      showMsg('启用验证码需填写服务端密钥（Secret Key），或通过环境变量 CAPTCHA_SECRET_KEY 注入', 'bad');
      return;
    }
  }

  try {
    const r = await API.saveCaptchaConfig({ enabled, provider, siteKey, secretKey, timeoutMs, onError });
    const autoEnabled = autoEnable && !!r.enabled;
    captchaCfg = r;
    renderCaptcha(r);
    // 措辞只说「已把状态设为启用」，不承诺「登录页必然生效」：启停还可能被
    // CAPTCHA_ENABLED 环境变量覆盖（卡片上「当前生效」一栏会如实显示该情况）。
    showMsg(autoEnabled ? '验证码配置已保存，并已将状态设为启用' : '验证码配置已保存', 'ok');
    toast(autoEnabled ? '验证码已保存并启用' : '验证码配置已保存，登录页下次进入时生效', { type: 'success' });
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

// R35：「全部用户」对话框的状态。**必须**放在模块级而不是对话框闭包里 ——
// 卡片列表每次刷新都会重绘（`loadUsers → renderUsers`），对话框里的行必须跟着一起更新
// （在对话框里删掉一个用户、卡片上却仍显示他，是最容易漏掉的一类不一致）。
let allUsersOpen = false; // 对话框是否开着（决定 renderUsers 末尾要不要重绘它）
let allUsersQuery = ''; // 搜索框当前内容（跨重绘保持，否则删一个用户就把搜索条件清掉了）

/**
 * 抹掉用户卡片与「全部用户」对话框里的动态内容。
 *
 * 两个调用点共用它（登出 `reset()`、切到非管理员 `setAdminCardVisible()`）——
 * 两处各手写一遍的必然结果是「只清了一处」：用户列表（用户名、角色、封禁原因）
 * 留在 DOM 里，换账号后越权可见。
 */
function clearUserDom() {
  const table = document.getElementById('user-table');
  if (table) table.innerHTML = '';
  const countEl = document.getElementById('user-count');
  if (countEl) countEl.textContent = '';
  const more = document.getElementById('user-more');
  if (more) more.hidden = true;
  const hint = document.getElementById('user-more-hint');
  if (hint) hint.textContent = '';
  allUsersOpen = false;
  allUsersQuery = '';
  const allList = document.getElementById('user-all-body');
  if (allList) allList.innerHTML = '';
}

/**
 * 清空用户卡片的动态内容（登出时调用）。
 *
 * 卡片本身按角色整体显隐，这里只负责把已渲染的列表抹掉 —— 双保险，
 * 确保 DOM 里不留上一账号的用户数据。
 */
export function reset() {
  usersRenderId++; // 使所有在途请求的响应作废
  usersState = [];
  clearUserDom();
  // 负载均衡：作废在途响应并抹掉密钥清单（含掩码后的 SecretId —— 换账号不得残留）
  lbRenderId++;
  lbUsage = null;
  lbOpen.clear();
  const lbList = document.getElementById('lb-list');
  if (lbList) lbList.innerHTML = '';
  const lbSummary = document.getElementById('lb-summary');
  if (lbSummary) lbSummary.textContent = '';
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

/**
 * 封禁状态的展示映射（前端**唯一**判据，R33）。
 *
 * `u.ban` 由服务端 `config-store.banInfo()` 算好，其中已有 `state`：`none` / `active` /
 * `expired`。前端**刻意不再自行比较时间** —— 一旦这里也写一份「until < now」的判断，
 * 浏览器时钟偏差、时区处理差异都会让两处判据分叉，表现就是「列表显示已解封、
 * 登录仍被拒」这种只能翻代码才解释得通的现象。这里只做**枚举 → 文案**的映射。
 */
const BAN_LABEL = {
  active: '已封禁',
  expired: '封禁已到期',
};

function banBadge(u) {
  const b = (u && u.ban) || {};
  if (b.state === 'active') {
    const bits = [];
    if (b.reason) bits.push(`原因：${b.reason}`);
    bits.push(b.until ? `解封时间：${fmtTime(b.until)}` : '解封时间：永久（需手动解封）');
    return `<span class="lk-badge bad" title="${escapeHtml(bits.join('；'))}">${BAN_LABEL.active}</span>`;
  }
  if (b.state === 'expired') {
    return `<span class="lk-badge gone" title="封禁已到期，该用户可正常登录；再点「封禁」可重新设置">${BAN_LABEL.expired}</span>`;
  }
  return '<span class="bk-sub">正常</span>';
}

/**
 * 用户表格 HTML —— 卡片列表与「全部用户」对话框的**唯一渲染器**（R35）。
 *
 * 两处各写一份表格，是这类界面最典型的腐烂方式：新增一列或一个按钮只改了一处，
 * 另一处静默落后，于是出现「卡片里能封禁、对话框里却不能」这种只能翻代码才解释得通的现象。
 * 因此它只接受「要渲染哪些用户」，渲染进哪个容器由调用方决定。
 */
function userTableHtml(users, currentId) {
  return `
    <table class="lk-table user-tbl">
      <thead><tr>
        <th>用户名</th><th>角色</th><th>状态</th><th>Windows Hello</th><th>创建时间</th><th>最后更新</th><th style="width:210px;text-align:right">操作</th>
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
          // R33：封禁 / 解封。自己的行不给按钮（服务端也会 400 拦下自封禁）——
          // 否则管理员一不小心就把自己锁在系统外，且没有任何人能帮他解开。
          const banned = (u.ban || {}).state === 'active';
          const banBtn = isSelf ? ''
            : (banned
              ? `<button class="mini-btn" data-act="unban" data-id="${escapeHtml(u.id)}" type="button" title="立即解除封禁，该账户可立刻重新登录">解封</button>`
              : `<button class="mini-btn danger" data-act="ban" data-id="${escapeHtml(u.id)}" type="button" title="设置封禁原因与到期时间">封禁</button>`);
          return `<tr>
            <td><b>${escapeHtml(u.username)}</b>${selfMark}</td>
            <td>${roleBadge}</td>
            <td>${banBadge(u)}</td>
            <td>${helloBadge}</td>
            <td class="bk-sub">${fmtTime(u.createdAt)}</td>
            <td class="bk-sub">${fmtTime(u.updatedAt)}</td>
            <td class="lk-acts" style="text-align:right">
              <button class="mini-btn" data-act="edit" data-id="${escapeHtml(u.id)}" type="button">编辑</button>
              ${banBtn}
              ${delBtn}
            </td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

/**
 * 绑定列表行内按钮（卡片与对话框共用）。
 *
 * `root` 限定查询范围是关键：不限定就会把**另一个容器**里的按钮一并绑上，
 * 于是点卡片里第 3 行的「删除」可能作用到对话框里的第 3 行（两个列表的 DOM
 * 顺序并不保证一致）。`users` 只传「这个容器刚刚渲染过的那一批」。
 */
function bindUserRowActions(root, users) {
  root.querySelectorAll('[data-act]').forEach((btn) => {
    const id = btn.getAttribute('data-id');
    const act = btn.getAttribute('data-act');
    const user = users.find((x) => x.id === id);
    if (!user) return;
    if (act === 'edit') {
      btn.onclick = () => showUserForm(user);
    } else if (act === 'del') {
      btn.onclick = () => deleteUser(user);
    } else if (act === 'ban') {
      btn.onclick = () => showBanForm(user);
    } else if (act === 'unban') {
      btn.onclick = () => unbanUser(user);
    }
  });
}

/**
 * 「显示全部」按钮的显隐（R35 需求 2 / 3 的**唯一判据**）。
 *
 * 判据用**严格大于**：正好 10 个用户时卡片已经完整展示了全部用户，
 * 此时再摆一个「显示全部」，点开只能看到与卡片一字不差的一份副本。
 */
function updateUserMore(total) {
  const more = document.getElementById('user-more');
  const hint = document.getElementById('user-more-hint');
  const over = total > USER_PREVIEW_LIMIT;
  if (more) more.hidden = !over;
  if (hint) hint.textContent = over ? `卡片仅显示前 ${USER_PREVIEW_LIMIT} 位，共 ${total} 位用户` : '';
}

function renderUsers() {
  const table = document.getElementById('user-table');
  if (!table) return;
  const users = usersState || [];
  const currentId = App.state.user ? App.state.user.id : null;

  if (!users.length) {
    table.innerHTML = `<div class="lk-empty">暂无用户</div>`;
    updateUserMore(0);
    repaintAllUsers();
    return;
  }

  // 需求 1：卡片列表最多展示 USER_PREVIEW_LIMIT 个用户（按服务端顺序取前 N 个）
  const shown = users.slice(0, USER_PREVIEW_LIMIT);
  table.innerHTML = userTableHtml(shown, currentId);
  bindUserRowActions(table, shown);

  updateUserMore(users.length);
  repaintAllUsers(); // 对话框开着时同步刷新：删/封/改名之后两边必须一致
}

/* ============================ 全部用户对话框（R35） ============================ */
/*
 * 用户数超过 USER_PREVIEW_LIMIT 时，卡片只展示前 10 位，「显示全部」把其余用户
 * 连同**搜索框**放进一个对话框：列表自带滚动条，搜索框固定在顶部、不随列表滚走。
 *
 * 两条容易做错的约束：
 *  1. 对话框里的行**必须**带完整操作按钮。「列表里看不见的用户 = 管不了的用户」
 *     是这一版最可能犯的错：50 个用户时后 40 个将永远无法编辑 / 封禁 / 删除。
 *  2. 所有变更（删除 / 封禁 / 编辑保存）都经由 `loadUsers() → renderUsers()` 这**一个**
 *     收口点，所以对话框的重绘挂在 `renderUsers()` 末尾（`repaintAllUsers()`），
 *     而不是在每个操作里各写一遍刷新 —— 那样迟早漏一个。
 */

/** 重绘「全部用户」列表（对话框没开时是空操作） */
function repaintAllUsers() {
  if (!allUsersOpen) return;
  const list = document.getElementById('user-all-body');
  if (!list) { allUsersOpen = false; return; } // 弹窗已被移除（例如登出时），别再往空气里渲染
  const users = usersState || [];
  const shown = filterUsersByName(users, allUsersQuery);
  const currentId = App.state.user ? App.state.user.id : null;

  const countEl = document.getElementById('user-all-count');
  if (countEl) {
    countEl.textContent = allUsersQuery.trim()
      ? `匹配 ${shown.length} / 共 ${users.length} 位`
      : `共 ${users.length} 位用户`;
  }

  if (!shown.length) {
    // 「搜索没命中」与「系统里一个用户都没有」是两件事，文案必须分开
    list.innerHTML = `<div class="lk-empty">${users.length ? '没有匹配的用户' : '暂无用户'}</div>`;
    return;
  }
  list.innerHTML = userTableHtml(shown, currentId);
  bindUserRowActions(list, shown);
}

/** 打开「全部用户」对话框（R35 需求 3） */
function showAllUsers() {
  if (!canManageUsers()) return;
  if (allUsersOpen) return; // 连点两次不得叠出第二层遮罩

  const users = usersState || [];
  const wrap = document.createElement('div');
  wrap.className = 'user-all';
  wrap.innerHTML = `
    <div class="user-all-bar">
      <input type="search" id="user-all-search" class="user-all-search"
        placeholder="搜索用户名（不区分大小写）" autocomplete="off" spellcheck="false">
      <span class="user-all-count" id="user-all-count"></span>
    </div>
    <div class="user-all-body" id="user-all-body"></div>`;

  allUsersQuery = '';
  openModal({
    title: `全部用户（共 ${users.length} 位）`,
    body: wrap,
    foot: [{ text: '关闭' }],
    wide: true,
    cls: 'user-all-dialog', // 7 列表格要的宽度（见 style.css）
    onClose: () => { allUsersOpen = false; allUsersQuery = ''; },
  });
  allUsersOpen = true;

  const search = document.getElementById('user-all-search');
  // 搜索是**本地内存过滤**（数据已经在手），因此既不防抖也不发请求。
  // 用 `oninput` 而不是 addEventListener：与列表按钮同一写法，且假 DOM 里可直接驱动。
  if (search) search.oninput = () => { allUsersQuery = search.value; repaintAllUsers(); };

  repaintAllUsers();
  if (search && search.focus) search.focus();
}

/* ============================ 账户封禁（R33） ============================ */

/** 封禁弹窗的默认到期时间（天）。留空才是永久，故给一个真实默认值避免误触"永久" */
const BAN_DEFAULT_DAYS = 7;

/** `datetime-local` 需要的**本地**时间串（`YYYY-MM-DDTHH:mm`，刻意不含时区） */
function localDateTimeValue(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 封禁弹窗：**封禁原因编辑框** + **到期时间选择器**（需求 2 / 4）。
 *
 * 时间控件用原生 `<input type="datetime-local">`（零依赖、无第三方日期库）。
 * ⚠️ 它的值**不带时区**（形如 `2026-10-11T12:00`），必须由这里用
 * `new Date(v).getTime()` 按**浏览器本地时区**换算成 epoch 毫秒后再提交；
 * 直接把那个字符串发给服务端，在「浏览器时区 ≠ 服务器时区」时必然错位
 * （服务端会按自己的时区解释它），表现为封禁提前/延后若干小时生效。
 */
function showBanForm(user) {
  if (!user) return;
  if (!isAdmin()) { toast('仅管理员可封禁用户', { type: 'warn' }); return; }

  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="form-item">
      <label>封禁原因 <span class="req">*</span></label>
      <textarea id="ban-reason" rows="3" maxlength="200"
        placeholder="将展示给被封用户，例如：多次上传违规内容"></textarea>
      <div class="hint">该原因会显示在用户登录时，请填写得具体、可理解（最多 200 字）。</div>
    </div>
    <div class="form-item">
      <label>封禁到期时间</label>
      <input type="datetime-local" id="ban-until" value="${escapeHtml(localDateTimeValue(Date.now() + BAN_DEFAULT_DAYS * 86400000))}">
      <div class="hint">到期后<b>自动解除</b>，无需手动操作。清空此项 = <b>永久封禁</b>（须管理员手动解封）。</div>
    </div>
    <div id="ban-msg" class="form-msg"></div>
  `;

  const m = openModal({
    title: `封禁用户「${user.username}」`,
    body: wrap,
    foot: [
      { text: '取消', onClick: (o, close) => close() },
      { text: '确认封禁', cls: 'danger', onClick: (o, close) => submitBan(o, close, user) },
    ],
  });
  // 该弹窗没有 input[type=text]，回车提交单独绑在原因框上
  const reasonEl = wrap.querySelector('#ban-reason');
  if (reasonEl) reasonEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitBan(m.overlay, m.close, user); }
  });
}

async function submitBan(overlay, close, user) {
  const reason = ((overlay.querySelector('#ban-reason') || {}).value || '');
  const raw = ((overlay.querySelector('#ban-until') || {}).value || '');
  const msgEl = overlay.querySelector('#ban-msg');
  const showMsg = (text, cls) => {
    if (!msgEl) return;
    msgEl.textContent = text;
    msgEl.className = 'form-msg show ' + cls;
  };

  // 只做「必填」这一类本地校验；原因长度、时间格式、时间是否已过一律由服务端裁定
  // （`config-store.setUserBan()` 是唯一实现点），避免两处各写一份规则后逐渐分叉。
  if (!reason.trim()) { showMsg('请填写封禁原因', 'bad'); return; }

  let until = '';
  if (raw) {
    const ms = new Date(raw).getTime();
    if (!Number.isFinite(ms)) { showMsg('封禁到期时间格式不正确', 'bad'); return; }
    until = ms; // 本地时区 → epoch 毫秒（绝对时刻），服务端按 ISO 存储
  }

  try {
    const r = await API.banUser(user.id, { reason: reason.trim(), until });
    close();
    await loadUsers();
    const revoked = (r && r.sessionsRevoked) || 0;
    toast(revoked > 0
      ? `已封禁「${user.username}」，其 ${revoked} 个会话已立即失效`
      : `已封禁「${user.username}」`, { type: 'success' });
  } catch (e) {
    showMsg(e.message || '封禁失败', 'bad');
  }
}

/** 立即解除封禁（需求 3）。不需要二次确认之外的任何输入 —— 解封永远可以再封回去。 */
async function unbanUser(user) {
  if (!user) return;
  if (!isAdmin()) { toast('仅管理员可解除封禁', { type: 'warn' }); return; }
  const ok = await confirmDialog({ allowHtml: true,
    title: '解除封禁',
    message: `确定立即解除用户「<b>${escapeHtml(user.username)}</b>」的封禁吗？<br>解除后该账户可立即正常登录。`,
    okText: '解除封禁',
  });
  if (!ok) return;
  try {
    await API.unbanUser(user.id);
    await loadUsers();
    toast('已解除封禁', { type: 'success' });
  } catch (e) {
    toast('解除封禁失败：' + e.message, { type: 'error', duration: 6000 });
  }
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

/* ============================ 负载均衡（按 API Key 的配额，R25） ============================ */
/*
 * **这张卡片同样只有管理员会看到**（纳入 ADMIN_ONLY_CARDS 整卡显隐）。
 *
 * 服务端返回的用量与写入闸门**同源**（`bucketStats.credentialUsage`）—— 卡片上写的数字
 * 就是闸门实际用来判定的数字，不会出现「界面显示没超、上传却被拦」。
 *
 * 列表形态是风箱（手风琴）：默认全部折叠，点标题行展开该密钥下的各桶占用；
 * 展开态存在 `lbOpen` 里并按密钥 id 记忆，刷新用量后不会把用户刚展开的项合上。
 */

const GB = 1024 * 1024 * 1024;
let lbUsage = null; // 服务端返回的 { credentials: [...] }
const lbOpen = new Set(); // 已展开的密钥 id（跨刷新保持）
let lbRenderId = 0; // 单调递增渲染序号：丢弃过期响应，避免慢请求覆盖新状态

/** 字节 → GB 数（保留 3 位小数，用于把配额回填到输入框） */
function bytesToGb(bytes) {
  const n = Number(bytes) || 0;
  return n > 0 ? Math.round((n / GB) * 1000) / 1000 : 0;
}

function loadLoadBalance() {
  if (!isAdmin()) return; // 普通用户连请求都不发（卡片已隐藏）
  const list = document.getElementById('lb-list');
  const myId = ++lbRenderId;
  if (list && !lbUsage) list.innerHTML = '<div class="lb-empty">正在加载用量…</div>';
  API.quotaUsage().then((r) => {
    if (myId !== lbRenderId) return;
    lbUsage = r;
    renderLoadBalance();
  }).catch((e) => {
    if (myId !== lbRenderId) return;
    if (e && e.status === 403) { // 非管理员（理论上不可达）→ 不暴露任何密钥信息
      if (list) list.innerHTML = '';
      return;
    }
    if (list) list.innerHTML = `<div class="lb-empty">用量加载失败：${escapeHtml(e.message)}</div>`;
  });
}

/** 单个桶的进度条（分母 = 该密钥的上限；无限制时用「已用总量」以便表达相对大小） */
function lbBucketHTML(b, credQuota, credUnlimited, credUsed) {
  const denom = credUnlimited ? credUsed : credQuota;
  const pct = denom > 0 ? Math.min(100, (b.sizeBytes / denom) * 100) : 0;
  const overBucket = b.quotaBytes > 0 && b.sizeBytes > b.quotaBytes;
  const meta = [];
  if (b.region) meta.push(escapeHtml(b.region));
  if (b.estimated) meta.push('估算');
  if (!b.available) meta.push('容量不可用');
  return `<div class="lb-bkt"${b.error ? ` title="${escapeHtml(b.error)}"` : ''}>
    <div class="lb-bkt-name"><code>${escapeHtml(b.bucket)}</code>${meta.length ? ' <span class="lb-sub">（' + meta.join(' · ') + '）</span>' : ''}</div>
    <div class="lb-bkt-bar"><div class="lb-bar${overBucket ? ' over' : ''}"><i style="width:${pct.toFixed(1)}%"></i></div></div>
    <div class="lb-bkt-num">${fmtSize(b.sizeBytes)}${b.quotaBytes > 0 ? ' / ' + fmtSize(b.quotaBytes) : ''}</div>
  </div>`;
}

function lbItemHTML(c) {
  const used = c.usedBytes || 0;
  const quota = c.quotaBytes || 0;
  const unlimited = !!c.unlimited || quota <= 0;
  const pct = unlimited ? 0 : Math.min(100, (used / quota) * 100);
  const barCls = unlimited ? '' : (c.exceeded ? ' over' : (pct >= 80 ? ' warn' : ''));
  const open = lbOpen.has(c.id);
  const name = escapeHtml(c.remark || c.secretIdMasked || '（未命名密钥）');
  const flags = [];
  if (c.providerName) flags.push(escapeHtml(c.providerName));
  if (!c.enabled) flags.push('已停用');
  if (!c.visibleToUsers) flags.push('对普通用户不可见');
  flags.push(`${c.bucketCount} 个存储桶`);
  const usageText = unlimited
    ? `无限制 · 已用 ${fmtSize(used)}`
    : `已用 ${fmtSize(used)} / ${fmtSize(quota)}${c.exceeded ? ' · 已超额' : ''}`;
  return `<div class="lb-item${c.exceeded ? ' over' : ''}${open ? ' open' : ''}" data-id="${escapeHtml(c.id)}">
    <div class="lb-head">
      <span class="lb-caret">▶</span>
      <div class="lb-title">
        <div class="lb-key">${name}</div>
        <div class="lb-sub">${escapeHtml(c.secretIdMasked || '')} · ${flags.join(' · ')}</div>
      </div>
      <div class="lb-usage">
        <div class="lb-num${c.exceeded ? ' over' : ''}">${usageText}</div>
        <div class="lb-bar${barCls}"><i style="width:${pct.toFixed(1)}%"></i></div>
      </div>
      <label class="lb-quota">上限<input type="number" min="0" step="1" value="${bytesToGb(quota)}" data-quota="${quota}" title="单位 GB；填 0 表示无限制">GB</label>
    </div>
    <div class="lb-body">
      ${(c.buckets && c.buckets.length)
        ? c.buckets.map((b) => lbBucketHTML(b, quota, unlimited, used)).join('')
        : '<div class="lb-empty">该密钥下暂无存储桶。</div>'}
    </div>
  </div>`;
}

function renderLoadBalance() {
  const list = document.getElementById('lb-list');
  const summary = document.getElementById('lb-summary');
  if (!list) return;
  const creds = (lbUsage && lbUsage.credentials) || [];
  if (summary) {
    const limited = creds.filter((c) => !c.unlimited).length;
    const over = creds.filter((c) => c.exceeded).length;
    summary.textContent = creds.length
      ? `（${creds.length} 个密钥${limited ? ` · ${limited} 个已设上限` : ''}${over ? ` · ${over} 个已超额` : ''}）`
      : '';
  }
  if (!creds.length) {
    list.innerHTML = '<div class="lb-empty">暂无 API Key。请先在「访问密钥」中添加密钥与存储桶。</div>';
    return;
  }
  list.innerHTML = creds.map(lbItemHTML).join('');

  list.querySelectorAll('.lb-item').forEach((item) => {
    const id = item.getAttribute('data-id');
    const head = item.querySelector('.lb-head');
    const input = item.querySelector('.lb-quota input');
    const quotaBox = item.querySelector('.lb-quota');
    if (head) {
      head.onclick = () => {
        const willOpen = !item.classList.contains('open');
        item.classList.toggle('open', willOpen);
        if (willOpen) lbOpen.add(id); else lbOpen.delete(id);
      };
    }
    if (quotaBox) quotaBox.onclick = (ev) => ev.stopPropagation(); // 点配额区不触发折叠
    if (input) {
      input.onclick = (ev) => ev.stopPropagation();
      input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); } });
      input.addEventListener('blur', () => saveQuota(id, input));
    }
  });
}

/**
 * 保存某密钥的空间上限。
 *
 * 输入单位是 **GB**（人类可读），服务端只认字节 —— 换算与回填都在这里做。
 * 「无变化」必须**早退**：blur 在用户只是点进点出时也会触发，若每次都发 PUT，
 * 会平白产生一串写配置 + 记录日志的噪声操作。
 */
async function saveQuota(id, input) {
  const gb = Number(input.value);
  const prev = Number(input.getAttribute('data-quota')) || 0;
  if (!Number.isFinite(gb) || gb < 0) {
    toast('上限必须为非负数（填 0 表示无限制）', { type: 'error', duration: 5000 });
    input.value = bytesToGb(prev);
    return;
  }
  const bytes = Math.floor(gb * GB);
  // GB 往返换算的精度损耗不应触发写入（例：1500000000B ⇄ 1.397GB）
  if (bytesToGb(bytes) === bytesToGb(prev)) { input.value = bytesToGb(prev); return; }
  try {
    await API.setCredentialQuota(id, bytes);
    toast(bytes > 0 ? `已设置空间上限：${fmtSize(bytes)}` : '已设为「无限制」', { type: 'success' });
    loadLoadBalance();
  } catch (e) {
    toast('保存失败：' + e.message, { type: 'error', duration: 6000 });
    input.value = bytesToGb(prev);
  }
}
