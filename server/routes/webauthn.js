/**
 * 路由：Windows Hello（WebAuthn）凭据管理
 *
 * 功能边界：
 *  - 注册：登录用户为自己的账户登记 Windows Hello 凭据（**需先验证当前密码**）
 *  - 关闭：清除凭据并停用（**同样需验证当前密码**，防止会话被劫持后关闭二次验证）
 *  - 管理员可为其他用户关闭（例如用户换了设备又无法登录时的救济通道）
 *
 * 与验证码共存：本模块与 reCAPTCHA / Turnstile **互不干扰** ——
 *  验证码在登录第一步（密码校验前）由 captcha.js 独立处理；
 *  Windows Hello 在登录第二步（密码校验通过后）由 auth.js 处理。
 *  两者是串联关系而非替代关系，同时开启时都会各自生效。
 *
 * 安全约定：
 *  - 公钥 / 凭据 ID 绝不下发前端；前端只拿到 `webauthnEnabled` 布尔值与随机挑战
 *  - 注册与关闭均要求当前密码，避免仅凭会话即可篡改二次验证配置
 */
const { express, security, configStore, statsStore, webauthn } = require('./_context');
const { webauthnContext, sendError, requireAdmin } = require('./_shared');

const router = express.Router();

/** 从会话中取当前用户（本模块所有接口都需要登录，由 index.js 全局鉴权保证） */
function currentUser(req) {
  return req.authUser || null;
}

/**
 * 注册选项：生成挑战并返回给前端调用 `navigator.credentials.create`。
 * 需要 `pubKeyCredParams` 只声明 ES256 —— 与本系统服务端支持的能力严格一致，
 * 避免浏览器挑了一个我们验不了的算法（如 RS256）导致注册后无法登录。
 */
router.post('/webauthn/register/options', async (req, res) => {
  try {
    const me = currentUser(req);
    if (!me) return res.status(401).json({ error: '请先登录' });

    // SEC-05：本端点会做一次口令哈希校验，旧实现无任何限流 ——
    // 仅凭一个被盗会话即可反复触发以阻塞事件循环。这里按 IP 限流。
    const ip = security.clientIp(req) || 'unknown';
    const rl = security.passwordLimiter('webauthn:' + ip);
    if (!rl.ok) {
      res.setHeader('Retry-After', String(rl.retryAfter));
      return res.status(429).json({ error: `操作过于频繁，请 ${rl.retryAfter} 秒后重试` });
    }

    // 需验证当前密码：防止会话被窃取后，攻击者直接注册自己的 Hello 凭据
    const cfgUser = configStore.findUserRawById(me.id);
    if (!cfgUser) return res.status(404).json({ error: '用户不存在' });
    const pwd = String((req.body || {}).password || '');
    if (!(await configStore.verifyUserPassword(me.id, pwd))) {
      statsStore.addLog({ action: 'webauthn.register.fail', level: 'warn', detail: `用户「${me.username}」开启 Windows Hello 时密码校验失败` });
      // R8-12：这是**当前密码不正确**，会话完全有效，因此必须是 403 而不是 401。
      // 前端 api.js 把任意 401 统一派发为 `auth-required`（「会话过期」）→ 用户
      // 只是手误打错密码，却被踢回登录页、弹窗内容丢失、提示文案还是错的。
      return res.status(403).json({ error: '密码不正确，无法开启 Windows Hello' });
    }

    const ctx = webauthnContext(req);
    const challenge = webauthn.issueChallenge('register', { userId: me.id, username: me.username });

    // user.id 必须是稳定且不泄露隐私的字节串（这里用用户 id 的 UTF-8 编码）
    res.json({
      challenge,
      rp: { id: ctx.rpId, name: ctx.rpName },
      user: { id: webauthn.base64url(Buffer.from(String(me.id), 'utf8')), name: me.username, displayName: me.username },
      pubKeyCredParams: [{ type: 'public-key', alg: webauthn.COSE_ALG_ES256 }],
      timeout: webauthn.CHALLENGE_TTL_MS,
      attestation: 'none',
      authenticatorSelection: {
        // 平台验证器 = 本机 Windows Hello；residentKey 非必需，降低兼容门槛
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        residentKey: 'discouraged',
      },
      excludeCredentials: [],
    });
  } catch (e) {
    sendError(res, e);
  }
});

/**
 * 注册验证：校验 attestation，保存公钥并启用。
 */
router.post('/webauthn/register/verify', (req, res) => {
  try {
    const me = currentUser(req);
    if (!me) return res.status(401).json({ error: '请先登录' });
    const b = req.body || {};
    const ctx = webauthnContext(req);

    const r = webauthn.verifyRegistration({
      clientDataJSON: b.clientDataJSON,
      attestationObject: b.attestationObject,
      rawId: b.rawId,
      expectedChallenge: String(b.challenge || ''),
      expectedOrigin: ctx.origin,
      rpId: ctx.rpId,
    });
    if (!r.ok) {
      statsStore.addLog({ action: 'webauthn.register.fail', level: 'warn', detail: `用户「${me.username}」Windows Hello 注册校验失败（${r.reason}）` });
      return res.status(400).json({ error: webauthn.publicReason(r.reason), reason: r.reason });
    }

    const user = configStore.setUserWebauthn(me.id, {
      credentialId: r.credentialId,
      publicKey: r.publicKey,
      signCount: r.signCount,
      aaguid: r.aaguid,
      fmt: r.fmt,
    });
    statsStore.addLog({ action: 'webauthn.register', detail: `用户「${me.username}」已启用 Windows Hello 登录验证` });
    res.json({ ok: true, user });
  } catch (e) {
    sendError(res, e);
  }
});

/**
 * 关闭 Windows Hello：清除凭据。需验证当前密码。
 */
router.post('/webauthn/disable', async (req, res) => {
  try {
    const me = currentUser(req);
    if (!me) return res.status(401).json({ error: '请先登录' });
    // SEC-05：同样按 IP 限流（同为口令校验入口）
    const ip = security.clientIp(req) || 'unknown';
    const rl = security.passwordLimiter('webauthn:' + ip);
    if (!rl.ok) {
      res.setHeader('Retry-After', String(rl.retryAfter));
      return res.status(429).json({ error: `操作过于频繁，请 ${rl.retryAfter} 秒后重试` });
    }
    const pwd = String((req.body || {}).password || '');
    if (!(await configStore.verifyUserPassword(me.id, pwd))) {
      return res.status(403).json({ error: '密码不正确，无法关闭 Windows Hello' }); // R8-12：语义同 register
    }
    const user = configStore.clearUserWebauthn(me.id);
    webauthn.clearChallengesForUser(me.id);
    statsStore.addLog({ action: 'webauthn.disable', level: 'warn', detail: `用户「${me.username}」已关闭 Windows Hello 登录验证` });
    res.json({ ok: true, user });
  } catch (e) {
    sendError(res, e);
  }
});

/**
 * 管理员为指定用户关闭 Windows Hello（救济通道）。
 *
 * 场景：用户更换设备 / 重装系统后凭据失效且无法完成验证，管理员需代为关闭，
 * 否则该账户将永久无法登录。与「重置密码」同级的运维能力，因此要求管理员权限。
 */
router.post('/users/:id/webauthn/disable', requireAdmin, (req, res) => {
  try {
    const target = configStore.getUserById(req.params.id);
    if (!target) return res.status(404).json({ error: '用户不存在' });
    const user = configStore.clearUserWebauthn(target.id);
    webauthn.clearChallengesForUser(target.id);
    statsStore.addLog({
      action: 'webauthn.disable', level: 'warn',
      detail: `管理员「${req.authUser.username}」关闭了用户「${target.username}」的 Windows Hello 验证`,
    });
    res.json({ ok: true, user });
  } catch (e) {
    sendError(res, e);
  }
});

module.exports = router;
