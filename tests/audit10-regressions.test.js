/**
 * 测试：第 10 轮审计修复的回归护栏（见开发文档「六、审计发现台账 6.4」）
 *
 * 第 10 轮的性质与往轮不同：它是**对第 9 轮修复的对抗式验收** —— 11 条里
 * 有两条（R10-01 高危、R10-05 可用性回归）是「修复本身的产物」。因此本文件的
 * 护栏一律打在**真实入口**（真实 HTTP 路由 / 真实 HTTPS WebDAV 服务）上，
 * 而不是内部函数 —— 「函数修好了但没接线」正是上一轮 R9-03 得以存活的原因。
 *
 * 覆盖的编号：
 *   R10-02 /fs/move 移动文件夹必须保留目录层级（否则密文永久不可解）
 *   R10-03 deletePrefix 三处入口共用白名单判据（"既不确认也不报错"按未删处理）
 *   R10-04 migratePrefix 只清理「本次确实被覆盖」的目标条目（目录 MOVE 是 merge 语义）
 *   R10-05 init 的 simple/multipart 分界必须感知加密模式（消除 5–8MB 死路）
 *   R10-06 WebDAV MOVE 删源必须标记分享链接
 *   R10-08 /fs/upload/chunk 必须校验分片大小
 *   R10-10 分片 complete 的用量缓存修正必须命中（cfg 必须带 secretId）
 *   R10-11 WebDAV 的 Overwrite: F 判据统一（覆盖「目标是文件」「目标是空目录」两种漏判）
 *
 * 不在本文件（已在别处有等价或更强的护栏）：
 *   R10-01 异步落盘路径 → tests/audit9-regressions.test.js（与 R9-08 的退出路径成对断言）
 *   R10-07 HEAD/GET 的 Range 判定同源 → 本文件（走真实 WebDAV HEAD）
 *   R10-09 轮询预算只在真的查单时消耗 → tests/audit9-regressions.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const test = require('node:test');
const { assert, assertEqual, ROOT, cleanupTempDir } = require('./helpers');

/* ------------------------------------------------------------------ *
 * 0 · 隔离与打桩（必须在 require 任何 server 模块之前）
 * ------------------------------------------------------------------ */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-audit10-'));
process.env.COS_DATA_DIR = TMP;
process.env.WEBDAV_PORT = String(18900 + (process.pid % 300));

const cos = require(path.join(ROOT, 'server', 'cos.js'));
const configStore = require(path.join(ROOT, 'server', 'config-store.js'));

/** 内存中的对象存储：key -> Buffer */
const fakeObjects = new Map();
/** 流式下载（`getObject` + `Output`）的次数 —— R10-12 用：HEAD 绝不该触发它 */
let streamReads = 0;
/**
 * 「云端既不确认也不报错」的 key 集合（R10-03 用）。
 * 白名单判据唯一能挡住的情形：整批回 200，响应体里既无 `<Deleted>` 也无 `<Error>`。
 */
let deleteSilent = null;

const BASE_CFG = {
  secretId: 'stub-id', secretKey: 'stub-key',
  bucket: 'audit10-bucket', region: 'ap-guangzhou', provider: 'tencent',
};

/**
 * 唯一的一份「云端行为」实现，同时供两条调用路径使用：
 *
 *  - 路由层：模块加载时以 `const { p } = require('./cos')` 解构绑定 → 替换 `cos.p` 即可；
 *  - `cos.js` **内部**（`listPage` / `listAllExact`）：走模块作用域的 `p`，它调的是
 *    `cos[method](params, cb)` 这种 **SDK 回调风格** —— 替换 `cos.p` 对它无效。
 *
 * 两条路径必须同一份实现，否则「路由看到的对象」与「列举看到的对象」会分叉，
 * 测出来的东西毫无意义（第 10 轮调试时正是踩了这个：只桩了 `cos.p`，
 * `listAllExact` 直接报 `cos[method] is not a function`）。
 *
 * @returns {{result: object}|{error: Error}}
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
      const errors = [];
      for (const o of (params.Objects || [])) {
        if (deleteSilent && deleteSilent.has(o.Key)) continue; // 既不确认也不报错
        fakeObjects.delete(o.Key);
        deleted.push({ Key: o.Key });
      }
      return ok({ Deleted: deleted, Error: errors });
    }
    case 'putObjectCopy':
    case 'sliceCopyFile': {
      const src = String(params.CopySource || '').split('?')[0].replace(/^https?:\/\//, '');
      const srcKey = src.startsWith('/')
        ? src.replace(/^\/[^/]+\//, '')
        : src.replace(/^[^/]+\//, '');
      const buf = fakeObjects.get(srcKey);
      if (buf === undefined) return fail('Not Found: ' + srcKey, 404);
      fakeObjects.set(params.Key, Buffer.from(buf));
      return ok({ ETag: 'etag', LastModified: new Date().toISOString() });
    }
    case 'multipartInit': return ok({ UploadId: 'audit10-upload-id' });
    case 'multipartUpload': return ok({ ETag: '"part-etag"' });
    case 'multipartComplete': return ok({ ETag: '"final-etag"' });
    case 'multipartAbort': return ok({});
    case 'multipartListPart': return ok({ ListPartsResult: { Part: [] } });
    case 'multipartList': return ok({ ListUploadsResult: { Upload: [], IsTruncated: 'false' } });
    case 'request': {
      // 官方容量统计（?stats）：回 XML，让 /stats/storage 走「官方口径」而不是列举回退
      if (params && params.action === 'stats') {
        let bytes = 0;
        for (const b of fakeObjects.values()) bytes += b.length;
        return ok({ Body: `<Size>${bytes}</Size><ObjectNumber>${fakeObjects.size}</ObjectNumber>` });
      }
      return ok({});
    }
    case 'getBucket': {
      const prefix = String(params.Prefix || '');
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
  // SDK 回调风格：cos.js 内部的 p() 走这条
  fakeClient[m] = (params, cb) => {
    const r = handleCloud(m, params || {});
    if (typeof cb === 'function') process.nextTick(() => cb(r.error || null, r.result));
  };
}
// 流式下载：fs-gateway.readObject 直接 `getClient(cfg).getObject(opts, cb)`（保持背压）
fakeClient.getObject = (opts, cb) => {
  streamReads += 1;
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
// 路由层：解构绑定的 `p` → 替换导出对象上的属性即可
cos.p = async (client, method, params) => {
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
const gateway = require(path.join(ROOT, 'server', 'fs-gateway.js'));
const uploadSessions = require(path.join(ROOT, 'server', 'upload-sessions.js'));
const { LIMITS } = require(path.join(ROOT, 'server', 'limits.js'));
const shared = require(path.join(ROOT, 'server', 'routes', '_shared.js'));
shared.requireConfig = () => BASE_CFG;
const fsRoutes = require(path.join(ROOT, 'server', 'routes', 'fs.js'));
const statsRoutes = require(path.join(ROOT, 'server', 'routes', 'stats.js'));

/* ------------------------------------------------------------------ *
 * 1 · 迷你 HTTP 工具（与 audit7/8/9 同型，逐轮护栏自包含）
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
      rejectUnauthorized: false, // 自签名证书
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
        status: res.statusCode,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function jsonOf(r) {
  try { return JSON.parse(r.text); } catch (e) { return null; }
}

/* ================================================================== *
 * R10-02 · /fs/move 移动文件夹必须保留目录层级
 * ================================================================== */

/**
 * 报告 §2 的 R10-02（高危）：`newKey = targetPrefix + baseName(key)` 对文件夹
 * **没有补尾斜杠**（`baseName('a/b/') === 'b'`），于是
 *   `a/b/x.txt`     → `dest/bx.txt`（应为 `dest/b/x.txt`）
 *   `a/b/sub/y.txt` → `dest/bsub/y.txt`
 * 三重后果：目录结构被破坏、元数据按 `dest/b/` 迁移（密文永久不可解）、
 * 错名键上的静默覆盖没有前置检查。
 *
 * 断言打在**真实路由**上 —— 打在 `baseName` 上守不住「四处取用里有一处没补」。
 */
test('R10-02 · 移动文件夹必须保留子目录层级（a/b/x.txt → dest/b/x.txt）', async () => {
  fakeObjects.clear();
  fakeObjects.set('a/b/x.txt', Buffer.from('x'));
  fakeObjects.set('a/b/sub/y.txt', Buffer.from('y'));

  const app = await startApp(fsRoutes);
  const r = await request(app.port, 'POST', '/api/fs/move', {
    body: { paths: ['a/b/'], targetPrefix: 'dest' },
  });
  assertEqual(r.status, 200, `R10-02：移动应成功，实际 ${r.status} ${r.text}`);
  const out = jsonOf(r);
  assert(out && out.ok, `R10-02：results 应全部成功，实际 ${r.text}`);

  assert(fakeObjects.has('dest/b/x.txt'),
    'R10-02：a/b/x.txt 必须搬到 dest/b/x.txt —— 旧实现产出 dest/bx.txt（目录层级丢失）');
  assert(fakeObjects.has('dest/b/sub/y.txt'),
    'R10-02：a/b/sub/y.txt 必须搬到 dest/b/sub/y.txt —— 旧实现产出 dest/bsub/y.txt');
  assert(!fakeObjects.has('dest/bx.txt') && !fakeObjects.has('dest/bsub/y.txt'),
    'R10-02：不得产生与文件夹同级的错名文件');
  await app.close();
});

/* ================================================================== *
 * R10-03 · 目录删除必须走白名单判据（"既不确认也不报错"按未删处理）
 * ================================================================== */

/**
 * 报告 §2 的 R10-03（高危）：R9-02 只修了 `/fs/delete` 的**文件**分支，
 * `deletePrefix` 的三处调用方（fs.js 的 rename/move/delete 目录分支、buckets.js
 * 清空桶、fs-gateway.js）仍丢弃 `deleteMultipleObject` 的返回值、按整批成功处理
 * → 对**仍然存在**的对象清掉加密元数据（不可逆）并标掉分享链接。
 *
 * 这里用 `/fs/delete` 的**目录**分支驱动（它是 deletePrefix 最常用的一处），
 * 断言两件不可逆的事都没发生。
 */
test('R10-03 · 云端未确认删除时，元数据与分享链接都必须原样保留', async () => {
  fakeObjects.clear();
  fakeObjects.set('d/ok.txt', Buffer.from('ok'));
  fakeObjects.set('d/locked.txt', Buffer.from('locked'));
  deleteSilent = new Set(['d/locked.txt']);
  try {
    // 给两个对象都登记加密元数据；并给 locked 建一条分享链接
    encStore.setMeta(BASE_CFG.bucket, 'd/locked.txt', {
      encrypted: true, mode: 'crypto', origSize: 6, createdAt: new Date().toISOString(),
      crypto: { segments: [{ n: 1, iv: 'aa', ctLen: 6, tag: 'bb' }] },
    });
    encStore.setMeta(BASE_CFG.bucket, 'd/ok.txt', {
      encrypted: true, mode: 'crypto', origSize: 2, createdAt: new Date().toISOString(),
      crypto: { segments: [{ n: 1, iv: 'cc', ctLen: 2, tag: 'dd' }] },
    });
    const link = await shareStore.create({
      key: 'd/locked.txt', bucket: BASE_CFG.bucket, region: BASE_CFG.region,
      fileName: 'locked.txt', size: 6, createdBy: 'admin',
    });

    const app = await startApp(fsRoutes);
    const r = await request(app.port, 'POST', '/api/fs/delete', { body: { paths: ['d/'] } });
    await app.close();

    // 接口会如实报「未清理完毕」，但真正要守的是下面两条
    assert(encStore.getMeta(BASE_CFG.bucket, 'd/locked.txt'),
      'R10-03：云端未确认删除的对象**绝不能**清元数据 —— 清了密文就永久不可解');
    assert(!shareStore.get(link.id).missingAt,
      'R10-03：云端未确认删除的对象**绝不能**把分享链接标成已删除 —— '
      + '已分发的 URL 会永久失效');
    // 确认删除成功的那个对象，元数据应当被清掉（证明判据不是"什么都不做"）
    assert(!encStore.getMeta(BASE_CFG.bucket, 'd/ok.txt'),
      'R10-03 反向对照：云端确认删除成功的对象必须清理元数据，否则判据退化成永不清理');
  } finally {
    deleteSilent = null;
  }
});

/* ================================================================== *
 * R10-04 · 目录 MOVE 是 merge 语义，不得清掉目标侧已有的元数据
 * ================================================================== */

/**
 * 报告 §2 的 R10-04（高危）：R9-03 给 `migratePrefix` 加的「清目标陈旧条目」
 * 与 WebDAV 目录 MOVE 的 **merge 语义**冲突 —— `movePrefix` 只「复制 + 删源」，
 * **从不删目标**。于是合并到非空目标时，目标已有对象的元数据被误删。
 *
 * 断言走 `gateway.movePrefix`（WebDAV 目录 MOVE 的真实入口）。
 */
test('R10-04 · 目录 MOVE 合并到非空目标时，目标侧已有对象的元数据必须保留', async () => {
  fakeObjects.clear();
  fakeObjects.set('src/a.txt', Buffer.from('src-a'));
  fakeObjects.set('dst/keep.txt', Buffer.from('dst-keep'));

  const meta = (n) => ({
    encrypted: true, mode: 'crypto', origSize: n, createdAt: new Date().toISOString(),
    crypto: { segments: [{ n: 1, iv: '11', ctLen: n, tag: '22' }] },
  });
  encStore.setMeta(BASE_CFG.bucket, 'src/a.txt', meta(5));
  encStore.setMeta(BASE_CFG.bucket, 'dst/keep.txt', meta(8));
  /**
   * R12-02 之后，「目标侧**存在同名对象**」不再走合并 —— 云端覆盖不可撤销，
   * 而回滚又不能删它（那会毁掉与本次移动无关的数据），于是「覆盖」这一半没有出口，
   * 唯一正确的做法是**动手前整体拒绝**。这里因此刻意使用**不同名**的目标对象，
   * 测的仍是 R10-04 的核心语义：目标侧已有、与本次无关的条目不得被清。
   * 「同名冲突 → 整体拒绝」由 `tests/audit12-regressions.test.js` 的 R12-02 用例守。
   */
  await gateway.movePrefix(BASE_CFG.bucket, 'src/', 'dst/');

  assert(encStore.getMeta(BASE_CFG.bucket, 'dst/keep.txt'),
    'R10-04：目标目录里**与本次复制无关**的对象，元数据必须原样保留 —— '
    + 'migratePrefix 曾无条件清掉整个目标前缀下的条目');
  const moved = encStore.getMeta(BASE_CFG.bucket, 'dst/a.txt');
  assert(moved && moved.origSize === 5,
    'R10-04 正向对照：本次新复制过来的条目，元数据必须迁移过来（源的参数）');
});

/* ================================================================== *
 * R10-05 · init 的 simple/multipart 分界必须感知加密模式
 * ================================================================== */

/**
 * 报告 §2 的 R10-05（中危）：`SIMPLE_THRESHOLD`(8MB) > `MAGIC_SYNC_MAX`(5MB)，
 * 而 init 不感知模式 → **(5MB, 8MB]** 的文件在 magic 模式下陷入死路：
 * init 回 `simple` → 直传 → `encryptBuffer` 抛 413（R9-09 加的上限），
 * 而错误文案让用户「改用分片上传」—— init 却永远不会为该尺寸返回 multipart。
 */
test('R10-05 · magic 模式下 5–8MB 文件必须走分片（不得是死路）', async () => {
  await encStore.updateSettings({ mode: 'magic' });
  const app = await startApp(fsRoutes);
  try {
    const inGap = LIMITS.MAGIC_SYNC_MAX + 1024 * 1024; // 6MB，落在缺口区间
    const r1 = await request(app.port, 'POST', '/api/fs/upload/init', {
      body: { key: 'r10-05/gap.bin', size: inGap },
    });
    const j1 = jsonOf(r1);
    assertEqual(j1 && j1.mode, 'multipart',
      // eslint-disable-next-line max-len
      `（init 响应：${r1.status} ${r1.text}）` +
      'R10-05：magic 模式下 6MB 必须走分片 —— 旧实现回 simple → 直传被 413 拒绝 → '
      + '用户按提示改分片、init 又不给分片，形成死路');
    assert(j1.chunkSize <= LIMITS.MAGIC_SYNC_MAX,
      `R10-05：magic 分片大小必须 ≤ ${LIMITS.MAGIC_SYNC_MAX}（同步阻塞上限/协议下限），实际 ${j1 && j1.chunkSize}`);

    // 恰好 ≤ 上限 → 仍走直传（不要把阈值整体压没）
    const r2 = await request(app.port, 'POST', '/api/fs/upload/init', {
      body: { key: 'r10-05/small.bin', size: LIMITS.MAGIC_SYNC_MAX - 1024 * 1024 },
    });
    assertEqual(jsonOf(r2) && jsonOf(r2).mode, 'simple',
      'R10-05 反向对照：≤ 上限的小文件仍应直传，否则分片路径被无谓放大');
  } finally {
    await app.close();
    await encStore.updateSettings({ mode: 'none' });
  }
});

/* ================================================================== *
 * R10-08 · /fs/upload/chunk 必须校验分片大小
 * ================================================================== */

/**
 * 报告 §2 的 R10-08（中危）：`encryptPart` 没有上限判定，而 chunk 路由只校验
 * 「非空」→ 持有合法会话者可提交远大于 `chunkSize` 的分片（60MB 仍在 raw 的 64MB 内），
 * 让 magic 的同步 XOR 独占事件循环数秒。
 */
test('R10-08 · 超过会话声明分片大小的分片必须被拒绝（400）', async () => {
  fakeObjects.clear();
  const sess = uploadSessions.create({
    uploadId: 'u1', key: 'r10-08/big.bin', bucket: BASE_CFG.bucket, region: BASE_CFG.region,
    size: 40 * 1024 * 1024, chunkSize: 5 * 1024 * 1024, provider: BASE_CFG.provider,
    createdBy: 'admin',
  });

  const app = await startApp(fsRoutes);
  try {
    // 合法：恰好等于 chunkSize
    const ok = await request(app.port, 'PUT',
      `/api/fs/upload/chunk?session=${sess.id}&part=1`,
      { body: Buffer.alloc(5 * 1024 * 1024, 0x41) });
    assertEqual(ok.status, 200, `R10-08 正向对照：等于 chunkSize 的分片必须放行，实际 ${ok.status}`);

    // 越界：chunkSize + 1
    const bad = await request(app.port, 'PUT',
      `/api/fs/upload/chunk?session=${sess.id}&part=2`,
      { body: Buffer.alloc(5 * 1024 * 1024 + 1, 0x42) });
    assertEqual(bad.status, 400,
      'R10-08：超过会话声明分片大小的分片必须 400 —— 旧实现只校验「非空」，'
      + '60MB 分片会让 magic 的同步 XOR 独占事件循环数秒');
  } finally {
    await app.close();
    uploadSessions.remove(sess.id);
  }
});

/* ================================================================== *
 * R10-10 · 分片 complete 的用量缓存修正必须命中
 * ================================================================== */

/**
 * 报告 §3 的 R10-10（低危）：`adjustStorageCache(sess.size, {bucket,region,provider,credentialId})`
 * 传的对象**没有 `secretId`**，而 `bucketCacheKey()` 的键是
 * `provider|secretId|bucket|region` → 分片完成算出的键是 `tencent||...`，
 * 与统计页写入时的 `tencent|stub-id|...` 永不相等 → 修正恒为静默空操作。
 *
 * 走**真实路由**：先用 `/api/stats/storage` 把缓存填进去，再跑分片上传，
 * 最后再读一次 `/api/stats/storage` —— 数字必须涨。
 */
test('R10-10 · 分片上传完成后用量缓存必须被修正（缓存键须含 secretId）', async () => {
  fakeObjects.clear();
  fakeObjects.set('seed.bin', Buffer.from('1234567890')); // 10 字节基准

  const app = await startApp(statsRoutes);
  const app2 = await startApp(fsRoutes);
  try {
    const before = jsonOf(await request(app.port, 'GET', '/api/stats/storage'));
    assert(before && typeof before.usedBytes === 'number',
      `R10-10：前置 —— /stats/storage 应返回用量，实际 ${JSON.stringify(before)}`);

    const size = 12 * 1024 * 1024; // > 8MB → 走分片
    const sess = uploadSessions.create({
      uploadId: 'u-r10-10', key: 'r10-10/big.bin', bucket: BASE_CFG.bucket,
      region: BASE_CFG.region, size, chunkSize: 8 * 1024 * 1024,
      provider: BASE_CFG.provider, createdBy: 'admin',
    });
    uploadSessions.setPart(sess.id, 1, 'etag-1');

    const c = await request(app2.port, 'POST', '/api/fs/upload/complete', {
      body: { sessionId: sess.id },
    });
    assertEqual(c.status, 200, `R10-10：分片合并应成功，实际 ${c.status} ${c.text}`);

    const after = jsonOf(await request(app.port, 'GET', '/api/stats/storage'));
    assertEqual(after.usedBytes, before.usedBytes + size,
      'R10-10：分片完成后用量必须立刻反映（缓存键须含 secretId）—— '
      + '旧实现传的手拼对象缺 secretId，键与统计页不一致 → 恒不命中，'
      + '数字要等 15 分钟 TTL 才刷新');
  } finally {
    await app.close();
    await app2.close();
  }
});

/* ================================================================== *
 * R10-06 / R10-07 / R10-11 · 走真实 WebDAV HTTPS 服务
 * ================================================================== */

let davServer = null;
let davPort = 0;

async function startDav() {
  const webdav = require(path.join(ROOT, 'server', 'webdav-server.js'));
  await webdav.apply();
  if (!webdav.isRunning()) throw new Error('WebDAV 未能启动（端口被占用？）');
  davServer = webdav;
  davPort = Number(process.env.WEBDAV_PORT);
  return davPort;
}

const AUTH = { Authorization: 'Basic ' + Buffer.from('u:p').toString('base64') };

test('R10-06 · WebDAV MOVE 删掉源对象后必须标记指向它的分享链接', async () => {
  await startDav();
  fakeObjects.clear();
  fakeObjects.set('m.txt', Buffer.from('move-me'));
  const link = await shareStore.create({
    key: 'm.txt', bucket: BASE_CFG.bucket, region: BASE_CFG.region,
    fileName: 'm.txt', size: 7, createdBy: 'admin',
  });
  assert(!shareStore.get(link.id).missingAt, '前置：链接初始应为有效');

  const r = await request(davPort, 'MOVE', '/dav/m.txt', {
    tls: true,
    headers: Object.assign({
      Destination: `https://127.0.0.1:${davPort}/dav/m-moved.txt`,
      Overwrite: 'T',
    }, AUTH),
  });
  assert(r.status === 201 || r.status === 204, `R10-06：MOVE 应成功，实际 ${r.status}`);

  assert(shareStore.get(link.id).missingAt,
    'R10-06：MOVE 会删掉源对象 → 必须标记指向它的分享链接。旧实现漏了这一处：'
    + '管理端长期显示有效、分享页照常渲染下载按钮');
});

/**
 * 报告 §2 的 R10-07（中危）：加密对象明文 > `MAX_RANGE_BUFFER` 时 GET 退化为
 * 全量流式解密（回 200），而 HEAD 仍宣告 206 + Content-Range → 续传客户端按区间
 * 建多个连接、每个却收到整份内容 → 拼装出**损坏文件**。
 */
test('R10-07 · 加密大对象的 HEAD 不得宣告 206（与 GET 的服务能力一致）', async () => {
  await startDav();
  fakeObjects.clear();
  const key = 'big-enc.bin';
  fakeObjects.set(key, Buffer.from('x'.repeat(64)));
  encStore.setMeta(BASE_CFG.bucket, key, {
    encrypted: true, mode: 'crypto', origSize: 64 * 1024 * 1024, // 64MB > MAX_RANGE_BUFFER(32MB)
    createdAt: new Date().toISOString(),
    crypto: { segments: [{ n: 1, iv: 'ab', ctLen: 64, tag: 'cd' }] },
  });

  const r = await request(davPort, 'HEAD', `/dav/${key}`, {
    tls: true,
    headers: Object.assign({ Range: 'bytes=0-1023' }, AUTH),
  });

  assertEqual(r.status, 200,
    'R10-07：明文超过 MAX_RANGE_BUFFER 时 GET 会退化为全量（200），'
    + 'HEAD 若仍给 206，续传客户端按区间建连接却收到整份内容 → 拼装出损坏文件');
  assert(!r.headers['content-range'],
    'R10-07：不得返回 Content-Range —— 服务端根本不会服务区间请求');

  /**
   * R11-17 · 正向对照（本条此前只有「不得 206」这一个方向）。
   *
   * 光断言「不得 206」是**半真**护栏：把判定写成恒 false（`if (rh && false)`，
   * 即「任何 Range 都回 200」）时，上面两条断言照样全绿 —— 而那正是 R10-07 想防的
   * 同一类损坏（客户端按 200 全量处理就罢了，真正致命的是 HEAD 与 GET 不一致）。
   * 补上「该 206 时必须 206」这一端，判定退化立刻变红。
   */
  fakeObjects.set('small-enc.bin', Buffer.from('y'.repeat(64)));
  encStore.setMeta(BASE_CFG.bucket, 'small-enc.bin', {
    encrypted: true, mode: 'crypto', origSize: 4096, // 4KB << MAX_RANGE_BUFFER(32MB)
    createdAt: new Date().toISOString(),
    crypto: { segments: [{ n: 1, iv: 'ab', ctLen: 64, tag: 'cd' }] },
  });
  const ok = await request(davPort, 'HEAD', '/dav/small-enc.bin', {
    tls: true,
    headers: Object.assign({ Range: 'bytes=0-1023' }, AUTH),
  });
  assertEqual(ok.status, 206,
    'R11-17 正向对照：明文未超过 MAX_RANGE_BUFFER 时，带 Range 的 HEAD **必须**回 206 —— '
    + '把判定写成恒 false（任何 Range 都回 200）时本条会变红');
  assert(ok.headers['content-range'],
    'R11-17 正向对照：206 必须同时给出 Content-Range（续传客户端据此拼装）');
  assertEqual(String(ok.headers['accept-ranges'] || ''), 'bytes',
    'R11-11：可服务区间时必须宣告 Accept-Ranges: bytes（判据与 GET 同源）');
});

/**
 * R10-12（本轮新增，写护栏时发现）：`app.head('*')` 注册在 `app.get('*')` **之后**，
 * 而 express 的 `Route.prototype._handles_method` 对 HEAD 有回退 ——
 * route 上没有显式 `head` 时把方法名退化成 `get` 再匹配。于是 HEAD 命中 GET 的
 * layer、以 `headOnly=false` 走**下载全路径**，`app.head('*')` 形同虚设。
 *
 * 连带效果：R8-15 的「HEAD 在 readObject 之前分流」、以及本轮 R10-07 的修复
 * （HEAD 不宣告 206）都进不去 —— 请求根本到不了 HEAD 分支。
 *
 * 断言用「流式下载次数」而不是读源码：注册顺序这类结构性缺陷，行为上只有一个
 * 可观测事实 —— HEAD 到底有没有去下载对象。
 */
test('R10-12 · HEAD 必须走 headObject 分支，不得触发对象下载（一次都不许）', async () => {
  await startDav();
  fakeObjects.clear();
  fakeObjects.set('head-probe.bin', Buffer.from('hello webdav'));

  streamReads = 0;
  const r = await request(davPort, 'HEAD', '/dav/head-probe.bin', { tls: true, headers: AUTH });

  assertEqual(r.status, 200, `R10-12：HEAD 应成功，实际 ${r.status}`);
  assertEqual(Number(r.headers['content-length']), 12,
    'R10-12：HEAD 的 Content-Length 必须是对象大小');
  assertEqual(streamReads, 0,
    'R10-12：HEAD **一次都不许**发起对象下载 —— `app.get("*")` 注册在前会把 HEAD '
    + '整个吞掉（express 对 HEAD 回退到 get 匹配），于是每个 HEAD 都真的下载整份对象，'
    + '加密对象还要整份流式解密后再丢弃');

  // 正向对照：GET 必须真的下载（证明计数器不是恒为 0）
  const g = await request(davPort, 'GET', '/dav/head-probe.bin', { tls: true, headers: AUTH });
  assertEqual(g.status, 200, 'R10-12 正向对照：GET 应成功');
  assert(streamReads > 0, 'R10-12 正向对照：GET 必须真的下载 —— 否则「零下载」是计数器坏了');
});

test('R10-11 · Overwrite: F —— 目标是已存在的文件时也必须 412', async () => {
  await startDav();
  fakeObjects.clear();
  fakeObjects.set('dirA/file1.txt', Buffer.from('a1'));
  fakeObjects.set('plain.txt', Buffer.from('i am a file')); // 目标路径上是一个**文件**

  const r = await request(davPort, 'MOVE', '/dav/dirA/', {
    tls: true,
    headers: Object.assign({
      Destination: `https://127.0.0.1:${davPort}/dav/plain.txt/`,
      Overwrite: 'F',
    }, AUTH),
  });

  assertEqual(r.status, 412,
    'R10-11：目标路径上已存在同名文件时必须 412 —— 旧判据只 `listLevel("plain.txt/")`，'
    + '命不中 → 把整个目录写进 plain.txt/ 前缀');
  assert(fakeObjects.has('dirA/file1.txt'), 'R10-11：412 时源必须原样保留');
});

test('R10-11 · Overwrite: F —— 目标是空目录（仅占位对象）时必须 412', async () => {
  await startDav();
  fakeObjects.clear();
  fakeObjects.set('dirA/file1.txt', Buffer.from('a1'));
  fakeObjects.set('emptyDir/', Buffer.from('')); // 空目录：只有一个占位对象

  const r = await request(davPort, 'MOVE', '/dav/dirA/', {
    tls: true,
    headers: Object.assign({
      Destination: `https://127.0.0.1:${davPort}/dav/emptyDir/`,
      Overwrite: 'F',
    }, AUTH),
  });

  assertEqual(r.status, 412,
    'R10-11：目标是一个已存在的空目录时必须 412 —— `listLevel` 会把占位对象 '
    + '（`c.Key === prefix`）跳过 → 旧判据认为目标不存在');
  assert(fakeObjects.has('dirA/file1.txt'), 'R10-11：412 时源必须原样保留');
});

test('R10-11 · 目录 COPY + Overwrite: F 必须在动手之前整体拒绝（零复制）', async () => {
  await startDav();
  fakeObjects.clear();
  fakeObjects.set('srcA/1.txt', Buffer.from('1'));
  fakeObjects.set('srcA/2.txt', Buffer.from('2'));
  fakeObjects.set('dstA/other.txt', Buffer.from('o')); // 目标非空

  const r = await request(davPort, 'COPY', '/dav/srcA/', {
    tls: true,
    headers: Object.assign({
      Destination: `https://127.0.0.1:${davPort}/dav/dstA/`,
      Overwrite: 'F',
    }, AUTH),
  });

  assertEqual(r.status, 412,
    'R10-11：目录 COPY + Overwrite: F 且目标已存在时必须 412（RFC 4918 §9.8.4）');
  assert(!fakeObjects.has('dstA/1.txt') && !fakeObjects.has('dstA/2.txt'),
    'R10-11：必须在**动手之前**整体拒绝 —— 旧实现在循环里逐对象 headObject，'
    + '复制掉若干个才发现冲突，目标目录留下无法回滚的半成品副本');
});

/* ================================================================== *
 * 收尾
 * ------------------------------------------------------------------ */

test.after(async () => {
  try { if (davServer) await davServer.close(); } catch (e) { /* ignore */ }
  for (const s of openServers) {
    try {
      if (typeof s.closeAllConnections === 'function') s.closeAllConnections();
      s.close();
    } catch (e) { /* ignore */ }
  }
  try {
    await require(path.join(ROOT, 'server', 'secure-store.js')).flush();
  } catch (e) { /* ignore */ }
  try {
    const statsStoreMod = require(path.join(ROOT, 'server', 'stats-store.js'));
    const secureStore = require(path.join(ROOT, 'server', 'secure-store.js'));
    await cleanupTempDir(TMP, {
      label: 'audit10-regressions',
      flushers: [
        { name: 'upload-sessions', flush: () => uploadSessions.flushSync() },
        { name: 'stats-store', flush: () => statsStoreMod.flushStatsSync() },
        { name: 'secure-store', flush: () => secureStore.flush() },
      ],
    });
  } catch (e) { /* ignore */ }
});
