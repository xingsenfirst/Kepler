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
 * 登录失败锁定的键（SEC-02 / R27-08）
 *
 * 旧实现**只按用户名**锁定：任何人只要知道管理员的用户名，连着输错 5 次密码
 * 就能把管理员本人锁在外面最长 30 分钟 —— 锁定被反向用作 DoS 工具，
 * 而且攻击者自己只受"每 IP 每分钟 10 次"的限流约束，成本极低。
 *
 * 锁定键必须带上**攻击者控制不了**的维度（来源 IP）：这样失败计数只对
 * 「这个 IP 试探这个账户」累积，管理员从自己的机器照常登录。
 * 分布式暴破由 loginLimiter（按 IP 限流）负责 —— 限流键才是纯 IP。
 *
 * R27-08：用户名必须**规范化后再入键**。`config-store.authenticateUser()` 是按
 * `toLowerCase()` 匹配的（大小写不敏感），而这里原样拼提交值、`completeLogin()`
 * 却用库里的规范名去清零 —— 两个后果：① 攻击者轮换大小写（`admin`/`Admin`/`ADMIN`…）
 * 就能让每个拼写各拿 5 次预算与独立的指数锁定，账户锁定形同虚设（只剩按 IP 的
 * 每秒级限流）；② 以不同大小写成功登录永远清不掉那个键的计数，它会一路升级到上限。
 */
function loginLockKey(ip, username) {
  return `${ip}|${String(username == null ? '' : username).trim().toLowerCase()}`;
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

    /**
     * R33：账户封禁。
     *
     * 位置很关键 —— 必须**在密码校验通过之后**：若在校验之前按用户名判封禁，
     * 登录接口的响应差异本身就成了**用户名枚举**通道（"存在且被封"与"不存在"
     * 报文不同），而这一步之前的失败分支（`401 用户名或密码错误` + 空转哈希）
     * 正是为了抹平这种差异而存在的。
     *
     * 顺序：先验密码 → 再看封禁 → 最后才决定走 Windows Hello 还是直接签发会话。
     * 若把封禁判定放到 Hello 分支之后，被封者会被先要求做一次本机验证才被告知
     * 「你已被封禁」，既多余又容易被误解为"验证失败"。
     *
     * 响应刻意带上 `reason` / `until`，供登录页显示封禁原因与解封时间（需求 5）。
     * 用 403（凭据没错，但无权进入）而非 401，并且**不**计入失败锁定 ——
     * 凭据正确却因封禁被拒不该把账户推向锁定，否则管理员刚解封又进不来。
     */
    const raw = configStore.findUserRawById(user.id);
    const ban = configStore.banInfo(raw);
    if (ban.active) {
      statsStore.addLog({
        action: 'auth.fail', level: 'warn',
        detail: `被封禁的账户尝试登录（用户名：${user.username}；解封时间：${ban.until || '永久'}）`,
      });
      return res.status(403).json({
        error: '该账户已被封禁',
        banned: true,
        reason: ban.reason,
        until: ban.until,
      });
    }

    // 密码正确：若该用户启用了 Windows Hello，先不签发会话，要求第二步验签
    //
    // ⚠️ 必须用**原始用户记录**判断，不能用 authenticateUser 的返回值：
    //    后者是 userView（安全视图），不含 webauthn 字段，用它判断会恒为「未启用」，
    //    从而静默绕过整个 Windows Hello 二次验证 —— 这是一个高危的失效开放（fail-open）。
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

    /**
     * R24-02：**在与用户名无关的位置先判宿主机是否可信**。
     *
     * 若把这个判断放到 `findUserRaw` / `isWebauthnEnabled` 之后，「用户存在**且**启用了
     * Windows Hello」会回 403、其余用户名回 401 —— 等于给这个匿名可达的端点又开一个
     * 用户名 oracle（R21-05 / R22-01 刚把三条分支收敛成同形，不能从旁边再漏一条）。
     * 因此在这里一次性拦下，三支的 401 同形语义保持不变。
     */
    let ctx;
    try {
      ctx = webauthnContext(req);
    } catch (e) {
      statsStore.addLog({
        action: 'auth.fail', level: 'warn',
        detail: `Windows Hello 拒绝：${e.message}（Host 不属本站，已按 fail-closed 处理）`,
      });
      return res.status(e.status || 403).json({ error: e.message });
    }

    /**
     * R21-05：三条「进不去」的分支必须**完全同形**（同状态码 + 同文案 + 同计数）。
     *
     * 旧实现里「用户不存在」回 `401 Windows Hello 验证失败，请重试`，而
     * 「用户存在但未启用 Windows Hello」回 `400 该账户未启用 Windows Hello，请使用密码登录`
     * —— 状态码与文案都不同，于是本端点（在 `PUBLIC_API` 白名单内，匿名可达）成了一个
     * **不需要密码的用户名 oracle**：先用它枚举出有效用户名，再拿这些用户名去撞库 / 社工。
     *
     * 登录第一步 `/auth/login` 在这点上是正确的（用户不存在与密码错误返回同一条 401 文案），
     * 这里向它对齐。`precheckLogin` 的 IP 级限流与 `ip|username` 冻结照常生效，
     * 枚举速率与撞库速率完全相同（本端点的限流此前对「未启用」分支是**不计数**的，
     * 等于给枚举留了一条不限速的支路）。
     */
    const authFail = (detail) => {
      const left = security.loginLock.fail(pre.lockKey);
      statsStore.addLog({ action: 'auth.fail', level: 'warn', detail: `Windows Hello 登录失败：${detail}（用户名：${username || '(空)'}）` });
      if (left > 0) return res.status(429).json({ error: `失败次数过多，账户已临时锁定，请 ${left} 秒后重试` });
      return res.status(401).json({ error: 'Windows Hello 验证失败，请重试' });
    };

    const raw = configStore.findUserRaw(username);
    if (!raw) return authFail('用户不存在');
    if (!configStore.isWebauthnEnabled(raw)) return authFail('该账户未启用 Windows Hello');

    /**
     * R33：封禁判定在这一支必须**与上面两支完全同形**（都走 `authFail`），
     * 绝不能回一条带封禁原因的 403 —— 本端点在 `PUBLIC_API` 白名单内、匿名可达，
     * 那样等于重新开一个「该用户名存在**且**被封禁」的 oracle，把 R21-05 / R22-01
     * 刚刚收敛掉的三支同形又漏掉一条。
     *
     * 走到这里意味着挑战是在**封禁之前**签发的（否则第一步已经 403 并附上原因），
     * 属于极窄的时序窗口；被封者想看原因，回第一步即可。
     */
    if (configStore.banInfo(raw).active) return authFail('该账户已被封禁');

    const cred = configStore.getWebauthn(raw);
    // R24-02：`ctx` 已在入口处解析（那时与用户名无关），此处直接复用 —— 不要再解析一次

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
      /**
       * R22-01：这一支**必须与前两支同形** —— 它是 R21-05 收敛时唯一漏掉的一支。
       *
       * 旧实现回 `401 { error: webauthn.publicReason(r.reason), reason: r.reason }`：
       * 多了一个 `reason` 键、文案也换成了「挑战缺失 / 挑战已过期 / 签名校验失败 …」
       * 这类**细节文案**，与 `authFail()` 的固定 `401 { error: 'Windows Hello 验证失败，请重试' }`
       * 在**状态码之外的文案与键集两处都不同形**。
       *
       * 而这一支的**可达前提**恰好是「用户名存在 **且** 已启用 Windows Hello」——
       * 攻击者提交 `{ username }` 单字段（`b.challenge` 为空串即可）就能命中
       * `challenge_missing` 走完这一支，于是它成了一个「用户名是否存在且启用了二次验证」
       * 的匿名 oracle（通常指管理员账户），比 R21-05 修的「是否启用」更精确。
       *
       * `r.reason` 只进服务端日志（排查要它），**绝不进响应体** —— 同 R21-05 的纪律：
       * 「进不去」的所有分支对匿名者必须完全不可区分。
       */
      return authFail(`验签失败（${r.reason}）`);
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
