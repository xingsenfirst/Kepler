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
    /**
     * R25：配额类错误带**机器可读码 + 结构化明细**（`code` / `quota`）。
     * 必须挂回错误对象 —— 只留文案的话，调用方无法把「超出 API Key 配额」与其它
     * 403（如上传排除命中）区分开，只能对所有 403 弹同一条提示。
     */
    if (data && data.code) err.code = data.code;
    if (data && data.quota) err.quota = data.quota;
    /**
     * R33：账户封禁同样带**结构化字段**（`banned` / `reason` / `until`）。
     * 只留那句「该账户已被封禁」的文案，登录页就无从显示"为什么被封、什么时候解封"，
     * 而这正是需求明确要求给被封用户看的两项信息（服务端已在校验密码后才下发）。
     */
    if (data && data.banned) {
      err.banned = true;
      err.reason = data.reason || '';
      err.until = data.until || '';
    }
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

/**
 * R29-01：上传的**停滞**判定阈值（区分两个阶段，理由见 `xhrPut`）。
 *  - `UPLOAD_IDLE_MS`：还在发字节时的静默容忍 —— 60 秒一个字节都没发出去，基本可判链路已断；
 *  - `UPLOAD_SERVER_WAIT_MS`：请求体已发完、等服务端确认 —— 服务端还要加密 / 上云 / 写元数据，
 *    大文件上云本身就可能几分钟，故给足 10 分钟。
 *
 * 两个值都**不是**「上传总时长」上限（那会误杀慢链路）：只有**完全没有进展**才会触发。
 */
const UPLOAD_IDLE_MS = 60 * 1000;
const UPLOAD_SERVER_WAIT_MS = 10 * 60 * 1000;

/**
 * XHR 上传（支持进度回调；返回的 Promise 附加 .xhr 引用用于中止）
 *
 * R29-01：这里补上了**停滞看门狗**。此前没有任何超时保护：只要服务端（或其背后的对象存储）
 * 迟迟不返回，`xhr.onload` 就永远不触发，上传任务会**无限期停在「上传中」**——用户看到的是
 * 「大文件卡住」，而文件可能早已落云（于是又表现为「刷新一下就有了」）。
 * 现在按阶段看门狗：
 *  - 发送阶段 60 秒无任何上传进度 → 判定链路停滞，abort 并给出可重试的错误；
 *  - 请求体发完后的等待阶段给到 10 分钟 → 超时同样 abort（错误里说明是服务端未确认）。
 * 停滞错误**不设 `aborted`**，因此 `uploadWithRetry` 会按既有策略重试两次，而不是直接失败。
 */
export function xhrPut(url, blob, onProgress) {
  const xhr = new XMLHttpRequest();
  const p = new Promise((resolve, reject) => {
    let settled = false;
    let stalled = false;
    let bodySent = false;
    let watchdog = null;
    const clearWatchdog = () => { if (watchdog) { clearTimeout(watchdog); watchdog = null; } };
    const armWatchdog = () => {
      clearWatchdog();
      watchdog = setTimeout(() => {
        stalled = true;
        // 触发 onabort → 下面的分支给出「停滞」错误（而不是「已中止」）
        try { xhr.abort(); } catch (e) { /* ignore */ }
      }, bodySent ? UPLOAD_SERVER_WAIT_MS : UPLOAD_IDLE_MS);
    };
    const settle = (fn, arg) => { if (settled) return; settled = true; clearWatchdog(); fn(arg); };

    xhr.open('PUT', url);
    xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
    xhr.responseType = 'json';
    xhr.upload.onprogress = (e) => {
      if (e && e.total && e.loaded >= e.total) bodySent = true;
      armWatchdog();
      if (onProgress) onProgress(e.loaded, e.total);
    };
    /**
     * R29-01：`upload.onload` 是「请求体**已全部交给网络栈**」的权威信号 —— 小文件上
     * `onprogress` 可能一次都不触发（浏览器会合并甚至省略），只靠它就会让进度条一直停在 0%
     * 直到响应到达。这里补一次"已发完"的回调：既让界面切到「服务器处理中」，也让看门狗
     * 从 60 秒档切到 10 分钟档（此后的等待属于服务端处理，不是链路停滞）。
     */
    xhr.upload.onload = () => {
      bodySent = true;
      armWatchdog();
      const total = Number(blob && blob.size) || 0;
      if (onProgress) onProgress(total, total);
    };
    xhr.onload = () => {
      clearWatchdog();
      const d = xhr.response || {};
      if (xhr.status >= 200 && xhr.status < 300) return settle(resolve, d);
      const err = new Error(d.error || `上传失败（HTTP ${xhr.status}）`);
      err.status = xhr.status;
      // R25：与 request() 同源 —— 直传（XHR）路径同样要能识别配额超限
      if (d && d.code) err.code = d.code;
      if (d && d.quota) err.quota = d.quota;
      settle(reject, err);
    };
    xhr.onerror = () => settle(reject, new Error('网络错误，上传中断'));
    xhr.onabort = () => {
      if (stalled) {
        const err = new Error(bodySent
          ? '上传停滞：数据已发完但服务器长时间未确认（加密 / 上云可能耗时过长，或链路中断）'
          : '上传停滞：持续 60 秒没有数据发出（链路中断或服务端未响应）');
        err.stalled = true; // 不设 aborted：让上层按既有的重试策略再试
        return settle(reject, err);
      }
      const err = new Error('已中止');
      err.aborted = true;
      settle(reject, err);
    };
    armWatchdog();
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
  // R33：账户封禁 / 解封（仅管理员）。`until` 由 datetime-local 换算成 epoch 毫秒后提交，
  // 留空即永久封禁 —— 服务端按绝对时刻存储，跨时区不会错位。
  banUser: (id, b) => request('POST', `/api/users/${encodeURIComponent(id)}/ban`, b),
  unbanUser: (id) => request('POST', `/api/users/${encodeURIComponent(id)}/unban`),
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
  // 负载均衡：按 API Key 的配额用量（仅管理员）
  quotaUsage: () => request('GET', '/api/credentials/quota-usage'),
  setCredentialQuota: (id, quotaBytes) => request('PUT', `/api/credentials/${encodeURIComponent(id)}`, { quotaBytes }),

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
  // R32-02：删除全部失效链接（文件已删除 / 已过期）；「已关闭」不算失效，不受影响
  deleteDeadLinks: () => request('DELETE', '/api/links/dead'),

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
  // R32-01：删除全部「支付失败」的订单（已支付 / 已退款 / 支付中一律不受影响）
  deleteFailedOrders: () => request('DELETE', '/api/payment/orders/failed'),
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
