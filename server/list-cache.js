/**
 * 目录列举短缓存（进程内、短 TTL、写操作即失效）
 *
 * ## 定位：只用于「加速重复刷新」，**绝不作为真值来源**
 *
 * 对象存储没有变更通知，任何本地缓存天生就可能与云端不一致。因此这里刻意把
 * TTL 压到秒级，并且**任何写操作都会立刻失效整个桶**——宁可少命中，也不能
 * 让用户看到「已删除的文件还在 / 刚上传的文件看不见」。
 *
 * 与「本地元数据索引 + dirRevision 增量同步」方案的取舍：
 * 后者要求**每一处写入口**都自增版本号（本项目有 15 个写入口，漏一处即
 * 静默永久不一致）；这里改成在 `cos.p()` 这一个咽喉点按「方法是否为写」统一
 * 失效，读方法用白名单判定，**未知方法一律按写处理**（失败时宁可多失效）。
 *
 * ## 为什么不做持久化
 * 一旦落盘就要面对一致性、跨用户可见性、敏感 key 存储三件事。进程内缓存
 * 重启即空，天然没有这些问题。
 */

/** 默认 TTL 3 秒；`LIST_CACHE_TTL_MS=0` 可整体关闭（排查数据新鲜度问题时的安全阀） */
const DEFAULT_TTL_MS = 3000;
/** 条目上限（FUN-12 同型的无界 Map 内存增长防护） */
const MAX_ENTRIES = 200;
/** 键内分隔符：桶名里不可能出现，避免拼接歧义 */
const SEP = '\u0000';

/**
 * 只读方法白名单。不在名单内的方法**一律按写操作处理** ——
 * 这样将来新增任何云端调用都不用记得回来登记，缺省即安全。
 */
const READ_METHODS = new Set([
  'getBucket', 'headObject', 'headBucket', 'getBucketAcl', 'getService',
  'multipartList', 'multipartListPart', 'getObject', 'getObjectStream',
]);

const store = new Map(); // key -> { at: number, value: object }

/**
 * 写操作的外部订阅者（PERF-01）
 *
 * 分片列举缓存等模块也需要"云端一写就失效"，但它们不在本模块里，
 * 与其各自去 cos.js 里加钩子，不如在这里提供一个订阅点 —— 咽喉点仍然只有
 * `cos.p()` 一处，不会因为新增缓存而扩散成多处。
 *
 * @param {(method: string, params: object) => void} fn
 * @returns {() => void} 取消订阅
 */
const mutateSubscribers = new Set();
function onMutate(fn) {
  if (typeof fn === 'function') mutateSubscribers.add(fn);
  return () => mutateSubscribers.delete(fn);
}

function ttlMs() {
  const raw = process.env.LIST_CACHE_TTL_MS;
  if (raw === undefined || raw === '') return DEFAULT_TTL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_TTL_MS;
}

/** 缓存是否启用（TTL=0 时整体关闭，便于线上快速止血） */
function enabled() {
  return ttlMs() > 0;
}

/**
 * 构造缓存键：桶标识 + 列举参数，任一项不同即不同键。
 *
 * R11-13：首参是「**桶标识**」而不一定是桶名 —— 调用方应传
 * `bucketCacheKey(cfg)`（`provider|secretId|bucket|region`）。多云下不同厂商/不同
 * 密钥可能绑定**同名桶**，只按桶名作键时 A 厂商的列举结果会在 TTL 内被当成
 * B 厂商的结果返回（与 `_shared.js` 的 `bucketCacheKey` 是同一条理由）。
 * 历史/测试里直接传桶名仍然可用（见 `invalidateBucket` 的兼容匹配）。
 *
 * R8-11：`kind` 是**调用方命名空间**，必须传 —— 缓存键描述的是"哪一次列举"，
 * 而不是"哪一组参数"。`/fs/list` 与 `/fs/search` 会以相同的五元组（`maxKeys=1000`
 * + 同一 delimiter）打到同一个桶，但两者缓存的**载荷结构不兼容**：
 *   · list   → `{ prefix, contents[], prefixes[{…}], isTruncated, nextMarker }`
 *   · search → `{ items[{key,size,lastModified}], prefixes[string], nextMarker, … }`
 * 命中错配时，search 读 `page.items` 得 undefined → `for…of` 抛 TypeError →
 * 500「操作失败」；反方向则 list 读 `r.contents` 得 undefined → **目录静默显示为空**。
 * 而本缓存是进程级共享的，任一客户端触发后会影响其他用户整整一个 TTL。
 *
 * 放在末尾（而非开头）是为了让 `invalidateBucket()` 的 `${bucket}\0` 前缀匹配继续成立。
 */
function keyOf(bucket, prefix, marker, maxKeys, delimiter, kind = '') {
  return [bucket, prefix, marker, maxKeys, delimiter, kind].join(SEP);
}

function get(key) {
  const ttl = ttlMs();
  if (ttl <= 0) return null;
  const e = store.get(key);
  if (!e) return null;
  if (Date.now() - e.at > ttl) { store.delete(key); return null; }
  return e.value;
}

function set(key, value) {
  if (ttlMs() <= 0) return;
  sweep();
  // 清完过期项仍超限：淘汰最早插入的（Map 保持插入顺序）
  while (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next();
    if (oldest.done) break;
    store.delete(oldest.value);
  }
  store.set(key, { at: Date.now(), value });
}

/** 清理已过期条目；返回清理数量 */
function sweep(now = Date.now()) {
  const ttl = ttlMs();
  let n = 0;
  for (const [k, e] of store) {
    if (now - e.at > ttl) { store.delete(k); n += 1; }
  }
  return n;
}

/**
 * 失效某个桶的全部列举缓存。
 * @returns {number} 被清除的条目数（便于测试断言）
 */
/**
 * R12-12：从缓存键的桶维度里取出桶名。
 *
 * 此前 `bucketIdentMatches` 里硬编码「4 段、第 3 段是桶名」，而段数由**另一个文件**
 * 的 `bucketCacheKey()` 决定（`_shared.js`）。将来给它加第 5 个维度是很自然的演进，
 * 而那时 `parts.length === 4` 恒假 → `invalidateBucket()` 对所有生产键**静默返回 0**
 * —— 写完对象后列举不刷新，且没有任何报错。
 *
 * 段序约定改为「桶名恒为**倒数第 2 段**」（region 永远在最后），于是加维度不会失效。
 * 唯一定义点在这里，由 `tests/invariants.test.js` 的联动护栏与 `bucketCacheKey` 对拍。
 *
 * @param {string} ident 形如 `<…>|bucket|region` 或纯桶名
 */
function bucketOfIdent(ident) {
  const parts = String(ident).split('|');
  if (parts.length === 1) return parts[0];
  return parts[parts.length - 2];
}

/**
 * 键的桶维度是否属于给定桶（R11-13）。
 *
 * 兼容两种形态：
 *  - 纯桶名（`keyOf('bkt', …)`，测试与历史调用直接用它）；
 *  - `bucketCacheKey()` 的 `<…>|bucket|region`（生产调用方传它，段数可变 —— 见
 *    {@link bucketOfIdent}）。
 *
 * 失效刻意取**保守**口径：同名桶的所有厂商条目一并失效。少失效会让 A 厂商的
 * 列举结果被 B 厂商读到（串味），多失效只是重建一次缓存，代价方向安全。
 */
function bucketIdentMatches(ident, bucket) {
  if (ident === bucket) return true;
  return bucketOfIdent(ident) === bucket;
}

function invalidateBucket(bucket) {
  if (!bucket) return 0;
  let n = 0;
  for (const k of store.keys()) {
    if (bucketIdentMatches(String(k).split(SEP)[0], bucket)) { store.delete(k); n += 1; }
  }
  return n;
}

/**
 * 判断一次云端调用是否为写操作（写操作需失效该桶缓存）。
 * @param {string} method
 * @param {object} [params]
 */
function isMutating(method, params) {
  if (method === 'request') {
    // 底层 request 可发任意方法；只有明确 GET 才算读
    return String((params && params.Method) || '').toUpperCase() !== 'GET';
  }
  return !READ_METHODS.has(method);
}

/**
 * 在每次云端调用后登记：写操作立即失效该桶缓存。
 * `cos.p()` 是全项目唯一调用云端的地方，挂在这里即可覆盖 routes /
 * fs-gateway / webdav 全部写入路径，不需要逐个接口登记。
 */
function noteCall(method, params) {
  if (!isMutating(method, params)) return 0;
  const n = invalidateBucket(params && params.Bucket);
  for (const fn of mutateSubscribers) {
    try { fn(method, params); } catch (e) { /* 订阅者异常绝不能影响主流程 */ }
  }
  return n;
}

function clear() { store.clear(); }
function size() { return store.size; }

module.exports = {
  DEFAULT_TTL_MS, MAX_ENTRIES, READ_METHODS,
  enabled, ttlMs, keyOf, get, set, sweep,
  invalidateBucket, isMutating, noteCall, onMutate,
  // R12-12：桶维度的解析唯一定义点（供护栏与 bucketCacheKey 对拍）
  bucketOfIdent, bucketIdentMatches,
  clear, size,
};
