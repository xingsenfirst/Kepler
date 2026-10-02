/**
 * 本地自签名证书 —— 管理界面 HTTPS 与 WebDAV 服务共用
 * 证书缓存于 data/local-cert.json，有效期约 820 天，过期自动重新生成。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const atomic = require('./atomic-write');

/**
 * R12-01（同源）：第 12 轮报告的枚举命令只点了 `config-store.js` 一处硬编码，
 * 实际还有本文件 —— 同样会在测试 / 多实例场景下读写**生产** `data/local-cert.json`
 * （过期时还会就地重新签发并写回）。与其它 store 统一走 `COS_DATA_DIR` 隔离开关。
 */
const DATA_DIR = process.env.COS_DATA_DIR ? path.resolve(process.env.COS_DATA_DIR) : path.join(__dirname, '..', 'data');
const CERT_FILE = path.join(DATA_DIR, 'local-cert.json');

/**
 * R28-04：缓存证书是否仍是**弱签名**（SHA-1 / MD5）。
 *
 * R27-19 只改了**新签发**的参数（`algorithm: 'sha256'`），而本函数在证书未过期时
 * （有效期 820 天）会直接返回缓存 —— 于是存量 SHA-1 证书最长还会被继续使用约 2 年 3 个月，
 * 期间受 SHA-1 影响的客户端依旧拒连，而这正是 R27-19 想解决的问题。
 * 这里在读取路径上补一道判据：弱签名一律重新签发。
 *
 * ⚠️ 修正（第 28 轮复核）：**不得**用 `crypto.X509Certificate#signatureAlgorithm` 判断 ——
 * Node 18 / 20 / 22 **都没有这个属性**（`toLegacyObject()` 里也没有），取到的恒是
 * `undefined`，`String(undefined || '')` 得到 `''`，于是判据对**任何**能解析的证书都返回
 * `false`：重签分支永远不可达，等于没修（护栏也会因此写假）。
 * 改为自己读 DER 外层 `signatureAlgorithm` 里的算法 OID：
 *
 *   Certificate ::= SEQUENCE {
 *     tbsCertificate       TBSCertificate,       -- SEQUENCE
 *     signatureAlgorithm   AlgorithmIdentifier,  -- SEQUENCE { algorithm OID, parameters }
 *     signatureValue       BIT STRING }
 *
 * 解析不了（结构异常、`X509Certificate` 不可用的老 Node）时返回 `true`：宁可多签一次。
 */
const WEAK_SIGNATURE_OIDS = new Set([
  '1.2.840.113549.1.1.2', // md2WithRSAEncryption
  '1.2.840.113549.1.1.3', // md4WithRSAEncryption
  '1.2.840.113549.1.1.4', // md5WithRSAEncryption
  '1.2.840.113549.1.1.5', // sha1WithRSAEncryption
  '1.2.840.10040.4.3',    // dsa-with-sha1
  '1.2.840.10045.4.1',    // ecdsa-with-SHA1
  '1.3.14.3.2.26',        // id-sha1
  '1.3.14.3.2.29',        // sha1WithRSA（与 1.1.5 并存的另一处登记）
]);

/**
 * 读一个 DER 元素的头，返回 `{ tag, len, headerLen, contentOff }`。
 * 越界、长度不合法或使用不定长形式（0x80）时返回 `null`（一律按「解析不了」处理）。
 */
function derElement(buf, off) {
  if (off + 2 > buf.length) return null;
  const tag = buf[off];
  let len = buf[off + 1];
  let headerLen = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4 || off + 2 + n > buf.length) return null;
    len = 0;
    for (let i = 0; i < n; i += 1) len = len * 256 + buf[off + 2 + i];
    headerLen = 2 + n;
  }
  const contentOff = off + headerLen;
  if (contentOff + len > buf.length) return null;
  return { tag, len, headerLen, contentOff };
}

/** DER 编码的 OID → 点分字符串（如 `1.2.840.113549.1.1.5`）。 */
function decodeOid(bytes) {
  if (!bytes.length) return '';
  const parts = [Math.floor(bytes[0] / 40), bytes[0] % 40];
  let acc = 0;
  for (let i = 1; i < bytes.length; i += 1) {
    acc = acc * 128 + (bytes[i] & 0x7f);
    if (!(bytes[i] & 0x80)) { parts.push(acc); acc = 0; }
  }
  return parts.join('.');
}

/** 取证书 DER 里**外层** `signatureAlgorithm` 的 OID；结构不符返回 `''`。 */
function signatureOidOf(der) {
  const cert = derElement(der, 0);                        // Certificate SEQUENCE
  if (!cert || cert.tag !== 0x30) return '';
  const tbs = derElement(der, cert.contentOff);           // tbsCertificate
  if (!tbs || tbs.tag !== 0x30) return '';
  const alg = derElement(der, tbs.contentOff + tbs.len);  // signatureAlgorithm
  if (!alg || alg.tag !== 0x30) return '';
  const oid = derElement(der, alg.contentOff);            // AlgorithmIdentifier 首元素即 OID
  if (!oid || oid.tag !== 0x06) return '';
  return decodeOid(der.subarray(oid.contentOff, oid.contentOff + oid.len));
}

function isWeakSignature(certPem) {
  try {
    const oid = signatureOidOf(new crypto.X509Certificate(certPem).raw);
    return !oid || WEAK_SIGNATURE_OIDS.has(oid);
  } catch (e) {
    return true;
  }
}

function getSelfSignedCert() {
  try {
    if (fs.existsSync(CERT_FILE)) {
      const c = JSON.parse(fs.readFileSync(CERT_FILE, 'utf8'));
      // R28-04：权限自愈（存量 0644 的私钥文件不会被 R27-13 创建路径覆盖）
      if (atomic.ensurePrivateModeSync(CERT_FILE)) {
        console.warn('[local-cert] 检测到 data/local-cert.json 权限过宽，已收紧为 0600');
      }
      const fresh = Date.now() - (c.createdAt || 0) < 820 * 86400 * 1000;
      if (c.key && c.cert && fresh && !isWeakSignature(c.cert)) return c;
      if (c.key && c.cert && fresh && isWeakSignature(c.cert)) {
        console.warn('[local-cert] 缓存的证书为弱签名（SHA-1），已重新签发为 SHA-256');
      }
    }
  } catch (e) { /* 重新生成 */ }
  const selfsigned = require('selfsigned');
  const pems = selfsigned.generate([{ name: 'commonName', value: 'localhost' }], {
    days: 825, keySize: 2048,
    /**
     * R27-19：必须显式指定摘要算法。`selfsigned@2.4.1` 未传 `algorithm` 时默认
     * **SHA-1**（实测 `signatureAlgorithm = sha1WithRsaEncryption`），而 SHA-1 已被
     * 主流浏览器/企业策略判为弱签名 —— 表现为自签名证书被拒或持续告警，
     * 回环 HTTPS 与 WebDAV 都可能因此不可用。
     */
    algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }] }],
  });
  const c = { key: pems.private, cert: pems.cert, createdAt: Date.now() };
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  /**
   * R27-13：以 0600 **创建**。旧实现是不带 mode 的 `writeFileSync` —— 文件先以
   * 默认权限（常见 0644）落地，再靠下一行 chmod 收紧，中间存在「同机他人可读私钥」
   * 的窗口；窗口内被强杀则 0644 永久保留。这里直接给目标权限，chmod 只作兜底。
   */
  fs.writeFileSync(CERT_FILE, JSON.stringify(c), { mode: 0o600 });
  // S9：与 secret.key 一致，收紧私钥文件权限（部分平台不支持时静默忽略）
  try { fs.chmodSync(CERT_FILE, 0o600); } catch (e) { /* ignore */ }
  return c;
}

module.exports = { getSelfSignedCert, isWeakSignature };
