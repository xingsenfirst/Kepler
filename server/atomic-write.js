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

/**
 * R27-14：尽力把某个路径的内容刷到稳定存储。失败一律静默。
 *
 * 为什么需要：`write(tmp)` + `rename(tmp, file)` 只保证**崩溃一致性**（任意时刻读到的
 * 是完整旧内容或完整新内容），不保证**断电后的持久化顺序** —— POSIX 上的 rename 可能
 * 先于数据落盘被提交，掉电后目标文件可能是 0 字节或部分分配。对 `config.enc`
 * （装着全部云厂商密钥与账户）与 `secret.key` 而言，这不是"丢一次写入"，
 * 而是"必须人工恢复/无法恢复"。
 *
 * Windows 等平台对目录 fsync 会报错（EPERM/EISDIR），属预期，静默忽略即可 ——
 * 所以本函数是「尽力而为」而不是「保证」。
 */
function fsyncPath(p) {
  let fd = null;
  try {
    fd = fs.openSync(p, 'r');
    fs.fsyncSync(fd);
  } catch (e) { /* 平台不支持（如 Windows 目录）/ 路径不存在：忽略 */ } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (e) { /* ignore */ } }
  }
}

async function fsyncPathAsync(p) {
  let fh = null;
  try {
    fh = await fs.promises.open(p, 'r');
    await fh.sync();
  } catch (e) { /* 同上 */ } finally {
    if (fh) { try { await fh.close(); } catch (e) { /* ignore */ } }
  }
}

/**
 * 同步原子写入
 *
 * R27-13：`opts.mode` 用于**密钥类文件**（`secret.key` / `enc.key` / 证书私钥）。
 * 旧实现不传 mode ⇒ Node 默认 `0o666 & ~umask`（常见 `0644`），而权限是在写入**之后**
 * 由调用方 `chmod 0600` 收紧的：两者之间存在一个「同机其他用户可读」的窗口，
 * 且进程若在窗口内被强杀（SIGKILL / OOM / 断电），权限会**永久**停在 0644 ——
 * 重启不会纠正（读取路径不校验权限），而可读的主密钥等于全部云厂商凭据与所有
 * `secure-store` 密文可解。这里改为**创建时**就是目标权限，chmod 只作为兜底保留。
 *
 * @param {string} file
 * @param {string|Buffer} data
 * @param {{mode?: number}} [opts]
 */
function writeAtomicSync(file, data, opts) {
  const tmp = tmpPath(file);
  try {
    fs.writeFileSync(tmp, data, opts && opts.mode ? { mode: opts.mode } : undefined);
    fsyncPath(tmp);            // R27-14：先让数据落盘，再提交 rename
    fs.renameSync(tmp, file);
    fsyncPath(path.dirname(file)); // R27-14：让 rename 本身落盘（POSIX 目录项）
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e2) { /* ignore */ }
    throw e;
  }
}

/**
 * 异步原子写入
 * @param {string} file
 * @param {string|Buffer} data
 * @param {{mode?: number}} [opts] 见 `writeAtomicSync` 的 R27-13 / R27-14 说明
 */
async function writeAtomic(file, data, opts) {
  const tmp = tmpPath(file);
  try {
    await fs.promises.writeFile(tmp, data, opts && opts.mode ? { mode: opts.mode } : undefined);
    await fsyncPathAsync(tmp);   // R27-14
    await fs.promises.rename(tmp, file);
    await fsyncPathAsync(path.dirname(file)); // R27-14
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

/**
 * R28-04：把**已存在**文件的权限收紧到 0600 —— 读取路径上的幂等自愈。
 *
 * 为什么需要：R27-13 只改了**创建**路径（以 `{mode:0o600}` 创建）。一台在修复之前
 * 装好、密钥文件恰好落在 `0644` 的机器（例如写入与 `chmod` 之间被强杀）升级后，
 * 文件权限**不会被纠正** —— 而 `secret.key` 正常运行时**永不重建**，那条暴露就一直
 * 存在，与"已收紧"的说明不符。这里在读取路径上补一次自愈：只在权限确实过宽时动作。
 *
 * 平台注意：Windows 的 `stat.mode` 不表示 POSIX 权限位（实测恒为 0666），照它判断会
 * 每次读都 chmod 一次且毫无意义，故在 Windows 上直接跳过。失败一律静默 —— 权限收紧
 * 是尽力而为，不能因为它把启动搞挂。
 *
 * @param {string} file
 * @returns {boolean} 是否真的做了收紧
 */
function ensurePrivateModeSync(file) {
  if (process.platform === 'win32') return false;
  try {
    const st = fs.statSync(file);
    if ((st.mode & 0o077) === 0) return false; // 已经只有属主可读写
    fs.chmodSync(file, 0o600);
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = { writeAtomicSync, writeAtomic, appendAtomic, sweepOrphanTmp, tmpPath, ensurePrivateModeSync };
