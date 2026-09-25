/**
 * 服务入口 —— 本地 Web 服务（HTTP + HTTPS）
 *
 *  - 所有对象存储 API 通信默认走 HTTPS（SDK Protocol 默认 https:）
 *  - 本机管理界面同时提供 HTTP(:3000) 与 HTTPS(:3443，自动生成自签名证书)
 *  - 默认仅监听 127.0.0.1；如需局域网访问，设置环境变量 HOST=0.0.0.0（请自行注意安全）
 */
const express = require('express');
const path = require('path');
const http = require('http');
const https = require('https');

const routes = require('./routes');
const shareRoutes = require('./share-routes');
const configStore = require('./config-store');
const uploadSessions = require('./upload-sessions');
const statsStore = require('./stats-store');
// R12-07：停机前需把加密元数据的去抖异步写刷干（flushMetaSync）
const encStore = require('./enc-store');
const ipGuard = require('./ip-guard');
const webdav = require('./webdav-server');
const authSession = require('./auth-session');
const security = require('./security');
const secureStore = require('./secure-store');
const paymentOrders = require('./payment-orders');
const { gzipMiddleware } = require('./gzip');
const requestContext = require('./request-context');
const { getSelfSignedCert } = require('./local-cert');

const app = express();

const HOST = process.env.HOST || '127.0.0.1';
const HTTP_PORT = Number(process.env.PORT) || 3000;
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 3443;

/**
 * R12-01（同源）：本文件此前有两处硬编码的 `data/`（孤儿 tmp 清扫、遗留明文升级）。
 * 与所有 store 同款写法统一走 `COS_DATA_DIR` —— 否则测试进程设了开关之后，
 * 这两处仍在动真实的 `data/`。
 */
const DATA_DIR = process.env.COS_DATA_DIR ? path.resolve(process.env.COS_DATA_DIR) : path.join(__dirname, '..', 'data');

app.disable('x-powered-by');
// FUN-01：上传路由的**原始请求体解析必须先于全局 express.json 挂载**。
//  上传走 `PUT /api/fs/upload/{simple,chunk}` + `express.raw({type:()=>true})`，
//  但若全局 json 解析器先执行，它会识别 `Content-Type: application/json`
//  （浏览器对 `.json` 文件的默认 MIME）并把 req.body 解析成对象、置 req._body=true，
//  于是后续 express.raw 认为"已被解析过"而直接跳过 →
//  fs.js 里 `!req.body || !req.body.length` 对对象恒为真 → 抛 400「请求体为空」。
//  结果：上传**任何 .json / .geojson 文件必然失败**，且直传（≤8MB）与分片（>8MB）
//  两条路径都受影响（>2MB 时更早被 json 解析器以 413 拒绝）。
//  这里把这两个路径的 raw 解析提前，使其不受全局 json 影响。
app.use(['/api/fs/upload/simple', '/api/fs/upload/chunk'], express.raw({ type: () => true, limit: '64mb' }));
app.use(express.json({ limit: '2mb' }));
// P12：gzip 压缩（必须早于路由与静态中间件注册）
//  — 覆盖 /api 的 JSON 响应 + 静态前端资源（.html/.js/.css/.svg/.json）
//  — 下载/缩略图/分享下载/测速等流式接口自动跳过，避免大文件缓冲进内存
app.use(gzipMiddleware);

// S6：基础安全响应头（API 与静态资源都覆盖；frame-ancestors 替代 X-Frame-Options 以兼容 CSP）
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // SEC-06：移除 script-src 的 'unsafe-inline'。
  //   它原本只为一个内联事件处理器（缩略图的 onload/onerror）而开，
  //   却使整站 XSS 纵深防护近乎归零 —— 任何一处 innerHTML 拼接遗漏都会被
  //   直接升级为脚本执行。该处理器已改为 addEventListener（explorer.js）。
  //   同时补齐 object-src / base-uri / form-action，收窄可攻击面。
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; "
    + "img-src 'self' data:; "
    + "style-src 'self' 'unsafe-inline'; "   // 少量组件依赖内联样式，暂保留
    // 两个验证码服务商的脚本源都必须在列：host-source 是**精确匹配**，
    // 少一个 www（recaptcha.net ≠ www.recaptcha.net）或漏掉整个域名（challenges.cloudflare.com）
    // 都会让脚本被拦截 → 组件永不 load → 而"需要验证码"的开关已打开 → 全站账号无法登录。
    // R14-02 当时的形态是：reCAPTCHA 少了 www、Turnstile 整个域名不在列 —— 两条分支都是坏的。
    // 与 `public/js/main.js` 的 CAPTCHA_SCRIPTS 同源，由 invariants 护栏双向看住。
    + "script-src 'self' https://www.recaptcha.net https://www.gstatic.com https://challenges.cloudflare.com; "
    + "frame-src https://www.recaptcha.net https://challenges.cloudflare.com; "
    + "connect-src 'self'; "
    + "object-src 'none'; "                  // 禁止 <object>/<embed>/<applet>
    + "base-uri 'self'; "                    // 防止 <base> 劫持相对路径脚本
    + "form-action 'self'; "                 // 防止表单外泄到第三方
    + "frame-ancestors 'none'");
  // 部署模式补 HSTS（与 S1 的 HTTPS 强制配套）：明文二次访问前就被浏览器内部升级
  if (security.IS_DEPLOY) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// 部署模式（HOST ≠ 回环）：明文 HTTP 一律 301 跳转 HTTPS
//  —— 避免会话 Cookie、加密访问令牌经明文链路泄露（S1）
//  —— 反代 TLS 终结（Nginx/Caddy）时，仅当 TRUST_PROXY=1 才信任 X-Forwarded-Proto，
//     否则已加密的请求会被反复 301 形成重定向循环
app.use((req, res, next) => {
  if (!security.IS_DEPLOY) return next();
  if (req.socket && req.socket.encrypted) return next();
  if (security.TRUST_PROXY) {
    const xfp = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    if (xfp === 'https') return next();
  }
  // SEC-05：跳转目标不能直接取 Host 头 —— 它是客户端可控的，直接拼接就成了
  // 开放重定向（`https://evil.example:3443/...` 看起来像是本站的链接）。
  // 只认「本机配置的 HOST」与「已配置的站点域名」，其余一律回退 HOST。
  const raw = String(req.headers.host || '').split(':')[0].trim().toLowerCase();
  const host = isAllowedRedirectHost(raw) ? raw : HOST;
  return res.redirect(301, `https://${host}:${HTTPS_PORT}${req.originalUrl}`);
});

/** 允许出现在 HTTPS 跳转目标里的主机名：本机 HOST + 已配置的站点域名 */
function isAllowedRedirectHost(host) {
  if (!host) return false;
  if (host === String(HOST).toLowerCase()) return true;
  try {
    const cfg = configStore.load();
    const list = [cfg && cfg.domains && cfg.domains.primary, cfg && cfg.domains && cfg.domains.backup];
    for (const d of list) {
      if (!d) continue;
      const h = String(d).replace(/^https?:\/\//i, '').split(/[/?#:]/)[0].trim().toLowerCase();
      if (h && h === host) return true;
    }
  } catch (e) { /* 配置不可读时只认 HOST */ }
  return false;
}

// IP 访问守卫（黑名单 + 国内白名单；回环地址永远放行，本机管理界面不会被锁死）
app.use(ipGuard.middleware);

// API 鉴权：除登录/会话探测/初始化管理员外，/api/** 均需有效登录会话；
// 分享页（/s/:id）、静态资源与 SPA 兜底保持匿名可访问
//  /auth/login/webauthn 属登录第二步（Windows Hello 验签），此时尚未签发会话，必须匿名可达
const PUBLIC_API = new Set(['/auth/login', '/auth/login/webauthn', '/auth/me', '/auth/init', '/captcha/public']);
app.use('/api', (req, res, next) => {
  // CSRF：非安全方法必须携带同源自定义头 X-Requested-With（S8）
  if (!security.csrfGuard(req)) {
    return res.status(403).json({ error: '请求缺少同源校验头，已拒绝（CSRF 防护）' });
  }
  if (PUBLIC_API.has(req.path)) return next();
  const token = authSession.parseToken(req);
  const session = token ? authSession.getSession(token) : null;
  if (!session) {
    return res.status(401).json({ error: '未登录或会话已过期，请重新登录' });
  }
  // SEC-02：鉴权必须以**实时用户记录**为准，绝不能用登录时写入会话的角色快照。
  // 会话里的 user 是 createSession() 时的浅拷贝，管理员降权 / 删除账户 / 重置密码
  // 之后旧快照仍然带着原 role，会让被降权者继续持管理员权限最长 24 小时，
  // 也会让已删除账户继续读写对象存储（且重置密码这一应急响应动作完全失效）。
  // 这里统一以 configStore 的当前记录重建 req.authUser —— 一处修改根治整类问题；
  // 用户在配置中已不存在时直接销毁会话并视为未登录。
  const live = configStore.findUserRawById(session.user && session.user.id);
  if (!live) {
    authSession.destroySession(token);
    return res.status(401).json({ error: '账户不存在或已被删除，请重新登录' });
  }
  req.authUser = {
    id: live.id,
    username: live.username,
    role: live.role,
    permissions: live.permissions || {},
  };
  req.sessionToken = token;
  // FUN-15：建立请求上下文，使「当前桶」成为会话级状态。
  // AsyncLocalStorage 会沿异步链传播，后续任何深度的 configStore 调用都能取到，
  // 因此路由层无需逐个传参（也就不会漏改）。
  requestContext.runWith({
    token,
    userId: live.id,
    role: live.role,
    activeBucketId: session.activeBucketId || '',
  }, () => next());
});

// API
app.use('/api', routes);

// 公开分享页（/s/:id），需在静态资源与 SPA 兜底之前挂载
app.use('/', shareRoutes);

// 静态前端（协商缓存：ETag 304 复用，更新后立即生效）
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR, {
  etag: true,
  lastModified: true,
  maxAge: 0,
  setHeaders(res, p) {
    if (p.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    // P10：JS/CSS 允许 5 分钟强缓存（配合 ETag；改动后强制刷新可立即生效）
    else if (p.endsWith('.js') || p.endsWith('.css')) res.setHeader('Cache-Control', 'public, max-age=300');
  },
}));

// SPA 兜底
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: '接口不存在' });
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// 统一错误处理
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || (err.type === 'entity.too.large' ? 413 : 500);
  let msg = err.message || '服务器内部错误';
  if (err.type === 'entity.too.large') msg = '请求体过大，超出上传大小限制';
  if (status >= 500) {
    console.error('[server]', err);
    if (err.rawMessage || err.cosCode) console.error('[server][detail]', err.cosCode || '', err.rawMessage || '');
  }
  if (!res.headersSent) res.status(status).json({ error: msg });
  else res.destroy();
});

/* ------------------------- 启动 ------------------------- */

// 收集所有 server 实例，用于 Ctrl+C / 进程终止时统一优雅关闭
const activeServers = [];
let shuttingDown = false;

function registerServer(srv, label) {
  activeServers.push(srv);
  srv.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`[Storage Manager] ${label} 启动失败：端口 ${e.port} 已被占用。`);
      console.error(`              可能是上一次进程未完全退出，请关闭占用该端口的程序后重试，`);
      console.error(`              或在 PowerShell 执行：Get-NetTCPConnection -LocalPort ${e.port} | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }`);
    } else {
      console.error(`[Storage Manager] ${label} 启动失败(${e.code || e.message})`);
    }
  });
  return srv;
}

function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  /**
   * R12-08：`pruneTimer` 存了句柄也 `unref()` 了，却**没有配清除** —— 全项目唯一
   * 一个没有配 `clearInterval` 的 `setInterval`。现在靠末尾的 `process.exit(0)` 兜底
   * 无实际危害；但任何「不 `process.exit` 的停机路径」都会留下一个每小时扫一次云端
   * `multipartAbort` 的定时器。定时器句柄必须**成对**管理（前端侧早有这条纪律）。
   */
  try { if (pruneTimer) clearInterval(pruneTimer); } catch (e) { /* ignore */ }
  const label = signal ? `（收到 ${signal}）` : '';
  console.log(`\n[Storage Manager] 正在关闭服务${label}...`);
  let closed = 0;
  const total = activeServers.length;
  const done = () => {
    closed++;
    if (closed >= total) {
      // 关闭前确保日志缓冲落盘（避免异步队列丢失最后一批日志）
      try { statsStore.flushLogsSync(); } catch (e) { /* ignore */ }
      // R7-14：统计是 500ms 去抖 + 异步写，不强制同步落盘就会丢掉最后一批流量/请求计数
      try { statsStore.flushStatsSync(); } catch (e) { /* ignore */ }
      // 等待敏感数据的异步写入完成（S4），再等待配置落盘、停止 WebDAV 服务并退出
      // PERF-06：上传会话（含加密分片元数据）去抖 300ms，停机前必须强制落盘
      try { uploadSessions.flush(); } catch (e) { /* ignore */ }
      /**
       * R12-07：加密元数据同样有去抖异步落盘（`persistMeta()`），停机前必须刷一次。
       *
       * `flushMetaSync()` 是 R11-07 新增并导出的，但生产侧**零调用**（只有测试用），
       * 于是 `migratePrefix` 之后紧接删源的那个窗口全靠异步落盘兜 —— 被 SIGKILL /
       * OOM 打断（不触发 exit 钩子）则目标密文失去凭据、永久不可解。
       * 同步刷一次在「无待写内容」时是空操作，成本为零。
       */
      try { encStore.flushMetaSync(); } catch (e) { /* ignore */ }
      /**
       * R14-09：订单落盘改为去抖合并写（300ms），停机前必须强制刷一次 ——
       * 否则「刚点完支付、进程正好在去抖窗口内退出」会丢掉最后一次状态变更
       * （`paid` 退回落盘前的 `pending`）。无待写内容时是空操作，成本为零。
       */
      try { paymentOrders.flush(); } catch (e) { /* ignore */ }
      Promise.all([secureStore.flush(), configStore.flush()]).catch(() => {}).finally(() => {
        webdav.close().finally(() => {
          try { instanceLock.release(); } catch (e) { /* 忽略 */ }
          console.log('[Storage Manager] 服务已关闭，端口已释放。');
          process.exit(0);
        });
      });
    }
  };
  if (total === 0) {
    try { statsStore.flushLogsSync(); } catch (e) { /* ignore */ }
    return process.exit(0);
  }
  activeServers.forEach((srv) => {
    try {
      // Node 18.2+：立即关闭空闲连接，强制关闭活跃连接，避免 Windows 下 TIME_WAIT 残留
      if (typeof srv.closeIdleConnections === 'function') srv.closeIdleConnections();
      if (typeof srv.closeAllConnections === 'function') {
        srv.closeAllConnections();
        srv.close(done);
      } else {
        srv.close(done);
      }
    } catch (err) {
      done();
    }
  });
  // 兜底：3 秒后无论如何退出，避免进程僵死
  setTimeout(() => process.exit(0), 3000).unref();
}

// 注册进程信号，确保 Ctrl+C / 关闭窗口 / kill 时 TCP 端口被释放
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
// Windows 下 Ctrl+C 有时以 SIGBREAK 或 console CTRL_CLOSE_EVENT 形式传递
if (process.platform === 'win32') {
  process.on('SIGBREAK', () => gracefulShutdown('SIGBREAK'));
}

/**
 * 单实例检查：两个进程同时操作同一份 data/ 会交替整体覆盖 config.enc，导致配置丢失。
 * 检测到活跃实例时拒绝启动（避免静默破坏数据）；崩溃残留的脏锁会被自动接管。
 */
const instanceLock = require('./instance-lock');
const lockRes = instanceLock.acquire();
if (!lockRes.ok) {
  console.error(
    `[Storage Manager] 启动中止：检测到另一个实例正在运行（PID ${lockRes.pid}），` +
    '两个进程同时操作 data/ 目录会导致配置损坏。\n' +
    '  若确认该进程已不存在，请删除 data/.instance.lock 后重试。'
  );
  process.exit(1);
}

/**
 * 清理过期上传会话（并尽力中止远端分片，避免产生无用存储费用）。
 *
 * R7-07：必须放在单实例锁**之后**。此前它排在锁之前 —— 于是抢锁失败、即将
 * `process.exit(1)` 的第二个实例仍然会 (a) 向云端发 `multipartAbort`，可能中止第一个
 * 实例**正在进行**的上传；(b) 在 exit 钩子里同步写 `data/upload-sessions.json` ——
 * 而「两进程同时写 data/」正是单实例锁要杜绝的事情。
 *
 * R11-12：只跑一次等于没跑 —— 长跑进程里 7 天过期与 `MAX_SESSIONS` 上限都不生效：
 * 已放弃会话的远端分片要等下次重启才 `multipartAbort`（**持续计费**），
 * `persist()` 每次重写整个会话表，随废弃会话累积而变慢。改为启动即清一次 +
 * 每小时兜一次；句柄存变量 + `unref()`，不阻止进程退出（优雅停机另走 gracefulShutdown）。
 */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const pruneSessions = () => {
  uploadSessions.prune((session) => {
    try {
      // 按会话自身的厂商/桶/地域解析客户端，未记录 provider 的历史会话回退到默认厂商
      const cfg = configStore.effectiveForBucket(session.bucket, session.region);
      return require('./cos').getClient({ ...cfg, provider: session.provider || cfg.provider });
    } catch (e) { return null; }
  });
};
pruneSessions();
const pruneTimer = setInterval(pruneSessions, PRUNE_INTERVAL_MS);
if (typeof pruneTimer.unref === 'function') pruneTimer.unref();

/**
 * 清扫历史遗留的孤儿临时文件。
 *
 * atomic-write 在「写完 tmp、尚未 rename」之间被强杀（Ctrl+C 命中窗口、任务管理器
 * 结束进程、容器 SIGKILL）会留下 0 字节的 `<file>.<pid>.<rand>.tmp`，catch 分支
 * 没有机会执行。此处以「pid 已死 + mtime 超过 10 分钟」双重条件做一次尽力清理，
 * 保持 data/ 目录整洁。放在单实例锁之后：此时可确定没有别的实例正在写 data/。
 *
 * R12-01（同源）：这里也必须跟着 `COS_DATA_DIR` 走 —— 否则开关存在时，清扫的仍是
 * 硬编码的那个 data/，且注释里「数据中心」与实际写入位置不一致。
 */
require('./atomic-write')
  .sweepOrphanTmp(DATA_DIR)
  .then((r) => {
    if (r.removed.length) {
      console.log(`[Storage Manager] 已清理 ${r.removed.length} 个残留临时文件（孤儿 tmp）。`);
    }
  })
  .catch(() => { /* 清扫失败不影响启动 */ });

const httpServer = registerServer(http.createServer(app), 'HTTP');
httpServer.listen(HTTP_PORT, HOST, () => {
  console.log(`[Storage Manager] HTTP   : http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${HTTP_PORT}`);
});
try {
  const cert = getSelfSignedCert();
  const httpsServer = registerServer(https.createServer({ key: cert.key, cert: cert.cert }, app), 'HTTPS');
  httpsServer.listen(HTTPS_PORT, HOST, () => {
    console.log(`[Storage Manager] HTTPS  : https://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${HTTPS_PORT}（自签名证书）`);
  });
} catch (e) {
  console.warn('[Storage Manager] HTTPS 证书生成失败，仅提供 HTTP 服务：', e.message);
}

// S4：将历史遗留的明文敏感数据文件升级为加密存储（已是密文则跳过）
try {
  for (const f of ['enc-settings.json', 'enc-meta.json', 'links.json', 'ipguard.json', 'upload-sessions.json']) {
    secureStore.upgrade(path.join(DATA_DIR, f));
  }
} catch (e) { /* 升级失败不影响启动 */ }

if (configStore.isCorrupted()) {
  console.warn('[Storage Manager] 警告：本地配置文件校验失败（可能被篡改或损坏），请在“设置”中重新配置。');
}

// 按已保存配置启动 WebDAV（HTTPS）服务；开关或账户变更时由路由层调用 webdav.apply()
webdav.start().catch((e) => console.error('[Storage Manager] WebDAV 初始化异常：', e.message));

/**
 * LOW-26：未捕获异常不能只打印就继续服务。
 *
 * 走到这里说明事件循环里出现了**未定义状态**（比如某个模块级变量被写坏）。
 * 继续接受请求会让故障在用户数据上放大 —— 尤其是本服务持有「加密元数据」和
 * 「配置」这两类一旦写坏就不可逆的状态。因此记录后触发优雅关闭，
 * 由进程管理器（或手工）重启回到干净状态；`--no-restart` 可在调试时保留旧行为。
 */
process.on('uncaughtException', (e) => {
  // 端口被占用这类 listen 错误已由 server.on('error') 单独处理，
  // 这里只处理真正未预期的异常（过滤掉已被处理的 EADDRINUSE）
  if (e && e.code === 'EADDRINUSE') return;
  console.error('[uncaught]', e);
  if (process.env.NO_RESTART_ON_UNCAUGHT === '1') return;
  console.error('[uncaught] 进程处于未定义状态，准备退出以避免故障放大（设置 NO_RESTART_ON_UNCAUGHT=1 可关闭该行为）');
  try { if (secureStore.flush) secureStore.flush(); } catch (e2) { /* 尽力而为 */ }
  setTimeout(() => process.exit(1), 50).unref();
});
process.on('unhandledRejection', (e) => console.error('[unhandled]', e));

module.exports = app;
