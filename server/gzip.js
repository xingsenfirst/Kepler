/**
 * 轻量 gzip 响应压缩（P12）—— 零新增依赖
 *
 * 覆盖两类响应：
 *  1. `/api` 下的 JSON 文本响应：体积大、重复度高、压缩收益明显，且响应体可控；
 *  2. 静态前端资源（.html/.js/.css/.svg/.json 等）：文本类且体积可观
 *     （如 main.js 55KB、provider-logos.js 46KB、style.css），压缩后通常只剩 20%~30%。
 *
 * 刻意不压缩：文件下载 / 缩略图 / 已压缩类型（图片、zip、mp4 等），
 * 避免把流式大文件缓冲进内存（这也是 gzip 中间件最常见的性能陷阱）。
 *
 * 实现说明：采用「包裹 res.write/res.end + 末尾统一 gzip」的方式，
 * 对 express.static 这类直接 end 的处理器同样生效（不依赖 res.send 的 hook）。
 */
const zlib = require('zlib');

const MIN_SIZE = 1024; // 小于 1KB 不压缩（压缩收益低于开销）
const MAX_SIZE = 2 * 1024 * 1024; // 超过 2MB 不缓冲压缩

/** 明确跳过：流式下载 / 缩略图 / 分享下载 / 测速（体积大或本就流式） */
const SKIP_PATH = /\/fs\/download|\/fs\/thumb|\/s\/[^/]+\/dl|\/stats\/speed/;

/** 可压缩的内容类型（API 与静态资源通用） */
const COMPRESSIBLE_TYPE = /json|text|javascript|xml|svg|plain|x-www-form-urlencoded|manifest/i;

/**
 * 静态资源的可压缩扩展名白名单。
 * 只认这些扩展名，避免把 .png/.woff2/.mp4 等已压缩二进制拖进内存。
 */
const STATIC_EXT = new Set([
  '.html', '.htm', '.js', '.mjs', '.css', '.json',
  '.svg', '.txt', '.xml', '.webmanifest', '.map',
]);

/** 判断本次请求是否值得进入压缩流程 */
function shouldCompress(req, res) {
  const ae = String(req.headers['accept-encoding'] || '');
  if (!/\bgzip\b/.test(ae)) return false;

  const path = String(req.path || '');
  if (SKIP_PATH.test(path)) return false;

  // API：路径以 /api 开头即可（后续再按 Content-Type 二次判定）
  if (path.startsWith('/api')) return true;

  // 静态资源：按扩展名白名单判定，避免把二进制资源缓冲进内存
  const ext = path.includes('.') ? path.slice(path.lastIndexOf('.')).toLowerCase() : '';
  return STATIC_EXT.has(ext);
}

function gzipMiddleware(req, res, next) {
  if (!shouldCompress(req, res)) return next();

  // PERF-08：无条件声明 Vary。
  // 是否压缩取决于请求头 Accept-Encoding，若不声明 Vary，中间缓存会把
  // 「给 A 的压缩响应」发给「不要 gzip 的 B」，造成跨用户串味。
  // 旧实现只在压缩分支设置了 Vary —— 恰好覆盖了更容易出错的不压缩分支。
  try { res.setHeader('Vary', 'Accept-Encoding'); } catch (e) { /* headersSent 时忽略 */ }

  let chunks = [];
  let buffered = 0;
  let passthrough = false; // 已判定为「不压缩」：后续数据直接透传，不再进内存
  const origWrite = res.write;
  const origEnd = res.end;
  let restored = false;

  const restore = () => {
    if (restored) return;
    restored = true;
    res.write = origWrite;
    res.end = origEnd;
  };

  // 把 chunk 写入缓冲区；一旦累计超过 MAX_SIZE 立即切成透传并释放已缓冲内存。
  // 写入 flush 到 origWrite 时如实返回其布尔值，使背压信号不再丢失。
  function writeBuf(chunk, enc) {
    if (!chunk) return true;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, enc || 'utf8');
    if (passthrough) return origWrite.call(res, buf);
    chunks.push(buf);
    buffered += buf.length;
    if (buffered > MAX_SIZE) {
      const joined = Buffer.concat(chunks);
      chunks = [];
      passthrough = true;
      origWrite.call(res, joined);
    }
    return true; // 缓冲模式下数据已被我们接收，背压由后续的透传 write 如实体现
  }

  res.write = function write(chunk, enc, cb) { return writeBuf(chunk, enc); };

  res.end = function end(chunk, enc, cb) {
    if (chunk) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, enc || 'utf8');
      if (passthrough) { restore(); return origEnd.call(res, buf, enc, cb); }
      chunks.push(buf);
      buffered += buf.length;
    }
    restore();

    if (passthrough) return origEnd.call(res, undefined, enc, cb);

    const data = chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0);
    chunks = [];
    const type = String(res.getHeader('Content-Type') || '');
    const already = res.getHeader('Content-Encoding');
    // 二次校验：Content-Type 必须可压缩（例如 /api 下返回二进制附件时不压缩）
    const compressible = COMPRESSIBLE_TYPE.test(type) || (!type && data.length > 0);
    if (!compressible || already || data.length < MIN_SIZE || data.length > MAX_SIZE) {
      if (data.length) origWrite.call(res, data);
      return origEnd.call(res, undefined, enc, cb);
    }
    zlib.gzip(data, { level: 6 }, (err, out) => {
      if (err) {
        if (data.length) origWrite.call(res, data);
        return origEnd.call(res, undefined, enc, cb);
      }
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Content-Length', String(out.length));
      origWrite.call(res, out);
      return origEnd.call(res, undefined, enc, cb);
    });
  };

  return next();
}

module.exports = { gzipMiddleware, shouldCompress, STATIC_EXT, SKIP_PATH };
