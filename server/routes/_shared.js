/**
 * 路由层共享工具与中间件
 *
 * 原本散落在 routes.js 顶部与各处（共 2000+ 行单文件），拆分后集中于此，
 * 供各领域子路由复用。**行为与原实现完全一致**，仅搬移位置。
 */
const crypto = require('crypto');
const { providers, security, configStore, statsStore, encStore, cos, gitignore } = require('./_context');
/**
 * R25：`gitignore` 必须在**模块作用域**可见 —— `cachedGitignoreMatcher()` 里用了
 * `gitignore.createMatcher()`，而此前唯一一处 `require('../gitignore')` 是
 * `assertNotExcluded()` 内的**局部** const，对另一个函数不可见。
 *
 * 于是「上传排除 → .gitignore 排除」一旦开启且客户端带了 `.gitignore`，走到
 * `cachedGitignoreMatcher()` 就抛 `ReferenceError: gitignore is not defined`；
 * 因为没有测试真的**跑**这条路径（`audit3` 只做静态正则断言），该缺陷长期无人发现
 * （eslint 的 `no-undef` 一直报，但 lint 未纳入门禁）。
 * 现在统一由 `_context`（它本就导出 `gitignore`）提供，`gitignore.MAX_TEXT` 等
 * 常量与 `createMatcher` 同源。
 */
const { p, translateError, badRequest } = require('../cos');
/**
 * R25：桶容量的「键 / 缓存 / 取值 / 客户端解析 / 并发映射」唯一定义点已下沉到
 * `server/bucket-stats.js`（根级模块，不依赖 routes）。原因见该文件头：WebDAV 独立
 * 实例也要判配额，而 `webdav-server → routes/_shared → _context → webdav-server`
 * 会构成循环依赖。此处转出，既有调用方与 `shared.bucketStat` 等测试钩子无感。
 */
const {
  bucketCacheKey, bucketSizeCache, BUCKET_STAT_CACHE_MS, getBucketStatViaApi, bucketStat,
  resolveBucketClient, mapLimit,
  QUOTA_EXCEEDED_CODE, assertCredentialQuota, credentialUsage, recordUsageDelta,
  // R28-02：单桶配额（与凭据级配额并列的两个层级）
  BUCKET_QUOTA_EXCEEDED_CODE, assertBucketQuota,
} = require('../bucket-stats');

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

/**
 * R17-04：把 `async` 处理器的 rejection 交回统一错误中间件。
 *
 * Express 4（本项目 `express@^4.19.2`）**不会**捕获 async handler 抛出的错误 ——
 * 它只认 `next(err)`。于是 `router.get('/x', async (req, res) => { throw ... })`
 * 一旦抛错，请求既不会 500 也不会结束，症状是**客户端一直转圈**，比 500 难排查得多
 * （`process.on('unhandledRejection')` 只 `console.error`，不产生响应）。
 *
 * 用法（只包住 handlers 列表的最后一个函数）：
 *
 *   router.post('/x', asyncHandler(async (req, res) => { ... }));
 *
 * 同步 URL 层中间件（`requireAdmin` 等）**不要**包 —— 它们本就该调用 `next`。
 * 下标不会被改变：包装后的函数仍是 `(req, res, next)` 三参签名。
 *
 * @param {(req, res, next) => any} fn
 * @returns {(req, res, next) => void}
 */
function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * R23-04：**路由层「async 处理器 + 标准错误响应」的唯一实现点**。
 *
 * 背景：`asyncHandler` 只解决了「抛错不会让请求永久挂起」，它把错误交给
 * `server/index.js` 的全局错误中间件，而那里直接用 `err.message` —— **不跑
 * `translateError()`**。于是每个路由自己写一份
 *
 * ```js
 * } catch (e) {
 *   const err = e.status ? e : translateError(e);
 *   res.status(err.status || 500).json({ error: err.message });
 * }
 * ```
 *
 * 全库 11 份逐字重复（另有 8 份在这两行之后追加一条 `statsStore.addLog`）。
 * 两份东西**不能**简单换成 `asyncHandler`：
 *
 *  ① `translateError()`（`server/cos.js`）把对象存储 / 网络的原始错误翻译成面向
 *     用户的分类文案；绕过它，用户看到的是 SDK 的英文原文；
 *  ② **R11-04 纪律**：上游 401 必须映射为 502。前端 `api.js` 见到 401 就强制登出，
 *     云端 401（密钥被拒）一旦透传，用户会被踢出登录并陷入「重新登录 → 再被踢」死循环。
 *
 * 因此把「翻译 + 401→502 + 落地」收进这一处，与全局错误中间件（只做兜底、不翻译）
 * 各司其职：路由里能落地的错误一律在这里落地，落到 `next(e)` 的只剩无法再回写的场景。
 *
 * 用法（只包住 handlers 列表的**最后一个**函数）：
 *
 *   router.get('/x', requireAdmin, apiHandler(async (req, res) => { ... }));
 *
 * 副作用（日志 / 审计）用第二参 `onError` 保留 —— 原 catch 里除响应之外的语句必须
 * 原样搬进去，**不许因为「收敛错误响应」而丢掉任何一条日志**：
 *
 *   router.post('/x', apiHandler(async (req, res) => { ... }, {
 *     onError: (err) => statsStore.addLog({ action: 'x', level: 'error', detail: err.message }),
 *   }));
 *
 * `onError` 只做副作用，**不得**写响应（响应由本函数统一落地）；它自己抛错会被吞掉，
 * 以免「记日志失败」掩盖真实错误。
 *
 * 同步 URL 层中间件（`requireAdmin` 等）**不要**包 —— 它们本就该调用 `next`。
 * 包装后的函数仍是 `(req, res, next)` 三参签名（Express 只按 `length` 区分错误中间件）。
 *
 * 为什么放在 `_shared.js`（而不是 `cos.js`）：本文件**早已** require `../cos`
 * （见文件头 `translateError` 的解构），加入本函数不新增任何依赖边；而 `cos.js`
 * 不 require 任何 routes（反向由 `routes.js` 单向发起），故不存在循环 require。
 *
 * @param {(req, res, next) => any} fn 处理器（通常是 `async` 函数）
 * @param {{onError?: (err: Error, req: object, res: object) => void}} [opts]
 *        `onError` 收到的是**已翻译**的错误（与落地响应里的同一个对象）
 * @returns {(req, res, next) => Promise<any>}
 */
function apiHandler(fn, opts) {
  const onError = opts && typeof opts.onError === 'function' ? opts.onError : null;
  return function wrapped(req, res, next) {
    return Promise.resolve(fn(req, res, next)).catch((e) => {
      // 与各路由原实现逐字同源的语义：业务错误（带 status）原样用，其余走翻译层
      const err = e && e.status ? e : translateError(e);
      if (onError) {
        try { onError(err, req, res); } catch (_) { /* 副作用自身失败不得改写原始错误 */ }
      }
      /**
       * 响应头已发出：再写就是 `ERR_HTTP_HEADERS_SENT`（在 catch 里抛错 = 请求永久挂起），
       * 因此交给全局错误中间件收尾（它会销毁套接字）。这条分支比旧的 `res.status(...)`
       * 更安全，且只在真正的流式/半写场景里生效。
       */
      if (res.headersSent) return next(e);
      return res.status(err.status || 500).json({ error: err.message });
    });
  };
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

/**
 * 密钥格式校验：仅腾讯云 SecretId 有 AKID 前缀约定，其他服务商不做前缀限制。
 * R30：Azure 例外 —— 它的 `secretId` 是**存储账户名**，会被拼进主机名，
 * 因此必须当场收敛字符集（否则一个 `evil.com/x` 就能把出站请求引向任意主机）。
 */
function validateCredentialFormat(provider, secretId) {
  const pid = providers.get(provider) ? provider : providers.DEFAULT_PROVIDER_ID;
  if (providers.isCos(pid) && !/^AKID[\w-]+$/.test(secretId)) {
    return '访问密钥 ID 格式不正确（腾讯云的 SecretId 应以 AKID 开头）';
  }
  if (providers.accountEndpointTemplate(pid) && !providers.isValidAccount(pid, secretId)) {
    return `${providers.nameOf(pid)} 的${providers.resolve(pid).credentialLabel.id}格式不正确`
      + '（3–24 位小写字母或数字，例如 myaccount）';
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
  const proto = security.requestIsSecure(req) ? 'https' : 'http'; // R27-03：唯一判据
  // 重建 host 串：IPv6 已带方括号，直接拼端口即可
  const hostWithPort = port ? rpId + ':' + port : rpId;
  /**
   * R24-02：**部署模式下 rpId 必须属于本站**（配置的主 / 备域名，或本机 HOST），
   * 回环主机名单独放行。旧实现无条件按请求 Host 推导 rpId / origin ——
   * WebAuthn 的核心属性是「凭据绑定**固定**的 RP」：服务端一旦接受任意 Host 作为
   * rpId，把域名解析到同一 IP 的钓鱼站就能完整代理「注册 + 登录」两步（服务端会以
   * `attacker.com` 作为 rpId 签发挑战并接受断言），防钓鱼属性被整条抵消。
   *
   * 判据复用 `isOwnSiteHost`（与支付站点地址、HTTPS 跳转目标**同一处**判据）。
   * 不可信时**直接抛错**（fail-closed），而不是退回按 Host 推导 —— 后者等于没修。
   *
   * 为什么放行回环：`Host: 127.0.0.1` 只可能来自访问本机的浏览器（远端攻击者无法让
   * 受害者的浏览器把远端站点写成回环地址），且 WebAuthn 依赖「回环属安全上下文」这
   * 一例外；本机（非部署）模式因此完全不受影响。
   *
   * R38-01：这条 fail-closed 判据本身没错，**错在它的允许集此前是空的** —— `deploy.sh`
   * 生成的运行环境写的是 `HOST=0.0.0.0`（通配绑定地址，永远不可能出现在 Host 头里），
   * 真实域名只进了 nginx 的 `server_name`，应用无从得知。于是**用真实域名访问本站**也会
   * 走到下面这个 403：用户看到「不是本站域名」，可它明明就是本站。修法不是放宽本判据
   * （那会撤掉 R24-02 的防钓鱼），而是给 `isOwnSiteHost()` 补上权威来源
   * `SITE_DOMAIN`（部署脚本写入）。文案同步补上可执行动作。
   */
  if (security.IS_DEPLOY && !security.isOwnSiteHost(rpId, []) && !isLoopbackHostname(rpId)) {
    const e = new Error('当前访问地址不是本站域名，Windows Hello 仅能在本站域名下使用；'
      + '请改用配置的站点域名访问（docker / systemd 部署请确认 SITE_DOMAIN 或 HOST '
      + '与浏览器地址栏完全一致），或用密码登录');
    e.status = 403;
    e.webauthnUntrusted = true;
    throw e;
  }
  return {
    rpId,
    rpName: '对象存储管理系统',
    origin: proto + '://' + hostWithPort,
  };
}

/**
 * 回环主机名（含 `localhost` 与其子域）。
 *
 * R24-02 用它把「本机访问」从「外站 Host」里摘出来：回环地址不可能被远端攻击者
 * 写进受害者浏览器的 Host 头，故不构成钓鱼面。
 */
function isLoopbackHostname(h) {
  const s = String(h || '').trim().toLowerCase();
  return s === 'localhost' || s.endsWith('.localhost')
    || s === '127.0.0.1' || s === '::1' || s === '[::1]';
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
// R25：「解析」的唯一实现点是 `bucket-stats.resolveBucketClient`（返回 null 的宽容语义，
// 供按 API Key 的用量统计跳过个别缺配置的桶）；这里只在其上加一层「失败即抛 428」。
function bucketClient(b) {
  const r = resolveBucketClient(b);
  if (!r) {
    const e = new Error('该存储桶没有可用的访问密钥或地域信息，请先在“系统设置”中配置密钥');
    e.status = 428; throw e;
  }
  return r;
}

// 安全确认：用户必须手动输入完整桶名且完全一致
function requireNameConfirm(body, bucket) {
  const v = String((body || {}).nameConfirm || '');
  if (v !== bucket) throw badRequest('确认失败：输入的名称与存储桶完整名称不一致，操作已取消');
}

/* 桶容量键 / 缓存 / 取值 / prune —— 自 R25 起唯一定义在 `server/bucket-stats.js`（本文件顶部已转出） */

/* -------------------------------- 分片列举短缓存（PERF-01） ---------------- */

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

/* `mapLimit` 自 R25 起唯一定义在 `server/bucket-stats.js`（本文件顶部已转出） */

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
 *
 * R23-04：**新代码不要再用它** —— 路由层的唯一实现点是 {@link apiHandler}
 * （把包装、翻译、落地、可选 onError 副作用放在一处）。本函数保留给
 * `webauthn.js` / `users.js` 那几处「catch 里只调它一行」的既有形态，
 * 二者语义同源（区别仅在 `headersSent` 时它是 `res.destroy()`、apiHandler 是 `next(e)`）。
 */
function sendError(res, e, fallbackStatus = 500) {
  const err = e && e.status ? e : translateError(e);
  if (!res.headersSent) res.status(err.status || fallbackStatus).json({ error: err.message });
  else res.destroy();
  return err;
}

/**
 * R25：统一错误响应体（**配额类错误带结构化明细**）。
 *
 * 在既有 `{ error: message }` 之上，把配额错误的机器可读码与明细一并下发
 * （`code` / `quota`）。前端 `api.js` 会把这些字段挂回抛出的错误对象，据此弹
 * 「超出配额」对话框 —— 只下发文案的话，前端无法把「配额超限」与其它 403
 * （如上传排除命中）区分开，只能对所有 403 一律弹同一个提示。
 *
 * 与 `apiHandler` 的关系：`apiHandler` 是「翻译 + 落地」的唯一实现点，但它固定下发
 * `{ error }`；配额闸门所在的少数路由在其 catch 里改用本函数**构造响应体**
 * （响应仍由路由自身 `res.status(...).json(...)` 落地），两者语义一致、互不冲突。
 */
function errorBody(err) {
  const out = { error: (err && err.message) ? err.message : String((err && err.toString()) || '') };
  if (err && err.code) out.code = err.code;
  if (err && err.quota) out.quota = err.quota;
  return out;
}

Object.assign(module.exports, {
  typeOf, baseName, parentOf,
  roleOf, bucketsFor, credentialsFor,
  requireAdmin, requireConfig, validateCredentialFormat,
  asyncHandler, apiHandler,
  sessionCookie, clearCookie,
  webauthnContext, splitHostPort,
  requireLocalBucket, bucketClient, requireNameConfirm,
  bucketCacheKey, bucketSizeCache, BUCKET_STAT_CACHE_MS, getBucketStatViaApi, bucketStat,
  listFragments, listFragmentsNoCache, invalidateFragmentCache, mapLimit,
  FRAGMENT_CACHE_MAX, DEFAULT_FRAGMENT_TTL_MS, sweepFragmentCache,
  checkBasenameExcluded, assertNotExcluded,
  sendError, errorBody,
  // R25：按 API Key 的配额（闸门 + 明细）
  QUOTA_EXCEEDED_CODE, assertCredentialQuota, credentialUsage, recordUsageDelta,
  // R28-02：按单个存储桶的配额（闸门 + 明细）
  BUCKET_QUOTA_EXCEEDED_CODE, assertBucketQuota,
});
