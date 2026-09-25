/**
 * 路由：登录认证（登录 / 登出 / 会话探测 / 系统初始化）
 *  — 唯一允许匿名访问的路由组（见 index.js 的 PUBLIC_API 白名单）
 *
 * 登录采用**两步式**设计，以便在密码正确之后、签发会话之前插入 Windows Hello 校验：
 *
 *   第一步 POST /auth/login       { username, password, captchaToken }
 *        · 人机验证（reCAPTCHA / Turnstile，开启时）
 *        · 密码校验
 *        · 若该用户启用了 Windows Hello → 返回 { ok:false, webauthnRequired:true, challenge }
 *          （此时**尚未签发会话**，服务端仅记录一个待校验挑战）
 *        · 未启用 → 直接签发会话（原有行为 100% 不变）
 *
 *   第二步 POST /auth/login/webauthn { username, challenge, clientDataJSON, authenticatorData, signature, rawId }
 *        · 校验 ES256 签名（Node 内置 crypto，零依赖）
 *        · 通过后才签发会话
 *
 * 与验证码共存：验证码属第一步、Windows Hello 属第二步，串联而非互斥，同时开启均生效。
 */
const { express, security, configStore, statsStore, authSession, captcha, webauthn } = require('./_context');
const { sessionCookie, clearCookie, webauthnContext } = require('./_shared');

const router = express.Router();

/**
 * 登录失败锁定的键（SEC-02）
 *
 * 旧实现**只按用户名**锁定：任何人只要知道管理员的用户名，连着输错 5 次密码
 * 就能把管理员本人锁在外面最长 30 分钟 —— 锁定被反向用作 DoS 工具，
 * 而且攻击者自己只受"每 IP 每分钟 10 次"的限流约束，成本极低。
 *
 * 锁定键必须带上**攻击者控制不了**的维度（来源 IP）：这样失败计数只对
 * 「这个 IP 试探这个账户」累积，管理员从自己的机器照常登录。
 * 分布式暴破由 loginLimiter（按 IP 限流）负责 —— 限流键才是纯 IP。
 */
function loginLockKey(ip, username) {
  return `${ip}|${username}`;
}

/** 两步登录共用的前置检查：限流 + 账户锁定。返回 null 表示可继续 */
function precheckLogin(req, res, username) {
  const ip = security.clientIp(req);
  const rl = security.loginLimiter(ip);
  if (!rl.ok) {
    statsStore.addLog({ action: 'auth.fail', level: 'warn', detail: `登录过于频繁已限流（IP：${ip}）` });
    res.setHeader('Retry-After', String(rl.retryAfter));
    res.status(429).json({ error: `尝试过于频繁，请 ${rl.retryAfter} 秒后重试` });
    return null;
  }
  const lockKey = loginLockKey(ip, username);
  const lockedLeft = security.loginLock.locked(lockKey);
  if (lockedLeft > 0) {
    statsStore.addLog({ action: 'auth.fail', level: 'warn', detail: `账户「${username}」在该来源已被临时锁定（IP：${ip}，剩余 ${lockedLeft} 秒）` });
    res.status(429).json({ error: `失败次数过多，账户已临时锁定，请 ${lockedLeft} 秒后重试` });
    return null;
  }
  return { ip, lockKey };
}

/**
 * 登录成功：签发会话并回写 Cookie
 * @param {boolean} [remember] 勾选「记住登录状态」→ 会话有效期 30 天（否则 24 小时）
 * @param {string} [ip] 来源 IP；用于清除**该来源**的失败计数（SEC-02）
 */
function completeLogin(res, user, remember, ip) {
  security.loginLock.reset(loginLockKey(ip || '', user.username));
  const token = authSession.createSession(user, { remember: !!remember });
  res.setHeader('Set-Cookie', sessionCookie(token));
  statsStore.addLog({
    action: 'auth.login',
    detail: `用户「${user.username}」登录成功${remember ? '（已勾选记住登录状态，有效期 30 天）' : ''}`,
  });
  return res.json({ ok: true, user });
}

// 登录第一步：校验人机验证与密码；启用 Windows Hello 时返回挑战而不签发会话
router.post('/auth/login', async (req, res) => {
  try {
    const b = req.body || {};
    const username = String(b.username || '').trim();
    const password = String(b.password || '');

    const pre = precheckLogin(req, res, username);
    if (!pre) return;

    // 人机验证（服务端回源校验；关闭时直接放行，不引入任何额外校验/依赖）
    // token 从 body.captchaToken 取（前端由 reCAPTCHA/Turnstile 组件产出），不信任前端自带的结果。
    const cap = await captcha.verify({ token: b.captchaToken, remoteip: pre.ip }, configStore);
    if (!cap.passed) {
      statsStore.addLog({ action: 'auth.fail', level: 'warn', detail: `登录被人机验证拦截（原因：${cap.reason}，用户名：${username || '(空)'}）` });
      return res.status(403).json({ error: captcha.publicReason(cap.reason) });
    }
    if (cap.degraded) {
      statsStore.addLog({ action: 'auth.captcha.degraded', level: 'warn', detail: `人机验证服务异常已按降级策略放行（原因：${cap.reason}，用户名：${username}）` });
    }

    const user = await configStore.authenticateUser(username, password);
    if (!user) {
      const left = security.loginLock.fail(pre.lockKey);
      statsStore.addLog({ action: 'auth.fail', level: 'warn', detail: `登录失败（用户名：${username || '(空)'}）` });
      if (left > 0) return res.status(429).json({ error: `失败次数过多，账户已临时锁定，请 ${left} 秒后重试` });
      return res.status(401).json({ error: '用户名或密码错误' });
    }

    // 密码正确：若该用户启用了 Windows Hello，先不签发会话，要求第二步验签
    //
    // ⚠️ 必须用**原始用户记录**判断，不能用 authenticateUser 的返回值：
    //    后者是 userView（安全视图），不含 webauthn 字段，用它判断会恒为「未启用」，
    //    从而静默绕过整个 Windows Hello 二次验证 —— 这是一个高危的失效开放（fail-open）。
    const raw = configStore.findUserRawById(user.id);
    if (configStore.isWebauthnEnabled(raw)) {
      const ctx = webauthnContext(req);
      const challenge = webauthn.issueChallenge('login', { userId: user.id, username: user.username });
      statsStore.addLog({ action: 'auth.login.webauthn', detail: `用户「${user.username}」密码校验通过，等待 Windows Hello 验证` });
      return res.json({
        ok: false,
        webauthnRequired: true,
        challenge,
        rpId: ctx.rpId,
        timeout: webauthn.CHALLENGE_TTL_MS,
        username: user.username,
        // 第二步是独立请求，需把「记住登录状态」带给前端，由它原样回传
        remember: Boolean(b.remember),
        // 提示前端只允许该账户登记过的凭据（浏览器仍按 allowCredentials 过滤）
        credentialId: configStore.getWebauthn(raw).credentialId,
      });
    }

    return completeLogin(res, user, Boolean(b.remember), pre.ip);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// 登录第二步：校验 Windows Hello 断言，通过后签发会话
router.post('/auth/login/webauthn', (req, res) => {
  try {
    const b = req.body || {};
    const username = String(b.username || '').trim();

    const pre = precheckLogin(req, res, username);
    if (!pre) return;

    const raw = configStore.findUserRaw(username);
    if (!raw) {
      const left = security.loginLock.fail(pre.lockKey);
      statsStore.addLog({ action: 'auth.fail', level: 'warn', detail: `Windows Hello 登录失败：用户不存在（用户名：${username || '(空)'}）` });
      if (left > 0) return res.status(429).json({ error: `失败次数过多，账户已临时锁定，请 ${left} 秒后重试` });
      return res.status(401).json({ error: 'Windows Hello 验证失败，请重试' });
    }
    if (!configStore.isWebauthnEnabled(raw)) {
      return res.status(400).json({ error: '该账户未启用 Windows Hello，请使用密码登录' });
    }

    const cred = configStore.getWebauthn(raw);
    const ctx = webauthnContext(req);

    const r = webauthn.verifyAuthentication({
      clientDataJSON: b.clientDataJSON,
      authenticatorData: b.authenticatorData,
      signature: b.signature,
      rawId: b.rawId,
      expectedChallenge: String(b.challenge || ''),
      expectedUserId: raw.id, // SEC-11：挑战必须是为该账户签发的
      expectedOrigin: ctx.origin,
      rpId: ctx.rpId,
      publicKey: cred.publicKey,
      storedCredentialId: cred.credentialId,
      storedSignCount: cred.signCount,
    });

    if (!r.ok) {
      const left = security.loginLock.fail(pre.lockKey);
      statsStore.addLog({ action: 'auth.fail', level: 'warn', detail: `用户「${username}」Windows Hello 验证失败（${r.reason}）` });
      if (left > 0) return res.status(429).json({ error: `失败次数过多，账户已临时锁定，请 ${left} 秒后重试` });
      return res.status(401).json({ error: webauthn.publicReason(r.reason), reason: r.reason });
    }

    // 验签通过：更新签名计数（单调递增，供克隆检测）并签发会话
    const user = configStore.touchWebauthn(raw.id, r.signCount);
    statsStore.addLog({ action: 'auth.login.webauthn.ok', detail: `用户「${username}」Windows Hello 验证通过` });
    return completeLogin(res, user, Boolean(b.remember), pre.ip);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// 登出：销毁会话并清除 Cookie
router.post('/auth/logout', (req, res) => {
  const token = authSession.parseToken(req);
  const name = (req.authUser && req.authUser.username) || '';
  authSession.destroySession(token);
  res.setHeader('Set-Cookie', clearCookie());
  statsStore.addLog({ action: 'auth.logout', detail: `用户「${name}」登出` });
  res.json({ ok: true });
});

// 强制登出当前用户在所有设备上的会话（S11）
router.post('/auth/logout-all', (req, res) => {
  const u = req.authUser;
  const n = u ? authSession.destroyUserSessions(u.id) : 0;
  authSession.destroySession(authSession.parseToken(req));
  res.setHeader('Set-Cookie', clearCookie());
  statsStore.addLog({ action: 'auth.logout', level: 'warn', detail: `用户「${(u && u.username) || ''}」强制登出全部设备（${n} 个会话）` });
  res.json({ ok: true, sessions: n });
});

// 当前登录用户信息（匿名可访问：用于前端探测登录态与初始化状态）
//  - 已登录  -> { ok: true, user }
//  - 未初始化 -> { ok: true, user: null, initialized: false }（引导创建管理员）
//  - 未登录   -> { ok: true, user: null, initialized: true }
router.get('/auth/me', (req, res) => {
  const token = authSession.parseToken(req);
  const session = token ? authSession.getSession(token) : null;
  if (session) {
    // SEC-13：`session.user` 是**登录那一刻的快照**（含 role）。
    // 管理员把某人降权 / 删除后，旧快照会让前端继续按旧角色渲染到下次登录为止。
    // 接口层的鉴权早就用实时记录（所以不会真越权），这里让 UI 与真实权限对齐。
    // 用户已被删除则视为未登录 —— 会话必须立即失效。
    //
    // ⚠️ 用户 id 在 `session.user.id` 上，**没有** `session.userId` 这个字段。
    //    早期这里写成 `session.userId`，取值恒为 undefined → findUserRawById 返回 null
    //    → 判定"用户已不存在"→ 每次调用都销毁会话。表现为：登录后一刷新页面就掉线
    //    （刷新才会重新走 /auth/me）。已加测试护栏（tests/auth-session.test.js）。
    const raw = configStore.findUserRawById(session.user && session.user.id);
    if (!raw) {
      authSession.destroySession(token);
      const initialized = configStore.listUsers().length > 0;
      return res.json({ ok: true, user: null, initialized });
    }
    return res.json({ ok: true, user: configStore.userView(raw) });
  }
  const initialized = configStore.listUsers().length > 0;
  res.json({ ok: true, user: null, initialized });
});

// 初始化首个管理员（仅当系统尚无任何用户时允许；之后一律拒绝）
//
// SEC-13：必须加**进程内互斥**。旧实现只检查 `listUsers().length > 0`，
// 而检查与写入之间隔着一次异步/较慢的 scrypt，两个并发请求可能同时通过检查、
// 各自创建一个管理员（新建实例的抢先初始化窗口）。另加 IP 限流，
// 避免被用来反复触发代价较高的口令哈希计算（SEC-05 同类风险）。
let initInFlight = false;
router.post('/auth/init', async (req, res) => {
  try {
    const ip = security.clientIp(req) || 'unknown';
    const limited = security.initLimiter(ip);
    if (!limited.ok) {
      return res.status(429).json({ error: `初始化尝试过于频繁，请 ${limited.retryAfter} 秒后重试` });
    }
    if (configStore.listUsers().length > 0) {
      return res.status(409).json({ error: '系统已初始化，请使用已有账户登录' });
    }
    if (initInFlight) {
      return res.status(409).json({ error: '系统正在初始化，请稍后重试' });
    }
    initInFlight = true;
    try {
      // 进入临界区后再检查一次：消除「检查 → 写入」之间的竞态窗口
      if (configStore.listUsers().length > 0) {
        return res.status(409).json({ error: '系统已初始化，请使用已有账户登录' });
      }
      const b = req.body || {};
      if (b.confirmPassword !== undefined && String(b.confirmPassword) !== String(b.password || '')) {
        return res.status(400).json({ error: '两次输入的密码不一致' });
      }
      const user = await configStore.addUser({ username: b.username, password: b.password, role: 'admin', permissions: {} });
      const token = authSession.createSession(user);
      res.setHeader('Set-Cookie', sessionCookie(token));
      statsStore.addLog({ action: 'auth.init', detail: `系统初始化，创建管理员「${user.username}」` });
      res.json({ ok: true, user });
    } finally {
      initInFlight = false;
    }
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

module.exports = router;
// SEC-02：暴露锁定键构造函数，供护栏测试直接断言「不同 IP 互不影响」
module.exports.loginLockKey = loginLockKey;
