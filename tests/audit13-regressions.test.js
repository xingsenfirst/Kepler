/**
 * 测试：第 13 轮审计修复的回归护栏（见开发文档「六、审计发现台账 6.4」）
 *
 * 第 13 轮是**验收轮**：它先复核第 12 轮宣称"已修"的条目，结论是
 * 「可以停止开新轮次」不成立 —— 依据的两条护栏各能被绕过。因此本轮的性质是
 * **把"看起来关上的门"重新撬开看一遍**，代码修复只占一半，另一半全在护栏本身。
 *
 * 覆盖的编号：
 *   R13-01 测试隔离必须"默认安全"（helpers 顶层兜底 COS_DATA_DIR，不靠用例自觉）
 *   R13-02 目录 COPY 失败回滚不得删「复制前就存在的目标对象」（fresh 过滤）
 *   R13-03 并发复制失败必须"先等 worker 落地再取快照"（stopped + allSettled，零孤儿）
 *   R13-04 Overwrite:F 必须在动手前整体拒绝（容器级 412 + 键级 fail-open 兜底）
 *   R13-05 moveObject 删源失败必须回滚本次新建的目标（且不得删复制前就有的目标）
 *
 * 每条都带**正向对照**（证明守卫没退化成"什么都不做"），并逐条登记进
 * `scripts/reverse-check.js` 的 CASES —— 撤销修复必须变红。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const test = require('node:test');
const { assert, assertEqual, ROOT, cleanupTempDir } = require('./helpers');

/* ------------------------------------------------------------------ *
 * 0 · 隔离与打桩（必须在 require 任何 server 模块之前）
 * ------------------------------------------------------------------ */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-audit13-'));
process.env.COS_DATA_DIR = TMP;
/**
 * 端口区间必须**与相邻轮次不相交**：`node --test` 默认按 CPU 数并发跑文件，
 * 两个文件同时启动 WebDAV 且 `pid % N` 撞到同一个端口时 `apply()` 会 EADDRINUSE
 * → `isRunning()` 为 false → 用例抛错（表现为偶发失败，极难归因）。
 * 既有区间：audit9 = 18800..19099、audit10 = 18900..19199、audit11 = 19100..19399、
 * audit12 = 19600..19799。本文件取 20400..20599，与四者均不相交。
 */
process.env.WEBDAV_PORT = String(20400 + (process.pid % 200));

const cos = require(path.join(ROOT, 'server', 'cos.js'));
const configStore = require(path.join(ROOT, 'server', 'config-store.js'));

/** 内存中的对象存储：key -> Buffer */
const fakeObjects = new Map();
/** 复制失败注入：命中的**目标** key 一律失败 */
let copyFailKeys = null;
/**
 * 给**成功**的复制注入延迟。它是 R13-03 的取样前提：没有它，12 个对象会被 5 路
 * worker 在同一微任务里全部取走并完成，`Promise.all` 拒绝时其实已经没有在飞的
 * 任务 —— 那时即便撤掉 `allSettled`，残留数仍是 0，护栏就成了空转。
 */
let copyDelayMs = 0;
/** 删除失败注入：命中 key 的 `deleteObject` 一律失败（R13-05 用） */
let deleteFailKeys = null;
/**
 * R13-04 的 fail-open 注入：命中前缀的 `listLevel`（`Delimiter: '/'` 的 getBucket）
 * 一律抛错 —— 复现 `destinationExists` 的"探测失败按不存在返回"。
 * 判据含 `Delimiter === '/'` 是刻意的：目标侧**预列举**（`listAllExact`）用的是
 * `Delimiter: ''`，不受影响，否则整个 COPY 会在动手前就失败，测不到兜底。
 */
let probeFailPrefix = null;
/** 云端复制尝试次数（R13-03 断言"失败后不再启动新任务"） */
const cloudCalls = { copyAttempts: 0 };
/** 捕获审计日志（R13-03 断言回滚日志不得谎报） */
const capturedLogs = [];

const BASE_CFG = {
  secretId: 'stub-id', secretKey: 'stub-key',
  bucket: 'audit13-bucket', region: 'ap-guangzhou', provider: 'tencent',
};

/**
 * 唯一的一份「云端行为」实现，同时供两条调用路径使用（第 10 轮踩过的坑）：
 * 路由/网关走 `cos.p`；`cos.js` 内部（listPage / listAllExact）走模块作用域的 `p`，
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
      if (deleteFailKeys && deleteFailKeys.has(params.Key)) {
        return fail('注入的删除失败：' + params.Key, 500);
      }
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
      // 目标 key 就是 params.Key（与 audit11 / audit12 同口径）
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
    case 'multipartInit': return ok({ UploadId: 'audit13-upload-id' });
    case 'multipartUpload': return ok({ ETag: '"part-etag"' });
    case 'multipartComplete': return ok({ ETag: '"final-etag"' });
    case 'multipartAbort': return ok({});
    case 'multipartListPart': return ok({ ListPartsResult: { Part: [] } });
    case 'multipartList': return ok({ ListUploadsResult: { Upload: [], IsTruncated: 'false' } });
    case 'request': return ok({});
    case 'getBucket': {
      const prefix = String(params.Prefix || '');
      // R13-04：让「目录非空」这一步探测失败（模拟网络抖动 / 403 → fail-open）
      if (probeFailPrefix && String(params.Delimiter) === '/' && prefix.startsWith(probeFailPrefix)) {
        return fail('注入的列举失败（fail-open 探测）：' + prefix, 500);
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
  // 只为「成功的复制」注入延迟（失败的复制必须立刻失败，才能造出"其余 worker 仍在飞"）
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
statsStore.addLog = (entry) => { capturedLogs.push(entry); };
statsStore.trackBucket = () => {};
const encStore = require(path.join(ROOT, 'server', 'enc-store.js'));
const shareStore = require(path.join(ROOT, 'server', 'share-store.js'));
const gateway = require(path.join(ROOT, 'server', 'fs-gateway.js'));

/* ------------------------------------------------------------------ *
 * 1 · 迷你 WebDAV 工具（与 audit7~12 同型，逐轮护栏自包含）
 * ------------------------------------------------------------------ */

const openServers = [];

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

/** 目标前缀下当前的对象键（排序后，便于断言可读） */
const keysUnder = (prefix) => [...fakeObjects.keys()].filter((k) => k.startsWith(prefix)).sort();

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
      label: 'audit13-regressions',
      flushers: [
        { name: 'enc-store', flush: () => encStore.flushMetaSync() },
        { name: 'stats-store', flush: () => statsStore.flushStatsSync() },
        { name: 'config-store', flush: () => configStore.flush() },
      ],
    });
  } catch (e) { /* ignore */ }
});

/* ================================================================== *
 * R13-01 · 测试隔离必须"默认安全"
 * ================================================================== */

/**
 * 报告 §0.1 / R13-01（高危，唯一一条会动到**真实用户数据**的缺陷）。
 *
 * 第 12 轮把 9 个 store + 2 个入口都改成支持 `COS_DATA_DIR`，并给 `config-store`
 * 补了单测 —— 但**全量测试仍会写生产数据**。根因不在 store 层，而在**加载时序**：
 * 若干用例用「设 env + `delete require.cache` 加载隔离实例 → 测完还原 env 并再删缓存」
 * 这一模式；此后同一文件里任何一次 `require`（含经 `cos.js` / 路由 / WebDAV **传递**
 * 加载）拿到的都是**绑定生产 `data/`** 的实例。实测 `audit6` 的 PERF-02 对生产
 * `config.enc` 做了 8 次"解密→重加密→原子替换"、`audit3` 的 FUN-02 把生产
 * `stats.json` 里桶 b 的 req 从 667 改到 672。
 *
 * 修法是**默认安全**：`tests/helpers.js` 是所有测试文件的公共入口，在它顶层无条件
 * 兜底 —— 凡是没有自己设 env 的测试进程，store 一律落进进程级临时目录。
 * 断言因此打在**子进程的后果**上：在不设 `COS_DATA_DIR` 的环境里只 require
 * `helpers.js`，那个进程拿到的数据目录必须已经是临时目录，且**不是**生产 `data/`。
 * 重新返回"靠每个用例自觉"（去掉顶层兜底）时，子进程会打印空串 → 立刻变红。
 */
test('R13-01 · 测试进程必须默认拿到临时数据目录（不得回落生产 data/）', async () => {
  const prodDataDir = path.join(ROOT, 'data');

  /**
   * 用**异步** `spawn` 而不是 `spawnSync`：本机 `spawnSync` 恒返回
   * `status=null / error=EBUSY`（RE-03 / R7-07 两条用例栽在同一处环境问题上），
   * 拿不到 stdout 就会把"没跑起来"误判成"输出了空串"→ 假阴性。
   */
  const runChild = (env) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e',
      "require('./tests/helpers.js');process.stdout.write(String(process.env.COS_DATA_DIR||''))",
    ], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
  });

  // ① 不设 env —— 必须被兜底到临时目录
  const envFree = Object.assign({}, process.env);
  delete envFree.COS_DATA_DIR;
  const a = await runChild(envFree);
  assertEqual(a.code, 0, `R13-01 前置：子进程应正常退出（stderr：${a.err.slice(0, 400)}）`);
  assert(a.out.length > 0,
    'R13-01：不设 COS_DATA_DIR 的测试进程必须拿到**临时数据目录** —— '
    + 'Helpers 的顶层兜底一旦被移除，进程就会回落生产 data/，'
    + '`npm test` 会直接改写生产 config.enc（全部云厂商密钥）与 stats.json');
  const resolved = path.resolve(a.out);
  assert(resolved !== path.resolve(prodDataDir),
    `R13-01：兜底目录**绝不能**是生产 data/（实际解析为 ${resolved}）`);
  assert(resolved.startsWith(path.resolve(os.tmpdir())),
    `R13-01：兜底目录必须落在系统临时目录之下（实际 ${resolved}）—— `
    + '否则测试产物会散落在项目或用户目录里，且不被退出钩子回收');

  // ② 正向对照：已经设了 env 的进程必须**保持原值**（不得被兜底覆盖）
  const preset = path.join(os.tmpdir(), 'cos-audit13-preset');
  const envPreset = Object.assign({}, process.env, { COS_DATA_DIR: preset });
  const b = await runChild(envPreset);
  assertEqual(b.code, 0, `R13-01 正向对照：子进程应正常退出（stderr：${b.err.slice(0, 400)}）`);
  assertEqual(path.resolve(b.out), path.resolve(preset),
    'R13-01 正向对照：显式设置的 COS_DATA_DIR 必须原样保留 —— '
    + '兜底写成无条件覆盖会让 audit7~12 等自带隔离的用例全部跑到同一个目录里互相污染');
});

/* ================================================================== *
 * R13-02 · 目录 COPY 失败回滚：fresh 过滤
 * ================================================================== */

/**
 * 报告 §1 的 R13-02（高危）。
 *
 * WebDAV 目录 COPY 的失败回滚（R12-04 新加）把 `created` **全量**喂给了
 * `rollbackCopies`（`webdav-server.js:941`），而 `movePrefix:783` 那层
 * `fresh = copied.filter((k) => !existedBefore.has(k))` 过滤没有一起搬过来。
 * 默认 `Overwrite: T` 下目标侧同名对象会被覆盖 —— 于是"回滚"会删掉**用户在复制前
 * 就存在**的对象，而失败与它毫无关系。这是不可逆的数据丢失。
 *
 * 断言打在后果上：复制前就存在的那个目标对象，回滚之后**必须还在**。
 */
test('R13-02 · 目录 COPY 失败回滚不得删「复制前就存在的目标对象」', async () => {
  await startDav();
  fakeObjects.clear();
  fakeObjects.set('r2src/', Buffer.alloc(0)); // 目录占位对象（WebDAV 用它判定源存在）
  for (let i = 0; i < 6; i += 1) {
    fakeObjects.set(`r2src/f-${String(i).padStart(2, '0')}.bin`, Buffer.from('SRC-' + i));
  }
  // 目标侧**原本就有** f-00（会被覆盖），它不是本次复制新建的
  fakeObjects.set('r2dst/f-00.bin', Buffer.from('OLD-USER-DATA'));

  copyFailKeys = new Set(['r2dst/f-05.bin']); // 前 5 个已复制 → 走到回滚
  copyDelayMs = 40; // 让失败发生时其余 worker 仍在飞（与 R13-03 同一取样前提）
  let r;
  try {
    r = await request(davPort, 'COPY', '/dav/r2src/', {
      tls: true,
      headers: Object.assign({
        Destination: `https://127.0.0.1:${davPort}/dav/r2dst`,
        Overwrite: 'T',
      }, AUTH),
    });
  } finally {
    copyFailKeys = null;
    copyDelayMs = 0;
  }
  assertEqual(r.status, 500,
    `R13-02 前置：注入的复制失败必须如实报错（实际 ${r.status}）—— `
    + '写成 >= 400 时"请求根本没走到复制分支"也会绿');
  await new Promise((res) => setTimeout(res, 200)); // 等回滚与残留落地

  assert(fakeObjects.has('r2dst/f-00.bin'),
    'R13-02：复制前就存在于目标侧的对象**不得被回滚删除** —— '
    + '它的内容确实被覆盖了（云端覆盖不可撤销），但它不是本次新建的副本；'
    + '删掉它就是把与本次失败无关的用户数据一并毁掉（不可逆）。'
    + `目标侧现存：${keysUnder('r2dst/').join('、') || '（空）'}`);
  assertEqual(keysUnder('r2dst/').join(','), 'r2dst/f-00.bin',
    `R13-02：本次新建的 5 个副本必须被清干净，只留复制前就有的那一个（实际 ${keysUnder('r2dst/').join('、')}）`);
  assertEqual(keysUnder('r2src/').length, 7,
    'R13-02：源目录必须原样保留（回滚只动目标侧）');

  // 正向对照：不注入失败时 Overwrite:T 的覆盖复制必须照常成功（fresh 过滤不得误伤）
  fakeObjects.clear();
  fakeObjects.set('r2oksrc/a.bin', Buffer.from('A'));
  fakeObjects.set('r2oksrc/b.bin', Buffer.from('B'));
  fakeObjects.set('r2okdst/a.bin', Buffer.from('OLD'));
  const okr = await request(davPort, 'COPY', '/dav/r2oksrc/', {
    tls: true,
    headers: Object.assign({
      Destination: `https://127.0.0.1:${davPort}/dav/r2okdst`,
      Overwrite: 'T',
    }, AUTH),
  });
  assertEqual(okr.status, 201, `R13-02 正向对照：正常覆盖复制必须 201（实际 ${okr.status}）`);
  assertEqual(keysUnder('r2okdst/').join(','), 'r2okdst/a.bin,r2okdst/b.bin',
    'R13-02 正向对照：两个对象都必须落地');
  assertEqual(fakeObjects.get('r2okdst/a.bin').toString(), 'A',
    'R13-02 正向对照：目标侧既有对象必须被新内容覆盖（Overwrite:T 的语义）');
});

/* ================================================================== *
 * R13-03 · 并发失败：先等 worker 落地再取快照
 * ================================================================== */

/**
 * 报告 §1 的 R13-03（高危）。
 *
 * 同一处入口缺了 `movePrefix:783` 的 `stopped` + `allSettled`：旧实现
 * `Promise.all(workers)` 一拒就往下走，其余 4 路 worker **仍在 `copyObject` 并
 * `created.push()`**；紧接的回滚拿到的是**过早的快照**，孤儿在回滚之后才落地，
 * 而日志因 `removed === fresh.length` 谎报「已回滚 N/N」。实测残留 11 个。
 *
 * 断言取「目标侧残留数 === 0」这个后果 —— 它同时覆盖"孤儿没回滚"与"日志谎报"两半。
 * `copyDelayMs` 是必需前提：没有它，12 个对象会在同一微任务里全部完成，
 * 撤回 `allSettled` 也测不出残留（护栏空转）。
 */
test('R13-03 · 并发复制失败回滚后目标侧不得残留任何孤儿，日志不得谎报', async () => {
  await startDav();
  fakeObjects.clear();
  const N = 12; // 多于 worker 数（5），确保失败发生时其它 worker 仍在飞
  for (let i = 0; i < N; i += 1) {
    fakeObjects.set(`r3src/f-${String(i).padStart(2, '0')}.bin`, Buffer.from('x'.repeat(i + 1)));
  }
  // 让**第一个被取走**的任务失败：其余 4 路 worker 在 copyDelayMs 内仍在飞
  copyFailKeys = new Set(['r3dst/f-00.bin']);
  copyDelayMs = 40;
  cloudCalls.copyAttempts = 0;
  capturedLogs.length = 0;

  let r;
  try {
    r = await request(davPort, 'COPY', '/dav/r3src/', {
      tls: true,
      headers: Object.assign({
        Destination: `https://127.0.0.1:${davPort}/dav/r3dst`,
        Overwrite: 'T',
      }, AUTH),
    });
  } finally {
    copyFailKeys = null;
    copyDelayMs = 0;
  }
  assertEqual(r.status, 500, `R13-03 前置：复制失败必须如实报错（实际 ${r.status}）`);

  /**
   * 孤儿是**在回滚之后才落地**的：旧实现在 `Promise.all` 拒绝的当下就取了快照
   * （此时在飞的 4 路 worker 什么都还没 push），于是它删掉 0 个、抛出、返回；
   * 那 4 个对象随后才被写进目标目录。因此必须**等到它们有机会落地之后**再数残留 ——
   * 立刻数会得到 0，护栏就空转了（"时序型"缺陷特有的取样陷阱）。
   */
  await new Promise((res) => setTimeout(res, 250));

  const leftovers = keysUnder('r3dst/');
  assertEqual(leftovers.length, 0,
    `R13-03：回滚后目标侧必须**零残留**（实际残留 ${leftovers.length} 个：`
    + `${leftovers.slice(0, 5).join('、')}）—— 旧实现在 Promise.all 拒绝后立刻取快照，`
    + '仍在飞的 worker 之后 push 的键不进快照 → 孤儿留在目标目录，'
    + '而日志因 removed === fresh.length 谎报「已回滚 N/N」');
  assertEqual(keysUnder('r3src/').length, N, 'R13-03：源目录必须完整保留');

  assert(cloudCalls.copyAttempts < N,
    `R13-03：失败后必须**停止启动新任务**（实际尝试复制 ${cloudCalls.copyAttempts} 次 / 共 ${N} 个对象）`
    + ' —— `stopped` 标志的那一半：没有它，worker 会把剩下 7 个对象全部复制一遍再回滚，'
    + '一次失败变成整目录的无效云端往返（且按量计费）');

  /**
   * 日志的**一致性**：只要它写出了「已回滚 X/Y」，X 就必须是**真实**删掉的个数，
   * 且当 X < Y 时必须明说残留。这一条挡的是"谎报"（R13-03 的另一半）：
   * 残留为 0 而日志说"已回滚 0/4"同样不可接受（那说明它删错了一批）。
   */
  const rollbackLog = capturedLogs.filter((e) => /复制失败/.test(String(e.detail || ''))).pop();
  assert(rollbackLog, 'R13-03：失败路径必须留下回滚审计日志');
  const m = /已回滚 (\d+)\/(\d+)/.exec(String(rollbackLog.detail));
  assert(m, `R13-03：日志必须写明「已回滚 X/Y」，实际：${rollbackLog.detail}`);
  assertEqual(Number(m[1]), Number(m[2]),
    `R13-03：零残留时日志必须声称"完整回滚"（实际 ${m[1]}/${m[2]}）—— `
    + `残留若真有 ${Number(m[2]) - Number(m[1])} 个，上一条断言已经报红了；`
    + '这里报红说明回滚数与实际不符（日志与事实不一致）');

  // 正向对照：不注入失败时 12 个对象必须全部复制成功
  fakeObjects.clear();
  for (let i = 0; i < N; i += 1) {
    fakeObjects.set(`r3ok/f-${String(i).padStart(2, '0')}.bin`, Buffer.from('y'));
  }
  const okr = await request(davPort, 'COPY', '/dav/r3ok/', {
    tls: true,
    headers: Object.assign({
      Destination: `https://127.0.0.1:${davPort}/dav/r3okdst`,
      Overwrite: 'T',
    }, AUTH),
  });
  assertEqual(okr.status, 201, `R13-03 正向对照：正常 COPY 必须 201（实际 ${okr.status}）`);
  assertEqual(keysUnder('r3okdst/').length, N,
    'R13-03 正向对照：12 个对象必须全部落地（stopped / allSettled 不得误伤成功路径）');
});

/* ================================================================== *
 * R13-04 · Overwrite:F 必须在动手前整体拒绝
 * ================================================================== */

/**
 * 报告 §1 的 R13-04（中危）。
 *
 * 报告称「这里的守卫只判『目标容器存在』」—— **复核后前提需要修正**：
 * `destinationExists(cos, cfg, dstKey, true)` 的判据是三种形态（① 目标路径本身是
 * 文件；② 目录占位对象；③ 目录下**任意一层子项**），第 ③ 形态查的就是"目标非空"。
 * 因此 `Overwrite: F` 下不存在"目标里只有部分同名对象、于是被静默覆盖"的路径。
 * 结论是**保留**容器级判据（与 RFC 4918 §9.8.4 的严格字面一致），
 * 并把键级比对接在它之后作 **fail-open 兜底**：① 的探测在网络抖动 / 403 时按
 * "不存在"返回（`destinationExists` 的既有约定），此时 ② 仍能挡住同名覆盖。
 *
 * 本用例因此分两段：**A** 守容器级语义（目标非空 → 412 且零改动）；
 * **B** 注入列举失败让 ① fail-open，验证 ② 不是装饰性代码（同样 412、零改动）。
 */
test('R13-04 · Overwrite:F 必须整体拒绝（容器级 412 + 键级 fail-open 兜底）', async () => {
  await startDav();

  /**
   * --- A1 · 容器级 —— 目标非空但**没有任何同名对象** ---
   *
   * 这是**只有容器级判据能挡住**的形态：源里是 `keep.bin` / `other.bin`，目标里只有
   * 一个名字完全不同的 `zz-existing.bin`。键级比对查不到任何冲突，因此若把容器级
   * 判据摘掉（只留键级兜底），这条会退化成 201 —— 把目录整个写进一个非空目录，
   * 正是 RFC 4918 §9.8.4 要求拒绝的情形。
   */
  fakeObjects.clear();
  fakeObjects.set('r4src/keep.bin', Buffer.from('SRC'));
  fakeObjects.set('r4src/other.bin', Buffer.from('SRC2'));
  fakeObjects.set('r4dst/zz-existing.bin', Buffer.from('EXISTING'));
  const beforeA = keysUnder('r4dst/').slice();
  probeFailPrefix = null;
  const a = await request(davPort, 'COPY', '/dav/r4src/', {
    tls: true,
    headers: Object.assign({
      Destination: `https://127.0.0.1:${davPort}/dav/r4dst`,
      Overwrite: 'F',
    }, AUTH),
  });
  assertEqual(a.status, 412,
    `R13-04：目标非空且声明 Overwrite:F 时必须在**动手之前**整体拒绝（实际 ${a.status}）—— `
    + 'RFC 4918 §9.8.4 要求整体拒绝；逐对象判定会在复制掉一部分之后才发现冲突，目标留半成品');
  assertEqual(keysUnder('r4dst/').join(','), beforeA.join(','),
    'R13-04：412 必须伴随**零改动**（一个对象都不许复制）');
  assertEqual(fakeObjects.get('r4dst/zz-existing.bin').toString(), 'EXISTING',
    'R13-04：目标侧既有对象的内容不得被这次被拒的请求改动');
  /**
   * 断言文案走的是**容器级**那一支：同名对象一个都没有，键级比对无从报冲突。
   * 没有这一条时，"容器级被摘掉、只剩键级兜底"也能让上面的 412 断言通过
   * —— 那就会把一条已经失效的判据当成有效（本轮反复出现的假护栏形态）。
   */
  assert(!/同名对象/.test(a.text),
    `R13-04：本形态下不存在任何同名对象，报错必须来自**容器级**判据（实际文案：${a.text}）`);

  /* --- A2 · 容器级 —— 目标非空且**含同名对象**（两条判据都能挡） --- */
  fakeObjects.clear();
  fakeObjects.set('r4asrc/keep.bin', Buffer.from('SRC'));
  fakeObjects.set('r4adst/keep.bin', Buffer.from('EXISTING'));
  const a2 = await request(davPort, 'COPY', '/dav/r4asrc/', {
    tls: true,
    headers: Object.assign({
      Destination: `https://127.0.0.1:${davPort}/dav/r4adst`,
      Overwrite: 'F',
    }, AUTH),
  });
  assertEqual(a2.status, 412,
    `R13-04：目标下有同名对象且声明 Overwrite:F 时必须拒绝（实际 ${a2.status}）`);
  assertEqual(fakeObjects.get('r4adst/keep.bin').toString(), 'EXISTING',
    'R13-04：同名冲突时目标侧内容一个字都不许变');
  assertEqual(keysUnder('r4adst/').length, 1, 'R13-04：同名冲突时不得落地任何副本');

  /* --- B · 键级兜底（① fail-open 时仍挡住同名覆盖） --- */
  fakeObjects.clear();
  fakeObjects.set('r4bsrc/keep.bin', Buffer.from('SRC'));
  fakeObjects.set('r4bdst/keep.bin', Buffer.from('EXISTING'));
  probeFailPrefix = 'r4bdst/'; // 让 destinationExists 的形态③ 探测失败 → fail-open
  let b;
  try {
    b = await request(davPort, 'COPY', '/dav/r4bsrc/', {
      tls: true,
      headers: Object.assign({
        Destination: `https://127.0.0.1:${davPort}/dav/r4bdst`,
        Overwrite: 'F',
      }, AUTH),
    });
  } finally {
    probeFailPrefix = null;
  }
  assertEqual(b.status, 412,
    `R13-04：容器级探测 fail-open 时，键级比对必须兜住（实际 ${b.status}）—— `
    + '删掉键级兜底后这条会退化成 201 覆盖用户数据');
  assert(/同名对象/.test(b.text),
    `R13-04：兜底分支必须给出**自己的**文案（说明是同名对象冲突，而不是笼统的"目标已存在"），实际：${b.text}`);
  assertEqual(fakeObjects.get('r4bdst/keep.bin').toString(), 'EXISTING',
    'R13-04：兜底分支同样必须零改动（目标侧既有内容一个字都不许变）');
  assertEqual(keysUnder('r4bdst/').length, 1, 'R13-04：兜底分支不得落地任何副本');

  /* --- 正向对照：空目标 + Overwrite:F 必须照常成功 --- */
  fakeObjects.clear();
  fakeObjects.set('r4ok/x.bin', Buffer.from('X'));
  const okr = await request(davPort, 'COPY', '/dav/r4ok/', {
    tls: true,
    headers: Object.assign({
      Destination: `https://127.0.0.1:${davPort}/dav/r4okdst`,
      Overwrite: 'F',
    }, AUTH),
  });
  assertEqual(okr.status, 201,
    `R13-04 正向对照：目标不存在时 Overwrite:F 必须放行（实际 ${okr.status}）—— `
    + '守卫退化成"恒 412"会让所有首次同步静默失败');
  assertEqual(keysUnder('r4okdst/').join(','), 'r4okdst/x.bin', 'R13-04 正向对照：对象必须落地');
});

/* ================================================================== *
 * R13-05 · moveObject 删源失败必须回滚
 * ================================================================== */

/**
 * 报告 §2 的 R13-05（中危）。
 *
 * `fs-gateway.moveObject` 完成「复制 → 删源」后，若**删源失败**旧实现直接抛错：
 * 源与目标并存，既不回滚也不留痕。后果有两层：① 目标侧多出来的副本按量计费；
 * ② `copyObject` 已把加密元数据迁到目标 key 上，源侧重试移动会撞上它。
 *
 * 回滚边界与 R11-03 / R13-02 同一条纪律（fresh 判据）：只删**本次新建**的目标。
 * 目标在复制前本就存在时（Overwrite:T 的覆盖移动），旧内容已被源覆盖、不可还原 ——
 * 这时再删目标就是把用户既有数据一并毁掉，**必须不删**。
 */
test('R13-05 · moveObject 删源失败必须回滚本次新建的目标（且不得删既有的）', async () => {
  /* --- ① 目标是本次新建 → 必须回滚删除 --- */
  fakeObjects.clear();
  fakeObjects.set('m5/src.bin', Buffer.from('DATA'));
  deleteFailKeys = new Set(['m5/src.bin']);
  let threw = null;
  try {
    await gateway.moveObject(BASE_CFG.bucket, 'm5/src.bin', 'm5/dst.bin', 'fs.move', '');
  } catch (e) { threw = e; } finally { deleteFailKeys = null; }
  assert(threw, 'R13-05 前置：删源失败必须向上抛（调用方需要知道移动没完成）');
  assert(!fakeObjects.has('m5/dst.bin'),
    'R13-05：删源失败时目标副本必须被回滚删除 —— 残留它会让用户"重试移动"叠出第二份，'
    + '且容量按两份计费（旧实现既不回滚也不留痕）');
  assert(fakeObjects.has('m5/src.bin'),
    'R13-05：源对象必须仍在（移动未完成，用户应能直接重试）');
  assert(/已回滚/.test(String(threw.message)) || /已回滚/.test(String(capturedLogs.map((x) => x.detail).join('\n'))),
    `R13-05：失败路径必须留下"已回滚"的痕迹（错误信息或审计日志），实际错误：${threw.message}`);

  /* --- ② 目标在复制前本就存在 → 绝不许删（fail-closed 分支） --- */
  fakeObjects.clear();
  fakeObjects.set('m6/src.bin', Buffer.from('NEW'));
  fakeObjects.set('m6/dst.bin', Buffer.from('USER-OLD'));
  deleteFailKeys = new Set(['m6/src.bin']);
  let threw2 = null;
  try {
    await gateway.moveObject(BASE_CFG.bucket, 'm6/src.bin', 'm6/dst.bin', 'fs.move', '');
  } catch (e) { threw2 = e; } finally { deleteFailKeys = null; }
  assert(threw2, 'R13-05 前置（②）：删源失败必须向上抛');
  assert(fakeObjects.has('m6/dst.bin'),
    'R13-05：目标在移动前**本就存在**时，删源失败**不得**回滚删除目标 —— '
    + '它的旧内容已被源覆盖（不可还原），再删就是把用户既有数据一并毁掉；'
    + '这条分支必须 fail-closed（宁可留孤儿待人工核对）');

  /* --- ③ 正向对照：正常移动必须成功 --- */
  fakeObjects.clear();
  fakeObjects.set('m7/src.bin', Buffer.from('OK'));
  await gateway.moveObject(BASE_CFG.bucket, 'm7/src.bin', 'm7/dst.bin', 'fs.move', '');
  assert(fakeObjects.has('m7/dst.bin'), 'R13-05 正向对照：源必须落到目标');
  assert(!fakeObjects.has('m7/src.bin'), 'R13-05 正向对照：源必须被删掉');
});

/* ================================================================== *
 * 附带 · 前置自检
 * ================================================================== */

test('附带 · 前置自检：本轮用到的模块均已加载', () => {
  assert(typeof gateway.rollbackCopies === 'function',
    'R13-02：gateway.rollbackCopies 必须是导出的唯一实现点（三处复制入口共用）');
  assert(typeof gateway.moveObject === 'function', 'R13-05：gateway.moveObject 必须可用');
  assert(typeof shareStore.markMissingByKeys === 'function', 'shareStore 应可用');
});
