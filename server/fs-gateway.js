/**
 * 统一文件网关 —— 所有对象存储读写操作的唯一入口
 *
 * 职责：透明加密/解密 + 加密元数据管理 + 审计日志。
 * routes.js 与 webdav-server.js 通过此模块操作文件，杜绝：
 *   1. WebDAV PUT 明文写入（加密模式下未加密即上传）
 *   2. WebDAV GET 直接下发云端密文（用户拿到不可解读的字节流，编辑回写即永久损坏）
 *   3. WebDAV DELETE/COPY/MOVE 不联动加密元数据（残留/漂移/错配）
 *   4. 全链路无审计日志（无法追溯泄露或误操作）
 *
 * 加密语义：
 *   - currentMode === 'none'：plain 路径，不加密、不记录元数据，行为与旧版一致
 *   - crypto / magic：写操作自动加密 Buffer→云端存储（流式 PUT 先缓冲全量，超限拒绝）；
 *     读操作自动对接 encStore.decryptTransform 透明解密下游明文；
 *     删/移/复同步联动 enc-meta.json
 *
 * 注意：本模块不替代对象存储 SDK 的直接列举（listObjects / listLevel），仅封装文件内容的读写与删除。
 */
const { PassThrough, pipeline } = require('stream');
const configStore = require('./config-store');
const encStore = require('./enc-store');
const statsStore = require('./stats-store');
const shareStore = require('./share-store'); // R7-03：删对象必须同步标记分享链接
const { getClient, p, translateError, listAllInfo, listAllExact, LIMITS, normalizeKey, copySource } = require('./cos');
const { deleteMultipleConfirmed } = require('./cos'); // R10-03：批量删除的白名单判据（共用）
const providers = require('./providers');

/* ============================ 并发与内存保护 ============================ */

/**
 * 加密文件 Range 请求的内存切片上限（超出即退化为全量流式解密）
 *
 * PERF-16：原为 128MB，配 `MAX_ENCRYPT_READERS = 3` 意味着峰值 ≈ 384MB 纯缓冲区
 * （还不含 PassThrough 与 V8 开销），且视频每次 seek 都要**重新全量解密**。
 * 降到 32MB 后峰值 ≈ 96MB；更大文件走全量流式，反而更快也更省。
 */
const MAX_RANGE_BUFFER = 32 * 1024 * 1024;
/** 流式写入（WebDAV PUT）的全量缓冲上限（P8：512MB → 128MB，防并发 OOM） */
const MAX_WRITE_BUFFER = 128 * 1024 * 1024;
/** 加密文件并发读取信号量上限（N4：限制同时解密的大文件数，避免内存线性增长） */
const MAX_ENCRYPT_READERS = 3;
/** 单次 PUT Copy 的服务端上限：超过必须走分块复制 —— 与 routes/fs.js 共用 limits.js 的同一份定义 */
const COPY_SIMPLE_LIMIT = LIMITS.COPY_SIMPLE_LIMIT;
let activeEncryptReaders = 0; // 当前正在进行的加密文件读取数
const encryptReaderQueue = []; // 排队等待的读取请求

/** 获取一个加密读取令牌；无空位时排队等待（先进先出） */
function acquireEncryptReader() {
  return new Promise((resolve) => {
    if (activeEncryptReaders < MAX_ENCRYPT_READERS) { activeEncryptReaders++; resolve(); return; }
    encryptReaderQueue.push(resolve);
  });
}

/**
 * 释放令牌。
 *
 * FUN-02：必须是**幂等**的，且带下界保护。
 * 旧实现无条件 `activeEncryptReaders--`，而调用方对同一个流同时挂了
 * `close` 与 `error` 两个回调 —— Node 的可销毁流在带错误销毁时会**先 emit error、
 * 再 emit close**，于是计数被减两次、漂移为负数；此后 `activeEncryptReaders < 3`
 * 恒为真，**并发上限永久失效（fail-open）**，排空队列也再不推进。
 *
 * 现在：① 返回一个只生效一次的包装函数（配 `once` 使用）；
 *       ② 内部再做下界保护，任何路径都不会把计数减到 0 以下。
 */
/**
 * 读取令牌的「交接兜底」（R7-08）。
 *
 * 释放令牌原本**完全外包给了调用方**：只在返回流的 `close` / `error` 上释放。
 * 而调用方（如 WebDAV）是在 `readObject()` 返回**之后**才 `pipe` —— 客户端若在这段
 * 等待期（尤其是排队等令牌的期间）断开，返回的流既没有消费者、也没有人 destroy，
 * `close` 永远不会触发 → 令牌永久泄漏。攒够 3 个（MAX_ENCRYPT_READERS）之后，
 * 所有加密读都会无限排队直到超时。
 *
 * 因此网关自己兜底：流一旦交出去，若在一定时间内**没有任何消费者接管**
 * （既没有 `pipe` 也没有 `data`），就销毁它 —— 销毁会触发 `close`，幂等释放器随即归还令牌。
 * 已经接管的流不受影响（定时器在接管那一刻就被取消）。
 */
const DEFAULT_READER_HANDOFF_MS = 60 * 1000;
let readerHandoffMs = DEFAULT_READER_HANDOFF_MS;

function armReaderHandoff(stream, release) {
  let taken = false;
  const taken_ = () => { taken = true; clearTimeout(timer); };
  stream.once('pipe', taken_);
  stream.once('data', taken_);
  const timer = setTimeout(() => {
    if (taken) return;
    taken = true;
    try { stream.destroy(); } catch (e) { /* 已销毁 */ }
    release(); // 幂等：destroy 触发的 close 也会走同一个释放器
  }, readerHandoffMs);
  if (typeof timer.unref === 'function') timer.unref(); // 不阻止进程退出
}

function makeEncryptReaderReleaser() {
  let released = false;
  return function release() {
    if (released) return;
    released = true;
    if (activeEncryptReaders > 0) {
      activeEncryptReaders--;
    } else {
      // 计数不可能为负；出现即说明释放路径有漏改（不要静默吞掉）
      console.error('[fs-gateway] 加密读取信号量异常：release 时计数已为 0，已忽略');
    }
    const next = encryptReaderQueue.shift();
    if (next) { activeEncryptReaders++; next(); }
  };
}

/* ============================ 内部工具 ============================ */

/** 配置与对象存储客户端校验 */
function requireCfgCos() {
  const cfg = configStore.get();
  // 地域仅在厂商要求时才必填（如又拍云 S3 兼容接口无需地域）
  const prov = providers.get(cfg && cfg.provider) || providers.resolve(cfg && cfg.provider);
  const needRegion = prov.regionRequired !== false;
  if (!cfg || !cfg.secretId || !cfg.secretKey || !cfg.bucket || (needRegion && !cfg.region)) {
    const e = new Error('尚未配置对象存储访问密钥与存储桶');
    e.status = 428;
    throw e;
  }
  return { cfg, cos: getClient(cfg) };
}

/**
 * 将可读流完整收集为 Buffer（用于加密前缓冲）。
 * @param {Readable} stream
 * @param {number} maxBytes 最大允许字节数（超出即拒绝，防止 OOM）
 * @returns {Promise<Buffer>}
 */
function bufferStream(stream, maxBytes = MAX_WRITE_BUFFER) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    stream.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        stream.destroy();
        const e = new Error(`上传数据超过上限（${Math.round(maxBytes / 1024 / 1024)}MB），请使用管理端的分片上传`);
        e.status = 413;
        reject(e);
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/* ============================ 读操作 ============================ */

/**
 * 读取对象内容，透明解密
 * @param {string} bucket
 * @param {string} key
 * @param {object}  opts { range?: string, decrypt?: boolean }  默认 decrypt=true
 * @returns {Promise<{ stream: Readable, contentType: string, contentLength: number,
 *                     encrypted: bool, origSize: number, lastModified: string, etag: string }>}
 *
 * 说明：encrypted 对象 + Range 请求时，会完整下载解密后在内存中切片；
 *       若明文大小超过固定上限（`MAX_RANGE_BUFFER`，R11-19：注释里的 128MB 是
 *       PERF-16 降半后忘记同步的旧值，实际为 32MB），退化为全量流式解密
 *       （返回 200，忽略 Range），避免单请求 O(origSize) 内存占用；
 *       非加密文件 Range 由对象存储原生处理。
 */
async function readObject(bucket, key, opts = {}) {
  const k = normalizeKey(key);
  const { cfg, cos } = requireCfgCos();
  const shouldDecrypt = opts.decrypt !== false;
  const encMeta = shouldDecrypt ? encStore.getMeta(cfg.bucket, k) : null;
  const range = String(opts.range || '').trim() || null;

  // 加密对象 + 需要解密
  if (encMeta) {
    // 先 HEAD 获取对象存储侧属性
    const head = await p(cos, 'headObject', { Bucket: cfg.bucket, Region: cfg.region, Key: k }, { noStat: true });
    const ct = head.headers['content-type'] || 'application/octet-stream';
    // 加密读取走信号量，限制并发解密，避免多路大文件同时占用内存
    await acquireEncryptReader();
    // 本次获取对应的**唯一**释放器（幂等）：无论走 Range 缓冲分支还是流式分支，
    // 也无论正常结束还是出错销毁，都只会真正释放一次（FUN-02）。
    const releaseReader = makeEncryptReaderReleaser();

    // R11-10：判据与 HEAD 同源（rangeServable），不再各写一遍 `<= MAX_RANGE_BUFFER`
    // —— 否则加密空文件上「HEAD 能服务、GET 却 400」这类分叉还会再次出现
    if (range && rangeServable({ encrypted: true, origSize: encMeta.origSize })) {
      try {
        // Range 请求 + 明文 ≤ MAX_RANGE_BUFFER：完整下载解密后内存切片
        const maxRange = MAX_RANGE_BUFFER;
        const pass = new PassThrough();
        const cosStream = new PassThrough();
        cos.getObject({ Bucket: cfg.bucket, Region: cfg.region, Key: k, Output: cosStream }, (err) => {
          if (err) { cosStream.destroy(err); pass.destroy(err); }
        });
        const decryptor = encStore.decryptTransform(encMeta);
        pipeline(cosStream, decryptor, pass, (pipeErr) => {
          if (pipeErr) pass.destroy(pipeErr);
        });
        const plainBuf = await bufferStream(pass, maxRange);
        const { start, end } = parseRange(range, plainBuf.length);
        const sliced = plainBuf.slice(start, end + 1);
        const result = new PassThrough();
        result.end(sliced);
        return {
          stream: result, encrypted: true, origSize: encMeta.origSize,
          contentType: ct, contentLength: sliced.length,
          lastModified: head.headers['last-modified'] || '',
          etag: head.headers.etag || '',
          rangeServed: true, range: { start, end, total: plainBuf.length },
        };
      } finally {
        releaseReader();
      }
    }

    // 无 Range，或明文超过内存上限（退化为全量流式解密，忽略 Range）
    try {
      const cosStream = new PassThrough();
      cos.getObject({ Bucket: cfg.bucket, Region: cfg.region, Key: k, Output: cosStream }, (err) => {
        if (err) { cosStream.destroy(err); }
      });
      const decryptor = encStore.decryptTransform(encMeta);
      const out = new PassThrough();
      pipeline(cosStream, decryptor, out, (pipeErr) => {
        if (pipeErr) out.destroy(pipeErr);
      });
      // 流式解密结束后释放令牌。
      // FUN-02：错误销毁会**先 error 后 close**，两者都必须能触发释放；
      // 用 once 绑定同一个幂等释放器，既保证一定能释放，也保证只释放一次。
      out.once('close', releaseReader);
      out.once('error', releaseReader);
      armReaderHandoff(out, releaseReader); // R7-08：无人接管时兜底释放
      return {
        stream: out, encrypted: true, origSize: encMeta.origSize,
        contentType: ct, contentLength: encMeta.origSize,
        lastModified: head.headers['last-modified'] || '',
        etag: head.headers.etag || '',
        rangeServed: false,
      };
    } catch (e) {
      releaseReader();
      throw e;
    }
  }

  // 非加密对象：云端直读
  const head = await p(cos, 'headObject', { Bucket: cfg.bucket, Region: cfg.region, Key: k }, { noStat: true });
  const total = Number(head.headers['content-length']) || 0;
  const ct = head.headers['content-type'] || 'application/octet-stream';

  /**
   * R9-04：Range 必须**如实回 206 + 区间长度**，不能声明全量长度却只发一段。
   *
   * 旧实现把 `Range` 转给云端（云端只回该区间），但返回的 `contentLength` 却是
   * `headObject` 的**全量**长度、`rangeServed` 恒为 false。调用方据此发
   * `200 + Content-Length: 全量`，body 里只有区间字节 → 客户端按 `Content-Length`
   * 等剩余字节，最终报「传输被提前关闭」；大文件表现为**下载损坏 / 播放失败**。
   * （VLC / PDF 阅读器 / Office / 多线程下载器的续传都走这条路径。）
   *
   * 尤其矛盾的是：同一轮里 HEAD 刚被改成如实宣告 `Accept-Ranges: bytes` 并对
   * `Range` 回 206 —— 于是 HEAD 说"支持续传"、GET 给出损坏的结果，协议两端自相矛盾。
   * 这与刚修掉的 R8-23（`/s/:id/dl` 宣告 `Accept-Ranges` 却从不处理 Range）是同一个
   * 「宣告了未实现的能力」，只是从分享页搬到了 WebDAV。
   *
   * 做法与加密分支的 Range 路径保持同一口径：本地 `parseRange` 解析命中区间，
   * 再把**归一化后**的 Range 交给云端（`bytes=start-end`），并把长度/区间如实回传。
   * `parseRange` 在越界时抛 416，此处如实透传（与加密分支一致）。
   */
  let served = null;
  if (range && total > 0) {
    served = parseRange(range, total); // 抛 416 / 400，由调用方透传
  }
  const cloudRange = served ? `bytes=${served.start}-${served.end}` : null;

  const cosStream = new PassThrough();
  const cosOpts = { Bucket: cfg.bucket, Region: cfg.region, Key: k, Output: cosStream };
  if (cloudRange) cosOpts.Range = cloudRange;
  cos.getObject(cosOpts, (err) => {
    if (err && !cosStream.destroyed) cosStream.destroy(err);
  });
  return {
    stream: cosStream, encrypted: false, origSize: total,
    contentType: ct,
    contentLength: served ? served.end - served.start + 1 : total,
    lastModified: head.headers['last-modified'] || '',
    etag: head.headers.etag || '',
    rangeServed: !!served,
    range: served ? { start: served.start, end: served.end, total } : undefined,
  };
}

/** 解析 HTTP Range 头 "bytes=N-M" → { start, end }，end 为 inclusive */
function parseRange(range, total) {
  const rm = /^bytes=(\d*)-(\d*)$/i.exec(range);
  if (!rm || total === 0) throw Object.assign(new Error('Range 格式无效'), { status: 400 });
  let s = rm[1] === '' ? null : Number(rm[1]);
  let e = rm[2] === '' ? null : Number(rm[2]);
  if (s === null && e !== null) { s = Math.max(0, total - e); e = total - 1; }
  if (s === null) s = 0;
  if (e === null || e >= total) e = total - 1;
  if (s > e || s >= total) throw Object.assign(new Error('Range Not Satisfiable'), { status: 416, contentRange: `bytes */${total}` });
  return { start: s, end: e };
}

/* ============================ 写操作 ============================ */

/**
 * 写入对象（自动加密，覆盖已有元数据）
 * @param {string} bucket
 * @param {string} key
 * @param {Buffer|Readable} data  字符串或 Buffer 或可读流（流会先缓冲）
 * @param {string} [contentType]
 * @param {string} [auditAction]   审计标记（如 'webdav.put'），null 跳过审计
 * @param {string} [auditPrefix]   审计详情前缀
 * @returns {Promise<{ encrypted: bool, bytesWritten: number }>}
 */
async function writeObject(bucket, key, data, contentType, auditAction, auditPrefix) {
  const k = normalizeKey(key);
  const { cfg, cos } = requireCfgCos();
  let plainBuf;
  if (Buffer.isBuffer(data)) {
    plainBuf = data;
  } else if (typeof data === 'string') {
    plainBuf = Buffer.from(data, 'utf8');
  } else {
    // 流：先缓冲全量
    plainBuf = await bufferStream(data);
  }

  const enc = encStore.encryptBuffer(cfg.bucket, k, plainBuf);
  const body = enc ? enc.data : plainBuf;
  const encrypted = !!enc;

  // 已存在覆盖：204，新建 201（与 WebDAV 协议一致）
  let existed = true;
  try {
    await p(cos, 'headObject', { Bucket: cfg.bucket, Region: cfg.region, Key: k }, { noStat: true });
  } catch (e) { existed = false; }

  // R7-06：写操作必须走 `p()` 咽喉点。此前这里是直接回调式调用 `cos.putObject`，
  // 绕过了 p() 里的两件事：① 列举缓存失效（WebDAV 上传后管理端最多 3 秒看不到新文件）
  // ② 按桶请求计数（统计漏计）。
  await p(cos, 'putObject', {
    Bucket: cfg.bucket, Region: cfg.region, Key: k,
    Body: body,
    ContentLength: body.length,
    Headers: { 'Content-Type': contentType || 'application/octet-stream' },
  });

  // SEC-08 + R7-02：**密文确认落云之后**才写入解密凭据（IV/TAG/盐/文件头），并立刻同步落盘。
  // 顺序不可颠倒：元数据是解密的唯一凭据，若在 putObject 之前写入，云端写入失败时
  // 云端仍是旧密文、本地凭据却已被新值覆盖 → 该文件永久不可解。
  // 写之后仍然要 flushMeta()：否则「云端有密文、本地没落盘」的窗口内崩溃 = 同样不可解。
  //
  // R8-03：明文覆盖写入（mode==='none'）时同样要对账 —— 必须清掉旧条目，
  // 否则同一个 key 先前是密文、现在被明文覆盖，下载会按旧参数还原 → 报错或静默损坏。
  encStore.reconcileAfterWrite(cfg.bucket, k, enc ? enc.meta : null);

  // 审计
  if (auditAction) {
    const mode = encrypted ? encStore.currentMode() : 'none';
    const prefix = auditPrefix ? `${auditPrefix}「${k}」` : k;
    statsStore.addLog({
      action: auditAction,
      level: 'info',
      detail: `${prefix} —— ${encrypted ? `已加密(${mode}) ${body.length}B（明文 ${plainBuf.length}B）` : `明文 ${body.length}B`}，${existed ? '覆盖' : '新建'}`,
    });
  }

  return { encrypted, bytesWritten: body.length, existed };
}

/* ============================ 删操作 ============================ */

/**
 * 删除单个对象并清理加密元数据
 *
 * R7-03：删除成功后还要把「指向该对象的分享链接」标记为已删除 —— 否则 WebDAV 删掉文件后，
 * 管理页仍显示链接「有效」、分享页仍给下载按钮。**凡是会删掉对象的入口都得标**。
 *
 * @returns {Promise<{ deleted: bool, encrypted: bool, bytesFreed: number }>}
 */
async function deleteObject(bucket, key, auditAction, auditPrefix) {
  const k = normalizeKey(key);
  const { cfg, cos } = requireCfgCos();
  const encMeta = encStore.getMeta(cfg.bucket, k);

  // 获取对象大小（审计用）
  let bytesFreed = 0;
  try {
    const head = await p(cos, 'headObject', { Bucket: cfg.bucket, Region: cfg.region, Key: k }, { noStat: true });
    bytesFreed = Number(head.headers['content-length']) || 0;
  } catch (e) { /* 对象不存在 */ }

  await p(cos, 'deleteObject', { Bucket: cfg.bucket, Region: cfg.region, Key: k });

  const hadMeta = encMeta ? encStore.removeMeta(cfg.bucket, k) : false;
  // R7-03：云端确认删除后才标（与「元数据只按已确认删除的 key 清」同一约束）
  shareStore.markMissingByKeys(cfg.bucket, [k]);

  if (auditAction) {
    const prefix = auditPrefix ? `${auditPrefix}「${k}」` : k;
    statsStore.addLog({
      action: auditAction,
      level: 'info',
      detail: `${prefix} —— ${bytesFreed}B${hadMeta ? '（已清理加密元数据）' : ''}`,
    });
  }

  return { deleted: true, encrypted: hadMeta, bytesFreed };
}

/**
 * 前缀递归删除（目录删除）并清理加密元数据（FUN-04 同型修复）
 *
 * ⚠️ 这是全项目**第三份**前缀删除实现（另两份在 `routes/fs.js` 与 `routes/buckets.js`）。
 * 上一轮修 FUN-04 时按「模块」推进，只改了前两份，本份漏改 —— 于是 WebDAV 删目录
 * 仍保留着原始缺陷：
 *
 *   - `listAll` 单次调用、不检查 `truncated`，达到上限即静默返回部分结果；
 *   - 随后**无条件** `removeMetaPrefix()` 清理整个前缀的加密元数据。
 *
 * 后果：目录下对象数超过上限时，只删掉前 N 个，其余残留对象的**加密元数据已被清空**
 * → 密文永久不可解，且持续占用容量。这是本项目最不可逆的一类数据丢失。
 *
 * 修复：与 `routes/fs.js` 的 `deletePrefix` 收敛为同一套契约 ——
 *   1. 用 `listAllInfo` 显式判定 `truncated`，循环删除直到清空或达到轮次上限；
 *   2. **仅当云端删除确实成功后**才按批清理元数据（不是先清元数据再删）；
 *   3. 仍被截断时如实返回 `truncated=true`，由调用方决定是否告警。
 *
 * @returns {{ deleted:number, metaCleaned:number, truncated:boolean, rounds:number }}
 */
async function deletePrefix(bucket, prefix, auditAction, auditPrefix) {
  const pre = normalizeKey(prefix).replace(/\/+$/, '') + '/';
  const { cfg, cos } = requireCfgCos();

  let deleted = 0;
  let metaCleaned = 0;
  let truncated = true;
  let rounds = 0;
  /**
   * R11-01：与 `routes/fs.js` / `routes/buckets.js` 的 deletePrefix 同构 ——
   * 「整批 0 成功即停下」必须置位外层变量。旧实现只有内层 `break`（只跳 for），
   * `truncated=true` 恰是外层 `while` 的继续条件 → 一次失败被放大成
   * MAX_ROUNDS=1000 次全量列举 + 批量删除。
   */
  let stalled = false;
  // 防御上限：正常桶数十轮内必清空；越界说明服务端 marker 未推进，必须停下
  const MAX_ROUNDS = 1000;

  while (truncated && !stalled && rounds < MAX_ROUNDS) {
    // 内部维护调用：不计按桶请求统计，跳过目录标记自身
    const info = await listAllInfo(cos, cfg, pre, {
      cap: LIMITS.DELETE, noStat: true, skipPrefixSelf: true,
    });
    truncated = info.truncated;
    if (!info.items.length) break;

    for (let i = 0; i < info.items.length; i += 1000) {
      const batch = info.items.slice(i, i + 1000);
      const keys = batch.map((k) => k.key);
      /**
       * R10-03：与 `routes/fs.js` 共用同一套**白名单**判据。
       *
       * 旧实现丢弃返回值、按整批成功处理 → S3 兼容厂商上单个 key 被拒时，
       * 仍会对**依然存在**的对象清掉解密凭据（永久不可解）并标掉分享链接
       * （已分发的 URL 永久失效）。
       */
      const res = await deleteMultipleConfirmed(cos, cfg, keys);
      deleted += res.okKeys.length;
      // 仅当云端删除确实成功后才清理元数据 —— 「密文不可解」的最后一道防线
      if (res.okKeys.length) {
        metaCleaned += encStore.removeMetaBatch(cfg.bucket, res.okKeys);
        // R7-03：只认**本批确认删除**的 key，绝不按前缀
        shareStore.markMissingByKeys(cfg.bucket, res.okKeys);
      }
      // 一个都没删掉 = 卡住 → 置位 stalled 让外层 while 也停下（R11-01）
      if (!res.okKeys.length) {
        stalled = true;
        truncated = true;
        break;
      }
    }
    rounds += 1;
  }

  // 目录标记对象：在全部子对象删除成功后再删，避免中途失败留下"空壳目录"
  // （截断时不删，因为目录尚未清空）
  if (!truncated) {
    try {
      await p(cos, 'deleteObject', { Bucket: cfg.bucket, Region: cfg.region, Key: pre });
    } catch (e) { /* 标记对象可能本就不存在 */ }
    metaCleaned += encStore.removeMetaBatch(cfg.bucket, [pre]);
    shareStore.markMissingByKeys(cfg.bucket, [pre]); // R7-03：目录占位对象本身也可能被分享
  }

  if (auditAction) {
    const prefixStr = auditPrefix ? `${auditPrefix}「${pre}」` : pre;
    statsStore.addLog({
      action: auditAction,
      level: truncated ? 'warn' : 'info',
      detail: `${prefixStr} —— ${deleted} 个对象${metaCleaned ? `（已清理 ${metaCleaned} 条加密元数据）` : ''}`
        + (truncated ? `，⚠️ 未删完（${rounds} 轮后仍被截断），请重试` : ''),
    });
  }

  // R11-01：stalled 与 truncated 一起上报，调用方据此区分「云端拒绝」与「未删完」
  return { deleted, metaCleaned, truncated, rounds, stalled };
}

/* ============================ 复制 / 移动 ============================ */

/**
 * 云端复制对象 + 加密元数据复制（FUN-07）
 *
 * 服务端 PUT Copy 单次上限为 5GB。`routes/fs.js` 的 `copyOne()` 会根据对象大小切换
 * 到 `sliceCopyFile`（分块复制），而这里的 WebDAV 网关原先**无条件**走 `putObjectCopy`
 * —— 于是「同一操作在管理界面能成功、在资源管理器里必然失败」，违反项目自定的
 * 「统一网关」原则。这里补上同样的分支，使两条路径收敛到同一套逻辑。
 */
async function copyObject(bucket, srcKey, dstKey, auditAction, auditPrefix, knownSize) {
  const srcK = normalizeKey(srcKey);
  const dstK = normalizeKey(dstKey);
  const { cfg, cos } = requireCfgCos();

  // CopySource 统一由 cos.js 生成（S3 厂商为 /bucket/key，COS 为外链域名形式）——
  // 切勿再本地硬编码，否则 S3 厂商复制/移动会因格式错误失败
  const src = copySource(cfg.provider, cfg.bucket, cfg.region, srcK);

  // 与 routes/fs.js 的 COPY_SIMPLE_LIMIT 保持一致：超过则先探测大小再决定是否分块复制
  let large = false;
  const given = Number(knownSize);
  try {
    // R11-15：调用方（逐页列举）手里**已经有** `it.size` —— 复用它，省掉每个对象
    // 一次额外的 headObject。目录 COPY 此前比 MOVE 慢一个数量级，一半就出在这里。
    if (Number.isFinite(given) && given > 0) large = given > COPY_SIMPLE_LIMIT;
    else large = Number((await headObject(bucket, srcK)).size) > COPY_SIMPLE_LIMIT;
  } catch (e) {
    // 探测失败不阻断：仍走简单复制，由服务端在超限时报错（行为与旧版一致）
  }

  if (large && providers.isCos(cfg.provider)) {
    await p(cos, 'sliceCopyFile', { Bucket: cfg.bucket, Region: cfg.region, Key: dstK, CopySource: src });
  } else {
    await p(cos, 'putObjectCopy', { Bucket: cfg.bucket, Region: cfg.region, Key: dstK, CopySource: src });
  }

  /**
   * R9-03：复制路径也必须做「写后对账」。
   *
   * R8-03 把三条**上传/写入**路径收敛到 `reconcileAfterWrite()`（`fs.js` 的直传与
   * 分片 complete、本文件的 `writeObject`），但**复制路径没有接上**。而 WebDAV 的
   * COPY/MOVE 在 `Overwrite: T`（默认）下会用 `putObjectCopy` 覆盖已存在的目标 ——
   * 这是一次**覆盖写入**，语义与上传完全相同。
   *
   * 复现（静默内容损坏）：① `mode=crypto` 上传 `B`（写入元数据）→ ② 管理员切到
   * `mode=none` → ③ 上传明文 `A` → ④ WebDAV `COPY A → B`（默认覆盖）。
   * 此时 `B` 已是明文，但 `bucket|B` 仍是 crypto 记录 → 下载报「密文头部标识不匹配」
   * 并中途断流；若旧记录是 `magic`，则**不报错**，用户拿到一份「看起来正常、
   * 内容全错」的文件。
   *
   * `copyMeta()` 的旧语义也帮不上忙：源无元数据时它直接 return（**不清目标**），
   * 正好把上面这种情况漏掉。`reconcileAfterWrite(bucket, dstK, 源元数据)` 才是正确
   * 契约 —— meta 为 null 即会 `removeMeta(dstK)`，把陈旧条目清掉。
   *
   * 调用时机与 R7-02 / R8-03 同一纪律：必须在云端复制**确认成功之后**。
   */
  const srcMeta = encStore.getMeta(cfg.bucket, srcK);
  const metaCopied = encStore.reconcileAfterWrite(cfg.bucket, dstK, srcMeta || null);

  if (auditAction) {
    const prefix = auditPrefix ? `${auditPrefix}` : '';
    statsStore.addLog({
      action: auditAction,
      level: 'info',
      detail: `${prefix}「${srcK}」→「${dstK}」${metaCopied ? '（加密元数据已迁移）' : ''}`,
    });
  }

  return { copied: true, metaCopied };
}

/**
 * 移动单个对象：云端复制→删源 + 元数据迁移
 *
 * R13-05：复制成功但**删源失败**时必须收尾 —— 旧实现直接抛错，源与目标并存，
 * 既不回滚也不留痕（目标侧多出来的副本按量计费，且加密元数据已被 copyObject
 * 迁到目标 key 上，源侧重试移动会撞上它）。
 *
 * 回滚边界与 R11-03 / R13-02 同一条纪律（fresh 判据）：只删「本次才新建」的目标。
 * 若目标在复制前**本就存在**（`Overwrite: T` 的覆盖移动），它的旧内容已被源
 * 覆盖、不可还原 —— 这时再删目标就是把用户既有数据也一并毁掉，绝不许做。
 */
async function moveObject(bucket, srcKey, dstKey, auditAction, auditPrefix) {
  const { cfg, cos } = requireCfgCos();
  const fromKey = normalizeKey(srcKey);
  const toKey = normalizeKey(dstKey);

  // 复制前探测目标是否已存在。探测本身失败时按「存在」处理（fail-closed）：
  // 宁可留下可重试的半成品，也不能误删复制前就有的用户对象（不可逆）。
  let dstExistedBefore = true;
  try {
    await p(cos, 'headObject', { Bucket: cfg.bucket, Region: cfg.region, Key: toKey }, { noStat: true });
    dstExistedBefore = true;
  } catch (e) {
    const code = String((e && (e.code || e.Code || e.errorCode)) || '');
    const status = Number((e && (e.statusCode || e.status)) || 0);
    if (status === 404 || /NoSuchKey|NotFound/i.test(code)) dstExistedBefore = false;
  }

  await copyObject(bucket, srcKey, dstKey); // 不在此写审计，move 统一写
  try {
    await p(cos, 'deleteObject', { Bucket: cfg.bucket, Region: cfg.region, Key: fromKey });
  } catch (delErr) {
    let tail;
    if (dstExistedBefore) {
      // 目标原本就在：内容已被覆盖（不可还原），但**不能再删它**。
      tail = '目标对象在移动前已存在、内容已被覆盖且无法还原，未做删除；'
        + '源对象仍在，请人工核对后重试或清理。';
    } else {
      // 目标是本次新建：删掉它 + 清掉刚迁入的元数据，回到「源在目标不在」的起点。
      // 元数据只在云端确认删除之后才动（与 deletePrefix 同一条铁律）。
      const rb = await rollbackCopies(cos, cfg, [toKey]);
      if (rb.removed === 1) {
        encStore.removeMetaBatch(cfg.bucket, [toKey]);
        tail = '已回滚删除目标副本及其加密元数据，源对象仍在，可直接重试。';
      } else {
        tail = `回滚删除目标副本也失败（${(rb.errors[0] && rb.errors[0].message) || '未知错误'}）；`
          + `源与目标并存，孤儿副本 ${toKey} 需手工清理。`;
      }
    }
    statsStore.addLog({
      action: auditAction || 'fs.move',
      level: 'error',
      detail: `${auditPrefix || ''}「${srcKey}」→「${dstKey}」移动失败：删除源对象出错（${delErr.message}）；${tail}`,
    });
    throw delErr;
  }
  // R10-06：MOVE 会**删掉源对象**，因此与 deleteObject 同属「会删对象的入口」——
  // 必须标记指向它的分享链接。旧实现漏了（文件头注释里那条纪律的漏网入口）：
  // 移动后指向源 key 的链接仍是 active，管理端长期显示有效、分享页照常渲染下载按钮，
  // 只有访客真正打开分享页时靠 60 秒 TTL 的惰性探测才纠正，而管理端从不探测。
  shareStore.markMissingByKeys(cfg.bucket, [fromKey]);
  const metaMoved = encStore.renameMeta(cfg.bucket, fromKey, toKey);

  if (auditAction) {
    const prefix = auditPrefix ? `${auditPrefix}` : '';
    statsStore.addLog({
      action: auditAction,
      level: 'info',
      detail: `${prefix}「${srcKey}」→「${dstKey}」${metaMoved ? '（加密元数据已迁移）' : ''}`,
    });
  }

  return { moved: true, metaMoved };
}

/**
 * 复制失败后的回滚：**唯一实现点**（R12-04）。
 *
 * 「复制失败必须回到『源在目标不在』这一干净起点」这条纪律此前有三份实现：
 * 管理端 `routes/fs.js`、`fs-gateway.movePrefix`、以及……**没有第三份 —— WebDAV
 * 目录 COPY 压根没写回滚**（R12-04）。第 11 轮只把 COPY 的性能修了，回滚没补。
 *
 * 与其补第四份，不如下沉：判据走 `deleteMultipleConfirmed`（白名单），
 * 结果如实返回 `removed` 与 `errors`，由调用方决定怎么留痕。
 *
 * @param {object} cos
 * @param {object} cfg
 * @param {string[]} keys 本次**新建**的目标键（不得含目标侧本来就有的键）
 * @returns {Promise<{removed:number, errors:Array<{key:string,message:string}>}>}
 */
async function rollbackCopies(cos, cfg, keys) {
  let removed = 0;
  const errors = [];
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    try {
      // R10-03：回滚也是批量删除 —— 判据必须同样走白名单，否则日志会谎报「已回滚 N/N」
      const res = await deleteMultipleConfirmed(cos, cfg, batch);
      removed += res.okKeys.length;
      for (const x of res.errors) errors.push(x);
    } catch (e) { /* 尽力而为：一个批次失败也要继续删剩下的 */ }
  }
  return { removed, errors };
}

/**
 * 前缀整体移动（文件夹重命名）：逐一复制后批量删除
 */
async function movePrefix(bucket, srcPrefix, dstPrefix, auditAction, auditPrefix) {
  const { cfg, cos } = requireCfgCos();
  const srcP = normalizeKey(srcPrefix).replace(/\/+$/, '');
  const dstP = normalizeKey(dstPrefix).replace(/\/+$/, '');
  // FUN-04 同型：单次 listAll 不检查截断时，超量目录会"只搬走一部分"，
  // 而下方 migratePrefix 却迁移整个前缀的元数据 → 未搬走的密文元数据被改写，
  // 指向已经不存在的新路径（元数据漂移）。这里显式判定并拒绝，而不是静默半成品。
  // 判定统一走 cos.listAllExact（与 routes/fs.js 的 rename/move 同源，避免各写一份）。
  const items = await listAllExact(cos, cfg, srcP + '/', {
    cap: LIMITS.HARD_MAX, noStat: true, skipPrefixSelf: true,
  }, '移动');

  /**
   * R11-03：复制**之前**先记录目标侧原本就存在的对象。
   *
   * 目录 MOVE 是「逐对象复制到目标 + 删源」的**合并**语义：它从不删目标已有对象，
   * 只在同名 key 上覆盖（见下方 migratePrefix 的注释）。因此回滚只能撤销
   * 「本次才创建」的那些键 —— 按 `copied` 全量删除会把**覆盖写入了目标既有对象**
   * 的键也删掉，等于源侧一次失败就毁掉目标侧与本次移动无关的用户数据，
   * 且不做 markMissing、不清元数据，留下一条指向已删对象的孤儿元数据。
   *
   * 这里一次列举（而不是复制途中逐键探测）成本最低；列举失败就让整个移动在
   * **动手之前**失败，好过复制一半才发现无法安全回滚。
   */
  const existedBefore = new Set();
  /**
   * R12-06：`cap` 用 `LIMITS.STAT`（20000，与源侧 `/fs/stat` 同源）而不是 `HARD_MAX`。
   *
   * 用 `HARD_MAX` 有两个后果：① 每次目录 MOVE 都要对目标前缀做一次**完整递归列举**
   * （目标 1 万对象 = 10 次串行云端往返），与 R11-15 刚为 COPY 省掉往返的方向相反；
   * ② 目标 ≥5 万时 MOVE 直接 400，而 `listAllExact` 的文案是「为避免只复制一部分
   * 就删除源数据…请分批移动」—— **一个字节都没复制**，文案与事实矛盾。
   * 超限是「无法安全地做冲突检测与回滚」，必须给专属文案。
   */
  let preexisting;
  try {
    preexisting = await listAllExact(cos, cfg, dstP + '/', {
      cap: LIMITS.STAT, noStat: true, skipPrefixSelf: true,
    });
  } catch (e) {
    if (e && e.truncated) {
      const e2 = new Error(
        `目标目录“${dstP}/”下对象过多（超过 ${LIMITS.STAT} 个），无法在合理开销内完成`
        + '「冲突检测 + 失败回滚」；已中止且**未做任何改动**。'
        + '请先拆分子目录分批移动，或改用一个空目标。'
      );
      e2.status = 400;
      throw e2;
    }
    throw e;
  }
  for (const it of preexisting) existedBefore.add(it.key);

  /**
   * R12-02：**动手之前**拒绝「会覆盖目标侧既有对象」的移动（一次都不覆盖）。
   *
   * R11-03 只把「删除」这一半改对了 —— 回滚不再删掉目标侧既有对象。但那意味着：
   * 复制一旦开始，目标侧同名对象的**内容已被源密文覆盖**，回滚却刻意不删它 ——
   * 于是它不是「保留」，而是**换成了别人的内容，且无法还原**（云端覆盖不可撤销）。
   * 更糟的是失败路径上 `throw e` 排在 `migratePrefix` 之前，那份被覆盖的对象
   * 在 `enc-meta.json` 里仍描述**旧明文**的参数 → 下载必然断流（crypto）或产出
   * 乱码（magic 无认证标签）。日志写「按合并语义保留」与事实完全相反。
   *
   * 「覆盖」这一半没有出口，因此唯一的正确做法是**不让它发生**：
   * 冲突非空即整体中止，与管理端 `routes/fs.js:assertNoConflict` 同款口径。
   */
  const conflicts = [];
  for (const it of items) {
    const target = dstP + '/' + it.key.slice((srcP + '/').length);
    if (existedBefore.has(target)) conflicts.push(target);
  }
  if (conflicts.length) {
    const preview = conflicts.slice(0, 3).map((k) => k.slice(dstP.length + 1)).join('、');
    const e = new Error(
      `目标位置“${dstP}/”下已存在 ${conflicts.length} 个同名对象（${preview}`
      + (conflicts.length > 3 ? ' 等' : '')
      + '）；目录移动会在云端覆盖它们且不可撤销，已中止且未做任何改动。'
      + '请先移走目标下的同名对象，或改用其它目标。'
    );
    e.status = 409;
    e.conflicts = conflicts;
    statsStore.addLog({
      action: auditAction || 'fs.move',
      level: 'warn',
      detail: `移动目录「${srcP}/」→「${dstP}/」被拒绝：目标下已存在 ${conflicts.length} 个同名对象（未做任何改动）`,
    });
    throw e;
  }

  // 受控并发复制（大文件夹加速）
  //
  // R7-11：① 与 copyObject 同源 —— 超过 5GB 的对象必须走 sliceCopyFile，
  //        否则「同一操作在管理界面能成功、在资源管理器里必然失败」；
  //        ② 并发复制中途失败必须**尽力回滚**：旧实现直接 reject，留下「源未删 +
  //        目标半份副本」，用户看到的是两个都不完整的目录。
  const copied = [];
  let idx = 0;
  /**
   * R12-13：`Promise.all` 拒绝后**其余 worker 仍在继续** —— 旧实现在 `catch` 里
   * 立刻对 `copied` 取快照，晚于它的 `copied.push()` 不进 `fresh`，于是目标侧残留
   * 孤儿，而日志因 `removed === fresh.length` 写「已回滚 N/N」，
   * 「残留孤儿需手工清理」的告警**永不触发** —— 日志谎报已完整回滚。
   * 修法：失败时先置 `stopped` 让各 worker 收尾，再 `allSettled` 等它们真正停下，
   * **然后**才取快照。
   */
  let stopped = false;
  const limit = Math.min(5, Math.max(1, items.length));
  const workers = [];
  for (let w = 0; w < limit; w++) {
    workers.push((async () => {
      while (!stopped && idx < items.length) {
        const it = items[idx++];
        const rel = it.key.slice((srcP + '/').length);
        const target = dstP + '/' + rel;
        const src = copySource(cfg.provider, cfg.bucket, cfg.region, it.key);
        const large = Number(it.size || 0) > COPY_SIMPLE_LIMIT;
        if (large && providers.isCos(cfg.provider)) {
          await p(cos, 'sliceCopyFile', { Bucket: cfg.bucket, Region: cfg.region, Key: target, CopySource: src });
        } else {
          await p(cos, 'putObjectCopy', { Bucket: cfg.bucket, Region: cfg.region, Key: target, CopySource: src });
        }
        copied.push(target);
      }
    })());
  }

  try {
    await Promise.all(workers);
  } catch (e) {
    stopped = true;
    // R12-13：先让在飞的 worker 落地，再取快照（见上方 `stopped` 的说明）
    await Promise.allSettled(workers);

    // 回滚：只删「本次新建」的目标对象（R11-03）。清理不干净也要**如实留痕** ——
    // 静默留下孤儿副本，比报一次错更难排查（下源和目标里都有同名内容）。
    const fresh = copied.filter((k) => !existedBefore.has(k));
    // R12-02：冲突已在动手前拒绝，正常情况下这里恒为 0；保留判定只是**纵深防御**
    // （复制期间被并发写入的键同样不该被回滚删掉），文案不得再称「按合并语义保留」
    const overwritten = copied.length - fresh.length;
    // R12-04：回滚的唯一实现点（与 WebDAV 目录 COPY 共用）
    const rb = await rollbackCopies(cos, cfg, fresh);
    const removed = rb.removed;
    const rollbackErrors = rb.errors;
    statsStore.addLog({
      action: auditAction || 'fs.move',
      level: 'error',
      detail: `移动目录「${srcP}/」失败：${e.message}；已回滚 ${removed}/${fresh.length} 个本次新建的目标对象`
        + (overwritten ? `，${overwritten} 个在复制期间已存在的目标对象未删除（不得覆盖回滚，需人工核对）` : '')
        + (rollbackErrors.length ? `；回滚失败 ${rollbackErrors.length} 个：${rollbackErrors[0].message}` : '')
        + (removed < fresh.length && !rollbackErrors.length
          ? `；残留 ${fresh.length - removed} 个孤儿副本需手工清理（目标前缀 ${dstP}/）` : ''),
    });
    throw e;
  }

  /**
   * R11-02：元数据迁移必须**早于删源**（与管理端 `routes/fs.js` 的硬约束对齐）。
   *
   * 旧顺序是「删源 → 标记分享链接 → 迁元数据」：两步之间被打断（进程崩溃、或
   * `markMissingByKeys` 在 share-store 损坏锁定态下同步抛错）时，目标位置已是
   * **新密文**，而 IV / TAG / 盐 / 原始文件头仍挂在**已被删除**的源 key 上 ——
   * magic 模式下连盐与文件头都只存在于元数据里，目标目录全部文件永久不可解。
   *
   * 迁移在前则最坏只留下「源已复制未删」的半成品，重跑即恢复，且目标密文与其
   * 凭据始终成对。与管理端同序后，两边共用同一条不变量。
   */
  // R10-04：`migratePrefix` 只清理**本次确实覆盖写入**的目标条目（WebDAV 目录 MOVE
  // 是"合并"语义 —— 它从不删目标已有对象，因此不能清目标侧的其它条目，否则会把
  // "合并进非空目标后仍可用的对象"变成永久不可解）。
  const relKeys = new Set(items.map((x) => x.key.slice((srcP + '/').length)).filter(Boolean));
  const metaMig = encStore.migratePrefix(cfg.bucket, srcP + '/', dstP + '/', { overwriteRelKeys: relKeys });
  const metaMoved = metaMig.moved;
  /**
   * R12-07：迁移后**立刻同步落盘**，再往下走删源。
   *
   * `migratePrefix` 内部走的是**异步** `persistMeta()`，而紧随其后（`:734` 起）就是
   * 批量删源。这个窗口内被 SIGKILL / OOM / 容器强停打断时（**不会**触发 exit 钩子），
   * 目标位置已是新密文、凭据却还没落盘 → 目标目录全部文件永久不可解。
   * R11-02 修好了顺序（迁移早于删源），但 SEC-08 的"先落盘再动云端"这一段没闭合。
   *
   * `flushMetaSync()` 在无待写内容时是空操作，成本为零。
   */
  encStore.flushMetaSync();

  // 批量删除源（含目录标记对象）
  const allKeys = items.map((x) => x.key);
  allKeys.push(srcP + '/');
  /**
   * R10-06：目录 MOVE 同样删掉了源对象 → 一并标记分享链接（与 `moveObject` 同款漏网）。
   * 这里还顺带用上了 R10-03 的白名单判据：只有云端**确认删除**的源 key 才能标记，
   * 否则源对象还在、链接却被标成"已删除"（已分发 URL 永久失效）。
   */
  const removedKeys = [];
  for (let i = 0; i < allKeys.length; i += 1000) {
    const batch = allKeys.slice(i, i + 1000);
    const res = await deleteMultipleConfirmed(cos, cfg, batch);
    removedKeys.push(...res.okKeys);
  }
  if (removedKeys.length) shareStore.markMissingByKeys(cfg.bucket, removedKeys);

  if (auditAction) {
    const prefix = auditPrefix ? `${auditPrefix}` : '';
    statsStore.addLog({
      action: auditAction,
      level: 'info',
      detail: `${prefix}「${srcP}/」→「${dstP}/」(${items.length} 个对象)${metaMoved ? '（加密元数据已迁移）' : ''}`
        + (metaMig.cleared ? `，清理目标陈旧元数据 ${metaMig.cleared} 条` : ''),
    });
  }

  return { moved: true, count: items.length, metaMoved };
}

/* ============================ HEAD（属性查询） ============================ */

/**
 * 获取对象属性（同步查询加密状态）
 */
async function headObject(bucket, key) {
  const k = normalizeKey(key);
  const { cfg, cos } = requireCfgCos();
  const head = await p(cos, 'headObject', { Bucket: cfg.bucket, Region: cfg.region, Key: k }, { noStat: true });
  const encMeta = encStore.getMeta(cfg.bucket, k);
  return {
    key: k,
    size: Number(head.headers['content-length']) || 0,
    origSize: encMeta ? encMeta.origSize : null,
    contentType: head.headers['content-type'] || null,
    lastModified: head.headers['last-modified'] || '',
    etag: head.headers.etag || '',
    encrypted: !!encMeta,
    encMode: encMeta ? encMeta.mode : null,
  };
}

/* ============================ 导出 ============================ */

/**
 * R10-07：该对象**能否**服务 Range —— HEAD 与 GET 的唯一判定来源。
 *
 * 加密对象只有在「明文 ≤ `MAX_RANGE_BUFFER`」时才能走「完整下载解密后内存切片」
 * （见 `readObject` 的加密分支）；更大的会退化为**全量流式解密并忽略 Range**，
 * 返回 200 + 全量长度 + 全量 body。
 *
 * 于是若 HEAD 对任何 Range 都宣告 206 + `Content-Range`，两端就自相矛盾：
 * 多线程下载器 / 续传客户端按 HEAD 建多个区间连接，每个连接却收到**整份**内容 ——
 * 按偏移拼装得到的是损坏文件，且带宽被放大数倍。
 *
 * @param {{encrypted?: boolean, origSize?: number}} meta `headObject` 的返回形状
 * @returns {boolean}
 */
function rangeServable(meta) {
  if (!meta || !meta.encrypted) return true; // 非加密：云端原生支持 Range
  const n = Number(meta.origSize || 0);
  /**
   * R11-10：空文件（origSize = 0）**不能**服务任何 Range。
   *
   * `parseRange(range, 0)` 对 total=0 恒抛 400，于是加密空文件上 HEAD 回 200、
   * GET 回 400 —— R10-07 定的「HEAD 与 GET 同源」在这条边界上仍然分叉。
   * 这里判 false 后，HEAD 不再宣告 206，GET 也走全量分支（不再调 parseRange）。
   */
  if (n <= 0) return false;
  return n <= MAX_RANGE_BUFFER;
}

module.exports = {
  // 核心读写
  readObject,
  writeObject,
  headObject,
  // 生命周期
  deleteObject,
  deletePrefix,
  copyObject,
  moveObject,
  movePrefix,
  // R12-04：复制失败回滚的**唯一实现点**（movePrefix 与 WebDAV 目录 COPY 共用）
  rollbackCopies,
  // 内部工具（供 webdav 侧列举复用，避免各自写 listAll）
  requireCfgCos,
  parseRange,
  // R10-07：HEAD 与 GET 必须共用「该对象能否服务 Range」的判定
  rangeServable,
  // 仅供测试：暴露加密读取信号量，用于验证「错误销毁不会把计数减成负数」(FUN-02)
  __test__: {
    acquireEncryptReader,
    makeEncryptReaderReleaser,
    activeCount: () => activeEncryptReaders,
    queueLen: () => encryptReaderQueue.length,
    MAX_ENCRYPT_READERS,
    reset: () => { activeEncryptReaders = 0; encryptReaderQueue.length = 0; },
    // R7-08：把「交接兜底」的等待时长调短，让用例不必真等 60 秒
    setHandoffMs: (ms) => { readerHandoffMs = Number(ms) > 0 ? Number(ms) : DEFAULT_READER_HANDOFF_MS; },
  },
};