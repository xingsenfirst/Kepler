/**
 * 单实例锁 —— 防止两个进程同时操作同一份 data/ 目录。
 *
 * 为什么需要：config-store 的配置缓存与串行写队列都基于「进程内唯一」的假设。
 * 若用户误开两个实例（或旧的进程未退出就再次启动），两个进程会各自持有缓存并
 * 交替整体覆盖 config.enc，造成配置丢失 —— 与 2026-09-11 那次「config.enc 损坏」
 * 属同类风险。本模块通过 `data/.instance.lock` 做进程级互斥。
 *
 * 实现要点：
 *  - 用 `wx` 标志独占创建锁文件（O_CREAT|O_EXCL，跨平台原子）
 *  - 锁内记录 pid 与启动时间；若发现锁存在但持有者进程已不存在（崩溃残留），自动接管
 *  - 正常退出时释放；异常退出留下的脏锁由「pid 存活检测」兜底
 */
const fs = require('fs');
const path = require('path');

// COS_DATA_DIR：与 stats-store / enc-store / share-store / ip-guard 一致的测试隔离开关
// —— 未设置时落到项目 data/，测试进程可指向临时目录（否则用例会去动真实的 .instance.lock）。
const DATA_DIR = process.env.COS_DATA_DIR ? path.resolve(process.env.COS_DATA_DIR) : path.join(__dirname, '..', 'data');
const LOCK_FILE = path.join(DATA_DIR, '.instance.lock');

let held = false;

/** 判断某 pid 是否仍存活（Windows / POSIX 通用：signal 0 探测） */
function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH = 不存在；EPERM = 存在但无权限（视为存活）
    return e && e.code === 'EPERM';
  }
}

function readLock() {
  try {
    return JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
  } catch (e) {
    return null;
  }
}

/**
 * R21-10：接管「读不出持有者」的锁之前，必须先确认这个文件**已经足够旧**。
 *
 * `fs.writeFileSync(file, payload, { flag: 'wx' })` 只保证「**创建**」是原子的
 * （O_CREAT|O_EXCL），而**创建与内容落盘不是同一个原子步骤** —— 内核先建出 0 字节
 * 文件并返回 fd，进程再写入。若 B 恰好落在 A「已创建、内容尚未落盘」这个窗口里
 * `readFileSync`，拿到的是空串 → `JSON.parse` 抛错 → `readLock()` 返回 `null`；
 * 旧实现把 `!cur` 直接当作「锁损坏 / 无主」，于是 `unlink` 掉 A **正在持有**的锁并
 * 接管。两个进程同时认为持锁，`config.enc` 被交替整体覆盖 —— 正是这把锁要防的事。
 *
 * 现在把「读到空 / 坏内容」与「确认无主」区分开：内容不可解析时，只有 mtime 超过
 * 宽限期才允许接管；新鲜的空锁一律按「有人正在建」处理，直接判为被占用。
 * 真正的崩溃残留（进程已死）仍由 `pidAlive` 判定接管，不受本宽限期影响。
 */
const LOCK_SHAPE_GRACE_MS = 2000;

/** 锁文件自最后一次修改以来的毫秒数；文件已不存在时返回 Infinity（并发释放 → 不该因「新鲜」而拒接管） */
function lockAgeMs() {
  try {
    return Math.max(0, Date.now() - fs.statSync(LOCK_FILE).mtimeMs);
  } catch (e) {
    return Infinity;
  }
}

/**
 * 尝试获取单实例锁。
 * @returns {{ ok: true } | { ok: false, stale: boolean, pid: number|null }}
 *   ok=false 且 stale=true 表示旧锁持有者已不存在（调用方可选择 force 接管）
 */
function acquire({ force = false } = {}) {
  if (held) return { ok: true };
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) { /* 目录已存在 */ }

  const payload = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });

  // 先探测已有锁
  const existing = readLock();
  if (existing && existing.pid && existing.pid !== process.pid && pidAlive(existing.pid)) {
    return { ok: false, stale: false, pid: existing.pid };
  }

  try {
    fs.writeFileSync(LOCK_FILE, payload, { flag: 'wx' });
    held = true;
    return { ok: true };
  } catch (e) {
    if (e && e.code === 'EEXIST') {
      // 锁文件已存在但持有者已死（或内容损坏）→ 清理后重试一次
      const cur = readLock();
      // R21-10：内容不可解析 ≠ 无主。别人可能只是「刚建好、内容还没落盘」——
      // 宽限期内一律按被占用处理，绝不 unlink（详见 lockAgeMs 上的说明）。
      if (!cur && !force && lockAgeMs() < LOCK_SHAPE_GRACE_MS) {
        return { ok: false, stale: false, pid: null };
      }
      if (!cur || !cur.pid || !pidAlive(cur.pid) || force) {
        try {
          fs.unlinkSync(LOCK_FILE);
          fs.writeFileSync(LOCK_FILE, payload, { flag: 'wx' });
          held = true;
          return { ok: true };
        } catch (e2) { /* 竞争失败，走下方返回 */ }
      }
      return { ok: false, stale: true, pid: cur ? cur.pid : null };
    }
    throw e;
  }
}

/** 释放锁（仅当本进程持有） */
function release() {
  if (!held) return;
  held = false;
  try {
    const cur = readLock();
    if (!cur || cur.pid === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch (e) { /* 已被清理，忽略 */ }
}

module.exports = { acquire, release, LOCK_FILE };
