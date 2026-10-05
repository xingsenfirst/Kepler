/**
 * 下载限速 —— **单一实现点**（R37）
 *
 * 三件事都收敛在本文件，别的模块只允许「取有效值」与「挂 Transform」：
 *   1. `pickEffective()`  纯函数：把若干层的限速**取最小值**，并指出是哪一层生效；
 *   2. `resolveLimit()`   组装五层（IP / API Key / 存储桶 / 用户 / 分享链接）后调 ①；
 *   3. `createThrottleTransform()`  按固定节拍切片投放的限速 Transform（共享桶，见下）。
 *
 * ## 为什么是「取最小值」
 *
 * 限速挂在**资源**上，而一次下载可能同时受多层约束（用哪个密钥、在哪个桶、
 * 谁下的、哪条链接、从哪个 IP 来）。上层设了 5MB/s、下层设了 20MB/s 时，
 * 生效值只能是 5 —— 否则「下层一改就把上层架空」，上层设置形同虚设。
 * 采用**严格取最小**后，下层的语义变成「只允许收得更紧」，与用户心智一致。
 *
 * ## 为什么桶是**共享**的（而不是每条连接一个桶）
 *
 * 每条连接一个桶只能限制「单条连接」的速率：同一用户开 10 条并发下载，
 * 每条都跑满限额 ⇒ 实际 10 倍。需求明确要求按「IP / 链接 / 用户维度建键」的
 * **字节桶表**，因此按**生效层 + 速率**建键，同一键上的所有下载共用一个桶，
 * 限的是**聚合**速率。
 *
 * ## 为什么桶表必须有界
 *
 * 键由请求内容决定（IP、链接 id……），是**外部可影响**的集合。`security.js` 里
 * `FAILS_MAX` / `FRAGMENT_CACHE_MAX` 与各 `sweep()` 记录的都是同一个教训：
 * 无界内存增长是本项目反复修的问题。故本表同时具备 **TTL 清扫**与**硬上限**
 * （超限按插入顺序淘汰最旧键，与 `createFailLock` 同款策略）。
 *
 * ## 单位口径
 *
 * 对外一律 `MB/s`（`1 MB = 1024 × 1024` 字节，与前端 `fmtSize` 同基数）；
 * 存储与计算一律**字节/秒**整数（0 或缺省 = 不限速）。
 */
const { Transform } = require('stream');
const configStore = require('./config-store');
const shareStore = require('./share-store');
const ipGuard = require('./ip-guard');
// 判据（「什么是合法的限速值」）住在叶子模块 limits.js —— 本模块与 config-store
// 都要用它，而后者不能 require 本模块（会成环）。这里只是**再导出**，调用方仍从
// throttle 取，保持「限速相关的入口都在这一个模块」。
const { MB, normalizeSpeedLimit, toMBps } = require('./limits');

/**
 * 桶表硬上限（参照 `security.FAILS_MAX`）。
 *
 * 达上限后按**插入顺序**淘汰最旧键。正常用量下不可能逼近：键的空间是
 * 「生效层 × 实体」，而实体本身受配置数量约束；只有「匿名分享链接 + 大量
 * 不同 IP」这类组合才可能堆积，且每条链接的下载入口自身还有限流器。
 */
const BUCKETS_MAX = 5000;

/** 空桶保留期：一个桶超过这段时间没被触碰就回收（配合 sweep() 定期清理） */
const BUCKET_TTL_MS = 10 * 60 * 1000;

/**
 * 投放节拍（毫秒）——本实现最关键的一个常量，它同时解决两件事（要求③）。
 *
 * 限速有两种朴素写法，都会踩坑：
 *
 *  A. **整块等**：收到 chunk 后 `setTimeout(chunkLen / rate)` 再整块放行。
 *     速率是对的，但「两次向 socket 写入」的间隔 = `chunkLen / rate`。
 *     限额 1 KB/s 而 chunk 恰好 64 KB 时，间隔 64 秒；更小的速率下会超过
 *     `DOWNLOAD_TIMEOUT_MS`（10 分钟）—— 而 `res.setTimeout` 是**无数据活动**
 *     超时，于是「限速把下载限速死了」，一个完全健康的下载被自己超时砍断。
 *
 *  B. **透支令牌桶**：允许 `tokens` 为负，越欠越多。平均速率同样正确，
 *     但仍要「等到欠账还清」才放行，间隔问题与 A 一样。
 *
 * 本实现改为**按固定节拍切片投放**：每 `SLICE_MS` 至多放行
 * `max(1, rate × SLICE_MS / 1000)` 字节。于是
 *   ① 速率仍然精确（每节拍放行量由额度决定，长程平均收敛到设定值）；
 *   ② **向 socket 写入的间隔恒 ≤ `SLICE_MS`**，无论限额多小、chunk 多大，
 *      10 分钟的无活动超时都不可能被限速自己触发；
 *   ③ 一次只持有**一个** chunk（投放完才回调 `cb`），内存不随文件增大，
 *      背压仍然沿 `pipeline` 向上游传导（不另挂 `data` 监听，要求②）。
 *
 * 代价（如实记录）：小额度的**抖动**被节拍量化 —— 速率低于 `1000 / SLICE_MS`
 * = 10 字节/秒时，每节拍至少放 1 字节，实际速率被抬到 10 B/s。这个量级
 * （0.00001 MB/s）在界面上无法被设置出来（界面以 MB/s 为单位、步长 0.1）。
 * 换来的是「限速绝不会把下载超时打成失败」。
 *
 * ## 额度为什么**不攒**（没有突发额度）
 *
 * 经典令牌桶允许闲置期间把额度攒到「1 秒的量」，于是闲置后的第一个请求可以瞬间
 * 冲掉一整秒的数据。对带宽限制这个场景，那会得到一个用户可感知的怪现象：
 * 「我设了 5 MB/s，怎么一点下载就瞬间下了 5 MB」。这里把额度上限压到**一个切片**
 * （`sliceFor(rate)`），于是有了一条**无条件成立**的不变量：
 *
 *     任意时间窗口 T 内，经过同一实体的字节数 ≤ rate × T + 一个切片
 *
 * 起始额度也给一个切片，使第一个节拍就能出数据（否则每次下载都要白等 100ms）。
 */
const SLICE_MS = 100;

/** 一个节拍最多放行多少字节（同时也是额度上限）——速率相关，故由函数给出 */
function sliceFor(rate) {
  return Math.max(1, Math.floor((rate * SLICE_MS) / 1000));
}

/** 层 → 给用户看的来源名（「已在 **API Key 管理** 中设置限速为 …」这句文案用它） */
const LAYER_LABELS = {
  credential: 'API Key 管理',
  bucket: '存储桶管理',
  user: '用户管理',
  link: '分享链接',
  ip: 'IP 地址管理',
};

/**
 * 层的优先级（高 → 低）。
 *
 * 只用于一件小事：多层**限速值相同**时，「生效来源」报哪一个。用户先看到的
 * 应该是「API Key 管理里设了 5」，而不是「IP 地址管理里也设了 5」——
 * 前者是他自己刚设的、能立刻对上号的那一处。
 */
const PRIORITY = ['credential', 'bucket', 'user', 'link', 'ip'];

/**
 * 归一化限速值 → **非负整数字节/秒**，0 = 不限速。
 * 实现与判据在 `server/limits.js`（叶子模块，供 config-store 复用而不成环）。
 */

/**
 * 从若干层里取**生效限速**（纯函数，护栏直接驱动它）。
 *
 * @param {Array<{source: string, bytesPerSec: number, key?: string, label?: string}>} layers
 *        **必须按优先级从高到低**传入（credential → bucket → user → link → ip）：
 *        取最小值时若有多层相同，**来源取更高优先的那一层**（用户先看到的是
 *        「API Key 管理里设了 5」，而不是「IP 地址管理里也设了 5」）。
 * @returns {{ limit: number, source: string, sourceLabel: string, sourceKey: string, layers: Array }}
 *   `sourceKey` 是**生效那一层的实体键**（如 `bucket:xxx`）—— 它是共享字节桶的
 *   建键依据：同一实体上的所有并发下载必须落在**同一个**桶里，限的才是聚合速率。
 */
function pickEffective(layers) {
  const active = (layers || [])
    .filter((l) => l && normalizeSpeedLimit(l.bytesPerSec) > 0)
    .map((l) => Object.assign({}, l, { bytesPerSec: normalizeSpeedLimit(l.bytesPerSec) }));
  if (!active.length) return { limit: 0, source: '', sourceLabel: '', sourceKey: '', layers: [] };
  let best = active[0];
  for (const l of active) {
    if (l.bytesPerSec < best.bytesPerSec) best = l; // 严格小于：同值保持更高优先层
  }
  return {
    limit: best.bytesPerSec,
    source: best.source,
    sourceLabel: best.label || LAYER_LABELS[best.source] || best.source,
    sourceKey: best.key || best.source,
    layers: active,
  };
}

/* ============================ 共享字节令牌桶 ============================ */

/** key -> { credit, cap, rate, active, updatedAt }；速率一变即换桶 */
const buckets = new Map();
let lastSweep = 0;

/** 表的有界性：TTL 清扫 + 硬上限淘汰（两条都要有，缺一即无界） */
function sweep(now) {
  if (now - lastSweep >= BUCKET_TTL_MS) {
    lastSweep = now;
    for (const [k, b] of buckets) {
      if (now - b.updatedAt > BUCKET_TTL_MS) buckets.delete(k);
    }
  }
  while (buckets.size > BUCKETS_MAX) {
    // Map 的迭代顺序 = 插入顺序 → 淘汰最早插入的键（与 createFailLock 同款）
    const oldest = buckets.keys().next().value;
    buckets.delete(oldest);
  }
}

function bucketFor(key, rate) {
  const now = Date.now();
  sweep(now);
  const k = String(key);
  let b = buckets.get(k);
  // 除了按 key 取，还要比一次 rate：管理员改了限速值必须立刻换一个新桶，
  // 否则旧桶的 credit（按旧速率攒的）会短暂地放行一个不符合新速率的量。
  if (!b || b.rate !== rate) {
    const cap = sliceFor(rate);
    b = { credit: cap, cap, rate, active: 0, updatedAt: now };
    buckets.set(k, b);
  }
  return b;
}

/**
 * 限速 Transform 工厂 —— 与 `download-stream.js` 的 `meter` 同一个写法：
 * 显式 Transform、并入同一条 `pipeline`、**不另挂 `data` 监听**（要求②）。
 *
 * 实现是**按 `SLICE_MS` 节拍切片投放**（理由见 `SLICE_MS` 的注释：整块等 / 透支
 * 令牌桶两种写法都会让「两次写入的间隔」无上界，从而误触 10 分钟无活动超时）。
 *
 * 时序：`transform(chunk, …)` 只把 chunk 记下来**不立刻回调**，于是上游被背压
 * 停住 —— 同一时刻在途数据只有一个 chunk。随后由节拍器按额度切片放行，
 * 全部放完才调用 `cb()`，这时上游才会送来下一块。
 *
 * @param {{key: string, bytesPerSec: number}} o
 * @returns {Transform|null} 不限速时返回 null（调用方据此**完全跳过**这一环）
 */
function createThrottleTransform({ key, bytesPerSec }) {
  const rate = normalizeSpeedLimit(bytesPerSec);
  if (!rate) return null;
  const b = bucketFor(key, rate);
  /**
   * 并发下载数（本桶）。
   *
   * 每个节拍的额度是**整桶共享**的，若每条连接都按「一个切片的量」取，先触发的那条
   * 会把整个节拍吃光、后来者一个字节都拿不到 —— 实测两条并发时是「一条满速、
   * 另一条半速甚至更少」，虽然聚合速率没超，但用户会看到「两个下载一快一慢」。
   * 这里按在跑的数量均分节拍额度，使**并发下载体验一致**（聚合上限不变）。
   */
  b.active = (b.active || 0) + 1;

  let buf = null;   // 在途 chunk（未放完的部分）
  let cbPending = null; // 放完才回调，形成对上游的背压
  let timer = null;

  const t = new Transform({
    transform(chunk, _enc, cb) {
      buf = chunk;
      cbPending = cb;
      // 立刻尝试投放一片，而不是先等一个节拍：否则**每个 chunk** 都要白等
      // `SLICE_MS` 才出第一个字节（64KB 一块的文件会累积成明显的额外延迟）。
      // `pump()` 自己会在没放完时重新定时。
      pump();
    },
  });

  function refill(now) {
    b.credit = Math.min(b.cap, b.credit + ((now - b.updatedAt) * b.rate) / 1000);
    b.updatedAt = now;
  }

  /** 一个节拍：按当前额度放行一片；额度不足就等下一个节拍（credit 永不为负） */
  function pump() {
    timer = null;
    if (!buf || t.destroyed) return;
    const now = Date.now();
    refill(now);
    const avail = Math.floor(b.credit);
    if (avail <= 0) { arm(); return; }
    // 本条连接在本节拍能拿到的份额（并发越多，份额越小；下限 1 保证仍在推进）
    const perTick = Math.max(1, Math.floor(b.cap / Math.max(1, b.active || 1)));
    const n = Math.min(avail, perTick, buf.length);
    b.credit -= n;
    t.push(buf.subarray(0, n));
    buf = n >= buf.length ? null : buf.subarray(n);
    if (!buf) {
      const cb = cbPending;
      cbPending = null;
      if (cb) cb();
      return;
    }
    arm();
  }

  function arm() {
    if (!timer && !t.destroyed) timer = setTimeout(pump, SLICE_MS);
  }

  // 销毁时必须清掉待触发的定时器：否则一个已断开的下载仍会留着计时器空转
  // （大量并发断连时是可见的开销），而且 `t.push` 会打到已销毁的流上。
  t.on('close', () => {
    if (timer) { clearTimeout(timer); timer = null; }
    buf = null;
    cbPending = null;
    // 退出并发计数：剩下的连接立刻恢复各自应得的份额
    b.active = Math.max(0, (b.active || 1) - 1);
  });
  return t;
}

/* ============================ 组装各层 ============================ */

/**
 * 解析一次下载的**生效限速**。
 *
 * @param {object} ctx
 *  - `ip`            客户端 IP **字符串**（`security.clientIp(req)`；形状须与
 *                    `ipGuard.evaluate()` 一致 —— 详见 `ipGuard.speedLimitFor` 的注释）
 *  - `method`        HTTP 方法（IP 规则可按方法过滤），默认 `'GET'`
 *  - `credentialId`  本次下载实际使用的密钥 id
 *  - `bucketId`      本地桶 id
 *  - `userId`        归属用户 **id**
 *  - `userName`      归属用户 **用户名**（分享链接只快照了创建者的用户名，
 *                    没有他的 id；两种标识都收下，解析到同一条记录后仍用 id 建键，
 *                    于是「同一个人」无论走哪个入口都落在同一个字节桶上）
 *  - `linkId`        分享链接 id（`/fs/download` 无链接）
 * @returns {{limit: number, source: string, sourceLabel: string, sourceKey: string, layers: Array}}
 */
function resolveLimit(ctx = {}) {
  const layers = [];

  // ① IP 层：多段同时命中时**取最严的那条**（ip-guard 内部已收敛）
  const ipHit = ipGuard.speedLimitFor(ctx.ip, ctx.method || 'GET', ctx.bucketId);
  if (ipHit && ipHit.bytesPerSec > 0) {
    layers.push({ source: 'ip', key: 'ip:' + ipHit.target, label: 'IP 地址管理', bytesPerSec: ipHit.bytesPerSec });
  }

  // ② API Key 层
  if (ctx.credentialId) {
    const c = configStore.listCredentials().credentials.find((x) => x.id === ctx.credentialId);
    if (c) layers.push({ source: 'credential', key: 'cred:' + c.id, bytesPerSec: c.speedLimit });
  }

  // ③ 存储桶层
  if (ctx.bucketId) {
    const b = configStore.listBuckets().buckets.find((x) => x.id === ctx.bucketId);
    if (b) layers.push({ source: 'bucket', key: 'bucket:' + b.id, bytesPerSec: b.speedLimit });
  }

  // ④ 用户层（两种标识都认，见函数头注释）
  const u = ctx.userId
    ? configStore.getUserById(ctx.userId)
    : (ctx.userName ? (configStore.listUsers().find((x) => x.username === ctx.userName) || null) : null);
  if (u) layers.push({ source: 'user', key: 'user:' + u.id, bytesPerSec: u.speedLimit });

  // ⑤ 分享链接层（「文件分享」与「链接管理」是同一条记录上的同一个字段）
  if (ctx.linkId) {
    const l = shareStore.get(ctx.linkId);
    if (l) layers.push({ source: 'link', key: 'link:' + l.id, bytesPerSec: l.speedLimit });
  }

  // 优先级顺序刻意与上面的 push 顺序一致（IP 层虽然最独立，但同值时优先报上层来源）
  const ordered = layers.sort((a, b) => PRIORITY.indexOf(a.source) - PRIORITY.indexOf(b.source));
  return pickEffective(ordered);
}

/**
 * 三个下载出口（`/fs/download`、`/s/:id/dl`、WebDAV GET）接入限速的**唯一入口**：
 * 「解析生效限速 → 造出限速环节」一步完成，调用方只多一行、不重复任何判定。
 *
 * @param {object} ctx 同 {@link resolveLimit}
 * @returns {Transform|null} 不限速（所有层都没设）时返回 `null`，
 *          调用方据此**完全跳过**这一环节，零开销。
 */
function makeThrottle(ctx) {
  const r = resolveLimit(ctx);
  if (!r.limit) return null;
  return createThrottleTransform({ key: r.sourceKey, bytesPerSec: r.limit });
}

/** 桶表规模（护栏用它断言「有界」；也是运行期自检的读数） */
function bucketCount() { return buckets.size; }

/** 仅供测试：清空桶表与清扫计时 */
function _resetForTest() {
  buckets.clear();
  lastSweep = 0;
}

module.exports = {
  MB,
  BUCKETS_MAX,
  BUCKET_TTL_MS,
  SLICE_MS,
  sliceFor,
  LAYER_LABELS,
  normalizeSpeedLimit,
  toMBps,
  pickEffective,
  resolveLimit,
  makeThrottle,
  createThrottleTransform,
  bucketCount,
  _resetForTest,
};
