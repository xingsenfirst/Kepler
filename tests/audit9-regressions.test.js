/**
 * 测试：第 9 轮审计修复的回归护栏（见开发文档「六、审计发现台账 6.4」）
 *
 * 编排原则与前几轮一致，并针对第 9 轮报告 §4 的元结论做了强化 ——
 * **断言一律打在「入口」上**（真实 HTTP 路由 / 真实事件流），而不是直接调内部函数：
 * 后者守不住"函数修好了但没接线"这一类缺陷（正是 R9-03 得以存活的原因）。
 *
 * 本文件覆盖的编号：
 *   R9-01 WebDAV 目录 COPY 不得复制到自身子目录（无界递归复制）
 *   R9-02 S3 批量删除丢弃 `<Error>` → 调用方必须走白名单判据
 *   R9-03 WebDAV COPY / MOVE 覆盖写入后必须对账加密元数据
 *   R9-04 WebDAV Range 响应必须与 HEAD 的宣告一致（206 + 区间长度）
 *   R9-05 `/s/:id/pay/status` 必须接入按 IP 的网关查单预算
 *   R9-06 目录 MOVE 必须认 `Overwrite: F`（412）
 *   R9-07 整桶标记对无 `bucket` 历史链接改回严格口径
 *   R9-08 测试收尾后退出钩子不得重建已删除的数据目录
 *   R9-09 magic 加密上限必须下沉到 `encryptBuffer`（覆盖直传 / WebDAV PUT）
 *   R9-10 加密下载「用户取消密码验证」不得落进 blob 回退分支
 *
 * 其余编号的护栏位置：
 *   R9-04 的 HEAD 侧一致性与路由表面积 → tests/routes-surface.test.js
 *   R9-05 的限流器预置值与阈值 → 本文件（security 实例断言）+ tests/routes-surface.test.js
 *   R9-10 的前端控制流 → tests/frontend.test.js（源码结构断言，附样例自测）
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-audit9-'));
process.env.COS_DATA_DIR = TMP;
// WebDAV 端口固定从环境变量取，且 `Number('0') || 8443` 让 0 不可用 → 指定一个高位端口。
// 端口冲突时 apply() 会捕获 EADDRINUSE 并打印日志（不会抛出），用例据此断言失败。
process.env.WEBDAV_PORT = String(18800 + (process.pid % 300));

const cos = require(path.join(ROOT, 'server', 'cos.js'));
const configStore = require(path.join(ROOT, 'server', 'config-store.js'));

/** 记录每次云端动作，供「有没有真的打云端」「用了哪个接口」这类断言使用 */
const pCalls = [];
/** 内存中的对象存储：key -> Buffer（字符串键值足够表达测试关心的一切） */
const fakeObjects = new Map();
/** 「云端拒绝删除」的 key 集合（R9-02 用例用：模拟 S3 在 200 响应体里报 <Error>） */
let deleteRejects = null;
/**
 * 「云端既不确认也不报错」的 key 集合（R9-02 用例 ③ 用）。
 *
 * 这是**白名单判据唯一能挡住**的情形：协议外行为 / 解析退化时，响应体里既没有
 * `<Deleted>` 也没有 `<Error>`。黑名单判据（「不在 Error 里就算成功」）会把这类对象
 * 当作删除成功 → 清掉仍然存在的密文凭据 + 标掉分享链接（两件都不可逆）。
 */
let deleteSilent = null;

const BASE_CFG = {
  secretId: 'stub-id', secretKey: 'stub-key',
  bucket: 'audit9-bucket', region: 'ap-guangzhou', provider: 'tencent',
};

/**
 * ⚠️ 打桩必须在 require 路由之前完成 —— 各模块在加载时就用解构把 `p` / `getClient`
 * 绑定了自身作用域（`const { getClient, p } = require('./cos')`）。
 * 之后改 `cos.p` 对它们没有任何影响（audit8 的编排注释也写明了这一点）。
 *
 * 另注：`fs-gateway.readObject` 的**流式下载**不走 `p()`，而是直接
 * `getClient(cfg).getObject(opts, cb)`（保持背压）。因此 `fakeClient` 必须自带
 * `getObject`，否则 GET 会在「客户端无此方法」上抛错 → 500。
 */
const fakeClient = { __provider: 'tencent' };
cos.getClient = () => fakeClient;
fakeClient.getObject = (opts, cb) => {
  const k = opts.Key;
  const buf = fakeObjects.get(k);
  if (buf === undefined) {
    const e = new Error('Not Found');
    e.status = 404;
    if (cb) process.nextTick(() => cb(e));
    if (opts.Output) process.nextTick(() => opts.Output.destroy(e));
    return;
  }
  // 模拟「云端只回请求区间」的行为：Range 存在时只推该段（这正是 R9-04 的前提）
  let slice = buf;
  const rm = /^bytes=(\d+)-(\d+)$/.exec(String(opts.Range || ''));
  if (rm) slice = buf.slice(Number(rm[1]), Number(rm[2]) + 1);
  if (opts.Output) process.nextTick(() => { opts.Output.end(slice); });
  if (cb) process.nextTick(() => cb(null, {}));
};
cos.p = async (client, method, params) => {
  pCalls.push({ method, params });
  switch (method) {
    case 'headObject': {
      const k = params.Key;
      if (!fakeObjects.has(k)) {
        const e = new Error('Not Found');
        e.status = 404; e.statusCode = 404;
        throw e;
      }
      return { headers: { 'content-length': String(fakeObjects.get(k).length), etag: 'etag-' + k } };
    }
    case 'getObject': {
      const k = params.Key;
      const buf = fakeObjects.get(k);
      if (buf === undefined) {
        const e = new Error('Not Found');
        e.status = 404;
        if (params.Output) params.Output.destroy(e);
        throw e;
      }
      // 模拟「云端只回请求区间」的行为：Range 存在时只推该段
      let slice = buf;
      const rm = /^bytes=(\d+)-(\d+)$/.exec(String(params.Range || ''));
      if (rm) slice = buf.slice(Number(rm[1]), Number(rm[2]) + 1);
      if (params.Output) process.nextTick(() => { params.Output.end(slice); });
      return {};
    }
    case 'putObject': {
      fakeObjects.set(params.Key, Buffer.from(String(params.Body || '')));
      return { ETag: 'etag' };
    }
    case 'deleteObject': {
      fakeObjects.delete(params.Key);
      return {};
    }
    case 'deleteMultipleObject': {
      /**
       * **默认行为**：整批 200 + Deleted 全命中（正常厂商路径）。
       *
       * 需要模拟「云端部分失败」的用例通过设置 `deleteRejects`（一个 key 集合）
       * 来表达 —— 这些 key 不删、改为在响应体的 `<Error>` 里报告。
       *
       * ⚠️ 必须用「共享状态」而不是「替换 cos.p」：`routes/fs.js` 在模块加载时就把
       * `p` 解构绑定了自身作用域，测试里改 `cos.p` 对它没有任何影响
       * （这正是本文件开头注释强调的顺序陷阱）。
       */
      const rejected = deleteRejects;
      const silent = deleteSilent;
      const deleted = [];
      const errors = [];
      for (const o of (params.Objects || [])) {
        if (rejected && rejected.has(o.Key)) {
          errors.push({ Key: o.Key, Code: 'AccessDenied', Message: '对象被锁定，无法删除' });
        } else if (silent && silent.has(o.Key)) {
          // 协议外行为：对象**没有被删掉**，但响应体里既不说 Deleted 也不说 Error。
          // 白名单判据必须把它归到「未确认成功」一侧；黑名单判据会误判为成功。
        } else {
          fakeObjects.delete(o.Key);
          deleted.push({ Key: o.Key });
        }
      }
      return { Deleted: deleted, Error: errors };
    }
    case 'putObjectCopy': {
      /**
       * CopySource 的形态按厂商而异（同一份 `copySource()` 产出）：
       *   - S3 兼容：`/bucket/key`
       *   - 腾讯云 COS：`bucket.cos.<region>.myqcloud.com/key`（**无 scheme**）
       * 测试只关心「源 key」，因此这里按「第一个 `/` 之后」或「host 之后」统一取。
       */
      const src = String(params.CopySource || '').split('?')[0].replace(/^https?:\/\//, '');
      const srcKey = src.startsWith('/')
        ? src.replace(/^\/[^/]+\//, '')
        : src.replace(/^[^/]+\//, '');
      const buf = fakeObjects.get(srcKey);
      if (buf === undefined) {
        throw Object.assign(new Error('Not Found: ' + srcKey), { status: 404 });
      }
      fakeObjects.set(params.Key, Buffer.from(buf));
      return { ETag: 'etag', LastModified: new Date().toISOString() };
    }
    case 'multipartInit': return { UploadId: 'audit9-upload-id' };
    case 'multipartListPart': return { ListPartsResult: { Part: [] } };
    case 'multipartList': return { ListUploadsResult: { Upload: [], IsTruncated: 'false' } };
    case 'getBucket': {
      // 前缀列举：按 key 字典序返回全部对象（Delimiter: '' 的递归语义）
      const prefix = String(params.Prefix || '');
      const keys = [...fakeObjects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const contents = keys.map((k) => ({
        Key: k, Size: fakeObjects.get(k).length, LastModified: new Date().toISOString(),
      }));
      return { Contents: contents, CommonPrefixes: [], IsTruncated: 'false' };
    }
    default: return {};
  }
};

/**
 * `configStore.get()` 决定 fs-gateway / 路由到处使用的桶配置；
 * `getWebdav()` / `authenticateWebdav()` 决定 WebDAV 服务是否监听。
 * 三者都必须在 require 之前替换 —— 但它们都在模块内以 `configStore.xxx()` 形式调用，
 * 因此可以在 require 之后再替换。这里统一提前做，避免顺序陷阱。
 */
configStore.get = () => BASE_CFG;
configStore.getWebdav = () => ({ enabled: true, accounts: [{ id: 'a1', username: 'u' }] });
/**
 * `getClientForSession()`（`routes/fs.js`）在续传路径上按**会话自己的桶**解析凭据，
 * 走的是 `effectiveForBucket()` 而不是 `get()`。不桩它会让续传分支因「无可用密钥」
 * 抛 428 → 被内层 catch 吞成 `sess = null` → 静默重建会话（把要测的路径绕过去了）。
 */
configStore.effectiveForBucket = () => BASE_CFG;
configStore.authenticateWebdav = async (user, pass) =>
  (user === 'u' && pass === 'p'
    ? { ok: true, account: { id: 'a1', username: 'u', role: 'admin' } }
    : { ok: false });

const security = require(path.join(ROOT, 'server', 'security.js'));
const statsStore = require(path.join(ROOT, 'server', 'stats-store.js'));
statsStore.addLog = () => {};
statsStore.trackBucket = () => {};
const encStore = require(path.join(ROOT, 'server', 'enc-store.js'));
const shareStore = require(path.join(ROOT, 'server', 'share-store.js'));
const gateway = require(path.join(ROOT, 'server', 'fs-gateway.js'));
const { LIMITS } = require(path.join(ROOT, 'server', 'limits.js'));
const shared = require(path.join(ROOT, 'server', 'routes', '_shared.js'));
shared.requireConfig = () => BASE_CFG;
const fsRoutes = require(path.join(ROOT, 'server', 'routes', 'fs.js'));

/* ------------------------------------------------------------------ *
 * 1 · 迷你 HTTP 工具（与 audit7/8 同型，保持逐轮护栏自包含）
 * ------------------------------------------------------------------ */

/** 已启动的 express 测试服务（收尾时统一关闭，避免 keep-alive 句柄吊住进程） */
const openServers = [];

function startApp(router, { authUser } = {}) {
  const express = require(path.join(ROOT, 'node_modules', 'express'));
  const app = express();
  app.use(express.json({ limit: '256kb' }));
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
        payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : null,
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

const json = (port, method, urlPath, body, opts) =>
  request(port, method, urlPath, Object.assign({ body }, opts)).then((r) => {
    let j = null;
    try { j = JSON.parse(r.text); } catch (e) { /* 非 JSON */ }
    return { status: r.status, json: j, text: r.text, headers: r.headers };
  });

/* ================================================================== *
 * R9-02 · S3 批量删除必须解析响应体 `<Error>`
 * ================================================================== */

/**
 * 报告 §2 的 R9-02：`s3-client.deleteMultipleObject` 曾硬编码 `Error: []`，
 * 把 S3 在 **200 响应体内**报告的单个失败全部丢弃；而 `routes/fs.js` 的 `/fs/delete`
 * 以该字段为唯一成败判据（黑名单：「不在 Error 里就算成功」）→ 对**仍然存在**的对象
 * 执行两件不可逆操作：清掉密文的解密凭据 + 把分享链接标成「已删除」。
 *
 * 这条护栏打在两处**真实入口**上：
 *  ① 真实 S3 客户端解析一段真实的 `DeleteObjects` 响应体（含 `<Error>`）；
 *  ② 真实 `/fs/delete` 路由 + 真实分享链接，验证失败对象的元数据与链接状态都没被动。
 */
test('R9-02 · S3 客户端必须把响应体里的 <Error> 解析出来，而不是丢弃', async () => {
  const { S3Client } = require(path.join(ROOT, 'server', 's3-client.js'));
  const client = new S3Client({
    accessKeyId: 'a', secretAccessKey: 'b',
    endpoint: 'https://s3.example.com', bucket: 'bk', region: 'us-east-1',
  });
  // 拦截底层 HTTP：返回一份真实的 DeleteObjects 响应 —— 一个成功、一个失败
  client._send = async () => '<?xml version="1.0" encoding="UTF-8"?>'
    + '<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
    + '<Deleted><Key>ok-1.txt</Key></Deleted>'
    + '<Error><Key>locked.txt</Key><Code>AccessDenied</Code>'
    + '<Message>Access Denied by object lock</Message></Error>'
    + '</DeleteResult>';

  const r = await new Promise((resolve, reject) => {
    client.deleteMultipleObject({ Bucket: 'bk', Objects: [{ Key: 'ok-1.txt' }, { Key: 'locked.txt' }] },
      (err, data) => (err ? reject(err) : resolve(data)));
  });

  assertEqual(r.Deleted.length, 1, 'Deleted 应只含真正删掉的那个 key');
  assertEqual(r.Deleted[0].Key, 'ok-1.txt', 'Deleted 的 key 必须如实解析');
  assertEqual(r.Error.length, 1,
    'R9-02：响应体里的 <Error> 必须被解析出来 —— 旧实现硬编码 Error: [] 把它整份丢弃');
  assertEqual(r.Error[0].Key, 'locked.txt', 'Error 的 Key 必须解析（调用方据此定位）');
  assertEqual(r.Error[0].Code, 'AccessDenied', 'Error 的 Code 必须解析');
  assert(r.Error[0].Message && /object lock/.test(r.Error[0].Message),
    'Error 的 Message 必须解析（人可读原因）');
});

test('R9-02 · /fs/delete 对「云端拒绝删除」的对象不得清元数据、不得标记分享链接', async () => {
  const srv = await startApp(fsRoutes);
  const doomed = 'r9-02/locked.bin';
  const fine = 'r9-02/fine.bin';
  fakeObjects.set(doomed, Buffer.from('locked-content'));
  fakeObjects.set(fine, Buffer.from('normal-content'));

  // 给两个对象都建立加密元数据（crypto 模式），并各建一条分享链接
  const linkDoomed = await shareStore.create({
    key: doomed, bucket: BASE_CFG.bucket, region: BASE_CFG.region,
    fileName: 'locked.bin', size: 14, expiresHours: 0, maxDownloads: 0,
    password: null, paid: null, createdBy: 'tester',
  });
  encStore.setMeta(BASE_CFG.bucket, doomed, {
    mode: 'crypto', origSize: 14, createdAt: new Date().toISOString(),
    crypto: { segments: [{ n: 1, iv: '00', ctLen: 14, tag: '00' }] },
  });

  // 云端：整批 200，但 doomed 那一条在响应体里报 <Error>
  deleteRejects = new Set([doomed]);

  try {
    const r = await json(srv.port, 'POST', '/api/fs/delete', { paths: [doomed, fine] });
    assertEqual(r.status, 200, '接口本身应正常返回');

    const byPath = new Map((r.json.results || []).map((x) => [x.path, x]));
    assertEqual(byPath.get(doomed).ok, false,
      'R9-02：云端明确报错的对象必须被判为失败（旧实现把它算成功）');
    assertEqual(byPath.get(fine).ok, true, '真正删掉的对象仍应判为成功');

    assert(encStore.getMeta(BASE_CFG.bucket, doomed),
      'R9-02：删除失败的密文对象，其解密凭据**绝不能**被清 —— 清了该文件永久不可解');
    assertEqual(shareStore.status(shareStore.get(linkDoomed.id)), 'active',
      'R9-02：删除失败的对象的分享链接**绝不能**被标成「已删除」—— 那是已分发链接的永久失效');
  } finally {
    deleteRejects = null;
  }
  await srv.close();
});

/**
 * R9-02 的**白名单语义**必须被单独守住 —— 上面的用例只模拟了「明确报 `<Error>`」，
 * 而黑名单判据（「不在 Error 里就算成功」）在那个场景下同样会给出正确结果。
 * 真正只有白名单能挡住的是：**云端既不确认也不报错**（协议外行为 / 解析退化）。
 */
test('R9-02 · 云端「既不确认也不报错」的对象必须按未删除处理（白名单语义）', async () => {
  const srv = await startApp(fsRoutes);
  const ghost = 'r9-02/unconfirmed.bin';
  fakeObjects.set(ghost, Buffer.from('still-there'));
  encStore.setMeta(BASE_CFG.bucket, ghost, {
    mode: 'crypto', origSize: 11, createdAt: new Date().toISOString(),
    crypto: { segments: [{ n: 1, iv: '00', ctLen: 11, tag: '00' }] },
  });
  const link = await shareStore.create({
    key: ghost, bucket: BASE_CFG.bucket, region: BASE_CFG.region,
    fileName: 'unconfirmed.bin', size: 11, expiresHours: 0, maxDownloads: 0,
    password: null, paid: null, createdBy: 'tester',
  });
  deleteSilent = new Set([ghost]);

  try {
    const r = await json(srv.port, 'POST', '/api/fs/delete', { paths: [ghost] });
    assertEqual(r.status, 200, '接口本身应正常返回');
    const byPath = new Map((r.json.results || []).map((x) => [x.path, x]));
    assertEqual(byPath.get(ghost).ok, false,
      'R9-02：云端没有确认删除的对象必须判为失败 —— '
      + '黑名单判据（「不在 Error 里就算成功」）会把它当成功，进而执行两件不可逆操作');

    assert(fakeObjects.has(ghost), '前置：对象在云端确实仍然存在');
    assert(encStore.getMeta(BASE_CFG.bucket, ghost),
      'R9-02：未确认删除的密文对象，解密凭据必须保留 —— 清了该文件永久不可解');
    assertEqual(shareStore.status(shareStore.get(link.id)), 'active',
      'R9-02：未确认删除的分享链接不得被标记 —— 那是已分发链接的永久失效');
  } finally {
    deleteSilent = null;
  }
  await srv.close();
});

/**
 * R9-02 的**报告面**（`errors`）此前没有任何断言 —— 路由层自己对任何不在
 * `res.okKeys` 里的 key 一律回 `ok: false`（`routes/fs.js:1287` 的兜底文案），
 * 因此把判据里的 `if (!okSet.has(k) && !errMap.has(k))` 改成恒 false 时，
 * 上面三条用例**照样全绿**（第 11 轮 R11-18 用静态护栏逐条验 anchor 时实测）。
 *
 * 而 `deleteMultipleConfirmed` 是判据的**唯一实现点**：`fs-gateway` 的 deletePrefix /
 * movePrefix 回滚 / 清空桶全都靠 `errors` 才知道"到底哪个没删掉"（日志里要如实留痕）。
 * 报告面缺失 = 那些入口只能报「失败」却说不出失败的是谁。故单独守这一半。
 */
test('R9-02 · deleteMultipleConfirmed 必须把「既不确认也不报错」的 key 报进 errors', async () => {
  const ghost = 'r9-02/report.bin';
  fakeObjects.set(ghost, Buffer.from('x'));
  deleteSilent = new Set([ghost]);
  try {
    // 打在唯一实现点上：`callP` 绕 `module.exports.p`，因此本文件的 `cos.p` 桩对内部函数有效
    const res = await cos.deleteMultipleConfirmed(fakeClient, BASE_CFG, [ghost]);
    assertEqual(res.okKeys.length, 0,
      'R9-02：未确认的 key 不得出现在 okKeys 里（这是白名单判据的核心）');
    assert(res.errors.some((e) => e.key === ghost && e.message),
      'R9-02：「云端既不确认也不报错」的 key 必须被报进 errors —— 黑名单判据下它被'
      + '静默丢弃，其它调用方（删目录 / 回滚 / 清桶）就只能报「失败」却说不出失败的是谁');
  } finally {
    deleteSilent = null;
    fakeObjects.delete(ghost);
  }
});

/* ================================================================== *
 * R9-03 · 复制路径必须接上「写后对账」
 * ================================================================== */

/**
 * 报告 §2 的 R9-03：R8-03 把三条**上传/写入**路径收敛到 `reconcileAfterWrite()`，
 * 但**复制路径没有接上**。而 WebDAV 的 COPY 在 `Overwrite: T`（默认）下会用
 * `putObjectCopy` 覆盖已存在的目标 —— 这是一次覆盖写入，语义与上传完全相同。
 *
 * 本用例驱动**真实的 `gateway.copyObject`**（这是 WebDAV COPY 的唯一入口），断言
 * 覆盖写入后目标 key 的加密元数据被正确对账。旧实现只调 `copyMeta()`，
 * 而它在「源无元数据」时**直接 return、不清目标** → 目标残留陈旧密文元数据。
 */
test('R9-03 · 复制覆盖写入后必须对账：源为明文时清掉目标的陈旧密文元数据', async () => {
  const src = 'r9-03/plain-source.txt'; // 明文（无元数据）
  const dst = 'r9-03/overwritten.bin'; // 目标曾加密过 → 有陈旧元数据
  fakeObjects.set(src, Buffer.from('this is plain text'));
  fakeObjects.set(dst, Buffer.from('old ciphertext'));

  // 目标残留一条 **magic** 模式的旧元数据（最危险：下载不报错、静默产出错内容）
  encStore.setMeta(BASE_CFG.bucket, dst, {
    mode: 'magic', origSize: 13, createdAt: new Date().toISOString(),
    magic: { salt: null, header: Buffer.from('OLDHDR').toString('base64'), magicLen: 6 },
  });
  assert(encStore.getMeta(BASE_CFG.bucket, dst), '前置：目标必须先有一条陈旧元数据');

  // 直接驱动真实入口 gateway.copyObject（WebDAV COPY 调的就是它）
  await gateway.copyObject(BASE_CFG.bucket, src, dst, 'webdav.copy', 'test ');

  assertEqual(encStore.getMeta(BASE_CFG.bucket, dst), null,
    'R9-03：源是明文 → 覆盖后目标必须**没有**加密元数据；'
    + '旧实现只调 copyMeta（源无元数据时直接 return）→ 陈旧 magic 元数据残留 '
    + '→ 下载静默产出「看起来正常、内容全错」的文件');

  // 反向：源是密文时，复制必须把源元数据带到目标
  const encSrc = 'r9-03/crypto-source.bin';
  const encDst = 'r9-03/crypto-target.bin';
  fakeObjects.set(encSrc, Buffer.from('cipher payload'));
  encStore.setMeta(BASE_CFG.bucket, encSrc, {
    mode: 'crypto', origSize: 14, createdAt: new Date().toISOString(),
    crypto: { segments: [{ n: 1, iv: 'ab', ctLen: 14, tag: 'cd' }] },
  });
  await gateway.copyObject(BASE_CFG.bucket, encSrc, encDst, 'webdav.copy', 'test ');
  const moved = encStore.getMeta(BASE_CFG.bucket, encDst);
  assert(moved, 'R9-03：源是密文 → 目标必须拿到解密凭据（否则复制出来的密文不可解）');
  assertEqual(moved.mode, 'crypto', '目标元数据的模式必须与源一致');
});

/* ================================================================== *
 * R9-06 · 目录 MOVE 必须认 Overwrite: F（走真实 WebDAV 服务器）
 * ================================================================== */

/**
 * 报告 §2 的 R9-06：R8-16 给 COPY 的目录分支补了 `Overwrite` 判定，**目录 MOVE 漏了**。
 * RFC 4918 §9.9.4 要求目标已存在 + `Overwrite: F` 时回 412，本实现此前直接合并并回 201。
 *
 * 本用例起**真实的 WebDAV HTTPS 服务**，用真实 Basic 认证与真实请求头驱动 ——
 * 这是「断言打在入口上」的要求（守函数不守调用点会漏掉"没接线"）。
 */
let davServer = null;
let davPort = 0;

async function startDav() {
  const webdav = require(path.join(ROOT, 'server', 'webdav-server.js'));
  // 开启 WebDAV 并给一个可认证账户；密钥来自 BASE_CFG
  configStore.get = () => BASE_CFG;
  configStore.getWebdav = () => ({ enabled: true, accounts: [{ id: 'a1', username: 'u' }] });
  configStore.authenticateWebdav = async (user, pass) =>
    (user === 'u' && pass === 'p' ? { ok: true, account: { id: 'a1', username: 'u', role: 'admin' } }
      : { ok: false });
  await webdav.apply();
  if (!webdav.isRunning()) throw new Error('WebDAV 未能启动（端口被占用？）');
  davServer = webdav;
  davPort = Number(process.env.WEBDAV_PORT);
  return davPort;
}

const AUTH = { Authorization: 'Basic ' + Buffer.from('u:p').toString('base64') };

test('R9-06 · 目录 MOVE + Overwrite: F 且目标存在 → 412（不得静默合并）', async () => {
  await startDav();
  // 源目录 dirA/ 与目标 dirB/ 都已有对象
  fakeObjects.set('dirA/file1.txt', Buffer.from('a1'));
  fakeObjects.set('dirB/file2.txt', Buffer.from('b2'));

  const r = await request(davPort, 'MOVE', '/dav/dirA/', {
    tls: true,
    headers: Object.assign({
      Destination: `https://127.0.0.1:${davPort}/dav/dirB/`,
      Overwrite: 'F',
    }, AUTH),
  });

  assertEqual(r.status, 412,
    'R9-06：目标已存在且 Overwrite: F 必须回 412（RFC 4918 §9.9.4）；'
    + '旧实现目录 MOVE 忽略 Overwrite → 直接合并并回 201');
  assert(fakeObjects.has('dirA/file1.txt'),
    'R9-06：412 时源目录必须原样保留（不得已搬走一半）');
});

/* ================================================================== *
 * R9-01 · 目录 COPY 不得复制到自身子目录（走真实 WebDAV 服务器）
 * ================================================================== */

/**
 * 报告 §2 的 R9-01（本轮唯一「不可自愈 + 不可逆 + 无用户感知」的缺陷）：
 * 把目录复制进它自己的子目录时，复制出的副本会被下一页再次当作源对象 →
 * `IsTruncated` 恒为 true → 请求永不返回 + 云端持续产生计费对象。
 *
 * 命名条件几乎总是成立：`photos/IMG.x`（I=0x49）< `photos/backup/IMG.x`（b=0x62）。
 * 管理端的两个同类入口早有守卫（`routes/fs.js` 的 rename / move），WebDAV 漏了。
 *
 * 护栏打**真实请求**上，并断言「既被拒绝、又没复制任何对象」——
 * 后者才是真正要防的（无界递归 + 计费）。
 */
test('R9-01 · 目录 COPY 到自身子目录必须被拒绝，且不得复制出任何对象', async () => {
  await startDav();
  fakeObjects.set('photos/IMG_0001.jpg', Buffer.from('img1'));
  fakeObjects.set('photos/IMG_0002.jpg', Buffer.from('img2'));
  const before = fakeObjects.size;

  const r = await request(davPort, 'COPY', '/dav/photos/', {
    tls: true,
    headers: Object.assign({
      Destination: `https://127.0.0.1:${davPort}/dav/photos/backup/`,
    }, AUTH),
  });

  assertEqual(r.status, 403,
    'R9-01：复制到自身子目录必须被拒绝（与管理端 routes/fs.js 同款守卫）');
  assertEqual(fakeObjects.size, before,
    'R9-01：被拒绝时不得复制出任何对象 —— 旧实现会无界递归复制并持续计费');
  assert(![...fakeObjects.keys()].some((k) => k.startsWith('photos/backup/')),
    'R9-01：目标前缀下不得出现任何副本');
});

test('R9-01 · 目录 MOVE 到自身内部同样被拒绝', async () => {
  await startDav();
  fakeObjects.set('docs/a.txt', Buffer.from('x'));
  const before = fakeObjects.size;

  const r = await request(davPort, 'MOVE', '/dav/docs/', {
    tls: true,
    headers: Object.assign({
      Destination: `https://127.0.0.1:${davPort}/dav/docs/inner/`,
    }, AUTH),
  });

  assertEqual(r.status, 403, 'R9-01：MOVE 到自身内部必须被拒绝');
  assertEqual(fakeObjects.size, before, 'R9-01：被拒绝时不得动任何对象');
});

/* ================================================================== *
 * R9-04 · WebDAV Range 响应必须与 HEAD 的宣告一致
 * ================================================================== */

/**
 * 报告 §2 的 R9-04：非加密对象的 GET 把 `Range` 转给云端（云端只回该区间），
 * 但返回的 `contentLength` 是 `headObject` 的**全量**长度、`rangeServed` 恒为 false
 * → 调用方发 `200 + Content-Length: 全量`，body 里只有区间字节 → 客户端按
 * `Content-Length` 等剩余字节，最终报「传输被提前关闭」，大文件表现为下载损坏。
 *
 * 尤其矛盾的是同一轮里 HEAD 刚被改成如实宣告 `Accept-Ranges` 并对 Range 回 206。
 * 本用例把**两端一起断言**，锁住「HEAD 说的和 GET 做的一致」。
 */
test('R9-04 · 非加密对象的 Range GET 必须回 206 + 区间长度（与 HEAD 一致）', async () => {
  await startDav();
  const key = 'range/sample.bin';
  const payload = Buffer.alloc(1000, 0x41);
  fakeObjects.set(key, payload);

  const get = await request(davPort, 'GET', '/dav/range/sample.bin', {
    tls: true, headers: Object.assign({ Range: 'bytes=0-99' }, AUTH),
  });

  assertEqual(get.status, 206,
    'R9-04：带 Range 的 GET 必须回 206；旧实现回 200');
  assertEqual(get.headers['content-length'], '100',
    'R9-04：Content-Length 必须是**区间**长度；旧实现回全量长度 → '
    + '客户端等不到剩余字节，报「传输被提前关闭」');
  assertEqual(get.headers['content-range'], 'bytes 0-99/1000',
    'R9-04：必须给出 Content-Range');
  assertEqual(Buffer.from(get.text, 'binary').length, 100,
    'R9-04：body 长度必须等于区间长度（旧实现只发区间字节却宣告全量长度）');

  // HEAD 侧必须给出同一套事实（两端一致才不会自相矛盾）
  const head = await request(davPort, 'HEAD', '/dav/range/sample.bin', {
    tls: true, headers: Object.assign({ Range: 'bytes=0-99' }, AUTH),
  });
  assertEqual(head.status, 206, 'R9-04：HEAD 带 Range 也回 206（两端一致）');
  assertEqual(head.headers['content-length'], '100', 'R9-04：HEAD 的长度必须与 GET 相同');

  // 越界 Range → 416（且不得被折叠成 500）
  const bad = await request(davPort, 'GET', '/dav/range/sample.bin', {
    tls: true, headers: Object.assign({ Range: 'bytes=5000-6000' }, AUTH),
  });
  assertEqual(bad.status, 416,
    'R9-04：越界 Range 必须回 416；旧实现把非 404 一律折叠成 500，'
    + '续传客户端会当成「服务端故障」而无限重试');
});

/* ================================================================== *
 * R9-09 · magic 上限必须覆盖「切换模式 + 断点续传」这条残留口
 * ================================================================== */

/**
 * 报告 §4 的元结论另一面：即使上限下沉到了 `encryptBuffer`，**分片会话**这条路仍然
 * 是「按会话创建时的 chunkSize 切分」。会话在 `mode=none` 下创建（chunkSize 最大 48MB），
 * 管理员随后切到 magic，用户复用会话继续上传 → 单个 48MB 分片的 `encryptPart`
 * 同步阻塞约 3 秒，R8-02 想压的问题在这条路径上原样存在。
 *
 * 本用例驱动**真实 `/fs/upload/init`**：先造一个「大分片」的既有会话，再切成 magic，
 * 断言这条路径被如实拒绝（409）而不是静默沿用大分片。
 */
test('R9-09 · 切换模式后续传：既有大分片会话必须被拒绝，而不是静默沿用', async () => {
  const uploadSessions = require(path.join(ROOT, 'server', 'upload-sessions.js'));
  const srv = await startApp(fsRoutes);

  // 先以 non-magic 建立会话 → chunkSize 取 plainChunk（48MB 上限，这里给个明显的值）
  await encStore.updateSettings({ mode: 'none' });
  const key = 'r9-09/resume-big.bin';
  const size = 90 * 1024 * 1024; // > SIMPLE_THRESHOLD，强制走分片
  const first = await json(srv.port, 'POST', '/api/fs/upload/init', { key, size });
  assertEqual(first.status, 200, '前置：首次 init 应成功');
  assertEqual(first.json.mode, 'multipart', '前置：大文件应走分片');
  const bigChunk = first.json.chunkSize;
  assert(bigChunk > LIMITS.MAGIC_SYNC_MAX,
    `前置：会话分片 ${bigChunk} 应大于 magic 上限 ${LIMITS.MAGIC_SYNC_MAX}`);

  // 管理员切到 magic，用户复用同一会话续传
  await encStore.updateSettings({ mode: 'magic' });
  try {
    const second = await json(srv.port, 'POST', '/api/fs/upload/init', { key, size });
    assertEqual(second.status, 409,
      'R9-09：切到 magic 后复用大分片会话必须被拒绝（409）—— '
      + '否则 48MB 分片的同步加密会阻塞事件循环约 3 秒（R8-02 的残留口）');
    assert(/分片|上限/.test(second.json.error || ''),
      'R9-09：错误文案必须说明原因（分片过大 / 超过上限）');
  } finally {
    await encStore.updateSettings({ mode: 'none' });
    // 清掉本用例留下的会话，避免影响后续断言
    for (const s of uploadSessions.list()) {
      if (s.key === key) uploadSessions.remove(s.id);
    }
  }
  await srv.close();
});

/* ================================================================== *
 * R9-05 · `/s/:id/pay/status` 必须接入按 IP 的网关查单预算
 * ================================================================== */

/**
 * 报告 §2 的 R9-05：`/pay/status` 只受**订单级**节流（3 秒一次）约束，
 * 没有按 IP 的总量上限 —— 持票据者造多个订单再逐个轮询，可达约 66 倍于
 * `payCheckLimiter` 的预算，每次都是一次携带真实商户凭据的 `queryCharge`。
 *
 * 本用例直接断言「预算存在 + 阈值合理 + 参数化行为正确」：
 *  - 复用 `payCheckLimiter` 会打断正常的 3 秒轮询（60/10 分钟）→ 必须更宽松；
 *  - 完全不限流则 R8-20 的防护在这条入口上失效 → 必须有硬上限。
 */
test('R9-05 · 必须存在独立的「按 IP 轮询查单预算」：比手动查单宽松，但有硬上限', async () => {
  const limiter = security.payStatusLimiter;
  assert(typeof limiter === 'function',
    'R9-05：security 必须导出 payStatusLimiter —— /pay/status 需要按 IP 的查单预算');

  // 用同一个 key 连续打满，量出阈值
  let allowed = 0;
  for (let i = 0; i < 5000; i++) {
    const r = limiter('r9-05-probe');
    if (!r.ok) break;
    allowed += 1;
  }
  assert(allowed >= 60,
    `R9-05：预算必须**宽松于** payCheckLimiter 的 60/10 分钟（实际 ${allowed}）——`
    + '直接复用 60 会打断正常的 3 秒轮询，让合法支付流程失败');
  assert(allowed <= 1000,
    `R9-05：预算必须有硬上限（实际 ${allowed}）—— 无上限则 R8-20 想防的`
    + '「刷光网关查单配额」在这条入口上不成立');
  assert(allowed > 200,
    `R10-09：预算必须**严格大于** 3 秒轮询在窗口内的请求数（10 分钟 = 200 次，实际 ${allowed}）——`
    + '恰好等于 200 是零余量：正常轮询就会把预算用光，之后页面再也无法主动推进状态');

  // 另一个 IP 不受影响（按 IP 隔离，不是全局闸门）
  const other = limiter('r9-05-other');
  assertEqual(other.ok, true, 'R9-05：预算必须按 IP 隔离，不得退化成全局闸门');
});

test('R9-05 · /s/:id/pay/status 必须真的被按 IP 预算闸门约束（打在路由入口上）', async () => {
  /**
   * 上一条用例只验证「限流器存在且阈值合理」—— 那是**只守函数、不守调用点**，
   * 正是第 9 轮 §4 点名的「半真护栏」：把 `share-routes.js` 里那一行接线删掉，
   * 上一条用例照样全绿。
   *
   * 这里改为打在**真实路由**上：真实 `share-routes` 路由 + 真实支付订单 + 真实订单票据
   * （`orderToken()` 产的 cookie），用一个「按 key 计数」的假预算替身，
   * 断言「路由确实按压了它、且确实按压过它」。
   */
  const express = require(path.join(ROOT, 'node_modules', 'express'));
  const shareRoutes = require(path.join(ROOT, 'server', 'share-routes.js'));
  const paymentOrders = require(path.join(ROOT, 'server', 'payment-orders.js'));
  const paymentGateway = require(path.join(ROOT, 'server', 'payment-gateway.js'));

  const link = await shareStore.create({
    key: 'r9-05/pay.bin', bucket: BASE_CFG.bucket, region: BASE_CFG.region,
    fileName: 'pay.bin', size: 10, expiresHours: 0, maxDownloads: 0,
    password: null, paid: { amountFen: 100, currency: 'CNY', channel: 'wechat' },
    createdBy: 'tester',
  });
  /**
   * 造**两个**订单：R10-09 起「被订单级节流拦下的轮询不再消耗 IP 预算」，
   * 因此同一个订单连问两次只会有一次真正去查单（那正是预算该被扣的那次）。
   * 要复现"预算被刷光"必须让两次轮询都真的会查单 —— 而这恰好就是 R9-05 要防的
   * 真实攻击形态：**造多个订单再逐个轮询**，把网关查单预算放大。
   */
  const orderA = paymentOrders.create({
    linkId: link.id, platform: 'wechat', amountFen: 100, currency: 'CNY',
  });
  const orderB = paymentOrders.create({
    linkId: link.id, platform: 'wechat', amountFen: 100, currency: 'CNY',
  });
  assertEqual(orderA.status, 'pending', '前置：订单应为待支付状态');
  assertEqual(orderA.platform, 'wechat',
    '前置：只有 platform=wechat 的待支付订单才会走「轮询时主动查单」这条分支');

  // 假预算：记录每次按压，第一次放行、之后一律拒绝（模拟「预算被刷光」）
  const probes = [];
  const realLimiter = security.payStatusLimiter;
  security.payStatusLimiter = (key) => {
    probes.push(key);
    return { ok: probes.length <= 1, remaining: Math.max(0, 1 - probes.length) };
  };
  // 假网关：计数每次真实查单（若闸门失效，第二轮会再打一次）
  let queries = 0;
  const realQuery = paymentGateway.queryCharge;
  paymentGateway.queryCharge = async () => { queries += 1; return { paid: false, status: 'pending' }; };

  const app = express();
  app.use((req, _res, next) => { req.authUser = { id: 'u1', username: 'admin', role: 'admin' }; next(); });
  // 挂载点必须与产品一致：`server/index.js` 是 `app.use('/', shareRoutes)` ——
  // 路由内部自身带 `/s/...` 前缀，挂到 `/s` 会变成 `/s/s/...`（本用例曾因此 404）。
  app.use('/', shareRoutes);
  const server = http.createServer(app);
  openServers.push(server);
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

  try {
    const r1 = await request(port, 'GET', `/s/${link.id}/pay/status`, {
      headers: { Cookie: `sp_${link.id}_pay=${paymentOrders.orderToken(orderA)}` },
    });
    const r2 = await request(port, 'GET', `/s/${link.id}/pay/status`, {
      headers: { Cookie: `sp_${link.id}_pay=${paymentOrders.orderToken(orderB)}` },
    });
    assertEqual(r1.status, 200, '前置：第一次轮询应正常返回');
    assertEqual(r2.status, 200, '前置：被预算拦下时也必须静默返回当前状态（不打断 UX）');

    assert(probes.length >= 2,
      'R9-05：路由必须真的调用按 IP 预算 —— 实际只按压了 ' + probes.length
      + ' 次（把 share-routes.js 里那行接线删掉时本条会变红）');
    assert(queries <= 1,
      `R9-05：预算被刷光后**不得**再向网关发起查单（实际 ${queries} 次）—— `
      + '否则 R8-20 想防的「刷光网关配额」在这条入口上不成立');

    /**
     * R10-09 · 补上「只在真的要查单时才扣预算」这一半的断言。
     *
     * 上面的两条只守住了「闸门存在 + 阈值合理」，R10-09 的另一半（被**订单级**
     * 节流拦下的轮询一次网关请求都没发，因此**不该**消耗按 IP 预算）此前没有断言：
     * 把 `statusQueryDue(order) && payStatusLimiter(ip).ok` 的顺序对调，短路顺序
     * 反了、限流器被无条件按压，旧用例照样全绿（第 11 轮 R11-17 实测）。
     *
     * 这里用**同一个订单 A 再问一次**：它刚查过单，订单级节流必然命中 →
     * 预算按压次数必须**一次都不增加**。
     */
    const probesBefore = probes.length;
    const r3 = await request(port, 'GET', `/s/${link.id}/pay/status`, {
      headers: { Cookie: `sp_${link.id}_pay=${paymentOrders.orderToken(orderA)}` },
    });
    assertEqual(r3.status, 200, '前置：被订单级节流拦下的轮询同样静默返回当前状态');
    assertEqual(probes.length, probesBefore,
      'R10-09：被订单级节流拦下的轮询**不得**消耗按 IP 查单预算 —— 它一次网关请求都没发，'
      + `实际却多按了 ${probes.length - probesBefore} 次。把 share-routes.js 里 `
      + '「statusQueryDue(order) && security.payStatusLimiter(ip).ok」的顺序对调即变红');
    assertEqual(queries, 1,
      'R11-17 正向对照：整轮三次轮询只有第一次真的发起了查单（另两次分别被预算与订单节流拦下）');
  } finally {
    security.payStatusLimiter = realLimiter;
    paymentGateway.queryCharge = realQuery;
    try { if (typeof server.closeAllConnections === 'function') server.closeAllConnections(); } catch (e) { /* ignore */ }
    await new Promise((r) => server.close(() => r()));
  }
});

/* ================================================================== *
 * R9-09 · magic 加密上限必须下沉到 encryptBuffer
 * ================================================================== */

/**
 * 报告 §4 的元结论：`R8-02` 只削掉了「分片」这一个面 —— 直传（`/fs/upload/simple`，
 * `express.raw` 上限 64MB）与 WebDAV PUT（全量缓冲后同步加密）两条路径没有约束，
 * 都能让 magic 同步阻塞事件循环数秒。
 *
 * 本用例的断言打在 `encryptBuffer` **自身**（而不是某个路由）——
 * 这正是修复的方向：「按模式拒绝超限输入」是加密入口的契约，而不是逐个调用点各写一次。
 */
test('R9-09 · encryptBuffer 必须拒绝超过上限的 magic 输入（并提示改用分片）', async () => {
  // 走**真实的设置接口**（而不是打桩 currentMode）—— `encryptBuffer` 内部自己
  // `loadSettings()` 取模式，打桩 currentMode 对它是无效的（这正是本用例要防的
  // 「函数与调用点脱节」）。`updateSettings` 会同步落盘到 TMP 下的设置文件。
  await encStore.updateSettings({ mode: 'magic' });

  const over = Buffer.alloc(LIMITS.MAGIC_SYNC_MAX + 1, 0x00);
  let threw = null;
  try {
    encStore.encryptBuffer(BASE_CFG.bucket, 'r9-09/too-big.bin', over);
  } catch (e) { threw = e; }
  assert(threw,
    `R9-09：magic 模式下 ${over.length} 字节的输入必须被拒绝 —— 直传 / WebDAV PUT `
    + '两条入口都没有分片上限，超过后同步阻塞事件循环数秒');
  assertEqual(threw.status, 413, 'R9-09：应以 413 明确表达「文件过大」');
  assert(/分片/.test(threw.message),
    'R9-09：错误文案必须给出可行出路（改用分片上传）');

  // 恰好等于上限 → 必须放行（上限是 inclusive 的）
  const atLimit = Buffer.alloc(LIMITS.MAGIC_SYNC_MAX, 0x01);
  const ok = encStore.encryptBuffer(BASE_CFG.bucket, 'r9-09/at-limit.bin', atLimit);
  assert(ok && ok.data && ok.meta, 'R9-09：恰好等于上限的输入必须正常加密');

  // crypto 模式不受该上限约束（AES-GCM 分片是流式的、快得多）
  await encStore.updateSettings({ mode: 'crypto' });
  const big = Buffer.alloc(LIMITS.MAGIC_SYNC_MAX + 1, 0x02);
  const c = encStore.encryptBuffer(BASE_CFG.bucket, 'r9-09/crypto-big.bin', big);
  assert(c && c.meta && c.meta.mode === 'crypto',
    'R9-09：该上限只针对 magic；crypto 模式的单次加密不应被它拦住');

  // 复位，避免影响后续用例
  await encStore.updateSettings({ mode: 'none' });
});

/* ================================================================== *
 * R9-08 / R10-01 · 退出路径「只写不建」；异步路径「必须建且必须落盘」
 * ------------------------------------------------------------------ *
 * 第 10 轮报告 §5.1 点名本文件原来的两条护栏**都是假的**，这里整体重做：
 *
 *  ① 旧护栏是源码扫描：只在 `process.on('exit')` 的**处理器体**里找 `mkdirSync`，
 *     而实现里 `mkdirSync` 在 `persistNowSync()` 内部 —— 把修复完全退回旧实现，
 *     那条扫描依然全绿（白名单正则还过宽地豁免了任何含 "cleaned" 的标识符）。
 *     → 改为**直接驱动真实退出路径** `flushSync()` 的行为断言。
 *  ② 旧护栏「泄漏计数可用」只验证 `countTempDirs` 自增自减，与"跑完不泄漏"无关。
 *     → 改为「清理跑完 + 真实退出路径再跑一次之后，该前缀下一个目录都不剩」。
 *
 * 同时把 R10-01 的另一半钉住：异步路径（`flush()`）**必须**建目录并落盘 ——
 * 「退出路径不建目录」这条约束一旦被误加到异步路径上，分片会话就再也不落盘了，
 * 而那正是 R10-01 的形态（强杀即丢全部分片加密元数据）。
 *
 * 报告 §2 的 R9-08 本体：R8-26 修正了清理顺序，但临时目录**仍在泄漏** ——
 * `process.on('exit')` 钩子在 `test.after` 的 `rmSync` **之后**执行 `persistNowSync()`
 * → `mkdirSync` 把目录整份重建。
 * ================================================================== */

test('R9-08 · 数据目录被删除后，真实退出路径 flushSync() 不得把它重建回来', async () => {
  const uploadSessions = require(path.join(ROOT, 'server', 'upload-sessions.js'));
  const secureStore = require(path.join(ROOT, 'server', 'secure-store.js'));

  // 前置：让 sessions 处于**已初始化**状态 —— sessions 为 null 时 flushSync() 直接
  // return，下面的断言会**恒真**（这正是被点名的假护栏形态：守了个空气）。
  uploadSessions.get('__r9_08_probe__');
  assert(fs.existsSync(TMP), '前置：TMP 应当存在（本文件尚未到收尾阶段）');

  // 正向对照：目录存在时退出路径**必须真的落盘** ——
  // 防止有人把 flushSync 改成空操作来"通过"下一条断言。
  uploadSessions.flushSync();
  await secureStore.flush();
  assert(fs.existsSync(path.join(TMP, 'upload-sessions.json')),
    'R9-08 正向对照：目录存在时退出路径必须落盘 —— 否则「不重建」会被空操作蒙混过去');

  // 真正要守的行为：删掉目录后，退出路径不得 mkdir 把它整份复活
  fs.rmSync(TMP, { recursive: true, force: true });
  assert(!fs.existsSync(TMP), '前置：TMP 已删除');
  uploadSessions.flushSync();

  assert(!fs.existsSync(TMP),
    'R9-08 / R10-01：退出路径必须「只写不建」—— 旧实现无条件 mkdirSync，'
    + '把 test.after 刚删掉的目录整份复活（现场 11 个泄漏目录的成因）');

  // 复原，后续用例仍依赖 TMP
  fs.mkdirSync(TMP, { recursive: true });
});

test('R10-01 · 异步落盘路径 flush() 必须建目录并真的写盘（去抖之外的落盘不能是空操作）', async () => {
  const uploadSessions = require(path.join(ROOT, 'server', 'upload-sessions.js'));
  const secureStore = require(path.join(ROOT, 'server', 'secure-store.js'));

  uploadSessions.get('__r10_01_probe__'); // 同上：确保 sessions 已初始化
  fs.rmSync(TMP, { recursive: true, force: true });
  assert(!fs.existsSync(TMP), '前置：TMP 已删除');

  uploadSessions.flush(); // 异步路径：去抖窗口外 / 优雅停机走的就是它
  await secureStore.flush(); // 等写队列排空

  assert(fs.existsSync(TMP),
    'R10-01：异步落盘路径必须创建数据目录 —— 否则进程存活期间一个字节都不写');
  assert(fs.existsSync(path.join(TMP, 'upload-sessions.json')),
    'R10-01：flush() 之后必须真的落盘 —— 旧实现 persistNow() 读取未声明的 `cleaned` '
    + '抛 ReferenceError、又被空 catch 吞掉，整条异步落盘恒为静默空操作');
});

test('R9-08 · 清理之后必须一个目录都不剩（countTempDirs 按本次前缀归零）', async () => {
  const helpers = require(path.join(ROOT, 'tests', 'helpers.js'));
  const uploadSessions = require(path.join(ROOT, 'server', 'upload-sessions.js'));
  const prefix = 'cos-audit9-leakprobe-';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  assertEqual(helpers.countTempDirs(prefix), 1, '前置：该前缀下应有 1 个目录');

  const r = await cleanupTempDir(dir, { label: 'r9-08-leak' });
  assertEqual(r.removed, true, 'R9-08：前置 —— 目录应被成功删除');

  // 关键：再跑一次**真实退出路径**，确认它不会把刚删掉的东西写回来。
  // 旧护栏只验「计数器能加减」，与"跑完不泄漏"毫无关系。
  uploadSessions.flushSync();
  assertEqual(helpers.countTempDirs(prefix), 0,
    'R9-08：清理 + 退出路径跑过之后，该前缀下必须一个目录都不剩 —— '
    + '"计数器能自增自减"不等于"跑完不泄漏"');
});

/* ================================================================== *
 * 收尾
 * ------------------------------------------------------------------ *
 * R9-08：这里刻意**最后**清理，且清理后立刻封住退出钩子
 * （cleanupTempDir 内部会置标记）。
 * ------------------------------------------------------------------ */

test.after(async () => {
  try { if (davServer) await davServer.close(); } catch (e) { /* ignore */ }
  for (const s of openServers) {
    try { if (typeof s.closeAllConnections === 'function') s.closeAllConnections(); s.close(); } catch (e) { /* ignore */ }
  }
  try {
    await require(path.join(ROOT, 'server', 'secure-store.js')).flush();
  } catch (e) { /* ignore */ }
  // R9-08：flushers 必须是 `{name, flush}` 形状 —— 传裸函数会静默失败（告警里会出现
  // "f.flush is not a function"，而刷干没做就等于把去抖数据写回已删目录）。
  try {
    const uploadSessions = require(path.join(ROOT, 'server', 'upload-sessions.js'));
    const statsStoreMod = require(path.join(ROOT, 'server', 'stats-store.js'));
    const secureStore = require(path.join(ROOT, 'server', 'secure-store.js'));
    await cleanupTempDir(TMP, {
      label: 'audit9-regressions',
      flushers: [
        { name: 'upload-sessions', flush: () => uploadSessions.flushSync() },
        { name: 'stats-store', flush: () => statsStoreMod.flushStatsSync() },
        { name: 'secure-store', flush: () => secureStore.flush() },
      ],
    });
  } catch (e) { /* ignore */ }
});
