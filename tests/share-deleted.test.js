/**
 * 「文件已被删除的分享链接」行为测试
 *
 * 背景：分享链接在创建时快照了 key/bucket，云端对象被删掉后链接本身毫发无损 ——
 * 旧行为是分享页照常给下载按钮、点了才报错，管理页则完全无感知（仍显示「有效」）。
 *
 * 本文件覆盖三条链路：
 *   ① share-store：deleted 状态 / 批量标记 / 取消标记 / 拒绝占用名额
 *   ② 分享页：已标记 → 直接提示；未标记 → 惰性探测（404 才算没了，其余一律放行）
 *   ③ 站内删除：/fs/delete 确认删掉后必须同步标记关联链接
 *
 * ⚠️ share-store 支持 COS_DATA_DIR，必须**先设环境变量再 require**，
 *    否则用例会把假链接写进项目真实的 data/links.json。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const { ROOT, assert, assertEqual, assertMatch, makeTempDir, request } = require('./helpers.js');

const tmp = makeTempDir('cos-share-del-');
process.env.COS_DATA_DIR = tmp.dir;

const http = require('http');
const express = require(path.join(ROOT, 'node_modules', 'express'));

// 假云端客户端：所有用例共用一个可变句柄，切换实现即可
let cloud = null;

const cos = require(path.join(ROOT, 'server', 'cos.js'));
cos.getClient = () => cloud; // 必须在 require 路由之前替换（路由在加载时就解构了 getClient）

const configStore = require(path.join(ROOT, 'server', 'config-store.js'));
configStore.effectiveForBucket = () => ({
  bucket: 'tb', region: 'ap-guangzhou', provider: 'tencent', secretId: 'sid', secretKey: 'skey',
});

const statsStore = require(path.join(ROOT, 'server', 'stats-store.js'));
statsStore.addLog = () => {};
statsStore.trackBucket = () => {};

const shareStore = require(path.join(ROOT, 'server', 'share-store.js'));
const shareRoutes = require(path.join(ROOT, 'server', 'share-routes.js'));

const shared = require(path.join(ROOT, 'server', 'routes', '_shared.js'));
shared.requireConfig = () => ({ bucket: 'tb', region: 'ap-guangzhou', provider: 'tencent' });
const fsRoutes = require(path.join(ROOT, 'server', 'routes', 'fs.js'));

/** 起一个只挂指定路由的本地服务 */
async function serve(mount, router, middleware) {
  const app = express();
  app.use(express.json());
  if (middleware) app.use(middleware);
  app.use(mount, router);
  const server = await new Promise((resolve) => {
    const s = http.createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  return {
    port: server.address().port,
    close: () => new Promise((r) => server.close(r)),
  };
}

/** 造一条链接（无密码、不付费、永久有效、不限次数） */
function makeLink(bucket, key, extra = {}) {
  return shareStore.create(Object.assign({
    key, bucket, region: 'ap-guangzhou', fileName: key.split('/').pop(), size: 1024,
    expiresHours: 0, maxDownloads: 0, password: null, paid: null, createdBy: 'tester',
  }, extra));
}

/**
 * 按 id 取**记录**再判状态。
 *
 * 不能拿 create() 的返回值去问 status()：那是 view() 产出的**视图**（只带 missing 布尔），
 * 不是库里的记录（带 missingAt）—— 混用会得到「明明标了已删除却判成已过期」的假结果。
 */
const stOf = (id) => shareStore.status(shareStore.get(id));

const bucketOf = (n) => 'tb-' + n; // 每条用例用独立桶名做数据隔离

/* ============================ ① store 层 ============================ */

test('已删除链接的状态优先于过期 / 次数用尽，并出现在视图里', async () => {
  const l = await makeLink(bucketOf('t1'), 'a.txt');
  assertEqual(stOf(l.id), 'active', '新建链接应为有效');
  assertEqual(shareStore.view(l).missing, false, '视图默认不应带 missing');
  assertEqual(shareStore.view(l).missingAt, null, '视图默认 missingAt 应为 null');

  assert(shareStore.markMissing(l.id), '首次标记应返回 true');
  const after = shareStore.get(l.id);
  assertEqual(shareStore.status(after), 'deleted', '标记后状态必须为 deleted');
  assertEqual(shareStore.view(after).missing, true, '视图必须带出 missing —— 管理页据此渲染');
  assertMatch(String(after.missingAt), /^\d{4}-\d{2}-\d{2}T/, 'missingAt 应为 ISO 时间');

  assertEqual(shareStore.markMissing(l.id), false, '重复标记不应重复落盘');

  // 即便同时过期 / 次数用尽，「文件已删除」也必须排在最前
  const l2 = await makeLink(bucketOf('t1b'), 'b.txt', { expiresHours: -1, maxDownloads: 1 });
  assertEqual(stOf(l2.id), 'expired', '未标记时应为已过期');
  shareStore.markMissing(l2.id);
  assertEqual(stOf(l2.id), 'deleted',
    '对象没了是最根本的事实 —— 否则管理员会去改有效期，改完照样下不了');

  shareStore.clearMissing(l2.id);
  assertEqual(stOf(l2.id), 'expired', '取消标记后应回落到原本的过期状态');
});

test('markMissingByKeys 只标记「已确认删除」的 key，且按桶隔离', async () => {
  const b = bucketOf('t2');
  const a = await makeLink(b, 'dir/a.txt');
  const c = await makeLink(b, 'dir/c.txt');
  const other = await makeLink(bucketOf('t2-other'), 'dir/a.txt'); // 同 key 不同桶
  const untouched = await makeLink(b, 'keep.txt');

  const n = shareStore.markMissingByKeys(b, ['dir/a.txt', 'dir/c.txt']);
  assertEqual(n, 2, `应只标记本桶匹配的两条，实际 ${n}`);
  assertEqual(stOf(a.id), 'deleted', 'dir/a.txt 应被标记');
  assertEqual(stOf(c.id), 'deleted', 'dir/c.txt 应被标记');
  assertEqual(stOf(other.id), 'active', '同名 key 在别的桶里不应被误标');
  assertEqual(stOf(untouched.id), 'active', '不在删除集合里的 key 必须保持有效');

  // 幂等：已经在缺失状态的不再计数（删除目录被截断、分批回调时会被反复调用）
  assertEqual(shareStore.markMissingByKeys(b, ['dir/a.txt']), 0, '已标记的key重复提交不应再计数');
  assertEqual(shareStore.markMissingByKeys(b, []), 0, '空集合应直接返回 0');
});

test('tryAcquire 必须拒绝已删除的链接，且不消耗次数', async () => {
  const l = await makeLink(bucketOf('t3'), 'x.txt');
  assertEqual(shareStore.tryAcquire(l.id).ok, true, '有效链接应能占用名额');
  shareStore.markMissing(l.id);
  const r = shareStore.tryAcquire(l.id);
  assertEqual(r.ok, false, '已删除的链接绝不能再占用下载名额');
  assertEqual(r.reason, 'deleted', '拒绝原因必须是 deleted（分享页据此渲染状态页）');
  const after = shareStore.get(l.id);
  assertEqual(Number(after.downloads), 1, '被拒的请求不能计入下载次数');
});

/* ============================ ② 分享页 ============================ */

test('已标记删除的链接：分享页提示「文件已被删除」，且不给下载按钮', async () => {
  const l = await makeLink(bucketOf('t4'), 'gone.txt');
  shareStore.markMissing(l.id);
  // R8-06 之后「已标记」不再等于「不再探测」：对象可能被重新上传回同一个 key，
  // 已标记的链接同样要重探一次。因此本用例必须给出「对象确实不在」的云端回答，
  // 才能稳定落在 410 —— 否则桩缺失会把探测走成失败分支（fail-open → 200）。
  cloud = {
    headObject(_params, cb) {
      cb(Object.assign(new Error('NoSuchKey'), { statusCode: 404, code: 'NoSuchKey' }), null);
    },
  };
  const srv = await serve('/', shareRoutes);
  try {
    const r = await request(srv.port, 'GET', '/s/' + l.id);
    assertEqual(r.status, 410, `应返回 410，实际 ${r.status}`);
    assertMatch(r.raw, /文件已被删除/, '分享页必须明确告知文件已被删除');
    assert(!/\/dl/.test(r.raw), '已删除的链接不应再渲染下载入口');
  } finally {
    await srv.close();
  }
});

test('R8-06：已标记删除的链接，在对象被重新上传回同一 key 后自动恢复为有效', async () => {
  // 旧实现第一行就是 `if (l.missingAt) return true`，于是下面那句
  // `else if (l.missingAt) clearMissing()` 永远不可达 —— deleted 成了**不可逆的假终态**，
  // 把同名文件重新上传回去，分享页恒 410、管理页恒显示「文件已删除」，
  // 与「重新上传到同一位置链接会自动恢复」的承诺完全相反。已分发的 URL 只能删链接重建。
  const l = await makeLink(bucketOf('t4b'), 'revived.txt');
  shareStore.markMissing(l.id);
  assertEqual(stOf(l.id), 'deleted', '前置条件：链接应处于已删除状态');

  cloud = {
    headObject(_params, cb) { cb(null, { headers: { 'content-length': '12' } }); },
  };
  const srv = await serve('/', shareRoutes);
  try {
    const r = await request(srv.port, 'GET', '/s/' + l.id);
    assertEqual(r.status, 200, `对象回来了，分享页必须恢复可用，实际 ${r.status}`);
    assertMatch(r.raw, /下载文件/, '恢复后应重新提供下载入口');
    assert(!shareStore.get(l.id).missingAt,
      '探测到对象存在必须清除 missingAt —— 否则「重新上传同名文件即可恢复」是句空话');
    assertEqual(stOf(l.id), 'active', '状态应回到有效');
  } finally {
    await srv.close();
  }
});

test('惰性探测：云端回答 404 时标记并提示；再次访问不再打云端', async () => {
  const l = await makeLink(bucketOf('t5'), 'lazy.txt');
  let headCalls = 0;
  cloud = {
    headObject(_params, cb) {
      headCalls += 1;
      cb(Object.assign(new Error('NoSuchKey'), { statusCode: 404, code: 'NoSuchKey' }), null);
    },
  };
  const srv = await serve('/', shareRoutes);
  try {
    const r1 = await request(srv.port, 'GET', '/s/' + l.id);
    assertEqual(r1.status, 410, '站外删除也必须能在分享页被识别（旧实现只会显示下载按钮）');
    assertMatch(r1.raw, /文件已被删除/, '应提示文件已被删除');
    assert(headCalls >= 1, '应发起存在性探测');
    assert(shareStore.get(l.id).missingAt, '探测到 404 必须落标记 —— 否则管理页永远无感知');

    const before = headCalls;
    const r2 = await request(srv.port, 'GET', '/s/' + l.id);
    assertEqual(r2.status, 410, '第二次访问应同样提示已删除');
    assertEqual(headCalls, before, '已落标记的链接不应再打云端（命中 missingAt 直接短路）');
  } finally {
    await srv.close();
  }
});

test('惰性探测失败一律放行：云端报错不等于文件被删（不得误标）', async () => {
  const l = await makeLink(bucketOf('t6'), 'alive.txt');
  cloud = {
    headObject(_params, cb) {
      cb(Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET', statusCode: -1 }), null);
    },
  };
  const srv = await serve('/', shareRoutes);
  try {
    const r = await request(srv.port, 'GET', '/s/' + l.id);
    assertEqual(r.status, 200, '网络抖动 / 密钥失效不应把页面变成已删除');
    assertMatch(r.raw, /下载文件/, '页面应照常提供下载入口（fail-open）');
    assert(!shareStore.get(l.id).missingAt,
      '云端报错绝不能把链接标记成已删除 —— 那会让一条好用的链接被永久判死');
  } finally {
    await srv.close();
  }
});

test('下载端点：已删除链接返回 410 且不消耗次数', async () => {
  const l = await makeLink(bucketOf('t7'), 'dl.txt');
  shareStore.markMissing(l.id);
  cloud = { getObject() { throw new Error('不该走到云端'); } };
  const srv = await serve('/', shareRoutes);
  try {
    const r = await request(srv.port, 'GET', '/s/' + l.id + '/dl');
    assertEqual(r.status, 410, `已删除链接的下载必须被拒，实际 ${r.status}`);
    assertMatch(r.raw, /文件已被删除/, '应给出「文件已被删除」而不是泛泛的失败');
    assertEqual(Number(shareStore.get(l.id).downloads), 0, '被拒的下载不能计入次数');
  } finally {
    await srv.close();
  }
});

/**
 * R8-09：服务端**故障**不得吞掉用户的下载配额。
 *
 * 下载端点先计数后传输（为防并发超限），因此服务端在「还没发出任何字节」时失败
 * 必须回滚刚占用的名额。旧实现里配置失效分支直接 `return`，于是「管理员解绑桶 /
 * 删密钥」期间访客每点一次下载就白扣一次：`maxDownloads=3` 的链接点 3 次即转
 * **终态** `exhausted`，重新绑定桶后仍然 410，只能靠人工「重置下载计数」救回。
 */
test('R8-09 · 配置失效导致 503 时必须回滚下载计数（服务端故障不能扣用户配额）', async () => {
  const l = await makeLink(bucketOf('t8'), 'cfg-gone.txt', { maxDownloads: 3 });
  const realEffective = configStore.effectiveForBucket;
  configStore.effectiveForBucket = () => null; // 模拟密钥被解绑 / 桶被删除
  cloud = { getObject() { throw new Error('不该走到云端'); } };
  const srv = await serve('/', shareRoutes);
  try {
    const r = await request(srv.port, 'GET', '/s/' + l.id + '/dl');
    assertEqual(r.status, 503, `配置失效应回 503，实际 ${r.status}`);
    assertEqual(Number(shareStore.get(l.id).downloads), 0,
      'R8-09：用户一字节都没拿到，必须回滚刚占用的名额 —— 否则每点一次白扣一次');
    assertEqual(stOf(l.id), 'active',
      '链接必须仍为有效（3 次额度一次都不该被消耗），绝不能因为服务端的故障变成终态');
  } finally {
    configStore.effectiveForBucket = realEffective;
    await srv.close();
  }
});

/* ============================ ③ 站内删除 ============================ */
// 以下两条走真实路由，桶名由 shared.requireConfig() 固定为 'tb'，
// 故改用「同一桶 + 唯一 key」做隔离（批量标记本来就按桶比对）
test('/fs/delete 删除对象后，指向它的分享链接必须同步标记为已删除', async () => {
  const l = await makeLink('tb', 'will-be-deleted.txt');
  const survivor = await makeLink('tb', 'stay.txt');
  const deleted = [];
  cloud = {
    headObject(params, cb) { cb(null, { headers: { 'content-length': '10' } }); },
    // R8-19：/fs/delete 的文件分支已从「逐个 deleteObject」改为
    // 「每批 ≤1000 的 deleteMultipleObject」。桩若只提供 deleteObject，
    // 云端调用会整体抛出并被吞成「整批失败」，于是**一个对象也没删掉**，
    // 断言只会看到「分享链接没被标记」这种次级症状。
    deleteMultipleObject(params, cb) {
      deleted.push(...params.Objects.map((o) => o.Key));
      cb(null, { Deleted: params.Objects });
    },
  };
  const srv = await serve('/api', fsRoutes, (req, _res, next) => {
    req.authUser = { id: 'u', username: 'u', role: 'admin' };
    next();
  });
  try {
    const r = await request(srv.port, 'POST', '/api/fs/delete', {
      body: { paths: ['will-be-deleted.txt'] },
    });
    assertEqual(r.status, 200, `删除应成功，实际 ${r.status} ${r.raw}`);
    assertEqual(deleted.length, 1, '应只删除指定对象');

    assertEqual(stOf(l.id), 'deleted',
      '云端对象已删除，分享链接必须同步标记 —— 否则管理页仍显示「有效」');
    assertEqual(stOf(survivor.id), 'active', '未删除的对象对应的链接不受影响');
  } finally {
    await srv.close();
  }
});

test('/fs/delete 删除目录：只有「确认删掉」的 key 被标记', async () => {
  const inDir = await makeLink('tb', 'd/a.txt');
  const missing = await makeLink('tb', 'd/not-listed.txt'); // 不在本批删除集合里
  const batch = [];
  cloud = {
    getBucket(params, cb) {
      // 只返回一页、且不截断 —— 模拟目录里只有一个对象
      if (String(params.Marker || '') !== '') {
        return cb(null, { Contents: [], CommonPrefixes: [], IsTruncated: 'false', NextMarker: '' });
      }
      cb(null, {
        Contents: [{ Key: 'd/a.txt', Size: '10', LastModified: '2026-01-01T00:00:00.000Z' }],
        CommonPrefixes: [], IsTruncated: 'false', NextMarker: 'd/a.txt',
      });
    },
    deleteMultipleObject(params, cb) {
      batch.push(...params.Objects.map((o) => o.Key));
      cb(null, { Deleted: params.Objects });
    },
  };
  const srv = await serve('/api', fsRoutes, (req, _res, next) => {
    req.authUser = { id: 'u', username: 'u', role: 'admin' };
    next();
  });
  try {
    const r = await request(srv.port, 'POST', '/api/fs/delete', { body: { paths: ['d/'] } });
    assertEqual(r.status, 200, `删除目录应成功，实际 ${r.status} ${r.raw}`);
    assertEqual(batch.join(','), 'd/a.txt', '云端应只删除列出的对象');
    assertEqual(stOf(inDir.id), 'deleted', '本批确认删除的 key 必须被标记');
    assertEqual(stOf(missing.id), 'active',
      '不在确认删除集合里的 key 严禁被标记 —— 与「元数据只按已确认删除的 key 清」同一约束');
  } finally {
    await srv.close();
  }
});

/* ============================ ④ 前端状态判定 ============================ */

test('前端 statusOf 与服务端同序：文件已删除 > 已过期 > 已关闭 > 有效', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'share-status.js'), 'utf8');
  const mjsFile = path.join(tmp.dir, 'share-status.mjs');
  fs.writeFileSync(mjsFile, src); // 以 .mjs 载入：该模块无 DOM 依赖，可直接 import
  const mod = await import('file:///' + mjsFile.replace(/\\/g, '/'));

  const base = { missing: false, expiresAt: null, maxDownloads: 0, downloads: 0 };
  assertEqual(mod.statusOf(Object.assign({}, base)), 'active', '普通链接应为有效');
  assertEqual(mod.statusOf(Object.assign({}, base, { missing: true })), 'deleted', 'missing 优先');
  assertEqual(
    mod.statusOf(Object.assign({}, base, { missing: true, expiresAt: '2020-01-01T00:00:00.000Z' })),
    'deleted', '同时过期时仍应判为已删除（与服务端 status() 同序）',
  );
  assertEqual(
    mod.statusOf(Object.assign({}, base, { expiresAt: '2020-01-01T00:00:00.000Z' })),
    'expired', '过期判定应保留',
  );
  assertEqual(
    mod.statusOf(Object.assign({}, base, { maxDownloads: 1, downloads: 1 })),
    'exhausted', '次数用尽判定应保留',
  );
  assertEqual(mod.STATUS_META.deleted.label, '文件已删除', '管理页状态列必须显示「文件已删除」');
  assertEqual(mod.STATUS_META.deleted.cls, 'gone', '应带 gone 样式类（整行灰化划线）');
});

// 收尾：先冲掉 secure-store 的异步写队列，再删临时目录
// （否则队列在目录已删后落盘，会打出一片 ENOENT 噪音）
test.after(async () => {
  try { await require(path.join(ROOT, 'server', 'secure-store.js')).flush(); } catch (e) { /* ignore */ }
  tmp.cleanup();
});
