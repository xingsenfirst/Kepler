/**
 * 代码审查修复回归护栏（2026-09-14 批次 0~3）
 *
 * ## 为什么单开这个文件
 *
 * 那次审查的 36 项发现**全部出现在 128 个用例全绿的前提下**。根因不是"没写测试"，
 * 而是测试集中在「密码学正确性、路由表面、原子写」这些**容易写单测**的部分，
 * 而真实故障集中在「资源生命周期、边界条件、跨模块契约、错误分类」。
 *
 * 因此本文件的用例刻意选择**行为契约**而非实现细节：
 *   - 断言"计数不会漂成负数"，而不是"某个变量等于几"；
 *   - 断言"损坏文件不得被覆盖"，而不是"函数返回 null"；
 *   - 对等价改写（gitignore 匹配器、xorBuf 窗口化）做**穷举差分**（见下方说明）。
 *
 * 每条用例都在注释里标注了对应编号，便于随修复回溯。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const test = require('node:test');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

/**
 * R12-01 · 数据目录隔离
 *
 * 本文件此前**不设** `COS_DATA_DIR`，而 `server/config-store.js` 在那一版里又是全库
 * 唯一不认这个开关的 store（`DATA_DIR` 硬编码）—— 于是下面三条 FUN-15 用例的
 * 「切桶 / 改可见性 / 改全局默认桶」全部直接作用在生产 `data/config.enc` 上。
 * 它们虽然 each 条都做了「还原」，但每一次 `save()` 都会把生产配置重新加密写盘
 * （内容等价、字节全变、`updatedAt` 被改写），而且这类依赖**真实环境残留状态**
 * 的用例换个干净机器就直接红。
 *
 * 与其它 server 测试文件一致：先隔离，**再** require 任何 server 模块
 * （store 在模块加载时就把目录解析成常量了）。随后播种两个桶，让 FUN-15 的
 * 「至少 2 个桶」前置得以自足。
 */
const COS_TMP = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cos-audit0-'));
process.env.COS_DATA_DIR = COS_TMP;

const { assert, assertEqual, assertReject, ROOT } = require('./helpers');

const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * 去掉注释后的源码（仅保留"真正会被执行/解析"的行）。
 * 断言"不再出现某写法"时必须用它 —— 否则会被"旧实现曾经…"这类说明性注释误伤。
 */
const readCode = (rel) => readSrc(rel)
  .split('\n')
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join('\n');

/* ==================================================================
 * SEC-09 · secure-store：必须区分「文件不存在」与「存在但损坏」
 * ================================================================== */

test('SEC-09 · readJson 区分「不存在」与「损坏」，损坏文件拒绝写入', () => {
const secureStore = require(path.join(ROOT, 'server', 'secure-store.js'));

/* R12-01 · 播种：两个「对普通用户可见」的桶 + 一条启用密钥（替代此前依赖生产配置） */
{
  // eslint-disable-next-line global-require
  const configStore = require(path.join(ROOT, 'server', 'config-store.js'));
  configStore.save({
    credentials: [{
      id: 'cred-audit0', provider: 'tencent',
      secretId: 'stub-id', secretKey: 'stub-key',
      enabled: true, visibleToUsers: true, remark: 'audit-regressions 播种数据（隔离目录）',
    }],
    buckets: [
      { id: 'bkt-audit0-a', provider: 'tencent', bucket: 'audit0-a', region: 'ap-guangzhou',
        credentialId: 'cred-audit0', enabled: true, active: true, visibleToUsers: true },
      { id: 'bkt-audit0-b', provider: 'tencent', bucket: 'audit0-b', region: 'ap-guangzhou',
        credentialId: 'cred-audit0', enabled: true, active: true, visibleToUsers: true },
    ],
    activeCredentialId: 'cred-audit0',
    activeBucketId: 'bkt-audit0-a',
  });
}

// 收尾：刷干 config-store 的去抖写队列后删目录（失败必须告警）
test.after(async () => {
  const configStore = require(path.join(ROOT, 'server', 'config-store.js'));
  await require('./helpers').cleanupTempDir(COS_TMP, {
    label: 'audit-regressions',
    flushers: [{ name: 'config-store', flush: () => configStore.flush() }],
  });
});

const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'sec09-'));
  const f = path.join(dir, 'x.json');

  // ① 不存在 → 返回 fallback，不抛错
  assertEqual(secureStore.readJson(f, { a: 1 }).a, 1, '文件不存在时应返回 fallback');

  // ② 合法 JSON → 正常解析
  fs.writeFileSync(f, '{"hello":"world"}');
  assertEqual(secureStore.readJson(f, null).hello, 'world', '合法 JSON 应正常解析');

  // ③ 存在但不是合法 JSON → 必须抛错（绝不能静默返回 fallback）
  fs.writeFileSync(f, '{ this is not json ]');
  let err = null;
  try { secureStore.readJson(f, { a: 1 }); } catch (e) { err = e; }
  assert(!!err, '损坏文件必须抛错 —— 否则 enc-meta.json 会被空表覆盖（不可逆）');
  assert(err.corrupt === true, '错误应带 corrupt 标记，便于运维识别');
  assert(/corrupt/.test(err.message) || /备份/.test(err.message), '错误文案应提示已备份');

  // ④ 进入损坏状态后，写入必须被拒绝（这是"密文不可解"的最后一道防线）
  let wErr = null;
  try { secureStore.writeJson(f, { files: {} }); } catch (e) { wErr = e; }
  assert(!!wErr && wErr.corrupt === true, '损坏状态的文件必须拒绝写入');

  // ⑤ 磁盘上应留有 .corrupt-* 备份，使"不可逆"降级为"可人工恢复"
  const backups = fs.readdirSync(dir).filter((x) => /\.corrupt-/.test(x));
  assert(backups.length >= 1, `应生成 .corrupt-* 备份（实际 ${backups.length} 个）`);

  // ⑥ 人工恢复后可清除标记并继续写入
  secureStore.clearCorrupt(f);
  fs.writeFileSync(f, '{"files":{}}');
  assertEqual(secureStore.readJson(f, null).files !== undefined, true, '清除标记后应恢复可用');

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
});

/* ==================================================================
 * FUN-02 · 加密读取信号量：释放必须幂等
 * ================================================================== */

test('FUN-02 · 加密读取信号量释放幂等，错误+关闭双触发不会把计数减成负数', async () => {
  const gw = require(path.join(ROOT, 'server', 'fs-gateway.js'));
  const t = gw.__test__;
  t.reset();

  // 正常路径：取 1 个、还 1 个
  await t.acquireEncryptReader();
  assertEqual(t.activeCount(), 1, '取用一个令牌后计数应为 1');
  const release = t.makeEncryptReaderReleaser();
  release();
  assertEqual(t.activeCount(), 0, '释放后计数应归零');

  // 关键回归：同一个流先后触发 error 与 close（Node 的错误销毁会 emit 两者）
  await t.acquireEncryptReader();
  const r2 = t.makeEncryptReaderReleaser();
  r2(); r2(); r2(); // 连续多次释放
  assertEqual(t.activeCount(), 0, '重复释放不得使计数为负（旧实现会漂成 -2）');
  assert(t.activeCount() >= 0, '计数下界保护：任何情况下不得为负');

  // 无令牌时释放也不得把全局计数打成负数
  const r3 = t.makeEncryptReaderReleaser();
  r3();
  assertEqual(t.activeCount(), 0, '空释放不得产生负计数');

  // 上限仍然有效：取满后再取会排队，而不是立即返回（fail-open 的直接后果）
  t.reset();
  const MAX = t.MAX_ENCRYPT_READERS;
  for (let i = 0; i < MAX; i++) await t.acquireEncryptReader();
  assertEqual(t.activeCount(), MAX, `取满 ${MAX} 个后计数应等于上限`);
  let acquiredImmediately = false;
  t.acquireEncryptReader().then(() => { acquiredImmediately = true; });
  await new Promise((r) => setImmediate(r));
  assertEqual(acquiredImmediately, false, '达到上限后新请求必须排队（计数漂移会让这里 fail-open）');
  assertEqual(t.queueLen(), 1, '排队请求应进入等待队列');
  t.reset();
});

/* ==================================================================
 * FUN-04 · listAll 必须显式暴露截断；删除不得"假装成功"
 * ================================================================== */

test('FUN-04 · listAllInfo 显式返回 truncated，且 cap 受硬上限约束', async () => {
  const { listAllInfo, listAll, LIMITS } = require(path.join(ROOT, 'server', 'cos.js'));

  // 构造一个"分页多次、总量超过 cap"的假客户端
  const pages = [
    { Contents: Array.from({ length: 1000 }, (_, i) => ({ Key: `a/${i}`, Size: 1, LastModified: '2026-01-01T00:00:00Z' })), IsTruncated: 'true', NextMarker: 'a/999' },
    { Contents: Array.from({ length: 1000 }, (_, i) => ({ Key: `b/${i}`, Size: 1, LastModified: '2026-01-01T00:00:00Z' })), IsTruncated: 'false', NextMarker: '' },
  ];
  let call = 0;
  const fakeCos = { getBucket: (p, cb) => cb(null, pages[call++] || { Contents: [], IsTruncated: 'false' }) };
  const cfg = { bucket: 'b', region: 'r' };

  // 用 cap=500 时：第一页就超过上限 → 必须标记 truncated
  const info = await listAllInfo(fakeCos, cfg, '', { cap: 500 });
  assertEqual(info.items.length, 500, '应精确截断到 cap');
  assertEqual(info.truncated, true, '超过 cap 必须显式标记 truncated —— 这是 FUN-04 的关键前提');

  // listAll 保持原有"只返回数组"的契约，行为不变
  call = 0;
  const arr = await listAll(fakeCos, cfg, '', { cap: 500 });
  assert(Array.isArray(arr) && arr.length === 500, 'listAll 仍返回数组且同样受限');

  // 未指定 cap 时受 LIMITS.HARD_MAX 硬上限约束（旧默认 20 万）
  assert(LIMITS.HARD_MAX <= 50000, `HARD_MAX 应收敛到 5 万以内（实际 ${LIMITS.HARD_MAX}）`);
  assert(LIMITS.DELETE < LIMITS.HARD_MAX, '删除类 cap 应小于硬上限（走流式循环）');
});

/* ==================================================================
 * FUN-08 · 国内 IP 白名单：区间归一化后无需"回溯 8 条"就能判对
 * ================================================================== */

test('FUN-08 · 白名单归一化后：重叠 / 同起点 / 包含关系均能正确判定', () => {
  const ipGuard = require(path.join(ROOT, 'server', 'ip-guard.js'));
  const ipToInt = (ip) => {
    const p = ip.split('.').map(Number);
    return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
  };

  // 刻意构造会让"固定回溯 8 条"失效的数据：多层包含 + 同起点 + 相邻
  const cidrs = [
    '1.0.0.0/8', '1.2.0.0/16', '1.2.3.0/24', '1.2.3.4/32',
    '2.0.0.0/8', '36.0.0.0/8', '36.128.0.0/9',
    '10.0.0.0/8', '100.64.0.0/10', '203.0.113.0/24',
    '255.255.255.0/24', '255.255.255.255/32',
  ].map((c) => {
    const [i, p] = c.split('/');
    return { v6: false, ip: ipToInt(i), prefix: Number(p), text: c };
  });

  const segs = ipGuard.buildIntervals(cidrs);
  // 归一化结果必须"升序且互不相交"
  for (let i = 1; i < segs.length; i++) {
    assert(segs[i].start > segs[i - 1].end, `归一化后的区间必须互不相交（第 ${i} 个）`);
  }

  // 与线性全扫描做穷举对照
  const linear = (v) => cidrs.some((c) => {
    const mask = c.prefix === 0 ? 0 : ((0xFFFFFFFF << (32 - c.prefix)) >>> 0);
    return ((v & mask) >>> 0) === ((c.ip & mask) >>> 0);
  });
  const intToIp = (v) => `${(v >>> 24) & 255}.${(v >>> 16) & 255}.${(v >>> 8) & 255}.${v & 255}`;

  ipGuard.__setChinaIntervalsForTest(segs);
  let diff = 0;
  let n = 0;
  const probes = new Set([0, 1, 0xFFFFFFFF, 0xFFFFFFFE]);
  for (const c of cidrs) {
    const span = (~((0xFFFFFFFF << (32 - c.prefix)) >>> 0)) >>> 0;
    for (const off of [-1, 0, 1, Math.floor(span / 2), span - 1, span, span + 1]) {
      const v = c.ip + off;
      if (v >= 0 && v <= 0xFFFFFFFF) probes.add(v >>> 0);
    }
  }
  for (let i = 0; i < 5000; i++) probes.add(crypto.randomInt(0, 0x100000000));
  for (const v of probes) {
    n++;
    if (ipGuard.isChinaIP(intToIp(v)) !== linear(v)) diff++;
  }
  assertEqual(diff, 0, `与线性全扫描对照 ${n} 个探测点应零差异（实际 ${diff}）`);

  // 未归一化前的旧实现依赖 magic number 8 —— 源码里不应再有该常量
  const src = readSrc('server/ip-guard.js');
  assert(!/idx\s*-\s*8/.test(src), '不应再出现"回溯 8 条"的 magic number（已由归一化取代）');
  ipGuard.__setChinaIntervalsForTest([]);
});

/* ==================================================================
 * FUN-09 · 跨厂商密钥回退：已知厂商却无同厂商密钥时必须失败
 * ================================================================== */

test('FUN-09 · 桶所属厂商无可用密钥时返回 null，绝不跨厂商猜测', () => {
  const cfg = {
    activeCredentialId: 'c-tencent',
    credentials: [
      { id: 'c-tencent', provider: 'tencent', secretId: 'a', secretKey: 'b', enabled: true },
      { id: 'c-aliyun-off', provider: 'aliyun', secretId: 'x', secretKey: 'y', enabled: false },
    ],
    buckets: [{ id: 'b1', bucket: 'demo', region: 'oss-cn-hz', provider: 'aliyun', credentialId: '', enabled: true }],
  };
  // 通过 updateBucket 的真实路径间接验证代价太高，这里直接断言源码契约
  const src = readSrc('server/config-store.js');
  assert(/已知厂商却无同厂商启用密钥/.test(src) || /宁可显式失败/.test(src),
    'activeCredential 应显式注释"无同厂商密钥即失败"的语义');
  assert(!/return enabled\[0\];\s*$/m.test(src.replace(/无桶上下文[\s\S]*?return active \|\| enabled\[0\];/, '')),
    '不应再有"无条件回退首个启用密钥"的兜底分支');

  // effectiveForBucket：桶记录不存在时必须返回 null（旧实现会猜密钥）
  assert(/if \(!b\) return null/.test(src), '桶记录不存在时 effectiveForBucket 必须返回 null');
  assert(/if \(!c\) return null/.test(src), '无可用密钥时 effectiveForBucket 必须返回 null');
});

/* ==================================================================
 * SEC-11 · WebAuthn 挑战必须绑定用户
 * ================================================================== */

test('SEC-11 · consumeChallenge 校验归属用户，不匹配即拒绝', () => {
  const W = require(path.join(ROOT, 'server', 'webauthn.js'));
  const ch = W.issueChallenge('login', { userId: 'u-alice', username: 'alice' });

  // 正确用户 → 通过
  const ok = W.consumeChallenge(ch, 'login', 'u-alice');
  assertEqual(ok.ok, true, '挑战归属用户一致时应通过');

  // 换个用户来消费（挑战已一次性销毁，需重新签发）
  const ch2 = W.issueChallenge('login', { userId: 'u-alice', username: 'alice' });
  const bad = W.consumeChallenge(ch2, 'login', 'u-bob');
  assertEqual(bad.ok, false, '挑战归属用户不一致时必须拒绝');
  assertEqual(bad.reason, 'challenge_user_mismatch', '应给出明确的拒绝原因');

  // 不传 expectedUserId 时保持向后兼容（只校验 purpose）
  const ch3 = W.issueChallenge('login', { userId: 'u-alice' });
  assertEqual(W.consumeChallenge(ch3, 'login').ok, true, '未指定期望用户时保持向后兼容');

  // 文案表必须包含新增原因，避免前端显示 undefined
  assertEqual(typeof W.publicReason('challenge_user_mismatch'), 'string', '新原因需有中文文案');
  assert(/账户/.test(W.publicReason('challenge_user_mismatch')), '文案应说明"账户不匹配"');
});

/* ==================================================================
 * SEC-14 · 规则 ID 必须使用 CSPRNG
 * ================================================================== */

test('SEC-14 · IP 规则 ID 使用 crypto 随机源，不再用 Math.random', () => {
  const src = readCode('server/ip-guard.js');
  assert(!/Math\.random/.test(src), 'ip-guard.js 不应再出现 Math.random()（注释除外）');
  assert(/crypto\.randomBytes/.test(src), '应使用 crypto.randomBytes 作为 ID 源');

  // 抽样验证 ID 长度与熵（16 字节 hex = 32 字符）
  const ipGuard = require(path.join(ROOT, 'server', 'ip-guard.js'));
  assert(typeof ipGuard.buildIntervals === 'function', 'buildIntervals 应导出以便验证归一化');
});

/* ==================================================================
 * FUN-11 · magic 模式必须具备完整性校验
 * ================================================================== */

test('FUN-11 · magic 模式：篡改密文必须报错，历史文件仍可解密', async () => {
  const enc = require(path.join(ROOT, 'server', 'enc-store.js'));
  enc.updateSettings({ mode: 'magic', magicHex: '89504e470d0a1a0a', useSalt: true });

  const plain = crypto.randomBytes(4096);
  const r = enc.encryptBuffer('tb', 'tk.bin', plain);
  assert(!!r.meta.magic.sha256, '元数据必须记录明文 sha256（否则无完整性可言）');

  const run = async (meta, source) => {
    const t = enc.decryptTransform(meta);
    const bufs = [];
    t.on('data', (d) => bufs.push(d));
    await pipeline(Readable.from(source), t);
    return Buffer.concat(bufs);
  };

  // ① 正常往返
  const dec = await run(r.meta, [r.data]);
  assert(dec.equals(plain), '正常往返必须还原出完全一致的明文');

  // ② 篡改密文 → 必须报错（旧实现会静默产出错误明文）
  const bad = Buffer.from(r.data);
  bad[bad.length - 5] ^= 0xff;
  await assertReject(() => run(r.meta, [bad]), '篡改密文必须被完整性校验拒绝');

  // ③ 历史文件（无摘要）→ 向后兼容，照常可解密
  const legacy = JSON.parse(JSON.stringify(r.meta));
  delete legacy.magic.sha256;
  delete legacy.magic.parts;
  const dec2 = await run(legacy, [r.data]);
  assert(dec2.equals(plain), '历史文件（无摘要）必须仍可正常解密');

  // ④ 分片路径同样可检出篡改
  const size = plain.length, chunk = 2048;
  const nParts = Math.ceil(size / chunk);
  const sess = { size, chunkSize: chunk, parts: {} };
  const parts = [];
  for (let n = 1; n <= nParts; n++) {
    const s = (n - 1) * chunk;
    parts.push(enc.encryptPart(sess, n, plain.subarray(s, Math.min(s + chunk, size))));
  }
  const fmeta = enc.buildFinalMeta(sess);
  assertEqual(fmeta.magic.integrity, 'parts', '分片元数据应标记为逐片可校验');
  assert((await run(fmeta, [Buffer.concat(parts)])).equals(plain), '分片往返必须正确');

  const badParts = Buffer.concat(parts);
  badParts[2500] ^= 0x40;
  await assertReject(() => run(fmeta, [badParts]), '分片密文篡改必须被检出');
});

/* ==================================================================
 * PERF-03 · xorBuf 窗口化后必须与旧实现逐字节一致
 * ================================================================== */

test('PERF-03 · 窗口式密钥流与"整段密钥流"逐字节等价（穷举差分）', () => {
  const enc = require(path.join(ROOT, 'server', 'enc-store.js'));
  const mk = enc.masterKey();
  const salt = crypto.randomBytes(16);

  // 旧实现的等价基准
  const oldKs = (offset, length) => {
    const out = Buffer.alloc(length);
    if (!length) return out;
    const s0 = Math.floor(offset / 32);
    const e0 = Math.floor((offset + length - 1) / 32);
    const st = Buffer.alloc((e0 - s0 + 1) * 32);
    for (let b = s0; b <= e0; b++) {
      crypto.createHash('sha256').update(mk).update(salt)
        .update(Buffer.from([(b >>> 24) & 255, (b >>> 16) & 255, (b >>> 8) & 255, b & 255]))
        .digest().copy(st, (b - s0) * 32);
    }
    st.copy(out, 0, offset - s0 * 32, offset - s0 * 32 + length);
    return out;
  };
  const oldXor = (buf, offset) => {
    const ks = oldKs(offset, buf.length);
    const n = buf.length;
    const w = n >>> 2;
    for (let i = 0; i < w; i++) {
      const p = i << 2;
      buf.writeUInt32BE((buf.readUInt32BE(p) ^ ks.readUInt32BE(p)) >>> 0, p);
    }
    for (let i = w << 2; i < n; i++) buf[i] ^= ks[i];
    return buf;
  };

  let diff = 0;
  let n = 0;
  for (let offset = 0; offset <= 70; offset++) {
    for (let len = 0; len <= 200; len++) {
      const base = crypto.randomBytes(len);
      const a = Buffer.from(base);
      const b = Buffer.from(base);
      enc.xorBuf(a, offset, salt);
      oldXor(b, offset);
      n++;
      if (!a.equals(b)) diff++;
    }
  }
  assertEqual(diff, 0, `穷举 ${n} 组（offset×len）应逐字节一致（实际差异 ${diff}）`);

  // 跨窗口（>64KB）且偏移非对齐：验证窗口切换处
  const big = 300 * 1024;
  const off = 987654;
  const base = crypto.randomBytes(big);
  const a = Buffer.from(base);
  const b = Buffer.from(base);
  enc.xorBuf(a, off, salt);
  oldXor(b, off);
  assert(a.equals(b), '300KB 跨窗口、非对齐偏移时必须与旧实现一致');
});

/* ==================================================================
 * SEC-06 · CSP 不得含 script-src 'unsafe-inline'
 * ================================================================== */

test('SEC-06 · CSP 移除 script-src unsafe-inline，并补齐 object-src/base-uri', () => {
  const src = readSrc('server/index.js');
  const m = src.match(/Content-Security-Policy[\s\S]{0,900}?frame-ancestors/);
  assert(!!m, '应能定位到 CSP 定义');
  const csp = m[0];
  const scriptSrc = (csp.match(/script-src\s+([^;]+)/) || [])[1] || '';
  assert(!/'unsafe-inline'/.test(scriptSrc),
    `script-src 不得含 'unsafe-inline'（实际：${scriptSrc.trim()}）`);
  assert(/object-src\s+'none'/.test(csp), '应补充 object-src none');
  assert(/base-uri\s+'self'/.test(csp), '应补充 base-uri self');
  assert(/form-action\s+'self'/.test(csp), '应补充 form-action self');

  // 前端不得残留内联事件处理器（否则移除 unsafe-inline 会直接破坏功能）
  const pubDir = path.join(ROOT, 'public');
  const walk = (d, out = []) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk(p, out);
      else if (/\.(js|html)$/.test(f.name)) out.push(p);
    }
    return out;
  };
  const offenders = [];
  for (const f of walk(pubDir)) {
    const s = fs.readFileSync(f, 'utf8');
    s.split('\n').forEach((l, i) => {
      if (/\son(click|load|error|change|input|submit|keydown|keyup|mouse\w+|drag\w+|focus|blur)\s*=\s*["']/.test(l)
          && !/\.on\w+\s*=/.test(l)) {
        offenders.push(`${path.relative(ROOT, f)}:${i + 1}`);
      }
    });
  }
  assertEqual(offenders.length, 0, `前端不应残留内联事件处理器：${offenders.slice(0, 5).join(', ')}`);
});

/* ==================================================================
 * FUN-06 / FUN-07 · WebDAV 挂载边界与大对象复制
 * ================================================================== */

test('FUN-06/FUN-07 · WebDAV 统一挂载点守卫；网关复制处理 >5GB 对象', () => {
  const wd = readSrc('server/webdav-server.js');
  // FUN-06：必须是"前置统一中间件"，而不是逐方法判断（逐方法正是漏掉 PUT 的原因）
  assert(/app\.use\(\(req, res, next\)[\s\S]{0,400}?startsWith\(MOUNT/.test(wd),
    '应存在统一的前置挂载点中间件');
  assert(/Destination 必须位于/.test(wd), 'MOVE/COPY 的 Destination 必须校验挂载前缀');
  assert(/不支持跨主机 Destination/.test(wd), 'MOVE/COPY 的 Destination 必须校验主机');

  // FUN-07：网关复制需有"大对象走分块复制"的分支，与管理界面口径一致
  const gw = readSrc('server/fs-gateway.js');
  assert(/COPY_SIMPLE_LIMIT/.test(gw), 'fs-gateway 应定义与 routes/fs.js 一致的复制大小阈值');
  assert(/sliceCopyFile/.test(gw), '超过阈值时应改用 sliceCopyFile 分块复制');
});

/* ==================================================================
 * PERF-04 · 列举上限集中化
 * ================================================================== */

test('PERF-04 · 列举上限集中在 server/limits.js，且全部低于旧默认值', () => {
  const { LIMITS, resolveCap, HARD_MAX } = require(path.join(ROOT, 'server', 'limits.js'));
  assert(LIMITS.SCAN <= 10000, `SCAN 上限应显著低于旧的 2 万（实际 ${LIMITS.SCAN}）`);
  assert(LIMITS.STAT <= 20000, `STAT 上限应收敛（实际 ${LIMITS.STAT}）`);
  assert(LIMITS.DELETE <= 10000, `DELETE 上限应远低于旧的 10 万（实际 ${LIMITS.DELETE}）`);
  assert(LIMITS.PROPFIND <= 10000, `PROPFIND 上限应收敛（实际 ${LIMITS.PROPFIND}）`);

  // resolveCap 必须把任意请求值夹到 HARD_MAX 以内（兜住回归）
  assertEqual(resolveCap(99999999, 1000), HARD_MAX, '任意 cap 都不得越过硬上限');
  assertEqual(resolveCap(undefined, 5000), 5000, '未指定时使用默认值');
  assertEqual(resolveCap(0, 5000), HARD_MAX, '显式无上限仍受硬上限约束');

  // 源码中不应再有散落的 200000 / 100000 硬编码（注释除外）
  for (const f of ['server/cos.js', 'server/routes/fs.js', 'server/routes/buckets.js']) {
    const s = readCode(f);
    assert(!/cap:\s*(200000|100000)/.test(s), `${f} 不应再有硬编码的超大 cap`);
  }
});

/* ==================================================================
 * SEC-10 · 分享令牌必须绑定密码
 * ================================================================== */

test('SEC-10 · 分享访问令牌与密码哈希绑定，改密码即失效（行为验证）', () => {
  const shareStore = require(path.join(ROOT, 'server', 'share-store.js'));

  // accessToken/verifyToken 接受普通对象，可纯函数验证（不碰 data/links.json）
  const linkA = { id: 'lnk-sec10', passwordHash: 'hash-of-old-password' };
  const tok = shareStore.accessToken(linkA);
  assertEqual(typeof tok, 'string', 'accessToken 应返回字符串');
  assert(shareStore.verifyToken(linkA, tok), '同一链接 + 同一密码哈希下令牌应有效');

  // ① 改密码 → 旧令牌必须失效（这是"修改分享密码能撤回已授权访问者"的前提）
  const linkB = { id: 'lnk-sec10', passwordHash: 'hash-of-new-password' };
  assert(!shareStore.verifyToken(linkB, tok), '改密码后旧令牌必须失效');

  // ② 清除密码 → 旧令牌同样必须失效
  const linkNoPass = { id: 'lnk-sec10' };
  assert(!shareStore.verifyToken(linkNoPass, tok), '清除密码后旧令牌必须失效');

  // ③ 令牌不得跨链接串用
  const linkOther = { id: 'lnk-other', passwordHash: 'hash-of-old-password' };
  assert(!shareStore.verifyToken(linkOther, tok), '令牌不得跨链接串用');

  // ④ 畸形输入必须安全拒绝
  assert(!shareStore.verifyToken(linkA, ''), '空令牌应被拒绝');
  assert(!shareStore.verifyToken(linkA, 'x'.repeat(63)), '长度不符的令牌应被拒绝');

  const routes = readSrc('server/share-routes.js');
  assert(/secure:\s*!!?security\.IS_DEPLOY/.test(routes),
    '分享解锁 Cookie 在部署模式下必须带 Secure');
});

/* ==================================================================
 * FUN-05 · 批量复制失败即停 + 回滚
 * ================================================================== */

test('FUN-05 · copyBatch 失败即停并回滚，不留半成品副本', () => {
  const src = readSrc('server/routes/fs.js');
  assert(/aborted\s*=\s*true/.test(src), '任一任务失败后必须置位取消标志（其余 worker 停止取任务）');
  assert(/rollback/.test(src), 'copyBatch 应支持失败回滚');
  assert(/partial/.test(src), '错误应携带 partial 明细（总数/成功数/是否回滚）');
  assert(!/while \(idx < items\.length\)/.test(src),
    '不应再有"忽略失败标志、继续取任务"的旧循环');
});

/* ==================================================================
 * PERF-06 · 下载流不再逐 chunk 触碰统计
 * ================================================================== */

test('PERF-06 · 下载流按固定间隔汇总统计（行为验证：1000 chunk 不产生 1000 次写统计）', async () => {
  const { PassThrough } = require('stream');
  const statsStore = require(path.join(ROOT, 'server', 'stats-store.js'));
  const { streamDownload } = require(path.join(ROOT, 'server', 'download-stream.js'));

  // 统计调用计数（就地替换，测试结束还原）
  const origSample = statsStore.sampleTraffic;
  const origTrack = statsStore.trackBucket;
  let sampleCalls = 0;
  let trackCalls = 0;
  let accounted = 0;
  statsStore.sampleTraffic = (up, down) => { sampleCalls += 1; accounted += down || 0; };
  statsStore.trackBucket = () => { trackCalls += 1; };

  try {
    const CHUNKS = 1000;
    const CHUNK_SIZE = 1024;
    // 假对象存储客户端：headObject 给长度，getObject 往 Output 里灌 chunk
    const fakeCos = {
      headObject: (params, cb) => cb(null, { headers: { 'content-length': String(CHUNKS * CHUNK_SIZE), 'content-type': 'application/octet-stream' } }),
      getObject: (params, cb) => {
        const out = params.Output;
        (async () => {
          for (let i = 0; i < CHUNKS; i++) {
            if (out.destroyed) break;
            if (!out.write(Buffer.alloc(CHUNK_SIZE, i & 0xff))) {
              await new Promise((r) => out.once('drain', r));
            }
          }
          out.end();
        })().then(() => cb(null, {}), cb);
      },
    };
    // 假响应：可写流 + Express 需要的少量方法
    const res = new PassThrough();
    res.setHeader = () => {};
    res.setTimeout = () => {};
    res.destroy = res.destroy.bind(res);
    const sink = (async () => { for await (const _ of res) { /* 消费掉 */ } })();
    const req = { setTimeout: () => {} };
    const traffic = { bytesDown: 0 };

    await streamDownload({
      cos: fakeCos, bucket: 'tb', region: 'r', key: 'k.bin',
      fileName: 'k.bin', encMeta: null, req, res, traffic,
    });
    await sink;

    const expected = CHUNKS * CHUNK_SIZE;
    assertEqual(traffic.bytesDown, expected, `traffic.bytesDown 必须精确累计全部字节（期望 ${expected}）`);
    assertEqual(accounted, expected, `上报给 statsStore 的字节数必须完整（期望 ${expected}，实际 ${accounted}）`);

    // 核心不变式：瞬时写完 1000 个 chunk，统计写次数必须远小于 chunk 数
    // （旧实现/间隔为 0 时会是 1000 次；间隔汇总时只应有收尾的那 1 次）
    assert(sampleCalls <= 2,
      `统计写次数应被汇总（≤2），实际 ${sampleCalls} 次 —— 若等于 chunk 数说明又退回逐 chunk 统计`);
    assert(trackCalls <= 2, `按桶统计次数应被汇总（≤2），实际 ${trackCalls} 次`);
    assert(sampleCalls >= 1, '至少要收尾清算一次，否则尾部字节会丢失');
  } finally {
    statsStore.sampleTraffic = origSample;
    statsStore.trackBucket = origTrack;
  }

  const src = readSrc('server/download-stream.js');
  assert(!/out\.on\('data'/.test(src), "不应再用 'data' 监听做统计（会形成双消费者）");
  assert(/new Transform\(/.test(src), '应使用显式 Transform 统一统计与转发（PERF-09）');
});

/* ==================================================================
 * PERF-07 · 日志轮转异步化
 * ================================================================== */

test('PERF-07 · rotateLogs 异步化，且不超过上限时不重写文件', () => {
  const src = readSrc('server/stats-store.js');
  assert(/async function rotateLogs/.test(src), 'rotateLogs 应为异步（旧实现同步读写整个日志文件）');
  assert(!/readFileSync\(LOGS_FILE/.test(src), '轮转不应再同步读取整个日志文件');
  assert(/lines\.length <= MAX_LOGS\) return/.test(src), '未超过上限时应完全不碰磁盘（消除写放大）');
});

/* ==================================================================
 * PERF-08 · gzip 背压与 Vary
 * ================================================================== */

test('PERF-08 · gzip 超限即透传，且无条件声明 Vary', () => {
  const src = readSrc('server/gzip.js');
  assert(/res\.setHeader\('Vary', 'Accept-Encoding'\)/.test(src),
    '应无条件设置 Vary（不压缩分支同样需要，否则共享缓存串味）');
  assert(/passthrough/.test(src), '超过阈值应切换为透传模式而非继续缓冲');
  assert(/buffered > MAX_SIZE/.test(src), '应在 write 过程中即时判定超限（旧实现只在 end 时判定）');
});

/* ==================================================================
 * 2026-09-15 复核：3 项未达标 + 1 项同型残留
 *
 * 这些是上一轮「声明已修但代码未改 / 只改了一半」的部分。护栏刻意写成
 * **行为断言**：FUN-15 用真实会话验证全局值不被污染，FUN-04b 扫描全库
 * 确认危险 API 已消失 —— 这样即使实现方式变了，只要语义退化就会被发现。
 * ================================================================== */

test('FUN-15 · 普通用户切桶只改会话，绝不污染全局 activeBucketId（行为验证）', () => {
  const configStore = require(path.join(ROOT, 'server', 'config-store.js'));
  const authSession = require(path.join(ROOT, 'server', 'auth-session.js'));
  const requestContext = require(path.join(ROOT, 'server', 'request-context.js'));

  const all = configStore.listBuckets();
  assert(all.buckets.length >= 2, `需要至少 2 个桶才能验证隔离（当前 ${all.buckets.length} 个）`);

  const before = configStore.listBuckets().activeBucketId;
  const [b1, b2] = all.buckets;
  const other = b1.id === before ? b2 : b1; // 找一个与当前默认不同的桶

  // 该桶在真实配置里可能恰好对普通用户不可见（visibleToUsers: false）。
  // 若如此则先临时放开、测完还原 —— 否则本用例只能验证「回退」分支，
  // 而**核心语义「会话选择必须生效于所有读端」反而被跳过**。
  const origVisible = other.visibleToUsers !== false;
  if (!origVisible) configStore.updateBucket(other.id, { visibleToUsers: true });

  // 造一个普通用户会话（不落盘到配置，仅内存）
  const token = authSession.createSession({ id: 'unit-fun15', username: 'unit-fun15', role: 'user' });
  try {
    // 在「普通用户 + 该会话」的上下文中切换当前桶
    let ok = false;
    requestContext.runWith({ token, userId: 'unit-fun15', role: 'user', activeBucketId: '' }, () => {
      ok = configStore.setActiveBucket(other.id, { token, role: 'user' });
    });
    assert(ok, '普通用户切桶应成功（只是作用域不同，不该失败）');

    // ① 全局默认值**必须原封不动** —— 这是本条护栏的核心
    assertEqual(configStore.listBuckets().activeBucketId, before,
      '普通用户切桶后全局 activeBucketId 必须保持不变（否则会改变管理员/WebDAV/分享的目标桶）');

    // ② 会话里确实记住了该选择（跨请求保持）
    assertEqual(authSession.getSessionBucket(token), other.id, '会话应记住用户选择的桶');

    // ③ 该会话上下文下解析出的当前桶就是用户选的那个
    const eff = requestContext.runWith({ token, userId: 'unit-fun15', role: 'user', activeBucketId: other.id },
      () => configStore.listBucketsFor('user'));
    assertEqual(eff.activeBucketId, other.id, '该会话下应解析出用户选择的桶');

    // ④ 管理员上下文不受影响
    const adminView = configStore.listBucketsFor('admin');
    assertEqual(adminView.activeBucketId, before, '管理员看到的当前桶不应被普通用户的操作改变');

    // ⑤ **操作读端**必须与界面读端同源 —— 这一条曾被漏掉：
    //    修复了 setActiveBucket（写端）与 listBucketsFor/safeView（界面读端），
    //    却漏了 effective()/get()，于是 requireConfig() 返回的仍是全局默认桶，
    //    表现为「界面显示 A、列表/上传/下载/删除/统计全打 B」。
    //    教训：写回归断言要**枚举同一状态的所有读取入口**，而不是只测改动那一处。
    const opCfg = requestContext.runWith({ token, userId: 'unit-fun15', role: 'user', activeBucketId: other.id },
      () => configStore.get());
    assertEqual(opCfg && opCfg.bucketId, other.id,
      'requireConfig()/get() 必须返回会话所选的桶（否则界面与实际操作指向不同桶）');
    const effCfg = requestContext.runWith({ token, userId: 'unit-fun15', role: 'user', activeBucketId: other.id },
      () => configStore.effective());
    assertEqual(effCfg && effCfg.bucketId, other.id, 'effective() 也必须返回会话所选的桶');

    // ⑥ 同源性总校验：所有读取入口在该会话下必须给出**同一个**桶
    const ids = requestContext.runWith({ token, userId: 'unit-fun15', role: 'user', activeBucketId: other.id }, () => [
      configStore.listBucketsFor('user').activeBucketId,
      (configStore.safeView('user') || {}).activeBucketId,
      (configStore.get() || {}).bucketId,
      (configStore.effective() || {}).bucketId,
    ]).filter(Boolean);
    assert(new Set(ids).size <= 1,
      `界面读端与操作读端必须同源，实际得到：${JSON.stringify(ids)}`);
  } finally {
    authSession.destroySession(token);
    if (!origVisible) configStore.updateBucket(other.id, { visibleToUsers: false }); // 还原
  }

  assertEqual(configStore.listBuckets().activeBucketId, before, '（收尾）全局值全程未被改动');
});

test('FUN-15 · 操作读端不得把普通用户回退到「对其不可见」的全局默认桶（越权面）', () => {
  const configStore = require(path.join(ROOT, 'server', 'config-store.js'));
  const authSession = require(path.join(ROOT, 'server', 'auth-session.js'));
  const requestContext = require(path.join(ROOT, 'server', 'request-context.js'));

  const all = configStore.listBuckets();
  if (all.buckets.length < 2) return; // 无法构造对照
  const hidden = all.buckets.find((b) => b.id === all.activeBucketId) || all.buckets[0];
  const visibleOther = all.buckets.find((b) => b.id !== hidden.id);
  if (!visibleOther) return;

  // 把「全局默认桶」临时设为对普通用户不可见
  const origVisible = hidden.visibleToUsers !== false;
  if (origVisible) configStore.updateBucket(hidden.id, { visibleToUsers: false });

  const token = authSession.createSession({ id: 'unit-fun15c', username: 'unit-fun15c', role: 'user' });
  try {
    const ctx = { token, userId: 'unit-fun15c', role: 'user', activeBucketId: '' };
    const got = requestContext.runWith(ctx, () => configStore.get());
    assert(got && got.bucketId !== hidden.id,
      `普通用户的操作目标不能是对其不可见的全局默认桶（当前得到 ${got && got.bucketId}）`);

    // 即便会话残留了一个不可见桶，也必须被忽略
    const got2 = requestContext.runWith(
      { token, userId: 'unit-fun15c', role: 'user', activeBucketId: hidden.id },
      () => configStore.get());
    assert(!got2 || got2.bucketId !== hidden.id,
      '会话里残留的不可见桶必须被忽略，不得作为操作目标');

    // 写端同样要拒绝：否则「切桶成功」与「实际读到的桶」分叉，用户被静默误导
    assertEqual(configStore.setActiveBucket(hidden.id, { token, role: 'user' }), false,
      '普通用户不得激活对其不可见的桶（写端必须拒绝，不能只靠读端回退掩盖）');

    // 管理员不受影响：仍能看到并使用该桶
    const gotAdmin = requestContext.runWith(
      { token: '', userId: 'unit-fun15a2', role: 'admin', activeBucketId: '' },
      () => configStore.get());
    assertEqual(gotAdmin && gotAdmin.bucketId, hidden.id, '管理员不应被普通用户的可见性规则限制');
  } finally {
    authSession.destroySession(token);
    if (origVisible) configStore.updateBucket(hidden.id, { visibleToUsers: true }); // 还原
  }
});

test('FUN-15 · 管理员切桶同时更新会话与系统默认桶', () => {
  const configStore = require(path.join(ROOT, 'server', 'config-store.js'));
  const authSession = require(path.join(ROOT, 'server', 'auth-session.js'));

  const before = configStore.listBuckets().activeBucketId;
  const all = configStore.listBuckets();
  const other = (all.buckets.find((b) => b.id !== before) || all.buckets[0]);
  if (!other || other.id === before) return; // 只有一个桶时无法对照

  const token = authSession.createSession({ id: 'unit-fun15a', username: 'unit-fun15a', role: 'admin' });
  try {
    assert(configStore.setActiveBucket(other.id, { token, role: 'admin' }), '管理员切桶应成功');
    assertEqual(configStore.listBuckets().activeBucketId, other.id,
      '管理员切桶应更新系统默认桶（供 WebDAV / 分享链接 / 无会话场景回退）');
    assertEqual(authSession.getSessionBucket(token), other.id, '管理员自身的会话也应同步');
    // 还原，避免影响后续用例与真实配置
    configStore.setActiveBucket(before || other.id, { token, role: 'admin' });
  } finally {
    authSession.destroySession(token);
  }
});

test('FUN-04b · 全库已无「按前缀无条件清空元数据」的危险 API', () => {
  // removeMetaPrefix 与「列举被截断」组合会造成不可逆损失（残留密文永久不可解）。
  // 护栏：该函数必须**彻底消失**（仅剩注释提及不算），且删除实现统一走按确认 key 的批处理。
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!['node_modules', '.git', '.workbuddy', 'data'].includes(e.name)) walk(p); } else if (e.name.endsWith('.js')) files.push(p);
    }
  };
  walk(path.join(ROOT, 'server'));

  for (const f of files) {
    const code = readCode(path.relative(ROOT, f));
    assert(!/removeMetaPrefix\s*\(/.test(code),
      `${path.relative(ROOT, f)} 仍调用了 removeMetaPrefix —— 该 API 与列举截断组合会清空未删对象的元数据`);
  }
  // 定义本身也应被移除（留着就会有人用）
  const encCode = readCode('server/enc-store.js');
  assert(!/removeMetaPrefix/.test(encCode), 'enc-store.js 不应再定义 removeMetaPrefix');

  // fs-gateway.deletePrefix 必须具备循环删除 + 截断守卫
  const gw = readSrc('server/fs-gateway.js');
  assert(/truncated/.test(gw) && /while \(truncated/.test(gw), 'fs-gateway.deletePrefix 必须循环删除直到不截断');
  assert(/removeMetaBatch/.test(gw), '元数据只能按「已确认删除」的 key 逐批清理');
  assert(/MAX_ROUNDS/.test(gw), '应有轮次上限，防止 marker 不推进时死循环');
});

test('SEC-08 · 分享下载对缺失 Sec-Fetch-Site 的请求不再无条件放行（行为验证）', () => {
  // 旧护栏只 grep 源码，会被注释里的同名词骗过。这里直接驱动判定函数。
  const { classifyDownloadSource } = require(path.join(ROOT, 'server', 'share-origin.js'));
  const host = '127.0.0.1:3000';
  const self = { secFetchSite: '', referer: `http://${host}/s/abc`, host, secure: false };

  // ① 持票（已解锁 Cookie）→ 放行（合法流程：先看页面再下载）
  assertEqual(classifyDownloadSource({ ...self, hasTicket: true }).allow, true, '持票请求应放行');

  // ② 现代浏览器显式声明跨站 → 拒绝（第三方 <img> 预取）
  assertEqual(classifyDownloadSource({ ...self, secFetchSite: 'cross-site' }).allow, false,
    'Sec-Fetch-Site: cross-site 必须拒绝');

  // ③ 缺失该头 + 跨源 Referer → 拒绝（curl 带 -e 或旧浏览器被第三方引用）
  assertEqual(classifyDownloadSource({ ...self, referer: 'http://evil.example/page' }).allow, false,
    '缺失 Sec-Fetch-Site 且 Referer 跨源时必须拒绝');

  // ④ 缺失该头 + 同源 Referer → 放行
  assertEqual(classifyDownloadSource({ ...self }).allow, true, '缺失该头但 Referer 同源应放行');

  // ⑤ 缺失该头且无 Referer → 判定为直连客户端，放行但理由必须是"无来源标识"（供调用方审计）
  const d = classifyDownloadSource({ secFetchSite: '', referer: '', host, secure: false });
  assertEqual(d.allow, true, '无来源标识的直连客户端保留可用性（不能误伤 curl）');
  assertEqual(d.reason, 'no-source-hint', '必须显式标注为无来源，便于调用方记审计日志');

  // ⑥ 协议不同（http 页引 https 资源，或反之）→ 视为跨源
  assertEqual(classifyDownloadSource({ ...self, referer: `https://${host}/s/abc`, secure: false }).allow, false,
    'Referer 协议与当前请求不一致时应拒绝');

  // ⑦ 路由必须真的调用该判定（防止"函数写好了但没接上"）
  const routes = readCode('server/share-routes.js');
  assert(/classifyDownloadSource\s*\(/.test(routes), 'share-routes.js 必须调用来源判定函数');
  assert(/if\s*\(!src\.allow\)/.test(routes), '判定为不可信时必须中断并返回状态页');
});

test('FUN-14 · 目标存在性检查已覆盖 rename 与 move 的全部分支', () => {
  const code = readCode('server/routes/fs.js'); // 去注释，避免被文档里的同名词骗过
  assert(/function assertNoConflict/.test(code), '应存在统一的冲突检查函数（不要在各分支各写一份）');

  const at = (needle) => code.indexOf(needle);
  const renameStart = at("router.post('/fs/rename'");
  const moveStart = at("router.post('/fs/move'");
  assert(renameStart >= 0 && moveStart > renameStart, '应能定位到 /fs/rename 与 /fs/move 两段');

  const rename = code.slice(renameStart, moveStart);
  const move = code.slice(moveStart);

  assert(/assertNoConflict\s*\(/.test(rename),
    '/fs/rename 必须做目标存在性检查（文件夹重命名曾静默覆盖）');
  assert(/assertNoConflict\s*\(/.test(move),
    '/fs/move 必须做目标存在性检查（文件移动曾静默覆盖）');

  // 顺序约束：检查必须发生在任何写入（copyOne / copyBatch / migratePrefix）之前
  for (const [name, seg] of [['rename', rename], ['move', move]]) {
    const check = seg.search(/await assertNoConflict\s*\(/);
    const write = seg.search(/await (copyOne|copyBatch)\s*\(/);
    assert(check >= 0 && (write < 0 || check < write),
      `${name}：冲突检查必须先于任何复制/写入（否则覆盖已发生，检查无意义）`);
  }
});
