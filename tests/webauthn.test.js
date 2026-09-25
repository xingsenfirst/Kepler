/**
 * 测试：WebAuthn（Windows Hello）零依赖实现
 *
 * 覆盖范围：本模块的安全价值全在"细节正确性"上，因此测试直接构造密码学材料，
 * 而不是依赖浏览器或真实认证器：
 *  1. CBOR 解码器（RFC 8949 确定性子集）与不支持类型的显式拒绝
 *  2. coseToSpki 与 OpenSSL 导出的 SPKI DER **逐字节一致**（最关键的兼容性断言）
 *  3. ES256 签名校验：直签摘要可通过、篡改必然失败、畸形签名不抛异常
 *  4. authenticatorData 解析（UP/UV/AT 标志、signCount、credId、COSE 公钥）
 *  5. 挑战时效与一次性消费（先删后判，杜绝重放）
 *  6. 完整注册流程 + 完整认证流程（含 signCount 递增）
 *  7. 负数路径：rpId 不符、UV 缺失、凭据 ID 张冠李戴、signCount 回退、算法不受支持
 *
 * 全部使用 node:test，不引入任何新依赖。
 */
const test = require('node:test');
const crypto = require('node:crypto');
const path = require('node:path');
const fsc = require('node:fs');
const os = require('node:os');

/**
 * R12-01：本文件此前的两种服务器状态操作（config-store 的用户增删 / WebAuthn 开关）
 * 直接落在**生产** `data/config.enc` 上 —— 因为它没有设 `COS_DATA_DIR`，而
 * `server/config-store.js` 在那一版里又是唯一不认该开关的 store（硬编码 data 目录）。
 * 后果就是：跑一次测试，用户的真实配置里就多出一个临时用户又被删掉，
 * `config.enc` 被反复重新加密写盘（内容等价、字节全变）。
 *
 * 与其它 server 测试文件保持一致：先把 `COS_DATA_DIR` 指到隔离临时目录，
 * **再** require 任何 server 模块（store 在模块加载时就把目录解析成常量了）。
 */
const TMP = fsc.mkdtempSync(path.join(os.tmpdir(), 'cos-webauthn-'));
process.env.COS_DATA_DIR = TMP;

const { assert, assertEqual } = require('./helpers');
const W = require(path.join(require('./helpers').ROOT, 'server', 'webauthn.js'));

// 收尾：先刷干 config-store 的去抖写队列，再删目录（失败必须告警，见 helpers.cleanupTempDir）
test.after(async () => {
  const configStore = require(path.join(require('./helpers').ROOT, 'server', 'config-store.js'));
  await require('./helpers').cleanupTempDir(TMP, {
    label: 'webauthn',
    flushers: [{ name: 'config-store', flush: () => configStore.flush() }],
  });
});

/* ============================ CBOR 构造辅助 ============================ */
/* 手写编码器（仅测试用）：与服务端解码器相互独立，避免"自己编码自己解码"式的假通过 */

function cborHead(major, n) {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) {
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(n, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

const cborUint = (n) => cborHead(0, n);
const cborNegInt = (n) => cborHead(1, -1 - n);
/** 按符号自动选择 major type（COSE 的 alg 键为负数，混用会编出错误字节） */
const cborInt = (n) => (n >= 0 ? cborUint(n) : cborNegInt(n));
const cborBytes = (buf) => Buffer.concat([cborHead(2, buf.length), buf]);
const cborText = (s) => {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([cborHead(3, b.length), b]);
};
const cborArray = (items) => Buffer.concat([cborHead(4, items.length), ...items]);
function cborMap(pairs) {
  return Buffer.concat([cborHead(5, pairs.length), ...pairs.flat()]);
}

/* ============================ 密码学材料辅助 ============================ */

/** 生成 P-256 密钥对，返回 { privateKey, publicKey, jwk, spki } */
function newKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    privateKey,
    publicKey,
    jwk: publicKey.export({ format: 'jwk' }),
    spki: publicKey.export({ format: 'der', type: 'spki' }),
  };
}

/** 用 jwk 的 x/y 构造 COSE EC2 公钥（Map 形式，与解码结果同构） */
function coseKeyFromJwk(jwk) {
  return new Map([
    [1, 2],                                        // kty = EC2
    [3, -7],                                       // alg = ES256
    [-1, 1],                                       // crv = P-256
    [-2, Buffer.from(jwk.x, 'base64url')],         // x
    [-3, Buffer.from(jwk.y, 'base64url')],         // y
  ]);
}

/** COSE 公钥 → CBOR 字节（用于拼进 authData） */
function coseKeyToCbor(coseKey) {
  return cborMap([
    [cborUint(1), cborInt(coseKey.get(1))],
    [cborUint(3), cborInt(coseKey.get(3))],
    [cborNegInt(-1), cborInt(coseKey.get(-1))],
    [cborNegInt(-2), cborBytes(coseKey.get(-2))],
    [cborNegInt(-3), cborBytes(coseKey.get(-3))],
  ]);
}

const RP_ID = '127.0.0.1';
const ORIGIN = 'http://127.0.0.1:3000';
const RP_HASH = crypto.createHash('sha256').update(RP_ID).digest();

/** 构造注册用 authenticatorData（含 attestedCredentialData） */
function buildAttestationAuthData({ credId, coseKey, signCount = 0, up = true, uv = true }) {
  let flags = 0x40; // AT
  if (up) flags |= 0x01;
  if (uv) flags |= 0x04;
  const sc = Buffer.alloc(4);
  sc.writeUInt32BE(signCount >>> 0, 0);
  const credIdLen = Buffer.alloc(2);
  credIdLen.writeUInt16BE(credId.length, 0);
  return Buffer.concat([RP_HASH, Buffer.from([flags]), sc, Buffer.alloc(16, 0), credIdLen, credId, coseKeyToCbor(coseKey)]);
}

/** 构造认证用 authenticatorData（无 AT） */
function buildAssertionAuthData({ signCount, up = true, uv = true }) {
  let flags = 0;
  if (up) flags |= 0x01;
  if (uv) flags |= 0x04;
  const sc = Buffer.alloc(4);
  sc.writeUInt32BE(signCount >>> 0, 0);
  return Buffer.concat([RP_HASH, Buffer.from([flags]), sc]);
}

function clientDataJSON(type, challenge, origin = ORIGIN) {
  return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), 'utf8');
}

/**
 * 对 authData || SHA-256(clientDataJSON) 做 ES256 签名（模拟认证器行为）。
 *
 * ⚠️ 必须用 `crypto.sign('sha256', signedData, key)` —— 这才是 WebAuthn §6.5.6
 * 定义的 ES256（= ecdsa-with-SHA256）：认证器对**原始被签名数据**做一次 SHA-256，
 * 再对摘要做 ECDSA。
 *
 * 反例（本项目真实踩过的坑）：先自行 `createHash('sha256')` 算摘要、再
 * `crypto.sign(null, digest, key)`。`algorithm` 为 null 时 Node/OpenSSL 会退回
 * 密钥默认摘要（EC P-256 = SHA-256），实际签的是 `SHA256(SHA256(data))`。
 * 由于服务端旧实现犯了**完全相同的错误**，测试与实现"对称地一起错"，
 * 用例全绿却掩盖了「注册成功、登录必然 signature_invalid」的真实缺陷。
 */
function signAssertion(privateKey, authData, clientDataBuf) {
  const signedData = Buffer.concat([authData, crypto.createHash('sha256').update(clientDataBuf).digest()]);
  return crypto.sign('sha256', signedData, privateKey);
}

/** 完成一次完整注册，返回 { reg, key, credId } */
function doRegistration({ up = true, uv = true, signCount = 0 } = {}) {
  const key = newKeyPair();
  const coseKey = coseKeyFromJwk(key.jwk);
  const credId = crypto.randomBytes(16);
  const challenge = W.issueChallenge('register', { userId: 'u-test' });
  const cdj = clientDataJSON('webauthn.create', challenge);
  const authData = buildAttestationAuthData({ credId, coseKey, signCount, up, uv });
  const attObj = cborMap([
    [cborText('fmt'), cborText('none')],
    [cborText('attStmt'), cborMap([])],
    [cborText('authData'), cborBytes(authData)],
  ]);
  const reg = W.verifyRegistration({
    clientDataJSON: W.base64url(cdj),
    attestationObject: W.base64url(attObj),
    rawId: W.base64url(credId),
    expectedChallenge: challenge,
    expectedOrigin: ORIGIN,
    rpId: RP_ID,
  });
  return { reg, key, credId, challenge, authData };
}

/* ============================ 1. CBOR 解码 ============================ */

test('CBOR：无符号整数跨越 1/2/4 字节边界', () => {
  assertEqual(W.cborDecode(cborUint(0)).value, 0, '0');
  assertEqual(W.cborDecode(cborUint(23)).value, 23, '23（info 内联边界）');
  assertEqual(W.cborDecode(cborUint(24)).value, 24, '24（转 1 字节）');
  assertEqual(W.cborDecode(cborUint(255)).value, 255, '255');
  assertEqual(W.cborDecode(cborUint(256)).value, 256, '256（转 2 字节）');
  assertEqual(W.cborDecode(cborUint(65535)).value, 65535, '65535');
  assertEqual(W.cborDecode(cborUint(65536)).value, 65536, '65536（转 4 字节）');
  assertEqual(W.cborDecode(cborUint(4294967295)).value, 4294967295, '2^32-1');
});

test('CBOR：负整数按 -1-n 编码（COSE 键 -1/-2/-3 的关键）', () => {
  assertEqual(W.cborDecode(cborNegInt(-1)).value, -1, '-1');
  assertEqual(W.cborDecode(cborNegInt(-2)).value, -2, '-2');
  assertEqual(W.cborDecode(cborNegInt(-3)).value, -3, '-3');
  assertEqual(W.cborDecode(cborNegInt(-7)).value, -7, '-7（ES256 算法号）');
});

test('CBOR：字节串/文本串/数组/映射/简单值', () => {
  const bytes = crypto.randomBytes(40);
  assertEqual(W.cborDecode(cborBytes(bytes)).value.equals(bytes), true, '字节串内容一致');
  assertEqual(W.cborDecode(cborText('你好 webauthn')).value, '你好 webauthn', 'UTF-8 文本串');
  const arr = W.cborDecode(cborArray([cborUint(1), cborText('a'), cborBytes(Buffer.from([9]))])).value;
  assertEqual(arr.length, 3, '数组长度');
  assertEqual(arr[0], 1, '数组元素 1');
  assertEqual(arr[2].equals(Buffer.from([9])), true, '数组内字节串');
  const map = W.cborDecode(cborMap([[cborText('k'), cborUint(7)], [cborUint(0), cborText('v')]])).value;
  assertEqual(map instanceof Map, true, '映射解码为 Map');
  assertEqual(map.get('k'), 7, '文本键');
  assertEqual(map.get(0), 'v', '整数键');
  assertEqual(W.cborDecode(Buffer.from([0xf5])).value, true, 'true');
  assertEqual(W.cborDecode(Buffer.from([0xf4])).value, false, 'false');
  assertEqual(W.cborDecode(Buffer.from([0xf6])).value, null, 'null');
});

test('CBOR：offset 准确（决定 COSE 公钥在 authData 中的结束位置）', () => {
  // 单元素：offset 应为该元素完整编码长度
  assertEqual(W.cborDecode(cborUint(5)).offset, 1, '1 字节整数');
  assertEqual(W.cborDecode(cborUint(300)).offset, 3, '3 字节整数');
  const bs = crypto.randomBytes(40);
  assertEqual(W.cborDecode(cborBytes(bs)).offset, 42, '40 字节字节串 = 2 + 40');
  assertEqual(W.cborDecode(cborText('abcd')).offset, 5, '4 字符文本串 = 1 + 4');
  // 多元素缓冲区：只消费首个元素，offset 恰好指向第二个元素的起点
  const first = cborText('abcd');
  const buf = Buffer.concat([first, cborUint(5), Buffer.from([0xff, 0xff])]);
  assertEqual(W.cborDecode(buf).offset, first.length, 'offset 应停在第一个元素之后');
  // 嵌套形态：attestationObject 整体解码后 offset 应等于总长度
  const attObj = cborMap([
    [cborText('fmt'), cborText('none')],
    [cborText('authData'), cborBytes(Buffer.from([1, 2, 3]))],
  ]);
  assertEqual(W.cborDecode(attObj).offset, attObj.length, '嵌套映射整体消费完毕');
});

test('CBOR：不支持的类型一律抛错（宁可拒绝也不误判）', () => {
  const cases = [
    [Buffer.from([0xc0, 0x01]), 'CBOR_UNSUPPORTED_MAJOR_TYPE_6', '标签（major 6）'],
    [Buffer.from([0xe0]), 'CBOR_UNSUPPORTED_SIMPLE_VALUE', '未定义简单值（0xe0）'],
    [Buffer.from([0xf7]), 'CBOR_UNSUPPORTED_SIMPLE_VALUE', 'undefined（0xf7）'],
    [Buffer.from([0x9f]), 'CBOR_INDEFINITE_NOT_SUPPORTED', '不定长数组'],
    [Buffer.from([0x5f]), 'CBOR_INDEFINITE_NOT_SUPPORTED', '不定长字节串'],
    [Buffer.from([0x7f]), 'CBOR_INDEFINITE_NOT_SUPPORTED', '不定长文本串'],
    [Buffer.from([0xbf]), 'CBOR_INDEFINITE_NOT_SUPPORTED', '不定长映射'],
    [Buffer.from([0x1b]), 'CBOR_UNSUPPORTED_LENGTH', '8 字节整数长度'],
    [Buffer.from([0x58]), 'CBOR_UNEXPECTED_EOF', '截断的 1 字节长度前缀'],
    [Buffer.from([0x59, 0x01]), 'CBOR_UNEXPECTED_EOF', '截断的 2 字节长度前缀'],
    [Buffer.from([0x5a, 0x00, 0x00]), 'CBOR_UNEXPECTED_EOF', '截断的 4 字节长度前缀'],
  ];
  for (const [buf, expect, label] of cases) {
    let reason = null;
    try { W.cborDecode(buf); } catch (e) { reason = e.message; }
    assert(reason !== null, `${label} 应抛错`);
    assert(reason.includes(expect), `${label} 错误码应为 ${expect}，实际 ${reason}`);
  }
  // 声明长度超出缓冲区
  let r = null;
  try { W.cborDecode(Buffer.from([0x44, 0x01, 0x02])); } catch (e) { r = e.message; }
  assertEqual(r, 'CBOR_TRUNCATED_BYTES', '字节串长度超出缓冲区');
  let rText = null;
  try { W.cborDecode(Buffer.from([0x64, 0x01, 0x02])); } catch (e) { rText = e.message; }
  assertEqual(rText, 'CBOR_TRUNCATED_TEXT', '文本串长度超出缓冲区');
  // 空输入
  let e2 = null;
  try { W.cborDecode(Buffer.alloc(0)); } catch (e) { e2 = e.message; }
  assertEqual(e2, 'CBOR_UNEXPECTED_EOF', '空输入');
});

test('CBOR：嵌套结构（attestationObject 真实形态）', () => {
  const authData = Buffer.from([1, 2, 3, 4]);
  const attObj = cborMap([
    [cborText('fmt'), cborText('packed')],
    [cborText('attStmt'), cborMap([[cborText('alg'), cborNegInt(-7)]])],
    [cborText('authData'), cborBytes(authData)],
  ]);
  const decoded = W.cborDecode(attObj).value;
  assertEqual(decoded.get('fmt'), 'packed', 'fmt');
  assertEqual(decoded.get('attStmt').get('alg'), -7, '嵌套映射里的负整数');
  assertEqual(decoded.get('authData').equals(authData), true, '嵌套字节串');
});

/* ============================ 2. COSE → SPKI ============================ */

test('coseToSpki：输出与 OpenSSL 导出的 SPKI DER 逐字节一致', () => {
  // 这是整个模块最关键的兼容性断言：只要有一个字节不同，crypto.createPublicKey 就会失败
  for (let i = 0; i < 5; i++) {
    const kp = newKeyPair();
    const spki = W.coseToSpki(coseKeyFromJwk(kp.jwk));
    assertEqual(spki.length, 91, 'P-256 SPKI DER 长度应为 91 字节');
    assertEqual(spki.equals(kp.spki), true, `第 ${i + 1} 组密钥：coseToSpki 应与 OpenSSL 导出一致`);
  }
});

test('coseToSpki：SPKI 结构可被 Node 解析为 EC P-256 公钥', () => {
  const kp = newKeyPair();
  const spki = W.coseToSpki(coseKeyFromJwk(kp.jwk));
  const key = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
  assertEqual(key.asymmetricKeyType, 'ec', '密钥类型应为 ec');
  assertEqual(key.asymmetricKeyDetails.namedCurve, 'prime256v1', '曲线应为 prime256v1');
});

test('coseToSpki：拒绝非 EC2 / 非 ES256 / 非 P-256 / 坐标长度异常', () => {
  const kp = newKeyPair();
  const good = coseKeyFromJwk(kp.jwk);
  const bad = (mutate, expect, label) => {
    const m = new Map(good);
    mutate(m);
    let reason = null;
    try { W.coseToSpki(m); } catch (e) { reason = e.message; }
    assertEqual(reason, expect, label);
  };
  bad((m) => m.set(1, 3), 'PUBLIC_KEY_NOT_EC2', 'kty=3(RSA) 应拒绝');
  bad((m) => m.set(3, -257), 'PUBLIC_KEY_ALG_NOT_ES256', 'alg=RS256 应拒绝');
  bad((m) => m.set(-1, 2), 'PUBLIC_KEY_CRV_NOT_P256', 'crv=P-384 应拒绝');
  bad((m) => m.set(-2, Buffer.alloc(31)), 'PUBLIC_KEY_COORD_INVALID', 'X 长度 31 应拒绝');
  bad((m) => m.set(-3, Buffer.alloc(33)), 'PUBLIC_KEY_COORD_INVALID', 'Y 长度 33 应拒绝');
  bad((m) => m.set(-2, 'not-a-buffer'), 'PUBLIC_KEY_COORD_INVALID', 'X 非 Buffer 应拒绝');
  // 非 Map
  let r = null;
  try { W.coseToSpki({ 1: 2 }); } catch (e) { r = e.message; }
  assertEqual(r, 'PUBLIC_KEY_NOT_MAP', '非 Map 输入应拒绝');
});

/* ============================ 3. ES256 签名校验 ============================ */

test('verifyEs256：按真实 WebAuthn 语义验签（ES256 = 对原始数据做一次 SHA-256）', () => {
  const kp = newKeyPair();
  const spki = W.coseToSpki(coseKeyFromJwk(kp.jwk));
  const data = Buffer.from('WebAuthn signed data');
  // 真实认证器：crypto.sign('sha256', data) —— 即 ecdsa-with-SHA256
  const sig = crypto.sign('sha256', data, kp.privateKey);

  assertEqual(W.verifyEs256(spki, data, sig), true, '正确签名应通过');
  assertEqual(W.verifyEs256(spki, Buffer.from('tampered'), sig), false, '篡改数据应失败');
  // 翻转签名最后一字节（S 的最低字节）
  const flipped = Buffer.from(sig);
  flipped[flipped.length - 1] ^= 0x01;
  assertEqual(W.verifyEs256(spki, data, flipped), false, '篡改签名应失败');
  // 翻转签名的长度字段（DER 结构破坏）
  const brokenStruct = Buffer.from(sig);
  brokenStruct[1] ^= 0x02;
  assertEqual(W.verifyEs256(spki, data, brokenStruct), false, '破坏 DER 结构应失败');
});

/**
 * 回归护栏：「双重哈希」缺陷不得复活。
 *
 * 服务端旧实现先自行算摘要、再 `crypto.verify(null, digest, key, sig)`，
 * 而 algorithm=null 会触发 EC 密钥的默认摘要，等价于 SHA-256 了两次。
 * 该缺陷的**唯一表现**是：注册（attestation='none'，不验签）成功，
 * 但登录校验恒返回 `signature_invalid` —— 与用户实际反馈完全一致。
 *
 * 这里直接固化"正确实现必须能验过真实签名，且不得把双重哈希误当正确"。
 */
test('verifyEs256：不得双重哈希（真实签名必须通过，旧错误模式必须验不过）', () => {
  const kp = newKeyPair();
  const spki = W.coseToSpki(coseKeyFromJwk(kp.jwk));
  const data = Buffer.from('assertion payload');
  const digest = crypto.createHash('sha256').update(data).digest();

  // ① 真实认证器的签名（对原始数据 SHA-256 一次）必须通过
  const realSig = crypto.sign('sha256', data, kp.privateKey);
  assertEqual(W.verifyEs256(spki, data, realSig), true,
    '真实 WebAuthn 语义的签名必须通过 —— 否则登录必然 signature_invalid');

  // ② 旧实现的调用模式（先自行摘要、再 verify(null, digest, ...)）必须验不过真实签名。
  //    若这里变 true，说明 Node 的 null 算法语义变了，本模块的判断需要复核。
  assertEqual(crypto.verify(null, digest, kp.publicKey, realSig), false,
    'verify(null, digest, ...) 不应验过真实签名（null 会退回 EC 默认摘要 → 双重哈希）');

  // ③ 用「双重哈希」签出来的签名，对真实数据必须被拒 —— 这是缺陷不得复活的护栏
  const doubleHashedSig = crypto.sign(null, digest, kp.privateKey);
  assertEqual(W.verifyEs256(spki, data, doubleHashedSig), false,
    '双重哈希签名对真实数据必须被拒 —— 若变真说明实现漂回了旧语义');
});

test('verifyEs256：裸 r||s（IEEE-P1363）签名同样可验（个别认证器不用 DER）', () => {
  const kp = newKeyPair();
  const spki = W.coseToSpki(coseKeyFromJwk(kp.jwk));
  const data = Buffer.from('p1363 raw signature');
  const der = crypto.sign('sha256', data, kp.privateKey);

  // 从 DER 中取出 r/s，重排成定长 64 字节的裸格式
  const { r, s } = W.normalizeDerSignature(der);
  const pad = (b) => {
    const out = Buffer.alloc(32);
    // 去掉 DER 的符号位填充 0x00 后右对齐
    let v = b;
    while (v.length > 32 && v[0] === 0x00) v = v.subarray(1);
    v.copy(out, 32 - v.length);
    return out;
  };
  const raw = Buffer.concat([pad(r), pad(s)]);
  assertEqual(raw.length, 64, '裸格式应为 64 字节');
  assertEqual(W.verifyEs256(spki, data, raw), true, '裸 r||s 签名应能验过');
  // 裸格式被篡改同样应失败
  const bad = Buffer.from(raw);
  bad[63] ^= 0x01;
  assertEqual(W.verifyEs256(spki, data, bad), false, '篡改裸签名应失败');
});

test('verifyEs256：换一把公钥必然失败（防止张冠李戴）', () => {
  const a = newKeyPair();
  const b = newKeyPair();
  const data = Buffer.from('shared payload');
  const sig = crypto.sign('sha256', data, a.privateKey);
  assertEqual(W.verifyEs256(W.coseToSpki(coseKeyFromJwk(b.jwk)), data, sig), false, 'B 的公钥不应验过 A 的签名');
});

test('verifyEs256：畸形输入返回 false 而非抛异常（路由层不会 500）', () => {
  const kp = newKeyPair();
  const spki = W.coseToSpki(coseKeyFromJwk(kp.jwk));
  assertEqual(W.verifyEs256(spki, Buffer.from('x'), Buffer.alloc(0)), false, '空签名');
  assertEqual(W.verifyEs256(spki, Buffer.from('x'), Buffer.from([0x30])), false, '过短签名');
  assertEqual(W.verifyEs256(spki, Buffer.from('x'), Buffer.from([0x31, 0x02, 0x02, 0x01, 0x00, 0x02, 0x01, 0x00])), false, '非 SEQUENCE');
  assertEqual(W.verifyEs256(Buffer.from('not der'), Buffer.from('x'), Buffer.alloc(72)), false, '无效公钥');
  assertEqual(W.verifyEs256(Buffer.alloc(0), Buffer.from('x'), Buffer.alloc(72)), false, '空公钥');
});

test('normalizeDerSignature：正确拆出 r/s，畸形结构抛错', () => {
  const kp = newKeyPair();
  const sig = crypto.sign('sha256', Buffer.from('m'), kp.privateKey);
  const { r, s } = W.normalizeDerSignature(sig);
  assert(r.length >= 1 && r.length <= 33, 'r 长度合理');
  assert(s.length >= 1 && s.length <= 33, 's 长度合理');
  for (const [buf, code] of [
    [Buffer.alloc(4), 'SIGNATURE_TOO_SHORT'],
    [Buffer.from([0x31, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01]), 'SIGNATURE_NOT_SEQUENCE'],
    [Buffer.from([0x30, 0x06, 0x03, 0x01, 0x01, 0x02, 0x01, 0x01]), 'SIGNATURE_R_MISSING'],
    [Buffer.from([0x30, 0x06, 0x02, 0x01, 0x01, 0x03, 0x01, 0x01]), 'SIGNATURE_S_MISSING'],
  ]) {
    let reason = null;
    try { W.normalizeDerSignature(buf); } catch (e) { reason = e.message; }
    assertEqual(reason, code, code);
  }
});

test('base64url 往返：无填充、URL 安全字符集', () => {
  for (let i = 0; i < 20; i++) {
    const buf = crypto.randomBytes(i * 3 + 1);
    const s = W.base64url(buf);
    assert(!/[+/=]/.test(s), '不应出现 + / = 字符');
    assertEqual(W.fromBase64url(s).equals(buf), true, '往返应一致');
  }
  // 含 0xfb 0xff 这类会产生 +/ 的字节
  const tricky = Buffer.from([0xfb, 0xff, 0xbf, 0xef]);
  const s = W.base64url(tricky);
  assert(!/[+/=]/.test(s), '高字节也不应产生 + / =');
  assertEqual(W.fromBase64url(s).equals(tricky), true, '高字节往返一致');
});

/* ============================ 4. authenticatorData 解析 ============================ */

test('parseAuthenticatorData：注册（AT=1）时解析出凭据与公钥', () => {
  const kp = newKeyPair();
  const coseKey = coseKeyFromJwk(kp.jwk);
  const credId = crypto.randomBytes(32);
  const authData = buildAttestationAuthData({ credId, coseKey, signCount: 7 });
  const p = W.parseAuthenticatorData(authData);

  assertEqual(p.rpIdHash.equals(RP_HASH), true, 'rpIdHash');
  assertEqual(p.flags, 0x45, 'flags = AT|UV|UP = 0x45');
  assertEqual(p.userPresent, true, 'UP');
  assertEqual(p.userVerified, true, 'UV');
  assertEqual(p.hasAttestedData, true, 'AT');
  assertEqual(p.signCount, 7, 'signCount');
  assertEqual(p.credentialId.equals(credId), true, 'credentialId');
  assertEqual(p.aaguid.length, 16, 'aaguid 16 字节');
  assertEqual(W.coseToSpki(p.cosePublicKey).equals(kp.spki), true, '解出的公钥应与原始一致');
  assertEqual(p.publicKeyEnd, authData.length, 'publicKeyEnd 应等于 authData 末尾');
});

test('parseAuthenticatorData：认证（AT=0）时不解析凭据，仅三个字段', () => {
  const authData = buildAssertionAuthData({ signCount: 12, up: true, uv: true });
  const p = W.parseAuthenticatorData(authData);
  assertEqual(authData.length, 37, '认证 authData 应为 37 字节');
  assertEqual(p.hasAttestedData, false, 'AT=0');
  assertEqual(p.userPresent, true, 'UP');
  assertEqual(p.userVerified, true, 'UV');
  assertEqual(p.signCount, 12, 'signCount');
  assertEqual(p.credentialId, undefined, '不应有 credentialId');
});

test('parseAuthenticatorData：UP/UV 标志位独立可辨', () => {
  assertEqual(W.parseAuthenticatorData(buildAssertionAuthData({ signCount: 0, up: true, uv: false })).userVerified, false, 'UP 有、UV 无');
  assertEqual(W.parseAuthenticatorData(buildAssertionAuthData({ signCount: 0, up: false, uv: true })).userPresent, false, 'UV 有、UP 无');
  assertEqual(W.parseAuthenticatorData(buildAssertionAuthData({ signCount: 0, up: false, uv: false })).flags, 0x00, 'flags=0');
});

test('parseAuthenticatorData：过长/截断输入抛出明确错误', () => {
  for (const [buf, code] of [
    [Buffer.alloc(36), 'AUTH_DATA_TOO_SHORT'],
    [Buffer.alloc(0), 'AUTH_DATA_TOO_SHORT'],
    [Buffer.concat([RP_HASH, Buffer.from([0x41]), Buffer.alloc(4), Buffer.alloc(16)]), 'AUTH_DATA_CREDENTIAL_TRUNCATED'],
  ]) {
    let reason = null;
    try { W.parseAuthenticatorData(buf); } catch (e) { reason = e.message; }
    assertEqual(reason, code, code);
  }
  // credId 声明长度超出实际数据
  const truncated = Buffer.concat([
    RP_HASH, Buffer.from([0x41]), Buffer.alloc(4), Buffer.alloc(16),
    Buffer.from([0x00, 0x20]), Buffer.from([1, 2, 3]),
  ]);
  let r = null;
  try { W.parseAuthenticatorData(truncated); } catch (e) { r = e.message; }
  assertEqual(r, 'AUTH_DATA_CRED_ID_TRUNCATED', 'credId 截断');
  // 非 Buffer
  let r2 = null;
  try { W.parseAuthenticatorData('string'); } catch (e) { r2 = e.message; }
  assertEqual(r2, 'AUTH_DATA_TOO_SHORT', '非 Buffer 输入');
});

/* ============================ 5. 挑战生命周期 ============================ */

test('挑战：签发后可消费一次，元信息随行', () => {
  const c = W.issueChallenge('register', { userId: 'u1', username: 'alice' });
  assertEqual(typeof c, 'string', '挑战应为字符串');
  assert(c.length >= 40, '挑战应有足够熵（32 字节 base64url ≥ 43 字符）');
  assert(!/[+/=]/.test(c), '挑战应为 URL 安全形式');
  const r = W.consumeChallenge(c, 'register');
  assertEqual(r.ok, true, '首次消费应成功');
  assertEqual(r.meta.userId, 'u1', 'meta.userId');
  assertEqual(r.meta.username, 'alice', 'meta.username');
});

test('挑战：一次性 —— 二次消费必失败（杜绝重放）', () => {
  const c = W.issueChallenge('login', { userId: 'u1' });
  assertEqual(W.consumeChallenge(c, 'login').ok, true, '第一次成功');
  const second = W.consumeChallenge(c, 'login');
  assertEqual(second.ok, false, '第二次必须失败');
  assertEqual(second.reason, 'challenge_unknown', '原因应为 challenge_unknown（已从池中删除）');
});

test('挑战：用途不匹配被拒绝，且同样被消费掉', () => {
  const c = W.issueChallenge('register', { userId: 'u1' });
  const r = W.consumeChallenge(c, 'login');
  assertEqual(r.ok, false, 'register 的挑战不能用于 login');
  assertEqual(r.reason, 'challenge_purpose_mismatch', '原因码');
  assertEqual(W.consumeChallenge(c, 'register').ok, false, '不匹配的消费也应销毁挑战');
});

test('挑战：未知/空值返回明确原因', () => {
  assertEqual(W.consumeChallenge('', 'login').reason, 'challenge_missing', '空字符串');
  assertEqual(W.consumeChallenge(null, 'login').reason, 'challenge_missing', 'null');
  assertEqual(W.consumeChallenge(undefined, 'login').reason, 'challenge_missing', 'undefined');
  assertEqual(W.consumeChallenge('Zm9vYmFy', 'login').reason, 'challenge_unknown', '未签发过的值');
});

test('挑战：过期后拒绝消费', () => {
  const c = W.issueChallenge('login', { userId: 'u1' });
  const entry = W._pending.get(c);
  assert(entry, '挑战应已登记');
  entry.expiresAt = Date.now() - 1; // 手动拨回时钟
  const r = W.consumeChallenge(c, 'login');
  assertEqual(r.ok, false, '过期应失败');
  assertEqual(r.reason, 'challenge_expired', '原因码');
});

test('挑战：TTL 常量为 5 分钟', () => {
  assertEqual(W.CHALLENGE_TTL_MS, 5 * 60 * 1000, 'CHALLENGE_TTL_MS');
  assertEqual(W.MAX_PENDING_CHALLENGES, 2000, 'MAX_PENDING_CHALLENGES');
});

test('挑战：签发时清理过期项（prunePending 不误删有效项）', () => {
  const stale = W.issueChallenge('login', { userId: 'ghost' });
  W._pending.get(stale).expiresAt = Date.now() - 1;
  const fresh = W.issueChallenge('login', { userId: 'u1' });
  assertEqual(W._pending.has(stale), false, '过期项应被清理');
  assertEqual(W._pending.has(fresh), true, '新项应保留');
  W.consumeChallenge(fresh, 'login');
});

test('clearChallengesForUser：只清指定用户的挑战', () => {
  const a1 = W.issueChallenge('login', { userId: 'ua' });
  const a2 = W.issueChallenge('register', { userId: 'ua' });
  const b1 = W.issueChallenge('login', { userId: 'ub' });
  W.clearChallengesForUser('ua');
  assertEqual(W._pending.has(a1), false, 'ua 的登录挑战应被清除');
  assertEqual(W._pending.has(a2), false, 'ua 的注册挑战应被清除');
  assertEqual(W._pending.has(b1), true, 'ub 的挑战不应受影响');
  W.consumeChallenge(b1, 'login');
});

/* ============================ 6. 完整注册流程 ============================ */

test('注册：完整流程通过并返回凭据信息', () => {
  const { reg, credId } = doRegistration({ signCount: 5 });
  assertEqual(reg.ok, true, '注册应通过，实际原因：' + reg.reason);
  assertEqual(reg.credentialId, W.base64url(credId), 'credentialId 应为凭据 ID 的 base64url');
  assertEqual(reg.signCount, 5, 'signCount 透传');
  assertEqual(reg.fmt, 'none', 'fmt 透传');
  assertEqual(reg.aaguid.length, 32, 'aaguid 为 16 字节的 hex（32 字符）');
  assert(Buffer.from(reg.publicKey, 'base64').length === 91, 'publicKey 为 91 字节 SPKI DER 的 base64');
});

test('注册：返回的公钥可直接用于验签（闭环验证）', () => {
  const { reg, key, credId } = doRegistration({ signCount: 5 });
  assertEqual(reg.ok, true, '前置注册应成功');
  const challenge = W.issueChallenge('login', { userId: 'u-test' });
  const cdj = clientDataJSON('webauthn.get', challenge);
  const authData = buildAssertionAuthData({ signCount: 6 });
  const sig = signAssertion(key.privateKey, authData, cdj);
  const auth = W.verifyAuthentication({
    clientDataJSON: W.base64url(cdj),
    authenticatorData: W.base64url(authData),
    signature: W.base64url(sig),
    rawId: W.base64url(credId),
    expectedChallenge: challenge,
    expectedOrigin: ORIGIN,
    rpId: RP_ID,
    publicKey: reg.publicKey,
    storedCredentialId: reg.credentialId,
    storedSignCount: reg.signCount,
  });
  assertEqual(auth.ok, true, '用注册返回的公钥验签应通过，实际原因：' + auth.reason);
});

/* ============================ 7. 注册负数路径 ============================ */

test('注册：clientDataJSON 类型必须为 webauthn.create', () => {
  const key = newKeyPair();
  const credId = crypto.randomBytes(8);
  const challenge = W.issueChallenge('register', { userId: 'u' });
  const authData = buildAttestationAuthData({ credId, coseKey: coseKeyFromJwk(key.jwk) });
  const attObj = cborMap([[cborText('fmt'), cborText('none')], [cborText('authData'), cborBytes(authData)]]);
  const r = W.verifyRegistration({
    clientDataJSON: W.base64url(clientDataJSON('webauthn.get', challenge)), // 故意用 get
    attestationObject: W.base64url(attObj),
    rawId: W.base64url(credId),
    expectedChallenge: challenge,
    expectedOrigin: ORIGIN,
    rpId: RP_ID,
  });
  assertEqual(r.ok, false, '类型不符应失败');
  assertEqual(r.reason, 'client_data_type_invalid', '原因码');
});

test('注册：挑战不匹配被拒绝', () => {
  const key = newKeyPair();
  const credId = crypto.randomBytes(8);
  const challenge = W.issueChallenge('register', { userId: 'u' });
  const authData = buildAttestationAuthData({ credId, coseKey: coseKeyFromJwk(key.jwk) });
  const attObj = cborMap([[cborText('fmt'), cborText('none')], [cborText('authData'), cborBytes(authData)]]);
  const r = W.verifyRegistration({
    clientDataJSON: W.base64url(clientDataJSON('webauthn.create', 'a-different-challenge')),
    attestationObject: W.base64url(attObj),
    rawId: W.base64url(credId),
    expectedChallenge: challenge,
    expectedOrigin: ORIGIN,
    rpId: RP_ID,
  });
  assertEqual(r.reason, 'client_data_challenge_mismatch', '原因码');
});

test('注册：origin 不匹配被拒绝（防跨站中继）', () => {
  const key = newKeyPair();
  const credId = crypto.randomBytes(8);
  const challenge = W.issueChallenge('register', { userId: 'u' });
  const authData = buildAttestationAuthData({ credId, coseKey: coseKeyFromJwk(key.jwk) });
  const attObj = cborMap([[cborText('fmt'), cborText('none')], [cborText('authData'), cborBytes(authData)]]);
  const r = W.verifyRegistration({
    clientDataJSON: W.base64url(clientDataJSON('webauthn.create', challenge, 'http://evil.example')),
    attestationObject: W.base64url(attObj),
    rawId: W.base64url(credId),
    expectedChallenge: challenge,
    expectedOrigin: ORIGIN,
    rpId: RP_ID,
  });
  assertEqual(r.reason, 'client_data_origin_mismatch', '原因码');
});

test('注册：rpId 不符被拒绝（防跨 RP 挪用凭据）', () => {
  const key = newKeyPair();
  const credId = crypto.randomBytes(8);
  const challenge = W.issueChallenge('register', { userId: 'u' });
  // authData 用 example.com 的 rpIdHash，但期望的 rpId 是 127.0.0.1
  const foreignHash = crypto.createHash('sha256').update('example.com').digest();
  const authData = Buffer.concat([
    foreignHash, Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16),
    Buffer.from([0x00, credId.length]), credId, coseKeyToCbor(coseKeyFromJwk(key.jwk)),
  ]);
  const attObj = cborMap([[cborText('fmt'), cborText('none')], [cborText('authData'), cborBytes(authData)]]);
  const r = W.verifyRegistration({
    clientDataJSON: W.base64url(clientDataJSON('webauthn.create', challenge)),
    attestationObject: W.base64url(attObj),
    rawId: W.base64url(credId),
    expectedChallenge: challenge,
    expectedOrigin: ORIGIN,
    rpId: RP_ID,
  });
  assertEqual(r.reason, 'rp_id_mismatch', '原因码');
});

test('注册：缺少 UV（仅 UP）被拒绝 —— Windows Hello 必须完成用户验证', () => {
  const { reg } = doRegistration({ uv: false });
  assertEqual(reg.ok, false, 'UV 缺失应失败');
  assertEqual(reg.reason, 'user_not_verified', '原因码');
});

test('注册：缺少 UP 被拒绝', () => {
  const { reg } = doRegistration({ up: false });
  assertEqual(reg.reason, 'user_not_present', '原因码');
});

test('注册：rawId 与 authData 内凭据 ID 不一致被拒绝', () => {
  const key = newKeyPair();
  const credId = crypto.randomBytes(16);
  const challenge = W.issueChallenge('register', { userId: 'u' });
  const authData = buildAttestationAuthData({ credId, coseKey: coseKeyFromJwk(key.jwk) });
  const attObj = cborMap([[cborText('fmt'), cborText('none')], [cborText('authData'), cborBytes(authData)]]);
  const r = W.verifyRegistration({
    clientDataJSON: W.base64url(clientDataJSON('webauthn.create', challenge)),
    attestationObject: W.base64url(attObj),
    rawId: W.base64url(crypto.randomBytes(16)), // 张冠李戴
    expectedChallenge: challenge,
    expectedOrigin: ORIGIN,
    rpId: RP_ID,
  });
  assertEqual(r.reason, 'credential_id_mismatch', '原因码');
});

test('注册：CTAP1/U2F 的 RSA 凭据（alg=RS256）被拒绝', () => {
  const key = newKeyPair();
  const credId = crypto.randomBytes(8);
  const coseKey = coseKeyFromJwk(key.jwk);
  coseKey.set(3, -257); // 改成 RS256
  const challenge = W.issueChallenge('register', { userId: 'u' });
  const authData = buildAttestationAuthData({ credId, coseKey });
  const attObj = cborMap([[cborText('fmt'), cborText('none')], [cborText('authData'), cborBytes(authData)]]);
  const r = W.verifyRegistration({
    clientDataJSON: W.base64url(clientDataJSON('webauthn.create', challenge)),
    attestationObject: W.base64url(attObj),
    rawId: W.base64url(credId),
    expectedChallenge: challenge,
    expectedOrigin: ORIGIN,
    rpId: RP_ID,
  });
  assertEqual(r.reason, 'public_key_unsupported', '原因码');
});

test('注册：畸形输入不抛异常，统一返回失败原因', () => {
  const cases = [
    [{ clientDataJSON: '!!!not-json!!!', attestationObject: 'AAAA', rawId: 'AA', expectedChallenge: W.issueChallenge('register', {}), expectedOrigin: ORIGIN, rpId: RP_ID }, 'client_data_invalid'],
    [{ clientDataJSON: W.base64url(Buffer.from('null')), attestationObject: 'AAAA', rawId: 'AA', expectedChallenge: W.issueChallenge('register', {}), expectedOrigin: ORIGIN, rpId: RP_ID }, 'client_data_invalid'],
  ];
  for (const [args, expect] of cases) {
    const r = W.verifyRegistration(args);
    assertEqual(r.ok, false, '应返回失败对象而非抛异常');
    assertEqual(r.reason, expect, '原因码');
  }
  // attestationObject 非 CBOR 映射
  const challenge = W.issueChallenge('register', {});
  const r2 = W.verifyRegistration({
    clientDataJSON: W.base64url(clientDataJSON('webauthn.create', challenge)),
    attestationObject: W.base64url(cborUint(5)),
    rawId: 'AA',
    expectedChallenge: challenge,
    expectedOrigin: ORIGIN,
    rpId: RP_ID,
  });
  assertEqual(r2.reason, 'attestation_object_invalid', '非映射的 attestationObject');
  // 缺 authData
  const challenge2 = W.issueChallenge('register', {});
  const r3 = W.verifyRegistration({
    clientDataJSON: W.base64url(clientDataJSON('webauthn.create', challenge2)),
    attestationObject: W.base64url(cborMap([[cborText('fmt'), cborText('none')]])),
    rawId: 'AA',
    expectedChallenge: challenge2,
    expectedOrigin: ORIGIN,
    rpId: RP_ID,
  });
  assertEqual(r3.reason, 'auth_data_missing', '缺少 authData');
});

test('注册：挑战被消费后重放同一请求必失败', () => {
  const key = newKeyPair();
  const credId = crypto.randomBytes(8);
  const challenge = W.issueChallenge('register', { userId: 'u' });
  const authData = buildAttestationAuthData({ credId, coseKey: coseKeyFromJwk(key.jwk) });
  const attObj = cborMap([[cborText('fmt'), cborText('none')], [cborText('authData'), cborBytes(authData)]]);
  const args = {
    clientDataJSON: W.base64url(clientDataJSON('webauthn.create', challenge)),
    attestationObject: W.base64url(attObj),
    rawId: W.base64url(credId),
    expectedChallenge: challenge,
    expectedOrigin: ORIGIN,
    rpId: RP_ID,
  };
  assertEqual(W.verifyRegistration(args).ok, true, '首次应成功');
  const replay = W.verifyRegistration(args);
  assertEqual(replay.ok, false, '重放应失败');
  assertEqual(replay.reason, 'challenge_unknown', '原因码');
});

/* ============================ 8. 完整认证流程 ============================ */

test('认证：完整流程通过且 signCount 递增', () => {
  const { reg, key, credId } = doRegistration({ signCount: 5 });
  assertEqual(reg.ok, true, '前置注册应成功');
  const challenge = W.issueChallenge('login', { userId: 'u-test' });
  const cdj = clientDataJSON('webauthn.get', challenge);
  const authData = buildAssertionAuthData({ signCount: 6 });
  const sig = signAssertion(key.privateKey, authData, cdj);
  const auth = W.verifyAuthentication({
    clientDataJSON: W.base64url(cdj),
    authenticatorData: W.base64url(authData),
    signature: W.base64url(sig),
    rawId: W.base64url(credId),
    expectedChallenge: challenge,
    expectedOrigin: ORIGIN,
    rpId: RP_ID,
    publicKey: reg.publicKey,
    storedCredentialId: reg.credentialId,
    storedSignCount: reg.signCount,
  });
  assertEqual(auth.ok, true, '认证应通过，实际原因：' + auth.reason);
  assertEqual(auth.signCount, 6, '新 signCount 应为 6');
});

test('认证：signCount 回退被拒绝（凭据克隆检测）', () => {
  const { reg, key, credId } = doRegistration({ signCount: 5 });
  assertEqual(reg.ok, true, '前置注册应成功');
  const challenge = W.issueChallenge('login', { userId: 'u-test' });
  const cdj = clientDataJSON('webauthn.get', challenge);
  const authData = buildAssertionAuthData({ signCount: 4 }); // 回退到 4
  const sig = signAssertion(key.privateKey, authData, cdj);
  const auth = W.verifyAuthentication({
    clientDataJSON: W.base64url(cdj),
    authenticatorData: W.base64url(authData),
    signature: W.base64url(sig),
    rawId: W.base64url(credId),
    expectedChallenge: challenge,
    expectedOrigin: ORIGIN,
    rpId: RP_ID,
    publicKey: reg.publicKey,
    storedCredentialId: reg.credentialId,
    storedSignCount: 5,
  });
  assertEqual(auth.ok, false, '计数回退应拒绝');
  assertEqual(auth.reason, 'sign_count_regression', '原因码');
});

test('认证：signCount 相等也被拒绝（必须严格递增）', () => {
  const { reg, key, credId } = doRegistration({ signCount: 5 });
  const challenge = W.issueChallenge('login', { userId: 'u-test' });
  const cdj = clientDataJSON('webauthn.get', challenge);
  const authData = buildAssertionAuthData({ signCount: 5 });
  const sig = signAssertion(key.privateKey, authData, cdj);
  const auth = W.verifyAuthentication({
    clientDataJSON: W.base64url(cdj),
    authenticatorData: W.base64url(authData),
    signature: W.base64url(sig),
    rawId: W.base64url(credId),
    expectedChallenge: challenge,
    expectedOrigin: ORIGIN,
    rpId: RP_ID,
    publicKey: reg.publicKey,
    storedCredentialId: reg.credentialId,
    storedSignCount: 5,
  });
  assertEqual(auth.reason, 'sign_count_regression', '相等回退同样拒绝');
});

test('认证：签名被篡改必然失败', () => {
  const { reg, key, credId } = doRegistration({ signCount: 1 });
  const challenge = W.issueChallenge('login', { userId: 'u-test' });
  const cdj = clientDataJSON('webauthn.get', challenge);
  const authData = buildAssertionAuthData({ signCount: 2 });
  const sig = signAssertion(key.privateKey, authData, cdj);
  sig[sig.length - 1] ^= 0xff; // 翻转最后一位
  const auth = W.verifyAuthentication({
    clientDataJSON: W.base64url(cdj),
    authenticatorData: W.base64url(authData),
    signature: W.base64url(sig),
    rawId: W.base64url(credId),
    expectedChallenge: challenge,
    expectedOrigin: ORIGIN,
    rpId: RP_ID,
    publicKey: reg.publicKey,
    storedCredentialId: reg.credentialId,
    storedSignCount: 1,
  });
  assertEqual(auth.reason, 'signature_invalid', '原因码');
});

test('认证：用他人公钥验签失败', () => {
  const { reg, credId } = doRegistration({ signCount: 1 });
  const other = newKeyPair();
  const challenge = W.issueChallenge('login', { userId: 'u-test' });
  const cdj = clientDataJSON('webauthn.get', challenge);
  const authData = buildAssertionAuthData({ signCount: 2 });
  const sig = signAssertion(other.privateKey, authData, cdj); // 用别人的私钥签
  const auth = W.verifyAuthentication({
    clientDataJSON: W.base64url(cdj),
    authenticatorData: W.base64url(authData),
    signature: W.base64url(sig),
    rawId: W.base64url(credId),
    expectedChallenge: challenge,
    expectedOrigin: ORIGIN,
    rpId: RP_ID,
    publicKey: reg.publicKey,
    storedCredentialId: reg.credentialId,
    storedSignCount: 1,
  });
  assertEqual(auth.reason, 'signature_invalid', '原因码');
});

test('认证：凭据 ID 不匹配被拒绝（浏览器持有多个凭据时防混淆）', () => {
  const { reg, key, credId } = doRegistration({ signCount: 1 });
  const challenge = W.issueChallenge('login', { userId: 'u-test' });
  const cdj = clientDataJSON('webauthn.get', challenge);
  const authData = buildAssertionAuthData({ signCount: 2 });
  const sig = signAssertion(key.privateKey, authData, cdj);
  const auth = W.verifyAuthentication({
    clientDataJSON: W.base64url(cdj),
    authenticatorData: W.base64url(authData),
    signature: W.base64url(sig),
    rawId: W.base64url(crypto.randomBytes(16)), // 换一个 rawId
    expectedChallenge: challenge,
    expectedOrigin: ORIGIN,
    rpId: RP_ID,
    publicKey: reg.publicKey,
    storedCredentialId: W.base64url(credId),
    storedSignCount: 1,
  });
  assertEqual(auth.reason, 'credential_id_mismatch', '原因码');
});

test('认证：clientDataJSON 类型必须为 webauthn.get', () => {
  const { reg, key, credId } = doRegistration({ signCount: 1 });
  const challenge = W.issueChallenge('login', { userId: 'u-test' });
  const cdj = clientDataJSON('webauthn.create', challenge); // 故意用 create
  const authData = buildAssertionAuthData({ signCount: 2 });
  const sig = signAssertion(key.privateKey, authData, cdj);
  const auth = W.verifyAuthentication({
    clientDataJSON: W.base64url(cdj),
    authenticatorData: W.base64url(authData),
    signature: W.base64url(sig),
    rawId: W.base64url(credId),
    expectedChallenge: challenge,
    expectedOrigin: ORIGIN,
    rpId: RP_ID,
    publicKey: reg.publicKey,
    storedCredentialId: reg.credentialId,
    storedSignCount: 1,
  });
  assertEqual(auth.reason, 'client_data_type_invalid', '原因码');
});

test('认证：origin 不符被拒绝', () => {
  const { reg, key, credId } = doRegistration({ signCount: 1 });
  const challenge = W.issueChallenge('login', { userId: 'u-test' });
  const cdj = clientDataJSON('webauthn.get', challenge, 'https://phishing.example');
  const authData = buildAssertionAuthData({ signCount: 2 });
  const sig = signAssertion(key.privateKey, authData, cdj);
  const auth = W.verifyAuthentication({
    clientDataJSON: W.base64url(cdj),
    authenticatorData: W.base64url(authData),
    signature: W.base64url(sig),
    rawId: W.base64url(credId),
    expectedChallenge: challenge,
    expectedOrigin: ORIGIN,
    rpId: RP_ID,
    publicKey: reg.publicKey,
    storedCredentialId: reg.credentialId,
    storedSignCount: 1,
  });
  assertEqual(auth.reason, 'client_data_origin_mismatch', '原因码');
});

test('认证：UV 缺失被拒绝（即使用户在场）', () => {
  const { reg, key, credId } = doRegistration({ signCount: 1 });
  const challenge = W.issueChallenge('login', { userId: 'u-test' });
  const cdj = clientDataJSON('webauthn.get', challenge);
  const authData = buildAssertionAuthData({ signCount: 2, uv: false });
  const sig = signAssertion(key.privateKey, authData, cdj);
  const auth = W.verifyAuthentication({
    clientDataJSON: W.base64url(cdj),
    authenticatorData: W.base64url(authData),
    signature: W.base64url(sig),
    rawId: W.base64url(credId),
    expectedChallenge: challenge,
    expectedOrigin: ORIGIN,
    rpId: RP_ID,
    publicKey: reg.publicKey,
    storedCredentialId: reg.credentialId,
    storedSignCount: 1,
  });
  assertEqual(auth.reason, 'user_not_verified', '原因码');
});

test('认证：公钥缺失或无效被拒绝', () => {
  const { key, credId } = doRegistration({ signCount: 1 });
  const mk = (publicKey) => {
    const challenge = W.issueChallenge('login', { userId: 'u-test' });
    const cdj = clientDataJSON('webauthn.get', challenge);
    const authData = buildAssertionAuthData({ signCount: 2 });
    const sig = signAssertion(key.privateKey, authData, cdj);
    return W.verifyAuthentication({
      clientDataJSON: W.base64url(cdj),
      authenticatorData: W.base64url(authData),
      signature: W.base64url(sig),
      rawId: W.base64url(credId),
      expectedChallenge: challenge,
      expectedOrigin: ORIGIN,
      rpId: RP_ID,
      publicKey,
      storedCredentialId: W.base64url(credId),
      storedSignCount: 1,
    });
  };
  assertEqual(mk('').reason, 'stored_public_key_invalid', '空公钥');
  assertEqual(mk(null).reason, 'stored_public_key_invalid', 'null 公钥');
  assertEqual(mk(Buffer.from('garbage').toString('base64')).reason, 'signature_invalid', '无效公钥（createPublicKey 失败即 false）');
});

test('认证：signCount 为 0 时不做回退判定（部分认证器不支持计数）', () => {
  const { reg, key, credId } = doRegistration({ signCount: 0 });
  assertEqual(reg.ok, true, '注册 signCount=0 应成功');
  const challenge = W.issueChallenge('login', { userId: 'u-test' });
  const cdj = clientDataJSON('webauthn.get', challenge);
  const authData = buildAssertionAuthData({ signCount: 0 });
  const sig = signAssertion(key.privateKey, authData, cdj);
  const auth = W.verifyAuthentication({
    clientDataJSON: W.base64url(cdj),
    authenticatorData: W.base64url(authData),
    signature: W.base64url(sig),
    rawId: W.base64url(credId),
    expectedChallenge: challenge,
    expectedOrigin: ORIGIN,
    rpId: RP_ID,
    publicKey: reg.publicKey,
    storedCredentialId: reg.credentialId,
    storedSignCount: 0,
  });
  assertEqual(auth.ok, true, '0 → 0 应放行（无计数能力），实际原因：' + auth.reason);
});

test('认证：挑战被消费后重放必失败', () => {
  const { reg, key, credId } = doRegistration({ signCount: 1 });
  const challenge = W.issueChallenge('login', { userId: 'u-test' });
  const cdj = clientDataJSON('webauthn.get', challenge);
  const authData = buildAssertionAuthData({ signCount: 2 });
  const sig = signAssertion(key.privateKey, authData, cdj);
  const args = {
    clientDataJSON: W.base64url(cdj),
    authenticatorData: W.base64url(authData),
    signature: W.base64url(sig),
    rawId: W.base64url(credId),
    expectedChallenge: challenge,
    expectedOrigin: ORIGIN,
    rpId: RP_ID,
    publicKey: reg.publicKey,
    storedCredentialId: reg.credentialId,
    storedSignCount: 1,
  };
  assertEqual(W.verifyAuthentication(args).ok, true, '首次应通过');
  const replay = W.verifyAuthentication(args);
  assertEqual(replay.ok, false, '重放应失败');
  assertEqual(replay.reason, 'challenge_unknown', '原因码');
});

test('认证：两步流程不可互换 —— login 挑战不能用于 register 校验', () => {
  const { key, credId } = doRegistration({ signCount: 1 });
  const challenge = W.issueChallenge('login', { userId: 'u-test' }); // 登录用挑战
  const authData = buildAttestationAuthData({ credId, coseKey: coseKeyFromJwk(key.jwk) });
  const attObj = cborMap([[cborText('fmt'), cborText('none')], [cborText('authData'), cborBytes(authData)]]);
  const r = W.verifyRegistration({
    clientDataJSON: W.base64url(clientDataJSON('webauthn.create', challenge)),
    attestationObject: W.base64url(attObj),
    rawId: W.base64url(credId),
    expectedChallenge: challenge,
    expectedOrigin: ORIGIN,
    rpId: RP_ID,
  });
  assertEqual(r.reason, 'challenge_purpose_mismatch', '用途必须严格区分');
});

/* ============================ 9. 文案映射 ============================ */

test('publicReason：覆盖全部内部原因码，未知码有兜底', () => {
  const reasons = [
    'challenge_missing', 'challenge_unknown', 'challenge_expired', 'challenge_purpose_mismatch',
    'client_data_invalid', 'client_data_type_invalid', 'client_data_challenge_mismatch',
    'client_data_origin_mismatch', 'attestation_object_invalid', 'auth_data_missing',
    'auth_data_invalid', 'rp_id_mismatch', 'user_not_present', 'user_not_verified',
    'attested_credential_missing', 'credential_id_mismatch', 'public_key_unsupported',
    'stored_public_key_invalid', 'signature_invalid', 'sign_count_regression',
    'not_enabled', 'not_registered',
  ];
  for (const r of reasons) {
    const text = W.publicReason(r);
    assert(typeof text === 'string' && text.length > 0, `${r} 应有文案`);
    assert(text !== W.publicReason('__unknown__'), `${r} 不应落到兜底文案`);
  }
  // 兜底
  assertEqual(W.publicReason('some_brand_new_reason'), W.publicReason('another'), '未知码统一兜底');
  assertEqual(W.publicReason(''), W.publicReason(undefined), '空值走兜底');
});

test('publicReason：文案不泄露内部实现细节', () => {
  for (const r of ['signature_invalid', 'sign_count_regression', 'public_key_unsupported']) {
    const text = W.publicReason(r);
    assert(!/Map|Buffer|DER|SPKI|COSE|CBOR|0x/i.test(text), `${r} 的文案不应暴露内部术语：${text}`);
  }
});

/* ============================ 10. 失效开放（fail-open）防护 ============================ */

test('登录判定必须用原始用户记录：userView 不含 webauthn，用之判断会静默绕过二次验证', () => {
  // 这是本项目实际踩过的坑：authenticateUser() 返回的是 userView（安全视图），
  // 其中**没有** webauthn 字段，若直接把它喂给 isWebauthnEnabled() 会恒返回 false，
  // 导致「启用了 Windows Hello 却照样只凭密码登录」—— 安全控制静默失效（fail-open）。
  // 这里用源码静态断言把这条边界钉住。
  const src = require('node:fs').readFileSync(
    path.join(require('./helpers').ROOT, 'server', 'routes', 'auth.js'), 'utf8');
  const login = src.slice(src.indexOf("router.post('/auth/login'"), src.indexOf("router.post('/auth/login/webauthn'"));

  assert(/findUserRawById\(/.test(login),
    '登录第一步必须通过 findUserRawById() 取原始记录来判断是否启用 Windows Hello');
  assert(!/isWebauthnEnabled\(\s*user\s*\)/.test(login),
    '不得把 authenticateUser() 的返回视图直接传给 isWebauthnEnabled()（会恒为 false，静默绕过二次验证）');
  // 反向确认：确认 authenticateUser 确实返回视图（否则上面的断言失去意义）
  const store = require('node:fs').readFileSync(
    path.join(require('./helpers').ROOT, 'server', 'config-store.js'), 'utf8');
  const authFn = store.slice(store.indexOf('function authenticateUser'), store.indexOf('function findUserRaw('));
  assert(/return\s+userView\(/.test(authFn), 'authenticateUser 应返回 userView（不含 webauthn 字段）');
  assert(!/webauthn/.test(authFn), 'authenticateUser 的返回值中不应出现 webauthn 字段');
});

test('config-store：isWebauthnEnabled 对视图与原始记录的判定差异符合预期', async () => {
  // 端到端固化"视图恒 false、原始记录才准确"这一事实，避免将来有人误改 userView 后
  // 又让上面的静态断言变成假阳性。
  const configStore = require(path.join(require('./helpers').ROOT, 'server', 'config-store.js'));
  const name = 'wa-unit-' + Date.now();
  const created = await configStore.addUser({ username: name, password: 'Unit!2026abc', role: 'user' });
  try {
    const raw0 = configStore.findUserRawById(created.id);
    assertEqual(configStore.isWebauthnEnabled(raw0), false, '初始未启用');
    configStore.setUserWebauthn(created.id, {
      credentialId: 'unit-test-cred',
      publicKey: Buffer.alloc(91, 3).toString('base64'),
      signCount: 0,
      aaguid: '00'.repeat(16),
      fmt: 'none',
    });
    const raw1 = configStore.findUserRawById(created.id);
    assertEqual(configStore.isWebauthnEnabled(raw1), true, '启用后原始记录应为 true');
    assertEqual(configStore.isWebauthnEnabled(await configStore.authenticateUser(name, 'Unit!2026abc')), false,
      'authenticateUser 返回的视图因不含 webauthn 字段而恒为 false —— 这就是 fail-open 的来源');
    // 安全视图不得泄露密钥材料
    const view = configStore.userView ? configStore.userView(raw1) : null;
    if (view) {
      assertEqual(view.publicKey, undefined, 'userView 不应暴露 publicKey');
      assertEqual(view.credentialId, undefined, 'userView 不应暴露 credentialId');
      assertEqual(view.webauthnEnabled, true, 'userView 应暴露 webauthnEnabled');
    }
    // 清除后回到未启用
    configStore.clearUserWebauthn(created.id);
    assertEqual(configStore.isWebauthnEnabled(configStore.findUserRawById(created.id)), false, '清除后应回到未启用');
  } finally {
    configStore.removeUser(created.id);
  }
});

test('config-store：凭据不完整时 enabled 回落到 false（避免登录被永久卡死）', async () => {
  const configStore = require(path.join(require('./helpers').ROOT, 'server', 'config-store.js'));
  // 直接构造缺 publicKey 的记录：normalizeWebauthn 应关闭 enabled
  const name = 'wa-partial-' + Date.now();
  const created = await configStore.addUser({ username: name, password: 'Unit!2026abc', role: 'user' });
  try {
    const raw = configStore.findUserRawById(created.id);
    raw.webauthn = { enabled: true, credentialId: 'only-cred', publicKey: '', signCount: 0 };
    assertEqual(configStore.isWebauthnEnabled(raw), false, '缺 publicKey 时应视为未启用');
    raw.webauthn = { enabled: true, credentialId: '', publicKey: 'somekey', signCount: 0 };
    assertEqual(configStore.isWebauthnEnabled(raw), false, '缺 credentialId 时应视为未启用');
    raw.webauthn = { enabled: false, credentialId: 'c', publicKey: 'k', signCount: 0 };
    assertEqual(configStore.isWebauthnEnabled(raw), false, 'enabled=false 时未启用');
    raw.webauthn = { enabled: true, credentialId: 'c', publicKey: 'k', signCount: 0 };
    assertEqual(configStore.isWebauthnEnabled(raw), true, '三者齐备才算启用');
  } finally {
    configStore.removeUser(created.id);
  }
});

/* ============================ 11. 常量与导出完整性 ============================ */
test('COSE 常量与 WebAuthn 规范一致', () => {
  assertEqual(W.COSE_ALG_ES256, -7, 'ES256 的 COSE 算法号为 -7');
});

test('模块导出完整（路由层依赖的全部函数都存在）', () => {
  const required = [
    'CHALLENGE_TTL_MS', 'MAX_PENDING_CHALLENGES', 'COSE_ALG_ES256',
    'cborDecode', 'parseAuthenticatorData', 'coseToSpki', 'verifyEs256',
    'normalizeDerSignature', 'base64url', 'fromBase64url', 'sha256',
    'issueChallenge', 'consumeChallenge', 'clearChallengesForUser',
    'verifyRegistration', 'verifyAuthentication', 'publicReason',
  ];
  for (const name of required) {
    assert(W[name] !== undefined, `应导出 ${name}`);
  }
});

test('模块零第三方依赖（只用 Node 内置 crypto）', () => {
  const src = require('node:fs').readFileSync(
    path.join(require('./helpers').ROOT, 'server', 'webauthn.js'), 'utf8');
  const requires = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  const external = requires.filter((m) => !m.startsWith('node:') && m !== 'crypto');
  assertEqual(external.length, 0, '不应引入第三方依赖，发现：' + external.join(', '));
});
