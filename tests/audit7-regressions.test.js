/**
 * 测试：第 7 轮审计修复的回归护栏（见开发文档「六、审计发现台账 6.4」）
 *
 * 编排原则与前面几轮一致：
 *  - **起真实的 express + 真实路由**，只把最外层的云端客户端（`cos.getClient` / `cos.p`）打桩，
 *    这样断言打在「路由实际用哪个厂商的客户端发了哪个请求」上，而不是打在源码文本上；
 *  - 打桩必须在 require 路由**之前**完成 —— fs.js 在模块加载时就解构了 `getClient` / `p`，
 *    事后替换不生效；
 *  - 数据目录用 `COS_DATA_DIR` 指到临时目录，不触碰项目真实 data/。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const test = require('node:test');
const { assert, assertEqual, ROOT, cleanupTempDir } = require('./helpers');

/* 必须在 require 任何 server 模块之前设置：upload-sessions / enc-store / stats-store
   都在模块加载时就把数据目录解析成常量了。 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-audit7-'));
process.env.COS_DATA_DIR = TMP;

const cos = require(path.join(ROOT, 'server', 'cos.js'));
const configStore = require(path.join(ROOT, 'server', 'config-store.js'));
const uploadSessions = require(path.join(ROOT, 'server', 'upload-sessions.js'));

/* ---------------- 云端客户端打桩 ---------------- */

/** 所有 getClient 调用（记录下路由最终决定用哪个厂商） */
const clientCalls = [];
/** 所有 p() 调用（记录下每个云端动作实际用的客户端厂商） */
const pCalls = [];
/** 可逐用例替换的钩子：默认走「一切都成功」的桩，个别失败路径用例再覆盖 */
const hooks = { putObject: null, p: null, listAll: null, listAllInfo: null, listAllExact: null };

cos.getClient = (cfg) => {
  clientCalls.push({ provider: cfg && cfg.provider, bucket: cfg && cfg.bucket });
  return {
    __provider: cfg && cfg.provider,
    // fs-gateway.writeObject 直接回调式调用 putObject（不经 p()，见 R7-06），
    // 因此这里必须单独留一个可失败的入口。
    putObject(params, cb) {
      if (hooks.putObject) return hooks.putObject(params, cb);
      return cb(null, {});
    },
    // R7-08 用：写入少量字节后**故意不 end** —— 模拟下载卡住、流无人消费的场景
    getObject(params, cb) {
      if (params && params.Output) params.Output.write(Buffer.alloc(1));
      if (hooks.getObject) return hooks.getObject(params, cb);
      if (cb) cb(null, {});
    },
  };
};

const listCache = require(path.join(ROOT, 'server', 'list-cache.js'));

cos.p = async (client, method, params) => {
  pCalls.push({ provider: client && client.__provider, method, params });
  // 忠实复刻真实 p() 的咽喉点副作用：写操作一律让该桶的列举缓存失效
  listCache.noteCall(method, params);
  if (hooks.p) return hooks.p(client, method, params);
  // 客户端自带该方法的（如 putObject）如实走它 —— 这样「让 putObject 失败」的用例
  // 无论路由是否经过 p() 都能命中，护栏不会因实现改成走 p() 而失效
  if (client && typeof client[method] === 'function') {
    return new Promise((resolve, reject) => {
      client[method](params, (err, data) => (err ? reject(err) : resolve(data)));
    });
  }
  switch (method) {
    case 'headObject': return { headers: {} };
    case 'multipartInit': return { UploadId: 'upload-id-1' };
    case 'multipartListPart': return { ListPartsResult: { Part: [] } };
    case 'multipartUpload': return { ETag: '"etag-1"' };
    case 'multipartComplete': return { Location: 'x', ETag: '"etag-final"' };
    case 'multipartAbort': return {};
    // 真实客户端（`cos-nodejs-sdk-v5` 与自研 s3-client）都回 `Deleted` 列表
    // （Quiet 缺省为 false）。桩若回 `{}`，删除会被判为「云端未确认」。
    case 'deleteMultipleObject':
      return { Deleted: (params.Objects || []).map((o) => ({ Key: o.Key })), Error: [] };
    default: return {};
  }
};

// 列举类桩：R7-03 的「清空桶 / 彻底删桶」用例需要控制「桶里有什么」
cos.listAll = async () => (hooks.listAll ? hooks.listAll() : []);
cos.listAllInfo = async (_client, _cfg, prefix) => (
  hooks.listAllInfo ? hooks.listAllInfo(prefix) : { items: [], truncated: false, count: 0 }
);
// listAllExact 与 listAllInfo 不同：它返回的是 **items 数组**（超限时直接抛错）
cos.listAllExact = async (_client, _cfg, prefix) => (
  hooks.listAllExact ? hooks.listAllExact(prefix) : []
);

// 注意：上面这些替换完成后才加载路由 / 网关
const fsRoutes = require(path.join(ROOT, 'server', 'routes', 'fs.js'));
const bucketsRoutes = require(path.join(ROOT, 'server', 'routes', 'buckets.js'));
const shareRoutes = require(path.join(ROOT, 'server', 'share-routes.js')); // 挂载点是根（路由自带 /s 前缀）
const fsGateway = require(path.join(ROOT, 'server', 'fs-gateway.js'));
const encStore = require(path.join(ROOT, 'server', 'enc-store.js'));
const shareStore = require(path.join(ROOT, 'server', 'share-store.js'));

/* ---------------- 配置播种（R12-01） ---------------- */

/**
 * R12-01：本文件的两个 R7-04 用例此前**依赖真实 `data/config.enc`**。
 *
 * 根因是 `server/config-store.js` 曾是全库唯一不读 `COS_DATA_DIR` 的 store
 * （`DATA_DIR` 硬编码）—— 于是本文件虽然把 `COS_DATA_DIR` 指到了 TMP，
 * `configStore.load()` 读到的**仍然是生产配置**。这不只是「测试依赖外部环境」，
 * 它还是一次**真实的数据事故**：`save()` 类操作会把生产 `config.enc` 重新加密写盘
 * （详见开发文档「六、审计发现台账 6.4」，第 12 轮曾实际发生数据事故）。
 *
 * 隔离修好之后 TMP 里当然是空的 —— 所以这里必须自己播种。写 Daisy数据到隔离目录，
 * 完全不碰生产 `data/`。这条也是对外表态：**用例依赖生产环境残留状态的，应当在本轮清掉。**
 */
const SEED_BUCKET_ID = 'bkt-audit7';
configStore.save({
  credentials: [{
    id: 'cred-audit7', provider: 'tencent',
    secretId: 'stub-id', secretKey: 'stub-key',
    enabled: true, visibleToUsers: true, remark: 'audit7 播种数据（COS_DATA_DIR 隔离目录）',
  }],
  buckets: [{
    id: SEED_BUCKET_ID, provider: 'tencent',
    bucket: 'audit7-bucket', region: 'ap-guangzhou',
    credentialId: 'cred-audit7', enabled: true, active: true,
    remark: 'audit7 播种数据（COS_DATA_DIR 隔离目录）',
  }],
  activeCredentialId: 'cred-audit7',
  activeBucketId: SEED_BUCKET_ID,
});
// `save()` 走去抖写盘，此刻文件未必已落盘；这里只需确认**缓存视图**已就位
// （「必须落到 COS_DATA_DIR」这一半由 `tests/audit12-regressions.test.js` 的 R12-01 用例守）
assert(configStore.load() && configStore.load().activeBucketId === SEED_BUCKET_ID,
  'R12-01 前置：播种的激活桶必须能被 load() 读到（隔离目录为空集会:i 份数据也要能自足）');

/* ---------------- 配置打桩 ---------------- */

const ALI_CFG = {
  secretId: 'LTAI-stub', secretKey: 'stub-secret',
  bucket: 'ali-demo-bucket', region: 'oss-cn-hangzhou', provider: 'aliyun',
};

const realGet = configStore.get;
const realEffective = configStore.effectiveForBucket;

function useConfig(cfg) {
  configStore.get = () => cfg;
  configStore.effectiveForBucket = () => cfg;
}
function restoreConfig() {
  configStore.get = realGet;
  configStore.effectiveForBucket = realEffective;
}

/* ---------------- 起服务 ---------------- */

function startApp() {
  const express = require(path.join(ROOT, 'node_modules', 'express'));
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.use((req, _res, next) => {
    req.authUser = { id: 'u1', username: 'admin', role: 'admin' };
    next();
  });
  app.use('/api', fsRoutes);
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function raw(port, method, urlPath, body, contentType) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: urlPath, method,
      headers: {
        'Content-Type': contentType || 'application/octet-stream',
        'Content-Length': body.length,
        'X-Requested-With': 'XMLHttpRequest',
      },
    }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* 非 JSON */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

function json(port, method, urlPath, body) {
  const payload = JSON.stringify(body || {});
  return raw(port, method, urlPath, Buffer.from(payload), 'application/json');
}

/* ============================================================
 * R7-01 · 分片上传会话必须记录 provider
 * ========================================================== */

/**
 * 这是本轮最硬的一条：**非腾讯云厂商上传 >8MB 必然失败**。
 *
 * init 用 `getClient(cfg)`（正确的阿里云客户端）创建 UploadId，但会话里 provider 被写成
 * 默认的 `tencent`；后续 chunk / complete / abort 走 `getClientForSession()`，
 * 被强制换成「COS SDK + 阿里云 AK/Endpoint」→ 首个分片即失败，已创建的 UploadId
 * 既不能合并也不能中止（中止也用错客户端），云端分片持续计费。
 *
 * 断言打在最终行为上：分片上传这一步实际使用的客户端厂商，必须与初始化时一致。
 */
test('R7-01 · 分片上传：会话记录的 provider 与目标桶一致（非腾讯云厂商不被退化成 COS SDK）', async () => {
  useConfig(ALI_CFG);
  clientCalls.length = 0;
  pCalls.length = 0;
  const srv = await startApp();
  try {
    const size = 20 * 1024 * 1024; // > SIMPLE_THRESHOLD(8MB) → 走分片
    const init = await json(srv.port, 'POST', '/api/fs/upload/init', { key: 'dir/big.bin', size });
    assertEqual(init.status, 200, `init 应成功（实际 ${init.status} ${init.text || ''}）`);
    const sessionId = init.json && init.json.sessionId;
    assert(sessionId, 'init 应返回 sessionId');

    const sess = uploadSessions.get(sessionId);
    assert(sess, '会话应已落库');
    assertEqual(sess.provider, 'aliyun',
      'R7-01：会话必须记录目标桶的真实厂商。若回退成默认 tencent，' +
      '后续 chunk/complete/abort 会用 COS SDK 去打阿里云 Endpoint —— 非腾讯云厂商 >8MB 上传必然失败');

    // 分片上传这一步：断言实际使用的客户端厂商
    const before = pCalls.length;
    const chunk = await raw(srv.port, 'PUT',
      `/api/fs/upload/chunk?session=${encodeURIComponent(sessionId)}&part=1`,
      Buffer.alloc(1024, 1));
    assertEqual(chunk.status, 200, `chunk 应成功（实际 ${chunk.status} ${chunk.text || ''}）`);

    const uploads = pCalls.slice(before).filter((c) => c.method === 'multipartUpload');
    assert(uploads.length > 0, 'chunk 应触发 multipartUpload');
    assertEqual(uploads[0].provider, 'aliyun',
      'R7-01：分片上传必须使用与 init 相同的厂商客户端（这里是 aliyun），' +
      '否则等于「用腾讯云 SDK 的签名去请求阿里云」');
  } finally {
    await srv.close();
    restoreConfig();
  }
});

/**
 * 腾讯云自身不能因为这次改动而退化：会话 provider 与 cfg 一致时，`getClientForSession`
 * 走的是 `getClient(cfg)` 分支，同样必须是 tencent。
 */
test('R7-01 · 腾讯云桶行为不变（会话 provider 仍为 tencent）', async () => {
  useConfig({
    secretId: 'AKIDstub', secretKey: 'stub',
    bucket: 'tc-demo-bucket', region: 'ap-guangzhou', provider: 'tencent',
  });
  clientCalls.length = 0;
  pCalls.length = 0;
  const srv = await startApp();
  try {
    const init = await json(srv.port, 'POST', '/api/fs/upload/init',
      { key: 'dir/big2.bin', size: 20 * 1024 * 1024 });
    assertEqual(init.status, 200, `init 应成功（实际 ${init.status}）`);
    const sess = uploadSessions.get(init.json.sessionId);
    assertEqual(sess.provider, 'tencent', '腾讯云桶的会话 provider 应为 tencent');
  } finally {
    await srv.close();
    restoreConfig();
  }
});

/**
 * `create()` 本身也必须尊重传入的 provider —— 这是 R7-01 的根因所在：
 * 传了就该用传的，没传才回退默认厂商。
 */
test('R7-01 · uploadSessions.create 尊重显式 provider，仅在缺失时回退默认厂商', () => {
  const a = uploadSessions.create({
    uploadId: 'u-a', key: 'k', bucket: 'b', region: 'r', size: 1, chunkSize: 1, provider: 'qiniu',
  });
  assertEqual(a.provider, 'qiniu', '显式传入的 provider 必须被采用（不得被默认值覆盖）');
  const b = uploadSessions.create({
    uploadId: 'u-b', key: 'k2', bucket: 'b', region: 'r', size: 1, chunkSize: 1,
  });
  assert(b.provider, '未传 provider 时仍应回退到默认厂商（历史会话兼容）');
  uploadSessions.remove(a.id);
  uploadSessions.remove(b.id);
});

/* ============================================================
 * R7-02 · 加密元数据必须在云端写入成功之后才落盘
 * ========================================================== */

const OLD_META = {
  mode: 'crypto', origSize: 10, createdAt: '2020-01-01T00:00:00.000Z',
  crypto: { segments: [{ n: 1, iv: 'aa'.repeat(6), ctLen: 10, tag: 'bb'.repeat(8) }] },
};

/**
 * 背景：`encryptBuffer()` 内部直接 `setMeta()`，而 `setMeta()` 会立刻排一次异步落盘 ——
 * 于是顺序是「先改本地凭据，再写云端」。`putObject` 一旦失败（超时 / 413 / 断网 / 权限），
 * 云端仍是**旧密文**，本地 IV / TAG / 盐却已被新值覆盖 → 该文件**永久不可解**。
 *
 * 断言：模拟云端写入失败后，元数据必须**原封不动**。
 */
test('R7-02 · 云端写入失败时，加密元数据必须保持旧值（不得先于云端写入）', async () => {
  useConfig(ALI_CFG);
  encStore.updateSettings({ mode: 'crypto', password: '' });
  const bucket = ALI_CFG.bucket;
  const key = 'enc/fail-case.bin';

  encStore.setMeta(bucket, key, JSON.parse(JSON.stringify(OLD_META)));
  encStore.flushMeta();

  hooks.putObject = (_params, cb) => cb(new Error('模拟云端写入失败（超时/413/权限）'));
  let threw = false;
  try {
    await fsGateway.writeObject(bucket, key, Buffer.from('全新的明文内容'), 'application/octet-stream', null, null);
  } catch (e) {
    threw = true;
  } finally {
    hooks.putObject = null;
    restoreConfig();
  }
  assert(threw, '云端写入失败必须向上抛出（不能假装成功）');

  const after = encStore.getMeta(bucket, key);
  assert(after, '元数据应仍然存在（旧密文仍可解）');
  assertEqual(after.crypto.segments[0].iv, OLD_META.crypto.segments[0].iv,
    'R7-02：云端写入失败后，本地 IV 必须仍是旧值 —— 若已被新 IV 覆盖，云端旧密文将永久不可解');
  assertEqual(after.createdAt, OLD_META.createdAt, 'R7-02：元数据整体不得被新条目覆盖');
});

/** 成功路径必须照旧：密文落云后元数据立即落盘（SEC-08 的窗口仍要压到零） */
test('R7-02 · 云端写入成功后，元数据立即写入并同步落盘', async () => {
  useConfig(ALI_CFG);
  encStore.updateSettings({ mode: 'crypto', password: '' });
  const bucket = ALI_CFG.bucket;
  const key = 'enc/ok-case.bin';
  encStore.flushMeta();
  try {
    const r = await fsGateway.writeObject(bucket, key, Buffer.from('成功写入的明文'), 'application/octet-stream', null, null);
    assertEqual(r.encrypted, true, 'crypto 模式下应已加密写入');
    const meta = encStore.getMeta(bucket, key);
    assert(meta && meta.crypto && meta.crypto.segments.length === 1, '成功后必须写入加密元数据');
    assertEqual(encStore.metaDirty(), false, 'SEC-08：写入后必须已同步落盘，不留「云端有密文本地没凭据」的窗口');
  } finally {
    restoreConfig();
  }
});

/** 契约本身：加密阶段不得触碰元数据存储（这是上面两条能成立的前提） */
test('R7-02 · encryptBuffer 不得写元数据（写入责任留给「云端确认成功后」）', () => {
  encStore.updateSettings({ mode: 'crypto', password: '' });
  encStore.flushMeta();
  assertEqual(encStore.metaDirty(), false, '前置条件：无未落盘变更');
  const r = encStore.encryptBuffer('r7-bucket', 'r7-no-write.bin', Buffer.from('abc'));
  assert(r && r.meta && r.data, '应返回 { data, meta }');
  assertEqual(encStore.getMeta('r7-bucket', 'r7-no-write.bin'), null,
    'encryptBuffer 只负责产出密文与元数据，不得落盘 —— 落盘必须由调用方在云端写入成功后执行');
  assertEqual(encStore.metaDirty(), false, 'encryptBuffer 不得产生任何未落盘变更');
});

/* ============================================================
 * R7-03 · 凡是会删掉对象的入口，都必须标记分享链接「文件已删除」
 * ========================================================== */

const DESTROY_BUCKET = { id: 'r7-bid', bucket: 'r7-bucket', region: 'ap-guangzhou', provider: 'tencent' };

/** 造一条指向指定桶/对象的分享链接（无密码、不付费、永久有效、不限次数） */
async function makeLink(bucket, key) {
  return shareStore.create({
    key, bucket, region: 'ap-guangzhou', fileName: key.split('/').pop(), size: 1024,
    expiresHours: 0, maxDownloads: 0, password: null, paid: null, createdBy: 'tester',
  });
}
/** 状态判定必须喂「记录」而不是 view() 产出的视图（视图没有 missingAt，会判出假结果） */
function statusOf(id) { return shareStore.status(shareStore.get(id)); }

/** 起一个挂 buckets 路由的服务（管理员身份） */
function startBucketsApp() {
  const express = require(path.join(ROOT, 'node_modules', 'express'));
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.use((req, _res, next) => {
    req.authUser = { id: 'u1', username: 'admin', role: 'admin' };
    next();
  });
  app.use('/api', bucketsRoutes);
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: server.address().port, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

/**
 * WebDAV 侧删除（fs-gateway.deleteObject）此前**完全没接**标记：
 * 通过 WebDAV 删掉文件后，管理页仍显示链接「有效」，分享页仍给下载按钮。
 */
test('R7-03 · WebDAV 删除单个对象后，关联分享链接判定为 deleted', async () => {
  useConfig(ALI_CFG);
  const link = await makeLink(ALI_CFG.bucket, 'wv/single.txt');
  try {
    assertEqual(statusOf(link.id), 'active', '前置条件：新建链接应为 active');
    await fsGateway.deleteObject(ALI_CFG.bucket, 'wv/single.txt', null, null);
    assertEqual(statusOf(link.id), 'deleted',
      'R7-03：WebDAV 删除对象后，指向它的分享链接必须标记为「文件已删除」');
  } finally {
    restoreConfig();
  }
});

/** 删目录同理：只认本批**已确认删除**的 key，绝不按前缀标记 */
test('R7-03 · WebDAV 删除目录后，目录下对象的分享链接判定为 deleted', async () => {
  useConfig(ALI_CFG);
  const inDir = await makeLink(ALI_CFG.bucket, 'wv/dir/a.txt');
  const outDir = await makeLink(ALI_CFG.bucket, 'wv/other.txt');
  hooks.listAllInfo = () => ({ items: [{ key: 'wv/dir/a.txt', size: 5 }], truncated: false });
  try {
    await fsGateway.deletePrefix(ALI_CFG.bucket, 'wv/dir', null, null);
    assertEqual(statusOf(inDir.id), 'deleted', 'R7-03：目录内对象的链接必须被标记');
    assertEqual(statusOf(outDir.id), 'active',
      'R7-03：标记必须按「已确认删除的 key」逐个比对，不得按前缀连坐误伤目录外的链接');
  } finally {
    hooks.listAllInfo = null;
    restoreConfig();
  }
});

/** 清空桶：trackedDeletePrefix 的回调此前只清加密元数据 */
test('R7-03 · 清空存储桶后，桶内对象的分享链接判定为 deleted', async () => {
  useConfig(Object.assign({}, DESTROY_BUCKET, { secretId: 'sid', secretKey: 'skey' }));
  const realListBuckets = configStore.listBuckets;
  const link = await makeLink(DESTROY_BUCKET.bucket, 'clear-me.txt');
  configStore.listBuckets = () => ({ buckets: [DESTROY_BUCKET] });
  hooks.listAllInfo = () => ({ items: [{ key: 'clear-me.txt', size: 7 }], truncated: false });
  const srv = await startBucketsApp();
  try {
    const r = await json(srv.port, 'POST', `/api/buckets/local/${DESTROY_BUCKET.id}/clear`,
      { nameConfirm: DESTROY_BUCKET.bucket });
    assertEqual(r.status, 200, `清空桶应成功（实际 ${r.status} ${r.text || ''}）`);
    assertEqual(statusOf(link.id), 'deleted',
      'R7-03：清空桶后指向桶内对象的分享链接必须标记为「文件已删除」');
  } finally {
    await srv.close();
    hooks.listAllInfo = null;
    configStore.listBuckets = realListBuckets;
    restoreConfig();
  }
});

/**
 * 彻底删桶：此前删云端桶 + 清 IP 规则 + 清加密元数据 + 清统计，**唯独不动分享链接**。
 * 这一处后果最重 —— 桶都没了，`effectiveForBucket()` 拿不到凭据，分享页的惰性探测
 * 会 fail-open，页面一直显示可下载、点了才报错。
 */
test('R7-03 · 彻底删除存储桶后，指向该桶的全部分享链接判定为 deleted', async () => {
  useConfig(Object.assign({}, DESTROY_BUCKET, { secretId: 'sid', secretKey: 'skey' }));
  const realListBuckets = configStore.listBuckets;
  const realRemoveBucket = configStore.removeBucket;
  const linkA = await makeLink(DESTROY_BUCKET.bucket, 'gone/a.txt');
  const linkB = await makeLink(DESTROY_BUCKET.bucket, 'gone/b.txt');
  const other = await makeLink('another-bucket', 'gone/a.txt');
  configStore.listBuckets = () => ({ buckets: [DESTROY_BUCKET] });
  configStore.removeBucket = () => true;
  hooks.listAll = () => [];
  const srv = await startBucketsApp();
  try {
    const r = await json(srv.port, 'POST', `/api/buckets/local/${DESTROY_BUCKET.id}/destroy`,
      { nameConfirm: DESTROY_BUCKET.bucket });
    assertEqual(r.status, 200, `彻底删桶应成功（实际 ${r.status} ${r.text || ''}）`);
    assertEqual(statusOf(linkA.id), 'deleted', 'R7-03：桶已不存在 → 指向它的链接必须标记');
    assertEqual(statusOf(linkB.id), 'deleted', 'R7-03：同桶的其它链接同样必须标记');
    assertEqual(statusOf(other.id), 'active', 'R7-03：不得连坐同名 key 的其它桶');
  } finally {
    await srv.close();
    hooks.listAll = null;
    configStore.listBuckets = realListBuckets;
    configStore.removeBucket = realRemoveBucket;
    restoreConfig();
  }
});

/* ============================================================
 * R7-04 · WebDAV 端口必须参与桶级 IP 规则与「一键屏蔽海外 IP」
 * ========================================================== */

const ipGuard = require(path.join(ROOT, 'server', 'ip-guard.js'));
// R8-26：清理临时目录前必须刷干的三个异步写队列（见文件末尾的 test.after）
const statsStore = require(path.join(ROOT, 'server', 'stats-store.js'));
const secureStore = require(path.join(ROOT, 'server', 'secure-store.js'));
/** 造一个最小的 req（clientIp 只看 socket.remoteAddress，guardRequest 再看 path / method） */
function fakeReq(pathname, ip, method = 'GET') {
  return { path: pathname, method, socket: { remoteAddress: ip } };
}

/**
 * WebDAV 跑在独立端口、挂载点 `/dav`，而 `resolveBucketId()` 此前只认
 * `/api/buckets/local/:id`、`/s/:id`、`/api/(fs|stats)/` —— `/dav/*` 一律返回 null，
 * 于是管理员为某个桶配的封禁规则、以及该桶的「屏蔽海外 IP」对 WebDAV 客户端完全不生效。
 */
test('R7-04 · /dav/* 请求能解析出目标桶（不再一律返回 null）', () => {
  const cfg = configStore.load();
  const active = (cfg.buckets || []).find((x) => x.id === cfg.activeBucketId) || (cfg.buckets || [])[0];
  assert(active, '测试环境应至少有一个本地桶记录');

  const got = ipGuard.resolveBucketId(fakeReq('/dav/dir/file.txt', '203.0.113.7'));
  assertEqual(got, active.id,
    'R7-04：WebDAV 请求必须解析出目标桶 —— 它走 fs-gateway → configStore.get()，' +
    '操作对象就是全局激活桶；解析不出桶 ⇒ 桶级规则与海外屏蔽对其形同虚设');

  // 挂载点本身（无尾斜杠）也要能解析
  assertEqual(ipGuard.resolveBucketId(fakeReq('/dav', '203.0.113.7')), active.id, '/dav 根路径同样应解析出桶');
});

/** 端到端：为激活桶加一条桶级规则，WebDAV 请求必须被拦下 */
test('R7-04 · 桶级屏蔽规则对 WebDAV 请求生效（且不误伤无桶上下文的请求）', () => {
  const cfg = configStore.load();
  const active = (cfg.buckets || []).find((x) => x.id === cfg.activeBucketId) || (cfg.buckets || [])[0];
  assert(active, '测试环境应至少有一个本地桶记录');

  const BLOCKED_IP = '203.0.113.9';
  const rule = ipGuard.addRule({ target: BLOCKED_IP, methods: [], bucketIds: [active.id] });
  try {
    const v = ipGuard.guardRequest(fakeReq('/dav/a.txt', BLOCKED_IP));
    assertEqual(v.ok, false, 'R7-04：桶级规则必须拦住 WebDAV 请求（旧实现会放行）');
    assertEqual(v.reason, 'rule', '应由规则命中而非其它原因');
    assertEqual(v.bucketId, active.id, '命中的桶级规则应对应 WebDAV 操作的目标桶');

    // 反向边界：桶级规则不得作用于「解析不出桶」的请求（配置管理、静态页等）
    const v2 = ipGuard.guardRequest(fakeReq('/api/config', BLOCKED_IP));
    assertEqual(v2.ok, true, '桶级规则不得误伤无桶上下文的请求（否则管理员会把自己锁在门外）');
  } finally {
    ipGuard.removeRule(rule.id);
  }
});

/** 本地回环永远放行 —— 加上桶解析后仍不得把管理员的 WebDAV 锁死 */
test('R7-04 · 回环地址的 WebDAV 请求仍然放行', () => {
  const v = ipGuard.guardRequest(fakeReq('/dav/a.txt', '127.0.0.1'));
  assertEqual(v.ok, true, '本机回环永远放行（含 WebDAV）');
});

/* ============================================================
 * R7-05 · 加密「查看密码」改密 / 清密后，已签发的令牌必须立即失效
 * ========================================================== */

/**
 * 背景：`tokenSecret()` 只由 masterKey + 固定字符串派生，**与密码哈希无关**，
 * 于是「改密码」这一应急动作对 30 分钟内已签发的令牌毫无作用 —— 持票人仍可继续
 * 解密下载全部密文。与已修的 SEC-10（分享令牌绑密码哈希）是同型问题，那边改了这边没改。
 */
test('R7-05 · 修改查看密码后，此前签发的令牌立即失效', async () => {
  await encStore.updateSettings({ mode: 'crypto', password: 'first-password' });
  const t = encStore.issueToken();
  assert(encStore.verifyToken(t.token), '前置条件：改密前签发的令牌应有效');

  await encStore.updateSettings({ password: 'second-password' });
  assertEqual(encStore.verifyToken(t.token), false,
    'R7-05：改密后旧令牌必须立即失效 —— 否则「改密码」撤不回已获授权的访问者');

  // 新密码下重新签发的令牌必须可用（不能因为绑定而把自己锁死）
  const t2 = encStore.issueToken();
  assert(encStore.verifyToken(t2.token), '改密后重新签发的令牌应有效');
});

test('R7-05 · 清除查看密码后，此前签发的令牌同样失效', async () => {
  await encStore.updateSettings({ password: 'to-be-cleared' });
  const t = encStore.issueToken();
  assert(encStore.verifyToken(t.token), '前置条件：清密前签发的令牌应有效');

  await encStore.updateSettings({ password: '' });
  assertEqual(encStore.verifyToken(t.token), false, 'R7-05：清密后旧令牌必须立即失效');
  assertEqual(encStore.passwordSet(), false, '清密后不应再要求密码');
});

/** 反向边界：只改非密码字段不得吊销令牌（否则每次改设置都会被踢下线） */
test('R7-05 · 仅修改非密码字段不吊销令牌（不得误伤）', async () => {
  await encStore.updateSettings({ password: 'stable-password' });
  const t = encStore.issueToken();
  await encStore.updateSettings({ magic: '89504e470d0a1a0a' });
  assertEqual(encStore.verifyToken(t.token), true,
    '改 magic / 加密方式等字段不得吊销令牌 —— 绑定应精确到「密码是否变了」');
});

/* ============================================================
 * R7-06 · WebDAV 写入 / 分片中止必须走 p() 咽喉点
 * ========================================================== */

/**
 * `p()` 是「列举缓存失效」与「按桶请求计数」的唯一挂载点。fs-gateway.writeObject 此前
 * 直接回调式调 `cos.putObject` 绕过了它 —— WebDAV 上传后管理端最多 3 秒看不到新文件。
 *
 * 两条断言互补：① 写入确实**经过**了 p()（pCalls 里有 putObject）；
 * ② 经过 p() 带来的效果——该桶的列举缓存失效。只断言其中一条都会被「手动补一次
 * noteCall」或「调了 p 却没接副作用」这类假修复骗过。
 */
test('R7-06 · fs-gateway.writeObject 必须经 p() 且使该桶列举缓存失效', async () => {
  useConfig(ALI_CFG);
  listCache.clear();
  const before = pCalls.length;
  const ckey = listCache.keyOf(ALI_CFG.bucket, 'wv/', '', 100, '/');
  listCache.set(ckey, { contents: [], prefixes: [] });
  assert(listCache.get(ckey), '前置条件：缓存里应有一条该桶的列举结果');
  try {
    await fsGateway.writeObject(ALI_CFG.bucket, 'wv/cache-invalidate.bin', Buffer.from('x'));
  } finally {
    restoreConfig();
  }
  const hits = pCalls.slice(before).filter((c) => c.method === 'putObject');
  assert(hits.length > 0,
    'R7-06：writeObject 的 putObject 必须经 p() 发出（旧实现是直接回调式调用）');
  assert(!listCache.get(ckey),
    'R7-06：写入之后列举缓存必须失效 —— 否则 WebDAV 上传的文件在缓存 TTL 内不可见');
});

/** 中止分片也是写操作：不过 p() 的话「文件碎片」页最长 30 秒仍显示已中止的碎片 */
test('R7-06 · 中止分片上传必须经 p() 咽喉点', () => {
  const before = pCalls.length;
  const sess = uploadSessions.create({
    uploadId: 'u-abort-me', key: 'abort.bin', bucket: 'b', region: 'r',
    size: 1, chunkSize: 1, provider: 'tencent',
  });
  // 推到 7 天过期窗口之外，让 prune 走「远端中止」分支
  sess.updatedAt = Date.now() - 8 * 86400 * 1000;
  uploadSessions.prune(() => ({
    __provider: 'tencent',
    multipartAbort(_params, cb) { cb(null, {}); },
  }));

  const hits = pCalls.slice(before).filter((c) => c.method === 'multipartAbort');
  assert(hits.length > 0,
    'R7-06：multipartAbort 必须经 p() 发出（旧实现是直接回调式调用，绕过了缓存失效与计数）');
  assert(!uploadSessions.get(sess.id), '中止成功后会话应从注册表中移除');
});

/* ============================================================
 * R7-07 · prune() 必须在单实例锁之后
 * ========================================================== */

/**
 * 抢锁失败、即将 `process.exit(1)` 的第二个实例，此前仍会 (a) 向云端发 multipartAbort，
 * 可能中止第一个实例正在进行的上传；(b) 在 exit 钩子里同步写 upload-sessions.json ——
 * 而「两进程同时写 data/」正是单实例锁要杜绝的事。
 *
 * 用**真实子进程**验证（约定：exit 落盘类行为不能靠桩）：先造一把「被活进程持有」的锁，
 * 再让子进程 require index.js，它必须在锁处退出，且**不得**写出 upload-sessions.json。
 */
test('R7-07 · 抢锁失败的实例不得执行 prune（不写 data/upload-sessions.json）', () => {
  const { spawnSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-audit7-lock-'));
  // 一把「被活进程持有」的锁（pid = 当前进程，必然存活）
  fs.writeFileSync(path.join(dir, '.instance.lock'),
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));

  const childScript = path.join(dir, 'child.js');
  fs.writeFileSync(childScript,
    'process.env.COS_DATA_DIR = ' + JSON.stringify(dir) + ';\n'
    + 'require(' + JSON.stringify(path.join(ROOT, 'server', 'index.js')) + ');\n');

  const r = spawnSync(process.execPath, [childScript], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
  // 断言必须在清理临时目录**之前**完成
  const wroteSessions = fs.existsSync(path.join(dir, 'upload-sessions.json'));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }

  // 同 RE-03：spawnSync 有时根本没起进程就返回 null，真因只在 `.error`（EBUSY）里
  const spawnNote = `status=${r.status} signal=${r.signal}`
    + ` error=${r.error ? r.error.code || r.error.message : '无'}`;
  assertEqual(r.status, 1,
    `第二个实例应因单实例锁而启动失败（exit 1；status=null 且带 EBUSY 即环境性失败）`
    + `【${spawnNote}】：${r.stderr || r.stdout || '(无输出)'}`);
  assertEqual(wroteSessions, false,
    'R7-07：抢锁失败的实例不得再执行 prune —— 否则它依然会向云端发 multipartAbort，' +
    '并在退出钩子里同步写 data/upload-sessions.json（正是单实例锁要杜绝的「两进程同时写 data/」）');
});

/* ============================================================
 * R7-08 · 加密读取令牌不得因「流无人接管」而永久泄漏
 * ========================================================== */

/** 轮询等待条件成立（事件驱动，不是墙钟阈值断言） */
async function waitUntil(fn, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

function cryptoMeta() {
  return {
    mode: 'crypto', origSize: 4096, createdAt: '2020-01-01T00:00:00.000Z',
    crypto: { segments: [{ n: 1, iv: 'aa'.repeat(6), ctLen: 4096, tag: 'bb'.repeat(8) }] },
  };
}

/**
 * 释放令牌原本完全外包给调用方：只在返回流的 close/error 上释放。若客户端在排队等令牌
 * 期间断开，返回的流既没消费者也没人 destroy → close 永不触发 → 令牌永久泄漏。
 * 攒够 MAX_ENCRYPT_READERS 个之后，所有加密读都会无限排队。
 *
 * 断言打在最终行为上：占满令牌后第 4 个请求会排队，**最终必须能被推进**。
 */
test('R7-08 · 无人接管的加密读流必须归还令牌（排队的请求不得永远卡住）', async () => {
  useConfig(ALI_CFG);
  const T = fsGateway.__test__;
  T.reset();
  T.setHandoffMs(20); // 交接兜底调短，避免用例真等 60 秒
  await encStore.updateSettings({ mode: 'crypto', password: '' });
  const bucket = ALI_CFG.bucket;
  const keys = ['r7sem/a.bin', 'r7sem/b.bin', 'r7sem/c.bin', 'r7sem/d.bin'];
  for (const k of keys) encStore.setMeta(bucket, k, cryptoMeta());

  const streams = [];
  let settled = false;
  try {
    for (let i = 0; i < T.MAX_ENCRYPT_READERS; i++) {
      const r = await fsGateway.readObject(bucket, keys[i], {});
      streams.push(r.stream); // 刻意**不消费**、也不 destroy
    }
    assertEqual(T.activeCount(), T.MAX_ENCRYPT_READERS, '前置条件：令牌应已被占满');

    const pending = fsGateway.readObject(bucket, keys[3], {})
      .then((r) => { settled = true; streams.push(r.stream); return r; });
    await new Promise((r) => setTimeout(r, 5));
    assertEqual(settled, false, '令牌占满时，第 4 个读请求应处于排队状态');
    assertEqual(T.queueLen(), 1, '应有 1 个请求在排队');

    const advanced = await waitUntil(() => settled, 5000);
    assert(advanced,
      'R7-08：无人接管的流必须最终归还令牌 —— 否则 3 个泄漏之后所有加密读都会无限排队');
    assert(await pending, '排队的请求应拿到结果');
  } finally {
    for (const s of streams) { try { s.destroy(); } catch (e) { /* 已销毁 */ } }
    T.reset();
    restoreConfig();
  }
});

/* ============================================================
 * R7-11 / R7-12 / R7-14 · 移动回滚、会话淘汰、停机落盘
 * ========================================================== */

/**
 * R7-11：`movePrefix` 并发复制中途失败时直接 reject —— 源没删、目标留下半份副本，
 * 用户看到两个都不完整的目录，且没有任何提示说明残留了什么。
 */
test('R7-11 · movePrefix 复制中途失败必须回滚已复制的目标副本，且不得删源', async () => {
  useConfig(ALI_CFG);
  hooks.listAllExact = () => [{ key: 'mvs/a.txt', size: 1 }, { key: 'mvs/b.txt', size: 1 }];
  const before = pCalls.length;
  // 让第 2 次（及以后）复制失败：必定留下 1 个已复制的目标副本，回滚才可观测
  let copies = 0;
  hooks.p = async (_client, method) => {
    if (method === 'putObjectCopy') {
      copies += 1;
      if (copies >= 2) throw new Error('模拟并发复制失败');
    }
    return null;
  };
  let threw = false;
  let errMsg = '';
  try {
    await fsGateway.movePrefix(ALI_CFG.bucket, 'mvs', 'mvd', null, null);
  } catch (e) {
    threw = true;
    errMsg = String((e && e.message) || e);
  } finally {
    hooks.p = null;
    hooks.listAllExact = null;
    restoreConfig();
  }
  assert(threw, `复制失败必须向上抛出（不能假装成功），实际错误：${errMsg}`);

  const calls = pCalls.slice(before);
  // 关键：回滚必须真的删掉**已复制到目标前缀下的对象**，而不只是"调了一下删除接口"
  const destDeletes = calls.filter((c) => c.method === 'deleteMultipleObject'
    && (c.params.Objects || []).some((o) => String(o.Key).indexOf('mvd/') === 0));
  assert(destDeletes.length > 0,
    'R7-11：失败后必须尽力回滚已复制的目标副本 —— 否则「源未删 + 目标半份」两个都不完整。'
    + `（实际云端调用：${calls.map((c) => c.method).join(',') || '无'}；复制调用 ${copies} 次；错误：${errMsg}）`);
  const srcDeletes = calls.filter((c) => c.method === 'deleteMultipleObject'
    && (c.params.Objects || []).some((o) => String(o.Key).indexOf('mvs/') === 0));
  assertEqual(srcDeletes.length, 0, 'R7-11：复制未完成时不得删除源对象');
});

/**
 * R7-12：超上限淘汰旧实现无条件 `abortRemote(); delete s[o.id];` —— 中止一失败就把
 * 本地会话删掉，云端分片的 UploadId 句柄随之丢失：既无法中止也无法续传，持续计费。
 * 这里与「过期分支」统一口径：中止失败就保留，等下轮再试。
 */
test('R7-12 · 超上限淘汰时若中止失败，会话必须保留（不得丢掉云端分片句柄）', () => {
  const ids = [];
  // 先把会话数顶到上限之上，触发「数量上限」分支
  while (uploadSessions.list().length <= uploadSessions.MAX_SESSIONS) {
    ids.push(uploadSessions.create({
      uploadId: 'u-limit', key: 'k-limit', bucket: 'b', region: 'r',
      size: 1, chunkSize: 1, provider: 'tencent',
    }).id);
  }
  const before = uploadSessions.list().length;
  try {
    // 客户端解析不出来 → abortRemote 恒返回 false
    uploadSessions.prune(() => null);
    assertEqual(uploadSessions.list().length, before,
      'R7-12：中止失败时不得删除会话（旧实现会无条件删，云端分片句柄就此丢失）');
  } finally {
    for (const id of ids) uploadSessions.remove(id);
  }
});

/**
 * R7-14：统计是 500ms 去抖 + 异步写。停机时只 flush 了日志缓冲，最后一批流量/请求计数
 * 会随进程退出丢失。补一个**同步**落盘出口（与 flushLogsSync 同型）。
 */
test('R7-14 · flushStatsSync 必须同步落盘（调用返回时文件已存在）', () => {
  const statsStore = require(path.join(ROOT, 'server', 'stats-store.js'));
  const file = path.join(TMP, 'stats.json');
  statsStore.track({ type: 'other', ok: true, bytesUp: 7, bytesDown: 0, ms: 1 });
  const wrote = statsStore.flushStatsSync();
  assertEqual(wrote, true, 'flushStatsSync 应实际执行一次落盘');
  assert(fs.existsSync(file), 'R7-14：调用返回时 stats.json 必须已经在磁盘上（同步写，不是排进异步队列）');
  assert(fs.readFileSync(file, 'utf8').length > 0, '落盘内容不得为空');
});

/* ============================================================
 * 遗留项 · HEAD /s/:id/dl 不得有副作用
 * ========================================================== */

/**
 * Express 在没有 HEAD 路由时会把 HEAD 请求交给 GET handler（只丢弃响应体）。
 * 而 `/s/:id/dl` 的 GET 是「有副作用的 GET」—— 占用一次下载名额 + 向云端发起完整
 * getObject。下载器 / 断点续传客户端先发一个 HEAD 探测就会白扣额度、白跑流量。
 */
test('HEAD /s/:id/dl：返回 200 与大小，但不得占用名额、不得读云端', async () => {
  const link = await makeLink(ALI_CFG.bucket, 'head/probe.bin');
  const express = require(path.join(ROOT, 'node_modules', 'express'));
  const app = express();
  app.use('/', shareRoutes);
  const server = await new Promise((resolve) => {
    const s = http.createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const before = pCalls.length;
  try {
    const r = await raw(server.address().port, 'HEAD', `/s/${link.id}/dl`, Buffer.alloc(0));
    assertEqual(r.status, 200, `HEAD 探测应返回 200（实际 ${r.status}）`);
    assertEqual(shareStore.get(link.id).downloads, 0,
      'HEAD 不得占用下载名额 —— 否则下载器一次探测就把额度刷掉（旧实现走完整 GET handler）');
    const cloud = pCalls.slice(before).filter((c) => c.method === 'getObject');
    assertEqual(cloud.length, 0, 'HEAD 不得触发云端 getObject（探测不该产生全量流量）');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

/** 已失效的链接：HEAD 也应给出确定答案（410），且同样不产生副作用 */
test('HEAD /s/:id/dl：失效链接返回 410 且不占用名额', async () => {
  const link = await makeLink(ALI_CFG.bucket, 'head/gone.bin');
  shareStore.markMissing(link.id);
  const express = require(path.join(ROOT, 'node_modules', 'express'));
  const app = express();
  app.use('/', shareRoutes);
  const server = await new Promise((resolve) => {
    const s = http.createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const r = await raw(server.address().port, 'HEAD', `/s/${link.id}/dl`, Buffer.alloc(0));
    assertEqual(r.status, 410, `已删除的链接 HEAD 应返回 410（实际 ${r.status}）`);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

/* ============================================================
 * R7-09 / R7-10 · 前端定时器句柄与失败态缓存
 * ========================================================== */

const JS_DIR = path.join(ROOT, 'public', 'js');

/**
 * 结构不变量分析器：**每一个 setInterval 的句柄都必须有对应的 clearInterval**。
 *
 * 前端约定「setInterval 一律存句柄并清除」，但约定靠人记 —— 曾经就漏了 `App._statsTimer`
 * 这一处（全库唯一一个没有 clearInterval 的 setInterval），登出后仍每 60 秒请求
 * `/api/stats/summary`（401）。用分析器把这条约定固化，比逐处 review 可靠。
 */
function uncleanedIntervalHandles(src) {
  const assigned = new Set();
  let m;
  const reAssigned = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*=\s*setInterval\s*\(/g;
  while ((m = reAssigned.exec(src))) assigned.add(m[1]);
  const cleared = new Set();
  const reCleared = /clearInterval\s*\(\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\)/g;
  while ((m = reCleared.exec(src))) cleared.add(m[1]);
  return [...assigned].filter((h) => !cleared.has(h));
}

test('R7-09 · 分析器自带样例自测（能识别「漏 clear」也能放行「有 clear」）', () => {
  assertEqual(uncleanedIntervalHandles('let t = null;\nt = setInterval(f, 100);\nclearInterval(t);\n').length, 0,
    '有 clearInterval 的句柄应被放行');
  assertEqual(uncleanedIntervalHandles('App._x = setInterval(f, 100);\n').join(','), 'App._x',
    '没有 clearInterval 的句柄必须被检出');
  assertEqual(uncleanedIntervalHandles('let a = setInterval(f, 1); let b = setInterval(g, 1); clearInterval(a);').join(','), 'b',
    '只清了其中一个时，另一个必须被检出');
});

test('R7-09 · public/js 下不存在「建了就不管」的 setInterval', () => {
  const files = fs.readdirSync(JS_DIR).filter((f) => f.endsWith('.js'));
  const bad = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(JS_DIR, f), 'utf8');
    for (const h of uncleanedIntervalHandles(src)) bad.push(`${f}:${h}`);
  }
  assertEqual(bad.join(', '), '',
    'R7-09：每个 setInterval 都必须存句柄并清除（登出/会话过期后不得继续轮询已 401 的接口）');
  assert(files.length >= 20, '应扫描到全部前端模块');
});

/**
 * R7-10：`storageCache` 曾经把 **rejected 的 Promise** 存起来且永不失效 ——
 * `/api/stats/storage` 失败一次（428 未配置、网络抖动）之后，后续所有 updateStatusbar
 * 都复用同一个失败 Promise，状态栏长期显示「用量获取失败」，只有切桶/增删桶才恢复。
 */
test('R7-10 · 存储用量缓存不得缓存失败态（失败后必须允许重试）', () => {
  const src = fs.readFileSync(path.join(JS_DIR, 'main.js'), 'utf8');
  // 结构判据：API.storage() 的结果必须带 .catch，且 catch 里把缓存置空
  const m = /API\.storage\(\)\s*\.catch\(\s*\(?\w*\)?\s*=>\s*\{([\s\S]*?)\}\s*\)/.exec(src);
  assert(m, 'R7-10：API.storage() 必须挂 .catch 处理失败分支（否则 rejected Promise 会被永久缓存）');
  assert(/storageCache\s*=\s*null/.test(m[1]),
    'R7-10：失败时必须把 storageCache 置空 —— 否则失败态被永久缓存，再也恢复不了');
});

/* ============================================================
 * D1 / D3 · 文档声称的能力必须与代码一致（见开发文档「六、审计发现台账 6.4」第 7 轮 D 段）
 * ========================================================== */

/**
 * D1：README 曾写「下载量、时间、次数、**来源 IP** 可审计」，但分享链接只有
 * `downloads` 计数与 `lastDownloadAt`，**没有逐次记录**，成功下载也不写含 IP 的日志
 * （IP 只出现在登录 / 解锁限流这类告警里）。文档已改口径，这里把「不记录来源信息」
 * 固化成不变量 —— 将来若真要加 IP 审计，必须同步改文档与这条断言。
 */
test('D1 · 一次分享下载只更新次数与最近时间，不新增来源 IP / UA 等逐次记录', async () => {
  const link = await makeLink(ALI_CFG.bucket, 'd1/probe.bin');
  const before = shareStore.get(link.id);
  assertEqual(before.downloads, 0, '前置条件：新链接未被下载过');
  assert(shareStore.tryAcquire(link.id), 'tryAcquire 应成功（未过期、未超次、无密码）');

  const after = shareStore.get(link.id);
  assertEqual(after.downloads, 1, '下载次数应 +1');
  assert(after.lastDownloadAt, '应记录最近下载时间');

  const added = Object.keys(after).filter((k) => !(k in before));
  assertEqual(added.join(', '), '',
    'D1：一次下载只应更新既有字段，不得新增逐次记录（否则就是「逐次审计」了，文档口径要一起改）');

  const sourceKeys = Object.keys(after).filter((k) => /ip|addr|agent/i.test(k));
  assertEqual(sourceKeys.join(', '), '',
    'D1：分享记录不得出现来源 IP / UA 字段 —— README 已明确「不记录来源 IP」');
});

/**
 * D3：README 曾写「普通用户查看用户列表 ✘」，但接口层并非拒绝 ——
 * `GET /users` 对非管理员返回 `scope:'self'`（只含自己一条）。
 * 这是**真实的权限边界**：前端隐藏只是第一层，接口层必须自己按 role 过滤，
 * 否则任何能发请求的人就能枚举全部账户。此前全库没有任何行为用例覆盖这一点。
 */
const usersRoutes = require(path.join(ROOT, 'server', 'routes', 'users.js'));

const FAKE_USERS = [
  { id: 'u-admin', username: 'root', role: 'admin' },
  { id: 'u-self', username: 'alice', role: 'user' },
  { id: 'u-other', username: 'bob', role: 'user' },
];
const realListUsers = configStore.listUsers;

/** 起一个挂 users 路由的服务（身份由参数决定） */
function startUsersApp(role, uid) {
  const express = require(path.join(ROOT, 'node_modules', 'express'));
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.use((req, _res, next) => {
    req.authUser = { id: uid, username: (FAKE_USERS.find((u) => u.id === uid) || {}).username, role };
    next();
  });
  app.use('/api', usersRoutes);
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

test('D3 · GET /users：管理员看到全部用户（scope=all）', async () => {
  configStore.listUsers = () => FAKE_USERS.slice();
  const srv = await startUsersApp('admin', 'u-admin');
  try {
    const r = await json(srv.port, 'GET', '/api/users', null);
    assertEqual(r.status, 200, `管理员应能列出全部用户（实际 ${r.status}）`);
    assertEqual(r.json && r.json.scope, 'all', '管理员作用域必须是 all');
    assertEqual(r.json && r.json.users.length, 3, '管理员应看到 3 条');
  } finally {
    await srv.close();
    configStore.listUsers = realListUsers;
  }
});

test('D3 · GET /users：普通用户只看到自己一条（scope=self），不得枚举他人', async () => {
  configStore.listUsers = () => FAKE_USERS.slice();
  const srv = await startUsersApp('user', 'u-self');
  try {
    const r = await json(srv.port, 'GET', '/api/users', null);
    assertEqual(r.status, 200, '普通用户调 /users 不应被 403 —— 接口层按 role 过滤而非拒绝');
    assertEqual(r.json && r.json.scope, 'self', '普通用户作用域必须是 self（README 已按此修正）');
    assertEqual(r.json && r.json.users.length, 1, '普通用户不得看到其他账户（否则可枚举全部用户）');
    assertEqual(r.json && r.json.users[0].id, 'u-self', '返回的必须是自己');
  } finally {
    await srv.close();
    configStore.listUsers = realListUsers;
  }
});

test.after(async () => {
  restoreConfig();
  try { encStore.updateSettings({ mode: 'none', password: '' }); } catch (e) { /* ignore */ }
  // R8-26：必须先**刷干异步写队列**再删目录。
  // upload-sessions 有 300ms 去抖写、stats-store 有 500ms 日志缓冲、secure-store 有
  // 串行写队列 —— 它们都会在 test.after 之后把文件写回已删除的目录，于是每次运行
  // 泄漏一个**非空**临时目录（实测 cos-audit7-* 从 133 涨到 134，且 134 个全部非空）。
  // 清理失败时 cleanupTempDir 会**告警**，不再像旧的 `catch { /* ignore */ }` 那样静默。
  await cleanupTempDir(TMP, {
    label: 'audit7-regressions',
    flushers: [
      { name: 'upload-sessions', flush: () => uploadSessions.flushSync() },
      { name: 'stats-store', flush: () => statsStore.flushStatsSync() },
      { name: 'secure-store', flush: () => secureStore.flush() },
    ],
  });
});
