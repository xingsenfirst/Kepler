/**
 * 第二十八轮审计护栏（R28-01 ~ R28-06）
 *
 * 本轮是**第二轮审计**（`审计报告-第二轮.md`，发现 A-01~A-06）的修复。它们有一个共同点：
 * 修的都是**上一轮（R27）或更早**留下的「说一套做一套」—— 要么修复只覆盖了一半路径，
 * 要么护栏断言的是生产路径上不可能出现的状态。因此本文件的取向是：
 *
 *  - 能用**行为**验证的绝不写成源码锚点（A-01 / A-03 / A-05 / A-06 都是行为断言）；
 *  - 每条都配**正向对照**（合法上传仍放行、普通 API 仍压缩、正常锁仍能获取），
 *    防「一律拒绝」这类把功能改死的假修复；
 *  - A-03 的护栏刻意走**真实 HTTP 请求**：上一轮它正是「拿合成 res 调纯函数」才假绿的。
 *
 * 覆盖：
 *  - R28-01 IPv6 屏蔽规则经「落盘 → 重新加载」后仍必须命中（Buffer 缓存不得被持久化）
 *  - R28-02 单桶配额必须在所有写入出口生效；且不得被被约束者自行调大（权限）
 *  - R28-03 真实 Range 请求的 206 响应不得被 gzip
 *  - R28-04 存量密钥文件权限自愈 / 弱签名证书重新签发
 *  - R28-05 陈旧锁接管期间，第三个实例不得趁「锁文件缺席」抢到锁
 *  - R28-06 不可解析地址在 /api 下的 403 文案必须可辨因
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const test = require('node:test');
const { assert, assertEqual, ROOT } = require('./helpers');

const R = (...p) => path.join(ROOT, ...p);
const readSrc = (...p) => fs.readFileSync(R(...p), 'utf8');
const freshRequire = (rel) => {
  const p = R(rel);
  delete require.cache[require.resolve(p)];
  return require(p);
};

/* ================================================================== *
 * R28-01 · IPv6 屏蔽规则的持久化往返
 * ================================================================== */

test('R28-01 · IPv6 屏蔽规则经「落盘 → 重新加载」后仍必须命中', () => {
  const ig = freshRequire('server/ip-guard.js');

  // 两条规则：一条 IPv4、一条 IPv6 —— 后者曾因 `_parsed.bytes` 被 JSON 退化成普通对象而失效
  ig.addRule({ target: '203.0.113.7', remark: 'r28-v4' });
  ig.addRule({ target: '2001:db8::/32', remark: 'r28-v6' });

  // ① 同进程内：两条都必须拦
  assertEqual(ig.evaluate('203.0.113.7', 'GET', null).ok, false, '前置：IPv4 规则应命中');
  assertEqual(ig.evaluate('2001:db8::1', 'GET', null).ok, false, '前置：IPv6 规则应命中');

  // ② 落盘形态：派生缓存 `_parsed` **不得**被写进文件（它是 Buffer，JSON 往返必坏）
  const store = freshRequire('server/config-store.js');
  const raw = JSON.parse(fs.readFileSync(path.join(process.env.COS_DATA_DIR, 'ipguard.json'), 'utf8'));
  const onDisk = store.decrypt(raw.data);
  for (const r of onDisk.rules) {
    assertEqual(Object.prototype.hasOwnProperty.call(r, '_parsed'), false,
      `R28-01：规则 ${r.target} 的派生缓存 _parsed 不得被持久化（IPv6 的 bytes 是 Buffer，`
      + 'JSON 往返后变成 {type:"Buffer",data:[…]}，而 load() 只按 text 判断复用 → 坏缓存被一直使用）');
  }

  // ③ 模拟重启：重新加载后两条仍须命中（IPv6 是本次修复的目标）
  const ig2 = freshRequire('server/ip-guard.js');
  assertEqual(ig2.evaluate('203.0.113.7', 'GET', null).ok, false,
    'R28-01 正向对照：IPv4 规则在重载后仍须命中');
  const v6 = ig2.evaluate('2001:db8::1', 'GET', null);
  assertEqual(v6.ok, false,
    'R28-01：IPv6 屏蔽规则在进程重启后**必须仍然命中** —— 旧实现下它会静默失效'
    + '（规则列表里显示已启用、命中计数恒为 0，但流量畅通）');

  // ④ 对外视图同样不得回传派生缓存（16 字节数组回显给前端没有意义）
  for (const r of ig2.listRules()) {
    assertEqual(Object.prototype.hasOwnProperty.call(r, '_parsed'), false,
      'R28-01：listRules() 不得回传 _parsed');
  }
  for (const r of ig2.view().rules) {
    assertEqual(Object.prototype.hasOwnProperty.call(r, '_parsed'), false,
      'R28-01：view() 不得回传 _parsed');
  }
});

/* ================================================================== *
 * R28-02 · 单桶配额闸门
 * ================================================================== */

test('R28-02 · 单桶配额必须由服务端强制（且两层闸门都在写入出口上）', () => {
  const bs = require(R('server', 'bucket-stats.js'));
  assertEqual(typeof bs.assertBucketQuota, 'function',
    'R28-02：必须提供 assertBucketQuota（单桶配额闸门）');
  assertEqual(bs.BUCKET_QUOTA_EXCEEDED_CODE, 'BUCKET_QUOTA_EXCEEDED',
    'R28-02：机器可读码必须是 BUCKET_QUOTA_EXCEEDED（与前端 util.js 的同名常量一致）');

  // 前端常量必须与服务端同源（R25-08 记过「两处字面量漂移 → 弹窗永不触发」）
  const util = readSrc('public', 'js', 'util.js');
  assert(/BUCKET_QUOTA_EXCEEDED_CODE\s*=\s*'BUCKET_QUOTA_EXCEEDED'/.test(util),
    'R28-02：前端 util.js 的码必须与服务端一致');
  assert(/BUCKET_QUOTA_EXCEEDED_CODE/.test(readSrc('public', 'js', 'upload.js')),
    'R28-02：上传失败分支必须把桶级配额一并当配额错误处理（否则只弹通用 toast）');

  // 所有写入出口两处闸门并列（凭据级 + 桶级）
  const fsSrc = readSrc('server', 'routes', 'fs.js');
  const wdSrc = readSrc('server', 'webdav-server.js');
  const countFs = (fsSrc.match(/await assertBucketQuota\(/g) || []).length;
  const countWd = (wdSrc.match(/assertBucketQuota\(/g) || []).length;
  assertEqual(countFs, 5,
    'R28-02：/fs 的 5 个写入口（mkdir / upload/simple / upload/init / rename / move）'
    + `都必须过桶级闸门，实际 ${countFs} 处`);
  assertEqual(countWd, 4,
    'R28-02：WebDAV 的 4 个写入口（PUT 目录 / PUT 文件 / MKCOL / COPY·MOVE）'
    + `都必须过桶级闸门，实际 ${countWd} 处`);

  // 被约束者不得自行调大自己的上限（否则闸门自带解除按钮）
  const bkSrc = readSrc('server', 'routes', 'buckets.js');
  assert(/if \(k !== 'remark'\) delete b\[k\];/.test(bkSrc),
    'R28-02：非管理员的桶字段白名单必须只剩 remark —— quotaBytes 现在是**强制执行的限额**，'
    + '允许被约束者自行调大等于闸门形同虚设');
});

test('R28-02 · 桶配额判据：严格大于才拒、0 表示无限制、待定增量参与判定', async () => {
  const bs = require(R('server', 'bucket-stats.js'));
  // 无上限（0 / 非法值）直接放行，且不触云端
  assertEqual(await bs.assertBucketQuota({}, { bucket: 'b', quotaBytes: 0 }, { addBytes: 1e12 }), null,
    'R28-02：quotaBytes = 0 必须视为无限制（不得拦）');
  assertEqual(await bs.assertBucketQuota({}, { bucket: 'b', quotaBytes: -1 }, { addBytes: 1e12 }), null,
    'R28-02：非法配额同样归 0（与 normalizeQuotaBytes 同口径）');

  /**
   * 有上限时的行为判定：**预先塞满桶容量缓存**，这样 `bucketStat()` 直接命中缓存、
   * 一次云端调用都不发生（否则单测会去打真实存储）。判定走的是生产同一函数。
   */
  const cfg = { provider: 'tencent', secretId: 'AKIDr28', bucket: 'r28-quota', region: 'ap-guangzhou', quotaBytes: 1000 };
  const seedSize = (sizeBytes) => bs.bucketSizeCache.set(bs.bucketCacheKey(cfg), {
    sizeBytes, objectCount: 1, estimated: false, source: 'test', t: Date.now(),
  });
  const takeErr = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

  seedSize(900);
  const full = await bs.assertBucketQuota({}, cfg, { addBytes: 100 });
  assert(full && full.usedBytes === 900 && full.quotaBytes === 1000,
    '前置：900 + 100 正好用满，必须放行（严格大于才拒）');
  let e = await takeErr(() => bs.assertBucketQuota({}, cfg, { addBytes: 101 }));
  assert(e, 'R28-02：900 + 101 超过上限 1000，必须拒绝');
  assertEqual(e.status, 403, 'R28-02：桶级超限必须是 403');
  assertEqual(e.code, bs.BUCKET_QUOTA_EXCEEDED_CODE,
    'R28-02：必须带机器可读码（前端据此弹「超出存储桶容量配额」对话框，而不是通用 toast）');
  assertEqual(e.quota && e.quota.scope, 'bucket', 'R28-02：明细里必须标明作用层级（bucket）');
  assertEqual(e.quota && e.quota.quotaBytes, 1000, 'R28-02：明细里必须含上限');
  assertEqual(e.quota && e.quota.usedBytes, 900, 'R28-02：明细里必须含已用量');

  // 待定增量必须参与判定（否则 15 分钟统计缓存期内可以随便超额）
  seedSize(900);
  bs.recordUsageDelta(cfg, 150);
  e = await takeErr(() => bs.assertBucketQuota({}, cfg, { addBytes: 0 }));
  assert(e, 'R28-02：待定增量（900 + 150 > 1000）必须计入判定 —— 只读缓存会让 TTL 窗口变成超额窗口');
  assertEqual(e.quota && e.quota.usedBytes, 1050, 'R28-02：判定口径 = 缓存值 + 待定增量');

  // 正向对照：清掉增量后同一状态必须放行（护栏不得退化成「一律拒绝」）
  bs.recordUsageDelta(cfg, -150);
  seedSize(900);
  const ok = await bs.assertBucketQuota({}, cfg, { addBytes: 0 });
  assert(ok && ok.usedBytes === 900, 'R28-02 正向对照：未超限时必须放行');
});

test('R28-02 · 端到端：真实 /fs 路由在桶配额超限时必须 403（且写请求不会打到云端）', async () => {
  const express = require(R('node_modules', 'express'));
  const cs = require(R('server', 'config-store.js'));
  const bs = require(R('server', 'bucket-stats.js'));

  // 一个「已超额」的桶：上限 1000，缓存里已有 2000（预置缓存 → 判定不触云端）
  await cs.addUser({ username: 'r28admin', password: 'Passw0rd!x', role: 'admin', permissions: {} });
  const cred = cs.addCredential({ provider: 'tencent', secretId: 'AKIDr28e2e', secretKey: 'sk', quotaBytes: 0, enabled: true, visibleToUsers: true });
  cs.addBucket({ provider: 'tencent', bucket: 'r28-e2e', region: 'ap-guangzhou', remark: '', quotaBytes: 1000, credentialId: cred.id, visibleToUsers: true, enabled: true });
  const cfg = cs.get();
  assertEqual(cfg.bucket, 'r28-e2e', '前置：刚添加的桶应是当前生效桶');
  assertEqual(cfg.quotaBytes, 1000, '前置：生效配置必须带上桶配额（闸门据此判定）');
  bs.bucketSizeCache.set(bs.bucketCacheKey(cfg), { sizeBytes: 2000, objectCount: 2, estimated: false, source: 'test', t: Date.now() });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.authUser = { id: 'u1', username: 'r28admin', role: 'admin' }; next(); });
  app.use('/api', require(R('server', 'routes', 'fs.js')));
  const srv = app.listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const port = srv.address().port;

  try {
    // ① mkdir（addBytes=0）在「已超额」时必须被桶级闸门拦下
    const res = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ path: 'r28dir/' });
      const req = http.request({
        host: '127.0.0.1', port, method: 'POST', path: '/api/fs/mkdir',
        headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) },
      }, (r) => {
        const bufs = []; r.on('data', (d) => bufs.push(d));
        r.on('end', () => resolve({ status: r.statusCode, json: (() => { try { return JSON.parse(Buffer.concat(bufs).toString('utf8')); } catch (e) { return null; } })() }));
      });
      req.on('error', reject);
      req.end(body);
    });
    assertEqual(res.status, 403,
      'R28-02：桶配额已超额时，真实 /fs/mkdir 必须回 403（此前该字段只展示、零拦截）—— '
      + '实际 ' + JSON.stringify(res));
    assertEqual(res.json && res.json.code, bs.BUCKET_QUOTA_EXCEEDED_CODE,
      'R28-02：响应体必须带 code（前端据此弹「超出存储桶容量配额」对话框）');
    assert(res.json && res.json.quota && res.json.quota.scope === 'bucket',
      'R28-02：响应体必须带结构化明细（含 scope=bucket）');
  } finally {
    srv.close();
  }
});

/* ================================================================== *
 * R28-03 · 206 区间响应不得压缩（真实请求路径）
 * ================================================================== */

test('R28-03 · 真实 Range 请求的 206 响应不得被 gzip（旧护栏用合成 res 断言 → 假绿）', async () => {
  const express = require(R('node_modules', 'express'));
  const { gzipMiddleware } = require(R('server', 'gzip.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r28-03-'));
  const body = 'x'.repeat(5000);
  fs.writeFileSync(path.join(dir, 'big.js'), body);

  const app = express();
  app.use(gzipMiddleware);            // 与 index.js 同序：中间件在路由/静态之前
  app.use(express.static(dir));
  const srv = app.listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const port = srv.address().port;

  const get = (headers) => new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/big.js', headers }, (res) => {
      const bufs = [];
      res.on('data', (d) => bufs.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(bufs) }));
    });
    req.on('error', reject);
  });

  try {
    // ① Range + Accept-Encoding: gzip → 必须仍是**未编码**的 1024 字节
    const ranged = await get({ Range: 'bytes=0-1023', 'Accept-Encoding': 'gzip' });
    assertEqual(ranged.status, 206, '前置：Range 请求应得到 206');
    assertEqual(ranged.headers['content-encoding'] || '', '',
      'R28-03：206 区间响应**不得**带 Content-Encoding —— 否则 Content-Range（按未压缩实体描述）'
      + '与编码后的实体长度互相打架；实际响应头 ' + JSON.stringify({
        ce: ranged.headers['content-encoding'], cl: ranged.headers['content-length'], cr: ranged.headers['content-range'],
      }));
    assertEqual(ranged.body.length, 1024, 'R28-03：区间正文必须是未压缩的 1024 字节');

    // ② 正向对照：同一路径不带 Range 仍必须被压缩（护栏不得退化成「一律不压」）
    const full = await get({ 'Accept-Encoding': 'gzip' });
    assertEqual(full.status, 200, '前置：无 Range 时应得 200');
    assertEqual(full.headers['content-encoding'], 'gzip',
      'R28-03 正向对照：普通静态资源仍必须压缩（压缩收益是引入本中间件的初衷）');
    assert(full.body.length < body.length, 'R28-03 正向对照：压缩后应显著更小');
  } finally {
    srv.close();
  }
});

/* ================================================================== *
 * R28-04 · 存量文件的权限 / 弱签名自愈
 * ================================================================== */

test('R28-04 · 存量密钥文件权限必须在读取路径上自愈（R27-13 只覆盖新建）', () => {
  const atomic = require(R('server', 'atomic-write.js'));
  assertEqual(typeof atomic.ensurePrivateModeSync, 'function',
    'R28-04：必须提供确保私有权限的自愈函数');
  // 三个密钥/凭据文件都以它收口
  assert(/ensurePrivateModeSync\(KEY_FILE\)/.test(readSrc('server', 'config-store.js')),
    'R28-04：config-store 读 secret.key 时必须自愈权限');
  assert(/ensurePrivateModeSync\(KEY_FILE\)/.test(readSrc('server', 'enc-store.js')),
    'R28-04：enc-store 读 enc.key 时必须自愈权限');
  assert(/ensurePrivateModeSync\(CERT_FILE\)/.test(readSrc('server', 'local-cert.js')),
    'R28-04：local-cert 读缓存证书时必须自愈权限');
  // Windows 上 POSIX 位无意义 → 不得反复 chmod（也不得因此报错）
  assert(/process\.platform === 'win32'/.test(readSrc('server', 'atomic-write.js')),
    'R28-04：必须跳过 Windows（stat.mode 不表示 POSIX 权限位）');
});

test('R28-04 · 缓存证书为弱签名（SHA-1）时必须重新签发，而不是继续用满 820 天', () => {
  const lc = require(R('server', 'local-cert.js'));
  assertEqual(typeof lc.isWeakSignature, 'function', 'R28-04：必须能判定缓存证书的签名算法');
  assertEqual(lc.isWeakSignature('not-a-cert'), true,
    'R28-04：解析不了时按「弱签名」处理（宁可多签一次，也不能继续用 SHA-1）');
  /**
   * 判据只能来自证书自身的 DER。`crypto.X509Certificate#signatureAlgorithm`
   * 在 Node 18 / 20 / 22 上**不存在**（`toLegacyObject()` 里也没有）→ 取到 `undefined`
   * → `/sha1/i.test('')` 恒 false → 该函数对任何能解析的证书都返回 false，
   * 「重签弱签名证书」的分支永远不可达。本条静态断言就是为了堵住这种假修复。
   */
  assert(!/\.signatureAlgorithm\b/.test(readSrc('server', 'local-cert.js')),
    'R28-04：不得用 X509Certificate#signatureAlgorithm 判签名算法（Node 18/20/22 无此属性 → 判据恒 false）');
  const crypto = require('crypto');
  const selfsigned = require(R('node_modules', 'selfsigned'));
  const good = selfsigned.generate([{ name: 'commonName', value: 'localhost' }], { days: 1, keySize: 2048, algorithm: 'sha256' });
  const bad = selfsigned.generate([{ name: 'commonName', value: 'localhost' }], { days: 1, keySize: 2048 }); // selfsigned 默认 SHA-1
  // 前置：同样只能从 DER 里断言（Node 不暴露 signatureAlgorithm）
  const rawOf = (pem) => Buffer.from(new crypto.X509Certificate(pem).raw);
  assertEqual(rawOf(good.cert).includes(Buffer.from('2a864886f70d01010b', 'hex')), true,
    '前置：good 必须是 sha256WithRSAEncryption');
  assertEqual(rawOf(bad.cert).includes(Buffer.from('2a864886f70d010105', 'hex')), true,
    '前置：bad 必须是 sha1WithRSAEncryption（selfsigned@2.4.1 未传 algorithm 时的默认值）');
  assertEqual(lc.isWeakSignature(good.cert), false, 'R28-04：SHA-256 证书不得被判为弱签名');
  assertEqual(lc.isWeakSignature(bad.cert), true, 'R28-04：SHA-1 证书必须被判为弱签名（据此触发重签）');
});

/**
 * 上面那条只驱动了判据函数本身。判据被接到**读取路径**上才算数 ——
 * 若 `getSelfSignedCert()` 里的 `!isWeakSignature(c.cert)` 被摘掉，上面那条仍会全绿。
 * 故这里给「读取缓存 → 决定复用还是重签」这个调用点单独一条行为护栏。
 */
test('R28-04 · 弱签名缓存证书必须在读取路径上真的被重新签发（调用点层）', () => {
  const selfsigned = require(R('node_modules', 'selfsigned'));
  const lc = freshRequire('server/local-cert.js');
  const CERT_FILE = path.join(process.env.COS_DATA_DIR, 'local-cert.json');
  const backup = fs.existsSync(CERT_FILE) ? fs.readFileSync(CERT_FILE, 'utf8') : null;
  const weak = selfsigned.generate([{ name: 'commonName', value: 'localhost' }], { days: 1, keySize: 2048 }); // SHA-1
  const strong = selfsigned.generate([{ name: 'commonName', value: 'localhost' }], { days: 1, keySize: 2048, algorithm: 'sha256' });
  const cache = (pems) => fs.writeFileSync(CERT_FILE,
    JSON.stringify({ key: pems.private, cert: pems.cert, createdAt: Date.now() }), { mode: 0o600 });
  try {
    // ① 缓存一份「刚签发、远未过期」的 SHA-1 证书 → 必须重新签发
    cache(weak);
    const rebuilt = lc.getSelfSignedCert();
    assertEqual(rebuilt.cert === weak.cert, false,
      'R28-04：缓存里是 SHA-1 证书时不得原样返回（旧实现的判据恒 false → 这里会直接复用满 820 天）');
    assertEqual(lc.isWeakSignature(rebuilt.cert), false,
      'R28-04：重新签发出来的证书必须是强签名（SHA-256）');
    // ② 正向对照：强签名且未过期 → 必须原样复用（护栏不得把证书缓存整个废掉）
    cache(strong);
    assertEqual(lc.getSelfSignedCert().cert, strong.cert,
      'R28-04 正向对照：强签名且未过期的缓存证书必须被复用，不得无谓重签');
  } finally {
    if (backup === null) { try { fs.unlinkSync(CERT_FILE); } catch (e) { /* 本就不存在 */ } }
    else fs.writeFileSync(CERT_FILE, backup);
  }
});

/* ================================================================== *
 * R28-05 · 陈旧锁接管期间的「锁文件缺席」窗口
 * ================================================================== */

test('R28-05 · 接管陈旧锁期间，第三个实例不得趁「锁文件缺席」抢到锁', () => {
  const DIR = process.env.COS_DATA_DIR; // helpers.js 已把 COS_DATA_DIR 兜底到临时目录
  const LOCK = path.join(DIR, '.instance.lock');
  const TAKEOVER = LOCK + '.takeover';
  const clean = () => { for (const f of [LOCK, TAKEOVER]) { try { fs.unlinkSync(f); } catch (e) { /* 不存在 */ } } };
  const stale = JSON.stringify({ pid: 999999, startedAt: new Date(Date.now() - 86400000).toISOString() });
  clean();

  // ---- ① 核心：接管进行中时，锁文件必须仍然存在且不可被抢 ----
  fs.writeFileSync(LOCK, stale); // 崩溃残留的陈旧锁
  const A = freshRequire('server/instance-lock.js');
  assertEqual(A.acquire().ok, true, '前置：陈旧锁应可被接管');

  /**
   * 模拟「B 正在接管途中」：B 抢到了接管标记（`O_EXCL`，故此刻标记存在）。
   * 旧实现（rename 把锁文件挪走）在这一刻会让 `LOCK_FILE` **不存在**，第三个实例
   * 只要调用 acquire() 就能 wx 创建成功 → 与仍自认持锁的 A 形成双持锁。
   * 新实现持有接管标记，第三个实例必须被挡住。
   */
  fs.writeFileSync(TAKEOVER, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  /**
   * ⚠️ 补强：这里必须把锁记录**写回陈旧值**。
   *
   * `A.acquire()` 成功后会把 `LOCK_FILE` 覆写成「本进程 pid」，而第三实例的
   * 「有活锁就退出」预检对自己（`cur.pid === process.pid`）是放行的 —— 于是
   * `C.acquire()` 会被**预检之后的那条「pid 仍存活 → 认输」**挡下，
   * 「接管标记是否真的拦住了第三实例」根本没被验证：实测把 `claimTakeover()`
   * 整段摘掉（不再创建标记、直接放行），这条断言照样通过（反向对照 `fail=0`）。
   * 真实场景里 B 之所以正在接管，正是因为那条锁记录**看起来是死的** ——
   * 这里如实还原该状态，判据才真正落在接管标记上。
   */
  fs.writeFileSync(LOCK, stale);
  const C = freshRequire('server/instance-lock.js');
  assertEqual(C.acquire().ok, false, 'R28-05：接管进行中（标记被持有）时，其它实例不得抢到锁');
  assertEqual(fs.existsSync(LOCK), true,
    'R28-05：接管期间锁文件**不得消失**（它是「有主」的唯一凭据，缺一瞬即被抢占）');
  // 清理这一轮模拟：删掉活标记与锁
  clean();

  // ---- ② 自愈：接管者中途被杀 → 标记里的 pid 已死 → 下一次接管必须成功并清掉标记 ----
  fs.writeFileSync(LOCK, stale);
  fs.writeFileSync(TAKEOVER, stale);
  const D = freshRequire('server/instance-lock.js');
  assertEqual(D.acquire().ok, true,
    'R28-05：接管标记的持有者已死时，下一次接管必须自愈成功（否则一次中途被杀会让后续启动全部失败）');
  assertEqual(fs.existsSync(TAKEOVER), false, 'R28-05：该次接管完成后不得残留接管标记');
  D.release();

  // ---- ③ 正向对照：没有任何残留时，获取必须照常成功（护栏不得把启动卡死）----
  clean();
  const E = freshRequire('server/instance-lock.js');
  assertEqual(E.acquire().ok, true, 'R28-05 正向对照：无锁时必须能正常获取');
  E.release();
  clean();
});

/* ================================================================== *
 * R28-06 · 拒绝文案的单一实现点
 * ================================================================== */

test('R28-06 · 不可解析地址在 /api 下的 403 必须能辨因（不再是「IP 已被屏蔽」）', () => {
  const ig = require(R('server', 'ip-guard.js'));
  assertEqual(typeof ig.blockTip, 'function', 'R28-06：文案必须收敛到唯一实现点 blockTip()');
  const unparsable = ig.blockTip('unparsable');
  assert(/无法识别|来源地址/.test(unparsable),
    'R28-06：unparsable 的文案必须点出「来源地址无法识别」，而不是让人去规则列表里找一个不存在的规则');
  assert(/管理员屏蔽/.test(ig.blockTip('rule')), 'R28-06 正向对照：规则命中仍说「已被管理员屏蔽」');
  assert(/中国大陆/.test(ig.blockTip('overseas')), 'R28-06 正向对照：海外屏蔽文案保持不变');
  // 两个拒绝分支共用同一实现点（HTTP JSON/HTML 与 WebDAV 文本）
  const ipSrc = readSrc('server', 'ip-guard.js');
  assertEqual((ipSrc.match(/blockTip\(/g) || []).length >= 2, true,
    'R28-06：ip-guard 内部两处（API 与 HTML）必须共用 blockTip');
  assert(/ipGuard\.blockTip\(/.test(readSrc('server', 'webdav-server.js')),
    'R28-06：WebDAV 的 403 文案必须同样取自 ipGuard.blockTip（否则三处文案会再次分叉）');
});
