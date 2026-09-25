/**
 * 统一下载流转发 —— /fs/download 与分享下载共用
 * 封装响应头设置、对象存储流管道、解密、流量统计、超时与背压。
 * 调用方负责：鉴权、令牌校验、日志、错误响应。
 */
const { PassThrough, Transform, pipeline } = require('stream');
const statsStore = require('./stats-store');
const encStore = require('./enc-store');
const { p } = require('./cos');

/** 下载类响应超时（无数据活动时）：10 分钟（P7） */
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 把统计更新下沉到**固定时间间隔**（PERF-06）
 *
 * 旧实现对每个 chunk 都调用 `sampleTraffic()` + `trackBucket()`：后者内部会调用
 * `persist()`（去抖后把整个 stats 对象 JSON 序列化并原子写盘）。以 64KB chunk、
 * 10MB/s 计算约为 **每秒 160 次「改内存 + 标记脏」**，大文件下载累计成千上万次 ——
 * 高带宽时段 CPU 明显被统计逻辑吃掉，磁盘写入次数与实际数据量严重不成比例。
 *
 * 改为：chunk 级别只在**局部**累加（一次整数加法，几乎零成本），
 * 仅在时间间隔到达或流结束时才真正触碰 statsStore。
 */
const STATS_FLUSH_MS = 1000;

/**
 * 将对象存储对象流式转发到 HTTP 响应（可选透明解密），含流量统计/背压/超时。
 * @param {object} params
 *  - cos: 对象存储客户端
 *  - bucket, region, key
 *  - fileName: 用于 Content-Disposition 的文件名
 *  - encMeta: 可选加密元数据（null 表示明文）
 *  - req, res: Express 请求/响应
 *  - traffic: { bytesDown } 统计对象
 *  - [timeoutMs]: 默认 10 分钟
 */
async function streamDownload({ cos, bucket, region, key, fileName, encMeta, req, res, traffic, timeoutMs = DOWNLOAD_TIMEOUT_MS }) {
  const head = await p(cos, 'headObject', { Bucket: bucket, Region: region, Key: key });
  const size = Number(head.headers['content-length']) || 0;
  const contentType = head.headers['content-type'] || 'application/octet-stream';
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', encMeta ? encMeta.origSize : size);
  // 转义双引号、反斜杠与换行符，防止响应头注入（Claude issue #2）
  const safeName = String(fileName).replace(/[\\"\r\n]/g, '');
  res.setHeader('Content-Disposition',
    `attachment; filename="${safeName.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(safeName)}`);

  const out = encMeta ? encStore.decryptTransform(encMeta) : new PassThrough();

  /* ---- 流量计量 Transform（同时修复 PERF-06 与 PERF-09） ----
   *
   * 旧实现在 PassThrough 上挂 `data` 监听做统计，随后又用 `pipeline(out, res)`
   * 注册第二个消费者 —— 两条消费路径并存，`out.on('error')`、`pipeline` 回调、
   * `res.on('close')` 三处都在销毁流，既有重复销毁风险，也让背压行为难以推理。
   *
   * 改为显式 Transform：统计与转发统一在一条管线中，销毁也收敛为单点。
   */
  let pendingBytes = 0;
  let lastFlushAt = Date.now();
  const meter = new Transform({
    transform(chunk, _enc, cb) {
      pendingBytes += chunk.length;
      if (traffic) traffic.bytesDown += chunk.length; // 供调用方在结束后读取总数
      const now = Date.now();
      if (now - lastFlushAt >= STATS_FLUSH_MS) {
        lastFlushAt = now;
        flushTraffic(pendingBytes);
        pendingBytes = 0;
      }
      this.push(chunk);
      cb();
    },
    flush(cb) {
      flushTraffic(pendingBytes); // 收尾：清算残余计数，避免尾部字节丢失
      pendingBytes = 0;
      cb();
    },
  });

  function flushTraffic(n) {
    if (!n) return;
    statsStore.sampleTraffic(0, n);
    statsStore.trackBucket(bucket, { down: n });
  }

  // 统一销毁：管道任一环节结束/出错都走到这里，且 destroy 本身幂等
  const teardown = (() => {
    let done = false;
    return (err) => {
      if (done) return;
      done = true;
      try { out.destroy(); } catch (e) { /* ignore */ }
      if (err) { try { res.destroy(); } catch (e) { /* ignore */ } }
    };
  })();

  pipeline(out, meter, res, (err) => teardown(err));
  res.on('close', () => teardown(null));
  out.on('error', () => teardown(null));

  req.setTimeout(timeoutMs);
  res.setTimeout(timeoutMs, () => teardown(null));

  await new Promise((resolve, reject) => {
    cos.getObject({ Bucket: bucket, Region: region, Key: key, Output: out }, (err) => (err ? reject(err) : resolve()));
  });
}

module.exports = { streamDownload, DOWNLOAD_TIMEOUT_MS };
