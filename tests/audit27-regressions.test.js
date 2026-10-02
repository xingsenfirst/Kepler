/**
 * 第二十七轮审计护栏（R27-01 ~ R27-26）
 *
 * 本轮是对一份**独立审计报告**（`审计报告-安全与功能缺陷.md`，26 条发现 K-01~K-26）的修复。
 * 护栏按「**撤掉修复就变红**」的取向挑选：每条断言的都是修复引入的**可观测差异**，
 * 而不是"代码长什么样"的形式检查（少数无法在纯进程内复现的路径用源码锚点兜住，
 * 并在注释里写明为什么）。
 *
 * 覆盖：
 *  - R27-01 重命名不再依赖未定义标识符（`currentItems` / 裸 `explorer`）
 *  - R27-03 「本次请求是否 HTTPS」唯一判据（反代 + TRUST_PROXY 下必须判为 HTTPS）
 *  - R27-07 IP 字面量必须可解析 + 规范化；解析失败的地址不再被 IP 守卫静默放行
 *  - R27-09 IP 规则目标尾斜杠不得退化成 `/0`
 *  - R27-10 畸形百分号编码不得把 ip-guard 中间件打成 500
 *  - R27-11 AES-GCM 认证失败时**一个字节的明文都不许下发**
 *  - R27-12 / R27-04 分片缺号 / 超出声明大小必须在路由层被拒（源码锚点 + 纯函数）
 *  - R27-13 / R27-14 密钥文件创建即 0600；原子写前先 fsync
 *  - R27-15 S3 路径点段规范化（签什么就发什么）
 *  - R27-20 二维码数据位填充：每个数据模块恰好写一次、第 0 列参与
 *  - R27-25 端点守卫：尾点 FQDN 不得绕过黑名单；保留段必须拒绝
 *  - R27-26 gzip 跳过判据大小写不敏感 + 206 不压缩
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { assert, assertEqual, ROOT } = require('./helpers');

const R = (...p) => path.join(ROOT, ...p);
const readSrc = (...p) => fs.readFileSync(R(...p), 'utf8');

/**
 * 剥掉**整行注释**后再断言。
 *
 * 本项目的注释习惯是「举反例」（R27-03 的说明里就引用了旧写法 `req.secure`），
 * 不剥注释会把「注释里提到的坏写法」当成真的坏写法。
 * 只剥整行注释（`//` 开头、块注释的 `*` / `/*` 续行），不动行尾注释与字符串
 * —— 与 `audit17-regressions.test.js` 的同名工具同一取向。
 */
function stripLineComments(src) {
  return String(src).split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
}

/* ================================================================== *
 * R27-01 · 重命名不可用（未定义标识符）
 * ================================================================== */

test('R27-01 · ops.js 不得引用未定义标识符（重命名曾因此整体静默失效）', () => {
  // 断言「代码里没有」时必须先剥注释：本项目的注释会引用旧写法作为反例
  const ops = readSrc('public', 'js', 'ops.js');
  const opsCode = stripLineComments(ops);
  const explorer = readSrc('public', 'js', 'explorer.js');

  assert(!/currentItems/.test(opsCode),
    'ops.js 不得再调用 currentItems —— 该标识符全库从未定义，抛错点在 try 之外、'
    + 'renameSelected 又不 await/catch，重命名的三个入口（工具栏 / F2 / 右键）会整体变成'
    + '一个 rejected promise：不弹框、不提示、无任何反应');

  assert(/explorer\.itemOf\s*\(/.test(opsCode),
    'ops.js 必须通过 explorer.itemOf() 取列表项（列表项归属 explorer 的私有 state.items）');
  assert(/explorer\.itemOf\s*=/.test(explorer),
    'explorer.js 必须导出 itemOf(key) 供 ops.js 使用');

  assert(/function updateOpsButtons\s*\(/.test(opsCode),
    'ops.js 必须自己实现 updateOpsButtons()（动态 import explorer）');
  assert(!/(^|[^.\w])explorer\.updateOpsButtons/.test(opsCode.replace(/m\.explorer\.updateOpsButtons/g, '')),
    'ops.js 不得再写裸 `explorer.updateOpsButtons` —— 它此前能跑只是因为 `index.html` 里'
    + '有 `<section id="explorer">`，靠 HTML Window 的命名访问把自由标识符解析成 DOM 元素'
    + '（`element.updateOpsButtons === undefined` → 静默 no-op）。这与 `currentItems` 是'
    + '同一类隐式依赖，任何一次给该元素改名就会变成 ReferenceError');
});

/* ================================================================== *
 * R27-03 · 「本次请求是否 HTTPS」唯一判据
 * ================================================================== */

test('R27-03 · 反代 TLS 终结（TRUST_PROXY=1）下必须判为 HTTPS，且分享页不得再用裸 req.secure', () => {
  const SEC = R('server', 'security.js');
  const savedHost = process.env.HOST;
  const savedTp = process.env.TRUST_PROXY;
  const fresh = () => { delete require.cache[require.resolve(SEC)]; return require(SEC); };
  try {
    process.env.HOST = '0.0.0.0';   // 部署模式（非回环）
    process.env.TRUST_PROXY = '1';
    const sec = fresh();
    assertEqual(typeof sec.requestIsSecure, 'function', 'security 必须导出 requestIsSecure（唯一判据）');
    assertEqual(sec.requestIsSecure({ secure: false }), true,
      'R27-03：部署模式 + TRUST_PROXY=1 时，socket 是明文（nginx→node）但浏览器地址栏是 https —— '
      + '必须判为 HTTPS。旧实现用裸 req.secure，于是分享页的 `POST /s/:id`（访问密码）、'
      + '`/s/:id/unlock`、`/s/:id/pay`、`/s/:id/pay/check` 在默认部署下全部被自己的同源校验 403');
    assertEqual(sec.requestIsSecure({ secure: true }), true, 'socket 本身加密时当然为 HTTPS');

    process.env.HOST = '127.0.0.1';  // 回环明文部署
    delete process.env.TRUST_PROXY;
    const sec2 = fresh();
    assertEqual(sec2.requestIsSecure({ secure: false }), false,
      'R27-03 反向对照：回环明文部署下不得判成 HTTPS（否则 https 页面判据会把正常访问当成跨站）');
  } finally {
    if (savedHost === undefined) delete process.env.HOST; else process.env.HOST = savedHost;
    if (savedTp === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = savedTp;
    delete require.cache[require.resolve(SEC)];
    require(SEC); // 复原：后续用例拿到与真实环境一致的实例
  }

  const share = stripLineComments(readSrc('server', 'share-routes.js'));
  assert(/security\.requestIsSecure\(req\)/.test(share),
    'share-routes.js 的 /s/* 同源校验必须走 security.requestIsSecure');
  assert(!/req\.secure/.test(share),
    'share-routes.js 不得再出现裸 req.secure —— 同一判据的 4 处写法必须收敛为 1 处'
    + '（旧实现只有这一处用裸值，于是默认 HTTPS 部署下同源请求被自家 CSRF 防护 403）');
});

/* ================================================================== *
 * R27-07 · IP 字面量校验与 IP 守卫 fail-closed
 * ================================================================== */

test('R27-07 · XFF 字面量必须可解析且规范化；解析失败不得被 IP 守卫放行', () => {
  const sec = require(R('server', 'security.js'));
  const ig = require(R('server', 'ip-guard.js'));

  // ① 合法性：旧实现「含 :: 且字符集合法即算 IP」，这些结构非法的串因此被采用
  for (const bad of ['1::2::3', ':::::', '::1:2:3:4:5:6:7:8:9', '1g::', '01.2.3.4', '999.1.1.1', 'aaa']) {
    assertEqual(sec.isIpLiteral(bad), false, `R27-07：${bad} 不是合法 IP 字面量，不得被采用`);
  }
  // 正向对照：合法地址仍必须原样可用（护栏不得退化成「一律不信任」）
  for (const good of ['203.0.113.9', '10.0.0.1', '::1', '2001:DB8::1', '::ffff:1.2.3.4']) {
    assertEqual(sec.isIpLiteral(good), true, `R27-07 正向对照：${good} 必须被接受`);
  }

  // ② 规范化：同一地址只能有一种拼写（否则限流/锁定键随拼写轮换）
  assertEqual(sec.normalizeIp('::A'), '::a', 'R27-07：IPv6 大小写必须归一');
  assertEqual(sec.normalizeIp('2001:DB8::1'), '2001:db8::1', 'R27-07：IPv6 必须压成规范形式');
  assertEqual(sec.normalizeIp('::ffff:0102:0304'), '1.2.3.4',
    'R27-07：IPv4-mapped 的十六进制写法必须与点分十进制写法归一到同一个键'
    + '（旧实现先盲目 slice(7) 会剥出 `0102:0304` 这种半截串）');
  assertEqual(sec.normalizeIp('::ffff:1.2.3.4'), '1.2.3.4', 'R27-07：点分映射写法同样归一');
  assertEqual(sec.normalizeIp('::1'), '127.0.0.1', 'R27-07：回环映射保持历史行为');

  // ③ fail-closed：解析不出来的地址不得跳过全部规则
  const blocked = ig.evaluate('1::2::3', 'GET', null);
  assertEqual(blocked.ok, false,
    'R27-07：不可解析的地址必须**拒绝**（旧实现 `if (info) {…}` 会跳过全部黑名单与「屏蔽海外」，'
    + '于是 `X-Forwarded-For: 1::2::3` 就是一个绕过全部 IP 屏蔽的请求头）');
  assertEqual(blocked.reason, 'unparsable', 'R27-07：拒绝原因必须是 unparsable（便于计入日志/文案）');
  assertEqual(ig.evaluate('203.0.113.9', 'GET', null).ok, true, 'R27-07 正向对照：正常地址照常放行');
});

/* ================================================================== *
 * R27-09 / R27-10 · 规则目标尾斜杠与畸形编码
 * ================================================================== */

test('R27-09 · IP 规则目标带尾斜杠不得被解析成 /0（一条笔误屏蔽全网）', () => {
  const ig = require(R('server', 'ip-guard.js'));
  assertEqual(ig.parseTarget('1.2.3.4/'), null,
    'R27-09：`1.2.3.4/` 的 prefixPart 是空串，`Number("") === 0` 会让它变成 `1.2.3.4/0` —— '
    + '匹配所有 IPv4，而规则由全局中间件执行 → 除回环外全网 403');
  assertEqual(ig.parseTarget('2001:db8::1/'), null, 'R27-09：IPv6 同型');
  // 正向对照：显式前缀与 `/0` 仍必须正常
  assertEqual(ig.parseTarget('1.2.3.4/32').prefix, 32, 'R27-09 正向对照：显式前缀照常');
  assertEqual(ig.parseTarget('0.0.0.0/0').prefix, 0, 'R27-09 正向对照：显式 /0 照常（只能由 0.0.0.0/0 产生）');
});

test('R27-10 · 畸形百分号编码不得把 ip-guard 打成 500（未认证可达）', () => {
  const ig = require(R('server', 'ip-guard.js'));
  // 该中间件挂在鉴权之前，旧实现里 decodeURIComponent 直接抛 URIError → 匿名 500 + 栈日志刷屏
  assertEqual(ig.resolveBucketId({ path: '/api/buckets/local/%E0%A4%A' }), null,
    'R27-10：无法解码的桶 id 必须按「解析不出」处理，而不是抛错');
  assertEqual(ig.resolveBucketId({ path: '/api/buckets/local/%ZZ' }), null, 'R27-10：`%ZZ` 同型');
  // 正向对照：正常路径仍必须解析出桶 id
  assertEqual(ig.resolveBucketId({ path: '/api/buckets/local/abc-123' }), 'abc-123', 'R27-10 正向对照');
});

/* ================================================================== *
 * R27-11 · GCM 先认证后下发
 * ================================================================== */

test('R27-11 · AES-GCM 认证失败时不得下发任何明文（旧实现会把等长错误明文先发出去）', async () => {
  const encStore = require(R('server', 'enc-store.js'));
  await encStore.updateSettings({ mode: 'crypto', password: '' });

  const plain = Buffer.from('A'.repeat(300000));
  const enc = encStore.encryptBuffer('bkt-gcm', 'x.bin', plain);
  assert(enc && enc.data, '前置：crypto 模式必须产出密文');

  // 翻转密文中的一位：IV 与标签不变（R24-03 的元数据比对全部通过），只有 GCM 标签校验能发现
  const tampered = Buffer.from(enc.data);
  tampered[tampered.length - 20] ^= 0x01;
  let err = null;
  let got = 0;
  await new Promise((resolve) => {
    const tr = encStore.decryptTransform(enc.meta);
    tr.on('data', (c) => { got += c.length; });
    tr.on('error', (e) => { err = e; resolve(); });
    tr.on('end', resolve);
    tr.end(tampered);
  });
  assert(err, 'R27-11：篡改必须报错（GCM 认证失败）');
  assertEqual(got, 0,
    'R27-11：认证失败前**一个字节都不能下发**。`download-stream` 已按 origSize 声明了 '
    + 'Content-Length，旧实现先 push(decipher.update()) 再 final()，等于把等长的错误明文'
    + '在报错前全部送达客户端，随后 res.destroy() 只是优雅 FIN —— 「收满 Content-Length」'
    + '的客户端会保留被篡改的文件');

  // 正向对照：未篡改必须完整还原
  const chunks = [];
  await new Promise((resolve, reject) => {
    const tr = encStore.decryptTransform(enc.meta);
    tr.on('data', (c) => chunks.push(c));
    tr.on('error', reject);
    tr.on('end', resolve);
    tr.end(enc.data);
  });
  assert(Buffer.concat(chunks).equals(plain), 'R27-11 正向对照：未篡改必须逐字节还原');
});

/* ================================================================== *
 * R27-04 / R27-12 · 分片上传的字节核对与缺号拒绝
 * ================================================================== */

test('R27-04 / R27-12 · 分片 complete 必须核对实际字节与缺号（源码锚点）', () => {
  const fsSrc = readSrc('server', 'routes', 'fs.js');
  assert(/分片序号不连续/.test(fsSrc),
    'R27-12：complete 必须拒绝缺号分片序列 —— 旧实现只校验「每个已上传分片有加密参数」，'
    + '`part=1` + `part=3` 会被合并成「第 1 段 + 第 3 段」，而本地元数据描述的正好也是这两段：'
    + '逐段 GCM 全部通过、解密不报错，却与 origSize 不符（magic 模式还会把逐片完整性永久降级为 none）');
  assert(/expectParts/.test(fsSrc), 'R27-12：还必须按「声明大小 ÷ 分片大小」核对片数');
  assert(/knownBytes > size/.test(fsSrc) && /UPLOAD_SIZE_MISMATCH/.test(fsSrc),
    'R27-04：必须按服务端自己算出的**实际字节数**与会话声明的大小核对，并给出机器可读码。'
    + '旧实现只在 init 按客户端声明的 size 过闸门，chunk/complete 既不核对也不记账，'
    + '最后还用 sess.size 记用量 —— 声明 8MB+1、实传 10000×8MB ≈ 78GB 也能穿过闸门且账面只涨 8MB');
  assert(/adjustStorageCache\(actualBytes, sessCfg\)/.test(fsSrc),
    'R27-04：用量记账必须用实际字节（actualBytes），不得再用声明值 sess.size');
  const sess = readSrc('server', 'upload-sessions.js');
  assert(/function setPart\(id, partNumber, etag, plainBytes\)/.test(sess),
    'R27-04：会话必须记录每个分片的**明文**字节数（云端 ListParts 给的是密文长度，不能当明文用）');
});

/* ================================================================== *
 * R27-13 / R27-14 · 密钥文件权限与 fsync
 * ================================================================== */

test('R27-13 · 密钥/证书文件必须「创建即 0600」（不是先 0644 落地再 chmod）', () => {
  const atomic = require(R('server', 'atomic-write.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r27-13-'));
  const file = path.join(dir, 'k.bin');

  // 行为验证：模式必须真的被传到底层 writeFileSync（Windows 忽略 POSIX 位，故这里断言传参）
  const orig = fs.writeFileSync;
  let seen = null;
  fs.writeFileSync = (p, d, o) => { if (String(p).includes('k.bin')) seen = o; return orig(p, d, o); };
  try {
    atomic.writeAtomicSync(file, 'secret-hex', { mode: 0o600 });
  } finally {
    fs.writeFileSync = orig;
  }
  assertEqual(seen && seen.mode, 0o600, 'R27-13：writeAtomicSync 必须把 mode 传给 writeFileSync');
  assertEqual(fs.readFileSync(file, 'utf8'), 'secret-hex', 'R27-13 正向对照：内容仍必须正确写入');

  // 三处密钥落盘点都必须显式传 0600（否则存在「同机他人可读主密钥」的窗口）
  assert(/writeAtomicSync\(KEY_FILE, key\.toString\('hex'\), \{ mode: 0o600 \}\)/.test(readSrc('server', 'config-store.js')),
    'R27-13：config-store 的主密钥必须创建即 0600');
  assert(/\{ mode: 0o600 \}/.test(readSrc('server', 'enc-store.js')), 'R27-13：enc-store 的 enc.key 同型');
  assert(/writeFileSync\(CERT_FILE, JSON\.stringify\(c\), \{ mode: 0o600 \}\)/.test(readSrc('server', 'local-cert.js')),
    'R27-13：证书私钥（local-cert.json）同型');
});

test('R27-14 · 原子写必须 fsync（否则断电后 rename 可能先于数据落盘）', () => {
  const src = readSrc('server', 'atomic-write.js');
  assert(/fsyncSync\(fd\)/.test(src), 'R27-14：同步写路径必须对临时文件 fsync');
  assert(/await fh\.sync\(\)/.test(src), 'R27-14：异步写路径必须 filehandle.sync()');
  assert(/path\.dirname\(file\)/.test(src), 'R27-14：rename 之后还要 fsync 目录（让目录项本身落盘）');
});

/* ================================================================== *
 * R27-15 · S3 路径点段规范化
 * ================================================================== */

test('R27-15 · S3 签名路径必须先删除点段（否则含 `.` 段的键必然签名不符）', () => {
  const { normalizeDotSegments } = require(R('server', 's3-client.js'));
  assertEqual(typeof normalizeDotSegments, 'function', 'R27-15：规范化函数必须导出以便护栏断言');
  assertEqual(normalizeDotSegments('/b/a/./x.txt'), '/b/a/x.txt',
    'R27-15：`fetch` 会用 WHATWG URL 再解析一次并删掉 `.` 段；签名必须先做同样的规范化，'
    + '否则「签名的路径 ≠ 实际发出的请求行」→ 云端 403 SignatureDoesNotMatch，'
    + '而 cos.js 会把它翻译成「请检查 AccessKey / SecretKey」，把运维引向轮换有效密钥');
  assertEqual(normalizeDotSegments('/b/a/../x.txt'), '/b/x.txt', 'R27-15：`..` 段同型');
  assertEqual(normalizeDotSegments('/b/a/b/'), '/b/a/b/', 'R27-15 正向对照：目录尾斜杠必须保留');
  assertEqual(normalizeDotSegments('/b/a/b.txt'), '/b/a/b.txt', 'R27-15 正向对照：普通键不得被改写');
});

/* ================================================================== *
 * R27-20 · 二维码数据位填充
 * ================================================================== */

test('R27-20 · 二维码每个数据模块恰好写一次，且第 0 列必须参与', () => {
  const src = readSrc('server', 'qrcode.js');
  // 用「源码注入计数器」观测 placeData 的实际写入位置（不改动仓库文件）
  const instrumented = src
    .replace('        if (f[row][col]) continue;',
      '        if (f[row][col]) { globalThis.__qrSkipped.push(row + "," + col); continue; }')
    .replace('        m[row][col] = bitIndex < total ? getBit(bitIndex) : 0;',
      '        globalThis.__qrWrites.push(row + "," + col);\n        m[row][col] = bitIndex < total ? getBit(bitIndex) : 0;');
  assert(instrumented !== src, '前置：注入点必须命中 placeData（否则本护栏会静默变成空跑）');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r27-20-'));
  const f = path.join(dir, 'qr-inst.js');
  fs.writeFileSync(f, instrumented);
  globalThis.__qrWrites = [];
  globalThis.__qrSkipped = [];
  const qr = require(f);
  const q = qr.encode('weixin://wxpay/bizpayurl?pr=abcdefg');
  const writes = globalThis.__qrWrites;
  const skipped = globalThis.__qrSkipped;
  delete globalThis.__qrWrites;
  delete globalThis.__qrSkipped;

  assert(q && writes.length, '前置：编码应成功且应有数据模块被写入');
  assertEqual(writes.length - new Set(writes).size, 0,
    'R27-20：同一个数据模块不得被写两次。旧实现写 `const colA = right === 6 ? right - 1 : right`'
    + '（只挪局部列号，不挪循环变量），列对变成 (5,4)、(4,3)、(2,1)：**第 4 列被写两次、'
    + '第 0 列永远拿不到数据**（规范要求 (5,4)、(3,2)、(1,0)）—— 标准解码器读出的码字顺序'
    + '与写入不符，只能靠 Reed–Solomon 纠错去修，抗污损余量被吃掉大半');
  assert(writes.some((k) => k.endsWith(',0')), 'R27-20：第 0 列必须收到数据模块');
  assertEqual(writes.length + skipped.length, q.size * q.size - q.size,
    'R27-20：除第 6 列（定时图案列，两列一组的走位会整列跨过、因此既不算数据也不算「函数模块跳过」）'
    + '之外，符号里的每个位置都必须二选一：要么被写入数据、要么是函数模块 —— 不允许有'
    + '「既非函数、又从未被写」的暗区（那意味着某段数据位根本没被放置）');
});

/* ================================================================== *
 * R27-25 · 端点守卫
 * ================================================================== */

test('R27-25 · 尾点 FQDN 不得绕过端点黑名单；RFC 6598/2544 保留段必须拒绝', () => {
  const g = require(R('server', 'endpoint-guard.js'));
  const mustReject = (u) => {
    let ok = false;
    try { g.assertSafeEndpoint(u); ok = true; } catch (e) { ok = false; }
    assertEqual(ok, false, `R27-25：${u} 必须被拒绝`);
  };
  mustReject('https://metadata.google.internal.');
  mustReject('https://localhost.');
  mustReject('https://100.64.0.1');
  mustReject('https://198.18.0.1');
  // 正向对照：不得把相邻的公有地址一起拒掉
  g.assertSafeEndpoint('https://100.63.0.1');
  g.assertSafeEndpoint('https://198.20.0.1');
});

/* ================================================================== *
 * R27-26 · gzip 跳过判据
 * ================================================================== */

test('R27-26 · 下载类路径大小写均须跳过（206 的判定见 R28-03 的端到端用例）', () => {
  const { shouldCompress } = require(R('server', 'gzip.js'));
  const req = (p) => ({ headers: { 'accept-encoding': 'gzip' }, path: p });
  assertEqual(shouldCompress(req('/api/fs/DOWNLOAD'), { statusCode: 200 }), false,
    'R27-26：Express 路由大小写不敏感，`/api/fs/DOWNLOAD` 会命中同一个下载处理器；'
    + '旧实现按小写字面量比对 SKIP_PATH，被一个字母大小写绕过 —— 本模块文档写明'
    + '「绝不缓冲」的流式下载因此进入压缩流程');
  assertEqual(shouldCompress(req('/api/stats/SPEED'), { statusCode: 200 }), false, 'R27-26：测速端点同型');
  /**
   * R28-03 的更正：这里原本断言 `shouldCompress(req('/big.js'), { statusCode: 206 }) === false`，
   * 但那是**假绿** —— `shouldCompress` 在路由之前执行，真实的 `res.statusCode` 此刻还是
   * 默认的 200，所以这条断言在生产路径上永远不可能被触发（缺陷仍在，护栏却全绿）。
   * 206 的护栏改到 `tests/audit28-regressions.test.js`：**发真实 Range 请求看响应头**。
   */
  // 正向对照：普通 API 与静态资源仍必须压缩（护栏不得退化成「一律不压」）
  assertEqual(shouldCompress(req('/api/fs/list'), { statusCode: 200 }), true, 'R27-26 正向对照：普通 API');
  assertEqual(shouldCompress(req('/big.js'), { statusCode: 200 }), true, 'R27-26 正向对照：静态 .js');
});
