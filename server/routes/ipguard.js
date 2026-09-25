/**
 * 路由：IP 访问屏蔽（黑名单 + 国内白名单，全局 / 桶级两级）
 *  — 全部接口仅管理员；规则变更即时生效
 */
const { express, configStore, statsStore, ipGuard } = require('./_context');
const { requireAdmin } = require('./_shared');

const router = express.Router();

/** 为规则附加作用范围显示信息（桶显示名列表 / 是否有已解绑桶） */
function ruleScopeView(rule, buckets) {
  const bids = Array.isArray(rule.bucketIds) ? rule.bucketIds : [];
  if (!bids.length) return Object.assign({}, rule, { bucketNames: [], bucketMissing: false, isGlobal: true });
  const names = [];
  let missing = false;
  for (const id of bids) {
    const b = buckets.find((x) => x.id === id);
    if (b) names.push(b.remark || b.bucket);
    else { missing = true; names.push('(已解绑的存储桶)'); }
  }
  return Object.assign({}, rule, { bucketNames: names, bucketMissing: missing, isGlobal: false });
}

router.get('/ipguard', requireAdmin, (req, res) => {
  const v = ipGuard.view();
  const buckets = configStore.listBuckets().buckets;
  v.rules = v.rules.map((r) => ruleScopeView(r, buckets));
  res.json(Object.assign({ ok: true, methods: ipGuard.ALLOWED_METHODS }, v));
});

router.post('/ipguard/rules', requireAdmin, (req, res) => {
  try {
    const b = req.body || {};
    const rule = ipGuard.addRule({ target: b.target, remark: b.remark, methods: b.methods, bucketIds: b.bucketIds });
    const scope = (rule.bucketIds && rule.bucketIds.length) ? '桶级' : '全局';
    statsStore.addLog({ action: 'ipguard.add', detail: `新增${scope} IP 屏蔽规则 ${rule.target}${rule.methods.length ? '（' + rule.methods.join('/') + '）' : '（全部方法）'}` });
    res.json({ ok: true, rule });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.put('/ipguard/rules/:id', requireAdmin, (req, res) => {
  try {
    const b = req.body || {};
    const rule = ipGuard.updateRule(req.params.id, { target: b.target, remark: b.remark, methods: b.methods, bucketIds: b.bucketIds });
    statsStore.addLog({ action: 'ipguard.update', detail: `修改 IP 屏蔽规则 ${rule.target}` });
    res.json({ ok: true, rule });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.put('/ipguard/rules/:id/enabled', requireAdmin, (req, res) => {
  try {
    const enabled = !!(req.body || {}).enabled;
    const rule = ipGuard.setRuleEnabled(req.params.id, enabled);
    statsStore.addLog({ action: 'ipguard.toggle', detail: `${enabled ? '启用' : '禁用'} IP 屏蔽规则 ${rule.target}` });
    res.json({ ok: true, rule });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.delete('/ipguard/rules/:id', requireAdmin, (req, res) => {
  try {
    const removed = ipGuard.removeRule(req.params.id);
    statsStore.addLog({ action: 'ipguard.delete', detail: `删除 IP 屏蔽规则 ${removed.target}` });
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// 按存储桶屏蔽 / 放行海外 IP（仅管理员；配置写入 config.enc，ip-guard 读配置即时生效）
router.put('/buckets/local/:id/block-overseas', requireAdmin, (req, res) => {
  try {
    const enabled = !!(req.body || {}).enabled;
    const r = ipGuard.setBucketOverseas(req.params.id, enabled);
    ipGuard.invalidateOverseasCache(req.params.id);
    const b = configStore.listBuckets().buckets.find((x) => x.id === req.params.id);
    statsStore.addLog({ action: 'bucket.block-overseas', level: 'warn', detail: `管理员「${req.authUser.username}」${enabled ? '开启' : '关闭'}存储桶「${b ? b.bucket : req.params.id}」的海外 IP 屏蔽（白名单 ${r.chinaRangeCount} 段）` });
    res.json(Object.assign({ ok: true }, r));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// 测试某个 IP 是否会被当前规则屏蔽（预检，便于用户校验规则）
// bucketId 可选：空 = 无桶上下文（仅全局规则）；'active' = 当前激活桶；其余 = 指定桶 id
router.get('/ipguard/test', requireAdmin, (req, res) => {
  const ip = String(req.query.ip || '').trim();
  const method = String(req.query.method || 'GET').toUpperCase();
  let bucketId = String(req.query.bucketId || '').trim();
  if (bucketId === 'active') {
    const lb = configStore.listBuckets();
    bucketId = lb.activeBucketId || '';
  }
  const v = ipGuard.evaluate(ip, method, bucketId || null);
  res.json({ ok: true, ip, method, bucketId: bucketId || null, allowed: v.ok, reason: v.reason || null, matchedRule: v.rule || null });
});

module.exports = router;
