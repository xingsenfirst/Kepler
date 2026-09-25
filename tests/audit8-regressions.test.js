/**
 * 测试：第 8 轮审计修复的回归护栏（见开发文档「六、审计发现台账 6.4」）
 *
 * 编排原则与前几轮一致：
 *  - 断言打在**行为**上，不打在源码文本上；
 *  - 起真实 express + 真实路由，只把最外层的云端调用（`cos.p` / `cos.getClient`）打桩；
 *  - 打桩必须在 require 路由**之前**完成 —— 路由在模块加载时就解构了这些函数；
 *  - 数据目录用 `COS_DATA_DIR` 指到临时目录，不触碰项目真实 data/。
 *
 * 本文件覆盖的编号：
 *   R8-02 magic 分片上限（同时是厂商协议下限）
 *   R8-03 覆盖写入后的元数据对账（明文覆盖必须清掉旧密文元数据）
 *   R8-11 list-cache 键的调用方命名空间
 *   R8-12 「当前密码不正确」不得回 401（否则前端当成会话过期并强制登出）
 *   R8-21 分片列举缓存必须有容量上限
 *   R8-24 `markMissingByBucket` 与 `markMissingByKeys` 对历史链接口径一致
 *   R8-25 跨链接的订单总量上限（且 paid / refunded 永不裁）
 *
 * 其余编号的护栏位置：
 *   R8-01 → tests/payment-gateway.test.js（微信签名必须覆盖请求体）
 *   R8-06 / R8-09 → tests/share-deleted.test.js
 *   R8-08 / R8-14 → tests/routes-surface.test.js（权限与路由表面积）
 *   R8-07 → tests/frontend.test.js（pay-poll.js 已登记为前端模块）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const test = require('node:test');
const { assert, assertEqual, ROOT, cleanupTempDir } = require('./helpers');

/* ------------------------------------------------------------------ *
 * 0 · 隔离与打桩（必须在 require 任何 server 模块之前）
 * ------------------------------------------------------------------ */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-audit8-'));
process.env.COS_DATA_DIR = TMP;
// R8-25：用小上限驱动跨链接裁剪分支 —— 否则要真的造两万笔订单才能碰到它
process.env.PAYMENT_MAX_ORDERS_TOTAL = '6';
// R14-03 之后，`pending` 在支付窗口内不可裁（保护在途付款）。本文件断言的是
// 「最旧的 pending 会被裁掉」这条上限语义，故把窗口压到 1ms，让待裁样本立刻超窗。
// 「窗口内不得裁」的新语义由 tests/audit14-regressions.test.js 单独覆盖（独立进程、默认窗口）。
process.env.PAYMENT_PENDING_KEEP_MS = '1';

const cos = require(path.join(ROOT, 'server', 'cos.js'));
const configStore = require(path.join(ROOT, 'server', 'config-store.js'));

/** 记录每次云端动作（含实际使用的客户端），供「有没有真的打云端」这类断言使用 */
const pCalls = [];

const BASE_CFG = {
  secretId: 'stub-id', secretKey: 'stub-key',
  bucket: 'audit8-bucket', region: 'ap-guangzhou', provider: 'tencent',
};

cos.getClient = () => ({ __provider: 'tencent' });
cos.p = async (client, method, params) => {
  pCalls.push({ method, params });
  switch (method) {
    case 'headObject': return { headers: { 'content-length': '0' } };
    case 'multipartInit': return { UploadId: 'audit8-upload-id' };
    case 'multipartListPart': return { ListPartsResult: { Part: [] } };
    case 'multipartList': return { ListUploadsResult: { Upload: [], IsTruncated: 'false' } };
    default: return {};
  }
};

const shared = require(path.join(ROOT, 'server', 'routes', '_shared.js'));
shared.requireConfig = () => BASE_CFG;
const statsStore = require(path.join(ROOT, 'server', 'stats-store.js'));
statsStore.addLog = () => {};
statsStore.trackBucket = () => {};

const fsRoutes = require(path.join(ROOT, 'server', 'routes', 'fs.js'));
const encStore = require(path.join(ROOT, 'server', 'enc-store.js'));
const listCache = require(path.join(ROOT, 'server', 'list-cache.js'));
const paymentOrders = require(path.join(ROOT, 'server', 'payment-orders.js'));
const shareStore = require(path.join(ROOT, 'server', 'share-store.js'));

/* ------------------------------------------------------------------ *
 * 迷你 HTTP 工具（与 audit7 同型，保持逐轮护栏自包含）
 * ------------------------------------------------------------------ */

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
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: server.address().port, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

function json(port, method, urlPath, body) {
  const payload = Buffer.from(JSON.stringify(body || {}));
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: urlPath, method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
        'X-Requested-With': 'XMLHttpRequest',
      },
    }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(text); } catch (e) { /* 非 JSON */ }
        resolve({ status: res.statusCode, json: body, text });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

/* ================================================================== *
 * R8-02 · magic 模式的分片上限
 * ================================================================== */

/**
 * 这条护栏同时锁住两个**方向相反**的要求：
 *  - 上界：magic 的密钥流是同步生成（每 32 字节一次 SHA-256），分片越大、
 *    单次阻塞事件循环越久 —— 必须明显小于默认的 8MB 起步值；
 *  - 下界：**AWS S3 要求「除最后一片外」每片 ≥ 5MB**，压到 5MB 以下会让
 *    启用 magic 的大文件在 S3 上合并时报 `EntityTooSmall`。
 *
 * 8MB 的默认值到 5MB 之间没有别的合法取值，因此这里的断言就是
 * 「必须恰好落在合法窗口内」，而不是「大致等于某个数」。
 */
test('R8-02 · magic 模式分片上限：既要压小同步阻塞，又不得低于厂商 5MB 下限', async () => {
  const realMode = encStore.currentMode;
  const srv = await startApp(fsRoutes);
  try {
    const size = 20 * 1024 * 1024; // > SIMPLE_THRESHOLD(8MB) → 走分片

    encStore.currentMode = () => 'magic';
    const magic = await json(srv.port, 'POST', '/api/fs/upload/init', { key: 'a/big.bin', size });
    assertEqual(magic.status, 200, `init 应成功（实际 ${magic.status} ${magic.text || ''}）`);
    const magicChunk = magic.json && magic.json.chunkSize;
    assertEqual(magicChunk, 5 * 1024 * 1024,
      'magic 模式的分片必须恰好是 5MB：' +
      '大于它 → 单次同步密钥流生成会长时间独占事件循环；' +
      '小于它 → AWS S3 分片下限（除末片外 5MB）不满足，合并报 EntityTooSmall');

    encStore.currentMode = () => 'none';
    const plain = await json(srv.port, 'POST', '/api/fs/upload/init', { key: 'a/plain.bin', size });
    assertEqual(plain.status, 200, `init 应成功（实际 ${plain.status} ${plain.text || ''}）`);
    assertEqual(plain.json && plain.json.chunkSize, 8 * 1024 * 1024,
      '非 magic 模式必须保持原分片大小（8MB 起步），不得被 R8-02 误伤');
  } finally {
    encStore.currentMode = realMode;
    await srv.close();
  }
});

/* ================================================================== *
 * R8-03 · 覆盖写入后的元数据对账
 * ================================================================== */

/**
 * 加密元数据描述的是「云端那个对象**当前**是什么」。覆盖写入时若新内容是明文，
 * 云端已经变成明文而本地旧条目还在，于是：
 *   · 旧条目是 crypto → 找不到 `COSCENC01` 魔数，报错，但响应头已按 origSize
 *     写了 Content-Length，浏览器拿到一个中途死亡的下载；
 *   · 旧条目是 magic  → **静默损坏**：拿旧盐还原被覆写的文件头再异或，
 *     用户得到一个「看起来正常、内容全错」的文件。
 */
test('R8-03 · 覆盖写入后必须对账：明文覆盖要清掉旧密文元数据，且不谎报成功', async () => {
  const bucket = 'audit8-reconcile';
  const key = 'dir/cover.bin';

  // 前置：先按密文写入一份元数据
  encStore.reconcileAfterWrite(bucket, key, { mode: 'magic', salt: 'aa', magicLen: 9 });
  assert(encStore.getMeta(bucket, key), '前置条件：应写入密文元数据');

  // ① 明文覆盖：必须删除旧条目（否则下载侧会按密文去解一个明文对象）
  assertEqual(encStore.reconcileAfterWrite(bucket, key, null), true,
    '明文覆盖后应报告「确实清理了旧元数据」');
  assertEqual(encStore.getMeta(bucket, key), null,
    'R8-03：明文覆盖写入成功后，旧密文元数据必须被清除 —— ' +
    '残留条目会让 magic 文件静默损坏、crypto 文件下载中途死亡');

  // ② 幂等：已经没有条目时不得谎报「清理成功」
  assertEqual(encStore.reconcileAfterWrite(bucket, key, null), false,
    '没有旧条目时应如实返回 false，不能谎报成功（否则掩盖真实的对账缺口）');

  // ③ 再次加密写入：必须写入新元数据（而不是因为「曾经清过」就跳过）
  assertEqual(encStore.reconcileAfterWrite(bucket, key, { mode: 'crypto' }), true, '加密写入应报告成功');
  assertEqual((encStore.getMeta(bucket, key) || {}).mode, 'crypto',
    '加密写入必须落到元数据上，否则密文无法解密');

  // ④ meta 为空时**不得**写入任何条目
  encStore.reconcileAfterWrite(bucket, 'dir/another.bin', null);
  assertEqual(encStore.getMeta(bucket, 'dir/another.bin'), null,
    '明文写入绝不能在元数据里留下空条目');
});

/* ================================================================== *
 * R8-11 · list-cache 键的调用方命名空间
 * ================================================================== */

/**
 * 缓存键描述的是「哪**一次**列举」，而不是「哪一组参数」。
 * `/fs/list` 与 `/fs/search` 会以相同的五元组（同 bucket / prefix / marker /
 * maxKeys=1000 / delimiter）打到同一个桶，但两者缓存的**载荷结构不兼容**：
 *   · list   → `{ contents[], prefixes[{…}] }`
 *   · search → `{ items[], prefixes[string] }`
 * 命中错配时 search 读 `page.items` 得 undefined → `for…of` 抛 TypeError → 500；
 * 反方向则 list 读 `r.contents` 得 undefined → **目录静默显示为空**。
 */
test('R8-11 · /fs/list 与 /fs/search 的缓存键必须落在不同命名空间，且按桶失效仍覆盖两者', () => {
  listCache.clear();
  const b = 'audit8-ns';
  const kList = listCache.keyOf(b, 'p/', '', 1000, '/', 'list');
  const kSearch = listCache.keyOf(b, 'p/', '', 1000, '/', 'search');

  assert(kList !== kSearch,
    'R8-11：同一组列举参数在 list / search 下必须是不同键 —— ' +
    '否则两种不兼容的载荷会互相命中，表现为「目录凭空变空」或 500');

  listCache.set(kList, { kind: 'list', contents: ['a'] });
  listCache.set(kSearch, { kind: 'search', items: ['b'] });
  assertEqual(listCache.get(kList).kind, 'list', 'list 键应命中自己的载荷');
  assertEqual(listCache.get(kSearch).kind, 'search', 'search 键应命中自己的载荷（不得被 list 覆盖）');

  // 反向：keyOf 的 kind 追加在**末尾**，因此按桶失效的前缀匹配必须继续覆盖两者
  assertEqual(listCache.invalidateBucket(b), 2,
    'invalidateBucket 必须同时清掉同一桶的 list 与 search 条目（kind 放在键末尾，前缀匹配仍成立）');
  assertEqual(listCache.get(kList), null, '写操作后 list 缓存必须已失效');
  assertEqual(listCache.get(kSearch), null, '写操作后 search 缓存同样必须失效');
  assertEqual(listCache.size(), 0, '该桶的条目不应残留');
});

/* ================================================================== *
 * R8-12 · 「当前密码不正确」不得回 401
 * ================================================================== */

/**
 * 前端 `api.js` 把**任意** 401 统一派发为 `auth-required`（「会话过期」）→
 * 清会话、跳登录页。于是用户只是手误打错一次密码，却被踢回登录页：
 * 弹窗内容丢失、提示文案还是错的。
 *
 * 会话在这里是完全有效的，正解是 403（已认证但无权/校验未通过）。
 * 该判定必须**同时**覆盖注册与关闭两个入口 —— 它们是同一条语义的两个实现。
 */
test('R8-12 · 当前密码错误必须回 403（401 会被前端当成会话过期并强制登出）', async () => {
  const security = require(path.join(ROOT, 'server', 'security.js'));
  const webauthnRoutes = require(path.join(ROOT, 'server', 'routes', 'webauthn.js'));

  const realIp = security.clientIp;
  const realLimiter = security.passwordLimiter;
  const realFind = configStore.findUserRawById;
  const realVerify = configStore.verifyUserPassword;
  security.clientIp = () => '127.0.0.1';
  security.passwordLimiter = () => ({ ok: true, retryAfter: 0 });
  configStore.findUserRawById = () => ({ id: 'u1', username: 'admin', role: 'admin' });
  configStore.verifyUserPassword = async () => false; // 恒定「密码不对」

  const srv = await startApp(webauthnRoutes);
  try {
    const reg = await json(srv.port, 'POST', '/api/webauthn/register/options', { password: 'wrong' });
    assertEqual(reg.status, 403,
      `R8-12：注册入口的密码错误应为 403，实际 ${reg.status}` +
      `（401 会被前端当成「会话过期」而强制登出）`);

    const off = await json(srv.port, 'POST', '/api/webauthn/disable', { password: 'wrong' });
    assertEqual(off.status, 403,
      `R8-12：关闭入口同样是「当前密码不正确」，应为 403，实际 ${off.status}`);
  } finally {
    await srv.close();
    security.clientIp = realIp;
    security.passwordLimiter = realLimiter;
    configStore.findUserRawById = realFind;
    configStore.verifyUserPassword = realVerify;
  }
});

/* ================================================================== *
 * R8-21 · 分片列举缓存的容量上限
 * ================================================================== */

/**
 * 这张表的键是 `'frag:' + provider|secretId|bucket|region`，值是该桶的**完整碎片数组**。
 * 旧实现唯一的删除时机是「同一个键再被读到且已过期」与「按桶失效」，于是
 * 密钥轮换（换 secretId）、桶解绑或改名都会产生**永不释放的旧键**，
 * 随使用时长单调上升。
 */
test('R8-21 · 分片列举缓存必须有容量上限：超过后淘汰最早的条目', async () => {
  const N = shared.FRAGMENT_CACHE_MAX + 5;
  const cfgs = [];
  for (let i = 0; i < N; i++) cfgs.push(Object.assign({}, BASE_CFG, { bucket: 'audit8-frag-' + i }));

  const before = pCalls.length;
  for (const cfg of cfgs) await shared.listFragments(null, cfg, { noStat: true });
  assertEqual(pCalls.length - before, N, '前置条件：每个新桶都应打一次云端（缓存未命中）');

  // 最早的条目必须已被淘汰 → 再问一次仍然打云端
  const mid = pCalls.length;
  await shared.listFragments(null, cfgs[0], { noStat: true });
  assertEqual(pCalls.length - mid, 1,
    `R8-21：插入 ${N} 个不同桶后，最早的条目必须已被淘汰（否则这张表无上限、只增不减）`);

  // 最新的条目仍在，且仍然命中缓存
  const last = pCalls.length;
  await shared.listFragments(null, cfgs[N - 1], { noStat: true });
  assertEqual(pCalls.length - last, 0,
    '缓存必须仍然有效：最新插入的条目不应被误清（否则等于把缓存整体废掉）');
});

/* ================================================================== *
 * R8-24 / R9-07 · 整桶标记对「无 bucket 字段历史链接」的口径
 * ================================================================== */

/**
 * R8-24 曾把整桶标记改成**宽松口径**（无 `bucket` 字段的历史链接也标记），理由是
 * 「猜错了的链接会被分享页的惰性探测在 60 秒内判回有效」。R9-07 复核后确认该论证
 * **不成立**，因此改回**严格口径**：
 *
 *   `configStore.effectiveForBucket(undefined)` 走
 *   `buckets.find(x => x.bucket === undefined)` → 永远不命中 → 返回 `null`。
 *   而 `probeObjectMissing` 在 `cfg` 为 null 时**刻意不探测、也不改判**
 *   （fail-open 只适用于「不确定」，不适用于「连探都没探成」）。
 *   于是被标记的历史链接**既不打云端、也不会 clearMissing**，永久停在 410 ——
 *   恰好就是注释声称要避免的「永久错误状态」。宽松口径是净负。
 *
 * 本用例锁住修正后的语义：**只标记 bucket 完全相符的链接**，历史链接保持原状态。
 */
test('R9-07 · 整桶标记只认 bucket 完全相符的链接：无 bucket 的历史链接不标记', async () => {
  const b1 = 'audit9-mb-1';
  const b2 = 'audit9-mb-2';
  const mk = (bucket) => shareStore.create({
    key: 'k-' + Math.random().toString(36).slice(2), bucket,
    region: 'ap-guangzhou', fileName: 'f', size: 1,
    expiresHours: 0, maxDownloads: 0, password: null, paid: null, createdBy: 'tester',
  });
  const mine = await mk(b1);
  const other = await mk(b2);
  const legacy = await mk(undefined); // 早于多桶版本的记录：没有 bucket 字段

  const n = shareStore.markMissingByBucket(b1);
  const stOf = (id) => shareStore.status(shareStore.get(id));

  assertEqual(stOf(mine.id), 'deleted', '本桶的链接必须被标记');
  assertEqual(stOf(other.id), 'active', '别的桶的链接不得被误标（桶隔离）');
  assertEqual(stOf(legacy.id), 'active',
    'R9-07：无 bucket 字段的历史链接**不得**被标记 —— 它猜不出桶 → effectiveForBucket 返回 null '
    + '→ 分享页既不会探测也不会 clearMissing，一旦标记就是**永久** 410（不可自愈）');
  assertEqual(n, 1, `应只标记 1 条（本桶），实际 ${n}`);

  // 幂等：已标记的不再计数
  assertEqual(shareStore.markMissingByBucket(b1), 0, '已标记的链接重复提交不应再计数');

  // 反向确认判据是「桶相符」而不是「有没有 bucket 字段」：
  // 对另一个桶（b2）执行整桶标记时，b2 的链接必须被标记，历史链接仍然不动。
  assertEqual(shareStore.markMissingByBucket(b2), 1, '对 b2 整桶标记应命中 b2 的链接');
  assertEqual(stOf(other.id), 'deleted', 'b2 的链接应被标记');
  assertEqual(stOf(legacy.id), 'active',
    '历史链接在两个桶的整桶标记之后都不得被误标 —— 它无法被任何桶证明归属于该桶');
});

/* ================================================================== *
 * R8-25 · 跨链接的订单总量上限
 * ================================================================== */

/**
 * `prune(linkId)` 的唯一调用点是 `create()`，而删链接后原 linkId 再也不会被请求到，
 * 于是「删链接 → 订单永久滞留」是一条只增不减的路径。这里补的是**跨链接**兜底。
 *
 * 同时必须锁住「保留集」：`paid` / `refunded` 是钱真正流动过的对账凭据，
 * 任何情况下都不能裁 —— 裁掉退款记录就再也证明不了「这笔钱退过」。
 */
test('R8-25 · 跨链接订单上限：只裁 pending / failed，已支付与已退款永不裁', async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const mkOrder = (linkId, i) => paymentOrders.create({
    linkId, platform: 'alipay', amountFen: 100, currency: 'CNY', fileName: 'f' + i, fileKey: 'k',
  });

  const ids = [];
  for (let i = 0; i < 4; i++) { ids.push((await mkOrder('L1', i)).id); await sleep(2); }
  paymentOrders.markPaid(ids[0]); // 第 1 笔置为已支付

  for (let i = 0; i < 3; i++) { ids.push((await mkOrder('L2', i)).id); await sleep(2); }

  const cap = Number(process.env.PAYMENT_MAX_ORDERS_TOTAL);
  const total = paymentOrders.listAll().length;
  assert(total <= cap,
    `R8-25：订单总量必须被上限约束（上限 ${cap}，实际 ${total}）—— ` +
    '否则「删链接后订单永不裁剪」会让订单文件无界增长');

  assertEqual((paymentOrders.get(ids[0]) || {}).status, 'paid',
    '已支付订单绝不能被裁 —— 它是对账凭据（退款记录同理）');
  assertEqual(paymentOrders.get(ids[1]), null,
    '最旧的 pending 订单应被裁掉（这是上限真正生效的证据）');
  assertEqual(paymentOrders.listForLink('L1').length, 3,
    'L1 应剩 3 笔（已支付的 1 笔 + 未裁的 2 笔）');
});

/* ------------------------------------------------------------------ *
 * 收尾
 * ------------------------------------------------------------------ */

test.after(async () => {
  listCache.clear();
  try {
    await require(path.join(ROOT, 'server', 'secure-store.js')).flush();
  } catch (e) { /* ignore */ }
  try {
    await cleanupTempDir(TMP, {
      label: 'audit8-regressions',
      flushers: [
        require(path.join(ROOT, 'server', 'upload-sessions.js')).flushSync,
        require(path.join(ROOT, 'server', 'stats-store.js')).flushStatsSync,
        require(path.join(ROOT, 'server', 'secure-store.js')).flush,
      ],
    });
  } catch (e) { /* ignore */ }
});
