/** API 客户端 —— 与本地服务端通信 */

/**
 * @param {object} [opt]
 * @param {AbortSignal} [opt.signal]
 * @param {boolean} [opt.noAuthRedirect] 401 时**不**派发全局 `auth-required`。
 *   R8-12：只有在「本来就没有有效会话」的调用（登录、初始化管理员、登录第二步
 *   Windows Hello 断言）上才需要它 —— 这些请求失败时弹「登录已过期，请重新登录」
 *   既误导用户、又会把正在填写的表单整块重置掉。
 */
async function request(method, path, body, { signal, noAuthRedirect } = {}) {
  // X-Requested-With：同源自定义头，浏览器跨域表单无法伪造，用于服务端 CSRF 校验
  const opt = { method, headers: { 'X-Requested-With': 'XMLHttpRequest' } };
  if (signal) opt.signal = signal;
  if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, opt);
  } catch (e) {
    // 主动取消（AbortController）不是故障：原样抛出，交给调用方静默丢弃。
    // 否则会被当成"无法连接本地服务"弹一个完全误导的错误提示。
    if (e && e.name === 'AbortError') throw e;
    const err = new Error('无法连接本地服务，请确认服务已启动');
    err.status = 0;
    throw err;
  }
  let data = null;
  try { data = await res.json(); } catch (e) { /* 非 JSON 响应 */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `请求失败（HTTP ${res.status}）`);
    err.status = res.status;
    // 401 未登录 → 派发全局事件，由 main.js 统一跳回登录界面。
    // R8-12：服务端的 401 只有两种含义，这里都必须**真是**「没有有效会话」。
    // 「当前密码不正确」（webauthn 注册/关闭）已改为 403；登录类请求用 noAuthRedirect 排除。
    if (res.status === 401 && !noAuthRedirect && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('auth-required'));
    }
    throw err;
  }
  return data;
}

function qs(params) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') p.set(k, v);
  }
  return p.toString();
}

/** XHR 上传（支持进度回调；返回的 Promise 附加 .xhr 引用用于中止） */
export function xhrPut(url, blob, onProgress) {
  const xhr = new XMLHttpRequest();
  const p = new Promise((resolve, reject) => {
    xhr.open('PUT', url);
    xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
    xhr.responseType = 'json';
    xhr.upload.onprogress = (e) => { if (onProgress) onProgress(e.loaded, e.total); };
    xhr.onload = () => {
      const d = xhr.response || {};
      if (xhr.status >= 200 && xhr.status < 300) resolve(d);
      else { const err = new Error(d.error || `上传失败（HTTP ${xhr.status}）`); err.status = xhr.status; reject(err); }
    };
    xhr.onerror = () => reject(new Error('网络错误，上传中断'));
    xhr.onabort = () => { const err = new Error('已中止'); err.aborted = true; reject(err); };
    xhr.send(blob);
  });
  p.xhr = xhr;
  return p;
}

export const API = {
  health: () => request('GET', '/api/health'),
  getConfig: () => request('GET', '/api/config'),
  saveConfig: (b) => request('PUT', '/api/config', b),
  verifyConfig: (b) => request('POST', '/api/config/verify', b),

  // 登录认证 / 用户管理
  authMe: () => request('GET', '/api/auth/me'),
  // 登录三兄弟（login / loginWebauthn / initAdmin）失败时**不**派发 auth-required：
  // 此刻本来就没有会话，401 意味着「凭据不对」，不是「会话过期」。
  login: (username, password, captchaToken, remember) => request('POST', '/api/auth/login', Object.assign(
    { username, password, remember: !!remember }, captchaToken ? { captchaToken } : null),
    { noAuthRedirect: true }),
  // 登录第二步：Windows Hello 断言校验（仅在第一步返回 webauthnRequired 时调用）
  loginWebauthn: (b) => request('POST', '/api/auth/login/webauthn', b, { noAuthRedirect: true }),
  logout: () => request('POST', '/api/auth/logout'),
  initAdmin: (b) => request('POST', '/api/auth/init', b, { noAuthRedirect: true }),
  users: () => request('GET', '/api/users'),
  addUser: (b) => request('POST', '/api/users', b),
  updateUser: (id, b) => request('PUT', `/api/users/${encodeURIComponent(id)}`, b),
  deleteUser: (id) => request('DELETE', `/api/users/${encodeURIComponent(id)}`),
  // 自助资料（普通用户亦可调用；仅允许改用户名与密码）
  myProfile: () => request('GET', '/api/users/me'),
  updateMyProfile: (b) => request('PUT', '/api/users/me', b),

  // Windows Hello（WebAuthn）：注册 / 关闭
  webauthnRegisterOptions: (password) => request('POST', '/api/webauthn/register/options', { password }),
  webauthnRegisterVerify: (b) => request('POST', '/api/webauthn/register/verify', b),
  webauthnDisable: (password) => request('POST', '/api/webauthn/disable', { password }),
  adminDisableWebauthn: (id) => request('POST', `/api/users/${encodeURIComponent(id)}/webauthn/disable`),

  // 登录人机验证（验证码）
  captchaPublic: () => request('GET', '/api/captcha/public'),
  captchaConfig: () => request('GET', '/api/captcha/config'),
  saveCaptchaConfig: (b) => request('PUT', '/api/captcha/config', b),

  // 访问密钥管理
  listCredentials: () => request('GET', '/api/credentials'),
  addCredential: (b) => request('POST', '/api/credentials', b),
  activateCredential: (id) => request('PUT', `/api/credentials/${encodeURIComponent(id)}/active`),
  updateCredential: (id, b) => request('PUT', `/api/credentials/${encodeURIComponent(id)}`, b),
  deleteCredential: (id) => request('DELETE', `/api/credentials/${encodeURIComponent(id)}`),
  // 批量设置密钥对普通用户的可见性（仅管理员）
  saveCredentialVisibility: (visibleIds) => request('PUT', '/api/credentials/visibility', { visibleIds }),

  // 本地存储桶管理
  localBuckets: () => request('GET', '/api/buckets/local'),
  addBucket: (b) => request('POST', '/api/buckets/local', b),
  updateBucket: (id, b) => request('PUT', `/api/buckets/local/${encodeURIComponent(id)}`, b),
  toggleBucketEnabled: (id, enabled) => request('PUT', `/api/buckets/local/${encodeURIComponent(id)}/enabled`, { enabled }),
  setBucketBlockOverseas: (id, enabled) => request('PUT', `/api/buckets/local/${encodeURIComponent(id)}/block-overseas`, { enabled }),
  activateBucket: (id) => request('PUT', `/api/buckets/local/${encodeURIComponent(id)}/active`),
  deleteBucket: (id) => request('DELETE', `/api/buckets/local/${encodeURIComponent(id)}`),
  // 批量设置桶对普通用户的可见性（仅管理员）
  saveBucketVisibility: (visibleIds) => request('PUT', '/api/buckets/visibility', { visibleIds }),

  // 存储桶管理页
  bucketStats: () => request('GET', '/api/buckets/stats'),
  clearBucket: (id, nameConfirm) => request('POST', `/api/buckets/local/${encodeURIComponent(id)}/clear`, { nameConfirm }),
  bucketFragments: (id) => request('GET', `/api/buckets/local/${encodeURIComponent(id)}/fragments`),
  clearFragments: (id) => request('POST', `/api/buckets/local/${encodeURIComponent(id)}/fragments/clear`),
  destroyCheck: (id) => request('GET', `/api/buckets/local/${encodeURIComponent(id)}/destroy-check`),
  destroyBucket: (id, nameConfirm) => request('POST', `/api/buckets/local/${encodeURIComponent(id)}/destroy`, { nameConfirm }),

  // 桶 ACL 安全检查
  aclCheck: () => request('GET', '/api/acl-check'),
  setAclReminder: (disabled) => request('PUT', '/api/acl-check/disabled', { disabled }),

  // 文件加密（系统设置）
  encSettings: () => request('GET', '/api/enc/settings'),
  // R8-14：任意登录用户可读的最小摘要（仅 passwordSet，不含 mode / 魔数）
  encStatus: () => request('GET', '/api/enc/status'),
  updateEncSettings: (b) => request('PUT', '/api/enc/settings', b),
  encUnlock: (password) => request('POST', '/api/enc/unlock', { password }),

  // IP 访问屏蔽
  ipGuard: () => request('GET', '/api/ipguard'),
  addIpRule: (b) => request('POST', '/api/ipguard/rules', b),
  updateIpRule: (id, b) => request('PUT', `/api/ipguard/rules/${encodeURIComponent(id)}`, b),
  toggleIpRule: (id, enabled) => request('PUT', `/api/ipguard/rules/${encodeURIComponent(id)}/enabled`, { enabled }),
  deleteIpRule: (id) => request('DELETE', `/api/ipguard/rules/${encodeURIComponent(id)}`),
  testIpRule: (ip, method, bucketId) => request('GET', '/api/ipguard/test?' + qs({ ip, method, bucketId })),

  list: (p) => request('GET', '/api/fs/list?' + qs(p)),
  // opt.signal：供调用方取消在途搜索（服务端据此停止后续翻页，不再白扫）
  search: (p, opt) => request('GET', '/api/fs/search?' + qs(p), undefined, opt),
  tree: (prefix) => request('GET', '/api/fs/tree?' + qs({ prefix })),
  mkdir: (path) => request('POST', '/api/fs/mkdir', { path }),
  rename: (path, newName, size) => request('POST', '/api/fs/rename', { path, newName, size }),
  move: (paths, targetPrefix) => request('POST', '/api/fs/move', { paths, targetPrefix }),
  del: (paths) => request('POST', '/api/fs/delete', { paths }),
  presign: (path, expires) => request('GET', '/api/fs/presign?' + qs({ path, expires })),
  stat: (path) => request('GET', '/api/fs/stat?' + qs({ path })),

  // 分享链接管理
  links: () => request('GET', '/api/links'),
  createLink: (b) => request('POST', '/api/links', b),
  updateLink: (id, b) => request('PUT', `/api/links/${encodeURIComponent(id)}`, b),
  deleteLink: (id) => request('DELETE', `/api/links/${encodeURIComponent(id)}`),

  uploadInit: (key, size, mtime, extra) => request('POST', '/api/fs/upload/init', Object.assign({ key, size, mtime }, extra || {})),
  uploadComplete: (sessionId) => request('POST', '/api/fs/upload/complete', { sessionId }),
  uploadAbort: (sessionId) => request('POST', '/api/fs/upload/abort', { sessionId }),
  sessions: () => request('GET', '/api/fs/sessions'),

  // 上传排除设置
  uploadExcludes: () => request('GET', '/api/upload-excludes'),
  saveUploadExcludes: (b) => request('PUT', '/api/upload-excludes', b),

  // 支付平台凭证（系统设置，仅管理员）
  paymentConfig: () => request('GET', '/api/payment/config'),
  paymentOrders: () => request('GET', '/api/payment/orders'),
  // 退款：本系统不代持资金，这只是把订单标记为「已退款」的人工记账动作
  refundOrder: (id) => request('POST', `/api/payment/orders/${encodeURIComponent(id)}/refund`),
  setPaymentSiteUrl: (siteUrl) => request('PUT', '/api/payment/site-url', { siteUrl }),
  setPaymentEnabled: (enabled) => request('PUT', '/api/payment/enabled', { enabled }),
  setPaymentChannelEnabled: (platform, enabled) => request('PUT', `/api/payment/config/${encodeURIComponent(platform)}/enabled`, { enabled }),
  validatePayment: (platform, b) => request('POST', `/api/payment/config/${encodeURIComponent(platform)}/validate`, b),
  savePayment: (platform, b) => request('PUT', `/api/payment/config/${encodeURIComponent(platform)}`, b),
  clearPayment: (platform) => request('DELETE', `/api/payment/config/${encodeURIComponent(platform)}`),

  // WebDAV 服务（系统设置）
  webdav: () => request('GET', '/api/webdav'),
  setWebdavEnabled: (enabled) => request('PUT', '/api/webdav/enabled', { enabled }),
  addWebdavAccount: (b) => request('POST', '/api/webdav/accounts', b),
  updateWebdavAccount: (id, b) => request('PUT', `/api/webdav/accounts/${encodeURIComponent(id)}`, b),
  deleteWebdavAccount: (id) => request('DELETE', `/api/webdav/accounts/${encodeURIComponent(id)}`),
  revealWebdavPassword: (id) => request('GET', `/api/webdav/accounts/${encodeURIComponent(id)}/password`),

  storage: () => request('GET', '/api/stats/storage'),
  summary: () => request('GET', '/api/stats/summary'),
  speed: () => request('GET', '/api/stats/speed'),
  logs: (p) => request('GET', '/api/stats/logs?' + qs(p)),

  thumbUrl: (path) => '/api/fs/thumb?path=' + encodeURIComponent(path),
  downloadUrl: (path) => '/api/fs/download?path=' + encodeURIComponent(path),
};
