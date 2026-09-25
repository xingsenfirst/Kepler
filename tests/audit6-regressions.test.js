/**
 * 测试：第六轮审计（AUDIT-REPORT.md）修复护栏
 *
 * 覆盖本轮落地的 P2 项：
 *   FUN-06  stats.json 损坏护栏（区分「不存在」与「损坏」，损坏即备份 + 拒绝落盘）
 *   FUN-07  IP 守卫按**会话**桶判定（不再读全局 activeBucketId）
 *   FUN-08  新增本地桶前的云端存在性探测（确定性失败才拒绝）
 *   FUN-11  rename / move 先迁加密元数据、再删源对象
 *   SEC-02  登录失败锁定键含来源 IP（防针对已知账户的锁定 DoS）
 *   SEC-03  支付回调限流 + 支付宝 RSA 验签
 *   PERF-01 分片列举短缓存（命中 + 分片写操作失效）
 *
 * 以及复核阶段新增的 RE 系列：
 *   RE-01  失败锁定器：计数按窗口衰减 + 条目可回收 + 键数量有硬上限
 *   RE-03  进程退出兜底落盘必须走同步写（异步写在 exit 后不会被调度）
 *
 * 约定同既有护栏：**行为断言**、真实驱动模块 / 路由、不写真实 data/。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { after } = require('node:test');
const { assert, assertEqual, assertMatch, ROOT, makeTempDir } = require('./helpers');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

/* ============================ FUN-06 ============================ */

/**
 * stats-store 在 require 时就固定了数据目录，只能在加载前设置 COS_DATA_DIR
 * 并清掉模块缓存 —— 与 audit3 里 payment-orders 的隔离手法一致。
 */
function loadStatsStoreFresh(dir) {
  const prev = process.env.COS_DATA_DIR;
  process.env.COS_DATA_DIR = dir;
  const modPath = require.resolve(path.join(ROOT, 'server', 'stats-store.js'));
  delete require.cache[modPath];
  const mod = require(modPath);
  return {
    mod,
    restore() {
      if (prev === undefined) delete process.env.COS_DATA_DIR;
      else process.env.COS_DATA_DIR = prev;
      delete require.cache[modPath];
    },
  };
}

const statsTmp = makeTempDir('cos-stats-');

test('FUN-06 · stats.json 不存在属正常启动：可累计并落盘（区分「不存在」与「损坏」）', async () => {
  const h = loadStatsStoreFresh(statsTmp.dir);
  try {
    h.mod.track({ type: 'unit', ok: true, bytesUp: 10, bytesDown: 20, ms: 1 });
    await sleep(800); // persist 有 500ms 去抖
    assertEqual(h.mod.isLoadFailed(), false, '文件不存在不应被判为损坏');
    const file = path.join(statsTmp.dir, 'stats.json');
    assert(fs.existsSync(file), '正常启动应能落盘 stats.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    assertEqual(parsed.days[h.mod.todayKey()].up, 10, '累计值应写入当天');
  } finally {
    h.restore();
  }
});

test('FUN-06 · stats.json 损坏时降级为空表并**拒绝落盘**，原件保留且已备份', async () => {
  const dir = tmpDir('cos-stats-bad-');
  const file = path.join(dir, 'stats.json');
  const BROKEN = '{"days":{"2026-01-01"';
  fs.writeFileSync(file, BROKEN); // 半截 JSON

  const h = loadStatsStoreFresh(dir);
  try {
    h.mod.track({ type: 'unit', ok: true, bytesUp: 999, bytesDown: 0, ms: 1 });
    assertEqual(h.mod.isLoadFailed(), true,
      '文件存在但解析失败必须被判为损坏 —— 旧实现把它与"文件不存在"混为一谈，' +
      '随后 500ms 就把空表写回磁盘，把还能人工抢救的历史统计整体覆盖掉');
    await sleep(800);
    assertEqual(fs.readFileSync(file, 'utf8'), BROKEN,
      '损坏期间绝不落盘：磁盘原件必须保持原样等待人工恢复');
    const bak = fs.readdirSync(dir).filter((f) => f.indexOf('stats.json.corrupt-') === 0);
    assert(bak.length >= 1, '应为损坏文件生成 .corrupt-* 备份');
  } finally {
    h.restore();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
});

test('FUN-06 · 损坏状态下读取仍可用（统计不是核心数据，不该拖垮服务）', () => {
  const dir = tmpDir('cos-stats-bad2-');
  fs.writeFileSync(path.join(dir, 'stats.json'), 'not json at all');
  const h = loadStatsStoreFresh(dir);
  try {
    assertEqual(h.mod.series(3).length, 3, '损坏时应降级为空序列而不是抛异常');
    assertEqual(h.mod.summary().traffic.todayUp, 0, '汇总同样降级为零值');
  } finally {
    h.restore();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
});

after(() => statsTmp.cleanup());

/* ============================ FUN-07 ============================ */

const configStore = require(path.join(ROOT, 'server', 'config-store.js'));
const authSession = require(path.join(ROOT, 'server', 'auth-session.js'));
const ipGuard = require(path.join(ROOT, 'server', 'ip-guard.js'));

/* ---------------- 配置播种（R13-01） ---------------- */

/**
 * R13-01：helpers 已把 `COS_DATA_DIR` 兜底到进程级临时目录，本文件拿到的 configStore
 * 绑定的是**空配置**。而下面两组用例此前一直**隐式读生产 `data/config.enc`**：
 *
 *   - FUN-07 直接 `configStore.listBuckets()` 取「至少 2 个桶」构造对照 —— 生产里
 *     恰好有 2 个桶才一直绿；隔离后空配置直接断言失败；
 *   - FUN-08 路由用例的云端探测走 `configStore.effective()` —— 生产里有一把启用密钥，
 *     探测才会真正发起并被桩拦成 400；空配置下探测被「尚未配置访问密钥」跳过
 *     （ok:true + warning），请求一路走到落库，500。
 *
 * 「能读到生产配置」本身就是 R13-01 的一半病因（ PERF-02 的 `save()` 还会**写**回去）。
 * 隔离修好之后临时目录里当然是空的 —— 所以这里必须自己播种（upsert 语义，幂等）。
 */
configStore.save({
  credentials: [{
    id: 'cred-audit6', provider: 'tencent',
    secretId: 'AKIDaudit6-seed', secretKey: 'audit6-seed-secret',
    enabled: true, visibleToUsers: true,
    remark: 'audit6 播种数据（COS_DATA_DIR 隔离目录）',
  }],
  buckets: [
    {
      id: 'bkt-audit6-a', provider: 'tencent',
      bucket: 'audit6-seed-a-1250000000', region: 'ap-guangzhou',
      credentialId: 'cred-audit6', enabled: true, visibleToUsers: true,
      remark: 'audit6 播种数据（COS_DATA_DIR 隔离目录）',
    },
    {
      id: 'bkt-audit6-b', provider: 'tencent',
      bucket: 'audit6-seed-b-1250000000', region: 'ap-guangzhou',
      credentialId: 'cred-audit6', enabled: true, visibleToUsers: true,
      remark: 'audit6 播种数据（COS_DATA_DIR 隔离目录）',
    },
    {
      // 喂饱 FUN-07 第二条（:144 的可见性分支）—— 此前生产配置里没有不可见桶时
      // 该用例直接 return 空转，播种后它真正参与断言。
      id: 'bkt-audit6-hidden', provider: 'tencent',
      bucket: 'audit6-seed-hidden-1250000000', region: 'ap-guangzhou',
      credentialId: 'cred-audit6', enabled: true, visibleToUsers: false,
      remark: 'audit6 播种数据（COS_DATA_DIR 隔离目录）',
    },
  ],
  activeCredentialId: 'cred-audit6',
  activeBucketId: 'bkt-audit6-a',
});
// `save()` 走去抖写盘，此刻文件未必已落盘；这里只需确认**缓存视图**已就位。
assert(configStore.load() && configStore.load().activeBucketId === 'bkt-audit6-a',
  'R13-01 前置：播种的激活桶必须能被 load() 读到（隔离目录为空时也要能自足）');

/** 造一个带 Cookie 的请求（ip-guard 挂在鉴权之前，只能自己解析 token） */
function reqWithSession(urlPath, token) {
  return {
    path: urlPath,
    method: 'GET',
    headers: token ? { cookie: `cosmgr_session=${token}` } : {},
    socket: { remoteAddress: '9.9.9.9' },
  };
}

test('FUN-07 · /api/fs/* 的目标桶按**会话**解析，而不是全局 activeBucketId', () => {
  const all = configStore.listBuckets();
  assert(all.buckets.length >= 2, `需要至少 2 个桶才能构造对照（当前 ${all.buckets.length} 个）`);
  const globalId = all.activeBucketId;
  const other = all.buckets.find((b) => b.id !== globalId && b.enabled !== false);
  assert(other, '需要另一个启用中的桶作为会话桶');

  const token = authSession.createSession({ id: 'unit-fun07', username: 'unit-fun07', role: 'admin' });
  try {
    authSession.setSessionBucket(token, other.id);
    const got = ipGuard.resolveBucketId(reqWithSession('/api/fs/list', token));
    assertEqual(got, other.id,
      '桶级 IP 规则必须作用在请求的真实目标桶上 —— 读全局会让「用户切到 B 桶后 A 桶的封禁失效」');

    // 无会话时（WebDAV / 内部调用）仍回退全局默认，行为不变
    assertEqual(ipGuard.resolveBucketId(reqWithSession('/api/fs/list', '')), globalId,
      '无会话信息时应回退系统默认桶（既有行为，防回归）');
  } finally {
    authSession.destroySession(token);
  }
});

test('FUN-07 · 普通用户会话不得让守卫解析到对其不可见的桶', () => {
  const all = configStore.listBuckets();
  const hidden = all.buckets.find((b) => b.visibleToUsers === false);
  if (!hidden) return; // 真实配置里没有不可见桶时跳过
  const token = authSession.createSession({ id: 'unit-fun07u', username: 'unit-fun07u', role: 'user' });
  try {
    authSession.setSessionBucket(token, hidden.id);
    const got = ipGuard.resolveBucketId(reqWithSession('/api/stats/overview', token));
    assert(got !== hidden.id,
      'IP 守卫同样受可见性约束：否则桶级规则会暴露 / 作用于该用户本不该接触的桶');
  } finally {
    authSession.destroySession(token);
  }
});

/* ============================ FUN-08 ============================ */

const cos = require(path.join(ROOT, 'server', 'cos.js'));
const origGetClient = cos.getClient;

let probeClient = null;
cos.getClient = () => probeClient; // 必须在 require 路由之前接管（路由在 require 时解构）
const bucketsRoutes = require(path.join(ROOT, 'server', 'routes', 'buckets.js'));

/** 假客户端：err 为 null 表示桶存在且可列举 */
function setProbeClient(err) {
  probeClient = { getBucket(_p, cb) { cb(err, err ? null : { Contents: [] }); } };
}

// 显式给出假密钥，避免依赖本机是否真的配置过凭据
const FAKE_CRED = { provider: 'tencent', secretId: 'AKIDunit', secretKey: 'unit-secret', endpoint: '' };

test('FUN-08 · 桶不存在（NoSuchBucket）时拒绝新增本地桶记录', async () => {
  setProbeClient(Object.assign(new Error('NoSuchBucket'), { code: 'NoSuchBucket', statusCode: 404 }));
  const r = await bucketsRoutes.__probeBucket('nope-1250000000', 'ap-guangzhou', FAKE_CRED);
  assertEqual(r.ok, false, '确定性失败（桶不存在）必须拒绝 —— 否则任何字符串都能存成桶记录');
  assert(String(r.message || '').length > 0, '应给出面向用户的失败原因');
});

test('FUN-08 · 网络抖动不算"桶不存在"：放行并回传 warning', async () => {
  setProbeClient(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
  const r = await bucketsRoutes.__probeBucket('maybe-1250000000', 'ap-guangzhou', FAKE_CRED);
  assertEqual(r.ok, true,
    '一次抖动就让管理员加不了桶是不可接受的：只有"不存在 / 无权访问"这种稳定事实才拒绝');
  assert(!!r.warning, '应回传 warning 提示未通过校验');
});

test('FUN-08 · 桶可访问时探测通过且不产生告警', async () => {
  setProbeClient(null);
  const r = await bucketsRoutes.__probeBucket('ok-1250000000', 'ap-guangzhou', FAKE_CRED);
  assertEqual(r.ok, true, '桶可访问时应放行');
  assertEqual(r.warning, undefined, '正常情况不应产生告警');
});

test('FUN-08 · 探测失败时路由必须短路：返回 400 且**不写任何本地记录**', async () => {
  setProbeClient(Object.assign(new Error('NoSuchBucket'), { code: 'NoSuchBucket', statusCode: 404 }));

  const express = require(path.join(ROOT, 'node_modules', 'express'));
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.authUser = { id: 'u', username: 'u', role: 'admin' }; next(); });
  app.use('/api', bucketsRoutes);
  const server = await new Promise((resolve) => {
    const s = require('http').createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });

  // 兜底：万一实现没有短路，也不能把假桶写进真实配置
  const origAdd = configStore.addBucket;
  let added = false;
  configStore.addBucket = () => { added = true; throw new Error('不该走到落库'); };
  try {
    const port = server.address().port;
    const body = JSON.stringify({ bucket: 'never-exists-1250000000', region: 'ap-guangzhou' });
    const res = await new Promise((resolve, reject) => {
      const req = require('http').request({
        host: '127.0.0.1', port, method: 'POST', path: '/api/buckets/local',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-Requested-With': 'XMLHttpRequest',
        },
      }, (r) => {
        let raw = '';
        r.on('data', (c) => { raw += c; });
        r.on('end', () => resolve({ status: r.statusCode, raw }));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
    assertEqual(res.status, 400,
      `桶不可访问时新增必须被拒（护栏只对"探测函数返回 false"生效而路由不采信 = 形同虚设），实际：${res.raw}`);
    assertEqual(added, false, '探测失败绝不能落库 —— 否则本地仍会多出一条指向不存在桶的记录');
  } finally {
    configStore.addBucket = origAdd;
    await new Promise((r) => server.close(r));
  }
});

/* ============================ FUN-11 ============================ */

const shared = require(path.join(ROOT, 'server', 'routes', '_shared.js'));
const encStore = require(path.join(ROOT, 'server', 'enc-store.js'));
const statsStore = require(path.join(ROOT, 'server', 'stats-store.js'));

// 阻止本用例把假桶名写进真实 data/
statsStore.trackBucket = () => {};
statsStore.addLog = () => {};
shared.requireConfig = () => ({ bucket: 'bkt', region: 'ap-guangzhou', provider: 'tencent' });

/** rename 全流程的调用序列（加密元数据与云端调用记在同一条时间线上） */
const renameEvents = [];
const origRenameMeta = encStore.renameMeta;
encStore.renameMeta = (bucket, from, to) => { renameEvents.push(`meta:${from}->${to}`); };

let renameClient = null;
cos.getClient = () => renameClient; // 在 require fs.js 之前换成重命名用的假客户端
const fsRoutes = require(path.join(ROOT, 'server', 'routes', 'fs.js'));

test('FUN-11 · 重命名文件：元数据迁移**先于**删除源对象', async () => {
  renameEvents.length = 0;
  const notFound = () => { const e = new Error('NotFound'); e.statusCode = 404; return e; };
  renameClient = {
    headObject(_p, cb) { cb(notFound(), null); },
    putObjectCopy(_p, cb) { renameEvents.push('copy'); cb(null, {}); },
    deleteObject(_p, cb) { renameEvents.push('delete:' + _p.Key); cb(null, {}); },
  };

  const express = require(path.join(ROOT, 'node_modules', 'express'));
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.authUser = { id: 'u', username: 'u', role: 'admin' }; next(); });
  app.use('/api', fsRoutes);
  const server = await new Promise((resolve) => {
    const s = require('http').createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const port = server.address().port;
    const body = JSON.stringify({ path: 'a.txt', newName: 'b.txt' });
    const res = await new Promise((resolve, reject) => {
      const req = require('http').request({
        host: '127.0.0.1', port, method: 'POST', path: '/api/fs/rename',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-Requested-With': 'XMLHttpRequest',
        },
      }, (r) => {
        let raw = '';
        r.on('data', (c) => { raw += c; });
        r.on('end', () => resolve({ status: r.statusCode, raw }));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
    assertEqual(res.status, 200, `重命名应成功，实际：${res.raw}`);

    // 顺序是本条护栏的核心：先删源再迁元数据的话，两步之间任何失败都会让密文
    // 永久失去元数据（数据还在但解不开），等于不可逆丢失。
    assert(renameEvents.indexOf('copy') >= 0, '应发生一次复制');
    assert(renameEvents.indexOf('meta:a.txt->b.txt') > renameEvents.indexOf('copy'),
      '元数据迁移应在复制之后');
    assert(renameEvents.indexOf('meta:a.txt->b.txt') < renameEvents.indexOf('delete:a.txt'),
      `元数据迁移必须**早于**删除源对象，实际序列：${JSON.stringify(renameEvents)}`);
  } finally {
    await new Promise((r) => server.close(r));
    encStore.renameMeta = origRenameMeta;
    cos.getClient = origGetClient;
  }
});

/* ============================ SEC-02 ============================ */

const security = require(path.join(ROOT, 'server', 'security.js'));
const authRoutes = require(path.join(ROOT, 'server', 'routes', 'auth.js'));

test('SEC-02 · 登录失败锁定键含来源 IP：一个 IP 的失败不会锁死账户本人', () => {
  const attacker = authRoutes.loginLockKey('203.0.113.9', 'admin');
  const victim = authRoutes.loginLockKey('10.0.0.7', 'admin');
  assert(attacker !== victim, '不同来源必须算出不同锁定键');

  security.loginLock.clear();
  try {
    let left = 0;
    for (let i = 0; i < 6; i++) left = security.loginLock.fail(attacker);
    assert(left > 0, '攻击来源应在连续失败后被锁定');
    assert(security.loginLock.locked(attacker) > 0, '攻击者自己应被挡住');
    assertEqual(security.loginLock.locked(victim), 0,
      '账户本人在**另一个来源**不得被连带锁定 —— 只按用户名锁定时，' +
      '任何人知道管理员用户名就能用 5 次错密码把他锁在外面最长 30 分钟');
  } finally {
    security.loginLock.clear();
  }
});

/* ============================ SEC-03 ============================ */

const crypto = require('crypto');
const paymentGateway = require(path.join(ROOT, 'server', 'payment-gateway.js'));

test('SEC-03 · 支付宝通知验签：真实签名通过，篡改 / 伪造 / 缺参都不通过', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pemPrivate = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const pemPublic = publicKey.export({ type: 'spki', format: 'pem' });

  const params = {
    out_trade_no: 'ord-1', trade_status: 'TRADE_SUCCESS', total_amount: '0.01',
    app_id: '2021004100000000', sign_type: 'RSA2',
  };
  const payload = paymentGateway.alipaySignPayload(params);
  const sign = crypto.createSign('RSA-SHA256').update(payload, 'utf8').sign(pemPrivate, 'base64');
  const signed = Object.assign({}, params, { sign });

  assertEqual(paymentGateway.alipayVerify(signed, pemPublic, 'RSA2'), true, '真实签名应通过');
  assertEqual(
    paymentGateway.alipayVerify(Object.assign({}, signed, { total_amount: '9999.00' }), pemPublic, 'RSA2'),
    false, '篡改金额后签名必须失效');
  assertEqual(
    paymentGateway.alipayVerify(Object.assign({}, signed, { sign: sign.slice(0, -4) + 'AAAA' }), pemPublic, 'RSA2'),
    false, '伪造签名必须失效');
  assertEqual(paymentGateway.alipayVerify(params, pemPublic, 'RSA2'), false, '缺 sign 字段应拒绝');
  assertEqual(paymentGateway.alipayVerify(signed, '', 'RSA2'), false, '未配置公钥应拒绝（不做伪验签）');
  assertEqual(paymentGateway.alipayVerify(signed, pemPublic, 'SM2'), false, 'SM2 本地无法验签，应明确拒绝');
});

test('SEC-03 · 支付回调有独立限流器（匿名端点不得无限触发带凭据的查单）', () => {
  assert(typeof security.payNotifyLimiter === 'function',
    '应提供 payNotifyLimiter —— 回调会带着真实商户密钥去查单，不限流等于把查单配额公开');
  let limited = false;
  for (let i = 0; i < 200; i++) {
    if (!security.payNotifyLimiter('198.51.100.5').ok) { limited = true; break; }
  }
  assert(limited, '同一 IP 高频回调应被限流');
});

/* ============================ PERF-01 ============================ */

const listCache = require(path.join(ROOT, 'server', 'list-cache.js'));

test('PERF-01 · 分片列举命中短缓存；分片写操作（abort）立即失效', async () => {
  let calls = 0;
  const client = {
    multipartList(_p, cb) {
      calls += 1;
      cb(null, { ListUploadsResult: { Upload: [], IsTruncated: 'false' } });
    },
  };
  const cfg = { provider: 'tencent', secretId: 'sid', secretKey: 'skey', bucket: 'frag-bkt', region: 'ap-guangzhou' };

  assertEqual((await shared.listFragments(client, cfg, { noStat: true })).length, 0, '空碎片列表');
  assertEqual(calls, 1, '首次应访问云端');
  assertEqual((await shared.listFragments(client, cfg, { noStat: true })).length, 0, '缓存命中结果一致');
  assertEqual(calls, 1,
    '重复刷新不应重复翻页扫描 —— /buckets/stats 对每个桶各扫一遍，这是纯粹的浪费');

  // 写操作经 cos.p() 的咽喉点登记 → 订阅者失效分片缓存
  listCache.noteCall('multipartAbort', { Bucket: cfg.bucket, Region: cfg.region, Key: 'x', UploadId: 'u' });
  await shared.listFragments(client, cfg, { noStat: true });
  assertEqual(calls, 2, '中止分片后必须重新拉取，否则「刚清空的碎片」仍显示存在');
});

test('（审计外）重命名文件夹：新 key 必须落在**父目录**下，而不是源目录内部', async () => {
  // parentOf 曾不剥尾斜杠 → parentOf('dir/') === 'dir/' → newKey = 'dir/新名/'
  // 恒满足 newKey.startsWith(key) → **任何文件夹都无法重命名**。
  const shared2 = require(path.join(ROOT, 'server', 'routes', '_shared.js'));
  assertEqual(shared2.parentOf('dir/'), '', '目录 key 的父前缀应是根（与 baseName 的剥斜杠语义一致）');
  assertEqual(shared2.parentOf('top/dir/'), 'top/', '两级目录的父前缀');
  assertEqual(shared2.parentOf('a.txt'), '', '根目录下文件的父前缀');
  assertEqual(shared2.parentOf('top/a.txt'), 'top/', '子目录下文件的父前缀');

  // 行为验证：直接驱动一次文件夹重命名，应成功而不是被"自身/子路径"拒绝
  renameEvents.length = 0;
  const notFound = () => { const e = new Error('NotFound'); e.statusCode = 404; return e; };
  renameClient = {
    getBucket(params, cb) {
      const pfx = String(params.Prefix || '');
      if (pfx !== 'dir/') return cb(null, { Contents: [], CommonPrefixes: [], IsTruncated: 'false', NextMarker: '' });
      cb(null, {
        Contents: [{ Key: 'dir/a.txt', Size: 10, LastModified: '2026-01-02T03:04:05.000Z' }],
        CommonPrefixes: [], IsTruncated: 'false', NextMarker: '',
      });
    },
    putObjectCopy(_p, cb) { cb(null, {}); },
    deleteObject(_p, cb) { cb(null, {}); },
    // 真实客户端（`cos-nodejs-sdk-v5` 与自研 s3-client）都回 `Deleted` 列表
    // （Quiet 缺省为 false）。桩若回 `{}`，删除会被判为「云端未确认」→ 不是桩的问题，
    // 是桩不真实。
    deleteMultipleObject(params, cb) {
      cb(null, { Deleted: (params.Objects || []).map((o) => ({ Key: o.Key })), Error: [] });
    },
  };
  const express = require(path.join(ROOT, 'node_modules', 'express'));
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.authUser = { id: 'u', username: 'u', role: 'admin' }; next(); });
  app.use('/api', fsRoutes);
  const server = await new Promise((resolve) => {
    const s = require('http').createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const port = server.address().port;
    const body = JSON.stringify({ path: 'dir/', newName: 'newdir' });
    const res = await new Promise((resolve, reject) => {
      const req = require('http').request({
        host: '127.0.0.1', port, method: 'POST', path: '/api/fs/rename',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-Requested-With': 'XMLHttpRequest',
        },
      }, (r) => {
        let raw = '';
        r.on('data', (c) => { raw += c; });
        r.on('end', () => resolve({ status: r.statusCode, raw }));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
    assertEqual(res.status, 200, `重命名文件夹应成功，实际：${res.status} ${res.raw}`);
    assertMatch(res.raw, /"newKey":"newdir\/"/, `新 key 应在根目录下，实际：${res.raw}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('FUN-10 · 回滚失败要留下孤儿副本线索（日志 + 错误明细），不能只留一句注释', async () => {
  renameEvents.length = 0;
  const logs = [];
  const origAddLog = statsStore.addLog;
  statsStore.addLog = (e) => { logs.push(e); };

  // 云端：第一个对象复制成功、第二个失败 → 触发回滚；回滚的 deleteObject 也失败
  let copyCalls = 0;
  const notFound = () => { const e = new Error('NotFound'); e.statusCode = 404; return e; };
  renameClient = {
    getBucket(params, cb) {
      // 目标目录 top/e/ 必须"不存在"（否则 assertNoConflict 直接 400，走不到复制）
      const pfx = String(params.Prefix || '');
      // 目标目录 top/e/ 必须是**空**（返回错误会被 assertNoConflict 当成 404 抛出去）
      if (pfx !== 'top/d/') return cb(null, { Contents: [], CommonPrefixes: [], IsTruncated: 'false', NextMarker: '' });
      cb(null, {
        Contents: [
          { Key: 'top/d/a.txt', Size: 10, LastModified: '2026-01-02T03:04:05.000Z' },
          { Key: 'top/d/b.txt', Size: 10, LastModified: '2026-01-02T03:04:05.000Z' },
        ],
        CommonPrefixes: [], IsTruncated: 'false', NextMarker: '',
      });
    },
    putObjectCopy(_p, cb) {
      copyCalls += 1;
      if (copyCalls >= 2) return cb(Object.assign(new Error('EntityTooLarge'), { statusCode: 400 }), null);
      cb(null, {});
    },
    deleteObject(_p, cb) { cb(Object.assign(new Error('回滚删除失败'), { statusCode: 500 }), null); },
  };

  const express = require(path.join(ROOT, 'node_modules', 'express'));
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.authUser = { id: 'u', username: 'u', role: 'admin' }; next(); });
  app.use('/api', fsRoutes);
  const server = await new Promise((resolve) => {
    const s = require('http').createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const port = server.address().port;
    // 用两级目录：parentOf('d/') === 'd/'，单级目录会让 newKey 落在源目录内部而被提前拒绝
    const body = JSON.stringify({ path: 'top/d/', newName: 'e' });
    const res = await new Promise((resolve, reject) => {
      const req = require('http').request({
        host: '127.0.0.1', port, method: 'POST', path: '/api/fs/rename',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-Requested-With': 'XMLHttpRequest',
        },
      }, (r) => {
        let raw = '';
        r.on('data', (c) => { raw += c; });
        r.on('end', () => resolve({ status: r.statusCode, raw }));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
    assertEqual(res.status, 500, `复制失败应返回 500，实际：${res.status} ${res.raw}`);
    assert(/孤儿副本/.test(res.raw),
      `回滚失败必须明确告知用户有孤儿副本要手工清理（旧实现把异常吞成一句注释），实际：${res.raw}`);
    const rb = logs.find((e) => e.action === 'fs.copy.rollback');
    assert(rb, '回滚失败必须留一条 error 级日志 —— 否则运维无从得知容量被白占');
    assertEqual(rb.level, 'error', '该日志应为 error 级');
  } finally {
    statsStore.addLog = origAddLog;
    await new Promise((r) => server.close(r));
  }
});

test('SEC-04 · /s/* 的非安全方法拒绝跨站来源；支付回调豁免', async () => {
  const shareRoutes = require(path.join(ROOT, 'server', 'share-routes.js'));
  const express = require(path.join(ROOT, 'node_modules', 'express'));
  const app = express();
  app.use('/', shareRoutes);
  const server = await new Promise((resolve) => {
    const s = require('http').createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  const post = (p, headers) => new Promise((resolve, reject) => {
    const req = require('http').request({
      host: '127.0.0.1', port, method: 'POST', path: p,
      headers: Object.assign({ 'Content-Length': '0' }, headers),
    }, (r) => {
      let raw = '';
      r.on('data', (c) => { raw += c; });
      r.on('end', () => resolve({ status: r.statusCode, raw }));
    });
    req.on('error', reject);
    req.end();
  });
  try {
    const evil = await post('/s/does-not-exist', {
      Origin: 'https://evil.example', Host: `127.0.0.1:${port}`,
    });
    assertEqual(evil.status, 403,
      '跨站 Origin 必须被拒 —— 否则第三方页面的自动提交表单可以替受害者创建支付订单');
    const cross = await post('/s/does-not-exist', {
      'Sec-Fetch-Site': 'cross-site', Host: `127.0.0.1:${port}`,
    });
    assertEqual(cross.status, 403, 'Sec-Fetch-Site: cross-site 必须被拒');
    // 无来源提示（脚本直连）不属于 CSRF 场景，不应误伤
    const direct = await post('/s/does-not-exist', { Host: `127.0.0.1:${port}` });
    assert(direct.status !== 403, `无来源提示的直连请求不应被 CSRF 拦截，实际：${direct.status}`);
    // 支付网关回调天然跨站，必须豁免（它另有验签 + 限流）
    const notify = await post('/pay/notify/not-a-platform', {
      Origin: 'https://evil.example', Host: `127.0.0.1:${port}`,
    });
    assert(notify.status !== 403, '支付回调必须豁免同源校验（否则真实网关回调会被全部拦掉）');

    // 同源 Origin 必须放行（这是正常浏览器提交表单的形态）
    const same = await post('/s/does-not-exist', {
      Origin: `http://127.0.0.1:${port}`, Host: `127.0.0.1:${port}`,
    });
    assert(same.status !== 403, `同源 Origin 不应被拦截，实际：${same.status}`);

    // Origin: "null"（不透明来源：沙箱 iframe / file:// 页面 / https→http 降级）
    // 是「拿不到来源」而非「来自别的站」，必须落到 Sec-Fetch-Site / Referer 判定，
    // 不能硬拒 —— 否则密码页与支付页的表单永远提交失败。
    const opaque = await post('/s/does-not-exist', { Origin: 'null', Host: `127.0.0.1:${port}` });
    assert(opaque.status !== 403,
      'Origin: null（不透明来源）不应被硬拒，应交给 Sec-Fetch-Site / Referer 判定 —— ' +
      '旧实现用 new URL("null") 解析直接抛异常 → 一律 403，密码页与支付页表单全部提交失败');

    // 但不透明来源 + 确凿跨站证据时仍必须拦住（安全等级不下降）
    const opaqueCross = await post('/s/does-not-exist', {
      Origin: 'null', 'Sec-Fetch-Site': 'cross-site', Host: `127.0.0.1:${port}`,
    });
    assertEqual(opaqueCross.status, 403, 'Origin: null 且 Sec-Fetch-Site: cross-site 仍必须被拒');
    const opaqueRef = await post('/s/does-not-exist', {
      Origin: 'null', Referer: 'https://evil.example/page', Host: `127.0.0.1:${port}`,
    });
    assertEqual(opaqueRef.status, 403, 'Origin: null 且 Referer 跨站仍必须被拒');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('FUN-13 · 有未落盘日志时轮转不再跳过（先冲缓冲再轮转）', async () => {
  const dir = tmpDir('cos-logs-');
  const file = path.join(dir, 'logs.jsonl');
  fs.writeFileSync(file, Array.from({ length: 6000 }, (_, i) => `{"t":"x","action":"a${i}"}`).join('\n') + '\n');

  const h = loadStatsStoreFresh(dir);
  try {
    h.mod.addLog({ action: 'unit-rotate' }); // 进入刷盘缓冲
    assert(require('fs').readFileSync(file, 'utf8').trim().split('\n').length === 6000, '缓冲尚未落盘');
    await h.mod.rotateLogs();
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).length;
    assert(lines <= 5000,
      `轮转必须生效（旧实现「有未落盘日志就跳过」，而日志持续产生 → 轮转长期不执行、文件无界增长），实际 ${lines} 行`);
  } finally {
    h.restore();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
});

test('PERF-02 · 连续多次配置变更合并为**一次**落盘；关闭去抖后恢复逐次写', async () => {
  const atomic = require(path.join(ROOT, 'server', 'atomic-write.js'));
  const orig = atomic.writeAtomic;
  let writes = 0;
  // 只数 config.enc —— 其它模块（enc-store / secure-store / share-store）共用同一个
  // atomic 模块，也会在后台落盘，混进来会让断言变得不可靠。
  atomic.writeAtomic = (f, t) => {
    if (String(f).indexOf('config.enc') >= 0) writes += 1;
    return orig(f, t);
  };
  try {
    await configStore.flush();
    writes = 0;
    for (let i = 0; i < 5; i++) configStore.save({});
    assertEqual(writes, 0, '去抖窗口内不应立刻写盘');
    await configStore.flush();
    assertEqual(writes, 1,
      '窗口内的 5 次变更必须合并成 1 次全量写 —— 每次都"序列化 + 加密 + 原子写"是纯粹的写放大');

    // 安全阀：CONFIG_WRITE_DEBOUNCE_MS=0 退回「立即写」
    process.env.CONFIG_WRITE_DEBOUNCE_MS = '0';
    await configStore.flush();
    writes = 0;
    for (let i = 0; i < 3; i++) configStore.save({});
    await configStore.flush();
    assertEqual(writes, 3, '关闭去抖后每次变更都应立即落盘（排查落盘问题时的退回路径）');
  } finally {
    delete process.env.CONFIG_WRITE_DEBOUNCE_MS;
    atomic.writeAtomic = orig;
    await configStore.flush();
  }
});

test('PERF-01 · 不同桶的碎片缓存互不干扰', async () => {
  let calls = 0;
  const client = {
    multipartList(_p, cb) { calls += 1; cb(null, { ListUploadsResult: { Upload: [], IsTruncated: 'false' } }); },
  };
  const base = { provider: 'tencent', secretId: 'sid', secretKey: 'skey', region: 'ap-guangzhou' };
  const c1 = Object.assign({}, base, { bucket: 'b1' });
  const c2 = Object.assign({}, base, { bucket: 'b2' });
  await shared.listFragments(client, c1, { noStat: true });
  await shared.listFragments(client, c2, { noStat: true });
  assertEqual(calls, 2, '两个桶应各拉一次');
  await shared.listFragments(client, c1, { noStat: true });
  assertEqual(calls, 2, '桶 1 命中缓存');
  listCache.noteCall('multipartComplete', { Bucket: 'b2', Region: 'ap-guangzhou', Key: 'k', UploadId: 'u' });
  await shared.listFragments(client, c1, { noStat: true });
  assertEqual(calls, 2, '只失效被写的那个桶');
  await shared.listFragments(client, c2, { noStat: true });
  assertEqual(calls, 3, '被写的桶重新拉取');
});

/* ============================ RE-01 ============================ */

/**
 * RE-01：`createFailLock` 的计数必须按窗口衰减，条目必须能被回收。
 *
 * 旧实现有两个连带缺陷：
 *  ① `sweep()` 的条件是 `v.lockedUntil && v.lockedUntil <= now && ...` ——
 *     未达锁定阈值的条目 `lockedUntil` 恒为 0，第一个条件恒假，于是
 *     「只有被锁定过的键才可能被回收」，其余条目**永不释放**（内存无界增长）；
 *  ② `count` 终身累计，`fail()` 从不判断"上次失败是否已滑出窗口" ——
 *     "连续失败 5 次"实际是"一辈子累计 5 次"，正常用户隔几天手误一次即被锁。
 *
 * ⚠️ 顺带记下一个修法上的坑：**只按审计建议①改 `sweep()` 是不够的** ——
 *    `sweep()` 受 windowMs 门控（每 windowMs 最多跑一遍）：只要有别的键在稍早时候
 *    触发过一次 sweep，陈旧条目就会在「门控关闭」期间被 `fail()` 撞上，既不被回收、
 *    计数又被累计，用户照样被误锁。计数衰减必须写在 `fail()` 里
 *    （下面第 2 条用例专门守住这一点）。
 *
 * 用例用**虚拟时钟**（临时替换 `Date.now`）驱动：预设实例的 windowMs 是 15 分钟，
 * 用真实 sleep 既慢又不确定；时间轴完全可控才能精确构造「sweep 门控被挡住」的边界。
 */
const withVirtualClock = (fn) => {
  const real = Date.now;
  let now = real.call(Date); // 从真实时间起算：避免跨天影响其它按日期分桶的模块
  Date.now = () => now;
  const tick = (ms) => { now += ms; };
  try {
    return fn(tick);
  } finally {
    Date.now = real;
  }
};

test('RE-01 · 失败计数按窗口衰减：跨窗口的手误不再累计成锁定', () => withVirtualClock((tick) => {
  const lock = security.createFailLock({ name: 're01-decay', maxFails: 5, baseLockMs: 1000, windowMs: 1000 });
  try {
    for (let i = 1; i <= 4; i++) {
      assertEqual(lock.fail('u'), 0, `窗口内第 ${i} 次失败不应锁定（阈值 5）`);
    }
    tick(5000); // 窗口滑过
    assertEqual(lock.fail('u'), 0,
      '窗口滑过后的这次失败必须重新从 1 计数 —— 旧实现终身累计，这里就会直接锁定，' +
      '表现为「正常用户隔几天手误一次，第 5 次被锁在门外」');
    for (let i = 1; i <= 3; i++) {
      assertEqual(lock.fail('u'), 0, `新窗口内第 ${i} 次失败仍不应锁定（累计 4 次）`);
    }
    assert(lock.fail('u') > 0, '同一窗口内第 5 次失败才应锁定（“连续”语义必须仍然生效）');
  } finally {
    lock.clear();
  }
}));

/**
 * 这一条专门守住「只按审计建议改 sweep() 还不够」：
 * `sweep()` 受 windowMs 门控（每 windowMs 最多跑一遍），只要有**别的键**在稍早时候
 * 触发过一次 sweep，陈旧条目就会在「门控关闭」期间被 fail() 撞上 —— 此时它既不会被
 * 回收，计数又被累计，用户照样被误锁。所以衰减必须写在 fail() 里。
 */
test('RE-01 · sweep 门控挡住回收时，陈旧计数也不得累计（衰减必须在 fail() 内）', () => withVirtualClock((tick) => {
  const lock = security.createFailLock({ name: 're01-gate', maxFails: 3, baseLockMs: 1500, maxLockMs: 1500, windowMs: 600 });
  try {
    for (let i = 0; i < 3; i++) lock.fail('u'); // 锁定至 +1500
    tick(1200);
    lock.fail('o1'); // 距上次 sweep 已 ≥ windowMs → sweep 跑一遍；'u' 仍在锁定期内 → 不被回收
    tick(500);       // 距上次 sweep 仅 500ms（< 600）→ 下一次 sweep 被门控挡住
    assertEqual(lock.fail('u'), 0,
      '锁定早已过期、条目早已陈旧，sweep 又被门控挡住时，这次失败必须重新计数；' +
      '只改 sweep() 的话这里仍会累计到阈值把用户锁住');
  } finally {
    lock.clear();
  }
}));

test('RE-01 · 锁定期内不因窗口滑过而解除（衰减不得沦为解锁后门）', () => withVirtualClock((tick) => {
  const lock = security.createFailLock({ name: 're01-nobypass', maxFails: 3, baseLockMs: 5000, windowMs: 30 });
  try {
    let left = 0;
    for (let i = 0; i < 3; i++) left = lock.fail('a');
    assert(left > 0, '连续 3 次失败后应被锁定');

    tick(60); // 窗口已滑过，但锁定（5s）仍在有效期内
    assert(lock.locked('a') > 0, '锁定期内仍应处于锁定状态');
    assert(lock.fail('a') > 0,
      '锁定期内继续失败不得把计数/锁定清零 —— 否则攻击者「等到窗口滑过再失败一次」' +
      '就能自行解锁（fail 与 locked 之间存在并发窗口，同一次请求可能已通过 locked 检查）');
  } finally {
    lock.clear();
  }
}));

test('RE-01 · 陈旧条目会被回收，键数量受硬上限约束（不再无界增长）', () => withVirtualClock((tick) => {
  const lock = security.createFailLock({ name: 're01-sweep', maxFails: 5, windowMs: 40, maxEntries: 3 });
  try {
    lock.fail('a');
    assertEqual(lock.size(), 1, '记一次失败后应跟踪 1 个键');
    tick(70);
    lock.fail('b'); // 这一次会触发 sweep
    assertEqual(lock.size(), 1,
      `滑出窗口的陈旧条目应被回收（旧实现的回收条件恒假，size 会停在 2），实际 ${lock.size()}`);

    for (let i = 0; i < 30; i++) lock.fail(`flood-${i}`);
    assert(lock.size() <= 3,
      `匿名入口可灌入任意多个新键，必须有硬上限兜底（旧实现是无界增长），实际 ${lock.size()}`);
  } finally {
    lock.clear();
  }
}));

test('RE-01 · 上限淘汰优先清理未锁定条目，锁定中的键不被挤掉', () => withVirtualClock(() => {
  const lock = security.createFailLock({ name: 're01-cap', maxFails: 2, baseLockMs: 60000, windowMs: 40, maxEntries: 2 });
  try {
    lock.fail('vip');
    lock.fail('vip');
    assert(lock.locked('vip') > 0, 'vip 应已被锁定');
    for (let i = 0; i < 10; i++) lock.fail(`x-${i}`);
    assert(lock.locked('vip') > 0,
      '淘汰应优先清理无防护价值的未锁定条目 —— 纯按插入顺序淘汰会把最先建立的锁定挤掉，' +
      '等于给了攻击者一条「用垃圾键冲掉别人锁定」的路径');
    assert(lock.size() <= 2, `键数量仍须受上限约束，实际 ${lock.size()}`);
  } finally {
    lock.clear();
  }
}));

test('RE-01 · 预设实例（登录锁定）的连续失败语义未被衰减改动破坏', () => {
  security.loginLock.clear();
  try {
    const key = authRoutes.loginLockKey('198.51.100.7', 'admin');
    for (let i = 1; i <= 4; i++) {
      assertEqual(security.loginLock.fail(key), 0, `15 分钟窗口内第 ${i} 次不应锁定`);
    }
    assert(security.loginLock.fail(key) > 0, '同一窗口内第 5 次失败应触发锁定');
  } finally {
    security.loginLock.clear();
  }
});

/* ============================ RE-03 ============================ */

/**
 * RE-03：`process.on('exit')` 里必须用**同步**写。
 *
 * 退出处理器返回后进程立即终止，事件循环不再推进：异步写只是把任务排进队列，
 * 回调永远不会被调度 —— 旧实现把 exit 兜底挂在 `writeJsonAsync` 上，
 * 注释声称覆盖 kill / 崩溃，实际一个字节都写不进去（真实生效的只有优雅停机）。
 *
 * 这里用**真的子进程**验证：建会话后立刻退出，去抖（300ms）尚未到期，
 * 此时唯一能落盘的路径就是 exit 兜底。
 */
test('RE-03 · 进程退出兜底落盘走同步写：去抖窗口内被强杀也不丢分片元数据', () => {
  const dir = tmpDir('cos-upsess-');
  const file = path.join(dir, 'upload-sessions.json');
  const upsessPath = path.join(ROOT, 'server', 'upload-sessions.js');
  try {
    const script = [
      `const up = require(${JSON.stringify(upsessPath)});`,
      'const t0 = Date.now();',
      "up.create({ uploadId: 'up-RE03', key: 'big.bin', bucket: 'bkt', region: 'ap-guangzhou',",
      "            size: 123, chunkSize: 5, createdBy: 'u1' });",
      'const elapsed = Date.now() - t0;',
      // 反真空：若 create() 本身慢到去抖（300ms）已到期，本次断言就失去意义了
      'process.exit(elapsed >= 200 ? 7 : 0);',
    ].join('\n');

    const { spawnSync } = require('child_process');
    const child = spawnSync(process.execPath, ['-e', script], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { COS_DATA_DIR: dir }),
      encoding: 'utf8',
      timeout: 30000,
    });
    /**
     * 诊断必须自带「为什么是 null」：本机（Windows + 托管 node）`spawnSync` 有时
     * **根本没起进程就返回** `status=null` / `signal=null` / 空 stdout+stderr，
     * 真实原因只存在于 `child.error`（EBUSY）。不打印它，现场就只剩一个 `null`，
     * 每次都要重新复现一遍才能判断「是环境问题还是真回归」。
     */
    const spawnNote = `status=${child.status} signal=${child.signal}`
      + ` error=${child.error ? child.error.code || child.error.message : '无'}`;
    assertEqual(child.status, 0,
      `子进程应在去抖到期前正常退出（7 = 反真空检查失败；status=null 且带 EBUSY 即环境性失败）`
      + `【${spawnNote}】：${child.stderr || child.stdout || '(无输出)'}`);

    assert(fs.existsSync(file),
      '退出时挂起的会话必须已落盘 —— 旧实现挂的是异步写，exit 后回调不再被调度，文件根本不会生成');

    /**
     * R13-01 顺带曝光的潜伏缺陷：子进程跑在自己的 COS_DATA_DIR 里，主密钥也只存在
     * 那边（dir/secret.key）—— 父进程的 configStore 绑定的是**另一个**数据目录，
     * 直接 `secureStore.readJson()` 必然 GCM 认证失败。本机 spawnSync 恒 EBUSY 时
     * 本条用例走不到这一步，该缺陷一直被掩盖（与 R13「它们的失败会让检测失真」同源）。
     * 这里改用**子进程的密钥**手动解密（封装格式见 config-store encrypt()：
     * base64( iv(12) | tag(16) | ciphertext )），完整保留「密文可往返」这一半断言。
     */
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert(payload && payload._enc === 1 && typeof payload.data === 'string',
      '落盘文件应是 secure-store 的加密封装格式（_enc=1）');
    const childKey = Buffer.from(fs.readFileSync(path.join(dir, 'secret.key'), 'utf8').trim(), 'hex');
    const blob = Buffer.from(payload.data, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', childKey, blob.subarray(0, 12));
    decipher.setAuthTag(blob.subarray(12, 28));
    const sessions = JSON.parse(Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]).toString('utf8'));
    const saved = Object.values(sessions || {}).find((s) => s && s.uploadId === 'up-RE03');
    assert(saved, `落盘的会话应含刚创建的 uploadId，实际：${JSON.stringify(sessions)}`);
    assertEqual(saved.key, 'big.bin', '加密元数据应能完整往返（这是分片后续解密的唯一凭据）');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
});
