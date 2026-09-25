/**
 * 本地收口原语：去抖合并写（`debouncedPersist`）与并发合并读（`singleFlight`）
 *
 * ## 为什么要有这个文件
 *
 * 第 14 轮的四条性能项（R14-08 / R14-09 / R14-10 / R14-12）表面是四个问题，
 * 本质是同一件事：**某条高频路径缺少「去抖 / 缓存 / 并发合并」中的某一层**。
 * 项目里已经有两份可参考的实现 —— `config-store.js` 的去抖写、
 * `routes/stats.js` 的 `storageInflight` —— 但两者都各自内嵌在模块里。
 * 再按需要内联第三、第四份，就是本项目反复踩过的「同一逻辑多份实现」，
 * 必然出现「改一处漏一处」。故收敛为两个原语，本文件是它们的**唯一实现点**
 * （报告 ANALYSIS-ROUND14 §3.2(1) 的收敛建议）。
 *
 * 报告把这它写作 `lib/write-coalesce.js`；本项目服务端模块一律位于 `server/`
 * （`docs-sync` 的目录结构与模块扫描只认这里），故落点为 `server/coalesce.js`，
 * 原语语义与报告一致。
 *
 * ## 与 `secure-store` 的关系
 *
 * 只依赖它的 `exitPathWritable()` —— 退出路径「只写不建」的唯一判据。
 * 这条纪律的代价历史上很具体：测试收尾 / 运维清理刚把 `data/` 删掉，退出钩子
 * 又把它整份重建并写回文件，本机因此悄悄累积过 134 个泄漏的临时目录。
 * 读写函数由调用方注入（默认走 `secure-store`），便于单测用假写入器断言
 * 「写了几次、写了什么」—— 这正是 R14-09 那条修复唯一可观测的后果。
 */
const path = require('path');
const secureStore = require('./secure-store');

/** 去抖窗口默认值（毫秒）。与 `config-store` 的 250ms 同一量级 */
const DEFAULT_DEBOUNCE_MS = 250;

/**
 * 退出收口登记表：`{ dataDir, exitFlush }`。
 *
 * 退出钩子**全库只注册一个**（见文件末尾），统一 flush 全部实例 ——
 * 项目铁律「清理/还原函数幂等且只注册一个退出处理器」。各模块若各自挂
 * `process.on('exit')`，既容易重复注册，也让「退出路径只写不建」的判据散成 N 份。
 */
const instances = new Set();

/**
 * 创建（并登记）一个「去抖合并写」。
 *
 * 语义：
 *  - `schedule()` 登记一次变更；窗口内**后续变更只替换待写内容**，不排队 ——
 *    中间态既没人读，也活不过一个去抖窗口；
 *  - 快照**延迟到落盘那一刻**才取（`getSnapshot()` 随写路径一起进队列），
 *    因此「入队时序列化」带来的同步阻塞与陈旧快照都不会发生；
 *  - `getSnapshot()` 返回 `null`/`undefined` 表示**本次不写** ——
 *    调用方用它表达「已锁定写入」（如 `payment-orders` 的读取失败标志）；
 *  - `debounceMs: 0` 是逃生阀：退回「立即写」，排查落盘问题时用。
 *
 * @param {string} file 目标文件绝对路径
 * @param {() => (object|null|undefined)} getSnapshot 取当前快照
 * @param {object} [opt]
 * @param {number} [opt.debounceMs] 去抖毫秒数（调用方解析环境变量后传入，默认 250）
 * @param {string} [opt.dataDir] 退出同步写的「只写不建」判据目录（默认取 `file` 的目录）
 * @param {(file: string, snapshot: object) => any} [opt.write] 异步写入器（默认 `secureStore.writeJsonAsync`）
 * @param {(file: string, snapshot: object) => any} [opt.writeSync] 同步写入器（默认 `secureStore.writeJson`）
 * @returns {{file: string, schedule: () => void, flush: () => void, pending: () => boolean}}
 */
function debouncedPersist(file, getSnapshot, opt = {}) {
  const dataDir = opt.dataDir || path.dirname(file);
  const rawMs = Number(opt.debounceMs);
  const debounceMs = Number.isFinite(rawMs) && rawMs >= 0 ? Math.floor(rawMs) : DEFAULT_DEBOUNCE_MS;
  const write = typeof opt.write === 'function'
    ? opt.write
    : (f, snap) => secureStore.writeJsonAsync(f, snap);
  const writeSync = typeof opt.writeSync === 'function'
    ? opt.writeSync
    : (f, snap) => secureStore.writeJson(f, snap);

  let timer = null;
  /** 是否有尚未落盘的变更。**不能**用「快照非 null」代替 —— 快照为 null 是「不写」而非「没变更」 */
  let dirty = false;

  function cancelTimer() {
    if (timer) { clearTimeout(timer); timer = null; }
  }

  /** 取快照；异常一律降级为「本次不写」，绝不让它把变更标记留在 dirty 状态 */
  function take() {
    let snap;
    try {
      snap = getSnapshot();
    } catch (e) {
      console.error(`[coalesce] 取快照失败 ${path.basename(file)}: ${(e && e.message) || e}`);
      return null;
    }
    return snap === undefined ? null : snap;
  }

  /** 异步落盘（不阻塞调用方） */
  function writeNow() {
    if (!dirty) return;
    dirty = false;
    const snap = take();
    if (snap === null) return;
    try {
      write(file, snap);
    } catch (e) {
      console.error(`[coalesce] 排队落盘失败 ${path.basename(file)}: ${(e && e.message) || e}`);
    }
  }

  /**
   * 退出路径的同步落盘。
   *
   * `process.on('exit')` 处理器返回后进程**立即**终止，事件循环不再推进 ——
   * 异步写只是把任务排进队列，回调永远不会被调度，一个字节都落不进磁盘。
   *
   * 这里**不做**「只写不建」的判断：那条判据刻意留在模块顶层的
   * `exitFlushOne()` 函数体内（见下），以便 `tests/invariants.test.js` 的
   * 「退出路径只写不建」检查能沿调用链找到守卫。**守卫藏进对象方法就会让那条
   * 检查失明** —— 本项目最忌讳的「护栏看不见」。
   */
  function writeNowSync() {
    if (!dirty) return;
    dirty = false;
    const snap = take();
    if (snap === null) return;
    try { writeSync(file, snap); } catch (e) { /* 退出阶段尽力而为 */ }
  }

  /** 登记一次变更；窗口内的后续变更只替换待写内容 */
  function schedule() {
    dirty = true;
    if (debounceMs <= 0) { cancelTimer(); writeNow(); return; }
    if (timer) return; // 窗口内已有排程：它自然会写入最新快照
    timer = setTimeout(() => { timer = null; writeNow(); }, debounceMs);
    if (timer.unref) timer.unref(); // 不阻止进程退出
  }

  /** 取消去抖并立即异步落盘（优雅停机 / 测试用） */
  function flush() { cancelTimer(); writeNow(); }

  instances.add({ dataDir, exitFlush: writeNowSync });
  return { file, schedule, flush, pending: () => dirty };
}

/**
 * 退出路径的统一收口。
 *
 * ⚠️ **只写不建**：数据目录不存在就跳过，连写都不写。
 * 判据走唯一实现点 `secureStore.exitPathWritable()`，且刻意留在**本函数体内**
 * （而不是藏进实例方法）—— 理由见 `writeNowSync` 的说明。
 */
function exitFlushOne(inst) {
  if (!secureStore.exitPathWritable(inst.dataDir)) return;
  inst.exitFlush();
}

function flushAllSync() {
  for (const inst of instances) {
    try { exitFlushOne(inst); } catch (e) { /* 退出阶段尽力而为 */ }
  }
}

process.on('exit', () => { flushAllSync(); });

/* ============================ 并发合并读 ============================ */

/** @type {Map<string, Promise<any>>} key -> in-flight Promise */
const inflight = new Map();

/**
 * 并发合并（single-flight）：同一 key 上的并发调用共享同一个 in-flight Promise。
 *
 * 用途是「同一份昂贵结果被 N 个并发请求各算一遍」—— 云端调用数与费用被 N 倍放大，
 * 且慢依赖场景下会各持一条连接。典型落点：
 *  - `GET /s/:id` 的惰性存在性探测（匿名可达、无需凭据，R14-10）；
 *  - `/fs/stat` 的文件夹计数（串行翻页，最多约 21 次云端往返，R14-12）。
 *
 * 失败**不缓存**：`finally` 里立刻摘掉条目，下一个请求会重新尝试 ——
 * 缓存失败结果会让一次瞬时抖动变成一段时间的持续故障。需要「失败也短暂留痕」的
 * 调用方（如存在性探测）应当自己在结果里叠加一层带 TTL 的缓存。
 *
 * @param {string} key 合并键（必须包含全部区分维度，否则会跨桶/跨资源串味）
 * @param {() => Promise<any>} fn 真正干活的函数（只在没有 in-flight 时被调用一次）
 * @returns {Promise<any>} 所有并发调用者拿到的是**同一个** Promise
 */
function singleFlight(key, fn) {
  const k = String(key);
  const hit = inflight.get(k);
  if (hit) return hit;
  const p = Promise.resolve()
    .then(fn)
    .finally(() => { if (inflight.get(k) === p) inflight.delete(k); });
  inflight.set(k, p);
  return p;
}

/** 供测试/护栏：当前在飞的合并键数量（应当回落，否则说明有键永不释放） */
function singleFlightSize() { return inflight.size; }

module.exports = {
  DEFAULT_DEBOUNCE_MS,
  debouncedPersist,
  singleFlight,
  singleFlightSize,
  // 供测试：模拟「进程退出」时的同步收口（生产侧由文件末尾的钩子调用）
  flushAllSync,
};
