/**
 * Microsoft Azure Blob Storage 客户端 —— **Shared Key 鉴权 + Blob REST**（零新增依赖）
 *
 * 为什么单独一个实现（而不是套用 `s3-client.js`）：
 * Azure Blob 的 REST 接口与 S3 兼容协议**只是长得像**，关键处都不同 ——
 *   · 鉴权是 Shared Key（HMAC-SHA256 over 一套固定顺序的 StringToSign），不是 SigV4；
 *   · 服务地址是 `https://<账户名>.blob.core.windows.net`（账户名进主机名），没有「地域」概念；
 *   · 分片上传是 **Block Blob**（Put Block + Put Block List），没有 UploadId 握手；
 *   · 复制是 `x-ms-copy-source`（可同步可异步），预签名是 **SAS** 而不是 query 版 SigV4。
 * 硬把 Azure 塞进 S3 适配器会在每一处都留一个 `if (azure)`，因此按本项目既有的
 * 「同一种协议一个实现」原则新建本文件（对比：腾讯云 COS 也是独立实现）。
 *
 * 对外接口与 `s3-client.js` / cos-nodejs-sdk-v5 **完全一致**（`(params, cb)` 回调风格、
 * 返回结构同名同义），因此 `cos.js` 的 `p()` / `listPage` / `listAll` /
 * `deleteMultipleConfirmed` 等上层逻辑一行都不用改。
 *
 * ## Shared Key 签名（StringToSign，字段顺序固定、不可增删）
 *
 * ```
 * VERB \n Content-Encoding \n Content-Language \n Content-Length \n Content-MD5 \n
 * Content-Type \n Date \n If-Modified-Since \n If-Match \n If-None-Match \n
 * If-Unmodified-Since \n Range \n CanonicalizedHeaders CanonicalizedResource
 * ```
 * 要点（每一条都踩过坑）：
 *  - `Content-Length` 为 **0 时必须留空**（不是写 "0"）—— 写 "0" 会得到 403
 *    `AuthenticationFailed`，而报文里不带任何线索；
 *  - 用了 `x-ms-date` 之后，上面的 `Date` 一行必须留空（服务端以 x-ms-date 为准）；
 *  - `CanonicalizedHeaders`：所有 `x-ms-*` 头，**名字小写**、按名字升序，每行 `name:value` + `\n`；
 *  - `CanonicalizedResource`：`/<账户名>/<容器>/<对象>`，随后每个查询参数各占一行
 *    `\n<名字小写>:<URL 解码后的值>`，按名字升序；同名参数的值用逗号连接在一行。
 *    ⚠️ 账户名取自**凭据**（`secretId`），不取自主机名 —— 自定义域名（含本机回环调试端点）
 *    下主机名里没有账户名，但规范化资源仍然要求它。
 *
 * ## 与上层的约定
 *  - 返回的响应头一律**小写**（`headers['content-length']`），`x-ms-meta-*` 映射回
 *    `x-cos-meta-*`，与 `s3-client.js` 的处理保持一致，上层无需感知厂商差异；
 *  - `getBucket` 返回 COS 形状（`Contents` / `CommonPrefixes` / `IsTruncated` / `NextMarker`）；
 *  - `deleteMultipleObject` 返回 `{ Deleted: [{Key}], Error: [{Key, Code, Message}] }`，
 *    且**只对云端明确确认删除的 key** 放进 `Deleted` —— `cos.deleteMultipleConfirmed`
 *    依赖这份白名单决定「能不能清加密元数据 / 标记分享链接失效」，多报一个都是数据事故。
 */
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream');
// XML 提取的三个小工具与 s3-client 共用一份实现（避免两套正则各自漂移）
const { tag, tagAll, unescapeXml } = require('./s3-client');

/** 请求头里出现的 API 版本。SAS 的 `sv` 必须与之一致（见 `getObjectUrl`）。 */
const API_VERSION = '2020-12-06';
const DEFAULT_TIMEOUT_MS = Number(process.env.AZURE_TIMEOUT_MS) || 120000;

/** Blob 大小上限（单次 Put Blob，2019-12-12 之后为 5000 MiB）；由调用方切分，这里只兜底 */
const MAX_PUT_BLOB = 5000 * 1024 * 1024;

/** 账户名（Azure 规则：3–24 位小写字母或数字）。它既进主机名又进签名，必须严格。 */
const ACCOUNT_NAME_RE = /^[a-z0-9]{3,24}$/;

/** 分片（Block）ID：Azure 要求 blockid 为 base64，且同一 block list 内**长度必须一致**。
 *  块名形如 `block-<会话令牌>-00001`（定宽分片号，便于由分片号反解 —— 断点续传要用）。 */
const BLOCK_PREFIX = 'block-';
const BLOCK_NUM_WIDTH = 5;
const BLOCK_RE = new RegExp(`^${BLOCK_PREFIX}([0-9a-z]+)-(\\d+)$`);
/** 拿不到会话令牌时的占位（保持块名形态稳定，而不是让长度乱跳） */
const BLOCK_TOKEN_FALLBACK = 'n0token';

/**
 * 会话令牌 → 块名里那一段。
 *
 * 为什么块名里必须带会话令牌：Azure 的未提交块挂在**目标对象**上（不是挂在某个 UploadId 上），
 * 而「删除未提交块」没有接口（取消掉的上传，其块最长留存 7 天）、容器级的未提交块枚举也不存在
 * —— 于是「上一次会话遗留的块」与「本次会话的块」在云端**不可区分**。
 * 若块名只由分片号决定，一次「取消后重新上传同一路径」就可能让续传判定采信旧会话的块，
 * 提交出一份**新旧拼接、且不报任何错**的文件。带上令牌后，块列表只认本会话那一批；
 * 跨进程重启的断点续传不受影响 —— 会话令牌本就持久化在上传会话记录里。
 */
function blockTokenOf(uploadId) {
  const m = /(?:^|-)([0-9a-f]{8,32})$/i.exec(String(uploadId || ''));
  return (m ? m[1].toLowerCase() : BLOCK_TOKEN_FALLBACK).slice(0, 32);
}

function blockIdOf(partNumber, uploadId) {
  const n = Math.max(1, Math.floor(Number(partNumber) || 1));
  const name = `${BLOCK_PREFIX}${blockTokenOf(uploadId)}-${String(n).padStart(BLOCK_NUM_WIDTH, '0')}`;
  return Buffer.from(name, 'utf8').toString('base64');
}

/** 块名 → 分片号（0 = 不是本实现发出的块名）。令牌比对由调用点负责。 */
function partNumberOf(blockId) {
  let s = '';
  try { s = Buffer.from(String(blockId), 'base64').toString('utf8'); } catch (e) { return 0; }
  const m = BLOCK_RE.exec(s);
  if (!m) return 0;
  const n = Number(m[2]);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 块名 → 会话令牌（'' = 不是本实现发出的块名） */
function blockTokenIn(blockId) {
  let s = '';
  try { s = Buffer.from(String(blockId), 'base64').toString('utf8'); } catch (e) { return ''; }
  const m = BLOCK_RE.exec(s);
  return m ? m[1] : '';
}

/** 逐段百分号编码（保留 `/` 作为分隔符）——与 cos.js 的 encodeCopyPath 同口径 */
function encodeKeyPath(key) {
  return String(key || '').split('/').map(encodeURIComponent).join('/');
}

/**
 * 查询参数按名字升序、值**原样**（不再解码）拼成「一行一个」的签名片段。
 *
 * ⚠️ 规范要求的「字符串到签名里的字段必须 URL 解码」，指的是「服务端把请求行解码之后
 * 得到的那个值」—— 而本函数的入参**就是那个值**：`_queryString()` 在**发送时**才做
 * `encodeURIComponent`。因此这里**不得**再解码一次。
 * 曾经多解了一次，于是键名里含字面 `%XX`（如目录名 `a%20b`，实际发出 `a%2520b`）时，
 * 签名用的是被解成 `a b` 的值、与服务端解出的 `a%20b` 不符 ⇒ 403；
 * 而 `100%` 这类解不开的值又因异常被吞而「偶然正确」，所以问题只在特定名字上暴露。
 */
function canonicalizedQuery(query) {
  const names = Object.keys(query || {}).sort();
  let out = '';
  for (const name of names) {
    const raw = query[name];
    // 同名参数（数组）→ 逗号连接在同一行
    const value = Array.isArray(raw)
      ? raw.map((x) => String(x)).join(',')
      : (raw === undefined || raw === null ? '' : String(raw));
    out += '\n' + name.toLowerCase() + ':' + value;
  }
  return out;
}

class AzureBlobClient {
  /**
   * @param {object} opts { accountName, accountKey, endpoint, bucket(容器), timeout }
   *   `endpoint` 为空时按 Azure 规则由账户名推导：`https://<账户名>.blob.core.windows.net`。
   */
  constructor(opts) {
    const o = opts || {};
    this.accountName = String(o.accountName || '').trim().toLowerCase();
    this.accountKey = String(o.accountKey || '').trim();
    if (!ACCOUNT_NAME_RE.test(this.accountName)) {
      const err = new Error('Azure 存储账户名不合法（应为 3–24 位小写字母或数字）');
      err.status = 400;
      throw err;
    }
    if (!this.accountKey) {
      const err = new Error('缺少 Azure 存储账户密钥');
      err.status = 400;
      throw err;
    }
    const raw = String(o.endpoint || '').trim() || `https://${this.accountName}.blob.core.windows.net`;
    const withProto = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;
    this.endpoint = withProto.replace(/\/+$/, '');
    const u = new URL(this.endpoint);
    this.protocol = u.protocol;
    this.host = u.host;
    /**
     * 端点自带路径前缀（如 `https://host/azure`）时保留 —— 与 s3-client 的 basePath 同义。
     * 注意它**不参与**签名（签名的 CanonicalizedResource 只认 /账户/容器/对象）。
     */
    this.basePath = u.pathname.replace(/\/+$/, '');
    this.container = o.bucket || '';
    this.timeout = Number(o.timeout) || DEFAULT_TIMEOUT_MS;
    /** 账户密钥是 base64；解不开就按原样当字节用（多数情况能解） */
    this._keyBytes = (() => {
      const buf = Buffer.from(this.accountKey, 'base64');
      return buf.length ? buf : Buffer.from(this.accountKey, 'utf8');
    })();
  }

  /* --------------------------- 内部：URL / 签名 --------------------------- */

  /**
   * 容器（= 上层的 Bucket）与对象键 → 请求路径（不含查询串）。
   *
   * ⚠️ `bucket` 为空**不是**「用默认容器」，而是「**账户级**请求」（列容器 `GET /?comp=list`）——
   * 这里若回退到 `this.container`，账户级请求就会打到 `/容器?comp=list` 上，
   * Azure 会把它当成「列该容器下的 Blob（缺 restype）」而返回 400/404。
   * 上层（`cos.js createClient` → `routes/config.js`）确实会构造**不带容器**的客户端，
   * 因此这条分支是真实路径，不是防御性代码。
   */
  _path(bucket, key) {
    const c = String(bucket == null ? '' : bucket);
    const k = String(key || '');
    if (!c) {
      if (k) {
        const err = new Error('缺少容器名（Azure 的「存储桶」即容器）');
        err.status = 400;
        throw err;
      }
      return this.basePath || '/'; // 账户级请求：路径即根
    }
    return this.basePath + '/' + encodeURIComponent(c) + (k ? '/' + encodeKeyPath(k) : '');
  }

  _sign(method, path, query, headers) {
    const now = new Date();
    // RFC 1123 GMT，如 Fri, 26 Jun 2015 23:39:12 GMT
    const xmsDate = now.toUTCString();
    const all = Object.assign({}, headers, {
      'x-ms-date': xmsDate,
      'x-ms-version': API_VERSION,
    });

    // CanonicalizedHeaders：所有 x-ms-* 头，名字小写、按名字升序，每行以 \n 收尾
    const lowered = {};
    for (const [k, v] of Object.entries(all)) lowered[String(k).toLowerCase()] = String(v == null ? '' : v).trim();
    const msNames = Object.keys(lowered).filter((k) => k.startsWith('x-ms-')).sort();
    const canonicalizedHeaders = msNames.map((k) => `${k}:${lowered[k]}\n`).join('');

    // 查询参数：解码后、名字升序、每行一个
    const canonicalizedResource = `/${this.accountName}${path}${canonicalizedQuery(query || {})}`;

    const contentLength = lowered['content-length'];
    const stringToSign = [
      String(method).toUpperCase(),
      lowered['content-encoding'] || '',
      lowered['content-language'] || '',
      // 0 字节请求体在签名串里必须是**空串**（写 "0" 会 403）
      contentLength && Number(contentLength) > 0 ? String(contentLength) : '',
      lowered['content-md5'] || '',
      lowered['content-type'] || '',
      lowered['date'] || '', // 用 x-ms-date 时此行留空
      lowered['if-modified-since'] || '',
      lowered['if-match'] || '',
      lowered['if-none-match'] || '',
      lowered['if-unmodified-since'] || '',
      lowered['range'] || '',
    ].join('\n') + '\n' + canonicalizedHeaders + canonicalizedResource;

    const signature = crypto.createHmac('sha256', this._keyBytes).update(stringToSign, 'utf8').digest('base64');
    return Object.assign({}, all, {
      authorization: `SharedKey ${this.accountName}:${signature}`,
    });
  }

  /** 查询对象 → 查询串（值用 encodeURIComponent，名字保持原样） */
  _queryString(query) {
    const names = Object.keys(query || {}).sort();
    if (!names.length) return '';
    const parts = [];
    for (const name of names) {
      const raw = query[name];
      const list = Array.isArray(raw) ? raw : [raw];
      for (const v of list) {
        if (v === undefined || v === null) continue;
        parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(v))}`);
      }
    }
    return parts.length ? '?' + parts.join('&') : '';
  }

  /**
   * 发一次请求。
   * @param {object} spec { method, bucket, key, query, headers, body(Buffer|string), rawBody, timeoutMs }
   * @returns {Promise<{status:number, headers:object, text:string, res:Response}>}
   */
  async _request(spec) {
    const bucket = spec.bucket !== undefined ? spec.bucket : this.container;
    const path = this._path(bucket, spec.key);
    const query = spec.query || {};
    const headers = Object.assign({}, spec.headers || {});
    let body = null;
    if (spec.body !== undefined && spec.body !== null) {
      body = Buffer.isBuffer(spec.body) ? spec.body : Buffer.from(String(spec.body), 'utf8');
      headers['content-length'] = String(body.length);
    }
    if (headers.host === undefined) headers.host = this.host;
    if (body && !headers['content-type']) headers['content-type'] = 'application/octet-stream';

    const signed = this._sign(spec.method, path, query, headers);
    const target = `${this.protocol}//${this.host}${path}${this._queryString(query)}`;

    const ctl = new AbortController();
    const timer = setTimeout(() => { try { ctl.abort(); } catch (e) { /* ignore */ } }, Number(spec.timeoutMs) || this.timeout);
    let res;
    try {
      res = await fetch(target, {
        method: String(spec.method).toUpperCase(),
        headers: signed,
        body: body || undefined,
        redirect: 'manual', // 与 S3 适配器同一纪律：不跟随重定向（防盲 SSRF）
        signal: ctl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      const err = new Error(e && e.name === 'AbortError' ? '请求超时（Azure 未在限定时间内响应）' : `网络连接异常：${e && e.message}`);
      err.code = e && e.name === 'AbortError' ? 'TimeoutError' : 'NetworkError';
      throw err;
    }
    if (res.status >= 300 && res.status < 400) {
      clearTimeout(timer);
      const loc = res.headers.get('location') || '';
      const err = new Error(`上游端点返回重定向（HTTP ${res.status}${loc ? ' → ' + loc.slice(0, 200) : ''}），已拒绝跟随（防 SSRF）`);
      err.statusCode = 502;
      err.code = 'RedirectNotAllowed';
      throw err;
    }
    // 流式消费的调用方自己清定时器（见 getObject）
    if (spec.rawBody) return { res, headers: res.headers, status: res.status, timer };
    let text = '';
    try { text = await res.text(); } catch (e) { text = ''; }
    clearTimeout(timer);
    const outHeaders = {};
    res.headers.forEach((v, k) => {
      // 元数据统一映射回 x-cos-meta-*，便于上层无差别读取（与 s3-client 同款）
      outHeaders[k] = v;
      if (k.startsWith('x-ms-meta-')) outHeaders['x-cos-meta-' + k.slice('x-ms-meta-'.length)] = v;
    });
    if (!res.ok) throw this._errorFrom(res.status, outHeaders, text);
    return { status: res.status, headers: outHeaders, text, res };
  }

  /** 把 Azure 的错误响应变成带 statusCode / code 的 Error（translateError 依赖这两个字段） */
  _errorFrom(status, headers, text) {
    const code = (headers && headers['x-ms-error-code'])
      || (text ? unescapeXml(tag(text, 'Code')) : '')
      || `HTTP ${status}`;
    const message = (text ? unescapeXml(tag(text, 'Message')) : '') || code;
    const err = new Error(message);
    err.statusCode = status;
    err.code = code;
    return err;
  }

  /** 回调风格适配（与 s3-client._do 同形） */
  _do(cb, fn) {
    const run = Promise.resolve().then(fn);
    if (typeof cb !== 'function') return run;
    run.then((data) => cb(null, data), (err) => cb(err));
    return undefined;
  }

  _ctx(params) {
    const p = params || {};
    return {
      bucket: p.Bucket !== undefined ? p.Bucket : this.container,
      key: p.Key || '',
      region: p.Region || '',
    };
  }

  /* ------------------------------ 服务 / 容器 ------------------------------ */

  /** 列出该账户下的容器（= 上层的「从云端获取桶列表」） */
  getService(params, cb) {
    return this._do(cb, async () => {
      const { text } = await this._request({ method: 'GET', bucket: '', query: { comp: 'list' } });
      const buckets = tagAll(text, 'Container').map((blk) => {
        const name = unescapeXml(tag(blk, 'Name'));
        return {
          Name: name,
          // Azure 不按地域寻址；上层用它做展示与回退，给账户的默认地域即可
          Region: 'auto',
          Location: 'auto',
          CreationDate: tag(blk, 'Last-Modified') || '',
        };
      });
      return { Buckets: buckets, Owner: {} };
    });
  }

  /** 容器是否存在（HEAD /container?restype=container） */
  headBucket(params, cb) {
    return this._do(cb, async () => {
      const { bucket } = this._ctx(params);
      const r = await this._request({ method: 'HEAD', bucket, query: { restype: 'container' } });
      return { __raw: null, headers: r.headers, statusCode: r.status };
    });
  }

  /** 删除容器（Blob 没有「删桶」以外的清空接口；空容器才可删，非空由云端拒绝） */
  deleteBucket(params, cb) {
    return this._do(cb, async () => {
      const { bucket } = this._ctx(params);
      await this._request({ method: 'DELETE', bucket, query: { restype: 'container' } });
      return {};
    });
  }

  /**
   * 列举 Blob（= 上层的 getBucket）。
   *
   * 返回 COS 形状（`Contents` / `CommonPrefixes` / `IsTruncated` / `NextMarker`），
   * `cos.listPage` 据此翻页。Azure 的 `marker` 是**不透明游标**，与原样回传的语义一致。
   */
  getBucket(params, cb) {
    return this._do(cb, async () => {
      const { bucket } = this._ctx(params);
      const query = { restype: 'container', comp: 'list' };
      if (params.Prefix) query.prefix = params.Prefix;
      if (params.Delimiter) query.delimiter = params.Delimiter;
      if (params.Marker) query.marker = params.Marker;
      // Azure 单页上限 5000；上层最多要 1000
      query.maxresults = String(Math.min(5000, Math.max(1, Number(params.MaxKeys) || 1000)));

      const { text } = await this._request({ method: 'GET', bucket, query });
      const contents = tagAll(text, 'Blob').map((blk) => ({
        Key: unescapeXml(tag(blk, 'Name')),
        Size: Number(tag(blk, 'Content-Length')) || 0,
        LastModified: tag(blk, 'Last-Modified') || '',
        ETag: tag(blk, 'Etag') || tag(blk, 'ETag') || '',
        StorageClass: 'STANDARD',
      }));
      const prefixes = tagAll(text, 'BlobPrefix')
        .map((blk) => unescapeXml(tag(blk, 'Name'))).filter(Boolean);
      const truncated = (tag(text, 'NextMarker') || '') !== '';
      return {
        Contents: contents,
        CommonPrefixes: prefixes.map((x) => ({ Prefix: x })),
        IsTruncated: truncated ? 'true' : 'false',
        NextMarker: truncated ? unescapeXml(tag(text, 'NextMarker')) : '',
        Name: bucket,
      };
    });
  }

  /**
   * 容器公开访问级别 → 上层统一的 ACL 结构。
   *
   * Azure 只有三档：私有 / `blob`（匿名可读单个 Blob）/ `container`（匿名可读并列目录）。
   * **没有匿名写**，因此映射出来的永远是 private 或 public-read —— 这一点必须如实反映，
   * 否则「公开可写」告警会把私有的 Azure 容器误报成高危。响应头 `x-ms-blob-public-access`
   * 只在非私有时出现，缺失即私有（无该头时按 private 处理）。
   */
  getBucketAcl(params, cb) {
    return this._do(cb, async () => {
      const { bucket } = this._ctx(params);
      const { headers } = await this._request({
        method: 'GET', bucket, query: { restype: 'container', comp: 'acl' },
      });
      const level = String(headers['x-ms-blob-public-access'] || '').toLowerCase();
      const isPublic = level === 'blob' || level === 'container';
      return {
        Grants: isPublic
          ? [{
            Grantee: { URI: 'http://acs.amazonaws.com/groups/global/AllUsers', ID: '', DisplayName: '' },
            Permission: 'READ',
          }]
          : [],
        Owner: {},
        // 兜底字段（evalBucketAcl 的 canned 分支），与 Grants 保持同一口径
        ACL: isPublic ? 'public-read' : 'private',
        // 便于界面/日志如实展示 Azure 的实际级别
        AzurePublicAccess: level,
      };
    });
  }

  /* ------------------------------ 对象读写 ------------------------------ */

  /**
   * 自定义元数据头：`x-cos-meta-*`（上层统一命名）→ `x-ms-meta-*`（Azure 只认后者）。
   *
   * `putObject` 与 `multipartComplete` 共用（R36）：Azure 与 S3 的关键差异是，
   * 它的块列表提交（Put Block List）**仍接受** `x-ms-meta-*` —— 于是分片上传的
   * 元数据既可以在提交时写入，也可以只在单请求 Put Blob 时写入；两处走同一个映射，
   * 才不会出现「小文件有上传者、大文件没有」的分裂。
   */
  _metaHeaders(headers) {
    const out = {};
    for (const [k, v] of Object.entries(headers || {})) {
      const lk = String(k).toLowerCase();
      if (lk.startsWith('x-cos-meta-')) out['x-ms-meta-' + lk.slice('x-cos-meta-'.length)] = String(v);
    }
    return out;
  }

  /** 上传单个对象（单请求 Put Blob，块类型 BlockBlob） */
  putObject(params, cb) {
    return this._do(cb, async () => {
      const { bucket, key } = this._ctx(params);
      const headers = Object.assign({ 'x-ms-blob-type': 'BlockBlob' }, this._metaHeaders(params.Headers));
      if (params.ContentType) headers['content-type'] = String(params.ContentType);
      const r = await this._request({
        method: 'PUT', bucket, key, headers, body: params.Body === undefined ? Buffer.alloc(0) : params.Body,
      });
      return { ETag: r.headers.etag || '' };
    });
  }

  headObject(params, cb) {
    return this._do(cb, async () => {
      const { bucket, key } = this._ctx(params);
      const r = await this._request({ method: 'HEAD', bucket, key });
      return { headers: r.headers, statusCode: r.status };
    });
  }

  /**
   * 下载对象：`params.Output` 是可写流时流式转发，否则整段缓冲返回 `{ Body }`。
   *
   * 流式判据必须是「有 pipe 方法」而不是「是函数」—— 上层四处传的都是 `PassThrough`
   * （`typeof` 为 `object`），判错会让对象被无界读进内存、调用方的流永不 end
   * （这正是 S3 适配器 R14-01 那次事故的形态，此处刻意照抄同一判据）。
   */
  getObject(params, cb) {
    return this._do(cb, async () => {
      const { bucket, key } = this._ctx(params);
      const headers = {};
      if (params.Range) headers.range = String(params.Range);
      const { res, timer } = await this._request({
        method: 'GET', bucket, key, headers, rawBody: true, timeoutMs: params.__timeoutMs,
      });
      if (!res.ok) {
        clearTimeout(timer);
        let text = '';
        try { text = await res.text(); } catch (e) { /* 以状态行为准 */ }
        const hdrs = {};
        res.headers.forEach((v, k) => { hdrs[k] = v; });
        throw this._errorFrom(res.status, hdrs, text);
      }
      const outHeaders = {};
      res.headers.forEach((v, k) => {
        outHeaders[k] = v;
        if (k.startsWith('x-ms-meta-')) outHeaders['x-cos-meta-' + k.slice('x-ms-meta-'.length)] = v;
      });
      const clear = () => clearTimeout(timer);
      const out = params.Output;
      if (out && typeof out.pipe === 'function') {
        const stream = Readable.fromWeb(res.body);
        stream.once('end', clear);
        stream.once('close', clear);
        stream.once('error', clear);
        pipeline(stream, out, (pipeErr) => {
          clear();
          if (pipeErr) out.destroy(pipeErr);
        });
        return { headers: outHeaders, statusCode: res.status };
      }
      let body = Buffer.alloc(0);
      try {
        body = Buffer.from(await res.arrayBuffer());
      } finally {
        clear();
      }
      return { Body: body, headers: outHeaders, statusCode: res.status };
    });
  }

  /**
   * 「这个对象 / 容器已经不存在了」——**删除族操作的唯一判据**。
   *
   * 为什么必须统一：S3 的 `DeleteObject` 对不存在的键返回 204（协议本身就是**幂等**的），
   * 腾讯云同理；Azure 却回 404 `BlobNotFound`。若单删直接抛出、批删却算作已删，
   * 同一份代码里就有了两套口径，表现为「同一次删除：走 `/fs/delete` 成功、走 WebDAV 失败」
   * （客户端重试一次 DELETE 就从成功变成报错）。上层的「幂等重试」预期来自**厂商族**，
   * 故统一按「已达成删除」处理。
   * `ContainerNotFound` 同理：容器都没了，里面的对象自然也不在。
   */
  _isGone(e) {
    const code = (e && e.code) || '';
    return Number(e && e.statusCode) === 404
      || code === 'BlobNotFound' || code === 'ContainerNotFound';
  }

  deleteObject(params, cb) {
    return this._do(cb, async () => {
      const { bucket, key } = this._ctx(params);
      try {
        await this._request({ method: 'DELETE', bucket, key });
      } catch (e) {
        if (!this._isGone(e)) throw e; // 本就不存在 = 已达成删除（与 S3 / COS 的幂等语义一致）
      }
      return {};
    });
  }

  /**
   * 批量删除（Azure 的 Batch API 需要 multipart/mixed 与专用端点，这里改为受控并发逐删）。
   *
   * 返回 COS 形状，且**只把云端明确确认删除的 key 放进 `Deleted`**：
   *  - 2xx 与 404 都算「已删除」（与 S3 `DeleteObjects` 的幂等语义一致：本来就不存在
   *    也报告为 Deleted）—— 上层据此清加密元数据 / 标记分享链接失效，语义必须一致；
   *  - 其余错误逐条进 `Error`，让上层**不做**任何元数据清理（保守取向）。
   */
  deleteMultipleObject(params, cb) {
    return this._do(cb, async () => {
      const { bucket } = this._ctx(params);
      const objects = Array.isArray(params.Objects) ? params.Objects : [];
      const deleted = [];
      const errors = [];
      const CONCURRENCY = 4;
      let idx = 0;
      const worker = async () => {
        while (idx < objects.length) {
          const o = objects[idx++];
          const k = o && o.Key;
          if (k === undefined) continue;
          try {
            await this._request({ method: 'DELETE', bucket, key: k });
            deleted.push({ Key: k });
          } catch (e) {
            const code = (e && e.code) || '';
            if (this._isGone(e)) {
              deleted.push({ Key: k }); // 幂等：不存在即已达成删除（判据与单删同源，见 _isGone）
            } else {
              errors.push({ Key: k, Code: code || 'DeleteFailed', Message: (e && e.message) || '删除失败' });
            }
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, objects.length) }, worker));
      return { Deleted: deleted, Error: errors };
    });
  }

  /**
   * 复制单个对象（Copy Blob，服务端复制）。
   *
   * `params.CopySource` 由 `cos.copySource()` 给出，形如 `/<容器>/<已编码的键>`（与本项目
   * 的 S3 路径同一形状）—— 这里把它还原成 Azure 需要的**绝对 URL**：
   * `https://<账户>.blob.core.windows.net/<容器>/<键>`。键保持已编码状态（复制源 URL 必须编码）。
   *
   * 大对象（>256 MiB）Azure 不允许同步复制，会返回 `x-ms-copy-status: pending`；这里随后
   * **轮询目标 Blob 的复制状态**直到 success/failed（有上限），而不是把 pending 当成功 ——
   * 上层会在复制成功后迁移加密元数据，提前返回等于把元数据搬到一个还没写完的对象上。
   */
  putObjectCopy(params, cb) {
    return this._do(cb, async () => {
      const { bucket, key } = this._ctx(params);
      const source = this._copySourceUrl(params.CopySource);
      const headers = { 'x-ms-copy-source': source };
      // 同账户内的小对象走同步复制，省掉一次轮询（失败会退回异步，见下）
      if (params.RequiresSync !== false) headers['x-ms-requires-sync'] = 'true';

      let status = '';
      try {
        const r = await this._request({ method: 'PUT', bucket, key, headers });
        status = String(r.headers['x-ms-copy-status'] || 'success').toLowerCase();
      } catch (e) {
        /**
         * 同步复制超过大小上限时 Azure 会拒绝（CannotVerifyCopySource / InvalidHeaderValue 等），
         * 此时退回**异步复制**再轮询 —— 否则大对象复制在本项目里直接失败。
         */
        if (!headers['x-ms-requires-sync']) throw e;
        delete headers['x-ms-requires-sync'];
        const r2 = await this._request({ method: 'PUT', bucket, key, headers });
        status = String(r2.headers['x-ms-copy-status'] || 'pending').toLowerCase();
      }
      if (status === 'pending') await this._pollCopy(bucket, key);
      return { ETag: '', CopyStatus: status };
    });
  }

  /**
   * 复制源 → 绝对 URL（已是 URL 的原样返回）。
   *
   * ⚠️ 必须跟随**本客户端自己解析出来的端点**（`protocol` / `host` / `basePath`），
   * 不能硬拼 `<账户>.blob.core.windows.net`：主权云（Azure 中国 / US Gov）与本地模拟器
   * （Azurite，端点形如 `http://127.0.0.1:10000/devstoreaccount1`）的域名与路径前缀都不同，
   * 而「端点可由用户覆盖」恰恰就是为这两类场景准备的 —— 硬拼会让复制 / 移动 / 重命名
   * （含 WebDAV 的 COPY / MOVE 与大对象的 sliceCopyFile）在它们上面**必然失败**：
   * 请求会打到一台不属于该账户的公有云主机上（表现为 `CannotVerifyCopySource`）。
   */
  _copySourceUrl(src) {
    const s = String(src || '').trim();
    if (/^https?:\/\//i.test(s)) return s;
    const p = s.startsWith('/') ? s : '/' + s;
    return `${this.protocol}//${this.host}${this.basePath}${p}`;
  }

  /** 轮询异步复制的状态（上限约 5 分钟；未完成即报错，绝不假装成功） */
  async _pollCopy(bucket, key) {
    const MAX_TRIES = 150;
    const GAP_MS = 2000;
    for (let i = 0; i < MAX_TRIES; i++) {
      await new Promise((r) => setTimeout(r, GAP_MS));
      const r = await this._request({ method: 'HEAD', bucket, key });
      const st = String(r.headers['x-ms-copy-status'] || '').toLowerCase();
      if (st === 'success') return;
      if (st === 'failed' || st === 'aborted') {
        const err = new Error(`云端复制失败（状态：${st}）`);
        err.statusCode = 500;
        err.code = 'CopyFailed';
        throw err;
      }
    }
    const err = new Error('云端复制仍未完成（等待超时），请稍后在属性面板确认后再重试');
    err.statusCode = 504;
    err.code = 'CopyPending';
    throw err;
  }

  /** 分块复制：Azure 的 Copy Blob 已是服务端复制，无大小上限，直接复用 */
  sliceCopyFile(params, cb) {
    return this.putObjectCopy(params, cb);
  }

  /* ------------------------------ 分片（Block Blob） ------------------------------ */

  /**
   * 「初始化分片上传」：Azure 没有 UploadId 握手 —— 块是直接 PUT 到目标 Blob 上的，
   * 只有 commit 时才把这些块拼成一个 Blob。因此这里**不发请求**，只签发一个会话令牌，
   * 上层拿它当 `sess.uploadId` 存续（chunk/complete 会原样带回来）。
   *
   * ⚠️ 这个令牌**必须进块名**（见 `blockTokenOf`）：块在云端挂在目标对象上、按会话区分不了，
   * 而取消掉的上传其块最长留存 7 天，所以令牌是「只认自己那一批块」的唯一凭据。
   * 它由上层持久化在上传会话记录里，因此跨进程重启的断点续传照样成立。
   */
  multipartInit(params, cb) {
    return this._do(cb, async () => {
      const { bucket, key } = this._ctx(params);
      return { Bucket: bucket, Key: key, UploadId: 'azure-block-' + crypto.randomBytes(12).toString('hex') };
    });
  }

  /** 上传一个块（Put Block） */
  multipartUpload(params, cb) {
    return this._do(cb, async () => {
      const { bucket, key } = this._ctx(params);
      const partNumber = Number(params.PartNumber) || 1;
      const blockId = blockIdOf(partNumber, params.UploadId);
      await this._request({
        method: 'PUT', bucket, key,
        query: { comp: 'block', blockid: blockId },
        body: params.Body === undefined ? Buffer.alloc(0) : params.Body,
      });
      /**
       * Azure 的 Put Block 不返回可用的 ETag（分片由**块名**引用，提交时也不需要 ETag），
       * 但上层会把这里返回的 ETag 记进上传会话并在 `multipartComplete` 里回传，
       * 且 `setPart` 的入参为字符串 —— 因此回一个**与块名一致**的合成 ETag：
       * 非空、可在断点续传时由 `multipartListPart` 复现同一个值，语义自洽。
       */
      return { ETag: blockId };
    });
  }

  /** 提交块列表（Put Block List）——顺序即 Parts 的顺序，用 Latest 以兼容已提交块 */
  multipartComplete(params, cb) {
    return this._do(cb, async () => {
      const { bucket, key } = this._ctx(params);
      const parts = (params.Parts || []).slice()
        .sort((a, b) => Number(a.PartNumber) - Number(b.PartNumber));
      const xml = '<?xml version="1.0" encoding="UTF-8"?><BlockList>'
        + parts.map((p) => `<Latest>${blockIdOf(p.PartNumber, params.UploadId)}</Latest>`).join('')
        + '</BlockList>';
      const r = await this._request({
        method: 'PUT', bucket, key,
        query: { comp: 'blocklist' },
        headers: Object.assign({ 'content-type': 'application/xml' }, this._metaHeaders(params.Headers)),
        body: xml,
      });
      return { Location: '', Bucket: bucket, Key: key, ETag: r.headers.etag || '' };
    });
  }

  /**
   * 中止分片上传：Azure 的未提交块没有删除接口（7 天后自动过期），只能提交或放着。
   * 这里如实返回空结果 —— 调用方只是「丢掉会话」，不会因此认为云端已清理干净。
   */
  multipartAbort(params, cb) {
    return this._do(cb, async () => ({}));
  }

  /**
   * 列出该对象上尚未提交的块（断点续传用）：由 base64 块名反解分片号。
   *
   * ⚠️ **只发一次请求，不翻页。** Get Block List 没有翻页参数（Azure 的请求参数只有
   * `comp` / `blocklisttype` / `timeout` / `snapshot` / `versionid`），响应里也没有
   * `NextMarker`。旧实现写了一个 `marker` 循环，但那个变量**从未进入请求**
   * ——`if (marker) query['blocklisttype'] = 'uncommitted'` 是把 `marker` 写成了
   * `blocklisttype` 的**空操作**（该值本来就是这个）。于是只要服务端真的回了游标，
   * 第二圈就会原样重取第一页、把同一批分片**再累加一次**（实测返回 `[1,2,1,2]`）。
   *
   * 这不是无害的重复：`routes/fs.js` 的续传闸门拿 `Σ size` 当「已落云、不必再计入
   * 配额」的字节数，重复项会把它翻倍，`netAdd = size - already` 被低估（可低到 0），
   * 相当于**放松配额判定**（fail-open）。因此这里按服务端真实契约只取一页，并额外按
   * 分片号去重（同一块名重复出现时只记一次），使「服务端多给了什么」都不至于污染账目。
   *
   * ⚠️ 另一半判据是**会话令牌**：未提交块在云端挂在目标对象上，`blocklisttype=uncommitted`
   * 返回的是该对象下**全部**未提交块 —— 不按令牌过滤就会把「上一次会话遗留的块」
   * （取消掉的上传，其块最长留存 7 天）当成本次已落云的进度，从而跳过本应重传的分片。
   * 故这里只认块名里的令牌等于本次 `UploadId` 的那些（见 `blockTokenOf`）。
   */
  multipartListPart(params, cb) {
    return this._do(cb, async () => {
      const { bucket, key } = this._ctx(params);
      const { text } = await this._request({
        method: 'GET', bucket, key, query: { comp: 'blocklist', blocklisttype: 'uncommitted' },
      });
      const own = blockTokenOf(params.UploadId);
      const parts = [];
      const seen = new Set();
      for (const blk of tagAll(text, 'Block')) {
        const name = tag(blk, 'Name');
        if (blockTokenIn(name) !== own) continue; // 他次会话的遗留块：不认，否则会跳过本应重传的分片
        const n = partNumberOf(name);
        if (!n || seen.has(n)) continue;
        seen.add(n);
        parts.push({
          PartNumber: n,
          // 与 multipartUpload 同一套合成 ETag（块名），断点续传时两侧一致
          ETag: name,
          Size: Number(tag(blk, 'Size')) || 0,
          LastModified: '',
        });
      }
      return {
        ListPartsResult: {
          Part: parts, IsTruncated: 'false', Key: key, UploadId: params.UploadId || '',
        },
      };
    });
  }

  /**
   * 列出「未完成的分片上传」：Azure 不提供容器级的未提交块枚举
   * （块只挂在具体 Blob 上，且没有 List Uncommitted Blocks 的容器级接口），
   * 因此如实返回空列表 —— 界面上的「碎片」对 Azure 恒为 0，而不是给一个假数字。
   * 未提交块会在 7 天后由 Azure 自动回收，不会持续计费。
   */
  multipartList(params, cb) {
    return this._do(cb, async () => ({
      ListUploadsResult: { Upload: [], IsTruncated: 'false', NextKeyMarker: '', NextUploadIdMarker: '' },
    }));
  }

  /** 桶容量统计：Azure 无 `?stats` 类接口，交给上层回退到对象列举统计 */
  request(params, cb) {
    return this._do(cb, async () => {
      const err = new Error('NotImplemented: operation not supported by this provider');
      err.statusCode = 501;
      err.code = 'NotImplemented';
      throw err;
    });
  }

  /* ------------------------------ 预签名（SAS） ------------------------------ */

  /**
   * 生成 Blob 的**服务 SAS** 只读直链（等价于其它厂商的预签名 URL）。
   *
   * StringToSign 的字段顺序由 API 版本决定（`2020-12-06` 起为 16 段，含 `sst` / `ses`）：
   * `sp st se canonicalizedResource si sip spr sv sr sst ses rscc rscd rsce rscl rsct`
   * 本实现只用到 `sp=r` / `st` / `se` / `sv` / `sr=b`，其余留空 —— 但**留空也要占位**，
   * 少一段就会得到 403 `AuthenticationFailed`。
   */
  getObjectUrl(params, cb) {
    const run = () => {
      const bucket = params.Bucket !== undefined ? params.Bucket : this.container;
      const key = params.Key || '';
      if (String(params.Sign) === 'false' || params.Sign === false) {
        return { Url: `${this.protocol}//${this.host}${this._path(bucket, key)}` };
      }
      const seconds = Math.max(1, Math.min(7 * 24 * 3600, Number(params.Expires) || 3600));
      const now = new Date();
      const fmt = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
      const st = fmt(new Date(now.getTime() - 5 * 60 * 1000)); // 回拨 5 分钟，容忍时钟漂移
      const se = fmt(new Date(now.getTime() + seconds * 1000));
      const path = this._path(bucket, key);
      /**
       * ⚠️ 「服务 SAS」的规范资源与「独占授权」的**不是同一套规则**，别互相照抄：
       *  - 独占授权（`Authorization: SharedKey` 头，见 `_sign`）：`/<账户><请求行里的路径>`，不含服务名；
       *  - 服务 SAS（本处）：`/blob/<账户>/<容器>/<Blob>` —— **2015-02-21 起必须带服务名 `/blob`**，
       *    且规范要求字段**必须 URL 解码**。
       * 两处拼错都只会得到 403 `AuthenticationFailed`，响应里不带任何线索，只能对着规范串核。
       * 这里用**原始的**容器名与键，而不是 `_path()` 的已编码结果：Azure 是把请求行里的路径
       * 解码之后再比对，而键里的字面 `%` 经 `encodeURIComponent` 发出、被解码回来后恰好还原成本处的原始值。
       */
      const canonicalizedResource = `/blob/${this.accountName}/${bucket}`
        + (key ? '/' + String(key) : '');
      const stringToSign = [
        'r', // sp
        st, // st
        se, // se
        canonicalizedResource, // canonicalizedResource
        '', // si  (signed identifier)
        '', // sip (signed IP)
        '', // spr (signed protocol)
        API_VERSION, // sv
        'b', // sr  (blob)
        '', // sst (snapshot time)
        '', // ses (encryption scope)
        '', // rscc
        '', // rscd
        '', // rsce
        '', // rscl
        '', // rsct
      ].join('\n');
      const sig = crypto.createHmac('sha256', this._keyBytes).update(stringToSign, 'utf8').digest('base64');
      const q = [
        `sv=${encodeURIComponent(API_VERSION)}`,
        `st=${encodeURIComponent(st)}`,
        `se=${encodeURIComponent(se)}`,
        'sr=b',
        'sp=r',
        `sig=${encodeURIComponent(sig)}`,
      ].join('&');
      return { Url: `${this.protocol}//${this.host}${path}?${q}` };
    };
    try {
      const out = run();
      if (typeof cb === 'function') cb(null, out);
      return out;
    } catch (e) {
      if (typeof cb === 'function') return cb(e);
      throw e;
    }
  }
}

module.exports = { AzureBlobClient, ACCOUNT_NAME_RE, blockIdOf, partNumberOf, API_VERSION, MAX_PUT_BLOB };
