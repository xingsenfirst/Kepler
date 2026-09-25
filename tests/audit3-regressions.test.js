/**
 * 第三轮代码审查（2026-09-15）修复回归护栏
 *
 * ## 与上一份护栏的关系
 *
 * `audit-regressions.test.js` 覆盖 2026-09-14 那轮 36 项。本轮 33 项里，
 * 有 6 项是**同型复发**（同一类错误换个文件再犯一次）—— 说明「改了一个调用点」
 * 并不等于「修好了这一类问题」。因此本文件的用例刻意**驱动共享实现本身**，
 * 而不是去断言某个文件里的字符串：
 *
 *   - `listAllExact` 是「完整列举」的唯一实现，rename/move/movePrefix 都走它；
 *   - `unwritableError` 是「关键文件拒绝覆盖」的唯一实现，config/secret/enc 共用；
 *   - `paymentMockEnabled()` 是模拟支付开关的唯一判定，页面与端点共用。
 *
 * 这样即使以后新增调用点，只要它接的是同一个函数，护栏就自动生效。
 *
 * 写法遵循上轮定下的原则：**行为断言优先**，确需读源码时用 `readCode()`（去注释）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { assert, assertEqual, assertReject, ROOT } = require('./helpers');

const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** 去掉注释后的源码（防止"旧实现曾经…"这类说明性文字误伤断言） */
const readCode = (rel) => readSrc(rel)
  .split('\n')
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join('\n');

/** 轮询等待条件成立（异步落盘用 setImmediate 等不到，真实 I/O 需要多轮事件循环） */
async function waitUntil(fn, msg, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('等待超时：' + (msg || ''));
}

/* ==================================================================
 * FUN-01 · payment-orders 读取失败后必须锁定写入
 * ================================================================== */

test('FUN-01 · 订单文件不可信时锁定写入，绝不把磁盘历史订单覆盖成空表', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fun01-'));
  const file = path.join(dir, 'payments.json');
  const broken = '{ this is not json ]';
  fs.writeFileSync(file, broken);

  const modPath = require.resolve(path.join(ROOT, 'server', 'payment-orders.js'));
  const prevEnv = process.env.COS_DATA_DIR;
  process.env.COS_DATA_DIR = dir;
  delete require.cache[modPath];
  try {
    const orders = require(modPath);

    // ① 损坏文件下依然可用（内存降级为空表），但**不能**落盘
    const before = fs.readdirSync(dir).filter((x) => /^payments\.json/.test(x));
    orders.create({ linkId: 'L1', platform: 'alipay', amountFen: 100, currency: 'CNY', payerIp: '1.2.3.4' });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assertEqual(fs.readFileSync(file, 'utf8'), broken, '读取失败后不得写入 —— 否则历史订单被空表覆盖');
    assert(
      fs.readdirSync(dir).filter((x) => /\.corrupt-/.test(x)).length >= 1,
      '应保留 .corrupt-* 备份，让"不可逆"降级为"可人工恢复"',
    );
    assert(before.length >= 1, '前置条件：订单文件确实存在');
  } finally {
    if (prevEnv === undefined) delete process.env.COS_DATA_DIR;
    else process.env.COS_DATA_DIR = prevEnv;
    delete require.cache[modPath];
  }
});

test('FUN-01 · 模块顶层已引入 fs：加载后 load() 不因 ReferenceError 崩溃', () => {
  // 历史上这里漏了 `require('fs')`，而 `node -e` 的求值上下文自带全局 fs，
  // 导致「看起来能用」。这里用**真实文件**再 require 一次，才能真正复现模块作用域。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fun01b-'));
  const modPath = require.resolve(path.join(ROOT, 'server', 'payment-orders.js'));
  const prevEnv = process.env.COS_DATA_DIR;
  process.env.COS_DATA_DIR = dir;
  delete require.cache[modPath];
  try {
    const orders = require(modPath);
    // 触发一次 load()：文件不存在分支同样会走 fs.existsSync
    const list = orders.listForLink('nope');
    assert(Array.isArray(list), 'load() 必须正常返回数组，而不是抛 ReferenceError: fs is not defined');
  } finally {
    if (prevEnv === undefined) delete process.env.COS_DATA_DIR;
    else process.env.COS_DATA_DIR = prevEnv;
    delete require.cache[modPath];
  }
});

/* ==================================================================
 * FUN-02 · 「列举→复制→删源」必须完整列举，截断即拒绝
 * ================================================================== */

test('FUN-02 · listAllExact 截断即抛错，绝不返回"部分集合"', async () => {
  const { listAllExact } = require(path.join(ROOT, 'server', 'cos.js'));

  const page = (from, n) => ({
    Contents: Array.from({ length: n }, (_, i) => ({
      Key: `d/${from + i}`, Size: 1, LastModified: '2026-01-01T00:00:00Z',
    })),
    IsTruncated: 'true',
    NextMarker: `d/${from + n - 1}`,
  });
  let call = 0;
  const pages = [page(0, 1000), page(1000, 1000)];
  const fakeCos = { getBucket: (p, cb) => cb(null, pages[call++] || { Contents: [], IsTruncated: 'false' }) };
  const cfg = { bucket: 'b', region: 'r' };

  // cap=500：第一页就截断 → 必须抛错（旧实现静默返回 500 条，随后删源会删掉没复制的对象）
  await assertReject(() => listAllExact(fakeCos, cfg, 'd/', { cap: 500 }, '移动'), '截断时必须抛错');

  // 抛出的错误要能被路由层正确转成 4xx，而不是 500
  let err = null;
  call = 0;
  try { await listAllExact(fakeCos, cfg, 'd/', { cap: 500 }, '移动'); } catch (e) { err = e; }
  assertEqual(err && err.status, 400, '截断应返回 400（用户可分批重试），不是 500');
  assert(err && err.truncated === true, '错误应带 truncated 标记，便于上层识别');

  // 完整列举成功时不抛错
  call = 0;
  const all = await listAllExact(fakeCos, cfg, 'd/', { cap: 5000 }, '移动');
  assertEqual(all.length, 2000, '未截断时应返回全部对象');
});

test('FUN-02 · rename / move / movePrefix 三个入口都走 listAllExact（不再各自 listAll）', () => {
  const fsCode = readCode('server/routes/fs.js');
  const gwCode = readCode('server/fs-gateway.js');

  // 旧实现：目录分支用 `listAll(client, cfg, key, { cap: LIMITS.STAT })`，不判截断
  assert(!/listAll\(client,\s*cfg,\s*key,\s*\{\s*cap:\s*LIMITS\.STAT/.test(fsCode),
    'routes/fs.js 的目录分支不得再用「不判截断」的 listAll');
  assert(/listAllExact/.test(fsCode), 'routes/fs.js 应改用 listAllExact');
  assert(/listAllExact/.test(gwCode), 'fs-gateway.js 应改用 listAllExact（与 routes 同源）');
});

/* ==================================================================
 * FUN-03 / FUN-04 · 关键数据文件「先备份、再拒绝覆盖」
 * ================================================================== */

test('FUN-03/04 · unwritableError 生成备份并拒绝写入，同一文件只备份一次', () => {
  const configStore = require(path.join(ROOT, 'server', 'config-store.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fun03-'));
  const f = path.join(dir, 'secret.key');
  fs.writeFileSync(f, 'not-a-key');

  const e1 = configStore.unwritableError(f, 'bad', '内容不是合法的 32 字节十六进制密钥');
  assertEqual(e1.status, 500, '应是可被路由层识别的 5xx');
  assertEqual(e1.corrupt, true, '应带 corrupt 标记');
  const backups = fs.readdirSync(dir).filter((x) => /\.bad-/.test(x));
  assertEqual(backups.length, 1, '首次应生成一份备份');

  // 幂等：损坏状态下会被反复调用，不能每次都复制一份（会淹没真正需要的那一份）
  configStore.unwritableError(f, 'bad', '内容不是合法的 32 字节十六进制密钥');
  assertEqual(fs.readdirSync(dir).filter((x) => /\.bad-/.test(x)).length, 1, '同一文件重复调用不应产生新备份');
});

test('FUN-03/04 · secret.key / config.enc 读取失败时抛错，绝不静默重建或覆盖', () => {
  const code = readCode('server/config-store.js');
  const encCode = readCode('server/enc-store.js');
  assert(/unwritableError\(KEY_FILE, 'bad'/.test(code), 'config-store 的 getMasterKey 不得静默重建密钥');
  assert(/unwritableError\(KEY_FILE, 'bad'/.test(encCode), 'enc-store 的 masterKey 同样不得静默重建（同型复发点）');
  assert(/corrupted/.test(code) && /requireStore/.test(code), 'requireStore 仍应区分损坏状态');
});

/* ==================================================================
 * FUN-06 · 普通操作不得改写「全局默认桶」
 * ================================================================== */

/**
 * 取出去注释源码中某个顶层函数的函数体。
 *
 * 这里不用全局正则，是因为 `migrateV1()`（旧版配置迁移）**本来就该**设置
 * activeBucketId —— 一刀切的 `!/cfg.activeBucketId =/` 会误伤它。
 * 按函数切片才能精确表达「addBucket / addCredential 不得改写全局默认桶」。
 */
function fnBody(code, name) {
  const parts = code.split(/\nfunction /);
  const hit = parts.find((p) => new RegExp(`^${name}\\b`).test(p));
  if (!hit) throw new Error(`未找到函数 ${name}`);
  return hit;
}

test('FUN-06 · addBucket / addCredential 不再顺手改写 activeBucketId / activeCredentialId', () => {
  const code = readCode('server/config-store.js');

  const addBucket = fnBody(code, 'addBucket');
  const addCredential = fnBody(code, 'addCredential');
  assert(!/cfg\.activeBucketId\s*=/.test(addBucket),
    'addBucket 不得直接改写全局默认桶 —— 普通用户调它会污染系统默认值');
  assert(!/cfg\.activeCredentialId\s*=/.test(addCredential),
    'addCredential 不得直接改写全局默认密钥');

  // 迁移旧版配置时设置默认值是**正确**的，护栏不能把它一起否掉
  const migrate = fnBody(code, 'migrateV1');
  assert(/activeCredentialId\s*=/.test(migrate), '前置条件：migrateV1 仍负责给旧配置补默认值');

  // 界面层需要"新建后自动切过去"的体验，由路由显式调用，语义外显
  const bucketsCode = readCode('server/routes/buckets.js');
  assert(/setActiveBucket\(/.test(bucketsCode), '路由层应显式调用 setActiveBucket 保留原有 UX');
  const configRouteCode = readCode('server/routes/config.js');
  assert(/setActiveCredential\(/.test(configRouteCode), '路由层应显式调用 setActiveCredential 保留原有 UX');
});

/* ==================================================================
 * SEC-05 · 模拟支付端点默认关闭
 * ================================================================== */

/**
 * SEC-05 的**当前形态**：接入真实网关后，原先的模拟端点 `/s/:id/pay/confirm`
 * 已随整个模拟开关一并删除。护栏的方向也随之反转 —— 不再是"模拟端点默认关闭"，
 * 而是"根本不存在可以绕开网关确认就置为已支付的入口"。
 */
/** 列出 server/ 下全部 .js（含子目录），供全量扫描使用 */
function serverJsFiles() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) out.push(p);
    }
  };
  walk(path.join(ROOT, 'server'));
  return out;
}

test('SEC-05 · 不存在可绕开网关确认、自行置为已支付的入口', () => {
  const router = require(path.join(ROOT, 'server', 'share-routes.js'));
  const paths = router.stack.filter((l) => l.route).map((l) => l.route.path);
  assert(!paths.some((p) => /pay\/confirm/.test(p)), '开发期模拟端点 pay/confirm 应已随真实网关接入而删除');

  // 承诺是「全库仅一处调用 markPaid」，扫描范围就必须是 server/ 下的全部源码：
  // 只看 share-routes.js 时，在别的文件里调用一次即可同时骗过文档与护栏。
  const hits = [];
  let total = 0;
  for (const file of serverJsFiles()) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    const src = readCode(rel);
    assert(!/paymentMockEnabled|PAYMENT_MOCK/.test(src), `不应残留模拟支付开关（含函数与环境变量）：${rel}`);
    const n = src.split('paymentOrders.markPaid(').length - 1;
    if (n > 0) { total += n; hits.push(`${rel} ×${n}`); }
  }
  assertEqual(total, 1, `全库（server/**/*.js）应只有一处 markPaid 调用，实际命中：${hits.join(', ') || '无'}`);

  // 这唯一一处必须位于 finalizeOrder 内部，且只能由网关查单结果驱动
  const code = readCode('server/share-routes.js');
  const iFinalize = code.indexOf('async function finalizeOrder');
  const iMarkPaid = code.indexOf('paymentOrders.markPaid(');
  assert(iFinalize >= 0, '应存在统一的查单落地函数 finalizeOrder');
  assert(iMarkPaid > iFinalize, 'markPaid 必须只出现在 finalizeOrder 内部');

  // 所有会改变订单状态的入口都必须走 finalizeOrder
  for (const p of ['/s/:id/pay/return', '/s/:id/pay/check']) {
    assert(paths.includes(p), `应存在支付结果入口 ${p}`);
  }
  assert(paths.includes('/pay/notify/:platform'), '应存在网关异步通知入口');
});

test('SEC-05 · 网关查单失败时不得判为已支付（失败必须 fail-closed）', () => {
  const gw = require(path.join(ROOT, 'server', 'payment-gateway.js'));
  return gw.queryCharge('alipay', { appId: 'x', privateKey: '' }, { id: 'nope', amountFen: 100 })
    .then((r) => {
      assertEqual(r.paid, false, '查单失败时不得判为已支付');
      assert(r.state !== 'paid', '状态不得为 paid');
    });
});

/* ==================================================================
 * SEC-08 · 加密元数据必须能同步落盘
 * ================================================================== */

test('SEC-08 · flushMeta 同步落盘：调用后不存在"未落盘变更"', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec08-'));
  const modPath = require.resolve(path.join(ROOT, 'server', 'enc-store.js'));
  const prevEnv = process.env.COS_DATA_DIR;
  process.env.COS_DATA_DIR = dir;
  delete require.cache[modPath];
  try {
    const encStore = require(modPath);
    assert(typeof encStore.flushMeta === 'function', '应导出 flushMeta');
    assert(typeof encStore.metaDirty === 'function', '应导出 metaDirty');

    assertEqual(encStore.metaDirty(), false, '初始状态没有未落盘变更');

    encStore.setMeta('bkt', 'a.txt', { mode: 'crypto', origSize: 1, createdAt: 'x', crypto: { segments: [] } });
    assertEqual(encStore.metaDirty(), true, 'setMeta 后应存在未落盘变更（异步写尚未完成）');

    assertEqual(encStore.flushMeta(), true, 'flushMeta 应实际执行了一次落盘');
    assertEqual(encStore.metaDirty(), false, 'flushMeta 后不得再有未落盘变更');

    // 幂等：无变更时不产生 I/O
    assertEqual(encStore.flushMeta(), false, '无变更时 flushMeta 应为空操作');

    // 落盘内容必须真的在磁盘上（enc-meta.json 是解密的唯一凭据）
    const metaFile = path.join(dir, 'enc-meta.json');
    assert(fs.existsSync(metaFile), 'enc-meta.json 必须已存在于磁盘');
  } finally {
    if (prevEnv === undefined) delete process.env.COS_DATA_DIR;
    else process.env.COS_DATA_DIR = prevEnv;
    delete require.cache[modPath];
  }
});

test('SEC-08 · 后续变更不能被"更早的异步写回调"误标为已落盘', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec08b-'));
  const modPath = require.resolve(path.join(ROOT, 'server', 'enc-store.js'));
  const prevEnv = process.env.COS_DATA_DIR;
  process.env.COS_DATA_DIR = dir;
  delete require.cache[modPath];
  try {
    const encStore = require(modPath);
    encStore.setMeta('bkt', 'a.txt', { mode: 'crypto', origSize: 1 });
    await waitUntil(() => !encStore.metaDirty(), '第一次异步写应能完成');
    encStore.setMeta('bkt', 'b.txt', { mode: 'crypto', origSize: 2 });
    await waitUntil(() => !encStore.metaDirty(), '第二次异步写应能完成');
    assertEqual(encStore.metaDirty(), false, '全部异步写完成后不应再有未落盘变更');

    // 再改一次：此时 dirty 必须重新变 true，且 flush 后归零
    encStore.setMeta('bkt', 'c.txt', { mode: 'crypto', origSize: 3 });
    assertEqual(encStore.metaDirty(), true, '新变更必须重新标记为未落盘');
    assertEqual(encStore.flushMeta(), true, 'flushMeta 应落盘新变更');
    assertEqual(encStore.metaDirty(), false, 'flushMeta 后应归零');
  } finally {
    if (prevEnv === undefined) delete process.env.COS_DATA_DIR;
    else process.env.COS_DATA_DIR = prevEnv;
    delete require.cache[modPath];
  }
});

/* ==================================================================
 * SEC-07 · WebDAV 必须纳入 IP 屏蔽
 * ================================================================== */

test('SEC-07 · WebDAV 复用主服务的 IP 判定（guardRequest），且早于认证执行', () => {
  const ipGuard = require(path.join(ROOT, 'server', 'ip-guard.js'));
  assert(typeof ipGuard.guardRequest === 'function', 'ip-guard 应导出 guardRequest 供 WebDAV 复用');

  const code = readCode('server/webdav-server.js');
  const guardAt = code.indexOf('ipGuard.guardRequest');
  const authAt = code.indexOf('app.use(authMiddleware)');
  assert(guardAt >= 0, 'WebDAV 必须挂载 IP 守卫 —— 独立端口不等于可以绕开屏蔽规则');
  assert(guardAt < authAt, 'IP 守卫应早于认证：命中屏蔽时连 scrypt 都不必算');
});

/* ==================================================================
 * SEC-10 · 分片上传三个接口都必须校验会话归属
 * ================================================================== */

test('SEC-10 · chunk / complete / abort 共用 assertSessionOwner 判定', () => {
  const code = readCode('server/routes/fs.js');
  const count = (code.match(/assertSessionOwner\(sess, req\)/g) || []).length;
  assert(count >= 3, `三个分片接口都必须校验归属（实际 ${count} 处）—— 漏一个就仍能替他人完成/中止上传`);
  assert(/function assertSessionOwner/.test(code), '归属判定应收敛为一个函数，避免各接口各写一份');
});

/* ==================================================================
 * SEC-11 · 云端桶列表只有一个入口且仅管理员 / 碎片列表仅管理员
 *
 * 原先 `GET /buckets`（requireAdmin）与 `POST /config/verify`（曾对普通用户开窄缝）
 * 都在回传云端桶名，两条路径两套判定 —— 后者等于让普通用户枚举账号资产。
 * 现在 `GET /buckets` 已删除（死代码），云端桶列表收敛为 `POST /config/verify` 唯一入口，
 * 且必须挂 requireAdmin（该断言在 tests/config-verify-permission.test.js 里以真实请求验证）。
 * ================================================================== */

test('SEC-11 · 云端桶列表收敛为单一入口且仅管理员', () => {
  const bucketsCode = readCode('server/routes/buckets.js');
  const configCode = readCode('server/routes/config.js');
  assert(!/router\.get\('\/buckets'/.test(bucketsCode),
    'GET /buckets 应已删除（死代码），云端桶列表只允许 POST /config/verify 一个入口');
  assert(/router\.post\('\/config\/verify',\s*requireAdmin/.test(configCode),
    '云端桶列表的唯一入口 POST /config/verify 必须挂 requireAdmin');
  assert(/router\.get\('\/buckets\/local\/:id\/fragments',\s*requireAdmin/.test(bucketsCode), '碎片列表必须仅管理员可见');
});

/* ==================================================================
 * SEC-12 · WebDAV 路径必须走 normalizeKey
 * ================================================================== */

test('SEC-12 · reqPathToKey 拒绝 ".." 且畸形编码按 400 处理（不再产生幽灵对象）', () => {
  const webdav = require(path.join(ROOT, 'server', 'webdav-server.js'));
  const toKey = webdav.__reqPathToKey;
  assert(typeof toKey === 'function', '应导出 __reqPathToKey 供测试驱动');

  assertEqual(toKey('/dav/a/b.txt'), 'a/b.txt', '常规路径应正常转换');
  assertEqual(toKey('/dav/dir/'), 'dir/', '目录保留尾斜杠');
  assertEqual(toKey('/dav/'), '', '根路径应为为空');

  // 含 '..' 的路径必须被拒 —— 否则会写出管理端看不到也删不掉的幽灵对象
  let err = null;
  try { toKey('/dav/..%2f..%2fx'); } catch (e) { err = e; }
  assert(!!err && err.status === 400, '含 ".." 的路径必须抛 400');

  // 畸形百分号编码：decodeURIComponent 会抛 URIError，必须转成 400 而不是 500
  let e2 = null;
  try { toKey('/dav/%ZZ'); } catch (e) { e2 = e; }
  assert(!!e2 && e2.status === 400, '畸形编码必须按 400 处理（旧实现直接 500）');
});

/* ==================================================================
 * FUN-11 · WebDAV 列举上限取自 limits.js
 * ================================================================== */

test('FUN-11 · WebDAV 的 PROPFIND 上限与 limits.js 一致（不再硬编码 20000）', () => {
  const webdav = require(path.join(ROOT, 'server', 'webdav-server.js'));
  const { LIMITS } = require(path.join(ROOT, 'server', 'limits.js'));
  assertEqual(webdav.__PROPFIND_CAP, LIMITS.PROPFIND, 'PROPFIND 上限应来自集中定义');
  assert(webdav.__PROPFIND_CAP < 20000, '不得再使用旧硬编码值 20000');
});

/* ==================================================================
 * FUN-09 · 直传路径也要带上 gitignore 排除参数
 * ================================================================== */

test('FUN-09 · /fs/upload/simple 与前端均传递 gitignore 排除参数', () => {
  const code = readCode('server/routes/fs.js');
  assert(/upload\/simple[\s\S]{0,400}assertNotExcluded\(key,/.test(code),
    '直传端点应把 gitignore 规则交给 assertNotExcluded（≤8MB 是最常用的路径）');
  const up = readCode('public/js/upload.js');
  assert(/giQuery\s*=\s*\(t\.gitignore/.test(up), '前端应组装 gitignore 查询串');
  assert(/mtime=\$\{t\.mtime\}\$\{giQuery\}/.test(up), '直传请求的 URL 应把 gitignore 查询串拼进去');
});

/* ==================================================================
 * SEC-09 · 预签名直链收敛暴露窗口并留痕
 * ================================================================== */

test('SEC-09 · 直链有效期上限收敛到 24 小时，且签发写入审计日志', () => {
  const code = readCode('server/routes/fs.js');
  assert(/MAX_PRESIGN_EXPIRES\s*=\s*24\s*\*\s*3600/.test(code), '直链 TTL 上限应为 24 小时（原为 7 天）');
  assert(/action:\s*'fs\.presign'/.test(code), '签发直链必须留下审计记录（此前完全没有）');
});

/* ==================================================================
 * SEC-13 · /auth/me 必须回实时用户，而不是登录快照
 * ================================================================== */

/**
 * ⚠️ 这条护栏**曾经是假护栏**：旧写法断言 `/findUserRawById\(session\.userId\)/`，
 * 恰好把 bug 本身当成了正确实现钉住 —— 会话对象上根本没有 `userId` 字段，
 * 取值恒为 undefined，于是每次调用 /auth/me 都判定"用户已不存在"并销毁会话，
 * 表现为「一刷新就掉线」。现在改为**禁止**出现该字段名的反向断言，
 * 真正的判定交给 tests/auth-session.test.js 里的行为测试（起服务打真实请求）。
 */
test('SEC-13 · /auth/me 读取实时用户记录，且用户被删后立即失效', () => {
  const code = readCode('server/routes/auth.js');
  assert(!/res\.json\(\{\s*ok:\s*true,\s*user:\s*session\.user\s*\}\)/.test(code),
    '不得再回传 session.user（登录快照）—— 降权后前端会按旧角色渲染');
  assert(!/session\.userId/.test(code),
    '会话对象上没有 userId 字段（历史 bug：写成 session.userId 恒为 undefined，每次探测都销毁会话）');
  assert(/findUserRawById\(\s*session\.user\s*(&&|,|\?)[\s\S]{0,40}session\.user\.id/.test(code),
    '应按 session.user.id 读取实时记录');
  assert(/userView\(/.test(code), '回传前必须走 userView，不能把含 passwordHash 的原始记录吐出去');
  assert(/destroySession\(token\)/.test(code), '用户已不存在时应立即销毁会话');
});

/* ==================================================================
 * SEC-14 · confirmDialog 危险默认值
 * ================================================================== */

test('SEC-14 · confirmDialog 默认转义，HTML 需显式声明', () => {
  const src = readSrc('public/js/util.js');
  assert(/allowHtml = false/.test(src), '默认必须是"转义"（旧默认 true 是极易复发的 XSS 入口）');

  // 现存 14 个调用点确实用到富文本，必须**逐个**显式声明，不能靠默认值蒙混
  const files = ['bucketmgr.js', 'credmgr.js', 'linkmgr.js', 'main.js', 'ops.js', 'paysettings.js', 'syssettings.js'];
  let missing = [];
  for (const f of files) {
    const code = readCode('public/js/' + f);
    const calls = code.split('confirmDialog({').length - 1;
    const flagged = (code.match(/confirmDialog\(\{\s*allowHtml:\s*true/g) || []).length;
    if (calls !== flagged) missing.push(`${f}(调用 ${calls} / 已声明 ${flagged})`);
  }
  assertEqual(missing.length, 0, `以下文件的 confirmDialog 未全部显式声明 allowHtml：${missing.join('、')}`);
});

/* ==================================================================
 * LOW-28 / PERF-16 · 上限集中化与内存峰值收敛
 * ================================================================== */

test('LOW-28 · /fs/list 的单页上限取自 limits.js（不再硬编码 1000）', () => {
  const code = readCode('server/routes/fs.js');
  assert(/Math\.min\(LIMITS\.LIST_PAGE/.test(code), '单页上限应来自集中定义');
  const { LIMITS } = require(path.join(ROOT, 'server', 'limits.js'));
  assertEqual(LIMITS.LIST_PAGE, 1000, '集中值应保持 1000（对象存储单页上限）');
});

test('PERF-16 · 加密 Range 缓冲区上限收敛到 32MB（峰值内存 384MB → 96MB）', () => {
  const code = readCode('server/fs-gateway.js');
  assert(/MAX_RANGE_BUFFER\s*=\s*32\s*\*\s*1024\s*\*\s*1024/.test(code),
    'MAX_RANGE_BUFFER 应降到 32MB —— 3 路并发 × 128MB 的峰值内存不可接受');
});

/* ==================================================================
 * LOW-21 · 凭据视图不再回传 SecretId 尾号
 * ================================================================== */

test('LOW-21 · credentialView 不回传 secretIdTail（减少密钥标识外泄）', () => {
  const code = readCode('server/config-store.js');
  assert(!/secretIdTail/.test(code), 'credentialView 不应再输出 secretIdTail');
});
