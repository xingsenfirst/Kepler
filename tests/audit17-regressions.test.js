/**
 * 第 17 轮审计 · 反向代理取 IP / 支付侧地址校验 / async 处理器兜底
 * （R17-01 ~ R17-04）
 *
 * ## 四条缺陷的共同点
 * 都是「静态看不出来、只有跑到真实部署形态才暴露」的那一类：
 *  - R17-01（高）默认部署是「Nginx 反代 + `TRUST_PROXY=1`」，而 IP 守卫自带的取 IP
 *    实现只看 `socket.remoteAddress` → 恒见 `127.0.0.1`，而 `evaluate()` 第一条
 *    「本机永远放行」直接短路 ⇒ 黑名单 / 国内白名单 / 按桶屏蔽海外 IP / WebDAV
 *    全部失效，且**界面上一切正常**（守卫「在工作」，只是判错了人）。
 *  - R17-02（中）支付宝 `gateway` 只查协议不查主机 ⇒ 服务端 SSRF（`alipayQuery`
 *    主动出站）+ 开放重定向（`share-routes.js` 302 给下载者）。
 *  - R17-03（低）「站点对外地址」只查形状 ⇒ 经支付网关背书的开放重定向。
 *  - R17-04（低）8 处 async 处理器无兜底 ⇒ Express 4 下抛错即**请求永久挂起**。
 *
 * ## 隔离与前置
 * `TRUST_PROXY` / `HOST` 都是 `security.js` 的**模块级常量**，必须在 `require`
 * 之前写进 env（加载后再改一律无效）。数据目录由 `helpers.js` 兜底到临时目录，
 * 绝不触碰生产 `data/`。
 * ------------------------------------------------------------------ */
const fs = require('fs');
const path = require('path');
const http = require('http');
const assert = require('node:assert');
const test = require('node:test');

// 必须在加载 security / ip-guard 之前设置：这两者在模块顶层读取 env 并冻结为常量
process.env.TRUST_PROXY = '1';
process.env.HOST = 'pan.example.com';

require('./helpers'); // 兜底 COS_DATA_DIR 到临时目录

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(p, 'utf8');

const SECURITY = path.join(ROOT, 'server', 'security.js');
const IP_GUARD = path.join(ROOT, 'server', 'ip-guard.js');
const WEBDAV = path.join(ROOT, 'server', 'webdav-server.js');
const SHARE_ROUTES = path.join(ROOT, 'server', 'share-routes.js');
const ROUTES_ENC = path.join(ROOT, 'server', 'routes', 'enc.js');
const ROUTES_STATS = path.join(ROOT, 'server', 'routes', 'stats.js');
const ROUTES_SHARED = path.join(ROOT, 'server', 'routes', '_shared.js');
const ROUTES_PAYMENT = path.join(ROOT, 'server', 'routes', 'payment.js');

const security = require(SECURITY);
const ipGuard = require(IP_GUARD);
const paymentProviders = require(path.join(ROOT, 'server', 'payment-providers.js'));

/**
 * 渲染源码时先把「整行注释」剥掉再断言。
 *
 * 本项目的注释习惯是**举反例**（如 R17-01 的说明里直接引用了旧写法
 * `socket.remoteAddress`），不剥注释就会把「注释里提到的坏写法」当成真的坏写法。
 * 只剥整行注释（`//` 开头、块注释的 `*` / `/*` 续行），不动行尾注释与字符串。
 */
function stripLineComments(src) {
  return String(src).split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
}

/* ==================================================================== */
/* R17-01 · 反向代理下的客户端 IP 与「回环豁免」的边界                      */
/* ==================================================================== */

/** 造一个最小 req：经过 Nginx 反代，socket 只见回环，真实客户端在 XFF 里 */
function proxiedReq(forwarded, socketAddr = '127.0.0.1') {
  return {
    path: '/api/fs/list',
    method: 'GET',
    headers: forwarded ? { 'x-forwarded-for': forwarded } : {},
    socket: { remoteAddress: socketAddr },
  };
}

test('R17-01 · 反代下两条取 IP 路径必须一致，且黑名单对真实客户端生效', () => {
  const req = proxiedReq('203.0.113.9');

  // ① 全库唯一实现：ip-guard 取到的必须与 security 相同（旧实现这里恒为 127.0.0.1）
  assert.strictEqual(security.clientIp(req), '203.0.113.9', 'security 应取 XFF 首段');
  assert.strictEqual(ipGuard.clientIp(req), security.clientIp(req),
    'ip-guard 必须复用 security 的取 IP 实现：两份实现必然在某一轮只改一份（本轮就是）');

  // ② 行为：把真实客户端加入全局黑名单 → 必须被拦下
  const rule = ipGuard.addRule({ target: '203.0.113.9', methods: [], bucketIds: [] });
  try {
    const v = ipGuard.guardRequest(proxiedReq('203.0.113.9'));
    assert.strictEqual(v.ok, false,
      '反代场景下把真实 IP 加入黑名单后必须被拦 —— 旧实现取到 127.0.0.1，命中'
      + '「本机永远放行」，于是所有屏蔽规则在默认部署下整体失效');
    assert.strictEqual(v.reason, 'rule', '应由规则命中');
    assert.strictEqual(v.ip, '203.0.113.9', '判定用的必须是真实客户端 IP');
  } finally {
    ipGuard.removeRule(rule.id);
  }
});

test('R17-01 · XFF 伪装的 127.0.0.1 不得重获回环豁免（与正常本机直连成对）', () => {
  const rule = ipGuard.addRule({ target: '127.0.0.1', methods: [], bucketIds: [] });
  try {
    // ① 攻击面：请求方写一个 `X-Forwarded-For: 127.0.0.1`，socket 是外部地址
    const spoofed = ipGuard.guardRequest(proxiedReq('127.0.0.1', '10.1.2.3'));
    assert.strictEqual(spoofed.ok, false,
      '来自转发头的 127.0.0.1 必须按**普通 IP** 参与判定；若照样套用「回环放行」，'
      + '任何人在默认部署下发一个请求头就能把 R17-01 的修复整条抵消（等价于没修）');
    assert.strictEqual(spoofed.reason, 'rule', '应由规则命中');

    // ② 正向对照：真正的本机直连（socket 即回环、无转发头）必须仍然放行
    const direct = ipGuard.guardRequest(proxiedReq('', '127.0.0.1'));
    assert.strictEqual(direct.ok, true,
      '正常本机直连必须仍然放行 —— 否则管理员会把自己的管理界面和 WebDAV 一起锁死');
  } finally {
    ipGuard.removeRule(rule.id);
  }
});

test('R17-01 · 取 IP 只有一份实现，WebDAV 复用同一套守卫判定', () => {
  const code = stripLineComments(read(IP_GUARD));
  assert.doesNotMatch(code, /remoteAddress/,
    'ip-guard 不得再自带「只看 socket.remoteAddress」的取 IP 实现 —— 它必须复用'
    + ' security.clientIpInfo()（注释里的反例已被剥除，这里只认真实代码）');
  assert.match(code, /security\.clientIpInfo\(req\)/,
    'ip-guard 的取 IP 必须走 security.clientIpInfo');

  const securityCode = read(SECURITY);
  assert.match(securityCode, /function clientIpInfo\(req\)/,
    'security 必须提供带来源信息的 clientIpInfo（只返回字符串无法区分「回环」与'
    + '「请求方自称回环」）');

  // WebDAV 是独立 Express 实例，一旦它自己取 IP，「一处修复整体生效」就不成立
  assert.match(read(WEBDAV), /ipGuard\.guardRequest\(req\)/,
    'WebDAV 必须复用 guardRequest，否则同一份屏蔽规则在 /dav 上仍形同虚设');
});

/* ==================================================================== */
/* R17-02 · 支付宝网关地址必须过 SSRF 主机校验                             */
/* ==================================================================== */

/** 照官方文档填对的一份支付宝凭证（网关字段留空 → 用默认值） */
const VALID_ALIPAY = {
  appId: '2021004100000000',
  privateKey: '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----',
  alipayPublicKey: '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A\n-----END PUBLIC KEY-----',
  signType: 'RSA2',
};

test('R17-02 · 网关地址四种恶意形态必须被拒，官方 / 沙箱域名放行', () => {
  const probe = (v) => paymentProviders.VALIDATORS.httpsUrl(v);

  // 正向对照：官方与沙箱网关必须放行（修复不得伤害正常配置）
  assert.strictEqual(probe('https://openapi.alipay.com/gateway.do'), true,
    '官方网关必须放行');
  assert.strictEqual(probe('https://openapi-sandbox.dl.alipaydev.com/gateway.do'), true,
    '沙箱网关必须放行');

  const rejected = [
    ['https://127.0.0.1:8443/gateway.do', '回环地址：服务端会主动出站去打内网面板'],
    ['https://10.0.0.1/gateway.do', '内网 IP 字面量'],
    ['http://openapi.alipay.com/gateway.do', '明文 http（既有规则，必须保留）'],
    ['https://169.254.169.254/latest/meta-data/', '云平台实例元数据'],
    ['https://metadata.google.internal/computeMetadata/v1/', '云平台元数据主机名'],
  ];
  for (const [bad, why] of rejected) {
    assert.strictEqual(typeof probe(bad), 'string',
      `${bad} 必须被拒（${why}）—— 该地址既决定服务端把商户签名请求发往哪里，`
      + '也决定把下载者 302 到哪里');
  }

  // 走字段路径，确认真的接在注册表上（而不是只让校验器函数本身合规）
  const r = paymentProviders.validate('alipay',
    Object.assign({}, VALID_ALIPAY, { gateway: 'https://127.0.0.1:8443/gateway.do' }));
  assert.strictEqual(r.ok, false, '内网网关不得通过整表校验');
  assert.ok(r.errors.some((e) => e.field === 'gateway'),
    '错误必须落在 gateway 字段上，前端才能定位');

  // 对照组：同一份凭证 + 官方网关必须整体通过
  const ok = paymentProviders.validate('alipay',
    Object.assign({}, VALID_ALIPAY, { gateway: 'https://openapi.alipay.com/gateway.do' }));
  assert.strictEqual(ok.ok, true,
    `官方网关的完整凭证必须通过，实际错误：${JSON.stringify(ok.errors)}`);
});

/* ==================================================================== */
/* R17-03 · 「站点对外地址」必须属于本站                                    */
/* ==================================================================== */

/** 起一个只挂支付路由的最小服务（管理员身份由测试头注入），跑完即关 */
async function withPaymentServer(fn) {
  const express = require(path.join(ROOT, 'node_modules', 'express'));
  const { statsStore } = require(path.join(ROOT, 'server', 'routes', '_context.js'));
  const origLog = statsStore.addLog;
  statsStore.addLog = () => {}; // 只在临时目录里工作，这里彻底免写日志

  const app = express();
  app.use(express.json({ limit: '32kb' }));
  app.use((req, _res, next) => {
    req.authUser = { username: 'tester', role: 'admin' };
    next();
  });
  app.use('/api', require(ROUTES_PAYMENT));

  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await fn(server.address().port);
  } finally {
    statsStore.addLog = origLog;
    await new Promise((r) => server.close(r));
  }
}

/**
 * 带超时的最小 HTTP 客户端。
 *
 * 超时是**必需**的：R17-04 的故障症状恰恰是「请求永久挂起」——反向变异验证
 * 撤销 asyncHandler 时必须能拿到一个「无响应」的结果，而不是把整个测试进程挂死。
 */
function jsonCall(port, method, urlPath, body, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: urlPath,
      headers: Object.assign(
        { 'X-Requested-With': 'XMLHttpRequest' },
        data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : null,
      ),
    }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* 非 JSON */ }
        done({ status: res.statusCode, json });
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); done({ status: 0, json: null }); });
    req.on('error', () => done({ status: 0, json: null }));
    if (data) req.write(data);
    req.end();
  });
}

test('R17-03 · 外站地址一律 400，本站地址放行，且真的落盘', async () => {
  await withPaymentServer(async (port) => {
    // ① 外站：形状完全合法也要拒 —— 该值会被拼成 return_url 交给支付网关，
    //    支付完成后由**网关**把用户浏览器重定向过来（经网关背书的开放重定向）
    const evil = await jsonCall(port, 'PUT', '/api/payment/site-url',
      { siteUrl: 'https://evil.example/phish' });
    assert.strictEqual(evil.status, 400,
      '外站地址必须被拒：形状校验拦不住它，而它足以把付款人导流到攻击者站点');
    assert.match((evil.json && evil.json.error) || '', /本站/,
      `错误文案应点明「必须是本站地址」，实际：${evil.json && evil.json.error}`);

    // ② 本站域名（部署 HOST）放行
    const own = await jsonCall(port, 'PUT', '/api/payment/site-url',
      { siteUrl: 'https://pan.example.com' });
    assert.strictEqual(own.status, 200, '本站域名必须放行');
    assert.strictEqual(own.json && own.json.siteUrl, 'https://pan.example.com', '应原样回显');

    // 落盘校验：GET 回来必须就是刚存的值（防止「回显了但没存」的假绿）
    const cfg = await jsonCall(port, 'GET', '/api/payment/config');
    assert.strictEqual(cfg.json && cfg.json.siteUrl, 'https://pan.example.com',
      '站点地址必须真的写进配置');

    // ③ 当前访问主机的地址同样放行（管理员用 IP:端口 访问时也要能配）
    const withPort = await jsonCall(port, 'PUT', '/api/payment/site-url',
      { siteUrl: 'https://127.0.0.1:8443/base/' });
    assert.strictEqual(withPort.status, 200, '当前访问主机的地址必须放行');
    assert.strictEqual(withPort.json && withPort.json.siteUrl, 'https://127.0.0.1:8443/base',
      '结尾斜杠应被规整掉');

    // ④ 形状不合法仍是 400（既有行为，必须保留）
    const bad = await jsonCall(port, 'PUT', '/api/payment/site-url', { siteUrl: 'not-a-url' });
    assert.strictEqual(bad.status, 400, '非 URL 的形状校验不得被新主机校验顶掉');

    // ⑤ 清空始终允许（回到「按请求 Host 兜底」）
    const cleared = await jsonCall(port, 'PUT', '/api/payment/site-url', { siteUrl: '' });
    assert.strictEqual(cleared.status, 200, '清空必须允许');
    assert.strictEqual(cleared.json && cleared.json.siteUrl, '', '清空后应为空串');
  });
});

test('R17-03 · 站点地址的「是不是本站」判据与 HTTPS 跳转同源', () => {
  // ① 判据本身（security.isOwnSiteHost）：部署 HOST / 已配置域名 / 调用方补充主机
  assert.strictEqual(security.isOwnSiteHost('https://pan.example.com', []), true,
    '部署 HOST 属于本站');
  assert.strictEqual(security.isOwnSiteHost('https://pan.example.com:8443/x/y', []), true,
    '带端口与路径的本站地址仍属本站');
  assert.strictEqual(security.isOwnSiteHost('https://evil.example', []), false,
    '外站不属于本站');
  assert.strictEqual(security.isOwnSiteHost('', []), false, '空值不属于本站');

  // ② 结构上钉住：支付路由与 HTTPS 跳转必须共用同一处判据（两份实现必然只改一份）
  const paySrc = stripLineComments(read(ROUTES_PAYMENT));
  assert.match(paySrc, /security\.isOwnSiteHost\(/,
    '支付「站点对外地址」必须用 security.isOwnSiteHost 判定');
  // R21-13 起：跳转目标改由 `security.httpsRedirectHost()` 统一决定（`HOST=0.0.0.0` 时
  // 先取配置的站点域名、再回退，并对通配兜底告警），但「是不是本站」仍必须问同一个
  // `isOwnSiteHost` —— 判据不得分叉成两份。故这里钉两处：调用方**整体委托**给唯一实现点，
  // 且该实现点内部仍用同一个判据函数。
  const idxSrc = read(path.join(ROOT, 'server', 'index.js'));
  assert.match(idxSrc, /security\.httpsRedirectHost\(/,
    'HTTPS 跳转目标必须交给 security.httpsRedirectHost 统一决定（不得在 index.js 内联一份）');
  const secSrc = read(path.join(ROOT, 'server', 'security.js'));
  assert.match(secSrc, /function httpsRedirectHost\([\s\S]*?isOwnSiteHost\(/,
    'HTTPS 跳转判据必须与支付站点判据同源（同一 isOwnSiteHost；同型问题两处各写一份，必然在某一轮只改一份）');

  // ③ 展示层兜底：配置值万一不属本站（旧版本写入 / 手改文件），回退按请求 Host 推断
  const shareSrc = stripLineComments(read(SHARE_ROUTES));
  assert.match(shareSrc, /if \(base && !security\.isOwnSiteHost\(base, \[\]\)\) base = '';/,
    'siteUrlFor 必须对配置值再兜一次 —— 否则旧配置会把付款人 302 到外站');
});

/* ==================================================================== */
/* R17-04 · async 处理器必须把抛错交回统一错误中间件                        */
/* ==================================================================== */

test('R17-04 · asyncHandler 的签名与语义（Express 4 不接 async 抛错）', async () => {
  const { asyncHandler } = require(ROUTES_SHARED);
  assert.strictEqual(typeof asyncHandler, 'function', '必须导出 asyncHandler');

  const wrapped = asyncHandler(async () => { throw new Error('boom'); });
  assert.strictEqual(wrapped.length, 3,
    '包装后必须仍是 (req, res, next) 三参签名，否则 Express 不会把它当普通 handler');

  // 语义：抛错走 next(err)，而不是被吞掉
  let caught = null;
  wrapped({}, {}, (e) => { caught = e; });
  await new Promise((r) => setImmediate(r));
  assert.ok(caught instanceof Error && caught.message === 'boom',
    'async 抛错必须转成 next(err) —— 交给统一错误中间件');

  // 对照：未包装的 async 直接调用只得到「一个被忽略的 rejected promise」
  const raw = async () => { throw new Error('raw-boom'); };
  let rawRejected = false;
  await Promise.resolve().then(raw).catch(() => { rawRejected = true; });
  assert.strictEqual(rawRejected, true,
    '未包装的 async 抛错只会产生一个被忽略的 rejected promise —— Express 4 不看它，'
    + '于是请求永久挂起（这正是 R17-04 的现场）');
});

test('R17-04 · 包装后的处理器抛错必须返回 500，而不是让请求挂起', async () => {
  const express = require(path.join(ROOT, 'node_modules', 'express'));
  const { asyncHandler } = require(ROUTES_SHARED);

  const app = express();
  app.get('/boom', asyncHandler(async () => { throw new Error('kaboom'); }));
  // 与 server/index.js 末尾同构的统一错误中间件
  app.use((err, req, res, _next) => { res.status(err.status || 500).json({ error: err.message }); });

  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const r = await jsonCall(server.address().port, 'GET', '/boom', undefined, 2000);
    assert.strictEqual(r.status, 500,
      '必须由统一错误中间件回答 500；若为 0（超时无响应）就说明请求又挂起了');
    assert.strictEqual(r.json && r.json.error, 'kaboom', '错误信息应透传给客户端');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('R17-04 · 8 处无顶层 try 的 async 处理器必须全部包上 asyncHandler', () => {
  // 逐条精确锚定（用注册语句本体，避免「文件里随便有个 asyncHandler 就算过」）
  const expectations = [
    [ROUTES_ENC, ["router.post('/enc/unlock', asyncHandler(async (req, res) => {"]],
    [ROUTES_STATS, ["router.get('/stats/logs', requireAdmin, asyncHandler(async (req, res) => {"]],
    [SHARE_ROUTES, [
      "router.post('/s/:id/pay', asyncHandler(async (req, res) => {",
      "router.get('/s/:id/pay/return', asyncHandler(async (req, res) => {",
      "router.post('/s/:id/pay/check', asyncHandler(async (req, res) => {",
      "router.get('/s/:id/pay/status', asyncHandler(async (req, res) => {",
      "router.post('/pay/notify/:platform', asyncHandler(async (req, res) => {",
      "router.post('/s/:id', asyncHandler(async (req, res) => {",
    ]],
  ];

  let total = 0;
  for (const [file, needles] of expectations) {
    const src = read(file);
    for (const needle of needles) {
      total += 1;
      assert.ok(src.includes(needle),
        `${path.relative(ROOT, file)} 缺少包装后的注册：${needle}\n`
        + '（Express 4 不捕获 async 抛错，公开匿名可达的路径一旦抛错就是永久挂起）');
    }
  }
  assert.strictEqual(total, 8,
    `本轮台账是 8 处无顶层 try 的 async 处理器，实际钉了 ${total} 处 —— 清单变了请同步报告`);

  // 下界自检：这三份文件里被包装的 async 处理器总数不得少于 8
  const wrappedCount = [ROUTES_ENC, ROUTES_STATS, SHARE_ROUTES]
    .map((f) => (read(f).match(/asyncHandler\(async/g) || []).length)
    .reduce((a, b) => a + b, 0);
  assert.ok(wrappedCount >= 8,
    `asyncHandler 包装数应 ≥ 8，实际 ${wrappedCount}（扫描范围可能已失效）`);
});
