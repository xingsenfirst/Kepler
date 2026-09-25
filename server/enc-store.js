/**
 * 文件加密模块 —— 隐私安全（本地加密后上传；验证通过后才解密查看/下载）
 *
 * 三种加密方式（系统设置中可选）：
 *  - none   不加密（默认，行为与旧版完全一致）
 *  - crypto AES-256-GCM 分段高强度加密
 *            密文结构：[魔数 COSCENC01(10B)][分段1: IV(12B) 密文 TAG(16B)][分段2: IV 密文 TAG]…
 *            直传 = 单分段；分片上传 = 每分片一个独立分段（支持断点续传 / 进程重启后继续）
 *            密钥为随机 32 字节，保存在 data/enc.key（务必备份，丢失无法解密）
 *  - magic  文件头魔数覆写 + 流式异或（轻量混淆，可选随机盐 / 自定义魔数）
 *            密文结构：[用户魔数(M B)][异或(原文[M:])]，长度与原文一致
 *            原始文件头保存在本地元数据中，解密时还原
 *
 * 元数据 data/enc-meta.json：{ files: { "<bucket>|<key>": { mode, origSize, crypto|magic, createdAt } } }
 *  - 记录每个密文对象的解密参数（IV/TAG/盐/原始文件头/原始大小）
 *  - 重命名 / 移动 / 复制时同步迁移；删除时清理
 *
 * 查看密码（权限验证）：可选。设置后在线查看 / 下载密文需先 POST /api/enc/unlock
 * 获取短期 HMAC 令牌（30 分钟）。密码仅做访问控制，与加密密钥相互独立（忘记可重置）。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Transform } = require('stream');
const secureStore = require('./secure-store');
const atomicWrite = require('./atomic-write');
const configStore = require('./config-store'); // 仅复用 unwritableError（备份 + 拒绝覆盖语义）
const { LIMITS } = require('./limits'); // R9-09：magic 同步加密上限（性能上限 + 协议下限）

// COS_DATA_DIR：与 payment-orders.js / tests/helpers.js 约定的隔离手段一致 ——
// 未设置时落到项目 data/。这个开关不只是"测试方便"：没有它，任何触碰加密元数据的
// 用例都会往**真实 data/enc-meta.json** 里写假条目（密文的唯一凭据），
// 一旦被误清就是不可逆的解密失败。
const DATA_DIR = process.env.COS_DATA_DIR ? path.resolve(process.env.COS_DATA_DIR) : path.join(__dirname, '..', 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'enc-settings.json');
const META_FILE = path.join(DATA_DIR, 'enc-meta.json');
const KEY_FILE = path.join(DATA_DIR, 'enc.key');

const CRYPTO_MAGIC = Buffer.from('COSCENC01', 'utf8'); // 10 字节：crypto 模式密文头标识
const IV_LEN = 12;
const TAG_LEN = 16;
const SALT_LEN = 16;
const MAX_MAGIC_BYTES = 64;
const DEFAULT_MAGIC_TEXT = 'ENCRYPTED';
const MODES = ['none', 'crypto', 'magic'];
const TOKEN_TTL_MS = 30 * 60 * 1000;

function iso() { return new Date().toISOString(); }
function bad(msg) { const e = new Error(msg); e.status = 400; return e; }

/* ============================ 主密钥 ============================ */

let masterKeyCache = null;

/**
 * 主密钥：随机 32 字节 hex，存 data/enc.key（首次自动生成）
 *
 * FUN-04 同型：`data/secret.key`（config-store）修了「内容不合规就静默换新密钥覆盖」，
 * 本文件必须同步 —— enc.key 是全部 crypto/magic 密文的唯一解密凭据，
 * 一旦被新密钥覆盖，云端所有已加密对象永久不可解。
 * 全库搜「不合规就重新生成密钥」的同型调用点时，两处必须一起改。
 */
function masterKey() {
  if (masterKeyCache) return masterKeyCache;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(KEY_FILE)) {
    const hex = fs.readFileSync(KEY_FILE, 'utf8').trim();
    if (/^[0-9a-f]{64}$/i.test(hex)) { masterKeyCache = Buffer.from(hex, 'hex'); return masterKeyCache; }
    // 文件存在但内容不是合法密钥：备份后抛错，绝不静默覆盖
    throw configStore.unwritableError(KEY_FILE, 'bad', '内容不是合法的 32 字节十六进制密钥');
  }
  masterKeyCache = crypto.randomBytes(32);
  atomicWrite.writeAtomicSync(KEY_FILE, masterKeyCache.toString('hex'));
  try { fs.chmodSync(KEY_FILE, 0o600); } catch (e) { /* 部分平台不支持，忽略 */ } // S4：收紧密钥文件权限
  return masterKeyCache;
}

/* ============================ 设置存储 ============================ */

let settings = null;

function defaultSettings() {
  return {
    mode: 'none',
    magicHex: Buffer.from(DEFAULT_MAGIC_TEXT, 'utf8').toString('hex'),
    useSalt: true, // 随机盐恒开（历史遗留字段，不再提供关闭入口）
    passwordHash: '',
    passwordSalt: '',
    updatedAt: '',
  };
}

function loadSettings() {
  if (settings) return settings;
  // S4：加密存储（兼容历史明文文件）
  // SEC-09：readJson 现在会区分「文件不存在」与「存在但损坏」——后者抛错。
  // 这里捕获后降级为默认设置继续运行，但**不覆盖磁盘**（secure-store 已拒绝写入损坏文件），
  // 并打印醒目告警，等待管理员用 .corrupt-* 备份人工恢复。
  let j = null;
  try {
    j = secureStore.readJson(SETTINGS_FILE, null);
  } catch (e) {
    console.error('[enc-store] 加密设置文件损坏，已降级为默认设置并锁定写入：', e.message);
  }
  if (j && typeof j === 'object') {
    settings = Object.assign(defaultSettings(), {
      mode: MODES.includes(j.mode) ? j.mode : 'none',
      magicHex: /^[0-9a-f]+$/i.test(String(j.magicHex || '')) && j.magicHex.length % 2 === 0 ? String(j.magicHex).toLowerCase() : defaultSettings().magicHex,
      useSalt: true, // 强制开启：即使历史配置为 false 也覆盖为 true
      passwordHash: String(j.passwordHash || ''),
      passwordSalt: String(j.passwordSalt || ''),
      updatedAt: j.updatedAt || '',
    });
  } else {
    settings = defaultSettings();
  }
  return settings;
}

function persistSettings() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  settings.updatedAt = iso();
  secureStore.writeJson(SETTINGS_FILE, settings); // 同步写入：设置变更低频且关键
}

/** 魔数输入解析：'0x' 开头按十六进制，否则按 UTF-8 文本；1-64 字节 */
function parseMagicInput(input) {
  const s = String(input === undefined || input === null ? '' : input).trim();
  if (!s) return null;
  let buf;
  if (/^0x[0-9a-f]+$/i.test(s)) {
    const hex = s.slice(2);
    if (hex.length % 2 !== 0) throw bad('十六进制魔数长度必须为偶数个字符');
    buf = Buffer.from(hex, 'hex');
  } else {
    buf = Buffer.from(s, 'utf8');
  }
  if (!buf.length) throw bad('魔数不能为空');
  if (buf.length > MAX_MAGIC_BYTES) throw bad(`魔数最长 ${MAX_MAGIC_BYTES} 字节（当前 ${buf.length} 字节）`);
  return buf;
}

/**
 * 口令哈希（SEC-05：异步）。
 * 禁止使用 `crypto.scryptSync` —— 它会占满单线程事件循环，
 * 几十个并发请求即可让全站无响应（详见 config-store.js 同名函数的说明）。
 */
function scryptHex(pw, saltHex) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(pw), Buffer.from(saltHex, 'hex'), 32, (err, key) => {
      if (err) reject(err); else resolve(key.toString('hex'));
    });
  });
}

/**
 * 更新设置（PATCH 语义：未传字段保持不变）
 * @param {object} patch { mode?, magic?, useSalt?, password? }
 *   useSalt：已废弃，随机盐恒开（无论传入何值始终为 true）
 *   password: undefined=保持；''=清除；非空=设置新密码
 */
async function updateSettings(patch) {
  const cur = loadSettings();
  if (patch.mode !== undefined) {
    if (!MODES.includes(patch.mode)) throw bad('加密方式无效（可选：none / crypto / magic）');
    cur.mode = patch.mode;
  }
  if (patch.magic !== undefined && patch.magic !== '') {
    const buf = parseMagicInput(patch.magic);
    cur.magicHex = buf.toString('hex');
  }
  cur.useSalt = true; // 随机盐恒开，忽略 patch.useSalt（历史字段，前端已移除开关）
  if (patch.password !== undefined) {
    if (patch.password === null || patch.password === '') {
      cur.passwordHash = '';
      cur.passwordSalt = '';
    } else {
      cur.passwordSalt = crypto.randomBytes(16).toString('hex');
      cur.passwordHash = await scryptHex(patch.password, cur.passwordSalt);
    }
  }
  masterKey(); // 确保密钥文件存在
  persistSettings();
  return settingsView();
}

function settingsView() {
  const s = loadSettings();
  const magicBuf = Buffer.from(s.magicHex, 'hex');
  return {
    mode: s.mode,
    magicHex: s.magicHex,
    magicText: magicBuf.toString('utf8').replace(/\uFFFD/g, '') || magicBuf.toString('hex'),
    useSalt: s.useSalt,
    passwordSet: !!s.passwordHash,
    encryptedCount: Object.keys(loadMeta().files).length,
    updatedAt: s.updatedAt,
  };
}

function currentMode() { return loadSettings().mode; }

/* ============================ 元数据存储 ============================ */

let metaCache = null;
/** SEC-09：加密元数据是否处于「损坏」状态（读取失败）—— 损坏时禁止写入，防不可逆覆盖 */
let metaCorrupt = false;

function loadMeta() {
  if (metaCache) return metaCache;
  // S4：加密存储（兼容历史明文文件）
  // SEC-09：enc-meta.json 是 crypto/magic 模式解密的**唯一**凭据来源
  // （IV/TAG/盐/原始文件头）。一旦读取失败后被空表覆盖，所有既有密文将永久不可解密。
  // 因此这里捕获读取失败并以空表继续运行（保证服务可用），
  // 同时置 metaCorrupt 让 persistMeta 拒绝写入，并打印醒目告警。
  let j = null;
  try {
    j = secureStore.readJson(META_FILE, null);
  } catch (e) {
    metaCorrupt = true;
    console.error('[enc-store] 加密元数据文件损坏，已锁定写入以防不可逆覆盖：', e.message);
  }
  metaCache = { files: (j && typeof j.files === 'object') ? j.files : {} };
  return metaCache;
}

/** 元数据是否处于损坏状态（供健康检查/前端提示） */
function metaIsCorrupt() { return metaCorrupt; }

/**
 * SEC-08：落盘进度跟踪。
 *
 * 一次变更会**独立**排进写队列（R14-08 之后队列内才序列化，排队期间的新变更会被
 * 后一次写一并带下去），所以不能用「异步回调里置 dirty=false」这种写法
 * （后发起的写可能先完成，把更早的回调结果覆盖掉，反而把新变更误标为已落盘）。
 * 改用单调递增序号：每次变更 +1，写完成回调把「已落盘序号」抬到它发起时的序号，
 * 未落盘 = `metaSeq > metaSavedSeq`。
 *
 * 序号语义与快照时点无关：写完成只把 `metaSavedSeq` 抬到**它自己那一次**的序号，
 * 因此哪怕它顺带写了更新后的内容，也不会把更大的序号误标成已落盘（只会更保守）。
 */
let metaSeq = 0;
let metaSavedSeq = 0;

function persistMeta() {
  if (metaCorrupt) {
    // 拒绝写入：磁盘上那份损坏文件是恢复既有密文的最后凭据，绝不能被空表覆盖
    const err = new Error('加密元数据文件处于损坏状态，已拒绝写入以避免不可逆的数据丢失；请先人工恢复 .corrupt-* 备份并重启服务');
    err.status = 500;
    err.corrupt = true;
    throw err;
  }
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const seq = ++metaSeq;
  // 异步串行写入：元数据变更较频繁，避免阻塞事件循环（P1）
  secureStore.writeJsonAsync(META_FILE, loadMeta())
    .then(() => { if (seq > metaSavedSeq) metaSavedSeq = seq; }, () => {});
}

/** 是否存在尚未落盘的元数据变更 */
function metaDirty() { return metaSeq > metaSavedSeq; }

/**
 * 同步落盘元数据（幂等；无变更时不产生任何 I/O）。
 *
 * SEC-08：`enc-meta.json` 是 crypto/magic 解密的**唯一**凭据。异步写留下一个
 * 「云端已有密文、本地还没落盘」的窗口，此时崩溃 = 该文件永久不可解。
 * 上传成功等关键节点调用本函数把窗口压到零；`exit` 钩子再兜一次底。
 */
function flushMeta() {
  if (!metaDirty()) return false;
  if (metaCorrupt) return false; // 损坏状态下不写（persistMeta 已在变更点抛错）
  try {
    persistMetaSync();
    metaSavedSeq = metaSeq;
    return true;
  } catch (e) {
    console.error('[enc-store] 元数据同步落盘失败：', e.message);
    return false;
  }
}

/**
 * 同步落盘元数据（幂等；无变更时不产生任何 I/O）。
 *
 * @param {{exit?: boolean}} [opts] exit=true 表示调用来自**进程退出钩子**：
 *   此时走「只写不建」（见 secureStore.exitPathWritable），目录不存在即跳过。
 *
 * ## R11-07：退出路径只写不建
 *
 * R9-08 / R10-01 在 `upload-sessions` 确立了这条纪律（清理掉的 `data/` 不该被退出
 * 钩子复活），但同一纪律没有同步到本模块 —— 这里的 `mkdirSync` 被 `process.on('exit')`
 * 直接触达，于是被删掉的 `COS_DATA_DIR` 与 `enc-meta.json` 会被一起复活
 * （还带着当前桶的密文元数据）。
 *
 * 注意区分两条路径：**在线**路径（`flushMeta()` → `persistMeta()`）仍应允许建目录 ——
 * 首次写入时目录可能尚不存在；只有退出路径才受此约束。
 */
function persistMetaSync(opts = {}) {
  if (metaCorrupt) {
    const err = new Error('加密元数据文件处于损坏状态，已拒绝写入以避免不可逆的数据丢失；请先人工恢复 .corrupt-* 备份并重启服务');
    err.status = 500;
    err.corrupt = true;
    throw err;
  }
  /**
   * R11-07：退出阶段绝不建目录（只写不建）。
   * R12-03：判据改用**唯一实现点** `secureStore.exitPathWritable()` —— 此前这里是
   * 第二份内联实现，于是「把 canonical 改成 `return true`」这种回归无人能发现
   * （第 12 轮实测：invariants 15/15 与 audit11 15/15 全绿）。
   */
  if (opts.exit && !secureStore.exitPathWritable(DATA_DIR)) return;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  secureStore.writeJson(META_FILE, loadMeta());
}

/** 退出路径的同步落盘（R11-07：只写不建）。与 upload-sessions.flushSync() 同款 */
function flushMetaSync() {
  if (!metaDirty()) return false;
  try {
    persistMetaSync({ exit: true });
    metaSavedSeq = metaSeq;
    return true;
  } catch (e) { return false; }
}

// SEC-08 兜底：进程退出时把尚未落盘的元数据刷出（writeFileSync 在 exit 钩子里仍可用）。
// 只监听 'exit' —— 不接 SIGINT/SIGTERM 是为了**不抢走**应用自身的优雅停机逻辑
// （注册这些信号会覆盖 Node 默认的退出行为）。
process.on('exit', () => {
  try { if (metaDirty()) persistMetaSync({ exit: true }); } catch (e) { /* 退出途中无法再补救 */ }
});

/**
 * 元数据键：**仅按云端桶名 + 对象键**（R7-15 已知限制，刻意不改）。
 *
 * 若两个服务商绑定了**同名桶**（如 A 厂商与 B 厂商各有一个 `my-bucket`），两者的元数据会
 * 互相覆盖，`removeBucketMeta()` 也会连坐清空。要修就得把 provider/region 并入键，
 * 而那是一场数据迁移 —— 键一变，全部既有条目立刻失联，等于让现网密文**永久不可解**。
 * 得失完全不成比例，因此这里保持原样，只在删桶路径上按桶名清理（行为不变）。
 */
function metaKey(bucket, key) { return `${bucket}|${key}`; }

function getMeta(bucket, key) {
  const m = loadMeta().files[metaKey(bucket, key)];
  return m ? JSON.parse(JSON.stringify(m)) : null;
}

function setMeta(bucket, key, entry) {
  loadMeta().files[metaKey(bucket, key)] = entry;
  persistMeta();
  return entry;
}

function removeMeta(bucket, key) {
  const files = loadMeta().files;
  const k = metaKey(bucket, key);
  if (!files[k]) return false;
  delete files[k];
  persistMeta();
  return true;
}

/**
 * R8-03：**覆盖写入成功之后**的元数据对账（全库唯一入口）。
 *
 * 为什么必须有这一步：加密元数据描述的是「云端那个对象当前是什么」。
 * 覆盖写入时若新模式是明文（`mode==='none'`），云端对象已经变成明文，
 * 而本地旧条目还在 —— 于是：
 *   · 旧条目是 `crypto` → 下载时读不到 `COSCENC01` 魔数 → 报错，
 *     但响应头已按 `origSize` 写了 `Content-Length`，浏览器拿到一个中途死亡的下载；
 *   · 旧条目是 `magic`  → **不报错**：拿旧盐还原文件头再异或，用户得到
 *     「看起来正常、内容全错」的文件 —— 静默损坏比报错更糟。
 *
 * 与 R7-02 是同一契约的两面：R7-02 防「本地先于云端」（putObject 失败却写了凭据），
 * 本函数防「本地多了一份云端已被替换掉的事实」。
 *
 * ⚠️ 调用点必须在云端写入**确认成功之后** —— 与 R7-02 同一条纪律：
 * 提前清理会在写入失败时把仍然有效的解密凭据删掉，同样不可逆。
 *
 * @param {object|null} meta `encryptBuffer()/buildFinalMeta()` 的产物；null = 本次写入是明文
 * @returns {boolean} 是否改动了元数据
 */
function reconcileAfterWrite(bucket, key, meta) {
  if (meta) { setMeta(bucket, key, meta); flushMeta(); return true; }
  if (removeMeta(bucket, key)) { flushMeta(); return true; }
  return false;
}

/**
 * 批量删除指定 key 的元数据（FUN-04 / FUN-04b）
 *
 * 只接受**已确认在云端删除成功**的 key 列表。
 *
 * 本项目曾有一个 `removeMetaPrefix(bucket, prefix)`：按前缀**无条件**清空元数据。
 * 它与「列举被 cap 截断」这个缺陷组合时会造成不可逆损失 —— 只删掉前 N 个对象，
 * 却把整个前缀（含未删对象）的元数据清空，残留密文永久不可解。
 * 该 API 已从代码中**彻底移除**（而非仅弃用）：只要它还存在，这个缺陷就迟早复发。
 * 删除目录时请配合「循环删除 + 按确认删除的 key 逐批清理」的契约使用本函数。
 *
 * 这里同时把持久化合并为一次，避免逐 key 触发写队列造成写放大。
 *
 * @param {string} bucket
 * @param {string[]} keys 已在云端确认删除成功的 key
 * @returns {number} 实际删除的元数据条数
 */
function removeMetaBatch(bucket, keys) {
  if (!Array.isArray(keys) || !keys.length) return 0;
  const files = loadMeta().files;
  let n = 0;
  for (const key of keys) {
    const k = metaKey(bucket, key);
    if (files[k]) { delete files[k]; n++; }
  }
  if (n) persistMeta();
  return n;
}

/** 重命名 / 移动：单个对象元数据迁移 */
function renameMeta(bucket, fromKey, toKey) {
  const files = loadMeta().files;
  const from = metaKey(bucket, fromKey);
  const to = metaKey(bucket, toKey);
  if (!files[from]) return false;
  files[to] = files[from];
  delete files[from];
  persistMeta();
  return true;
}

/**
 * 前缀整体迁移（文件夹重命名/移动），返回迁移条数。
 *
  * 陈旧条目清理（R9-03 的诉求）：把明文目录移动/复制到曾存放过密文的同名 key 上时，
  * 目标残留的旧密文元数据会被下游当作「这个 key 是密文」而使用：
  *   · 旧条目 crypto → 下载报「密文头部标识不匹配」并中途断流；
  *   · 旧条目 magic  → **静默产出内容全错的明文**。
  * 与单对象覆盖写入（`reconcileAfterWrite`）是同一类问题，只是作用域从 key 升到 prefix。
  *
  * ⚠️ R10-04：清理范围**只能**是「本次确实被覆盖写入的目标 key」。
  *
  * 上一版按「目标前缀下有、源前缀没有」来清，对**合并语义**是净负改动：
  * `movePrefix`（WebDAV 目录 MOVE）是「逐对象复制 + 删源」，**从不删目标已有对象**。
  * 于是把 `dirA/` 合并进已有 `dirB/keep.bin` 的 `dirB/` 时，`keep.bin` 的云端密文
  * 原封不动，本地元数据却被删掉 —— 把「合并后未被覆盖的对象仍可正常使用」变成了
  * **永久不可解**。这比它想修的问题更严重。
  *
  * 因此改为由调用方显式传入本次覆盖写入的相对键集合；不传则不清理（保守）。
  *
  * @param {string} bucket
  * @param {string} fromPrefix 源前缀（含尾 `/`）
  * @param {string} toPrefix 目标前缀（含尾 `/`）
  * @param {{overwriteRelKeys?: Set<string>}} [opts] 本次**确实覆盖写入**的目标相对键。
  *   仅清理其中「目标有元数据、而源侧没有迁过来」的条目（即明文覆盖了密文）。
  *   不传 = 不清理（不确定就不动）。
  * @returns {{moved: number, cleared: number}}
  */
 function migratePrefix(bucket, fromPrefix, toPrefix, opts = {}) {
   const files = loadMeta().files;
   const from = metaKey(bucket, fromPrefix);
   const to = metaKey(bucket, toPrefix);
   const overwrite = (opts && opts.overwriteRelKeys instanceof Set) ? opts.overwriteRelKeys : null;
   let n = 0;
   const sourceKeys = new Set();
   for (const k of Object.keys(files)) {
     if (k.startsWith(from)) sourceKeys.add(k.slice(from.length));
   }
   // 先清陈旧：只清理「本次被覆盖写入」且「源侧没有元数据迁过来」的目标条目
   let cleared = 0;
   if (overwrite) {
     for (const rel of overwrite) {
       if (!rel) continue;
       // 源侧有对应条目 → 迁移时会覆盖它，无需先删
       if (sourceKeys.has(rel)) continue;
       const tk = to + rel;
       if (files[tk] === undefined) continue;
       delete files[tk];
       cleared++;
     }
   }
   for (const k of Object.keys(files)) {
     if (k.startsWith(from)) {
       const nk = to + k.slice(from.length);
       files[nk] = files[k];
       delete files[k];
       n++;
     }
   }
   if (n || cleared) persistMeta();
   return { moved: n, cleared };
 }

/** 复制对象（云端密文复制后解密参数不变）：元数据一并复制 */
function copyMeta(bucket, fromKey, toKey) {
  const files = loadMeta().files;
  const from = metaKey(bucket, fromKey);
  if (!files[from]) return false;
  files[metaKey(bucket, toKey)] = JSON.parse(JSON.stringify(files[from]));
  persistMeta();
  return true;
}

/** 清空某桶全部加密元数据（清空文件 / 彻底删除存储桶时调用） */
function removeBucketMeta(bucket) {
  const files = loadMeta().files;
  const pre = `${bucket}|`;
  let n = 0;
  for (const k of Object.keys(files)) {
    if (k.startsWith(pre)) { delete files[k]; n++; }
  }
  if (n) persistMeta();
  return n;
}

/** 批量判断哪些 key 是密文（供 /fs/list 标记 🔒） */
function encryptedSetFor(bucket, keys) {
  const files = loadMeta().files;
  const out = new Set();
  for (const k of keys || []) {
    if (files[metaKey(bucket, k)]) out.add(k);
  }
  return out;
}

/**
 * 元数据一致性巡检（M2）。
 *
 * 背景：删除/重命名对象时需同步更新 enc-meta。若「云端操作成功但本地元数据写入失败」
 * 或「对象被本系统之外的工具删除」，会残留指向已不存在对象的元数据（孤儿记录）。
 * 对已加密对象而言，元数据是**解密所必需**的 —— 元数据丢失即文件永久不可解；
 * 反之孤儿记录长期累积还会无谓膨胀文件。
 *
 * 本函数列出某桶下「本地有元数据、但云端已无对应对象」的 key（孤儿候选），
 * 交由调用方决定是否清理（不在此处自动删除，避免误判导致解密信息丢失）。
 *
 * @param {string} bucket 桶名
 * @param {string[]} cloudKeys 该桶当前云端存在的全部 key
 * @returns {{ orphans: string[], total: number }}
 */
function findOrphanMeta(bucket, cloudKeys) {
  const prefix = `${bucket}|`;
  const cloud = new Set(cloudKeys || []);
  const orphans = [];
  let total = 0;
  for (const mk of Object.keys(loadMeta().files)) {
    if (!mk.startsWith(prefix)) continue;
    total++;
    const key = mk.slice(prefix.length);
    if (!cloud.has(key)) orphans.push(key);
  }
  return { orphans, total };
}

/** 统计某桶的加密元数据条数（不含为其他桶） */
function metaCountForBucket(bucket) {
  const prefix = `${bucket}|`;
  return Object.keys(loadMeta().files).filter((mk) => mk.startsWith(prefix)).length;
}

/* ============================ 异或密钥流（magic 模式） ============================ */

/**
 * 生成覆盖原文偏移 [offset, offset+length) 的密钥流
 * 分块：块 i = SHA256(主密钥 || 盐 || u32be(i))，纯位置函数 → 分片上传无需会话状态
 */
function xorKeystream(offset, length, salt) {
  const key = masterKey();
  const out = Buffer.alloc(length);
  if (!length) return out;
  const startBlock = Math.floor(offset / 32);
  const endBlock = Math.floor((offset + length - 1) / 32);
  const stream = Buffer.alloc((endBlock - startBlock + 1) * 32);
  for (let b = startBlock; b <= endBlock; b++) {
    const h = crypto.createHash('sha256')
      .update(key)
      .update(salt || Buffer.alloc(0))
      .update(Buffer.from([(b >>> 24) & 0xff, (b >>> 16) & 0xff, (b >>> 8) & 0xff, b & 0xff]))
      .digest();
    h.copy(stream, (b - startBlock) * 32);
  }
  stream.copy(out, 0, offset - startBlock * 32, offset - startBlock * 32 + length);
  return out;
}

/**
 * 异或（原地）。
 *
 * 性能要点：
 *  1. 按 32 位（4 字节）字循环而非逐字节 —— 循环次数降为 1/4，且
 *     `readUInt32BE`/`writeUInt32BE` 为原生实现，大文件解密时 CPU 占用显著低于
 *     逐字节异或（原实现会打满单核并挤占 MAX_ENCRYPT_READERS 名额）；
 *  2. PERF-03：密钥流**逐块生成、就地消耗**，不再一次性分配与明文等长的缓冲。
 *     旧实现一次 48MB 分片会同时持有「原始 + 副本 + 整段密钥流 + 输出 + concat 结果」
 *     约 5 份 48MB（峰值 ≈240MB）；现在密钥流只占一个 64KB 的小窗口，
 *     峰值直接降 1 份（≈48MB），且对超大分片不再随长度放大。
 *
 * 尾部不足 4 字节的部分按字节处理，保证任意长度正确。
 */
function xorBuf(buf, offset, salt) {
  const n = buf.length;
  if (!n) return buf;
  const key = masterKey();
  const saltBuf = salt || Buffer.alloc(0);

  // 按 32 字节块推进：窗口内的块可复用于多个字，减少 SHA256 调用次数。
  //
  // 窗口大小必须**按需取小**：固定 2048 块（64KB）时，一个 4 字节的调用也要算
  // 2048 次 SHA-256（实测 3.4ms/次），小缓冲场景会被放大成数十秒级退化。
  // 这里取 min(上限, 实际需要 + 余量)，大分片仍享受窗口复用，小缓冲则只算必要的块。
  const WINDOW_MAX_BLOCKS = 2048; // 上限：64KB 窗口，限制峰值内存
  let block = Math.floor(offset / 32);
  // +2：① 一个 4 字节字可能跨越块边界（pos%32 ∈ [29,31]）需读到下一块；
  //     ② offset 非 32 对齐时首块只用到一部分，尾块同理。
  const needBlocks = Math.ceil(n / 32) + 2;
  const winBlocks = Math.min(WINDOW_MAX_BLOCKS, needBlocks);
  let windowStart = block;
  let stream = fillKeystream(key, saltBuf, windowStart, winBlocks);

  const ensureBlock = (b) => {
    if (b >= windowStart && b + 1 < windowStart + winBlocks) return;
    windowStart = b;
    stream = fillKeystream(key, saltBuf, windowStart, winBlocks);
  };

  const words = n >>> 2; // 完整的 4 字节字数
  for (let i = 0; i < words; i++) {
    const p = i << 2;
    const pos = offset + p;
    const b = Math.floor(pos / 32);
    ensureBlock(b);
    const sOff = (b - windowStart) * 32 + (pos - b * 32);
    buf.writeUInt32BE((buf.readUInt32BE(p) ^ stream.readUInt32BE(sOff)) >>> 0, p);
  }
  for (let i = words << 2; i < n; i++) {
    const pos = offset + i;
    const b = Math.floor(pos / 32);
    ensureBlock(b);
    buf[i] ^= stream[(b - windowStart) * 32 + (pos - b * 32)];
  }
  return buf;
}

/** 生成从 startBlock 起的 blocks 个密钥流块（每块 32 字节） */
function fillKeystream(key, saltBuf, startBlock, blocks) {
  const out = Buffer.alloc(blocks * 32);
  const w = Buffer.alloc(4);
  for (let i = 0; i < blocks; i++) {
    const b = startBlock + i;
    w[0] = (b >>> 24) & 0xff; w[1] = (b >>> 16) & 0xff; w[2] = (b >>> 8) & 0xff; w[3] = b & 0xff;
    crypto.createHash('sha256').update(key).update(saltBuf).update(w).digest()
      .copy(out, i * 32);
  }
  return out;
}

/* ============================ 加密：直传（整文件） ============================ */

/**
 * 整文件加密（直传路径）
 *
 * ⚠️ **本函数不写元数据**（R7-02）。解密凭据（IV / TAG / 盐 / 原始文件头）必须由调用方
 * 在「云端写入**确认成功之后**」自行 `setMeta(bucket, key, enc.meta)` 并 `flushMeta()`。
 *
 * 曾经在这里直接 `setMeta()`，而 `setMeta()` 内部会立刻排一次异步落盘 —— 于是顺序变成了
 * 「先改本地元数据，再写云端」：一旦 `putObject` 失败（超时 / 413 / 断网 / 权限），
 * 云端仍是**旧密文**，本地的 IV / TAG / 盐却已被新值覆盖 → 该文件**永久不可解**。
 * 这与 FUN-04 / FUN-11 反复强调的「元数据只在云端确认成功之后才动」正好相反。
 *
 * R9-09：**magic 模式拒绝超限输入**。本函数是同步的，且 magic 的密钥流每 32 字节
 * 做一次 SHA-256 —— 单次传入越大，事件循环被占住越久（5MB ≈ 418ms、48MB ≈ 4.0s）。
 * 该上限以前只加在分片路径的 `chunkSize` 上，直传与 WebDAV PUT 两条入口可绕过。
 * 现在把判定**放进加密入口**：凡是走 magic 的整文件加密，超过 `LIMITS.MAGIC_SYNC_MAX`
 * 一律拒绝并要求改用分片上传 —— 而不是在每个调用点各写一次（那正是「同一状态多入口，
 * 改一处漏一处」）。
 *
 * 注意上限同时是 AWS S3 的分片下限（除末片外 ≥ 5MB），详见 `limits.js` 的注释。
 *
 * @returns { data: Buffer, meta: object } | null（mode=none 时返回 null，调用方跳过）
 * @throws {Error} magic 模式下输入超过上限（status 413，提示改用分片上传）
 */
function encryptBuffer(bucket, key, buf) {
  const s = loadSettings();
  if (s.mode === 'none') return null;
  if (s.mode === 'magic' && buf && buf.length > LIMITS.MAGIC_SYNC_MAX) {
    const e = new Error(
      `文件过大（${buf.length} 字节）无法用「文件头魔数」模式一次性加密：`
      + `该模式为同步加密，上限 ${LIMITS.MAGIC_SYNC_MAX} 字节（${Math.round(LIMITS.MAGIC_SYNC_MAX / 1048576)}MB）。`
      + '请改用分片上传（会自动按上限切分），或换用「AES-256-GCM」模式。'
    );
    e.status = 413;
    throw e;
  }
  if (s.mode === 'crypto') {
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
    const ct = Buffer.concat([cipher.update(buf), cipher.final()]);
    const tag = cipher.getAuthTag();
    const data = Buffer.concat([CRYPTO_MAGIC, iv, ct, tag]);
    const meta = {
      mode: 'crypto', origSize: buf.length, createdAt: iso(),
      crypto: { segments: [{ n: 1, iv: iv.toString('hex'), ctLen: buf.length, tag: tag.toString('hex') }] },
    };
    // R7-02：不在此落盘元数据 —— 由调用方在云端写入成功后写入（见函数头部说明）
    return { data, meta };
  }
  // magic：魔数覆写文件头 + 其余流式异或
  //
  // FUN-11：magic 原为「无认证标签」的纯异或，云端密文一旦被损坏或恶意篡改，
  // 解密会**静默产出看似正常但内容错误**的明文，与 crypto 分支的 GCM 认证形成强烈反差。
  // 这里在元数据中记录明文的 SHA-256，解密流末尾校验，失败即报错。
  // 注意：这只增加**完整性校验**，不提升保密强度 —— magic 仍只是「混淆级保护」。
  const magic = Buffer.from(s.magicHex, 'hex');
  const M = magic.length;
  const salt = s.useSalt ? crypto.randomBytes(SALT_LEN) : null;
  const header = Buffer.from(buf.slice(0, M)); // 原始文件头（解密时还原）
  const body = xorBuf(Buffer.from(buf.slice(M)), 0, salt);
  const data = Buffer.concat([magic, body]);
  const meta = {
    mode: 'magic', origSize: buf.length, createdAt: iso(),
    magic: {
      salt: salt ? salt.toString('hex') : null,
      header: header.toString('base64'),
      magicLen: M,
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    },
  };
  // R7-02：同上，不在加密阶段写元数据
  return { data, meta };
}

/* ============================ 加密：分片上传 ============================ */

/**
 * 加密单个分片（multipart 路径）。会话加密状态存于 sess.enc（随 upload-sessions.json 持久化），
 * magic 模式的盐 / 原始文件头在首次加密时固定，进程重启后断点续传仍一致。
 *
 * 注意：调用方需自行保证 sess.enc 与当前设置模式一致（不一致应在路由层拒绝）。
 * @param {object} sess 上传会话（含 chunkSize / size / enc）
 * @param {number} partNumber 分片序号（从 1 开始）
 * @param {Buffer} plainBuf 该分片的明文数据
 * @returns { Buffer } 加密后的分片内容（上传到对象存储的字节）
 */
function encryptPart(sess, partNumber, plainBuf) {
  const s = loadSettings();
  if (s.mode === 'none') return plainBuf;
  if (!sess.enc) sess.enc = { mode: s.mode, parts: {} };

  /**
   * R11-08：magic 上限的**最内层兜底**（与 `encryptBuffer` 同一契约）。
   *
   * 这个上限此前连续 5 轮出现在不同入口上：R8-02（init 的分片大小）→ R9-09
   * （`encryptBuffer`，覆盖直传与 WebDAV PUT）→ R10-05（init 的 simple/multipart
   * 分界）→ R10-08（chunk 路由校验 chunkSize）→ R11-08（会话缺 chunkSize、
   * 会话创建后模式被切换导致上限被放大两条绕行）。
   *
   * 判决规则：一个上限在第 5 个入口上仍然可绕时，就不再逐入口补 —— 直接下沉到
   * 最内层函数一次。无论调用方怎么算的 `chunkSize`、会话是什么时候建的、模式
   * 中途怎么变的，超限输入在这里一律被拒。
   */
  /**
   * R12-05：magic 分片偏移在会话缺 `chunkSize` 时是 `NaN`。
   *
   * `:785` 的 `base = (partNumber - 1) * sess.chunkSize` 在 `chunkSize` 缺失
   * （7 天有效期内的历史 `upload-sessions.json` 就是这样的会话）时得到 `NaN`，
   * 于是第 2 片起一律 `RangeError: The value of "offset" is out of range` → 500，
   * 任务**永久卡死**（第 1 片已成功且已落盘），只能取消重传，旧分片持续计费到下次
   * `prune`。更隐蔽的是 `:836` 的 `normalisePartDigests` 在同样条件下返回 `null` →
   * `integrity: 'none'` → FUN-11 的完整性校验**同时失效**（比 500 更难发现）。
   *
   * 这里在**入口**把它挡住（最内层兜底，与上面的分片上限同款）：非正有限数即 409，
   * 文案给出路（取消任务重传）。
   */
  if (s.mode === 'magic' && !(Number(sess.chunkSize) > 0 && Number.isFinite(Number(sess.chunkSize)))) {
    const e = new Error(
      '该上传任务未记录有效的分片大小，无法按「文件头魔数」模式计算分片偏移'
      + '（偏移由分片大小决定）。请取消该上传任务后重新上传。'
    );
    e.status = 409;
    throw e;
  }

  if (s.mode === 'magic' && plainBuf && plainBuf.length > LIMITS.MAGIC_SYNC_MAX) {
    const e = new Error(
      `分片过大（${plainBuf.length} 字节）无法用「文件头魔数」模式同步加密：`
      + `该模式的同步上限为 ${LIMITS.MAGIC_SYNC_MAX} 字节（${Math.round(LIMITS.MAGIC_SYNC_MAX / 1048576)}MB）。`
      + '本次上传任务的分片大小与该上限不符（可能是加密方式在上传过程中被切换），'
      + '请取消该上传任务后重新上传。'
    );
    e.status = 413;
    throw e;
  }

  if (s.mode === 'magic') {
    const magic = Buffer.from(s.magicHex, 'hex');
    const M = magic.length;
    if (sess.enc.salt === undefined) {
      sess.enc.salt = s.useSalt ? crypto.randomBytes(SALT_LEN).toString('hex') : null;
      sess.enc.magicLen = M;
    }
    // FUN-11：分片路径同样累加明文摘要。
    // 只在分片**按序**到达时推进 —— 摘要是有状态的，乱序无法拼出整体摘要。
    // 若未能覆盖全部分片，则退化为「不校验」（与旧行为一致），但元数据中会显式标记。
    if (!sess.enc.parts) sess.enc.parts = {};
    sess.enc.parts[partNumber] = { sha256: crypto.createHash('sha256').update(plainBuf).digest('hex') };
    const salt = sess.enc.salt ? Buffer.from(sess.enc.salt, 'hex') : null;
    if (partNumber === 1) {
      sess.enc.header = Buffer.from(plainBuf.slice(0, M)).toString('base64'); // 幂等：同一数据结果一致
      return Buffer.concat([magic, xorBuf(Buffer.from(plainBuf.slice(M)), 0, salt)]);
    }
    const base = (partNumber - 1) * sess.chunkSize;
    return xorBuf(Buffer.from(plainBuf), base - M, salt);
  }

  // crypto：每分片独立 GCM 分段（断点续传 / 重启安全）
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
  const ct = Buffer.concat([cipher.update(plainBuf), cipher.final()]);
  const tag = cipher.getAuthTag();
  sess.enc.parts[partNumber] = { iv: iv.toString('hex'), tag: tag.toString('hex'), ctLen: plainBuf.length };
  return partNumber === 1
    ? Buffer.concat([CRYPTO_MAGIC, iv, ct, tag])
    : Buffer.concat([iv, ct, tag]);
}

/**
 * 规整分片摘要（FUN-11 的 multipart 分支）
 *
 * 分片 utf-8 边界是**确定性**的：分片 n 覆盖明文偏移 [(n-1)*chunkSize, n*chunkSize)，
 * 仅分片 1 的前 magicLen 字节被魔数覆写（不计入密文、由 header 还原）。
 * 因此只要 `1..N` 全部到齐，就能在解密时对每一段独立校验。
 *
 * @returns {Array<{offset:number, len:number, sha256:string}>|null} 任一序号缺失时返回 null
 */
function normalisePartDigests(parts, size, chunkSize, magicLen) {
  if (!parts || typeof parts !== 'object') return null;
  const total = Number(size) || 0;
  const cs = Number(chunkSize) || 0;
  if (!total || !cs) return null;
  const n = Math.ceil(total / cs);
  const out = [];
  for (let i = 1; i <= n; i++) {
    const rec = parts[i] || parts[String(i)];
    if (!rec || !rec.sha256) return null;
    const start = (i - 1) * cs;
    const len = Math.min(cs, total - start);
    if (len <= 0) return null;
    // 偏移按**还原后的完整明文流**计算：分片 1 的前 magicLen 字节虽被魔数覆写，
    // 但解密时由 header 还原回明文的最前面 —— 因此该段的摘要仍覆盖 [0, cs) 全段。
    out.push({ offset: start, len, sha256: rec.sha256 });
  }
  return out;
}

/**
 * 完成分片上传后，依据会话加密状态生成最终元数据（不落盘，由调用方在
 * multipartComplete 成功后调用 setMeta 写入）。
 * @returns { object | null } null = 本次上传未加密
 */
function buildFinalMeta(sess) {
  if (!sess.enc || !sess.enc.mode || sess.enc.mode === 'none') return null;
  if (sess.enc.mode === 'magic') {
    if (!sess.enc.header) throw bad('分片上传元数据不完整（缺少原始文件头），请取消任务后重新上传');
    // FUN-11：分片**连续且完整**时给出逐片摘要，解密端点位即在确定性边界上逐个校验，
    // 使 magic 模式也具备篡改可检出能力。缺失任一分片则不声称可校验（回退旧行为）。
    const partDigests = normalisePartDigests(sess.enc.parts, sess.size, sess.chunkSize, sess.enc.magicLen);
    return {
      mode: 'magic', origSize: sess.size, createdAt: iso(),
      magic: {
        salt: sess.enc.salt || null,
        header: sess.enc.header,
        magicLen: sess.enc.magicLen,
        integrity: partDigests ? 'parts' : 'none',
        parts: partDigests || undefined,
      },
    };
  }
  const parts = Object.entries(sess.enc.parts || {});
  if (!parts.length) throw bad('分片上传元数据不完整（无加密分段），请取消任务后重新上传');
  const uploaded = Object.keys(sess.parts || {});
  for (const n of uploaded) {
    if (!sess.enc.parts[n]) throw bad(`第 ${n} 分片缺少加密元数据（可能以明文上传），请取消任务后重新上传`);
  }
  const segments = parts
    .map(([n, v]) => ({ n: Number(n), iv: v.iv, tag: v.tag, ctLen: v.ctLen }))
    .sort((a, b) => a.n - b.n);
  return { mode: 'crypto', origSize: sess.size, createdAt: iso(), crypto: { segments } };
}

/* ============================ 解密流 ============================ */

/**
 * 构造解密 Transform：输入云端密文字节流，输出原始明文流。
 *
 * - crypto 模式逐段校验 GCM 认证标签（任何篡改/损坏都会报错，不会输出损坏明文）；
 * - magic 模式（FUN-11）用元数据的 SHA-256 校验完整性 —— 该模式本无认证标签，
 *   旧实现会静默产出被篡改的「看似正常」明文，在只读归档/备份场景下尤其危险。
 *   缺少摘要信息（历史文件）时不校验，保持向后兼容。
 */
function decryptTransform(meta) {
  const mk = masterKey();

  if (meta.mode === 'magic') {
    const M = meta.magic.magicLen;
    const header = Buffer.from(meta.magic.header, 'base64');
    const salt = meta.magic.salt ? Buffer.from(meta.magic.salt, 'hex') : null;
    const expected = meta.magic.sha256 || null;                    // 单块上传的整体摘要
    const partChecks = Array.isArray(meta.magic.parts) ? meta.magic.parts : null;
    const hasCheck = !!(expected || partChecks);
    let skipped = 0, emitted = false, counter = 0;
    let whole = expected ? crypto.createHash('sha256') : null;
    // 分段校验：按**还原后明文**的偏移推进，任一段摘要不符立即失败。
    // 注意 counter 是密文体偏移（不含被魔数覆写的头部 M 字节），
    // 而摘要按完整明文分段 —— 因此需要一个独立的明文游标 pEnd。
    let pIdx = partChecks ? 0 : -1;
    let partAcc = pIdx >= 0 ? crypto.createHash('sha256') : null;
    let pEnd = 0;

    /**
     * 输出明文并推进分段校验。
     *
     * 关键点：**必须按分段边界切分**缓冲区。若一个 chunk 跨越两个分段，
     * 把整块喂进当前累加器再 digest，会让下一分段丢失属于它的那部分字节，
     * 导致正常文件被误判为篡改。
     */
    const pushWithCheck = (buf, t) => {
      if (whole) whole.update(buf);
      if (partAcc === null) { pEnd += buf.length; t.push(buf); return; }
      let off = 0;
      while (off < buf.length) {
        const seg = partChecks[pIdx];
        if (!seg) {
          // 超出已知分段范围（理论上不会发生）：照常输出，不再校验
          const rest = buf.subarray(off);
          pEnd += rest.length;
          t.push(rest);
          break;
        }
        const segEnd = seg.offset + seg.len;
        const room = Math.max(0, segEnd - pEnd);
        const takeN = Math.min(room || buf.length, buf.length - off);
        const piece = buf.subarray(off, off + takeN);
        partAcc.update(piece);
        pEnd += takeN;
        t.push(piece);
        off += takeN;
        if (pEnd >= segEnd) {
          const got = partAcc.digest('hex');
          pIdx += 1;
          partAcc = pIdx < partChecks.length ? crypto.createHash('sha256') : null;
          if (seg.sha256 !== got) {
            throw new Error('magic 密文完整性校验失败：文件内容已被篡改或损坏');
          }
        }
      }
    };

    return new Transform({
      transform(chunk, enc, cb) {
        try {
          let data = chunk;
          if (skipped < M) {
            const skip = Math.min(M - skipped, data.length);
            data = data.subarray(skip);
            skipped += skip;
            if (!data.length) return cb();
          }
          if (!emitted) { emitted = true; pushWithCheck(header, this); } // 还原被魔数覆写的原始文件头
          if (data.length) {
            const plain = xorBuf(Buffer.from(data), counter, salt);
            counter += data.length;
            pushWithCheck(plain, this);
          }
          cb();
        } catch (e) { cb(e); }
      },
      flush(cb) {
        if (skipped < M) return cb(new Error('密文数据不完整（短于魔数长度）'));
        if (!emitted) { try { pushWithCheck(header, this); } catch (e) { return cb(e); } }
        if (!hasCheck) return cb();
        try {
          if (whole && whole.digest('hex') !== expected) {
            return cb(new Error('magic 密文完整性校验失败：文件内容已被篡改或损坏'));
          }
          // 尾段未走完（密文被截断）也应判失败
          if (partChecks && pIdx < partChecks.length) {
            return cb(new Error('magic 密文完整性校验失败：数据不完整（缺少尾部分片）'));
          }
          return cb();
        } catch (e) { return cb(e); }
      },
    });
  }

  // crypto 模式：分段状态机 [魔数10B] (IV12B 密文 TAG16B)×N
  const segs = (meta.crypto && meta.crypto.segments) || [];
  if (!segs.length) { const t = new Transform(); process.nextTick(() => t.destroy(new Error('缺少加密分段元数据'))); return t; }
  let si = 0, phase = 'magic', remaining = CRYPTO_MAGIC.length;
  let pending = Buffer.alloc(0);
  let decipher = null, ctLeft = 0;

  const take = (n) => {
    if (pending.length < n) return null;
    const out = pending.slice(0, n);
    pending = pending.subarray(n);
    return out;
  };

  // R7-13：背压让出的定时器句柄。流被销毁后回调仍会在已销毁的 Transform 上 push，
  // 故句柄必须保存并在流关闭时清除（否则「取消下载」会引出一串 ERR_STREAM_DESTROYED）。
  let yieldTimer = null;

  const t = new Transform({
    // P8：较小的水位线让背压尽早生效（消费者慢时上游暂停，避免密文全部堆积在 pending）
    highWaterMark: 64 * 1024,
    transform(chunk, enc, cb) {
      try {
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        // P8：pending 硬上限 16MB，超限视为上游异常（拒绝继续接收，防内存线性增长）
        if (pending.length > 16 * 1024 * 1024) {
          return cb(new Error('加密文件过大或上游数据异常，缓冲区超限（16MB）'));
        }
        let progressed = true;
        while (progressed) {
          progressed = false;
          // P8：可读侧积压过多时让出事件循环，等待下游消费后再继续
          if (this.readableLength > 4 * 1024 * 1024) {
            yieldTimer = setTimeout(() => { yieldTimer = null; cb(); }, 5);
            return;
          }
          if (phase === 'magic') {
            const t = take(remaining);
            if (!t) break;
            if (!t.equals(CRYPTO_MAGIC)) return cb(new Error('密文头部标识不匹配（该文件可能未使用 crypto 模式加密或已损坏）'));
            phase = 'iv'; remaining = IV_LEN; progressed = true;
          } else if (phase === 'iv') {
            const t = take(IV_LEN);
            if (!t) break;
            decipher = crypto.createDecipheriv('aes-256-gcm', mk, t);
            ctLeft = segs[si].ctLen;
            phase = 'ct'; progressed = true;
          } else if (phase === 'ct') {
            if (!ctLeft) { phase = 'tag'; remaining = TAG_LEN; progressed = true; continue; }
            const n = Math.min(ctLeft, pending.length);
            if (!n) break;
            const t = take(n);
            ctLeft -= n;
            this.push(decipher.update(t));
            if (!ctLeft) { phase = 'tag'; remaining = TAG_LEN; }
            progressed = true;
          } else if (phase === 'tag') {
            const t = take(TAG_LEN);
            if (!t) break;
            decipher.setAuthTag(t);
            this.push(decipher.final()); // 认证失败在此抛出
            si++;
            if (si < segs.length) { phase = 'iv'; remaining = IV_LEN; }
            else phase = 'done';
            progressed = true;
          } else break; // done
        }
        cb();
      } catch (e) { cb(e); }
    },
    flush(cb) {
      if (phase !== 'done' || pending.length) {
        return cb(new Error('密文数据不完整或格式损坏'));
      }
      cb();
    },
  });
  // R7-13：流一旦关闭，挂起的让出回调必须取消 —— 它会在已销毁的流上继续 push
  t.once('close', () => {
    if (yieldTimer) { clearTimeout(yieldTimer); yieldTimer = null; }
  });
  return t;
}

/* ============================ 查看密码（权限验证）与令牌 ============================ */

function passwordSet() { return !!loadSettings().passwordHash; }

/** 校验加密文件查看密码（SEC-05：async —— 该入口在 /enc/unlock 上，是攻击者可达路径） */
async function checkPassword(pw) {
  const s = loadSettings();
  if (!s.passwordHash) return true; // 未设置密码 → 不拦截
  const h = await scryptHex(pw, s.passwordSalt);
  try {
    return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(s.passwordHash, 'hex'));
  } catch (e) {
    return false;
  }
}

/**
 * 访问令牌的签名密钥。
 *
 * R7-05：必须**与当前密码哈希绑定**（与已修的 SEC-10「分享令牌绑密码哈希」同型）。
 * 旧实现只由 masterKey + 固定字符串派生 —— 与密码毫无关系，于是「修改/清除查看密码」
 * 这一应急动作**撤不回** 30 分钟内已签发的令牌：持票人仍可继续解密下载全部密文。
 *
 * 现在把 passwordHash / passwordSalt 纳入派生输入：改密或清密 → 密钥变化 →
 * 旧令牌立即失效。用哈希派生而不是直接比较，故密码哈希本身不会泄露给客户端。
 * 未设密码时两者皆为空串（相当于 'no-pass' 这一固定绑定），语义不变。
 */
function tokenSecret() {
  const s = loadSettings();
  return crypto.createHash('sha256')
    .update(masterKey())
    .update('enc-token-v1')
    .update(String(s.passwordHash || ''))
    .update(String(s.passwordSalt || ''))
    .digest();
}

/** 签发 30 分钟有效的访问令牌 */
function issueToken() {
  const exp = Date.now() + TOKEN_TTL_MS;
  const mac = crypto.createHmac('sha256', tokenSecret()).update(String(exp)).digest('hex');
  return { token: `${exp}.${mac}`, expiresIn: TOKEN_TTL_MS };
}

function verifyToken(t) {
  try {
    const s = String(t || '');
    const i = s.indexOf('.');
    if (i < 0) return false;
    const exp = Number(s.slice(0, i));
    const mac = s.slice(i + 1);
    if (!Number.isFinite(exp) || exp < Date.now()) return false;
    const calc = crypto.createHmac('sha256', tokenSecret()).update(String(exp)).digest('hex');
    if (calc.length !== mac.length) return false;
    return crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(mac));
  } catch (e) {
    return false;
  }
}

/* ============================ 内部工具（测试用） ============================ */

function _resetForTest() {
  settings = null;
  metaCache = null;
  masterKeyCache = null;
}

module.exports = {
  MODES, CRYPTO_MAGIC, TOKEN_TTL_MS,
  settingsView, updateSettings, currentMode,
  masterKey, parseMagicInput,
  getMeta, setMeta, removeMeta, removeMetaBatch, reconcileAfterWrite,
  renameMeta, migratePrefix, copyMeta, removeBucketMeta, encryptedSetFor,
  findOrphanMeta, metaCountForBucket,
  encryptBuffer, encryptPart, buildFinalMeta, decryptTransform,
  xorBuf, fillKeystream, // PERF-03：导出以便对窗口式密钥流做差分验证
  passwordSet, checkPassword, issueToken, verifyToken,
  metaIsCorrupt,
  flushMeta, flushMetaSync, metaDirty, // SEC-08：关键节点同步落盘；flushMetaSync 为退出路径（只写不建）
  _resetForTest,
};
