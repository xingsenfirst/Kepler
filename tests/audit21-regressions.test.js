/**
 * 第二十一轮审计护栏（R21-01 ~ R21-15）
 *
 * 每条用例都断言**可观测的后果**，并配一条正向对照（不注入故障时必须成功），
 * 证明守卫没有退化成「什么都不做」。反向对照登记在 `scripts/reverse-check.js`。
 *
 * 覆盖：
 *  - R21-01 密文对象的分享下载必须与 `/api/fs/download` 共用同一道加密门禁
 *  - R21-03 流式写入（WebDAV PUT）必须有并发上限
 *  - R21-05 Windows Hello 登录失败分支必须同形（不得成为用户名 oracle）
 *  - R21-06 `notifyUrl` 必须与**实际下单渠道**同源
 *  - R21-09 自助改密必须二次校验当前密码
 *  - R21-10 抢锁不得在「内容未落盘」窗口里接管活锁
 *  - R21-11 缓存键的分隔符必须不可被请求参数注入
 *  - R21-12 出站请求不得自动跟随重定向
 *  - R21-13 HTTPS 跳转目标不得落到通配绑定地址
 *  - R21-14 WebDAV 错误响应不得回显上游原始 message
 *  - R21-15 跳过清单的版本号与文档引用必须与仓库一致
 *
 * ⚠️ 端口一律用 `listen(0)`（临时端口），避免与相邻轮次并发跑文件时 EADDRINUSE。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { PassThrough, Readable } = require('stream');
const { test } = require('node:test');
const { ROOT, assert, assertEqual, assertMatch, makeTempDir, request } = require('./helpers.js');

const tmp = makeTempDir('cos-audit21-');
process.env.COS_DATA_DIR = tmp.dir;

const express = require(path.join(ROOT, 'node_modules', 'express'));

/* ============================ 公共打桩 ============================ */

const cos = require(path.join(ROOT, 'server', 'cos.js'));
/**
 * 假云端句柄：**必须在任何路由/网关 require 之前**装好 —— 它们都在加载时
 * `const { getClient } = require('./cos')` 解构，之后再改 `cos.getClient` 无效。
 * 所有用例共用一个可变句柄，切换实现即可（与 `share-deleted.test.js` 同一手法）。
 */
let cloud = null;
cos.getClient = () => cloud;

const configStore = require(path.join(ROOT, 'server', 'config-store.js'));
const statsStore = require(path.join(ROOT, 'server', 'stats-store.js'));
const encStore = require(path.join(ROOT, 'server', 'enc-store.js'));

statsStore.addLog = () => {};
statsStore.trackBucket = () => {};
statsStore.sampleTraffic = () => {};

/** 起一个只挂指定路由的本地服务（端口由内核分配） */
async function serve(mount, router, middleware) {
  const app = express();
  app.use(express.json());
  if (middleware) app.use(middleware);
  app.use(mount, router);
  const server = await new Promise((resolve) => {
    const s = http.createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  return { port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}

/* ==================================================================== */
/* R21-01 · 密文对象的分享下载必须与 /api/fs/download 共用同一道加密门禁      */
/* ==================================================================== */

test('R21-01 · 密文对象 + 已设查看密码：分享下载/HEAD/分享页都不得放行明文', async () => {
  const ENC_KEY = 'secret/cipher.bin';
  const PLAIN_KEY = 'public/plain.txt';
  const ENC_PASSWORD = 'enc-pw-21';
  const GOOD_TOKEN = 'good.token';
  const CONTENT = 'DECRYPTED-PLAINTEXT';

  // enc-store 打桩：本地不写真实密文，只把「哪些 key 是密文」「是否已设密码」摆好。
  // 这些都在 share-routes / download-stream 里以属性访问调用，故可直接替换。
  encStore.getMeta = (_bucket, key) => (key === ENC_KEY
    ? { origSize: String(CONTENT.length), mode: 'crypto' } : null);
  encStore.passwordSet = () => true; // 已设「加密访问密码」
  encStore.verifyToken = (t) => String(t || '') === GOOD_TOKEN;
  encStore.issueToken = () => ({ token: GOOD_TOKEN, expiresIn: 30 * 60 * 1000 });
  encStore.checkPassword = async (pw) => String(pw) === ENC_PASSWORD;
  encStore.decryptTransform = () => new PassThrough(); // 桩：密文即明文，便于断言字节数

  // 假云端：headObject 报明文长度；getObject 把明文写进 Output。
  cloud = {
    headObject(_p, cb) { cb(null, { headers: { 'content-length': String(CONTENT.length) } }); },
    getObject(params, cb) {
      params.Output.end(CONTENT);
      cb(null, {});
    },
  };
  configStore.effectiveForBucket = () => ({
    bucket: 'tb', region: 'ap-guangzhou', provider: 'tencent', secretId: 'sid', secretKey: 'sk',
  });

  const shareStore = require(path.join(ROOT, 'server', 'share-store.js'));
  const shareRoutes = require(path.join(ROOT, 'server', 'share-routes.js'));

  const mk = (key) => shareStore.create({
    key, bucket: 'tb', region: 'ap-guangzhou', fileName: key.split('/').pop(), size: CONTENT.length,
    expiresHours: 0, maxDownloads: 0, password: null, paid: null, createdBy: 'tester',
  });
  const encLink = await mk(ENC_KEY);
  const plainLink = await mk(PLAIN_KEY);

  const srv = await serve('/', shareRoutes);
  try {
    /* ---- 正向对照：明文对象照常可下（守卫不得退化成「谁都下不了」） ---- */
    const ok1 = await request(srv.port, 'GET', '/s/' + plainLink.id + '/dl');
    assertEqual(ok1.status, 200, '明文对象的分享下载必须照常成功');
    assertMatch(ok1.raw, /DECRYPTED-PLAINTEXT/, '明文对象应拿到完整内容');

    /* ---- 核心：密文对象 + 无令牌 → 必须被拦，且**不消耗下载额度** ---- */
    const blocked = await request(srv.port, 'GET', '/s/' + encLink.id + '/dl');
    assertEqual(blocked.status, 303,
      `R21-01：无加密令牌时分享下载必须被拦下（旧实现直接解密下发），实际 ${blocked.status}`);
    assert(!/DECRYPTED-PLAINTEXT/.test(blocked.raw), 'R21-01：被拦的响应里绝不能出现明文');
    assertEqual(Number(shareStore.get(encLink.id).downloads), 0,
      'R21-01：没通过访问控制就不该扣下载次数（与付费拦截同一条纪律）');

    /* ---- HEAD 必须与 GET 看到同一结果（否则成了「能不能下」的探测口） ---- */
    const headBlocked = await request(srv.port, 'HEAD', '/s/' + encLink.id + '/dl');
    assertEqual(headBlocked.status, 303, 'R21-01：HEAD 与 GET 的门禁判定必须一致');
    assertEqual(String(headBlocked.headers.location || ''), '/s/' + encLink.id,
      'R21-01：被拦的 HEAD 应把人送回分享页（去输入加密访问密码）');

    /* ---- 分享页不得给出下载入口，而应给出「加密访问密码」表单 ---- */
    const page = await request(srv.port, 'GET', '/s/' + encLink.id);
    assertEqual(page.status, 200, '分享页本身应可访问（用于输入密码）');
    assert(/\/unlock/.test(page.raw), 'R21-01：分享页必须提供加密访问密码表单');
    assert(!new RegExp('/s/' + encLink.id + '/dl"').test(page.raw),
      'R21-01：未解锁前不得渲染下载入口');

    /* ---- 反向对照：带正确令牌（请求头）→ 放行 ---- */
    const ok2 = await request(srv.port, 'GET', '/s/' + encLink.id + '/dl', {
      headers: { 'x-enc-token': GOOD_TOKEN },
    });
    assertEqual(ok2.status, 200, 'R21-01：持有有效加密令牌时必须放行');
    assertMatch(ok2.raw, /DECRYPTED-PLAINTEXT/, 'R21-01：持令牌应拿到明文');

    /* ---- 分享侧解锁：正确密码 → 种 Cookie；带 Cookie 再下 → 放行 ---- */
    const unlock = await request(srv.port, 'POST', '/s/' + encLink.id + '/unlock', {
      body: { password: ENC_PASSWORD },
    });
    assertEqual(unlock.status, 303, `R21-01：解锁成功应 303 回分享页，实际 ${unlock.status}`);
    const setCookie = String(unlock.headers['set-cookie'] || '');
    assert(/ke_enc=/.test(setCookie), 'R21-01：解锁成功必须下发加密令牌 Cookie');
    assert(/HttpOnly/i.test(setCookie), 'R21-01：加密令牌 Cookie 必须是 HttpOnly');
    assert(/Path=\/s\//i.test(setCookie),
      'R21-01：加密令牌 Cookie 必须限定在 /s/ 作用域（不得进入 /api/**）');

    const cookie = setCookie.split(';')[0];
    const ok3 = await request(srv.port, 'GET', '/s/' + encLink.id + '/dl', { headers: { cookie } });
    assertEqual(ok3.status, 200, 'R21-01：持解锁 Cookie 时必须放行');
    assertMatch(ok3.raw, /DECRYPTED-PLAINTEXT/, 'R21-01：持 Cookie 应拿到明文');

    /* ---- 错误密码：不得解锁 ---- */
    const bad = await request(srv.port, 'POST', '/s/' + encLink.id + '/unlock', {
      body: { password: 'wrong-pw' },
    });
    assertEqual(bad.status, 401, `R21-01：密码错误应 401，实际 ${bad.status}`);
    assert(!/ke_enc=/.test(String(bad.headers['set-cookie'] || '')), 'R21-01：密码错误绝不能下发令牌');
  } finally {
    await srv.close();
  }
});

/* ==================================================================== */
/* R21-03 · 流式写入（WebDAV PUT）必须有并发上限                            */
/* ==================================================================== */

test('R21-03 · 流式写入并发不得超过信号量上限，且单个写入仍然正确', async () => {
  let inflight = 0;
  let maxInflight = 0;
  const bodies = [];
  cloud = {
    headObject(_p, cb) { cb(Object.assign(new Error('NoSuchKey'), { statusCode: 404, code: 'NoSuchKey' }), null); },
    putObject(params, cb) {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      bodies.push(params.Body.length);
      setTimeout(() => { inflight -= 1; cb(null, {}); }, 60);
    },
  };
  const fsGateway = require(path.join(ROOT, 'server', 'fs-gateway.js'));

  configStore.get = () => ({ provider: 'tencent', secretId: 'sid', secretKey: 'sk', bucket: 'tb', region: 'ap-guangzhou' });
  // 不加密，专注内存并发维度（加密副本那条路径另有上限）
  encStore.encryptBuffer = () => null;
  encStore.reconcileAfterWrite = () => {};

  const streamOf = (n) => Readable.from([Buffer.alloc(1024, n)]);

  /* ---- 正向对照：单个流式写入必须成功且字节数正确 ---- */
  const one = await fsGateway.writeObject('tb', 'w/single.bin', streamOf(7), 'application/octet-stream', null, null);
  assertEqual(one.bytesWritten, 1024, 'R21-03：单次流式写入的字节数必须正确');

  /* ---- 并发 5 个流式写入：同时在飞的必须 ≤ 上限（2） ---- */
  maxInflight = 0;
  await Promise.all([1, 2, 3, 4, 5].map((n) => fsGateway.writeObject('tb', 'w/c' + n + '.bin', streamOf(n), 'application/octet-stream', null, null)));
  assertEqual(bodies.length, 6, 'R21-03：6 次写入都应落到云端（含正向对照那一笔）');
  assert(maxInflight <= 2,
    `R21-03：流式写入的并发峰值必须被信号量钉住（上限 2），实际 ${maxInflight} —— `
    + '旧实现只有「单请求 128MB」上限，无并发闸门，N 个 PUT ≈ N×256MB 可把进程推入 OOM');
  assert(maxInflight > 1, 'R21-03：正向对照 —— 信号量不得退化成「完全串行/什么都不做」');
});

/* ==================================================================== */
/* R21-05 · Windows Hello 登录失败分支必须同形                              */
/* ==================================================================== */

test('R21-05 · 用户不存在 / 未启用 Hello 必须返回同一状态码与同一文案', async () => {
  configStore.findUserRaw = (u) => (u === 'exists-user' ? { id: 'u1', username: 'exists-user' } : null);
  configStore.isWebauthnEnabled = () => false; // 存在但未启用

  const authRoutes = require(path.join(ROOT, 'server', 'routes', 'auth.js'));
  const srv = await serve('/api', authRoutes);
  try {
    const a = await request(srv.port, 'POST', '/api/auth/login/webauthn', { body: { username: 'no-such-user' } });
    const b = await request(srv.port, 'POST', '/api/auth/login/webauthn', { body: { username: 'exists-user' } });

    assertEqual(a.status, b.status,
      `R21-05：两种分支的状态码必须相同（旧实现 401 vs 400），实际 ${a.status} vs ${b.status}`);
    assertEqual(a.status, 401, `R21-05：失败统一为 401，实际 ${a.status}`);
    assertEqual(a.raw, b.raw, 'R21-05：两种分支的文案必须逐字相同 —— 否则本端点成了用户名 oracle');
    assert(!/未启用|Windows Hello，请使用密码登录/.test(b.raw), 'R21-05：不得再回「该账户未启用 Windows Hello」这类可区分的文案');
  } finally {
    await srv.close();
  }
});

/* ==================================================================== */
/* R21-06 · notifyUrl 必须与实际下单渠道同源                                */
/* ==================================================================== */

test('R21-06 · 复用在途订单时，回调地址必须指向**订单原渠道**而非请求体渠道', async () => {
  const paymentRules = require(path.join(ROOT, 'server', 'payment-rules.js'));
  const paymentOrders = require(path.join(ROOT, 'server', 'payment-orders.js'));
  const paymentProviders = require(path.join(ROOT, 'server', 'payment-providers.js'));
  const paymentGateway = require(path.join(ROOT, 'server', 'payment-gateway.js'));

  paymentRules.snapshot = () => ({ enabled: true, states: { alipay: true, wechat: true }, configuredMap: { alipay: true, wechat: true }, available: ['alipay', 'wechat'] });
  paymentRules.resolvePaidState = () => ({ required: true, effective: true, amountFen: 100, currency: 'CNY', reason: '' });
  paymentProviders.isConfigured = () => true;

  const pendingOrder = { id: 'o-pending-1', linkId: '', platform: 'alipay', amountFen: 100, currency: 'CNY', status: 'pending' };
  paymentOrders.payerState = () => ({ state: 'pending', order: pendingOrder });

  const captured = [];
  paymentGateway.createCharge = async (platform, cfg, opts) => {
    captured.push({ platform, notifyUrl: opts.notifyUrl });
    return { ok: true, kind: 'redirect', url: 'https://example.invalid/pay' };
  };

  const shareStore = require(path.join(ROOT, 'server', 'share-store.js'));
  const shareRoutes = require(path.join(ROOT, 'server', 'share-routes.js'));

  const link = await shareStore.create({
    key: 'a.txt', bucket: 'tb', region: 'ap-guangzhou', fileName: 'a.txt', size: 10,
    expiresHours: 0, maxDownloads: 0, password: null,
    paid: { required: true, amountFen: 100, currency: 'CNY' }, createdBy: 'tester',
  });
  pendingOrder.linkId = link.id;

  const srv = await serve('/', shareRoutes);
  try {
    // 客户端提交的是**另一条**渠道（wechat）—— 两条都能通过 available 校验
    const r = await request(srv.port, 'POST', '/s/' + link.id + '/pay', { body: { platform: 'wechat' } });
    assertEqual(captured.length, 1, `应发起一次下单，实际 ${captured.length}（响应 ${r.status}）`);
    assertEqual(captured[0].platform, 'alipay', 'R21-06：复用在途订单必须沿用原渠道下单');
    assert(/\/pay\/notify\/alipay$/.test(captured[0].notifyUrl),
      `R21-06：回调地址必须与原渠道同源（旧实现用请求体的 wechat），实际 ${captured[0].notifyUrl}`);
  } finally {
    await srv.close();
  }
});

/* ==================================================================== */
/* R21-09 · 自助改密必须二次校验当前密码                                    */
/* ==================================================================== */

test('R21-09 · PUT /users/me 改密码必须先验证当前密码', async () => {
  const authSession = require(path.join(ROOT, 'server', 'auth-session.js'));
  authSession.destroyUserSessionsExcept = () => {};
  authSession.destroyUserSessions = () => {};
  configStore.verifyUserPassword = async (_id, pw) => pw === 'correct-pw';
  const updated = [];
  configStore.updateUser = async (id, patch) => { updated.push(patch); return { id, username: patch.username || 'tester', role: 'user' }; };

  const usersRoutes = require(path.join(ROOT, 'server', 'routes', 'users.js'));
  const srv = await serve('/api', usersRoutes, (req, _res, next) => {
    req.authUser = { id: 'u1', username: 'tester', role: 'user' };
    req.sessionToken = 't';
    next();
  });
  try {
    /* ---- 缺当前密码 → 400（旧实现直接改密成功） ---- */
    const miss = await request(srv.port, 'PUT', '/api/users/me', {
      body: { password: 'new-password-1', confirmPassword: 'new-password-1' },
    });
    assertEqual(miss.status, 400, `R21-09：缺当前密码必须被拒，实际 ${miss.status}`);
    assertEqual(updated.length, 0, 'R21-09：未通过校验前绝不能落库');

    /* ---- 当前密码错误 → 403 ---- */
    const bad = await request(srv.port, 'PUT', '/api/users/me', {
      body: { password: 'new-password-1', confirmPassword: 'new-password-1', currentPassword: 'nope' },
    });
    assertEqual(bad.status, 403, `R21-09：当前密码错误必须被拒，实际 ${bad.status}`);
    assertEqual(updated.length, 0, 'R21-09：当前密码错误时绝不能改密');

    /* ---- 正向对照：当前密码正确 → 成功 ---- */
    const ok = await request(srv.port, 'PUT', '/api/users/me', {
      body: { password: 'new-password-1', confirmPassword: 'new-password-1', currentPassword: 'correct-pw' },
    });
    assertEqual(ok.status, 200, `R21-09：校验通过后必须成功，实际 ${ok.status} ${ok.raw}`);
    assertEqual(updated.length, 1, 'R21-09：校验通过后应落库一次');
    assertEqual(updated[0].password, 'new-password-1', 'R21-09：落库的必须是新密码');

    /* ---- 正向对照：只改用户名（不动凭据）→ 不需要当前密码 ---- */
    const onlyName = await request(srv.port, 'PUT', '/api/users/me', { body: { username: 'renamed' } });
    assertEqual(onlyName.status, 200, `R21-09：不涉及凭据的改名不应被拦，实际 ${onlyName.status}`);
  } finally {
    await srv.close();
  }
});

/* ==================================================================== */
/* R21-10 · 抢锁不得在「内容未落盘」窗口里接管活锁                            */
/* ==================================================================== */

test('R21-10 · 新鲜的空锁文件不得被接管；陈旧残留才可以', async () => {
  const LOCK = path.join(ROOT, 'server', 'instance-lock.js');
  const lockFile = path.join(tmp.dir, '.instance.lock');
  const fresh = () => {
    delete require.cache[require.resolve(LOCK)];
    return require(LOCK);
  };

  /* ---- 正向对照：没有锁文件 → 正常拿到 ---- */
  try { fs.unlinkSync(lockFile); } catch (e) { /* 不存在 */ }
  const a = fresh().acquire();
  assertEqual(a.ok, true, 'R21-10：无锁时应能获取');
  fresh().release();

  /* ---- 核心：刚创建、内容还没落盘的空锁 → 绝不能被接管 ---- */
  fs.writeFileSync(lockFile, '');
  const b = fresh().acquire();
  assertEqual(b.ok, false,
    'R21-10：新鲜的空锁必须按「有人正在建」处理 —— 旧实现 unlink 后接管，'
    + '会让两个进程同时认为持锁，config.enc 被交替覆盖');
  assertEqual(fs.readFileSync(lockFile, 'utf8'), '',
    'R21-10：被拒时绝不能删掉/覆盖别人的锁文件');

  /* ---- 反向对照：确实是崩溃残留（够旧）→ 允许接管 ---- */
  const old = new Date(Date.now() - 60 * 1000);
  fs.utimesSync(lockFile, old, old);
  const c = fresh().acquire();
  assertEqual(c.ok, true, 'R21-10：陈旧的内容损坏锁必须仍可接管（否则一次崩溃就永久起不来）');
  fresh().release();

  /* ---- 反向对照：持有者进程已死 → 即使新鲜也允许接管 ---- */
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, startedAt: new Date().toISOString() }));
  const d = fresh().acquire();
  assertEqual(d.ok, true, 'R21-10：pid 已死的锁必须可接管（该判定不受宽限期影响）');
  fresh().release();

  try { fs.unlinkSync(lockFile); } catch (e) { /* ignore */ }
});

/* ==================================================================== */
/* R21-11 · 缓存键分隔符不可被请求参数注入                                   */
/* ==================================================================== */

test('R21-11 · 含分隔符的参数不得再拼出同一个缓存键（列举缓存 / 搜索候选集）', async () => {
  const listCache = require(path.join(ROOT, 'server', 'list-cache.js'));
  const searchCandidates = require(path.join(ROOT, 'server', 'search-candidates.js'));

  listCache.clear();
  searchCandidates.clear();

  /* ---- 列举缓存：('a', 'b\0c') 与 ('a\0b', 'c') 旧实现拼出同一键 ---- */
  const k1 = listCache.keyOf('bk', 'a', 'b\u0000c', 100, '/', 'list');
  const k2 = listCache.keyOf('bk', 'a\u0000b', 'c', 100, '/', 'list');
  assert(k1 !== k2, `R21-11：两组不同的列举参数不得拼出同一个缓存键（旧实现均为 ${JSON.stringify(k1)}）`);

  listCache.set(k1, { payload: 'A' });
  assertEqual(listCache.get(k2), null,
    'R21-11：另一组参数不得命中前一组写入的缓存条目（进程级共享缓存会串味）');
  assertEqual((listCache.get(k1) || {}).payload, 'A', 'R21-11：正向对照 —— 同一组参数必须仍能命中');

  /* ---- 搜索候选集：同型（prefix / scope 可被 \0 拼接） ---- */
  const s1 = searchCandidates.keyOf('ident', 'a', 'b\u0000c');
  const s2 = searchCandidates.keyOf('ident', 'a\u0000b', 'c');
  assert(s1 !== s2, 'R21-11：搜索候选集的键同样不得被 \\u0000 拼接混淆');

  searchCandidates.put(s1, { items: [{ key: 'x' }], at: Date.now(), ident: 'ident', prefix: 'a', scope: 'b\u0000c' });
  assertEqual(searchCandidates.get(s2), null, 'R21-11：搜索候选集也不得互相命中');
  assert(searchCandidates.get(s1), 'R21-11：正向对照 —— 同一组参数必须仍能命中');
});

/* ==================================================================== */
/* R21-12 · 出站请求不得自动跟随重定向                                       */
/* ==================================================================== */

test('R21-12 · S3 客户端遇到 3xx 必须拒绝跟随（防盲 SSRF），正常响应不受影响', async () => {
  const { S3Client } = require(path.join(ROOT, 'server', 's3-client.js'));
  const calls = [];
  let mode = 'redirect';
  let port = 0;
  const server = http.createServer((req, res) => {
    calls.push(req.url);
    if (mode === 'redirect') {
      // 真实世界的目标会是 `http://169.254.169.254/latest/meta-data/`；这里指向
      // **本机伪服务的另一个路径**，好处是「跟随了没有」可以被 `calls` 直接数出来
      // （指向元数据地址时第二次请求不会落到本服务，判断不出有没有跟随）。
      res.writeHead(302, { Location: 'http://127.0.0.1:' + port + '/followed' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    res.end('<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>bkt</Name><IsTruncated>false</IsTruncated></ListBucketResult>');
  });
  port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

  const client = new S3Client({
    provider: 's3', secretId: 'AKID', secretKey: 'sk-secret-secret-secret-secret',
    region: 'us-east-1', endpoint: 'http://localhost:' + port + '/s3', bucket: 'bkt',
  });

  try {
    /* ---- 核心：302 到元数据地址 → 必须报错，且不得发起第二次请求 ---- */
    const before = calls.length;
    let err = null;
    try {
      await new Promise((resolve, reject) => {
        client.getBucket({ Bucket: 'bkt', Region: 'us-east-1' }, (e, d) => (e ? reject(e) : resolve(d)));
      });
    } catch (e) { err = e; }
    assert(err, 'R21-12：遇到重定向必须抛错（不得静默跟随）');
    assertEqual(err.code, 'RedirectNotAllowed', `R21-12：错误码应为 RedirectNotAllowed，实际 ${err && err.code}`);
    assertEqual(err.statusCode, 502, 'R21-12：应归类为上游故障（502），而不是折叠成 200/500');
    assert(/重定向/.test(String(err.message)), 'R21-12：错误文案必须说明「拒绝跟随重定向」');
    assertEqual(calls.length - before, 1,
      'R21-12：绝不能跟随到 Location（第二次请求就是打向内网的那一次）');

    /* ---- 正向对照：正常 2xx 响应必须照常解析 ---- */
    mode = 'ok';
    const out = await new Promise((resolve, reject) => {
      client.getBucket({ Bucket: 'bkt', Region: 'us-east-1' }, (e, d) => (e ? reject(e) : resolve(d)));
    });
    assert(out, 'R21-12：正向对照 —— 正常响应必须能解析（守卫不得退化成「全都失败」）');
    assertEqual(Array.isArray(out.Contents) ? out.Contents.length : 0, 0, 'R21-12：正向对照 —— 空桶应解析出 0 个对象');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('R21-12 · 支付网关遇到 3xx 必须当「未确认」处理，绝不判为已支付', async () => {
  const paymentGateway = require(path.join(ROOT, 'server', 'payment-gateway.js'));
  const realFetch = global.fetch;
  const seenInits = [];
  let metadataHits = 0; // 被引向元数据地址的请求次数 —— 「有没有跟随」的唯一可观测证据
  let mode = 'redirect';

  global.fetch = async (url, init) => {
    seenInits.push(init || {});
    if (String(url).includes('169.254.169.254')) {
      metadataHits += 1;
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (mode === 'redirect') {
      return new Response('', { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } });
    }
    if (String(url).includes('/v1/oauth2/token')) {
      return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ id: 'ORDER1', status: 'COMPLETED' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const cfg = { mode: 'live', clientId: 'cid', clientSecret: 'sec' };
  const order = { id: 'local-1', tradeNo: 'ORDER1', amountFen: 100, currency: 'CNY' };
  try {
    const blocked = await paymentGateway.queryCharge('paypal', cfg, order);
    assertEqual(blocked.paid, false, 'R21-12：出现重定向时绝不能判为已支付（fail-closed）');
    assertEqual(blocked.state, 'error', `R21-12：应归为「未确认」，实际 ${blocked.state}`);
    assert(seenInits.length > 0 && seenInits.every((i) => i.redirect === 'manual'),
      'R21-12：出站请求必须显式声明 redirect: "manual"');
    assertEqual(metadataHits, 0,
      'R21-12：绝不能真的把请求打到 Location 指向的元数据地址（默认 follow 会打）；'
      + '这一条也是「撤掉修复必须变红」的关键观察量');

    /* ---- 正向对照：正常响应仍应能判定为已支付 ---- */
    mode = 'ok';
    const paid = await paymentGateway.queryCharge('paypal', cfg, order);
    assertEqual(paid.paid, true, 'R21-12：正向对照 —— 正常链路必须仍能判定已支付');
    assertEqual(paid.state, 'paid', 'R21-12：正向对照 —— 状态应为 paid');
  } finally {
    global.fetch = realFetch;
  }
});

/* ==================================================================== */
/* R21-13 · HTTPS 跳转目标不得落到通配绑定地址                               */
/* ==================================================================== */

test('R21-13 · HOST=0.0.0.0 时跳转目标优先取站点域名，而不是不可解析的通配地址', async () => {
  const SEC = path.join(ROOT, 'server', 'security.js');
  const realLoad = configStore.load;
  const savedHost = process.env.HOST;

  const withHost = (h, domains) => {
    configStore.load = () => ({ domains: domains || {} });
    process.env.HOST = h;
    delete require.cache[require.resolve(SEC)];
    return require(SEC);
  };

  try {
    /* ---- 正向对照：普通部署 HOST（非通配）→ 直接用 HOST ---- */
    const normal = withHost('storage.example.com', {});
    assertEqual(normal.httpsRedirectHost('attacker.example').host, 'storage.example.com',
      'R21-13：非通配 HOST 时回退目标应为 HOST 本身');

    /* ---- 核心：HOST=0.0.0.0 且配置了站点域名 → 取域名 ---- */
    const withDomain = withHost('0.0.0.0', { primary: 'cloud.example.com' });
    const pick = withDomain.httpsRedirectHost('attacker.example');
    assertEqual(pick.host, 'cloud.example.com',
      'R21-13：Docker 默认 HOST=0.0.0.0 时，跳转目标必须优先取站点域名（旧实现 301 到 https://0.0.0.0:3443/…）');
    assertEqual(pick.fallbackToBindAll, false, 'R21-13：取到域名时不应触发告警分支');

    /* ---- 请求 Host 本身是通配地址 → 同样不得用它 ---- */
    const sameBindAll = withHost('0.0.0.0', { primary: 'cloud.example.com' });
    assertEqual(sameBindAll.httpsRedirectHost('0.0.0.0:3000').host, 'cloud.example.com',
      'R21-13：请求 Host 是 0.0.0.0 时也不得作为跳转目标');

    /* ---- 无站点域名 → 保留 HOST 并标记告警（可诊断性优于静默不跳） ---- */
    const noDomain = withHost('0.0.0.0', {});
    const warn = noDomain.httpsRedirectHost('attacker.example');
    assertEqual(warn.host, '0.0.0.0', 'R21-13：无域名可退时应保留原行为');
    assertEqual(warn.fallbackToBindAll, true, 'R21-13：必须置告警标记，让调用方留痕');

    /* ---- 允许的请求 Host 优先于域名（同源请求不该被改写到别的域名） ---- */
    const preferRaw = withHost('0.0.0.0', { primary: 'cloud.example.com' });
    assertEqual(preferRaw.httpsRedirectHost('cloud.example.com').host, 'cloud.example.com',
      'R21-13：被允许的请求 Host 必须优先');
    assertEqual(preferRaw.httpsRedirectHost('public.example.com').host, 'cloud.example.com',
      'R21-13：未配置的请求 Host 不得被信任（开放重定向）');
  } finally {
    configStore.load = realLoad;
    if (savedHost === undefined) delete process.env.HOST; else process.env.HOST = savedHost;
    delete require.cache[require.resolve(SEC)];
    require(SEC); // 复原：后续文件/用例拿到的是绑定原始 HOST 的实例
  }
});

/* ==================================================================== */
/* R21-14 · WebDAV 错误响应不得回显上游原始 message                          */
/* ==================================================================== */

test('R21-14 · 上游原始 message 不得出现在 WebDAV 响应里，本地校验文案保留', async () => {
  const webdav = require(path.join(ROOT, 'server', 'webdav-server.js'));
  const f = webdav.__davErrorMessage;
  assert(typeof f === 'function', 'R21-14：应导出可驱动的错误文案函数');

  /* ---- 核心：上游错误（带 statusCode）→ 只回分类文案 ---- */
  const upstream = Object.assign(new Error('RequestId=abc123 Endpoint=cos.ap-guangzhou.myqcloud.com AccessKeyId=AKIDxxxx'), { statusCode: 403, code: 'SignatureDoesNotMatch' });
  const msg = f(upstream);
  assert(!/RequestId|AKIDxxxx|myqcloud/.test(msg),
    `R21-14：不得回显上游原始串（请求 ID / 端点 / 密钥片段），实际 ${msg}`);
  assertMatch(msg, /签名错误/, 'R21-14：应给出分类化文案');

  /* ---- 经 translateError 包过的错误（带 rawMessage）→ 同样不得回显原文 ---- */
  const wrapped = cos.translateError(Object.assign(new Error('RAW-UPSTREAM-INTERNALS'), { statusCode: 500 }));
  const msg2 = f(wrapped);
  assert(!/RAW-UPSTREAM-INTERNALS/.test(msg2), 'R21-14：rawMessage 只能留在服务端日志里');

  /* ---- 正向对照：本进程生成的校验文案必须原样保留（诊断价值） ---- */
  const local = Object.assign(new Error('Range 格式无效'), { status: 400 });
  assertEqual(f(local), 'Range 格式无效', 'R21-14：本地校验错误不含上游信息，应原样透出');
});

/* ==================================================================== */
/* R21-15 · 跳过清单与仓库状态一致                                          */
/* ==================================================================== */

test('R21-15 · SCAN-SKIPLIST 的版本号与文档引用必须与仓库一致', async (t) => {
  const listPath = path.join(ROOT, 'SCAN-SKIPLIST.md');
  /**
   * R22 复核：`SCAN-SKIPLIST.md` 是**未纳入 git 的工作区文件**（属仓库管理决策，用户已
   * 明确不计入版本控制），因此它完全可能不存在。此时「清单与仓库一致」这一命题无从判定 ——
   * 直接跳过，而不是把「文件缺失」误报成回归（它还会连带把 `tests/invariants.test.js` 的
   * 「反向变异 anchor 必须命中」也一起拖红，把一条真实护栏的失效藏在环境噪音里）。
   * 文件存在时，下面的断言照旧生效。
   */
  if (!fs.existsSync(listPath)) {
    t.skip('SCAN-SKIPLIST.md 不在工作区（该清单不纳入 git）—— 「清单与仓库一致」无从判定');
    return;
  }
  const src = fs.readFileSync(listPath, 'utf8');
  const pkgVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

  const m = src.match(/^\s*-\s*项目：`object-manager`\s*v([0-9.]+)\s*$/m);
  assert(m, 'R21-15：SCAN-SKIPLIST 必须声明项目版本（形如「- 项目：`object-manager` v1.2.3」）');
  assertEqual(m[1], pkgVersion,
    `R21-15：跳过清单里的版本号必须与 package.json 一致（否则读者不知道这份清单对应哪个构建）`);

  /* 清单里引用到的每个 .md 都必须真实存在 —— R17 那份「不存在的报告」曾让后续轮次按图索骥 */
  const refs = new Set();
  for (const mm of src.matchAll(/`([^`\n]+\.md)`/g)) refs.add(mm[1]);
  const missing = [...refs].filter((r) => !fs.existsSync(path.join(ROOT, r)));
  assertEqual(missing.length, 0,
    `R21-15：跳过清单引用了不存在的文档：${missing.join('、')}（后续轮次会照着找不到的文件查证据）`);
});

/* ============================ 收尾 ============================ */

test.after(async () => {
  try { await require(path.join(ROOT, 'server', 'secure-store.js')).flush(); } catch (e) { /* ignore */ }
  tmp.cleanup();
});
