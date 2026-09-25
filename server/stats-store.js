/**
 * 统计存储模块 —— 上传/下载流量、API 请求统计、操作日志
 *  - 按天聚合存储在 data/stats.json，保留最近 30 天
 *  - 操作日志追加写入 data/logs.jsonl，最多保留 5000 条
 */
const fs = require('fs');
const path = require('path');
const atomic = require('./atomic-write');
const configStore = require('./config-store'); // 仅复用 unwritableError（备份 + 拒绝覆盖语义）

// COS_DATA_DIR：与 payment-orders / enc-store 一致的测试隔离开关 ——
// 未设置时落到项目 data/，测试进程可指向临时目录（FUN-06 的损坏护栏需要能造一个坏文件）。
const DATA_DIR = process.env.COS_DATA_DIR ? path.resolve(process.env.COS_DATA_DIR) : path.join(__dirname, '..', 'data');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
const LOGS_FILE = path.join(DATA_DIR, 'logs.jsonl');
const RETAIN_DAYS = 30;
const MAX_LOGS = 5000;

/**
 * FUN-06：stats.json 的损坏护栏。
 *
 * 旧实现把「文件不存在」和「文件损坏」都吞进同一个 catch，一律 `{days:{}}`：
 * 文件因断电/磁盘写坏/手工编辑出错而变成半个 JSON 时，进程照样以空表启动，
 * 500ms 后 `persist()` 就把这份空表原子写回磁盘 —— 磁盘上那份（可能还能
 * 人工抢救的）历史统计被整体覆盖，且**没有任何告警**。
 *
 * 统计不是核心数据，所以这里不抛异常让服务起不来（那与它的权重不匹配），
 * 而是沿用 payment-orders 的降级语义：**读降级为空表，写永久锁定**。
 * 磁盘原件保留，并备份为 `.corrupt-<ts>`，等待人工恢复。
 */
let loadFailed = false;

let stats = null;
let saveTimer = null;

function todayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function ensure() {
  if (stats) return stats;
  try {
    // 文件不存在是正常首次启动，直接走空表，**不**触发损坏护栏
    if (!fs.existsSync(STATS_FILE)) { stats = { days: {} }; }
    else {
      const parsed = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || !parsed.days) throw new Error('内容结构不是预期的 { days: {} }');
      stats = parsed;
    }
  } catch (e) {
    // 走到这里 = 文件存在但读不出来/结构不对。备份原件并锁定写入，绝不再落盘覆盖。
    loadFailed = true;
    const err = configStore.unwritableError(STATS_FILE, 'corrupt', '无法解析或结构异常');
    console.error('[stats-store] ' + err.message + ' 原始错误：' + ((e && e.message) || e));
    stats = { days: {} };
  }
  if (!stats.buckets || typeof stats.buckets !== 'object') stats.buckets = {};
  return stats;
}

function persist() {
  if (loadFailed) return; // 读取失败过 → 绝不落盘，防覆盖
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      ensureDataDir();
      // 清理过期数据
      const cutoff = Date.now() - RETAIN_DAYS * 86400 * 1000;
      for (const key of Object.keys(stats.days)) {
        const t = new Date(key + 'T00:00:00').getTime();
        if (Number.isFinite(t) && t < cutoff) delete stats.days[key];
      }
      // 异步落盘（P1，原子写）：统计写入不阻塞事件循环
      atomic.writeAtomic(STATS_FILE, JSON.stringify(stats, null, 1))
        .catch(() => { /* 统计写入失败不影响主流程 */ });
    } catch (e) { /* 统计写入失败不影响主流程 */ }
  }, 500);
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * 同步落盘统计（**同步**；仅供停机路径调用）。
 *
 * R7-14：统计写入是 500ms 去抖 + 异步原子写。停机时只 flush 了日志缓冲，
 * 最后 500ms 内累计的流量 / 请求计数会随进程退出一起丢失 —— 表现为「今天的总流量
 * 比实际少一点」，无法排查也无从补回。
 *
 * 这里与 `flushLogsSync` 同型：清掉去抖定时器，用**同步**原子写立刻落盘
 * （`process.on('exit')` 里异步写不会被执行，这是踩过的坑）。
 *
 * @returns {boolean} 是否真的写了一次
 */
function flushStatsSync() {
  if (loadFailed) return false; // 读取失败过 → 绝不落盘，防覆盖
  if (!stats) return false; // 从未加载过，没有可写内容
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    ensureDataDir();
    atomic.writeAtomicSync(STATS_FILE, JSON.stringify(stats, null, 1));
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 记录一次 API 请求
 * @param {object} o {type, ok, bytesUp, bytesDown, ms}
 */
function track(o) {
  const s = ensure();
  const d = s.days[todayKey()] || (s.days[todayKey()] = { up: 0, down: 0, req: {} });
  d.up += Math.max(0, o.bytesUp || 0);
  d.down += Math.max(0, o.bytesDown || 0);
  const t = d.req[o.type] || (d.req[o.type] = { ok: 0, fail: 0, up: 0, down: 0, ms: 0 });
  if (o.ok) t.ok += 1; else t.fail += 1;
  t.up += Math.max(0, o.bytesUp || 0);
  t.down += Math.max(0, o.bytesDown || 0);
  t.ms += Math.max(0, o.ms || 0);
  persist();
}

/** 最近 n 天（含今天）的时间序列 */
function series(n) {
  const s = ensure();
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400 * 1000);
    const key = todayKey(d);
    const v = s.days[key] || { up: 0, down: 0, req: {} };
    let ok = 0, fail = 0;
    for (const t of Object.values(v.req)) { ok += t.ok; fail += t.fail; }
    out.push({ date: key, up: v.up, down: v.down, ok, fail });
  }
  return out;
}

/** 汇总统计（供仪表盘） */
function summary() {
  const s = ensure();
  const days = series(7);
  const today = days[days.length - 1];
  const byTypeMap = {};
  for (const d of days) {
    for (const [type, t] of Object.entries((s.days[d.date] || { req: {} }).req)) {
      const m = byTypeMap[type] || (byTypeMap[type] = { type, ok: 0, fail: 0, up: 0, down: 0 });
      m.ok += t.ok; m.fail += t.fail; m.up += t.up; m.down += t.down;
    }
  }
  const byType = Object.values(byTypeMap).sort((a, b) => (b.ok + b.fail) - (a.ok + a.fail));
  return {
    traffic: { todayUp: today.up, todayDown: today.down, days },
    requests: {
      today: { ok: today.ok, fail: today.fail },
      days,
      byType,
    },
  };
}

/* ------------------------- 按桶累计统计（持久化） ------------------------- */

/**
 * 记录某存储桶的一笔累计量：上传字节数 / 下载字节数 / 请求数
 * @param {string} bucket 桶名（含 APPID）
 * @param {object} o { up, down, req }
 */
function trackBucket(bucket, o) {
  if (!bucket) return;
  const s = ensure();
  const b = s.buckets[bucket] || (s.buckets[bucket] = { up: 0, down: 0, req: 0 });
  b.up += Math.max(0, (o && o.up) || 0);
  b.down += Math.max(0, (o && o.down) || 0);
  b.req += Math.max(0, (o && o.req) || 0);
  persist();
}

/** 全部桶的累计统计映射 { [bucket]: {up, down, req} } */
function bucketStats() {
  return ensure().buckets;
}

/** 清除某桶的累计统计（彻底删除存储桶时调用） */
function resetBucketStats(bucket) {
  const s = ensure();
  if (Object.prototype.hasOwnProperty.call(s.buckets, bucket)) {
    delete s.buckets[bucket];
    persist();
  }
}

/* ------------------------- 实时速率（内存采样，不持久化） ------------------------- */

const speedSamples = []; // { t, up, down }，最近 15 秒内的流量采样
const SAMPLE_KEEP = 15000;
const SAMPLE_MERGE = 400; // 400ms 内的流量合并为同一样本（流式下载每个 chunk 都会回调）

/**
 * 记录一笔实时流量（用于计算上传/下载速度）
 * 应在数据实际传输时调用（下载流 on-data、上传分片完成等），与 track() 的日累计互不影响。
 */
function sampleTraffic(up, down) {
  up = Math.max(0, up || 0);
  down = Math.max(0, down || 0);
  if (!up && !down) return;
  const t = Date.now();
  const last = speedSamples[speedSamples.length - 1];
  if (last && t - last.t < SAMPLE_MERGE) {
    last.up += up;
    last.down += down;
    return;
  }
  speedSamples.push({ t, up, down });
  while (speedSamples.length && t - speedSamples[0].t > SAMPLE_KEEP) speedSamples.shift();
}

/** 近 windowMs 内的平均速率（字节/秒） */
function speed(windowMs = 10000) {
  const now = Date.now();
  let up = 0, down = 0;
  for (const s of speedSamples) {
    if (now - s.t <= windowMs) { up += s.up; down += s.down; }
  }
  return { up: up / (windowMs / 1000), down: down / (windowMs / 1000), windowSec: windowMs / 1000 };
}

/* ------------------------- 操作日志 ------------------------- */

/** 日志缓冲：合并写入，避免每次请求同步 appendFile 阻塞事件循环（P1/P2） */
const LOG_BUFFER = [];
const LOG_FLUSH_MAX = 50; // 累积条数达到阈值立即刷盘
const LOG_FLUSH_MS = 2000; // 否则最多延迟 2 秒刷盘
const LOG_DETAIL_MAX = 500; // 单条详情最大长度，超出截断
let logFlushing = false;
let logTimer = null;
let flushPromise = null; // 当前进行中的刷盘 Promise（N2：getLogs 等待用）

/** 日志字段清洗：去除控制字符 + 长度截断，避免特殊字符污染 JSONL 文件（S12） */
function sanitizeField(v, max) {
  let s = String(v == null ? '' : v);
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  if (s.length > max) s = s.slice(0, max) + '...(已截断)';
  return s;
}

function addLog(entry) {
  try {
    LOG_BUFFER.push(JSON.stringify({
      t: new Date().toISOString(),
      level: sanitizeField(entry.level || 'info', 16),
      action: sanitizeField(entry.action || '', 64),
      detail: sanitizeField(entry.detail || '', LOG_DETAIL_MAX),
      ok: entry.ok !== false,
    }) + '\n');
    if (LOG_BUFFER.length >= LOG_FLUSH_MAX) flushLogs();
    else if (!logTimer) {
      logTimer = setTimeout(() => { logTimer = null; flushLogs(); }, LOG_FLUSH_MS);
      if (logTimer.unref) logTimer.unref();
    }
  } catch (e) { /* 日志失败不影响主流程 */ }
}

/** 异步刷盘：一次 I/O 写入缓冲中的全部日志；返回 Promise（N2：供 getLogs 等待） */
function flushLogs() {
  if (!LOG_BUFFER.length) return Promise.resolve();
  if (logFlushing) return flushPromise || Promise.resolve();
  logFlushing = true;
  const chunk = LOG_BUFFER.splice(0, LOG_BUFFER.length).join('');
  ensureDataDir();
  flushPromise = fs.promises.appendFile(LOGS_FILE, chunk)
    .catch(() => {})
    .finally(() => { logFlushing = false; flushPromise = null; });
  return flushPromise;
}

/** 同步刷盘：读取日志或进程退出前调用，确保缓冲不丢 */
function flushLogsSync() {
  if (!LOG_BUFFER.length) return;
  try {
    ensureDataDir();
    const chunk = LOG_BUFFER.splice(0, LOG_BUFFER.length).join('');
    fs.appendFileSync(LOGS_FILE, chunk);
  } catch (e) { /* 忽略 */ }
}

/**
 * 日志轮转：由定时器在空闲时执行，移出请求路径。
 *
 * PERF-07：改为**异步流式重写**。旧实现用 `readFileSync` 读入整个 logs.jsonl
 * 再 `writeAtomicSync` 全量重写 —— 日志接近上限（5000 行）时，
 * 这一对同步全量读写会在轮转瞬间阻塞事件循环，造成全站延迟尖峰。
 *
 * 另外这里只保留末尾 MAX_LOGS 行：读到的行数不超过上限时才**完全不动磁盘**，
 * 避免「每 10 分钟无条件重写一次整个文件」这种无谓的写放大。
 */
async function rotateLogs() {
  try {
    // FUN-13：旧实现「有未落盘日志就直接跳过」。日志是持续产生的（每 2 秒一批），
    // 而轮转每 10 分钟才检查一次 —— 两者几乎必然相撞，于是轮转**长期不执行**，
    // logs.jsonl 无界增长，getLogs 每次读全文再倒序扫描也越来越慢。
    // 正确做法是把缓冲先刷掉再轮转，而不是把工作推给"下一轮"。
    if (LOG_BUFFER.length) await flushLogs();
    if (LOG_BUFFER.length) return; // 仍在刷盘中（并发刷写）：本轮让位，下一轮再来
    if (!fs.existsSync(LOGS_FILE)) return;
    const text = await fs.promises.readFile(LOGS_FILE, 'utf8');
    const lines = text.split('\n').filter(Boolean);
    if (lines.length <= MAX_LOGS) return;
    await atomic.writeAtomic(LOGS_FILE, lines.slice(lines.length - MAX_LOGS).join('\n') + '\n');
  } catch (e) { /* 轮转失败不影响主流程 */ }
}

// 每 10 分钟检查一次日志规模；启动 5 秒后先执行一次
const rotateTimer = setInterval(rotateLogs, 10 * 60 * 1000);
if (rotateTimer.unref) rotateTimer.unref();
setTimeout(rotateLogs, 5000).unref();

async function getLogs({ limit = 200, level = '', action = '' } = {}) {
  try {
    await flushLogs(); // 先异步冲掉缓冲，确保读到最新日志（不阻塞事件循环）
    if (!fs.existsSync(LOGS_FILE)) return [];
    const text = await fs.promises.readFile(LOGS_FILE, 'utf8');
    const lines = text.trim().split('\n').filter(Boolean);
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        const o = JSON.parse(lines[i]);
        if (level && o.level !== level) continue;
        if (action && o.action.indexOf(action) === -1) continue;
        out.push(o);
      } catch (e) { /* 跳过损坏行 */ }
    }
    return out;
  } catch (e) {
    return [];
  }
}

module.exports = {
  track, series, summary, addLog, getLogs, todayKey, sampleTraffic, speed,
  trackBucket, bucketStats, resetBucketStats,
  flushLogs, flushLogsSync, rotateLogs, flushStatsSync,
  isLoadFailed: () => loadFailed, // FUN-06：供测试与运维观察统计是否已降级
};
