/**
 * 测试：搜索续扫（/api/fs/search 的 cursor 语义）与单页列举的游标推导
 *
 * 背景：搜索原先是「一次 listAll 到扫描上限就截断」，超过 LIMITS.SCAN 个对象的目录
 * 永远搜不全，前端只能给出「建议进入子目录再搜索」这种把问题推回给用户的提示。
 * 改为逐页扫描 + 返回游标后，前端可原样传回继续扫描剩余部分。
 *
 * 本次刻意守住的两点（也是最容易写错的地方）：
 *  1. 中途停下（凑够 limit 或扫满单轮上限）时，游标必须落在**最后处理的那个 key**，
 *     不能是下一页的 nextMarker —— 否则同页尚未处理的对象会被永久跳过，
 *     而续扫看起来「成功了」，丢失是静默的。
 *  2. 空页 + IsTruncated=true（服务端多余忍拳）时列举必须终止，否则原地打转成死循环。
 *
 * 打桩方式说明：`cos.listPage` 内部调用的是 cos.js 的**模块私有** `p`，替换
 * `cos.p` 够不到（与 config.js 在 require 时解构属同一类陷阱）。因此这里替换
 * `cos.getClient` 返回的**客户端对象**，让私有 `p` 直接打到假客户端的 getBucket 上。
 */
process.env.LIST_SCAN_CAP = '4'; // 让单轮扫描上限小到可以用几条假数据触发

const http = require('http');
const path = require('path');
const test = require('node:test');
const { assert, assertEqual, ROOT } = require('./helpers');

/* 必须在 require 路由之前接管 ——  routes/fs.js 在 require 时就解构了 getClient / listPage */
const cos = require(path.join(ROOT, 'server', 'cos.js'));
const shared = require(path.join(ROOT, 'server', 'routes', '_shared.js'));
const statsStore = require(path.join(ROOT, 'server', 'stats-store.js'));
const listCache = require(path.join(ROOT, 'server', 'list-cache.js'));
const candidates = require(path.join(ROOT, 'server', 'search-candidates.js'));

/**
 * 清空两层进程级缓存。
 *
 * 两个都必须清：**列举页缓存**（`listCache`）与**搜索候选集**（`candidates`）
 * 都是进程级的，且候选集的键只含「桶标识 + 前缀 + 范围」—— 各用例恰好都用
 * `prefix=a/`，于是上一个用例物化的候选集会原样落到下一个用例里，表现是
 * 「这次搜索一次云端都没打」（断言到 0 次调用时会被误判成代码回归）。
 *
 * 候选集的 TTL 比页缓存的 3 秒长（默认 10 秒），所以它比页缓存更容易跨用例存活 ——
 * 早期版本只清 `listCache`，实测有 5 条用例因此变红。
 */
function resetCaches() {
  listCache.clear();
  candidates.clear();
}

shared.requireConfig = () => ({ bucket: 'bkt', region: 'ap-guangzhou', provider: 'tencent' });
statsStore.trackBucket = () => {}; // 避免把假桶名写进真实 data/stats.json

/** 当前生效的假客户端（各用例自行替换 listing 行为） */
let fakeClient = null;
cos.getClient = () => fakeClient;

/**
 * 用「假对象库」接管云端列举：按 marker 返回固定大小的一页。
 * @param {string[]} keys 已按字典序排列
 */
function useFakeStore(keys, pageSize) {
  // 列举缓存是**进程级**的：不清就会串到上一个用例的缓存上，
  // 表现是「这次搜索一次云端都没打」（断言到 0 次调用，误判为代码回归）。
  resetCaches();
  const calls = [];
  fakeClient = {
    getBucket(params, cb) {
      calls.push(params);
      const marker = params.Marker || '';
      const idx = marker ? keys.findIndex((k) => k > marker) : 0;
      const start = idx < 0 ? keys.length : idx;
      const page = keys.slice(start, start + pageSize);
      const isTruncated = start + pageSize < keys.length;
      cb(null, {
        Contents: page.map((k) => ({ Key: k, Size: 10, LastModified: '2026-01-02T03:04:05.000Z' })),
        CommonPrefixes: [],
        IsTruncated: String(isTruncated),
        NextMarker: isTruncated ? page[page.length - 1] : '',
      });
    },
  };
  return calls;
}

let server = null;
function startServer() {
  const express = require(path.join(ROOT, 'node_modules', 'express'));
  const fsRoutes = require(path.join(ROOT, 'server', 'routes', 'fs.js'));
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.use((req, _res, next) => { req.authUser = { id: 'u', username: 'u', role: 'admin' }; next(); });
  app.use('/api', fsRoutes);
  return new Promise((resolve) => {
    const s = http.createServer(app);
    s.listen(0, '127.0.0.1', () => resolve({
      port: s.address().port,
      close: () => new Promise((r) => s.close(r)),
    }));
  });
}

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET' }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(text) }); } catch (e) { resolve({ status: res.statusCode, json: null, text }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

test.before(async () => { server = await startServer(); });
test.after(async () => { if (server) await server.close(); });

const KEYS = ['a/0.txt', 'a/1.txt', 'a/2.txt', 'a/3.txt', 'a/4.txt', 'a/5.txt', 'a/6.txt', 'a/7.txt', 'a/8.txt', 'a/9.txt'];

test('扫描未触顶时：一次扫完，cursor 为空且 truncated=false', async () => {
  useFakeStore(KEYS, 3);
  const r = await get(server.port, '/api/fs/search?prefix=a/&limit=1000');
  assertEqual(r.status, 200, `搜索应成功（实际 ${r.status} ${r.json && r.json.error}）`);
  assertEqual(r.json.matches.length, 10, '全部 10 个对象都应命中（无筛选时单轮上限 2000）');
  assertEqual(r.json.cursor, '', '已扫完时游标必须为空串（前端据此隐藏「继续搜索」）');
  assertEqual(r.json.truncated, false, '已扫完不应标记 truncated');
  assertEqual(r.json.hint, '', '已扫完不应再给「可继续搜索」的提示');
});

test('单轮扫满上限后返回非空 cursor，且 hint 提示可继续', async () => {
  useFakeStore(KEYS, 3);
  const r = await get(server.port, '/api/fs/search?prefix=a/&q=.txt&limit=1000');
  assertEqual(r.status, 200, '搜索应成功');
  assertEqual(r.json.scanned, 4, '带筛选时单轮扫描上限生效（LIST_SCAN_CAP=4）');
  assert(r.json.cursor !== '', `扫满单轮上限必须返回非空游标（实际 "${r.json.cursor}"）`);
  assertEqual(r.json.truncated, true, '还有未扫描对象时应标记 truncated');
  assert(/继续搜索/.test(r.json.hint), `hint 应提示可继续搜索（实际 "${r.json.hint}"）`);
});

test('续扫能覆盖全部对象：不重不漏', async () => {
  useFakeStore(KEYS, 3);
  const seen = [];
  let cursor = '';
  for (let round = 0; round < 10; round++) {
    const url = '/api/fs/search?prefix=a/&q=.txt&limit=1000' + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    const r = await get(server.port, url);
    assertEqual(r.status, 200, `第 ${round + 1} 轮搜索应成功`);
    for (const m of r.json.matches) seen.push(m.key);
    cursor = r.json.cursor || '';
    if (!cursor) break;
  }
  assertEqual(seen.length, 10, `续扫后应恰好拿到全部 10 个对象（实际 ${seen.length}）`);
  assertEqual(new Set(seen).size, 10, '续扫结果不应重复');
  assertEqual(seen.join(','), KEYS.join(','), '续扫结果应完整且保持顺序（无遗漏）');
});

test('凑够 limit 中途停下时，游标落在最后处理的 key 而非下一页（否则同页对象被跳过）', async () => {
  useFakeStore(KEYS, 5);
  // 第一轮：limit=2，一页 5 条 → 处理到第 2 条就停
  const r1 = await get(server.port, '/api/fs/search?prefix=a/&limit=2');
  assertEqual(r1.status, 200, '第一轮应成功');
  assertEqual(r1.json.matches.length, 2, '应只返回 limit 指定的条数');
  assertEqual(r1.json.cursor, KEYS[1], `游标必须是最后处理的 key（期望 ${KEYS[1]}，实际 ${r1.json.cursor}）`);

  // 第二轮必须从未处理的 KEYS[2] 开始，而不是从下一页开头 KEYS[5]
  const r2 = await get(server.port, `/api/fs/search?prefix=a/&limit=2&cursor=${encodeURIComponent(r1.json.cursor)}`);
  assertEqual(r2.status, 200, '第二轮应成功');
  assertEqual(r2.json.matches[0].key, KEYS[2],
    `续扫必须从 KEYS[2] 起，而不是跳到下一页开头（实际 ${r2.json.matches[0].key}）` +
    ' —— 若跳页，KEYS[2]~KEYS[4] 会被永久跳过且无任何报错');
  assertEqual(r2.json.matches[1].key, KEYS[3], '续扫应连续取后续对象');
});

test('本轮正好在页边界扫满上限时，仍必须给出游标（否则剩余对象被静默丢弃）', async () => {
  // 页大小 2、单轮上限 4（LIST_SCAN_CAP=4）：两页刚好扫满 4 个 ——
  // 循环是「扫满上限」退出的，**不会**走「页内提前停」那条分支。
  // 旧实现只在该分支里写游标，于是返回 truncated=true + cursor="" ：
  // 前端只在 cursor 非空时才显示「继续搜索」，桶里剩下的对象既看不到、
  // 也无从续扫，而且界面连「结果不完整」都不提示。
  useFakeStore(KEYS, 2);
  const r = await get(server.port, '/api/fs/search?prefix=a/&q=.txt&limit=1000');
  assertEqual(r.status, 200, '搜索应成功');
  assertEqual(r.json.scanned, 4, '本轮应扫满单轮上限 4 个');
  assertEqual(r.json.truncated, true, '还有未扫描对象时应标记 truncated');
  assertEqual(r.json.cursor, KEYS[3],
    `页边界退出也必须落在最后处理的 key 上（期望 ${KEYS[3]}，实际 "${r.json.cursor}"）` +
    ' —— 游标为空等于把桶里剩余对象静默丢弃');
});

test('未变更数据时重复搜索应命中列举缓存，不再重复打云端（API 调用数）', async () => {
  const calls = useFakeStore(KEYS, 3);
  await get(server.port, '/api/fs/search?prefix=a/&q=.txt&limit=1000');
  const first = calls.length;
  assert(first > 0, '首次搜索应真的发起列举');

  // 注意：LIST_SCAN_CAP=4，首轮本就只扫 4 个，所以与首次结果比较而非写死 10
  const r1 = await get(server.port, '/api/fs/search?prefix=a/&q=.txt&limit=1000');
  const r2 = await get(server.port, '/api/fs/search?prefix=a/&q=.txt&limit=1000');
  assertEqual(r2.status, 200, '重复搜索应成功');
  assertEqual(r2.json.matches.length, r1.json.matches.length,
    '命中缓存时结果必须与首次一致（不得多给也不得少给）');
  assertEqual(r2.json.matches.map((m) => m.key).join(','), r1.json.matches.map((m) => m.key).join(','),
    '命中缓存时结果顺序与内容都应一致');
  assertEqual(calls.length, first,
    `数据未变更时重复搜索不应再打云端（首次 ${first} 次，累计 ${calls.length} 次）`);
});

test('空页 + IsTruncated=true（服务端多余忍拳）必须终止，不得死循环', async () => {
  resetCaches(); // 本用例直接替换 fakeClient，不走 useFakeStore，需自行隔离缓存
  let n = 0;
  fakeClient = {
    getBucket(params, cb) {
      n += 1;
      if (n === 1) {
        cb(null, { Contents: [{ Key: 'a/x', Size: 1, LastModified: '' }], IsTruncated: 'true', NextMarker: '' });
        return;
      }
      // 空页但仍声称未列完：若游标回退到「上一页最后一个 key」就会原地打转
      cb(null, { Contents: [], IsTruncated: 'true', NextMarker: '' });
    },
  };
  const r = await Promise.race([
    get(server.port, '/api/fs/search?prefix=a/&limit=100'),
    new Promise((_, rej) => setTimeout(() => rej(new Error('搜索未返回（疑似死循环）')), 3000)),
  ]);
  assertEqual(r.status, 200, '应正常返回而不是挂死');
  // 首轮拿到 1 条（无 NextMarker，按 key 续扫）→ 第二轮空页且无 NextMarker → 必须停下。
  // 旧实现把游标回退到「累积数组」的最后一个 key，空页时该值不变 → 原地打转成死循环。
  assertEqual(n, 2, `应在第 2 次调用后终止（实际 ${n} 次）：空页且无 NextMarker 时不得再用上一页的 key 续扫`);
  assertEqual(r.json.truncated, false, '已无法继续时应标记扫描结束');
});

test('listPage 被导出：搜索与全量列举共用同一份翻页实现', () => {
  assert(typeof cos.listPage === 'function', 'cos.listPage 必须导出，供 /fs/search 复用而非另写一份');
  assert(typeof cos.listAllInfo === 'function', 'listAllInfo 仍应可用（内部已改为复用 listPage）');
});

/* ================== 仅当前目录（scope=current）与请求可取消 ================== */

/**
 * 一棵含深层子树的假对象库：
 *   a/            目录自身（0 字节占位对象）
 *   a/1.txt a/2.txt a/4.txt
 *   a/sub/ + a/sub/{x,y,z}.txt
 *   a/sub2/ + a/sub2/p.txt
 * 递归视角 10 个对象；「仅当前目录」只应看到 5 个直接子项（不含自身占位）。
 */
const TREE = [
  'a/', 'a/1.txt', 'a/2.txt', 'a/4.txt',
  'a/sub/', 'a/sub/x.txt', 'a/sub/y.txt', 'a/sub/z.txt',
  'a/sub2/', 'a/sub2/p.txt',
];
/** 无目录占位对象的扁平目录（用于构造「恰好在页边界扫满」的场景） */
const FLAT = ['a/1.txt', 'a/2.txt', 'a/4.txt', 'a/sub/', 'a/sub2/'];

/**
 * 假对象库：同时支持递归（Delimiter=''）与单级（Delimiter='/'）两种列举语义。
 *
 * 单级语义按真实 COS 行为模拟：文件走 Contents、直接子目录走 CommonPrefixes，
 * 两者在**同一页**里混排 —— 这正是「仅当前目录」最容易写错的地方（只扫 Contents
 * 就会把子目录整页整页地丢掉，且没有任何报错）。
 *
 * @param {string[]} keys 递归视角的全量 key（无需预先排序）
 * @param {number} pageSize 每页条数
 * @param {{hang?: boolean}} [opt] hang=true 时每次列举挂起，由调用方放行（用于制造客户端中断窗口）
 * @returns {{calls: object[], pending: Function[]}}
 */
function useFakeBucket(keys, pageSize, { hang = false } = {}) {
  resetCaches(); // 列举缓存是**进程级**的：不清就会串到上一个用例
  const sorted = [...keys].sort();
  const calls = [];
  const pending = [];
  fakeClient = {
    getBucket(params, cb) {
      calls.push(params);
      const prefix = params.Prefix || '';
      const marker = params.Marker || '';
      const pool = params.Delimiter === '/'
        // 直接子项 = 目录自身占位 + 「rest 不含 '/'」的文件 + 「rest 仅以 '/' 结尾」的子目录
        ? sorted.filter((k) => {
          if (k === prefix) return true;
          if (!k.startsWith(prefix)) return false;
          const rest = k.slice(prefix.length);
          const slash = rest.indexOf('/');
          return slash === -1 || slash === rest.length - 1;
        })
        : sorted.filter((k) => k.startsWith(prefix));
      const idx = marker ? pool.findIndex((k) => k > marker) : 0;
      const start = idx < 0 ? pool.length : idx;
      const page = pool.slice(start, start + pageSize);
      const isTruncated = start + pageSize < pool.length;
      // 单级列举时子目录只通过 CommonPrefixes 暴露（真实 COS 行为）；
      // 递归列举时目录占位对象就是普通对象，必须出现在 Contents 里。
      const inContents = (k) => (params.Delimiter === '/' ? (!k.endsWith('/') || k === prefix) : true);
      const respond = () => cb(null, {
        Contents: page.filter(inContents)
          .map((k) => ({ Key: k, Size: k.endsWith('/') ? 0 : 10, LastModified: '2026-01-02T03:04:05.000Z' })),
        CommonPrefixes: params.Delimiter === '/'
          ? page.filter((k) => k.endsWith('/') && k !== prefix).map((k) => ({ Prefix: k }))
          : [],
        IsTruncated: String(isTruncated),
        NextMarker: isTruncated ? page[page.length - 1] : '',
      });
      if (hang) pending.push(respond);
      else respond();
    },
  };
  return { calls, pending };
}

/** 等待条件成立（按事件循环推进，与耗时无关） */
async function waitUntil(fn, rounds = 2000) {
  for (let i = 0; i < rounds; i++) {
    if (fn()) return true;
    await new Promise((r) => setImmediate(r));
  }
  return false;
}

test('scope=current：只列举直接子项，深层子树不再被翻页（该选项的全部收益）', async () => {
  const cur = useFakeBucket(TREE, 3);
  const rc = await get(server.port, '/api/fs/search?prefix=a/&scope=current');
  assertEqual(rc.status, 200, `仅当前目录搜索应成功（实际 ${rc.status}）`);
  assertEqual(rc.json.matches.map((m) => m.key).join(','), 'a/1.txt,a/2.txt,a/4.txt,a/sub/,a/sub2/',
    '仅当前目录应返回 5 个直接子项：不含深层文件，也不含目录自身的占位对象');
  assert(cur.calls.length > 0 && cur.calls.every((c) => c.Delimiter === '/'),
    `仅当前目录必须带 Delimiter='/' 列举（实际 ${JSON.stringify(cur.calls.map((c) => c.Delimiter))}）`);

  const rec = useFakeBucket(TREE, 3);
  const rr = await get(server.port, '/api/fs/search?prefix=a/');
  assertEqual(rr.json.matches.length, 10, '默认（递归）应命中整棵子树的 10 个对象');
  assert(rec.calls.length > cur.calls.length,
    `仅当前目录的云端列举次数必须更少（current ${cur.calls.length} 次 vs 递归 ${rec.calls.length} 次）`
    + ' —— 找当前目录的文件却翻完整棵子树，是该选项要消除的浪费');
});

test('scope=current 续扫：子目录（CommonPrefixes）与文件混排时不重不漏', async () => {
  useFakeBucket(TREE, 3);
  const seen = [];
  let cursor = '';
  for (let round = 0; round < 10; round++) {
    const url = '/api/fs/search?prefix=a/&scope=current&limit=4' + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    const r = await get(server.port, url);
    assertEqual(r.status, 200, `第 ${round + 1} 轮搜索应成功`);
    for (const m of r.json.matches) seen.push(m.key);
    cursor = r.json.cursor || '';
    if (!cursor) break;
  }
  assertEqual(seen.join(','), 'a/1.txt,a/2.txt,a/4.txt,a/sub/,a/sub2/',
    '同页内尚未处理的子目录不得被跳过 —— 不把 CommonPrefixes 与文件按键序合并就会静默丢结果');
  assertEqual(new Set(seen).size, seen.length, '续扫结果不应重复');
});

test('scope=current 在页边界扫满时也必须给出游标（否则剩余对象被静默丢弃）', async () => {
  // 页大小 2、单轮上限 4（LIST_SCAN_CAP=4）：两页刚好扫满 ——
  // 循环是「扫满上限」退出的，**不会**走「页内提前停」那条分支，游标只能来自兜底。
  useFakeBucket(FLAT, 2);
  const r = await get(server.port, '/api/fs/search?prefix=a/&scope=current&q=.txt');
  assertEqual(r.status, 200, '搜索应成功');
  assertEqual(r.json.scanned, 4, '本轮应扫满单轮上限 4 个');
  assertEqual(r.json.truncated, true, '还有未扫描对象时应标记 truncated');
  assertEqual(r.json.cursor, 'a/sub/',
    `页边界退出时游标必须落在最后处理的 key 上（期望 a/sub/，实际 "${r.json.cursor}"）`
    + ' —— 游标为空等于把桶里剩余对象静默丢弃');
});

test('listPage：本页只有 CommonPrefixes 时 nextMarker 不得为空（单级列举静默截断）', async () => {
  resetCaches(); // 直接替换 fakeClient，不走 useFakeBucket，需自行隔离缓存
  let n = 0;
  fakeClient = {
    getBucket(params, cb) {
      n += 1;
      // 页内只有子目录、没有文件，且服务端未回 NextMarker（兼容部分 S3 实现）
      cb(null, { Contents: [], CommonPrefixes: [{ Prefix: 'a/z/' }], IsTruncated: 'true', NextMarker: '' });
    },
  };
  const page = await cos.listPage(fakeClient, { bucket: 'bkt', region: 'r' }, 'a/', { delimiter: '/' });
  assertEqual(n, 1, '应只打一次云端');
  assertEqual(page.isTruncated, true, '服务端已声明未列完');
  assertEqual(page.nextMarker, 'a/z/',
    '子目录页的游标必须回退到 CommonPrefixes —— 只按 Contents 取回退值会得到空串，'
    + '调用方据此判定「已列完」，桶里剩下的页被静默丢弃');
});

test('列举缓存键必须含 delimiter：递归与仅当前目录不得命中同一份缓存', async () => {
  const { calls } = useFakeBucket(TREE, 20);
  await get(server.port, '/api/fs/search?prefix=a/&scope=current');
  const afterCurrent = calls.length;
  const rr = await get(server.port, '/api/fs/search?prefix=a/');
  assertEqual(calls.length, afterCurrent + 1,
    '递归搜索必须另起一次列举（缓存键不含 delimiter 时会命中 current 那份缓存：'
    + '用户切了范围，却拿到另一次搜索的结果）');
  assert(rr.json.matches.some((m) => m.key === 'a/sub/x.txt'),
    '递归结果必须包含深层文件 a/sub/x.txt（串味时只会拿到仅当前目录的那 5 项）');
});

test('客户端断开后服务端停止翻页（不再为注定被丢弃的响应打云端）', async () => {
  const { calls, pending } = useFakeBucket(TREE, 3, { hang: true });
  let clientReq = null;
  const settled = new Promise((resolve) => {
    clientReq = http.request(
      { host: '127.0.0.1', port: server.port, path: '/api/fs/search?prefix=a/', method: 'GET' },
      () => resolve('response'),
    );
    clientReq.on('error', () => resolve('error'));
    clientReq.end();
  });

  try {
    assert(await waitUntil(() => pending.length >= 1), '首轮列举应发起（挂起等待放行）');
    clientReq.destroy();
    // 先让服务端把「连接已断开」处理掉，再放行首页：这样第 2 页是否被发起，
    // 完全取决于服务端有没有检测中断 —— 不依赖任何墙钟阈值。
    await new Promise((r) => setTimeout(r, 60));
    pending.splice(0).forEach((fn) => fn());
    await new Promise((r) => setTimeout(r, 300)); // 给服务端推进的机会（等待，非耗时断言）

    assertEqual(calls.length, 1,
      `客户端已断开时不得再翻下一页（实际 ${calls.length} 次列举）`
      + ' —— 每多一页都是一次真实网络往返，而响应注定被前端丢弃');
  } finally {
    pending.splice(0).forEach((fn) => fn()); // 放行残留页，避免服务端 await 悬挂
    await Promise.race([settled, new Promise((r) => setTimeout(r, 200))]);
  }
});
