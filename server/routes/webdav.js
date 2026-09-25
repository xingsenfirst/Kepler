/**
 * 路由：WebDAV 服务设置（开关 / 账户 CRUD / 明文密码读取）
 *  — 全部接口仅管理员（/webdav/accounts/:id/password 返回明文密码，务必保持管理员门槛）
 */
const { express, configStore, statsStore, webdav, security } = require('./_context');
const { requireAdmin } = require('./_shared');

const router = express.Router();

/** 组装返回给前端的 WebDAV 视图（含服务器地址与运行状态） */
function webdavView() {
  const w = configStore.getWebdav();
  return Object.assign({}, w, {
    mount: webdav.MOUNT + '/',
    port: webdav.DEFAULT_PORT,
    serverUrl: webdav.serverUrl(),
    running: webdav.isRunning(),
  });
}

// 查看 WebDAV 开关 / 账户列表（不含明文密码）/ 服务器地址 / 运行状态（仅管理员）
router.get('/webdav', requireAdmin, (req, res) => {
  res.json(webdavView());
});

// 启用 / 停用 WebDAV（停用后立即关闭 HTTPS 端口；仅管理员）
router.put('/webdav/enabled', requireAdmin, async (req, res) => {
  try {
    const enabled = Boolean((req.body || {}).enabled);
    if (enabled && !configStore.getWebdav().accounts.length) {
      return res.status(400).json({ error: '请先创建至少一个 WebDAV 账户，再启用服务' });
    }
    configStore.setWebdavEnabled(enabled);
    await webdav.apply();
    statsStore.addLog({ action: 'webdav.toggle', level: 'warn', detail: `${enabled ? '启用' : '停用'} WebDAV 服务（HTTPS :${webdav.DEFAULT_PORT}）` });
    res.json(webdavView());
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// 新增账户（服务端再次校验确认密码一致性；仅管理员）
router.post('/webdav/accounts', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    if (b.confirmPassword !== undefined && String(b.confirmPassword) !== String(b.password || '')) {
      return res.status(400).json({ error: '两次输入的密码不一致' });
    }
    const acc = configStore.addWebdavAccount(b);
    statsStore.addLog({ action: 'webdav.account', level: 'info', detail: `新增 WebDAV 账户「${acc.appName}」（${acc.username}）` });
    await webdav.apply(); // 开关已开时新账户即时生效
    res.json(Object.assign({ ok: true, account: acc }, webdavView()));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// 编辑账户（应用名称 / 用户名；密码留空表示不修改；仅管理员）
router.put('/webdav/accounts/:id', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    if (b.password !== undefined && b.password !== '' && b.confirmPassword !== undefined &&
      String(b.confirmPassword) !== String(b.password)) {
      return res.status(400).json({ error: '两次输入的密码不一致' });
    }
    const patch = {};
    if (b.appName !== undefined) patch.appName = b.appName;
    if (b.username !== undefined) patch.username = b.username;
    if (b.password !== undefined && b.password !== '') patch.password = b.password;
    const acc = configStore.updateWebdavAccount(req.params.id, patch);
    statsStore.addLog({ action: 'webdav.account', level: 'info', detail: `修改 WebDAV 账户「${acc.appName}」` });
    await webdav.apply();
    res.json(Object.assign({ ok: true, account: acc }, webdavView()));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// 删除账户（仅管理员）
router.delete('/webdav/accounts/:id', requireAdmin, async (req, res) => {
  try {
    const before = configStore.getWebdav();
    const target = before.accounts.find((a) => a.id === req.params.id);
    if (!configStore.removeWebdavAccount(req.params.id)) return res.status(404).json({ error: '账户不存在' });
    statsStore.addLog({ action: 'webdav.account', level: 'warn', detail: `删除 WebDAV 账户「${target ? target.appName : req.params.id}」` });
    // 最后一个账户被删除时，自动停用服务并关闭端口
    if (!configStore.getWebdav().accounts.length && configStore.getWebdav().enabled) {
      configStore.setWebdavEnabled(false);
    }
    await webdav.apply();
    res.json(Object.assign({ ok: true }, webdavView()));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

/**
 * 查看账户明文密码（用于列表中"显示密码"，走本地加密配置读取；仅管理员）
 *
 * SEC-12：WebDAV 用 Basic 认证，服务端必须能还原出口令原文，故无法像登录密码
 * 那样只存 scrypt 哈希 —— 这是**有意取舍**（已在 README 威胁模型章节文档化）。
 * 但该接口会**返回明文凭据**，一旦管理员账户被冒用或会话被劫持，
 * 攻击者可静默取走全部 WebDAV 口令且不留痕迹。因此这里补上：
 *   ① 每次揭示都写 **warn 级审计日志**（含操作者、账户名、来源 IP）；
 *   ② 对同一账户的揭示频率做限流，抑制批量拖走。
 * 后续若要彻底收敛，可改为"单次性揭示 + 强制二次确认"。
 */
router.get('/webdav/accounts/:id/password', requireAdmin, (req, res) => {
  const ip = security.clientIp(req) || 'unknown';
  const rl = security.webdavRevealLimiter(`${req.authUser && req.authUser.id}:${ip}`);
  if (!rl.ok) {
    return res.status(429).json({ error: `查看密码过于频繁，请 ${rl.retryAfter} 秒后重试` });
  }

  const acc = configStore.revealWebdavPassword(req.params.id);
  if (!acc) return res.status(404).json({ error: '账户不存在' });

  statsStore.addLog({
    action: 'webdav.revealPassword',
    level: 'warn',
    detail: `管理员「${req.authUser ? req.authUser.username : '?'}」查看了 WebDAV 账户「${acc.username || acc.appName || acc.id}」的明文密码（IP：${ip}）`,
  });
  res.json({ ok: true, id: acc.id, password: acc.password });
});

module.exports = router;
