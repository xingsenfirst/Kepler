/**
 * 第三十七轮护栏（R37）—— 五处「下载限速」+ 新增「IP 地址管理」页
 *
 * 需求（逐条对应到下面的用例）：
 *  1. 五处可设「下载限速」，优先级 API Key → 存储桶 → 用户 → 文件分享 = 链接管理
 *     → `pickEffective` 取各层**最小值**；同值取更高优先层
 *  2. 下层设置时提示「已在 XX 管理中设置限速为 xx MB/S」
 *     → `throttle.resolveLimit` + `GET /throttle/ceiling` + 前端 `ceilingText`
 *  3. 文件分享与链接管理是**同一份**（同一条记录上的 `speedLimit`）
 *     → `share-store` 单字段 + 两个入口写同一个字段
 *  4. 「IP 地址限速」可与「IP 访问屏蔽」一样用 CIDR，且**不拦截**
 *     → `ip-guard.speedLimitFor`（只认 `kind:'speed'`）+ `matchRules`（只认 `block`）
 *  5. 「IP 访问屏蔽」整卡从存储桶页迁到 IP 地址管理页
 *     → `index.html` 结构断言 + `ipmgr.js`/`bucketmgr.js` 归属断言
 *  6. 全链路：三个下载出口（`/fs/download`、`/s/:id/dl`、WebDAV GET）都过限速闸门
 *     → `makeThrottle` 调用点断言（含「无用户层」这一**已知缺口**的显式记录）
 *
 * ## 三层断言（缺一层就会留下「假绿」）
 *
 *  ① **存储 / 纯函数层**（真实 `throttle.js` / `ip-guard.js` / `config-store`）：
 *     生效值到底怎么算、CIDR 到底匹配上没匹配上。只测路由的话，「取最小值」这类
 *     真正的核心语义全在射程外 —— 而它恰恰是最容易写成「取最大值」的地方。
 *  ② **节拍层**（真实 `Transform` + 真实计时）：**限速真的限速了吗**。
 *     这是本轮唯一无法用静态断言替代的部分：`createThrottleTransform` 的实现里
 *     任何一个 `<=` / 单位错误都会让"限速"变成一句注释，而单测全绿。
 *     同时钉住**写间隔 ≤ SLICE_MS** —— 这是"不触发 10 分钟无活动超时"的充要条件。
 *  ③ **路由 / 界面层**（真实 express 路由 + 真发 HTTP；沙箱里 import 真实前端模块）：
 *     鉴权、入参校验（非法值必须 400，绝不静默当 0）、以及按钮是否真接上。
 *
 * ⚠️ 配置会真实落盘（`config.enc`），必须先把 `COS_DATA_DIR` 指到临时目录**再** require。
 *
 * ⚠️ 计时类用例（②）在负载高的机器上会抖，故判据一律给**区间**而不是等值：
 *    速率允许 ±35%，写间隔允许 2×（定时器本身就有 1~15ms 的抖动）。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const test = require('node:test');
const { after } = require('node:test');
const { assert, assertEqual, ROOT, makeTempDir, request, cleanupTempDir } = require('./helpers.js');

const tmp = makeTempDir('cos-r37-');
process.env.COS_DATA_DIR = tmp.dir;

const JS = (...p) => path.join(ROOT, 'public', 'js', ...p);
const SERVER = (...p) => path.join(ROOT, 'server', ...p);

const express = require(path.join(ROOT, 'node_modules', 'express'));
const configStore = require(SERVER('config-store.js'));
const shareStore = require(SERVER('share-store.js'));
const ipGuard = require(SERVER('ip-guard.js'));
const throttle = require(SERVER('throttle.js'));
const limits = require(SERVER('limits.js'));

const configRoutes = require(SERVER('routes', 'config.js'));
const bucketRoutes = require(SERVER('routes', 'buckets.js'));
const userRoutes = require(SERVER('routes', 'users.js'));
const throttleRoutes = require(SERVER('routes', 'throttle.js'));

/* ================================================================== *
 * 公共工具
 * ================================================================== */

const MB = 1024 * 1024;

/**
 * 挂一组路由、注入身份，返回 server。
 *
 * 用真实 express 路由（而不是直接调处理函数）：入参校验、403 / 400 的**状态码**
 * 本身就是本轮要求的一部分（「非法值必须 400」只有走一遍 HTTP 才算验过）。
 */
async function serve(routes, { as = null, role = 'admin' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (as) req.authUser = { id: as, username: as, role };
    next();
  });
  for (const r of routes) app.use('/api', r);
  return new Promise((resolve) => {
    const s = http.createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

/** 建一份「1 把密钥 + 1 个桶 + 1 个用户」的最小配置，返回各 id */
async function seed({ credSpeed = 0, bucketSpeed = 0, userSpeed = 0 } = {}) {
  configStore.save({
    provider: 'tencent',
    secretId: 'AKIDr37', secretKey: 'skr37', bucket: 'r37-bucket', region: 'ap-guangzhou',
    credentials: [{
      id: 'c1', provider: 'tencent', secretId: 'AKIDr37', secretKey: 'skr37',
      enabled: true, visibleToUsers: true, remark: 'r37-cred', speedLimit: credSpeed,
    }],
    buckets: [{
      id: 'b1', provider: 'tencent', bucket: 'r37-bucket', region: 'ap-guangzhou',
      credentialId: 'c1', enabled: true, remark: 'r37-bucket', speedLimit: bucketSpeed,
    }],
    activeCredentialId: 'c1',
    activeBucketId: 'b1',
  });
  // 用户只能走 addUser（密码要哈希）；同名先清掉，保证用例可重复跑
  const exist = configStore.listUsers().find((u) => u.username === 'r37user');
  if (exist) await configStore.removeUser(exist.id);
  const u = await configStore.addUser({
    username: 'r37user', password: 'pw-123456', role: 'user', speedLimit: userSpeed,
  });
  return { credId: 'c1', bucketId: 'b1', userId: u.id };
}

/* ================================================================== *
 * ① 存储 / 纯函数层
 * ================================================================== */

test('R37 · limits：MB/s 与字节/秒的换算口径（1 MB = 1024×1024），且非法值归一化为「不限速」', () => {
  assertEqual(limits.MB, 1024 * 1024, 'MB 必须是 1024 基数（与 util.fmtSize 同基数，否则用户算不平时间账）');
  assertEqual(limits.toMBps(5 * MB), 5, '5 MB → 5 MB/s');
  assertEqual(limits.toMBps(5.5 * MB), 5.5, '保留一位小数');
  assertEqual(limits.toMBps(1.25 * MB), 1.3, '四舍五入到一位小数');

  assertEqual(limits.normalizeSpeedLimit(-1), 0, '负数 → 0（不限速）');
  assertEqual(limits.normalizeSpeedLimit('abc'), 0, '非数字 → 0');
  assertEqual(limits.normalizeSpeedLimit(NaN), 0, 'NaN → 0');
  assertEqual(limits.normalizeSpeedLimit(0), 0, '0 就是不限速');
  assertEqual(limits.normalizeSpeedLimit(1024.9), 1024, '向下取整成整数字节');
});

/**
 * 入参校验与存储归一化**必须分开**：存储层把非法值当 0（温和、不会把界面弄崩），
 * 接口层必须**报错**（`-1` 静默变成 `0`，用户以为自己设了限速，实际是全速下载 ——
 * 与本项目 `quotaBytes` 踩过的坑完全同型）。
 */
test('R37 · limits.parseSpeedLimitInput：非法值必须报错，绝不静默归一化成 0', () => {
  assertEqual(limits.parseSpeedLimitInput('').ok, true, '空串合法（= 不限速）');
  assertEqual(limits.parseSpeedLimitInput('').value, 0, '空串 → 0');

  const neg = limits.parseSpeedLimitInput(-1);
  assertEqual(neg.ok, false, '负数必须被拒绝 —— 归一化成 0 等于「悄悄解除限速」');
  assert(neg.error.indexOf('负') >= 0, `错误文案应说明是负数问题，实际：${neg.error}`);

  assertEqual(limits.parseSpeedLimitInput('abc').ok, false, '非数字必须被拒绝');
  assertEqual(limits.parseSpeedLimitInput(Infinity).ok, false, 'Infinity 必须被拒绝');

  const ok = limits.parseSpeedLimitInput(5 * MB);
  assertEqual(ok.ok, true, '正常值通过');
  assertEqual(ok.value, 5 * MB, '并按字节/秒返回');
});

test('R37 · pickEffective：多层取**最小值**，同值取优先级更高的层', () => {
  const layers = (spec) => spec.map(([source, bytes]) => ({ source, bytesPerSec: bytes, key: source + ':k' }));
  const prio = (r) => r.source;

  // 各层都设了 → 取最小的那个，并且**报出它来自哪一层**
  const low = throttle.pickEffective(layers([['credential', 5 * MB], ['bucket', 10 * MB], ['user', 3 * MB]]));
  assertEqual(low.limit, 3 * MB, '三层 5/10/3 → 取 3（最小值，不是最高优先层的 5）');
  assertEqual(prio(low), 'user', '生效值来自设得最小的那一层');

  // 0 = 不限速，等价于「这一层没设」
  const withZero = throttle.pickEffective(layers([['credential', 5 * MB], ['bucket', 0], ['user', 0]]));
  assertEqual(withZero.limit, 5 * MB, '0 表示该层没设限速，不得参与「取最小值」把速率压成 0');
  assertEqual(prio(withZero), 'credential', '只有真正设了值的那层算数');

  // 同值时保持更高优先层（用于「提示语里说清是哪一层限制了你」）
  const tie = throttle.pickEffective(layers([['credential', 4 * MB], ['bucket', 4 * MB]]));
  assertEqual(prio(tie), 'credential', '同值时应报优先级更高的层（API Key 高于存储桶）');

  // 全都没设 → 不限速
  assertEqual(throttle.pickEffective(layers([['credential', 0]])).limit, 0, '都没有设 → 0');
  assertEqual(throttle.pickEffective([]).limit, 0, '空数组 → 0（不得抛错）');
  assertEqual(throttle.pickEffective(null).limit, 0, 'null → 0（不得抛错）');

  // sourceKey 必须是**实体自己的键**而不是层名：并发下载要聚到同一个桶上
  assertEqual(low.sourceKey, 'user:k', 'sourceKey 取实体键，供多连接共享同一份额度');
});

test('R37 · resolveLimit：按「IP → 密钥 → 桶 → 用户 → 链接」聚合出各层，5 层齐全', async () => {
  const { credId, bucketId, userId } = await seed({ credSpeed: 8 * MB, bucketSpeed: 6 * MB, userSpeed: 0 });
  const link = await shareStore.create({
    key: 'a/b.bin', bucket: 'r37-bucket', region: 'ap-guangzhou',
    createdBy: 'r37user', speedLimit: 4 * MB,
  });
  ipGuard.addRule({ target: '203.0.113.0/24', kind: 'speed', speedLimit: 2 * MB, enabled: true });

  const r = throttle.resolveLimit({
    ip: '203.0.113.9', method: 'GET',
    credentialId: credId, bucketId, userId, linkId: link.id,
  });
  assertEqual(r.limit, 2 * MB, '五层 2/8/6/0/4 → 取 2（最严的是 IP 层）');
  assertEqual(r.source, 'ip', '并指出是 IP 层在限');
  assertEqual(r.limit > 0 && r.sourceLabel.length > 0, true, '必须有可展示的层名（提示语要用）');

  // 去掉链接层与 IP 层后，最小的是桶层 6MB（< 密钥 8MB）
  const r2 = throttle.resolveLimit({ ip: '198.51.100.7', method: 'GET', credentialId: credId, bucketId });
  assertEqual(r2.limit, 6 * MB, '密钥 8 / 桶 6 → 取 6');
  assertEqual(r2.source, 'bucket', '来源应为存储桶层');
});

/* ================================================================== *
 * ② 节拍层：限速真的限速了吗
 * ================================================================== */

/**
 * 用假上游驱动 `createThrottleTransform`，量出「实际耗时 / 理论耗时」与**最大写间隔**。
 *
 * 为什么要量 `maxGapMs`：`res.setTimeout(DOWNLOAD_TIMEOUT_MS)` 是**无活动**超时
 * （10 分钟）。若实现改成「攒够一整块再放行」，1 KB/s × 64 KB 分块就会出现 64 秒的
 * 静默期 —— 正常下载被判超时断开。本轮的实现按 100ms 节拍释放，因此间隔有硬上界；
 * 这条不变量只有量出来才算数。
 */
async function measure({ bytesPerSec, total, chunk = 64 * 1024, key = 'k1', parallel = 1 }) {
  const { Readable } = require('stream');
  return Promise.all(Array.from({ length: parallel }, () => new Promise((resolve) => {
    const t = throttle.createThrottleTransform({ key, bytesPerSec });
    let last = 0;
    let maxGap = 0;
    let out = 0;
    const t0 = Date.now();
    let sent = 0;
    const src = new Readable({
      read() {
        const n = Math.min(chunk, total - sent);
        if (n <= 0) { this.push(null); return; }
        sent += n;
        this.push(Buffer.alloc(n, 1));
      },
    });
    t.on('data', (b) => {
      const now = Date.now();
      if (last) maxGap = Math.max(maxGap, now - last);
      last = now;
      out += b.length;
    });
    t.on('end', () => resolve({ ms: Date.now() - t0, bytes: out, maxGapMs: maxGap }));
    src.pipe(t);
    // ⚠️ 必须把它消费掉：没有人读 `t` 就不会有背压，节拍器也就无从谈起
    t.resume();
  })));
}

test('R37 · 节拍器：限速真的限速（实测速率接近设定值，且**永不超速**）', async () => {
  const rate = 200 * 1024; // 200 KB/s
  const total = 200 * 1024; // 恰好 1 秒的量
  const [r] = await measure({ bytesPerSec: rate, total, key: 'rate-1' });

  assertEqual(r.bytes, total, '字节必须一字不少地全部送达（限速不是截断）');
  const ratio = r.ms / 1000;
  assert(ratio > 0.65 && ratio < 1.45,
    `200 KB 以 200 KB/s 应约 1000ms，实测 ${r.ms}ms（比值 ${ratio.toFixed(3)}）——`
    + '明显偏小说明限速没生效（成了"全速下载"），明显偏大说明节拍预算算错了');
});

test('R37 · 节拍器：写间隔恒 ≤ 2×SLICE_MS —— 这是"不被 10 分钟无活动超时误杀"的充要条件', async () => {
  // 刻意用「慢速率 + 大分块」：任何"攒够一整块再放行"的实现都会在这里露出长静默期
  const [r] = await measure({ bytesPerSec: 20 * 1024, total: 100 * 1024, chunk: 64 * 1024, key: 'gap-1' });
  assertEqual(r.bytes, 100 * 1024, '字节数不因节拍而丢失');
  assert(r.maxGapMs <= throttle.SLICE_MS * 2,
    `最大写间隔 ${r.maxGapMs}ms 超过 2×SLICE_MS(${throttle.SLICE_MS * 2}ms) ——`
    + '一旦出现长静默期，`res.setTimeout(10min)` 这个**无活动**超时会把正常下载判死');
});

test('R37 · 节拍器：同一实体的并发下载**均分**额度（不是先到的吃满、后来的饿死）', async () => {
  const rate = 200 * 1024;
  const total = 100 * 1024; // 两条各 100 KB，共享 200 KB/s → 理想各 ~500ms
  const rs = await measure({ bytesPerSec: rate, total, key: 'fair-1', parallel: 2 });

  const agg = rs.reduce((s, x) => s + x.bytes, 0);
  assertEqual(agg, 2 * total, '两条流的字节总数必须正确');
  for (const x of rs) {
    assert(x.bytes === total, '每条流都要被完整送达');
    assert(x.ms > 300, `单条 ${total}B 在共享 200KB/s 下不应快于 300ms，实测 ${x.ms}ms（说明某一条抢占了全部额度）`);
    assert(x.ms < 1200, `单条也不应慢到 ${x.ms}ms（说明额度被另一条独吞或整体卡住）`);
  }
  // 公平性：两条耗时不应相差一倍以上
  const [a, b] = rs.map((x) => x.ms).sort((x, y) => x - y);
  assert(b / Math.max(1, a) < 2,
    `两条并发耗时 ${a}ms / ${b}ms 相差过大 —— 说明没有按 active 数均分每拍额度`);
});

test('R37 · 节拍器：bucket 表有上界与 TTL 清扫（不得无界增长）', () => {
  assert(throttle.BUCKETS_MAX > 0 && throttle.BUCKETS_MAX <= 100000,
    '限速桶表必须有硬上界（否则每个不同 key 都留一条，长期运行必然涨内存）');
  assert(throttle.BUCKET_TTL_MS >= 60 * 1000,
    'TTL 清扫窗口应至少 1 分钟（太短会把正在下载的桶误回收成满额度 = 短暂超速）');

  throttle._resetForTest();
  const before = throttle.bucketCount();
  const t = throttle.createThrottleTransform({ key: 'sweep-a', bytesPerSec: 1024 * 1024 });
  assertEqual(throttle.bucketCount(), before + 1, '新建一个限速器应产生一个桶');
  t.destroy();
  throttle._resetForTest();
  assertEqual(throttle.bucketCount(), 0, '_resetForTest 应能清空（测试之间不得互相污染）');
});

test('R37 · makeThrottle：不限速时必须返回 null（让调用方**完全跳过**这一环）', async () => {
  await seed({ credSpeed: 0, bucketSpeed: 0, userSpeed: 0 });
  assertEqual(throttle.makeThrottle({ ip: '10.1.1.1', credentialId: 'c1', bucketId: 'b1' }), null,
    '各层都没设限速 → null。若返回一个"永不限速"的 Transform，每个下载都会多一层管道与一个定时器');
});

/* ================================================================== *
 * ③ IP 规则层：屏蔽与限速**互斥**
 * ================================================================== */

test('R37 · ip-guard：屏蔽规则与限速规则互不串味（屏蔽不产生限速，限速不拦截）', () => {
  for (const r of ipGuard.listRules()) ipGuard.removeRule(r.id);

  // 刻意让两条规则的地址段**不重叠** —— 否则"限速规则命中时是否被拦"根本分不清
  // 到底是哪条规则在起作用（本节要说的是两类规则互不串味）
  const blk = ipGuard.addRule({ target: '192.0.2.0/24', kind: 'block', enabled: true, remark: '屏蔽段' });
  const spd = ipGuard.addRule({ target: '198.18.5.0/24', kind: 'speed', speedLimit: 3 * MB, enabled: true });

  assertEqual(ipGuard.speedLimitFor('192.0.2.7', 'GET'), null,
    '只被**屏蔽**规则覆盖的地址不得产生限速（否则"屏蔽"会变成"限速"，用户以为被拒其实是慢）');
  const hit = ipGuard.speedLimitFor('198.18.5.4', 'GET');
  assert(hit && hit.bytesPerSec === 3 * MB, '限速规则命中的地址必须拿到限速值');
  assertEqual(hit.target, '198.18.5.0/24', '并回报是哪条规则命中的（前端要展示）');

  // 屏蔽判定不得把限速规则当成命中（否则"限速"会把请求 403 掉）
  const ev = ipGuard.evaluate('198.18.5.4', 'GET');
  assertEqual(ev.ok, true, '只有限速规则命中时，`evaluate` 必须放行（限速「不拦截」）');
  const blkEv = ipGuard.evaluate('192.0.2.7', 'GET');
  assertEqual(blkEv.ok, false, '被屏蔽规则覆盖的地址仍应被拦下');
  assertEqual(blkEv.reason, 'rule', '拦截原因应归到规则命中');

  ipGuard.removeRule(blk.id);
  ipGuard.removeRule(spd.id);
});

test('R37 · ip-guard.speedLimitFor：非法 IP / 未命中 / 已禁用 / 速率为 0 一律返回 null（fail-open）', () => {
  for (const r of ipGuard.listRules()) ipGuard.removeRule(r.id);
  const r1 = ipGuard.addRule({ target: '203.0.113.0/24', kind: 'speed', speedLimit: 2 * MB, enabled: true });
  // 「已禁用」「速率为 0」两条用**独立网段**：否则它们落在上面那条 /24 里，
  // 即使自身不生效也会被 /24 命中，断言就成了「测试自己搭错了场景」
  const off = ipGuard.addRule({ target: '203.0.200.0/24', kind: 'speed', speedLimit: 1 * MB });
  // 新规则一律 `enabled: true`（与屏蔽规则一致），要测「已禁用不生效」必须显式停用
  ipGuard.setRuleEnabled(off.id, false);
  const zero = ipGuard.addRule({ target: '203.0.201.0/24', kind: 'speed', speedLimit: 0, enabled: true });

  assertEqual(ipGuard.speedLimitFor('203.0.113.5', 'GET').bytesPerSec, 2 * MB, 'CIDR 内命中');
  assertEqual(ipGuard.speedLimitFor('203.0.114.5', 'GET'), null, 'CIDR 外不命中');
  assertEqual(ipGuard.speedLimitFor('203.0.200.77', 'GET'), null, '已禁用规则不参与');
  assertEqual(ipGuard.speedLimitFor('203.0.201.88', 'GET'), null, '速率为 0 的规则等价于没设（不得把速率压成 0）');

  // fail-open：限速是**资源管理**而不是安全边界，判不出来时宁可放行
  assertEqual(ipGuard.speedLimitFor('', 'GET'), null, '空 IP → null');
  assertEqual(ipGuard.speedLimitFor('not-an-ip', 'GET'), null, '非法 IP → null（不得抛错、也不得误命中）');
  assertEqual(ipGuard.speedLimitFor(undefined, 'GET'), null, 'undefined → null');

  // ⚠️ 传 `{ip, fromForwarded}` 包装对象时必须**不命中**（而不是"凑巧命中"）：
  // 这正是开发期踩到的坑 —— `speedLimitFor` 曾按包装对象实现，于是 CIDR 匹配读到
  // `undefined`，**静默永不生效**（限速看起来配好了、实际全速下载，全绿）。
  assertEqual(ipGuard.speedLimitFor({ ip: '203.0.113.5', fromForwarded: false }, 'GET'), null,
    'speedLimitFor 只接受**原始 IP 字符串**；传包装对象应判不出来（fail-open）而不是误命中');

  for (const r of [r1, off, zero]) ipGuard.removeRule(r.id);
});

test('R37 · ip-guard：多条限速规则同时命中时取**最严**的一条', () => {
  for (const r of ipGuard.listRules()) ipGuard.removeRule(r.id);
  const wide = ipGuard.addRule({ target: '203.0.113.0/24', kind: 'speed', speedLimit: 9 * MB, enabled: true });
  const narrow = ipGuard.addRule({ target: '203.0.113.64/26', kind: 'speed', speedLimit: 1 * MB, enabled: true });

  const hit = ipGuard.speedLimitFor('203.0.113.70', 'GET');
  assertEqual(hit.bytesPerSec, 1 * MB, '宽规则 9MB + 窄规则 1MB → 取 1MB（更严的赢）');
  assertEqual(hit.target, '203.0.113.64/26', '并回报更严的那条');

  for (const r of [wide, narrow]) ipGuard.removeRule(r.id);
});

/* ================================================================== *
 * ④ 存储层：五处实体的 speedLimit 字段
 * ================================================================== */

test('R37 · config-store：密钥 / 存储桶 / 用户的 speedLimit 可读可写，未传即保持', async () => {
  const { credId, bucketId, userId } = await seed({ credSpeed: 7 * MB, bucketSpeed: 0, userSpeed: 0 });

  const cred = configStore.listCredentials().credentials.find((c) => c.id === credId);
  assertEqual(cred.speedLimit, 7 * MB, '密钥的限速应被保存并读出');

  // 未传 → 保持原值（「未传即保持」是本项目所有实体 patch 的统一约定）
  configStore.updateCredential(credId, { remark: '改名不改限速' });
  assertEqual(configStore.listCredentials().credentials.find((c) => c.id === credId).speedLimit, 7 * MB,
    'patch 里没有 speedLimit 时不得被清成 0');

  configStore.updateBucket(bucketId, { speedLimit: 3 * MB });
  assertEqual(configStore.listBuckets().buckets.find((b) => b.id === bucketId).speedLimit, 3 * MB,
    '存储桶限速应可写（这个分支曾经漏掉过：写进去静默丢失）');

  await configStore.updateUser(userId, { speedLimit: 9 * MB });
  assertEqual(configStore.getUserById(userId).speedLimit, 9 * MB, '用户限速应可写');

  // 非法值在存储层收敛为 0（温和），接口层才报错 —— 两层分工见 limits 的用例
  configStore.updateBucket(bucketId, { speedLimit: -5 });
  assertEqual(configStore.listBuckets().buckets.find((b) => b.id === bucketId).speedLimit, 0,
    '存储层把非法值归一化为 0（不是 NaN，也不是负数）');
});

test('R37 · share-store：speedLimit 是**同一条记录上的同一个字段**（文件分享 ≡ 链接管理）', async () => {
  const link = await shareStore.create({
    key: 'x/y.bin', bucket: 'r37-bucket', region: 'ap-guangzhou', createdBy: 'r37user', speedLimit: 6 * MB,
  });
  assertEqual(shareStore.get(link.id).speedLimit, 6 * MB, '创建时应带上 speedLimit');

  await shareStore.update(link.id, { speedLimit: 2 * MB });
  assertEqual(shareStore.get(link.id).speedLimit, 2 * MB, '更新后应是新值');

  await shareStore.update(link.id, { maxDownloads: 5 });
  assertEqual(shareStore.get(link.id).speedLimit, 2 * MB, 'patch 未传 speedLimit 时不得被清掉');
  assertEqual(shareStore.view(shareStore.get(link.id)).speedLimit, 2 * MB,
    'view()（接口回包用的那份）必须带上 speedLimit，否则前端拿不到当前值');

  const bare = await shareStore.create({ key: 'z.bin', bucket: 'r37-bucket' });
  assertEqual(bare.speedLimit, 0, '不传即 0（不限速），且不得出现 undefined');
});

/* ================================================================== *
 * ⑤ 路由层
 * ================================================================== */

test('R37 · 路由：GET /throttle/ceiling 按 scope 只回报**上层**的限制', async () => {
  const { credId, bucketId, userId } = await seed({ credSpeed: 5 * MB, bucketSpeed: 0, userSpeed: 0 });
  const link = await shareStore.create({ key: 'c.bin', bucket: 'r37-bucket', createdBy: 'r37user' });
  const srv = await serve([throttleRoutes], { as: userId, role: 'user' });
  const port = srv.address().port;
  try {
    // credential 是最上层：没有「上层」可言 → 不限
    const c = await request(port, 'GET', `/api/throttle/ceiling?scope=credential&id=${credId}`);
    assertEqual(c.status, 200, '应 200');
    assertEqual(c.json.limit, 0, 'API Key 层之上没有更严的层');

    // bucket 的上层=它绑定的密钥（归属判据在服务端）
    const b = await request(port, 'GET', `/api/throttle/ceiling?scope=bucket&id=${bucketId}`);
    assertEqual(b.json.limit, 5 * MB, '存储桶的上层限制来自它绑定的密钥');
    assertEqual(b.json.source, 'credential', '并指明来自密钥层');
    assertEqual(b.json.layers.map((l) => l.source).includes('credential'), true, 'layers 里应含该层');
    assertEqual(b.json.layers.every((l) => l.id === undefined),
      true, 'layers 不得带实体 id（避免把「这个桶归哪把密钥」的归属信息泄露给普通用户）');

    // user 层之上无法确定会用哪个桶/密钥 → 刻意的「不猜」
    const u = await request(port, 'GET', `/api/throttle/ceiling?scope=user&id=${userId}`);
    assertEqual(u.json.limit, 0, '用户层的上层限制按「不猜」处理（随便挑一个桶会给出看似有理的错误数字）');

    // link 的上层 = 密钥 + 桶 + 分享创建者那条用户记录
    const l = await request(port, 'GET', `/api/throttle/ceiling?scope=link&id=${link.id}`);
    assertEqual(l.json.limit, 5 * MB, '链接的上层限制应含密钥层');
    assertEqual(l.json.source, 'credential', '来源为密钥层');
  } finally { await new Promise((r) => srv.close(r)); }
});

test('R37 · 路由：GET /throttle/ceiling 的参数校验（未知 scope / 不存在的实体）', async () => {
  const { userId } = await seed({ credSpeed: 5 * MB });
  const srv = await serve([throttleRoutes], { as: userId, role: 'user' });
  const port = srv.address().port;
  try {
    const bad = await request(port, 'GET', '/api/throttle/ceiling?scope=nope');
    assertEqual(bad.status, 400, '未知 scope 应 400（而不是当成「不限速」静默放过）');

    const nf = await request(port, 'GET', '/api/throttle/ceiling?scope=bucket&id=missing');
    assertEqual(nf.status, 404, '实体不存在应 404（前端据此降级为「无提示」）');

    // 新建分享时链接还不存在：按桶名 + 当前用户查
    const byBucket = await request(port, 'GET', '/api/throttle/ceiling?scope=link&bucket=r37-bucket');
    assertEqual(byBucket.status, 200, '新建分享场景必须可用（否则文件分享对话框拿不到提示）');
    assertEqual(byBucket.json.limit, 5 * MB, '应解析出该桶绑定的密钥层限制');
  } finally { await new Promise((r) => srv.close(r)); }
});

test('R37 · 路由：非法限速值一律 400 —— 绝不静默当 0（否则 = 悄悄解除限速）', async () => {
  const { userId } = await seed({});
  const srvCred = await serve([configRoutes], { as: 'admin1', role: 'admin' });
  const srvBucket = await serve([bucketRoutes], { as: 'admin1', role: 'admin' });
  const srvUser = await serve([userRoutes], { as: 'admin1', role: 'admin' });
  try {
    const p1 = srvCred.address().port;
    const post = await request(p1, 'POST', '/api/credentials', {
      body: { provider: 'tencent', secretId: 'AKIDz', secretKey: 'skz', speedLimit: -1 },
    });
    assertEqual(post.status, 400, 'POST /credentials 传负数限速应 400');

    const p2 = srvBucket.address().port;
    const b = await request(p2, 'POST', '/api/buckets/local', {
      body: { provider: 'tencent', bucket: 'nb', region: 'ap-guangzhou', speedLimit: 'abc' },
    });
    assertEqual(b.status, 400, 'POST /buckets/local 传非数字限速应 400');

    const p3 = srvUser.address().port;
    const u = await request(p3, 'POST', '/api/users', {
      body: { username: 'z' + Date.now(), password: 'pw-123456', speedLimit: -3 },
    });
    assertEqual(u.status, 400, 'POST /users 传负数限速应 400');
  } finally {
    for (const s of [srvCred, srvBucket, srvUser]) await new Promise((r) => s.close(r));
  }
});

test('R37 · 路由：PUT /users/me 不得修改自己的下载限速（自查改自己 = 绕过上层约束）', async () => {
  const { userId } = await seed({ userSpeed: 4 * MB });
  const srv = await serve([userRoutes], { as: userId, role: 'user' });
  const port = srv.address().port;
  try {
    const r = await request(port, 'PUT', '/api/users/me', { body: { speedLimit: 0 } });
    assertEqual(r.status, 403, '普通用户改自己的限速必须 403 —— 否则「用户管理」这一层的约束形同虚设');
    assertEqual(configStore.getUserById(userId).speedLimit, 4 * MB, '且原值不得被改写');
  } finally { await new Promise((r) => srv.close(r)); }
});

/* ================================================================== *
 * ⑥ 全链路接线：三个下载出口 + IP 页迁移
 * ================================================================== */

const readSrc = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

test('R37 · 接线：三个下载出口都必须过限速闸门（含最容易漏掉的 WebDAV 独立路径）', () => {
  const fsR = readSrc('server', 'routes', 'fs.js');
  const share = readSrc('server', 'share-routes.js');
  const dav = readSrc('server', 'webdav-server.js');
  const ds = readSrc('server', 'download-stream.js');

  assert(/makeThrottle\(/.test(fsR), '① GET /fs/download 必须接限速（→ streamDownload 的 throttle 参数）');
  assert(/makeThrottle\(/.test(share), '② GET /s/:id/dl 必须接限速');
  assert(/makeThrottle\(/.test(dav), '③ WebDAV GET 是**独立实现**的下载路径，必须单独接（它不经过 download-stream.js）');

  // 唯一实现点：节拍器只在 throttle.js 里造，别处不得自己造一份
  // （判据不能是「源码里有没有 `createThrottleTransform` 字样」—— 文件头的注释就写着它）
  assert(/createThrottleTransform/.test(readSrc('server', 'throttle.js')), '节拍器实现点应在 throttle.js');
  assertEqual(/require\(['"][^'"]*throttle['"]\)/.test(ds), false,
    'download-stream.js 不得 require throttle.js —— 节拍器由**调用方**传入'
    + '（三个出口各自决定用哪一层、怎么取 IP），它只负责把节拍器串进同一条 pipeline');

  // 管道顺序：节拍器必须与既有的单条 pipeline 串联，绝不能用独立 data 监听
  // （独立监听会绕过背压，`res` 内存无界增长）
  assert(/stages = throttle \? \[out, throttle, meter, res\] : \[out, meter, res\]/.test(ds),
    '节拍器必须插在 out（解密后）与 meter（计量）之间，且与既有阶段合成同一条 pipeline');
  assertEqual(/throttle\.on\('data'/.test(ds), false,
    '不得给节拍器挂独立的数据监听（会绕过背压）');

  assert(/throttle\.destroy\(\)/.test(ds), 'teardown 必须销毁节拍器（否则它的 setTimeout 会残留）');
});

test('R37 · 接线：WebDAV 只有 IP / 密钥 / 桶三层 —— 「无用户层」是**已知缺口**且必须写明', () => {
  const dav = readSrc('server', 'webdav-server.js');
  const m = /const throttle = makeThrottle\(\{([\s\S]{0,400}?)\}\)/.exec(dav);
  assert(m, 'WebDAV 的 GET 分支必须调用 makeThrottle');
  assert(/ip:/.test(m[1]) && /credentialId:/.test(m[1]) && /bucketId:/.test(m[1]),
    'WebDAV 必须带上 IP / 密钥 / 存储桶三层');
  assertEqual(/userId:/.test(m[1]) || /userName:/.test(m[1]), false,
    'WebDAV 刻意**不传**用户层：`req.webdavUser` 是 webdav.accounts 里的独立凭据，'
    + '与系统用户表没有可靠对应关系；同名匹配会是一次静默的错误归因');
  assert(/用户管理[\s\S]{0,120}(缺口|不受|不猜)|(缺口|不受|不猜)[\s\S]{0,120}用户管理/.test(dav),
    '这条缺口必须在源码注释里写明（否则下一个人会以为已经覆盖全了）');
});

test('R37 · 接线：presign 直链是**无法在进程内限速**的旁路，且必须如实记录', () => {
  const fsR = readSrc('server', 'routes', 'fs.js');
  assert(/presign/.test(fsR), 'presign 入口当然还在');
  assert(/(旁路|绕过|bypass)/.test(fsR),
    '`/fs/presign` 签出的地址由客户端**直接连对象存储**下载，本进程拦不到任何字节 ——'
    + '这条局限必须写进注释并在文档里如实说明，否则用户会以为设了限速就万无一失');
});

test('R37 · 界面：四张列表卡片都有「限速」列与按钮，且共用同一个渲染器', () => {
  const speed = readSrc('public', 'js', 'speedlimit.js');
  assert(/export function speedCellHtml/.test(speed), 'speedCellHtml 必须是导出（四卡片共用）');

  const cases = [
    ['credmgr.js', 'credential'],
    ['bucketmgr.js', 'bucket'],
    ['syssettings.js', 'user'],
    ['linkmgr.js', 'link'],
  ];
  for (const [file, scope] of cases) {
    const src = readSrc('public', 'js', file);
    assert(new RegExp(`speedCellHtml\\('${scope}'`).test(src),
      `${file} 必须用它自己的 scope（'${scope}'）调用 speedCellHtml —— 传错 scope 会让「保存到哪」错位`);
    assert(/openSpeedLimitDialog/.test(src), `${file} 必须能打开限速对话框`);
    assert(/act === 'speed'/.test(src), `${file} 行内按钮必须处理 data-act="speed"`);
  }
});

test('R37 · 界面：文件分享对话框含限速输入框，且上层提示复用**同一个**文案实现点', () => {
  const ops = readSrc('public', 'js', 'ops.js');
  assert(/id="lk-speed"/.test(ops), '创建分享链接对话框必须有限速输入框');
  assert(/body\.speedLimit = sp\.bytes/.test(ops), '保存时必须把限速值放进请求体（否则用户填了不生效）');
  assert(/parseMbpsInput\(speedInput\.value\)/.test(ops), '输入必须过 parseMbpsInput 这一唯一判据');
  assert(/(ceilingText|fetchCeiling)/.test(ops),
    '上层提示必须复用 speedlimit.js 的实现点，不得在 ops.js 里重写一遍文案');
  assertEqual(/已在 .* 中设置限速为/.test(ops), false,
    '需求原文的提示句式只允许出现在 speedlimit.js 一处（两处必然分叉）');

  // 直链（presign）不走本服务，因此它下面的字段块只对「托管链接」可见
  assert(/id="lk-managed-fields"[\s\S]*id="lk-speed"/.test(ops),
    '限速输入框必须放在「托管链接」专属区块内 —— 预签名直链不经过本服务，给它设限速是假的');
});

test('R37 · 界面：「IP 访问屏蔽」整卡已从存储桶页**迁出**（不是复制一份）', () => {
  const html = readSrc('public', 'index.html');
  const bm = readSrc('public', 'js', 'bucketmgr.js');
  const ipm = readSrc('public', 'js', 'ipmgr.js');

  // ① 页面结构：卡片只出现一次，且落在 #ipmgr 之内（而不是 #bucketmgr）
  const cardCount = (html.match(/id="ipguard-card"/g) || []).length;
  assertEqual(cardCount, 1, '「IP 访问屏蔽」卡片在 index.html 里只允许出现一次（迁移不得变成复制）');
  /** 按 `<section id="…">` 切出该区块的源码（用 indexOf 而不是正则，避免嵌套/注释干扰） */
  const sectionOf = (id) => {
    const start = html.indexOf(`<section id="${id}"`);
    if (start < 0) return '';
    const next = html.indexOf('<section id="', start + 1);
    return next < 0 ? html.slice(start) : html.slice(start, next);
  };
  const bmSection = sectionOf('bucketmgr');
  const ipSection = sectionOf('ipmgr');
  assert(bmSection && ipSection, '应能找到 bucketmgr / ipmgr 两个区块');
  assertEqual(/ipguard-card/.test(bmSection), false, '#bucketmgr 区块内不得再有 IP 屏蔽卡片');
  assert(/ipguard-card/.test(ipSection) && /ipspeed-card/.test(ipSection),
    '#ipmgr 区块内应同时含屏蔽卡与限速卡（两者共用一份规则表）');

  // ② 顺序：订单管理 → IP 地址管理 → 监控仪表盘（需求指定）
  const order = ['side-orders', 'side-ipmgr', 'side-dashboard']
    .map((id) => html.indexOf(`id="${id}"`));
  assert(order.every((i) => i >= 0), '三个侧栏入口都应存在');
  assert(order[0] < order[1] && order[1] < order[2],
    '侧栏顺序必须是「订单管理 → IP 地址管理 → 监控仪表盘」');

  // ③ 代码归属：渲染 / 请求全部在 ipmgr.js，bucketmgr.js 里不得残留
  assert(/refreshIpGuard/.test(ipm) && /ipguard-table/.test(ipm), '规则渲染与请求应已迁到 ipmgr.js');
  assertEqual(/refreshIpGuard/.test(bm), false, 'bucketmgr.js 不得残留 refreshIpGuard（否则会重复请求一次）');
  assertEqual(/id="ipguard-table"|'ipguard-table'/.test(bm), false, 'bucketmgr.js 不得再写 ipguard-table');
});

test('R37 · 界面：IP 限速对话框必须拒绝 0（0 = 这条规则不起作用，应改用「禁用」）', () => {
  const ipm = readSrc('public', 'js', 'ipmgr.js');
  assert(/kind: 'speed'|kind === 'speed'/.test(ipm), 'ipmgr 必须区分屏蔽 / 限速两种规则');
  assert(/parseMbpsInput/.test(ipm), '限速值必须过同一个输入判据');
  assert(/bytes <= 0|bytes === 0|!\s*r\.bytes|不会起作用|失效/.test(ipm),
    '限速规则填 0 应被拦下并说明原因（填 0 等于没设，用户会以为限住了）');
  assert(/speedRule/.test(ipm), '预检结果应同时回报限速命中（否则用户在 IP 页看不到「会被限速」）');
});

/* ================================================================== *
 * ⑦ 收尾
 * ================================================================== */

test('R37 · 契约：路由清单与 §7.1 接口表同步（新接口必须可在开发文档中搜到完整路径）', () => {
  const doc = readSrc('Develop_Document.md');
  assert(doc.includes('/throttle/ceiling'), '开发文档必须收录 `GET /throttle/ceiling` 的完整路径');
});

after(() => {
  cleanupTempDir(tmp.dir);
});
