/**
 * S3 兼容客户端 —— 面向阿里云 OSS / 华为云 OBS / 七牛云 / 又拍云 / AWS S3 等
 *
 * 设计目标：提供与 cos-nodejs-sdk-v5 足够接近的调用界面，
 * 使上层业务代码（routes / fs-gateway / webdav）保持单一写法：
 *
 *   client.getBucket({ Bucket, Region, Prefix, Delimiter, Marker, MaxKeys }, cb)
 *   client.headObject({ Bucket, Region, Key }, cb)
 *   client.putObject({ Bucket, Region, Key, Body, ContentLength, Headers }, cb)
 *   ...
 *
 * 与 COS 的主要差异：
 *  - 鉴权：AWS Signature V4（可选 UNSIGNED-PAYLOAD 流式上传）
 *  - CopySource：使用 URL 编码的 "/bucket/key"（COS 使用外链域名格式）
 *  - 列举接口：S3 使用 continuation-token 分页，此处转换为 Marker/IsTruncated 语义
 *  - 请求头元数据：S3 使用 x-amz-meta-*（COS 为 x-cos-meta-*）
 */
const crypto = require('crypto');
const { URL } = require('url');
const { Readable, pipeline } = require('stream');

const DEFAULT_TIMEOUT_MS = Number(process.env.S3_TIMEOUT_MS) || 120000;
const EMPTY_PAYLOAD_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

/**
 * NextMarker 编码约定：
 * S3 正常返回 NextContinuationToken（不透明游标）→ 直接透传；
 * 若某服务商在 list-type=2 下未返回该字段，则退回用「最后一个 Key」作 start-after 游标。
 * 两种游标语义不同（不透明 token vs 键字符串），用前缀区分，续传时按前缀选择参数名。
 */
const MARKER_PREFIX_KEY = '$k$';

/* ------------------------------- 工具函数 ------------------------------- */

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

/** AWS URI 编码：保留 '/'，其余按 RFC 3986 严格编码 */
function uriEncode(value, keepSlash) {
  const s = String(value);
  let out = '';
  for (const ch of s) {
    if (/[A-Za-z0-9\-._~]/.test(ch)) out += ch;
    else if (ch === '/' && keepSlash) out += ch;
    else {
      const buf = Buffer.from(ch, 'utf8');
      for (const b of buf) out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return out;
}

function encodeKeyPath(key) {
  // S3 规范：Key 内的 '/' 保留为路径分隔符
  return uriEncode(key, true);
}

/**
 * 从端点主机名推导地域（部分厂商无 region 入参时的兜底）：
 *  - oss-cn-hangzhou.aliyuncs.com -> cn-hangzhou
 *  - obs.cn-north-4.myhuaweicloud.com -> cn-north-4
 *  - s3.cn-north-1.qiniucs.com -> cn-north-1
 */
function deriveRegionFromHost(endpoint) {
  try {
    const host = new URL(endpoint).host.toLowerCase();
    const DOM = '(?:aliyuncs|myhuaweicloud|qiniucs|amazonaws)\\.com';
    const SVC = '(?:s3|oss|obs|cos|kodo)';
    // 地域段固定要求「两字母 + 至少一个 -xxx」，避免把服务名（s3 / oss / obs）误当地域
    const REGION = '([a-z]{2}(?:-[a-z0-9]+)+)';
    const patterns = [
      `^${SVC}\\.dualstack\\.${REGION}\\.${DOM}$`, // s3.dualstack.us-east-1.amazonaws.com
      `^${SVC}\\.${REGION}\\.${DOM}$`,             // obs.cn-north-4.myhuaweicloud.com / s3.us-east-1.amazonaws.com
      `^${SVC}-${REGION}\\.${DOM}$`,               // oss-cn-hangzhou.aliyuncs.com / s3-cn-east-1.qiniucs.com
    ];
    for (const p of patterns) {
      const m = new RegExp(p).exec(host);
      if (m) return m[1];
    }
    return '';
  } catch (e) {
    return '';
  }
}

/** 将多种输入统一为 Buffer（字符串按 utf8、TypedArray 取原始字节） */
function toBuffer(body) {
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  return Buffer.from(String(body || ''), 'utf8');
}

/**
 * 规范化 CopySource 为 S3 的 "/bucket/key"。
 * 注意：调用方（routes.copySource / fs-gateway）传入的键**已完成百分号编码**，
 * 此处只做形式归一，绝不再次编码，否则双重编码会导致键错乱。
 *  - /bucket/key → 原样（已编码）
 *  - bucket.cos.<region>.myqcloud.com/key → /bucket/key
 *  - bucket/key → 补前导斜杠
 */
function normalizeCopySource(src) {
  const s = String(src || '').trim();
  const m = /^([a-z0-9-]+)\.cos\.[a-z0-9-]+\.myqcloud\.com\/(.*)$/i.exec(s);
  if (m) return `/${m[1]}/${m[2]}`;
  return s.startsWith('/') ? s : '/' + s;
}

/**
 * 逐段解码已百分号编码的对象键（用于从 CopySource 反解出原始键）。
 * 解码失败（非法转义序列）时保留原样，避免异常；后续 _request 会重新编码一次，
 * 因此绝不能对已编码的键再次编码，否则会双重编码。
 */
function decodeKeyPath(encoded) {
  return String(encoded || '').split('/').map((seg) => {
    try { return decodeURIComponent(seg); } catch (e) { return seg; }
  }).join('/');
}

/** Node Readable -> Web ReadableStream（fetch body 需要）；已是 web stream 直接返回 */
function toWebStream(body) {
  if (!body) return body;
  if (typeof Readable.toWeb === 'function') {
    // Node 17+：官方转换（任何 Node stream 均可）
    return Readable.toWeb(body);
  }
  if (body instanceof ReadableStream) return body;
  // 极端环境兜底：整体缓冲（失去流式，但保证可用）
  return new Promise((resolve, reject) => {
    const chunks = [];
    body.on('data', (c) => chunks.push(c));
    body.on('error', reject);
    body.on('end', () => resolve(new Blob(chunks)));
  });
}

function parseXml(text) {
  // 轻量 XML 解析：仅提取 S3 响应所需的单层结构，避免引入额外依赖
  const out = {};
  out.__raw = text;
  return out;
}

/** 极简标签取值：返回首个同名标签内的文本 */
function tag(text, name) {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(text);
  return m ? m[1] : '';
}

/** 取出所有同名标签块（用于 Contents / CommonPrefixes 等重复节点） */
function tagAll(text, name) {
  // 要求标签名后紧跟 '>' 或空白：避免 <Bucket> 误匹配 <Buckets> 这类同前缀容器标签
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>[\\s\\S]*?</${name}>`, 'g');
  return text.match(re) || [];
}

/**
 * 归一化服务端返回的地域标识：
 *  - 阿里云 OSS：oss-cn-hangzhou -> cn-hangzhou
 *  - 腾讯云 COS：cos.ap-guangzhou -> ap-guangzhou
 *  - 华为云 OBS / AWS：cn-north-4 / us-east-1 原样返回
 */
function normalizeBucketRegion(loc) {
  const s = String(loc || '').trim();
  if (!s) return '';
  const m = /^(?:oss|cos|obs)[.-](.+)$/i.exec(s);
  return m ? m[1] : s;
}

/** 去掉 XML 实体转义（Key 中的 &amp; 等） */
function unescapeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/* ------------------------------- 客户端实现 ------------------------------- */

class S3Client {
  /**
   * @param {object} opts { accessKeyId, secretAccessKey, endpoint, bucket, region }
   */
  constructor(opts) {
    const o = opts || {};
    this.accessKeyId = o.accessKeyId || '';
    this.secretAccessKey = o.secretAccessKey || '';
    const raw = String(o.endpoint || '').trim() || 'https://s3.amazonaws.com';
    const withProto = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;
    this.endpoint = withProto.replace(/\/+$/, '');
    this.region = String(o.region || '').trim() || deriveRegionFromHost(this.endpoint) || 'us-east-1';
    this.bucket = o.bucket || '';
    const u = new URL(this.endpoint);
    this.host = u.host;
    this.protocol = u.protocol;
    this.basePath = u.pathname.replace(/\/+$/, '');
    this.timeout = Number(o.timeout) || DEFAULT_TIMEOUT_MS;
  }

  /** 依据 COS 风格的 { Bucket, Region } 覆盖本次请求的桶与地域（region 为 COS 概念，S3 下忽略） */
  _ctx(params) {
    const bucket = (params && params.Bucket) || this.bucket;
    return { bucket: String(bucket || '') };
  }

  /** 生成 SigV4 签名后的请求头（host 必须使用实际请求的 hostHeader，含桶前缀） */
  _sign(method, path, query, headers, payloadHash, hostHeader) {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);

    const signedHeadersMap = Object.assign({}, headers, {
      host: hostHeader || this.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    });
    // 小写键名（按字典序签名）
    const lowered = {};
    for (const [k, v] of Object.entries(signedHeadersMap)) lowered[k.toLowerCase()] = String(v).trim();
    const signedHeaderNames = Object.keys(lowered).sort();
    const canonicalHeaders = signedHeaderNames.map((k) => `${k}:${lowered[k]}\n`).join('');
    const signedHeaders = signedHeaderNames.join(';');

    const canonicalQuery = Object.keys(query).sort()
      .map((k) => `${uriEncode(k, false)}=${uriEncode(query[k], false)}`).join('&');

    const canonicalRequest = [
      method.toUpperCase(), path || '/', canonicalQuery,
      canonicalHeaders, signedHeaders, payloadHash,
    ].join('\n');

    const scope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest),
    ].join('\n');

    const kDate = hmac('AWS4' + this.secretAccessKey, dateStamp);
    const kRegion = hmac(kDate, this.region);
    const kService = hmac(kRegion, 's3');
    const kSigning = hmac(kService, 'aws4_request');
    const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

    return Object.assign({}, signedHeadersMap, {
      authorization: `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    });
  }

  /**
   * 发起一次 S3 请求
   * @param {object} spec { method, bucket, key, query, headers, body(Buffer|Stream|undefined),
   *                        streamBody(bool), timeoutMs, rawBody(bool) }
   * @param {boolean} [spec.rawBody] true 时不预读响应体，原样返回 fetch 的 Response，
   *        由调用方自行消费（HEAD 无体、GET 二进制/流式必需）。默认预读为文本（XML 场景）。
   */
  _request(spec) {
    const method = String(spec.method || 'GET').toUpperCase();
    // 显式空桶（''）用于服务级请求（ListBuckets），不能回退到默认桶
    const bucket = spec.bucket !== undefined ? String(spec.bucket || '') : (this.bucket || '');
    const key = spec.key || '';
    const query = spec.query || {};
    const headers = Object.assign({}, spec.headers || {});

    const hostHeader = bucket && this.basePath === ''
      ? `${bucket}.${this.host}`          // 虚拟主机风格（S3 默认）
      : this.host;
    let path;
    if (bucket && this.basePath === '') {
      path = '/' + encodeKeyPath(key);
    } else {
      // 路径风格：/bucket/key（部分厂商与自定义 endpoint 需要）
      path = this.basePath + '/' + bucket + (key ? '/' + encodeKeyPath(key) : '');
    }
    if (!path.startsWith('/')) path = '/' + path;

    const hasBody = spec.body !== undefined && spec.body !== null;
    let payloadHash;
    if (!hasBody) payloadHash = EMPTY_PAYLOAD_SHA256;
    else if (spec.streamBody) payloadHash = UNSIGNED_PAYLOAD;
    else payloadHash = sha256Hex(toBuffer(spec.body));

    if (headers.host === undefined) headers.host = hostHeader;
    if (hasBody && !spec.streamBody) headers['content-length'] = String(toBuffer(spec.body).length);
    else if (hasBody && spec.contentLength !== undefined) headers['content-length'] = String(spec.contentLength);

    const signed = this._sign(method, path, query, headers, payloadHash, hostHeader);
    const qs = Object.keys(query).sort()
      .map((k) => `${uriEncode(k, false)}=${uriEncode(query[k], false)}`).join('&');
    const target = `${this.protocol}//${hostHeader}${path}${qs ? '?' + qs : ''}`;

    const init = { method, headers: signed };
    if (hasBody) {
      if (spec.streamBody) {
        // fetch 需要标准 Web ReadableStream；Node 流需转换后才能作为 body
        init.body = toWebStream(spec.body);
        init.duplex = 'half';
      } else {
        init.body = toBuffer(spec.body);
      }
    }

    const timeoutMs = Number(spec.timeoutMs) || this.timeout;
    const controller = new AbortController();
    let timer = setTimeout(() => controller.abort(), timeoutMs);
    init.signal = controller.signal;

    if (spec.rawBody) {
      // 不预读响应体：二进制/流式/无体响应（HEAD）必须原样交出 Response。
      // 注意：timeout 由调用方在消费完 body 后清理（clearRequestTimeout），
      // 否则长下载会被 abort —— 见 getObject 中的显式清理。
      return fetch(target, init)
        .then((res) => ({ res, body: undefined, timeoutTimer: timer }))
        .catch((e) => {
          clearTimeout(timer);
          throw this._normalizeNetworkError(e);
        });
    }

    return fetch(target, init)
      .then(async (res) => {
        clearTimeout(timer);
        return { res, body: await res.text() };
      })
      .catch((e) => {
        clearTimeout(timer);
        throw this._normalizeNetworkError(e);
      });
  }

  /**
   * 无响应体（HEAD）请求的统一入口 —— FUN-10
   *
   * `rawBody:true` 时 `_request()` 会把 `timeoutTimer` 交还给调用方，要求其在消费完
   * body 后自行清理；这是**流式下载**必需的行为（长下载不能被超时中断）。
   * 但 HEAD 没有响应体可读，"由调用方清理"就变成了"没有任何人清理" —— 每次 HEAD
   * 都会留下一个 `setTimeout(…, 120000)` 以及它闭包捕获的 AbortController / Response。
   * 而 HEAD 是项目里调用最频繁的操作之一（存在性检查、PROPFIND、MOVE 前置探测等），
   * 高频场景下会稳定堆积定时器与内存。
   *
   * 这里把「拿到响应即清理定时器」封装成单一入口，从结构上消除泄漏，
   * 而不是依赖每个调用点自觉记得清理。
   *
   * @param {object} spec 与 {@link _request} 相同
   * @returns {Promise<Response>}
   */
  async _head(spec) {
    const { res, timeoutTimer } = await this._request(Object.assign({}, spec, { rawBody: true }));
    clearTimeout(timeoutTimer); // HEAD 无响应体可消费，响应已到即可立即清理
    return res;
  }

  /** 统一网络层错误（超时 / 其它） */
  _normalizeNetworkError(e) {
    const err = new Error(e && e.name === 'AbortError'
      ? 'TimeoutError: request timed out'
      : (e && e.message) || 'network error');
    err.code = e && e.name === 'AbortError' ? 'TimeoutError' : (e && e.code) || 'NetworkError';
    return err;
  }

  /** 统一的响应处理：非 2xx 抛出带 statusCode/code 的错误 */
  async _send(spec, { raw = false } = {}) {
    const { res, body } = await this._request(spec);
    if (res.ok) return raw ? { res, body } : body;
    const code = tag(body, 'Code') || `HTTP ${res.status}`;
    const message = tag(body, 'Message') || res.statusText || 'request failed';
    const err = new Error(`${code}: ${message}`);
    err.statusCode = res.status;
    err.code = unescapeXml(code);
    err.rawMessage = unescapeXml(message);
    throw err;
  }

  /* --------------------------- COS 兼容方法 --------------------------- */

  /**
   * 列举对象（COS getBucket 语义：Marker/NextMarker/IsTruncated）
   *
   * S3 原生使用 continuation-token 分页，与 COS 的 Marker 语义不同。此处做**内部吸收**：
   * - 对外入参统一按 COS 语义接收 `Marker`（首轮为空/cursor）；若调用方显式传
   *   `ContinuationToken`（如上层自行管理游标）则优先使用。
   * - 对外返回 `NextMarker` 恒为**可直接回传的不透明游标**（S3 下即 continuation-token），
   *   调用方按 COS 习惯把 `NextMarker` 塞回 `Marker` 即可，适配层再映射回 continuation-token。
   *
   * 关键：不论厂商，`NextMarker` 与下一轮的续传参数必须一一对应，绝不能把 token 当
   * `start-after`（那是"从该 key 之后开始"的字符串语义，会导致漏项/重复）。
   */
  getBucket(params, cb) {
    return this._do(cb, async () => {
      const { bucket } = this._ctx(params);
      const query = { 'list-type': '2' };
      if (params.Prefix) query.prefix = params.Prefix;
      if (params.Delimiter) query.delimiter = params.Delimiter;
      if (params.MaxKeys) query['max-keys'] = String(params.MaxKeys);
      // 游标：显式 ContinuationToken 优先；否则把调用方按 COS 习惯传来的 Marker 当作
      // 上一轮返回的 NextMarker 继续使用（按前缀区分是不透明 token 还是键字符串）。
      let cursor = params.ContinuationToken !== undefined && params.ContinuationToken !== ''
        ? String(params.ContinuationToken)
        : (params.Marker ? String(params.Marker) : '');
      if (cursor.startsWith(MARKER_PREFIX_KEY)) {
        // 键字符串游标 → 用 start-after（语义为"从该 key 之后继续"，S3 会跳过该 key 本身）
        query['start-after'] = cursor.slice(MARKER_PREFIX_KEY.length);
        cursor = '';
      }
      if (cursor) query['continuation-token'] = cursor;

      const body = await this._send({ method: 'GET', bucket, query });
      const contents = tagAll(body, 'Contents').map((blk) => ({
        Key: unescapeXml(tag(blk, 'Key')),
        Size: Number(tag(blk, 'Size')) || 0,
        LastModified: tag(blk, 'LastModified'),
        ETag: tag(blk, 'ETag'),
        StorageClass: tag(blk, 'StorageClass') || 'STANDARD',
      }));
      const prefixes = tagAll(body, 'CommonPrefixes')
        .map((blk) => unescapeXml(tag(blk, 'Prefix'))).filter(Boolean);
      const truncated = tag(body, 'IsTruncated').toLowerCase() === 'true';
      const nextToken = unescapeXml(tag(body, 'NextContinuationToken'));
      // 极少数服务商在 list-type=2 下不回 NextContinuationToken，退回用末 key 作 start-after。
      // 此时游标是"键字符串"，下一轮必须走 start-after 而非 continuation-token —— 用前缀区分。
      const fallbackKey = contents.length ? contents[contents.length - 1].Key : '';
      const nextMarker = truncated ? (nextToken || (fallbackKey ? MARKER_PREFIX_KEY + fallbackKey : '')) : '';
      return {
        Contents: contents,
        CommonPrefixes: prefixes.map((p) => ({ Prefix: p })),
        IsTruncated: truncated ? 'true' : 'false',
        NextMarker: nextMarker,
        NextContinuationToken: truncated ? nextToken : '',
        Name: bucket,
      };
    });
  }

  headBucket(params, cb) {
    return this._do(cb, async () => {
      const { bucket } = this._ctx(params);
      const res = await this._head({ method: 'HEAD', bucket }); // FUN-10：定时器自动清理
      if (!res.ok) {
        const err = new Error(res.status === 404 ? 'NoSuchBucket: bucket not found' : `HTTP ${res.status}`);
        err.statusCode = res.status;
        err.code = res.status === 404 ? 'NoSuchBucket' : `HTTP ${res.status}`;
        throw err;
      }
      return { __raw: null, headers: headerObject(res.headers), statusCode: res.status };
    });
  }

  /** 删除存储桶（要求桶已清空，否则服务端返回 BucketNotEmpty） */
  deleteBucket(params, cb) {
    return this._do(cb, async () => {
      const { bucket } = this._ctx(params);
      await this._send({ method: 'DELETE', bucket });
      return {};
    });
  }

  getService(params, cb) {
    return this._do(cb, async () => {
      const body = await this._send({ method: 'GET', bucket: '' });
      const buckets = tagAll(body, 'Bucket').map((blk) => {
        // 地域取值优先级：BucketRegion（AWS/COS）→ Location（阿里云 / 华为云）→ 客户端地域
        const raw = unescapeXml(tag(blk, 'BucketRegion')) || unescapeXml(tag(blk, 'Location'));
        const region = normalizeBucketRegion(raw) || this.region;
        return {
          Name: unescapeXml(tag(blk, 'Name')),
          Region: region,
          Location: region,
          CreationDate: tag(blk, 'CreationDate'),
        };
      });
      return { Buckets: buckets, Owner: {} };
    });
  }

  headObject(params, cb) {
    return this._do(cb, async () => {
      const { bucket } = this._ctx(params);
      const res = await this._head({ method: 'HEAD', bucket, key: params.Key || '' }); // FUN-10
      if (!res.ok) {
        const err = new Error(res.status === 404 ? 'NoSuchKey: object not found' : `HTTP ${res.status}`);
        err.statusCode = res.status;
        err.code = res.status === 404 ? 'NoSuchKey' : `HTTP ${res.status}`;
        throw err;
      }
      const headers = {};
      res.headers.forEach((v, k) => {
        // 元数据统一映射回 x-cos-meta-* 命名，便于上层无差别读取
        headers[k.startsWith('x-amz-meta-') ? k.replace('x-amz-meta-', 'x-cos-meta-') : k] = v;
      });
      return { headers, statusCode: res.status };
    });
  }

  getObject(params, cb) {
    return this._do(cb, async () => {
      const { bucket } = this._ctx(params);
      // rawBody: 必须原样拿到 Response —— 流式模式要 pipe res.body，缓冲模式要 arrayBuffer()
      const { res, timeoutTimer } = await this._request({
        method: 'GET', bucket, key: params.Key || '',
        headers: params.Range ? { range: params.Range } : undefined,
        timeoutMs: params.__timeoutMs, rawBody: true,
      });
      if (!res.ok) {
        clearTimeout(timeoutTimer);
        let text = '';
        try { text = await res.text(); } catch (e) { /* 响应体不可读则以状态行为准 */ }
        // 尝试从 XML 错误体里取更精确的 Code
        const code = text ? (tag(text, 'Code') || '') : '';
        const message = text ? (tag(text, 'Message') || '') : '';
        const err = new Error(message || code || `HTTP ${res.status}`);
        err.statusCode = res.status;
        err.code = unescapeXml(code) || (res.status === 404 ? 'NoSuchKey' : `HTTP ${res.status}`);
        throw err;
      }
      // 流式判据必须与 COS SDK 对齐：看它是不是一个流（有 pipe），而不是看它是不是函数。
      // 曾写成 `typeof params.Output === 'function'`，而生产四处传的都是 PassThrough（typeof 为 'object'），
      // 于是全部掉进下面的 arrayBuffer 分支：对象被无界读进内存、调用方传入的流永不 end，
      // 进而让 `await bufferStream(pass)` 永不返回、`finally { releaseReader() }` 永不执行 ——
      // 非腾讯云厂商的下载全线失效，且加密读信号量被永久泄漏（R14-01）。
      const out = params.Output;
      if (out && typeof out.pipe === 'function') {
        // 流式模式：把响应体导进调用方给的流。超时改由流生命周期兜底 ——
        // body 读完/出错时清理定时器，避免长下载过程中被请求级 timer 误 abort。
        const stream = Readable.fromWeb(res.body);
        const clear = () => clearTimeout(timeoutTimer);
        stream.once('end', clear);
        stream.once('close', clear);
        stream.once('error', clear);
        // 用 pipeline 而非 stream.pipe(out)：任一端出错都要让另一端收到并销毁。
        // 只 pipe 的话，上游错误不会传到 out，上层会永久挂起（这正是本条缺陷的放大环节）。
        pipeline(stream, out, (pipeErr) => {
          clear();
          if (pipeErr) out.destroy(pipeErr);
        });
        return { Body: out, headers: headerObject(res.headers), statusCode: res.status };
      }
      try {
        const buf = Buffer.from(await res.arrayBuffer());
        return { Body: buf, headers: headerObject(res.headers), statusCode: res.status };
      } finally {
        clearTimeout(timeoutTimer);
      }
    });
  }

  putObject(params, cb) {
    return this._do(cb, async () => {
      const { bucket } = this._ctx(params);
      const headers = Object.assign({}, params.Headers || {});
      if (params.ContentType) headers['content-type'] = params.ContentType;
      // COS 元数据头 → S3 元数据头
      for (const k of Object.keys(headers)) {
        if (k.toLowerCase().startsWith('x-cos-meta-')) {
          headers['x-amz-meta-' + k.slice('x-cos-meta-'.length)] = headers[k];
          delete headers[k];
        }
      }
      const isStream = params.Body && typeof params.Body.pipe === 'function';
      const body = await this._send({
        method: 'PUT', bucket, key: params.Key || '', headers, body: params.Body,
        streamBody: isStream, contentLength: params.ContentLength,
      });
      return {
        ETag: tag(body, 'ETag'),
        Location: tag(body, 'Location'),
        headers: {},
      };
    });
  }

  deleteObject(params, cb) {
    return this._do(cb, async () => {
      const { bucket } = this._ctx(params);
      await this._send({ method: 'DELETE', bucket, key: params.Key || '' });
      return {};
    });
  }

  /**
   * 批量删除（COS deleteMultipleObject 语义），自动按 1000 条分批。
   *
   * R9-02：**必须解析响应体内的 `<Error>` 集合**。
   *
   * S3 的 `DeleteObjects` 对整批返回 200，单个对象的失败（权限不足、对象锁、
   * 合规保留、对象不存在等）只在响应体内用 `<Error><Key/><Code/><Message/></Error>`
   * 报告。旧实现硬编码 `Error: []`，把这些失败**全部丢弃**。
   *
   * 调用方（`routes/fs.js` 的 `/fs/delete`）以该字段为唯一成败判据，于是失败的对象
   * 被当作已删除 → `removeMetaBatch` 清掉**仍然存在**的密文的解密凭据（该文件永久
   * 不可解）、`markMissingByKeys` 把指向它的分享链接标成"已删除"（已分发的链接
   * 永久失效）。项目把这两件事都定义为不可逆操作，而判据来自一个被写死成空数组的字段。
   *
   * 修复后调用方仍应使用**白名单**判据（只处理明确出现在 `Deleted` 里的 key），
   * 两层一起保证「不确定的一律不动」。
   */
  deleteMultipleObject(params, cb) {
    return this._do(cb, async () => {
      const { bucket } = this._ctx(params);
      const objects = params.Objects || [];
      const deleted = [];
      const errors = [];
      for (let i = 0; i < objects.length; i += 1000) {
        const batch = objects.slice(i, i + 1000);
        const xml = '<?xml version="1.0" encoding="UTF-8"?>' +
          '<Delete><Quiet>false</Quiet>' +
          batch.map((o) => `<Object><Key>${escapeXml(o.Key)}</Key></Object>`).join('') +
          '</Delete>';
        const body = await this._send({
          method: 'POST', bucket, query: { delete: '' },
          headers: { 'content-type': 'application/xml' }, body: xml,
        });
        for (const blk of tagAll(body, 'Deleted')) deleted.push({ Key: unescapeXml(tag(blk, 'Key')) });
        // R9-02：不丢弃 <Error>。Key/Code/Message 三者都取，调用方按 Key 定位、按
        // Code/Message 给出人可读原因（Code 缺失时回退 Message，两者都缺则给兜底文案）。
        for (const blk of tagAll(body, 'Error')) {
          const key = unescapeXml(tag(blk, 'Key'));
          const code = unescapeXml(tag(blk, 'Code'));
          const message = unescapeXml(tag(blk, 'Message'));
          errors.push({
            Key: key,
            Code: code || 'DeleteFailed',
            Message: message || code || '云端拒绝删除该对象',
          });
        }
      }
      return { Deleted: deleted, Error: errors };
    });
  }

  /** 复制对象（服务端复制）：CopySource 使用 S3 的 /bucket/key 形式 */
  putObjectCopy(params, cb) {
    return this._do(cb, async () => {
      const { bucket } = this._ctx(params);
      const src = String(params.CopySource || '');
      const copySource = normalizeCopySource(src);
      const body = await this._send({
        method: 'PUT', bucket, key: params.Key || '',
        headers: { 'x-amz-copy-source': copySource },
      });
      return { ETag: tag(body, 'ETag'), LastModified: tag(body, 'LastModified') };
    });
  }

  /**
   * 分块复制（COS sliceCopyFile 语义）：用于超过单次 PUT Copy 上限（5GB）的大对象。
   * 流程：HEAD 源对象取大小 → multipartInit → 逐片 UploadPartCopy → multipartComplete
   * 失败时自动 abort，避免残留碎片。
   */
  sliceCopyFile(params, cb) {
    return this._do(cb, async () => {
      const { bucket } = this._ctx(params);
      const key = params.Key || '';
      const copySource = normalizeCopySource(String(params.CopySource || ''));
      // 源桶/键（CopySource 形如 /bucket/key，键为已编码形式；此处反解为原始键）
      const seg = copySource.replace(/^\//, '').split('/');
      const srcBucket = decodeKeyPath(seg.shift());
      const srcKey = decodeKeyPath(seg.join('/'));

      // FUN-10：HEAD 用 _head()，定时器在响应到达时即清理（旧写法把它丢弃成泄漏）
      const headRes = await this._head({ method: 'HEAD', bucket: srcBucket, key: srcKey });
      if (!headRes.ok) {
        const err = new Error('NoSuchKey: source object not found');
        err.statusCode = headRes.status;
        err.code = 'NoSuchKey';
        throw err;
      }
      const total = Number(headRes.headers.get('content-length')) || 0;
      // 空对象直接走简单复制
      if (total <= 0) return this.putObjectCopy(params, cb);

      const PART = Math.max(8 * 1024 * 1024, Number(params.PartSize) || 64 * 1024 * 1024);
      const init = await this.multipartInit({ Bucket: bucket, Key: key });
      const uploadId = init.UploadId;
      try {
        const count = Math.max(1, Math.ceil(total / PART));
        const parts = [];
        for (let i = 0; i < count; i++) {
          const start = i * PART;
          const end = Math.min(total, start + PART) - 1;
          const body = await this._send({
            method: 'PUT', bucket, key,
            query: { partNumber: String(i + 1), uploadId },
            headers: {
              'x-amz-copy-source': copySource,
              'x-amz-copy-source-range': `bytes=${start}-${end}`,
            },
          });
          const etag = tag(body, 'ETag');
          if (!etag) {
            const err = new Error('InternalError: copy part returned no ETag');
            err.code = 'InternalError';
            throw err;
          }
          parts.push({ PartNumber: i + 1, ETag: etag });
        }
        return await this.multipartComplete({ Bucket: bucket, Key: key, UploadId: uploadId, Parts: parts });
      } catch (e) {
        try { await this.multipartAbort({ Bucket: bucket, Key: key, UploadId: uploadId }); } catch (_) { /* 清理失败不掩盖原始错误 */ }
        throw e;
      }
    });
  }

  /** 分片上传：初始化 */
  multipartInit(params, cb) {
    return this._do(cb, async () => {
      const { bucket } = this._ctx(params);
      const headers = {};
      if (params.ContentType) headers['content-type'] = params.ContentType;
      const body = await this._send({
        method: 'POST', bucket, key: params.Key || '', query: { uploads: '' }, headers,
      });
      return { Bucket: bucket, Key: params.Key || '', UploadId: unescapeXml(tag(body, 'UploadId')) };
    });
  }

  /** 分片上传：上传单个分片 */
  multipartUpload(params, cb) {
    return this._do(cb, async () => {
      const { bucket } = this._ctx(params);
      const partNumber = Number(params.PartNumber) || 1;
      const body = await this._send({
        method: 'PUT', bucket, key: params.Key || '',
        query: { partNumber: String(partNumber), uploadId: params.UploadId },
        body: params.Body, contentLength: params.ContentLength,
        streamBody: params.Body && typeof params.Body.pipe === 'function',
      });
      return { ETag: tag(body, 'ETag') };
    });
  }

  /** 分片上传：完成 */
  multipartComplete(params, cb) {
    return this._do(cb, async () => {
      const { bucket } = this._ctx(params);
      const parts = (params.Parts || []).slice()
        .sort((a, b) => Number(a.PartNumber) - Number(b.PartNumber));
      const xml = '<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUpload>' +
        parts.map((p) => `<Part><PartNumber>${Number(p.PartNumber)}</PartNumber>` +
          `<ETag>${escapeXml(String(p.ETag || '').replace(/^"|"$/g, ''))}</ETag></Part>`).join('') +
        '</CompleteMultipartUpload>';
      const body = await this._send({
        method: 'POST', bucket, key: params.Key || '',
        query: { uploadId: params.UploadId },
        headers: { 'content-type': 'application/xml' }, body: xml,
      });
      return {
        Location: tag(body, 'Location'),
        Bucket: tag(body, 'Bucket'),
        Key: tag(body, 'Key'),
        ETag: tag(body, 'ETag'),
      };
    });
  }

  /** 分片上传：中止 */
  multipartAbort(params, cb) {
    return this._do(cb, async () => {
      const { bucket } = this._ctx(params);
      await this._send({
        method: 'DELETE', bucket, key: params.Key || '', query: { uploadId: params.UploadId },
      });
      return {};
    });
  }

  /** 列出未完成的分片上传（COS multipartList 语义） */
  multipartList(params, cb) {
    return this._do(cb, async () => {
      const { bucket } = this._ctx(params);
      const query = { uploads: '' };
      if (params.MaxUploads) query['max-uploads'] = String(params.MaxUploads);
      if (params.KeyMarker) query['key-marker'] = params.KeyMarker;
      if (params.UploadIdMarker) query['upload-id-marker'] = params.UploadIdMarker;
      const body = await this._send({ method: 'GET', bucket, query });
      const uploads = tagAll(body, 'Upload').map((blk) => ({
        Key: unescapeXml(tag(blk, 'Key')),
        UploadId: unescapeXml(tag(blk, 'UploadId')),
        Initiated: tag(blk, 'Initiated'),
      }));
      const truncated = tag(body, 'IsTruncated').toLowerCase() === 'true';
      return {
        ListUploadsResult: {
          Upload: uploads,
          IsTruncated: truncated ? 'true' : 'false',
          NextKeyMarker: unescapeXml(tag(body, 'NextKeyMarker')),
          NextUploadIdMarker: unescapeXml(tag(body, 'NextUploadIdMarker')),
        },
      };
    });
  }

  /**
   * 列出某次分片上传已成功上传的分片（COS multipartListPart 语义）
   * 用于断点续传恢复：调用方读取 ListPartsResult.Part（PartNumber/ETag/Size）
   */
  multipartListPart(params, cb) {
    return this._do(cb, async () => {
      const { bucket } = this._ctx(params);
      const parts = [];
      let marker = '';
      let truncated = true;
      let guard = 0;
      while (truncated && guard++ < 100) {
        const query = { uploadId: String(params.UploadId || ''), 'max-parts': '1000' };
        if (marker) query['part-number-marker'] = String(marker);
        const body = await this._send({ method: 'GET', bucket, key: params.Key || '', query });
        for (const blk of tagAll(body, 'Part')) {
          parts.push({
            PartNumber: Number(tag(blk, 'PartNumber')) || 0,
            ETag: tag(blk, 'ETag'),
            Size: Number(tag(blk, 'Size')) || 0,
            LastModified: tag(blk, 'LastModified'),
          });
        }
        truncated = tag(body, 'IsTruncated').toLowerCase() === 'true';
        const next = unescapeXml(tag(body, 'NextPartNumberMarker'));
        if (!truncated || !next || next === marker) break;
        marker = next;
      }
      return {
        ListPartsResult: {
          Part: parts,
          IsTruncated: 'false',
          Key: params.Key || '',
          UploadId: params.UploadId || '',
        },
      };
    });
  }

  /**
   * 桶 ACL 查询：S3 返回的授权结构（Grants）与 COS 接近，
   * 但 S3 不再返回 AllUsers 授权（新版默认禁用 ACL），此处仅做尽力而为的映射。
   */
  getBucketAcl(params, cb) {
    return this._do(cb, async () => {
      const { bucket } = this._ctx(params);
      const body = await this._send({ method: 'GET', bucket, query: { acl: '' } });
      const grants = tagAll(body, 'Grant').map((blk) => {
        const grantee = tag(blk, 'Grantee');
        return {
          Grantee: {
            URI: unescapeXml(tag(grantee, 'URI')),
            ID: unescapeXml(tag(grantee, 'ID')),
            DisplayName: unescapeXml(tag(grantee, 'DisplayName')),
          },
          Permission: tag(blk, 'Permission'),
        };
      });
      return { Grants: grants, Owner: {} };
    });
  }

  /** 桶容量：S3 无对应接口，交由上层回退到对象列举统计 */
  request(params, cb) {
    return this._do(cb, async () => {
      const err = new Error('NotImplemented: operation not supported by this provider');
      err.statusCode = 501;
      err.code = 'NotImplemented';
      throw err;
    });
  }

  /** 预签名下载直链（SigV4 query 签名） */
  getObjectUrl(params, cb) {
    try {
      const bucket = params.Bucket || this.bucket;
      const key = params.Key || '';
      const expires = Math.max(1, Math.min(604800, Number(params.Sign && params.Expires ? params.Expires : 3600) || 3600));
      const hostHeader = bucket ? `${bucket}.${this.host}` : this.host;
      const path = (bucket && this.basePath === '' ? '/' : this.basePath + '/' + bucket + '/') + encodeKeyPath(key);

      const now = new Date();
      const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
      const dateStamp = amzDate.slice(0, 8);
      const scope = `${dateStamp}/${this.region}/s3/aws4_request`;
      const query = {
        'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
        'X-Amz-Credential': `${this.accessKeyId}/${scope}`,
        'X-Amz-Date': amzDate,
        'X-Amz-Expires': String(expires),
        'X-Amz-SignedHeaders': 'host',
      };
      const canonicalQuery = Object.keys(query).sort()
        .map((k) => `${uriEncode(k, false)}=${uriEncode(query[k], false)}`).join('&');
      const canonicalRequest = ['GET', path, canonicalQuery, `host:${hostHeader}\n`, 'host', UNSIGNED_PAYLOAD].join('\n');
      const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
      const kDate = hmac('AWS4' + this.secretAccessKey, dateStamp);
      const kSigning = hmac(hmac(hmac(kDate, this.region), 's3'), 'aws4_request');
      const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
      const url = `${this.protocol}//${hostHeader}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
      if (typeof cb === 'function') cb(null, { Url: url });
      return { Url: url };
    } catch (e) {
      if (typeof cb === 'function') return cb(e);
      throw e;
    }
  }

  /* --------------------------- 回调适配 --------------------------- */

  /** 将 async 方法体包装为 SDK 风格 (err, data) 回调，兼容上层 p() 封装 */
  _do(cb, fn) {
    const run = Promise.resolve().then(fn);
    if (typeof cb !== 'function') return run;
    run.then((data) => cb(null, data), (err) => cb(err));
  }
}

function headerObject(headers) {
  const out = {};
  headers.forEach((v, k) => {
    out[k.startsWith('x-amz-meta-') ? k.replace('x-amz-meta-', 'x-cos-meta-') : k] = v;
  });
  return out;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

module.exports = { S3Client, uriEncode };
