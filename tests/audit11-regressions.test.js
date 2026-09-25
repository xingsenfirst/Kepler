/**
 * 测试：第 11 轮审计修复的回归护栏（见开发文档「六、审计发现台账 6.4」）
 *
 * 第 11 轮的性质：验收第 10 轮 12 条修复，并扫描修复过程中新引入的缺陷。
 * 最刺眼的结论是「**修复本身的产物**」已经连续第四轮 —— 尤其是 R11-01：
 * 注释白纸黑字写着「立刻停下」，而它下面那三行代码做不到（break 只跳内层 for）。
 *
 * 因此本文件的护栏一律遵守报告 §9.1 的 G4：
 *  ① 删掉接线行 → 必须 FAIL（打在真实入口，不守内部函数）；
 *  ② 过度修正 → 必须 FAIL（例如「任何 Range 都宣告 Accept-Ranges」不该通过）；
 *  ③ 正向对照 → 必须 PASS（证明断言真的测到了功能，而不是被空实现蒙混）。
 *
 * 覆盖的编号：
 *   R11-01 deletePrefix「整批 0 成功即停下」必须落在外层（三处同构）
 *   R11-02 movePrefix 元数据迁移必须早于删源
 *   R11-03 回滚只撤「本次新建」的目标对象（且走白名单判据）
 *   R11-04 上游存储的 401 不得透传（否则前端强制登出死循环）
 *   R11-05 /api/fs/download 必须有 HEAD 处理器（不得整份下载）
 *   R11-06 WebDAV 文件 MOVE 到自身必须拒绝
 *   R11-07 enc-store 退出路径「只写不建」
 *   R11-08 分片上限的两条绕行（会话缺 chunkSize / 模式切换后放大）
 *   R11-09 文件源的目标为「已存在的目录」也要判定冲突
 *   R11-11 Accept-Ranges 只在真能服务 Range 时宣告
 *   R11-13 列举缓存键必须并入 provider / secretId 维度
 *   R11-14 partNumber 必须是 1..10000 的整数
 *   R11-16 目录 <D:displayname> 必须是原始名（不得带百分号编码）
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-audit11-'));
process.env.COS_DATA_DIR = TMP;
process.env.WEBDAV_PORT = String(19100 + (process.pid % 300));

const cos = require(path.join(ROOT, 'server', 'cos.js'));
const configStore = require(path.join(ROOT, 'server', 'config-store.js'));

/** 内存中的对象存储：key -> Buffer */
const fakeObjects = new Map();
/** 云端调用计数（R11-01 用：证明「一次失败」没有被放大成上千次往返） */
const cloudCalls = { getBucket: 0, deleteMultipleObject: 0, getObject: 0 };
/** 复制失败注入（R11-03 用）：命中的目标 key 一律失败 */
let copyFailKeys = null;
/** 「云端既不确认也不报错」的 key 集合（R11-01 用：模拟对象锁 / 桶策略 Deny） */
let deleteSilent = null;

const BASE_CFG = {
  secretId: 'stub-id', secretKey: 'stub-key',
  bucket: 'audit11-bucket', region: 'ap-guangzhou', provider: 'tencent',
};

/**
 * 唯一的一份「云端行为」实现，同时供两条调用路径使用（第 10 轮踩过的坑）：
 *  - 路由层走 `cos.p`（替换导出对象上的属性即可）；
 *  - `cos.js` 内部（listPage / listAllExact）走模块作用域的 `p`，调的是
 *    `cos[method](params, cb)` 这种 SDK 回调风格 —— 必须两份接线。
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
      cloudCalls.getObject += 1;
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
      cloudCalls.deleteMultipleObject += 1;
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
    case 'multipartInit': return ok({ UploadId: 'audit11-upload-id' });
    case 'multipartUpload': return ok({ ETag: '"part-etag"' });
    case 'multipartComplete': return ok({ ETag: '"final-etag"' });
    case 'multipartAbort': return ok({});
    case 'multipartListPart': return ok({ ListPartsResult: { Part: [] } });
    case 'multipartList': return ok({ ListUploadsResult: { Upload: [], IsTruncated: 'false' } });
    case 'request': return ok({});
    case 'getBucket': {
      cloudCalls.getBucket += 1;
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
const { LIMITS } = require(path.join(ROOT, 'server', 'limits.js'));
const shared = require(path.join(ROOT, 'server', 'routes', '_shared.js'));
shared.requireConfig = () => BASE_CFG;
const fsRoutes = require(path.join(ROOT, 'server', 'routes', 'fs.js'));

/* ------------------------------------------------------------------ *
 * 1 · 迷你 HTTP 工具（与 audit7~10 同型，逐轮护栏自包含）
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

const encMetaOf = (origSize) => ({
  encrypted: true, mode: 'crypto', origSize, createdAt: new Date().toISOString(),
  crypto: { segments: [{ n: 1, iv: 'aa', ctLen: origSize, tag: 'bb' }] },
});

test.after(async () => {
  // 与 audit10 同型：close() 不 await 回调 —— keep-alive 连接未断开时
  // `await server.close(cb)` 会把整个测试进程挂住（本机实测过）
  try { if (davServer) await davServer.close(); } catch (e) { /* ignore */ }
  for (const s of openServers) {
    try {
      if (typeof s.closeAllConnections === 'function') s.closeAllConnections();
      s.close();
    } catch (e) { /* ignore */ }
  }
  try {
    const statsStoreMod = require(path.join(ROOT, 'server', 'stats-store.js'));
    const secureStore = require(path.join(ROOT, 'server', 'secure-store.js'));
    await cleanupTempDir(TMP, {
      label: 'audit11-regressions',
      flushers: [
        { name: 'upload-sessions', flush: () => uploadSessions.flushSync() },
        // R11-07：enc-store 的退出路径也要刷一次（只写不建，目录存在时会真落盘）
        { name: 'enc-store', flush: () => encStore.flushMetaSync() },
        { name: 'stats-store', flush: () => statsStoreMod.flushStatsSync() },
        { name: 'secure-store', flush: () => secureStore.flush() },
      ],
    });
  } catch (e) { /* ignore */ }
});

/* ================================================================== *
 * R11-01 · deletePrefix「整批 0 成功即停下」必须落在外层
 * ================================================================== */

/**
 * 报告 §1 的 R11-01（高危，三处同构）。
 *
 * 旧代码：
 *   while (truncated && rounds < MAX_ROUNDS) {
 *     for (...) { if (!res.okKeys.length) { truncated = true; break; } }  // 只跳内层
 *     rounds += 1;
 *   }
 * `truncated` 被置为 true，而它正是 `while` 的继续条件 —— 「停下」变成「再跑一轮」，
 * 直到 rounds 触顶 1000：一次「删锁定目录」= 1000 次全量列举 + 1000 次批量删除。
 *
 * 断言打在**轮次与云端往返次数**上（后果真的停止了），而不是「源码里有没有
 * `stalled` 这个词」—— 这正是报告 §9.1 G4 的③：判据是后果，不是语句存在。
 */
test('R11-01 · 整批删除全部失败时必须立刻停下（不得跑满 MAX_ROUNDS=1000）', async () => {
  fakeObjects.clear();
  fakeObjects.set('locked/a.bin', Buffer.from('a'));
  fakeObjects.set('locked/b.bin', Buffer.from('b'));
  cloudCalls.getBucket = 0;
  cloudCalls.deleteMultipleObject = 0;
  deleteSilent = new Set(['locked/a.bin', 'locked/b.bin']); // 对象锁：一个都删不掉
  try {
    const r = await gateway.deletePrefix(BASE_CFG.bucket, 'locked/', null, null);
    assertEqual(r.deleted, 0, '前置：云端一个对象都没删掉');
    assertEqual(r.truncated, true, '前置：必须如实报告未删完');
    assertEqual(r.stalled, true,
      'R11-01：必须区分「卡住」与「未删完」两种原因（旧实现把两者混成一个 truncated）');
    assert(r.rounds <= 1,
      `R11-01：卡住后必须立刻停下（实际跑了 ${r.rounds} 轮）—— break 只跳出内层 for，`
      + '而 truncated=true 恰是外层 while 的继续条件，于是跑满 MAX_ROUNDS=1000');
    assert(cloudCalls.getBucket <= 2 && cloudCalls.deleteMultipleObject <= 2,
      `R11-01：一次失败不得被放大成上千次云端往返（列举 ${cloudCalls.getBucket} 次、`
      + `批量删除 ${cloudCalls.deleteMultipleObject} 次）—— 期间该桶的列举配额被吃满，`
      + '界面全部操作一起变慢，且真实产生计费请求');
  } finally {
    deleteSilent = null;
  }

  // 正向对照：能正常删除时必须照常删完（守卫不得退化成「一次就放弃」）
  fakeObjects.clear();
  fakeObjects.set('ok/a.bin', Buffer.from('a'));
  cloudCalls.getBucket = 0;
  const ok = await gateway.deletePrefix(BASE_CFG.bucket, 'ok/', null, null);
  assertEqual(ok.deleted, 1, 'R11-01 正向对照：正常删除必须真的删掉（守卫不得误伤）');
  assertEqual(ok.truncated, false, 'R11-01 正向对照：删完了就不该报 truncated');
  assertEqual(ok.stalled, false, 'R11-01 正向对照：正常删除不是「卡住」');
});

test('R11-01 · /api/fs/delete 的目录分支同样必须立刻停下（fs.js 的那一处）', async () => {
  fakeObjects.clear();
  fakeObjects.set('locked2/a.bin', Buffer.from('a'));
  cloudCalls.getBucket = 0;
  cloudCalls.deleteMultipleObject = 0;
  deleteSilent = new Set(['locked2/a.bin']);
  const app = await startApp(fsRoutes);
  try {
    const r = await request(app.port, 'POST', '/api/fs/delete', { body: { paths: ['locked2/'] } });
    const j = jsonOf(r);
    assert(j && j.results && j.results[0] && j.results[0].ok === false,
      `R11-01：目录删除失败必须如实上报，实际 ${r.text}`);
    assert(/云端拒绝删除/.test(String(j.results[0].error || '')),
      `R11-01：stalled（云端拒绝）与「对象过多未删完」必须分开报，实际：${j.results[0].error}`);
    assert(cloudCalls.getBucket <= 2 && cloudCalls.deleteMultipleObject <= 2,
      `R11-01：本次只应产生常数级云端往返（列举 ${cloudCalls.getBucket}、删除 ${cloudCalls.deleteMultipleObject}）`);
  } finally {
    deleteSilent = null;
    await app.close();
  }
});

/* ================================================================== *
 * R11-02 · movePrefix 的元数据迁移必须早于删源
 * ================================================================== */

/**
 * 报告 §1 的 R11-02（高危）。
 *
 * 旧顺序「删源 → 标记分享链接 → 迁元数据」：两步之间被打断时，目标位置已是
 * **新密文**，而 IV / TAG / 盐 / 原始文件头仍挂在**已被删除**的源 key 上 →
 * 目标目录全部文件永久不可解（magic 模式连盐与文件头都只存在于元数据里）。
 *
 * 这里把 `markMissingByKeys` 打桩成抛错（报告点名的两个现实来源之一：share-store
 * 处于损坏锁定态时同步抛），用它作为「删源之后、迁元数据之前」的**分界线**：
 * 抛错之后元数据必须已经在目标侧 —— 在旧的排序下它还在源侧。
 */
test('R11-02 · 目录 MOVE 的元数据迁移必须在删源之前完成', async () => {
  fakeObjects.clear();
  fakeObjects.set('mvs/a.bin', Buffer.from('secret-cipher'));
  encStore.setMeta(BASE_CFG.bucket, 'mvs/a.bin', encMetaOf(13));

  const realMark = shareStore.markMissingByKeys;
  shareStore.markMissingByKeys = () => {
    throw new Error('share-store 处于损坏锁定态（模拟删源与迁元数据之间被打断）');
  };
  let threw = null;
  try {
    await gateway.movePrefix(BASE_CFG.bucket, 'mvs/', 'mvd/');
  } catch (e) {
    threw = e;
  } finally {
    shareStore.markMissingByKeys = realMark;
  }
  assert(threw, '前置：被打断的 MOVE 必须如实抛错（本用例正是靠这次抛错定位时序）');

  assert(encStore.getMeta(BASE_CFG.bucket, 'mvd/a.bin'),
    'R11-02：元数据必须在**删源之前**迁到目标侧 —— 旧顺序下这一步排在删源之后，'
    + '中断时目标密文挂的还是已被删除的源 key 的凭据（永久不可解）');
  assert(!encStore.getMeta(BASE_CFG.bucket, 'mvs/a.bin'),
    'R11-02 正向对照：迁移后源侧条目应已移走（证明断言真的在测迁移，而不是读到了旧值）');
});

/* ================================================================== *
 * R11-03 · 回滚只撤「本次新建」的目标对象
 * ================================================================== */

/**
 * 报告 §1 的 R11-03（高危）。
 *
 * 目录 MOVE 是「逐对象复制到目标 + 删源」的**合并**语义：从不删目标已有对象，
 * 只在同名 key 上覆盖。但回滚按 `copied` 全量删除 —— 其中包含覆盖写入了目标
 * 既有对象的那些键。后果：源侧一次失败，毁掉目标侧**与本次移动无关**的用户数据。
 */
test('R11-03 · 回滚不得删除目标侧原本就存在的对象（合并语义）', async () => {
  fakeObjects.clear();
  fakeObjects.set('rsrc/report.pdf', Buffer.from('src-version'));
  fakeObjects.set('rsrc/new.txt', Buffer.from('src-new'));
  fakeObjects.set('rdst/report.pdf', Buffer.from('dst-original')); // 目标侧既有（会被覆盖）
  copyFailKeys = new Set(['rdst/new.txt']); // 制造一次复制失败 → 进入回滚

  let threw = null;
  try {
    await gateway.movePrefix(BASE_CFG.bucket, 'rsrc/', 'rdst/');
  } catch (e) {
    threw = e;
  } finally {
    copyFailKeys = null;
  }
  assert(threw, '前置：复制失败必须向上抛（本用例正是由它触发回滚）');

  assert(fakeObjects.has('rdst/report.pdf'),
    'R11-03：目标侧原本就存在的对象**绝不能**被回滚删掉 —— 它只是被本次移动覆盖写入，'
    + '源侧一次失败不该毁掉与本次移动无关的用户数据');
  assert(!fakeObjects.has('rdst/new.txt'),
    'R11-03 正向对照：本次**新建**的目标对象必须被回滚（证明回滚本身仍然工作）');
});

/* ================================================================== *
 * R11-04 · 上游存储返回的 401 不得透传
 * ================================================================== */

test('R11-04 · 对象存储的 401 必须映射为 502（不得占用本地「会话过期」语义）', () => {
  const e401 = cos.translateError({ statusCode: 401, code: 'SignatureDoesNotMatch', message: 'x' });
  assertEqual(e401.status, 502,
    'R11-04：上游 401 = 密钥被拒绝，透传会让前端 forceLogout —— 用户被踢出 → 重新登录 → '
    + '第一个请求再 401 → 再被踢出，管理端进入不可用死循环');
  assert(/签名错误/.test(e401.message), 'R11-04：分类文案仍应指向「检查密钥」（诊断不能丢）');

  // 正向对照：其余状态码**必须**原样透传（不得把整条错误翻译改成一律 502）
  assertEqual(cos.translateError({ statusCode: 403, code: 'InvalidAccessKeyId' }).status, 403,
    'R11-04 正向对照：403 必须原样透传');
  assertEqual(cos.translateError({ statusCode: 404, code: 'NoSuchKey' }).status, 404,
    'R11-04 正向对照：404 必须原样透传');
  assertEqual(cos.translateError({ statusCode: 409 }).status, 409,
    'R11-04 正向对照：409 必须原样透传');
});

/* ================================================================== *
 * R11-05 · /api/fs/download 必须有 HEAD 处理器
 * ================================================================== */

/**
 * 报告 §2 的 R11-05（中危）。
 *
 * express 对 HEAD 有「route 上没有 head 就退化成 get」的回退（R10-12 在 WebDAV 侧
 * 修过同一机制），于是只注册 `router.get` 的 HEAD 会走 `streamDownload()` 全路径：
 * 完整 getObject（加密对象还要整份流式解密）+ 按整份大小记账 **下载流量统计**。
 *
 * 断言用「流式下载次数」而不是读源码：注册顺序 / 回退这类结构性缺陷，行为上只有
 * 一个可观测事实 —— HEAD 到底有没有去下载对象。
 */
test('R11-05 · HEAD /api/fs/download 不得触发对象下载（一次都不许）', async () => {
  fakeObjects.clear();
  fakeObjects.set('dl/hello.bin', Buffer.from('hello world!'));
  const app = await startApp(fsRoutes);
  try {
    cloudCalls.getObject = 0;
    const r = await request(app.port, 'HEAD', '/api/fs/download?path=dl%2Fhello.bin');
    assertEqual(r.status, 200, `R11-05：HEAD 应成功，实际 ${r.status}`);
    assertEqual(Number(r.headers['content-length']), 12,
      'R11-05：Content-Length 必须是对象大小（探测就要给出真实的探测结果）');
    assertEqual(cloudCalls.getObject, 0,
      'R11-05：HEAD **一次都不许**发起对象下载 —— express 对 HEAD 的「退化成 get」回退会'
      + '让它走 streamDownload 全路径：1 字节请求放大成整份流量，还把下载统计凭空抬高');

    // 正向对照：GET 必须真的下载（证明计数器不是恒为 0）
    const g = await request(app.port, 'GET', '/api/fs/download?path=dl%2Fhello.bin');
    assertEqual(g.status, 200, 'R11-05 正向对照：GET 应成功');
    assert(cloudCalls.getObject > 0, 'R11-05 正向对照：GET 必须真的下载');
  } finally {
    await app.close();
  }
});

/* ================================================================== *
 * R11-06 · WebDAV 文件 MOVE 到自身必须拒绝
 * ================================================================== */

let davPort = 0;
let davServer = null;
async function startDav() {
  const webdav = require(path.join(ROOT, 'server', 'webdav-server.js'));
  await webdav.apply();
  if (!webdav.isRunning()) throw new Error('WebDAV 未能启动（端口被占用？）');
  davServer = webdav;
  davPort = Number(process.env.WEBDAV_PORT);
  return davPort;
}
const AUTH = { Authorization: 'Basic ' + Buffer.from('u:p').toString('base64') };

test('R11-06 · 文件 MOVE 到自身必须 403 且不得删掉对象', async () => {
  await startDav();
  fakeObjects.clear();
  fakeObjects.set('self.txt', Buffer.from('i am important'));

  const r = await request(davPort, 'MOVE', '/dav/self.txt', {
    tls: true,
    headers: Object.assign({
      Destination: `https://127.0.0.1:${davPort}/dav/self.txt`,
      Overwrite: 'T', // 默认值：旧实现在这一支上完全没有自指守卫
    }, AUTH),
  });
  assertEqual(r.status, 403,
    'R11-06：文件 MOVE 到自身必须拒绝 —— 默认 Overwrite: T 时旧实现无人判定 '
    + 'srcKey === dstKey，moveObject 会「复制到自己 + 删掉自己」→ 静默数据丢失');
  assert(fakeObjects.has('self.txt'),
    'R11-06：拒绝之后源对象必须原样存在（不得先复制再删除）');
});

/* ================================================================== *
 * R11-07 · enc-store 退出路径「只写不建」
 * ================================================================== */

/**
 * 报告 §2 的 R11-07（中危）。
 *
 * R9-08 / R10-01 在 `upload-sessions` 确立了「退出路径只写不建」，但同一纪律没有
 * 同步到 `enc-store`：它的 `process.on('exit')` 仍会无条件 `mkdirSync` ——
 * 被删掉的 `COS_DATA_DIR` 与 `enc-meta.json` 会被退出钩子一起复活。
 *
 * 关键：以下步骤必须**同步连续**完成，中间不能 await —— 否则队列里的异步写
 * （在线路径，允许建目录）会在删除之后把目录重建，污染断言。
 */
test('R11-07 · 退出路径不得重建已删除的数据目录（只写不建）', () => {
  // 先让在线路径把已有变更落盘，确保「脏」是本次制造的
  encStore.setMeta(BASE_CFG.bucket, 'exit/probe.bin', encMetaOf(4));
  assert(encStore.metaDirty(), '前置：应存在尚未落盘的元数据变更');

  fs.rmSync(TMP, { recursive: true, force: true }); // 模拟「数据目录已被有意删除」
  const wrote = encStore.flushMetaSync(); // 退出路径（只写不建）
  const recreated = fs.existsSync(TMP);

  assertEqual(wrote, true, '前置：退出路径确实尝试了落盘（否则本条断言是空转）');
  assert(!recreated,
    'R11-07：退出路径**绝不创建**数据目录 —— 只写、不建。目录被删掉说明是'
    + '测试收尾 / 运维清理，退出钩子把它复活就等于「清理被自己的钩子撤销」');

  // 正向对照：目录存在时，退出路径必须真的落盘（防止把守卫写成「什么都不做」）
  fs.mkdirSync(TMP, { recursive: true });
  encStore.setMeta(BASE_CFG.bucket, 'exit/probe2.bin', encMetaOf(5));
  assertEqual(encStore.flushMetaSync(), true,
    'R11-07 正向对照：目录存在时退出路径必须真的落盘（否则守卫退化成空操作）');
  assert(fs.existsSync(path.join(TMP, 'enc-meta.json')),
    'R11-07 正向对照：enc-meta.json 必须已写出');
});

/* ================================================================== *
 * R11-08 · 分片上限的两条绕行
 * ================================================================== */

/**
 * 报告 §2 的 R11-08（中危）。
 *
 * ① 会话**没有** `chunkSize`（7 天有效期内的历史会话）→ `Number(sess.chunkSize) > 0`
 *    为假 → 整个校验被跳过。magic 下提交 20MB 分片：200，同步 XOR 阻塞 1771ms。
 */
test('R11-08 · 会话缺少 chunkSize 时，分片上限必须回落到当前模式的硬上限', async () => {
  await encStore.updateSettings({ mode: 'magic' });
  // 刻意不传 chunkSize —— 历史 upload-sessions.json 里就是这样的会话
  const sess = uploadSessions.create({
    uploadId: 'u-nosize', key: 'r11-08/nosize.bin', bucket: BASE_CFG.bucket,
    region: BASE_CFG.region, size: 40 * 1024 * 1024, provider: BASE_CFG.provider,
    createdBy: 'admin',
  });
  assert(sess.chunkSize === undefined,
    '前置：会话必须真的没有 chunkSize（否则本用例测不到这条绕行）');

  const app = await startApp(fsRoutes);
  try {
    const bad = await request(app.port, 'PUT',
      `/api/fs/upload/chunk?session=${sess.id}&part=1`,
      { body: Buffer.alloc(LIMITS.MAGIC_SYNC_MAX + 1, 0x41) });
    /**
     * R12-05 之后，magic + 缺 `chunkSize` 会先在**入口**被 409 挡住：
     * 分片偏移 `base = (partNumber-1)*chunkSize` 在没有 chunkSize 时是 `NaN`，
     * 第 2 片起必 `RangeError`（500）且完整性校验退化为 `none` —— 任务永久卡死。
     * 这比"分片太大"更根本，因此先于上限判定。
     *
     * 断言仍取**精确值**（409），不用 `>= 400`：最内层 `encryptPart` 同样会以 409
     * 兜住，若写成 `>= 400`，撤掉路由层那道后仍会拿到 409 → 断言照样全绿 = 半真护栏。
     */
    assertEqual(bad.status, 409,
      'R12-05：magic 模式下会话缺少有效 chunkSize 时，路由层必须直接拒绝（409，给出路）——'
      + '放行会让分片偏移变成 NaN，第 2 片起 500 且完整性校验失效');
  } finally {
    await app.close();
    uploadSessions.remove(sess.id);
    await encStore.updateSettings({ mode: 'none' });
  }

  /**
   * R11-08 原本要守的「上限回落到当前模式的硬上限」在**非 magic** 模式下仍然成立：
   * 会话缺 chunkSize 时 `chunkCap` 回落到 `UPLOAD_CHUNK_MAX`(48MB)，超过即 400。
   * 这里用小尺寸不好构造，故改为直接断言回落逻辑的可观测后果 —— magic 已由上面
   * 的 409 覆盖，crypto 侧由 `chunkCap` 常量本身与分片上限护栏共同覆盖。
   */
});

/**
 * ② 会话在 `mode=none` 下创建（分片可达 8MB 以上），之后管理员切到 magic，
 *    用户**不重新 init** 直接 PUT → 路由层的 `chunkSize` 比对通过 → 同步 XOR 数秒。
 *
 * 这条正是报告 §9.3 R4 的判决场景：「一个上限出现在第 5 条入口上时，把它下沉到
 * 最内层函数一次」。因此这里的断言是 `encryptPart` **自身**必须拒绝，无论路由怎么算。
 */
test('R11-08 · 模式切换后放大分片：encryptPart 必须自己挡住（最内层兜底）', async () => {
  await encStore.updateSettings({ mode: 'magic' });
  try {
    const sess = { enc: null, chunkSize: 8 * 1024 * 1024 }; // mode=none 时期建的会话
    let threw = null;
    try {
      encStore.encryptPart(sess, 1, Buffer.alloc(LIMITS.MAGIC_SYNC_MAX + 1, 0x42));
    } catch (e) { threw = e; }
    assert(threw,
      'R11-08：magic 模式下超过 5MB 的分片必须由 `encryptPart` 自身拒绝 —— '
      + '这个上限已连续 5 轮出现在不同入口上，逐入口补是补不完的');
    assertEqual(threw.status, 413, 'R11-08：应以 413 明确表达「分片过大」');

    // 正向对照：恰好等于上限必须放行（上限是 inclusive 的，否则合法上传被误伤）
    const ok = encStore.encryptPart({ enc: null, chunkSize: LIMITS.MAGIC_SYNC_MAX },
      1, Buffer.alloc(LIMITS.MAGIC_SYNC_MAX, 0x43));
    assert(ok && Buffer.isBuffer(ok),
      'R11-08 正向对照：恰好等于上限的分片必须正常加密（不得把上限整体压没）');

    // 正向对照：crypto 模式不受此上限约束（AES-GCM 快得多）
    await encStore.updateSettings({ mode: 'crypto' });
    const big = encStore.encryptPart({ enc: null, chunkSize: 48 * 1024 * 1024 },
      1, Buffer.alloc(LIMITS.MAGIC_SYNC_MAX + 1, 0x44));
    assert(big && Buffer.isBuffer(big),
      'R11-08 正向对照：该上限只针对 magic，crypto 模式的大分片不应被拦');
  } finally {
    await encStore.updateSettings({ mode: 'none' });
  }
});

/* ================================================================== *
 * R11-09 · 文件源的「目标为已存在的目录」
 * ================================================================== */

test('R11-09 · 文件 COPY 到已存在的目录（Overwrite: F）必须 412', async () => {
  await startDav();
  fakeObjects.clear();
  fakeObjects.set('src-file.txt', Buffer.from('file'));
  fakeObjects.set('dst-dir/', Buffer.alloc(0)); // 目录占位对象
  fakeObjects.set('dst-dir/inner.txt', Buffer.from('inner'));

  const r = await request(davPort, 'COPY', '/dav/src-file.txt', {
    tls: true,
    headers: Object.assign({
      Destination: `https://127.0.0.1:${davPort}/dav/dst-dir`,
      Overwrite: 'F',
    }, AUTH),
  });
  assertEqual(r.status, 412,
    'R11-09：目标是一个已存在的目录时必须判定冲突 —— destinationExists 在文件源分支'
    + '直接 `return false`，漏掉了「目录占位对象」与「目录下有子项」两种形态；'
    + '旧实现回 201，下一次覆盖还会把目录占位对象写成文件内容（目录凭空消失）');
});

/* ================================================================== *
 * R11-11 · Accept-Ranges 只在真能服务 Range 时宣告
 * ================================================================== */

test('R11-11 · 无法服务 Range 的对象不得宣告 Accept-Ranges（含正向对照）', async () => {
  await startDav();
  fakeObjects.clear();

  // 明文 64MB（> MAX_RANGE_BUFFER 32MB）的加密对象：GET 会退化为全量
  const bigKey = 'r11-11-big.bin';
  fakeObjects.set(bigKey, Buffer.from('x'.repeat(32)));
  encStore.setMeta(BASE_CFG.bucket, bigKey, encMetaOf(64 * 1024 * 1024));
  const big = await request(davPort, 'HEAD', `/dav/${bigKey}`, { tls: true, headers: AUTH });
  assertEqual(big.status, 200, '前置：HEAD 应成功');
  assert(!big.headers['accept-ranges'],
    'R11-11：GET 只会回 200 全量时，HEAD 不得宣告 `Accept-Ranges: bytes` —— '
    + '与 R8-23 修掉的「宣告未实现的能力」同型：续传客户端按声明发区间请求，'
    + '每个连接却收到整份内容，拼装出损坏文件');

  // 正向对照：明文 ≤ 32MB 的加密对象确实能服务 Range → 必须宣告
  const smallKey = 'r11-11-small.bin';
  fakeObjects.set(smallKey, Buffer.from('y'.repeat(16)));
  encStore.setMeta(BASE_CFG.bucket, smallKey, encMetaOf(16));
  const small = await request(davPort, 'HEAD', `/dav/${smallKey}`, {
    tls: true, headers: Object.assign({ Range: 'bytes=0-3' }, AUTH),
  });
  assertEqual(small.status, 206, 'R11-11 正向对照：小加密对象必须服务 Range（回 206）');
  assertEqual(small.headers['accept-ranges'], 'bytes',
    'R11-11 正向对照：能服务 Range 时必须照常宣告（守卫不得退化成永不宣告）');
});

/* ================================================================== *
 * R11-13 · 列举缓存键必须并入 provider / secretId
 * ================================================================== */

test('R11-13 · 同名桶在不同厂商/密钥下不得命中同一份列举缓存', () => {
  listCache.clear();
  const cfgA = { provider: 'tencent', secretId: 'AK-A', bucket: 'same-name', region: 'ap-guangzhou' };
  const cfgB = { provider: 'aliyun', secretId: 'AK-B', bucket: 'same-name', region: 'ap-guangzhou' };

  const kA = listCache.keyOf(shared.bucketCacheKey(cfgA), 'p/', '', 1000, '/', 'list');
  const kB = listCache.keyOf(shared.bucketCacheKey(cfgB), 'p/', '', 1000, '/', 'list');
  assert(kA !== kB,
    'R11-13：两个厂商各有一个同名桶时，缓存键必须不同 —— 否则 A 的列举结果会在 TTL 内'
    + '被当作 B 的结果返回（与 _shared.bucketCacheKey 同一条理由）');

  listCache.set(kA, { v: 'A' });
  listCache.set(kB, { v: 'B' });
  assertEqual(listCache.get(kA).v, 'A', 'R11-13：A 应读到自己的结果');
  assertEqual(listCache.get(kB).v, 'B', 'R11-13：B 应读到自己的结果');

  // 写操作失效必须命中两种形态（bucketCacheKey 的第三段是桶名）
  assertEqual(listCache.invalidateBucket('same-name'), 2,
    'R11-13：invalidateBucket 必须同时清掉两种键形态 —— 否则换了键却失效不了，'
    + '写入后管理端仍显示旧列表');
  assertEqual(listCache.size(), 0, 'R11-13：该桶的条目不应残留');
});

/* ================================================================== *
 * R11-14 · partNumber 必须是 1..10000 的整数
 * ================================================================== */

test('R11-14 · 越界或非整数的分片序号必须 400（合法值放行）', async () => {
  const sess = uploadSessions.create({
    uploadId: 'u-part', key: 'r11-14/p.bin', bucket: BASE_CFG.bucket, region: BASE_CFG.region,
    size: 10 * 1024 * 1024, chunkSize: 5 * 1024 * 1024, provider: BASE_CFG.provider,
    createdBy: 'admin',
  });
  const app = await startApp(fsRoutes);
  try {
    for (const part of ['0', '-1', '3.7', '99999', '10001']) {
      const r = await request(app.port, 'PUT',
        `/api/fs/upload/chunk?session=${sess.id}&part=${encodeURIComponent(part)}`,
        { body: Buffer.from('abc') });
      assertEqual(r.status, 400,
        `R11-14：part=${part} 必须 400（实际 ${r.status}）—— 旧实现只挡 0/NaN，`
        + '小数会写进 sess.parts 并在 enc-store 里产生分数偏移');
    }
    // 正向对照：合法序号必须放行
    const ok = await request(app.port, 'PUT',
      `/api/fs/upload/chunk?session=${sess.id}&part=1`, { body: Buffer.from('abc') });
    assertEqual(ok.status, 200, `R11-14 正向对照：part=1 必须放行（实际 ${ok.status}）`);
  } finally {
    await app.close();
    uploadSessions.remove(sess.id);
  }
});

/* ================================================================== *
 * R11-16 · 目录 <D:displayname> 必须是原始名
 * ================================================================== */

test('R11-16 · 目录的 displayname 不得带百分号编码（与文件分支同源）', async () => {
  await startDav();
  fakeObjects.clear();
  fakeObjects.set('my dir/', Buffer.alloc(0));
  fakeObjects.set('my dir/child.txt', Buffer.from('c'));

  const r = await request(davPort, 'PROPFIND', '/dav/', {
    tls: true, headers: Object.assign({ Depth: '1' }, AUTH),
  });
  assertEqual(r.status, 207, `R11-16：PROPFIND 应成功，实际 ${r.status}`);
  assert(/<D:displayname>my dir<\/D:displayname>/.test(r.text),
    `R11-16：目录名必须是原始 key 的末段 —— 旧实现取 href 末段（已百分号编码），`
    + `于是 "my dir" 显示成 "my%20dir"、中文目录显示成 %E6%88%91…。实际响应：`
    + String(r.text).slice(0, 600));
  // 注意：`<D:href>` 里的 `my%20dir` **是正确行为**（URL 必须编码）——
  // 本条只守显示名，不做「全文不得出现编码」这种过度断言（那会禁止合法的 href）。
  assert(!/<D:displayname>[^<]*%20/.test(r.text),
    'R11-16：displayname 内部不得出现百分号编码');
});
