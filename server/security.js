/**
 * 安全加固模块 —— 部署模式判定 / CSRF 校验 / IP 级速率限制 / 失败锁定
 *
 * 设计原则：零新增依赖（仅用 Node 内置模块），内存态即可满足本机与小规模部署。
 *
 *  - 部署模式（HOST ≠ 回环）：强制仅 HTTPS 提供 API、会话 Cookie 带 Secure
 *  - CSRF：非安全方法（GET/HEAD/OPTIONS 之外）必须携带同源自定义头 X-Requested-With，
 *    浏览器跨域表单无法伪造自定义头，可阻断表单型 CSRF
 *  - 速率限制：滑动计数窗口（windowMs 内最多 max 次），按 IP（可拼接业务键）
 *  - 失败锁定：同一业务键连续失败达阈值后临时冻结，冻结时长按失败次数指数增长（有上限）
 */
const DEPLOY_HOST = String(process.env.HOST || '127.0.0.1');
const IS_LOOPBACK = DEPLOY_HOST === '127.0.0.1' || DEPLOY_HOST === 'localhost' || DEPLOY_HOST === '::1';
/** 是否部署模式（监听局域网/公网）：此时强制 HTTPS + Secure Cookie */
const IS_DEPLOY = !IS_LOOPBACK;

/**
 * 是否信任反向代理注入的 X-Forwarded-For 头（N1 修复）。
 * 仅当显式配置 TRUST_PROXY=1 时才信任；否则一律使用 socket 对端地址，
 * 杜绝直连场景下通过伪造 XFF 绕过限流/锁定。
 */
const TRUST_PROXY = String(process.env.TRUST_PROXY || '') === '1';

/** 会话 Cookie 的 Secure 属性（部署模式必须，避免明文 HTTP 泄露会话） */
function secureCookieAttr() {
  return IS_DEPLOY ? '; Secure' : '';
}

/**
 * 取客户端 IP（N1 修复）：
 *  - 默认（未配置可信代理）：直接使用 socket.remoteAddress，与 ip-guard.js 一致，不信任 XFF
 *  - TRUST_PROXY=1（部署在反向代理后）：信任 XFF 首段（最接近真实客户端的值）
 */
function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '');
  if (TRUST_PROXY && xf) {
    const first = xf.split(',')[0].trim();
    if (first) return first;
  }
  let ip = (req.socket && req.socket.remoteAddress) || req.ip || '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1') ip = '127.0.0.1'; // 统一回环表示，与 ip-guard 一致
  return ip;
}

/* ============================ CSRF ============================ */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF 校验：安全方法直接放行；其余方法要求 X-Requested-With: XMLHttpRequest。
 * 前端 api.js / xhrPut 已统一携带该头。
 */
function csrfGuard(req) {
  if (SAFE_METHODS.has(req.method)) return true;
  const h = String(req.get('x-requested-with') || '');
  return h.toLowerCase() === 'xmlhttprequest';
}

/* ============================ 速率限制 ============================ */

/**
 * 创建速率限制器（滑动计数窗口）
 * @param {object} opt { name, windowMs, max }
 * @returns {(key: string) => { ok: boolean, retryAfter: number }} retryAfter 单位为秒
 */
function createLimiter({ name = 'limit', windowMs = 60 * 1000, max = 10 }) {
  const hits = new Map(); // key -> { count, resetAt }
  let lastSweep = 0;

  function sweep(now) {
    if (now - lastSweep < windowMs) return;
    lastSweep = now;
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }

  return function check(key) {
    const now = Date.now();
    sweep(now);
    const k = String(key || '-');
    const rec = hits.get(k);
    if (!rec || rec.resetAt <= now) {
      hits.set(k, { count: 1, resetAt: now + windowMs });
      return { ok: true, retryAfter: 0 };
    }
    rec.count += 1;
    if (rec.count > max) {
      return { ok: false, retryAfter: Math.max(1, Math.ceil((rec.resetAt - now) / 1000)) };
    }
    return { ok: true, retryAfter: 0 };
  };
}

/** Express 中间件工厂：对指定 key 维度限流，超限返回 429 */
function limitMiddleware(limiter, keyFn) {
  return (req, res, next) => {
    const r = limiter(keyFn(req));
    if (r.ok) return next();
    res.setHeader('Retry-After', String(r.retryAfter));
    return res.status(429).json({ error: `操作过于频繁，请 ${r.retryAfter} 秒后重试` });
  };
}

/* ============================ 失败锁定 ============================ */

/**
 * RE-01：失败锁定表的硬上限。
 *
 * `sweep()` 受 windowMs 门控（每 windowMs 最多跑一遍），两次 sweep 之间
 * 匿名入口（登录按 IP+用户名、WebDAV 按 IP+用户名）仍可灌入任意多个新键 ——
 * 没有上限就是一条无界内存增长路径（FUN-12 同型）。达上限后按**插入顺序**
 * 淘汰最旧键。超过上限需要「数千个互不相同的键」，而各入口自身都有限流器
 * （登录 10 次/分/IP、WebDAV 30 次/分/IP）挡住单点洪泛，因此这里只承担
 * 内存安全职责，不作为安全边界。
 */
const FAILS_MAX = 5000;

/**
 * 创建失败锁定器：连续失败达 maxFails 后冻结，冻结时长指数增长（上限 maxLockMs）
 *
 * 「连续」的语义 = **同一个窗口内**连续。跨窗口的失败不再累计（见 fail()）。
 * @param {object} opt { name, maxFails, baseLockMs, maxLockMs, windowMs, maxEntries }
 */
function createFailLock({ name = 'lock', maxFails = 5, baseLockMs = 60 * 1000, maxLockMs = 30 * 60 * 1000, windowMs = 15 * 60 * 1000, maxEntries = FAILS_MAX }) {
  const fails = new Map(); // key -> { count, lockedUntil, lastAt }
  let lastSweep = 0;

  /**
   * 回收已失效条目。
   *
   * RE-01：旧写法是 `if (v.lockedUntil && v.lockedUntil <= now && ...)` ——
   * **未达锁定阈值**的条目 `lockedUntil` 恒为 0，第一个条件恒假，于是
   * 「只有被锁定过的键才可能被回收」，普通用户偶尔手误产生的条目**永不释放**。
   * 现在改为「锁已过期（或无锁）且最后一次失败已滑出窗口」即回收。
   */
  function sweep(now) {
    if (now - lastSweep < windowMs) return;
    lastSweep = now;
    for (const [k, v] of fails) {
      const lockExpired = !v.lockedUntil || v.lockedUntil <= now;
      if (lockExpired && v.lastAt + windowMs <= now) fails.delete(k);
    }
  }

  /**
   * 硬上限兜底（RE-01）：优先淘汰**未锁定**的条目（它们已无防护价值），
   * 全都处于锁定期时才按插入顺序淘汰最旧的。
   */
  function capSize(now) {
    if (fails.size <= maxEntries) return;
    for (const [k, v] of fails) {
      if (fails.size <= maxEntries) break;
      if (!v.lockedUntil || v.lockedUntil <= now) fails.delete(k);
    }
    while (fails.size > maxEntries) fails.delete(fails.keys().next().value);
  }

  return {
    /** 当前是否被锁定；返回剩余秒数（0 表示未锁定） */
    locked(key) {
      const now = Date.now();
      sweep(now);
      const v = fails.get(String(key || '-'));
      if (!v || !v.lockedUntil) return 0;
      if (v.lockedUntil <= now) return 0;
      return Math.max(1, Math.ceil((v.lockedUntil - now) / 1000));
    },
    /** 记录一次失败；返回本次失败后的锁定剩余秒数（0 表示尚未锁定） */
    fail(key) {
      const now = Date.now();
      // RE-01：sweep 原先只在 locked() 里调用 —— 某个键若只被 fail() 触碰
      // （调用方只 fail 不 locked）就永远不会触发回收，回收完全依赖别的键来"顺带"跑。
      sweep(now);
      const k = String(key || '-');
      let v = fails.get(k);
      // RE-01：计数必须按窗口衰减。
      //
      // 旧实现里 count 终身累计，"连续失败 5 次"实际是"一辈子累计 5 次"：
      // 正常用户隔几天手误一次，第 5 次就被锁在门外（可用性回归，非安全问题）。
      //
      // ⚠️ 但**正处于锁定期内不得重置** —— 否则攻击者「等到窗口滑过再失败一次」
      // 即可把自己的锁定清零，等于给锁定留了后门（fail() 与 locked() 之间存在
      // 并发窗口，同一次请求可能已通过 locked() 检查后才走到这里）。
      const activeLock = !!v && v.lockedUntil > now;
      if (!v || (!activeLock && now - v.lastAt > windowMs)) {
        v = { count: 0, lockedUntil: 0, lastAt: now };
      }
      v.count += 1;
      v.lastAt = now;
      if (v.count >= maxFails) {
        const over = v.count - maxFails; // 超出阈值的次数
        const lockMs = Math.min(maxLockMs, baseLockMs * Math.pow(2, Math.min(over, 6)));
        v.lockedUntil = now + lockMs;
      }
      fails.set(k, v);
      capSize(now);
      if (!v.lockedUntil || v.lockedUntil <= now) return 0;
      return Math.max(1, Math.ceil((v.lockedUntil - now) / 1000));
    },
    /** 成功后清空该键的失败记录 */
    reset(key) {
      fails.delete(String(key || '-'));
    },
    /** 供测试/运维：当前跟踪的键数量（观察内存是否有界） */
    size() { return fails.size; },
    /** 供测试/运维：清空全部记录 */
    clear() { fails.clear(); },
  };
}

/* ============================ 预置实例 ============================ */

// 登录：每 IP 每分钟 ≤ 10 次；同一用户名连续失败 5 次起临时锁定（1 分钟起，指数增长，上限 30 分钟）
const loginLimiter = createLimiter({ name: 'login', windowMs: 60 * 1000, max: 10 });
const loginLock = createFailLock({ name: 'login', maxFails: 5, baseLockMs: 60 * 1000, maxLockMs: 30 * 60 * 1000 });

// 加密查看密码：每 IP 每分钟 ≤ 10 次；失败 5 次起锁定（防爆破加密访问密码）
const encUnlockLimiter = createLimiter({ name: 'enc-unlock', windowMs: 60 * 1000, max: 10 });
const encUnlockLock = createFailLock({ name: 'enc-unlock', maxFails: 5, baseLockMs: 60 * 1000, maxLockMs: 30 * 60 * 1000 });

// 分享链接：按 IP + 链接 ID 限流（每 10 分钟 ≤ 20 次）；同一链接连续失败 5 次冻结 30 分钟
const shareLimiter = createLimiter({ name: 'share', windowMs: 10 * 60 * 1000, max: 20 });
const shareLock = createFailLock({ name: 'share', maxFails: 5, baseLockMs: 30 * 60 * 1000, maxLockMs: 30 * 60 * 1000 });

/* --- SEC-05：口令校验类入口的限流（旧实现只有登录与加密解锁有限流） --- */

// 系统初始化：每 IP 每 10 分钟 ≤ 10 次（该端点匿名可达且会触发口令哈希）
const initLimiter = createLimiter({ name: 'auth-init', windowMs: 10 * 60 * 1000, max: 10 });

// 口令校验类管理动作（Windows Hello 注册、改密码等）：每 IP 每分钟 ≤ 10 次
const passwordLimiter = createLimiter({ name: 'password', windowMs: 60 * 1000, max: 10 });

// WebDAV 认证：按 **IP** 限流（旧实现只按 IP+用户名锁定，攻击者换用户名即可绕过）
const webdavAuthLimiter = createLimiter({ name: 'webdav-auth', windowMs: 60 * 1000, max: 30 });

// 分享下载：按 IP + 链接 ID 限流（SEC-08：该端点是"有副作用的 GET"，且此前无限流）
const shareDownloadLimiter = createLimiter({ name: 'share-download', windowMs: 10 * 60 * 1000, max: 60 });

// SEC-03：支付网关异步通知 —— 按 IP 限流（每 10 分钟 ≤ 60 次）。
// 该端点匿名可达且会**带着真实商户凭据去网关查单**：没有它，任何人扫到回调地址
// 就能反复触发查单，把商户的查单配额刷光（进而让真实支付回调挤不进来）。
const payNotifyLimiter = createLimiter({ name: 'pay-notify', windowMs: 10 * 60 * 1000, max: 60 });

// R8-20：手动查单入口（`/s/:id/pay/check`、`/s/:id/pay/return`）—— 按 IP 限流（每 10 分钟 ≤ 60 次）。
// 与 payNotifyLimiter 是同一条推理：两者都会走到 `finalizeOrder → queryCharge`，
// 拿的是真实商户凭据。持票据者循环重放即可刷光网关查单配额，
// 把真实支付的确认挤掉。与「同一订单最快 3 秒查一次」的节流叠加使用。
const payCheckLimiter = createLimiter({ name: 'pay-check', windowMs: 10 * 60 * 1000, max: 60 });

/**
 * R9-05：轮询端点 `/s/:id/pay/status` 专用的**按 IP 网关查单预算**（每 10 分钟 ≤ 200 次）。
 *
 * 为什么不能直接复用 `payCheckLimiter`：那个阈值（60/10 分钟）是为"用户主动点按钮"
 * 设计的，而轮询端点**页面每 3 秒自动打一次**（微信 Native 没有回跳，只能靠轮询推进）。
 * 一个正常支付流程动辄几十秒到几分钟，60 次会在正常使用中就被打满 —— 直接复用等于
 * 用一个限流器去打断合法流程。
 *
 * 但完全不限流又是 R8-20 的漏洞：持票据者可 `POST /s/:id/pay` 造订单（`shareLimiter`
 * 20 次/10 分钟；单链接订单上限 50），再对每个订单每 3 秒轮询 `/pay/status`。
 * `finalizeOrderThrottled` 的键是**订单**（3 秒一次），没有按 IP 的总量上限 ——
 * 可达 20 订单 × 200 次 ≈ 4000 次/10 分钟，是 `payCheckLimiter` 预算的约 66 倍，
 * 每次都是一次携带真实商户凭据的 `queryCharge`。R8-20 想防的"刷光网关查单配额、
 * 把真实支付的确认挤掉"在这条入口上完全不成立。
 *
  * R10-09：取 **300 次**每 10 分钟，而不是恰好等于轮询速率的 200。
  *
  * 页面每 3 秒轮询一次 → 10 分钟正好 200 次，与 200 的窗口**完全相等（零余量）**；
  * 注释原先声称"正常轮询远低于它"，与算术不符。真正的正常上限还要再叠上
  * "一个支付流程内可能轮流推进几个订单"与多人共用出口 IP（NAT），零余量必被击穿。
  * 300 给一半余量，同时仍把"多订单并行刷"的放大倍数压在可控范围。
  *
  * 另一半修法在调用侧：只有「本轮真的会查单」才消耗本预算（见 share-routes.js
  * 的 `statusQueryDue`）—— 预算的语义是"网关查单次数"，不是"页面轮询次数"。
  *
  * 命中限流时**静默返回当前状态**（不改判为错误页），页面下一轮再问 ——
  * 与既有的订单级节流同一 UX 契约。
  */
 const payStatusLimiter = createLimiter({ name: 'pay-status', windowMs: 10 * 60 * 1000, max: 300 });

// SEC-12：WebDAV 明文口令揭示 —— 按「管理员 + IP」限流（每 10 分钟 ≤ 20 次）。
// 该接口会返回**明文凭据**，限流用于抑制"会话被劫持后批量拖走全部口令"。
const webdavRevealLimiter = createLimiter({ name: 'webdav-reveal', windowMs: 10 * 60 * 1000, max: 20 });

/**
 * R14-10：分享页查看 —— 按 **IP** 限流（每 10 分钟 ≤ 300 次）。
 *
 * 与 `shareDownloadLimiter`（IP+链接、60 次/10 分钟）是两回事，别合并：
 * 那条保护的是「有副作用的 GET」**下载额度**，这条保护的是**云端探测**。
 * `GET /s/:id` 会对每个链接做一次惰性 `headObject` 存在性探测（结果缓存 60 秒），
 * 而该处理器此前**完全没有限流器**（全文件的 limiter 调用点都不含它）——
 * 匿名访客只要并发请求同一个分享页 URL，就能把云端调用数与费用放大 N 倍；
 * 慢桶场景下每个请求还会各持一条连接，最长挂满 SDK 的 120 秒超时
 * （主站与 WebDAV 共用同一进程，可拖垮整个服务）。
 *
 * 取 300：分享页会被「打开 → 返回 → 再打开」地反复访问，也常在 NAT 出口后被
 * 多人共用；但它只是渲染一个静态页面 + 一次**已做并发合并**的探测，
 * 300 次/10 分钟对正常访问绰绰有余。
 */
const shareViewLimiter = createLimiter({ name: 'share-view', windowMs: 10 * 60 * 1000, max: 300 });

module.exports = {
  DEPLOY_HOST, IS_LOOPBACK, IS_DEPLOY, TRUST_PROXY,
  secureCookieAttr, clientIp,
  csrfGuard, SAFE_METHODS,
  createLimiter, limitMiddleware,
  createFailLock,
  loginLimiter, loginLock,
  encUnlockLimiter, encUnlockLock,
  shareLimiter, shareLock,
  initLimiter, passwordLimiter, webdavAuthLimiter, shareDownloadLimiter, webdavRevealLimiter, payNotifyLimiter,
  payCheckLimiter, payStatusLimiter, shareViewLimiter,
};
