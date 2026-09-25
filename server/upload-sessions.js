/**
 * 断点续传会话注册表
 *  - 记录 multipart 会话（uploadId、已上传分片 ETag、分片加密参数），持久化到 data/upload-sessions.json
 *  - 客户端中断（页面刷新/进程重启）后可依据相同 Key+Size 匹配继续上传
 *  - S4：会话内含分片加密元数据（IV/TAG），统一走 secure-store 加密落盘
 */
const fs = require('fs');
const path = require('path');
const secureStore = require('./secure-store');
const providers = require('./providers');

// COS_DATA_DIR：与 stats-store / payment-orders / enc-store 一致的测试隔离开关 ——
// 未设置时落到项目 data/，测试进程可指向临时目录（RE-03 需要在子进程里做真实退出落盘验证）。
const DATA_DIR = process.env.COS_DATA_DIR ? path.resolve(process.env.COS_DATA_DIR) : path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'upload-sessions.json');
const EXPIRE_MS = 7 * 86400 * 1000;
/** 会话数上限（M8）：超出时按 updatedAt 从最旧开始淘汰，避免大量中断上传累积导致
 *  文件膨胀与 prune 时的长时间遍历阻塞。正常场景远达不到该量级。 */
const MAX_SESSIONS = 2000;

let sessions = null;
let saveTimer = null;

function ensure() {
  if (sessions) return sessions;
  try {
    // S4：加密存储（兼容历史明文文件，读取时自动识别）
    const raw = secureStore.readJson(FILE, null);
    if (raw && typeof raw === 'object') sessions = raw;
    else sessions = {};
  } catch (e) {
    // SEC-09：损坏时告警（secure-store 已锁定写入，磁盘文件不会被空集覆盖）
    console.error('[upload-sessions] 上传会话文件损坏，已降级为空集并锁定写入：', e.message);
    sessions = {};
  }
  return sessions;
}

function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persistNow();
  }, 300);
}

/** 立即落盘（去抖窗口之外调用；异步，不阻塞事件循环） */
function persistNow() {
  try {
    /**
     * R10-01：这里曾误留一行 `if (cleaned && !fs.existsSync(DATA_DIR)) return;`，
     * 而 `cleaned` **只声明在**下面的 `persistNowSync()` 里 —— 本函数读取未声明
     * 标识符会抛 `ReferenceError`，又被这里的空 `catch` 静默吞掉。
     * 后果是**整条异步落盘路径恒为静默空操作**：进程存活期间一个字节都不写，
     * 只剩 `process.on('exit')` 那条同步路径还能落盘 —— 而强杀（SIGKILL /
     * OOM / `taskkill /F` / 容器强停）根本不会触发 exit 钩子，于是会话（内含分片
     * 加密元数据 IV / TAG / 盐）全丢，已上传分片永久不可解且持续计费。
     * 丢失窗口由「≤300ms 去抖」变成「整个进程生命周期」。
     *
     * 异步路径只负责建目录 + 排队写入；「目录被有意删掉时不要复活」是**退出路径**
     * 才需要的约束，已统一收敛到 {@link exitPathWritable}。
     */
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    // S4/P11：加密 + 按文件维度串行原子写入（避免并发交错或进程退出截断）
    secureStore.writeJsonAsync(FILE, sessions);
  } catch (e) { /* ignore */ }
}

/**
 * 立即落盘（**同步**；仅供进程退出前调用）。
 *
 * RE-03：`process.on('exit')` 处理器返回后进程**立即**终止，事件循环不再推进 ——
 * 异步写只是把任务排进队列，回调永远不会被调度，一个字节都落不进磁盘。
 * 旧的 exit 兜底调的正是异步的 `persistNow()`，注释声称覆盖 kill / 崩溃，
 * 实际从未生效（这也是它一直"看起来没问题"的原因：真实生效路径是优雅停机）。
 *
 * 退出阶段**绝不创建数据目录** —— 只写、不建（理由见
 * {@link secureStore.exitPathWritable}）：测试收尾 / 运维清理刚删掉的目录不能被
 * 自己的退出钩子复活。判据改用唯一实现点（R12-03）—— 此前本模块留了一份私有副本，
 * 于是「canonical 被改成 `return true`」这种回归无人能发现（第 12 轮实测：两套护栏全绿）。
 */
function persistNowSync() {
  try {
    // R9-08 / R10-01 / R12-03：退出阶段只写不建（唯一实现点）
    if (!secureStore.exitPathWritable(DATA_DIR)) return;
    secureStore.writeJson(FILE, sessions);
  } catch (e) { /* ignore */ }
}

/**
 * PERF-06：去抖窗口内进程被强杀会丢失会话元数据。
 *
 * 分片上传会话里存着**加密元数据**（IV / TAG / 盐）。这些字节没落盘，
 * 已上传的分片就无法解密 —— 用户看到的是"上传成功但文件打不开"，
 * 而重新上传又会产生新的分片（旧的继续计费）。
 *
 * 优雅停机由 index.js 调用 flush()（异步写 + await secureStore.flush()，不阻塞事件循环）。
 */
function flush() {
  if (!sessions) return;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  persistNow();
}

/**
 * RE-03：退出兜底必须走**同步**写（见 persistNowSync 的说明）。
 * 未初始化时（sessions 为 null）是空操作；sessions 未变更过也只是白写一次，
 * 退出路径上一次同步写换来"分片元数据不丢"是值得的。
 */
function flushSync() {
  if (!sessions) return;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  persistNowSync();
}
process.on('exit', () => { try { flushSync(); } catch (e) { /* 退出阶段尽力而为 */ } });

function create({ uploadId, key, bucket, region, size, chunkSize, provider, createdBy }) {
  const s = ensure();
  const id = require('crypto').randomBytes(12).toString('hex');
  const pid = provider || providers.DEFAULT_PROVIDER_ID;
  // SEC-07：记录创建者，使 /fs/sessions 能按用户过滤（避免泄露他人会话的桶名与对象键）
  s[id] = {
    id, uploadId, key, bucket, region, provider: pid, size, chunkSize,
    createdBy: createdBy || '', parts: {}, createdAt: Date.now(), updatedAt: Date.now(),
  };
  persist();
  return s[id];
}

/**
 * 列出未完成会话。
 * @param {object} [opt] { createdBy } 指定时只返回该创建者的会话；
 *                       管理员（不传）返回全部。历史会话无 createdBy → 视为不属于任何普通用户。
 */
function list(opt) {
  const s = ensure();
  const all = Object.values(s);
  const who = opt && opt.createdBy;
  if (!who) return all;
  return all.filter((o) => o.createdBy === who);
}

function get(id) {
  return ensure()[id] || null;
}

/**
 * 按 Key+Size 查找未完成会话（用于断点续传恢复）
 *
 * FUN-02：必须同时限定**创建者与目标桶**。曾经只按 key+size 全库匹配：
 *  - 用户 A 上传与他人同 key 同 size 的文件时会命中 B 的会话，拿到 B 的 sessionId，
 *    随后 chunk/complete/abort 被 `assertSessionOwner` 拦成 403 —— 表现为「一上传就失败」，
 *    且他人 sessionId 与分片进度被泄露（存在性侧信道）；
 *  - 只按 key+size 还会命中**别的桶**的会话，续传实际打到错误的桶上。
 *
 * @param {string} key
 * @param {number} size
 * @param {object} [filter] { createdBy, bucket, region } 传入即作为**必要条件**
 */
function findByTarget(key, size, filter = {}) {
  const s = ensure();
  let best = null;
  for (const o of Object.values(s)) {
    if (o.key !== key || o.size !== size) continue;
    if (filter.createdBy !== undefined && o.createdBy !== filter.createdBy) continue;
    if (filter.bucket !== undefined && o.bucket !== filter.bucket) continue;
    if (filter.region !== undefined && o.region !== filter.region) continue;
    if (!best || o.updatedAt > best.updatedAt) best = o;
  }
  return best;
}

function setPart(id, partNumber, etag) {
  const sess = ensure()[id];
  if (!sess) return null;
  sess.parts[partNumber] = etag;
  sess.updatedAt = Date.now();
  persist();
  return sess;
}

/** 立即持久化会话（加密分片参数写入后调用，防响应丢失导致 IV/TAG 失联） */
function touch(id) {
  const sess = ensure()[id];
  if (!sess) return null;
  sess.updatedAt = Date.now();
  persist();
  return sess;
}

function remove(id) {
  const s = ensure();
  if (s[id]) { delete s[id]; persist(); }
}

/**
 * 启动时清理过期会话（并尽力中止远端分片，避免产生无用存储费用）
 *
 * 异步化（M8）：中止远端分片改为「不等待」触发（SDK 回调式），整体函数不再阻塞事件循环；
 * 同时对会话总数设上限，超出部分按 updatedAt 淘汰最旧记录。
 *
 * @param {Function|object} getClientForSession 会话 → 客户端解析函数；兼容旧的「单一客户端对象」传参
 */
function prune(getClientForSession) {
  const s = ensure();
  const now = Date.now();
  // 兼容旧调用：非函数时视为单一客户端对象
  const resolveClient = typeof getClientForSession === 'function'
    ? getClientForSession
    : () => getClientForSession;

  const abortRemote = (o) => {
    try {
      const cos = resolveClient(o);
      // 无法解析客户端（配置缺失/厂商不支持）时保留会话，避免丢失远端分片句柄
      if (!cos) return false;
      // R7-06：同样要过 `p()` 咽喉点 —— 中止分片是写操作，必须让「分片列举缓存」失效。
      // 此前直接回调式调用，中止后「文件碎片」页最长 30 秒仍显示已中止的碎片。
      // 这里懒加载避免与 cos 模块形成加载期循环依赖；失败由 p() 的 promise 吞掉，
      // 不影响 prune 的其余流程（中止本身只是尽力而为）。
      const { p } = require('./cos');
      p(cos, 'multipartAbort', { Bucket: o.bucket, Region: o.region, Key: o.key, UploadId: o.uploadId })
        .catch(() => {});
      return true;
    } catch (e) { return false; }
  };

  // 1) 过期会话：远端中止 + 本地删除
  for (const o of Object.values(s)) {
    if (now - o.updatedAt > EXPIRE_MS) {
      if (!abortRemote(o)) continue; // 客户端不可用时保留，等下轮再试
      delete s[o.id];
    }
  }

  // 2) 数量上限：按 updatedAt 升序淘汰最旧的（保留最近的活跃会话）
  const rest = Object.values(s);
  if (rest.length > MAX_SESSIONS) {
    rest.sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
    for (const o of rest.slice(0, rest.length - MAX_SESSIONS)) {
      // R7-12：与过期分支**同一口径** —— 中止失败就保留会话，等下一轮再试。
      // 旧实现无条件 `abortRemote(); delete s[o.id];`，中止一失败就把本地会话删掉，
      // 云端分片的 UploadId 句柄随之丢失：用户既无法中止、也无法续传，分片持续计费。
      if (!abortRemote(o)) continue;
      delete s[o.id];
    }
  }

  persist();
}

module.exports = {
  create, get, findByTarget, setPart, touch, remove, list, prune, flush, flushSync,
  MAX_SESSIONS, // 供测试与运维观察会话上限
};
