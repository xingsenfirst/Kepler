/**
 * WebAuthn（Windows Hello）服务端校验 —— 零依赖实现
 *
 * 只做本系统需要的最小子集：**ES256（ECDSA P-256 + SHA-256）** 的注册与认证。
 * 签名校验完全依赖 Node 内置 `crypto`（`crypto.createPublicKey` 支持 SPKI DER，
 * `crypto.verify` 支持 ES256），因此**不引入任何第三方依赖**。
 *
 * 安全要点：
 *  - 挑战（challenge）由服务端生成、服务端保存、一次性消费，绝不信任前端回传值；
 *  - 校验 `clientDataJSON.type` / `challenge` / `origin` 三要素，防重放与跨站中继；
 *  - 校验 `rpIdHash` 与 rpId 的 SHA-256 一致，防跨 RP 凭据挪用；
 *  - 校验 authenticatorData 的 UP（用户在场）与 UV（用户验证，即 Windows Hello 的生物/PIN）；
 *  - 维护 signCount 单调递增，检测凭据克隆（克隆时计数回退，直接拒绝）；
 *  - 公钥解析固定为 ES256/P-256 曲线，拒绝其他算法（算法混淆攻击面收敛）。
 *
 * 参考：W3C Web Authentication Level 2 §6.1（注册）与 §6.2（认证）。
 */
const crypto = require('crypto');

/* ============================ 常量 ============================ */

const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 挑战有效期 5 分钟
const MAX_PENDING_CHALLENGES = 2000;    // 待校验挑战上限，防止内存堆积
const COSE_ALG_ES256 = -7;              // COSE 算法标识：ES256
const COSE_KTY_EC2 = 2;                 // COSE 密钥类型：EC2

/* ============================ CBOR 解码 ============================ */

/**
 * 最小 CBOR 解码器 —— 仅覆盖 WebAuthn 实际用到的类型。
 *
 * WebAuthn 的 `attestationObject` 与 `credentialPublicKey` 均为 CBOR 编码。
 * 这里实现 RFC 8949 的确定性子集：
 *   0 无符号整数 / 1 负整数 / 2 字节串 / 3 文本串 / 4 数组 / 5 映射 / 7 简单值(布尔/null)
 *
 * 不支持的 major type（标签、浮点、不定长）一律抛错 —— 宁可拒绝也不误判，
 * 避免解码歧义带来的解析漏洞（例如同一字节串被两种方式解读）。
 *
 * @param {Buffer} buf
 * @returns {{value:any, offset:number}} 解码结果与结束偏移
 */
function cborDecode(buf) {
  let pos = 0;

  function readLength(info, extraLen) {
    if (info < 24) return info;
    if (info === 24) {
      if (pos >= buf.length) throw new Error('CBOR_UNEXPECTED_EOF');
      return buf[pos++];
    }
    if (info === 25) {
      if (pos + 2 > buf.length) throw new Error('CBOR_UNEXPECTED_EOF');
      const v = buf.readUInt16BE(pos); pos += 2; return v;
    }
    if (info === 26) {
      if (pos + 4 > buf.length) throw new Error('CBOR_UNEXPECTED_EOF');
      const v = buf.readUInt32BE(pos); pos += 4; return v;
    }
    throw new Error('CBOR_UNSUPPORTED_LENGTH');
  }

  function decodeItem() {
    if (pos >= buf.length) throw new Error('CBOR_UNEXPECTED_EOF');
    const initial = buf[pos++];
    const major = initial >> 5;
    const info = initial & 0x1f;

    switch (major) {
      case 0: // 无符号整数
        return readLength(info);
      case 1: { // 负整数
        const n = readLength(info);
        return -1 - n;
      }
      case 2: { // 字节串
        if (info === 31) throw new Error('CBOR_INDEFINITE_NOT_SUPPORTED');
        const len = readLength(info);
        if (pos + len > buf.length) throw new Error('CBOR_TRUNCATED_BYTES');
        const out = buf.subarray(pos, pos + len);
        pos += len;
        return out;
      }
      case 3: { // 文本串
        if (info === 31) throw new Error('CBOR_INDEFINITE_NOT_SUPPORTED');
        const len = readLength(info);
        if (pos + len > buf.length) throw new Error('CBOR_TRUNCATED_TEXT');
        const out = buf.subarray(pos, pos + len).toString('utf8');
        pos += len;
        return out;
      }
      case 4: { // 数组
        if (info === 31) throw new Error('CBOR_INDEFINITE_NOT_SUPPORTED');
        const len = readLength(info);
        const arr = [];
        for (let i = 0; i < len; i++) arr.push(decodeItem());
        return arr;
      }
      case 5: { // 映射
        if (info === 31) throw new Error('CBOR_INDEFINITE_NOT_SUPPORTED');
        const len = readLength(info);
        const map = new Map();
        for (let i = 0; i < len; i++) {
          const k = decodeItem();
          const v = decodeItem();
          map.set(k, v);
        }
        return map;
      }
      case 7: // 简单值：false/true/null（UTF-8 与未定义值不支持）
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        throw new Error('CBOR_UNSUPPORTED_SIMPLE_VALUE');
      default:
        throw new Error('CBOR_UNSUPPORTED_MAJOR_TYPE_' + major);
    }
  }

  const value = decodeItem();
  return { value, offset: pos };
}

/* ============================ 认证器数据解析 ============================ */

/**
 * 解析 `authenticatorData`（WebAuthn §6.1）。
 *
 * 布局：
 *   rpIdHash       32 bytes   RP ID 的 SHA-256
 *   flags           1 byte    bit0=UP 用户在场 / bit2=UV 用户验证 / bit6=AT 含 attestedCredentialData
 *   signCount       4 bytes   大端无符号
 *   attestedCredentialData（仅注册、且 AT=1 时存在）
 *     aaguid        16 bytes
 *     credIdLen      2 bytes  大端
 *     credId        n bytes
 *     publicKey     CBOR 编码的 COSE 公钥
 *   extensions（本系统不使用，忽略）
 */
function parseAuthenticatorData(authData) {
  if (!Buffer.isBuffer(authData) || authData.length < 37) {
    throw new Error('AUTH_DATA_TOO_SHORT');
  }
  const rpIdHash = authData.subarray(0, 32);
  const flags = authData[32];
  const signCount = authData.readUInt32BE(33);
  const at = (flags & 0x40) !== 0;
  const uv = (flags & 0x04) !== 0;
  const up = (flags & 0x01) !== 0;

  const out = { rpIdHash, flags, signCount, userPresent: up, userVerified: uv, hasAttestedData: at };

  if (at) {
    if (authData.length < 55) throw new Error('AUTH_DATA_CREDENTIAL_TRUNCATED');
    const aaguid = authData.subarray(37, 53);
    const credIdLen = authData.readUInt16BE(53);
    const credIdStart = 55;
    const credIdEnd = credIdStart + credIdLen;
    if (authData.length < credIdEnd) throw new Error('AUTH_DATA_CRED_ID_TRUNCATED');
    const credentialId = authData.subarray(credIdStart, credIdEnd);
    // 公钥为 CBOR，需解码以确定其结束位置（剩余部分为扩展）
    const { value: coseKey, offset } = cborDecode(authData.subarray(credIdEnd));
    out.aaguid = aaguid;
    out.credentialId = credentialId;
    out.cosePublicKey = coseKey;
    out.publicKeyEnd = credIdEnd + offset;
  }
  return out;
}

/* ============================ COSE 公钥 → SPKI DER ============================ */

/** DER 编码：SEQUENCE 包裹若干项 */
function derSequence(...parts) {
  return derTagged(0x30, Buffer.concat(parts));
}

/**
 * DER 编码：单个 TLV。
 * 长度 <128 用短形式；≥128 用长形式（最高位标记后续长度字节数）。
 */
function derTagged(tag, content) {
  const len = content.length;
  let lenBuf;
  if (len < 0x80) {
    lenBuf = Buffer.from([len]);
  } else {
    const bytes = [];
    let n = len;
    while (n > 0) { bytes.unshift(n & 0xff); n >>>= 8; }
    lenBuf = Buffer.from([0x80 | bytes.length, ...bytes]);
  }
  return Buffer.concat([Buffer.from([tag]), lenBuf, content]);
}

/**
 * 把 COSE EC2 公钥（ES256/P-256）转成 SPKI DER，供 `crypto.createPublicKey` 使用。
 *
 * SPKI 结构：
 *   SEQUENCE {
 *     SEQUENCE { OID 1.2.840.10045.2.1 (ecPublicKey), OID 1.2.840.10045.3.1.7 (prime256v1) }
 *     BIT STRING { 0x00 未使用位 || 0x04 || X(32) || Y(32) }
 *   }
 *
 * 只接受 alg=ES256、kty=EC2、crv=P-256、x/y 各 32 字节；其余一律拒绝。
 */
function coseToSpki(coseKey) {
  if (!(coseKey instanceof Map)) throw new Error('PUBLIC_KEY_NOT_MAP');
  const kty = coseKey.get(1);
  const alg = coseKey.get(3);
  const crv = coseKey.get(-1);
  const x = coseKey.get(-2);
  const y = coseKey.get(-3);

  if (kty !== COSE_KTY_EC2) throw new Error('PUBLIC_KEY_NOT_EC2');
  if (alg !== COSE_ALG_ES256) throw new Error('PUBLIC_KEY_ALG_NOT_ES256');
  if (crv !== 1) throw new Error('PUBLIC_KEY_CRV_NOT_P256'); // 1 = P-256
  if (!Buffer.isBuffer(x) || !Buffer.isBuffer(y) || x.length !== 32 || y.length !== 32) {
    throw new Error('PUBLIC_KEY_COORD_INVALID');
  }

  // 未压缩点格式：0x04 || X || Y
  const point = Buffer.concat([Buffer.from([0x04]), x, y]);
  const bitString = derTagged(0x03, Buffer.concat([Buffer.from([0x00]), point]));

  const oidEcPublicKey = Buffer.from([0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01]);
  const oidPrime256v1 = Buffer.from([0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07]);
  const algorithmId = derSequence(oidEcPublicKey, oidPrime256v1);
  return derSequence(algorithmId, bitString);
}

/* ============================ 签名校验 ============================ */

/** 把 WebAuthn 的 ASN.1 DER 签名规范化为可读结构（仅用于长度校验与规范化） */
function normalizeDerSignature(sig) {
  if (!Buffer.isBuffer(sig) || sig.length < 8) throw new Error('SIGNATURE_TOO_SHORT');
  if (sig[0] !== 0x30) throw new Error('SIGNATURE_NOT_SEQUENCE');
  let pos = 2;
  if (sig[1] & 0x80) pos = 2 + (sig[1] & 0x7f); // 长形式长度
  if (sig[pos] !== 0x02) throw new Error('SIGNATURE_R_MISSING');
  const rLen = sig[pos + 1];
  const r = sig.subarray(pos + 2, pos + 2 + rLen);
  pos = pos + 2 + rLen;
  if (sig[pos] !== 0x02) throw new Error('SIGNATURE_S_MISSING');
  const sLen = sig[pos + 1];
  const s = sig.subarray(pos + 2, pos + 2 + sLen);
  return { r, s };
}

/** 整数按 ASN.1 DER INTEGER 的最简形式编码（高位为 1 时补 0x00，去掉多余前导 0） */
function derInteger(buf) {
  let i = 0;
  while (i < buf.length - 1 && buf[i] === 0x00 && (buf[i + 1] & 0x80) === 0) i++;
  let body = buf.subarray(i);
  if (body.length === 0) body = Buffer.from([0x00]);
  if (body[0] & 0x80) body = Buffer.concat([Buffer.from([0x00]), body]);
  return derTagged(0x02, body);
}

/**
 * 把签名统一转换成 DER 编码。
 *
 * WebAuthn/CTAP2 规定 ES256 的签名是 **ASN.1 DER**（Windows Hello 即如此），
 * 但个别认证器/实现会返回 IEEE-P1363 的裸 `r||s`（定长 64 字节）。
 * 这里两种都接受：64 字节视为裸格式并转 DER，其余按 DER 原样透传。
 * 只有真正畸形的签名才会在后续 `normalizeDerSignature` 中被拒。
 */
function toDerSignature(sig) {
  if (!Buffer.isBuffer(sig)) throw new Error('SIGNATURE_NOT_BUFFER');
  if (sig.length === 64) {
    const r = derInteger(sig.subarray(0, 32));
    const s = derInteger(sig.subarray(32, 64));
    return derSequence(r, s);
  }
  return sig;
}

/**
 * 校验 WebAuthn 签名（ES256 / SHA-256）。
 *
 * ⚠️ 血泪教训（2026-09-14）：**必须让 Node 对「原始被签名数据」做一次 SHA-256**。
 *
 * 旧实现先自己算好摘要、再调用 `crypto.verify(null, digest, key, sig)`，理由是
 * "传 null 表示不再摘要"。**这个理解是错的**：`algorithm` 为 `null` 时 Node/OpenSSL
 * 会退回到密钥的默认摘要（EC P-256 即 SHA-256），于是实际计算的是
 * `SHA256(SHA256(data))` —— 双重哈希，导致**注册成功但登录必然 `signature_invalid`**
 * （注册走 `attestation: 'none'`，不做验签，所以问题只在登录侧暴露）。
 *
 * 正确写法就是标准的 `ecdsa-with-SHA256`（即 ES256 的定义）：
 *     crypto.verify('sha256', signedData, key, signature)
 * 实证对比（P-256 + DER 签名）：
 *     verify(null,  digest,     key, sig) → false  ← 旧实现
 *     verify('sha256', signedData, key, sig) → true   ← 现在
 *
 * @param {Buffer} publicKeySpki SPKI DER 公钥
 * @param {Buffer} data         被签名的原始数据（authData || SHA-256(clientDataJSON)）
 * @param {Buffer} signature    ECDSA 签名（DER，或裸 r||s）
 * @returns {boolean}
 */
function verifyEs256(publicKeySpki, data, signature) {
  let key;
  try {
    key = crypto.createPublicKey({ key: publicKeySpki, format: 'der', type: 'spki' });
  } catch (e) {
    return false;
  }
  let der;
  try {
    der = toDerSignature(signature);
    // 提前做结构校验，避免把畸形签名交给 OpenSSL（部分版本会抛错而非返回 false）
    normalizeDerSignature(der);
  } catch (e) {
    return false;
  }
  try {
    return crypto.verify('sha256', data, key, der) === true;
  } catch (e) {
    return false;
  }
}

/* ============================ 挑战管理 ============================ */

/**
 * 待校验挑战池：key 为 challenge（base64url），value 为元信息。
 * 内存存储、一次性消费；服务重启后失效（用户重新发起即可，可接受）。
 */
const pending = new Map();

function prunePending() {
  const now = Date.now();
  for (const [k, v] of pending) if (v.expiresAt < now) pending.delete(k);
  // 兜底：超过上限时按创建时间淘汰最早的一半，防止异常流量撑爆内存
  if (pending.size > MAX_PENDING_CHALLENGES) {
    const entries = [...pending.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
    for (let i = 0; i < entries.length - MAX_PENDING_CHALLENGES / 2; i++) pending.delete(entries[i][0]);
  }
}

/**
 * 生成并登记一个挑战。
 * @param {string} purpose 'register' | 'login'
 * @param {object} meta    附加信息（如 { userId }）
 */
function issueChallenge(purpose, meta) {
  prunePending();
  const challenge = base64url(crypto.randomBytes(32));
  pending.set(challenge, Object.assign({ purpose, createdAt: Date.now(), expiresAt: Date.now() + CHALLENGE_TTL_MS }, meta || {}));
  return challenge;
}

/**
 * 消费一个挑战（一次性）。
 * 校验存在性、用途、时效与**归属用户**；无论成功与否都会删除，防止重放与暴力试探。
 *
 * SEC-11：挑战必须与请求用户绑定。
 * `issueChallenge('login', { userId })` 写入了 userId，但调用方原先只校验 purpose、
 * 从不比对 `meta.userId` 与目标账户 —— 经推演这不构成认证绕过（公钥取自目标账户记录），
 * 却是一处纵深防御缺口：一旦将来支持多凭据或共享凭据表，该缺口会立即变成实际漏洞。
 *
 * @param {string} challenge
 * @param {string} purpose 'register' | 'login'
 * @param {string} [expectedUserId] 期望的归属用户 id；提供时必须与 meta.userId 一致
 * @returns {{ok:true, meta:object} | {ok:false, reason:string}}
 */
function consumeChallenge(challenge, purpose, expectedUserId) {
  const c = String(challenge || '');
  if (!c) return { ok: false, reason: 'challenge_missing' };
  const entry = pending.get(c);
  if (!entry) return { ok: false, reason: 'challenge_unknown' };
  pending.delete(c); // 一次性：先删后判，杜绝重放
  if (entry.expiresAt < Date.now()) return { ok: false, reason: 'challenge_expired' };
  if (entry.purpose !== purpose) return { ok: false, reason: 'challenge_purpose_mismatch' };
  if (expectedUserId !== undefined && expectedUserId !== null
      && String(entry.userId || '') !== String(expectedUserId)) {
    return { ok: false, reason: 'challenge_user_mismatch' };
  }
  return { ok: true, meta: entry };
}

/** 清理某用户的全部待校验挑战（删除凭据 / 关闭该功能时调用） */
function clearChallengesForUser(userId) {
  for (const [k, v] of pending) if (String(v.userId) === String(userId)) pending.delete(k);
}

/* ============================ 基础编解码 ============================ */

function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(str) {
  const s = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(s, 'base64');
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest();
}

/* ============================ 注册验证 ============================ */

/**
 * 校验收到的注册响应（`navigator.credentials.create` 的结果）。
 *
 * 前端需回传（均 base64url）：
 *   clientDataJSON / attestationObject / rawId
 *
 * @param {object} args
 * @param {string} args.clientDataJSON      base64url
 * @param {string} args.attestationObject   base64url
 * @param {string} args.rawId               base64url（凭据 ID，需与 authData 内一致）
 * @param {string} args.expectedChallenge   服务端已签发、待消费的挑战
 * @param {string} args.expectedOrigin      期望来源（如 http://127.0.0.1:3000）
 * @param {string} args.rpId                依赖方 ID（如 127.0.0.1）
 * @returns {{ok:true, credentialId:string, publicKey:string, signCount:number, aaguid:string, fmt:string}}
 *          或 {ok:false, reason:string}
 */
function verifyRegistration({ clientDataJSON, attestationObject, rawId, expectedChallenge, expectedOrigin, rpId }) {
  const consumed = consumeChallenge(expectedChallenge, 'register');
  if (!consumed.ok) return { ok: false, reason: consumed.reason };

  let clientData, attObj;
  try { clientData = JSON.parse(fromBase64url(clientDataJSON).toString('utf8')); }
  catch (e) { return { ok: false, reason: 'client_data_invalid' }; }
  if (!clientData || typeof clientData !== 'object') return { ok: false, reason: 'client_data_invalid' };

  if (clientData.type !== 'webauthn.create') return { ok: false, reason: 'client_data_type_invalid' };
  if (clientData.challenge !== expectedChallenge) return { ok: false, reason: 'client_data_challenge_mismatch' };
  if (expectedOrigin && clientData.origin !== expectedOrigin) return { ok: false, reason: 'client_data_origin_mismatch' };

  try { attObj = cborDecode(fromBase64url(attestationObject)).value; }
  catch (e) { return { ok: false, reason: 'attestation_object_invalid' }; }
  if (!(attObj instanceof Map)) return { ok: false, reason: 'attestation_object_invalid' };

  const authData = attObj.get('authData');
  if (!Buffer.isBuffer(authData)) return { ok: false, reason: 'auth_data_missing' };

  let parsed;
  try { parsed = parseAuthenticatorData(authData); }
  catch (e) { return { ok: false, reason: 'auth_data_invalid' }; }

  // RP ID 校验：authData.rpIdHash 必须等于 SHA-256(rpId)
  if (!parsed.rpIdHash.equals(sha256(Buffer.from(rpId, 'utf8')))) {
    return { ok: false, reason: 'rp_id_mismatch' };
  }
  if (!parsed.userPresent) return { ok: false, reason: 'user_not_present' };
  // Windows Hello 一定会做用户验证（生物识别或 PIN）；要求 UV 可显著提升安全性
  if (!parsed.userVerified) return { ok: false, reason: 'user_not_verified' };
  if (!parsed.hasAttestedData || !parsed.credentialId) return { ok: false, reason: 'attested_credential_missing' };

  // rawId 必须与 authData 中的 credentialId 一致，防止张冠李戴
  const rawIdBuf = fromBase64url(rawId);
  if (!rawIdBuf.length || !rawIdBuf.equals(parsed.credentialId)) {
    return { ok: false, reason: 'credential_id_mismatch' };
  }

  let spki;
  try { spki = coseToSpki(parsed.cosePublicKey); }
  catch (e) { return { ok: false, reason: 'public_key_unsupported' }; }

  return {
    ok: true,
    credentialId: base64url(parsed.credentialId),
    publicKey: spki.toString('base64'),
    signCount: parsed.signCount >>> 0,
    aaguid: Buffer.from(parsed.aaguid).toString('hex'),
    fmt: String(attObj.get('fmt') || 'none'),
  };
}

/* ============================ 认证验证 ============================ */

/**
 * 校验登录时的认证断言（`navigator.credentials.get` 的结果）。
 *
 * 前端需回传（均 base64url）：
 *   clientDataJSON / authenticatorData / signature / rawId
 *
 * 签名数据为 `authenticatorData || SHA-256(clientDataJSON)`（WebAuthn §6.2.3）。
 *
 * @param {object} args
 * @param {string} args.clientDataJSON
 * @param {string} args.authenticatorData
 * @param {string} args.signature
 * @param {string} args.rawId
 * @param {string} args.expectedChallenge
 * @param {string} args.expectedOrigin
 * @param {string} args.rpId
 * @param {string} args.publicKey       注册时保存的 SPKI 公钥（base64）
 * @param {string} args.storedCredentialId 注册时保存的凭据 ID（base64url）
 * @param {number} args.storedSignCount 注册时保存的签名计数
 * @returns {{ok:true, signCount:number} | {ok:false, reason:string}}
 */
function verifyAuthentication({
  clientDataJSON, authenticatorData, signature, rawId,
  expectedChallenge, expectedOrigin, rpId, expectedUserId,
  publicKey, storedCredentialId, storedSignCount,
}) {
  const consumed = consumeChallenge(expectedChallenge, 'login', expectedUserId);
  if (!consumed.ok) return { ok: false, reason: consumed.reason };

  let clientData;
  try { clientData = JSON.parse(fromBase64url(clientDataJSON).toString('utf8')); }
  catch (e) { return { ok: false, reason: 'client_data_invalid' }; }
  if (!clientData || typeof clientData !== 'object') return { ok: false, reason: 'client_data_invalid' };

  if (clientData.type !== 'webauthn.get') return { ok: false, reason: 'client_data_type_invalid' };
  if (clientData.challenge !== expectedChallenge) return { ok: false, reason: 'client_data_challenge_mismatch' };
  if (expectedOrigin && clientData.origin !== expectedOrigin) return { ok: false, reason: 'client_data_origin_mismatch' };

  const authDataBuf = fromBase64url(authenticatorData);
  const clientDataBuf = fromBase64url(clientDataJSON);
  let parsed;
  try { parsed = parseAuthenticatorData(authDataBuf); }
  catch (e) { return { ok: false, reason: 'auth_data_invalid' }; }

  if (!parsed.rpIdHash.equals(sha256(Buffer.from(rpId, 'utf8')))) {
    return { ok: false, reason: 'rp_id_mismatch' };
  }
  if (!parsed.userPresent) return { ok: false, reason: 'user_not_present' };
  if (!parsed.userVerified) return { ok: false, reason: 'user_not_verified' };

  // 凭据 ID 必须与登记的一致（浏览器可能同时持有多个凭据）
  const rawIdBuf = fromBase64url(rawId);
  if (storedCredentialId && !rawIdBuf.equals(fromBase64url(storedCredentialId))) {
    return { ok: false, reason: 'credential_id_mismatch' };
  }

  // 签名计数回退 = 可能被克隆，直接拒绝（WebAuthn §6.2.4）
  const prev = Number(storedSignCount) || 0;
  const next = parsed.signCount >>> 0;
  if (prev > 0 && next > 0 && next <= prev) return { ok: false, reason: 'sign_count_regression' };

  // 被签名数据：authData || SHA-256(clientDataJSON)
  const signedData = Buffer.concat([authDataBuf, sha256(clientDataBuf)]);

  let spki;
  try { spki = Buffer.from(String(publicKey || ''), 'base64'); }
  catch (e) { return { ok: false, reason: 'stored_public_key_invalid' }; }
  if (!spki.length) return { ok: false, reason: 'stored_public_key_invalid' };

  if (!verifyEs256(spki, signedData, fromBase64url(signature))) {
    return { ok: false, reason: 'signature_invalid' };
  }
  return { ok: true, signCount: next };
}

/* ============================ 面向用户的文案 ============================ */

/** 内部原因码 → 可读文案（不泄露实现细节，但保留排障所需的区分度） */
function publicReason(reason) {
  const r = String(reason || '');
  const map = {
    challenge_missing: 'Windows Hello 验证信息缺失，请重试',
    challenge_unknown: 'Windows Hello 验证请求已失效，请重新登录',
    challenge_expired: 'Windows Hello 验证超时，请重新登录',
    challenge_purpose_mismatch: 'Windows Hello 验证用途不匹配，请重新登录',
  challenge_user_mismatch: 'Windows Hello 挑战与目标账户不匹配，请重新发起登录',
    client_data_invalid: 'Windows Hello 返回数据无效',
    client_data_type_invalid: 'Windows Hello 返回类型不正确',
    client_data_challenge_mismatch: 'Windows Hello 挑战值不匹配，请重试',
    client_data_origin_mismatch: '访问来源与预期不符，Windows Hello 验证已拒绝',
    attestation_object_invalid: 'Windows Hello 注册数据无效',
    auth_data_missing: 'Windows Hello 认证数据缺失',
    auth_data_invalid: 'Windows Hello 认证数据无效',
    rp_id_mismatch: 'Windows Hello 验证域名不匹配，请通过本机地址访问',
    user_not_present: 'Windows Hello 未检测到用户在场',
    user_not_verified: 'Windows Hello 未完成用户验证（请使用指纹、面容或 PIN）',
    attested_credential_missing: 'Windows Hello 未返回凭据信息',
    credential_id_mismatch: 'Windows Hello 凭据不匹配，请重新登录',
    public_key_unsupported: '该 Windows Hello 凭据算法不受支持（仅支持 ES256）',
    stored_public_key_invalid: '本地保存的 Windows Hello 公钥无效，请重新启用该功能',
    signature_invalid: 'Windows Hello 签名校验失败，登录已拒绝',
    sign_count_regression: 'Windows Hello 凭据计数异常（可能被复制），已拒绝登录',
    not_enabled: '该账户未启用 Windows Hello',
    not_registered: '该账户尚未完成 Windows Hello 注册',
  };
  return map[r] || 'Windows Hello 验证未通过，请重试';
}

module.exports = {
  CHALLENGE_TTL_MS,
  MAX_PENDING_CHALLENGES,
  COSE_ALG_ES256,
  // 底层能力（供测试与高级调用）
  cborDecode,
  parseAuthenticatorData,
  coseToSpki,
  verifyEs256,
  normalizeDerSignature,
  base64url,
  fromBase64url,
  sha256,
  // 挑战
  issueChallenge,
  consumeChallenge,
  clearChallengesForUser,
  // 业务校验
  verifyRegistration,
  verifyAuthentication,
  publicReason,
  _pending: pending, // 仅供测试检视
};
