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

  /**
   * R27-26：`req.path` 必须**小写化**后再比对。
   *
   * Express 的默认路由匹配是**大小写不敏感**的：`GET /api/fs/DOWNLOAD` 会命中同一个
   * 下载处理器，而 `SKIP_PATH` 的字面量全是小写 —— 旧实现因此被一个字母大小写绕过，
   * 把本模块文档写明「绝不缓冲」的流式下载纳入压缩流程（实测
   * `shouldCompress('/api/fs/DOWNLOAD') === true`，而同一个小写路径为 false）。
   */
  const path = String(req.path || '').toLowerCase();
  if (SKIP_PATH.test(path)) return false;

  /**
   * R28-03：**带 `Range` 的请求一律不压缩**（并因此不缓冲）。
   *
   * 这里必须看**请求头**，不能看 `res.statusCode`：本函数在路由之前执行，此刻状态码
   * 还是默认的 200 —— R27-26 写的 `if (res.statusCode === 206) return false` 在真实
   * 请求路径上**永远不成立**（是死代码，只有单测里喂合成的 `{statusCode:206}` 才会命中，
   * 于是「缺陷仍在 + 护栏全绿」同时成立）。而 `Range` 是请求方在**进入路由之前**就已
   * 送到的信息：它意味着响应可能是 206，此时再套一层 gzip 会让 `Content-Range`
   * （按未压缩实体描述）与 `Content-Encoding` 的实体长度互相打架 —— 实测
   * `206 + gzip` 回的是 `CL=29 / CR=bytes 0-1023/5000`，不解释内容编码、或按区间
   * 拼接的续传客户端会拿到损坏的文件。压缩收益在续传场景本就不值得冒这个风险。
   *
   * 纵深防御：`end()` 阶段还会再判一次真实状态码与 `Content-Range`（见下），
   * 覆盖「没有 Range 头、但处理器自己回了 206」的少数情况。
   */
  if (req.headers && req.headers.range) return false;

  // API：路径以 /api 开头即可（后续再按 Content-Type 二次判定）
  if (path.startsWith('/api')) return true;

  // 静态资源：按扩展名白名单判定，避免把二进制资源缓冲进内存
  const ext = path.includes('.') ? path.slice(path.lastIndexOf('.')) : '';
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
    /**
     * R28-03 纵深防御：**区间响应一律不压缩**。
     *
     * 这里是真正能看到最终状态的位置（`shouldCompress` 在路由之前执行，那里读到的
     * `res.statusCode` 还是默认的 200）。`Content-Range` 一并判，因为 206 必然带它、
     * 而个别处理器可能只设其一。
     */
    const ranged = Number(res.statusCode) === 206 || Boolean(res.getHeader('Content-Range'));
    // 二次校验：Content-Type 必须可压缩（例如 /api 下返回二进制附件时不压缩）
    const compressible = COMPRESSIBLE_TYPE.test(type) || (!type && data.length > 0);
    if (!compressible || already || ranged || data.length < MIN_SIZE || data.length > MAX_SIZE) {
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
