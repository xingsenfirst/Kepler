/**
 * 本地自签名证书 —— 管理界面 HTTPS 与 WebDAV 服务共用
 * 证书缓存于 data/local-cert.json，有效期约 820 天，过期自动重新生成。
 */
const fs = require('fs');
const path = require('path');

/**
 * R12-01（同源）：第 12 轮报告的枚举命令只点了 `config-store.js` 一处硬编码，
 * 实际还有本文件 —— 同样会在测试 / 多实例场景下读写**生产** `data/local-cert.json`
 * （过期时还会就地重新签发并写回）。与其它 store 统一走 `COS_DATA_DIR` 隔离开关。
 */
const DATA_DIR = process.env.COS_DATA_DIR ? path.resolve(process.env.COS_DATA_DIR) : path.join(__dirname, '..', 'data');
const CERT_FILE = path.join(DATA_DIR, 'local-cert.json');

function getSelfSignedCert() {
  try {
    if (fs.existsSync(CERT_FILE)) {
      const c = JSON.parse(fs.readFileSync(CERT_FILE, 'utf8'));
      if (c.key && c.cert && Date.now() - (c.createdAt || 0) < 820 * 86400 * 1000) return c;
    }
  } catch (e) { /* 重新生成 */ }
  const selfsigned = require('selfsigned');
  const pems = selfsigned.generate([{ name: 'commonName', value: 'localhost' }], {
    days: 825, keySize: 2048,
    extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }] }],
  });
  const c = { key: pems.private, cert: pems.cert, createdAt: Date.now() };
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CERT_FILE, JSON.stringify(c));
  // S9：与 secret.key 一致，收紧私钥文件权限（部分平台不支持时静默忽略）
  try { fs.chmodSync(CERT_FILE, 0o600); } catch (e) { /* ignore */ }
  return c;
}

module.exports = { getSelfSignedCert };
