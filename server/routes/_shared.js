/**
 * 路由层共享工具与中间件
 *
 * 原本散落在 routes.js 顶部与各处（共 2000+ 行单文件），拆分后集中于此，
 * 供各领域子路由复用。**行为与原实现完全一致**，仅搬移位置。
 */
const crypto = require('crypto');
const { providers, security, configStore, statsStore, encStore, cos } = require('./_context');
const { getClient, providerOf, p, translateError, listAll, badRequest } = require('../cos');

exports = module.exports = {};

/* ============================ 文件类型 / 路径 ============================ */

const TYPE_EXT = {
  image: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'ico', 'tif', 'tiff', 'heic'],
  video: ['mp4', 'avi', 'mkv', 'mov', 'wmv', 'flv', 'm4v', 'webm', 'ts', '3gp', 'mpg', 'mpeg'],
  audio: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'ape'],
  doc: ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pdf', 'txt', 'md', 'csv', 'json', 'html', 'htm', 'xml', 'epub'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso', 'jar', 'apk'],
};

function typeOf(key) {
  const ext = key.includes('.') ? key.split('.').pop().toLowerCase() : '';
  for (const [t, list] of Object.entries(TYPE_EXT)) if (list.includes(ext)) return t;
  return 'other';
}

function baseName(key) {
  const k = key.endsWith('/') ? key.slice(0, -1) : key;
  const i = k.lastIndexOf('/');
  return i >= 0 ? k.slice(i + 1) : k;
}

/**
 * 父目录前缀（以 '/' 结尾；根目录返回 ''）
 *
 * ⚠️ **必须先剥掉尾斜杠**：目录 key 形如 `dir/`，直接 `lastIndexOf('/')`
 * 会命中它自己末尾的那个斜杠，于是 `parentOf('dir/') === 'dir/'` ——
 * 与 `baseName`（它正确剥了尾斜杠）语义不一致。
 *
 * 这个不一致让「重命名文件夹」成为必失败路径：
 *   newKey = parentOf('dir/') + '新名/' = 'dir/新名/'
 *   随后 `newKey.startsWith(key)` 恒成立 → 一律被判为「重命名为自身或子路径」而拒绝。
 * 即：**任何文件夹都无法重命名**，且报错信息完全指向别的方向，极难排查。
 */
function parentOf(key) {
  const k = key.endsWith('/') ? key.slice(0, -1) : key;
  const i = k.lastIndexOf('/');
  return i >= 0 ? k.slice(0, i + 1) : '';
}

/* ============================ 角色 / 可见性 ============================ */

/** 获取客户端 IP 的角色（admin 返回 'admin'，否则视为普通用户） */
function roleOf(req) {
  return (req.authUser && req.authUser.role) || 'user';
}

/** 按当前登录角色列出桶（普通用户仅见 visibleToUsers 桶） */
function bucketsFor(req) {
  return configStore.listBucketsFor(roleOf(req));
}

/** 按当前登录角色列出密钥（普通用户仅见 visibleToUsers 密钥） */
function credentialsFor(req) {
  return configStore.listCredentialsFor(roleOf(req));
}

/* ============================ 中间件 ============================ */

/**
 * 仅管理员可访问；非管理员一律 403（前端隐藏入口只是第一层，接口层强制校验）
 *  — 安全要求：所有涉及全局配置 / 密钥 / 明文密码 / 规则的接口都必须挂载本中间件。
 */
function requireAdmin(req, res, next) {
  const u = req.authUser;
  if (!u || u.role !== 'admin') {
    return res.status(403).json({ error: '仅管理员可执行该操作' });
  }
  next();
}

/* ============================ 配置前置条件 ============================ */

/** 获取配置（未配置时抛出 428） */
function requireConfig() {
  const cfg = configStore.get();
  if (!cfg || !cfg.secretId || !cfg.secretKey) {
    const e = new Error('尚未配置对象存储访问密钥，请先在“设置”中完成配置');
    e.status = 428;
    throw e;
  }
  if (!cfg.bucket || !cfg.region) {
    const e = new Error('尚未选择存储桶，请先在“设置”中选择存储桶');
    e.status = 428;
    throw e;
  }
  return cfg;
}

/** 密钥格式校验：仅腾讯云 SecretId 有 AKID 前缀约定，其他服务商不做前缀限制 */
function validateCredentialFormat(provider, secretId) {
  const pid = providers.get(provider) ? provider : providers.DEFAULT_PROVIDER_ID;
  if (providers.isCos(pid) && !/^AKID[\w-]+$/.test(secretId)) {
    return '访问密钥 ID 格式不正确（腾讯云的 SecretId 应以 AKID 开头）';
  }
  return '';
}

/* ============================ 会话 Cookie ============================ */

/**
 * 会话 Cookie（部署模式 HOST≠回环时附加 Secure，仅经 HTTPS 传输）
 *
 * Max-Age 取自会话自身的剩余有效期（见 authSession.sessionTtl），而不是写死常量：
 * 「记住登录状态」是 30 天、普通登录是 24 小时，两者下发的 Cookie 必须分别对应，
 * 否则浏览器会先于服务端丢弃 Cookie，勾选不生效。
 *
 * @param {string} token
 * @param {number} [ttlMs] 剩余有效期（毫秒）；缺省时按会话查询，查不到则退回默认 TTL
 */
function sessionCookie(token, ttlMs) {
  const authSession = require('../auth-session');
  let ms = Number(ttlMs);
  if (!Number.isFinite(ms) || ms <= 0) ms = authSession.sessionTtl(token) || authSession.SESSION_TTL_MS;
  return authSession.COOKIE_NAME + '=' + encodeURIComponent(token) +
    '; Path=/; HttpOnly; SameSite=Lax' + security.secureCookieAttr() +
    '; Max-Age=' + Math.floor(ms / 1000);
}

/** 清除会话 Cookie（属性需与下发时一致，否则浏览器不会覆盖） */
function clearCookie() {
  const authSession = require('../auth-session');
  return authSession.COOKIE_NAME + '=; Path=/; HttpOnly; SameSite=Lax' +
    security.secureCookieAttr() + '; Max-Age=0';
}

/* ============================ Windows Hello（WebAuthn）上下文 ============================ */

/**
 * 从 Host 头分离出「主机名」与「端口」。
 *
 * 必须正确处理三种形态，否则 rpId 会带上端口（WebAuthn 规范严禁）：
 *   example.com:3443   → { hostname: 'example.com',        port: '3443' }
 *   example.com        → { hostname: 'example.com',        port: '' }
 *   127.0.0.1:3000     → { hostname: '127.0.0.1',          port: '3000' }
 *   [::1]:3000         → { hostname: '[::1]',              port: '3000' }
 *   [::1]              → { hostname: '[::1]',              port: '' }
 */
function splitHostPort(hostHeader) {
  const raw = String(hostHeader || '').trim();
  if (!raw) return { hostname: '', port: '' };
  if (raw.startsWith('[')) {
    // IPv6 字面量：方括号内的内容才是主机名（浏览器把 ::1 的 rpId 视为 [::1] 的规范形式）
    const end = raw.indexOf(']');
    if (end < 0) return { hostname: raw, port: '' };
    const hostname = raw.slice(0, end + 1);
    const rest = raw.slice(end + 1);
    return { hostname, port: rest.startsWith(':') ? rest.slice(1) : '' };
  }
  const i = raw.lastIndexOf(':');
  // 无冒号 → 无端口；有多个冒号说明是未加括号的 IPv6（不合法的 Host 写法），整体当主机名
  if (i < 0 || raw.indexOf(':') !== i) return { hostname: raw, port: '' };
  return { hostname: raw.slice(0, i), port: raw.slice(i + 1) };
}

/**
 * 推导 WebAuthn 的 rpId 与 origin —— 两者必须与浏览器实际访问的地址严格一致，
 * 否则客户端会因 `SecurityError`（rpId 不匹配）直接拒绝调用 Windows Hello。
 *
 *  ⚠️ 关键约束：**rpId 必须是有效域（裸主机名），绝不能带端口或协议**。
 *     若把 `127.0.0.1:3000` 当作 rpId，浏览器会拒绝调用（非法的 RP ID），
 *     且认证器对 rpIdHash 的计算也会与预期不符。因此这里必须剥离端口。
 *  - rpId：Host 头的主机名部分（不含端口）。用 IP 访问时 IP 本身就是 rpId，
 *          浏览器允许 http://127.0.0.1 下的 WebAuthn（安全上下文例外）。
 *  - origin：协议 + 主机 + 端口（**必须保留端口**，否则 origin 校验会失败）。
 *          协议按"实际连接是否加密"判定：req.secure 为真（HTTPS）或部署模式
 *          且信任代理（X-Forwarded-Proto: https）→ https。
 *
 * 说明：本系统默认在 127.0.0.1 上以 HTTP 运行，而 127.0.0.1 / localhost 属于
 * 浏览器认定的安全上下文，因此 Windows Hello 在本地明文 HTTP 下亦可正常工作。
 */
function webauthnContext(req) {
  const { hostname, port } = splitHostPort(req.headers.host);
  const rpId = hostname || '127.0.0.1';
  const proto = (req.secure || (security.IS_DEPLOY && security.TRUST_PROXY)) ? 'https' : 'http';
  // 重建 host 串：IPv6 已带方括号，直接拼端口即可
  const hostWithPort = port ? rpId + ':' + port : rpId;
  return {
    rpId,
    rpName: '对象存储管理系统',
    origin: proto + '://' + hostWithPort,
  };
}

/* ============================ 本地桶解析 / 统计 ============================ */

// 依据 id 查找本地桶记录
function requireLocalBucket(id) {
  const { buckets } = configStore.listBuckets();
  const b = buckets.find((x) => x.id === id);
  if (!b) { const e = new Error('存储桶不存在或已从列表移除'); e.status = 404; throw e; }
  return b;
}

// 为指定桶解析客户端（桶可能未关联可用密钥）
function bucketClient(b) {
  const cfg = configStore.effectiveForBucket(b.bucket, b.region);
  const provider = (cfg && cfg.provider) || providers.DEFAULT_PROVIDER_ID;
  const needRegion = (providers.get(provider) || {}).regionRequired !== false;
  if (!cfg || !cfg.secretId || !cfg.secretKey || (needRegion && !cfg.region)) {
    const e = new Error('该存储桶没有可用的访问密钥或地域信息，请先在“系统设置”中配置密钥');
    e.status = 428; throw e;
  }
  return { cfg, cos: getClient(cfg) };
}

// 安全确认：用户必须手动输入完整桶名且完全一致
function requireNameConfirm(body, bucket) {
  const v = String((body || {}).nameConfirm || '');
  if (v !== bucket) throw badRequest('确认失败：输入的名称与存储桶完整名称不一致，操作已取消');
}

/**
 * 桶相关缓存的唯一键：多云下不同厂商/不同密钥可能绑定**同名桶**，
 * 若仅以桶名作键会互相覆盖（A 厂商的容量显示成 B 厂商的数字）。故并入 provider 与凭据。
 */
function bucketCacheKey(cfg) {
  return [providerOf(cfg), cfg.secretId || '', cfg.bucket || '', cfg.region || ''].join('|');
}

// 桶容量缓存（与原实现共用同一份状态）
const bucketSizeCache = new Map(); // cacheKey -> { t, sizeBytes, objectCount, estimated }
const BUCKET_STAT_CACHE_MS = 15 * 60 * 1000;
/** FUN-12：缓存条目上限。密钥轮换 / 多桶会持续产生新 key，无上限即缓慢泄漏 */
const BUCKET_STAT_CACHE_MAX = 200;

/**
 * 写入前顺带清掉过期项；仍超限则淘汰最早的（Map 保持插入顺序）。
 * 旧实现只判 TTL 从不删除 —— 条目只增不减，长时间运行就是一条单调上升的内存曲线。
 */
function pruneBucketSizeCache() {
  const now = Date.now();
  for (const [k, v] of bucketSizeCache) {
    if (now - v.t > BUCKET_STAT_CACHE_MS) bucketSizeCache.delete(k);
  }
  while (bucketSizeCache.size >= BUCKET_STAT_CACHE_MAX) {
    const oldest = bucketSizeCache.keys().next();
    if (oldest.done) break;
    bucketSizeCache.delete(oldest.value);
  }
}

/** 调用腾讯云 COS ?stats 接口获取官方容量；返回 { sizeBytes, objectCount } 或 null（失败/不支持） */
async function getBucketStatViaApi(client, cfg) {
  if (!providers.isCos(providerOf(cfg.provider))) return null;
  try {
    const data = await p(client, 'request', { Method: 'GET', Bucket: cfg.bucket, Region: cfg.region, action: 'stats' }, { noStat: true });
    const body = data && (data.Body || data.body);
    if (typeof body === 'string') {
      const sizeM = body.match(/<Size>([^<]+)<\/Size>/);
      const objM = body.match(/<ObjectNumber>([^<]+)<\/ObjectNumber>/);
      if (sizeM || objM) return { sizeBytes: sizeM ? Number(sizeM[1]) : 0, objectCount: objM ? Number(objM[1]) : 0 };
    } else if (body && typeof body === 'object') {
      return { sizeBytes: Number(body.Size) || 0, objectCount: Number(body.ObjectNumber) || 0 };
    }
    return null;
  } catch (e) {
    return null; // 失败由调用方回退
  }
}

async function bucketStat(client, cfg) {
  const key = bucketCacheKey(cfg);
  const c = bucketSizeCache.get(key);
  if (c && Date.now() - c.t < BUCKET_STAT_CACHE_MS) return c;
  pruneBucketSizeCache(); // FUN-12：写之前清理，避免条目无限堆积

  // P3：优先官方 ?stats 接口（单次 API 调用，无分页扫全桶）
  const official = await getBucketStatViaApi(client, cfg);
  if (official) {
    const out = {
      sizeBytes: official.sizeBytes,
      objectCount: official.objectCount,
      estimated: false,
      source: 'GetBucketStat',
      t: Date.now(),
    };
    bucketSizeCache.set(key, out);
    return out;
  }

  // 回退：分页列出对象累计（最多扫描 5000 个，超出为估算值）
  const items = await listAll(client, cfg, '', { cap: 5001 });
  const out = {
    sizeBytes: items.reduce((s, x) => s + (x.size || 0), 0),
    objectCount: items.length,
    estimated: items.length >= 5001,
    source: 'ListScan',
    t: Date.now(),
  };
  bucketSizeCache.set(key, out);
  return out;
}

/* ---------------- 分片列举短缓存（PERF-01） ---------------- */

/**
 * 分片列表是**整桶翻页扫描**：`/buckets/stats` 对 N 个桶各扫一遍、
 * 彻底删除前检查再扫一遍、碎片页自己又扫一遍，而它在这几处几乎同时被请求。
 * 桶里没碎片时也要付满一次 `multipartList` 往返 —— 纯粹的白白消耗。
 *
 * 与目录列举缓存同理：只用于加速重复刷新，**不作为真值来源**：
 *  - TTL 30 秒，进程内，重启即空；
 *  - 任何分片类写操作（init / upload / complete / abort）立即失效该桶；
 *  - `FRAGMENT_CACHE_TTL_MS=0` 可整体关闭。
 */
const DEFAULT_FRAGMENT_TTL_MS = 30 * 1000;
/**
 * R8-21：条目上限。
 *
 * 这张表是全库**唯一**没有容量上限、也没有清扫的进程级缓存：键是
 * `'frag:' + provider|secretId|bucket|region`，值是该桶的**完整碎片数组**（可达数 MB），
 * 而唯一的删除时机是「**同一个键**再被读到且已过期」与「按桶失效」。
 * 于是密钥轮换 / 编辑（换成新 secretId）、桶解绑或改名都会产生**永不释放的旧键**，
 * 随使用时长单调上升。项目里其余同型缓存（list-cache、bucketSizeCache、
 * overseasCache、existsProbe、statusQueryAt、FAILS_MAX）都已收敛 —— 只有它漏了。
 */
const FRAGMENT_CACHE_MAX = 200;
const fragmentCache = new Map(); // cacheKey -> { at, bucket, value }

function fragmentTtlMs() {
  const raw = process.env.FRAGMENT_CACHE_TTL_MS;
  if (raw === undefined || raw === '') return DEFAULT_FRAGMENT_TTL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_FRAGMENT_TTL_MS;
}

/** 失效某桶的分片缓存；@returns {number} 被清除条目数 */
function invalidateFragmentCache(bucket) {
  if (!bucket) return 0;
  let n = 0;
  for (const [k, e] of fragmentCache) {
    if (e.bucket === bucket) { fragmentCache.delete(k); n += 1; }
  }
  return n;
}

/**
 * R8-21：清扫过期条目 + 硬上限兜底（与 list-cache / bucketSizeCache 同一纪律）。
 * 过期条目在保留窗口内永远不会再被读到，留着纯属占用内存。
 * @returns {number} 被清除的过期条目数
 */
function sweepFragmentCache(now = Date.now()) {
  const ttl = fragmentTtlMs();
  let n = 0;
  for (const [k, e] of fragmentCache) {
    if (now - e.at > ttl) { fragmentCache.delete(k); n += 1; }
  }
  // 仍有超限：淘汰最早插入的（Map 保持插入顺序）
  while (fragmentCache.size > FRAGMENT_CACHE_MAX) {
    const oldest = fragmentCache.keys().next();
    if (oldest.done) break;
    fragmentCache.delete(oldest.value);
  }
  return n;
}

// 咽喉点订阅：分片类写操作一律失效。multipartList / multipartListPart 是读方法，
// 不会触发 noteCall，因此这里无需再排除。
require('../list-cache').onMutate((method, params) => {
  if (typeof method === 'string' && method.indexOf('multipart') === 0) {
    invalidateFragmentCache(params && params.Bucket);
  }
});

// 列出全部未完成的分片上传任务（文件碎片），自动翻页（PERF-01：带短缓存）
async function listFragments(client, cfg, { noStat = false } = {}) {
  const ttl = fragmentTtlMs();
  const ckey = ttl > 0 ? 'frag:' + bucketCacheKey(cfg) : '';
  if (ckey) {
    const hit = fragmentCache.get(ckey);
    if (hit && Date.now() - hit.at <= ttl) return hit.value;
    if (hit) fragmentCache.delete(ckey);
  }
  const value = await listFragmentsNoCache(client, cfg, { noStat });
  if (ckey) {
    sweepFragmentCache(); // R8-21：写入前先清扫 + 兜住硬上限
    fragmentCache.set(ckey, { at: Date.now(), bucket: cfg.bucket, value });
  }
  return value;
}

async function listFragmentsNoCache(client, cfg, { noStat = false } = {}) {
  const uploads = [];
  let marker = {};
  let guard = 0;
  do {
    const data = await p(client, 'multipartList', Object.assign(
      { Bucket: cfg.bucket, Region: cfg.region, MaxUploads: 1000 }, marker
    ), { noStat });
    const r = (data && (data.ListUploadsResult || data)) || {};
    const list = Array.isArray(r.Upload) ? r.Upload : (r.Upload ? [r.Upload] : []);
    uploads.push(...list);
    if (guard++ > 2000) break; // 防御：分页异常时强制退出
    if (String(r.IsTruncated || '').toLowerCase() === 'true') {
      marker = { KeyMarker: r.NextKeyMarker || '', UploadIdMarker: r.NextUploadIdMarker || '' };
    } else marker = null;
  } while (marker);
  return uploads.map((u) => ({
    key: u.Key, uploadId: u.UploadId,
    initiated: u.Initiated || '',
    storageClass: u.StorageClass || '',
  }));
}

/** 带并发上限的并行映射（P3：多桶统计并行，但限制并发避免触发 COS 限流） */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = [];
  for (let w = 0; w < Math.min(limit, items.length); w++) {
    workers.push((async () => {
      while (cursor < items.length) {
        const idx = cursor++;
        out[idx] = await fn(items[idx], idx);
      }
    })());
  }
  await Promise.all(workers);
  return out;
}

/* ============================ 上传排除 ============================ */

/** 检查 key 是否命中基础排除规则（.DS_Store / Thumbs.db），命中返回文件名，否则 null */
function checkBasenameExcluded(key) {
  const ex = configStore.getUploadExcludes();
  if (!ex) return null;
  const base = baseName(key);
  if (ex.dsStore && base === '.DS_Store') return '.DS_Store';
  if (ex.thumbsDb && base.toLowerCase() === 'thumbs.db') return 'Thumbs.db';
  return null;
}

/** 服务端兜底：校验上传 key 是否被排除规则命中（命中抛出 403） */
function assertNotExcluded(key, gitignoreText, gitignoreRel) {
  const gitignore = require('../gitignore');
  const hit = checkBasenameExcluded(key);
  if (hit) {
    const e = new Error(`文件 ${hit} 已被系统设置中的「上传排除」规则过滤，已跳过`);
    e.status = 403; throw e;
  }
  const ex = configStore.getUploadExcludes();
  if (ex && ex.gitignore && gitignoreText && gitignoreRel) {
    // SEC-04：gitignoreText 来自客户端，匹配必须走**线性匹配器**（见 gitignore.js）。
    // 这里额外对超限截断做显式告警 —— 截断会让"本该被忽略的文件被上传"，
    // 静默截断会极难排查。
    const m = cachedGitignoreMatcher(gitignoreText);
    if (m.truncated && !m.__truncWarned) {
      // R8-27：同一次上传的 N 个文件会拿到同一个（缓存下来的）matcher，
      // 因此这个告警每个内容版本只出一次 —— 否则 2000 个文件就是 2000 条一模一样的日志。
      m.__truncWarned = true;
      statsStore.addLog({
        action: 'upload.excludes', level: 'warn',
        detail: `客户端 .gitignore 超出解析上限（${gitignore.MAX_TEXT} 字节 / ${gitignore.MAX_RULES} 条），已截断匹配；超过部分不参与排除判定`,
      });
    }
    if (m.isIgnored(String(gitignoreRel).replace(/\\/g, '/'))) {
      const e = new Error(`文件 ${key} 匹配项目 .gitignore 排除规则，已跳过`);
      e.status = 403; throw e;
    }
  }
}

/**
 * R8-27：`.gitignore` 匹配器的进程级 LRU 缓存。
 *
 * 前端把整份 `.gitignore` **随每个文件**一起发上来（直传路径还把它塞进 URL 查询串，
 * 2000 个文件 ≈ 110MB 额外请求体），而服务端每次都从零编译一遍。实测
 * `createMatcher`：50 规则 0.38ms、200 规则 0.61ms、500 规则 2.57ms —— 2000 个文件的
 * 目录上传 = 2000 次解析（累计约 5 秒**同步** CPU，且 2 路并发让这些 2.6ms 的长任务
 * 密集落在单线程事件循环上，表现为整站卡顿）。
 *
 * `createMatcher` 是纯函数，内容不变则结果必然不变，因此按**内容哈希**缓存即可。
 * 上限 8 条：同一时刻活跃的项目通常只有一两个，留点余量覆盖"用户来回切目录"。
 */
const GITIGNORE_CACHE_MAX = 8;
const gitignoreCache = new Map(); // sha1(全文) -> matcher

function cachedGitignoreMatcher(text) {
  const src = String(text || '');
  const key = crypto.createHash('sha1').update(src, 'utf8').digest('hex');
  const hit = gitignoreCache.get(key);
  if (hit) {
    // LRU：命中即移到队尾（Map 保持插入顺序）
    gitignoreCache.delete(key);
    gitignoreCache.set(key, hit);
    return hit;
  }
  const m = gitignore.createMatcher(src);
  gitignoreCache.set(key, m);
  while (gitignoreCache.size > GITIGNORE_CACHE_MAX) {
    const oldest = gitignoreCache.keys().next();
    if (oldest.done) break;
    gitignoreCache.delete(oldest.value);
  }
  return m;
}

/* ============================ 统一错误响应 ============================ */

/**
 * 标准错误响应：把 throw 出来的错误翻译为 { status, message } 后回写。
 * 保留各路由原有的 e.status 优先（业务错误）→ translateError 兜底（SDK 错误）语义。
 */
function sendError(res, e, fallbackStatus = 500) {
  const err = e && e.status ? e : translateError(e);
  if (!res.headersSent) res.status(err.status || fallbackStatus).json({ error: err.message });
  else res.destroy();
  return err;
}

Object.assign(module.exports, {
  typeOf, baseName, parentOf,
  roleOf, bucketsFor, credentialsFor,
  requireAdmin, requireConfig, validateCredentialFormat,
  sessionCookie, clearCookie,
  webauthnContext, splitHostPort,
  requireLocalBucket, bucketClient, requireNameConfirm,
  bucketCacheKey, bucketSizeCache, BUCKET_STAT_CACHE_MS, getBucketStatViaApi, bucketStat,
  listFragments, listFragmentsNoCache, invalidateFragmentCache, mapLimit,
  FRAGMENT_CACHE_MAX, DEFAULT_FRAGMENT_TTL_MS, sweepFragmentCache,
  checkBasenameExcluded, assertNotExcluded,
  sendError,
});
