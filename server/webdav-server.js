/**
 * WebDAV 服务 —— 将当前激活的对象存储桶通过 WebDAV 协议暴露
 *
 * 安全约束：
 *  - 仅监听独立的 HTTPS 端口（复用本地自签名证书），强制加密传输，拒绝明文 HTTP
 *  - HTTP Basic 认证（账户在「系统设置 → WebDAV」中管理，密码字段级加密存储）
 *  - 连续认证失败按用户名锁定，防暴力枚举（复用 security.createFailLock）
 *  - 未启用或无有效账户时服务不监听端口
 *
 * 协议：OPTIONS / PROPFIND / GET / HEAD / PUT / DELETE / MKCOL / MOVE / COPY
 * 路径挂载点：/dav/（/dav/ 之后即对象存储 Key）
 */
const express = require('express');
const https = require('https');
const { URL } = require('url');
const configStore = require('./config-store');
const security = require('./security');
const statsStore = require('./stats-store');
const { getClient, p, normalizeKey, listAllExact, translateError, uploaderMeta } = require('./cos');
const providers = require('./providers');
const gateway = require('./fs-gateway');
/**
 * R25：按 API Key 的配额闸门 + 写入增量记账。
 *
 * 直接 require **根级模块**而不是 `routes/_shared` —— 依赖图是单向的
 * `routes/* → routes/_context → webdav-server → fs-gateway → cos`，反向 require
 * `routes/_shared` 会构成循环（见 `bucket-stats.js` 文件头）。
 */
const bucketStats = require('./bucket-stats');
const ipGuard = require('./ip-guard');
/**
 * R37：下载限速的唯一入口。
 *
 * 客户端 IP 一律取 `security.clientIp(req)` 返回的**原始 IP 字符串** ——
 * 与 `ipGuard.evaluate(ip, …)` / `speedLimitFor(ip, …)` 同形状；**不要**传
 * `security.clientIpInfo(req)` 那个 `{ip, fromForwarded}` 包装对象（CIDR 匹配
 * 会读到 `undefined`，于是「限速配好了却静默不生效」）。
 *
 * ⚠️ WebDAV 的 GET 是一条**独立的下发路径**（`r.stream.pipe(res)`），
 * 不经过 `download-stream.streamDownload()`，因此**必须单独接线** ——
 * 否则「主站下载被限速、WebDAV 挂载照样全速」，限速形同虚设（要求⑤）。
 * 复用的是同一个工厂函数，不是另写一份限速逻辑。
 */
const { makeThrottle } = require('./throttle');
const { LIMITS } = require('./limits');
const { getSelfSignedCert } = require('./local-cert');

/**
 * R21-14：回给 WebDAV 客户端的错误文案**不得包含上游原始 message**。
 *
 * 管理端刻意只回分类文案、把原始串放进 `err.rawMessage`（仅服务端日志）——
 * 因为 SDK 的 message 里可能带请求 ID、端点、AccessKeyId 片段。WebDAV 侧此前
 * 直接把 `e.message` 发给客户端（R21-14 只收口了 GET/HEAD 与 PUT 两处；
 * R22-03 把 PROPFIND / MKCOL / DELETE / COPY 四处一并改调本函数 —— 该文件内
 * **不得再出现裸 `send(e.message)`**）。
 *
 * 判据不是「哪些文案要翻译」而是「这个错误是不是上游来的」：
 *  - 上游错误（COS SDK / s3-client）带 `statusCode`，或被 `translateError` 包过（带 `rawMessage`）；
 *  - 本进程自己生成的校验错误（如 `Range 格式无效`、`上传数据超过上限…`，由 fs-gateway 抛出、
 *    只带 `status`）不含任何上游信息，原文透出对排查更有价值，保留。
 */
function davErrorMessage(e) {
  const fromUpstream = !!e && (e.statusCode !== undefined || e.rawMessage !== undefined);
  if (!fromUpstream) return String((e && e.message) || '操作失败，请重试');
  return translateError(e).message;
}

/** WebDAV 认证失败锁定：连续 5 次失败锁定 1 分钟起，最长 30 分钟（按用户名） */
const webdavLock = security.createFailLock({ name: 'webdav', maxFails: 5, baseLockMs: 60 * 1000, maxLockMs: 30 * 60 * 1000 });

const MOUNT = '/dav';
const DEFAULT_PORT = Number(process.env.WEBDAV_PORT) || 8443;
const HOST = process.env.HOST || '127.0.0.1';
// FUN-11：上限一律取自 limits.js（旧值在此硬编码 20000，是集中值的 4 倍）。
// 与 PERF-04「列举上限集中定义」保持一致，避免各处数字互不知情。
const PROPFIND_CAP = LIMITS.PROPFIND;

/**
 * R8-17：**实际实现**的 WebDAV 动词，与 OPTIONS 的 `Allow` 头同源。
 * 未列入者一律 405（而不是落到 SPA 兜底的 404）——
 * 尤其 `LOCK`/`UNLOCK`/`PROPPATCH`：本服务不实现 locking，
 * 而资源管理器与 Office 在写入前会先尝试 `LOCK`，需要拿到明确的"不支持"。
 */
const WEBDAV_METHODS = new Set([
  'OPTIONS', 'PROPFIND', 'GET', 'HEAD', 'PUT', 'DELETE', 'MKCOL', 'MOVE', 'COPY',
]);

let server = null;
let starting = null;

/* ------------------------------ XML / 路径工具 ------------------------------ */

function xmlEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function hrefFor(key) {
  // key 以 / 结尾表示目录
  const enc = key.split('/').map((seg) => encodeURIComponent(seg)).join('/');
  return MOUNT + '/' + enc;
}

/**
 * 请求路径是否落在 WebDAV 挂载点上（R34）
 *
 * 判据此前**手写在 9 处**（`req.path.startsWith(MOUNT)` / `destPath.startsWith(MOUNT + '/')`），
 * 而根路径 `/` 在其中的**大部分**地方被落在门外 —— 只有挂载点边界中间件显式放行了它。
 * 于是同一个路径上的两个回答互相矛盾：
 *   - `app.options()` 的路径参数是**正则**（匹配任意路径），`/` 命中 → **200 + `DAV: 1`**，
 *     客户端据此判定「这里是 WebDAV」；
 *   - `app.propfind('*')` 里的前缀判据把 `/` 挡掉 → 落到 Express 默认兜底，
 *     回一页 **HTML 404 `Cannot PROPFIND /`**。
 *
 * 这正是用户报告的那条链：`OPTIONS /` 的 200 让客户端愿意弹凭据框 → 401 挑战 → 密码输对 →
 * 列目录撞 404 → 客户端无法确认这是个集合 → 「输入的文件夹似乎无效，请选择另一个」。
 * 密码框先弹、报错在其后，顺序完全对上。
 *
 * 根路径上那个 301（`app.get('/')`）救不了它：**WebDAV 客户端从不用 GET 打开集合**，
 * 第一步就是 PROPFIND，重定向对它们等于不存在。
 *
 * 因此把 `/` 与 `/dav` 一样当作挂载点本身：`reqPathToKey` 对两者都得到空 key（根集合）。
 * ⚠️ 只特判**正好等于** `/` 的根路径 —— 不能把整个根命名空间都算作挂载点，
 * 那会撤销 FUN-06 划下的边界（「挂载点之外不可读、不可写」）。
 */
function inMount(reqPath) {
  return reqPath === '/' || reqPath === MOUNT || reqPath.indexOf(MOUNT + '/') === 0;
}

/**
 * 请求路径 -> 对象 Key（去掉挂载前缀；目录保留尾部 /）
 *
 * SEC-12：与 `cos.js` 共用 `normalizeKey()`，不再手写剥离。
 * 旧实现不禁 `..`（`PUT /dav/..%2f..%2fx` 会写出含 `..` 的 key），
 * 而管理端 `normalizeKey` 拒绝 `..` —— 于是这些对象在界面**既看不到也删不掉**，
 * 成为持续计费的幽灵对象。畸形百分号编码还会让 `decodeURIComponent` 抛 URIError → 500。
 */
function reqPathToKey(reqPath) {
  let pth;
  try {
    pth = decodeURIComponent(reqPath.split('?')[0]);
  } catch (e) {
    const err = new Error('路径编码非法（百分号转义格式错误）');
    err.status = 400;
    throw err;
  }
  // R34：前缀剥离必须按**路径段**匹配。手写 `startsWith(MOUNT)` 会把 `/davx` 的前缀也剥掉，
  // 得到 key `x` —— 一个「管理界面看不到、WebDAV 却能读」的幽灵命名空间
  // （与 SEC-12 修掉的 `..` 幽灵对象同型）。`inMount` 已经把这类路径挡在挂载点之外，
  // 这里再独立成立一次，避免它成为后续调用者的陷阱。
  if (pth === MOUNT || pth.indexOf(MOUNT + '/') === 0) pth = pth.slice(MOUNT.length);
  return normalizeKey(pth); // 禁 '..'、反斜杠归一、剥前导斜杠；空串表示根
}

function rfcDate(s) {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d) ? null : d.toUTCString();
}

function guessContentType(key) {
  const ext = key.includes('.') ? key.split('.').pop().toLowerCase() : '';
  const map = {
    html: 'text/html', htm: 'text/html', txt: 'text/plain', md: 'text/plain',
    css: 'text/css', js: 'application/javascript', json: 'application/json', xml: 'application/xml',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
    svg: 'image/svg+xml', pdf: 'application/pdf', zip: 'application/zip',
    mp4: 'video/mp4', mp3: 'audio/mpeg',
  };
  return map[ext] || 'application/octet-stream';
}

/**
 * R14-06：能被浏览器**内联渲染并执行脚本**的 MIME 类型（对比时忽略 `;charset=…` 后缀）。
 *
 * 这些类型在 GET 响应里被强制改成 `Content-Disposition: attachment`：
 * WebDAV 的定位是文件存取，内联渲染带来的只有风险（见 `buildApp` 里的安全头说明）。
 */
const RENDERABLE_TYPES = new Set(['text/html', 'image/svg+xml', 'application/xhtml+xml']);

/* ------------------------------ 对象列举 ------------------------------ */

async function requireCos() {
  const cfg = configStore.get();
  // 地域仅在厂商要求时才必填（如又拍云 S3 兼容接口无需地域）
  const prov = providers.get(cfg && cfg.provider) || providers.resolve(cfg && cfg.provider);
  const needRegion = prov.regionRequired !== false;
  if (!cfg || !cfg.secretId || !cfg.secretKey || !cfg.bucket || (needRegion && !cfg.region)) {
    const e = new Error('尚未完成对象存储密钥与存储桶配置，WebDAV 无法提供服务');
    e.status = 503;
    throw e;
  }
  return { cfg, cos: getClient(cfg) };
}

/**
 * 列举一层（Delimiter=/）：返回文件数组、子目录前缀数组与截断标志。
 *
 * R8-22：必须**翻页到底**。旧实现只取一页（`MaxKeys: 1000`）且完全不读
 * `IsTruncated` / `NextMarker` —— 子项超过 1000 的目录在资源管理器 / Finder /
 * rclone 里就「只有 1000 个」，既不完整、也无任何提示，用户看到的是
 * 「一个看起来正常但少了东西的目录」。总量由 `PROPFIND_CAP` 兜底。
 *
 * @returns {Promise<{files: object[], dirs: object[], truncated: boolean}>}
 *   `truncated` 为真表示**结果仍不完整**（已达 PROPFIND_CAP 或云端不再给游标），
 *   调用方必须把它显式告出去，不能默默丢弃。
 */
async function listLevel(cos, cfg, prefix) {
  const files = [];
  const dirs = [];
  let marker = '';
  let truncated = false;
  let more = true;
  while (more) {
    const data = await p(cos, 'getBucket', {
      Bucket: cfg.bucket, Region: cfg.region,
      Prefix: prefix, Delimiter: '/', Marker: marker, MaxKeys: 1000,
    }, { noStat: true });
    const contents = data.Contents || [];
    let capped = false;
    for (const c of contents) {
      if (c.Key === prefix) continue; // 目录标记对象本身不算「文件」
      if (files.length + dirs.length >= PROPFIND_CAP) { capped = true; break; }
      files.push({ key: c.Key, size: Number(c.Size) || 0, lm: c.LastModified, dir: false });
    }
    if (!capped) {
      for (const x of data.CommonPrefixes || []) {
        if (files.length + dirs.length >= PROPFIND_CAP) { capped = true; break; }
        dirs.push({ key: x.Prefix, size: 0, lm: '', dir: true });
      }
    }
    // 游标优先取云端给的 NextMarker；未给则回退到本页最后一个 Key
    // （与 listAll/listPage 的既有约定一致，避免不同厂商返回口径不一致导致死循环）
    marker = data.NextMarker || (contents.length ? contents[contents.length - 1].Key : '');
    const isTrunc = String(data.IsTruncated) === 'true';
    if (capped) { truncated = true; more = false; }
    else if (!isTrunc) { more = false; }
    else if (!marker) { truncated = true; more = false; } // 云端说"还有"但不给游标 → 只能停
  }
  return { files, dirs, truncated };
}

/**
 * WebDAV `Overwrite: F` 的唯一判据：目标是否已存在。
 *
 * ## R10-11：此前有两套实现，且各自漏判一种形态
 *
 * | 位置 | 旧判据 | 漏判形态 |
 * |------|--------|----------|
 * | 文件分支（`!srcKey.endsWith('/')`） | `headObject(dstKey)` | ——（这个是对的） |
 * | 目录 MOVE | `listLevel(dst + '/')` 只看一层 | ① 目标是**已存在的文件**：`listLevel('plain.txt/')` 命不中 → 不报 412，随后把源目录整个写进 `plain.txt/` 前缀；② 目标是**空目录**：只有 `dir/` 一个占位对象，而 `listLevel` 里 `if (c.Key === prefix) continue` 会把它跳过 → 也不报 412 |
 * | 目录 COPY | 循环内**逐对象** `headObject(target)` | 要在复制掉一部分对象之后才发现冲突（RFC 4918 §9.8.4 要求整体拒绝）；且只查"源里也有的 rel key"，目标多出来的对象查不到 |
 *
 * 三处收敛到本函数，判据按「先精确、后列举」的顺序覆盖四种存在形态：
 *
 *   1. 目标路径本身是一个已存在的**文件**（含"把目录写到某个已存在文件之下"）；
 *   2. 目标是一个**目录占位对象**（空目录只有 `dir/` 这一个 0 字节标记对象）；
 *   3. 目标目录下有**任意一层子项**（文件或子目录前缀）—— 判定"非空"只需第一层，
 *      刻意不递归（超大目标上递归全量列举纯属浪费）。
 *
 * 探测本身失败（网络抖动 / 403）时**按不存在返回**：`Overwrite: F` 的目标是
 * "不要覆盖我没见过的东西"，探测失败意味着服务端没能确认目标存在，此时放行由
 * 云端自己的条件写来兜 —— 反之若按"存在"返回，一次抖动就会让所有同步静默失败。
 *
 * @param {object} cos 客户端
 * @param {object} cfg 桶配置
 * @param {string} dstKey 目标对象键（可带尾斜杠）
 * @param {boolean} srcIsDir 源是否为目录（决定要不要查 2/3 两种目录形态）
 * @returns {Promise<boolean>}
 */
async function destinationExists(cos, cfg, dstKey, srcIsDir) {
  const bare = String(dstKey || '').replace(/\/+$/, '');
  const head = async (Key) => {
    try {
      await p(cos, 'headObject', { Bucket: cfg.bucket, Region: cfg.region, Key }, { noStat: true });
      return true;
    } catch (e) { return false; }
  };
  const prefix = bare + '/';
  // ① 目标路径本身是一个已存在的文件
  if (bare && await head(bare)) return true;
  if (!srcIsDir) {
    /**
     * R11-09：文件源也要排除「目标是一个已存在的**目录**」。
     *
     * R10-11 把目录源的 4 种目标形态收敛齐了，文件源却在 `return false` 里漏掉
     * 目录形态 —— 于是 `COPY a.txt → dirB/（Overwrite: F）` 回 **201**，
     * 下一次覆盖还会把目录占位对象 `dirB/` 写成文件内容（目录凭空消失）。
     * RFC 4918 §9.8.4 要求此时的结果是 409/412。
     */
    if (await head(prefix)) return true; // ② 目录占位对象
    try {
      const lvl = await listLevel(cos, cfg, prefix); // ③ 目录下任意一层子项
      return Boolean((lvl.files && lvl.files.length) || (lvl.dirs && lvl.dirs.length));
    } catch (e) { return false; }
  }
  // ② 目录占位对象（空目录）
  if (await head(prefix)) return true;
  // ③ 目录下任意一层子项
  try {
    const lvl = await listLevel(cos, cfg, prefix);
    return Boolean((lvl.files && lvl.files.length) || (lvl.dirs && lvl.dirs.length));
  } catch (e) { return false; }
}

/**
 * R27-16：条件请求求值（RFC 7232 §3.1 `If-Match` / §3.2 `If-None-Match`）。
 *
 * 为什么必须做：本服务在 HEAD / GET 上**宣告了 `ETag`**（`:648` / `:696`），而
 * 「宣告 ETag」在 HTTP 语义里就是承诺「客户端可以用它做条件写」。全库此前
 * `grep -i "if-match|if-none-match"` **零命中** —— 于是同步工具 / Office 在覆盖前发的
 * `PUT If-Match: "<etag>"`（或建新文件用的 `If-None-Match: *`）被**无条件执行**：
 * 客户端以为"我的版本没被别人改过"，服务端却直接覆盖，两边各自的修改静默丢一份。
 * 这类丢失没有任何报错，也是 WebDAV 客户端最难排查的一类问题。
 *
 * 只对**带了条件头**的请求多花一次 `headObject`（普通读写零开销）。
 * `If-Match` 用强比较（去掉 `W/` 与引号后逐字比）；`*` 表示"只要存在"。
 * 求值失败返回 `{ status, message }`，调用方据此回 412。
 *
 * @returns {Promise<null | {status:number, message:string}>} null = 条件满足，放行
 */
async function checkPreconditions(req, cfg, key) {
  const ifMatch = String(req.headers['if-match'] || '').trim();
  const ifNoneMatch = String(req.headers['if-none-match'] || '').trim();
  if (!ifMatch && !ifNoneMatch) return null;

  let etag = '';
  try {
    const st = await gateway.headObject(cfg.bucket, key);
    etag = String((st && st.etag) || '');
  } catch (e) {
    etag = ''; // 不存在 / 探测失败 → 按「无当前实体」处理
  }
  const strip = (v) => String(v).replace(/^W\//i, '').replace(/^"|"$/g, '').trim();
  const listOf = (v) => v.split(',').map(strip).filter(Boolean);
  const current = strip(etag);

  if (ifMatch) {
    if (ifMatch === '*') {
      if (!current) return { status: 412, message: '412 Precondition Failed：If-Match: * 但目标不存在' };
    } else if (!current || !listOf(ifMatch).includes(current)) {
      return {
        status: 412,
        message: `412 Precondition Failed：If-Match 与当前 ETag 不一致（服务端为 ${current || '（不存在）'}）—— `
          + '目标已被其它客户端修改，请先取回最新版本再重试',
      };
    }
  }
  if (ifNoneMatch) {
    if (ifNoneMatch === '*') {
      if (current) return { status: 412, message: '412 Precondition Failed：If-None-Match: * 但目标已存在' };
    } else if (current && listOf(ifNoneMatch).includes(current)) {
      return { status: 412, message: '412 Precondition Failed：If-None-Match 命中当前 ETag' };
    }
  }
  return null;
}

/**
 * 逐页遍历某前缀下的全部对象（**不截断**），每页回调一次。
 *
 * R8-16：`listRecursive()` 会在 `PROPFIND_CAP` 处静默截断并直接 return。这对
 * 「宁可截断也不能无界增长」的 PROPFIND 尚可（配合显式告警），但对 **COPY** 是
 * 灾难：源目录 6000 个对象时只复制前 5000 个，客户端拿到 201 后按协议删除源目录
 * → 永久丢失 1000 个对象。凡是"列举 → 复制/删除"的路径都必须逐页处理。
 *
 * @param {(items: object[], page: {isTruncated: boolean, nextMarker: string}) => any} onPage
 *   返回 `false` 表示调用方要求提前停止翻页。
 */
async function forEachPrefixPage(cos, cfg, prefix, onPage) {
  let marker = '';
  let more = true;
  while (more) {
    const data = await p(cos, 'getBucket', {
      Bucket: cfg.bucket, Region: cfg.region,
      Prefix: prefix, Delimiter: '', Marker: marker, MaxKeys: 1000,
    }, { noStat: true });
    const items = [];
    for (const c of data.Contents || []) {
      if (c.Key === prefix) continue;
      items.push({ key: c.Key, size: Number(c.Size) || 0, lm: c.LastModified, dir: false });
    }
    const isTruncated = String(data.IsTruncated) === 'true';
    marker = data.NextMarker || (items.length ? items[items.length - 1].key : '');
    if (await onPage(items, { isTruncated, nextMarker: marker }) === false) return;
    more = isTruncated && !!marker;
  }
}

/**
 * 递归列举前缀下全部对象（Depth: infinity）—— **有上限**。
 *
 * PROPFIND 的响应体是整体驻留内存后一次发出的（`multistatus()`），因此这里刻意
 * 保留 `PROPFIND_CAP` 截断；但**必须把截断事实告诉调用方**（旧实现在函数中间
 * `return out`，调用方无从得知，用户只会觉得"目录少了东西"）。
 *
 * @returns {Promise<{items: object[], truncated: boolean}>}
 */
async function listRecursive(cos, cfg, prefix) {
  const out = [];
  let truncated = false;
  await forEachPrefixPage(cos, cfg, prefix, (items) => {
    for (const it of items) {
      if (out.length >= PROPFIND_CAP) { truncated = true; return false; }
      out.push(it);
    }
    return true;
  });
  return { items: out, truncated };
}

/**
 * R8-16 / R8-22：把「这次列举没列完」的事实显式告出去。
 *
 * RFC 4918 没有为 PROPFIND 定义截断语义（207 只是"多状态"），而 WebDAV 客户端
 * 也不读自定义响应头。刻意**不**往 207 体里塞伪 `<D:response>` —— 那会被资源管理器
 * 当成一个真实条目渲染成幽灵文件，比不提示更糟。因此用两条不干扰协议的通道：
 *  ① 响应头 `X-WebDAV-Truncated`（脚本化客户端 / 抓包排查时可见）；
 *  ② 审计日志 `level: 'warn'`（管理端「操作日志」里能查到具体路径与条数）。
 */
function noteTruncation(res, where, count, path) {
  res.setHeader('X-WebDAV-Truncated', String(count));
  res.setHeader('X-WebDAV-Truncated-Reason', 'PROPFIND_CAP');
  statsStore.addLog({
    action: 'webdav.propfind', level: 'warn',
    detail: `WebDAV 列举被截断：${where}「${path}」仅返回前 ${count} 项（上限 PROPFIND_CAP=${PROPFIND_CAP}），`
      + '客户端看到的目录不完整；请分目录访问或改用 Web 界面',
  });
}

/* ------------------------------ 认证与 HTTPS 守卫 ------------------------------ */

function unauthorized(res) {
  res.setHeader('WWW-Authenticate', 'Basic realm="WebDAV", charset="UTF-8"');
  res.status(401).type('text/plain').send('401 Unauthorized：WebDAV 需要账户认证');
}

async function authMiddleware(req, res, next) {
  // 双保险：该服务本就只在 HTTPS 上监听；任何明文请求一律拒绝
  if (!req.socket || !req.socket.encrypted) {
    return res.status(403).type('text/plain').send('403 Forbidden：WebDAV 强制使用 HTTPS，拒绝明文 HTTP 连接');
  }
  const w = configStore.getWebdav();
  if (!w.enabled) return res.status(503).type('text/plain').send('503 Service Unavailable：WebDAV 未启用');

  const h = req.headers.authorization || '';
  if (!/^Basic\s+/i.test(h)) return unauthorized(res);
  let user = '', pass = '';
  try {
    const decoded = Buffer.from(h.replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    user = i < 0 ? decoded : decoded.slice(0, i);
    pass = i < 0 ? '' : decoded.slice(i + 1);
  } catch (e) { return unauthorized(res); }

  const ip = security.clientIp(req) || 'unknown';

  // 防爆破：连续失败按用户名锁定（Claude issue #3）
  const lockKey = `${ip}|${user}`;
  const lockedLeft = webdavLock.locked(lockKey);
  if (lockedLeft > 0) {
    res.setHeader('Retry-After', String(lockedLeft));
    return res.status(429).type('text/plain')
      .send(`429 Too Many Requests：认证失败次数过多，请 ${lockedLeft} 秒后重试`);
  }

  /**
   * SEC-05 + R8-05：**认证失败**时统一记账并回答。
   *
   * SEC-05 的本意是「防匿名爆破」—— 那个攻击是**失败**驱动的。旧实现把
   * `webdavAuthLimiter(ip)` 放在凭据校验**之前**，于是它退化成全局 QPS 闸门：
   * 第三方客户端一次目录刷新就发几十个 `PROPFIND`/`GET`，第 31 个起全部
   * 429 + `Retry-After: 60`，而且 `createLimiter` 只自增、认证成功**也不会重置**，
   * 于是「复制中断、目录刷不出来、反复重连」。正常挂载被硬性封顶在 30 请求/分钟。
   *
   * 现在两层限流都只在失败路径上计数：成功的请求永远不消耗任何配额。
   *
   * @returns {boolean} 是否已由本函数回答（true = 调用方不要再回答）
   */
  const rejectAuthFailure = () => {
    const rl = security.webdavAuthLimiter(ip);
    if (!rl.ok) {
      res.setHeader('Retry-After', String(rl.retryAfter));
      res.status(429).type('text/plain')
        .send(`429 Too Many Requests：该 IP 认证失败次数过多，请 ${rl.retryAfter} 秒后重试`);
      return true;
    }
    const left = webdavLock.fail(lockKey);
    if (left > 0) {
      res.setHeader('Retry-After', String(left));
      res.status(429).type('text/plain')
        .send(`429 Too Many Requests：认证失败次数过多，请 ${left} 秒后重试`);
      return true;
    }
    return false;
  };

  let r;
  try {
    r = await configStore.authenticateWebdav(user, pass); // SEC-05：异步 scrypt，不阻塞事件循环
  } catch (e) {
    if (rejectAuthFailure()) return undefined;
    return unauthorized(res);
  }
  if (!r.ok) {
    if (rejectAuthFailure()) return undefined;
    return unauthorized(res);
  }
  webdavLock.reset(lockKey);
  req.webdavUser = r.account;
  next();
}

/* ------------------------------ XML 响应构造 ------------------------------ */

function propResponse(href, item) {
  const lm = item && item.lm ? rfcDate(item.lm) : null;
  let props;
  if (item && item.dir) {
    /**
     * R11-16：`<D:displayname>` 必须取**原始 key** 的末段，不能取 href 的末段。
     *
     * href 是百分号编码后的 URL 片段 —— `my dir/` 会显示成 `my%20dir`、
     * 中文目录显示成 `%E6%88%91…`（文件分支取的就是原始 key，两者此前不一致）。
     * 编码只应出现在 `<D:href>`，不应泄漏进显示名。
     */
    const dirName = String(item.key || '').replace(/\/+$/, '').split('/').pop() || '';
    props = `<D:resourcetype><D:collection/></D:resourcetype>` +
      `<D:displayname>${xmlEsc(dirName)}</D:displayname>` +
      (lm ? `<D:getlastmodified>${xmlEsc(lm)}</D:getlastmodified>` : '');
  } else if (item) {
    props = `<D:resourcetype/>` +
      `<D:displayname>${xmlEsc(item.key.split('/').pop())}</D:displayname>` +
      `<D:getcontentlength>${item.size}</D:getcontentlength>` +
      `<D:getcontenttype>${xmlEsc(guessContentType(item.key))}</D:getcontenttype>` +
      (lm ? `<D:getlastmodified>${xmlEsc(lm)}</D:getlastmodified>` : '');
  } else {
    props = `<D:resourcetype/>`;
  }
  return `<D:response><D:href>${xmlEsc(href)}</D:href>` +
    `<D:propstat><D:prop>${props}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
}

function multistatus(responses) {
  return `<?xml version="1.0" encoding="utf-8"?>` +
    `<D:multistatus xmlns:D="DAV:">${responses.join('')}</D:multistatus>`;
}

/* ------------------------------ Express 应用 ------------------------------ */

function buildApp() {
  const app = express();
  app.disable('x-powered-by');

  /**
   * R14-06：WebDAV 是**另一个 Express 实例**，主站 `index.js` 那套安全响应头
   * （nosniff / CSP / frame-ancestors）只挂在 3000/3443 上，这里一份都没有。
   *
   * 而 `guessContentType` 把 `html` 映射为 `text/html`、`svg` 映射为 `image/svg+xml`：
   * 任何人用浏览器打开 `https://host:8443/dav/a.html`（Basic 认证后浏览器会**缓存该源凭据**）
   * 就等于让桶里的一个文件在源内执行脚本，而后续 `fetch('/dav/...', { method: 'PUT' })`
   * 会被自动附加 Authorization —— 一个 HTML 文件即可拿到该账户名下全部桶的读写删权限；
   * 多账户共用一台 WebDAV 时构成跨用户提权。`.svg` 更隐蔽（内联渲染时 `<script>` 即执行）。
   *
   * `default-src 'none'; sandbox` 让即便内联渲染也无脚本可执行；
   * 可渲染类型再强制 `Content-Disposition: attachment`（见 `setContentHeaders`）。
   * 放在最前，使 403 / 404 等所有响应都带上。
   */
  app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  /**
   * SEC-07：IP 屏蔽（与 HTTP 主服务同一套判定）。
   *
   * WebDAV 监听独立端口，此前完全没有 IP 守卫 —— 主站的屏蔽规则对它形同虚设，
   * 被屏蔽的 IP 只要知道 WebDAV 账号就能继续读写同一个桶。
   * 放在认证**之前**：屏蔽命中时连 scrypt 都不必算，避免被当成算力放大器。
   */
  app.use((req, res, next) => {
    const v = ipGuard.guardRequest(req);
    if (v.ok) return next();
    // R28-06：文案走唯一实现点 `ipGuard.blockTip()`（此前 HTTP 与 WebDAV 各写一份，
    // 新增 `unparsable` 原因时只改了 HTTP 侧）
    const tip = ipGuard.blockTip(v.reason);
    res.status(403).type('text/plain').send(`403 Forbidden：${tip}（IP: ${v.ip || ipGuard.clientIp(req)}）`);
  });

  app.use(authMiddleware);

  /**
   * 挂载点边界中间件（FUN-06）
   *
   * 旧实现把「路径是否在 /dav 之下」的判断**逐 disperse 到每个方法里**：
   * PROPFIND / GET / HEAD / MKCOL / DELETE 都写了 `startsWith(MOUNT)`，
   * 唯独 PUT 漏了 —— 于是 `PUT https://host:8443/anything` 会在桶里创建键 `anything`，
   * 而 GET 只能经 `/dav/anything` 访问，产生「界面可见但 WebDAV 不可见」的幽灵对象。
   *
   * 逐方法判守正是这类遗漏的温床（新增一个动词就漏一次）。改为**前置统一中间件**：
   * 除了根重定向 `/` 与健康探测，任何不在挂载点之下的路径一律 404，
   * 从结构上保证「挂载点之外不可写、不可读」。
   */
  app.use((req, res, next) => {
    // R34：`OPTIONS *` 是 RFC 4918 §9.1 要求的**服务级**能力探测（「本仓库在至少某些命名空间里
    // 支持列出的特性」），它不指向任何资源，因此没有「在不在挂载点之下」可言 —— 必须放它过去
    // 交给下面的 OPTIONS 处理器，否则它会被这里当成越界路径回 404，而规范要求 `DAV` 头
    // **必须**出现在对 `*` 的 OPTIONS 响应上。旧实现就是这样把 `OPTIONS *` 答成 404 的。
    if (req.method === 'OPTIONS' && req.path === '*') return next();
    // 根路径 / 与 /dav 都算挂载点（见 inMount）；其余必须在 MOUNT（/dav）之下或正好等于它
    if (inMount(req.path)) return next();
    return res.status(404).type('text/plain').send('404 Not Found：WebDAV 仅挂载于 ' + MOUNT + '/');
  });

  // CORS 预检 / 能力声明（部分客户端先发 OPTIONS）
  //
  // R8-17：`DAV` 头必须**只声明真正实现的能力**。旧实现写 `DAV: 1, 2`，
  // 而 RFC 4918 的 level 2 意味着支持 locking（LOCK/UNLOCK）；本服务全文件没有任何
  // LOCK/UNLOCK/PROPPATCH 路由，未匹配方法落到 404。于是 Windows 资源管理器 / Office
  // 在写入前尝试 `LOCK` 拿到 404，行为未定义（常见表现是「能浏览但写不了」），
  // 同时两个响应头自相矛盾。这里如实降为 `1`，并从 `Allow` 中剔除未实现的动词。
  app.options(/.*/, (req, res) => {
    res.setHeader('DAV', '1');
    res.setHeader('Allow', 'OPTIONS, PROPFIND, GET, HEAD, PUT, DELETE, MKCOL, MOVE, COPY');
    res.setHeader('MS-Author-Via', 'DAV');
    res.status(200).end();
  });

  /**
   * R8-17：未实现的 WebDAV 动词必须回答 **405/501**，而不是落到 SPA 兜底的 404。
   *
   * 404 会让客户端以为「这个 URL 不存在」而放弃重试；405 才能正确表达
   * 「资源在、但这个动词不支持」。适配的动词清单与上面的 `Allow` 头保持单一来源。
   */
  app.use((req, res, next) => {
    if (!inMount(req.path)) return next();
    const m = String(req.method || '').toUpperCase();
    if (WEBDAV_METHODS.has(m)) return next();
    res.setHeader('Allow', 'OPTIONS, PROPFIND, GET, HEAD, PUT, DELETE, MKCOL, MOVE, COPY');
    return res.status(405).type('text/plain')
      .send(`405 Method Not Allowed：WebDAV 不支持 ${m}（本服务未实现 locking / PROPPATCH）`);
  });

  // 根 / 重定向到挂载点
  app.get('/', (req, res) => res.redirect(301, MOUNT + '/'));

  /* PROPFIND：列目录（Depth: 1 默认）或单对象属性（Depth: 0） */
  const propfind = async (req, res) => {
    try {
      const { cfg, cos } = await requireCos();
      const key = reqPathToKey(req.path);
      const depth = String(req.headers.depth || '1').toLowerCase();
      res.setHeader('Content-Type', 'application/xml; charset=utf-8');

      // 根集合
      if (!key) {
        const responses = [propResponse(MOUNT + '/', { dir: true, key: '', lm: '' })];
        if (depth !== '0') {
          const { files, dirs, truncated } = await listLevel(cos, cfg, '');
          for (const d of dirs) responses.push(propResponse(hrefFor(d.key), d));
          for (const f of files) responses.push(propResponse(hrefFor(f.key), f));
          if (truncated) {
            noteTruncation(res, 'PROPFIND Depth:1（根目录）', responses.length - 1, '/');
          }
        }
        return res.status(207).send(multistatus(responses));
      }

      // 判断对象 / 目录
      const isDir = key.endsWith('/');
      if (isDir) {
        // 目录标记对象可能不存在（虚拟目录），列举其内容即可证明存在
        const responses = [propResponse(hrefFor(key), { dir: true, key, lm: '' })];
        if (depth !== '0') {
          if (depth === 'infinity') {
            const { items, truncated } = await listRecursive(cos, cfg, key);
            for (const it of items) responses.push(propResponse(hrefFor(it.key), it));
            if (truncated) {
              noteTruncation(res, 'PROPFIND Depth:infinity', items.length, key);
            }
          } else {
            const { files, dirs, truncated } = await listLevel(cos, cfg, key);
            for (const d of dirs) responses.push(propResponse(hrefFor(d.key), d));
            for (const f of files) responses.push(propResponse(hrefFor(f.key), f));
            if (truncated) {
              noteTruncation(res, 'PROPFIND Depth:1', files.length + dirs.length, key);
            }
          }
        }
        return res.status(207).send(multistatus(responses));
      }

      // 文件：HEAD 校验存在
      let head;
      try {
        head = await p(cos, 'headObject', { Bucket: cfg.bucket, Region: cfg.region, Key: key }, { noStat: true });
      } catch (e) {
        return res.status(404).type('text/plain').send('404 Not Found');
      }
      const item = {
        key, dir: false,
        size: Number(head.headers['content-length']) || 0,
        lm: head.headers['last-modified'] || '',
      };
      return res.status(207).send(multistatus([propResponse(hrefFor(key), item)]));
    } catch (e) {
      // R22-03：与其余同型 catch 同一口径 —— 上游原始 message 只进服务端日志
      if (!res.headersSent) res.status(e.status || 500).type('text/plain').send(davErrorMessage(e));
    }
  };
  // PROPFIND 为非标准 HTTP 方法，Express 以小写方法名注册
  app['propfind']('*', (req, res, next) => {
    if (!inMount(req.path)) return next();
    propfind(req, res);
  });

  /* GET / HEAD：下载（经文件网关透明解密后下发明文）；HEAD 仅取属性 */
  const getObject = async (req, res, headOnly) => {
    try {
      const { cfg } = await requireCos();
      const key = reqPathToKey(req.path);
      if (!key || key.endsWith('/')) return res.status(405).type('text/plain').send('405 Method Not Allowed');

      /**
       * R8-15：HEAD 必须在 `readObject` **之前**分流。
       *
       * `readObject` 在返回前就已调用 `cos.getObject({ …, Output })` —— 请求已经发出。
       * 旧实现拿到返回结果后才 `stream.destroy()`，于是每个 HEAD = 1 次 `headObject`
       * + 1 次 `getObject`（白付一倍云端请求与连接）；大对象上更是「每次都开始传整个
       * 对象、只靠销毁中止」。而 WebDAV 客户端在几乎每次读/写/复制前都会发 HEAD。
       *
       * 这里只走 `gateway.headObject()`：不触碰任何流，明文大小由本地加密元数据换算
       * （加密对象的 `Content-Length` 必须报明文长度，与 GET 一致）。
       */
      if (headOnly) {
        const st = await gateway.headObject(cfg.bucket, key);
        const total = st.encrypted ? Number(st.origSize) || 0 : st.size;
        res.setHeader('Content-Type', st.contentType || 'application/octet-stream');
        /**
         * R11-11：`Accept-Ranges` 必须与 GET 的服务能力一致。
         *
         * 无条件宣告时，明文 > 32MB 的加密对象上任何 Range 只会得到 200 全量
         * （实测 `200 / accept-ranges: bytes / content-range: undefined`）—— 与
         * R8-23 修掉的「宣告未实现的能力」同型：续传客户端按声明发区间请求，
         * 每个连接却收到整份内容，拼装出损坏文件。判据与 GET 同源（`rangeServable`）。
         */
        if (gateway.rangeServable(st)) res.setHeader('Accept-Ranges', 'bytes');
        if (st.lastModified) res.setHeader('Last-Modified', st.lastModified);
        if (st.etag) res.setHeader('ETag', st.etag);
        /**
         * 带 Range 的 HEAD 也如实回答 206/Content-Range（续传客户端会据此判断）。
         *
         * R10-07：但**只在 GET 真的会服务 Range 时**才宣告 206。
         * 加密对象明文超过 `MAX_RANGE_BUFFER` 时 GET 会退化为「全量流式解密、
         * 忽略 Range」（回 200 + 全量长度）；若 HEAD 仍给 206 + Content-Range，
         * 续传客户端就按区间建多个连接、每个却收到整份内容 → 拼装出损坏文件。
         * 判定统一取自 `gateway.rangeServable()`，与 GET 同源。
         */
        const rh = String(req.headers.range || '').trim();
        if (rh && gateway.rangeServable(st)) {
          try {
            const r = gateway.parseRange(rh, total);
            res.setHeader('Content-Range', `bytes ${r.start}-${r.end}/${total}`);
            res.setHeader('Content-Length', String(r.end - r.start + 1));
            return res.status(206).end();
          } catch (e) { /* Range 无效 → 退化为完整长度 */ }
        }
        res.setHeader('Content-Length', String(total));
        return res.status(200).end();
      }

      const rh = String(req.headers.range || '').trim();
      const range = rh || null;

      // 统一走网关：加密对象自动解密，非加密对象直读
      const r = await gateway.readObject(cfg.bucket, key, { range, decrypt: true });

      res.setHeader('Content-Type', r.contentType);
      // R14-06：可渲染类型一律改为附件下载。WebDAV 是文件存取协议，没有理由内联渲染；
      // 而 `text/html` / `image/svg+xml` 一旦被浏览器内联打开，就会在本源内执行脚本
      // （配合被缓存的 Basic 凭据 = 一个文件拿到整个账户的权限）。CSP 已兜一层，
      // 这里再兜一层：直接不让它有"渲染"这个入口。
      if (RENDERABLE_TYPES.has(String(r.contentType).split(';')[0].trim().toLowerCase())) {
        res.setHeader('Content-Disposition', 'attachment');
      }
      // R11-11：同上 —— 只在真能服务 Range 时宣告（判据与 HEAD 分支同源）
      if (gateway.rangeServable({ encrypted: r.encrypted, origSize: r.origSize })) {
        res.setHeader('Accept-Ranges', 'bytes');
      }
      res.setHeader('Content-Length', String(r.contentLength));
      if (r.rangeServed) {
        res.setHeader('Content-Range', `bytes ${r.range.start}-${r.range.end}/${r.range.total}`);
      }
      if (r.lastModified) res.setHeader('Last-Modified', r.lastModified);
      if (r.etag) res.setHeader('ETag', r.etag);
      res.status(r.rangeServed ? 206 : 200);
      /**
       * R37：下载限速（复用与主站同一个限速环节）。
       *
       * 三处出口（`/fs/download`、`/s/:id/dl`、本处）都必须接线，任何一处漏掉
       * 都是一个「不限速的旁路」—— 而 WebDAV 恰恰是最容易漏的那个：它的路径、
       * 认证、响应头全部独立于 `download-stream.js`。
       *
       * ⚠️ **WebDAV 只覆盖 IP / API Key / 存储桶三层，没有「用户管理」层。**
       * `req.webdavUser` 是 `cfg.webdav.accounts` 里的**应用凭据**
       * （`{ id, appName, username }`），与系统用户表**没有关联字段**，无法可靠地
       * 映射到某个系统用户。这里刻意**不猜**（按用户名同名去匹配会是个静默的错误归属），
       * 因此 WebDAV 通道不受「用户管理」里的下载限速约束 —— 这是已知且写在文档里的缺口。
       */
      const throttle = makeThrottle({
        ip: security.clientIp(req),
        method: req.method,
        credentialId: cfg.credentialId,
        bucketId: cfg.bucketId,
      });
      r.stream.pipe(throttle || res);
      if (throttle) throttle.pipe(res);
      r.stream.on('error', () => { try { res.destroy(); } catch (e2) { /* ignore */ } });
      res.on('close', () => {
        try { r.stream.destroy(); } catch (e2) { /* ignore */ }
        // 限速环节也要销毁：否则它内部的节拍定时器会残留（同 download-stream 的 teardown）
        if (throttle) { try { throttle.destroy(); } catch (e2) { /* ignore */ } }
      });
    } catch (e) {
      if (!res.headersSent) {
        /**
         * R9-04：4xx 必须**原样透传**，不能一律折叠成 500。
         *
         * `readObject` 在 Range 越界时抛 416（`parseRange` 给出 `bytes * /total`）。
         * 旧写法 `st === 404 ? 404 : 500` 会把 416 变成 500 —— 续传客户端据此判定
         * 「服务端故障」而不停重试，而正确的语义是「这个区间不存在，别再试了」。
         */
        const st = Number(e.status || e.statusCode) || 500;
        /**
         * R13-07：上游 401 不得占用本地「会话过期」语义。
         * s3-client 的错误只带 `statusCode`、不经 `translateError`（cos.js:146 的 401→502
         * 映射只罩住走翻译的管理端路由），本路径直接读 statusCode 时会把上游 401 原样透出，
         * 让 WebDAV 客户端误判为认证挑战而非「密钥被拒」。这里补上映射。
         */
        const out = st === 401 ? 502 : (st >= 400 && st < 500 ? st : 500);
        if (out === 416 && e.contentRange) res.setHeader('Content-Range', e.contentRange);
        res.status(out).type('text/plain').send(out === 404 ? '404 Not Found' : davErrorMessage(e));
      }
    }
  };
  /**
   * R10-12：`app.head('*')` 必须注册在 `app.get('*')` **之前**。
   *
   * 实测（本机 express 4.x）：`Route.prototype._handles_method` 对 HEAD 有回退 ——
   * 若该 route 上没有显式注册 `head`，就把方法名退化成 `get` 再匹配：
   * ```js
   * if (name === 'head' && !this.methods['head']) name = 'get';
   * ```
   * 于是「先注册 `app.get('*')`」时，HEAD 会命中 GET 的 layer 并**以 headOnly=false
   * 执行下载全路径** —— 下面那行 `app.head('*')` 从此形同虚设。实测两种注册顺序：
   *   get→head ：HEAD 命中 GET 处理器
   *   head→get ：HEAD 命中 HEAD 处理器
   *
   * 后果不只是「多算一次云端请求」：R8-15 特意加的「HEAD 在 readObject 之前分流」
   * 从未生效，于是**每个 HEAD 都真的去下载整个对象** —— 加密对象还要整份流式解密
   * 后再丢弃。WebDAV 客户端在几乎每次读/写/复制前都会发 HEAD，1GB 文件列一次目录
   * 就是几十 GB 的无效流量与 CPU。R10-07 的修复（HEAD 不宣告 206）同样被这条短路，
   * 因为请求根本进不了 HEAD 分支。
   */
  app.head('*', (req, res, next) => (inMount(req.path) ? getObject(req, res, true) : next()));
  app.get('*', (req, res, next) => (inMount(req.path) ? getObject(req, res, false) : next()));

  /* PUT：上传对象（经文件网关加密后上传）；路径以 / 结尾时等价 MKCOL */
  app.put('*', async (req, res) => {
    try {
      const { cfg, cos } = await requireCos();
      let key = reqPathToKey(req.path);
      if (!key) return res.status(409).type('text/plain').send('409 Conflict：无法上传到根路径');
      if (key.endsWith('/')) {
        // R25：目录是 0 字节对象 → `addBytes=0`（仅「已超额」时拒绝）
        // R28-02：凭据级 + 桶级两层闸门（与 /fs 的写入口径一致）
        await bucketStats.assertCredentialQuota(cfg.credentialId, { addBytes: 0 });
        await bucketStats.assertBucketQuota(cos, cfg, { addBytes: 0 });
        try { await p(cos, 'headObject', { Bucket: cfg.bucket, Region: cfg.region, Key: key }, { noStat: true }); return res.status(405).end(); } catch (e) { /* 不存在则创建 */ }
        // R36：目录标记对象顺带记录创建者（属性面板的文件夹「创建者」）
        await p(cos, 'putObject', {
          Bucket: cfg.bucket, Region: cfg.region, Key: key, Body: Buffer.alloc(0), ContentLength: 0,
          Headers: uploaderMeta(req.webdavUser && req.webdavUser.username),
        });
        return res.status(201).end();
      }
      /**
       * R25：配额闸门。`Content-Length` 可得时按「整份写入」预判（可在落盘前拦下），
       * 分块传输（无 Content-Length）时退化为「仅已超额才拒绝」。
       */
      const putLen = Math.max(0, Number(req.headers['content-length']) || 0);
      await bucketStats.assertCredentialQuota(cfg.credentialId, { addBytes: putLen });
      await bucketStats.assertBucketQuota(cos, cfg, { addBytes: putLen }); // R28-02：单桶上限
      /**
       * R27-16：条件写必须在校验**之后**、真正写入**之前**求值。
       * 位置放在配额闸门之后：超出配额时不该因为条件不匹配而给出 412（配额错更根本）。
       */
      const pre = await checkPreconditions(req, cfg, key);
      if (pre) return res.status(pre.status).type('text/plain').send(pre.message);
      // 经网关写入：自动加密（mode!=='none'）+ 联动元数据 + 审计
      const r = await gateway.writeObject(
        cfg.bucket, key, req,
        req.headers['content-type'] || guessContentType(key),
        'webdav.put',
        req.webdavUser ? `${req.webdavUser.username} 上传 ` : 'WebDAV 上传 ',
        req.webdavUser && req.webdavUser.username // R36：记录上传者供属性面板展示
      );
      // 记账落盘后的**实际**字节数（加密后会与 Content-Length 不同）—— 供配额判定用
      bucketStats.recordUsageDelta(cfg, r.bytesWritten);
      res.status(r.existed ? 204 : 201).end();
    } catch (e) {
      /**
       * R10-05（另一半）：magic 模式下超过 5MB 的整文件加密会被 `encryptBuffer`
       * 以 413 拒绝 —— 而**WebDAV 没有分片上传接口**，那句「请改用分片上传」在这里
       * 不可执行，用户会卡在「大文件完全传不上去且不知道该怎么办」。
       *
       * 这里补上 WebDAV 侧的真实出路：换用 AES-256-GCM，或改从管理界面上传（那里会
       * 自动按上限切分）。与其给一条走不通的建议，不如讲明约束本身。
       */
      if (Number(e.status) === 413 && !res.headersSent) {
        return res.status(413).type('text/plain')
          .send(`${davErrorMessage(e)}\n（WebDAV 挂载写入不支持分片上传：请改用「AES-256-GCM」加密模式，`
            + '或改用管理界面的文件上传 —— 那里会自动按上限切分。）');
      }
      if (!res.headersSent) res.status(e.status || 500).type('text/plain').send(davErrorMessage(e));
    }
  });

  /* MKCOL：新建目录 */
  app[ 'MKCOL'.toLowerCase() ]('*', async (req, res, next) => {
    if (!inMount(req.path)) return next();
    try {
      const { cfg, cos } = await requireCos();
      const key = reqPathToKey(req.path);
      if (!key) return res.status(409).end();
      const dirKey = key.endsWith('/') ? key : key + '/';
      // R25：新建集合是 0 字节对象 → `addBytes=0`
      await bucketStats.assertCredentialQuota(cfg.credentialId, { addBytes: 0 });
      await bucketStats.assertBucketQuota(cos, cfg, { addBytes: 0 }); // R28-02：单桶上限
      try {
        await p(cos, 'headObject', { Bucket: cfg.bucket, Region: cfg.region, Key: dirKey }, { noStat: true });
        return res.status(405).type('text/plain').send('405 Method Not Allowed：集合已存在');
      } catch (e) { /* 不存在，继续创建 */ }
      await p(cos, 'putObject', {
        Bucket: cfg.bucket, Region: cfg.region, Key: dirKey, Body: Buffer.alloc(0), ContentLength: 0,
        Headers: uploaderMeta(req.webdavUser && req.webdavUser.username), // R36：目录创建者
      });
      res.status(201).end();
    } catch (e) {
      // R22-03：MKCOL 同型收口
      if (!res.headersSent) res.status(e.status || 500).type('text/plain').send(davErrorMessage(e));
    }
  });

  /* DELETE：经网关删除（自动清理加密元数据 + 审计） */
  app.delete('*', async (req, res, next) => {
    if (!inMount(req.path)) return next();
    try {
      const { cfg } = await requireCos();
      const key = reqPathToKey(req.path);
      if (!key) return res.status(403).type('text/plain').send('403：禁止删除存储桶根');
      const userLabel = req.webdavUser ? `${req.webdavUser.username} 删除 ` : 'WebDAV 删除 ';
      // R25：删除**不设配额闸门**（删除是在释放空间，拦下它只会让用户更出不去）；
      // 只把释放的字节记账，让配额判定及时跟着回落。目录删除（deletePrefix）不返回
      // 字节数，故不记账 —— 代价是额度数字偏保守（**偏严**方向，不会放行超额写入）。
      if (!key.endsWith('/')) {
        // R27-16：DELETE 同样要尊重 If-Match（"只删我看到的那个版本"）
        const preDel = await checkPreconditions(req, cfg, key);
        if (preDel) return res.status(preDel.status).type('text/plain').send(preDel.message);
        const del = await gateway.deleteObject(cfg.bucket, key, 'webdav.delete', userLabel);
        if (del && del.bytesFreed) bucketStats.recordUsageDelta(cfg, -del.bytesFreed);
      } else {
        // FUN-04 同型：删目录可能未删完（对象数超上限）。此时必须如实报错，
        // 绝不能返回 204 —— 否则客户端以为删除成功，残留对象继续占费且元数据已被清理。
        const r = await gateway.deletePrefix(cfg.bucket, key, 'webdav.delete', userLabel);
        if (r.truncated) {
          // R11-01：stalled（云端拒绝，如对象锁）与「未删完」分开报，不再混成一句
          const reason = r.stalled
            ? '云端拒绝删除（对象锁 / 桶策略），已停止'
            : `${r.rounds} 轮后仍超出单次处理上限，请拆分为子目录分批删除后重试`;
          return res.status(500).type('text/plain')
            .send(`500：目录未完全删除（已删 ${r.deleted} 个对象，${reason}）`);
        }
      }
      res.status(204).end();
    } catch (e) {
      if (!res.headersSent) {
        const st = e.statusCode || e.status || 500;
        res.status(st === 404 ? 404 : 500).type('text/plain').send(st === 404 ? '404 Not Found' : davErrorMessage(e));
      }
    }
  });

  /* MOVE / COPY：经网关操作（自动管理加密元数据 + 审计） */
  async function moveCopy(req, res, isMove) {
    try {
      const { cfg, cos } = await requireCos();
      const srcKey = reqPathToKey(req.path);
      const destHeader = req.headers.destination;
      if (!destHeader) return res.status(400).type('text/plain').send('400：缺少 Destination 头');
      let destUrl;
      let destPath;
      try {
        destUrl = new URL(destHeader);
        destPath = destUrl.pathname;
      } catch (e) { return res.status(400).send('Destination 无效'); }
      // FUN-06：Destination 必须位于本服务的挂载点之下。
      // 旧实现只取 pathname 且**不校验前缀**，于是 Destination 指向 `/任意路径` 时
      // 会把对象写到挂载点命名空间之外，破坏「/dav 即逻辑边界」的约定。
      //
      // R34：判据收敛到 `inMount()`（此前是手写的 `=== MOUNT || startsWith(MOUNT + '/')`）。
      // 根路径 `/` 也是挂载点（见 inMount），因此这里**放行**它，由紧随其后的
      // `!dstKey` 以 400 拒掉 —— 把根集合整个换掉在 WebDAV 里没有合法语义，
      // 但「是不是挂载点」与「能不能当目标」是两件事，不该在这行混着判。
      if (!inMount(destPath)) {
        return res.status(403).type('text/plain')
          .send(`403 Forbidden：Destination 必须位于 ${MOUNT}/ 挂载点之下`);
      }
      // 同时校验主机：跨主机 Destination 意味着客户端试图让本服务代为写入另一台服务，
      // 在 WebDAV 语义下无合法用途（正确的用法是重定向到目标主机）。
      const destHost = destUrl.host || '';
      if (destHost && destHost !== String(req.headers.host || '')) {
        return res.status(403).type('text/plain')
          .send('403 Forbidden：不支持跨主机 Destination');
      }
      const dstKey = reqPathToKey(destPath);
      if (!srcKey || !dstKey) return res.status(400).type('text/plain').send('400：源或目标路径无效');
      const overwrite = String(req.headers.overwrite || 'T').toUpperCase() !== 'F';

      const userLabel = req.webdavUser ? `${req.webdavUser.username} ${isMove ? '移动' : '复制'} ` : `WebDAV ${isMove ? '移动' : '复制'} `;

      /**
       * R11-06：文件分支的自指守卫（与目录分支同款措辞）。
       *
       * 文件 MOVE 是 `copyObject(dst)` → `deleteObject(src)` 两步，默认
       * `Overwrite: T` 时 `:761` 那个分支被跳过，`srcKey === dstKey` 完全没人管 ——
       * 若云端接受自复制（COS 允许同名覆盖），对象会被直接删掉并回 201，
       * 客户端认为成功：**静默数据丢失**。
       * 触发场景是真实存在的：客户端的「同名重命名」、同步工具对已一致资源的
       * 对齐操作、大小写重命名回原名。COPY 自指同理（无意义的 no-op），一律 403。
       */
      if (srcKey === dstKey) {
        return res.status(403).type('text/plain')
          .send(`403 Forbidden：${isMove ? '移动' : '复制'}目标与源相同`);
      }

      const srcIsDir = srcKey.endsWith('/');
      /**
       * R25：COPY / MOVE 的配额闸门 —— `addBytes=0`（只拦「已超额」）。
       *
       * 为什么不传源对象大小：COPY 会新增一份占用，但它要么是文件（大小已知需先 HEAD，
       * 平白多一次往返）、要么是目录（要全量列举才知道），且 WebDAV 客户端在超额时
       * 拿到 507/403 都会重试。统一取「已超额即拒」，语义简单且判定成本为零。
       *
       * R28-02：**两层闸门并列** —— 凭据级（该密钥名下合计）之后紧跟桶级（该桶自身上限）。
       * 两行之间刻意不留注释：`reverse-check` 的 anchor 在扫描前会把注释抹成等长空白，
       * 夹在锚点中间的行内注释会让锚点失配（这正是本轮 R25-07 那条对照失效的原因）。
       */
      await bucketStats.assertCredentialQuota(cfg.credentialId, { addBytes: 0 });
      await bucketStats.assertBucketQuota(cos, cfg, { addBytes: 0 });
      if (!srcIsDir) {
        // 文件
        // R10-11：判据统一走 destinationExists（与目录分支同源）
        if (!overwrite && await destinationExists(cos, cfg, dstKey, false)) {
          return res.status(412).end();
        }
        if (isMove) {
          await gateway.moveObject(cfg.bucket, srcKey, dstKey, 'webdav.move', userLabel);
        } else {
          /**
           * R27-06：COPY 是**净增**占用（MOVE 是净零，故不计），必须把真实拷入的
           * 字节喂给配额记账 —— 与上面 PUT 分支同一条纪律。
           *
           * 旧实现只在 PUT / DELETE 记账：COPY 之后 `usedBytes` 不会变化，而它的闸门
           * 又是「已超额才拒」（`addBytes: 0`），于是在缓存刷新的 15 分钟窗口内可以
           * 把一个大对象反复 COPY 成 copy1/、copy2/…，账面纹丝不动、存储成倍增长。
           */
          const r = await gateway.copyObject(cfg.bucket, srcKey, dstKey, 'webdav.copy', userLabel);
          if (r && r.bytes) bucketStats.recordUsageDelta(cfg, r.bytes);
        }
        return res.status(201).end();
      }

      // 目录
      //
      // R9-01：**自嵌套守卫**（COPY 与 MOVE 共用）。
      //
      // 把目录复制/移动进它自己的子目录（资源管理器里把文件夹拖进自己下面新建的
      // 子目录、"就地快照"式备份工具）时，目标 key 落在源前缀**内部**：
      //   COPY /dav/photos/  →  Destination: /dav/photos/backup/
      // 旧实现逐页列举复制（forEachPrefixPage）：复制出的副本（photos/backup/IMG_0001.jpg）
      // 在下一页被重新当作源对象 —— 只要存在源 key 字典序小于目标 key 的对象就会命中，而
      // `photos/IMG_*.jpg`（`I`=0x49）< `photos/backup/...`（`b`=0x62），数字/大写/
      // `a` 开头的目录名全部满足 → **常规命名下的默认行为**。
      // 后果是 `IsTruncated` 恒为 true、请求永不返回，且云端每页 1000 个对象持续
      // 产生计费对象，只能人工清理。这是不可自愈 + 不可逆 + 无用户感知的组合。
      // （R13 起 COPY 改为 listAllExact 先全量列举，无限翻页不再发生；
      //   但"复制进自身内部"语义上仍是自指，守卫保留为纵深防御。）
      //
      // 管理端的两个同类入口早有此守卫（`routes/fs.js` 的「不能将文件夹重命名为其
      // 自身或其子路径」「不能将文件夹移动到其自身内部」），WebDAV 这条此前漏了。
      // 先归一化尾斜杠再比前缀，避免 `/dav/a` → `/dav/a/` 这种"自指但字符串不等"逃逸。
      if (srcKey === dstKey) {
        return res.status(403).type('text/plain')
          .send(`403 Forbidden：${isMove ? '移动' : '复制'}目标与源相同`);
      }
      if ((dstKey.replace(/\/+$/, '') + '/').startsWith(srcKey)) {
        return res.status(403).type('text/plain')
          .send(`403 Forbidden：不能将文件夹${isMove ? '移动' : '复制'}到其自身内部（${srcKey} → ${dstKey}）`);
      }

      if (isMove) {
        // R9-06：目录 MOVE 也要认 `Overwrite: F`（RFC 4918 §9.9.4）。
        // 此前 `overwrite` 只用在了文件分支与 COPY 目录分支，目录 MOVE 直接合并/覆盖，
        // 带"不覆盖"策略的同步工具会静默覆盖目标已有对象。
        // R10-11：判据与文件分支 / COPY 目录分支同源（见 destinationExists 的说明）。
        // 旧实现只看 `listLevel` 一层，漏掉「目标是已存在的文件」与「目标是空目录」两种形态。
        if (!overwrite && await destinationExists(cos, cfg, dstKey, true)) {
          const dstProbe = dstKey.replace(/\/+$/, '') + '/';
          return res.status(412).type('text/plain')
            .send(`412 Precondition Failed：目标「${dstProbe}」已存在且请求声明 Overwrite: F`);
        }
        await gateway.movePrefix(cfg.bucket, srcKey, dstKey, 'webdav.move', userLabel);
      } else {
        /**
         * 目录复制（R13-02/03/04：形态与 `movePrefix` 完全对齐 ——
         * 「完整列举 → 目标侧既有集合 → 键级冲突预检 → 受控并发复制
         *  → stopped + allSettled → fresh 过滤回滚」）。
         *
         * R8-16 的纪律在此延续：列举**不得静默截断**。`listAllExact` 在达到 cap 时
         * 抛错（整个请求在动手之前失败），而不是复制一半仍返回 201。
         */
        const dstDir = dstKey.replace(/\/+$/, '') + '/';

        // 源侧全量（HARD_MAX，与 movePrefix 同口径；超限文案改写为复制语义）
        let srcItems;
        try {
          srcItems = await listAllExact(cos, cfg, srcKey, {
            cap: LIMITS.HARD_MAX, noStat: true, skipPrefixSelf: true,
          }, '复制');
        } catch (e) {
          if (e && e.truncated) {
            const e2 = new Error(
              `源目录“${srcKey}”下对象过多（超过 ${e.cap || LIMITS.HARD_MAX} 个），无法在合理开销内完成`
              + '「冲突检测 + 失败回滚」；已中止且**未做任何改动**。请先拆分子目录分批复制。'
            );
            e2.status = 400;
            throw e2;
          }
          throw e;
        }

        /**
         * R13-02 / R13-04：复制**之前**先记录目标侧原本就存在的对象（一次列举，
         * 与 movePrefix 的 existedBefore 同源）。它同时服务两条纪律：
         *   ① 回滚的 `fresh` 过滤 —— 默认 `Overwrite: T` 下目标侧同名对象会被覆盖，
         *      它们进了 copied 也不能删（那是用户在复制前就有的数据）；
         *   ② 键级冲突预检 —— 见下。
         * 列举失败/超限就让整个复制在**动手之前**失败，好过复制一半才发现无法安全回滚。
         */
        let preexisting;
        try {
          preexisting = await listAllExact(cos, cfg, dstDir, {
            cap: LIMITS.STAT, noStat: true, skipPrefixSelf: true,
          });
        } catch (e) {
          if (e && e.truncated) {
            const e2 = new Error(
              `目标目录“${dstDir}”下对象过多（超过 ${LIMITS.STAT} 个），无法在合理开销内完成`
              + '「冲突检测 + 失败回滚」；已中止且**未做任何改动**。'
              + '请先拆分子目录分批复制，或改用一个空目标。'
            );
            e2.status = 400;
            throw e2;
          }
          throw e;
        }
        const existedBefore = new Set();
        for (const it of preexisting) existedBefore.add(it.key);

        const targets = [];
        for (const it of srcItems) {
          const rel = it.key.slice(srcKey.length);
          if (!rel) continue; // 目录标记对象自身
          targets.push({ key: it.key, dst: dstDir + rel, size: it.size });
        }

        /**
         * R13-04：`Overwrite: F` 的冲突预检。
         *
         * 报告的原话是「这里的守卫只判『目标容器存在』」—— 复核后**前提需要修正**：
         * `destinationExists(cos, cfg, dstKey, true)`（末参 srcIsDir）的判据是三种形态
         * （① 目标路径本身是文件；② 目录占位对象；③ 目录下有**任意一层子项**），
         * 第 ③ 形态查的就是「目标非空」。因此 `Overwrite: F` 下不存在「目标里只有
         * 部分同名对象、于是被静默覆盖」的路径 —— 只要目标非空就整体 412。
         * 据此**保留** R10-11 的容器级判据（与 RFC 4918 §9.8.4 的严格字面一致，
         * 也是 `audit10` 里 R10-11 那条行为护栏所断言的语义），不改成按键放行。
         *
         * ① 之下再补 ② 键级比对作为**fail-open 兜底**：① 的三形态探测在网络抖动 /
         * 403 时按「不存在」返回（见 `destinationExists` 的说明），① 会就此放行；
         * 而 ② 依据的 `existedBefore` 来自一次**已经成功**的列举，不受探测失败影响。
         * 两者同源（都以目标侧已存在的 key 集合为准）：① 负责 RFC 语义，② 负责兜底。
         *
         * `Overwrite: T`（默认）**有意不加 409**：RFC 允许覆盖，`copyObject` 的
         * `reconcileAfterWrite` 会让目标元数据随新内容走（R9-03），失败回滚又有
         * `fresh` 过滤（R13-02）保证不删用户复制前就有的对象 —— 三条合起来，
         * T 下「确认会被覆盖的 key」已如实记进审计日志（见下方 `overwritten`），
         * 无需再以 409 违背协议语义。`movePrefix` 不接 `overwrite`（MOVE 一律 409）
         * 属有意的语义收紧：移动会删源，不可合并。
         */
        if (!overwrite) {
          // ① 容器级 —— R10-11 的唯一判据，覆盖「目标是文件 / 空目录 / 非空目录」三种形态
          if (await destinationExists(cos, cfg, dstKey, true)) {
            return res.status(412).type('text/plain')
              .send(`412 Precondition Failed：目标「${dstDir}」已存在且请求声明 Overwrite: F`);
          }
          // ② 键级兜底 —— ① 因探测失败 fail-open 时仍能挡住同名覆盖
          const conflicts = [];
          for (const t of targets) if (existedBefore.has(t.dst)) conflicts.push(t.dst);
          if (conflicts.length) {
            const preview = conflicts.slice(0, 3).map((k) => k.slice(dstDir.length)).join('、');
            return res.status(412).type('text/plain')
              .send(`412 Precondition Failed：目标「${dstDir}」下已存在 ${conflicts.length} 个同名对象（${preview}`
                + `${conflicts.length > 3 ? ' 等' : ''}），且请求声明 Overwrite: F；未做任何改动。`);
          }
        }
        const overwritten = [];
        for (const t of targets) if (existedBefore.has(t.dst)) overwritten.push(t.dst);

        /**
         * R11-15：受控并发（5 路）+ 复用 `it.size` 省 headObject + `req.destroyed` 即停。
         *
         * R12-04 / R13-03：中途失败必须回滚，且**先等所有 worker 落地再取快照**。
         * 旧实现 `Promise.all` 一拒就 `return false` 停翻页，其余 4 路 worker 仍在
         * `copyObject` 并 `created.push()` —— 紧接的回滚拿到的是过早的快照，
         * 孤儿在回滚之后才落地，日志却写「已回滚 N/N」（谎报）。
         * 修法照抄 movePrefix：失败先置 `stopped`，再 `allSettled`，然后才取快照。
         */
        let copied = 0;
        let copiedBytes = 0; // R27-06：目录 COPY 的净增占用（逐对象累加，成功后才记账）
        const created = [];
        let idx = 0;
        let stopped = false;
        let copyErr = null;
        const limit = Math.min(5, Math.max(1, targets.length));
        const workers = [];
        for (let w = 0; w < limit; w++) {
          workers.push((async () => {
            while (!stopped && idx < targets.length) {
              if (req.destroyed) { stopped = true; break; }
              const t = targets[idx++];
              // 不逐对象写审计（沿用旧行为），但把已知大小传下去省一次 headObject
              const r = await gateway.copyObject(cfg.bucket, t.key, t.dst, null, null, t.size);
              if (r && r.bytes) copiedBytes += r.bytes; // R27-06：真实拷入字节
              created.push(t.dst);
              copied += 1;
            }
          })());
        }
        try {
          await Promise.all(workers);
        } catch (e) {
          copyErr = e;
          stopped = true;
          // R13-03：先让在飞的 worker 落地，再取快照（见上方说明）
          await Promise.allSettled(workers);
        }
        const aborted = !copyErr && Boolean(req.destroyed);

        if (copyErr) {
          // R13-02：只回滚「本次新建」的目标对象；复制前就存在的同名对象已被覆盖，
          // 删掉它们等于毁掉与本次失败无关的用户数据（且不做 markMissing、不清元数据）。
          const fresh = created.filter((k) => !existedBefore.has(k));
          const overwrittenRolled = created.length - fresh.length;
          const rb = await gateway.rollbackCopies(cos, cfg, fresh);
          statsStore.addLog({
            action: 'webdav.copy',
            level: 'error',
            detail: `${userLabel}目录「${srcKey}」→「${dstDir}」复制失败：${copyErr.message}；`
              + `已回滚 ${rb.removed}/${fresh.length} 个本次新建的目标对象`
              + (overwrittenRolled ? `，${overwrittenRolled} 个在复制期间已存在的目标对象未删除（不得覆盖回滚，需人工核对）` : '')
              + (rb.errors.length ? `；回滚失败 ${rb.errors.length} 个：${rb.errors[0].message}` : '')
              + (rb.removed < fresh.length && !rb.errors.length
                ? `；残留 ${fresh.length - rb.removed} 个孤儿副本需手工清理（目标 ${dstDir}）` : ''),
          });
          throw copyErr;
        }

        // R27-06：复制成功后才记账（失败路径上面已 throw，不会走到这里）
        if (copiedBytes) bucketStats.recordUsageDelta(cfg, copiedBytes);
        statsStore.addLog({
          action: 'webdav.copy',
          level: aborted ? 'warn' : 'info',
          detail: `${userLabel}目录「${srcKey}」→「${dstDir}」${aborted ? '客户端中断，已复制' : '共'} ${copied} 个对象`
            + (overwritten.length ? `（其中覆盖 ${overwritten.length} 个目标侧既有对象）` : ''),
        });
      }
      res.status(201).end();
    } catch (e) {
      if (!res.headersSent) {
        const st = Number(e.statusCode || e.status) || 500;
        // R8-16：4xx（412 目标已存在 / 403 跨主机 Destination / 400 路径无效）必须**原样透传**。
        // 旧实现把它们一律折叠成 500，客户端无法区分「我的请求有问题」与「服务端故障」，
        // 会当成瞬时错误去无限重试 —— 对 COPY 而言就是反复半途覆盖。
        // R13-07：但 401 是例外 —— s3-client 的错误只带 statusCode、不经 translateError
        // 的 401→502 映射（cos.js:146），直接透出会占用本地「会话过期」语义，先映射再透传。
        const out = st === 401 ? 502 : (st >= 400 && st < 500 ? st : 500);
        res.status(out).type('text/plain').send(out === 404 ? '404 Not Found' : davErrorMessage(e));
      }
    }
  }
  app[ 'MOVE'.toLowerCase() ]('*', (req, res, next) => (inMount(req.path) ? moveCopy(req, res, true) : next()));
  app[ 'COPY'.toLowerCase() ]('*', (req, res, next) => (inMount(req.path) ? moveCopy(req, res, false) : next()));

  return app;
}

/* ------------------------------ 生命周期 ------------------------------ */

/** 是否位于可信反向代理之后（与 security.js 同一判据：仅显式 TRUST_PROXY=1 才信转发头） */
function trustProxy() {
  return String(process.env.TRUST_PROXY || '') === '1';
}

/** 用户访问面板用的主机名[:端口]；反代后 Nginx 已按 server_name 覆写 Host，故它就是域名本身 */
function reqHost(req) {
  if (!req) return '';
  const h = (typeof req.get === 'function' ? req.get('host') : '') || (req.headers && req.headers.host) || '';
  return String(h).trim();
}

/**
 * 本次请求是否确实经过了可信反代。
 * 只看 `TRUST_PROXY=1` 不够：部署脚本把它写进了 `.env`，而管理员完全可能绕过 Nginx
 * 直连应用端口（`http://IP:3000`）——那种情况下按「反代入口」拼出来的地址是错的。
 * 因此还要求请求里真的带 Nginx 注入的转发头。
 */
function viaTrustedProxy(req) {
  if (!trustProxy() || !req || !req.headers) return false;
  return Boolean(req.headers['x-forwarded-proto'] || req.headers['x-forwarded-for']);
}

/** Nginx 注入的协议（只有 TRUST_PROXY=1 时才可信，否则可被请求方伪造） */
function reqProto(req) {
  if (trustProxy() && req && req.headers) {
    const xfp = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    if (xfp === 'http' || xfp === 'https') return xfp;
  }
  return 'https'; // WebDAV 只跑 HTTPS，外网一律按 https 呈现
}

/**
 * 浏览器实际连接的端口（非默认端口时才需要写进地址）。
 *
 * 为什么不能只看 Host：Nginx 的 `$host` 已经把端口剥掉了，所以站点跑在 8443 时
 * 反代传来的 Host 依然是 `pan.example.com` —— 照它拼出来的是 `https://pan.example.com/dav/`，
 * 少了端口就指向 443，客户端照样连不上。判据取两处，取到即用：
 *   ① 请求头里带端口的 Host（自建反代可能原样透传）；
 *   ② `X-Forwarded-Port`（部署脚本写的 Nginx 会注入 `$server_port`）。
 * 与协议默认端口一致时返回空串，保证 443/https、80/http 的地址保持干净。
 */
function reqExtPort(req) {
  if (!req || !req.headers) return '';
  const raw = String(req.headers['x-forwarded-port'] || '').split(',')[0].trim();
  if (!/^\d{1,5}$/.test(raw)) return '';
  return raw;
}

/**
 * 对外访问地址 —— 挂载到资源管理器 / Finder 时填的就是这一条。
 *
 * 旧实现只拼「监听地址 + 端口」：部署时 `.env` 里是 `HOST=0.0.0.0`，
 * 于是界面**恒显示 `https://localhost:8443/dav/`**。那是**服务器自己**的回环地址，
 * 客户端照着填必然连不上（而且 8443 是自签证书，多数客户端会直接拒绝），
 * 表现就是「WebDAV 配置好了但用不了」。
 *
 * 地址必须反映「用户从哪儿访问」，按确定性从高到低取：
 *   ① `WEBDAV_PUBLIC_URL` —— 部署脚本写入的对外基地址（Nginx `/dav/` 反代入口，含非默认端口）；
 *   ② 面板域名 —— 请求经可信反代时，用管理员此刻访问的域名 + 实际端口（见 reqExtPort）；
 *   ③ 直连回退 —— 未经反代时，用面板主机名 + WebDAV 自己的端口（本机/内网自测）。
 */
function serverUrl(req) {
  const base = String(process.env.WEBDAV_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (base) return base + MOUNT + '/';

  const host = reqHost(req);
  if (host && viaTrustedProxy(req)) {
    const proto = reqProto(req);
    // Nginx 的 $host 不含端口；Host 自带的端口优先，其次看 X-Forwarded-Port
    const m = /:(\d{1,5})$/.exec(host);
    const hostOnly = m ? host.slice(0, -(m[1].length + 1)) : host;
    const port = m ? m[1] : reqExtPort(req);
    const defPort = proto === 'https' ? '443' : '80';
    const shown = port && port !== defPort ? `:${port}` : '';
    return `${proto}://${hostOnly}${shown}${MOUNT}/`;
  }
  if (host) return `https://${host.replace(/:\d+$/, '')}:${DEFAULT_PORT}${MOUNT}/`;
  return `https://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${DEFAULT_PORT}${MOUNT}/`;
}

/** 读取配置，按开关状态启动或停止 HTTPS WebDAV 服务 */
async function apply() {
  const w = configStore.getWebdav();
  const shouldRun = w.enabled && Array.isArray(w.accounts) && w.accounts.length > 0;
  if (shouldRun && !server && !starting) {
    starting = (async () => {
      try {
        const cert = getSelfSignedCert();
        const srv = https.createServer({ key: cert.key, cert: cert.cert }, buildApp());
        srv.on('error', (e) => {
          if (e.code === 'EADDRINUSE') {
            console.error(`[Storage Manager] WebDAV 启动失败：端口 ${DEFAULT_PORT} 已被占用，请设置环境变量 WEBDAV_PORT=<其他端口> 后重启。`);
          } else {
            console.error('[Storage Manager] WebDAV 服务错误：', e.message);
          }
        });
        await new Promise((resolve, reject) => {
          srv.once('error', reject);
          srv.listen(DEFAULT_PORT, HOST, resolve);
        });
        server = srv;
        console.log(`[Storage Manager] WebDAV : ${serverUrl()}（HTTPS，强制加密）`);
      } catch (e) {
        console.error('[Storage Manager] WebDAV 启动失败：', e.message);
      } finally {
        starting = null;
      }
    })();
    await starting;
  } else if (!shouldRun && server) {
    const srv = server;
    server = null;
    await new Promise((resolve) => {
      try {
        if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();
        srv.close(() => resolve());
      } catch (e) { resolve(); }
    });
    console.log('[Storage Manager] WebDAV 服务已停止');
  }
}

function start() { return apply(); }

function isRunning() { return Boolean(server); }

function close() {
  const srv = server;
  if (!srv) return Promise.resolve();
  server = null;
  return new Promise((resolve) => {
    try {
      if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();
      srv.close(() => resolve());
    } catch (e) { resolve(); }
  });
}

module.exports = {
  start, apply, close, isRunning, serverUrl, MOUNT, DEFAULT_PORT,
  // 仅供测试：SEC-12 路径→Key 的归一化必须可被直接驱动（幽灵对象的根源在它）
  __reqPathToKey: reqPathToKey,
  // 仅供测试：R34「挂载点判据唯一实现点」必须可被直接驱动（9 处手写正是根路径漏判的成因）
  __inMount: inMount,
  __PROPFIND_CAP: PROPFIND_CAP,
  // 仅供测试：R21-14「错误响应不得回显上游原始 message」必须可被直接驱动
  __davErrorMessage: davErrorMessage,
};
