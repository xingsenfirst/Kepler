/**
 * 路由：监控统计（速率 / 存储用量 / 汇总 / 操作日志） + 健康检查
 */
const { express, configStore, statsStore } = require('./_context');
const secureStore = require('../secure-store');
const { LIMITS } = require('../limits');
const { getClient, p, translateError, listAll } = require('../cos');
const { requireConfig, requireAdmin, bucketCacheKey } = require('./_shared');

const router = express.Router();

/* ==================== 容量缓存（PERF-05） ====================
 *
 * 旧实现是**单槽**变量 `{key,t,data}`：多桶交替查询时每换一次桶就整槽失效，
 * 命中率趋近于 0，且不可缓存多桶结果。改为按 `bucketCacheKey` 索引的 Map +
 * LRU 上限（最多 16 桶），并叠加「同桶并发请求共享同一个 in-flight Promise」，
 * 避免同一次页面刷新对每个桶重复发起昂贵的云端调用。
 */
const STORAGE_TTL = 15 * 60 * 1000; // 官方统计每日更新，15 分钟足够且更省调用（PERF-05）
const STORAGE_CACHE_MAX = 16;
/** @type {Map<string, {t:number, data:object}>} */
const storageCacheMap = new Map();
/** @type {Map<string, Promise<object>>} */
const storageInflight = new Map();

function cacheGet(key) {
  const hit = storageCacheMap.get(key);
  if (!hit) return null;
  if (Date.now() - hit.t >= STORAGE_TTL) { storageCacheMap.delete(key); return null; }
  // LRU：命中即移到末尾
  storageCacheMap.delete(key);
  storageCacheMap.set(key, hit);
  return hit.data;
}

function cacheSet(key, data) {
  storageCacheMap.delete(key);
  storageCacheMap.set(key, { t: Date.now(), data });
  while (storageCacheMap.size > STORAGE_CACHE_MAX) {
    storageCacheMap.delete(storageCacheMap.keys().next().value);
  }
}

/**
 * 用量缓存增量修正：上传/删除后立即修正本地缓存，使状态栏无需等待官方统计（每日更新）即可反映变化。
 *
 * @param {number} delta 正数=新增字节，负数=释放字节
 * @param {object} [cfg] 目标桶配置（用于计算缓存键）。缺失时不做修正 ——
 *   宁可让数字 TTL 到期后再刷新，也不能把增量加到**错误的桶**上。
 */
function adjustStorageCache(delta, cfg) {
  if (!delta || !cfg) return;
  let key;
  try { key = bucketCacheKey(cfg); } catch (e) { return; }
  const hit = storageCacheMap.get(key);
  if (!hit || !hit.data) return;
  hit.data.usedBytes = Math.max(0, (hit.data.usedBytes || 0) + delta);
  hit.data.statTime = new Date().toISOString();
  hit.t = Date.now();
}

// 实时上传/下载速率（近 10 秒平均）
router.get('/stats/speed', (req, res) => {
  res.json(statsStore.speed());
});

async function queryStorage(cfg, cacheKey) {
  const client = getClient(cfg);
  try {
    const data = await p(client, 'request', { Method: 'GET', Bucket: cfg.bucket, Region: cfg.region, action: 'stats' });
    const body = data && (data.Body || data.body);
    if (typeof body === 'string') {
      const sizeM = body.match(/<Size>([^<]+)<\/Size>/);
      const objM = body.match(/<ObjectNumber>([^<]+)<\/ObjectNumber>/);
      if (!sizeM && !objM) throw new Error('响应格式无法解析');
      return {
        usedBytes: sizeM ? Number(sizeM[1]) : 0,
        objectCount: objM ? Number(objM[1]) : 0,
        source: 'GetBucketStat',
        estimated: false,
        statTime: new Date().toISOString(),
      };
    }
    if (body && typeof body === 'object') {
      if (body.Size === undefined && body.ObjectNumber === undefined) throw new Error('响应格式无法解析');
      return {
        usedBytes: Number(body.Size) || 0,
        objectCount: Number(body.ObjectNumber) || 0,
        source: 'GetBucketStat',
        estimated: false,
        statTime: new Date().toISOString(),
      };
    }
    throw new Error('响应格式无法解析');
  } catch (e) {
    // 回退：分页列出对象累计用量（估算值，上限受 PERF-04 约束）
    const items = await listAll(client, cfg, '', { cap: LIMITS.SCAN });
    const usedBytes = items.reduce((s, x) => s + x.size, 0);
    return {
      usedBytes,
      objectCount: items.length,
      source: 'ListScan',
      estimated: true,
      statTime: new Date().toISOString(),
    };
  }
}

// 存储用量（GetBucketStat，按桶缓存；失败时回退为列出生存量估算）
router.get('/stats/storage', async (req, res) => {
  try {
    const cfg = requireConfig();
    // 缓存键含 provider/凭据/桶/地域 —— 切换桶或多云同名桶时不会串用旧数字
    const cacheKey = bucketCacheKey(cfg);
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    // 同桶并发请求合并：共享同一个 in-flight Promise，避免重复打云端（PERF-05）
    let inflight = storageInflight.get(cacheKey);
    if (!inflight) {
      inflight = queryStorage(cfg, cacheKey)
        .then((out) => { cacheSet(cacheKey, out); return out; })
        .finally(() => { storageInflight.delete(cacheKey); });
      storageInflight.set(cacheKey, inflight);
    }
    res.json(await inflight);
  } catch (e) {
    const err = e.status ? e : translateError(e);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// 汇总统计：容量 + 流量 + 请求（7 天）
router.get('/stats/summary', async (req, res) => {
  try {
    const cfg = configStore.get();
    const quotaBytes = cfg ? cfg.quotaBytes : 0; // 0 = 无限制
    res.json(Object.assign({ quotaBytes }, statsStore.summary()));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 操作日志（**仅管理员**）
//
// SEC-07：日志 detail 字段包含用户名、客户端 IP、对象键、桶名
// （如 auth.login / fs.delete / share.download），对普通用户开放等于泄露
// 全部存储桶清单与其它用户的完整操作轨迹，违反「普通用户仅见自己可见资源」的约定。
router.get('/stats/logs', requireAdmin, async (req, res) => {
  const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 200));
  const logs = await statsStore.getLogs({ limit, level: String(req.query.level || ''), action: String(req.query.action || '') });
  res.json({ logs });
});

/* ============================ 健康检查 ============================ */

router.get('/health', (req, res) => {
  const cfg = configStore.get();
  // SEC-09：把「敏感数据文件写入失败」与「文件损坏」状态一并暴露，
  // 否则 enc-meta.json 这类唯一解密凭据的故障将完全静默（密文永久不可解）。
  const out = {
    ok: true,
    time: new Date().toISOString(),
    configured: Boolean(cfg && cfg.secretId && cfg.secretKey),
    corrupted: configStore.isCorrupted(),
  };
  const secureErr = secureStore.getLastWriteError();
  if (secureErr) { out.ok = false; out.secureWriteError = secureErr; }
  const corruptFiles = secureStore.corruptList();
  if (corruptFiles.length) { out.ok = false; out.corruptFiles = corruptFiles; }
  res.status(out.ok ? 200 : 503).json(out);
});

module.exports = router;
module.exports.adjustStorageCache = adjustStorageCache;
