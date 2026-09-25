/**
 * 敏感数据文件安全存储（S4）
 *
 *  - data/enc-settings.json、enc-meta.json、links.json、ipguard.json 等敏感 JSON
 *    统一以 AES-256-GCM 加密落盘，主密钥复用 config-store 的 data/secret.key
 *  - 兼容历史明文文件：读取时自动识别（无 _enc 标记则按明文解析），写入时自动升级为密文
 *  - 提供同步与异步两种写入：同步用于低频关键数据；异步用于较高频数据，
 *    并按文件维度串行化，避免并发 writeFile 交错导致文件损坏
 */
const fs = require('fs');
const path = require('path');
const configStore = require('./config-store');
const atomic = require('./atomic-write');

const ENC_FLAG = '_enc';
const ENC_VERSION = 1;

/**
 * 处于「损坏」状态的文件集合（SEC-09）。
 *
 * 语义：这些文件**存在但读取/解密/解析失败**（不是"不存在"）。
 * 一旦进入该集合，`writeJson*` 将**拒绝写入** —— 因为多数调用方在读取失败后
 * 只会拿到一个空对象，随后任何一次写入都会把这份"空数据"落盘，
 * 覆盖掉那份**唯一**能解密既有密文的元数据（不可逆）。
 */
const corruptFiles = new Set();
let lastWriteError = null;

/**
 * 加密封装。
 *
 * R14-08：**不要** `null, 1` 缩进 —— 这个字符串唯一的消费者是 `JSON.parse`，
 * 而 `data` 是一整串不可读的密文。缩进既换不来任何可读性，又让落盘体积成倍膨胀
 * （序列化的 CPU 与写盘的字节都按这个倍数走）。
 */
function serialize(obj) {
  return JSON.stringify({ [ENC_FLAG]: ENC_VERSION, data: configStore.encrypt(obj) });
}

/** 把损坏文件另存一份备份，让"不可逆"降级为"可人工恢复"，返回备份路径 */
function backupCorrupt(file) {
  try {
    if (!fs.existsSync(file)) return '';
    const dst = `${file}.corrupt-${Date.now()}`;
    fs.copyFileSync(file, dst);
    return dst;
  } catch (e) {
    return '';
  }
}

function corruptError(file, why) {
  const bak = backupCorrupt(file);
  corruptFiles.add(file);
  const err = new Error(
    `敏感数据文件 ${path.basename(file)} ${why}；为防覆盖导致的不可逆数据丢失，已改名为 .corrupt-* 备份`
    + (bak ? `（${path.basename(bak)}）` : '（备份失败，请手工备份）')
    + '，并拒绝写入该文件。请先检查并恢复该文件后重启。'
  );
  err.status = 500;
  err.corrupt = true;
  err.file = file;
  return err;
}

/**
 * 读取 JSON 文件（自动识别加密封装与历史明文）。
 *
 * ⚠️ SEC-09：必须区分两种情况 ——
 *   ① **文件不存在** → 返回 fallback（首次运行的正常路径）；
 *   ② **存在但读取/解密/解析失败** → **抛错**（绝不返回 fallback）。
 * 旧实现把 ② 也当成 ① 静默返回 null，导致 enc-meta.json 被空表覆盖后
 * 所有密文永久无法解密（且无任何告警）—— 这是本项目最不可逆的一类数据丢失。
 *
 * @param {string} file 绝对路径
 * @param {*} fallback 仅用于「文件不存在」时的默认值
 * @throws {Error} 文件存在但无法解析/解密时抛出（status=500, corrupt=true）
 */
function readJson(file, fallback) {
  let raw;
  try {
    if (!fs.existsSync(file)) return fallback;
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw corruptError(file, `读取失败（${e.message}）`);
  }
  let j;
  try {
    j = JSON.parse(raw);
  } catch (e) {
    // 存在但不是合法 JSON —— 与「文件不存在」**完全不同**。
    // 静默返回 fallback 会让调用方拿空表去覆盖 enc-meta.json，密文永久不可解。
    throw corruptError(file, `不是合法 JSON（${e.message}）`);
  }
  if (j && j[ENC_FLAG] === ENC_VERSION && typeof j.data === 'string') {
    try {
      return configStore.decrypt(j.data);
    } catch (e) {
      throw corruptError(file, `解密/完整性校验失败（${e.message}）`);
    }
  }
  return j;
}

/** 写入前守卫：损坏文件一律拒绝写入（唯一例外是显式 force） */
function assertWritable(file, force) {
  if (!force && corruptFiles.has(file)) {
    const err = new Error(
      `敏感数据文件 ${path.basename(file)} 处于损坏状态（已有 .corrupt-* 备份），`
      + '已拒绝写入以避免覆盖造成的不可逆数据丢失。请先恢复该文件并重启服务。'
    );
    err.status = 500;
    err.corrupt = true;
    err.file = file;
    throw err;
  }
}

/**
 * 退出路径「只写不建」的**唯一判据**（R9-08 / R10-01 / R11-07）。
 *
 * 纪律本身很简单：进程退出时绝不创建数据目录 —— 只写、不建。理由：
 *  1. 测试收尾刚把数据目录整体删掉，退出钩子随后走到这里；若仍 `mkdirSync`
 *     就会把它整份重建并写回文件，"清理"被自己的退出钩子撤销（历史上造出过
 *     37 个泄漏目录）。
 *  2. `data/` 在**启动期**就已由 `instance-lock.js` 无条件创建，退出时它必然存在；
 *     不存在只可能是"已被有意删除"，此时不该复活它。
 *
 * 之所以放在这里而不是让各模块各写一遍：这条纪律此前只能靠注释传播
 * —— 讲了三轮，全库 3 处 `process.on('exit')` 只有 1 处遵守（upload-sessions）。
 * 跨模块的纪律必须有唯一实现点，否则必然漏。
 *
 * @param {string} dir 数据目录绝对路径
 * @returns {boolean}
 */
function exitPathWritable(dir) {
  return fs.existsSync(dir);
}

/**
 * 同步写入（加密 + 原子替换）；用于低频但关键的数据，确保调用返回时已落盘。
 *
 * SEC-09：写入失败不再静默 —— 记录 `lastWriteError`（经 /api/health 暴露）
 * 并打印错误；同时拒绝写入处于损坏状态的文件。
 */
function writeJson(file, obj) {
  assertWritable(file);
  try {
    atomic.writeAtomicSync(file, serialize(obj));
    lastWriteError = null;
  } catch (e) {
    lastWriteError = { file, message: e.message, at: new Date().toISOString() };
    console.error(`[secure-store] 写入失败 ${path.basename(file)}: ${e.message}`);
  }
  return obj;
}

/* 按文件维度的串行写队列：保证异步写入顺序，避免并发覆盖 */
const queues = new Map();

/** 异步写入（加密 + 串行）；用于较高频数据，避免阻塞事件循环（P1） */
function writeJsonAsync(file, obj) {
  assertWritable(file);
  const prev = queues.get(file) || Promise.resolve();
  const next = prev
    .then(() => {
      /**
       * R14-08：序列化（`JSON.stringify` + **全量 AES-256-GCM 加密**）必须在**队列内**执行。
       *
       * 旧实现把它放在入队**之前** —— 于是这个"异步写"对调用方仍是一次同步全表加密：
       * `enc-meta` 到 5 万条（约 20MB）时单次 `serialize` 约百毫秒级纯阻塞，
       * 删大目录叠加成数秒的事件循环停顿，期间全站（含正在进行的下载与 WebDAV）
       * 无响应。`config-store.js` 早已为同类问题做了去抖（PERF-02），这里漏了。
       *
       * 顺带修掉两个连带问题：
       *  ① 快照语义由「入队那一刻」变成「真正落盘那一刻」。调用方传的都是内存里
       *     **那份活对象**（enc-meta / upload-sessions / links / payments 一律就地变更），
       *     于是排队期间发生的更新会一并落盘 —— 只会更接近真实状态，不会更旧；
       *     而 `enc-store.js` 的落盘进度跟踪用的是单调递增序号，不依赖快照时点。
       *  ② 序列化失败不再需要「提前 return 一个已 resolve 的 Promise」那条旁路，
       *     统一走下面这条 catch，错误可观（`lastWriteError` → `/api/health`）。
       *
       * 队列此时已按文件维度串行，所以「上一份的加密」与「这一份的加密」不会交错，
       * 总的工作量还不增反减。
       */
      return atomic.writeAtomic(file, serialize(obj));
    })
    .then(() => { lastWriteError = null; })
    .catch((e) => {
      lastWriteError = { file, message: e.message, at: new Date().toISOString() };
      console.error(`[secure-store] 异步写入失败 ${path.basename(file)}: ${e.message}`);
    });
  queues.set(file, next);
  return next;
}

/** 等待某文件全部待写入任务完成（优雅关闭前调用） */
function flush() {
  return Promise.all(Array.from(queues.values())).then(() => undefined);
}

/** 最近的写入错误（供 /api/health 暴露） */
function getLastWriteError() { return lastWriteError; }

/** 处于损坏状态的文件列表（供 /api/health 暴露） */
function corruptList() { return Array.from(corruptFiles).map((f) => path.basename(f)); }

/** 测试/运维：清除损坏标记（仅在人工恢复文件后使用） */
function clearCorrupt(file) { corruptFiles.delete(file); }

/** 将已存在的明文文件升级为加密存储；已是加密格式或不存在时返回 false */
function upgrade(file) {
  try {
    if (!fs.existsSync(file)) return false;
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j && j[ENC_FLAG] === ENC_VERSION) return false;
    writeJson(file, j);
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = {
  readJson, writeJson, writeJsonAsync, flush, upgrade,
  // R11-07：退出路径「只写不建」的共用判据（upload-sessions / enc-store / config-store）
  exitPathWritable,
  getLastWriteError, corruptList, clearCorrupt,
  ENC_FLAG, ENC_VERSION,
};
