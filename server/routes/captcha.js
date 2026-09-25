/**
 * 路由：验证码服务配置（公开最小视图 + 管理员完整配置）
 *  — secretKey 任何情况下都不出服务端（仅返回 hasSecret 布尔值）
 */
const { express, configStore, statsStore, captcha } = require('./_context');
const { requireAdmin } = require('./_shared');

const router = express.Router();

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
  res.json({
    enabled: stored.enabled,
    provider: stored.provider,
    siteKey: stored.siteKey,
    hasSecret: Boolean(stored.secretKey),
    timeoutMs: stored.timeoutMs,
    onError: stored.onError,
    envOverridden: envUsed,
    // 登录页实际生效视图（含环境变量合并结果，供管理员核对）
    effective: captcha.publicConfig(configStore),
  });
});

// 保存验证码配置（仅管理员；secretKey 留空 = 保持不变）
router.put('/captcha/config', requireAdmin, (req, res) => {
  try {
    const b = req.body || {};
    const patch = {};
    if (b.enabled !== undefined) patch.enabled = !!b.enabled;
    if (b.provider !== undefined) {
      if (!['recaptcha', 'turnstile'].includes(b.provider)) {
        return res.status(400).json({ error: '验证码服务商仅支持 recaptcha 或 turnstile' });
      }
      patch.provider = b.provider;
    }
    if (b.siteKey !== undefined) patch.siteKey = String(b.siteKey || '').trim();
    if (b.secretKey !== undefined) patch.secretKey = String(b.secretKey || '');
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
    statsStore.addLog({
      action: 'config.save', level: 'info',
      detail: `管理员「${req.authUser.username}」更新验证码配置（enabled=${saved.enabled}，provider=${saved.provider}，onError=${saved.onError}）`,
    });
    res.json({
      ok: true,
      enabled: saved.enabled, provider: saved.provider, siteKey: saved.siteKey,
      hasSecret: Boolean(saved.secretKey), timeoutMs: saved.timeoutMs, onError: saved.onError,
      effective: captcha.publicConfig(configStore),
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

module.exports = router;
