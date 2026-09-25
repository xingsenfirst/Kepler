/**
 * 路由：分享链接管理
 *  — 管理员可见/可管理全部链接；普通用户仅限自己创建的（shareStore.listFor / canManage）
 */
const { express, configStore, statsStore, shareStore, paymentProviders, paymentRules } = require('./_context');
const { getClient, p, normalizeKey, badRequest } = require('../cos');
const { roleOf, requireConfig, baseName } = require('./_shared');
const router = express.Router();

/** 当前支付能力快照（开关 + 凭证完整 + 可用渠道） */
function paySnapshot() {
  const stored = configStore.getPayment();
  return Object.assign({ enabled: stored.enabled }, paymentRules.snapshot(
    stored.platforms, paymentProviders.ORDER, (id) => paymentProviders.isConfigured(id, stored.platforms[id]),
  ));
}

/**
 * 付费配置落盘前的提示（不是错误）。
 *
 * 付费是**分享者的意图**，支付渠道是否就绪是**系统当前状态**，两者解耦：
 * 即便支付被停用、或没有可用渠道，也允许保存配置 —— 否则管理员调一次开关
 * 就会把所有链接的付费配置冲掉，与「停用后自动免费、启用后按原配置恢复」相悖。
 * 这里只返回一句提示，由前端以警告形式告知。
 */
function paidWarning(paid) {
  if (!paid || !paid.required) return '';
  try {
    const snap = paySnapshot();
    if (!snap.enabled) return '支付功能当前处于停用状态，付费配置已保存，但该链接暂时按免费下载处理。';
    if (!snap.available.length) return '当前没有可用的支付渠道（需渠道已启用且凭证填写完整），付费配置已保存，但该链接暂时按免费下载处理。';
  } catch (e) { /* 支付模块异常不应阻断链接保存 */ }
  return '';
}

/** 校验并规范化链接参数，返回 {expiresHours, maxDownloads, password} 或抛出 badRequest */
function parseLinkParams(b) {
  const out = {};
  if (b.expiresHours !== undefined) {
    if (b.expiresHours === null || b.expiresHours === '' || Number(b.expiresHours) === 0) {
      out.expiresHours = null; // 永久有效
    } else {
      const h = Number(b.expiresHours);
      if (!Number.isFinite(h) || h <= 0) throw badRequest('有效期必须为正数（小时），或留空表示永久有效');
      if (h > 24 * 3650) throw badRequest('有效期最长 10 年');
      out.expiresHours = h;
    }
  }
  if (b.maxDownloads !== undefined) {
    const n = Number(b.maxDownloads);
    if (!Number.isInteger(n) || n < 0) throw badRequest('下载次数必须为不小于 0 的整数（0 表示不限制）');
    if (n > 1e9) throw badRequest('下载次数数值过大');
    out.maxDownloads = n;
  }
  if (b.password !== undefined) {
    if (b.password === null || b.password === '') {
      out.password = null; // 未启用 / 清除密码
    } else {
      const pw = String(b.password);
      if (pw.length < 1 || pw.length > 64) throw badRequest('访问密码长度须为 1-64 个字符');
      out.password = pw;
    }
  }
  if (b.paid !== undefined) {
    // paid: null → 关闭付费下载；paid: { required, amount } → 设置（amount 单位为元）
    const p0 = b.paid && typeof b.paid === 'object' ? b.paid : {};
    const required = Boolean(p0.required);
    let amountFen = 0;
    if (p0.amount !== undefined && p0.amount !== null && p0.amount !== '') {
      const r = paymentRules.normalizeAmount(p0.amount);
      if (!r.ok) throw badRequest(r.message);
      amountFen = r.fen;
    }
    if (required && amountFen <= 0) {
      throw badRequest(`已开启「需付费下载」，请填写付费金额（最低 ${paymentRules.formatAmount(paymentRules.MIN_AMOUNT_FEN)} 元）`);
    }
    // required=false 时金额仍会保留，便于下次直接打开开关
    out.paid = { required: required && amountFen > 0, amountFen, currency: paymentRules.CURRENCY };
  }
  return out;
}

// 分享链接列表（管理员看全部；普通用户仅看自己创建的）
router.get('/links', (req, res) => {
  res.json({ links: shareStore.listFor(roleOf(req), req.authUser && req.authUser.username) });
});

// 创建链接（对目标对象做 head 校验并快照文件名/大小）
router.post('/links', async (req, res) => {
  try {
    const cfg = requireConfig();
    const client = getClient(cfg);
    const b = req.body || {};
    const key = normalizeKey(String(b.path || ''));
    if (!key || key.endsWith('/')) return res.status(400).json({ error: '请选择一个文件（不支持分享文件夹）' });
    const params = parseLinkParams(b);

    const fileName = baseName(key);
    let size = 0;
    try {
      const head = await p(client, 'headObject', { Bucket: cfg.bucket, Region: cfg.region, Key: key });
      size = Number(head.headers['content-length']) || 0;
    } catch (e) {
      return res.status(404).json({ error: '对象不存在或无权访问：' + key });
    }

    const link = await shareStore.create({
      key, bucket: cfg.bucket, region: cfg.region, fileName, size,
      expiresHours: params.expiresHours === undefined ? 24 * 7 : params.expiresHours,
      maxDownloads: params.maxDownloads === undefined ? 0 : params.maxDownloads,
      password: params.password === undefined ? null : params.password,
      paid: params.paid,
      createdBy: (req.authUser && req.authUser.username) || '',
    });
    statsStore.addLog({
      action: 'share.create',
      detail: `创建分享链接 ${link.id}（${key}）${link.paid && link.paid.required ? `，需付费 ${paymentRules.formatAmount(link.paid.amountFen)} 元` : ''}`,
    });
    res.json(Object.assign({ ok: true }, link, { warn: paidWarning(link.paid) }));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// 修改链接（有效期 / 次数 / 密码 / 重置计数；普通用户仅限自己创建的）
router.put('/links/:id', async (req, res) => {
  try {
    const target = shareStore.get(req.params.id);
    if (!target) return res.status(404).json({ error: '链接不存在' });
    if (!shareStore.canManage(target, roleOf(req), req.authUser && req.authUser.username)) {
      return res.status(403).json({ error: '无权修改该分享链接' });
    }
    const params = parseLinkParams(req.body || {});
    if (req.body && req.body.resetCount !== undefined && typeof req.body.resetCount !== 'boolean') {
      throw badRequest('resetCount 必须为布尔值');
    }
    const link = await shareStore.update(req.params.id, Object.assign({}, params, {
      resetCount: Boolean(req.body && req.body.resetCount),
    }));
    statsStore.addLog({
      action: 'share.update',
      detail: `修改分享链接 ${req.params.id}${params.paid ? `，付费下载：${link.paid && link.paid.required ? `需付 ${paymentRules.formatAmount(link.paid.amountFen)} 元` : '关闭'}` : ''}`,
    });
    res.json(Object.assign({ ok: true }, link, { warn: paidWarning(link.paid) }));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// 删除链接（仅删除本地分享记录，不影响云端对象；普通用户仅限自己创建的）
router.delete('/links/:id', (req, res) => {
  const target = shareStore.get(req.params.id);
  if (!target) return res.status(404).json({ error: '链接不存在' });
  if (!shareStore.canManage(target, roleOf(req), req.authUser && req.authUser.username)) {
    return res.status(403).json({ error: '无权删除该分享链接' });
  }
  if (!shareStore.remove(req.params.id)) return res.status(404).json({ error: '链接不存在' });
  statsStore.addLog({ action: 'share.delete', detail: '删除分享链接 ' + req.params.id, level: 'warn' });
  res.json({ ok: true });
});

module.exports = router;
