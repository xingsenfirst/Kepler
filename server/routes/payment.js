/**
 * 路由：支付平台配置（仅管理员）
 *
 * 本模块**只包含凭证配置、开关、合法性校验与订单管理**（列表 / 退款标记），
 * 不涉及任何下单 / 查单 / 网关回调等支付业务流程（后者在 share-routes.js 与 payment-gateway.js）。
 * 校验规则集中在 server/payment-providers.js，开关约束集中在 server/payment-rules.js，
 * 本文件只负责编排。
 *
 * 开关层级（对应需求一 / 二 / 四）：
 *   总开关   config.payment.enabled              —— 停用后所有付费链接自动转免费
 *   渠道开关 config.payment.platforms[id].enabled —— 各渠道独立，可任意组合
 *   约束     总开关为「启用」时，至少一个渠道开启（关闭最后一个会被拒绝）
 *
 * 安全约定：
 *  - 全部接口挂载 requireAdmin；
 *  - 敏感字段（密钥 / 证书 / Secret）任何情况下都不回传明文，只回传「是否已配置」；
 *  - 审计日志只记录"哪个平台、改了什么开关"，绝不记录字段值。
 */
const { express, configStore, statsStore, paymentProviders, paymentRules, paymentOrders, shareStore } = require('./_context');
const { requireAdmin } = require('./_shared');

const router = express.Router();

/** 审计：只记平台与动作，不记值（密钥明文一旦进日志就是永久泄露） */
function logChange(req, action, detail) {
  statsStore.addLog({
    action: `payment.${action}`,
    level: 'info',
    detail: `管理员「${req.authUser.username}」${detail}`,
  });
}

const allIds = () => paymentProviders.ORDER.slice();

/** 各渠道当前开关状态 */
function currentStates(stored) {
  return paymentRules.channelStates(stored.platforms, allIds());
}

/** 各渠道凭证是否已完整填写 */
function configuredMap(stored) {
  const m = {};
  for (const id of allIds()) m[id] = paymentProviders.isConfigured(id, stored.platforms[id]);
  return m;
}

/* ============================ 读取 ============================ */

/* ============================ 订单管理 ============================ */

/**
 * 订单列表（管理员）
 *
 * 文件名 / 对象键在创建订单时已**快照**进订单，因此分享链接被删除后，
 * 这里依然能回答"这笔钱是为什么付的"—— 只存 linkId 是做不到这点的。
 */
router.get('/payment/orders', requireAdmin, (req, res) => {
  try {
    const rows = paymentOrders.listAll().map((o) => {
      const link = shareStore.get(o.linkId); // 链接可能已被删除
      const p = paymentProviders.platform(o.platform);
      return Object.assign(paymentOrders.view(o), {
        fileName: o.fileName || (link ? link.fileName : ''),
        fileKey: o.fileKey || (link ? link.key : ''),
        // 链接是否已不存在：管理页据此把链接列显示为"已删除"，而不是一个点了 404 的死链
        linkExists: Boolean(link),
        linkUrl: '/s/' + o.linkId,
        platformName: (p && p.name) || o.platform,
      });
    });
    res.json({ orders: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * 标记订单为「已退款」（人工记账，非网关退款）。
 *
 * 本系统**不代持资金** —— 这笔钱从未经过本服务器，退款是在微信/支付宝/PayPal 后台
 * 手动完成的。这里只做一件事：把订单置为 `refunded`，让它的支付凭证失效，
 * 并从「已收」统计里扣除。因此没有也不需要任何网关调用。
 *
 * 只允许作用于 `paid`：其余状态的订单退无可退（钱还没进账 / 已经退过了）。
 */
router.post('/payment/orders/:id/refund', requireAdmin, (req, res) => {
  try {
    const target = paymentOrders.get(req.params.id);
    if (!target) return res.status(404).json({ error: '订单不存在' });
    if (target.status !== 'paid') {
      const why = target.status === 'refunded' ? '该订单已标记为已退款'
        : target.status === 'failed' ? '该订单未支付成功，无需退款'
          : '该订单尚未完成支付，无法退款';
      return res.status(400).json({ error: why });
    }
    const o = paymentOrders.markRefunded(req.params.id);
    statsStore.addLog({
      action: 'payment.refund', level: 'warn',
      detail: `管理员「${req.authUser.username}」将订单 ${o.id} 标记为已退款（¥${paymentRules.formatAmount(o.amountFen)}，原支付凭证已失效）`,
    });
    res.json({ ok: true, order: paymentOrders.view(o) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

/**
 * 读取全部平台的表单定义 + 已保存的配置（一次请求拿全，避免前端按平台轮询）
 */
router.get('/payment/config', requireAdmin, (req, res) => {
  try {
    const stored = configStore.getPayment();
    const states = currentStates(stored);
    const ready = configuredMap(stored);
    const settings = {};
    for (const p of paymentProviders.list()) {
      const view = paymentProviders.publicView(p.id, stored.platforms[p.id]);
      settings[p.id] = {
        values: view.values,
        configured: view.configured,
        complete: ready[p.id],
        enabled: !!states[p.id],
        available: !!states[p.id] && !!ready[p.id],
      };
    }
    res.json({
      enabled: stored.enabled,
      siteUrl: stored.siteUrl || '',
      platforms: paymentProviders.clientSchema(),
      settings,
      // 当前真正可用于收款的渠道（开关已开且凭证完整）—— 前端据此提示"待补全"
      availableChannels: paymentRules.availableChannels(states, ready),
      updatedAt: stored.updatedAt || '',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ============================ 总开关 ============================ */

/** 启用 / 停用支付功能（停用不影响任何已保存配置，仅让付费逻辑整体不生效） */
router.put('/payment/enabled', requireAdmin, (req, res) => {
  try {
    const on = Boolean(req.body && req.body.enabled);
    const stored = configStore.getPayment();
    const chk = paymentRules.checkGlobalToggle(on, currentStates(stored));
    if (!chk.ok) return res.status(400).json({ error: chk.message });

    const after = configStore.setPaymentEnabled(on);
    logChange(req, 'toggle', `${on ? '启用' : '停用'}支付功能`);
    res.json({
      ok: true,
      enabled: after.enabled,
      availableChannels: paymentRules.availableChannels(currentStates(after), configuredMap(after)),
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

/**
 * 站点对外地址 —— 支付网关回调与支付完成回跳的目标。
 *
 * 本机回环地址收不到公网回调，生产环境必须填对外可达的 https 地址；
 * 留空则按每次请求的 Host 兜底（仅适合本地调试）。
 */
router.put('/payment/site-url', requireAdmin, (req, res) => {
  try {
    const raw = String((req.body && req.body.siteUrl) || '').trim();
    let url = raw.replace(/\/+$/, '');
    if (url && !/^https?:\/\/[^\s]+$/i.test(url)) {
      return res.status(400).json({ error: '站点对外地址必须是 http(s):// 开头的完整地址' });
    }
    const after = configStore.setPaymentSiteUrl(url);
    logChange(req, 'site-url', url ? `将站点对外地址设为 ${url}` : '清除站点对外地址（改为按请求 Host 兜底）');
    res.json({ ok: true, siteUrl: after.siteUrl || '' });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

/* ============================ 渠道开关 ============================ */

/** 启用 / 停用某一支付渠道（总开关启用时不允许关闭最后一个） */
router.put('/payment/config/:platform/enabled', requireAdmin, (req, res) => {
  const id = req.params.platform;
  if (!paymentProviders.isKnown(id)) return res.status(404).json({ error: `未知的支付平台：${id}` });
  try {
    const on = Boolean(req.body && req.body.enabled);
    const stored = configStore.getPayment();
    const states = currentStates(stored);
    const chk = paymentRules.checkChannelToggle(states, id, on, stored.enabled);
    if (!chk.ok) return res.status(400).json({ error: chk.message });

    const after = configStore.setChannelEnabled(id, on);
    const p = paymentProviders.platform(id);
    logChange(req, 'channel', `${on ? '启用' : '停用'}支付渠道「${p.name}」`);
    res.json({
      ok: true,
      platform: id,
      enabled: !!currentStates(after)[id],
      available: !!currentStates(after)[id] && !!configuredMap(after)[id],
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

/* ============================ 凭证校验与保存 ============================ */

/**
 * 仅校验不保存（界面「校验」按钮）
 * 与保存走同一份 validate()，保证"先校验看到通过、点保存就一定通过"。
 */
router.post('/payment/config/:platform/validate', requireAdmin, (req, res) => {
  const id = req.params.platform;
  if (!paymentProviders.isKnown(id)) {
    return res.status(404).json({ error: `未知的支付平台：${id}` });
  }
  try {
    const stored = configStore.getPayment();
    // 敏感字段留空时沿用已保存的值参与校验，否则"已配置但未改动"会被误判为必填缺失
    const prev = stored.platforms[id] || {};
    const merged = paymentProviders.applySave(id, prev, req.body || {});
    const r = paymentProviders.validate(id, merged);
    res.json({ ok: r.ok, errors: r.errors });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** 保存某一平台的凭证（校验通过才落盘） */
router.put('/payment/config/:platform', requireAdmin, (req, res) => {
  const id = req.params.platform;
  if (!paymentProviders.isKnown(id)) {
    return res.status(404).json({ error: `未知的支付平台：${id}` });
  }
  try {
    const stored = configStore.getPayment();
    const prev = stored.platforms[id] || {};
    const patch = req.body && typeof req.body === 'object' ? req.body : {};

    // 全空提交 = 清空该平台配置（不报错）
    const merged = paymentProviders.applySave(id, prev, patch);
    const hasAny = Object.keys(merged).length > 0;

    if (hasAny) {
      const r = paymentProviders.validate(id, merged);
      if (!r.ok) {
        return res.status(400).json({
          error: '凭证校验未通过，未保存任何内容',
          errors: r.errors,
        });
      }
    }

    // 首次为该平台填写凭证时默认**开启**该渠道 —— 用户既然在配它，
    // 意图显然是要用；之后是否停用由渠道开关显式控制。
    const firstTime = Object.keys(prev).length === 0;
    if (hasAny && firstTime) configStore.setChannelEnabled(id, true);

    const after = configStore.savePayment(id, merged);
    const view = paymentProviders.publicView(id, after.platforms[id]);
    const p = paymentProviders.platform(id);
    logChange(req, 'save', hasAny ? `更新支付渠道「${p.name}」凭证` : `清空支付渠道「${p.name}」凭证`);

    const states = currentStates(after);
    const ready = configuredMap(after);
    res.json({
      ok: true,
      platform: id,
      values: view.values,
      configured: view.configured,
      complete: ready[id],
      enabled: !!states[id],
      available: !!states[id] && !!ready[id],
      updatedAt: after.platforms[id] ? after.platforms[id].updatedAt || '' : '',
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

/** 清除某一平台的凭证（会连带关闭该渠道，故同样受"至少一个渠道"约束） */
router.delete('/payment/config/:platform', requireAdmin, (req, res) => {
  const id = req.params.platform;
  if (!paymentProviders.isKnown(id)) {
    return res.status(404).json({ error: `未知的支付平台：${id}` });
  }
  try {
    const stored = configStore.getPayment();
    // 清凭证意味着该渠道不再可用，等价于把它关掉 —— 因此提前做一次约束校验，
    // 避免出现"总开关开着、却一个渠道都没有"的非法状态。
    const chk = paymentRules.checkChannelToggle(currentStates(stored), id, false, stored.enabled);
    if (!chk.ok) return res.status(400).json({ error: chk.message });

    configStore.clearPayment(id);
    const p = paymentProviders.platform(id);
    logChange(req, 'clear', `清除支付渠道「${p.name}」凭证`);
    res.json({ ok: true, platform: id, enabled: false, available: false });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

module.exports = router;
