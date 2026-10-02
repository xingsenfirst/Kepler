/**
 * 桶容量（用量）查询与并发工具 —— **服务端根级模块**，不依赖 `routes/`。
 *
 * ## 为什么单独成文件（而不是留在 `routes/_shared.js`）
 *
 * 容量查询原本定义在 `routes/_shared.js`。R25 新增的「按 API Key 的配额」既要在
 * **路由**里判（建桶 / 上传），也要在 **WebDAV 独立实例**里判（PUT / COPY / MKCOL / MOVE）。
 * 而依赖图是单向的：
 *
 *   routes/*  →  routes/_context  →  webdav-server  →  fs-gateway  →  cos
 *
 * 若让 `webdav-server` 反向 require `routes/_shared`，就会形成
 * `webdav-server → routes/_shared → _context → webdav-server` 的**循环依赖**：
 * 加载期 `_shared` 从半初始化的 `_context` 解构会拿到 `undefined`，故障点在运行时才爆，
 * 极难定位。故把「容量查询 + 并发映射 + 客户端解析」下沉到本模块（只依赖 `cos` /
 * `providers` / `config-store`），`routes/_shared.js` 改为**转出**这里的东西，
 * 既有调用方与测试（`shared.bucketStat` / `shared.bucketCacheKey`）无感。
 *
 * 判据仍只有一份：`bucketStat()` 是全库唯一的「桶用量」取值点（官方 `?stats` 优先、
 * 分页列出兜底），配额统计与桶管理页显示的是**同一个数字**。
 */
const configStore = require('./config-store');
const providers = require('./providers');
const { getClient, providerOf, p, listAll } = require('./cos');

/* ============================ 桶容量缓存与取值 ============================ */

/**
 * 桶相关缓存的唯一键：多云下不同厂商/不同密钥可能绑定**同名桶**，
 * 若仅以桶名作键会互相覆盖（A 厂商的容量显示成 B 厂商的数字）。故并入 provider 与凭据。
 */
function bucketCacheKey(cfg) {
  return [providerOf(cfg), cfg.secretId || '', cfg.bucket || '', cfg.region || ''].join('|');
}

// 桶容量缓存（与原实现共用同一份状态）
const bucketSizeCache = new Map(); // cacheKey -> { t, sizeBytes, objectCount, estimated }
const BUCKET_STAT_CACHE_MS = 15 * 60 * 1000;
/** FUN-12：缓存条目上限。密钥轮换 / 多桶会持续产生新 key，无上限即缓慢泄漏 */
const BUCKET_STAT_CACHE_MAX = 200;

/**
 * R25：桶 → 「自上次**新鲜**容量取样以来累计的净写入字节」。
 *
 * ## 为什么必须有它（否则配额闸门形同虚设）
 *
 * `bucketSizeCache` 的 TTL 是 15 分钟（官方 `?stats` 每日才更新，缓存 15 分钟已属频繁）。
 * 若配额判定直接读缓存，用户在 15 分钟内往 10GB 上限的密钥里灌 100GB 也不会被拦一次 ——
 * 「配了额度却拦不住」比没有额度更危险（管理员据此以为已经管住了）。
 *
 * 因此每次写入都把增量记在这里，配额判定用 **缓存值 + 未取样增量**。
 * 一旦某桶被**新鲜**取样（`bucketStat` 走到缓存未命中分支），说明新数字已包含这些写入，
 * 该桶的增量随之清零（在 `bucketStat` 内统一清，不在调用方清 —— 避免散落的遗漏）。
 *
 * 语义上与 `routes/stats.js` 的 `adjustStorageCache`（用量面板的增量修正）同源，
 * 但**互不替代**：那个修正的是「显示」，这里修正的是「判定」，本模块不依赖任何 routes。
 */
const bucketPendingDelta = new Map(); // cacheKey -> bytes
/** 与 `BUCKET_STAT_CACHE_MAX` 同一纪律：键空间相同，必须有上限 + 清扫 */
const BUCKET_DELTA_MAX = 200;

/**
 * 写入前顺带清掉过期项；仍超限则淘汰最早的（Map 保持插入顺序）。
 * 旧实现只判 TTL 从不删除 —— 条目只增不减，长时间运行就是一条单调上升的内存曲线。
 */
function pruneBucketSizeCache() {
  const now = Date.now();
  for (const [k, v] of bucketSizeCache) {
    if (now - v.t > BUCKET_STAT_CACHE_MS) bucketSizeCache.delete(k);
  }
  while (bucketSizeCache.size >= BUCKET_STAT_CACHE_MAX) {
    const oldest = bucketSizeCache.keys().next();
    if (oldest.done) break;
    bucketSizeCache.delete(oldest.value);
  }
}

/** 调用腾讯云 COS ?stats 接口获取官方容量；返回 { sizeBytes, objectCount } 或 null（失败/不支持） */
async function getBucketStatViaApi(client, cfg) {
  if (!providers.isCos(providerOf(cfg.provider))) return null;
  try {
    const data = await p(client, 'request', { Method: 'GET', Bucket: cfg.bucket, Region: cfg.region, action: 'stats' }, { noStat: true });
    const body = data && (data.Body || data.body);
    if (typeof body === 'string') {
      const sizeM = body.match(/<Size>([^<]+)<\/Size>/);
      const objM = body.match(/<ObjectNumber>([^<]+)<\/ObjectNumber>/);
      if (sizeM || objM) return { sizeBytes: sizeM ? Number(sizeM[1]) : 0, objectCount: objM ? Number(objM[1]) : 0 };
    } else if (body && typeof body === 'object') {
      return { sizeBytes: Number(body.Size) || 0, objectCount: Number(body.ObjectNumber) || 0 };
    }
    return null;
  } catch (e) {
    return null; // 失败由调用方回退
  }
}

async function bucketStat(client, cfg) {
  const key = bucketCacheKey(cfg);
  const c = bucketSizeCache.get(key);
  if (c && Date.now() - c.t < BUCKET_STAT_CACHE_MS) return c;
  pruneBucketSizeCache(); // FUN-12：写之前清理，避免条目无限堆积

  // P3：优先官方 ?stats 接口（单次 API 调用，无分页扫全桶）
  const official = await getBucketStatViaApi(client, cfg);
  if (official) {
    const out = {
      sizeBytes: official.sizeBytes,
      objectCount: official.objectCount,
      estimated: false,
      source: 'GetBucketStat',
      t: Date.now(),
    };
    bucketSizeCache.set(key, out);
    noteFreshSample(key); // R25：新数字已含此前全部写入，未取样增量清零
    return out;
  }

  // 回退：分页列出对象累计（最多扫描 5000 个，超出为估算值）
  const items = await listAll(client, cfg, '', { cap: 5001 });
  const out = {
    sizeBytes: items.reduce((s, x) => s + (x.size || 0), 0),
    objectCount: items.length,
    estimated: items.length >= 5001,
    source: 'ListScan',
    t: Date.now(),
  };
  bucketSizeCache.set(key, out);
  /**
   * R27-05：**只有精确样本才能清空待定增量**。
   *
   * `estimated === true` 意味着这次扫描在上限处被截断（这里只取了前 5001 个对象），
   * 得到的是一个**下界**，它**并不包含**此前的写入 —— 而旧实现无条件
   * `noteFreshSample(key)`，把唯一能补偿截断的机制一并清掉。
   *
   * 后果不是「数字略偏」而是**闸门长期失效**：`getBucketStatViaApi()` 仅对腾讯云
   * 生效（其它厂商一律走本分支），所以任何非腾讯云厂商的桶只要对象数超过 5001，
   * 判定基准就永远是一个远小于真实占用的下界，且每次缓存过期（15 分钟）都把新记的
   * 增量再清一次 —— 管理员以为配了额度，实际上没有。
   *
   * 保留增量的代价是「可能偏高」（云端迟早会把写入算进去，而增量仍未清），方向上
   * 偏保守（宁可多拦，不可漏放），与本模块 `assertCredentialQuota` 的失败取向一致。
   */
  if (!out.estimated) noteFreshSample(key);
  return out;
}

/* ============================ 写入增量记账（R25 配额用） ============================ */

/** 新鲜取样后清掉该桶的未取样增量（见 `bucketPendingDelta` 的说明） */
function noteFreshSample(key) {
  bucketPendingDelta.delete(key);
}

/** 清扫超限条目（与 `pruneBucketSizeCache` 同一纪律；Map 保持插入顺序，淘汰最早的） */
function sweepPendingDelta() {
  while (bucketPendingDelta.size >= BUCKET_DELTA_MAX) {
    const oldest = bucketPendingDelta.keys().next();
    if (oldest.done) break;
    bucketPendingDelta.delete(oldest.value);
  }
}

/**
 * 记账一次写入的净增量（正数=新增占用，负数=释放）。**唯一写入点**。
 *
 * `cfg` 用于算缓存键（与 `bucketStat` 同一个键空间，才能被 `noteFreshSample` 清掉）。
 * 传入 0 / 非有限数 / 缺 cfg 时静默忽略 —— 记账失败不该影响主流程（顶多让判定滞后
 * 到一个取样周期，而**抛错**会让正常的删除/上传直接失败，代价大得多）。
 */
function recordUsageDelta(cfg, delta) {
  const d = Number(delta);
  if (!cfg || !Number.isFinite(d) || d === 0) return;
  let key;
  try { key = bucketCacheKey(cfg); } catch (e) { return; }
  sweepPendingDelta();
  bucketPendingDelta.set(key, (bucketPendingDelta.get(key) || 0) + d);
}

/** 测试钩子：读取某桶当前未取样增量 */
function pendingUsageDelta(cfg) {
  try { return bucketPendingDelta.get(bucketCacheKey(cfg)) || 0; } catch (e) { return 0; }
}


/* ============================ 桶 → 云端客户端解析 ============================ */

/**
 * 为本地桶记录解析云端客户端（`{ cfg, cos }`）；**不可用时返回 `null`**，不抛错。
 *
 * 这是「桶 → 客户端」的**唯一实现点**（`routes/_shared.bucketClient` 是本函数之上
 * 一层「失败即抛 428」的包装）。之所以取「返回 null」的宽容语义：配额统计要遍历
 * 一个 API Key 下的**全部**桶，其中某个桶缺少密钥/地域时应当**跳过该桶**，
 * 而不是让整个用量统计（进而让「能否上传」）整体失败 —— 那是把一处局部缺配置
 * 放大成全局不可用。
 */
function resolveBucketClient(b) {
  const cfg = configStore.effectiveForBucket(b.bucket, b.region);
  const provider = (cfg && cfg.provider) || providers.DEFAULT_PROVIDER_ID;
  const needRegion = (providers.get(provider) || {}).regionRequired !== false;
  if (!cfg || !cfg.secretId || !cfg.secretKey || (needRegion && !cfg.region)) return null;
  return { cfg, cos: getClient(cfg) };
}

/* ============================ 并发工具 ============================ */

/** 带并发上限的并行映射（P3：多桶统计并行，但限制并发避免触发 COS 限流） */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = [];
  for (let w = 0; w < Math.min(limit, items.length); w++) {
    workers.push((async () => {
      while (cursor < items.length) {
        const idx = cursor++;
        out[idx] = await fn(items[idx], idx);
      }
    })());
  }
  await Promise.all(workers);
  return out;
}

/* ============================ 凭据（API Key）配额 ============================ */

/**
 * 配额超限的**机器可读码**。
 *
 * 前端据此**弹对话框**（而不是普通 toast）—— 单纯靠 HTTP 403 无法与「上传排除命中」
 * 等其它 403 区分。该码随响应体 `code` 字段下发（见 `routes/_shared.errorBody`）。
 */
const QUOTA_EXCEEDED_CODE = 'CREDENTIAL_QUOTA_EXCEEDED';

/** 人类可读字节数（仅用于配额超限提示文案；与前端 fmtSize 保持同一量纲） */
function humanBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return v + ' B';
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let x = v / 1024;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i += 1; }
  return (x >= 100 ? Math.round(x) : x.toFixed(1)) + ' ' + units[i];
}

/**
 * 某凭据（API Key）的配额用量 —— **按 API Key 聚合**的唯一实现点。
 *
 * @param {string} credId 凭据 id
 * @returns {Promise<{credentialId:string, quotaBytes:number, unlimited:boolean,
 *   usedBytes:number, outstandingBytes:number,
 *   buckets:Array<object>}>}
 *   `quotaBytes` 为 0 表示**无限制**；`buckets` 按 `sizeBytes` **降序**（负载均衡卡片直接展示）；
 *   `outstandingBytes` 是尚未被新鲜取样吸收的写入增量（见 `bucketPendingDelta`）。
 */
async function credentialUsage(credId) {
  const empty = {
    credentialId: credId || '',
    quotaBytes: 0,
    unlimited: true,
    usedBytes: 0,
    outstandingBytes: 0,
    buckets: [],
  };
  const cfg = configStore.load();
  if (!cfg || !credId) return empty;
  const cred = (cfg.credentials || []).find((c) => c.id === credId);
  if (!cred) return empty;

  const quotaBytes = configStore.normalizeQuotaBytes(cred.quotaBytes);
  // 归属判定与「实际写入用哪把密钥」同源（config-store.credentialIdForBucket）
  const mine = (cfg.buckets || []).filter((b) => configStore.credentialIdForBucket(cfg, b) === credId);

  const rows = await mapLimit(mine, 4, async (b) => {
    const row = {
      id: b.id,
      bucket: b.bucket,
      region: b.region || '',
      remark: b.remark || '',
      quotaBytes: configStore.normalizeQuotaBytes(b.quotaBytes),
      sizeBytes: 0,
      objectCount: 0,
      estimated: false,
      source: '',
      outstandingBytes: 0,
      // false = 该桶缺密钥/地域，无法查容量（配额判定按 0 计，但不静默失败）
      available: false,
      error: '',
    };
    const r = resolveBucketClient(b);
    if (!r) { row.error = '该存储桶缺少可用的访问密钥或地域信息'; return row; }
    row.available = true;
    try {
      const st = await bucketStat(r.cos, r.cfg);
      const pending = Math.max(0, pendingUsageDelta(r.cfg));
      row.sizeBytes = (st.sizeBytes || 0) + pending;
      row.objectCount = st.objectCount || 0;
      row.estimated = Boolean(st.estimated);
      row.source = st.source || '';
      row.outstandingBytes = pending;
    } catch (e) {
      row.available = false;
      row.error = '容量查询失败';
    }
    return row;
  });

  rows.sort((a, b) => b.sizeBytes - a.sizeBytes);
  const usedBytes = rows.reduce((s, x) => s + x.sizeBytes, 0);
  const outstandingBytes = rows.reduce((s, x) => s + x.outstandingBytes, 0);
  return { credentialId: credId, quotaBytes, unlimited: quotaBytes <= 0, usedBytes, outstandingBytes, buckets: rows };
}

/**
 * 断言凭据配额未超限；超限时**抛出 403**（带机器可读码 + 结构化明细）。
 *
 * 判定式：`usedBytes + addBytes > quotaBytes`。
 *  - `addBytes` 为本次待写入的字节数（已知大小时传入 → 可在**写入前**预判并拦下）；
 *  - 未知大小（建桶 / 复制 / 移动）传 0，即「**已经**超出上限就不许再写」。
 *
 * `credId` 为空 / 查不到 / 配额为 0 时一律**放行**（无归属或无上限 = 无约束）。
 *
 * @param {string} credId
 * @param {{addBytes?: number}} [opts]
 * @returns {Promise<object>} 用量明细（放行时也返回，便于调用方记日志）
 * @throws {Error} status=403 / code=CREDENTIAL_QUOTA_EXCEEDED / quota={...}
 */
async function assertCredentialQuota(credId, opts) {
  const addBytes = Math.max(0, Math.floor(Number((opts && opts.addBytes) || 0) || 0));
  const usage = await credentialUsage(credId);
  if (!credId || usage.unlimited) return usage;
  if (usage.usedBytes + addBytes > usage.quotaBytes) {
    const e = new Error(
      `该 API Key 的存储空间已达上限（已用 ${humanBytes(usage.usedBytes)} / 上限 ${humanBytes(usage.quotaBytes)}），`
      + '无法继续写入；请在「系统设置 → 负载均衡」中调大上限，或清理该密钥下已有文件后再试'
    );
    e.status = 403;
    e.code = QUOTA_EXCEEDED_CODE;
    e.quota = {
      credentialId: credId,
      quotaBytes: usage.quotaBytes,
      usedBytes: usage.usedBytes,
      addBytes,
      reason: QUOTA_EXCEEDED_CODE,
    };
    throw e;
  }
  return usage;
}

/**
 * R28-02：**单桶**配额的机器可读码（与凭据级区分开，前端据此给不同文案）。
 */
const BUCKET_QUOTA_EXCEEDED_CODE = 'BUCKET_QUOTA_EXCEEDED';

/**
 * R28-02：断言**单个存储桶**的空间配额未超限；超限时抛 403。
 *
 * 为什么需要它：桶记录上的 `quotaBytes` 此前**只在界面展示** —— `Develop_Document.md`
 * 写的是「桶配额仍是**单桶上限**」、`CHANGELOG` 称其为「**单桶**限额」、界面还会把
 * `sizeBytes > quotaBytes` 的桶标成「超额」并把进度条染红，但服务端**没有任何一处**
 * 拿它拦过写入（全库 `quotaBytes` 的消费者只有「存取 / 归一化」与「展示」两类，
 * 唯一的判定是凭据级的 `assertCredentialQuota`）。于是设了 1GB 桶配额却写进 10GB
 * 不会有任何反应 —— 与 R25 那轮明确批评过的失败模式同型（「配了额度却拦不住，
 * 比没有额度更危险」）。
 *
 * 判定口径与凭据级**刻意保持一致**（便于读者只记一套规则）：
 *  - `usedBytes + addBytes > quotaBytes`（**严格大于**才拒，「正好用满」放行）；
 *  - `quotaBytes` 为 0 / 非法 = 无限制，直接放行；
 *  - 用量 = 桶的官方/列举容量（15 分钟缓存）**+ 待定增量**，理由见 `bucketPendingDelta`
 *    的说明（只读缓存会让 TTL 窗口变成无限制超额窗口）；
 *  - 未知大小（mkdir / rename / move / WebDAV COPY）传 `addBytes: 0`，即「已经超出
 *    上限就不许再写」。
 *
 * 需要 `client` 的原因：桶容量查询走 `bucketStat()`（官方 `?stats` 优先、分页列举兜底）。
 * 调用方手里本来就有客户端（`/fs` 的 `getClient(cfg)`、WebDAV 的 `requireCos()`），
 * 且该查询有缓存，因此与既有的凭据级判定共享同一份缓存，不额外打云端。
 *
 * @param {object} client 该桶的云端客户端
 * @param {object} cfg 生效桶配置（需含 provider/secretId/bucket/region/quotaBytes）
 * @param {{addBytes?: number}} [opts]
 * @returns {Promise<object|null>} 用量明细；无上限时返回 null
 * @throws {Error} status=403 / code=BUCKET_QUOTA_EXCEEDED / quota={...}
 */
async function assertBucketQuota(client, cfg, opts) {
  const quotaBytes = configStore.normalizeQuotaBytes(cfg && cfg.quotaBytes);
  if (!quotaBytes) return null; // 0 = 无限制
  const addBytes = Math.max(0, Math.floor(Number((opts && opts.addBytes) || 0) || 0));
  const st = await bucketStat(client, cfg);
  const pending = Math.max(0, pendingUsageDelta(cfg));
  const usedBytes = (Number(st && st.sizeBytes) || 0) + pending;
  if (usedBytes + addBytes > quotaBytes) {
    const e = new Error(
      `该存储桶的空间配额已达上限（已用 ${humanBytes(usedBytes)} / 上限 ${humanBytes(quotaBytes)}），`
      + '无法继续写入；请在「存储桶管理」中调大该桶配额，或清理桶内文件后再试'
    );
    e.status = 403;
    e.code = BUCKET_QUOTA_EXCEEDED_CODE;
    e.quota = {
      scope: 'bucket',
      bucket: (cfg && cfg.bucket) || '',
      quotaBytes,
      usedBytes,
      addBytes,
      estimated: Boolean(st && st.estimated),
      reason: BUCKET_QUOTA_EXCEEDED_CODE,
    };
    throw e;
  }
  return { quotaBytes, usedBytes, addBytes };
}

module.exports = {
  bucketCacheKey, bucketSizeCache, BUCKET_STAT_CACHE_MS, BUCKET_STAT_CACHE_MAX,
  pruneBucketSizeCache, getBucketStatViaApi, bucketStat,
  resolveBucketClient, mapLimit,
  // R25：按 API Key 的配额
  QUOTA_EXCEEDED_CODE, humanBytes, recordUsageDelta, pendingUsageDelta,
  credentialUsage, assertCredentialQuota,
  // R28-02：按**单个存储桶**的配额
  BUCKET_QUOTA_EXCEEDED_CODE, assertBucketQuota,
};
