/**
 * 原子写入工具 —— 杜绝"写入被中断导致文件被截断为 0 字节"
 *
 * 直接 writeFile 会先清空目标文件再写入；若进程在两步之间退出（Ctrl+C、kill、
 * 异常崩溃），文件将永久损坏为 0 字节。改为「写临时文件 + rename」：
 * 同一分区内 rename 是原子操作，任意时刻读取到的都是完整的旧内容或新内容。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * 临时文件名：`<原名>.<pid>.<随机串>.tmp`
 *
 * 唯一性来源必须是**随机量**。历史版本用 `Date.now().toString(36)`，在同一毫秒内
 * 会生成完全相同的名字 —— 若上一轮的 rename 尚未完成（异步写、队列被阻塞、IO 慢），
 * 后一次的 writeFile 会以 `w` 模式打开**同一个 tmp** 并先把长度截断为 0，于是
 * 两次写入共用一份数据，先到的 rename 会把被截断的文件搬到目标路径。
 * 现改用 16 位随机 hex，配合 pid，跨进程/同进程都不再碰撞。
 */
function tmpPath(file) {
  return `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
}

/** 同步原子写入 */
function writeAtomicSync(file, data) {
  const tmp = tmpPath(file);
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e2) { /* ignore */ }
    throw e;
  }
}

/** 异步原子写入 */
async function writeAtomic(file, data) {
  const tmp = tmpPath(file);
  try {
    await fs.promises.writeFile(tmp, data);
    await fs.promises.rename(tmp, file);
  } catch (e) {
    try { await fs.promises.unlink(tmp); } catch (e2) { /* ignore */ }
    throw e;
  }
}

/** 孤儿临时文件名匹配：`<原名>.<pid>.<随机串>.tmp` */
const TMP_RE = /^(.*)\.(\d+)\.([0-9a-z]+)\.tmp$/i;

/**
 * 进程是否存活。
 *
 *  - POSIX：`process.kill(pid, 0)` 成功=存活；`ESRCH`=不存在；`EPERM`=存在但无权（存活）。
 *  - Windows：Node 用 `OpenProcess` 实现，`EPERM` 同样表示"进程存在但无权限打开"
 *    （服务进程如 svchost.exe 即属此类）。此时**不能**因拿不到句柄就判定为死亡，
 *    故用 `tasklist` 做一次精确核对，避免把系统服务误判为孤儿而删掉其文件。
 *
 * 已知局限（PID 复用）：tmp 文件名的 pid 是写入时那一刻的进程号。若原进程已崩溃退出、
 * 而 Windows 之后把同一 PID 分配给了别的进程（如某个 svchost），本函数会认为"存活"，
 * 该孤儿文件要到那个无关进程也退出后才会被清扫。这是 PID 复用固有的不确定性 ——
 * 清扫属于尽力而为的维护动作，宁可漏删（留几个 0 字节文件）也不可误删。
 *
 * 探测失败时保守返回 true（宁可漏删，不可误删正在写入的文件）。
 */
const IS_WINDOWS = process.platform === 'win32';

function isPidAlive(pid) {
  if (!pid || pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (!e || e.code !== 'EPERM') return false; // ESRCH 等 → 不存在
    if (!IS_WINDOWS) return true;               // POSIX：EPERM 即进程存在
    return isPidAliveWin32(pid);                // Windows：再精确核对一次
  }
}

/** Windows：用 tasklist 核对该 PID 是否真的在进程列表中 */
function isPidAliveWin32(pid) {
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], {
      encoding: 'utf8', windowsHide: true, timeout: 5000,
    });
    // 命中时形如 "node.exe","3108","Console","1","46,652 K"；未命中时输出"没有运行的任务..."提示
    return new RegExp(`"${pid}"`).test(out);
  } catch (e) {
    return true; // 探测失败：保守视为存活
  }
}

/**
 * 清扫目录中的**孤儿**临时文件。
 *
 * 背景：`writeFile(tmp)` 与 `rename(tmp, file)` 之间存在窗口。进程若在该窗口内被
 * 强杀（Ctrl+C 恰好命中、任务管理器结束、CI 取消、容器 SIGKILL），`catch` 不会执行，
 * 0 字节的 tmp 便永久滞留在 `data/` 里，越积越多。
 *
 * 安全策略（三重条件，宁可漏删不可误删）：
 *  1. 文件名必须匹配本模块的 tmp 命名规则；
 *  2. 文件名中的 pid **已不存活**（存活进程可能正在写入，绝不动）；
 *  3. mtime 早于 `minAgeMs`（默认 10 分钟），避免误删时钟漂移或 pid 复用场景。
 *
 * @param {string} dir            目标目录
 * @param {{minAgeMs?:number, dryRun?:boolean}} [opts]
 * @returns {Promise<{scanned:number, removed:string[], skipped:number}>}
 */
async function sweepOrphanTmp(dir, opts = {}) {
  const minAgeMs = Number.isFinite(opts.minAgeMs) ? opts.minAgeMs : 10 * 60 * 1000;
  const dryRun = !!opts.dryRun;
  const result = { scanned: 0, removed: [], skipped: 0 };
  let names;
  try {
    names = await fs.promises.readdir(dir);
  } catch (e) {
    return result; // 目录不存在等：静默跳过，清扫属于尽力而为的维护动作
  }
  const now = Date.now();
  for (const name of names) {
    const m = TMP_RE.exec(name);
    if (!m) continue;
    result.scanned++;
    const pid = Number(m[2]);
    const full = path.join(dir, name);
    let st;
    try { st = await fs.promises.stat(full); } catch (e) { continue; }
    if (!st.isFile()) { result.skipped++; continue; }
    if (isPidAlive(pid)) { result.skipped++; continue; }        // 条件 2
    if (now - st.mtimeMs < minAgeMs) { result.skipped++; continue; } // 条件 3
    if (dryRun) { result.removed.push(name); continue; }
    try {
      await fs.promises.unlink(full);
      result.removed.push(name);
    } catch (e) {
      result.skipped++;
    }
  }
  return result;
}

/**
 * 异步追加（日志类）。
 *
 * 实现说明（性能）：早期版本为「读全文件 + 拼接 + 整体原子替换」，每次追加都是 O(n)
 * 磁盘读与重写，日志长大后会形成明显写放大。现改为 `fs.appendFile` 追加写：
 *  - POSIX 下 O_APPEND 写入对小尺寸数据是原子的（不覆盖既有内容），不会产生 0 字节截断；
 *  - Windows 下 appendFile 亦为追加打开（FILE_APPEND_DATA），同样不截断既有内容。
 * 因此"追加中途崩溃导致文件损坏"的风险从"整体替换正确性"降级为"仅最后一行可能不完整"，
 * 对日志场景完全可接受，且消除了 O(n) 写放大。
 *
 * 注意：本函数不适合需要"整体一致性快照"的配置类文件（那类应走 writeAtomic）。
 */
async function appendAtomic(file, chunk) {
  try {
    await fs.promises.appendFile(file, chunk);
  } catch (e) {
    // 目录不存在时补建后重试一次（日志首次写入常见）
    if (e && (e.code === 'ENOENT')) {
      await fs.promises.mkdir(require('path').dirname(file), { recursive: true });
      await fs.promises.appendFile(file, chunk);
      return;
    }
    throw e;
  }
}

module.exports = { writeAtomicSync, writeAtomic, appendAtomic, sweepOrphanTmp, tmpPath };
