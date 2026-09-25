/**
 * 第十四轮 · 性能与「本地收口」批次的回归护栏
 *
 * 覆盖 R14-08 / R14-09 / R14-10 / R14-12 —— 报告 ANALYSIS-ROUND14 §3.1 的 P2 批次。
 * 这四条表面是四个问题，本质是同一件事：**某条高频路径缺少「去抖 / 缓存 / 并发合并」
 * 中的某一层**。修复的载体是 §3.2(1) 建议抽出的共享原语 `server/coalesce.js`，
 * 因此本文件的后半部分同时在验原语本身与它的四处接线。
 *
 * 为什么单独一个文件、独立进程：本文件要观测「一次云端调用被打了几次」，
 * 需要在 require 路由**之前**替换 `cos.getClient`（路由在加载时就解构了它），
 * 而别的 audit 文件已经在同一进程里更换过同一批句柄 —— 互相污染。
 *
 * 每条护栏都做了反向对照（见 `scripts/reverse-check.js` 的 R14-08 / R14-09 /
 * R14-10 / R14-12 条目）：**退回旧实现时这里必须变红**。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const test = require('node:test');

const { ROOT, assert, assertEqual, cleanupTempDir } = require('./helpers.js');

/* ------------------------------------------------------------------ *
 * 0 · 隔离（必须在 require 任何 server 模块之前）
 * ------------------------------------------------------------------ */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-audit14perf-'));
process.env.COS_DATA_DIR = TMP;
// 本文件要观测「去抖窗口内合并成几次写」，故用**默认**的 300ms 窗口，
// 不设 PAYMENT_WRITE_DEBOUNCE_MS（设 0 会让整条去抖路径失效，等于自我关灯）。

const express = require(path.join(ROOT, 'node_modules', 'express'));
const coalesce = require(path.join(ROOT, 'server', 'coalesce.js'));
const secureStore = require(path.join(ROOT, 'server', 'secure-store.js'));
const configStore = require(path.join(ROOT, 'server', 'config-store.js'));
const statsStore = require(path.join(ROOT, 'server', 'stats-store.js'));
const listCache = require(path.join(ROOT, 'server', 'list-cache.js'));
const security = require(path.join(ROOT, 'server', 'security.js'));

const logs = [];
statsStore.addLog = (e) => { logs.push(e || {}); };
statsStore.trackBucket = () => {};

/* ---- 假云端客户端：**回调风格**（`cos.p` 走 `cos[method](params, cb)`） ---- */
const cloud = {
  calls: [],
  head: 'ok', // ok | notfound | error
  /**
   * 探测的**人为延迟**。
   *
   * ⚠️ 造「并发」必须靠它：假客户端的回调是**同步**触发的，
   * 第一次探测会在下一个微任务里就完成 —— 后到的请求于是命中结果缓存，
   * 「有没有 in-flight 去重」这件事根本观测不出来（撤掉 singleFlight 也照样只打一次，
   * 反向对照会假绿）。注入延迟才能造出「其余请求仍在飞」的真实交叠。
   */
  headDelay: 0,
  listDelay: 0,
  contents: [],
};

const resetCalls = () => { cloud.calls.length = 0; };
const countOf = (method) => cloud.calls.filter((c) => c.method === method).length;

cloud.headObject = (params, cb) => {
  cloud.calls.push({ method: 'headObject', params });
  const finish = () => {
    if (cloud.head === 'notfound') {
      const e = new Error('Not Found');
      e.code = 'NoSuchKey';
      cb(e);
      return;
    }
    if (cloud.head === 'error') {
      // 非 404 的失败：网络 / 鉴权 / 超时 —— 既不改判，也必须留痕
      const e = new Error('stub upstream failure');
      e.code = 'InternalError';
      cb(e);
      return;
    }
    cb(null, { headers: { 'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT' } });
  };
  if (cloud.headDelay > 0) setTimeout(finish, cloud.headDelay);
  else finish();
};

cloud.getBucket = (params, cb) => {
  cloud.calls.push({ method: 'getBucket', params });
  const finish = () => cb(null, { Contents: cloud.contents, CommonPrefixes: [], IsTruncated: 'false' });
  // 同 headDelay：不注入延迟就造不出「其余请求仍在飞」，singleFlight 那一层测不出来
  if (cloud.listDelay > 0) setTimeout(finish, cloud.listDelay);
  else finish();
};

cloud.putObject = (params, cb) => {
  cloud.calls.push({ method: 'putObject', params });
  cb(null, {});
};

const cos = require(path.join(ROOT, 'server', 'cos.js'));
cos.getClient = () => cloud; // 必须在 require 路由之前替换（路由加载时即解构）

configStore.effectiveForBucket = () => ({
  bucket: 'tb', region: 'ap-guangzhou', provider: 'tencent', secretId: 'sid', secretKey: 'skey',
});

const shared = require(path.join(ROOT, 'server', 'routes', '_shared.js'));
shared.requireConfig = () => ({
  bucket: 'tb', region: 'ap-guangzhou', provider: 'tencent', secretId: 'sid', secretKey: 'skey',
});

const paymentOrders = require(path.join(ROOT, 'server', 'payment-orders.js'));
const shareStore = require(path.join(ROOT, 'server', 'share-store.js'));
const shareRoutes = require(path.join(ROOT, 'server', 'share-routes.js'));
const fsRoutes = require(path.join(ROOT, 'server', 'routes', 'fs.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 起一个只挂指定路由的本地服务 */
async function serve(mount, router) {
  const app = express();
  app.use(express.json());
  app.use(mount, router);
  const server = await new Promise((resolve) => {
    const s = http.createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  return { port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}

/** 发一个请求，返回 { status, text, json } */
function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET' }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(text); } catch (e) { /* 分享页是 HTML */ }
        resolve({ status: res.statusCode, text, json: body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/* ================================================================== *
 * 一 · coalesce 原语本身（唯一实现点）
 * ================================================================== */

test('去抖合并写：窗口内多次 schedule 合并为一次，且快照在落盘那一刻才取', async () => {
  const writes = [];
  let state = 1;
  const w = coalesce.debouncedPersist(path.join(TMP, 'coalesce-a.json'), () => ({ v: state }), {
    debounceMs: 60,
    write: (_f, snap) => { writes.push(snap.v); },
    writeSync: () => {},
  });

  w.schedule();
  state = 2;
  w.schedule();
  state = 3;
  w.schedule();

  assertEqual(writes.length, 0,
    '窗口内不得落盘 —— 中间态既没人读也活不过一个去抖窗口，落盘就是纯浪费');
  await sleep(140);
  assertEqual(writes.length, 1,
    `三次变更必须合并成一次落盘（实际 ${writes.length} 次）—— 这正是 R14-09 要压掉的那部分放大`);
  assertEqual(writes[0], 3,
    '落盘时必须取**最新**快照（在落盘那一刻取值），否则会把中间态当成最终态写下去');
});

test('去抖合并写：快照返回 null 表示「本次不写」，debounceMs=0 是立即写的逃生阀', async () => {
  let n = 0;
  const nullW = coalesce.debouncedPersist(path.join(TMP, 'coalesce-b.json'), () => null, {
    debounceMs: 20, write: () => { n++; }, writeSync: () => { n++; },
  });
  nullW.schedule();
  await sleep(70);
  assertEqual(n, 0, '快照为 null 表示「不写」（调用方用它表达「已锁定写入」），不得落盘');

  let m = 0;
  const nowW = coalesce.debouncedPersist(path.join(TMP, 'coalesce-c.json'), () => ({ a: 1 }), {
    debounceMs: 0, write: () => { m++; }, writeSync: () => { m++; },
  });
  nowW.schedule();
  assertEqual(m, 1, 'PAYMENT_WRITE_DEBOUNCE_MS=0 这类逃生阀必须退回「立即写」');
});

test('退出收口：目录不存在时只写不建（不复活被清理的 data/），存在时同步落盘一次', () => {
  const ghostDir = path.join(TMP, 'ghost-dir-not-exist');
  let ghost = 0;
  coalesce.debouncedPersist(path.join(ghostDir, 'g.json'), () => ({ a: 1 }), {
    debounceMs: 100000, write: () => { ghost++; }, writeSync: () => { ghost++; },
  }).schedule();
  coalesce.flushAllSync();
  assertEqual(ghost, 0,
    '退出路径「只写不建」：目录不存在就连写都不写 —— 否则测试/运维刚删掉的 data/ 会被自己的退出钩子复活（历史上泄漏过 134 个临时目录）');
  assertEqual(fs.existsSync(ghostDir), false, '退出路径绝不能创建数据目录');

  const liveDir = path.join(TMP, 'live-dir');
  fs.mkdirSync(liveDir, { recursive: true });
  let live = 0;
  coalesce.debouncedPersist(path.join(liveDir, 'l.json'), () => ({ a: 1 }), {
    debounceMs: 100000, write: () => {}, writeSync: () => { live++; },
  }).schedule();
  coalesce.flushAllSync();
  assertEqual(live, 1,
    '目录存在时必须同步落盘 —— `process.on(exit)` 返回后进程立即终止，异步写的回调永远排不上，一个字节都落不下去');
});

test('并发合并读：同键并发只算一次，结算后释放，且失败不缓存', async () => {
  let calls = 0;
  const ps = [0, 1, 2, 3].map(() => coalesce.singleFlight('k1', async () => {
    calls++;
    await sleep(20);
    return 'v';
  }));
  const vals = await Promise.all(ps);
  assertEqual(calls, 1, '同一 key 上的并发调用必须共享一次真正的计算（R14-10 / R14-12 的放大倍数就是这么压掉的）');
  assert(vals.every((v) => v === 'v'), '所有并发调用者必须拿到同一个结果值');
  assertEqual(coalesce.singleFlightSize(), 0,
    '结算后必须释放条目 —— 不释放就是一条无界内存增长路径（FUN-12 同型）');

  let failed = 0;
  for (let i = 0; i < 2; i++) {
    // eslint-disable-next-line no-await-in-loop
    await coalesce.singleFlight('k2', async () => { failed++; throw new Error('boom'); }).catch(() => {});
  }
  assertEqual(failed, 2,
    '失败**不缓存**：一次瞬时抖动被缓存下来就会变成一段时间的持续故障');
  assertEqual(coalesce.singleFlightSize(), 0, '失败的条目同样必须被释放');
});

/* ================================================================== *
 * 二 · R14-08：secure-store 的「异步写」必须真的离开调用栈
 * ================================================================== */

test('R14-08 · writeJsonAsync 返回之前不得同步做全量加密（缩进也已去掉）', async () => {
  const file = path.join(TMP, 'r14-08.json');
  const origEncrypt = configStore.encrypt;
  let atCallTime = 0;
  let total = 0;
  configStore.encrypt = (obj) => { total++; return origEncrypt(obj); };
  try {
    const p = secureStore.writeJsonAsync(file, { hello: 'world' });
    atCallTime = total; // 此刻 Promise 刚拿到手
    await p;
    await secureStore.flush();
  } finally {
    configStore.encrypt = origEncrypt;
  }
  assertEqual(atCallTime, 0,
    '`JSON.stringify` + AES-256-GCM 全量加密必须发生在**写队列之内**：'
    + '旧实现把它放在入队之前，于是"异步写"对调用方仍是一次同步全表加密 —— '
    + 'enc-meta 到 5 万条时单次约百毫秒级纯阻塞，删大目录会叠成数秒的事件循环停顿');
  assertEqual(total, 1, '一次 writeJsonAsync 恰好加密一次');

  const raw = fs.readFileSync(file, 'utf8');
  assertEqual(JSON.parse(raw)._enc, 1, '落盘必须仍是加密封装（_enc=1）');
  assertEqual(raw.indexOf('\n'), -1,
    'R14-08：不得再带 `JSON.stringify(..., null, 1)` 的缩进 —— 这个字符串唯一的消费者是 JSON.parse，'
    + '缩进既换不来可读性（data 是一整串密文），又让体积成倍膨胀');

  const dec = secureStore.readJson(file, null);
  assertEqual(dec && dec.hello, 'world', '去掉缩进后必须仍能解回原值');
});

/* ================================================================== *
 * 三 · R14-09：订单落盘去抖
 * ================================================================== */

test('R14-09 · 一次支付流程的多次状态变更合并为一次落盘（窗口内不写盘）', async () => {
  const origWrite = secureStore.writeJsonAsync;
  let writes = 0;
  const payloads = [];
  secureStore.writeJsonAsync = (f, snap) => { writes++; payloads.push(snap); return Promise.resolve(); };
  let o;
  try {
    o = paymentOrders.create({ linkId: 'R14-09', platform: 'alipay', amountFen: 100, currency: 'CNY' });
    paymentOrders.setTradeNo(o.id, 'trade-1');
    paymentOrders.markPaid(o.id);
    paymentOrders.markDownloaded(o.id);
    assertEqual(writes, 0,
      '去抖窗口内一次都不该落盘 —— 旧实现这 4 次状态变更会各触发一次全量序列化 + 加密 + 写盘，'
      + '而 POST /s/:id/pay 匿名可达，属典型的「温水型」性能债');

    await sleep(450); // 默认窗口 300ms
    assertEqual(writes, 1,
      `窗口到期后必须合并成 1 次落盘（实际 ${writes} 次）—— 真正需要落盘的只有最后一次状态`);
    const last = payloads[payloads.length - 1];
    assert(last && last.orders && last.orders.some((x) => x.id === o.id && x.status === 'paid' && x.downloadedAt),
      '合并后的快照必须包含**最新**状态（paid + downloadedAt），而不是窗口内第一次变更的快照');
  } finally {
    secureStore.writeJsonAsync = origWrite;
  }
});

test('R14-09 · flush() 必须立刻把待写内容落盘（优雅停机不能丢最后一次变更）', async () => {
  const origWrite = secureStore.writeJsonAsync;
  let writes = 0;
  secureStore.writeJsonAsync = () => { writes++; return Promise.resolve(); };
  try {
    const o = paymentOrders.create({ linkId: 'R14-09-flush', platform: 'alipay', amountFen: 1, currency: 'CNY' });
    paymentOrders.markPaid(o.id);
    assertEqual(writes, 0, '前置：窗口内尚未落盘');
    paymentOrders.flush();
    assertEqual(writes, 1,
      'flush() 必须立刻落盘 —— 停机时若不刷，去抖窗口内的最后一次变更（如 `paid`）会丢，'
      + '重启后订单退回 pending：钱付了却查不到已付');
  } finally {
    secureStore.writeJsonAsync = origWrite;
  }
});

/* ================================================================== *
 * 四 · R14-10：分享页存在性探测
 * ================================================================== */

let shareSrv = null;
async function shareServer() {
  if (!shareSrv) shareSrv = await serve('/', shareRoutes);
  return shareSrv;
}

/**
 * 造一条链接（无密码、不付费、永久有效、不限次数）。
 *
 * ⚠️ 必须 `await`：`shareStore.create()` 为了加密落盘而是异步的，
 * 直接取它的返回值会拿到 Promise —— `l.id` 为 undefined，请求打到 `/s/undefined` 得 404，
 * 而失败信息会指向「分享页渲染」，与真正的原因（忘了 await）差着十万八千里。
 */
function makeLink(bucket, key, extra = {}) {
  return shareStore.create(Object.assign({
    key, bucket, region: 'ap-guangzhou', fileName: key.split('/').pop(), size: 1024,
    expiresHours: 0, maxDownloads: 0, password: null, paid: null, createdBy: 'tester',
  }, extra));
}

test('R14-10 · 同一分享页的并发访问只探测一次（in-flight 去重）', async () => {
  const l = await makeLink('tb-probe-dedupe', 'p/one.bin');
  assert(l && l.id, '前置：链接必须创建成功');
  cloud.head = 'ok';
  cloud.headDelay = 60; // 见 cloud.headDelay 的说明：不注入延迟就观测不到「在飞」
  const srv = await shareServer();
  resetCalls();
  try {
    const rs = await Promise.all([0, 1, 2, 3, 4].map(() => get(srv.port, `/s/${l.id}`)));
    assert(rs.every((r) => r.status === 200), '分享页应正常渲染（实际状态：' + rs.map((r) => r.status).join(',') + '）');
    assertEqual(countOf('headObject'), 1,
      `5 个并发请求必须只打 1 次 headObject（实际 ${countOf('headObject')} 次）—— `
      + '旧实现把结果写进缓存的动作在 await **之后**，于是并发请求各自发起一次探测：'
      + '云端调用数与费用被 N 倍放大（匿名可达、无需任何凭据），慢桶下还会各持一条连接挂满 120 秒');
  } finally {
    cloud.headDelay = 0;
  }
});

test('R14-10 · 探测失败必须留下 warn 日志，且页面仍按 fail-open 可用', async () => {
  const l = await makeLink('tb-probe-log', 'p/two.bin');
  cloud.head = 'error';
  const srv = await shareServer();
  resetCalls();
  const before = logs.length;

  const r = await get(srv.port, `/s/${l.id}`);
  const probes = logs.slice(before).filter((e) => e.action === 'share.probe');
  assertEqual(probes.length, 1,
    '非 404 的探测失败必须写一条 share.probe 日志 —— 旧实现被外层 `catch` 完全吞掉、零日志，'
    + '凭据失效 / 桶被删 / 端点不可达对运维完全不可见');
  assertEqual(probes[0].level, 'warn', '这是故障信号，必须是 warn 级');
  assert(String(probes[0].detail).includes(l.id), '日志里必须能定位到是哪条链接');
  assertEqual(r.status, 200,
    '「非 404 一律 fail-open」的取舍**不变**：只有明确的 404 才算文件没了，'
    + '否则一次临时抖动会把所有分享页打成错误页');

  // 失败也留短期缓存：紧接着的第二次访问不再打云端（否则就是每个请求各探一次）
  resetCalls();
  await get(srv.port, `/s/${l.id}`);
  assertEqual(countOf('headObject'), 0,
    '探测失败后必须落一条**短期**缓存（EXISTS_FAIL_TTL_MS）把重试频率压到有界；'
    + '只挡成功、不挡失败等于没挡住 R14-10 的那条放大路径');
  cloud.head = 'ok';
});

test('R14-10 · GET /s/:id 必须受限流保护（此前该处理器完全没有限流器）', async () => {
  const l = await makeLink('tb-view-limit', 'p/three.bin');
  const srv = await shareServer();
  cloud.head = 'ok';
  // 直接把该 IP 的预算耗光：本机请求的来源 IP 恒为 127.0.0.1
  for (let i = 0; i < 400; i++) security.shareViewLimiter('127.0.0.1');
  const r = await get(srv.port, `/s/${l.id}`);
  assertEqual(r.status, 429,
    '分享页查看必须走 shareViewLimiter（300 次/10 分钟/IP）—— '
    + '该处理器此前没有任何限流器，匿名访客并发请求同一 URL 就能把云端探测放大约 N 倍');
});

/* ================================================================== *
 * 五 · R14-12：/fs/stat 的文件夹计数
 * ================================================================== */

let fsSrv = null;
async function fsServer() {
  if (!fsSrv) fsSrv = await serve('/api', fsRoutes);
  return fsSrv;
}

test('R14-12 · 同一目录重复 stat 走短缓存，写操作后立即失效', async () => {
  const srv = await fsServer();
  cloud.contents = [{ Key: 'd1/a.bin', Size: 10 }, { Key: 'd1/b.bin', Size: 20 }];
  delete process.env.LIST_CACHE_TTL_MS; // 用默认 TTL（3 秒）
  listCache.clear();

  resetCalls();
  const first = await get(srv.port, '/api/fs/stat?path=d1/');
  assertEqual(first.status, 200, `首次 stat 应成功（实际 ${first.status} ${first.text}）`);
  assertEqual(first.json.objectCount, 2, '对象总数应排除目录标记对象');
  assertEqual(countOf('getBucket'), 1, '首次必须真去列举');

  const second = await get(srv.port, '/api/fs/stat?path=d1/');
  assertEqual(countOf('getBucket'), 1,
    `同一目录的重复 stat 必须命中短缓存（实际又列举了 ${countOf('getBucket') - 1} 次）—— `
    + '该路由此前既无限流也不走 list-cache，而它是串行翻页（默认上限 2 万 → 最多约 21 次云端往返），'
    + '前端属性面板的自动刷新与多标签页会自然把它放大成云端请求风暴');
  assertEqual(second.json.objectCount, 2, '缓存命中时载荷必须仍然正确');

  // 写操作 → cos.p 的咽喉点统一失效整个桶
  // eslint-disable-next-line global-require
  await require(path.join(ROOT, 'server', 'cos.js')).p(cloud, 'putObject',
    { Bucket: 'tb', Region: 'ap-guangzhou', Key: 'd1/c.bin' });

  await get(srv.port, '/api/fs/stat?path=d1/');
  assertEqual(countOf('getBucket'), 2,
    '写操作必须立刻让该桶的 stat 缓存失效 —— 否则用户刚传完文件再看属性会读到旧数字');
});

test('R14-12 · 同一目录的并发 stat 只列举一次（并发合并，与缓存相互独立）', async () => {
  const srv = await fsServer();
  cloud.contents = [{ Key: 'd2/a.bin', Size: 1 }];
  // 关掉列举缓存：此时只剩 singleFlight 这一层，才能单独验它
  process.env.LIST_CACHE_TTL_MS = '0';
  listCache.clear();
  resetCalls();
  cloud.listDelay = 30; // 造出真正交叠的并发（见 cloud.listDelay 的说明）
  try {
    await Promise.all([0, 1, 2].map(() => get(srv.port, '/api/fs/stat?path=d2/')));
    assertEqual(countOf('getBucket'), 1,
      `缓存关闭时 3 个并发请求仍必须只列举 1 次（实际 ${countOf('getBucket')} 次）—— `
      + '这就是 singleFlight 那一层；少了它，属性面板多开几个标签页就等于把云端调用乘以标签数');
  } finally {
    cloud.listDelay = 0;
    delete process.env.LIST_CACHE_TTL_MS;
  }
});

/* ================================================================== *
 * 收尾
 * ================================================================== */

test.after(async () => {
  if (shareSrv) await shareSrv.close();
  if (fsSrv) await fsSrv.close();
  await cleanupTempDir(TMP, {
    label: 'audit14-perf',
    flushers: [
      { name: 'payment-orders', flush: () => paymentOrders.flush() },
      { name: 'secure-store', flush: () => secureStore.flush() },
    ],
  });
});
