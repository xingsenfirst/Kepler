/** 应用入口 —— 全局状态、工具栏、状态栏、视图调度 */
import { API } from './api.js';
import { toast, fmtSize, fmtTime, openModal, escapeHtml, confirmDialog } from './util.js';
import { explorer } from './explorer.js';
import { tree } from './tree.js';
import { ops } from './ops.js';
import { uploadMgr } from './upload.js';
import { dashboard } from './dashboard.js';
import { settings } from './settings.js';
import { help } from './help.js';
import * as linkmgr from './linkmgr.js';
import * as ordermgr from './ordermgr.js';
import * as bucketmgr from './bucketmgr.js';
import * as syssettings from './syssettings.js';
import * as credmgr from './credmgr.js';
import { verifyWindowsHello, webauthnSupported } from './webauthn.js';
import { providerMeta } from './provider-logos.js';
import { openProfileDialog } from './profile.js';
// R8-04：加密访问令牌是**凭据**，登出时必须随会话一起丢弃（见 forceLogout）。
import { reset as resetEncSession } from './enc.js';

/* ------------------------------ SVG 图标 ------------------------------ */
const SVG = {
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 6l-6 6 6 6"/></svg>',
  fwd: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 6l6 6-6 6"/></svg>',
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/></svg>',
  menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M4 12h16M4 18h16"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
  filter: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 5h16M7 12h10M10 19h4"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  viewList: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 6h13M8 12h13M8 18h13"/><circle cx="4" cy="6" r="1" fill="currentColor"/><circle cx="4" cy="12" r="1" fill="currentColor"/><circle cx="4" cy="18" r="1" fill="currentColor"/></svg>',
  viewThumb: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/></svg>',
  viewLarge: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/></svg>',
  viewSmall: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="6" height="5" rx="1"/><rect x="11" y="5" width="6" height="5" rx="1"/><rect x="19" y="5" width="2" height="5" rx="1"/><rect x="3" y="14" width="6" height="5" rx="1"/><rect x="11" y="14" width="6" height="5" rx="1"/><rect x="19" y="14" width="2" height="5" rx="1"/></svg>',
  viewopt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 8h10M18 8h2M4 16h4M12 16h8"/><circle cx="16" cy="8" r="2"/><circle cx="10" cy="16" r="2"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h.01a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z"/></svg>',
  newfolder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M12 11v5M9.5 13.5h5"/></svg>',
  upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 4v12M7 11l5 5 5-5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>',
  rename: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 5l4 4L8 20H4v-4z"/><path d="M13 7l4 4"/></svg>',
  move: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7L12.5 19"/></svg>',
  del: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/><path d="M10 11v6M14 11v6"/></svg>',
  caret: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M6 9l6 6 6-6"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="5" width="3.5" height="14" rx="1"/><rect x="13.5" y="5" width="3.5" height="14" rx="1"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>',
  cancel: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>',
  bucket: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 8l2 12a2 2 0 0 0 2 1.7h8A2 2 0 0 0 18 20l2-12"/><path d="M3 8h18"/><path d="M8 8a4 4 0 0 1 8 0"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 5l4 4L8 20H4v-4z"/><path d="M13 7l4 4"/></svg>',
};
window.__SVG = SVG;

/* ------------------------------ 全局状态 ------------------------------ */

const LS_KEY = 'cosmgr.prefs.v1';

function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch (e) { return {}; }
}
function savePrefs(extra) {
  try {
    const p = {
      view: App.state.view,
      sort: App.state.sort,
      columns: App.state.columns,
      autoRefresh: App.state.autoRefresh,
      searchCurrentOnly: App.state.searchCurrentOnly,
    };
    localStorage.setItem(LS_KEY, JSON.stringify(Object.assign(p, extra || {})));
  } catch (e) { /* 隐私模式下 localStorage 可能不可用，忽略 */ }
}

export const App = {
  state: {
    prefix: '',
    view: 'list',
    sort: { key: 'name', dir: 'asc' },
    columns: ['name', 'size', 'type', 'modified'],
    autoRefresh: 0, // 秒，0=手动
    selection: new Set(),
    history: [],
    historyIndex: -1,
    config: null,      // /api/config 安全视图
    buckets: [],       // 本地存储桶列表（含备注/配额）
    uploadExcludes: { dsStore: false, thumbsDb: false, gitignore: false }, // 上传排除设置
    bucket: '',
    bucketDisplay: '', // 外显名称（备注 || 桶名）
    region: '',
    quotaBytes: 0,     // 0 = 无限制
    storageInfo: null,
    searchActive: false,
    // 搜索范围：true = 仅当前目录（服务端 delimiter '/'），false = 递归子树。
    // 存 App.state 而非 window.__filter，是为了让「搜索框回车」与「筛选面板」
    // 两个入口**共用同一个判据** —— 各存一份就会出现"面板里勾了、回车却不生效"。
    searchCurrentOnly: false,
    statsSummary: null,
    enc: { mode: 'none', passwordSet: false }, // 文件加密设置摘要（下载/查看解锁判定用）
    user: null,        // 当前登录用户 { id, username, role }，null = 未登录
    authReady: false,  // 登录态探测完成标记
  },
  refresh() { return explorer.refresh(); },
  navigate(prefix, opts) {
    closeSidebar();
    return explorer.navigate(prefix, opts);
  },
  onConfigChanged() {
    loadConfig().then(() => {
      tree.init();
      explorer.refresh();
    });
  },
  updateStatusbar: updateStatusbar,
};

/* ------------------------------ 初始化 ------------------------------ */

async function init() {
  // 偏好恢复
  const prefs = loadPrefs();
  if (prefs.view) App.state.view = prefs.view;
  if (prefs.sort) App.state.sort = prefs.sort;
  if (Array.isArray(prefs.columns) && prefs.columns.length) App.state.columns = prefs.columns;
  if (prefs.autoRefresh !== undefined) App.state.autoRefresh = prefs.autoRefresh;
  // 恢复时不回写（prefs 刚读出来，写回去没有意义，还可能把别的字段覆盖成默认值）
  setSearchScope(!!prefs.searchCurrentOnly, { save: false });

  // 仅做 DOM 绑定，不触发任何需要鉴权的 API 请求
  injectIcons();
  bindToolbar();
  bindAuth();
  bindUserMenu();
  bindKeyboard();

  // 先探测登录态
  const me = await checkAuth();
  App.state.authReady = true;

  if (!me) {
    // 未登录：显示登录遮罩，等待用户登录后再加载主界面
    showAuthOverlay();
    return;
  }

  // 已登录：初始化各模块并加载主界面
  await bootstrapApp();
}

/** 登录成功后加载主界面 */
async function bootstrapApp() {
  // 首次登录时初始化各模块（部分模块在 init 中会立即发 API 请求，必须在登录后执行）；
  // 重复登录（如会话过期后重新登录）不再重复绑定事件，避免监听器重复
  if (!App._bootstrapped) {
    explorer.init();
    tree.init();
    uploadMgr.init();
    dashboard.init();
    help.init();
    settings.init();
    App._bootstrapped = true;
  }

  await loadConfig(true);
  await App.navigate('', { push: false });
  startAutoRefresh();
  refreshMiniStats();
  startStatsTimer(); // R7-09：内部自带「先停后启」，重新登录不会叠加出第二个定时器
  startSpeedPolling(); // 内部自带「先停后启」，重新登录不会叠加出第二个定时器
  checkBucketAcl(); // 启动时检测桶权限（不阻塞页面）
  loadEncState(); // 加密设置摘要（密码门控判定）
}

/* ------------------------------ 登录态 / 认证遮罩 ------------------------------ */

let authMode = 'login'; // 'login' | 'init'

/**
 * 「记住登录状态」的本地痕迹。
 *
 * ⚠️ **只保存用户名，绝保存密码。** 浏览器本地存储（localStorage）是明文可读的：
 * 任何一段脚本、任何一个能接触这台电脑的人都能取出内容。把密码写进去，
 * 等于把账户凭据从"只有你知道"降级为"谁都能抄走"。
 * 真正让用户免于重复登录的是**会话有效期**（服务端 30 天），不是本地存的密码。
 */
const REMEMBER_LS_KEY = 'cosmgr.auth.v1';

function loadRemember() {
  try { return JSON.parse(localStorage.getItem(REMEMBER_LS_KEY)) || {}; } catch (e) { return {}; }
}

function saveRemember(remember, username) {
  try {
    if (!remember) localStorage.removeItem(REMEMBER_LS_KEY);
    else localStorage.setItem(REMEMBER_LS_KEY, JSON.stringify({ remember: true, username: username || '' }));
  } catch (e) { /* 隐私模式下不可用，忽略 */ }
}

/** 探测登录态，返回 user 对象或 null */
async function checkAuth() {
  try {
    const r = await API.authMe();
    if (r.user) {
      App.state.user = r.user;
      renderUserMenu();
      return r.user;
    }
    App.state.user = null;
    if (r.initialized === false) {
      authMode = 'init';
    } else {
      authMode = 'login';
    }
    return null;
  } catch (e) {
    // 网络错误等：当作未登录
    App.state.user = null;
    authMode = 'login';
    return null;
  }
}

function showAuthOverlay() {
  const overlay = document.getElementById('auth-overlay');
  if (!overlay) return;
  overlay.hidden = false;
  // 根据模式设置界面
  const title = document.getElementById('auth-title');
  const sub = document.getElementById('auth-sub');
  const confirmItem = document.getElementById('auth-confirm-item');
  const submitBtn = document.getElementById('btn-auth-submit');
  const foot = document.getElementById('auth-foot');
  const errEl = document.getElementById('auth-error');
  errEl.hidden = true; errEl.textContent = '';
  // 清空输入（密码始终清空；用户名在勾选过「记住登录状态」时回填）
  const saved = loadRemember();
  const rememberBox = document.getElementById('auth-remember');
  const rememberItem = document.getElementById('auth-remember-item');
  if (rememberBox) rememberBox.checked = !!saved.remember;
  // 初始化创建管理员时没有"记住登录状态"的意义（必然是首次登录），隐藏该项
  if (rememberItem) rememberItem.hidden = authMode === 'init';
  document.getElementById('auth-username').value = saved.remember ? (saved.username || '') : '';
  document.getElementById('auth-password').value = '';
  document.getElementById('auth-confirm').value = '';

  if (authMode === 'init') {
    title.textContent = '创建管理员账户';
    sub.textContent = '首次使用，请创建管理员账户以初始化系统';
    confirmItem.hidden = false;
    submitBtn.textContent = '创建并登录';
    foot.textContent = '管理员账户拥有全部权限，包括用户管理与系统配置';
  } else {
    title.textContent = '登录';
    sub.textContent = '请输入账户凭据以继续';
    confirmItem.hidden = true;
    submitBtn.textContent = '登 录';
    foot.textContent = '';
  }
  // 人机验证：服务端开启时渲染组件并加载对应脚本；关闭时零改动
  setupAuthCaptcha();

  setTimeout(() => {
    const u = document.getElementById('auth-username');
    // 用户名已回填时直接聚焦密码框，少一次 Tab
    if (u && u.value) document.getElementById('auth-password').focus();
    else if (u) u.focus();
  }, 100);
}

function hideAuthOverlay() {
  const overlay = document.getElementById('auth-overlay');
  if (overlay) overlay.hidden = true;
}

function showAuthError(msg) {
  const el = document.getElementById('auth-error');
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
}

/* ------------------------------ 登录人机验证（CAPTCHA） ------------------------------ */
/* 服务端开启验证码时才渲染组件并加载脚本；关闭时本区块零行为，登录流程与原逻辑完全一致。 */

const captchaState = { provider: '', widgetId: null, token: '', active: false };

/**
 * 验证码脚本地址 —— 必须与 `server/index.js` 的 CSP `script-src` 严格同源。
 *
 * CSP 的 host-source 是**精确匹配**：`recaptcha.net` 不匹配 `www.recaptcha.net`。
 * 曾因这里写无 www、CSP 写有 www，导致脚本被 CSP 拦截、组件永不 load，
 * 而 `captchaState.active` 已被置真 → 每次点登录都只回「请先完成人机验证」，
 * 全站账号无法登录（R14-02）。`tests/invariants.test.js` 对此做静态护栏。
 */
const CAPTCHA_SCRIPTS = {
  // reCAPTCHA 固定走 www.recaptcha.net（避免 google.com 不可达），显式渲染模式
  recaptcha: 'https://www.recaptcha.net/recaptcha/api.js?onload=__cosCaptchaReady&render=explicit',
  turnstile: 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=__cosCaptchaReady&render=explicit',
};

function captchaMsg(text) {
  const el = document.getElementById('auth-captcha-msg');
  if (!el) return;
  if (!text) { el.hidden = true; el.textContent = ''; return; }
  el.textContent = text;
  el.hidden = false;
}

function loadCaptchaScript(provider) {
  return new Promise((resolve, reject) => {
    const id = 'captcha-script-' + provider;
    let s = document.getElementById(id);
    if (s) {
      if (s.dataset.loaded === '1') return resolve();
      s.addEventListener('load', () => resolve(), { once: true });
      s.addEventListener('error', () => reject(new Error('captcha script error')), { once: true });
      return;
    }
    s = document.createElement('script');
    s.id = id;
    s.src = CAPTCHA_SCRIPTS[provider] || CAPTCHA_SCRIPTS.recaptcha;
    s.async = true;
    s.addEventListener('load', () => { s.dataset.loaded = '1'; resolve(); }, { once: true });
    s.addEventListener('error', () => reject(new Error('captcha script error')), { once: true });
    document.head.appendChild(s);
  });
}

// 脚本 onload 挂钩（render=explicit 模式需要；实际渲染在 setupAuthCaptcha 中完成）
window.__cosCaptchaReady = () => {};

/** 拉取验证码配置并渲染组件（仅 login 模式；未启用时保证零页面改动） */
async function setupAuthCaptcha() {
  const box = document.getElementById('auth-captcha');
  if (!box) return;
  box.hidden = true; box.innerHTML = '';
  captchaMsg('');
  captchaState.active = false; captchaState.token = ''; captchaState.widgetId = null; captchaState.provider = '';
  if (authMode !== 'login') return;

  let cfg;
  try { cfg = await API.captchaPublic(); } catch (e) { return; }
  if (!cfg || !cfg.available || !cfg.siteKey) return;

  captchaState.active = true;
  captchaState.provider = cfg.provider;
  box.hidden = false;
  captchaMsg('正在加载人机验证组件…');

  const holder = document.createElement('div');
  holder.className = 'captcha-holder';
  box.appendChild(holder);

  try {
    await loadCaptchaScript(cfg.provider);
    if (cfg.provider === 'turnstile') {
      if (!window.turnstile) throw new Error('turnstile not ready');
      captchaState.widgetId = window.turnstile.render(holder, {
        sitekey: cfg.siteKey,
        callback: (t) => { captchaState.token = t || ''; captchaMsg(''); },
        'expired-callback': () => { captchaState.token = ''; },
        'error-callback': () => { captchaState.token = ''; captchaMsg('人机验证组件出错，请刷新页面重试'); },
      });
    } else {
      if (!window.grecaptcha) throw new Error('grecaptcha not ready');
      await new Promise((resolve) => window.grecaptcha.ready(resolve));
      captchaState.widgetId = window.grecaptcha.render(holder, {
        sitekey: cfg.siteKey,
        callback: (t) => { captchaState.token = t || ''; captchaMsg(''); },
        'expired-callback': () => { captchaState.token = ''; },
      });
    }
    captchaMsg('');
  } catch (e) {
    captchaState.token = '';
    // 不要只说「网络可能受限」：真实成因也可能是验证码配置本身不可用（R14-02），
    // 而管理员此时已经登不进来，提示必须给出**他能在系统设置里执行的出路**。
    captchaMsg('人机验证组件加载失败，暂时无法登录。请让管理员在「系统设置 → 登录人机验证」中关闭验证码或改用其它服务商后重试。');
  }
}

/** 登录失败后重置验证码组件（token 一次性，需重新验证） */
function resetAuthCaptcha() {
  captchaState.token = '';
  if (captchaState.widgetId === null) return;
  try {
    if (captchaState.provider === 'turnstile' && window.turnstile) window.turnstile.reset(captchaState.widgetId);
    else if (window.grecaptcha) window.grecaptcha.reset(captchaState.widgetId);
  } catch (e) { /* ignore */ }
}

function bindAuth() {
  const submit = document.getElementById('btn-auth-submit');
  if (!submit) return;
  submit.onclick = doAuthSubmit;
  // 回车提交
  ['auth-username', 'auth-password', 'auth-confirm'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') doAuthSubmit(); });
  });
}

async function doAuthSubmit() {
  const username = document.getElementById('auth-username').value.trim();
  const password = document.getElementById('auth-password').value;
  const confirm = document.getElementById('auth-confirm').value;
  const submitBtn = document.getElementById('btn-auth-submit');
  const rememberBox = document.getElementById('auth-remember');
  const remember = Boolean(rememberBox && rememberBox.checked && authMode !== 'init');
  if (!username) { showAuthError('请输入用户名'); return; }
  if (!password) { showAuthError('请输入密码'); return; }
  // 人机验证：开启时必须已完成校验（token 由组件回调产出，服务端会回源复核）
  if (captchaState.active && !captchaState.token) {
    showAuthError('请先完成人机验证');
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = authMode === 'init' ? '创建中…' : '登录中…';
  try {
    let r;
    if (authMode === 'init') {
      if (password !== confirm) { showAuthError('两次输入的密码不一致'); submitBtn.disabled = false; submitBtn.textContent = '创建并登录'; return; }
      r = await API.initAdmin({ username, password, confirmPassword: confirm });
    } else {
      r = await API.login(username, password, captchaState.token, remember);

      // 登录第二步：该账户启用了 Windows Hello，需先通过本机验证才签发会话。
      // 自动唤起 Windows Hello（无需用户再点一次按钮）。
      if (r && r.webauthnRequired) {
        if (!webauthnSupported()) {
          showAuthError('该账户已启用 Windows Hello，但当前浏览器不支持；请改用受支持的浏览器，或联系管理员关闭该验证');
          resetAuthCaptcha();
          return;
        }
        submitBtn.textContent = '等待 Windows Hello…';
        showAuthError(''); // 清空错误提示，准备唤起
        try {
          r = await verifyWindowsHello(API, r);
        } catch (we) {
          showAuthError(we.message || 'Windows Hello 验证失败');
          resetAuthCaptcha(); // 挑战一次性，失败后需重新走第一步
          return;
        }
      }
    }
    if (r && r.user) {
      App.state.user = r.user;
      saveRemember(remember, username);
      // 登录成功即把主视图重置到 explorer：换账号（尤其管理员→普通用户）时，
      // 上一个会话停留的区块必须作废，不能让新账号看到旧账号渲染的内容。
      resetMainView();
      renderUserMenu();
      hideAuthOverlay();
      await bootstrapApp();
      toast(authMode === 'init' ? '管理员账户创建成功，欢迎使用' : `欢迎回来，${r.user.username}`, { type: 'success' });
    }
  } catch (e) {
    showAuthError(e.message || '登录失败');
    resetAuthCaptcha(); // token 一次性使用，失败后需重新验证
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = authMode === 'init' ? '创建并登录' : '登 录';
  }
}

/** 强制退出并回到登录界面（全局 401 时调用） */
function forceLogout(reason) {
  App.state.user = null;
  App.state.authReady = false;
  // 停止定时器，防止在未登录状态下继续轮询 API
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  stopSpeedPolling(); // PERF-03：否则登出后仍每 2 秒请求一次 /api/stats/speed（401）
  stopStatsTimer(); // R7-09：否则登出后仍每 60 秒请求一次 /api/stats/summary（401）
  App.state.config = null;
  App.state.bucket = '';
  // 清空跨会话残留的界面状态：主视图回到 explorer、关闭浮层。
  // 否则下一个登录的账号会直接看到上一个账号停留的区块（越权显示）。
  resetMainView();
  // 让各模块丢弃上一账号的渲染缓存，下次进入时强制重新拉取
  syssettings.reset();
  // R8-04：加密访问令牌是凭据（30 分钟有效），不随登出丢弃的话，
  // 同一浏览器里下一个账号点密文文件会被 ensureUnlocked() 直接放行。
  resetEncSession();
  App.state.enc = { mode: 'none', passwordSet: false }; // 下一账号登录时由 loadEncState() 重新拉取
  // R8-18：上传队列含上一账号的完整对象键，且在途 XHR 会带失效会话继续打服务端
  uploadMgr.reset();
  renderUserMenu(); // 隐藏用户菜单
  // 隐藏主视图，避免显示残留内容
  const overlay = document.getElementById('auth-overlay');
  authMode = 'login';
  showAuthOverlay();
  if (reason) toast(reason, { type: 'warn', duration: 4000 });
}
App.forceLogout = forceLogout;

/* ------------------------------ 右上角用户菜单 ------------------------------ */

function renderUserMenu() {
  const wrap = document.getElementById('user-menu-wrap');
  const nameEl = document.getElementById('user-name');
  const headEl = document.getElementById('um-head');
  const usersItem = document.getElementById('um-users');
  const sep = document.getElementById('um-sep');
  const menu = document.getElementById('user-menu');
  const user = App.state.user;

  if (!user) {
    if (wrap) wrap.hidden = true;
    if (menu) menu.hidden = true;
    return;
  }
  if (wrap) wrap.hidden = false;
  if (nameEl) nameEl.textContent = user.username;
  if (headEl) headEl.textContent = `${user.username}（${user.role === 'admin' ? '管理员' : '普通用户'}）`;

  // 「编辑资料」对所有角色可见（普通用户改自己资料的唯一入口）；
  // 「用户管理」仅管理员可见。显式双向赋值，避免上一会话的 hidden 状态残留。
  const isAdmin = user.role === 'admin';
  const profileItem = document.getElementById('um-profile');
  if (profileItem) profileItem.hidden = false;
  if (usersItem) usersItem.hidden = !isAdmin;
  if (sep) sep.hidden = !isAdmin;

  // SEC-07：操作日志（详情含用户名 / 客户端 IP / 对象键 / 桶名）仅管理员可见。
  // 在**角色权威渲染点**统一赋值，避免仅绑定一次导致换账号后残留。
  const sideLogs = document.getElementById('side-logs');
  if (sideLogs) sideLogs.hidden = !isAdmin;

  // 订单管理接口为管理员专属，普通用户整条入口不展示（与"不发请求"同效）
  const sideOrders = document.getElementById('side-orders');
  if (sideOrders) sideOrders.hidden = !isAdmin;

  // IP 屏蔽规则的增删改与预检全部为管理员专属（规则详情含其它用户的来源 IP），
  // 普通用户整卡隐藏；bucketmgr 会据此跳过规则列表请求，避免无谓 403。
  const ipCard = document.getElementById('ipguard-card');
  if (ipCard) ipCard.hidden = !isAdmin;

  // 自定义请求域名：保存走 PUT /api/config（管理员专属），且是全局生效的共享设置。
  // 普通用户整卡隐藏；credmgr 据此跳过域名回填。
  const domainCard = document.getElementById('credmgr-domain-card');
  if (domainCard) domainCard.hidden = !isAdmin;

  // 添加存储桶：桶名与地域普通用户无从得知，云端桶列表也不对其开放（SEC-11），
  // 桶集合改由管理员用「存储桶可见性权限」开放 —— 两处入口对普通用户一律隐藏。
  for (const id of ['btn-bucket-add', 'btn-buckets-add']) {
    const el = document.getElementById(id);
    if (el) el.hidden = !isAdmin;
  }

  if (menu) menu.hidden = true;
}

function bindUserMenu() {
  const btn = document.getElementById('btn-user-menu');
  const menu = document.getElementById('user-menu');
  if (!btn || !menu) return;

  let closeTimer = null;

  function openMenu() {
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    menu.hidden = false;
  }
  function closeMenu() {
    menu.hidden = true;
  }
  function scheduleClose() {
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = setTimeout(closeMenu, 200);
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.hidden) openMenu(); else closeMenu();
  });
  btn.addEventListener('mouseenter', openMenu);
  btn.addEventListener('mouseleave', scheduleClose);
  menu.addEventListener('mouseenter', openMenu);
  menu.addEventListener('mouseleave', scheduleClose);

  // 点击外部关闭
  document.addEventListener('mousedown', (e) => {
    if (!menu.hidden && !menu.contains(e.target) && !btn.contains(e.target)) {
      closeMenu();
    }
  });

  // 菜单项
  const profileItem = document.getElementById('um-profile');
  if (profileItem) {
    profileItem.onclick = () => {
      closeMenu();
      openProfileDialog();
    };
  }
  const usersItem = document.getElementById('um-users');
  if (usersItem) {
    usersItem.onclick = () => {
      closeMenu();
      switchMainView('systemsettings');
    };
  }
  const logoutItem = document.getElementById('um-logout');
  if (logoutItem) {
    logoutItem.onclick = async () => {
      closeMenu();
      try { await API.logout(); } catch (e) { /* 忽略网络错误，仍强制登出 */ }
      forceLogout('已退出登录');
    };
  }
}

/** 加密设置摘要（含查看密码是否设置），设置变更事件后刷新 */
function loadEncState() {
  // R8-14：`passwordSet` 对**所有角色**都必须真实 —— 前端 `ensureUnlocked()` 靠它决定
  // 是否弹出「加密访问密码」验证框。旧实现把非管理员硬编码为「未设密码」，
  // 于是普通用户即使在管理员处拿到了查看密码也**无处输入**，点下载必然 401，
  // 而服务端专门给出的 needUnlock 文案被整段丢弃。
  // `/enc/status` 只回 passwordSet（不含 mode / 魔数），任意登录用户可读。
  API.encStatus().then((s) => {
    App.state.enc = { mode: 'none', passwordSet: !!s.passwordSet };
  }).catch(() => { /* 服务不可用时保持默认（不拦截） */ });

  // `mode` 属安全配置（会暴露"用什么算法/魔数"），仅管理员需要，仅管理员可读；
  // 它不参与下载门控，取不到也不影响行为。
  if (!(App.state.user && App.state.user.role === 'admin')) return;
  API.encSettings().then((s) => {
    App.state.enc = { mode: s.mode, passwordSet: !!s.passwordSet };
  }).catch(() => { /* 保持 encStatus 给出的 passwordSet */ });
}
window.addEventListener('enc-settings-changed', () => loadEncState());

async function loadConfig(first) {
  try {
    const cfg = await API.getConfig();
    App.state.config = cfg;
    App.state.uploadExcludes = cfg.uploadExcludes || { dsStore: false, thumbsDb: false, gitignore: false };
    App.state.quotaBytes = cfg.quotaBytes || 0;
    App.state.buckets = cfg.buckets || [];
    App.state.bucket = cfg.bucket || '';
    App.state.region = cfg.region || '';
    App.state.bucketDisplay = cfg.bucketRemark || cfg.bucket || '';
    if (cfg.corrupted) {
      toast('本地加密配置校验失败（可能被篡改或损坏），请重新配置密钥', { type: 'error', duration: 8000 });
    } else if (first && !cfg.configured) {
      // 仅管理员在首次未配置时引导配置；普通用户提示联系管理员（共享密钥，无需自行绑定）
      const isAdmin = App.state.user && App.state.user.role === 'admin';
      if (isAdmin) {
        settings.open();
        toast('欢迎使用对象存储管理系统，请先完成访问密钥配置', { type: 'info', duration: 6000 });
      } else {
        toast('尚未配置访问密钥，请联系管理员配置后重试', { type: 'warn', duration: 8000 });
      }
    }
    renderBucketList();
    updateStatusbar();
    window.dispatchEvent(new CustomEvent('buckets-changed'));
  } catch (e) {
    toast(e.message, { type: 'error' });
  }
}

/* ------------------------- 存储桶管理（侧边栏） ------------------------- */

function renderBucketList() {
  const ul = document.getElementById('bucket-list');
  const cfg = App.state.config;
  const buckets = App.state.buckets || [];
  const activeId = cfg ? cfg.activeBucketId : '';
  const isAdmin = !!(App.state.user && App.state.user.role === 'admin');
  if (!buckets.length) {
    // 普通用户不再自行添加桶：可见桶由管理员开放，一个都没有时只能联系管理员
    const tip = isAdmin
      ? (cfg && cfg.configured ? '尚未添加存储桶，点击此处或上方 + 添加' : '请先在“设置”中配置访问密钥')
      : '管理员尚未为你开放任何存储桶，请联系管理员在「存储桶可见性权限」中开放';
    const canAdd = isAdmin && cfg && cfg.configured;
    ul.innerHTML = `<li class="bucket-empty ${canAdd ? 'clickable' : ''}">${tip}</li>`;
    if (canAdd) ul.querySelector('.bucket-empty').onclick = () => openBucketDialog(null);
    return;
  }
  ul.innerHTML = buckets.map((b) => {
    const display = b.remark || b.bucket;
    const sub = b.remark ? `${b.bucket} · ${b.region}` : b.region;
    return `<li class="bucket-item ${b.id === activeId ? 'active' : ''}" data-id="${b.id}" title="${escapeHtml(b.bucket)}（${escapeHtml(b.region)}）">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="bk-ic"><path d="M4 8l2 12a2 2 0 0 0 2 1.7h8A2 2 0 0 0 18 20l2-12"/><path d="M3 8h18"/><path d="M8 8a4 4 0 0 1 8 0"/></svg>
      <span class="bk-text"><b>${escapeHtml(display)}</b><i>${escapeHtml(sub)}</i></span>
      <span class="bk-acts">
        <button class="icon-btn small bk-edit" data-id="${b.id}" title="编辑备注 / 配额">${SVG.edit}</button>
        ${isAdmin ? `<button class="icon-btn small bk-del" data-id="${b.id}" title="将存储桶从列表中移除">${SVG.close}</button>` : ''}
      </span>
    </li>`;
  }).join('');
  ul.querySelectorAll('.bucket-item').forEach((li) => {
    li.onclick = (e) => {
      if (e.target.closest('.bk-acts')) return;
      selectBucket(li.dataset.id);
    };
  });
  ul.querySelectorAll('.bk-edit').forEach((btn) => {
    btn.onclick = () => {
      const b = buckets.find((x) => x.id === btn.dataset.id);
      if (b) openBucketDialog(b);
    };
  });
  ul.querySelectorAll('.bk-del').forEach((btn) => {
    btn.onclick = () => removeBucket(btn.dataset.id);
  });
}

async function selectBucket(id) {
  const cfg = App.state.config;
  if (cfg && cfg.activeBucketId === id) return;
  try {
    await API.activateBucket(id);
    const b = (App.state.buckets || []).find((x) => x.id === id);
    storageCache = null;
    await loadConfig(false);
    App.navigate('', { push: false });
    tree.init();
    toast('已切换到存储桶 ' + (b ? (b.remark || b.bucket) : ''), { type: 'success' });
  } catch (e) {
    toast('切换存储桶失败：' + e.message, { type: 'error' });
  }
}

async function removeBucket(id) {
  const b = (App.state.buckets || []).find((x) => x.id === id);
  const name = b ? (b.remark || b.bucket) : '';
  const ok = await confirmDialog({ allowHtml: true,
    title: '移除存储桶',
    message: `确定将存储桶 <b>${escapeHtml(name)}</b> 从本地列表移除吗？<br><span style="color:var(--text-2)"></span>`,
    okText: '移除', danger: true,
  });
  if (!ok) return;
  try {
    await API.deleteBucket(id);
    toast('已从本地移除存储桶 ' + name, { type: 'success' });
    storageCache = null;
    await loadConfig(false);
    App.navigate('', { push: false });
    tree.init();
  } catch (e) {
    toast('移除失败：' + e.message, { type: 'error' });
  }
}

/** 添加 / 编辑存储桶弹窗（管理员添加时可从云端拉取桶列表，须先选择访问密钥） */
function openBucketDialog(existing) {
  const isEdit = Boolean(existing);
  // 管理员专属字段的单一判据。服务端对非管理员走字段白名单，`credentialId` 与
  // `visibleToUsers` 一律丢弃（SEC-01）；而「从云端获取桶列表」用的是
  // POST /config/verify（仅管理员，SEC-11）—— 两件事普通用户都做不了主。
  // 与其留一堆勾了也没用 / 点了就 403 的控件，不如整项不渲染。
  const isAdminUser = !!(App.state.user && App.state.user.role === 'admin');
  // 候选密钥：已绑定（本地已存）且未停用；未配置任何密钥时无法拉取云端列表
  const allCreds = (App.state.config && App.state.config.credentials) || [];
  const usableCreds = allCreds.filter((c) => c.enabled !== false);
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="form-msg" id="bk-msg"></div>
    ${isEdit || !isAdminUser ? '' : `<div class="form-item">
      <label>访问密钥<span class="req">*</span></label>
      <select id="bk-cred">
        <option value="">— 选择访问密钥 —</option>
        ${usableCreds.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.remark || c.secretIdMasked || c.id)}（${escapeHtml(c.providerName || '')}）</option>`).join('')}
      </select>
      <div class="hint">选择一个已启用且未停用的密钥，用于从云端拉取桶列表与后续访问。</div>
    </div>`}
    <div class="form-item">
      <label>存储桶名称<span class="req">*</span></label>
      <input type="text" id="bk-name" placeholder="请输入云端已存在的存储桶名称" value="${isEdit ? escapeHtml(existing.bucket) : ''}" ${isEdit ? 'disabled' : ''}>
    </div>
    ${isEdit || !isAdminUser ? '' : `<div class="form-item">
      <button class="mini-btn" id="bk-load-cloud">从云端获取桶列表并选择</button>
      <select id="bk-cloud-pick" style="margin-left:8px;height:28px;width:52%;display:none"></select>
    </div>`}
    <div class="form-row">
      <div class="form-item">
        <label>地域（Region）<span class="req">*</span></label>
        <input type="text" id="bk-region" placeholder="例如 ap-guangzhou" value="${isEdit ? escapeHtml(existing.region) : ''}">
        <div class="hint" id="bk-region-hint"></div>
      </div>
      <div class="form-item">
        <label>备注名（可选）</label>
        <input type="text" id="bk-remark" placeholder="填写后外显为备注名" value="${isEdit ? escapeHtml(existing.remark || '') : ''}">
      </div>
    </div>
    <div class="form-item">
      <label>容量配额（GB）</label>
      <input type="number" id="bk-quota" min="0" step="1" value="${isEdit ? ((existing.quotaBytes || 0) / 1024 ** 3) : 0}">
      <div class="hint"><b> · 容量配额功能仅用于防止存储量过高，填 0 则无限制。为安全起见，修改回源设置、跨域设置、修改访问权限等操作需前往服务商控制台，本程序不提供此类功能</b>。</div>
    </div>
    ${isAdminUser ? `<div class="form-item">
      <label class="check-line"><input type="checkbox" id="bk-visible" ${isEdit ? (existing.visibleToUsers === false ? '' : 'checked') : 'checked'}>   对普通用户可见</label>
      <div class="hint">取消勾选后，该存储桶仅管理员可见；普通用户登录后不会看到此桶。</div>
    </div>` : ''}`;

  const msg = (text, cls) => {
    const m = wrap.querySelector('#bk-msg');
    m.textContent = text;
    m.className = 'form-msg show ' + cls;
  };

  // 密钥切换：地域提示与占位符随所选密钥的服务商变化
  const credSel = wrap.querySelector('#bk-cred');
  const regionHint = wrap.querySelector('#bk-region-hint');
  function syncCredentialHints() {
    if (!credSel) return;
    const id = credSel.value;
    const cred = usableCreds.find((c) => c.id === id);
    const pid = (cred && cred.provider) || (App.state.config && App.state.config.provider) || 'tencent';
    const prov = providerMeta(pid);
    if (regionHint) {
      regionHint.textContent = prov.regionHint || '';
      const regionInput = wrap.querySelector('#bk-region');
      if (regionInput) regionInput.placeholder = prov.regionPlaceholder || '请输入地域';
    }
  }
  if (credSel) credSel.onchange = syncCredentialHints;

  // 初始（编辑无选择器时）：按当前生效服务商
  if (regionHint) {
    const pid = (App.state.config && App.state.config.provider) || 'tencent';
    const prov = providerMeta(pid);
    regionHint.textContent = prov.regionHint || '';
    wrap.querySelector('#bk-region').placeholder = prov.regionPlaceholder || '请输入地域';
  }

  const loadBtn = wrap.querySelector('#bk-load-cloud');
  if (loadBtn) {
    loadBtn.onclick = async () => {
      if (!usableCreds.length) {
        return msg('暂无可用密钥，请先在「密钥管理」中添加并启用', 'bad');
      }
      const credId = credSel ? credSel.value : '';
      if (!credId) return msg('请先选择访问密钥', 'bad');
      try {
        msg('正在从云端获取…', 'info');
        const r = await API.verifyConfig({ credentialId: credId });
        if (!r.ok) return msg(r.error, 'bad');
        const sel = wrap.querySelector('#bk-cloud-pick');
        sel.style.display = '';
        sel.innerHTML = '<option value="">— 选择存储桶 —</option>' + (r.buckets || []).map((x) => `<option value="${escapeHtml(x.name)}|${escapeHtml(x.region)}">${escapeHtml(x.name)}（${escapeHtml(x.region)}）</option>`).join('');
        sel.onchange = () => {
          const [n, rg] = sel.value.split('|');
          if (n) { wrap.querySelector('#bk-name').value = n; wrap.querySelector('#bk-region').value = rg; }
        };
        msg(`获取成功，共 ${(r.buckets || []).length} 个存储桶`, 'ok');
      } catch (e) {
        msg(e.message, 'bad');
      }
    };
  }

  openModal({
    title: isEdit ? '编辑存储桶' : '添加存储桶', body: wrap,
    foot: [
      { text: '取消', onClick: (o, close) => close() },
      {
        text: isEdit ? '保存' : '添加', cls: 'primary', onClick: async (o, close) => {
          const region = wrap.querySelector('#bk-region').value.trim();
          const remark = wrap.querySelector('#bk-remark').value.trim();
          const quotaGB = Number(wrap.querySelector('#bk-quota').value) || 0;
          // 非管理员没有渲染该项（服务端也会丢弃该字段），提交时按「可见」处理
          const visibleEl = wrap.querySelector('#bk-visible');
          const visibleToUsers = visibleEl ? visibleEl.checked : true;
          if (quotaGB < 0) return msg('配额不能为负数，0 表示无限制', 'bad');
          try {
            if (isEdit) {
              await API.updateBucket(existing.id, { region, remark, quotaBytes: Math.round(quotaGB * 1024 ** 3), visibleToUsers });
            } else {
              const bucket = wrap.querySelector('#bk-name').value.trim();
              if (!bucket || !region) return msg('请填写存储桶名称与地域', 'bad');
              // 绑定用户选择的密钥（未选择时留空，回退为使用当前密钥）
              const credId = credSel ? credSel.value : '';
              await API.addBucket({ bucket, region, remark, quotaBytes: Math.round(quotaGB * 1024 ** 3), visibleToUsers, credentialId: credId || undefined });
            }
            close();
            toast(isEdit ? '存储桶信息已更新' : '存储桶已添加', { type: 'success' });
            storageCache = null;
            await loadConfig(false);
            if (!isEdit) {
              App.navigate('', { push: false });
              tree.init();
              checkBucketAcl(); // 新增桶后立即检测其权限状态
            }
          } catch (e) {
            msg(e.message, 'bad');
          }
        },
      },
    ],
  });
}
App.openBucketDialog = openBucketDialog;

/* ------------------------- 存储桶权限安全提醒 ------------------------- */

const ACL_LABEL = { 'public-read': '公有读私有写', 'public-read-write': '公有读写' };

/** 检查本地绑定桶的 ACL，发现公开访问时弹警告（用户已选"不再提醒"则跳过） */
async function checkBucketAcl() {
  // SEC-07：该接口为管理员专属（会遍历全部桶并返回桶名/地域/备注）。
  // 普通用户直接不发请求 —— 避免"必然 403"的无用调用与信息面暴露。
  if (!(App.state.user && App.state.user.role === 'admin')) return;
  try {
    const r = await API.aclCheck();
    if (r.disabled) return;
    const pubs = r.publicBuckets || [];
    if (!pubs.length) return; // 空桶列表 / 全部私有 / 仅查询失败：不打扰
    openAclWarning(pubs, (r.buckets || []).filter((b) => b.acl === 'unknown'));
  } catch (e) { /* 检查整体失败时静默，不影响页面使用 */ }
}

function openAclWarning(publics, unknowns) {
  const wrap = document.createElement('div');
  const hasWrite = publics.some((b) => b.acl === 'public-read-write');
  wrap.innerHTML = `
    <div class="acl-warn-text">检测到 <b>${publics.length}</b> 个存储桶处于<b>公开访问</b>状态。</div>
    <table class="acl-warn-table">
      <thead><tr><th>存储桶</th><th>地域</th><th>当前权限</th></tr></thead>
      <tbody>${publics.map((b) => `<tr>
        <td title="${escapeHtml(b.bucket)}">${escapeHtml(b.remark || b.bucket)}${b.remark ? `<i class="bk-sub">（${escapeHtml(b.bucket)}）</i>` : ''}</td>
        <td>${escapeHtml(b.region)}</td>
        <td><span class="lk-badge bad">${ACL_LABEL[b.acl] || b.acl}</span></td>
      </tr>`).join('')}</tbody>
    </table>
    ${unknowns && unknowns.length ? `<div class="hint" style="margin-top:10px">另有 ${unknowns.length} 个存储桶权限查询失败（${escapeHtml(unknowns.map((u) => u.remark || u.bucket).join('、'))}），未能确认其权限状态，请前往控制台自行核实。</div>` : ''}
    <div class="hint" style="margin-top:10px">点击「不再提醒」将永久关闭本提醒。</div>`;
  openModal({
    title: '⚠️ 存储桶权限安全警告', body: wrap,
    foot: [
      { text: '不再提醒', onClick: async (o, close) => {
        try {
          await API.setAclReminder(true);
          toast('已永久关闭存储桶权限安全提醒', { type: 'success' });
        } catch (e) {
          toast('关闭提醒失败：' + e.message, { type: 'error' });
          return;
        }
        close();
      } },
      { text: '关闭', cls: 'primary' },
    ],
  });
}

/* ------------------------------ 工具栏 ------------------------------ */

function injectIcons() {
  const set = (id, svg, label) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = svg + (label ? `<span>${label}</span>` : '');
  };
  set('btn-back', SVG.back); set('btn-fwd', SVG.fwd); set('btn-up', SVG.up);
  set('btn-refresh', SVG.refresh); set('btn-menu', SVG.menu);
  set('search-icon', SVG.search); set('btn-filter', SVG.filter); set('btn-search-clear', SVG.close);
  set('btn-viewopt', SVG.viewopt);
  set('btn-syssettings', SVG.gear, '系统设置');
  set('btn-bucket-add', SVG.plus, '');
  set('btn-bucket-refresh', SVG.refresh);
  set('btn-drawer-close', SVG.close);
  // 操作按钮
  set('op-newfolder', SVG.newfolder); set('op-upload', SVG.upload); set('op-download', SVG.download);
  set('op-rename', SVG.rename); set('op-move', SVG.move); set('op-copylink', SVG.link); set('op-delete', SVG.del);
  // 视图切换
  const vs = { list: SVG.viewList, thumbs: SVG.viewThumb, large: SVG.viewLarge, small: SVG.viewSmall };
  document.querySelectorAll('#view-switch button').forEach((b) => { b.innerHTML = vs[b.dataset.view] || ''; b.classList.toggle('active', b.dataset.view === App.state.view); });
  // 上传按钮下拉（文件/文件夹）
  const upBtn = document.getElementById('op-upload');
  upBtn.onclick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    showDropdownMenu(r.left, r.bottom + 4, [
      { text: '上传文件', onClick: () => document.getElementById('file-input').click() },
      { text: '上传文件夹', onClick: () => document.getElementById('folder-input').click() },
    ]);
  };
}

function showDropdownMenu(x, y, items) {
  const menu = document.getElementById('ctx-menu');
  menu.innerHTML = items.map((it, i) => `<div class="mi" data-i="${i}">${it.text}</div>`).join('');
  menu.hidden = false;
  menu.style.left = Math.min(x, innerWidth - 200) + 'px';
  menu.style.top = Math.min(y, innerHeight - items.length * 36 - 12) + 'px';
  menu.querySelectorAll('.mi').forEach((el) => {
    el.onclick = () => { menu.hidden = true; items[Number(el.dataset.i)].onClick(); };
  });
  setTimeout(() => document.addEventListener('mousedown', hideMenuOnce), 0);
  function hideMenuOnce(e) {
    if (!menu.contains(e.target)) menu.hidden = true;
    document.removeEventListener('mousedown', hideMenuOnce);
  }
}
window.__dropdown = showDropdownMenu;

function bindToolbar() {
  const $ = (id) => document.getElementById(id);
  $('btn-back').onclick = () => explorer.historyGo(-1);
  $('btn-fwd').onclick = () => explorer.historyGo(1);
  $('btn-up').onclick = () => {
    const p = App.state.prefix;
    if (!p) return;
    const parent = p.slice(0, -1).includes('/') ? p.slice(0, p.slice(0, -1).lastIndexOf('/') + 1) : '';
    App.navigate(parent);
  };
  $('btn-refresh').onclick = () => { explorer.refresh(); loadConfig(false); };
  $('btn-menu').onclick = () => toggleSidebar();
  $('sidebar-mask').onclick = () => closeSidebar();

  // 面包屑点击（在 explorer 中渲染）
  // 视图切换
  document.querySelectorAll('#view-switch button').forEach((b) => {
    b.onclick = () => {
      App.state.view = b.dataset.view;
      document.querySelectorAll('#view-switch button').forEach((x) => x.classList.toggle('active', x === b));
      savePrefs();
      explorer.render();
    };
  });
  $('btn-viewopt').onclick = () => openViewOptions();
  $('btn-syssettings').onclick = () => switchMainView('systemsettings');
  $('side-buckets').onclick = () => { switchMainView('bucketmgr'); closeSidebar(); };
  $('side-links').onclick = () => { switchMainView('linkmgr'); closeSidebar(); };
  $('side-orders').onclick = () => { switchMainView('ordermgr'); closeSidebar(); };
  $('side-dashboard').onclick = () => { switchMainView('dashboard'); closeSidebar(); };
  $('side-logs').onclick = () => { switchMainView('dashboard'); dashboard.showLogs(); closeSidebar(); };
  $('side-settings').onclick = () => { switchMainView('credmgr'); closeSidebar(); };
  $('side-help').onclick = () => { help.open(); closeSidebar(); };

  // 搜索
  const searchInput = $('search-input');
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && searchInput.value.trim()) explorer.search();
    if (e.key === 'Escape') explorer.exitSearch();
  });
  $('btn-filter').onclick = () => openFilterPanel();
  $('btn-search-clear').onclick = () => explorer.exitSearch();
  $('btn-exit-search').onclick = () => explorer.exitSearch();
  $('search-input').oninput = function () {
    $('btn-search-clear').hidden = !this.value;
  };

  // 操作按钮
  $('op-newfolder').onclick = () => ops.newFolder();
  $('op-download').onclick = () => ops.downloadSelected();
  $('op-rename').onclick = () => ops.renameSelected();
  $('op-move').onclick = () => ops.moveSelected();
  $('op-copylink').onclick = () => ops.copyLinkSelected();
  $('op-delete').onclick = () => ops.deleteSelected();
  $('op-selectall').onclick = () => explorer.selectAll();
  $('btn-bucket-add').onclick = () => {
    if (!App.state.config || !App.state.config.configured) {
      const isAdmin = App.state.user && App.state.user.role === 'admin';
      if (isAdmin) {
        toast('请先在“密钥管理”中配置访问密钥', { type: 'warn' });
        settings.open();
      } else {
        toast('尚未配置访问密钥，请联系管理员配置', { type: 'warn' });
      }
      return;
    }
    openBucketDialog(null);
  };
  $('btn-bucket-refresh').onclick = () => loadConfig(false);

  // 上传抽屉
  $('status-uploads').onclick = () => toggleUploadDrawer();
  $('btn-drawer-close').onclick = () => toggleUploadDrawer(false);
  $('btn-clear-finished').onclick = () => uploadMgr.clearFinished();
  $('file-input').onchange = function () { uploadMgr.enqueue(this.files, App.state.prefix); this.value = ''; };
  $('folder-input').onchange = function () { uploadMgr.enqueue(this.files, App.state.prefix, true); this.value = ''; };

  updateNavButtons();
}

function toggleSidebar(force) {
  const sb = document.getElementById('sidebar');
  const mask = document.getElementById('sidebar-mask');
  const open = force !== undefined ? force : !sb.classList.contains('open');
  sb.classList.toggle('open', open);
  mask.hidden = !open;
}
function closeSidebar() { toggleSidebar(false); }

const MAIN_VIEWS = ['explorer', 'dashboard', 'linkmgr', 'ordermgr', 'bucketmgr', 'systemsettings', 'credmgr'];

function switchMainView(v) {
  for (const id of MAIN_VIEWS) {
    const el = document.getElementById(id);
    if (el) el.hidden = v !== id;
  }
  if (v === 'dashboard') dashboard.refresh();
  else if (v === 'linkmgr') linkmgr.refresh();
  else if (v === 'ordermgr') ordermgr.refresh();
  else if (v === 'bucketmgr') bucketmgr.refresh();
  else if (v === 'systemsettings') syssettings.refresh();
  else if (v === 'credmgr') credmgr.refresh();
  else updateStatusbar();
  if (v !== 'bucketmgr') bucketmgr.stop(); // 离开管理页时停止统计轮询
}
App.switchMainView = switchMainView;
App.backToExplorer = () => switchMainView('explorer');

/**
 * 重置主视图到文件浏览（explorer）。
 *
 * **必须在登出与登录成功两个时点调用。** 否则上一个会话停留的非 explorer 区块
 * （如 #systemsettings）会保持可见：`App.navigate()` 只重写 explorer 子树，不会隐藏
 * 其它 section，于是换账号后用户直接看到上一个会话渲染的界面 —— 管理员登出、
 * 普通用户登录时会因此看到完整的用户列表与「添加用户」按钮（越权显示）。
 */
function resetMainView() {
  for (const id of MAIN_VIEWS) {
    const el = document.getElementById(id);
    if (el) el.hidden = id !== 'explorer';
  }
  // 订单列表属于上一个账号的对账数据，换账号必须丢弃
  ordermgr.reset();
  closeSidebar();
  // 关闭可能残留的浮层，避免跨会话泄漏上一账号的上下文
  const drawer = document.getElementById('upload-drawer');
  if (drawer) drawer.hidden = true;
  const cm = document.getElementById('ctx-menu');
  if (cm) cm.hidden = true;
}
App.resetMainView = resetMainView;

function toggleUploadDrawer(force) {
  const d = document.getElementById('upload-drawer');
  const open = force !== undefined ? force : d.hidden;
  d.hidden = !open;
  if (open) uploadMgr.render();
}

/* ------------------------------ 视图选项 ------------------------------ */

const COLUMN_DEFS = [
  { id: 'name', label: '名称' },
  { id: 'size', label: '大小' },
  { id: 'type', label: '类型' },
  { id: 'modified', label: '修改时间' },
];

function openViewOptions() {
  const s = App.state;
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div style="font-size:12px;color:var(--text-2);margin-bottom:6px">列表视图显示列</div>
    <div id="vo-cols"></div>
    <div class="hr"></div>
    <div class="form-item"><label>排序方式</label>
      <div class="seg-col" id="vo-sort">
        <button class="chip" data-v="name">名称</button>
        <button class="chip" data-v="size">大小</button>
        <button class="chip" data-v="type">类型</button>
        <button class="chip" data-v="modified">修改时间</button>
      </div>
    </div>
    <div class="form-item"><label>排序方向</label>
      <div class="seg-col" id="vo-dir">
        <button class="chip" data-v="asc">升序</button><button class="chip" data-v="desc">降序</button>
      </div>
    </div>
    <div class="hr"></div>
    <div class="form-item"><label>自动刷新频率（浏览目录时）</label>
      <div class="seg-col" id="vo-refresh">
        <button class="chip" data-v="0">手动</button><button class="chip" data-v="5">5 秒</button>
        <button class="chip" data-v="15">15 秒</button><button class="chip" data-v="30">30 秒</button>
        <button class="chip" data-v="60">60 秒</button>
      </div>
    </div>`;
  const colsEl = wrap.querySelector('#vo-cols');
  COLUMN_DEFS.forEach((c) => {
    const line = document.createElement('div');
    line.className = 'check-line';
    const checked = s.columns.includes(c.id) ? 'checked' : '';
    line.innerHTML = `<input type="checkbox" id="col-${c.id}" ${checked}><label for="col-${c.id}" style="margin:0">${c.label}</label>`;
    colsEl.appendChild(line);
  });
  function chipSelect(elSel, val) {
    wrap.querySelectorAll(elSel + ' .chip').forEach((b) => b.classList.toggle('active', b.dataset.v === String(val)));
  }
  chipSelect('#vo-sort', s.sort.key);
  chipSelect('#vo-dir', s.sort.dir);
  chipSelect('#vo-refresh', s.autoRefresh);
  [['#vo-sort', 'sort.key'], ['#vo-dir', 'sort.dir'], ['#vo-refresh', 'autoRefresh']].forEach(([sel]) => {
    wrap.querySelectorAll(sel + ' .chip').forEach((b) => {
      b.onclick = () => { b.parentElement.querySelectorAll('.chip').forEach((x) => x.classList.remove('active')); b.classList.add('active'); };
    });
  });
  wrap.querySelector('#vo-sort').dataset.role = 'sortkey';
  const m = openModal({
    title: '视图选项', body: wrap, foot: [
      { text: '取消' },
      {
        text: '应用', cls: 'primary', onClick: (o, close) => {
          try {
            s.columns = COLUMN_DEFS.filter((c) => o.querySelector('#col-' + c.id).checked).map((c) => c.id);
            if (!s.columns.includes('name')) s.columns.unshift('name');
            const act = (sel, fallback) => {
              const el = o.querySelector(sel + ' .active');
              return el ? el.dataset.v : fallback;
            };
            s.sort.key = act('#vo-sort', s.sort.key);
            s.sort.dir = act('#vo-dir', s.sort.dir);
            s.autoRefresh = Number(act('#vo-refresh', s.autoRefresh));
            savePrefs(); startAutoRefresh();
            explorer.render();
            close();
            toast('视图选项已应用', { type: 'success' });
          } catch (e) {
            toast('应用视图选项失败：' + e.message, { type: 'error' });
            close();
          }
        },
      },
    ],
  });
}

/* ------------------------------ 筛选面板（搜索多条件） ------------------------------ */

function openFilterPanel() {
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="form-item"><label>类型</label>
      <select id="ft-type">
        <option value="">全部类型</option><option value="image">图片</option><option value="video">视频</option>
        <option value="audio">音频</option><option value="doc">文档</option><option value="archive">压缩包</option>
        <option value="other">其他文件</option><option value="folder">文件夹</option>
      </select>
    </div>
    <div class="form-row">
      <div class="form-item"><label>修改日期从</label><input type="date" id="ft-from"></div>
      <div class="form-item"><label>修改日期至</label><input type="date" id="ft-to"></div>
    </div>
    <div class="form-row">
      <div class="form-item"><label>最小大小 (MB)</label><input type="number" id="ft-min" min="0" placeholder="0"></div>
      <div class="form-item"><label>最大大小 (MB)</label><input type="number" id="ft-max" min="0" placeholder="不限"></div>
    </div>
    <div class="check-line" style="margin-top:6px">
      <input type="checkbox" id="ft-current" ${App.state.searchCurrentOnly ? 'checked' : ''}>
      <label for="ft-current" style="margin:0">仅当前目录（不递归子目录）</label>
    </div>
    <div class="hint">点击工具栏“搜索”或在搜索框回车后，将按名称关键字 + 以上条件搜索。
      勾选「仅当前目录」时只扫当前这一层 —— 云端列举从“所有子目录的页数”降到 1 页，
      在大桶里是数量级的差别；该选项会被记住。</div>`;
  const m = openModal({
    title: '筛选条件', body: wrap, foot: [
      { text: '清除条件', onClick: (o, close) => { window.__filter = null; close(); explorer.exitSearch(); } },
      {
        text: '应用并搜索', cls: 'primary', onClick: (o, close) => {
          const f = {
            type: o.querySelector('#ft-type').value,
            from: o.querySelector('#ft-from').value,
            to: o.querySelector('#ft-to').value,
            minMB: Number(o.querySelector('#ft-min').value) || 0,
            maxMB: o.querySelector('#ft-max').value ? Number(o.querySelector('#ft-max').value) : null,
          };
          window.__filter = (f.type || f.from || f.to || f.minMB || f.maxMB) ? f : null;
          // 搜索范围不入 __filter：它是 App.state 上的单一判据（回车与面板共用），
          // 塞进 filter 会让「只勾范围、不填条件」时 filter 被判为空而整次搜索被跳过。
          setSearchScope(o.querySelector('#ft-current').checked);
          close();
          explorer.search();
        },
      },
    ],
  });
}

/**
 * 设置搜索范围（仅当前目录 / 递归子树），并同步搜索框的占位提示。
 *
 * 单一判据：搜索框回车与筛选面板都读 App.state.searchCurrentOnly，
 * 不会出现「面板里勾了、回车却不生效」这种两处状态不一致。
 */
function setSearchScope(on, { save = true } = {}) {
  App.state.searchCurrentOnly = !!on;
  const input = document.getElementById('search-input');
  if (input) {
    input.placeholder = App.state.searchCurrentOnly
      ? '搜索当前目录（回车）'
      : '搜索当前目录及子目录（回车）';
  }
  if (save) savePrefs();
}

/* ------------------------------ 状态栏 ------------------------------ */

let storageCache = null;

export async function updateStatusbar() {
  const $ = (id) => document.getElementById(id);
  const cfg = App.state.config;
  const conn = $('status-conn');
  if (!cfg) { conn.querySelector('em').textContent = '未连接'; conn.querySelector('.dot').className = 'dot'; }
  else if (cfg.corrupted) { conn.querySelector('em').textContent = '配置已损坏'; conn.querySelector('.dot').className = 'dot bad'; }
  else if (cfg.configured) { conn.querySelector('em').textContent = '已就绪（HTTPS）'; conn.querySelector('.dot').className = 'dot ok'; }
  else { conn.querySelector('em').textContent = '未配置密钥'; conn.querySelector('.dot').className = 'dot'; }

  $('status-bucket').textContent = App.state.bucket ? `🪣 ${App.state.bucketDisplay || App.state.bucket}（${App.state.region}）` : '';
  $('status-bucket').title = App.state.bucket || '';

  // 存储用量（quotaBytes 为 0 表示无限制）
  if (cfg && cfg.configured && App.state.bucket) {
    try {
      // R7-10：失败态**不得**被缓存。旧实现把 rejected 的 Promise 存进 storageCache
      // 且永不失效 —— 一次 428（未配置）或网络抖动之后，后续每次 updateStatusbar
      // 都复用同一个失败 Promise，状态栏长期显示「用量获取失败」，只有切桶/增删桶才恢复。
      if (!storageCache) {
        storageCache = API.storage().catch((e) => { storageCache = null; throw e; });
      }
      const st = await storageCache;
      App.state.storageInfo = st;
      const used = st.usedBytes || 0;
      const total = App.state.quotaBytes || 0;
      const pct = total ? Math.min(100, (used / total) * 100) : 0;
      const bar = document.querySelector('#status-quota .quota-bar');
      bar.querySelector('i').style.width = total ? pct.toFixed(1) + '%' : '100%';
      bar.classList.toggle('hot', total > 0 && pct >= 85);
      bar.classList.toggle('unlimited', total === 0);
      $('quota-text').textContent = total ? `${fmtSize(used)} / ${fmtSize(total)}（${pct.toFixed(1)}%）` : `${fmtSize(used)} / 无限制`;
    } catch (e) { $('quota-text').textContent = '用量获取失败'; }
  } else {
    document.querySelector('#status-quota .quota-bar i').style.width = '0';
    $('quota-text').textContent = '—';
  }
}

/**
 * 今日累计流量（低频，写入悬停提示；状态栏正文显示实时速度）
 *
 * R7-09：驱动它的 60 秒定时器此前**建了就再没人管**（全库唯一一处没有 clearInterval 的
 * setInterval）—— 登出 / 会话过期后仍每 60 秒请求一次 `/api/stats/summary`（401）。
 * 这里与 `startSpeedPolling` 同一套约定：句柄保存 + 可停止 + 状态栏元素不在时自停。
 */
export async function refreshMiniStats() {
  // 已登出（状态栏不在）→ 立刻停止轮询，而不是"请求照发、只在渲染时 return"
  if (!document.getElementById('status-traffic')) { stopStatsTimer(); return; }
  try {
    const s = await API.summary();
    App.state.statsSummary = s;
    const t = s.traffic;
    document.getElementById('status-traffic').title =
      `今日流量 ↑${fmtSize(t.todayUp)} ↓${fmtSize(t.todayDown)}（正文为实时速度，近 10 秒平均）`;
    updateStatusbar();
  } catch (e) {
    // 401/403 说明会话已失效，继续轮询没有意义
    if (e && (e.status === 401 || e.status === 403)) stopStatsTimer();
  }
}

/** R7-09：统计摘要定时器 —— 句柄保存 + 先停后启，登出时由 forceLogout 停止 */
function startStatsTimer() {
  stopStatsTimer();
  App._statsTimer = setInterval(refreshMiniStats, 60000);
}
function stopStatsTimer() {
  if (App._statsTimer) { clearInterval(App._statsTimer); App._statsTimer = null; }
}

/**
 * 实时上传/下载速度（近 10 秒平均，2 秒轮询）
 *
 * PERF-03：句柄必须保存并可停止。旧实现 `setInterval(tick, 2000)` 的结果被丢弃，
 * 于是登出后、登录页上仍在持续请求 `/api/stats/speed`（返回 401）——
 * 约 1800 次/小时/标签页，多标签页叠加，且全部是无效请求。
 * 同时在元素不存在（未登录 / 已登出）时**停止轮询**，而不是"请求照发、只在渲染时 return"。
 */
let speedTimer = null;
function startSpeedPolling() {
  stopSpeedPolling();
  const el = () => document.getElementById('status-traffic');
  async function tick() {
    if (!el()) { stopSpeedPolling(); return; } // 状态栏不在 → 已登出，立即停
    try {
      const s = await API.speed();
      if (!el()) { stopSpeedPolling(); return; }
      el().textContent = `↑${fmtSize(s.up || 0)}/s ↓${fmtSize(s.down || 0)}/s`;
    } catch (e) {
      // 401（未登录）说明会话已失效，继续轮询没有意义
      if (e && (e.status === 401 || e.status === 403)) stopSpeedPolling();
    }
  }
  tick();
  speedTimer = setInterval(tick, 2000);
}

function stopSpeedPolling() {
  if (speedTimer) { clearInterval(speedTimer); speedTimer = null; }
}
App.stopSpeedPolling = stopSpeedPolling;

/** 强制刷新存储用量（上传/删除等改变容量的操作后调用） */
export function refreshStorage() {
  storageCache = null;
  updateStatusbar();
}
App.refreshStorage = refreshStorage;

function updateNavButtons() {
  const s = App.state;
  document.getElementById('btn-back').disabled = s.historyIndex <= 0;
  document.getElementById('btn-fwd').disabled = s.historyIndex >= s.history.length - 1;
}
App.updateNavButtons = updateNavButtons;

/* ------------------------------ 自动刷新 ------------------------------ */

let refreshTimer = null;
function startAutoRefresh() {
  clearInterval(refreshTimer);
  if (App.state.autoRefresh > 0) {
    refreshTimer = setInterval(() => {
      if (document.getElementById('explorer').hidden) return; // 仪表盘打开时不刷新文件列表
      if (uploadMgr.hasActive()) return; // 有上传任务时暂停自动刷新，避免干扰
      explorer.refresh({ silent: true });
      refreshMiniStats();
    }, App.state.autoRefresh * 1000);
  }
}

/* ------------------------------ 键盘快捷键 ------------------------------ */

function bindKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    if (document.querySelector('#modal-root .overlay')) return;
    const s = App.state;
    if (e.key === 'Delete' && s.selection.size) { ops.deleteSelected(); }
    else if (e.key === 'F2' && s.selection.size === 1) { ops.renameSelected(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault(); explorer.selectAll();
    } else if (e.key === 'F5') { e.preventDefault(); explorer.refresh(); }
    else if (e.key === 'Enter' && s.selection.size === 1) { explorer.openItem([...s.selection][0]); }
    else if (e.key === 'Backspace') { document.getElementById('btn-up').click(); }
  });

  // 全局 401 → 强制回到登录页（防止会话过期后仍停留在界面）
  window.addEventListener('auth-required', () => {
    if (App.state.user) {
      forceLogout('登录已过期，请重新登录');
    }
  });
}

/* roundRect 兼容 */
if (!CanvasRenderingContext2D.prototype.roundRect) {
  CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
    r = Math.min(r || 0, w / 2, h / 2);
    this.moveTo(x + r, y);
    this.arcTo(x + w, y, x + w, y + h, r);
    this.arcTo(x + w, y + h, x, y + h, r);
    this.arcTo(x, y + h, x, y, r);
    this.arcTo(x, y, x + w, y, r);
    this.closePath();
    return this;
  };
}

init();
