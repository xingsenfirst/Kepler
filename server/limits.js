/**
 * 列举/扫描上限集中定义（PERF-04）
 *
 * ## 为什么要集中
 *
 * 旧代码里这些数字散落在 4 个文件（cos.js / routes/fs.js / routes/buckets.js /
 * webdav-server.js），取值从 2 万到 20 万不等且互不知情。`listAll()` 串行翻页把
 * 全部结果累积到内存数组，20 万对象意味着 200 次串行云端往返 + 一次整体序列化，
 * 单请求即可产生数秒长任务与数百 MB 内存峰值 —— 多个请求并发就可能撑爆内存。
 *
 * ## 取值依据
 *
 * - `SCAN`（搜索/估算扫描）：**5000**。用户搜索通常关注最近/前若干页，
 *   超出应给出「结果过多，请细化关键词」而非假装全量返回。
 * - `STAT`（文件夹属性计数）：**20000**。精确到 2 万已满足「这个文件夹有多大」；
 *   超过时返回 `truncated=true`，UI 显示「≥N」而非假精确值。
 * - `DELETE`（删除/清空）：**5000**。删除走「列举一页→删一页」流式循环，
 *   内存恒定，循环次数自然覆盖超大桶，无需一次读入大量对象。
 * - `PROPFIND`（WebDAV Depth: infinity）：**5000**。文件系统客户端对超大目录
 *   本身也不能良好呈现，超出同样标注截断。
 * - `HARD_MAX`（硬性天花板）：**50000**。任何调用方都不得越过，用于兜住回归。
 *
 * 所有 cap 均可通过环境变量覆盖，便于在受控环境下做压力验证。
 */

/** 从环境变量读取正整数上限，非法/缺失时回退默认值 */
function fromEnv(name, dflt) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

/** 任何列举操作的硬性天花板 —— 越过即视为缺陷 */
const HARD_MAX = 50000;

function clamp(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return HARD_MAX;
  return Math.min(Math.floor(n), HARD_MAX);
}

const LIMITS = {
  /** 单页列举条数上限（/fs/list 的 maxKeys；对象存储服务端单页上限 1000） */
  LIST_PAGE: 1000,
  /** 搜索 / 用量估算扫描上限 */
  SCAN: clamp(fromEnv('LIST_SCAN_CAP', 5000)),
  /** 文件夹属性计数上限 */
  STAT: clamp(fromEnv('LIST_STAT_CAP', 20000)),
  /** 删除 / 清空时的单次列举上限（循环调用，恒定内存） */
  DELETE: clamp(fromEnv('LIST_DELETE_CAP', 5000)),
  /** WebDAV Depth: infinity 的 PROPFIND 上限 */
  PROPFIND: clamp(fromEnv('LIST_PROPFIND_CAP', 5000)),
  /** 硬性天花板 */
  HARD_MAX,
  /**
   * 单请求复制（`putObjectCopy`）的大小上限 —— 超过必须走分块复制。
   * 此前 routes/fs.js 与 fs-gateway.js 各写一份同样的常量，属于典型的
   * 「同一类常量多份实现」，改一处漏一处就会分叉，故收拢到这里。
   */
  COPY_SIMPLE_LIMIT: 5 * 1024 * 1024 * 1024,
  /**
   * R9-09：magic（异或流）加密模式下，**单次同步加密的输入上限**。
   *
   * `xorBuf` 的密钥流每 32 字节做一次 SHA-256，且 `encryptBuffer` / `encryptPart`
   * 都是**同步**函数、在 handler 里直接调用 —— 输入越大，事件循环被占住越久。
   * 本机实测 sha256 单块 ≈ 2.55µs：
   *   5MB ≈ 418ms、8MB ≈ 669ms、48MB ≈ 4.0s（纯同步阻塞）。
   * 多路并发上传时这些阻塞会叠加，整个服务在数秒内不响应任何请求。
   *
   * **不能再往下压**：5MB 是 AWS S3 对「除最后一片外」的分片下限，压到 4MB 会让
   * 启用 magic 的大文件在 AWS S3 上合并时报 `EntityTooSmall`（腾讯云 COS 是 1MB、
   * 阿里云 OSS / 华为云 OBS 是 100KB，本可更小，但必须取各厂商中最严的那个）。
   * 也就是说 —— 它同时是**性能上限**与**协议下限**，改之前先查协议。
   *
   * R8-02 只把这个上限用于分片路径（`routes/fs.js` 的 `chunkSize`），而直传
   * （`/fs/upload/simple`，`express.raw` 上限 64MB）与 WebDAV PUT（全量缓冲后同步
   * 加密）两条路径没有约束。R9-09 把它**下沉到 `encStore.encryptBuffer` 内部**，
   * 使「按模式拒绝超限输入」成为加密入口自身的契约，而不是逐个调用点各写一次 ——
   * 否则就是第 N 次「同一状态多入口，改一处漏一处」。
   */
  MAGIC_SYNC_MAX: 5 * 1024 * 1024,
};

/**
 * 解析调用方传入的 cap：
 *  - 未传（undefined/null）→ 返回 `dflt`
 *  - 显式传 false / 0 → 无显式上限，仍受 HARD_MAX 约束
 *  - 其它值 → 取 min(值, HARD_MAX)
 */
function resolveCap(requested, dflt) {
  if (requested === undefined || requested === null) return clamp(dflt);
  if (requested === false || requested === 0) return HARD_MAX;
  return clamp(requested);
}

/* ============================ 下载限速（R37） ============================ */

/**
 * UI 的 MB 与字节的换算基数。
 *
 * 取 1024 而非 1000：与 `public/js/util.js` 的 `fmtSize()` 同基数 —— 界面上
 * 「文件大小」与「限速」用两套基数，用户会算不平（1.5 MB/s 传输 150 MB 文件
 * 到底要 100 秒还是 150 秒）。
 */
const MB = 1024 * 1024;

/**
 * 归一化限速值 → **非负整数字节/秒**；`0` = 不限速。
 *
 * 这是「什么是合法的限速值」的**唯一判据**，放在本文件（无任何 require 的叶子
 * 模块）而不是 `throttle.js`：`config-store` / `share-store` 写盘时要用它归一化，
 * 而 `throttle.js` 反过来要 require 它们 —— 判据若住在 `throttle.js` 就会成环。
 *
 * 约定与 `normalizeQuotaBytes` 一致：非有限数 / 非正数一律归 0（不限），
 * 正数向下取整（速率是字节/秒，小数没有意义）。
 */
function normalizeSpeedLimit(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

/** 字节/秒 → MB/s（展示用，保留一位小数；0 = 不限速） */
function toMBps(bytesPerSec) {
  const n = normalizeSpeedLimit(bytesPerSec);
  if (!n) return 0;
  return Math.round((n / MB) * 10) / 10;
}

/**
 * 校验**接口入参**里用户填的限速值 —— 四个设置入口（API Key / 存储桶 / 用户 /
 * 分享链接）共用的**唯一实现点**。
 *
 * 为什么不能直接把 `b.speedLimit` 丢给 `normalizeSpeedLimit`：
 * 它与配额（R25 的 `quotaBytes`）是同一个陷阱 —— 界面填 `-1` / `abc` 会被
 * 归一化成 `0`，而 `0` 的语义是「**不限速**」。于是用户以为设置了限制，
 * 实际把限制**完全放开**了（正好反了）。所以入参必须先判定合法性，
 * 非法一律 400 让用户看见，而不是静默改写成「更宽松」的值。
 *
 * @param {*} v 原始入参
 * @returns {{ok: true, value: number} | {ok: false, error: string}}
 *          `value` 为向下取整的字节/秒；`0` = 不限速
 */
function parseSpeedLimitInput(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return { ok: false, error: '限速值不能为负数（0 表示不限速）' };
  return { ok: true, value: Math.floor(n) };
}

module.exports = {
  LIMITS, resolveCap, HARD_MAX,
  MB, normalizeSpeedLimit, toMBps, parseSpeedLimitInput,
};
