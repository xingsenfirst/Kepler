/**
 * 搜索候选集缓存：带 TTL、写操作即失效、**只在进程内**
 *
 * ## 它是什么（以及刻意不是什么）
 *
 * 它不是「本地元数据索引」。索引意味着**可信真值**，于是要求每一处写入口都同步维护它
 * —— 漏一处即永久不一致，而且不一致是静默的（用户只会觉得「搜不到」或「搜出已删的」）。
 *
 * 这里做的是**候选集**：一份明确可能过期的对象键清单，只用于省掉「重复搜索时重新翻页」，
 * 任何时候都不充当「桶里有什么」的判据。接受最终一致之后，「漏一处即永久不一致」这个
 * 否决理由就自动失效了 —— 过期由 TTL 自愈，最坏情况只是慢一点、旧几秒。
 *
 * ## 失效接线只有一处
 *
 * 订阅 {@link listCache.onMutate}，而 `cos.p()` 是全项目唯一的云端出口（`p()` 在**成功与
 * 失败两条分支**上都调 `listCache.noteCall()`），因此 routes / fs-gateway / WebDAV 的全部
 * 写入路径天然覆盖，**不需要逐个接口登记**。将来新增缓存也只需订阅同一个点。
 *
 * ## 唯一的盲区：站外写入
 *
 * 控制台、生命周期规则、别的工具改了桶，本系统收不到任何信号 —— 只能靠 TTL 兜底，
 * 把「永久不一致」降级成「最多陈旧 `SEARCH_CANDIDATES_TTL_MS` 毫秒」。
 *
 * ## 为什么不做持久化
 *
 * 与 `list-cache.js` 同一条理由：一旦落盘就要面对一致性、跨用户可见性、敏感 key 存储
 * 三件事。进程内缓存重启即空，天然没有这些问题。
 *
 * ## 容量与降级
 *
 * 单条目超过 `SEARCH_CANDIDATES_MAX_ITEMS` 时**整个条目被丢弃**（并留一条 warn 日志），
 * 该子树退回「逐页列举 + 秒级页缓存」的既有行为。宁可退化，也不要让一个大桶把进程内存
 * 吃满。默认上限 10000 与「1 万对象以内收益最明显、再大就该上后台扫描作业」这一判断同源。
 */
const listCache = require('./list-cache');

/** 默认 TTL 10 秒；`SEARCH_CANDIDATES_TTL_MS=0` 可整体关闭（排查数据新鲜度问题时的安全阀） */
const DEFAULT_TTL_MS = 10000;
/** 条目数上限（与 `list-cache.js` 的 MAX_ENTRIES 同型的无界 Map 内存增长防护） */
const MAX_ENTRIES = 4;
/** 单条目键数上限（超限即整条丢弃，见文件头「容量与降级」） */
const DEFAULT_MAX_ITEMS = 10000;
/** 键内分隔符：桶标识 / 前缀里不可能出现，避免拼接歧义 */
const SEP = '\u0000';

const store = new Map(); // key -> { at, ident, prefix, scope, items[], nextMarker, complete }
/**
 * 「该子树太大、不值得物化」的标记（key -> 写入时刻）。
 *
 * 单独一张表而不是 `items: []` 的空条目，是为了两件事：
 *  - `get()` 一眼返回 null，调用方不必理解这个状态；
 *  - **防止中途重新开始物化** —— 若被丢弃后又从当前页重新积累，物化出来的会是一段
 *    「中间窗口」而非从头开始的连续前缀，续扫时会静默漏掉窗口之前的所有对象。
 */
const tooBig = new Map();

/**
 * 「子树超出物化上限」的留痕。
 *
 * 这条日志有实际用途：它正是「该上后台扫描作业了」的信号 —— 桶里出现一个超过
 * `SEARCH_CANDIDATES_MAX_ITEMS` 的前缀时，缓存会自动退化成逐页列举，运维需要知道
 * 「不是缓存坏了，是这个子树太大」。
 *
 * 惰性 require + try/catch：缓存模块不该因为日志通道未就绪而影响搜索本身，
 * 也避免在模块加载期引入与 `stats-store` 的加载序耦合。
 */
function warnTooBig(count) {
  try {
    // eslint-disable-next-line global-require
    const statsStore = require('./stats-store');
    statsStore.addLog({
      action: 'search.candidates',
      level: 'warn',
      detail: `子树候选集超过 ${maxItems()} 个对象（已物化 ${count} 个），该前缀退回逐页列举：`
        + `搜索仍正确，但重复搜索不再免费。若该前缀长期这么大，应考虑后台扫描作业。`,
    });
  } catch (e) { /* 日志失败不影响主流程 */ }
}

function ttlMs() {
  const raw = process.env.SEARCH_CANDIDATES_TTL_MS;
  if (raw === undefined || raw === '') return DEFAULT_TTL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_TTL_MS;
}

function maxItems() {
  const raw = process.env.SEARCH_CANDIDATES_MAX_ITEMS;
  if (raw === undefined || raw === '') return DEFAULT_MAX_ITEMS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_MAX_ITEMS;
}

/** 缓存是否启用（TTL=0 时整体关闭，便于线上快速止血） */
function enabled() {
  return ttlMs() > 0;
}

/**
 * 构造缓存键：桶标识 + 前缀 + 范围，任一项不同即不同键。
 *
 * `ident` 必须传 `bucketCacheKey(cfg)`（`provider|secretId|bucket|region`）—— 与
 * `list-cache.keyOf` 同一条理由（R11-13）：多云下不同厂商 / 不同密钥可能绑定**同名桶**，
 * 只按桶名作键会让 A 厂商的搜索结果在 TTL 内被当成 B 厂商的返回（串味）。
 *
 * `scope` 必须传（`'current'` / `''`）：两者的列举语义不同（delimiter `'/'` vs `''`），
 * 同一 prefix 会得到两套完全不同的键集合。
 */
function keyOf(ident, prefix, scope) {
  return [ident, prefix, scope || ''].join(SEP);
}

/** 该子树是否已被判定为「太大、不物化」（且仍在 TTL 内） */
function isTooBig(key, now = Date.now()) {
  if (!tooBig.has(key)) return false;
  if (now - tooBig.get(key) > ttlMs()) { tooBig.delete(key); return false; }
  return true;
}

/**
 * 取条目。**返回的是存储中的对象本身**，调用方**不得就地修改**（尤其 `items`）——
 * 需要追加请 `concat` 出新数组再 {@link put}，否则会绕过容量上限的检查。
 *
 * @returns {{ident:string,prefix:string,scope:string,items:Array,nextMarker:string,
 *            complete:boolean,at:number}|null} 未命中 / 已过期 / 已判太大 → null
 */
function get(key) {
  if (!enabled()) return null;
  const e = store.get(key);
  if (!e) return null;
  // TTL 从**首次物化**算起，命中时不续期。续期会让热条目永不失效，
  // 于是站外写入的陈旧窗口可以无限延长 —— 正是这条缓存要避免的事。
  if (Date.now() - e.at > ttlMs()) { store.delete(key); return null; }
  return e;
}

/**
 * 写入 / 覆盖条目。
 *
 * `at` **沿用首次物化的时刻**（不被覆盖），语义见 {@link get}。
 * 超过单条目上限 → 删除该键、登记 tooBig、返回 false；此后在 TTL 内不再接受该键的写入。
 *
 * @returns {boolean} 是否真的写入了（false = 关闭 / 太大 / 被拒）
 */
function put(key, entry) {
  if (!enabled()) return false;
  const now = Date.now();
  if (isTooBig(key, now)) return false;
  const items = Array.isArray(entry && entry.items) ? entry.items : [];
  if (items.length > maxItems()) {
    store.delete(key);
    tooBig.set(key, now);
    warnTooBig(items.length);
    return false;
  }
  const prev = store.get(key);
  store.set(key, {
    ident: entry.ident, prefix: entry.prefix, scope: entry.scope || '',
    items, nextMarker: entry.nextMarker || '', complete: Boolean(entry.complete),
    at: prev ? prev.at : now,
  });
  trim();
  return true;
}

/** 清完过期项仍超限：淘汰最早物化的（Map 保持插入顺序，更新已有键不改变其位置） */
function trim() {
  sweepTooBig();
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next();
    if (oldest.done) break;
    store.delete(oldest.value);
  }
}

/** 回收过期的 tooBig 标记（否则这张表会随不同 prefix 单调增长） */
function sweepTooBig(now = Date.now()) {
  let n = 0;
  for (const [k, at] of tooBig) {
    if (now - at > ttlMs()) { tooBig.delete(k); n += 1; }
  }
  return n;
}

/**
 * 失效某个桶的全部候选集。
 *
 * 复用 `list-cache.bucketIdentMatches()` 而不是另写一份：那里定义了「桶名恒为标识的
 * 倒数第 2 段」与「同名桶的所有厂商一并失效」这两条口径，两处各写一份必然漂移。
 *
 * @param {string} bucket 桶名（`p()` 回调里给的就是桶名）
 * @returns {number} 被清除的条目数（便于测试断言）
 */
function drop(bucket) {
  if (!bucket) return 0;
  let n = 0;
  for (const [k, e] of store) {
    if (listCache.bucketIdentMatches(String(e.ident), String(bucket))) { store.delete(k); n += 1; }
  }
  for (const k of tooBig.keys()) {
    // tooBig 只登记了键，桶维度需要从键里取（键首段即 ident）
    if (listCache.bucketIdentMatches(String(k).split(SEP)[0], String(bucket))) tooBig.delete(k);
  }
  return n;
}

/**
 * 有序数组中「第一个 key 大于 cursor」的下标（二分）。
 *
 * 游标语义与对象存储一致：`Marker` 是**独占**的（返回大于它的 key）。因此这里的比较
 * 必须是**严格大于**：用 `>=` 会让续扫重复返回刚刚处理过的那个对象。
 * 重复键（某目录既作为 0 字节占位对象出现在 Contents、又作为 CommonPrefixes 出现）
 * 取**首个**，与 `Marker` 的行为一致 —— 两个都不会被返回。
 */
function firstAfter(items, cursor) {
  if (!cursor) return 0;
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (items[mid].key > cursor) hi = mid; else lo = mid + 1;
  }
  return lo;
}

function clear() { store.clear(); tooBig.clear(); }
function size() { return store.size; }
function tooBigSize() { return tooBig.size; }

/**
 * 失效接线：**全模块唯一一处**。
 *
 * `cos.p()` → `listCache.noteCall()` → 本订阅者，链路上没有任何逐接口登记。
 * 订阅者自身抛错绝不能影响主流程 —— `list-cache` 已对订阅者做了 try/catch，
 * 这里仍显式收口一次，避免将来改动订阅协议时把异常抛回云端调用链。
 */
listCache.onMutate((method, params) => {
  try { drop(params && params.Bucket); } catch (e) { /* 缓存失效失败不影响主流程 */ }
});

module.exports = {
  DEFAULT_TTL_MS, MAX_ENTRIES, DEFAULT_MAX_ITEMS,
  ttlMs, maxItems, enabled, keyOf, get, put, isTooBig, firstAfter,
  drop, clear, size, tooBigSize, sweepTooBig,
};
