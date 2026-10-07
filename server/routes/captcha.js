/**
 * 路由：验证码服务配置（公开最小视图 + 管理员完整配置）
 *  — secretKey 任何情况下都不出服务端（仅返回 hasSecret 布尔值）
 *
 * R41：两种服务商（reCAPTCHA / Turnstile）的凭证**各自独立保存**，
 * 管理员可以两套都填好，再用 `provider` 选择登录页实际使用哪一套。
 */
const { express, configStore, statsStore, captcha } = require('./_context');
const { requireAdmin } = require('./_shared');

const router = express.Router();

/**
 * 把内部配置裁剪成「两套凭证各自的公开视图」。
 * `hasSecret` 只回布尔值 —— 明文密钥永不出服务端。
 * @param {object} stored configStore.getCaptcha() 的返回值（含明文与 providers）
 */
function providersView(stored) {
  const src = (stored && stored.providers) || {};
  const out = {};
  for (const name of configStore.CAPTCHA_PROVIDERS) {
    const e = (src[name] && typeof src[name] === 'object') ? src[name] : {};
    out[name] = { siteKey: String(e.siteKey || ''), hasSecret: Boolean(e.secretKey) };
  }
  return out;
}

// 公开：登录页渲染验证码组件所需的最小配置（匿名可访问，见 index.js PUBLIC_API 白名单）
// 仅返回 enabled/provider/siteKey/available；secretKey 任何情况下都不出服务端。
router.get('/captcha/public', (req, res) => {
  res.json(captcha.publicConfig(configStore));
});

// 管理端视图：完整配置（secretKey 掩码为布尔值，不回传明文；附环境变量覆盖提示）
router.get('/captcha/config', requireAdmin, (req, res) => {
  const stored = configStore.getCaptcha();
  const envUsed = {};
  envUsed.enabled = process.env.CAPTCHA_ENABLED === 'true' || process.env.CAPTCHA_ENABLED === 'false';
  envUsed.provider = Boolean(process.env.CAPTCHA_PROVIDER);
  envUsed.siteKey = Boolean(process.env.CAPTCHA_SITE_KEY);
  envUsed.secretKey = Boolean(process.env.CAPTCHA_SECRET_KEY);
  const providers = providersView(stored);
  const sel = providers[stored.provider] || { siteKey: '', hasSecret: false };
  res.json({
    enabled: stored.enabled,
    provider: stored.provider,
    // 两套凭证各自的视图（界面据此分别回填）
    providers,
    // 顶层 siteKey/hasSecret 保留为「当前选中那一套」的派生值，兼容旧前端与旧调用方
    siteKey: sel.siteKey,
    hasSecret: sel.hasSecret,
    timeoutMs: stored.timeoutMs,
    onError: stored.onError,
    envOverridden: envUsed,
    // 登录页实际生效视图（含环境变量合并结果，供管理员核对）
    effective: captcha.publicConfig(configStore),
  });
});

/** 校验并规范化单个服务商提交的凭证块（返回 null = 该块无需改动） */
function parseProviderPatch(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const out = {};
  if (entry.siteKey !== undefined) out.siteKey = String(entry.siteKey || '').trim();
  // secretKey：'' = 保持不变；null = 显式清除；其它 = 设置为新值
  if (entry.secretKey === null) out.secretKey = null;
  else if (typeof entry.secretKey === 'string' && entry.secretKey !== '') out.secretKey = entry.secretKey;
  return out;
}

// 保存验证码配置（仅管理员；secretKey 留空 = 保持不变）
router.put('/captcha/config', requireAdmin, (req, res) => {
  try {
    const b = req.body || {};
    const patch = {};
    if (b.enabled !== undefined) patch.enabled = !!b.enabled;
    if (b.provider !== undefined) {
      if (!configStore.CAPTCHA_PROVIDERS.includes(b.provider)) {
        return res.status(400).json({ error: '验证码服务商仅支持 recaptcha 或 turnstile' });
      }
      patch.provider = b.provider;
    }
    // 两套凭证：逐服务商独立应用（未提交的服务商原样保留）
    if (b.providers !== undefined) {
      if (!b.providers || typeof b.providers !== 'object') {
        return res.status(400).json({ error: 'providers 须为对象（形如 {"recaptcha":{"siteKey":"…"}}）' });
      }
      const clean = {};
      for (const name of Object.keys(b.providers)) {
        if (!configStore.CAPTCHA_PROVIDERS.includes(name)) {
          return res.status(400).json({ error: `未知的验证码服务商：${name}` });
        }
        const one = parseProviderPatch(b.providers[name]);
        if (one) clean[name] = one;
      }
      patch.providers = clean;
    }
    // 兼容旧的扁平形态：落到 provider 指向的那一套（providers 未提交时才用）
    if (b.siteKey !== undefined && b.providers === undefined) patch.siteKey = String(b.siteKey || '').trim();
    if (b.secretKey !== undefined && b.providers === undefined) {
      patch.secretKey = b.secretKey === null ? null : String(b.secretKey || '');
    }
    if (b.timeoutMs !== undefined) {
      const t = Number(b.timeoutMs);
      if (!Number.isFinite(t) || t < 1000 || t > 15000) {
        return res.status(400).json({ error: '校验超时须为 1000–15000 毫秒' });
      }
      patch.timeoutMs = Math.floor(t);
    }
    if (b.onError !== undefined) {
      if (!['block', 'degrade'].includes(b.onError)) {
        return res.status(400).json({ error: '失败策略仅支持 block（拦截）或 degrade（降级放行）' });
      }
      patch.onError = b.onError;
    }
    const saved = configStore.saveCaptcha(patch);
    const providers = providersView(saved);
    const sel = providers[saved.provider] || { siteKey: '', hasSecret: false };
    statsStore.addLog({
      action: 'config.save', level: 'info',
      detail: `管理员「${req.authUser.username}」更新验证码配置（enabled=${saved.enabled}，provider=${saved.provider}，onError=${saved.onError}）`,
    });
    res.json({
      ok: true,
      enabled: saved.enabled, provider: saved.provider,
      providers,
      siteKey: sel.siteKey, hasSecret: sel.hasSecret,
      timeoutMs: saved.timeoutMs, onError: saved.onError,
      effective: captcha.publicConfig(configStore),
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

module.exports = router;
