/**
 * 分享链接存储 —— data/links.json（明文 JSON，不含密钥）
 *
 * 每条链接：
 *  {
 *    id, key, bucket, region,          // 目标对象与所属桶（创建时快照）
 *    fileName, size,                   // 展示用元数据（创建时快照）
 *    createdAt,
 *    createdBy,                        // 创建者用户名（用于按角色隔离列表；历史数据为空）
 *    expiresAt,                        // ISO 时间；null = 永久有效
 *    maxDownloads,                     // 最大下载次数；0 = 不限制
 *    downloads, lastDownloadAt,        // 已下载次数 / 最近下载时间
 *    passwordSalt, passwordHash,       // scrypt 哈希；无则未启用密码
 *    missingAt,                        // ISO 时间；非空 = 云端对象已不存在（见下方「对象缺失标记」）
 *    paid: { required, amountFen, currency },  // 付费下载配置（分享者意图，永远原样保留）
 *  }
 *
 * ⚠️ `paid` 只表达**分享者的意图**，不代表当前一定收费。是否真的收费由
 * `server/payment-rules.js` 的 `resolvePaidState()` 在读取时计算 ——
 * 停用支付功能后链接自动转免费，重新启用又自然恢复，全程不需要改动本文件的数据。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const configStore = require('./config-store');
const secureStore = require('./secure-store');

// COS_DATA_DIR：与 payment-orders / enc-store / stats-store / upload-sessions
// 一致的测试隔离开关（此前缺失，用例只能写真实 data/links.json）
const DATA_DIR = process.env.COS_DATA_DIR ? path.resolve(process.env.COS_DATA_DIR) : path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'links.json');

let cache = null;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  if (cache) return cache;
  try {
    // S4：加密存储（兼容历史明文文件）
    const raw = secureStore.readJson(FILE, null);
    if (raw && Array.isArray(raw.links)) {
      cache = raw;
      return cache;
    }
  } catch (e) {
    // SEC-09：损坏时不静默重建 —— 打出告警；secure-store 已锁定该文件写入，
    // 磁盘上的损坏文件（及其 .corrupt-* 备份）不会被空表覆盖。
    console.error('[share-store] 分享链接文件损坏，已降级为空列表并锁定写入：', e.message);
  }
  cache = { links: [] };
  return cache;
}

function persist() {
  ensureDataDir();
  // N5：异步串行写入（secure-store 内部按文件维度排队 + 原子写），
  // 优雅关闭时由 index.js 的 secureStore.flush() 兜底不丢数据
  secureStore.writeJsonAsync(FILE, cache);
}

/**
 * 分享链接 ID：16 字节 base64url（22 字符，128 位熵）—— 与 config-store.newId 的熵要求
 * 保持一致（此前为 9 字节/72 位）。链接 ID 会出现在公开 URL 中，故不能过短；
 * 历史 8/12 字符 ID 仍可正常访问（不做强制迁移）。
 */
function newId() {
  return crypto.randomBytes(16).toString('base64url');
}

/**
 * 口令哈希（SEC-05：异步）。
 * 分享密码是**攻击者可达的校验入口**（`/s/:id` 输入密码即触发），
 * 旧版 scryptSync 会被用来阻塞事件循环，故一律走异步 scrypt。
 */
function hashPassword(pw, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(pw), Buffer.from(salt, 'hex'), 32, (err, key) => {
      if (err) reject(err); else resolve(key.toString('hex'));
    });
  });
}

/* ------------------------- 视图 / 状态 ------------------------- */

/** 安全视图：不含密码哈希 */
function view(l) {
  return {
    id: l.id,
    key: l.key,
    bucket: l.bucket,
    region: l.region,
    fileName: l.fileName || '',
    size: Number(l.size) || 0,
    createdAt: l.createdAt,
    createdBy: l.createdBy || '',
    expiresAt: l.expiresAt || null,
    maxDownloads: Number(l.maxDownloads) || 0,
    downloads: Number(l.downloads) || 0,
    lastDownloadAt: l.lastDownloadAt || null,
    hasPassword: Boolean(l.passwordHash),
    missingAt: l.missingAt || null,
    missing: Boolean(l.missingAt),
    paid: {
      required: Boolean(l.paid && l.paid.required),
      amountFen: Number(l.paid && l.paid.amountFen) || 0,
      currency: (l.paid && l.paid.currency) || 'CNY',
    },
  };
}

/**
 * 链接状态：deleted | expired | exhausted | active
 *
 * 「文件已删除」排在最前：对象没了是最根本的事实，也是管理员最需要知道的 ——
 * 否则管理页只显示「有效」，管理员会去改有效期/次数，改完照样下不了。
 */
function status(l, now = Date.now()) {
  if (l.missingAt) return 'deleted';
  if (l.expiresAt && new Date(l.expiresAt).getTime() <= now) return 'expired';
  if (Number(l.maxDownloads) > 0 && Number(l.downloads) >= Number(l.maxDownloads)) return 'exhausted';
  return 'active';
}

function list() {
  return load().links.map(view);
}

/**
 * 按创建者过滤列表：
 * - 管理员：全部链接
 * - 普通用户：仅自己创建的链接（历史无 createdBy 的链接对普通用户不可见）
 */
function listFor(role, username) {
  const all = load().links.map(view);
  if (role === 'admin') return all;
  return all.filter((l) => l.createdBy && l.createdBy === username);
}

/** 判断某用户是否有权操作指定链接（管理员任意；普通用户仅限自己创建的） */
function canManage(link, role, username) {
  if (!link) return false;
  if (role === 'admin') return true;
  return Boolean(link.createdBy) && link.createdBy === username;
}

function get(id) {
  return load().links.find((l) => l.id === id) || null;
}

/* ------------------------- 增删改 ------------------------- */

/**
 * 规范化付费配置（防御性：路由层已做过带错误提示的校验，这里只保证落盘数据合法）
 * @returns {{required: boolean, amountFen: number, currency: string}}
 */
function normalizePaid(paid) {
  if (!paid || typeof paid !== 'object') return { required: false, amountFen: 0, currency: 'CNY' };
  const required = Boolean(paid.required);
  const fen = Number(paid.amountFen);
  const amountFen = Number.isInteger(fen) && fen > 0 ? fen : 0;
  // 要求付费却没有合法金额 → 视为未启用（宁可免费，也不要出现"必须付 0 元"的怪状态）
  return { required: required && amountFen > 0, amountFen, currency: 'CNY' };
}

async function create({ key, bucket, region, fileName, size, expiresHours, maxDownloads, password, createdBy, paid }) {
  const links = load().links;
  const l = {
    id: newId(),
    key,
    bucket,
    region,
    fileName: fileName || String(key).split('/').pop() || 'file',
    size: Number(size) || 0,
    createdAt: new Date().toISOString(),
    createdBy: createdBy || '',
    expiresAt: expiresHours ? new Date(Date.now() + expiresHours * 3600 * 1000).toISOString() : null,
    maxDownloads: Number(maxDownloads) || 0,
    downloads: 0,
    lastDownloadAt: null,
    paid: normalizePaid(paid),
  };
  if (password) {
    const salt = crypto.randomBytes(16).toString('hex');
    l.passwordSalt = salt;
    l.passwordHash = await hashPassword(password, salt);
  }
  links.unshift(l);
  persist();
  return view(l);
}

async function update(id, patch) {
  const l = get(id);
  if (!l) return null;
  if (patch.expiresHours !== undefined) {
    const h = patch.expiresHours;
    l.expiresAt = h ? new Date(Date.now() + h * 3600 * 1000).toISOString() : null;
  }
  if (patch.maxDownloads !== undefined) l.maxDownloads = Number(patch.maxDownloads) || 0;
  if (patch.password !== undefined) {
    if (patch.password === null || patch.password === '') {
      delete l.passwordHash;
      delete l.passwordSalt;
    } else {
      const salt = crypto.randomBytes(16).toString('hex');
      l.passwordSalt = salt;
      l.passwordHash = await hashPassword(patch.password, salt);
    }
  }
  if (patch.resetCount) {
    l.downloads = 0;
    l.lastDownloadAt = null;
  }
  if (patch.paid !== undefined) l.paid = normalizePaid(patch.paid);
  persist();
  return view(l);
}

function remove(id) {
  const links = load().links;
  const i = links.findIndex((l) => l.id === id);
  if (i < 0) return false;
  links.splice(i, 1);
  persist();
  return true;
}

/* ------------------------- 对象缺失标记 ------------------------- */

/**
 * 标记「该链接指向的云端对象已不存在」。
 *
 * 链接在创建时快照了 key/bucket，云端对象被删掉后链接本身毫发无损 —— 旧行为是：
 * 分享页照常显示下载按钮（点了才报"文件不存在"），管理页则完全无感知，仍显示「有效」。
 * 这里把「对象没了」落成链接上的一个字段，让**分享页与管理页共用同一个事实来源**，
 * 避免两边各判一套、又出现改一半的漏网之鱼。
 *
 * @returns {boolean} 是否真的发生了状态变化（未变化就不落盘）
 */
function markMissing(id) {
  const l = get(id);
  if (!l || l.missingAt) return false;
  l.missingAt = new Date().toISOString();
  persist();
  return true;
}

/** 取消「已删除」标记（对象被重新上传到同一个 key） */
function clearMissing(id) {
  const l = get(id);
  if (!l || !l.missingAt) return false;
  delete l.missingAt;
  persist();
  return true;
}

/**
 * 批量标记：给定 bucket 下**已确认删除**的 key 集合。
 *
 * 刻意只接受「云端确认删掉的 key」集合，而不是前缀 —— 删除目录时若被截断，
 * 按前缀标记会把还活着的对象误判成已删除（与 FUN-04「元数据只按已确认删除的 key 清」
 * 是同一个约束）。
 *
 * R9-07：与 {@link markMissingByBucket} 不同，这里**保留宽松口径**是成立的 ——
 * 判据是「该 key 在云端被**明确确认**删除」，是一条事实而不是猜测。
 * 历史链接（无 `bucket` 字段）的 key 确实被删了，标记它是正确的。
 *
 * 唯一的风险是「不同桶下同名 key」被误伤：此时 `l.bucket` 非空且与本次删除的
 * `bucket` 不同 → 下面的条件会跳过它（这是有意的，避免跨桶误判）。
 * 真正的历史遗留问题（无 bucket + 猜不出桶）见 `markMissingByBucket` 的注释：
 * 那类链接需要 `bucket` 回填，而不是靠自愈。
 *
 * @returns {number} 本次新标记的数量
 */
function markMissingByKeys(bucket, keys) {
  const set = new Set(Array.isArray(keys) ? keys : []);
  if (!set.size) return 0;
  const now = new Date().toISOString();
  let n = 0;
  for (const l of load().links) {
    if (l.missingAt || !set.has(l.key)) continue;
    // 有 bucket 且与本次删除的桶不同 → 跳过（跨桶同名 key 不能误伤）。
    // 无 bucket 的历史链接：该 key 已被云端明确确认删除，标记是事实 → 不跳过。
    if (l.bucket && bucket && l.bucket !== bucket) continue;
    l.missingAt = now;
    n += 1;
  }
  if (n) persist();
  return n;
}

/**
 * 整桶标记：该存储桶已不存在（彻底删桶）→ 指向它的全部链接一律判「文件已删除」。
 *
 * R7-03：彻底删桶此前只清了 IP 规则、加密元数据、统计，**唯独不动分享链接**。
 * 桶都没了，`effectiveForBucket()` 拿不到凭据，分享页的惰性探测会 fail-open，
 * 于是页面一直显示可下载、点了才报错 —— 比「清空桶」更糟，因为连兜底探测都失效了。
 *
 * 这里按**桶**而不是按 key 标记：桶整体消失时，它下面任何 key 都不可能还在，
 * 不需要（也拿不到）逐个 key 的删除确认。
 *
 * R8-24 曾把这里改成「宽松口径」—— 连**没有 `bucket` 字段的历史链接**也一并标记，
 * 理由是「猜错了的链接会被分享页的惰性探测在 60 秒内判回有效」。R9-07 复核后确认
 * 这条论证**不成立**，宽松口径是净负，因此改回**严格口径**：
 *
 *   `configStore.effectiveForBucket(undefined)` 走的是
 *   `buckets.find(x => x.bucket === undefined)` —— 永远不命中，返回 `null`。
 *   而分享页的自愈逻辑（`share-routes.probeObjectMissing`）在 `cfg` 为 null 时
 *   **刻意不探测、也不改判**（fail-open 只适用于「不确定」，不适用于「连探都没探成」）。
 *   于是这类链接被标记后**既不打云端、也不会 `clearMissing`**，永久停在 410 ——
 *   恰好就是注释声称要避免的「永久错误状态」。
 *
 * 严格口径（无 bucket 就跳过）下，这类历史链接保持原状态：分享页会照常探测
 * （`l.bucket` 为 undefined 时 `effectiveForBucket` 同样返回 null → 维持原判），
 * 至少不会因为一次「彻底删桶」就被误判成永久失效。
 * 真要对它们生效，正确做法是**回填 `bucket`**（见 `links.json` 的迁移），
 * 而不是靠一条不成立的自愈论证去猜。
 *
 * @returns {number} 本次新标记的数量
 */
function markMissingByBucket(bucket) {
  if (!bucket) return 0;
  const now = new Date().toISOString();
  let n = 0;
  for (const l of load().links) {
    if (l.missingAt) continue;
    // R9-07：严格口径 —— 无 bucket 的历史链接**跳过**（理由见函数头注释）。
    // 注意不能写成 `l.bucket && l.bucket !== bucket`：那正是被否掉的宽松口径。
    if (l.bucket !== bucket) continue;
    l.missingAt = now;
    n += 1;
  }
  if (n) persist();
  return n;
}

/* ------------------------- 校验 / 计数 ------------------------- */

/** 校验分享密码（SEC-05：async） */
async function checkPassword(l, pw) {
  if (!l.passwordHash) return true;
  try {
    const h = Buffer.from(await hashPassword(pw, l.passwordSalt), 'hex');
    const t = Buffer.from(l.passwordHash, 'hex');
    return h.length === t.length && crypto.timingSafeEqual(h, t);
  } catch (e) {
    return false;
  }
}

/**
 * 原子地占用一次下载名额（先计数后传输，保证并发下不超限）
 * Node 单线程下，tryAcquire / release 的临界区全程为同步 JS 代码（get + 修改 + persist 都是同步），
 * 不会在执行中途被其他请求切换；故读-改-写天然原子，不会出现 maxDownloads 被突破。
 * 此注释专门回应 Claude 安全建议 #7。
 */
function tryAcquire(id) {
  const l = get(id);
  if (!l) return { ok: false, reason: 'notfound' };
  const st = status(l);
  if (st !== 'active') return { ok: false, reason: st, link: l };
  l.downloads = Number(l.downloads) + 1;
  l.lastDownloadAt = new Date().toISOString();
  persist();
  return { ok: true, link: l };
}

/** 回滚一次下载计数（下载启动前失败时调用，如云端对象已不存在） */
function release(id) {
  const l = get(id);
  if (!l || Number(l.downloads) <= 0) return;
  l.downloads = Number(l.downloads) - 1;
  persist();
}

/* ------------------------- 密码通过后的访问令牌（Cookie） ------------------------- */

/** 主密钥统一由 config-store 持有（S4：复用同一 data/secret.key，原子写入） */
function masterKey() {
  return configStore.getMasterKey();
}

/**
 * 密码通过后的访问令牌。
 *
 * SEC-10：令牌必须**与当前密码哈希绑定**，而不是只与链接 id 绑定。
 * 旧实现是 `HMAC(key, 'share-pass:' + id)` —— 无过期时间、且**改密码/清密码后仍然有效**，
 * 于是"修改分享密码"这一动作无法撤回已获授权的访问者（安全语义不符）。
 * 现在把 passwordHash 纳入签名输入：改密码 → 令牌自然失效，旧 Cookie 立即失效。
 * 使用 HMAC 而非明文比较，故哈希本身不会泄露给客户端。
 */
function accessToken(link) {
  const l = typeof link === 'string' ? get(link) : link;
  const id = (l && l.id) || String(link || '');
  const bind = (l && l.passwordHash) || 'no-pass';
  return crypto.createHmac('sha256', masterKey()).update('share-pass:' + id + '|' + bind).digest('hex');
}

function verifyToken(link, token) {
  if (typeof token !== 'string' || token.length !== 64) return false;
  const expected = accessToken(link);
  try {
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  } catch (e) {
    return false;
  }
}

module.exports = {
  list, listFor, canManage, get, create, update, remove, status, view,
  checkPassword, tryAcquire, release, accessToken, verifyToken,
  markMissing, clearMissing, markMissingByKeys, markMissingByBucket,
};
