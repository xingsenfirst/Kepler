/**
 * 测试：目录列举短缓存（server/list-cache.js）
 *
 * 这个缓存的**失败模式比没缓存更危险**：用户看到「刚删掉的文件还在」或
 * 「刚上传的文件看不见」，且不会有任何报错。因此这里守的是三件事：
 *  1. 命中条件严格（桶 / 前缀 / 游标 / 页大小 / 分隔符 任一不同即不命中）；
 *  2. 任何写操作立即失效整个桶，且失效挂在 cos.p 这一个咽喉点（未知方法按写处理）；
 *  3. 有上限、会过期、可整体关闭（LIST_CACHE_TTL_MS=0）。
 */
const http = require('http');
const path = require('path');
const test = require('node:test');
const { assert, assertEqual, ROOT } = require('./helpers');

const listCache = require(path.join(ROOT, 'server', 'list-cache.js'));
const cos = require(path.join(ROOT, 'server', 'cos.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test.beforeEach(() => {
  listCache.clear();
  process.env.LIST_CACHE_TTL_MS = '3000';
});

test.after(() => { delete process.env.LIST_CACHE_TTL_MS; });

/* ------------------------------ 命中与隔离 ------------------------------ */

test('同一目录的相同参数命中缓存，不同参数互不串味', () => {
  const k1 = listCache.keyOf('bkt', 'a/', '', 100, '/');
  listCache.set(k1, { contents: ['x'] });
  assertEqual(listCache.get(k1).contents[0], 'x', '相同键应命中');

  const variants = [
    listCache.keyOf('other', 'a/', '', 100, '/'),
    listCache.keyOf('bkt', 'b/', '', 100, '/'),
    listCache.keyOf('bkt', 'a/', 'cur', 100, '/'),
    listCache.keyOf('bkt', 'a/', '', 200, '/'),
    listCache.keyOf('bkt', 'a/', '', 100, ''),
  ];
  for (const k of variants) {
    assertEqual(listCache.get(k), null, `键 ${JSON.stringify(k)} 不应命中其它目录/参数的结果`);
  }
});

test('键以桶名分隔，失效时不会误伤其它桶', () => {
  listCache.set(listCache.keyOf('bkt-a', 'p/', '', 100, '/'), { v: 1 });
  listCache.set(listCache.keyOf('bkt-b', 'p/', '', 100, '/'), { v: 2 });
  assertEqual(listCache.invalidateBucket('bkt-a'), 1, '只应清掉 bkt-a 一条');
  assertEqual(listCache.get(listCache.keyOf('bkt-a', 'p/', '', 100, '/')), null, 'bkt-a 应已失效');
  assertEqual(listCache.get(listCache.keyOf('bkt-b', 'p/', '', 100, '/')).v, 2, 'bkt-b 不应被误伤');
});

/* ------------------------------ 写操作失效 ------------------------------ */

test('写操作立即失效该桶缓存（删除 / 上传 / 复制 / 分片合并）', () => {
  const key = listCache.keyOf('bkt', 'a/', '', 100, '/');
  for (const method of ['deleteObject', 'deleteMultipleObject', 'putObject', 'putObjectCopy', 'multipartComplete']) {
    listCache.clear();
    listCache.set(key, { v: 1 });
    assert(listCache.noteCall(method, { Bucket: 'bkt' }) === 1, `${method} 应失效 1 条`);
    assertEqual(listCache.get(key), null, `${method} 之后不该再读到旧缓存`);
  }
});

test('读操作不失效缓存（列举 / HEAD / 分片列举）', () => {
  const key = listCache.keyOf('bkt', 'a/', '', 100, '/');
  for (const method of ['getBucket', 'headObject', 'multipartList', 'multipartListPart', 'headBucket']) {
    listCache.clear();
    listCache.set(key, { v: 1 });
    assertEqual(listCache.noteCall(method, { Bucket: 'bkt' }), 0, `${method} 是读操作，不应失效`);
    assertEqual(listCache.get(key).v, 1, `${method} 之后缓存应保持`);
  }
});

test('未知方法一律按写处理（将来新增云端调用无需回来登记，缺省即安全）', () => {
  const key = listCache.keyOf('bkt', 'a/', '', 100, '/');
  listCache.set(key, { v: 1 });
  assert(listCache.noteCall('someFutureWriteApi', { Bucket: 'bkt' }) === 1,
    '未登记的方法必须按写处理并失效缓存');
});

test('request 仅 GET 算读，其它方法按写处理', () => {
  const key = listCache.keyOf('bkt', 'a/', '', 100, '/');
  listCache.set(key, { v: 1 });
  assertEqual(listCache.noteCall('request', { Method: 'GET', Bucket: 'bkt' }), 0, 'GET 应视为读');
  assertEqual(listCache.get(key).v, 1, 'GET 之后缓存应保持');
  assertEqual(listCache.noteCall('request', { Method: 'POST', Bucket: 'bkt' }), 1, 'POST 应视为写');
});

/* ------------------------------ 过期 / 上限 / 关闭 ------------------------------ */

test('TTL 到期后不再命中', async () => {
  process.env.LIST_CACHE_TTL_MS = '5';
  const k = listCache.keyOf('bkt', 'a/', '', 100, '/');
  listCache.set(k, { v: 1 });
  assert(listCache.get(k), '刚写入时应命中');
  await sleep(20);
  assertEqual(listCache.get(k), null, '超过 TTL 后不应命中');
  assertEqual(listCache.size(), 0, '读取时应顺带清掉过期条目');
});

test('LIST_CACHE_TTL_MS=0 可整体关闭（线上止血安全阀）', () => {
  process.env.LIST_CACHE_TTL_MS = '0';
  assertEqual(listCache.enabled(), false, 'TTL=0 应视为关闭');
  const k = listCache.keyOf('bkt', 'a/', '', 100, '/');
  listCache.set(k, { v: 1 });
  assertEqual(listCache.get(k), null, '关闭后不应写入也不应命中');
});

test('条目数有上限，不会无界增长', () => {
  for (let i = 0; i < listCache.MAX_ENTRIES + 50; i++) {
    listCache.set(listCache.keyOf('bkt', 'p' + i + '/', '', 100, '/'), { v: i });
  }
  assert(listCache.size() <= listCache.MAX_ENTRIES,
    `条目数应被限制在 ${listCache.MAX_ENTRIES} 以内（实际 ${listCache.size()}）`);
});

/* ------------------------------ 路由级集成 ------------------------------ */

test('/fs/list 命中缓存时不再访问云端，写操作后立刻重新拉取', async () => {
  const shared = require(path.join(ROOT, 'server', 'routes', '_shared.js'));
  const statsStore = require(path.join(ROOT, 'server', 'stats-store.js'));
  shared.requireConfig = () => ({ bucket: 'bkt', region: 'ap-guangzhou', provider: 'tencent' });
  statsStore.trackBucket = () => {};

  let calls = 0;
  const fakeClient = {
    getBucket(params, cb) {
      calls += 1;
      cb(null, { Contents: [{ Key: 'a/x.txt', Size: 1, LastModified: '' }], CommonPrefixes: [], IsTruncated: 'false', NextMarker: '' });
    },
    deleteObject(params, cb) { cb(null, {}); },
  };
  cos.getClient = () => fakeClient;

  const express = require(path.join(ROOT, 'node_modules', 'express'));
  const fsRoutes = require(path.join(ROOT, 'server', 'routes', 'fs.js'));
  const app = express();
  app.use((req, _res, next) => { req.authUser = { id: 'u', role: 'admin' }; next(); });
  app.use('/api', fsRoutes);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const get = (p) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      let t = '';
      res.on('data', (d) => { t += d; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(t) }));
    }).on('error', reject);
  });

  try {
    listCache.clear();
    const r1 = await get('/api/fs/list?prefix=a/');
    assertEqual(r1.status, 200, '首次列举应成功');
    assertEqual(calls, 1, '首次应访问云端');

    const r2 = await get('/api/fs/list?prefix=a/');
    assertEqual(calls, 1, '第二次应命中缓存，不再访问云端');
    assertEqual(r2.json.contents.length, 1, '缓存命中应返回同样的内容');

    // 写操作经 cos.p 这个咽喉点应立刻失效整个桶缓存，下一次列举必须重新打云端
    await cos.p(fakeClient, 'deleteObject', { Bucket: 'bkt', Region: 'r', Key: 'a/x.txt' });
    assertEqual(listCache.size(), 0, '写操作后该桶的缓存应被清空');
    await get('/api/fs/list?prefix=a/');
    assertEqual(calls, 2, '写操作之后应重新访问云端（否则用户会看到刚删掉的文件）');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
