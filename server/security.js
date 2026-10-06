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
 * R38：**本站对外域名**（部署脚本写入 `SITE_DOMAIN=cos.example.com`）。
 *
 * 为什么必须有它 —— 这是 R38-01 的根因所在：`deploy.sh` 生成的运行环境里
 * `HOST=0.0.0.0`。那是**通配绑定地址**（要求内核监听全部网卡），它**永远不可能**
 * 出现在请求的 `Host` 头里；而真实域名此前只被写进 nginx 的 `server_name`，
 * **应用完全不知道「自己叫什么」**。
 *
 * 后果是部署模式下「本站」允许集里只剩一个通配地址，于是：
 *  - WebAuthn：任何用真实域名访问的注册 / 登录都被 `webauthnContext()` 判成
 *    「当前访问地址不是本站域名」→ 403，Windows Hello 完全不可用；
 *  - HTTPS 跳转：`configuredSiteHost()` 取不到域名，`httpsRedirectHost()` 只能
 *    退回 `https://0.0.0.0:3443/…`（Windows 上根本无法解析）。
 *
 * ⚠️ 它**不是**「自定义请求域名（`cfg.domains`）」，两者语义不同、不可合并：
 * 后者是**分享链接优先使用的 CDN 域名**（见密钥管理页的原话），可选，且与
 * 「本站是否在本域名下提供服务」毫无关系；把它当成 rpId 白名单来源，等于用
 * 「分享走哪个域名」回答「本站叫什么」。
 */
const SITE_DOMAIN = normalizeHost(process.env.SITE_DOMAIN || '');

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
 * 回环 / IPv4-mapped IPv6 归一化：`::ffff:127.0.0.1` → `127.0.0.1`、`::1` → `127.0.0.1`。
 * 全库只有这一份写法（ip-guard 曾自带一份等价的私有实现，见下）。
 *
 * R27-07：**同时做规范化（canonicalize）**。本函数的返回值在限流与失败锁定的键里
 * 直接充当「身份」（`ip`、`ip|username`），所以同一地址必须只有一种拼写 —— 否则
 * 攻击者靠改写拼写（`::A` / `::a`、`::ffff:0102:0304` / `::ffff:1.2.3.4`）就能让每个
 * 请求落进不同的键，把限流与账户锁定整条绕开。规范化交 `ip-guard.canonicalIpLiteral`
 * （唯一实现点：IPv4 拒前导零、IPv6 必须真的能解析成 16 字节并压成 RFC 5952 形式）。
 *
 * 规范化失败时退回「原样（IPv6 小写化）」而不是空串：调用方
 * `clientIpInfo()` 已经把非法转发头收敛成 `''`，走到这里的多半是 socket 地址
 * （一定合法）；真出现异常值时保持可辨识、可记录，比硬塞一个空身份更安全。
 */
function normalizeIp(raw) {
  const ip = String(raw == null ? '' : raw).trim();
  if (!ip) return '';
  /**
   * 顺序很关键：**先规范化，再做回环折算**。
   * 旧实现先无条件 `slice(7)` 剥 `::ffff:` 前缀 —— 那只对**点分十进制**写法正确，
   * 对十六进制写法（`::ffff:0102:0304`）会剥出 `0102:0304` 这种半截串。
   * `canonicalIpLiteral` 自己会把 IPv4-mapped 折算成点分十进制，故这里不再手剥。
   */
  let canon = null;
  try {
    canon = require('./ip-guard').canonicalIpLiteral(ip); // 懒加载：避免 security ↔ ip-guard 加载期成环
  } catch (e) { canon = null; }
  const out = canon || ip;
  if (out === '::1' || out === '0:0:0:0:0:0:0:1') return '127.0.0.1';
  return out.includes(':') ? out.toLowerCase() : out;
}

/**
 * R22-02 起：语法上是否是一个**可信的** IP 字面量（不接受端口 / 域名 / 任意字符串）。
 *
 * 为什么必须有这道校验：`X-Forwarded-For` 即便在 `TRUST_PROXY=1` 下也仍是
 * **请求方可控输入**。若取值不做格式校验，攻击者可以给每个请求**换一个不同的非法串**
 * （`a`、`b`、`c`…），而限流键与失败锁定键正是 `ip` / `ip|username` —— 键随头轮换，
 * 等于把「按 IP 限流 + 账户锁定」整条绕开（比「取首段」本身更致命）。
 *
 * R27-07：判据从「字符集 + 粗结构」升级为**真的能解析**（委托
 * `ip-guard.canonicalIpLiteral`，与 `normalizeIp` 同一实现点）。旧实现对含 `::`
 * 的串直接 `return true`，于是 `1::2::3` / `:::::` / `::1:2:…:9` 这类**结构非法**
 * 的值被当成合法 IP 采用，而它们在下游 `ip-guard.evaluate()` 里解析失败 ——
 * 后者当时会**跳过全部规则**并放行，等于「一个请求头绕过所有 IP 屏蔽」。
 * 同时拒绝前导零写法（`01.2.3.4`），它曾把限流预算放大 81 倍。
 *
 * 只做**语法**判定，不判归属：内网 / 回环地址在局域网部署里是完全合法的客户端 IP，
 * 归属（公网 / 内网 / 国内）一律交给 `ip-guard` 判定。
 */
function isIpLiteral(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s || s.length > 45) return false;
  try {
    return require('./ip-guard').canonicalIpLiteral(s) !== null;
  } catch (e) {
    return false; // 判据不可用时 fail-closed（宁可判为「不是 IP」→ 不采用该头）
  }
}

/** `X-Forwarded-For` 头是否存在且非空 —— 用于区分「没有头」与「头在但值不可用」 */
function hasForwardedHeader(req) {
  const h = req && req.headers;
  return Boolean(String((h && h['x-forwarded-for']) || '').trim());
}

/**
 * 取「反向代理注入的真实客户端 IP」：仅 `TRUST_PROXY=1` 且确有 `X-Forwarded-For`
 * 时返回首段（最接近真实客户端的值），否则返回空串。
 *
 * R17-01：这是全库**唯一一份** XFF 解析实现。此前 `ip-guard.js` 自带了另一份
 * 「只看 `socket.remoteAddress`、没有任何 XFF 分支」的实现，而 `deploy.sh` 生成的
 * 默认部署恰好是「Nginx 反代 + `TRUST_PROXY=1`」——于是同一进程里两条取 IP 路径分叉：
 * 限流 / 失败锁定 / 分享冻结拿到真实 IP，IP 守卫却永远拿到 Nginx 的回环地址。
 *
 * R22-02：取值前必须过 `isIpLiteral()` —— 非 IP 字面量一律不接受（理由见上）。
 * 同时 `deploy.sh` 生成的 Nginx 侧已改为**重写**该头（`$remote_addr`），
 * 使首段不再可能来自请求方原值；这里的格式校验是第二道防线（老配置 / 自建反代）。
 */
function forwardedClientIp(req) {
  if (!TRUST_PROXY) return '';
  if (!hasForwardedHeader(req)) return '';
  const first = String(req.headers['x-forwarded-for']).split(',')[0].trim();
  return isIpLiteral(first) ? first : '';
}

/**
 * 取客户端 IP **以及它的来源**（R17-01）。
 *
 * 返回「来源」是必需的：开启 `TRUST_PROXY` 后 IP 取自请求头，属**请求方可控输入**，
 * 调用方必须据此决定还能不能套用「回环永远放行」——否则任何人只要发一个
 * `X-Forwarded-For: 127.0.0.1` 就重新变成「本机」，屏蔽规则被一个请求头整条绕过。
 * 只返回字符串时这两件事无法区分（旧的 `ip-guard.clientIp()` 正是这么丢掉了信息）。
 *
 * R22-02：「头在、但值不是 IP 字面量」必须与「根本没有头」区分开。两者若都落进
 * socket 分支，反代部署下 socket 恰好是 Nginx 的 `127.0.0.1`，这个来源根本不可辨认的
 * 请求就会被当成**本机直连**而白拿回环豁免（R17-01 刚堵掉的洞又换个形式回来）。
 * 因此显式标记 `fromForwarded=true` 且置空 IP：调用方既不得套回环豁免，这类请求也
 * 一律共用同一个限流 / 锁定键（无法靠轮换非法串重置预算）。
 *
 * @returns {{ip: string, fromForwarded: boolean}} fromForwarded=true 表示该值来自请求头
 */
function clientIpInfo(req) {
  const fwd = forwardedClientIp(req);
  if (fwd) return { ip: normalizeIp(fwd), fromForwarded: true };
  if (TRUST_PROXY && hasForwardedHeader(req)) return { ip: '', fromForwarded: true };
  const raw = (req && req.socket && req.socket.remoteAddress) || (req && req.ip) || '';
  return { ip: normalizeIp(raw), fromForwarded: false };
}

/**
 * 取客户端 IP（N1 修复）：
 *  - 默认（未配置可信代理）：直接使用 socket.remoteAddress，不信任 XFF
 *  - TRUST_PROXY=1（部署在反向代理后）：信任 XFF 首段（最接近真实客户端的值）
 *
 * R17-01：`ip-guard.js` 直接复用本函数，不再自带一份实现 —— 同一逻辑两份实现，
 * 必然在某一轮改动里只改一份（本轮就是）。
 */
function clientIp(req) {
  return clientIpInfo(req).ip;
}

/**
 * R27-03：本次请求在**浏览器眼里**是不是 HTTPS —— 全库唯一实现点。
 *
 * 为什么必须有它：反代 TLS 终结（`deploy.sh` 装的就是 Nginx + `TRUST_PROXY=1`，
 * 且 `proxy_pass http://127.0.0.1:<port>`）时，socket 是**明文 HTTP**，而本服务
 * 从不 `app.set('trust proxy', …)` —— Express 的 `req.secure` 只按
 * `req.connection.encrypted` 推导，于是**恒为 false**；可浏览器地址栏是 `https://`，
 * 它发出的 `Origin` 也是 `https://host`。任何拿 `req.secure` 直接判协议的地方都会
 * 得出相反结论。
 *
 * 同一件事此前在库里有 **4 份**写法：`share-routes.js` 的 `siteUrlFor` 与分享下载
 * 来源判定、`_shared.js` 的 WebAuthn origin 三处用了
 * `req.secure || (IS_DEPLOY && TRUST_PROXY)`，而 `share-routes.js` 的 `/s/*`
 * 同源校验用了裸 `req.secure` —— 结果默认 HTTPS 部署下**分享页的所有 POST**
 * （提交访问密码 / 查看密码解锁 / 发起支付 / 手动查单）都被自己的 CSRF 防护 403，
 * 页面只显示一句「请求来源校验失败」。这正是本项目反复记档的元规律：
 * 「同一逻辑多份实现处，必有改一半的漏网之鱼」。
 *
 * 语义刻意与那三处**逐字一致**（不在本函数里额外要求 `X-Forwarded-Proto` 头）：
 * `TRUST_PROXY=1` 在本项目里的含义就是「部署方保证按 `deploy.sh` 的模板转发
 * 真实协议」，收紧会让既有部署的分享页重新变红 —— 那是另一个决定，不该混在
 * 这次「统一口径」里做。
 *
 * @param {import('http').IncomingMessage} req
 * @returns {boolean}
 */
function requestIsSecure(req) {
  const r = req || {};
  return Boolean(r.secure || (IS_DEPLOY && TRUST_PROXY));
}

/**
 * 主机名归一化：去首尾空白、小写、剥掉 `http(s)://` 前缀、去掉端口与路径。
 * 空 / 非法输入返回 `''`（调用方一律按「不匹配」处理）。
 */
function normalizeHost(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (!s) return '';
  return s.replace(/^[a-z]+:\/\//, '').split(/[/?#]/)[0].split(':')[0].trim();
}

/**
 * 该主机名是否属于「本站自身」（R17-03）：本机 `HOST` + 配置里的主/备站点域名
 * + 调用方补充的允许主机（如当前请求的 `Host`）。
 *
 * 用于回答「这个地址是不是本站」——支付「站点对外地址」与 HTTPS 跳转目标都要问
 * 同一个问题，因此收敛到这一处（HTTPS 跳转目标自 R21-13 起改由 `httpsRedirectHost()`
 * 统一决定，而后者内部仍调本函数；`index.js` 不再自持一份判据）。
 * 配置读取走惰性 require，避免 security → config-store → … 的加载顺序耦合。
 *
 * @param {string} host 待判定的主机名（可带协议前缀 / 端口）
 * @param {string[]} [extra] 调用方补充的允许主机
 * @returns {boolean}
 */
function isOwnSiteHost(host, extra) {
  const h = normalizeHost(host);
  if (!h) return false;
  // R38：`SITE_DOMAIN`（部署脚本写入的真实域名）优先纳入 —— 缺了它，默认部署
  // 下整个允许集里只剩 `HOST=0.0.0.0` 这个通配绑定地址，真实域名一律被判「非本站」。
  const own = new Set([normalizeHost(DEPLOY_HOST), SITE_DOMAIN]);
  try {
    const cfg = require('./config-store').load();
    own.add(normalizeHost(cfg && cfg.domains && cfg.domains.primary));
    own.add(normalizeHost(cfg && cfg.domains && cfg.domains.backup));
  } catch (e) { /* 配置不可读时只认本机 HOST */ }
  for (const e of extra || []) own.add(normalizeHost(e));
  own.delete('');
  // R38：通配绑定地址不是「本站域名」。把它留在允许集里只会制造「看着有一条、
  // 其实永远不命中」的假象（请求 Host 不可能等于 0.0.0.0），还会让
  // `httpsRedirectHost()` 的回退分支把「无域名可用」误判成「有域名可用」。
  for (const x of [...own]) { if (isBindAllHost(x)) own.delete(x); }
  return own.has(h);
}

/** 配置里的站点主/备域名（取第一个非空），读不到返回 '' */
function configuredSiteHost() {
  // R38：部署脚本写下的真实域名优先于「分享用 CDN 域名」—— 后者只是分享链接的
  // 展示偏好，拿它做 HTTPS 跳转目标会把用户送到一个并不提供本系统的域名上。
  if (SITE_DOMAIN) return SITE_DOMAIN;
  try {
    const cfg = require('./config-store').load();
    const d = cfg && cfg.domains;
    return normalizeHost((d && (d.primary || d.backup)) || '');
  } catch (e) {
    return '';
  }
}

/** 是否为「监听全部网卡」的通配绑定地址（它作为跳转目标没有意义） */
function isBindAllHost(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (s === '0.0.0.0' || s === '::' || s === '[::]' || s === '*') return true;
  return normalizeHost(s) === '0.0.0.0';
}

/**
 * R21-13：明文 → HTTPS 跳转目标的**唯一实现点**。
 *
 * 目标选取顺序（R22-06：注释必须与 `:158-168` 的实现**逐项同序**，否则下轮会被
 * 当成「文档不同步」再报一次）：**被允许的请求 Host → 本机 HOST（非通配时）
 * → 配置的站点主/备域名 → 通配回退并告警**。
 *
 * 为什么不直接用 HOST 兜底：`Dockerfile` 里 `HOST=0.0.0.0`（容器必须监听通配地址
 * 才能被外部访问），而 `0.0.0.0` 作为**跳转目标**毫无意义 —— 按 README 的 Docker
 * 快速启动（不注入 `TRUST_PROXY`、不配置站点域名）访问 `http://<服务器>:3000`，
 * 会被 301 到 `https://0.0.0.0:3443/…`（Windows 上根本无法解析）。这不是安全问题，
 * 而是「照文档做即坏」。因此通配绑定地址**不再作为首选兜底**：先看有没有配置站点
 * 域名；都没有时保留原行为并置 `fallbackToBindAll`，由调用方打一条显式告警
 * （保持跳转比默默不跳更可诊断 —— 后者会让人以为 HTTPS 已经就绪，而部署模式下
 * Secure Cookie 其实不会下发）。
 *
 * @param {string} rawHost 请求的 Host 头（可带端口）
 * @returns {{ host: string, fallbackToBindAll: boolean }}
 */
function httpsRedirectHost(rawHost) {
  const raw = normalizeHost(rawHost);
  // 请求的 Host 是通配绑定地址时同样不可用（它并不指向任何可访问的名字）
  if (raw && !isBindAllHost(rawHost) && isOwnSiteHost(raw, [DEPLOY_HOST])) {
    return { host: raw, fallbackToBindAll: false };
  }
  const local = normalizeHost(DEPLOY_HOST);
  if (!isBindAllHost(local)) return { host: local, fallbackToBindAll: false };
  const dom = configuredSiteHost();
  if (dom) return { host: dom, fallbackToBindAll: false };
  return { host: local, fallbackToBindAll: true };
}

/* ============================ CSRF ============================ */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF 校验：安全方法直接放行；其余方法要求 X-Requested-With: XMLHttpRequest。
 * 前端 api.js / xhrPut 已统一携带该头。
 *
 * R24-06：在此之上补一层**同源校验**。原判据是**单点** —— 它依赖「浏览器不让跨站
 * 请求伪造自定义头」这一事实；一旦将来引入 CORS、或反代 / 插件替请求补上该头，
 * 这道防线就**静默消失**（且没有任何症状）。因此只要请求带了 `Origin`（其次
 * `Referer`），就要求其主机与**本次请求的 Host**一致；两者都缺失时放行 ——
 * curl / wget 之类直连客户端本就不带这两个头，不在「浏览器跨站」的威胁面内，
 * 收紧只会误伤它们。
 *
 * 与请求自身 Host 比对（而不是与配置域名比对）有两个好处：不依赖站点是否配置了
 * 域名（局域网 / Docker 直接访问照样成立），也不会因反代隐藏端口而误判。
 * `Origin: null`（沙箱 iframe / 某些重定向）不是合法 URL → 直接拒绝。
 */
function csrfGuard(req) {
  if (SAFE_METHODS.has(req.method)) return true;
  const h = String(req.get('x-requested-with') || '');
  if (h.toLowerCase() !== 'xmlhttprequest') return false;
  const src = String(req.get('origin') || req.get('referer') || '').trim();
  if (!src) return true;
  let from = '';
  try { from = new URL(src).host; } catch (e) { return false; }
  const want = normalizeHost(String(req.get('host') || ''));
  return normalizeHost(from) !== '' && normalizeHost(from) === want;
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
/**
 * R38：「备份配置」导出时校验账户口令的限流器。
 *
 * 为什么不复用 `passwordLimiter`（10 次/分钟）：两者都拿 scrypt 校验**同一份**
 * 口令哈希，共用预算会让「导出备份」把「改密码」的额度吃掉 —— 用户改密码时突然
 * 被「操作过于频繁」挡住，而他只会以为是自己密码打错了。语义不同就各给一条
 * （本项目既有约定：支付链路上的三个限流器也是因此没有合并）。
 */
const backupExportLimiter = createLimiter({ name: 'backup-export', windowMs: 10 * 60 * 1000, max: 10 });

const shareViewLimiter = createLimiter({ name: 'share-view', windowMs: 10 * 60 * 1000, max: 300 });

module.exports = {
  DEPLOY_HOST, IS_LOOPBACK, IS_DEPLOY, TRUST_PROXY,
  SITE_DOMAIN, // R38：部署脚本写入的本站对外域名（「本站」允许集的权威来源）
  secureCookieAttr, clientIp,
  // R17-01：唯一的 XFF 解析实现 + 「IP 及其来源」；R17-03：「这个地址是不是本站」
  // R22-02：`isIpLiteral` 是「转发头里的值是否可信」的唯一语法判据
  normalizeIp, forwardedClientIp, clientIpInfo, normalizeHost, isOwnSiteHost,
  isIpLiteral, hasForwardedHeader,
  requestIsSecure, // R27-03：唯一的「本次请求是否 HTTPS」判据
  httpsRedirectHost, isBindAllHost, configuredSiteHost,
  csrfGuard, SAFE_METHODS,
  createLimiter, limitMiddleware,
  createFailLock,
  loginLimiter, loginLock,
  encUnlockLimiter, encUnlockLock,
  shareLimiter, shareLock,
  initLimiter, passwordLimiter, webdavAuthLimiter, shareDownloadLimiter, webdavRevealLimiter, payNotifyLimiter,
  payCheckLimiter, payStatusLimiter, shareViewLimiter,
  backupExportLimiter, // R38：备份导出校验账户口令的限流（与 passwordLimiter 刻意分开）
};
