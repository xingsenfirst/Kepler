/**
 * 第二十五轮护栏（R25-01 ~ R25-07）—— 负载均衡：按 API Key 的空间配额
 *
 * 需求：① 列出全部 API Key，可为单个 Key 设置「最多可使用的空间大小」（0 = 无限制）；
 * ② 超出后，用该 Key **创建新存储桶**或**上传文件**都要被拦下并弹窗告知；
 * ③ 列出每个 Key 下每个桶的占用（按大小排序、进度条、风箱式折叠）。
 *
 * 本轮的核心风险不是「功能没做」，而是**做了却拦不住**：配额判定若只读桶容量的
 * 15 分钟缓存，用户在缓存期内可以灌进任意多的数据 —— 界面显示没超、管理员以为管住了。
 * 因此这里既钉判定式本身，也钉「写入增量必须并入判定」与「每个入口都真的接了闸门」。
 *
 * 覆盖：
 *  - R25-01 用量聚合：归属判据与「实际服务该桶的密钥」同源；未绑定密钥的桶**不得被漏算**
 *  - R25-02 `assertCredentialQuota` 的边界（严格大于才算超额）、无限制 / 无归属一律放行
 *  - R25-03 写入增量并入判定（否则缓存期内可无限超额）；新鲜取样后归零
 *  - R25-04 `adjustStorageCache` 这个咽喉点必须把增量喂给配额记账
 *  - R25-05 HTTP 层：`/fs/upload/init`（分片）与 `/fs/upload/simple`（直传）超限必须
 *          403 + `code=CREDENTIAL_QUOTA_EXCEEDED` + 结构化 `quota`（前端据此弹窗）
 *  - R25-06 HTTP 层：`POST /buckets/local`（新建桶）超限必须同样拒绝；未超限必须放行
 *  - R25-07 WebDAV 四个写入动词（PUT 的目录 / 文件两条分支、MKCOL、COPY·MOVE）都接了闸门
 *  - R25-08 前端：卡片位置 / 管理员归属 / 机器可读码前后端一致 / 上传与建桶路径会弹窗
 *
 * 反向对照登记在 `scripts/reverse-check.js` 的 `R25-*` 条目。
 * ⚠️ 端口一律 `listen(0)`（临时端口），与相邻轮次并发跑文件时不会 EADDRINUSE。
 */
const fsc = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { test } = require('node:test');
const { ROOT, assert, assertEqual, assertReject, cleanupTempDir } = require('./helpers.js');

const TMP = fsc.mkdtempSync(path.join(os.tmpdir(), 'cos-audit25-'));
process.env.COS_DATA_DIR = TMP;

const read = (rel) => fsc.readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * 粗粒度注释剥离（仅为「该文件内不得出现裸 X」这类静态判据服务）。
 * 只按**整行**判定 `//` 与块注释续行，避免被字符串里的 `//`（URL）误伤。
 */
function withoutCommentLines(src) {
  return src.split(/\r?\n/)
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

/* ==================================================================== */
/* 云端打桩：桶名 → 官方口径容量（必须在加载 bucket-stats 之前接管）             */
/* ==================================================================== */

const BUCKET_SIZES = {};
const cos = require(path.join(ROOT, 'server', 'cos.js'));
cos.getClient = () => ({ __stub: true });
cos.p = async (client, method, params) => {
  if (method === 'request' && params && params.action === 'stats') {
    const bucket = String((params && params.Bucket) || '');
    const n = Object.prototype.hasOwnProperty.call(BUCKET_SIZES, bucket) ? BUCKET_SIZES[bucket] : 0;
    // 形态与腾讯云 ?stats 的 XML 响应一致（bucket-stats 走正则解析）
    return { Body: `<Size>${n}</Size><ObjectNumber>1</ObjectNumber>` };
  }
  if (method === 'getBucket') return { Contents: [], IsTruncated: 'false' }; // 建桶存在性探测
  if (method === 'putObject') return {}; // 直传落盘（桩：不真的写云端）
  if (method === 'headObject') return { headers: { 'content-length': '0' } };
  throw new Error('测试桩未预期的 p() 调用：' + method);
};
cos.listAll = async () => [];
cos.listAllExact = async () => [];

const configStore = require(path.join(ROOT, 'server', 'config-store.js'));
const bucketStats = require(path.join(ROOT, 'server', 'bucket-stats.js'));
const { adjustStorageCache } = require(path.join(ROOT, 'server', 'routes', 'stats.js'));

/** 用一份全新的配置替换当前配置，并清空桶容量缓存（避免上一用例的数字串进来） */
function seed(cfg) {
  bucketStats.bucketSizeCache.clear();
  configStore.save(cfg);
}

/** 断言一次 quota 拒绝，并返回错误对象供进一步检查 */
async function takeQuotaError(fn, msg) {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  throw new Error('断言失败：期望抛出配额错误，但成功返回' + (msg ? '（' + msg + '）' : ''));
}

const CRED = (id, sid, quotaBytes) => ({
  id, provider: 'tencent', secretId: sid, secretKey: 'k-' + sid,
  quotaBytes, enabled: true, visibleToUsers: true, remark: id,
});
const BKT = (id, bucket, credentialId) => ({
  id, provider: 'tencent', bucket, region: 'ap-guangzhou', credentialId, enabled: true,
});

/* ==================================================================== */
/* R25-01 · 用量聚合与「桶 → 密钥」归属                                       */
/* ==================================================================== */

test('R25-01 · 用量按「实际服务该桶的密钥」聚合，未绑定密钥的桶不得被漏算', async () => {
  seed({
    credentials: [CRED('credA', 'AKIDa', 0), CRED('credB', 'AKIDb', 500)],
    activeCredentialId: 'credA',
    buckets: [
      BKT('b1', 'r25a-small', 'credB'), // 100
      BKT('b2', 'r25a-big', 'credB'),   // 300
      BKT('b3', 'r25a-unbound', ''),    // 200：未绑定 → 由同厂商启用密钥服务
    ],
  });
  BUCKET_SIZES['r25a-small'] = 100;
  BUCKET_SIZES['r25a-big'] = 300;
  BUCKET_SIZES['r25a-unbound'] = 200;

  const b = await bucketStats.credentialUsage('credB');
  assertEqual(b.usedBytes, 400, 'R25-01：credB 名下两桶之和应为 400');
  assertEqual(b.quotaBytes, 500, 'R25-01：配额应原样读出');
  assertEqual(b.unlimited, false, 'R25-01：配额 500 > 0 → 非无限制');
  assertEqual(b.buckets.map((x) => x.bucket).join(','), 'r25a-big,r25a-small',
    'R25-01：桶必须按 sizeBytes 降序（卡片直接照此渲染）');

  /**
   * 关键：未显式绑定 credentialId 的桶在上传时其实**由某把启用密钥服务**
   * （`activeCredential(cfg, b)` 按 provider 回退）。若聚合时只看 `b.credentialId`
   * 就把它们排除，配额会系统性**低估** —— 界面显示没超、上传却被拦。
   */
  const a = await bucketStats.credentialUsage('credA');
  assertEqual(a.usedBytes, 200,
    'R25-01：未绑定密钥的桶必须归到「实际服务它的密钥」名下（漏算 = 闸门形同虚设）');
  assertEqual(a.unlimited, true, 'R25-01：配额 0 表示无限制');
  assertEqual(a.buckets[0].bucket, 'r25a-unbound', 'R25-01：该桶应出现在 credA 的桶列表里');
});

/* ==================================================================== */
/* R25-02 · 判定式边界                                                       */
/* ==================================================================== */

test('R25-02 · 严格大于才算超额；无限制 / 无归属一律放行', async () => {
  seed({
    credentials: [CRED('credQ', 'AKIDq', 1000), CRED('credU', 'AKIDu', 0)],
    activeCredentialId: 'credQ',
    buckets: [BKT('q1', 'r25q-full', 'credQ'), BKT('u1', 'r25u-huge', 'credU')],
  });
  BUCKET_SIZES['r25q-full'] = 1000;      // 恰好用满
  BUCKET_SIZES['r25u-huge'] = 10 ** 12;  // 无限制的桶

  // 已用 == 上限：不算「超出」，建桶（addBytes=0）应放行
  await bucketStats.assertCredentialQuota('credQ', { addBytes: 0 });

  // 再多写 1 字节 → 超出（严格大于）
  const e1 = await takeQuotaError(() => bucketStats.assertCredentialQuota('credQ', { addBytes: 1 }));
  assertEqual(e1.status, 403, 'R25-02：配额超限必须是 403');
  assertEqual(e1.code, 'CREDENTIAL_QUOTA_EXCEEDED', 'R25-02：必须带机器可读码（前端据此弹窗）');
  assert(e1.quota && typeof e1.quota === 'object', 'R25-02：必须带结构化 quota 明细');
  assertEqual(e1.quota.usedBytes, 1000, 'R25-02：明细里应含已用量');
  assertEqual(e1.quota.quotaBytes, 1000, 'R25-02：明细里应含上限');
  assertEqual(e1.quota.addBytes, 1, 'R25-02：明细里应含本次待写入量');

  // 无限制：即便体积远超任何合理值也放行
  await bucketStats.assertCredentialQuota('credU', { addBytes: 10 ** 12 });

  // 无归属 / 不存在的凭据：没有配额可判 → 放行（不得凭空拦下）
  await bucketStats.assertCredentialQuota('', { addBytes: 10 ** 12 });
  await bucketStats.assertCredentialQuota('no-such-credential', { addBytes: 10 ** 12 });

  // 反向对照：本用例必须真的能抓到「永远抛错」的实现
  const okUsage = await bucketStats.credentialUsage('credU');
  assertEqual(okUsage.unlimited, true, 'R25-02：前置事实 —— credU 应为无限制');
});

/* ==================================================================== */
/* R25-03 · 写入增量必须并入判定                                             */
/* ==================================================================== */

test('R25-03 · 未取样的写入增量必须计入判定（否则缓存期内可无限超额）', async () => {
  seed({
    credentials: [CRED('credD', 'AKIDd', 1000)],
    activeCredentialId: 'credD',
    buckets: [BKT('d1', 'r25d1', 'credD')],
  });
  BUCKET_SIZES['r25d1'] = 100; // 官方口径：桶里只有 100 字节

  const cfgKey = { provider: 'tencent', secretId: 'AKIDd', bucket: 'r25d1', region: 'ap-guangzhou' };

  // 首次取样 → 新鲜写入缓存（100），同时清掉该桶的未取样增量
  assertEqual((await bucketStats.credentialUsage('credD')).usedBytes, 100,
    'R25-03：首次取样应等于官方口径');

  // 记账 950 字节（模拟一次刚完成、尚未被新鲜取样吸收的上传）
  bucketStats.recordUsageDelta(cfgKey, 950);
  const u = await bucketStats.credentialUsage('credD');
  assertEqual(u.outstandingBytes, 950, 'R25-03：未取样增量应被单独暴露（便于排查口径差）');
  assertEqual(u.usedBytes, 1050,
    'R25-03：判定口径必须是「缓存值 + 未取样增量」。只看缓存的话 100 < 1000 会放行，'
    + '用户在 15 分钟缓存期内可往 1KB 上限里灌进任意多数据');

  // 1050 > 1000 → 必须拒绝
  await takeQuotaError(() => bucketStats.assertCredentialQuota('credD', { addBytes: 0 }),
    'R25-03：并入增量后应判为超额');

  // 新鲜取样后增量归零（新数字已包含这些写入，重复计一次会虚高）
  const fresh = await bucketStats.getBucketStatViaApi(cos.getClient({}), {
    provider: 'tencent', bucket: 'r25d1', region: 'ap-guangzhou',
  });
  BUCKET_SIZES['r25d1'] = 100 + 950; // 云端已把写入计入
  assert(fresh, '前置：桩应能返回官方容量');

  // 手动让缓存失效，逼出一次新鲜取样
  bucketStats.bucketSizeCache.clear();
  const u2 = await bucketStats.credentialUsage('credD');
  assertEqual(u2.outstandingBytes, 0, 'R25-03：新鲜取样后未取样增量必须归零');
  assertEqual(u2.usedBytes, 1050, 'R25-03：归零后仍等于真实占用（不能重复计数）');
});

/* ==================================================================== */
/* R25-04 · 咽喉点必须把增量喂给配额记账                                       */
/* ==================================================================== */

test('R25-04 · adjustStorageCache 是写入增量的唯一入口，必须同步喂给配额记账', () => {
  seed({
    credentials: [CRED('credS', 'AKIDs', 1000)],
    activeCredentialId: 'credS',
    buckets: [BKT('s1', 'r25s1', 'credS')],
  });
  const cfgKey = { provider: 'tencent', secretId: 'AKIDs', bucket: 'r25s1', region: 'ap-guangzhou' };
  const before = bucketStats.pendingUsageDelta(cfgKey);

  // 这个函数是所有 HTTP 写/删路径（直传、分片合并、删除、清空桶）共用的咽喉点
  adjustStorageCache(777, cfgKey);
  assertEqual(bucketStats.pendingUsageDelta(cfgKey) - before, 777,
    'R25-04：`adjustStorageCache` 必须把增量同时喂给配额记账 —— 否则某个写入入口'
    + '（或全部）的字节都不计入配额，闸门会被静默绕过');

  // 负数（释放空间）同样要记账，否则删完文件后额度不会及时回落
  adjustStorageCache(-77, cfgKey);
  assertEqual(bucketStats.pendingUsageDelta(cfgKey) - before, 700, 'R25-04：释放量应为负增量');

  // 缺 cfg / 0 增量：静默忽略，不得抛错（记账失败不该让主流程失败）
  adjustStorageCache(0, cfgKey);
  adjustStorageCache(100, null);
  assertEqual(bucketStats.pendingUsageDelta(cfgKey) - before, 700, 'R25-04：0 / 缺 cfg 不应改变记账');
});

/* ==================================================================== */
/* R25-05 / R25-06 · HTTP 层：闸门必须落地成 403 + code + quota              */
/* ==================================================================== */

const express = require(path.join(ROOT, 'node_modules', 'express'));

/** 起一个挂指定路由 + 强制角色的临时服务 */
function serve(mount, router, role) {
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.use((req, _res, next) => { req.authUser = { id: 'u1', username: 'u1', role }; next(); });
  app.use(mount, router);
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: server.address().port, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

function send(port, method, urlPath, { body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : (Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)));
    const req = http.request({
      host: '127.0.0.1', port, path: urlPath, method,
      headers: Object.assign(
        { 'X-Requested-With': 'XMLHttpRequest' },
        payload ? { 'Content-Type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json', 'Content-Length': payload.length } : null,
        headers,
      ),
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch (e) { /* 非 JSON */ }
        resolve({ status: res.statusCode, raw, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const fsRoutes = require(path.join(ROOT, 'server', 'routes', 'fs.js'));
const bucketRoutes = require(path.join(ROOT, 'server', 'routes', 'buckets.js'));

test('R25-05 · 五个 HTTP 写入入口超限都必须 403 + code + quota', async () => {
  const seedFull = () => {
    seed({
      credentials: [CRED('credE', 'AKIDe', 1000)],
      activeCredentialId: 'credE',
      activeBucketId: 'e1',
      buckets: [BKT('e1', 'r25e-full', 'credE')],
    });
    /**
     * 用**已超额**（1001 > 1000）而不是「恰好用满」：
     * mkdir / rename / move 是 0 字节写入（`addBytes=0`），判据是「**已经**超出上限」，
     * 恰好用满时它们本就该放行（严格大于才算超出，边界由 R25-02 单独钉）。
     */
    BUCKET_SIZES['r25e-full'] = 1001;
  };
  seedFull();

  const srv = await serve('/api', fsRoutes, 'admin');
  try {
    /**
     * 五个入口**逐个**断言 —— 「一条护栏覆盖 N 处」不够：闸门是可被独立摘掉的，
     * 若只测其中一处，另外四处撤掉也不会变红（R21-16 / R22-03 都栽在这种形态上）。
     */
    const cases = [
      { name: 'mkdir', method: 'POST', path: '/api/fs/mkdir', body: { path: 'sub' } },
      { name: 'rename', method: 'POST', path: '/api/fs/rename', body: { path: 'a.txt', newName: 'b.txt' } },
      { name: 'move', method: 'POST', path: '/api/fs/move', body: { paths: ['a.txt'], targetPrefix: 'sub/' } },
      // size 必须大于 SIMPLE_THRESHOLD(8MB)，否则 init 会直接返回 simple 而不落闸门
      { name: 'init', method: 'POST', path: '/api/fs/upload/init', body: { key: 'big.bin', size: 9 * 1024 * 1024 } },
      { name: 'simple', method: 'PUT', path: '/api/fs/upload/simple?path=a.txt&mtime=0', body: Buffer.from('hello') },
    ];
    for (const c of cases) {
      const r = await send(srv.port, c.method, c.path, { body: c.body });
      assertEqual(r.status, 403, `R25-05【${c.name}】：超限必须 403（实际 ${r.status} / ${r.raw}）`);
      assertEqual(r.json && r.json.code, 'CREDENTIAL_QUOTA_EXCEEDED',
        `R25-05【${c.name}】：必须带机器可读码（前端据此弹窗）`);
      assert(r.json && r.json.quota && r.json.quota.usedBytes === 1001,
        `R25-05【${c.name}】：必须带结构化 quota 明细（弹窗要显示已用 / 上限）`);
    }

    // 反向对照：把上限放开后，同一条直传必须能成功 —— 否则上面只证明了「恒抛错」
    seed({
      credentials: [CRED('credE', 'AKIDe', 0)],
      activeCredentialId: 'credE',
      activeBucketId: 'e1',
      buckets: [BKT('e1', 'r25e-full', 'credE')],
    });
    bucketStats.bucketSizeCache.clear();
    const up2 = await send(srv.port, 'PUT', '/api/fs/upload/simple?path=a.txt&mtime=0',
      { body: Buffer.from('hello') });
    assertEqual(up2.status, 200, `R25-05：设为无限制后直传必须放行（实际 ${up2.status} / ${up2.raw}）`);
    const mk2 = await send(srv.port, 'POST', '/api/fs/mkdir', { body: { path: 'sub' } });
    assertEqual(mk2.status, 200, `R25-05：设为无限制后建目录必须放行（实际 ${mk2.status} / ${mk2.raw}）`);
  } finally {
    await srv.close();
  }
});

test('R25-06 · 新建存储桶入口超限必须拒绝；未超限必须放行', async () => {
  seed({
    credentials: [CRED('credF', 'AKIDf', 1000)],
    activeCredentialId: 'credF',
    activeBucketId: 'f1',
    buckets: [BKT('f1', 'r25f-full', 'credF')],
  });
  // 1001 > 1000 → 已经超额（建桶本身不占空间，故 addBytes=0 判的是「已超额」）
  BUCKET_SIZES['r25f-full'] = 1001;

  const srv = await serve('/api', bucketRoutes, 'admin');
  try {
    const denied = await send(srv.port, 'POST', '/api/buckets/local', {
      body: { bucket: 'r25f-new', region: 'ap-guangzhou', credentialId: 'credF' },
    });
    assertEqual(denied.status, 403, `R25-06：超限建桶必须 403（实际 ${denied.status} / ${denied.raw}）`);
    assertEqual(denied.json && denied.json.code, 'CREDENTIAL_QUOTA_EXCEEDED', 'R25-06：必须带机器可读码');
    assertEqual((configStore.load().buckets || []).some((x) => x.bucket === 'r25f-new'), false,
      'R25-06：被拒的建桶请求不得留下任何记录');

    // 反向对照：未超限时必须能建（证明闸门不是「一律拒绝」）
    seed({
      credentials: [CRED('credF', 'AKIDf', 0)],
      activeCredentialId: 'credF',
      activeBucketId: 'f1',
      buckets: [BKT('f1', 'r25f-full', 'credF')],
    });
    bucketStats.bucketSizeCache.clear();
    const ok = await send(srv.port, 'POST', '/api/buckets/local', {
      body: { bucket: 'r25f-new', region: 'ap-guangzhou', credentialId: 'credF' },
    });
    assertEqual(ok.status, 200, `R25-06：未超限时必须放行（实际 ${ok.status} / ${ok.raw}）`);
    assertEqual((configStore.load().buckets || []).some((x) => x.bucket === 'r25f-new'), true,
      'R25-06：放行的建桶请求必须真的落库');
  } finally {
    await srv.close();
  }
});

/* ==================================================================== */
/* R25-07 · WebDAV 四个写入动词都接了闸门（静态不变量）                          */
/* ==================================================================== */

test('R25-07 · WebDAV 的 PUT（目录 / 文件）/ MKCOL / COPY·MOVE 都接了配额闸门', () => {
  const code = withoutCommentLines(read('server/webdav-server.js'));

  const putStart = code.indexOf("app.put('*'");
  const mkcolStart = code.indexOf("app[ 'MKCOL'.toLowerCase() ]");
  const delStart = code.indexOf("app.delete('*'");
  const moveCopyStart = code.indexOf('async function moveCopy(');
  const moveRouteStart = code.indexOf("'MOVE'.toLowerCase()");

  assert(putStart >= 0 && mkcolStart > putStart && delStart > mkcolStart,
    '扫描范围自检：应能依次定位 PUT / MKCOL / DELETE 三个处理器（定位失败时下面的「命中 0」会假绿）');
  assert(moveCopyStart >= 0 && moveRouteStart > moveCopyStart,
    '扫描范围自检：应能定位 moveCopy 定义与其路由注册');

  const putBody = code.slice(putStart, mkcolStart);
  const mkcolBody = code.slice(mkcolStart, delStart);
  const moveBody = code.slice(moveCopyStart, moveRouteStart);

  /**
   * PUT 的**两条分支各自**要有一个断言落点。
   *
   * 为什么不数「PUT 里 assertCredentialQuota 出现次数 >= 2」：那是**聚合**判据，
   * 只能证明总量够，说不出红的是哪一条；一旦有人在别处再补一处（或将来把两处合并进
   * 一个助手函数），计数仍够而真正的分支其实已经裸奔。按分支分区判定才逐处可定位。
   */
  const dirIdx = putBody.indexOf("if (key.endsWith('/')) {");
  const lenIdx = putBody.indexOf('const putLen');
  const writeIdx = putBody.indexOf('await gateway.writeObject');
  assert(dirIdx >= 0 && lenIdx > dirIdx && writeIdx > lenIdx,
    '扫描范围自检：应能依次定位 PUT 的目录分支 / putLen / 落盘调用');
  assert(/assertCredentialQuota\(/.test(putBody.slice(dirIdx, lenIdx)),
    'R25-07：WebDAV PUT 的**目录分支**必须过闸门');
  assert(/assertCredentialQuota\(/.test(putBody.slice(lenIdx, writeIdx)),
    'R25-07：WebDAV PUT 的**文件分支**必须过闸门');
  assert(/recordUsageDelta\(/.test(putBody.slice(writeIdx)),
    'R25-07：WebDAV PUT 落盘后必须把字节数记进配额（否则挂载写入永不计入判定）');

  assert(/assertCredentialQuota\(/.test(mkcolBody),
    'R25-07：WebDAV MKCOL 必须过闸门（新建集合也是一种写入）');
  assert(/assertCredentialQuota\(/.test(moveBody),
    'R25-07：WebDAV COPY / MOVE 必须过闸门');

  // 删除**不得**设闸门 —— 删除是在释放空间，拦下它只会让用户更出不去
  const delBody = code.slice(delStart, delStart + 1400);
  assert(!/assertCredentialQuota\(/.test(delBody),
    'R25-07：WebDAV DELETE 不得设配额闸门（删除会释放空间，拦下它自相矛盾）');
});

/* ==================================================================== */
/* R25-08 · 前端接线与前后端契约                                             */
/* ==================================================================== */

test('R25-08 · 负载均衡卡片位置正确、纳入管理员专属、且前后端错误码一致', () => {
  const html = read('public/index.html');
  const iUser = html.indexOf('id="sysset-user-card"');
  const iLb = html.indexOf('id="sysset-lb-card"');
  const iEnc = html.indexOf('id="sysset-enc-card"');
  assert(iUser >= 0 && iLb >= 0 && iEnc >= 0, '前置：三张卡片都应存在');
  assert(iUser < iLb && iLb < iEnc,
    'R25-08：负载均衡卡片必须位于「用户管理」与「文件加密」之间（需求指定的位置）');

  const sys = read('public/js/syssettings.js');
  assert(/ADMIN_ONLY_CARDS[\s\S]{0,400}sysset-lb-card/.test(sys),
    'R25-08：负载均衡卡片必须纳入 ADMIN_ONLY_CARDS（仅管理员可见）');

  // 前后端错误码必须逐字一致 —— 不一致 = 前端永远识别不出配额超限（弹窗永不出现）
  const srvCode = /const QUOTA_EXCEEDED_CODE = '([^']+)'/.exec(read('server/bucket-stats.js'));
  const webCode = /export const QUOTA_EXCEEDED_CODE = '([^']+)'/.exec(read('public/js/util.js'));
  assert(srvCode && webCode, '前置：前后端都应定义 QUOTA_EXCEEDED_CODE');
  assertEqual(webCode[1], srvCode[1],
    'R25-08：前端 QUOTA_EXCEEDED_CODE 必须与服务端逐字一致（否则弹窗逻辑永不触发）');
  assert(/QUOTA_EXCEEDED_CODE/.test(read('public/js/upload.js')),
    'R25-08：上传路径必须按该码识别配额超限');
  assert(/showQuotaDialog/.test(read('public/js/main.js')),
    'R25-08：新建存储桶路径同样要弹配额对话框');

  // api.js 必须把服务端下发的 code / quota 挂回错误对象（否则上层拿不到明细）
  const api = read('public/js/api.js');
  assert(/err\.code = data\.code/.test(api) && /err\.code = d\.code/.test(api),
    'R25-08：request() 与 xhrPut() 两条通道都要保留 code（只改一条会让直传路径识别不出）');
  assert(/err\.quota = data\.quota/.test(api) && /err\.quota = d\.quota/.test(api),
    'R25-08：两条通道都要保留结构化 quota 明细');

  // 新端点：只读、仅管理员
  const cfgRoutes = read('server/routes/config.js');
  assert(/'\/credentials\/quota-usage', requireAdmin/.test(cfgRoutes),
    'R25-08：`GET /credentials/quota-usage` 必须挂 requireAdmin（响应含全部密钥与桶名 → 账号资产）');
});

/* ============================ 收尾 ============================ */

test.after(async () => {
  await cleanupTempDir(TMP, {
    label: 'audit25-regressions',
    flushers: [
      { name: 'config-store', flush: () => configStore.flush() },
      { name: 'stats-store', flush: () => require(path.join(ROOT, 'server', 'stats-store.js')).flushStatsSync() },
      { name: 'secure-store', flush: () => require(path.join(ROOT, 'server', 'secure-store.js')).flush() },
    ],
  });
});
