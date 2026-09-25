/**
 * 测试：搜索候选集（`server/search-candidates.js`）与 `/api/fs/search` 的接入
 *
 * ## 这层缓存唯一不能违反的东西
 *
 * 候选集是**可能过期的对象键清单**，只用来省掉「重复搜索时重新翻页」。因此本文件里
 * 最重要的一条不是「省了几次调用」，而是**等价性**：开关候选集、以及候选集命中与否，
 * 同一请求必须返回**逐字段相同**的结果。缓存能让搜索更快，绝不能让搜索不一样。
 *
 * ## 为什么失败模式集中在「测试隔离」与「等价性」两处
 *
 *  - 候选集是**进程级**的，且键只含「桶标识 + 前缀 + 范围」—— 各用例都用同一个
 *    prefix，不清就会串到下一个用例（表现是「一次云端都没打」）。故每个用例前
 *    统一走 `resetCaches()`。
 *  - 「省了调用」与「结果还对不对」是两件事，必须分别断言：只测前者的话，
 *    一个把结果截断的 bug 会因为「云端调用少了」而一路绿灯。
 *
 * 打桩方式与 `search-cursor.test.js` 一致：`cos.listPage` 内部走 cos.js 的
 * **模块私有** `p`，只能替换 `cos.getClient` 返回的**客户端对象**。
 */
const http = require('http');
const path = require('path');
const test = require('node:test');
const { assert, assertEqual, ROOT } = require('./helpers');

const candidates = require(path.join(ROOT, 'server', 'search-candidates.js'));
const listCache = require(path.join(ROOT, 'server', 'list-cache.js'));
const cos = require(path.join(ROOT, 'server', 'cos.js'));
const shared = require(path.join(ROOT, 'server', 'routes', '_shared.js'));
const statsStore = require(path.join(ROOT, 'server', 'stats-store.js'));

shared.requireConfig = () => ({ bucket: 'bkt', region: 'ap-guangzhou', provider: 'tencent' });
statsStore.trackBucket = () => {};
statsStore.addLog = () => {}; // 「子树太大」的告警不该写进真实 data/logs.jsonl

let fakeClient = null;
cos.getClient = () => fakeClient;

/** 两个进程级缓存都要清（候选集 TTL 比页缓存长，更容易跨用例存活） */
function resetCaches() {
  listCache.clear();
  candidates.clear();
}

/** 按需调整候选集的 TTL / 单条上限（两个值都是**每次调用时读环境变量**） */
function setCand({ ttlMs, maxItems } = {}) {
  if (ttlMs !== undefined) process.env.SEARCH_CANDIDATES_TTL_MS = String(ttlMs);
  if (maxItems !== undefined) process.env.SEARCH_CANDIDATES_MAX_ITEMS = String(maxItems);
  resetCaches();
}

/**
 * 假对象库：递归（Delimiter=''）与单级（Delimiter='/'）两种语义都支持，
 * 单级时子目录走 CommonPrefixes（真实 COS 行为）。
 * @returns {{calls: object[], writes: object[]}}
 */
function useFakeBucket(keys, pageSize) {
  resetCaches();
  const sorted = [...keys].sort();
  const calls = [];
  const writes = [];
  fakeClient = {
    getBucket(params, cb) {
      calls.push(params);
      const prefix = params.Prefix || '';
      const marker = params.Marker || '';
      const pool = params.Delimiter === '/'
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
      const inContents = (k) => (params.Delimiter === '/' ? (!k.endsWith('/') || k === prefix) : true);
      cb(null, {
        Contents: page.filter(inContents)
          .map((k) => ({ Key: k, Size: k.endsWith('/') ? 0 : 10, LastModified: '2026-01-02T03:04:05.000Z' })),
        CommonPrefixes: params.Delimiter === '/'
          ? page.filter((k) => k.endsWith('/') && k !== prefix).map((k) => ({ Prefix: k }))
          : [],
        IsTruncated: String(isTruncated),
        NextMarker: isTruncated ? page[page.length - 1] : '',
      });
    },
    // 写方法只需存在且回调成功：`cos.p()` 的成功/失败两条分支都会挂失效钩子，
    // 本文件要验的正是「写一次 → 候选集立刻不认账」这条链路。
    deleteObject(params, cb) { writes.push(params); cb(null, {}); },
    putObject(params, cb) { writes.push(params); cb(null, {}); },
  };
  return { calls, writes };
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

/** 只比较「语义字段」：`matches` 的每一项逐一比对，避免只比长度 */
function assertSameResult(a, b, label) {
  assertEqual(a.status, b.status, `${label}：HTTP 状态应一致`);
  assertEqual(JSON.stringify(a.json.matches), JSON.stringify(b.json.matches),
    `${label}：命中列表必须逐字段一致（键序、大小、类型、时间）`);
  assertEqual(a.json.scanned, b.json.scanned, `${label}：扫描计数应一致`);
  assertEqual(a.json.cursor, b.json.cursor, `${label}：续扫游标应一致`);
  assertEqual(a.json.truncated, b.json.truncated, `${label}：truncated 标记应一致`);
  assertEqual(a.json.hint, b.json.hint, `${label}：提示文案应一致`);
}

test.before(async () => { server = await startServer(); });
test.after(async () => { if (server) await server.close(); });

const KEYS = [
  'a/', 'a/1.txt', 'a/2.txt', 'a/3.txt', 'a/4.txt',
  'a/5.txt', 'a/6.txt', 'a/7.txt', 'a/8.txt', 'a/9.txt',
];

/* ============================ 单元：模块自身的契约 ============================ */

test('firstAfter：游标是独占的 —— 严格大于，重复键取首个（否则续扫会重发刚处理过的对象）', () => {
  const items = [{ key: 'a' }, { key: 'b' }, { key: 'b' }, { key: 'c' }];
  assertEqual(candidates.firstAfter(items, ''), 0, '空游标必须从头开始');
  assertEqual(candidates.firstAfter(items, 'a'), 1, '游标 a 之后应从头一个 b 开始');
  assertEqual(candidates.firstAfter(items, 'b'), 3,
    '游标 b 之后必须是严格大于 b 的位置 —— 用 >= 会把两个 b 之一再返回一次（重复结果）');
  assertEqual(candidates.firstAfter(items, 'z'), items.length, '游标超出末尾应返回长度（表示本地已读完）');
});

test('put / get：超过单条上限即整条丢弃，且此后不再接受该键（防「中间窗口」）', () => {
  setCand({ ttlMs: 60000, maxItems: 3 });
  const k = candidates.keyOf('p|s|bkt|r', 'a/', '');
  assert(candidates.put(k, { ident: 'p|s|bkt|r', prefix: 'a/', scope: '', items: [{ key: 'x' }], nextMarker: '', complete: false }),
    '未超限应写入成功');
  assert(candidates.get(k), '写入后应能取到');
  assertEqual(candidates.put(k, { ident: 'p|s|bkt|r', prefix: 'a/', scope: '', items: [{ key: '1' }, { key: '2' }, { key: '3' }, { key: '4' }], nextMarker: '', complete: false }), false,
    '超过上限必须拒绝');
  assertEqual(candidates.get(k), null, '被判定超限后必须整条丢弃（不能留半份）');
  assertEqual(candidates.size(), 0, 'store 里不应残留该键');
  assertEqual(candidates.tooBigSize(), 1, '应登记「太大」标记');
  assertEqual(candidates.put(k, { ident: 'p|s|bkt|r', prefix: 'a/', scope: '', items: [{ key: '1' }], nextMarker: '', complete: false }), false,
    'TTL 内不得再接受该键 —— 否则会从当前页重新积累出一段「中间窗口」，'
    + '续扫时窗口之前的对象会被静默漏掉');
  assertEqual(candidates.size(), 0, '仍然不应写入');
});

test('TTL 从首次物化算起，命中不续期（否则热条目永不失效，站外写入的陈旧窗口可无限延长）', async () => {
  setCand({ ttlMs: 10000, maxItems: 1000 });
  const k = candidates.keyOf('p|s|bkt|r', 'a/', '');
  const entry = { ident: 'p|s|bkt|r', prefix: 'a/', scope: '', items: [{ key: 'x' }], nextMarker: '', complete: false };
  candidates.put(k, entry);
  const at1 = candidates.get(k).at;
  await new Promise((r) => setTimeout(r, 30));
  candidates.put(k, Object.assign({}, entry, { nextMarker: 'x' }));
  assertEqual(candidates.get(k).at, at1,
    'put 覆盖已有键时不得刷新 at —— 否则「写一次就永不过期」，站外写入的陈旧窗口会被无限延长');

  // 过期判定本身（TTL 与等待留出 2 倍余量，避免慢机器上的判定漂移）
  setCand({ ttlMs: 80, maxItems: 1000 });
  candidates.put(k, entry);
  assert(candidates.get(k), '未过期应命中');
  await new Promise((r) => setTimeout(r, 200));
  assertEqual(candidates.get(k), null, '超过 TTL 后必须过期（这是「漏一处即永久不一致」不再成立的根据）');
});

test('enabled=false（TTL=0）：不读也不写，是排查数据新鲜度问题的安全阀', () => {
  setCand({ ttlMs: 0, maxItems: 1000 });
  const k = candidates.keyOf('p|s|bkt|r', 'a/', '');
  assertEqual(candidates.enabled(), false, 'TTL=0 应视为整体关闭');
  assertEqual(candidates.put(k, { ident: 'p|s|bkt|r', prefix: 'a/', scope: '', items: [{ key: 'x' }], nextMarker: '', complete: false }), false, '关闭时不得写入');
  assertEqual(candidates.size(), 0, '关闭时 store 必须为空');
  setCand({ ttlMs: 60000 });
  assertEqual(candidates.enabled(), true, '改回非零 TTL 应恢复');
});

test('keyOf：桶标识与搜索范围都进键（同名桶不同厂商、递归与单级不得互相命中）', () => {
  const a = candidates.keyOf('tencent|k1|bkt|ap-guangzhou', 'a/', '');
  const b = candidates.keyOf('tencent|k2|bkt|ap-guangzhou', 'a/', '');
  const c = candidates.keyOf('tencent|k1|bkt|ap-guangzhou', 'a/', 'current');
  const d = candidates.keyOf('tencent|k1|bkt|ap-guangzhou', 'b/', '');
  assertEqual(new Set([a, b, c, d]).size, 4, '四个维度各异必须得到四个不同的键');
});

/* ============================ 集成：/fs/search 的接入 ============================ */

test('等价性：候选集命中与未命中，同一请求的结果必须逐字段相同', async () => {
  const { calls } = useFakeBucket(KEYS, 3);

  // 1) 预热：完整枚举一次，把整棵子树物化进候选集
  setCand({ ttlMs: 60000, maxItems: 10000 });
  const warm = await get(server.port, '/api/fs/search?prefix=a/&limit=1000');
  assertEqual(warm.status, 200, '预热搜索应成功');
  assertEqual(warm.json.matches.length, 10, '预热应扫到全部 10 个对象');
  const afterWarm = calls.length;
  assert(afterWarm > 0, '预热必须真的打过云端');

  // 2) 换一个关键词再来一次：这一轮完全由候选集服务
  const warm2 = await get(server.port, '/api/fs/search?prefix=a/&q=.txt&limit=1000');
  assertEqual(calls.length, afterWarm,
    `命中候选集后不应再打云端（预热 ${afterWarm} 次，累计 ${calls.length} 次）`
    + ' —— 这正是这层缓存的全部收益');
  // `q` 按**基础名**匹配，故目录占位对象 `a/`（基础名 "a"）不算命中：10 个键里命中 9 个
  assertEqual(warm2.json.matches.length, 9, '从候选集过滤也必须拿到全部 9 个 .txt 对象');

  // 3) 关掉候选集、清干净重跑同一请求，结果必须一模一样
  setCand({ ttlMs: 0 });
  const cold = await get(server.port, '/api/fs/search?prefix=a/&q=.txt&limit=1000');
  assertSameResult(warm2, cold, '候选集开/关');

  setCand({ ttlMs: 60000 });
});

test('等价性（分批续扫）：候选集存在时逐轮续扫，结果与纯扫描完全相同', async () => {
  /** 逐轮续扫，返回「每轮游标」与「每轮命中」两条序列（分开收集，便于定位差异） */
  async function sweep() {
    const cursors = [];
    const hits = [];
    let cur = '';
    for (let i = 0; i < 12; i++) {
      const r = await get(server.port, `/api/fs/search?prefix=a/&limit=3${cur ? `&cursor=${encodeURIComponent(cur)}` : ''}`);
      assertEqual(r.status, 200, '续扫每轮都应成功');
      hits.push(...r.json.matches.map((m) => m.key));
      cursors.push(r.json.cursor);
      cur = r.json.cursor || '';
      if (!cur) break;
    }
    return { cursors, hits };
  }

  // 冷路径：候选集关闭，纯逐页扫描作为基准
  setCand({ ttlMs: 0 });
  useFakeBucket(KEYS, 2);
  const cold = await sweep();

  // 暖路径：候选集全程开启，同样逐轮续扫
  setCand({ ttlMs: 60000, maxItems: 10000 });
  const { calls } = useFakeBucket(KEYS, 2); // 页更小 → 更依赖续扫
  const warm = await sweep();

  assertEqual(warm.cursors.join('|'), cold.cursors.join('|'),
    '每轮的续扫游标必须与纯扫描完全一致（游标错了会静默漏对象）');
  assertEqual(warm.hits.join('|'), cold.hits.join('|'),
    '每轮的命中序列必须与纯扫描完全一致 —— 候选集只允许让同一序列更便宜，不允许让它改变');
  assertEqual(new Set(warm.hits).size, warm.hits.length, '续扫结果不应重复');
  assertEqual(warm.hits.length, 10, `应恰好覆盖 10 个对象（实际 ${warm.hits.length}）`);
  assertEqual(warm.hits.join(','), KEYS.join(','), '续扫结果应完整且保持键序');
  assert(calls.length > 0, '暖路径首轮没有候选集可用，仍应打过云端');
});

test('候选集的增量：关掉列举缓存后，重复搜索仍然不打云端（否则这层缓存等于没做）', async () => {
  /*
   * 这条用例的存在理由，恰恰是「另外那些用例抓不到它」：
   * `listCache` 的 TTL 是秒级、且接入候选集**之前**就已经存在，于是「重复搜索免费」
   * 这件事在 `cand = null`（等价于接入前的状态）下**照样成立** —— 只测这一点的用例
   * 会一路绿灯，却没有任何东西能证明候选集真的接进了路由。
   *
   * 所以这里把列举缓存**整体关掉**（TTL=0）：此时能让第二轮不打云端的只剩候选集。
   * 用「开关」而不是「等 TTL 过期」是为了不引入任何计时依赖，结论是确定的。
   */
  const prevListTtl = process.env.LIST_CACHE_TTL_MS;
  try {
    process.env.LIST_CACHE_TTL_MS = '0'; // 页缓存彻底停用
    const { calls } = useFakeBucket(KEYS, 3);
    setCand({ ttlMs: 60000, maxItems: 10000 });

    const first = await get(server.port, '/api/fs/search?prefix=a/&limit=1000');
    assertEqual(first.status, 200, '首轮应成功');
    assertEqual(first.json.matches.length, 10, '首轮应扫到全部 10 个对象');
    const afterFirst = calls.length;
    assert(afterFirst > 0, '首轮必须真的打过云端');

    const second = await get(server.port, '/api/fs/search?prefix=a/&limit=1000');
    assertEqual(calls.length, afterFirst,
      `页缓存已停用时，第二轮仍不得打云端（首轮 ${afterFirst} 次，累计 ${calls.length} 次）`
      + ' —— 这是候选集相对 listCache 的**增量**，也是它唯一的收益');
    assertEqual(second.json.matches.length, 10, '命中候选集也必须返回完整结果（快，但不能变少）');
  } finally {
    if (prevListTtl === undefined) delete process.env.LIST_CACHE_TTL_MS;
    else process.env.LIST_CACHE_TTL_MS = prevListTtl;
  }
});

test('写操作立即失效：云端写入后候选集不再被使用，必须重新列举', async () => {
  const { calls, writes } = useFakeBucket(KEYS, 3);
  setCand({ ttlMs: 60000, maxItems: 10000 });

  await get(server.port, '/api/fs/search?prefix=a/&limit=1000'); // 预热
  const afterWarm = calls.length;
  await get(server.port, '/api/fs/search?prefix=a/&q=.txt&limit=1000');
  assertEqual(calls.length, afterWarm, '前置条件：未变更时第二轮不该打云端');

  // 走真正的云端出口写一次 —— 失效链是 p() → listCache.noteCall() → 本模块的订阅者
  await cos.p(fakeClient, 'deleteObject', { Bucket: 'bkt', Key: 'a/1.txt' });
  assertEqual(writes.length, 1, '假客户端应收到一次写调用');
  assertEqual(candidates.size(), 0,
    '写操作必须立即清掉该桶的候选集 —— 否则用户会在 TTL 内一直看到「刚删掉的文件还在」');

  const afterWrite = calls.length;
  await get(server.port, '/api/fs/search?prefix=a/&q=.txt&limit=1000');
  assert(calls.length > afterWrite,
    `写后必须重新列举（写前 ${afterWrite} 次，写后累计 ${calls.length} 次）`);
});

test('写失败同样失效：p() 的成功与失败两条分支都挂失效钩子', async () => {
  const { calls } = useFakeBucket(KEYS, 3);
  // 让写调用失败
  fakeClient.deleteObject = (params, cb) => cb(new Error('ETIMEDOUT'));
  setCand({ ttlMs: 60000, maxItems: 10000 });

  await get(server.port, '/api/fs/search?prefix=a/&limit=1000');
  await get(server.port, '/api/fs/search?prefix=a/&q=.txt&limit=1000');
  const before = calls.length;

  await cos.p(fakeClient, 'deleteObject', { Bucket: 'bkt', Key: 'a/1.txt' }).catch(() => {});
  assertEqual(candidates.size(), 0,
    '写入**失败**也可能已经部分生效，同样必须失效 —— 少失效一次就会让用户看到陈旧结果');

  await get(server.port, '/api/fs/search?prefix=a/&q=.txt&limit=1000');
  assert(calls.length > before, '写失败后也应重新列举');
});

test('超过物化上限：整条丢弃并退回逐页列举，结果仍然完整（宁可退化，不可让内存失控）', async () => {
  const { calls } = useFakeBucket(KEYS, 3);
  setCand({ ttlMs: 60000, maxItems: 3 }); // 上限压到 3，任何一次翻页都会越界

  const r1 = await get(server.port, '/api/fs/search?prefix=a/&limit=1000');
  assertEqual(r1.status, 200, '超限应退化而不是报错');
  assertEqual(r1.json.matches.length, 10, '退化后结果仍必须完整（10 个对象）');
  assertEqual(candidates.size(), 0, '超限的键不得留在 store 里');
  assertEqual(candidates.tooBigSize(), 1, '应登记「太大」标记');

  // 第二次请求：不得因为「本轮从头又攒了几页」而重新物化出一段中间窗口
  const r2 = await get(server.port, '/api/fs/search?prefix=a/&limit=1000');
  assertEqual(JSON.stringify(r2.json.matches), JSON.stringify(r1.json.matches), '退化后的结果必须稳定');
  assertEqual(candidates.size(), 0,
    '仍不得物化 —— 从当前页重新积累会得到「中间窗口」而非从头开始的连续前缀，'
    + '续扫时会静默漏掉窗口之前的对象');
  assert(calls.length > 0, '退化路径每次都要真扫');
});

test('scope 分离：递归与「仅当前目录」不得互相命中候选集', async () => {
  const TREE = ['a/', 'a/1.txt', 'a/2.txt', 'a/sub/', 'a/sub/x.txt', 'a/sub/y.txt'];
  const { calls } = useFakeBucket(TREE, 3);
  setCand({ ttlMs: 60000, maxItems: 10000 });

  const rc = await get(server.port, '/api/fs/search?prefix=a/&scope=current');
  assertEqual(rc.status, 200, '仅当前目录搜索应成功');
  assertEqual(rc.json.matches.map((m) => m.key).join(','), 'a/1.txt,a/2.txt,a/sub/',
    '仅当前目录应只看到 3 个直接子项');
  const afterCurrent = calls.length;

  const rr = await get(server.port, '/api/fs/search?prefix=a/');
  assertEqual(rr.status, 200, '递归搜索应成功');
  assertEqual(rr.json.matches.length, 6,
    '递归应看到子树里全部 6 个键：「仅当前目录」不返回目录占位对象，递归则把它当普通对象返回');
  assert(rr.json.matches.some((m) => m.key === 'a/sub/x.txt'), '递归结果必须包含深层文件');
  assert(calls.length > afterCurrent,
    '递归必须另起列举（候选集键含 scope，命中 current 那份会让用户切了范围却拿到另一次搜索的结果）');
});

test('客户端断开后服务端停止翻页（候选集不得绕过中断检测）', async () => {
  // 候选集为空 → 每一条都要打云端；把服务端挂在第一页上，制造中断窗口
  setCand({ ttlMs: 60000, maxItems: 10000 });
  const calls = [];
  const pending = [];
  fakeClient = {
    getBucket(params, cb) {
      calls.push(params);
      pending.push(() => cb(null, {
        Contents: [{ Key: 'a/1.txt', Size: 10, LastModified: '' }],
        CommonPrefixes: [], IsTruncated: 'true', NextMarker: 'a/1.txt',
      }));
    },
  };

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
    for (let i = 0; i < 2000 && pending.length < 1; i++) await new Promise((r) => setImmediate(r));
    assert(pending.length >= 1, '首轮列举应发起（挂起等待放行）');
    clientReq.destroy();
    await new Promise((r) => setTimeout(r, 60));
    pending.splice(0).forEach((fn) => fn());
    await new Promise((r) => setTimeout(r, 300));

    assertEqual(calls.length, 1,
      `客户端已断开时不得再翻下一页（实际 ${calls.length} 次列举）—— 每多一页都是一次真实网络往返，`
      + '而响应注定被前端丢弃');
  } finally {
    pending.splice(0).forEach((fn) => fn());
    await Promise.race([settled, new Promise((r) => setTimeout(r, 200))]);
  }
});
