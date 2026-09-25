/**
 * 路由：系统配置 / 访问密钥管理 / 服务商凭据验证
 *  — 密钥为共享资源，写操作（新增/修改/删除/可见性）一律仅管理员
 */
const { express, providers, configStore, statsStore } = require('./_context');
const { createClient, p, translateError } = require('../cos');
const { requireAdmin, roleOf, credentialsFor, validateCredentialFormat } = require('./_shared');
const { assertSafeEndpoint } = require('../endpoint-guard');

const router = express.Router();

/* ============================ 系统配置 ============================ */

// 获取配置（安全视图：SecretId 掩码，SecretKey 不回传；按角色过滤桶可见性）
router.get('/config', (req, res) => {
  res.json(Object.assign({ selfTest: configStore.selfTest() }, configStore.safeView(roleOf(req))));
});

// 保存配置（兼容旧版扁平入参；secretKey 为空表示保留原值；仅管理员——密钥为共享资源，普通用户不可自行绑定）
router.put('/config', requireAdmin, (req, res) => {
  const b = req.body || {};
  try {
    if (b.provider !== undefined && String(b.provider).trim() && !providers.isSupported(String(b.provider).trim())) {
      return res.status(400).json({ error: '当前版本暂不支持该服务商，请选择其他服务商' });
    }
    // 密钥：同 SecretId 视为更新并设为当前
    if (b.secretId !== undefined) {
      const sid = String(b.secretId).trim();
      const fmtErr = sid ? validateCredentialFormat(b.provider, sid) : '';
      if (fmtErr) return res.status(400).json({ error: fmtErr });
      if (sid) {
        const stored = configStore.get() || {};
        const skey = String(b.secretKey || '').trim() || (stored.secretId === sid ? stored.secretKey : '');
        if (!skey) return res.status(400).json({ error: '请填写 SecretKey' });
        // FUN-06：addCredential 不再自动设为当前密钥；本接口为管理员专属，显式切换以保持原行为
        const cred = configStore.addCredential({ provider: b.provider, secretId: sid, secretKey: skey, remark: b.credentialRemark });
        configStore.setActiveCredential(cred.id);
      }
    }
    // 存储桶：同名视为更新并设为当前
    if (b.bucket !== undefined && String(b.bucket).trim()) {
      const q = b.quotaBytes !== undefined ? Number(b.quotaBytes) : undefined;
      if (q !== undefined && (!Number.isFinite(q) || q < 0)) {
        return res.status(400).json({ error: '配额容量不能为负数（0 表示无限制）' });
      }
      // FUN-06：addBucket 不再自动改写全局默认桶；本接口为管理员专属，显式切换以保持原行为
      const bk = configStore.addBucket({
        provider: b.provider,
        bucket: String(b.bucket).trim(),
        region: String(b.region || '').trim(),
        remark: b.bucketRemark,
        quotaBytes: q !== undefined ? Math.floor(q) : undefined,
      });
      configStore.setActiveBucket(bk.id, { token: req.sessionToken, role: roleOf(req) });
    }
    if (b.domains !== undefined) {
      configStore.save({
        domains: {
          primary: String((b.domains || {}).primary || '').trim(),
          backup: String((b.domains || {}).backup || '').trim(),
        },
      });
    }
    statsStore.addLog({ action: 'config.save', detail: '更新系统配置', level: 'info' });
    res.json(Object.assign({ selfTest: configStore.selfTest() }, configStore.safeView(roleOf(req))));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

/* ============================ 访问密钥管理 ============================ */

// 密钥列表（掩码，按角色过滤可见性）
router.get('/credentials', (req, res) => {
  res.json(credentialsFor(req));
});

// 新增（或按 SecretId 更新）密钥，并设为当前（仅管理员）
router.post('/credentials', requireAdmin, (req, res) => {
  const b = req.body || {};
  const secretId = String(b.secretId || '').trim();
  const secretKey = String(b.secretKey || '').trim();
  if (b.provider !== undefined && String(b.provider).trim() && !providers.isSupported(String(b.provider).trim())) {
    return res.status(400).json({ error: '当前版本暂不支持该服务商，请选择其他服务商' });
  }
  const fmtErr = validateCredentialFormat(b.provider, secretId);
  if (fmtErr) return res.status(400).json({ error: fmtErr });
  if (!secretKey) return res.status(400).json({ error: '请填写 SecretKey' });
  try {
    const cred = configStore.addCredential({ provider: b.provider, secretId, secretKey, remark: b.remark, endpoint: b.endpoint, visibleToUsers: b.visibleToUsers, enabled: b.enabled });
    // FUN-06：同上，新增密钥由本管理员接口显式设为当前（存储层不再自动改写）
    configStore.setActiveCredential(cred.id);
    statsStore.addLog({ action: 'config.save', detail: '保存访问密钥 ' + cred.secretIdMasked, level: 'info' });
    res.json(Object.assign({ ok: true }, configStore.listCredentials()));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// 选择当前密钥（全局状态，仅管理员）
// ⚠️ 兼容/内部回退用途：前端已无「使用此密钥」入口（多密钥改为全部启用 + 同厂商优先回退），
//    此接口仅保留供内部兜底与历史调用，勿在新功能中依赖它表达「切换」语义。
router.put('/credentials/:id/active', requireAdmin, (req, res) => {
  try {
    const creds = configStore.listCredentials().credentials;
    const target = creds.find((c) => c.id === req.params.id);
    if (!target) return res.status(404).json({ error: '密钥不存在' });
    if (target.enabled === false) return res.status(400).json({ error: '该密钥已停用，请先启用后再使用' });
    if (!configStore.setActiveCredential(req.params.id)) return res.status(404).json({ error: '密钥不存在' });
    statsStore.addLog({ action: 'config.save', detail: '切换当前访问密钥', level: 'info' });
    res.json(Object.assign({ ok: true }, credentialsFor(req)));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// 批量设置密钥对普通用户的可见性（仅管理员；须在 /credentials/:id 之前注册避免被参数捕获）
router.put('/credentials/visibility', requireAdmin, (req, res) => {
  try {
    const b = req.body || {};
    if (!Array.isArray(b.visibleIds)) return res.status(400).json({ error: 'visibleIds 必须为数组' });
    const known = new Set(configStore.listCredentials().credentials.map((x) => x.id));
    const clean = b.visibleIds.filter((id) => known.has(String(id)));
    const r = configStore.setCredentialsVisibility(clean.map(String));
    statsStore.addLog({
      action: 'credential.visibility', level: 'warn',
      detail: `管理员「${req.authUser.username}」设置密钥可见性：${r.visibleCount} 个密钥对普通用户可见`,
    });
    res.json(Object.assign({ ok: true }, configStore.listCredentials()));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// 修改密钥（备注 / 可见性 / 启停，仅管理员）——停用时自动设为不可见
router.put('/credentials/:id', requireAdmin, (req, res) => {
  try {
    if (!configStore.updateCredential(req.params.id, (req.body || {}))) {
      return res.status(404).json({ error: '密钥不存在' });
    }
    res.json(Object.assign({ ok: true }, configStore.listCredentials()));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// 删除本地已保存的密钥（仅本地，不影响云端；仅管理员）
router.delete('/credentials/:id', requireAdmin, (req, res) => {
  try {
    if (!configStore.removeCredential(req.params.id)) return res.status(404).json({ error: '密钥不存在' });
    statsStore.addLog({ action: 'config.save', detail: '删除本地访问密钥', level: 'warn' });
    res.json(Object.assign({ ok: true }, configStore.listCredentials()));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

/* ============================ 连接验证 ============================ */

/**
 * 连接验证：使用传入或已存密钥调用对象存储服务，验证凭据/桶可用性。
 * 支持 credentialId：用本地已存指定密钥（须未停用）验证并拉取桶列表。
 *
 * ## 权限：仅管理员
 *
 * 两条理由，缺一不可：
 *   ① **SEC-03 盲 SSRF**：风险来自**请求方可控的 endpoint / 凭据** —— 一旦对普通用户
 *      开放，即可借本服务探测内网与云实例元数据。
 *   ② **SEC-11 云端桶名属于账号资产**：本接口会调 `getService` 回传该密钥可见的
 *      **全部**桶名。曾对普通用户开过一道「必须指定可见且已启用 credentialId」的窄缝，
 *      但那只是把 SSRF 面收窄了，并没有改变「普通用户能枚举账号资产」这一事实 ——
 *      与 `GET /buckets`（云端桶列表，见 audit3 护栏 SEC-11）口径直接冲突。
 *      同一件事只允许有一条口径，因此收回到 requireAdmin，前端对普通用户不再提供
 *      「从云端获取桶列表」入口（普通用户仍可手填桶名 + 地域添加，服务端会做存在性探测）。
 *
 * 端点仍过 `assertSafeEndpoint()`（密钥上的自定义端点同样校验，纵深防御）。
 */
router.post('/config/verify', requireAdmin, async (req, res) => {
  try {
    const stored = configStore.get() || {};
    const b = req.body || {};

    // 请求体携带的自定义端点必须先做安全校验（拒绝元数据/回环/私网，非回环强制 https）
    if (b.endpoint !== undefined && String(b.endpoint).trim()) {
      try { assertSafeEndpoint(b.endpoint); } catch (e) {
        return res.status(e.status || 400).json({ ok: false, error: e.message });
      }
    }
    // 指定密钥：取本地存储的完整密钥（含 provider/endpoint），停用密钥拒绝使用
    if (b.credentialId) {
      const full = configStore.load();
      const cred = full && full.credentials.find((c) => c.id === String(b.credentialId));
      if (!cred) return res.status(404).json({ ok: false, error: '所选密钥不存在，请刷新后重试' });
      if (cred.enabled === false) return res.status(400).json({ ok: false, error: '所选密钥已停用，请先启用或选择其他密钥' });
      // 密钥自带的自定义端点同样过守卫（请求体端点已在前面校验过）
      if (cred.endpoint) {
        try { assertSafeEndpoint(cred.endpoint); } catch (e) {
          return res.status(e.status || 400).json({ ok: false, error: e.message });
        }
      }
      const cProvider = cred.provider || providers.DEFAULT_PROVIDER_ID;
      const cRegion = (b.region && String(b.region).trim()) || '';
      const cBucket = (b.bucket && String(b.bucket).trim()) || '';
      let client;
      try {
        client = createClient({
          provider: cProvider,
          secretId: cred.secretId,
          secretKey: cred.secretKey,
          region: cRegion,
          endpoint: cred.endpoint || '',
          bucket: cBucket,
        });
      } catch (e) {
        return res.status(e.status || 400).json({ ok: false, error: e.message });
      }
      let buckets2 = [];
      try {
        const svc = await p(client, 'getService', {});
        buckets2 = (svc.Buckets || []).map((x) => ({
          name: x.Name,
          region: x.Region || (x.Location || '').replace(/^cos\./, ''),
          location: x.Location,
          creationDate: x.CreationDate,
        }));
      } catch (e) {
        const t = translateError(e);
        return res.json({ ok: false, error: '密钥验证失败：' + t.message });
      }
      return res.json({ ok: true, message: '连接成功，凭据有效', provider: cProvider, buckets: buckets2 });
    }
    const secretId = (b.secretId && String(b.secretId).trim()) || stored.secretId;
    const secretKey = (b.secretKey && String(b.secretKey).trim()) || stored.secretKey;
    const bucket = (b.bucket && String(b.bucket).trim()) || stored.bucket || '';
    const region = (b.region && String(b.region).trim()) || stored.region || '';
    const provider = (b.provider && String(b.provider).trim()) || stored.provider || providers.DEFAULT_PROVIDER_ID;
    const endpoint = (b.endpoint && String(b.endpoint).trim()) || stored.endpoint || '';
    if (!secretId || !secretKey) return res.status(400).json({ ok: false, error: '请先填写访问密钥（AccessKey ID / Secret Access Key）' });

    let client;
    try {
      client = createClient({ provider, secretId, secretKey, region, endpoint });
    } catch (e) {
      return res.status(e.status || 400).json({ ok: false, error: e.message });
    }
    let buckets = [];
    try {
      const svc = await p(client, 'getService', {});
      buckets = (svc.Buckets || []).map((x) => ({
        name: x.Name,
        region: x.Region || (x.Location || '').replace(/^cos\./, ''),
        location: x.Location,
        creationDate: x.CreationDate,
      }));
    } catch (e) {
      const t = translateError(e);
      return res.status(200).json({ ok: false, error: '密钥验证失败：' + t.message });
    }
    if (bucket) {
      const bRegion = region || (buckets.find((x) => x.name === bucket) || {}).region;
      if (!bRegion) return res.json({ ok: false, error: `未找到存储桶 ${bucket}，请检查桶名是否正确`, buckets });
      try {
        await p(client, 'headBucket', { Bucket: bucket, Region: bRegion });
      } catch (e) {
        const t = translateError(e);
        return res.json({ ok: false, error: '存储桶验证失败：' + t.message, buckets });
      }
    }
    res.json({ ok: true, message: '连接成功，凭据有效' + (bucket ? '，存储桶可访问' : ''), buckets });
  } catch (e) {
    const t = translateError(e);
    res.status(500).json({ ok: false, error: '验证过程异常：' + t.message });
  }
});

module.exports = router;
