/**
 * 配置存储模块 —— 配置信息本地加密存储与验证机制
 *
 * 安全设计：
 *  - 首次运行生成 32 字节随机主密钥，保存在 data/secret.key（仅本机可读）
 *  - 配置使用 AES-256-GCM 加密（随机 IV + 认证标签），存于 data/config.enc
 *  - GCM 认证标签可检测配置文件是否被篡改/损坏（完整性验证）
 *  - SecretKey 永不回传前端，仅返回掩码信息
 *
 * 数据结构（v3，多云服务商 + 多密钥 + 多存储桶）：
 *  {
 *    credentials: [{ id, provider, secretId, secretKey, remark, endpoint, createdAt }],
 *    activeCredentialId: string,
 *    buckets: [{ id, provider, bucket, region, remark, quotaBytes, credentialId, createdAt }],
 *    activeBucketId: string,
 *    domains: { primary, backup },
 *    createdAt, updatedAt,
 *  }
 * 旧版（v1，扁平 secretId/secretKey/bucket/region/quotaBytes）在 load() 时自动迁移。
 * v2（无 provider 字段）在 normalize() 中统一兜底为腾讯云，保证历史配置继续可用。
 */
const crypto = require('crypto');
const fs = require('fs');
const atomic = require('./atomic-write');
const path = require('path');
const providers = require('./providers');
const paymentProviders = require('./payment-providers');
const { assertSafeEndpoint } = require('./endpoint-guard');

/**
 * R12-01：此前这里是全库唯一一处**硬编码**的 data 目录
 * （`const DATA_DIR = path.join(__dirname, '..', 'data')`），不读 `COS_DATA_DIR`。
 *
 * 后果已经实际发生过一次：`tests/audit6-regressions.test.js` 里几处 `configStore.save({})`
 * 在跑全量测试时**直接改写了生产 `data/config.enc`**（内含云厂商密钥 / 桶 / 账户）——
 * AES-GCM 每次 IV 随机，文件内容等价但字节全变、`updatedAt` 被改写。更危险的是：
 * 将来任何一条用例只要在 `save()` 里带上真实字段，就会静默覆盖生产凭据，而测试一样全绿。
 *
 * 现在与其它 store 同款写法；`KEY_FILE`（主密钥）一并纳入，否则测试会用到生产主密钥。
 */
const DATA_DIR = process.env.COS_DATA_DIR ? path.resolve(process.env.COS_DATA_DIR) : path.join(__dirname, '..', 'data');
const KEY_FILE = path.join(DATA_DIR, 'secret.key');
const CONFIG_FILE = path.join(DATA_DIR, 'config.enc');

let cached = null; // 解密后的配置缓存
let cachedAt = 0; // 缓存载入时间戳（P13：60 秒 TTL）
const CACHE_TTL_MS = 60 * 1000;
let corrupted = false;
let masterKeyCache = null; // N3：主密钥内存缓存，避免每次加解密同步读盘

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * 把可疑/损坏的 data 文件另存一份备份（FUN-03 / FUN-04）。
 *
 * 与 `secure-store.backupCorrupt()` 同款语义：让「不可逆」降级为「可人工恢复」。
 * 每个进程对同一文件**只备份一次** —— 否则损坏状态下反复调用会产生一堆
 * `.corrupt-<ts>` 副本，反而淹没真正需要的那一份。
 *
 * @param {string} file 绝对路径
 * @param {'corrupt'|'bad'} tag 备份后缀标记
 * @returns {string} 备份文件路径（失败返回空串）
 */
const backedUp = new Set();
function backupDataFile(file, tag) {
  const key = `${tag}:${file}`;
  if (backedUp.has(key)) return '';
  backedUp.add(key);
  try {
    if (!fs.existsSync(file)) return '';
    const dst = `${file}.${tag}-${Date.now()}`;
    fs.copyFileSync(file, dst);
    return dst;
  } catch (e) {
    return '';
  }
}

/**
 * 构造一个「数据文件不可写」错误（调用方应向上抛，由路由层转成 5xx）。
 *
 * 对外导出是为了让 `enc-store.js` 等持有同类关键文件的模块复用同一套语义
 * （FUN-04 的备份 + 拒绝覆盖），而不是各自再写一份。
 *
 * @param {string} file 绝对路径
 * @param {'corrupt'|'bad'} tag 备份后缀标记
 * @param {string} why 人类可读的原因
 */
function unwritableError(file, tag, why) {
  const bak = backupDataFile(file, tag);
  const err = new Error(
    `${path.basename(file)} ${why}；为防覆盖造成的不可逆数据丢失，`
    + (bak ? `已备份为 ${path.basename(bak)}，` : '（备份失败，请立即手工复制该文件）')
    + '并拒绝写入。请先恢复或确认无误后手工处理该文件，再重启服务。'
  );
  err.status = 500;
  err.corrupt = true;
  err.file = file;
  return err;
}

function getMasterKey() {
  if (masterKeyCache) return masterKeyCache;
  ensureDataDir();
  if (fs.existsSync(KEY_FILE)) {
    const hex = fs.readFileSync(KEY_FILE, 'utf8').trim();
    if (/^[0-9a-f]{64}$/i.test(hex)) { masterKeyCache = Buffer.from(hex, 'hex'); return masterKeyCache; }
    // FUN-04：文件存在但内容不是合法密钥 —— **绝不能**静默生成新密钥覆盖它。
    //
    // 旧密钥是 config.enc / enc-meta / links / payments 的唯一解密凭据，
    // 一旦被覆盖，全部历史数据永久不可解（空文件、BOM、少一个字符都会走到这里）。
    // 这里备份异常内容后直接抛错，让故障显式化：宁可起不来，也不能悄悄把数据判死刑。
    // 运维确认该文件确实无用后，手工删除即可让服务重新生成新密钥。
    throw unwritableError(KEY_FILE, 'bad', '内容不是合法的 32 字节十六进制密钥');
  }
  const key = crypto.randomBytes(32);
  atomic.writeAtomicSync(KEY_FILE, key.toString('hex'));
  try { fs.chmodSync(KEY_FILE, 0o600); } catch (e) { /* 部分平台不支持 */ }
  masterKeyCache = key;
  return key;
}

function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getMasterKey(), iv);
  const plain = Buffer.from(JSON.stringify(obj), 'utf8');
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  // base64( iv(12) | tag(16) | ciphertext )
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decrypt(b64) {
  const raw = Buffer.from(b64, 'base64');
  if (raw.length < 29) throw new Error('CONFIG_FORMAT_INVALID');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const data = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', getMasterKey(), iv);
  decipher.setAuthTag(tag); // 认证失败将抛出异常 => 配置被篡改或损坏
  const plain = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

/**
 * 实体 ID 生成：统一 16 字节（128 位熵）hex。
 *
 * 历史上本处为 8 字节（64 位），share-store 另用 9 字节 base64url —— 两者不一致且
 * 熵偏低。现统一为 16 字节：既有 16 位 ID 的历史数据仍可正常读取（ID 只作标识、不解析），
 * 但**新建**实体一律 32 位 hex。后续新增实体类型请复用本函数。
 */
function newId() {
  return crypto.randomBytes(16).toString('hex');
}

const DEFAULT_CONFIG = {
  credentials: [],
  activeCredentialId: '',
  buckets: [],
  activeBucketId: '',
  domains: { primary: '', backup: '' },
  prefs: { aclReminderDisabled: false }, // 用户偏好：ACL 安全提醒"不再提醒"
  uploadExcludes: { dsStore: false, thumbsDb: false, gitignore: false }, // 上传排除规则
  webdav: { enabled: false, accounts: [] }, // WebDAV 服务（开关 + 账户，密码字段级加密）
  users: [], // 登录用户（username / passwordHash / passwordSalt / role）
  captcha: {
    enabled: false, provider: 'recaptcha', siteKey: '', secretKey: '',
    timeoutMs: 5000, onError: 'block',
  }, // 登录人机验证（默认关闭；secretKey 仅为服务端用，绝不下发前端）
  payment: { platforms: {} }, // 支付平台凭证（仅基础配置与合法性校验，字段见 server/payment-providers.js）
  createdAt: '',
  updatedAt: '',
};

const DEFAULT_UPLOAD_EXCLUDES = { dsStore: false, thumbsDb: false, gitignore: false };

// 旧版默认配额（用于百分比展示）；0 表示无限制
const DEFAULT_QUOTA = 50 * 1024 * 1024 * 1024;

/** 旧版(v1)扁平配置 -> v2 多密钥多桶结构 */
function migrateV1(raw) {
  const now = new Date().toISOString();
  const cfg = Object.assign({}, DEFAULT_CONFIG, {
    domains: raw.domains || { primary: '', backup: '' },
    createdAt: raw.createdAt || now,
    updatedAt: raw.updatedAt || now,
  });
  let credId = '';
  if (raw.secretId && raw.secretKey) {
    const cred = {
      id: newId(),
      provider: providers.DEFAULT_PROVIDER_ID,
      secretId: String(raw.secretId),
      secretKey: String(raw.secretKey),
      remark: '',
      endpoint: '',
      createdAt: raw.createdAt || now,
    };
    cfg.credentials.push(cred);
    credId = cred.id;
    cfg.activeCredentialId = cred.id;
  }
  if (raw.bucket && raw.region) {
    const b = {
      id: newId(),
      provider: providers.DEFAULT_PROVIDER_ID,
      bucket: String(raw.bucket),
      region: String(raw.region),
      remark: '',
      quotaBytes: Number.isFinite(Number(raw.quotaBytes)) ? Number(raw.quotaBytes) : DEFAULT_QUOTA,
      credentialId: credId,
      createdAt: raw.createdAt || now,
    };
    cfg.buckets.push(b);
    cfg.activeBucketId = b.id;
  }
  return cfg;
}

function normalize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  // v1 判定：存在扁平 secretId/bucket 且没有 credentials 数组
  if (!Array.isArray(raw.credentials) && (raw.secretId !== undefined || raw.bucket !== undefined)) {
    return migrateV1(raw);
  }
  const cfg = Object.assign({}, DEFAULT_CONFIG, raw);
  if (!Array.isArray(cfg.credentials)) cfg.credentials = [];
  if (!Array.isArray(cfg.buckets)) cfg.buckets = [];
  // 密钥记录兜底：历史密钥无 provider 字段，统一视为腾讯云；endpoint 自定义端点（S3 兼容厂商可选）
  for (const c of cfg.credentials) {
    if (!c || typeof c !== 'object') continue;
    if (!providers.get(c.provider)) c.provider = providers.DEFAULT_PROVIDER_ID;
    if (typeof c.endpoint !== 'string') c.endpoint = '';
  }
  // 桶记录兜底：历史桶默认启用（enabled 向后兼容）；blockOverseasIP 默认关闭（按桶屏蔽海外 IP，向后兼容）
  for (const b of cfg.buckets) {
    if (!b || typeof b !== 'object') continue;
    if (!providers.get(b.provider)) b.provider = providers.DEFAULT_PROVIDER_ID;
    if (typeof b.endpoint !== 'string') b.endpoint = '';
    if (b.enabled === undefined) b.enabled = true;
    if (typeof b.blockOverseasIP !== 'boolean') b.blockOverseasIP = false;
  }
  if (!cfg.domains || typeof cfg.domains !== 'object') cfg.domains = { primary: '', backup: '' };
  if (!cfg.prefs || typeof cfg.prefs !== 'object') cfg.prefs = { aclReminderDisabled: false };
  if (cfg.prefs.aclReminderDisabled === undefined) cfg.prefs.aclReminderDisabled = false;
  if (!cfg.uploadExcludes || typeof cfg.uploadExcludes !== 'object') cfg.uploadExcludes = { dsStore: false, thumbsDb: false, gitignore: false };
  for (const k of ['dsStore', 'thumbsDb', 'gitignore']) {
    if (cfg.uploadExcludes[k] === undefined) cfg.uploadExcludes[k] = false;
  }
  if (!cfg.webdav || typeof cfg.webdav !== 'object') cfg.webdav = { enabled: false, accounts: [] };
  if (typeof cfg.webdav.enabled !== 'boolean') cfg.webdav.enabled = false;
  if (!Array.isArray(cfg.webdav.accounts)) cfg.webdav.accounts = [];
  if (!Array.isArray(cfg.users)) cfg.users = [];
  // 验证码配置兜底：补全结构并归一化枚举，避免历史脏配置影响运行
  if (!cfg.captcha || typeof cfg.captcha !== 'object') cfg.captcha = {};
  if (typeof cfg.captcha.enabled !== 'boolean') cfg.captcha.enabled = false;
  if (!['recaptcha', 'turnstile'].includes(cfg.captcha.provider)) cfg.captcha.provider = 'recaptcha';
  if (cfg.captcha.onError !== 'degrade') cfg.captcha.onError = 'block';
  if (typeof cfg.captcha.siteKey !== 'string') cfg.captcha.siteKey = '';
  if (typeof cfg.captcha.secretKey !== 'string') cfg.captcha.secretKey = '';
  if (!Number.isFinite(Number(cfg.captcha.timeoutMs)) || cfg.captcha.timeoutMs <= 0) cfg.captcha.timeoutMs = 5000;
  // 用户记录兜底：过滤非法项并补齐字段，避免历史脏数据导致运行异常
  cfg.users = cfg.users.filter((u) => u && typeof u === 'object' && typeof u.username === 'string' && u.username);
  for (const u of cfg.users) {
    if (typeof u.username !== 'string') u.username = '';
    if (!['admin', 'user'].includes(u.role)) u.role = 'user';
    if (!u.permissions || typeof u.permissions !== 'object') u.permissions = {};
    if (typeof u.passwordHash !== 'string') u.passwordHash = '';
    if (typeof u.passwordSalt !== 'string') u.passwordSalt = '';
    // Windows Hello（WebAuthn）凭据兜底：结构不完整即视为未启用，
    // 避免脏数据导致登录时校验逻辑拿到半截字段而误放行。
    u.webauthn = normalizeWebauthn(u.webauthn);
  }
  return cfg;
}

function load() {
  // P13：缓存带 60 秒 TTL，外部修改 config.enc 后最多 1 分钟内自动生效
  if (cached && Date.now() - cachedAt < CACHE_TTL_MS) return cached;
  ensureDataDir();
  if (!fs.existsSync(CONFIG_FILE)) {
    corrupted = false;
    cached = null;
    cachedAt = Date.now();
    return null;
  }
  try {
    const b64 = fs.readFileSync(CONFIG_FILE, 'utf8').trim();
    const cfg = normalize(decrypt(b64));
    corrupted = false;
    cached = cfg;
    cachedAt = Date.now();
    return cfg;
  } catch (e) {
    // 认证失败或格式错误：标记损坏，避免使用被篡改的数据
    corrupted = true;
    cached = null;
    return null;
  }
}

/* 配置落盘：串行队列 + 去抖合并（PERF-02）

   旧实现每次 `persist()` 都把**整个配置**序列化 → AES-GCM 加密 → 原子写盘一次。
   连续改多个桶的可见性、批量保存支付配置这类操作会产生 N 次全量写，
   而真正需要落盘的只有**最后一次**的结果 —— 中间态既没人读，也活不过 250ms。

   改为「去抖合并 + 串行执行」：
    - 内存缓存**立即**更新（读路径完全不受影响，仍是同步可见）；
    - 磁盘写入延迟 DEBOUNCE_MS，窗口内的后续变更只替换待写对象，不排队；
    - `flush()`（优雅关闭 / 单测）会立刻取消去抖、同步发起写入并等待完成，
      因此「进程退出丢最后一次变更」这个风险点由既有停机流程覆盖；
    - `CONFIG_WRITE_DEBOUNCE_MS=0` 可退回「立即写」（排查落盘问题时用）。
*/

let writeQueue = Promise.resolve();
let lastWriteError = null;
let pendingCfg = null;   // 去抖窗口内待写的最新配置
let debounceTimer = null;

function debounceMs() {
  const raw = process.env.CONFIG_WRITE_DEBOUNCE_MS;
  if (raw === undefined || raw === '') return 250;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 250;
}

/** 真正执行一次落盘（内部用；不为它单独设去抖） */
function writeNow(cfg) {
  cfg.updatedAt = new Date().toISOString();
  ensureDataDir();
  const text = encrypt(cfg);
  writeQueue = writeQueue.then(() => atomic.writeAtomic(CONFIG_FILE, text)).catch((e) => {
    lastWriteError = e;
    // FUN-13：写盘失败时**必须**让内存缓存失效。
    // 否则内存里是新配置、磁盘上还是旧的，进程会一直按"已保存"的样子运行，
    // 直到某次重启才暴露「配置回到过去」，且期间任何排障都看不到真实状态。
    cached = null;
    cachedAt = 0;
    console.error('[Storage Manager] 配置写入磁盘失败，已丢弃内存缓存：', (e && e.message) || e);
  });
  return writeQueue;
}

function persist(cfg) {
  // FUN-03：损坏护栏 —— 磁盘上那份 config.enc 虽读不出来，却是恢复数据的最后凭据。
  // 旧实现在 load() 失败后由 requireStore() 拿 DEFAULT_CONFIG 覆盖落盘，
  // 一次「随手保存」即永久清空全部密钥 / 多桶 / 用户（含管理员）。
  // 这里与 secure-store 的 SEC-09 对齐：先备份再拒绝写入，故障显式化。
  // 「文件不存在」不属于损坏（首次运行或已手工清空），照常允许写入。
  if (corrupted && fs.existsSync(CONFIG_FILE)) {
    throw unwritableError(CONFIG_FILE, 'corrupt', '无法解密或解析（可能已被篡改或损坏）');
  }
  cached = cfg;
  cachedAt = Date.now();
  corrupted = false;

  pendingCfg = cfg;
  if (debounceMs() <= 0) {
    // 立即写分支必须**同步清掉** pendingCfg —— 否则它会被 flushPending()
    // 当成"窗口内尚未落盘的变更"再写一遍（同一次变更写两次，正是去抖要消除的浪费）。
    pendingCfg = null;
    writeNow(cfg);
    return cfg;
  }
  if (debounceTimer) return cfg; // 窗口内已有排程：它自然会写入最新对象
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    const target = pendingCfg;
    pendingCfg = null;
    if (target) writeNow(target);
  }, debounceMs());
  if (debounceTimer.unref) debounceTimer.unref(); // 不阻止进程退出
  return cfg;
}

/** 取消去抖并立即落盘（若有待写内容），返回可等待的 Promise */
function flushPending() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (pendingCfg) {
    const target = pendingCfg;
    pendingCfg = null;
    writeNow(target);
  }
  return writeQueue;
}

/** 等待全部待落盘任务完成（优雅关闭前调用） */
function flush() { return flushPending(); }

/**
 * 兜底：去抖窗口内进程被强杀（Ctrl+C 之外的 kill / 崩溃）时的最后一道保险。
 * 优雅停机走 index.js 的 `configStore.flush()`；这里只补那之外的情形，
 * 且**只在确实有待写内容时才动磁盘**，正常退出时是彻底的空操作。
 */
process.on('exit', () => {
  if (!pendingCfg) return;
  try {
    /**
     * R12-03：`secure-store` 依赖 `config-store`（读主密钥），反过来在**模块顶层**
     * require 它就成环了。退出钩子此刻两个模块必定都已加载完毕，这里延迟取用是安全的，
     * 且换来了「判据只有一个实现点」—— 比在 config-store 里再内联一份 `existsSync` 强。
     */
    // eslint-disable-next-line global-require
    const secureStore = require('./secure-store');
    pendingCfg.updatedAt = new Date().toISOString();
    /**
     * R11-07：退出路径只写不建 —— 与 `upload-sessions` / `enc-store` 同一条纪律。
     *
     * `ensureDataDir()` 会在退出阶段把已被删除的 `data/` 重建并写回 `config.enc`，
     * 让"清理"被自己的退出钩子撤销。在线路径仍照常建目录（首次写入时它可能尚
     * 不存在），只有退出阶段受此约束。
     *
     * R12-03：判据改用**唯一实现点** `secureStore.exitPathWritable()` —— 此前这里是
     * 第三份内联实现（`upload-sessions` 还有一份私有副本），于是"唯一实现点"
     * 事实上名存实亡：把它改成 `return true`，两套护栏全绿。
     */
    if (!secureStore.exitPathWritable(DATA_DIR)) return;
    atomic.writeAtomicSync(CONFIG_FILE, encrypt(pendingCfg));
  } catch (e) { /* 退出阶段无法补救，尽力而为 */ }
});
/** 最近一次落盘错误（健康检查/排障用） */
function getLastWriteError() { return lastWriteError; }

/**
 * 合并写入配置（唯一调用点：`PUT /api/config`）
 *
 * SEC-01：这里**必须在当前配置对象上就地合并**，不能再用
 * 「读快照 → 复制出新对象 → 整体写回」。
 *
 * 快照写法会在并发下**静默丢更新**：另一个写操作（如 addUser，它校验密码时有
 * await）已先读过同一个对象，本函数用复制出的新对象整体替换缓存之后，
 * 那个操作稍后把自己手里的**旧引用**写回 —— 本次的变更就凭空消失了。
 * 丢的可能是访问密钥、桶绑定或用户角色，而且没有任何报错。
 *
 * 其余写操作（addBucket / updateBucket / addUser / updateUser …）都是在
 * `requireStore()` 返回的**同一个**对象上就地修改后 `persist(cfg)`，
 * 因此彼此并发是安全的；快照式替换是全库唯一会替换缓存对象的写法。
 */
function save(partial) {
  const cur = requireStore();
  Object.assign(cur, partial);
  return persist(cur);
}

/* ============================ 生效配置（运行时视图） ============================ */

function activeBucket(cfg) {
  if (!cfg.buckets.length) return null;
  // 优先返回激活桶（且未停用）；否则回退到第一个未停用的桶
  const active = cfg.buckets.find((b) => b.id === cfg.activeBucketId);
  if (active && active.enabled !== false) return active;
  return cfg.buckets.find((b) => b.enabled !== false) || cfg.buckets[0];
}

/**
 * 解析某桶应使用的密钥。
 *
 * ## 铁律（FUN-09）：**绝不跨厂商猜测密钥**
 *
 * 桶属于某个厂商（阿里云的桶用腾讯云密钥必然 403 / 签名错误）。因此当已知目标厂商
 * 却又找不到**同厂商的启用密钥**时，正确行为是**返回 null 并让调用方报「该桶无可用密钥」**，
 * 而不是"还有一个启用密钥就拿来用" —— 后者会把用户的密钥发给错误厂商，
 * 表现为难以定位的 403，同时造成凭据外发。
 *
 * 仅在**完全无法确定目标厂商**（无桶上下文）时才允许回退到激活密钥 / 首个启用密钥。
 *
 * @param {object} cfg 完整配置
 * @param {object|null} bucket 目标桶记录（可为 null）
 * @returns {object|null} 密钥记录；无法确定且无合理回退时为 null
 */
function activeCredential(cfg, bucket) {
  if (!cfg.credentials.length) return null;
  const enabled = cfg.credentials.filter((x) => x.enabled !== false);
  if (!enabled.length) return null;

  let hintProvider = null; // 已知的"目标厂商"线索

  // ① 桶显式绑定密钥：绑定本身即最强约束
  if (bucket && bucket.credentialId) {
    const c = cfg.credentials.find((x) => x.id === bucket.credentialId);
    if (c && c.enabled !== false) return c;
    // 绑定的密钥已停用 → 只能用**同一厂商**的其它启用密钥替代
    if (c && c.provider) {
      hintProvider = c.provider;
      const same = enabled.find((x) => x.provider === c.provider);
      if (same) return same;
    }
  }
  // ② 桶声明的 provider
  if (!hintProvider && bucket && bucket.provider) hintProvider = bucket.provider;
  if (hintProvider) {
    const same = enabled.find((x) => x.provider === hintProvider);
    if (same) return same;
    // ⚠️ 已知厂商却无同厂商启用密钥 —— 宁可显式失败，也不跨厂商串访
    return null;
  }
  // ③ 无桶上下文（如"先用某个可用密钥拉桶列表"）：回退到激活密钥 → 首个启用密钥
  const active = enabled.find((x) => x.id === cfg.activeCredentialId);
  return active || enabled[0];
}

/**
 * 生效配置：扁平形状 { provider, secretId, secretKey, bucket, region, quotaBytes, domains }
 * 供 cos.js / 文件操作路由直接使用，保持与旧版一致。
 * 桶与密钥的服务商不一致时以桶为准（桶绑定密钥通常已保证一致），未绑定时用密钥的服务商。
 *
 * ## FUN-15：**必须与界面读端同源**
 *
 * 列表 / 上传 / 下载 / 删除 / 统计全部经由 `requireConfig() → get() → effective()`
 * 进入这里。若此处读全局而界面读会话，用户切桶后就会出现
 * 「界面显示新桶名、实际操作仍打全局桶」的错位 —— 更糟的是当全局默认桶对该用户
 * 不可见时，操作层会持续读写一个他本不该访问的桶（越权读取面）。
 *
 * @param {boolean} [isAdmin] 省略时按当前请求角色判定（无上下文按管理员）
 */
function effective(isAdmin) {
  const cfg = load();
  if (!cfg) return null;
  const admin = isAdmin === undefined ? (sessionRole() !== 'user') : isAdmin === true;
  const b = resolveEffectiveBucket(cfg, admin);
  const c = activeCredential(cfg, b);
  const pid = (b && b.provider) || (c && c.provider) || providers.DEFAULT_PROVIDER_ID;
  return {
    provider: pid,
    secretId: c ? c.secretId : '',
    secretKey: c ? c.secretKey : '',
    credentialId: c ? c.id : '',
    endpoint: (c && c.endpoint) || (b && b.endpoint) || providers.endpointFor(pid, b ? b.region : ''),
    bucket: b ? b.bucket : '',
    region: b ? b.region : '',
    bucketId: b ? b.id : '',
    bucketRemark: b ? b.remark || '' : '',
    quotaBytes: b ? (Number.isFinite(Number(b.quotaBytes)) ? Number(b.quotaBytes) : 0) : 0,
    domains: cfg.domains || { primary: '', backup: '' },
    updatedAt: cfg.updatedAt,
  };
}

/** 同 {@link effective}；`requireConfig()` 与所有 /api/fs/* 操作读端都经由此处 */
function get(isAdmin) {
  return effective(isAdmin);
}

/**
 * 按桶名解析生效配置（用于分享链接下载：目标桶可能不是当前激活桶）
 *
 * ## FUN-09：桶记录不存在时**必须失败，不得猜测密钥**
 *
 * 旧实现里 `b` 为 undefined 会使 `wantProvider = null`，从而让 `activeCredential()`
 * 回退到「激活密钥 / 首个启用密钥」—— 若那把密钥属于另一厂商，请求会带着
 * **错误厂商的密钥与端点**发出，既是 403 的来源，也把用户凭据外发给了非目标厂商。
 * 正确做法是返回 null，由调用方给出明确错误。
 *
 * @param {string} bucketName
 * @param {string} [fallbackRegion] 仅用于兼容早期分享链接中保存的地域快照
 * @returns {object|null} 桶记录不存在、或无同厂商可用密钥时返回 null
 */
function effectiveForBucket(bucketName, fallbackRegion) {
  const cfg = load();
  if (!cfg) return null;
  const b = cfg.buckets.find((x) => x.bucket === bucketName);
  if (!b) return null; // 桶已被移除/改名 → 拒绝猜测密钥

  const c = activeCredential(cfg, b);
  if (!c) return null; // 该厂商无可用启用密钥 → 拒绝跨厂商串访

  const pid = b.provider || c.provider;
  const region = b.region || fallbackRegion || '';
  return {
    provider: pid,
    secretId: c.secretId,
    secretKey: c.secretKey,
    credentialId: c.id,
    endpoint: c.endpoint || b.endpoint || providers.endpointFor(pid, region),
    bucket: bucketName,
    bucketId: b.id,
    region,
  };
}

/* ============================ 密钥管理 ============================ */

function requireStore() {
  let cfg = load();
  if (!cfg) {
    // FUN-03：配置**损坏**（而非「不存在」）时绝不用空配置顶上 ——
    // 那等于把磁盘上唯一还能人工抢救的密文换成一份空表。
    // 这里直接抛错，让所有写操作显式失败并引导恢复；
    // 「文件不存在」由 load() 区分（corrupted=false），仍走下面的首次初始化。
    if (corrupted) {
      throw unwritableError(CONFIG_FILE, 'corrupt', '无法解密或解析（可能已被篡改或损坏）');
    }
    // 首次运行：尚无配置文件，初始化空配置
    cfg = persist(Object.assign({}, DEFAULT_CONFIG, { createdAt: new Date().toISOString() }));
  }
  return cfg;
}

function maskSecretId(sid) {
  sid = String(sid || '');
  return sid.length > 8 ? sid.slice(0, 4) + '****' + sid.slice(-4) : (sid ? '****' : '');
}

function credentialView(c) {
  return {
    id: c.id,
    provider: providers.get(c.provider) ? c.provider : providers.DEFAULT_PROVIDER_ID,
    providerName: providers.nameOf(c.provider),
    endpoint: c.endpoint || '',
    secretIdMasked: maskSecretId(c.secretId),
    remark: c.remark || '',
    visibleToUsers: c.visibleToUsers !== false, // 对普通用户可见（默认 true，历史密钥向后兼容）
    enabled: c.enabled !== false, // 启用/停用（默认 true，历史密钥向后兼容）
    createdAt: c.createdAt || '',
  };
}

function listCredentials() {
  const cfg = load();
  if (!cfg) return { credentials: [], activeCredentialId: '' };
  return {
    credentials: cfg.credentials.map(credentialView),
    activeCredentialId: (activeCredential(cfg, activeBucket(cfg)) || {}).id || '',
  };
}

/**
 * 按角色列出密钥（可见性过滤）：
 *  - admin：始终返回全部密钥
 *  - 其他（普通用户）：仅返回 visibleToUsers !== false 的密钥
 *  activeCredentialId 若指向不可见密钥，则回退到第一个可见密钥（无可见密钥则为空）。
 */
function listCredentialsFor(role) {
  const { credentials, activeCredentialId } = listCredentials();
  if (role === 'admin') return { credentials, activeCredentialId };
  const visible = credentials.filter((c) => c.visibleToUsers !== false);
  let activeId = activeCredentialId;
  if (!visible.some((c) => c.id === activeId)) {
    activeId = visible.length ? visible[0].id : '';
  }
  return { credentials: visible, activeCredentialId: activeId };
}

/**
 * 批量设置密钥对普通用户的可见性。
 * @param {string[]} visibleIds 对普通用户可见的密钥 id 集合（不在集合内的一律设为不可见）
 * @returns {{ ok: boolean, visibleCount: number }}
 */
function setCredentialsVisibility(visibleIds) {
  const cfg = requireStore();
  const set = new Set(Array.isArray(visibleIds) ? visibleIds : []);
  let visibleCount = 0;
  for (const c of cfg.credentials) {
    c.visibleToUsers = set.has(c.id);
    if (c.visibleToUsers) visibleCount++;
  }
  persist(cfg);
  return { ok: true, visibleCount };
}

function addCredential({ provider, secretId, secretKey, remark, endpoint, visibleToUsers, enabled }) {
  const cfg = requireStore();
  const now = new Date().toISOString();
  const pid = providers.get(provider) ? provider : providers.DEFAULT_PROVIDER_ID;
  const ep = typeof endpoint === 'string' ? endpoint.trim() : '';
  // SEC-03：写入前校验自定义端点（禁云元数据/回环/私网，非回环强制 https），
  // 避免把危险端点持久化后由后续任意请求触发。
  if (ep) assertSafeEndpoint(ep);
  // 同 SecretId 视为更新（便于重新保存同一密钥）
  const exist = cfg.credentials.find((c) => c.secretId === secretId);
  if (exist) {
    exist.secretKey = secretKey || exist.secretKey;
    exist.provider = pid;
    exist.endpoint = ep;
    if (remark !== undefined) exist.remark = String(remark || '');
    if (visibleToUsers !== undefined) exist.visibleToUsers = visibleToUsers !== false;
    if (enabled !== undefined) exist.enabled = enabled !== false;
    // FUN-06：不再顺手改写全局 activeCredentialId。
    // 「保存一个密钥」与「切换到这个密钥」是两件事，混在一起会让写操作产生
    // 意料之外的全局副作用。需要切换请走 setActiveCredential()（管理员专属入口）。
    persist(cfg);
    return credentialView(exist);
  }
  const cred = {
    id: newId(),
    provider: pid,
    secretId,
    secretKey,
    remark: String(remark || ''),
    endpoint: ep,
    visibleToUsers: visibleToUsers !== false, // 默认对普通用户可见
    enabled: enabled !== false, // 默认启用（历史密钥向后兼容）
    createdAt: now,
  };
  cfg.credentials.push(cred);
  // FUN-06：同上，新增密钥不再自动设为当前密钥（由路由层显式决定是否切换）
  persist(cfg);
  return credentialView(cred);
}

function removeCredential(id) {
  const cfg = requireStore();
  const idx = cfg.credentials.findIndex((c) => c.id === id);
  if (idx < 0) return false;
  cfg.credentials.splice(idx, 1);
  if (cfg.activeCredentialId === id) cfg.activeCredentialId = (cfg.credentials[0] || {}).id || '';
  // 桶上引用该密钥的，清除引用（回退为使用当前密钥）
  for (const b of cfg.buckets) if (b.credentialId === id) b.credentialId = '';
  persist(cfg);
  return true;
}

function setActiveCredential(id) {
  const cfg = requireStore();
  const c = cfg.credentials.find((c) => c.id === id);
  if (!c) return false;
  if (c.enabled === false) return false; // 不能激活已停用的凭证
  cfg.activeCredentialId = id;
  persist(cfg);
  return true;
}

function updateCredentialRemark(id, remark) {
  const cfg = requireStore();
  const c = cfg.credentials.find((x) => x.id === id);
  if (!c) return false;
  c.remark = String(remark || '');
  persist(cfg);
  return true;
}

/** 更新密钥（服务商 / 端点 / 备注 / 可见性 / 启用状态）——停用时自动设为不可见 */
function updateCredential(id, patch) {
  const cfg = requireStore();
  const c = cfg.credentials.find((x) => x.id === id);
  if (!c) return false;
  if (patch.provider !== undefined && providers.get(patch.provider)) c.provider = patch.provider;
  if (patch.endpoint !== undefined) {
    const ep = String(patch.endpoint || '').trim();
    if (ep) assertSafeEndpoint(ep); // SEC-03：同 addCredential
    c.endpoint = ep;
  }
  if (patch.remark !== undefined) c.remark = String(patch.remark || '');
  if (patch.visibleToUsers !== undefined) c.visibleToUsers = patch.visibleToUsers !== false;
  if (patch.enabled !== undefined) {
    c.enabled = patch.enabled !== false;
    if (!c.enabled) c.visibleToUsers = false; // 停用时自动对普通用户不可见
  }
  persist(cfg);
  return true;
}

/* ============================ 存储桶管理 ============================ */

function bucketView(b) {
  return {
    id: b.id,
    provider: providers.get(b.provider) ? b.provider : providers.DEFAULT_PROVIDER_ID,
    providerName: providers.nameOf(b.provider),
    bucket: b.bucket,
    region: b.region,
    remark: b.remark || '',
    displayName: b.remark || b.bucket,
    quotaBytes: Number.isFinite(Number(b.quotaBytes)) ? Number(b.quotaBytes) : 0,
    credentialId: b.credentialId || '',
    visibleToUsers: b.visibleToUsers !== false, // 对普通用户可见（默认 true，历史桶向后兼容）
    enabled: b.enabled !== false, // 启用/停用（默认 true，历史桶向后兼容）
    blockOverseasIP: b.blockOverseasIP === true, // 仅屏蔽海外 IP（按桶生效，默认 false）
    createdAt: b.createdAt || '',
  };
}

function listBuckets() {
  const cfg = load();
  if (!cfg) return { buckets: [], activeBucketId: '' };
  const active = activeBucket(cfg);
  return { buckets: cfg.buckets.map(bucketView), activeBucketId: (active || {}).id || '' };
}

/**
 * 当前**会话**生效的桶 id（FUN-15）
 *
 * 取值优先级：请求上下文（本次请求内已切换） → 会话记录（跨请求保持） → 空串。
 * 返回空串表示"跟随系统默认桶"，调用方应回退到 `cfg.activeBucketId`。
 *
 * 之所以不直接 require 这两个模块：它们在初始化路径上会反向依赖 config-store，
 * 函数内懒加载可彻底避免循环依赖。
 */
function sessionActiveBucketId() {
  let ctx;
  let authSession;
  try {
    ctx = require('./request-context');
    authSession = require('./auth-session');
  } catch (e) {
    return '';
  }
  const direct = ctx.activeBucketId();
  if (direct) return direct;
  const t = ctx.token();
  if (!t) return '';
  try {
    return authSession.getSessionBucket(t) || '';
  } catch (e) {
    return '';
  }
}

/**
 * 当前请求的角色（用于可见性收窄）。
 *
 * 无请求上下文时返回 'admin' —— 那是 WebDAV / 分享链接 / 启动自检等**可信内部路径**，
 * 它们本就按系统默认桶工作，不应被普通用户的可见性规则影响。
 */
function sessionRole() {
  let ctx;
  try {
    ctx = require('./request-context');
  } catch (e) {
    return 'admin';
  }
  try {
    return ctx.role() || 'admin';
  } catch (e) {
    return 'admin';
  }
}

/**
 * 按会话 + 角色解析出生效桶记录（无会话数据时回退全局默认）
 *
 * **这是「当前桶」唯一的权威读取入口** —— 界面（listBucketsFor / safeView）与
 * 操作（effective / get / requireConfig）都必须走这里，否则会出现
 * 「界面显示 A、实际操作打 B」的错位。
 */
function resolveEffectiveBucket(cfg, isAdmin) {
  if (!cfg || !cfg.buckets.length) return null;
  const admin = isAdmin === true;
  const usable = (b) => Boolean(b) && b.enabled !== false && (admin || b.visibleToUsers !== false);

  // ① 会话级当前桶：存在且对该角色可用时才认
  const sid = sessionActiveBucketId();
  if (sid) {
    const b = cfg.buckets.find((x) => x.id === sid);
    if (usable(b)) return b;
    // 会话里可能残留已停用 / 已被收窄可见性的桶 —— 一律忽略
  }

  // ② 无会话信息：管理员走全局默认；
  //    普通用户**必须**回退到第一个可见且启用的桶 —— 全局默认桶可能对他不可见，
  //    直接回退会让他持续读写一个本不该访问的桶（FUN-15 的边界越权面）。
  if (admin) return activeBucket(cfg);
  const visible = cfg.buckets.filter((b) => b.enabled !== false && b.visibleToUsers !== false);
  if (!visible.length) return null; // 没有任何可见桶 → 宁可显式失败，也不放行不可见桶
  return visible.find((b) => b.id === cfg.activeBucketId) || visible[0];
}

/**
 * 按角色列出桶（可见性过滤）：
 *  - admin：始终返回全部桶
 *  - 其他（普通用户）：仅返回 visibleToUsers !== false **且 enabled !== false** 的桶
 *  activeBucketId 若指向不可见/已停用桶，则回退到第一个可见且启用的桶（无则为空）。
 *  优先采用**会话级**当前桶（FUN-15）。
 */
function listBucketsFor(role, overrideId) {
  const { buckets, activeBucketId } = listBuckets();
  const isAdmin = role !== 'user';
  // FUN-15：会话级当前桶优先。管理员也要生效（管理员切桶同样不该影响他人），
  // 只是其可见性过滤规则不同。
  const sessionId = overrideId !== undefined ? overrideId : sessionActiveBucketId();
  const preferred = sessionId || activeBucketId;
  if (isAdmin) {
    // 管理员：会话桶必须真实存在且未停用，否则回退全局默认
    const hit = buckets.find((b) => b.id === preferred && b.enabled !== false);
    return { buckets, activeBucketId: hit ? hit.id : activeBucketId };
  }
  const visible = buckets.filter((b) => b.visibleToUsers !== false && b.enabled !== false);
  let activeId = preferred;
  if (!visible.some((b) => b.id === activeId)) {
    activeId = visible.length ? visible[0].id : '';
  }
  return { buckets: visible, activeBucketId: activeId };
}

/**
 * 批量设置桶对普通用户的可见性。
 * @param {string[]} visibleIds 对普通用户可见的桶 id 集合（不在集合内的桶一律设为不可见）
 * @returns {{ ok: boolean, visibleCount: number }}
 */
function setBucketsVisibility(visibleIds) {
  const cfg = requireStore();
  const set = new Set(Array.isArray(visibleIds) ? visibleIds : []);
  let visibleCount = 0;
  for (const b of cfg.buckets) {
    b.visibleToUsers = set.has(b.id);
    if (b.visibleToUsers) visibleCount++;
  }
  persist(cfg);
  return { ok: true, visibleCount };
}

function addBucket({ provider, bucket, region, remark, quotaBytes, credentialId, visibleToUsers, enabled, blockOverseasIP }) {
  const cfg = requireStore();
  const now = new Date().toISOString();
  // 服务商推导：绑定密钥的 provider 优先（桶必须与密钥同厂商，否则用错 SDK）；
  // 未绑定时用入参 provider（须是已注册厂商），最后回退默认（腾讯云）。
  let pid = '';
  if (credentialId) {
    const cred = cfg.credentials.find((c) => c.id === String(credentialId));
    if (cred && providers.get(cred.provider)) pid = cred.provider;
  }
  // 只有「入参 provider 是已注册厂商」才算**显式指定**，用于区分
  // 「调用方明确要设成某厂商」与「只是回退到默认厂商」（见下方 SEC-01）。
  const explicitProvider = providers.get(provider) ? provider : '';
  if (!pid) pid = explicitProvider || providers.DEFAULT_PROVIDER_ID;
  // 同名桶视为更新
  const exist = cfg.buckets.find((b) => b.bucket === bucket);
  if (exist) {
    // SEC-01：**仅当厂商被显式指定（或由绑定密钥推导）时才改写 provider**。
    // 旧实现在此无条件 `exist.provider = pid`，而未显式指定时 pid 会回退成默认厂商，
    // 于是任意普通用户只要提交一个**已存在的桶名**，就能把该桶的 provider 改成腾讯云
    // → activeCredential() 错配密钥、该桶对全体用户（含管理员）立即不可用。
    // 未显式指定时保持原厂商不变。
    if (credentialId || explicitProvider) exist.provider = pid;
    if (region) exist.region = region;
    if (remark !== undefined) exist.remark = String(remark || '');
    if (quotaBytes !== undefined) exist.quotaBytes = Number(quotaBytes) || 0;
    if (credentialId !== undefined) exist.credentialId = String(credentialId || '');
    if (visibleToUsers !== undefined) exist.visibleToUsers = visibleToUsers !== false;
    if (enabled !== undefined) exist.enabled = enabled !== false;
    if (blockOverseasIP !== undefined) exist.blockOverseasIP = blockOverseasIP === true;
    // FUN-06：不再顺手改写全局 activeBucketId。
    //
    // FUN-15 已把「当前桶」变成会话级状态，setActiveBucket() 会区分
    // 「写会话」与「写全局（仅管理员）」。而这里是无条件写全局 ——
    // 于是任何普通用户只要 POST /api/buckets/local 提交一个已存在的桶名，
    // 就能改变系统默认桶（影响管理员界面、WebDAV、分享链接回退）。
    // 需要切换请走 setActiveBucket(id, { token, role })。
    persist(cfg);
    return bucketView(exist);
  }
  const b = {
    id: newId(),
    provider: pid,
    bucket,
    region,
    remark: String(remark || ''),
    quotaBytes: Number(quotaBytes) || 0,
    credentialId: String(credentialId || ''),
    visibleToUsers: visibleToUsers !== false, // 默认对普通用户可见
    enabled: true, // 启用/停用（默认启用）
    blockOverseasIP: blockOverseasIP === true, // 按桶屏蔽海外 IP（默认关闭）
    createdAt: now,
  };
  cfg.buckets.push(b);
  // FUN-06：同上，新增桶不再自动设为当前桶。
  // 首个桶不受影响 —— activeBucket() 在 activeBucketId 为空时会回退到第一个未停用桶。
  persist(cfg);
  return bucketView(b);
}

function updateBucket(id, patch) {
  const cfg = requireStore();
  const b = cfg.buckets.find((x) => x.id === id);
  if (!b) return false;
  // SEC-01：**禁止通过通用更新接口修改 provider**。
  // 厂商必须由绑定的密钥推导（见 addBucket），否则可被用来把桶指向错误的厂商/SDK，
  // 破坏全体用户的数据面。region 同理属数据面字段，由路由层限制为管理员专属。
  if (patch.region !== undefined && patch.region) b.region = String(patch.region).trim();
  if (patch.remark !== undefined) b.remark = String(patch.remark || '');
  if (patch.quotaBytes !== undefined) b.quotaBytes = Number(patch.quotaBytes) || 0;
  if (patch.credentialId !== undefined) b.credentialId = String(patch.credentialId || '');
  if (patch.visibleToUsers !== undefined) b.visibleToUsers = patch.visibleToUsers !== false;
  if (patch.blockOverseasIP !== undefined) b.blockOverseasIP = patch.blockOverseasIP === true;
  if (patch.enabled !== undefined) {
    b.enabled = patch.enabled !== false;
    // 停用时自动设为对普通用户不可见（与密钥停用一致）
    if (!b.enabled) b.visibleToUsers = false;
  }
  persist(cfg);
  return true;
}

/** 查询指定桶是否开启「屏蔽海外 IP」（桶不存在返回 false） */
function bucketBlockOverseas(cfg, bucketId) {
  if (!cfg || !bucketId) return false;
  const b = (cfg.buckets || []).find((x) => x.id === bucketId);
  return !!(b && b.blockOverseasIP === true);
}

/** 统计已启用的桶数量（用于停用保护：至少保留一个启用桶） */
function enabledBucketCount(cfg) {
  return (cfg.buckets || []).filter((b) => b.enabled !== false).length;
}

function removeBucket(id) {
  const cfg = requireStore();
  const idx = cfg.buckets.findIndex((b) => b.id === id);
  if (idx < 0) return false;
  cfg.buckets.splice(idx, 1);
  if (cfg.activeBucketId === id) cfg.activeBucketId = (cfg.buckets[0] || {}).id || '';
  persist(cfg);
  return true;
}

/**
 * 切换当前桶（FUN-15：**会话级**）
 *
 * 旧实现无条件改写 `cfg.activeBucketId`。由于该字段是全局单值，普通用户切桶会
 * 连带改变管理员界面、`/api/fs/*`、`/api/stats/*`、WebDAV 与分享链接所使用的桶 ——
 * 多人同时使用时表现为"我的桶自己变了"。
 *
 * 现在的语义：
 *   - 有会话时：**只写会话**（`authSession.setSessionBucket`），绝不改写全局；
 *   - 仅管理员**额外**更新全局默认桶 —— 全局值的语义已降级为「系统默认桶」，
 *     供无会话场景（WebDAV、分享链接、启动自检）与首次登录回退使用。
 *
 * @param {string} id 目标桶 id
 * @param {{ token?: string, role?: string }} [opts] 省略时从请求上下文推断
 * @returns {boolean}
 */
function setActiveBucket(id, opts) {
  const cfg = requireStore();
  const b = cfg.buckets.find((x) => x.id === id);
  if (!b) return false;
  if (b.enabled === false) return false; // 不能激活已停用的桶

  let ctx = null;
  try { ctx = require('./request-context'); } catch (e) { /* 无上下文时按无会话处理 */ }
  const o = opts || {};
  const token = o.token || (ctx ? ctx.token() : '');
  const role = o.role || (ctx ? ctx.role() : '') || 'admin';
  const isAdmin = role !== 'user';
  // 普通用户不得激活对其不可见的桶。路由层（PUT /buckets/local/:id/active）虽已拦截，
  // 但这里必须再兜一层：否则其他调用点写进会话后，读端会静默回退到可见桶，
  // 表现为「界面显示已切换、实际仍在原桶」——既误导用户，也掩盖越权路径。
  if (!isAdmin && b.visibleToUsers === false) return false;

  // ① 会话级：这是「当前桶」的权威来源
  if (token) {
    let authSession = null;
    try { authSession = require('./auth-session'); } catch (e) { /* ignore */ }
    if (authSession && !authSession.setSessionBucket(token, id)) return false;
    if (ctx) ctx.setActiveBucketId(id); // 让本次请求后续逻辑立即生效
  }

  // ② 全局默认：只有管理员能改。普通用户走到这里会被跳过 —— 这正是本修复的核心。
  if (isAdmin) {
    cfg.activeBucketId = id;
    // 桶绑定了密钥时，同步切换默认密钥
    if (b.credentialId && cfg.credentials.some((c) => c.id === b.credentialId)) {
      cfg.activeCredentialId = b.credentialId;
    }
    persist(cfg);
  }
  return true;
}

/* ============================ 安全视图（供前端） ============================ */

function safeView(role) {
  const cfg = load();
  const isAdmin = role !== 'user'; // 缺省（undefined）按管理员/内部逻辑处理
  const creds = listCredentialsFor(isAdmin ? 'admin' : 'user');
  // FUN-13：桶过滤**复用 listBucketsFor()**，不要内联一份只有 visibleToUsers 的副本
  // —— 内联版本漏掉了 enabled，与列表接口口径分叉（历史上靠"停用自动隐藏"掩盖）。
  // 复用同一函数可从结构上消除口径漂移。
  const { buckets, activeBucketId } = listBucketsFor(isAdmin ? 'admin' : role);
  if (!cfg) {
    return {
      configured: false,
      corrupted,
      secretIdMasked: '',
      hasSecret: false,
      bucket: '', region: '', quotaBytes: 0, bucketRemark: '',
      domains: { primary: '', backup: '' },
      uploadExcludes: getUploadExcludes(),
      credentials: creds.credentials, activeCredentialId: creds.activeCredentialId,
      buckets, activeBucketId,
      updatedAt: '',
    };
  }
  // FUN-15：生效桶按「会话级当前桶 → 全局默认」解析，并统一做可见性/启用校验。
  // 旧实现管理员走全局、普通用户走角色过滤，两条口径容易漂移；现在收敛为同一个函数。
  let effBucket = resolveEffectiveBucket(cfg, isAdmin);
  if (effBucket && !isAdmin && (effBucket.visibleToUsers === false || effBucket.enabled === false)) {
    effBucket = null; // 普通用户不可见 → 视为未选桶，由前端引导切换
  }
  if (!effBucket && !isAdmin) {
    // 回退：角色可见的第一个启用桶（与 listBucketsFor 的口径一致）
    effBucket = (buckets || []).length
      ? (cfg.buckets.find((b) => b.id === activeBucketId && b.enabled !== false) || null)
      : null;
  }
  const c = activeCredential(cfg, effBucket);
  // 普通用户若当前生效密钥不可见或已停用，回退到可见且启用的密钥
  let effCredential = c;
  if (!isAdmin && c && (c.visibleToUsers === false || c.enabled === false)) {
    effCredential = cfg.credentials.find((x) => x.visibleToUsers !== false && x.enabled !== false) || null;
  }
  return {
    configured: Boolean(effCredential && effCredential.secretId && effCredential.secretKey),
    corrupted,
    provider: (effBucket && effBucket.provider) || (effCredential && effCredential.provider) || providers.DEFAULT_PROVIDER_ID,
    providerName: providers.nameOf((effBucket && effBucket.provider) || (effCredential && effCredential.provider)),
    secretIdMasked: effCredential ? maskSecretId(effCredential.secretId) : '',
    hasSecret: Boolean(effCredential && effCredential.secretKey),
    bucket: effBucket ? effBucket.bucket : '',
    region: effBucket ? effBucket.region : '',
    bucketRemark: effBucket ? effBucket.remark || '' : '',
    quotaBytes: effBucket ? (Number.isFinite(Number(effBucket.quotaBytes)) ? Number(effBucket.quotaBytes) : 0) : 0,
    domains: cfg.domains,
    uploadExcludes: getUploadExcludes(),
    credentials: creds.credentials,
    activeCredentialId: creds.activeCredentialId,
    buckets,
    activeBucketId,
    updatedAt: cfg.updatedAt,
  };
}

/** 使用独立密钥材料进行一次性加密解密验证（用于“测试连接”前自检） */
function selfTest() {
  try {
    const probe = { t: Date.now(), nonce: crypto.randomBytes(8).toString('hex') };
    const b64 = encrypt(probe);
    const out = decrypt(b64);
    return out.nonce === probe.nonce;
  } catch (e) {
    return false;
  }
}

function isCorrupted() {
  load();
  return corrupted;
}

/* ============================ 服务商 ============================ */

/** 返回全部服务商元数据（供前端呈现厂商选择器与文案） */
function listProviders() {
  return providers.list();
}

/* ============================ 用户偏好 ============================ */

function getPrefs() {
  const cfg = load();
  return cfg ? cfg.prefs : { aclReminderDisabled: false };
}

function setPrefs(patch) {
  const cfg = requireStore();
  cfg.prefs = Object.assign({}, cfg.prefs, patch || {});
  persist(cfg);
  return cfg.prefs;
}

/* ============================ 上传排除设置 ============================ */

function getUploadExcludes() {
  const cfg = load();
  return Object.assign({}, DEFAULT_UPLOAD_EXCLUDES, (cfg && cfg.uploadExcludes) || {});
}

function setUploadExcludes(patch) {
  const cfg = requireStore();
  cfg.uploadExcludes = Object.assign(getUploadExcludes(), patch || {});
  persist(cfg);
  return Object.assign({}, cfg.uploadExcludes);
}

/* ============================ 登录人机验证配置 ============================ */

/**
 * 读取验证码配置（服务端内部使用，含 secretKey）。
 * 绝不会被 routes 直接回传前端——对外由 captcha.publicConfig() 裁剪。
 */
function getCaptcha() {
  const cfg = load();
  const c = (cfg && cfg.captcha) || {};
  return {
    enabled: !!c.enabled,
    provider: c.provider === 'turnstile' ? 'turnstile' : 'recaptcha',
    siteKey: c.siteKey || '',
    secretKey: c.secretKey || '',
    timeoutMs: Number.isFinite(Number(c.timeoutMs)) && c.timeoutMs > 0 ? Number(c.timeoutMs) : 5000,
    onError: c.onError === 'degrade' ? 'degrade' : 'block',
  };
}

/**
 * 保存验证码配置。
 * - secretKey 留空表示"保持不变"（避免界面保存时误清空已配置的密钥）。
 * - secretKey 为 null（显式清除）时才真正置空。
 */
function saveCaptcha(patch) {
  const cfg = requireStore();
  const prev = getCaptcha();
  const p = patch || {};
  cfg.captcha = {
    enabled: p.enabled !== undefined ? !!p.enabled : prev.enabled,
    provider: ['recaptcha', 'turnstile'].includes(p.provider) ? p.provider : prev.provider,
    siteKey: p.siteKey !== undefined ? String(p.siteKey || '') : prev.siteKey,
    secretKey: p.secretKey === undefined || p.secretKey === '' ? prev.secretKey : String(p.secretKey),
    timeoutMs: p.timeoutMs !== undefined && Number.isFinite(Number(p.timeoutMs)) && Number(p.timeoutMs) > 0 ? Number(p.timeoutMs) : prev.timeoutMs,
    onError: p.onError !== undefined && p.onError === 'degrade' ? 'degrade' : 'block',
  };
  if (p.secretKey === null) cfg.captcha.secretKey = ''; // 显式清除密钥
  persist(cfg);
  return getCaptcha();
}

/* ============================ 支付平台凭证 ============================ */

/**
 * 读取支付配置（服务端内部使用，含明文密钥）。
 * 绝不会被路由直接回传前端 —— 对外由 paymentProviders.publicView() 裁剪为「值 + 是否已配置」。
 * @returns {{enabled: boolean, platforms: object, updatedAt: string}}
 */
function getPayment() {
  const cfg = load();
  const p = (cfg && cfg.payment) || {};
  const src = p.platforms && typeof p.platforms === 'object' ? p.platforms : {};
  const platforms = {};
  // 只保留注册表中已知平台，避免历史脏数据被一路带下去
  for (const id of Object.keys(src)) {
    if (!paymentProviders.isKnown(id)) continue;
    if (!src[id] || typeof src[id] !== 'object') continue;
    platforms[id] = Object.assign({}, src[id]);
  }
  return {
    enabled: p.enabled === true,
    platforms,
    // 站点对外地址：支付网关要往这里回调、支付完成后要跳回这里。
    // 本机回环地址收不到公网回调，故必须可由管理员显式指定（留空则按请求 Host 兜底）。
    siteUrl: typeof p.siteUrl === 'string' ? p.siteUrl : '',
    updatedAt: p.updatedAt || '',
  };
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * 写入某一支付平台的凭证。
 * 合并策略（"留空保持不变"等）由 paymentProviders.applySave() 在路由层完成，
 * 本函数只负责持久化 + 打时间戳，保持存储层语义单一。
 * `enabled`（渠道开关）不属于凭证，这里只做**保留**，改它请用 setChannelEnabled()。
 */
function savePayment(platformId, values) {
  const cfg = requireStore();
  const cur = getPayment();
  const platforms = Object.assign({}, cur.platforms);
  if (values && Object.keys(values).length) {
    const prev = platforms[platformId] || {};
    platforms[platformId] = Object.assign({}, prev, values, { updatedAt: nowIso() });
  } else {
    delete platforms[platformId];
  }
  cfg.payment = { enabled: cur.enabled, platforms, siteUrl: cur.siteUrl, updatedAt: nowIso() };
  persist(cfg);
  return getPayment();
}

/** 总开关：启用 / 停用支付功能（不影响任何已保存的渠道与凭证配置） */
function setPaymentEnabled(on) {
  const cfg = requireStore();
  const cur = getPayment();
  cfg.payment = { enabled: !!on, platforms: cur.platforms, siteUrl: cur.siteUrl, updatedAt: nowIso() };
  persist(cfg);
  return getPayment();
}

/** 渠道开关：启用 / 停用某一支付渠道（约束校验在路由层，由 payment-rules 判定） */
function setChannelEnabled(platformId, on) {
  const cfg = requireStore();
  const cur = getPayment();
  const platforms = Object.assign({}, cur.platforms);
  const prev = platforms[platformId] || {};
  platforms[platformId] = Object.assign({}, prev, { enabled: !!on, updatedAt: nowIso() });
  cfg.payment = { enabled: cur.enabled, platforms, siteUrl: cur.siteUrl, updatedAt: nowIso() };
  persist(cfg);
  return getPayment();
}

/**
 * 站点对外地址（支付网关回调与支付完成回跳的目标）。
 * 传空串表示清除，回退为「按请求 Host 兜底」。
 */
function setPaymentSiteUrl(url) {
  const cfg = requireStore();
  const cur = getPayment();
  const v = String(url == null ? '' : url).trim().replace(/\/+$/, ''); // 去掉结尾斜杠，拼接时统一处理
  cfg.payment = { enabled: cur.enabled, platforms: cur.platforms, siteUrl: v, updatedAt: nowIso() };
  persist(cfg);
  return getPayment();
}

/** 清除某一支付平台的全部凭证（开关状态一并复位为关闭） */
function clearPayment(platformId) {
  return savePayment(platformId, {});
}

/* ============================ WebDAV 服务 ============================ */

// 密码字段级加密（外层 config.enc 已整包加密，此处为账户口令再加一层 GCM 保护）
function sealPassword(plain) {
  return encrypt({ v: 1, pw: String(plain == null ? '' : plain) });
}
function openPassword(sealed) {
  if (!sealed) return '';
  try {
    const o = decrypt(sealed);
    return o && typeof o === 'object' ? String(o.pw || '') : '';
  } catch (e) {
    return '';
  }
}

function normalizeAccountInput(b) {
  const appName = String((b && b.appName) || '').trim();
  const username = String((b && b.username) || '').trim();
  if (!appName) throw Object.assign(new Error('应用名称不能为空'), { status: 400 });
  if (!username) throw Object.assign(new Error('用户名不能为空'), { status: 400 });
  if (appName.length > 64) throw Object.assign(new Error('应用名称最长 64 个字符'), { status: 400 });
  if (username.length > 64) throw Object.assign(new Error('用户名最长 64 个字符'), { status: 400 });
  return { appName, username };
}

/** 账户安全视图（默认不回传明文密码；showPassword=true 时附带 password） */
function accountView(a, showPassword) {
  return {
    id: a.id,
    appName: a.appName,
    username: a.username,
    hasPassword: Boolean(a.passwordSealed),
    createdAt: a.createdAt || '',
    updatedAt: a.updatedAt || '',
    password: showPassword ? openPassword(a.passwordSealed) : undefined,
  };
}

function getWebdav() {
  const cfg = load() || requireStore();
  const w = cfg.webdav || { enabled: false, accounts: [] };
  return {
    enabled: !!w.enabled,
    accounts: (w.accounts || []).map((a) => accountView(a, false)),
  };
}

function setWebdavEnabled(enabled) {
  const cfg = requireStore();
  cfg.webdav = cfg.webdav || { enabled: false, accounts: [] };
  cfg.webdav.enabled = !!enabled;
  persist(cfg);
  return getWebdav();
}

function addWebdavAccount(b) {
  const { appName, username } = normalizeAccountInput(b);
  const password = String((b && b.password) || '');
  if (!password) throw Object.assign(new Error('密码不能为空'), { status: 400 });
  if (password.length > 128) throw Object.assign(new Error('密码最长 128 个字符'), { status: 400 });
  const cfg = requireStore();
  cfg.webdav = cfg.webdav || { enabled: false, accounts: [] };
  if (cfg.webdav.accounts.some((a) => a.appName === appName)) {
    throw Object.assign(new Error('同名应用账户已存在，请使用编辑功能修改'), { status: 409 });
  }
  const now = new Date().toISOString();
  const acc = { id: newId(), appName, username, passwordSealed: sealPassword(password), createdAt: now, updatedAt: now };
  cfg.webdav.accounts.push(acc);
  persist(cfg);
  return accountView(acc, false);
}

function updateWebdavAccount(id, b) {
  const cfg = requireStore();
  cfg.webdav = cfg.webdav || { enabled: false, accounts: [] };
  const acc = cfg.webdav.accounts.find((a) => a.id === id);
  if (!acc) throw Object.assign(new Error('账户不存在'), { status: 404 });
  if (b.appName !== undefined || b.username !== undefined) {
    const merged = { appName: b.appName !== undefined ? b.appName : acc.appName, username: b.username !== undefined ? b.username : acc.username };
    const { appName, username } = normalizeAccountInput(merged);
    if (cfg.webdav.accounts.some((a) => a.id !== id && a.appName === appName)) {
      throw Object.assign(new Error('同名应用账户已存在'), { status: 409 });
    }
    acc.appName = appName;
    acc.username = username;
  }
  if (b.password !== undefined) {
    const password = String(b.password || '');
    if (!password) throw Object.assign(new Error('密码不能为空'), { status: 400 });
    if (password.length > 128) throw Object.assign(new Error('密码最长 128 个字符'), { status: 400 });
    acc.passwordSealed = sealPassword(password);
  }
  acc.updatedAt = new Date().toISOString();
  persist(cfg);
  return accountView(acc, false);
}

function removeWebdavAccount(id) {
  const cfg = requireStore();
  cfg.webdav = cfg.webdav || { enabled: false, accounts: [] };
  const idx = cfg.webdav.accounts.findIndex((a) => a.id === id);
  if (idx < 0) return false;
  cfg.webdav.accounts.splice(idx, 1);
  persist(cfg);
  return true;
}

/** 取出指定账户明文密码（账户列表展示密码 / WebDAV Basic 认证使用） */
function revealWebdavPassword(id) {
  const cfg = load();
  const acc = cfg && cfg.webdav && cfg.webdav.accounts.find((a) => a.id === id);
  if (!acc) return null;
  return accountView(acc, true);
}

/**
 * 恒定时间字符串比较（S7）：各自取 SHA-256 摘要（定长 32 字节）后再 timingSafeEqual，
 * 既不泄露长度差异，也避免自写逐字节循环的潜在优化风险。
 */
function constTimeEquals(a, b) {
  const ha = crypto.createHash('sha256').update(String(a == null ? '' : a), 'utf8').digest();
  const hb = crypto.createHash('sha256').update(String(b == null ? '' : b), 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * 空转哈希：账户不存在/未启用时执行，保持与成功路径相近耗时，避免用户名枚举（S7）。
 * SEC-05：同样走**异步** scrypt（旧版 scryptSync 在 WebDAV 随机用户名爆破下会阻塞主线程）。
 */
function dummyHash(password) {
  return new Promise((resolve) => {
    crypto.scrypt(String(password == null ? '' : password), Buffer.from('00'.repeat(16), 'hex'), 32, () => resolve());
  });
}

/** WebDAV 认证：按用户名匹配账户，返回 { ok, account? }（SEC-05：async） */
async function authenticateWebdav(username, password) {
  const cfg = load();
  if (!cfg || !cfg.webdav || !cfg.webdav.enabled) { await dummyHash(password); return { ok: false }; }
  const acc = cfg.webdav.accounts.find((a) => a.username === String(username || ''));
  if (!acc) { await dummyHash(password); return { ok: false }; }
  const plain = openPassword(acc.passwordSealed);
  // R14-07：口令错误时**也必须跑一次 dummyHash**。真实路径只做 AES-GCM 解密 + 两次
  // SHA-256（微秒级），而「用户名不存在」分支要跑一次完整 scrypt（约 50ms）——
  // 不补这一行的话，侧信道恰好**反向放大**：有效用户名是「快」的那个，
  // 单次请求即可枚举出全部 WebDAV 账户名，再配合 webdavAuthLimiter 做定向爆破。
  // 同文件的 `authenticateUser` 无论用户名是否存在都走 scrypt，此处此前与它口径不一致。
  if (!constTimeEquals(password, plain)) { await dummyHash(password); return { ok: false }; }
  return { ok: true, account: { id: acc.id, appName: acc.appName, username: acc.username } };
}

/* ============================ 用户管理（登录鉴权） ============================ */

/**
 * ⚠️ SEC-05：口令哈希**必须用异步 scrypt**，禁止再引入 `scryptSync`。
 *
 * `crypto.scryptSync` 的执行无法被事件循环切分（N=16384 约 16MB 内存 + 数十毫秒 CPU），
 * 几十个并发请求就能把单线程事件循环压满 —— 全站（含正在进行的下载与 WebDAV）一起卡死。
 * 异步版本在 libuv 线程池中执行，代价是调用链必须 `await`：
 * 因此 `addUser` / `updateUser` / `authenticateUser` / `verifyUserPassword` /
 * `authenticateWebdav` 全部改为 async。
 */
function scryptHex(pw, saltHex) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(pw), Buffer.from(saltHex, 'hex'), 32, (err, key) => {
      if (err) reject(err); else resolve(key.toString('hex'));
    });
  });
}

function generateSalt() {
  return crypto.randomBytes(16).toString('hex');
}

/** 生成口令哈希（异步）→ { salt, hash } */
async function hashPassword(password) {
  const salt = generateSalt();
  return { salt, hash: await scryptHex(password, salt) };
}

/** 时序安全比较（异步），避免时序侧信道猜测密码 */
async function verifyPassword(password, hash, salt) {
  if (!hash || !salt) return false;
  try {
    const a = Buffer.from(await scryptHex(password, salt), 'hex');
    const b = Buffer.from(hash, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (e) {
    return false;
  }
}

/** 用户名合法性校验 */
function normalizeUsername(username) {
  const name = String(username || '').trim();
  if (!name) throw Object.assign(new Error('用户名不能为空'), { status: 400 });
  if (!/^[a-zA-Z0-9_\u4e00-\u9fa5@.-]{2,32}$/.test(name)) {
    throw Object.assign(new Error('用户名仅支持 2-32 位中文、字母、数字及 _ @ . - 字符'), { status: 400 });
  }
  return name;
}

/** 密码强度校验（新增用户/修改密码时使用） */
function assertPasswordPolicy(password) {
  if (typeof password !== 'string' || password.length < 6) {
    throw Object.assign(new Error('密码长度至少 6 位'), { status: 400 });
  }
  if (password.length > 128) {
    throw Object.assign(new Error('密码最长 128 个字符'), { status: 400 });
  }
}

function normalizeRole(role) {
  return ['admin', 'user'].includes(role) ? role : 'user';
}

function normalizePermissions(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return {};
  return p;
}

/* ============================ Windows Hello（WebAuthn）凭据 ============================ */

/**
 * 归一化用户上的 WebAuthn 凭据。
 *
 * 设计：**凭据完整才视为启用**。`enabled` 只是用户意愿开关，真正的判定必须
 * 同时具备 credentialId 与 publicKey —— 缺任一即回落到未启用，避免"开关是开的
 * 但无法验证"导致登录被永久卡死（那种情况下用户只能改配置文件自救）。
 */
function normalizeWebauthn(w) {
  const empty = { enabled: false, credentialId: '', publicKey: '', signCount: 0, aaguid: '', fmt: '', createdAt: '', lastUsedAt: '' };
  if (!w || typeof w !== 'object' || Array.isArray(w)) return empty;
  const credentialId = typeof w.credentialId === 'string' ? w.credentialId : '';
  const publicKey = typeof w.publicKey === 'string' ? w.publicKey : '';
  const complete = Boolean(credentialId && publicKey);
  return {
    enabled: Boolean(w.enabled) && complete,
    credentialId,
    publicKey,
    signCount: Number.isFinite(Number(w.signCount)) ? Number(w.signCount) : 0,
    aaguid: typeof w.aaguid === 'string' ? w.aaguid : '',
    fmt: typeof w.fmt === 'string' ? w.fmt : '',
    createdAt: typeof w.createdAt === 'string' ? w.createdAt : '',
    lastUsedAt: typeof w.lastUsedAt === 'string' ? w.lastUsedAt : '',
  };
}

/** 该用户是否已启用并可用的 Windows Hello */
function isWebauthnEnabled(user) {
  const w = normalizeWebauthn(user && user.webauthn);
  return w.enabled;
}

/** 读取用户的 WebAuthn 凭据（归一化后的副本） */
function getWebauthn(user) {
  return normalizeWebauthn(user && user.webauthn);
}

/** 保存用户的注册结果并启用 Windows Hello */
function setUserWebauthn(id, { credentialId, publicKey, signCount, aaguid, fmt }) {
  const cfg = requireStore();
  const user = cfg.users.find((u) => u.id === id);
  if (!user) throw Object.assign(new Error('用户不存在'), { status: 404 });
  if (!credentialId || !publicKey) throw Object.assign(new Error('Windows Hello 凭据信息不完整'), { status: 400 });
  const now = new Date().toISOString();
  user.webauthn = normalizeWebauthn({
    enabled: true,
    credentialId,
    publicKey,
    signCount: Number(signCount) || 0,
    aaguid: aaguid || '',
    fmt: fmt || '',
    createdAt: now,
    lastUsedAt: '',
  });
  user.updatedAt = now;
  persist(cfg);
  return userView(user);
}

/** 关闭 Windows Hello 并清除凭据（保守起见一并清空密钥材料） */
function clearUserWebauthn(id) {
  const cfg = requireStore();
  const user = cfg.users.find((u) => u.id === id);
  if (!user) throw Object.assign(new Error('用户不存在'), { status: 404 });
  user.webauthn = normalizeWebauthn(null);
  user.updatedAt = new Date().toISOString();
  persist(cfg);
  return userView(user);
}

/** 登录成功后更新签名计数与使用时间 */
function touchWebauthn(id, signCount) {
  const cfg = requireStore();
  const user = cfg.users.find((u) => u.id === id);
  if (!user) return null;
  const w = normalizeWebauthn(user.webauthn);
  w.signCount = Number(signCount) || 0;
  w.lastUsedAt = new Date().toISOString();
  user.webauthn = w;
  persist(cfg);
  return userView(user);
}

/** 用户安全视图：绝不回传密码哈希/盐，也不回传 WebAuthn 公钥（仅回传是否启用） */
function userView(u) {
  const w = normalizeWebauthn(u.webauthn);
  return {
    id: u.id,
    username: u.username,
    role: u.role || 'user',
    permissions: u.permissions || {},
    // Windows Hello：仅暴露"是否启用"与注册时间，公钥/凭据 ID 一律不出服务端
    webauthnEnabled: w.enabled,
    webauthnCreatedAt: w.enabled ? w.createdAt : '',
    createdAt: u.createdAt || '',
    updatedAt: u.updatedAt || '',
  };
}

function listUsers() {
  const cfg = load();
  if (!cfg) return [];
  return cfg.users.map(userView);
}

function getUserById(id) {
  const cfg = load();
  if (!cfg) return null;
  return cfg.users.find((u) => u.id === id) || null;
}

/** 管理员数量统计（用于保护最后一个管理员） */
function adminCount(cfg) {
  return (cfg.users || []).filter((u) => u.role === 'admin').length;
}

async function addUser({ username, password, role, permissions }) {
  const name = normalizeUsername(username);
  assertPasswordPolicy(password);
  // R14-04：先把异步工作做完（scrypt 约 50~100ms），再取 store 并**同步**完成全部修改。
  //
  // 旧实现是「先取 cfg → await → 改 cfg → persist(cfg)」。await 期间若 60 秒 TTL 到期，
  // `load()` 会把 `cached` 换成**新对象**（`cached = cfg`），手上的 cfg 就此脱钩；
  // 随后的 `persist(cfg)` 又把 `cached` 指回旧对象，于是这段时间内别人的写入被
  // **整体覆盖** —— 双方都收到成功响应，一方的变更却静默消失（丢的若是角色/权限，
  // 就表现为「降权不生效」）。把 await 提到取 store 之前，异步间隙即不复存在。
  const { salt, hash } = await hashPassword(password);
  const cfg = requireStore();
  if (cfg.users.some((u) => u.username.toLowerCase() === name.toLowerCase())) {
    throw Object.assign(new Error('用户名已存在'), { status: 409 });
  }
  const now = new Date().toISOString();
  const user = {
    id: newId(),
    username: name,
    passwordSalt: salt,
    passwordHash: hash,
    role: normalizeRole(role),
    permissions: normalizePermissions(permissions),
    // 新用户默认未启用 Windows Hello；启用须走"注册并验证凭据"的完整流程
    webauthn: normalizeWebauthn(null),
    createdAt: now,
    updatedAt: now,
  };
  cfg.users.push(user);
  persist(cfg);
  return userView(user);
}

async function updateUser(id, patch) {
  const now = new Date().toISOString();
  // 同 `addUser`（R14-04）：把唯一一处 await 提到取 store **之前**。
  // 否则这一段 scrypt 期间一旦 TTL 到期换了 cached 对象，后面所有 `user.xxx = …`
  // 都会写进脱钩的旧对象，最终 `persist(cfg)` 覆盖掉别人的写入。
  let cred = null;
  if (patch.password !== undefined && patch.password !== '') {
    assertPasswordPolicy(patch.password);
    cred = await hashPassword(patch.password);
  }
  const cfg = requireStore();
  const user = cfg.users.find((u) => u.id === id);
  if (!user) throw Object.assign(new Error('用户不存在'), { status: 404 });

  if (patch.username !== undefined && String(patch.username).trim() !== user.username) {
    const name = normalizeUsername(patch.username);
    if (cfg.users.some((u) => u.id !== id && u.username.toLowerCase() === name.toLowerCase())) {
      throw Object.assign(new Error('用户名已存在'), { status: 409 });
    }
    user.username = name;
  }
  if (cred) {
    user.passwordSalt = cred.salt;
    user.passwordHash = cred.hash;
  }
  if (patch.role !== undefined) {
    const role = normalizeRole(patch.role);
    if (user.role === 'admin' && role !== 'admin' && adminCount(cfg) <= 1) {
      throw Object.assign(new Error('至少保留一个管理员账户'), { status: 400 });
    }
    user.role = role;
  }
  if (patch.permissions !== undefined) {
    user.permissions = normalizePermissions(patch.permissions);
  }
  user.updatedAt = now;
  persist(cfg);
  return userView(user);
}

function removeUser(id) {
  const cfg = requireStore();
  const idx = cfg.users.findIndex((u) => u.id === id);
  if (idx < 0) return false;
  const target = cfg.users[idx];
  if (target.role === 'admin' && adminCount(cfg) <= 1) {
    throw Object.assign(new Error('至少保留一个管理员账户'), { status: 400 });
  }
  cfg.users.splice(idx, 1);
  persist(cfg);
  return true;
}

/** 登录认证：按用户名匹配，返回用户安全视图或 null（SEC-05：async） */
async function authenticateUser(username, password) {
  const cfg = load();
  if (!cfg) return null;
  const name = String(username || '').trim();
  const user = cfg.users.find((u) => u.username.toLowerCase() === name.toLowerCase());
  // 用户不存在也做一次等价耗时的空转哈希，避免通过响应时间枚举用户名
  if (!user) { await dummyHash(password); return null; }
  if (!(await verifyPassword(String(password == null ? '' : password), user.passwordHash, user.passwordSalt))) {
    return null;
  }
  return userView(user);
}

/**
 * 按用户名读取原始用户记录（含 WebAuthn 凭据等敏感字段）。
 *
 * 仅供登录流程在服务端**内部**使用（需要 publicKey 做签名校验）；
 * 任何路由都不得把本函数的返回值直接回传前端。
 */
function findUserRaw(username) {
  const cfg = load();
  if (!cfg) return null;
  const name = String(username || '').trim();
  if (!name) return null;
  return cfg.users.find((u) => u.username.toLowerCase() === name.toLowerCase()) || null;
}

/** 按 id 读取原始用户记录（同上，仅限服务端内部使用） */
function findUserRawById(id) {
  const cfg = load();
  if (!cfg) return null;
  return cfg.users.find((u) => u.id === id) || null;
}

/** 校验密码是否正确（不返回用户对象，供两步登录的第一步单独使用）（SEC-05：async） */
async function verifyUserPassword(id, password) {
  const user = findUserRawById(id);
  if (!user) return false;
  return verifyPassword(String(password == null ? '' : password), user.passwordHash, user.passwordSalt);
}

module.exports = {
  load, save, get, flush, flushPending, getLastWriteError, getMasterKey,
  effective, effectiveForBucket, safeView, selfTest, isCorrupted,
  encrypt, decrypt, // 供 secure-store 复用同一主密钥与格式（S4）
  unwritableError, // 供 enc-store 等复用「备份 + 拒绝覆盖」语义（FUN-03 / FUN-04）
  DEFAULT_CONFIG, DEFAULT_QUOTA,
  listCredentials, listCredentialsFor, addCredential, removeCredential, setActiveCredential, updateCredentialRemark, updateCredential, setCredentialsVisibility,
  listProviders,
  listBuckets, listBucketsFor, addBucket, updateBucket, removeBucket, setActiveBucket, setBucketsVisibility, bucketBlockOverseas,
  getPrefs, setPrefs,
  getUploadExcludes, setUploadExcludes,
  getCaptcha, saveCaptcha,
  // 支付平台凭证（仅基础配置与合法性校验）
  getPayment, savePayment, clearPayment, setPaymentEnabled, setChannelEnabled, setPaymentSiteUrl,
  getWebdav, setWebdavEnabled, addWebdavAccount, updateWebdavAccount, removeWebdavAccount,
  revealWebdavPassword, authenticateWebdav,
  listUsers, getUserById, userView, addUser, updateUser, removeUser, authenticateUser,
  // Windows Hello（WebAuthn）
  isWebauthnEnabled, getWebauthn, setUserWebauthn, clearUserWebauthn, touchWebauthn,
  findUserRaw, findUserRawById, verifyUserPassword,
};
