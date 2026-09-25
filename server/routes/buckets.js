/**
 * 路由：存储桶管理
 *  — 本地桶列表/新增/编辑（普通用户可操作部分字段）
 *  — 启停 / 切换当前桶 / 可见性 / 解绑（管理员）
 *  — 桶容量统计、清空、碎片、彻底删除（管理员）
 *  — 云端桶列表 / 桶 ACL 安全检查
 */
// R7-03：shareStore 一并从 _context 取（删对象/删桶都要同步标记分享链接）
const { express, providers, configStore, statsStore, encStore, ipGuard, shareStore } = require('./_context');
const { getClient, p, translateError, listAll, listAllInfo, LIMITS, badRequest } = require('../cos');
const { deleteMultipleConfirmed } = require('../cos'); // R10-03：批量删除的白名单判据（共用）
const {
  requireAdmin, roleOf, bucketsFor, requireConfig, requireLocalBucket,
  bucketClient, requireNameConfirm, bucketStat, listFragments, listFragmentsNoCache, mapLimit,
} = require('./_shared');

const router = express.Router();

/* ============================ 本地桶记录 ============================ */

// 本地桶列表（按角色过滤可见性）
router.get('/buckets/local', (req, res) => {
  res.json(bucketsFor(req));
});

/**
 * FUN-08：新增本地桶前的**云端存在性探测**。
 *
 * 该路由不挂 requireAdmin —— 普通用户也能添加桶（写入只影响自己的会话）。
 * 但没有探测时，任何登录者都能把任意字符串存成桶记录：
 *   - 拼错桶名/地域 → 本地记录看着正常，一刷新就 404，且会被设为当前桶；
 *   - 恶意/误操作批量灌记录 → 管理员的桶管理列表被垃圾数据淹没；
 *   - 指向**不属于本系统**的桶名时，后续操作会带着本系统的密钥去打别人的桶。
 *
 * 判定策略是**确定性失败才拒绝**：
 *   - 404 / NoSuchBucket / AccessDenied / 地域重定向（301/PermanentRedirect）→ 400 拒绝；
 *   - 其它错误（网络超时、5xx、SDK 异常）→ 放行并回传 warning。
 *     理由：一次抖动就让管理员加不了桶是不可接受的，而"桶不存在/无权访问"
 *     是稳定事实，不会因重试而改变。
 *
 * @returns {Promise<{ok: boolean, message?: string, warning?: string}>}
 */
async function probeBucket(bucket, region, credOverride) {
  let cfg;
  try {
    cfg = credOverride ? Object.assign({}, configStore.effective(), credOverride) : configStore.effective();
  } catch (e) {
    return { ok: true, warning: '读取当前密钥配置失败，已跳过存在性校验' };
  }
  if (!cfg || !cfg.secretId || !cfg.secretKey) {
    return { ok: true, warning: '尚未配置访问密钥，已跳过存在性校验' };
  }
  const target = Object.assign({}, cfg, { bucket, region });
  try {
    const cos = getClient(target);
    await p(cos, 'getBucket', { Bucket: bucket, Region: region, MaxKeys: 1, Delimiter: '/' }, { noStat: true });
    return { ok: true };
  } catch (e) {
    const code = String((e && (e.code || e.Code || e.errorCode)) || '');
    const status = Number((e && (e.statusCode || e.status)) || 0);
    const hard = /NoSuchBucket|AccessDenied|InvalidBucketName|PermanentRedirect|AuthorizationHeaderMalformed|SignatureDoesNotMatch/i.test(code)
      || status === 404 || status === 403 || status === 301;
    if (hard) {
      return { ok: false, message: translateError(e) };
    }
    return { ok: true, warning: '无法连接云端校验该存储桶（' + (code || status || '未知错误') + '），已按你填写的信息保存' };
  }
}

// 添加（或按桶名更新）本地桶，并设为当前
/**
 * 新增本地桶记录（仅管理员）
 *
 * 「普通用户自行添加桶（只写自己会话）」这条路径已移除：普通用户不知道桶名与地域，
 * 也没有选择访问密钥 / 拉取云端桶列表的权限（见 SEC-11），由管理员在「存储桶可见性权限」
 * 里开放哪些桶给他们。留着这条路径只会得到一个「填不出正确桶名」的死胡同，
 * 以及一个可用任意桶名探测存在性的 oracle。
 */
router.post('/buckets/local', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const bucket = String(b.bucket || '').trim();
  const region = String(b.region || '').trim();
  if (!bucket) return res.status(400).json({ error: '请填写存储桶名称（需含 APPID 后缀）' });
  if (!region) return res.status(400).json({ error: '请填写存储桶地域（Region）' });
  const q = b.quotaBytes !== undefined ? Number(b.quotaBytes) : 0;
  if (!Number.isFinite(q) || q < 0) return res.status(400).json({ error: '配额容量不能为负数（0 表示无限制）' });
  try {
    // 从所选密钥推导服务商（桶的 provider 必须与密钥一致，否则后续操作用错 SDK）
    let provider;
    let credOverride = null;
    if (b.credentialId) {
      const full = configStore.load();
      const cred = full && (full.credentials || []).find((c) => c.id === String(b.credentialId));
      if (cred) {
        provider = cred.provider;
        // 探测必须用**这条被指定的密钥**，否则会用当前桶的密钥去验别人的桶，
        // 得到"A 密钥访问 B 桶被拒"这种与真实配置无关的误判。
        credOverride = {
          provider: cred.provider,
          secretId: cred.secretId,
          secretKey: cred.secretKey,
          endpoint: cred.endpoint || '',
        };
      }
    }
    const exists = (configStore.listBuckets().buckets || []).some((x) => x.bucket === bucket);
    // FUN-08：仅对**新建**记录做云端探测。已存在的桶走这里多半只是改备注/配额，
    // 此时要求云端可达只会让「离线改个备注」也无故失败。
    let warning = '';
    if (!exists) {
      const probe = await probeBucket(bucket, region, credOverride);
      if (!probe.ok) return res.status(400).json({ error: '无法访问该存储桶：' + probe.message + '。请检查桶名、地域与所选密钥是否正确' });
      if (probe.warning) warning = probe.warning;
    }
    const saved = configStore.addBucket({
      provider,
      bucket,
      region,
      remark: b.remark,
      quotaBytes: Math.floor(q),
      credentialId: b.credentialId,
      visibleToUsers: b.visibleToUsers, // 未传时由 addBucket 默认（对普通用户可见）
    });
    // FUN-06：addBucket 不再自动改写全局默认桶，这里显式切换以保留原有 UX。
    // 走 setActiveBucket(id, {token, role}) —— 它按 FUN-15 语义处理：
    // 有会话只写会话（普通用户影响不到全局），仅管理员额外更新系统默认桶。
    configStore.setActiveBucket(saved.id, { token: req.sessionToken, role: roleOf(req) });
    statsStore.addLog({ action: 'config.save', detail: '添加存储桶 ' + bucket, level: 'info' });
    res.json(Object.assign({ ok: true, bucket: saved, warning: warning || undefined }, configStore.listBuckets()));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// 更新桶信息（备注 / 配额 / 地域 / 关联密钥）
router.put('/buckets/local/:id', (req, res) => {
  const b = req.body || {};
  if (b.quotaBytes !== undefined) {
    const q = Number(b.quotaBytes);
    if (!Number.isFinite(q) || q < 0) return res.status(400).json({ error: '配额容量不能为负数（0 表示无限制）' });
    b.quotaBytes = Math.floor(q);
  }
  try {
    // SEC-01：非管理员只允许改「备注 / 配额」，其余字段**一律丢弃**。
    // 旧实现用 delete 列表（visibleToUsers / credentialId / enabled），漏掉了
    // provider 与 region，导致普通用户可把任意桶的厂商改成默认厂商、地域改错，
    // 使该桶对全体用户（含管理员）立即不可用。改为白名单后不会随字段新增而失效。
    if (roleOf(req) !== 'admin') {
      for (const k of Object.keys(b)) {
        if (k !== 'remark' && k !== 'quotaBytes') delete b[k];
      }
    }
    // FUN-05：字段白名单只管住「改哪些字段」，没管住「改哪个桶」。
    // 同一文件的 /active 早已校验 target.visibleToUsers，这里漏了 →
    // 普通用户可修改**对自己不可见**的管理员专属桶的备注（迷惑管理员）
    // 与容量配额（放松或收紧配额限制）。两处判定必须一致。
    if (roleOf(req) !== 'admin') {
      const target = requireLocalBucket(req.params.id);
      if (target.visibleToUsers === false) return res.status(403).json({ error: '无权访问该存储桶' });
    }
    if (!configStore.updateBucket(req.params.id, b)) return res.status(404).json({ error: '存储桶不存在' });
    res.json(Object.assign({ ok: true }, configStore.listBuckets()));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// 启用/停用存储桶（仅管理员；停用时自动设为对普通用户不可见）
// 误操作保护：至少保留一个启用的存储桶——当前仅剩最后一个启用桶时拒绝停用。
router.put('/buckets/local/:id/enabled', requireAdmin, (req, res) => {
  try {
    const b = req.body || {};
    const want = b.enabled !== false;
    if (!want) {
      const cfg = configStore.load() || { buckets: [] };
      const target = cfg.buckets.find((x) => x.id === req.params.id);
      if (!target) return res.status(404).json({ error: '存储桶不存在' });
      if (target.enabled !== false) {
        const enabledOthers = cfg.buckets.filter((x) => x.id !== req.params.id && x.enabled !== false).length;
        if (enabledOthers === 0) {
          return res.status(400).json({ error: '仅剩一个存储桶时不能停用，请直接解绑' });
        }
      }
    }
    if (!configStore.updateBucket(req.params.id, { enabled: want })) {
      return res.status(404).json({ error: '存储桶不存在' });
    }
    const view = configStore.listBuckets().buckets.find((x) => x.id === req.params.id) || {};
    statsStore.addLog({
      action: 'bucket.toggle', level: 'warn',
      detail: `管理员「${req.authUser.username}」${want ? '启用' : '停用'}存储桶「${view.bucket || ''}」${!want ? '（同时设为对普通用户不可见）' : ''}`,
    });
    res.json(Object.assign({ ok: true }, configStore.listBuckets()));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// 切换当前桶（普通用户只能切换到对其可见的桶）
router.put('/buckets/local/:id/active', (req, res) => {
  try {
    const target = requireLocalBucket(req.params.id);
    if (roleOf(req) !== 'admin' && target.visibleToUsers === false) {
      return res.status(403).json({ error: '无权访问该存储桶' });
    }
    if (target.enabled === false) return res.status(400).json({ error: '该存储桶已停用，请先在存储桶管理中启用后再切换' });
    // FUN-15：显式带上会话 token 与角色 —— 普通用户只写会话，管理员同时更新系统默认桶
    const role = roleOf(req);
    if (!configStore.setActiveBucket(req.params.id, { token: req.sessionToken, role })) {
      return res.status(404).json({ error: '存储桶不存在' });
    }
    const eff = configStore.get() || {};
    statsStore.addLog({ action: 'config.save', detail: '切换当前存储桶 ' + (eff.bucket || ''), level: 'info' });
    res.json(Object.assign({ ok: true }, bucketsFor(req)));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// 批量设置存储桶对普通用户的可见性（仅管理员）
router.put('/buckets/visibility', requireAdmin, (req, res) => {
  try {
    const b = req.body || {};
    if (!Array.isArray(b.visibleIds)) return res.status(400).json({ error: 'visibleIds 必须为数组' });
    // 校验传入 id 均存在，避免无意义写入
    const known = new Set(configStore.listBuckets().buckets.map((x) => x.id));
    const clean = b.visibleIds.filter((id) => known.has(String(id)));
    const r = configStore.setBucketsVisibility(clean.map(String));
    statsStore.addLog({
      action: 'bucket.visibility', level: 'warn',
      detail: `管理员「${req.authUser.username}」设置存储桶可见性：${r.visibleCount} 个桶对普通用户可见`,
    });
    res.json(Object.assign({ ok: true }, bucketsFor(req)));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// 删除本地桶（仅本地记录，不删除云端数据；仅管理员 —— 解绑会影响所有用户并清理桶级 IP 规则）
router.delete('/buckets/local/:id', requireAdmin, (req, res) => {
  try {
    const before = configStore.listBuckets();
    const target = before.buckets.find((x) => x.id === req.params.id);
    if (!configStore.removeBucket(req.params.id)) return res.status(404).json({ error: '存储桶不存在' });
    const cleaned = ipGuard.removeRulesForBucket(req.params.id); // 同步清理该桶的桶级 IP 屏蔽规则
    statsStore.addLog({ action: 'config.save', detail: '将存储桶从列表中移除' + (target ? target.bucket : '') + (cleaned ? `（同时清理 ${cleaned} 条桶级 IP 屏蔽规则）` : ''), level: 'warn' });
    res.json(Object.assign({ ok: true }, configStore.listBuckets()));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

/*
 * 云端桶列表接口（`GET /buckets`）已删除 —— 它是死代码：`api.js getBuckets()` 全库无人调用，
 * 实际拉云端桶列表走的是 `POST /config/verify`（管理员在建桶弹窗里「从云端获取桶列表」）。
 * 两条路径做同一件事、各有一套权限判定，正是 SEC-11 口径分叉的来源。
 * 现在收敛为**唯一入口** `POST /config/verify`（requireAdmin）。
 */

/* ============================ 桶 ACL 安全检查 ============================ */

/**
 * 判定桶 ACL 权限级别：private | public-read | public-read-write
 * 只看授权给"所有人"（AllUsers）的权限，授权给指定账号的不算公开。
 */
function evalBucketAcl(aclData) {
  const grants = (aclData && aclData.Grants) || [];
  let allRead = false, allWrite = false;
  for (const g of grants) {
    const uri = (g && g.Grantee && g.Grantee.URI) || '';
    if (!uri.includes('global/AllUsers')) continue;
    const perm = String(g.Permission || '').toUpperCase();
    if (perm === 'FULL_CONTROL' || perm === 'WRITE') { allWrite = true; allRead = true; }
    else if (perm === 'READ') allRead = true;
  }
  if (allWrite) return 'public-read-write';
  if (allRead) return 'public-read';
  // 兜底：部分响应只带 canned ACL 字符串
  const canned = String((aclData && aclData.ACL) || '').toLowerCase();
  if (canned.includes('public-read-write')) return 'public-read-write';
  if (canned.includes('public-read')) return 'public-read';
  return 'private';
}

// 检查全部本地绑定桶的 ACL（单个桶失败不影响其他桶）（**仅管理员**）
//
// SEC-07：该接口用 configStore.listBuckets() 遍历**全部**桶并返回桶名 / 地域 / 备注，
// 未按角色过滤 —— 普通用户可据此得到完整的桶清单。改为管理员专属。
router.get('/acl-check', requireAdmin, async (req, res) => {
  const prefs = configStore.getPrefs();
  const { buckets } = configStore.listBuckets();
  if (!buckets.length) return res.json({ disabled: prefs.aclReminderDisabled, buckets: [], publicBuckets: [] });

  const results = [];
  for (const b of buckets) {
    const cfg = configStore.effectiveForBucket(b.bucket, b.region);
    const provider = (cfg && cfg.provider) || providers.DEFAULT_PROVIDER_ID;
    const needRegion = (providers.get(provider) || {}).regionRequired !== false;
    if (!cfg || !cfg.secretId || (needRegion && !cfg.region)) {
      results.push({ bucket: b.bucket, region: b.region, remark: b.remark, acl: 'unknown', error: '未配置可用密钥或地域' });
      continue;
    }
    try {
      const client = getClient(cfg);
      const acl = await p(client, 'getBucketAcl', { Bucket: b.bucket, Region: cfg.region });
      results.push({ bucket: b.bucket, region: cfg.region, remark: b.remark, acl: evalBucketAcl(acl) });
    } catch (e) {
      const err = e.status ? e : translateError(e);
      results.push({ bucket: b.bucket, region: cfg.region, remark: b.remark, acl: 'unknown', error: err.message });
    }
  }
  const publicBuckets = results.filter((r) => r.acl === 'public-read' || r.acl === 'public-read-write');
  res.json({ disabled: prefs.aclReminderDisabled, buckets: results, publicBuckets });
});

// 设置"不再提醒"开关（仅管理员）
router.put('/acl-check/disabled', requireAdmin, (req, res) => {
  const disabled = Boolean(req.body && req.body.disabled);
  configStore.setPrefs({ aclReminderDisabled: disabled });
  res.json({ ok: true, disabled });
});

/* ============================ 桶容量 / 清空 / 碎片 / 彻底删除 ============================ */

// 每桶统计：容量（官方口径）+ 本系统累计上传/下载流量与请求数 + 碎片数
router.get('/buckets/stats', async (req, res) => {
  try {
    const { buckets, activeBucketId } = bucketsFor(req);
    const local = statsStore.bucketStats();
    const out = await mapLimit(buckets, 3, async (b) => {
      const c = local[b.bucket] || { up: 0, down: 0, req: 0 };
      const item = {
        id: b.id, bucket: b.bucket, region: b.region, remark: b.remark || '',
        provider: b.provider || providers.DEFAULT_PROVIDER_ID,
        providerName: providers.nameOf(b.provider),
        quotaBytes: b.quotaBytes || 0,
        enabled: b.enabled !== false,
        blockOverseasIP: b.blockOverseasIP === true,
        active: b.id === activeBucketId,
        stats: { sizeBytes: null, objectCount: null, estimated: false, upBytes: c.up || 0, downBytes: c.down || 0, requests: c.req || 0, fragmentCount: null },
        error: '',
      };
      try {
        const { cfg, cos: client } = bucketClient(b);
        try {
          const st = await bucketStat(client, cfg);
          item.stats.sizeBytes = st.sizeBytes;
          item.stats.objectCount = st.objectCount;
          item.stats.estimated = Boolean(st.estimated);
        } catch (e) { /* 容量查询失败不阻塞其余统计 */ item.statError = '容量查询失败'; }
        try {
          item.stats.fragmentCount = (await listFragments(client, cfg, { noStat: true })).length;
        } catch (e) { item.stats.fragmentCount = -1; }
      } catch (e) {
        const err = e.status ? e : translateError(e);
        item.error = err.message;
      }
      return item;
    });
    res.json({ buckets: out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 清空存储桶全部文件（需手输完整桶名确认；仅删除云端对象，不删除桶）
router.post('/buckets/local/:id/clear', requireAdmin, async (req, res) => {
  try {
    const b = requireLocalBucket(req.params.id);
    requireNameConfirm(req.body, b.bucket);
    const { cfg, cos: client } = bucketClient(b);
    // FUN-04：清空必须等到「云端确实删完」才清元数据 —— 旧实现先忽略截断、
    // 再无条件 removeBucketMeta()，会让残留对象的密文永久不可解。
    const r = await trackedDeletePrefix(client, cfg, '', (deletedKeys) => {
      encStore.removeMetaBatch(cfg.bucket, deletedKeys);
      // R7-03：桶内对象已确认删除 → 指向它们的分享链接同步标记「文件已删除」。
      // 漏了这一处，清空桶后管理页仍显示链接「有效」、分享页仍给下载按钮。
      shareStore.markMissingByKeys(cfg.bucket, deletedKeys);
    });
    if (r.truncated) {
      // R11-01：stalled（云端拒绝删除）与「对象过多未删完」分开报
      const err = new Error(r.stalled
        ? `云端拒绝删除该桶内的对象（对象锁 / 桶策略），已停止；本次共删除 ${r.count} 个。为避免残留密文不可解，加密元数据保留未清。`
        : `对象过多，本次仅删除 ${r.count} 个后仍未清理完毕；为避免残留密文不可解，加密元数据保留未清。请再次执行「清空」直到全部删除完成。`);
      err.status = 500;
      throw err;
    }
    const active = configStore.get();
    if (active && active.bucket === b.bucket) adjustStorageCache(-r.bytes, cfg);
    statsStore.addLog({ action: 'bucket.clear', detail: `清空存储桶 ${b.bucket}：删除 ${r.count} 个对象，释放 ${r.bytes} 字节`, level: 'warn' });
    res.json({ ok: true, deleted: r.count, bytes: r.bytes });
  } catch (e) {
    const err = e.status ? e : translateError(e);
    res.status(err.status || 500).json({ error: err.message });
    statsStore.addLog({ action: 'bucket.clear', detail: '清空存储桶失败: ' + err.message, level: 'error' });
  }
});

// 碎片列表（未完成的分片上传任务）
// SEC-11：与「清空碎片」同属管理员运维动作，且会暴露桶内对象 key。
router.get('/buckets/local/:id/fragments', requireAdmin, async (req, res) => {
  try {
    const b = requireLocalBucket(req.params.id);
    const { cfg, cos: client } = bucketClient(b);
    const fragments = await listFragments(client, cfg);
    res.json({ fragments });
  } catch (e) {
    const err = e.status ? e : translateError(e);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// 清空文件碎片：中止全部未完成的分片上传任务（不影响已完成的对象）
router.post('/buckets/local/:id/fragments/clear', requireAdmin, async (req, res) => {
  try {
    const b = requireLocalBucket(req.params.id);
    const { cfg, cos: client } = bucketClient(b);
    let aborted = 0;
    // 清空动作要**照着这份清单去中止任务**，必须读最新值：缓存里少了几个
    // 就漏掉几个分片，碎片会一直占着存储计费。
    const frags = await listFragmentsNoCache(client, cfg);
    // R8-19：旧实现逐个 `await multipartAbort`（串行）—— 1000 个碎片 ≈ 50 秒，
    // 期间浏览器早已超时、界面无进度。本文件顶部本就 import 了 mapLimit
    // （多桶统计与 movePrefix 同源），改成受控并发即可，语义完全不变。
    await mapLimit(frags, 5, async (f) => {
      try {
        await p(client, 'multipartAbort', { Bucket: cfg.bucket, Region: cfg.region, Key: f.key, UploadId: f.uploadId });
        aborted++;
      } catch (e) { /* 单个任务失败不中断其余 */ }
    });
    statsStore.addLog({ action: 'bucket.fragments', detail: `清空存储桶 ${b.bucket} 文件碎片：中止 ${aborted} 个分片上传任务`, level: 'warn' });
    res.json({ ok: true, aborted });
  } catch (e) {
    const err = e.status ? e : translateError(e);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// 彻底删除前的实时条件检查
// R8-08：同屏的 `/fragments`、`/fragments/clear`、`/destroy` 都挂了 requireAdmin，
// 唯独这里漏了 —— 它却会返回**不可见桶**的对象数量/碎片数/可删性，并且每次都真实
// 发起 `getBucket` + 分片全量列举（可被反复施压消耗云端配额）。
router.get('/buckets/local/:id/destroy-check', requireAdmin, async (req, res) => {
  try {
    const b = requireLocalBucket(req.params.id);
    const { cfg, cos: client } = bucketClient(b);
    const probe = await listAll(client, cfg, '', { cap: 1000 });
    let fragmentCount = 0;
    // 彻底删除不可逆 —— 前置检查必须读最新值，不能用缓存
    try { fragmentCount = (await listFragmentsNoCache(client, cfg, { noStat: true })).length; } catch (e) { fragmentCount = -1; }
    res.json({
      ok: true,
      objectCount: probe.length,
      objectCountCapped: probe.length >= 1000,
      fragmentCount,
      deletable: probe.length === 0 && fragmentCount === 0,
    });
  } catch (e) {
    const err = e.status ? e : translateError(e);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// 彻底删除存储桶（云端删除 + 移除本地记录 + 清除统计）：
// 必须满足：桶内全部文件已清空、无未完成分片上传、手输完整桶名完全匹配
router.post('/buckets/local/:id/destroy', requireAdmin, async (req, res) => {
  try {
    const b = requireLocalBucket(req.params.id);
    requireNameConfirm(req.body, b.bucket);
    const { cfg, cos: client } = bucketClient(b);
    const probe = await listAll(client, cfg, '', { cap: 1 });
    if (probe.length) {
      const e = new Error('存储桶内仍有文件（对象），请先清空全部文件后再执行删除');
      e.status = 409; throw e;
    }
    // 同上：彻底删除前必须用最新分片清单，缓存可能造成"明明有碎片却放行删除"
    const frags = await listFragmentsNoCache(client, cfg);
    if (frags.length) {
      const e = new Error(`存在 ${frags.length} 个未完成的分片上传任务（文件碎片），请先清空文件碎片`);
      e.status = 409; throw e;
    }
    await p(client, 'deleteBucket', { Bucket: b.bucket, Region: cfg.region });
    configStore.removeBucket(b.id);
    const cleanedRules = ipGuard.removeRulesForBucket(b.id); // 同步清理该桶的桶级 IP 屏蔽规则
    encStore.removeBucketMeta(b.bucket); // 同步清理该桶的全部加密元数据
    statsStore.resetBucketStats(b.bucket);
    // R7-03：桶整体消失 → 指向它的分享链接一律判「文件已删除」。
    // 这一处最容易被漏：桶没了之后 effectiveForBucket() 拿不到凭据，分享页的惰性探测会
    // fail-open，结果页面一直显示可下载、点了才报错。
    const deadLinks = shareStore.markMissingByBucket(b.bucket);
    statsStore.addLog({ action: 'bucket.destroy', detail: `彻底删除存储桶 ${b.bucket}（${b.region}）` + (cleanedRules ? `（同时清理 ${cleanedRules} 条桶级 IP 屏蔽规则）` : '') + (deadLinks ? `（同时标记 ${deadLinks} 条失效分享链接）` : ''), level: 'warn' });
    res.json({ ok: true });
  } catch (e) {
    const err = e.status ? e : translateError(e);
    res.status(err.status || 500).json({ error: err.message });
    statsStore.addLog({ action: 'bucket.destroy', detail: '删除存储桶失败: ' + err.message, level: 'error' });
  }
});

/* ============================ 内部工具 ============================ */

// 递归删除前缀下全部对象（分批 1000），流式循环直到列完（FUN-04）
//  — 与 fs 模块共享同一实现思路；此处保持独立以避免循环依赖
//  — 必须返回 truncated：达到上限而截断时，**不得**据此清理加密元数据，
//    否则残留对象的密文将永久不可解（旧实现的 cap:100000 静默截断正源于此）。
async function trackedDeletePrefix(client, cfg, key, onDeleted) {
  let deleted = 0;
  let bytes = 0;
  let rounds = 0;
  let truncated = true;
  // R11-01：同 routes/fs.js —— 「整批 0 成功即停下」必须置位外层变量，
  // 内层 break 只跳 for，truncated=true 反而让外层 while 继续（详见 fs.js 的说明）
  let stalled = false;
  const MAX_ROUNDS = 1000;
  while (truncated && !stalled && rounds < MAX_ROUNDS) {
    const info = await listAllInfo(client, cfg, key, { cap: LIMITS.DELETE });
    truncated = info.truncated;
    if (!info.items.length) break;
    for (let i = 0; i < info.items.length; i += 1000) {
      const batch = info.items.slice(i, i + 1000);
      const sizeOf = new Map(batch.map((k) => [k.key, Number(k.size || 0)]));
      /**
       * R10-03：与 `routes/fs.js` 共用同一套**白名单**判据（清空桶是"整桶"操作，
       * 覆盖面比删单个文件更大 —— 单个 key 被对象锁拒绝时，旧实现仍会清掉它的
       * 解密凭据并标掉分享链接，两件都不可逆）。
       */
      const res = await deleteMultipleConfirmed(client, cfg, batch.map((k) => k.key));
      deleted += res.okKeys.length;
      bytes += res.okKeys.reduce((s, k) => s + (sizeOf.get(k) || 0), 0);
      if (onDeleted && res.okKeys.length) onDeleted(res.okKeys);
      // 一个都没删掉 = 卡住（桶策略 Deny / 合规保留）→ 置位 stalled 让外层停下（R11-01）
      if (!res.okKeys.length) {
        stalled = true;
        truncated = true;
        break;
      }
    }
    rounds += 1;
  }
  return { count: deleted, bytes, truncated, rounds, stalled };
}

// 用量缓存增量修正（懒加载 metrics 模块，避免与 stats 路由产生循环依赖）
function adjustStorageCache(delta, cfg) {
  try {
    require('./stats').adjustStorageCache(delta, cfg);
  } catch (e) { /* 缓存修正失败不影响主流程 */ }
}

module.exports = router;
// 测试钩子：FUN-08 的存在性探测是纯云端交互，只有把它暴露出来才能在
// 不写真实配置的前提下断言「确定性失败才拒绝、网络抖动可放行」这条边界。
module.exports.__probeBucket = probeBucket;
