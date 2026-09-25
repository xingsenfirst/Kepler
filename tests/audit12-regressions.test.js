/**
 * 测试：第 12 轮审计修复的回归护栏（见开发文档「六、审计发现台账 6.4」）
 *
 * 第 12 轮的性质与前面几轮都不同：**它抓到的是"护栏自己"的缺陷**。
 *
 *  - §0.1 是一起真实数据事故：`config-store` 是全库唯一不读 `COS_DATA_DIR` 的 store，
 *    于是 `npm test` 直接改写生产 `data/config.enc`（内含全部云厂商密钥）。
 *  - §0.2 是「唯一实现点」的假象：`secure-store.exitPathWritable()` 被声明为 canonical，
 *    生产侧却**零调用**（一处私有副本 + 两处内联）；把它改成 `return true`，
 *    第 11 轮新建的两套护栏（invariants 15 / audit11 15）**全绿**。
 *
 * 因此本文件除了守行为，还刻意守两件事：
 *  ① **判据必须是后果，不是语句存在** —— 例如 R12-03 断言的是「把 canonical 换成
 *     恒 false 之后，退出路径真的一个字节都不写」，而不是「源码里有没有那行调用」；
 *  ② **每条都要带正向对照** —— 证明守卫没有退化成"什么都不做"（§9.1 G4③）。
 *
 * 覆盖的编号：
 *   R12-01 config-store 必须支持 COS_DATA_DIR（不得写生产配置）
 *   R12-02 目录 MOVE 覆盖冲突必须在动手前整体拒绝
 *   R12-03 退出路径的判据必须走唯一实现点
 *   R12-04 WebDAV 目录 COPY 失败必须回滚
 *   R12-05 magic 分片缺 chunkSize 时最内层必须拒绝（NaN 偏移）
 *   R12-06 目标目录过大必须给专属文案且零改动
 *   R12-07 元数据迁移后必须立刻同步落盘
 *   R12-12 bucketOfIdent 取倒数第 2 段（加维度不失效）
 *   R12-13 并发回滚不得留下孤儿（且日志不得谎报"已完整回滚"）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const test = require('node:test');
const { assert, assertEqual, assertReject, ROOT, cleanupTempDir } = require('./helpers');

/* ------------------------------------------------------------------ *
 * 0 · 隔离与打桩（必须在 require 任何 server 模块之前）
 * ------------------------------------------------------------------ */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-audit12-'));
process.env.COS_DATA_DIR = TMP;
/**
 * 端口区间必须**与相邻轮次不相交**：`node --test` 默认按 CPU 数并发跑文件，
 * 两个文件同时启动 WebDAV 且 `pid % N` 撞到同一个端口时，`apply()` 会 EADDRINUSE
 * → `isRunning()` 为 false → 用例抛错（表现为**偶发**失败，极难归因）。
 * 既有区间：audit9 = 18800..19099、audit10 = 18900..19199、audit11 = 19100..19399
 * （前两个本身就重叠）。本文件取 19600..19799，与三者均不相交。
 */
process.env.WEBDAV_PORT = String(19600 + (process.pid % 200));

const cos = require(path.join(ROOT, 'server', 'cos.js'));
const configStore = require(path.join(ROOT, 'server', 'config-store.js'));

/** 内存中的对象存储：key -> Buffer */
const fakeObjects = new Map();
/** 复制失败注入：命中的目标 key 一律失败 */
let copyFailKeys = null;
/**
 * R12-13：给**成功**的复制注入延迟，制造「失败发生时其余 worker 仍在飞」这一
 * 真实时序。没有它，12 个对象会被 5 路 worker 在同一微任务内全部取走并完成，
 * `Promise.all` 拒绝时其实已经没有在飞的任务 —— 那样即便撤掉 `allSettled`，
 * 残留数仍然是 0，护栏就成了空转（这正是"窗口太窄"型假护栏的又一种形态）。
 */
let copyDelayMs = 0;
/** 云端复制尝试次数（用于断言失败后不再启动新任务） */
const cloudCalls = { copyAttempts: 0 };
/** R12-06：目标前缀列举"无限翻页"注入（模拟超大目标目录） */
let bigPrefix = null;
const BIG_TOTAL = 25000;

const BASE_CFG = {
  secretId: 'stub-id', secretKey: 'stub-key',
  bucket: 'audit12-bucket', region: 'ap-guangzhou', provider: 'tencent',
};

/**
 * 唯一的一份「云端行为」实现，同时供两条调用路径使用（第 10 轮踩过的坑）：
 * 路由层走 `cos.p`；`cos.js` 内部（listPage / listAllExact）走模块作用域的 `p`，
 * 调的是 `cos[method](params, cb)` 这种 SDK 回调风格 —— 必须两份接线。
 */
function handleCloud(method, params) {
  const ok = (result) => ({ result });
  const fail = (message, status) => ({ error: Object.assign(new Error(message), { status }) });

  switch (method) {
    case 'headObject': {
      const k = params.Key;
      if (!fakeObjects.has(k)) return fail('Not Found', 404);
      return ok({ headers: { 'content-length': String(fakeObjects.get(k).length), etag: 'etag-' + k } });
    }
    case 'getObject': {
      const buf = fakeObjects.get(params.Key);
      if (buf === undefined) return fail('Not Found', 404);
      return ok({ Body: buf });
    }
    case 'putObject': {
      fakeObjects.set(params.Key, Buffer.isBuffer(params.Body) ? params.Body : Buffer.from(String(params.Body || '')));
      return ok({ ETag: 'etag' });
    }
    case 'deleteObject': {
      fakeObjects.delete(params.Key);
      return ok({});
    }
    case 'deleteMultipleObject': {
      const deleted = [];
      for (const o of (params.Objects || [])) {
        fakeObjects.delete(o.Key);
        deleted.push({ Key: o.Key });
      }
      return ok({ Deleted: deleted, Error: [] });
    }
    case 'putObjectCopy':
    case 'sliceCopyFile': {
      cloudCalls.copyAttempts += 1;
      // 目标 key 就是 params.Key（与 audit11 同口径）
      if (copyFailKeys && copyFailKeys.has(params.Key)) {
        return fail('注入的复制失败：' + params.Key, 500);
      }
      const src = String(params.CopySource || '').split('?')[0].replace(/^https?:\/\//, '');
      const srcKey = src.startsWith('/')
        ? src.replace(/^\/[^/]+\//, '')
        : src.replace(/^[^/]+\//, '');
      const buf = fakeObjects.get(srcKey);
      if (buf === undefined) return fail('Not Found: ' + srcKey, 404);
      fakeObjects.set(params.Key, Buffer.from(buf));
      return ok({ ETag: 'etag', LastModified: new Date().toISOString() });
    }
    case 'multipartInit': return ok({ UploadId: 'audit12-upload-id' });
    case 'multipartUpload': return ok({ ETag: '"part-etag"' });
    case 'multipartComplete': return ok({ ETag: '"final-etag"' });
    case 'multipartAbort': return ok({});
    case 'multipartListPart': return ok({ ListPartsResult: { Part: [] } });
    case 'multipartList': return ok({ ListUploadsResult: { Upload: [], IsTruncated: 'false' } });
    case 'request': return ok({});
    case 'getBucket': {
      const prefix = String(params.Prefix || '');
      /**
       * R12-06：目标前缀"无限翻页"——每页 1000 个合成对象，共 25000 个。
       * 合成而非真建 2.5 万个对象，是为了让用例在毫秒级跑完且不吃内存。
       */
      if (bigPrefix && prefix === bigPrefix) {
        const page = Number(params.Marker || 0);
        const start = page * 1000;
        const contents = [];
        for (let i = 0; i < 1000; i += 1) {
          contents.push({ Key: `${prefix}obj-${start + i}`, Size: 1, LastModified: new Date().toISOString() });
        }
        const more = start + 1000 < BIG_TOTAL;
        return ok({
          Contents: contents, CommonPrefixes: [],
          IsTruncated: more ? 'true' : 'false', NextMarker: more ? String(page + 1) : '',
        });
      }
      const delim = params.Delimiter;
      const keys = [...fakeObjects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const mk = (k) => ({ Key: k, Size: fakeObjects.get(k).length, LastModified: new Date().toISOString() });
      if (delim) {
        const dirs = new Set();
        const files = [];
        for (const k of keys) {
          const rest = k.slice(prefix.length);
          const i = rest.indexOf(delim);
          if (i >= 0) dirs.add(prefix + rest.slice(0, i + 1));
          else files.push(k);
        }
        return ok({
          Contents: files.map(mk),
          CommonPrefixes: [...dirs].sort().map((Prefix) => ({ Prefix })),
          IsTruncated: 'false',
        });
      }
      return ok({ Contents: keys.map(mk), CommonPrefixes: [], IsTruncated: 'false' });
    }
    default: return ok({});
  }
}

const CLOUD_METHODS = [
  'headObject', 'getObject', 'putObject', 'deleteObject', 'deleteMultipleObject',
  'putObjectCopy', 'sliceCopyFile', 'multipartInit', 'multipartUpload',
  'multipartComplete', 'multipartAbort', 'multipartListPart', 'multipartList',
  'getBucket', 'request',
];

const fakeClient = { __provider: 'tencent' };
for (const m of CLOUD_METHODS) {
  fakeClient[m] = (p, cb) => {
    const r = handleCloud(m, p || {});
    if (typeof cb === 'function') process.nextTick(() => cb(r.error || null, r.result));
  };
}
fakeClient.getObject = (opts, cb) => {
  const r = handleCloud('getObject', opts || {});
  if (r.error) {
    if (opts && opts.Output) process.nextTick(() => opts.Output.destroy(r.error));
    if (typeof cb === 'function') process.nextTick(() => cb(r.error));
    return;
  }
  if (opts && opts.Output) process.nextTick(() => { opts.Output.end(r.result.Body); });
  if (typeof cb === 'function') process.nextTick(() => cb(null, {}));
};

cos.getClient = () => fakeClient;
cos.p = async (client, method, params) => {
  // R12-13：只为「成功的复制」注入延迟，让失败发生时其余 worker 确实还在飞
  if (copyDelayMs > 0 && (method === 'putObjectCopy' || method === 'sliceCopyFile')
      && !(copyFailKeys && copyFailKeys.has(params.Key))) {
    await new Promise((r) => setTimeout(r, copyDelayMs));
  }
  const r = handleCloud(method, params || {});
  if (r.error) throw r.error;
  return r.result;
};

configStore.get = () => BASE_CFG;
configStore.effectiveForBucket = () => BASE_CFG;
configStore.getWebdav = () => ({ enabled: true, accounts: [{ id: 'a1', username: 'u' }] });
configStore.authenticateWebdav = async (user, pass) =>
  (user === 'u' && pass === 'p'
    ? { ok: true, account: { id: 'a1', username: 'u', role: 'admin' } }
    : { ok: false });

const statsStore = require(path.join(ROOT, 'server', 'stats-store.js'));
statsStore.addLog = () => {};
statsStore.trackBucket = () => {};
const encStore = require(path.join(ROOT, 'server', 'enc-store.js'));
const shareStore = require(path.join(ROOT, 'server', 'share-store.js'));
const listCache = require(path.join(ROOT, 'server', 'list-cache.js'));
const gateway = require(path.join(ROOT, 'server', 'fs-gateway.js'));
const uploadSessions = require(path.join(ROOT, 'server', 'upload-sessions.js'));
const secureStore = require(path.join(ROOT, 'server', 'secure-store.js'));
const { LIMITS } = require(path.join(ROOT, 'server', 'limits.js'));
const shared = require(path.join(ROOT, 'server', 'routes', '_shared.js'));
shared.requireConfig = () => BASE_CFG;
const fsRoutes = require(path.join(ROOT, 'server', 'routes', 'fs.js'));

/* ------------------------------------------------------------------ *
 * 1 · 迷你 HTTP / WebDAV 工具（与 audit7~11 同型，逐轮护栏自包含）
 * ------------------------------------------------------------------ */

const openServers = [];

function startApp(router, { authUser } = {}) {
  const express = require(path.join(ROOT, 'node_modules', 'express'));
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use((req, _res, next) => {
    req.authUser = authUser === undefined
      ? { id: 'u1', username: 'admin', role: 'admin' }
      : authUser;
    next();
  });
  app.use('/api', router);
  return new Promise((resolve) => {
    const server = http.createServer(app);
    openServers.push(server);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close: () => new Promise((r) => {
          try {
            if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
            server.close(() => r());
          } catch (e) { r(); }
        }),
      });
    });
  });
}

function request(port, method, urlPath, { headers = {}, body = null, tls = false } = {}) {
  return new Promise((resolve, reject) => {
    const mod = tls ? https : http;
    const payload = body === null ? null
      : (Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)));
    const opts = {
      host: '127.0.0.1', port, path: urlPath, method,
      rejectUnauthorized: false,
      headers: Object.assign(
        { 'X-Requested-With': 'XMLHttpRequest' },
        payload ? { 'Content-Length': payload.length } : null,
        payload && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : null,
        headers,
      ),
    };
    const req = mod.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const encMetaOf = (origSize) => ({
  encrypted: true, mode: 'crypto', origSize, createdAt: new Date().toISOString(),
  crypto: { segments: [{ n: 1, iv: 'aa', ctLen: origSize, tag: 'bb' }] },
});

let davPort = 0;
let davServer = null;
async function startDav() {
  if (davServer && davPort) return davPort;
  const webdav = require(path.join(ROOT, 'server', 'webdav-server.js'));
  await webdav.apply();
  if (!webdav.isRunning()) throw new Error('WebDAV 未能启动（端口被占用？）');
  davServer = webdav;
  davPort = Number(process.env.WEBDAV_PORT);
  return davPort;
}
const AUTH = { Authorization: 'Basic ' + Buffer.from('u:p').toString('base64') };

test.after(async () => {
  try { if (davServer) await davServer.close(); } catch (e) { /* ignore */ }
  for (const s of openServers) {
    try {
      if (typeof s.closeAllConnections === 'function') s.closeAllConnections();
      s.close();
    } catch (e) { /* ignore */ }
  }
  try {
    await cleanupTempDir(TMP, {
      label: 'audit12-regressions',
      flushers: [
        { name: 'upload-sessions', flush: () => uploadSessions.flushSync() },
        { name: 'enc-store', flush: () => encStore.flushMetaSync() },
        { name: 'stats-store', flush: () => statsStore.flushStatsSync() },
        { name: 'config-store', flush: () => configStore.flush() },
        { name: 'secure-store', flush: () => secureStore.flush() },
      ],
    });
  } catch (e) { /* ignore */ }
});

/* ================================================================== *
 * R12-01 · config-store 的落盘必须跟随 COS_DATA_DIR
 * ================================================================== */

/**
 * 报告 §1 的 R12-01（高危，本轮唯一一条会动到**真实用户数据**的缺陷）。
 *
 * `server/config-store.js` 曾是 `const DATA_DIR = path.join(__dirname, '..', 'data')`
 * —— 全库唯一一个不读 `COS_DATA_DIR` 的 store。于是跑一次全量测试就会对生产
 * `data/config.enc`（内含 3 条云厂商密钥、2 个桶、3 个账户）做 8 次
 * 「解密 → 重新加密 → 原子替换」。第 12 轮审计过程中这件事**实际发生了**。
 *
 * 断言打在两个**后果**上：① 隔离目录里确实出现了 `config.enc`（写对了地方）；
 * ② 生产文件的字节**一个都没变**（没写错地方）。只断言前者不够 ——
 * 万一两边都写了，前者照样绿。
 */
test('R12-01 · config-store 的落盘必须落在 COS_DATA_DIR，且不得改写生产 config.enc', async () => {
  const prodCfg = path.join(ROOT, 'data', 'config.enc');
  const before = fs.existsSync(prodCfg) ? fs.readFileSync(prodCfg) : null;

  // 触发一次真实落盘：save() 是就地合并，这里改一个无害字段
  configStore.save({ prefs: Object.assign({}, ((configStore.load() || {}).prefs || {}), { __r12: 1 }) });
  await configStore.flush();

  const tmpCfg = path.join(TMP, 'config.enc');
  assert(fs.existsSync(tmpCfg),
    `R12-01：隔离目录里必须出现 config.enc（实际没有）—— COS_DATA_DIR=${TMP}`);
  const after = fs.existsSync(prodCfg) ? fs.readFileSync(prodCfg) : null;
  assert(
    (before === null && after === null) || (before && after && before.equals(after)),
    'R12-01：生产 data/config.enc 的字节**一个都不许变** —— 它装着全部云厂商密钥，'
    + '测试进程重写它等于拿用户的真实凭据做测试夹具（第 12 轮已实际发生）',
  );
});

/* ================================================================== *
 * R12-02 · 目录 MOVE 的覆盖冲突必须在动手前整体拒绝
 * ================================================================== */

/**
 * 报告 §1 的 R12-02（高危）。
 *
 * R11-03 把"删除"这一半改对了（回滚不再删目标侧既有对象），但**"覆盖"这一半没有出口**：
 *  - 复制一旦开始，目标侧同名对象的内容**已被源密文覆盖**（云端覆盖不可撤销）；
 *  - 回滚又刻意不删它 → 它不是「保留」，而是「换成了别人的内容」；
 *  - 失败路径上 `throw e` 排在 `migratePrefix` 之前 → 那份被覆盖的对象在
 *    `enc-meta.json` 里仍描述**旧明文**的参数 → 下载必然断流（crypto）或产出乱码（magic）。
 * 日志还写「按合并语义保留」，与事实完全相反。
 *
 * 修法是 (a)：动手前整体拒绝。因此本用例断言的是「**一个字节都没动**」——
 * 源仍在、目标仍是原内容、一个副本都没复制。
 */
test('R12-02 · 目标下存在同名对象时必须整体拒绝（409），且不得覆盖目标内容', async () => {
  fakeObjects.clear();
  fakeObjects.set('c2src/report.pdf', Buffer.from('src-version'));
  fakeObjects.set('c2src/new.txt', Buffer.from('src-new'));
  fakeObjects.set('c2dst/report.pdf', Buffer.from('dst-original')); // 同名 → 会被覆盖

  let threw = null;
  try {
    await gateway.movePrefix(BASE_CFG.bucket, 'c2src/', 'c2dst/');
  } catch (e) {
    threw = e;
  }
  assert(threw, '前置：存在同名冲突时必须抛错（本用例正是靠它验证"未做任何改动"）');
  assertEqual(threw.status, 409,
    'R12-02：冲突必须 409（与管理端 assertNoConflict 同款口径）—— 不是 400 也不是 500');

  assertEqual(fakeObjects.get('c2dst/report.pdf').toString(), 'dst-original',
    'R12-02：目标侧同名对象的内容**绝不能**被改写 —— 云端覆盖不可撤销，'
    + '回滚也删不掉它，于是它只会变成"别人的内容"；唯一正确做法是让它不发生');
  assert(fakeObjects.has('c2src/report.pdf') && fakeObjects.has('c2src/new.txt'),
    'R12-02：源目录必须原样保留（整体拒绝 = 一次都不复制）');
  assertEqual(fakeObjects.has('c2dst/new.txt'), false,
    'R12-02：冲突时**一个副本都不许复制**（旧实现会先复制一部分再进回滚）');

  // 正向对照：目标下没有同名对象时必须照常成功（守卫不得退化成"永不移动"）
  fakeObjects.clear();
  fakeObjects.set('c2ok/a.txt', Buffer.from('a'));
  fakeObjects.set('c2ok/b.txt', Buffer.from('b'));
  const r = await gateway.movePrefix(BASE_CFG.bucket, 'c2ok/', 'c2okdst/');
  assert(r && r.moved !== undefined, 'R12-02 正向对照：无冲突时必须正常完成移动');
  assert(fakeObjects.has('c2okdst/a.txt') && fakeObjects.has('c2okdst/b.txt'),
    'R12-02 正向对照：目标侧必须真的出现两个对象');
  assert(!fakeObjects.has('c2ok/a.txt'),
    'R12-02 正向对照：源必须被删除（证明走的是移动而不是复制）');
});

/* ================================================================== *
 * R12-03 · 退出路径的判据必须走唯一实现点
 * ================================================================== */

/**
 * 报告 §2 的 R12-03（中危，§9.3 R2 的核心）。
 *
 * 第 12 轮 §0.2 实测：`secure-store.exitPathWritable()` 被声明为 canonical，
 * 但生产侧**零调用**（`upload-sessions` 一份私有副本 + `enc-store` / `config-store`
 * 两处内联）。把 canonical 改成 `return true`，`invariants 15/15` 与 `audit11 15/15`
 * 全绿 —— 说明没有任何测试守住它。
 *
 * 因此本用例**打桩 canonical 本身**：把它换成「恒 false」，如果退出路径真的调用的是
 * 唯一实现点，那么目录被删之后就**一个字节都不该写、目录也不该被重建**。
 * 若某处仍留着私有副本（`fs.existsSync` 内联），它照样会 mkdir + 写盘 → 本条变红。
 */
test('R12-03 · 退出路径必须调用唯一实现点（打桩 canonical 后必须真的不写）', () => {
  const realJudge = secureStore.exitPathWritable;
  secureStore.exitPathWritable = () => false; // canonical 判据：一律"不可写"
  try {
    // 制造"待写内容"，再删掉数据目录 —— 正是测试收尾 / 运维清理的形态
    encStore.setMeta(BASE_CFG.bucket, 'exit12/probe.bin', encMetaOf(4));
    const sess = uploadSessions.create({
      uploadId: 'u-r12-03', key: 'exit12/probe.bin', bucket: BASE_CFG.bucket,
      region: BASE_CFG.region, size: 1024, chunkSize: 1024, provider: BASE_CFG.provider,
      createdBy: 'admin',
    });
    assert(sess, '前置：会话必须创建成功（否则 upload-sessions 侧无从验证）');

    fs.rmSync(TMP, { recursive: true, force: true });
    encStore.flushMetaSync();
    uploadSessions.flushSync();

    assert(!fs.existsSync(TMP),
      'R12-03：canonical 判据为 false 时退出路径**既不得写盘、也不得重建目录** —— '
      + '若这里仍然存在目录，说明某处还在用自己的私有副本（第 12 轮实测：三份实现）');
  } finally {
    secureStore.exitPathWritable = realJudge;
    if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });
  }

  // 正向对照：恢复真实判据 + 目录存在时，退出路径必须真的落盘
  encStore.setMeta(BASE_CFG.bucket, 'exit12/probe2.bin', encMetaOf(5));
  assertEqual(encStore.flushMetaSync(), true,
    'R12-03 正向对照：目录存在时退出路径必须真的落盘（守卫不得退化成永远不写）');
  assert(fs.existsSync(path.join(TMP, 'enc-meta.json')),
    'R12-03 正向对照：enc-meta.json 必须已写出');

  /**
   * **反向的一半**（没有它上面那条就是半真护栏）。
   *
   * 「canonical 为 false 时不写」在两种实现下都成立 —— 换成私有副本
   * `if (opts.exit && !fs.existsSync(DATA_DIR)) return` 同样不写（目录本来就不存在）。
   * 于是那条断言**抓不到**「走的是不是唯一实现点」。
   *
   * 真正能区分的判据是反过来：canonical 恒 **true**（人为给出错误判据）、目录却不存在。
   *  - 走 canonical → 照判据行事 → 真的写（并把目录建回来）；
   *  - 留着私有 `fs.existsSync` → 不写。
   * 这一半只可能由"接线真的通到 canonical"产生，因此它才是 R12-03 的实质护栏。
   */
  secureStore.exitPathWritable = () => true;
  try {
    encStore.setMeta(BASE_CFG.bucket, 'exit12/probe3.bin', encMetaOf(6));
    fs.rmSync(TMP, { recursive: true, force: true });
    encStore.flushMetaSync();
    assert(fs.existsSync(TMP),
      'R12-03 反向：canonical 判据被设为 true 时，退出路径必须**照判据行事**（真的写）—— '
      + '若这里目录仍不存在，说明某处还在用私有副本 `fs.existsSync` 而不是唯一实现点，'
      + '那么"改 canonical 就改了全部三处"这个前提不成立（第 12 轮 §0.2 的原型）');
  } finally {
    secureStore.exitPathWritable = realJudge;
    if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });
    encStore.flushMetaSync();
  }
});

/* ================================================================== *
 * R12-04 · WebDAV 目录 COPY 失败必须回滚
 * ================================================================== */

/**
 * 报告 §2 的 R12-04（中危）—— 第 3 处复制入口漏网。
 *
 * 管理端 `routes/fs.js` 与 `fs-gateway.movePrefix` 都有回滚，唯独 WebDAV 目录 COPY 的
 * `Promise.all` **外面没有 try/catch**：中途任一对象复制失败时直接落到外层 catch 回
 * 4xx/500，目标目录留下 N 个已复制对象、源仍在。R11-15 只修了性能，没修这个。
 *
 * 修复同时把回滚下沉成唯一实现点 `gateway.rollbackCopies()`（三处共用）。
 */
test('R12-04 · WebDAV 目录 COPY 中途失败必须回滚（目标侧不得残留副本）', async () => {
  await startDav();
  fakeObjects.clear();
  fakeObjects.set('cp12/', Buffer.alloc(0)); // 目录占位对象（WebDAV 用它判定源存在）
  fakeObjects.set('cp12/a.bin', Buffer.from('a'));
  fakeObjects.set('cp12/b.bin', Buffer.from('b'));
  fakeObjects.set('cp12/c.bin', Buffer.from('c'));
  fakeObjects.set('cp12/d.bin', Buffer.from('d'));

  copyFailKeys = new Set(['cp12dst/c.bin']); // 第 3 个失败 → 前两个已复制
  let r;
  try {
    r = await request(davPort, 'COPY', '/dav/cp12/', {
      tls: true,
      headers: Object.assign({
        Destination: `https://127.0.0.1:${davPort}/dav/cp12dst`,
        Overwrite: 'T',
      }, AUTH),
    });
  } finally {
    copyFailKeys = null;
  }
  /**
   * 断言取**精确值** 500 而不是 `>= 400`：注入的复制失败是 500，而"源不存在"是 404。
   * 写成 `>= 400` 时，万一目录标记对象没建、请求根本没走到复制分支，断言照样全绿
   * —— 那就是一条测了个空的正向断言（§9.1 G4① 的同型陷阱）。
   */
  assertEqual(r.status, 500, `R12-04：复制失败必须如实报错（实际 ${r.status}）`);

  const leftovers = [...fakeObjects.keys()].filter((k) => k.startsWith('cp12dst/'));
  assertEqual(leftovers.length, 0,
    `R12-04：目标目录必须回到「源在目标不在」这一干净起点（残留 ${leftovers.length} 个：`
    + `${leftovers.slice(0, 3).join('、')}）—— 半份副本会让容量翻倍，用户重试再叠一层`);
  assert(fakeObjects.has('cp12/a.bin') && fakeObjects.has('cp12/d.bin'),
    'R12-04：源目录必须原样保留（回滚不得动源）');

  // 正向对照：不注入失败时目录 COPY 必须照常成功
  copyFailKeys = null;
  const okr = await request(davPort, 'COPY', '/dav/cp12/', {
    tls: true,
    headers: Object.assign({
      Destination: `https://127.0.0.1:${davPort}/dav/cp12ok`,
      Overwrite: 'T',
    }, AUTH),
  });
  assertEqual(okr.status, 201, `R12-04 正向对照：正常 COPY 必须 201（实际 ${okr.status}）`);
  assertEqual([...fakeObjects.keys()].filter((k) => k.startsWith('cp12ok/')).length, 4,
    'R12-04 正向对照：4 个对象必须全部复制成功（回滚逻辑不得误伤成功路径）');
});

/* ================================================================== *
 * R12-05 · magic 分片缺 chunkSize 的 NaN 偏移（最内层兜底）
 * ================================================================== */

/**
 * 报告 §2 的 R12-05（中危）。
 *
 * `base = (partNumber - 1) * sess.chunkSize` —— 会话没有 `chunkSize` 时是 `NaN`：
 * 第 1 片成功并 `touch()` 落盘，第 2 片起一律 `RangeError` 500，任务**永久卡死**
 * （只能取消重传，旧分片持续计费到下次 prune）。同时 `normalisePartDigests` 返回
 * `null` → `integrity: 'none'`，FUN-11 的完整性校验**同时失效**（比 500 更隐蔽）。
 *
 * 修法是"入口 + 最内层各挡一次"（§9.3 R4）：路由层已由 audit11 的 R11-08 用例守着，
 * 这里守**最内层 `encryptPart` 自己**—— 无论谁调它都躲不掉。
 */
test('R12-05 · magic 模式下缺 chunkSize 时 encryptPart 必须自己拒绝（最内层兜底）', async () => {
  await encStore.updateSettings({ mode: 'magic' });
  try {
    let threw = null;
    try {
      encStore.encryptPart({ enc: null }, 1, Buffer.alloc(1024, 0x41)); // 刻意不给 chunkSize
    } catch (e) { threw = e; }
    assert(threw,
      'R12-05：magic 分片缺少有效 chunkSize 时，`encryptPart` **自身**必须拒绝 —— '
      + '放行会让第 2 片起的偏移变成 NaN（RangeError 500，任务永久卡死），'
      + '且完整性校验退化为 none');
    assertEqual(threw.status, 409,
      `R12-05：应以 409 明确表达「分片参数不可用」（实际 ${threw.status}）—— `
      + '500 会让客户端以为服务端故障而去重试，越试越卡');

    // 正向对照：给了合法 chunkSize 就必须正常加密（含第 2 片，证明偏移不是 NaN）
    const p1 = encStore.encryptPart({ enc: null, chunkSize: 1024 }, 1, Buffer.alloc(1024, 0x42));
    const p2 = encStore.encryptPart({ enc: null, chunkSize: 1024 }, 2, Buffer.alloc(1024, 0x43));
    assert(Buffer.isBuffer(p1) && Buffer.isBuffer(p2),
      'R12-05 正向对照：有 chunkSize 时两片都必须正常加密（第 2 片正是 NaN 偏移的爆点）');
  } finally {
    await encStore.updateSettings({ mode: 'none' });
  }
});

/* ================================================================== *
 * R12-06 · 目标目录过大：专属文案 + 零改动
 * ================================================================== */

/**
 * 报告 §2 的 R12-06（中危）。
 *
 * `existedBefore` 用的是 `listAllExact(cap: LIMITS.HARD_MAX)`：① 每次目录 MOVE 都要对
 * 目标前缀做一次完整递归列举（目标 1 万对象 = 10 次串行云端往返），与 R11-15 刚为
 * COPY 省掉往返的方向相反；② 目标 ≥5 万时 MOVE 直接 400，而 `listAllExact` 的文案是
 * 「为避免只复制一部分就删除源数据…请分批移动」—— **一个字节都没复制**，文案自相矛盾。
 *
 * 修法：`cap` 降到 `LIMITS.STAT`（20000），超限给专属文案。
 */
test('R12-06 · 目标目录过大时必须给专属文案，且未做任何改动', async () => {
  assert(LIMITS.STAT < LIMITS.HARD_MAX,
    `R12-06 前置：目标探测的上限必须小于 HARD_MAX（STAT=${LIMITS.STAT}, HARD_MAX=${LIMITS.HARD_MAX}）`
    + ' —— 用 HARD_MAX 会让每次 MOVE 都对目标做一次完整递归列举');

  fakeObjects.clear();
  fakeObjects.set('bigsrc/a.bin', Buffer.from('a'));
  fakeObjects.set('bigsrc/b.bin', Buffer.from('b'));
  bigPrefix = 'bigdst/';
  let threw = null;
  try {
    await gateway.movePrefix(BASE_CFG.bucket, 'bigsrc/', 'bigdst/');
  } catch (e) {
    threw = e;
  } finally {
    bigPrefix = null;
  }
  assert(threw, '前置：目标目录过大时必须抛错中止');
  assertEqual(threw.status, 400, `R12-06：应以 400 中止（实际 ${threw.status}）`);
  assert(/目标目录/.test(threw.message) && /未做任何改动/.test(threw.message),
    `R12-06：必须是**专属文案**（说明"目标过大、无法安全回滚、未做任何改动"），`
    + `而不是复用「请分批移动」—— 后者与"一个字节都没复制"自相矛盾。实际：${threw.message}`);
  assert(!/请分批移动/.test(threw.message),
    'R12-06：不得再出现「请分批移动」这种把源侧超限与目标侧超限混为一谈的文案');
  assert(fakeObjects.has('bigsrc/a.bin') && fakeObjects.has('bigsrc/b.bin'),
    'R12-06：中止时源目录必须原样保留（一个都没复制）');
});

/* ================================================================== *
 * R12-07 · 元数据迁移后必须立刻同步落盘
 * ================================================================== */

/**
 * 报告 §3 的 R12-07（低危）。
 *
 * `flushMetaSync()` 被新增并导出，但生产侧**零调用**（全库仅测试用）。而 `migratePrefix`
 * 用的是异步 `persistMeta()`，紧接其后就是批量删源 —— 该窗口内被 SIGKILL / OOM
 * （**不触发 exit 钩子**）打断时，目标位置已是新密文、凭据却还没落盘 →
 * 目标目录全部文件永久不可解。R11-02 修好了顺序，SEC-08 的落盘窗口没闭合。
 *
 * 断言「迁移之后立刻不再脏」—— 这正是"已同步落盘"的唯一可观测后果。
 */
test('R12-07 · 目录 MOVE 的元数据迁移完成后必须已同步落盘（不再脏）', async () => {
  fakeObjects.clear();
  fakeObjects.set('fl12/a.bin', Buffer.from('cipher-a'));
  encStore.setMeta(BASE_CFG.bucket, 'fl12/a.bin', encMetaOf(9));
  assert(encStore.metaDirty(), '前置：应存在尚未落盘的元数据变更（否则本条是空转）');

  await gateway.movePrefix(BASE_CFG.bucket, 'fl12/', 'fl12dst/');

  assert(encStore.getMeta(BASE_CFG.bucket, 'fl12dst/a.bin'),
    '前置：元数据必须已迁到目标侧');
  assertEqual(encStore.metaDirty(), false,
    'R12-07：`migratePrefix` 之后必须**立刻同步落盘**再往下走删源 —— '
    + '迁移用的是异步 persistMeta()，与删源之间被打断（SIGKILL/OOM 不触发 exit 钩子）时，'
    + '目标已是新密文而凭据未落盘 → 永久不可解');
});

/* ================================================================== *
 * R12-12 · bucketOfIdent 必须取倒数第 2 段
 * ================================================================== */

/**
 * 报告 §3 的 R12-12（低危）。
 *
 * `bucketIdentMatches` 曾硬编码「4 段、第 3 段是桶名」，而段数约定（`bucketCacheKey`）
 * 定义在另一个文件。给 `bucketCacheKey` 增加第 5 个维度（很自然的演进）后
 * `parts.length === 4` 恒假 → `invalidateBucket()` 对所有生产键**静默返回 0**
 * —— 写完对象后列举不刷新，且没有任何报错。
 *
 * 修法：导出 `bucketOfIdent()`，约定「桶名恒为倒数第 2 段」。
 */
test('R12-12 · bucketOfIdent 取倒数第 2 段（加维度不失效）+ 失效联动', () => {
  listCache.clear();
  const cfgA = { provider: 'tencent', secretId: 'AK-A', bucket: 'same-name', region: 'ap-guangzhou' };
  const identA = shared.bucketCacheKey(cfgA);

  assertEqual(listCache.bucketOfIdent(identA), 'same-name',
    `R12-12：4 段形态必须解析出桶名（实际 ident=${identA}）`);
  // 演进形态：前面多加一个维度（段数 4 → 5），桶名仍是倒数第 2 段
  assertEqual(listCache.bucketOfIdent(`extra|${identA}`), 'same-name',
    'R12-12：段数增加后仍必须解析出桶名 —— 旧实现硬编码 `parts.length === 4`，'
    + '加维度后对所有生产键静默返回 0（写完对象列举不刷新，且无任何报错）');
  assertEqual(listCache.bucketOfIdent('same-name'), 'same-name',
    'R12-12：纯桶名形态必须保持兼容');

  // 失效联动：5 段形态的缓存条目也必须能被 invalidateBucket 清掉
  const k5 = listCache.keyOf(`extra|${identA}`, 'p/', '', 1000, '/', 'list');
  const k4 = listCache.keyOf(identA, 'p/', '', 1000, '/', 'list');
  listCache.set(k5, { v: 'A5' });
  listCache.set(k4, { v: 'A4' });
  assert(listCache.get(k5) && listCache.get(k4), '前置：两种形态的条目都应写入成功');
  assertEqual(listCache.invalidateBucket('same-name'), 2,
    'R12-12：invalidateBucket 必须清掉**所有段数形态**下同桶的条目（键变了却失效不了 = 串味）');
  assertEqual(listCache.size(), 0, 'R12-12：该桶的条目不应残留');
});

/* ================================================================== *
 * R12-13 · 并发回滚不得留下孤儿
 * ================================================================== */

/**
 * 报告 §3 的 R12-13（低危）。
 *
 * `Promise.all` 拒绝后**其余 worker 仍在继续**：`fresh` 快照在 `catch` 里算，
 * 晚于它的 `copied.push()` 不进 `fresh` → 目标侧残留孤儿；而日志因
 * `removed === fresh.length` 写「已回滚 8/8」，「残留孤儿需手工清理」的告警
 * **永不触发** —— 日志谎报「已完整回滚」。
 *
 * 修法：失败时先置 `stopped`，再 `allSettled` 等所有 worker 真正停下，**然后**取快照。
 *
 * 断言取「目标侧残留数 === 0」这个**后果**：它同时覆盖"孤儿没回滚"与"日志谎报"两半。
 */
test('R12-13 · 并发复制失败回滚后，目标侧不得残留任何孤儿', async () => {
  fakeObjects.clear();
  const N = 12; // 多于 worker 数（5），确保失败发生时其它 worker 仍在飞
  for (let i = 0; i < N; i += 1) {
    fakeObjects.set(`race12/f-${String(i).padStart(2, '0')}.bin`, Buffer.from('x'.repeat(i + 1)));
  }
  // 让第一个被取走的任务失败：其余 4 路 worker 仍在飞（copyDelayMs 保证这一点）
  copyFailKeys = new Set(['race12dst/f-00.bin']);
  copyDelayMs = 40;
  cloudCalls.copyAttempts = 0;

  let threw = null;
  try {
    await gateway.movePrefix(BASE_CFG.bucket, 'race12/', 'race12dst/');
  } catch (e) {
    threw = e;
  } finally {
    copyFailKeys = null;
    copyDelayMs = 0;
  }
  assert(threw, '前置：复制失败必须向上抛（本用例正是由它触发并发回滚）');

  /**
   * 孤儿是**在回滚之后才落地**的：旧实现在 `Promise.all` 拒绝的当下就取了快照
   * （此时在飞的 4 路 worker 什么都还没 push），于是它删掉 0 个、抛出、返回；
   * 那 4 个对象随后才被 write 进目标目录。因此断言必须**等到它们有机会落地之后**
   * 再数残留 —— 立刻数会得到 0，护栏就空转了（这是"时序型"缺陷特有的取样陷阱）。
   */
  await new Promise((r) => setTimeout(r, 200));

  const leftovers = [...fakeObjects.keys()].filter((k) => k.startsWith('race12dst/'));
  assertEqual(leftovers.length, 0,
    `R12-13：回滚后目标侧必须**零残留**（实际残留 ${leftovers.length} 个：`
    + `${leftovers.slice(0, 5).join('、')}）—— 旧实现在 Promise.all 拒绝后立刻取快照，`
    + '仍在飞的 worker 之后 push 的键不进快照 → 孤儿留在目标目录，'
    + '而日志因 removed === fresh.length 谎报「已完整回滚」');
  assertEqual([...fakeObjects.keys()].filter((k) => k.startsWith('race12/')).length, N,
    'R12-13：源目录必须完整保留（回滚只动目标侧）');
  assert(cloudCalls.copyAttempts < N,
    `R12-13：失败后必须**停止启动新任务**（实际尝试复制 ${cloudCalls.copyAttempts} 次 / 共 ${N} 个对象）`
    + ' —— `stopped` 标志的那一半：没有它，worker 会把剩下 7 个对象全部复制一遍再回滚，'
    + '一次失败变成整目录的无效云端往返（且按量计费）');

  // 正向对照：没有失败时，12 个对象必须全部移动成功
  fakeObjects.clear();
  for (let i = 0; i < N; i += 1) {
    fakeObjects.set(`race12ok/f-${String(i).padStart(2, '0')}.bin`, Buffer.from('y'));
  }
  await gateway.movePrefix(BASE_CFG.bucket, 'race12ok/', 'race12okdst/');
  assertEqual([...fakeObjects.keys()].filter((k) => k.startsWith('race12okdst/')).length, N,
    'R12-13 正向对照：全部成功时必须完整移动（stopped 标志不得误伤正常路径）');
  assertEqual([...fakeObjects.keys()].filter((k) => k.startsWith('race12ok/')).length, 0,
    'R12-13 正向对照：源必须被删干净');
});

/* ================================================================== *
 * 附带 · shareStore 的引用（保持与 audit11 同型，避免未使用告警）
 * ================================================================== */

test('附带 · 前置自检：本轮用到的模块均已加载', () => {
  assert(typeof shareStore.markMissingByKeys === 'function', 'shareStore 应可用');
  assert(typeof gateway.rollbackCopies === 'function',
    'R12-04：gateway.rollbackCopies 必须是导出的唯一实现点');
});
