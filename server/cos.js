/**
 * 存储客户端封装 —— 按服务商创建客户端，统一错误翻译与请求统计埋点
 *
 *  - 腾讯云：cos-nodejs-sdk-v5（原生 COS 协议）
 *  - 其余厂商：S3 兼容协议（见 s3-client.js）
 *
 * 上层业务代码只依赖本模块导出的统一接口，不感知底层协议差异。
 */
const COS = require('cos-nodejs-sdk-v5');
const configStore = require('./config-store');
const statsStore = require('./stats-store');
const providers = require('./providers');
const { S3Client } = require('./s3-client');
const { assertSafeEndpoint } = require('./endpoint-guard');
const { LIMITS, resolveCap } = require('./limits');
const listCache = require('./list-cache');

const clients = new Map(); // 签名 -> 客户端实例缓存
let clientsKey = '';

/** 从配置中解析出服务商 id（缺省视为腾讯云，兼容历史配置） */
function providerOf(cfg) {
  return String((cfg && cfg.provider) || providers.DEFAULT_PROVIDER_ID);
}

/**
 * 创建存储客户端
 * @param {object} cfg { provider, secretId, secretKey, endpoint, region, bucket }
 */
function createClient(cfg) {
  const pid = providerOf(cfg);
  const meta = providers.resolve(pid);
  if (meta.kind === 'planned') {
    const err = new Error(`${meta.name} 暂未开放接入，请先选择其他服务商`);
    err.status = 400;
    throw err;
  }
  const endpoint = String(cfg.endpoint || '').trim() ||
    providers.endpointFor(pid, cfg.region);
  // SEC-03：自定义端点必须先过安全校验（禁云元数据/回环/私网，非回环强制 https），
  // 否则可被用来让服务端替请求方访问内网或云实例元数据端点（盲 SSRF）。
  if (cfg.endpoint) assertSafeEndpoint(cfg.endpoint);
  if (meta.kind === 'cos') {
    // 腾讯云 SDK 的凭据字段名为 SecretId / SecretKey（非 AWS 的 accessKeyId / secretAccessKey）
    return new COS({
      SecretId: cfg.secretId,
      SecretKey: cfg.secretKey,
      FileParallelLimit: 3,
      ChunkParallelLimit: 3,
      ChunkRetryTimes: 2,
      // P6：避免网络异常时请求永久挂起（默认 120 秒，可用环境变量覆盖）
      Timeout: Number(process.env.COS_TIMEOUT_MS) || 120000,
    });
  }
  if (!endpoint) {
    const err = new Error(`${meta.name} 缺少服务端点（Endpoint），请在密钥中补充`);
    err.status = 400;
    throw err;
  }
  return new S3Client({
    accessKeyId: cfg.secretId,
    secretAccessKey: cfg.secretKey,
    endpoint,
    region: cfg.region,
    bucket: cfg.bucket,
  });
}

function getClient(cfg) {
  const c = cfg || configStore.get();
  if (!c || !c.secretId || !c.secretKey) {
    const err = new Error('尚未配置对象存储访问密钥，请先在“设置”中完成配置');
    err.status = 428; // Precondition Required
    throw err;
  }
  const pid = providerOf(c);
  const key = [pid, c.secretId, c.secretKey, c.endpoint || '', c.region || ''].join('|');
  if (clientsKey !== key) {
    clients.clear();
    clientsKey = key;
  }
  if (!clients.has(key)) {
    clients.set(key, createClient(c));
  }
  return clients.get(key);
}

/**
 * 将 SDK 回调风格转为 Promise
 * @param {object} opts { noStat } noStat=true 时不计入按桶请求统计（内部轮询类调用）
 */
function p(cos, method, params, opts) {
  return new Promise((resolve, reject) => {
    cos[method](params, (err, data) => {
      // 按桶请求计数（跳过 request 原始调用：那是本系统自己的统计轮询）
      if (!opts || !opts.noStat) {
        const bk = params && params.Bucket;
        if (bk && method !== 'request') statsStore.trackBucket(bk, { req: 1 });
      }
      // 列举缓存失效的唯一挂载点：写操作一律失效该桶缓存。
      // 放在成功与失败**两条分支**上 —— 失败的写也可能已经部分生效，
      // 少失效一次就可能让用户看到「刚删掉的文件还在」。
      listCache.noteCall(method, params);
      if (err) reject(err); else resolve(data);
    });
  });
}

/** SDK 错误 -> 面向用户的中文错误信息 */
/**
 * 将存储服务返回的错误翻译为面向用户的分类化提示（S9）
 *  - 用户只看到分类文案，不含请求 ID、内部路径、区域等内部信息
 *  - 原始错误消息保留在 err.rawMessage，仅供服务端日志排查使用
 */
function translateError(e) {
  const raw = (e && e.message) || '未知错误';
  const status = e && (e.statusCode || e.status) || 0;
  const code = (e && (e.code || e.errorCode)) || '';
  let msg;
  // SDK 本地参数校验失败（如凭据缺失）不带 statusCode，按参数错误处理而非 500
  if (/missing param/i.test(raw)) msg = '请求参数错误：缺少 ' + raw.replace(/missing param\s*/i, '');
  else if (status === 400 || code === 'InvalidArgument') msg = '请求参数错误，请检查后重试';
  else if (status === 401) msg = '签名错误：请检查 AccessKey / SecretKey 是否正确';
  else if (status === 403 || code === 'AccessDenied' || code === 'InvalidAccessKeyId' || code === 'SignatureDoesNotMatch') msg = '签名错误：请检查 AccessKey / SecretKey 是否正确';
  else if (status === 404 || code === 'NoSuchBucket' || code === 'NoSuchKey') msg = '资源不存在：对象或存储桶不存在';
  else if (status === 409) msg = '资源冲突：请刷新后重试';
  else if (code === 'NoSuchUpload') msg = '分片上传会话已失效，请重新上传';
  else if (code === 'NotImplemented') msg = '当前服务商不支持该操作';
  else if (code === 'TimeoutError' || /timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed/i.test(raw)) msg = '网络连接异常，请检查网络后重试';
  else if (status >= 500) msg = '对象存储服务暂时不可用，请稍后重试';
  else msg = '操作失败，请重试';
  const err = new Error(msg);
  /**
   * R11-04：上游存储返回的 **401 不得原样透传**。
   *
   * 项目的硬约定是「401 = 没有有效会话」：前端 `api.js` 一见 401 就派发
   * `auth-required` → `forceLogout('登录已过期，请重新登录')`（还会清掉未提交的编辑）。
   * 而对象存储用 401 表达的是**密钥被拒绝**（SignatureDoesNotMatch / 密钥轮换或吊销），
   * 两者是同一种状态码下的两件事 —— 透传的结果是：用户被踢出 → 重新登录 →
   * 第一个请求再 401 → 再被踢出，管理端进入不可用死循环，且错误文案把
   * 「密钥无效」误导成「会话过期」。
   *
   * 上游的 401 映射为 502（"上游说不行"，属服务端故障而非会话问题）；
   * 本地会话语义的 401 由路由层自己抛，不经本函数，因此不受影响。
   */
  err.status = status === 401 ? 502 : (status >= 400 && status < 600 ? status : 500);
  err.cosCode = code;
  err.rawMessage = raw; // 仅服务端日志使用
  return err;
}

/**
 * 执行一次面向用户的存储操作并记录请求统计
 * @param {string} type 请求类型 list/upload/download/delete/mkdir/rename/move/stat/search/other
 * @param {Function} fn async 操作体
 * @param {object} traffic {bytesUp, bytesDown} 在操作体内更新并回填
 */
async function tracked(type, fn, traffic) {
  const t0 = Date.now();
  const bytes = traffic || {};
  try {
    const result = await fn();
    statsStore.track({ type, ok: true, bytesUp: bytes.bytesUp || 0, bytesDown: bytes.bytesDown || 0, ms: Date.now() - t0 });
    return result;
  } catch (e) {
    statsStore.track({ type, ok: false, bytesUp: bytes.bytesUp || 0, bytesDown: bytes.bytesDown || 0, ms: Date.now() - t0 });
    throw e instanceof Error && e.status ? e : translateError(e);
  }
}

/**
 * 递归列出前缀下全部对象（统一实现：routes 与 fs-gateway 共用，禁止各自再写一份）
 *
 * PERF-04：cap 默认不再是无约束的 20 万。`listAll` 串行翻页并把结果全量累积到
 * 内存数组，单次上限过大时会同时造成「200+ 次串行云端往返」与「整体序列化」的
 * 双重长任务。默认上限改为 {@link LIMITS.HARD_MAX}（5 万），各调用方应按业务语义
 * 显式传入更小的值。
 *
 * @param {object} cos  存储客户端
 * @param {object} cfg  { bucket, region }
 * @param {string} prefix
 * @param {object} [opts]
 *  - cap: 最多返回条数（受 HARD_MAX 硬约束）。**注意**：达到上限即停，
 *    结果可能是部分集合；需要区分「已列完」与「被截断」请用 {@link listAllInfo}。
 *  - noStat: true 时不计入按桶请求统计（内部维护类调用）
 *  - skipPrefixSelf: true 时跳过与 prefix 完全相等的对象（目录标记自身）
 * @returns {Promise<Array<{ key: string, size: number, lastModified: string }>>}
 *          lastModified 为服务端返回的 ISO 时间串（/fs/search 日期区间过滤依赖该字段）
 */
async function listAll(cos, cfg, prefix, opts = {}) {
  return (await listAllInfo(cos, cfg, prefix, opts)).items;
}

/**
 * 列出**一页**对象 —— 全项目唯一的「翻一页 + 推导下一页游标」实现。
 *
 * 为什么要抽出来：此前「下一页游标」的推导（`NextMarker` 缺失时回退到本页最后
 * 一个 key）只写在 `listAllInfo` 里，任何需要**游标透传**的新调用方（如
 * `/fs/search` 的续扫）都不得不复制一遍；按本项目反复验证的规律，复制即分叉。
 * 现在 `listAllInfo` 与搜索续扫都建立在这一份实现之上。
 *
 * 游标语义：返回的 `nextMarker` 恒为「可直接塞回 `Marker` 的不透明游标」
 * （S3 下由 `s3-client` 适配为 continuation-token，见该文件顶部说明）。
 *
 * @param {object} cos
 * @param {object} cfg  { bucket, region }
 * @param {string} prefix
 * @param {object} [opts]
 *  - marker: 起始游标，首轮传 ''
 *  - maxKeys: 单页条数（对象存储服务端上限 1000）
 *  - delimiter: 传 '/' 时按下级目录聚合（返回 CommonPrefixes）；默认 '' 为递归列举
 *  - noStat: true 时不计入按桶请求统计
 *  - skipPrefixSelf: true 时跳过与 prefix 完全相等的对象（目录标记自身）
 * @returns {Promise<{items: Array<{key,size,lastModified}>, prefixes: string[],
 *                    nextMarker: string, isTruncated: boolean}>}
 *          `nextMarker` 为空串即表示已列举完（调用方必须以此为准，不要靠条数反推）
 */
async function listPage(cos, cfg, prefix, { marker = '', maxKeys = 1000, delimiter = '', noStat = false, skipPrefixSelf = false } = {}) {
  const data = await p(cos, 'getBucket', {
    Bucket: cfg.bucket,
    Region: cfg.region,
    Prefix: prefix,
    Delimiter: delimiter,
    Marker: marker,
    MaxKeys: Math.min(1000, Math.max(1, Number(maxKeys) || 1000)),
  }, noStat ? { noStat: true } : undefined);

  const items = [];
  for (const c of data.Contents || []) {
    if (skipPrefixSelf && c.Key === prefix) continue;
    items.push({ key: c.Key, size: Number(c.Size) || 0, lastModified: c.LastModified || '' });
  }
  const prefixes = (data.CommonPrefixes || []).map((x) => x.Prefix).filter(Boolean);
  const isTruncated = String(data.IsTruncated) === 'true';
  // 只回退到**本页**最后一个 key：若本页为空且服务端未给 NextMarker，
  // 必须得到空串并结束循环（回退到上一页的 key 会原地打转成死循环）。
  //
  // delimiter='/' 时本页可能**只有 CommonPrefixes 而没有 Contents**（子目录数超过
  // MaxKeys 的极端目录）：这时若仍只按 items 取回退值就会得到空串，循环被判为
  // "已列举完"，而桶里明明还有下一页 —— 是一次静默截断。CommonPrefixes 本身就是
  // 合法的 marker（语义为"返回大于它的 key"），故一并纳入回退。
  const lastOf = (arr) => (arr.length ? arr[arr.length - 1].key : '');
  const nextMarker = isTruncated
    ? (data.NextMarker || lastOf(items) || (prefixes.length ? prefixes[prefixes.length - 1] : ''))
    : '';
  return { items, prefixes, nextMarker, isTruncated };
}

/**
 * 与 {@link listAll} 相同，但额外返回 `truncated`：指示结果是否因达到 cap 而被截断。
 *
 * 这是 FUN-04 的关键前提 —— 旧调用方用「拿到的条数 == cap」来反推是否截断，
 * 一旦上游发生多余忍拳就误判为「已列完」，进而在对象未删干净时就去清元数据。
 *
 * @returns {Promise<{items: Array, truncated: boolean, cap: number}>}
 */
async function listAllInfo(cos, cfg, prefix, { cap, noStat = false, skipPrefixSelf = false } = {}) {
  const limit = resolveCap(cap, LIMITS.HARD_MAX);
  const all = [];
  let marker = '';
  let truncated = true;
  while (truncated && all.length < limit) {
    const page = await listPage(cos, cfg, prefix, { marker, noStat, skipPrefixSelf });
    for (const it of page.items) {
      all.push(it);
      if (all.length >= limit) break;
    }
    truncated = page.isTruncated;
    marker = page.nextMarker;
    if (!marker) break;
  }
  if (all.length > limit) all.length = limit;
  return { items: all, truncated, cap: limit };
}

/**
 * 列举**必须完整**的对象集合：一旦因达到 cap 被截断就抛错，绝不返回部分集合。
 *
 * 用于「列举 → 复制 → 删源」这类场景（重命名 / 移动目录）。旧调用方用
 * `listAll(cap)` 拿部分集合继续走流程，而随后的删除按**整个前缀**执行 ——
 * 超出 cap 的那部分对象被删却没复制，数据不可逆丢失（FUN-02）。
 *
 * 全项目只有这一处「完整列举」判定，routes/fs.js 与 fs-gateway.js 共用，
 * 避免各处自己写一遍 `if (info.truncated)` 而漏掉某个分支。
 *
 * @param {object} cos
 * @param {object} cfg
 * @param {string} prefix
 * @param {object} [opts]  同 {@link listAllInfo}
 * @param {string} [what]  用于错误文案的操作名，如「移动」
 * @returns {Promise<Array<{key:string,size:number,lastModified:string}>>}
 */
async function listAllExact(cos, cfg, prefix, opts = {}, what = '处理') {
  const info = await listAllInfo(cos, cfg, prefix, opts);
  if (info.truncated) {
    const e = new Error(
      `「${prefix}」下对象数超过单次要${what}的上限（${info.cap}）。`
      + `为避免只复制一部分就删除源数据，已中止且未做任何改动；请分批${what}其中的子目录。`
    );
    e.status = 400;
    e.truncated = true;
    e.cap = info.cap;
    throw e;
  }
  return info.items;
}

/**
 * 绕道 `module.exports` 调用 {@link p}。
 *
 * 测试用 `cos.p = 桩` 替换的是**导出对象上的属性**；本文件内的其它函数若直接调
 * 模块作用域的 `p`，桩就打不到它们。对本函数而言后果很具体：桩失效 → 真实 `p` 去
 * 调假客户端上不存在的 `deleteMultipleObject` → 整批失败 → 什么也测不到，护栏只能
 * 退化成"直接桩掉本函数"（那就等于没测判据本身）。
 *
 * 绕一次导出对象即可让既有 `cos.p` 桩继续生效；生产环境下与直接调 `p` 完全等价。
 */
function callP(...args) {
  return module.exports.p(...args);
}

/**
 * 批量删除，并返回「云端**明确确认**已删除」的 key（R9-02 / R10-03 的唯一判据）。
 *
 * 为什么必须有它：S3 的 `DeleteObjects` 对整批回 **200**，单个对象的失败（对象锁、
 * 合规保留、桶策略 `Deny s3:DeleteObject`、对象不存在……）只写在响应体的 `<Error>`
 * 里。调用方若把「整批返回成功」当成「全部删掉了」，就会对**仍然存在**的对象执行
 * 两个本项目自定为**不可逆**的动作：
 *   ① `removeMetaBatch` 清掉活密文的 IV / TAG / 盐 → 文件永久不可解；
 *   ② `markMissingByKeys` 把指向它的分享链接标成已删除 → 已分发的 URL 永久失效。
 *
 * 判据必须是**白名单**（只认明确出现在 `Deleted` 里的 key），而不是「不在 `Error`
 * 里就算成功」的黑名单 —— 后者在厂商响应体既无 `<Deleted>` 也无 `<Error>`
 * （协议外行为 / 解析退化）时会把未确认的删除当成成功。
 *
 * 集中在此处的理由：`/fs/delete`、`/fs/move` 的目录分支、清空桶、WebDAV 删目录
 * **四处**都要同一套判据。上一轮只改了其中一处，另三处漏网（R10-03）——
 * 这正是「同一状态多个入口，改一处漏一处」，故下沉为共用函数。
 *
 * @param {object} cos   客户端
 * @param {object} cfg   桶配置（bucket / region）
 * @param {string[]} keys 待删除的 key
 * @returns {Promise<{okKeys: string[], errors: Array<{key:string, message:string}>}>
 *   `okKeys` = 云端确认已删除的 key（**只**用它做元数据清理 / 分享链接标记）
 */
async function deleteMultipleConfirmed(cos, cfg, keys) {
  const list = Array.isArray(keys) ? keys.filter((k) => typeof k === 'string' && k) : [];
  if (!list.length) return { okKeys: [], errors: [] };

  const byKey = new Map(list.map((k, i) => [k, i]));
  const okSet = new Set();      // key -> 云端明确确认已删除
  const errMap = new Map();     // key -> 人可读原因

  try {
    const r = await callP(cos, 'deleteMultipleObject', {
      Bucket: cfg.bucket, Region: cfg.region,
      Objects: list.map((k) => ({ Key: k })),
    });
    for (const d of (Array.isArray(r && r.Deleted) ? r.Deleted : [])) {
      if (!d || d.Key === undefined) continue;
      if (byKey.has(d.Key)) okSet.add(d.Key);
    }
    const errs = Array.isArray(r && r.Error) ? r.Error : (r && r.Error ? [r.Error] : []);
    for (const err of errs) {
      if (!err || err.Key === undefined) continue;
      if (byKey.has(err.Key)) errMap.set(err.Key, err.Message || err.Code || '云端拒绝删除该对象');
    }
  } catch (e) {
    // 整批失败：全部标记失败 —— 调用方据此**不做任何**元数据清理
    for (const k of list) errMap.set(k, e && e.message ? e.message : '批量删除失败');
  }

  // 既不在 Deleted 也不在 Error → 云端没有确认 → 保守地视为未删除
  for (const k of list) {
    if (!okSet.has(k) && !errMap.has(k)) {
      errMap.set(k, '云端未确认该对象的删除结果（响应中既无 Deleted 也无 Error），已按未删除处理');
    }
  }

  const okKeys = list.filter((k) => okSet.has(k));
  const errors = list.filter((k) => errMap.has(k)).map((k) => ({ key: k, message: errMap.get(k) }));
  return { okKeys, errors };
}

/** 校验并规范化对象 Key（禁止越权路径） */
function normalizeKey(key) {
  if (typeof key !== 'string') throw badRequest('Key 必须为字符串');
  let k = key.replace(/\\/g, '/').replace(/^\/+/, '');
  if (k.includes('..')) throw badRequest('Key 不能包含 ..');
  return k;
}

function badRequest(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}

/** CopySource 的 Key 需逐段百分号编码（保留 '/' 作分隔符） */
function encodeCopyPath(key) {
  return String(key).split('/').map(encodeURIComponent).join('/');
}

/**
 * 构造对象复制的 CopySource（**全项目唯一实现**，routes.js 与 fs-gateway.js 共用）。
 *
 * - S3 兼容厂商：`/bucket/key`（键需百分号编码）
 * - 腾讯云 COS：外链域名形式 `bucket.cos.<region>.myqcloud.com/key`
 *
 * 历史上 fs-gateway.js 内曾硬编码 COS 外链域名形式，导致经网关（WebDAV / 部分文件操作）
 * 触发的复制在 S3 厂商上 CopySource 格式错误而失败，与 routes.js 行为不一致 —— 故统一到此。
 */
function copySource(provider, bucket, region, key) {
  if (providers.isS3(provider)) return `/${bucket}/${encodeCopyPath(key)}`;
  return `${bucket}.cos.${region}.myqcloud.com/${encodeCopyPath(key)}`;
}

module.exports = {
  getClient, createClient, providerOf, p, tracked, translateError,
  listAll, listAllInfo, listAllExact, listPage, LIMITS, normalizeKey, badRequest,
  copySource, encodeCopyPath, deleteMultipleConfirmed,
};
