/**
 * 路由：文件系统操作
 *  — 列表 / 属性 / 搜索 / 新建目录
 *  — 上传（直传 + 分片断点续传 + 加密）
 *  — 下载 / 缩略图 / 预签名
 *  — 重命名 / 移动 / 删除 / 目录树
 */
const { express, providers, configStore, statsStore, uploadSessions, encStore, streamDownload, shareStore } = require('./_context');
const {
  getClient, p, translateError, listAll, listAllInfo, listAllExact, listPage, LIMITS,
  normalizeKey, badRequest, copySource,
} = require('../cos');
const { deleteMultipleConfirmed } = require('../cos'); // R10-03：批量删除的白名单判据（共用）
/**
 * R12-04：**复制失败回滚的唯一实现点**。
 *
 * 本文件的 `copyBatch` 此前留着第三份回滚 —— 逐对象 `deleteObject`、且按「删除调用
 * 没抛错就算成功」的黑名单口径判断。与 R10-03 确立的白名单判据（`deleteMultipleConfirmed`
 * 只认响应体 `Deleted`）不是同一套：厂商在整批响应里用 `<Error>` 报告单键失败时，
 * 这里会把**仍然存在的对象**当成已回滚，日志因此谎报「已自动回滚 N 个副本」。
 *
 * 三处复制入口（本文件 / `fs-gateway.movePrefix` / WebDAV 目录 COPY）现在共用
 * `gateway.rollbackCopies()`。
 */
const gateway = require('../fs-gateway');
const { requireConfig, baseName, parentOf, typeOf, assertNotExcluded, mapLimit, bucketCacheKey } = require('./_shared');
const security = require('../security'); // SEC-09：直链签发需记录来源 IP
const listCache = require('../list-cache'); // 目录列举短缓存（写操作由 cos.p 统一失效）
const candidates = require('../search-candidates'); // 搜索候选集（带 TTL，写操作由 cos.p 统一失效）
const { singleFlight } = require('../coalesce'); // R14-12：同目录并发请求合并（唯一实现点）

const router = express.Router();

const SIMPLE_THRESHOLD = 8 * 1024 * 1024; // 8MB 以下直传
/**
 * R8-02 / R9-09：magic（异或流）模式下允许的分片上限。
 *
 * 取值与理由集中在 `limits.js` 的 `MAGIC_SYNC_MAX`（单一来源）—— 那里的注释写明
 * 它同时是**性能上限**（密钥流每 32 字节一次 SHA-256，5MB ≈ 418ms 同步阻塞）
 * 与**协议下限**（AWS S3 要求除末片外每片 ≥ 5MB）。**改之前先查协议**。
 *
 * R9-09 起该上限还下沉到了 `encStore.encryptBuffer` 内部：直传与 WebDAV PUT 这两条
 * 「整文件一次加密」的入口也会被同一契约拦住，不再只依赖本文件的分片计算。
 */
const MAGIC_CHUNK_MAX = LIMITS.MAGIC_SYNC_MAX;
/**
 * 分片大小的绝对上限（R11-08）。
 *
 * 旧实现把这个 48MB 内联在 `init` 的 `plainChunk` 表达式里，而 chunk 路由校验
 * 「会话缺 chunkSize」时又需要一个同样的数字 —— 两处各写一遍必然分叉。
 * 这里与 `init` 共用同一常量（48MB 的上界来自 `express.raw` 的 64MB 限制）。
 */
const UPLOAD_CHUNK_MAX = 48 * 1024 * 1024;
// putObjectCopy 单请求复制上限，与 fs-gateway.js 共用 limits.js 中的同一份定义
const COPY_SIMPLE_LIMIT = LIMITS.COPY_SIMPLE_LIMIT;

/* ============================ 列表 / 属性 / 搜索 ============================ */

// 目录/对象列表（分页）
router.get('/fs/list', async (req, res) => {
  try {
    const cfg = requireConfig();
    const client = getClient(cfg);
    const prefix = normalizeKey(String(req.query.prefix || ''));
    const marker = String(req.query.marker || '');
    // LOW-28：单页上限取自 limits.js（旧实现在此硬编码 1000）
    const maxKeys = Math.min(LIMITS.LIST_PAGE, Math.max(1, Number(req.query.maxKeys) || 100));
    const delimiter = req.query.delimiter === '' ? '' : '/';

    // 短缓存：只用于加速「同一目录的重复刷新」，键含桶标识因此不会跨桶串味。
    // 任何写操作都会由 cos.p 统一失效整个桶（见 list-cache.js 顶部说明）。
    // R11-13：桶维度必须是 bucketCacheKey(cfg)（含 provider / secretId），仅用桶名
    // 会让「两个厂商各有一个同名桶」互相串味。
    const cacheKey = listCache.keyOf(bucketCacheKey(cfg), prefix, marker, maxKeys, delimiter, 'list');
    const cached = listCache.get(cacheKey);
    if (cached) { res.json(cached); return; }

    const data = await p(client, 'getBucket', {
      Bucket: cfg.bucket, Region: cfg.region,
      Prefix: prefix, Delimiter: delimiter, Marker: marker, MaxKeys: maxKeys,
    });
    const encSet = encStore.encryptedSetFor(cfg.bucket, (data.Contents || []).map((c) => c.Key));
    const contents = (data.Contents || []).map((c) => ({
      key: c.Key,
      name: baseName(c.Key),
      size: Number(c.Size) || 0,
      lastModified: c.LastModified,
      etag: String(c.ETag || '').replace(/"/g, ''),
      storageClass: c.StorageClass || 'STANDARD',
      isFolder: String(c.Key).endsWith('/'),
      type: String(c.Key).endsWith('/') ? 'folder' : typeOf(c.Key),
      encrypted: encSet.has(c.Key), // 密文对象（云端存储为密文，下载/查看时本地解密）
    }));
    const prefixes = (data.CommonPrefixes || []).map((x) => ({
      prefix: x.Prefix,
      name: baseName(x.Prefix),
      isFolder: true,
      type: 'folder',
      size: 0,
      lastModified: '',
    }));
    const lastKey = contents.length ? contents[contents.length - 1].key : '';
    const payload = {
      prefix,
      contents,
      prefixes,
      isTruncated: String(data.IsTruncated) === 'true',
      nextMarker: data.NextMarker || lastKey,
    };
    listCache.set(cacheKey, payload);
    res.json(payload);
  } catch (e) {
    const err = e.status ? e : translateError(e);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// 属性面板：文件 → 名称/创建时间/大小；文件夹 → 名称/创建时间/对象总数
router.get('/fs/stat', async (req, res) => {
  try {
    const cfg = requireConfig();
    const client = getClient(cfg);
    const key = normalizeKey(String(req.query.path || ''));
    if (!key) return res.status(400).json({ error: '缺少 path 参数' });

    if (key.endsWith('/')) {
      /**
       * 文件夹：创建时间取目录标记对象的 LastModified（无标记对象则为 null）；
       * 对象总数 = 前缀下全部对象，排除目录标记对象（以 / 结尾），空文件夹为 0。
       *
       * R14-12：这是**串行翻页**（`listAll` 单页上限 1000，`LIMITS.STAT` 默认 2 万
       * → 最多约 21 次串行云端往返），而本路由此前既无限流、也不走短缓存 ——
       * 对比同文件的 `/fs/list`、`/fs/search` 都用了 `listCache`，
       * 与 `/stats/storage`（15 分钟缓存 + in-flight 合并）更是鲜明反差：
       * 同为「统计」语义，一个防了放大、一个没防。
       *
       * 于是任意已登录用户（**不需要管理员**）反复请求
       * `GET /api/fs/stat?path=<任意大文件夹>/` 就能快速烧掉云端请求配额；
       * 前端属性面板的自动刷新与多标签页会自然产生并发。
       *
       * 两层收口，都复用既有唯一实现点：
       *  ① 短 TTL 缓存（`list-cache`，键含 `bucketCacheKey(cfg)` 与 `kind='stat'`，
       *     不会与 `/fs/list`、`/fs/search` 的载荷结构串味）；任何写操作由 `cos.p`
       *     统一失效整个桶，所以「刚传完文件再看属性」不会拿到旧数字；
       *  ② 并发合并（`coalesce.singleFlight`）—— 同一目录的并发请求共享一次列举。
       */
      const statKey = listCache.keyOf(bucketCacheKey(cfg), key, '', LIMITS.STAT, '', 'stat');
      const cachedStat = listCache.get(statKey);
      if (cachedStat) return res.json(cachedStat);

      const payload = await singleFlight(`fs-stat:${statKey}`, async () => {
        // 排队期间可能已被别的请求填好（去重窗口内到达的请求不必再算一次）
        const again = listCache.get(statKey);
        if (again) return again;

        let lastModified = null;
        try {
          const head = await p(client, 'headObject', { Bucket: cfg.bucket, Region: cfg.region, Key: key });
          lastModified = head.headers['last-modified'] || null;
        } catch (e) { /* 无标记对象（纯虚拟目录）→ 创建时间未知 */ }

        const STAT_CAP = LIMITS.STAT;
        const objs = await listAll(client, cfg, key, { cap: STAT_CAP + 1 });
        const files = objs.filter((o) => !String(o.key).endsWith('/'));
        const reachedCap = objs.length > STAT_CAP;
        const out = {
          ok: true, isFolder: true, key,
          name: baseName(key.replace(/\/$/, '')) || key,
          lastModified,
          objectCount: Math.min(files.length, STAT_CAP),
          reachedCap,
        };
        listCache.set(statKey, out);
        return out;
      });
      return res.json(payload);
    }

    // 文件
    const head = await p(client, 'headObject', { Bucket: cfg.bucket, Region: cfg.region, Key: key });
    const encMeta = encStore.getMeta(cfg.bucket, key);
    res.json({
      ok: true, isFolder: false, key,
      name: baseName(key),
      size: encMeta ? encMeta.origSize : (Number(head.headers['content-length']) || 0), // 加密文件显示原始大小
      encrypted: !!encMeta, // 云端存储为密文
      lastModified: head.headers['last-modified'] || null,
    });
  } catch (e) {
    if (e.statusCode === 404 || e.statusCode === '404' || /NotFound|NoSuchKey/i.test(String(e.code || ''))) {
      return res.status(404).json({ error: '对象不存在：' + normalizeKey(String(req.query.path || '')) });
    }
    const err = e.status ? e : translateError(e);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// 搜索（服务端过滤，支持名称/类型/日期/大小多条件；超量时返回游标供前端续扫）
router.get('/fs/search', async (req, res) => {
  try {
    const cfg = requireConfig();
    const client = getClient(cfg);
    const prefix = normalizeKey(String(req.query.prefix || ''));
    const q = String(req.query.q || '').toLowerCase();
    const type = String(req.query.type || '');
    const from = String(req.query.from || '');   // YYYY-MM-DD（含）
    const to = String(req.query.to || '');       // YYYY-MM-DD（含）
    const min = Number(req.query.min || 0);
    const max = req.query.max ? Number(req.query.max) : Infinity;
    const limit = Math.min(2000, Math.max(1, Number(req.query.limit) || 500));
    const cursor = String(req.query.cursor || '');
    // 搜索范围：scope=current → 只搜当前目录（delimiter '/'），默认递归整个子树（''）
    const scope = String(req.query.scope || '') === 'current' ? 'current' : '';
    const delimiter = scope === 'current' ? '/' : '';
    // 单轮扫描上限：无筛选条件时只需少量扫描即可返回结果；有条件时才放开
    const hasFilter = Boolean(q) || (type && type !== 'all') || Boolean(from) || Boolean(to) || min > 0 || max !== Infinity;
    const scanCap = hasFilter ? LIMITS.SCAN : 2000;

    /**
     * 客户端是否已断开（与 share-routes.js 的 SEC-06 判定同一惯用法）。
     *
     * 用户改关键词 / 连按回车 / 切走目录时，前端会 AbortController 掉上一个请求。
     * 没有这个检测的话，服务端那一轮剩下的列举**照打云端**，而响应最终被前端丢弃 ——
     * 纯纯的一次白扫（每次列举都是真实网络往返，且计入请求配额）。
     */
    const clientGone = () => req.aborted
      || (req.socket && req.socket.destroyed)
      || res.writableEnded || res.destroyed;
    let aborted = false;

    /**
     * 搜索候选集（`search-candidates.js`）：带 TTL 的对象键清单，用来省掉「重复搜索
     * 时重新翻页」。它**不是**可信索引 —— 从内存取到的条目永远可能与云端不一致，
     * 靠 TTL 自愈，写操作则由 `cos.p()` 的咽喉点立即失效。
     *
     * `cand` 为 null 时（关闭 / 未命中 / 该前缀太大）本函数的行为与接入之前**完全一致**：
     * 逐页列举 + 秒级页缓存。候选集只是「能把哪一段直接交给内存」，不改变游标、上限、
     * 过滤与响应字段的任何语义 —— 这正是 `tests/search-candidates.test.js` 里
     * 「开与关结果逐字段相同」那条等价性护栏要守住的东西。
     */
    const ident = bucketCacheKey(cfg);
    const candKey = candidates.keyOf(ident, prefix, scope);
    let cand = candidates.get(candKey);
    // 游标是**独占**的（对象存储的 Marker 语义是「返回大于它的 key」）→ 二分找首个
    // 严格大于 cursor 的条目。用 >= 会让续扫把刚处理过的对象再返回一次。
    let localIdx = cand ? candidates.firstAfter(cand.items, cursor) : 0;
    // 云端续扫起点：候选集已物化部分的之后；没有候选集时即本次的 cursor
    let cloudMarker = cand && cand.items.length ? cand.nextMarker : cursor;
    let cloudDone = Boolean(cand && cand.complete);
    // 本请求刚取回、尚未消费的一页（候选集管跨请求复用，这里管本请求推进）
    let pending = [];
    let pendingIdx = 0;

    const matches = [];
    let scanned = 0;
    let nextCursor = '';
    let exhausted = false;
    // 跨页保留：循环因「扫满上限 / 凑够 limit」而退出时也要知道停在哪
    let lastKey = '';

    /**
     * 单级列举：子目录来自 CommonPrefixes（不在 items 里）。必须与本页文件
     * **按键序合并**后再扫描 —— 否则游标可能落在某个文件上，而排在它前面、
     * 尚未处理的子目录会被续扫永久跳过（又是一次静默丢结果）。
     */
    const mergePage = (page) => (scope === 'current'
      ? page.items.map((it) => ({ key: it.key, size: it.size, lastModified: it.lastModified }))
        .concat(page.prefixes.map((p) => ({ key: p, size: 0, lastModified: '' })))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      : page.items);

    /** 内存里（候选集 + 本页）是否还有未消费的条目 */
    const moreLocal = () => (cand ? localIdx < cand.items.length : false) || pendingIdx < pending.length;

    /**
     * 取下一个待扫描条目。**顺序与「纯逐页扫描」完全相同**：
     * 候选集已物化的部分 → 本请求刚取回的一页 → 云端翻下一页。
     */
    const nextEntry = async () => {
      for (;;) {
        if (cand && localIdx < cand.items.length) return cand.items[localIdx++];
        if (pendingIdx < pending.length) return pending[pendingIdx++];
        if (cloudDone) return null;
        // 缓存键必须含 delimiter —— 否则「递归」与「仅当前目录」两种列举会命中同一份
        // 缓存，用户切了范围却拿到另一次搜索的结果（同一 prefix+marker，两种语义）。
        // R8-11：还必须含**调用方命名空间** `'search'` —— 搜索缓存的载荷是
        // `{items, prefixes:[string]}`，而 /fs/list 缓存的是 `{contents, prefixes:[{}]}`；
        // 两者的五元组在 maxKeys=1000 时重合，互相命中会一边 500、一边静默显示空目录。
        // R11-13：桶维度用 bucketCacheKey(cfg)（同名桶的不同厂商/密钥不得串味）
        const pageKey = listCache.keyOf(ident, prefix, cloudMarker, 1000, delimiter, 'search');
        let page = listCache.get(pageKey);
        if (!page) {
          // 单级模式下目录自身（0 字节占位对象）不应作为结果出现，否则"搜当前目录"
          // 会把自己列出来；递归模式维持既有行为，不加这个过滤。
          page = await listPage(client, cfg, prefix, {
            marker: cloudMarker, delimiter, skipPrefixSelf: scope === 'current',
          });
          listCache.set(pageKey, page);
        }
        const entries = mergePage(page);
        pending = entries;
        pendingIdx = 0;
        cloudMarker = page.nextMarker || '';
        // `nextMarker` 为空串即表示已列举完（`listPage` 的契约，不要靠条数反推）
        if (!page.isTruncated || !page.nextMarker) cloudDone = true;
        // 整页追加：即便本页只消费一部分，它也已经是**连续前缀**的一部分，下次请求
        // 可以整段从内存读。`put` 返回 false（关闭 / 该前缀超过物化上限）时把 `cand`
        // 置空，本请求仍靠 `pending` 正常推进 —— 只是不再缓存。
        if (candidates.enabled()) {
          const items = (cand ? cand.items : []).concat(entries);
          const ok = candidates.put(candKey, {
            ident, prefix, scope, items, nextMarker: cloudMarker, complete: cloudDone,
          });
          cand = ok ? candidates.get(candKey) : null;
          // 刚追加的这一页由 `pending` 消费，避免本地分支再发一遍
          localIdx = cand ? cand.items.length : 0;
        }
      }
    };

    // 逐页扫描，直到「凑够 limit 条匹配」/「本轮扫满 scanCap」/「云端列举结束」。
    //
    // 关键：中途停下时游标必须落在**最后处理的那个 key** 上，而不是下一页的
    // nextMarker —— 否则同一页里尚未处理的对象会被永久跳过，续扫反而丢结果，
    // 且这种丢失是静默的（用户只会觉得「少了几条」）。
    while (matches.length < limit && scanned < scanCap) {
      // 每取一条前看一眼客户端还在不在：已断开就停手，不再向云端要下一页
      if (clientGone()) { aborted = true; break; }
      const item = await nextEntry();
      if (!item) { exhausted = true; break; }
      scanned++;
      lastKey = item.key;
      const name = baseName(item.key);
      if (q && !name.toLowerCase().includes(q)) continue;
      const isFolder = item.key.endsWith('/');
      const t = isFolder ? 'folder' : typeOf(item.key);
      if (type && type !== 'all' && t !== type) continue;
      if ((from || to || min > 0 || max !== Infinity) && !isFolder) {
        const lm = item.lastModified || '';
        const day = typeof lm === 'string' ? lm.slice(0, 10) : '';
        if (from && day && day < from) continue;
        if (to && day && day > to) continue;
        if (item.size < min || item.size > max) continue;
      }
      matches.push({
        key: item.key, name, size: item.size, isFolder,
        type: isFolder ? 'folder' : t,
        lastModified: item.lastModified || '',
      });
    }

    // 客户端已断开：这一轮剩下的列举不必再打云端，响应也不会有人接收
    if (aborted) { res.destroy(); return; }

    // 循环也可能不是「页内提前停」而是「刚好在页边界凑够/扫满」而退出 —— 这时
    // nextCursor 还是空的，续扫就没有起点，桶里剩余的对象会被**静默丢弃**
    // （前端只在 cursor 非空时才显示「继续搜索」，用户连结果不完整都看不出来）。
    // 统一兜底：只要没扫完，游标就落到最后处理过的那个 key 上。
    if (!exhausted && !nextCursor) {
      // 例外：来源**确实已到尽头**（云端已列举完，内存里也没有剩余条目）时不能给
      // 游标 —— 那会得到一个永远续不到东西的 cursor，前端一直显示「继续搜索」。
      // 与旧实现在「最后一页恰好扫完」时的表现一致。
      if (cloudDone && !moreLocal()) exhausted = true;
      else nextCursor = lastKey;
    }

    res.json({
      matches, scanned, limit,
      // 下一轮原样传回 cursor 即可续扫；空串表示已扫完整个目录
      cursor: nextCursor,
      truncated: !exhausted,
      hint: !exhausted ? `该目录下还有未扫描的对象（本轮已扫描 ${scanned} 个），可继续搜索。` : '',
    });
  } catch (e) {
    const err = e.status ? e : translateError(e);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// 新建文件夹（0 字节对象，Key 以 / 结尾）
router.post('/fs/mkdir', async (req, res) => {
  try {
    const cfg = requireConfig();
    const client = getClient(cfg);
    let key = normalizeKey(String((req.body || {}).path || ''));
    if (!key) throw badRequest('路径不能为空');
    if (!key.endsWith('/')) key += '/';
    await p(client, 'putObject', { Bucket: cfg.bucket, Region: cfg.region, Key: key, Body: Buffer.alloc(0), ContentLength: 0 });
    res.json({ ok: true, key });
    statsStore.addLog({ action: 'fs.mkdir', detail: '创建文件夹 ' + key });
  } catch (e) {
    const err = e.status ? e : translateError(e);
    res.status(err.status || 500).json({ error: err.message });
    statsStore.addLog({ action: 'fs.mkdir', detail: '创建文件夹失败: ' + err.message, level: 'error' });
  }
});

/* ============================ 上传（含断点续传） ============================ */

// 小文件直传（<= 8MB），raw body；加密模式开启时在本地完成加密后才上传
router.put('/fs/upload/simple', express.raw({ type: () => true, limit: '64mb' }), async (req, res) => {
  try {
    const cfg = requireConfig();
    const client = getClient(cfg);
    const key = normalizeKey(String(req.query.path || ''));
    if (!req.body || !req.body.length) throw badRequest('请求体为空');
    // 上传排除规则校验（.DS_Store / Thumbs.db，服务端兜底）
    //
    // FUN-09：旧实现不传 gitignore 参数 —— ≤8MB 的文件走直传，.gitignore 排除规则
    // 在**最常用的那条路径上**被整体绕过（分片路径 /fs/upload/init 是传了的）。
    assertNotExcluded(key, String(req.query.gitignore || ''), String(req.query.gitignoreRel || ''));
    let body = req.body;
    let encrypted = false;
    const enc = encStore.encryptBuffer(cfg.bucket, key, req.body);
    if (enc) { body = enc.data; encrypted = true; } // 密文存储（服务商控制台所见即密文）
    const stored = body.length;
    await p(client, 'putObject', {
      Bucket: cfg.bucket, Region: cfg.region, Key: key,
      Body: body, ContentLength: stored,
      Headers: { 'x-cos-meta-file-mtime': String(req.query.mtime || '') },
    });
    // SEC-08 + R7-02：密文**确认落云之后**才写解密凭据（encryptBuffer 不再代写）。
    // 先写元数据再写云端的话，putObject 失败会让本地凭据覆盖成新值、云端却还是旧密文 → 永久不可解。
    // R8-03：反向同样要处理 —— 明文覆盖写入时必须清掉旧条目，否则本地还留着上一条
    // crypto/magic 记录 → 下载报错、或（magic 分支）静默拿到内容全错的文件。
    encStore.reconcileAfterWrite(cfg.bucket, key, enc ? enc.meta : null);
    res.json({ ok: true, key, encrypted });
    statsStore.sampleTraffic(stored, 0);
    statsStore.trackBucket(cfg.bucket, { up: stored });
    adjustStorageCache(stored, cfg);
    statsStore.addLog({ action: 'fs.upload', detail: `上传 ${key}（${req.body.length} 字节，直传${encrypted ? `，已加密存储为 ${stored} 字节密文` : ''}）` });
  } catch (e) {
    const err = e.status ? e : translateError(e);
    res.status(err.status || 500).json({ error: err.message });
    statsStore.addLog({ action: 'fs.upload', detail: '上传失败 ' + String(req.query.path || '') + ': ' + err.message, level: 'error' });
  }
});

// 分片上传：初始化（返回 sessionId / chunkSize / 已传分片，实现断点续传）
router.post('/fs/upload/init', async (req, res) => {
  try {
    const cfg = requireConfig();
    const client = getClient(cfg);
    const key = normalizeKey(String((req.body || {}).key || ''));
    const size = Number((req.body || {}).size || 0);
    if (!key || !Number.isFinite(size) || size < 0) throw badRequest('参数错误');

    // 上传排除规则校验（前端选择阶段已过滤，此处为服务端兜底）
    assertNotExcluded(key, String((req.body || {}).gitignore || ''), String((req.body || {}).gitignoreRel || ''));

    /**
     * R10-05：**simple / multipart 的分界必须感知加密模式**。
     *
     * R9-09 把 5MB 上限下沉到了 `encryptBuffer`（直传会 413），但 `init` 仍按固定的
     * `SIMPLE_THRESHOLD`(8MB) 决定走直传还是分片 —— 于是 **5MB < size ≤ 8MB** 的文件
     * 在 magic 模式下陷入死路：
     *   init → `mode:'simple'` → 直传 → `encryptBuffer` 抛 413；
     * 重试仍然是同一条路径（前端拿到 `simple` 就直传，失败只 toast，无回退），
     * 而错误文案让用户「改用分片上传」—— 但 init 永远不会为该尺寸返回 multipart。
     *
     * 修法：magic 模式下把分界压到 `MAGIC_SYNC_MAX`，让 (5MB, 8MB] 走分片
     * （分片大小已在下面被 `MAGIC_CHUNK_MAX` 压住，单片同步阻塞可控）。
     * 这样"分片"这条路对任何尺寸都真实存在，413 的提示才是可执行的。
     */
    const simpleLimit = encStore.currentMode() === 'magic'
      ? Math.min(SIMPLE_THRESHOLD, MAGIC_CHUNK_MAX)
      : SIMPLE_THRESHOLD;
    if (size <= simpleLimit) {
      return res.json({ mode: 'simple', key });
    }

    // 断点续传：查找同 Key+Size 的未完成会话并验证远端 uploadId 有效。
    //
    // FUN-02：必须限定创建者与**当前目标桶**（否则会命中他人 / 其它桶的会话），
    // 且校验 uploadId 时要按**会话自己的桶**解析凭据 —— complete/abort 早已改成
    // getClientForSession(sess)，init 这条路径之前漏了，管理员切桶后会误判
    // 「uploadId 已失效」并重建会话，已传分片全部作废（还产生存储费用）。
    const who = (req.authUser && req.authUser.username) || '';
    let sess = uploadSessions.findByTarget(key, size, { createdBy: who, bucket: cfg.bucket, region: cfg.region });
    let uploadedParts = [];
    if (sess) {
      try {
        const lp = await p(getClientForSession(sess), 'multipartListPart', {
          Bucket: sess.bucket, Region: sess.region, Key: key, UploadId: sess.uploadId,
        });
        uploadedParts = (lp.ListPartsResult.Part || []).map((x) => ({ partNumber: Number(x.PartNumber), etag: String(x.ETag).replace(/"/g, ''), size: Number(x.Size) || 0 }));
        // 同步本地记录
        for (const sp of uploadedParts) uploadSessions.setPart(sess.id, sp.partNumber, sp.etag);
      } catch (e) {
        sess = null; // uploadId 已失效，重新创建
      }
    }
    if (!sess) {
      const init = await p(client, 'multipartInit', { Bucket: cfg.bucket, Region: cfg.region, Key: key });
      // 分片上限 48MB，防止超过 express.raw 64MB 限制导致 413（Claude issue #4）
      // R11-08：上限提取为 UPLOAD_CHUNK_MAX —— chunk 路由校验「会话缺 chunkSize」
      // 时要回落到这里，两处必须同源
      const plainChunk = Math.min(UPLOAD_CHUNK_MAX, Math.max(SIMPLE_THRESHOLD, Math.ceil(size / 10000 / (1024 * 1024)) * 1024 * 1024));
      /**
       * R8-02：magic 模式的分片上限**单独压到 `MAGIC_CHUNK_MAX`（5MB）**。
       *
       * magic 的密钥流是「每 32 字节一次 SHA-256」（`enc-store.fillKeystream`），
       * 实测：48MB 分片同步耗时 ≈ **3014ms**（同为 48MB 的 AES-256-GCM 仅 47.6ms
       * —— 被宣传为"轻量混淆"的 magic 反而慢约 63 倍）。
       * `encryptPart` 是**同步**函数、直接在 request handler 里调用，于是一个 48MB 分片
       * 会独占单线程事件循环约 3 秒 —— 期间 HTTP / WebDAV / 下载 / 其它上传全部零响应，
       * 前端 3 路分片并发 × 2 路文件并发即 9~15 秒级停摆。下载方向同型
       * （`decryptTransform` 每 64KB 同步异或）。
       *
       * 压小分片**不改变总 CPU**（密钥流按字节算），只是把单次阻塞从 ~3 秒降到 ~300ms，
       * 让事件循环能在分片边界正常让出。根治要改密钥流的派生粒度（改为块级派生），
       * 但那会把块尺寸写进**密文语义** → 必须引入版本号与迁移路径，
       * 否则历史密文不可解（与 R7-15 的 `metaKey` 同属一类取舍）。
       * 该限制已登记在 Develop_Document.md 的「技术限制」。
       *
       * ⚠️ 下界由**厂商协议**决定，不是性能调参：AWS S3 要求「除最后一片外」每片
       * ≥ 5MB，压到 4MB 会让 magic 大文件在 S3 上合并时报 `EntityTooSmall`。
       * 因此 `MAGIC_CHUNK_MAX` 同时是「性能上限」与「协议下限」，两者在此重合。
       */
      const chunkSize = encStore.currentMode() === 'magic'
        ? Math.min(plainChunk, MAGIC_CHUNK_MAX)
        : plainChunk;      // R7-01：provider 必须随会话落盘。曾经漏传 → create() 回退到默认厂商（tencent），
      // 于是 getClientForSession() 认为「会话厂商 ≠ 桶的厂商」，用 COS SDK 去打阿里云/其它厂商
      // 的 Endpoint —— 非腾讯云厂商 >8MB 的分片上传从第二个分片起必然失败，
      // 且已创建的 UploadId 既不能合并也不能中止（中止也用错客户端），云端分片持续计费。
      sess = uploadSessions.create({
        uploadId: init.UploadId, key, bucket: cfg.bucket, region: cfg.region, size, chunkSize,
        provider: cfg.provider, // R7-01
        createdBy: (req.authUser && req.authUser.username) || '', // SEC-07：记录创建者供 /fs/sessions 过滤
      });
    } else if (encStore.currentMode() === 'magic' && sess.chunkSize > MAGIC_CHUNK_MAX) {
      /**
       * R9-09 残留口：会话**续传**时不重新计算 `chunkSize`。
       *
       * 会话在 `mode=none`（或 crypto）下创建 → 管理员中途切到 magic → 复用会话继续上传时，
       * 仍沿用旧的大分片（最大 48MB），`encryptPart` 同步阻塞约 3 秒 —— R8-02 想压的
       * 那个问题在「切换模式 + 断点续传」这条路径上原样存在。
       *
       * 但这里**不能就地改小 `sess.chunkSize`**：分片偏移由 chunkSize 决定，改了就与
       * 已上传分片的边界错位 → 合出来的文件是乱的。与 R7-15 的取舍同类 ——
       * 涉及已落盘数据语义的参数不可中途变更。因此如实拒绝并请用户重建任务。
       */
      const e = new Error(
        `该上传任务的分片大小为 ${sess.chunkSize} 字节，超过「文件头魔数」模式的上限 `
        + `${MAGIC_CHUNK_MAX} 字节；加密方式在上传过程中刚切换到 magic，`
        + '沿用旧分片会长时间阻塞服务。请取消该上传任务后重新上传。'
      );
      e.status = 409;
      throw e;
    }
    res.json({
      mode: 'multipart', sessionId: sess.id, chunkSize: sess.chunkSize,
      uploadedParts, key,
    });
    if (uploadedParts.length) statsStore.addLog({ action: 'fs.upload', detail: `断点续传恢复 ${key}（已传 ${uploadedParts.length} 分片）` });
  } catch (e) {
    const err = e.status ? e : translateError(e);
    res.status(err.status || 500).json({ error: err.message });
  }
});

/**
 * SEC-10：校验本次请求是否有权操作该上传会话。
 *
 * chunk / complete / abort 三个接口此前**都不校验归属** —— sessionId 是 24 位 hex，
 * 管理员在 `/fs/sessions` 能看见全部，任何拿到它的人都能往他人桶里写内容，
 * 或替他人完成 / 中止上传（DoS）。管理员可操作全部会话（运维需要）。
 *
 * 三个接口共用这一个判定，避免「加了两个、漏掉第三个」。
 */
function assertSessionOwner(sess, req) {
  if (!sess) return;
  if (req.authUser && req.authUser.role === 'admin') return;
  const owner = String(sess.createdBy || '');
  const me = String((req.authUser && req.authUser.username) || '');
  if (owner && owner === me) return;
  // 无归属信息的是历史遗留会话：宁可拦下让管理员处置，也不默认放行
  const e = new Error(owner ? '无权操作他人的上传任务' : '该上传任务缺少归属信息，仅管理员可操作');
  e.status = 403;
  throw e;
}

// 分片上传：上传单个分片（加密开启时按分片加密后上传）
router.put('/fs/upload/chunk', express.raw({ type: () => true, limit: '64mb' }), async (req, res) => {
  try {
    requireConfig();
    const sess = uploadSessions.get(String(req.query.session || ''));
    const partNumber = Number(req.query.part || 0);
    if (!sess) throw badRequest('上传会话不存在或已失效');
    assertSessionOwner(sess, req); // SEC-10
    if (!req.body || !req.body.length) throw badRequest('分片参数错误');
    /**
     * R11-14：`partNumber` 必须是 1..10000 的整数（S3 协议的分片序号范围）。
     *
     * 旧实现只写了 `if (!partNumber || ...)`：小数 `3.7` 是真值，会写进
     * `sess.parts` / `sess.enc.parts` 并触发整会话落盘，还在 `enc-store` 的
     * `base = (partNumber-1)*chunkSize` 里产生**分数偏移**；`-1` / `99999` 同样
     * 先落盘再由云端拒绝。越界值必须在本入口就挡掉。
     */
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
      throw badRequest('分片序号必须是 1 到 10000 之间的整数');
    }

    // 加密一致性所需的当前模式，同时用于下面的分片上限回落
    const mode = encStore.currentMode();

    /**
     * R12-05：magic 模式下分片偏移完全由 `chunkSize` 决定
     * （`encryptPart` 里 `base = (partNumber - 1) * sess.chunkSize`）。
     * 会话缺 `chunkSize` 时 `base` 是 `NaN` → 第 2 片起必 500，任务永久卡死，
     * 且 FUN-11 的完整性校验同时退化为 `none`。
     *
     * 这里在**入口**就挡住（409，文案给出路），而不是放行到「按模式上限比对」
     * 那条分支 —— 那只挡得住"分片太大"，挡不住"偏移算不出来"。
     * `encryptPart` 内部还有一层同款兜底（最内层），两处口径一致。
     */
    if (mode === 'magic' && !(Number(sess.chunkSize) > 0 && Number.isFinite(Number(sess.chunkSize)))) {
      const e = new Error(
        '该上传任务未记录有效的分片大小，无法按「文件头魔数」模式计算分片偏移'
        + '（偏移由分片大小决定）。请取消该上传任务后重新上传。'
      );
      e.status = 409;
      throw e;
    }

    /**
     * R10-08 / R11-08：分片大小必须与会话声明的 `chunkSize` 一致。
     *
     * R9-09 把 magic 上限下沉到了 `encryptBuffer`，但 `encryptPart`（分片路径）没有
     * 上限判定，而这里又只校验「非空」—— 持有合法会话者可以提交一个远大于会话
     * `chunkSize` 的分片（例如 60MB，仍在 `express.raw` 的 64MB 之内），让 magic
     * 的同步 XOR 跑上数秒、独占事件循环。上限因此只挡住了"合法上传会卡"，
     * 挡不住"构造请求才能卡" —— 病根（逐个入口各写一次）依旧存在。
     *
     * 校验 body ≤ `chunkSize` 是**天然一致**的约束：分片偏移由 `chunkSize` 决定，
     * 超过它的分片本就与已确定的分片边界不符，接受它只会产出无法正确合并的文件。
     *
     * R11-08 两条绕行一并堵上：
     *  ① 会话**没有** `chunkSize`（7 天有效期内的历史 `upload-sessions.json` 可被
     *     读到）时 `Number(sess.chunkSize) > 0` 为假 → 整个校验被跳过。实测 magic
     *     下提交 20MB 分片：200，同步 XOR 阻塞 1771ms。
     *  ② 会话在 `mode=none` 下创建（chunkSize 可达 48MB）、之后管理员切到 magic，
     *     用户不重新 init 直接 PUT → 用 48MB 比对的校验反而"通过"。实测 3712ms。
     * 处理：缺失时回落到**当前模式的硬上限**；同时在 `encryptPart` 内部再兜一层
     * （上限出现在第 5 个入口上时，应下沉到最内层函数一次，而不是每条入口各写一遍）。
     */
    const chunkCap = Number(sess.chunkSize) > 0
      ? Number(sess.chunkSize)
      : (mode === 'magic' ? MAGIC_CHUNK_MAX : UPLOAD_CHUNK_MAX);
    if (req.body.length > chunkCap) {
      const e = new Error(
        `分片大小 ${req.body.length} 字节超过上限 ${chunkCap} 字节；`
        + (Number(sess.chunkSize) > 0
          ? '分片偏移已由分片大小确定，超大的分片无法正确合并。'
          : '该上传任务未记录分片大小，已按当前加密模式的上限判定；请取消任务后重新上传。')
      );
      e.status = 400;
      throw e;
    }

    // 加密一致性：会话已按其他模式加密、或此前已有明文分片 → 拒绝（避免产出混合密文/明文文件）
    if (mode !== 'none') {
      if (sess.enc && sess.enc.mode !== mode) {
        const e = new Error('加密方式在上传过程中已变更，与当前任务不一致；请取消该上传任务后重新上传');
        e.status = 409; throw e;
      }
      if (!sess.enc && Object.keys(sess.parts).length) {
        const e = new Error('加密在本次上传过程中才开启，已上传的分片为明文；请取消该上传任务后重新上传');
        e.status = 409; throw e;
      }
    }

    let body = req.body;
    if (mode !== 'none') {
      body = encStore.encryptPart(sess, partNumber, req.body);
      uploadSessions.touch(sess.id); // 立即持久化 IV/TAG/盐，防响应丢失后无法解密
    }

    const data = await p(getClientForSession(sess), 'multipartUpload', {
      Bucket: sess.bucket, Region: sess.region, Key: sess.key,
      UploadId: sess.uploadId, PartNumber: partNumber,
      Body: body, ContentLength: body.length,
    });
    const etag = String(data.ETag || '').replace(/"/g, '');
    uploadSessions.setPart(sess.id, partNumber, etag);
    res.json({ ok: true, partNumber, etag });
    statsStore.sampleTraffic(body.length, 0);
    statsStore.trackBucket(sess.bucket, { up: body.length });
    adjustStorageCache(0); // 保持与原实现一致：分片阶段不修正总量，合并时统一计入
  } catch (e) {
    const err = e.status ? e : translateError(e);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// 分片上传：完成合并（加密任务先校验元数据完整性，成功后写入加密元数据）
router.post('/fs/upload/complete', async (req, res) => {
  try {
    requireConfig();
    const sess = uploadSessions.get(String((req.body || {}).sessionId || ''));
    if (!sess) throw badRequest('上传会话不存在或已完成');
    assertSessionOwner(sess, req); // SEC-10
    // FUN-03：必须按**会话自身**的 bucket/region/provider 解析凭据。
    // 旧实现用 requireConfig() + getClient() 取的是「当前激活桶」的客户端，却拿它去
    // 操作 sess.bucket：上传期间一旦切换激活桶（管理员切桶或用户切到别的桶），
    // UploadId 属于原桶、密钥与厂商都不匹配 → 在**所有分片都已传完**的最后一步必然 403。
    // R10-10：一次解析出完整 cfg，客户端与用量缓存修正共用同一份 ——
    // 保证缓存键里的 secretId 与统计页算键时用的是同一把密钥。
    const sessCfg = configForSession(sess);
    const client = getClient(sessCfg);
    const parts = Object.entries(sess.parts)
      .map(([n, etag]) => ({ PartNumber: Number(n), ETag: etag }))
      .sort((a, b) => a.PartNumber - b.PartNumber);
    if (!parts.length) throw badRequest('没有已上传的分片');
    const encMeta = encStore.buildFinalMeta(sess); // 加密任务：校验并生成元数据（不完整则拒绝合并）
    await p(client, 'multipartComplete', {
      Bucket: sess.bucket, Region: sess.region, Key: sess.key,
      UploadId: sess.uploadId, Parts: parts,
    });
    // SEC-08：分片合并成功即云端已有完整密文，解密凭据必须同步落盘。
    // R8-03：会话以「不加密」模式开启时，合并出来的就是明文 —— 必须清掉被覆盖掉的
    // 旧密文所对应的元数据（同一 key 先前的加密上传），否则下载按旧参数还原 → 损坏。
    encStore.reconcileAfterWrite(sess.bucket, sess.key, encMeta);
    uploadSessions.remove(sess.id);
    res.json({ ok: true, key: sess.key, encrypted: !!encMeta });
    // R10-10：必须传完整 cfg（见 configForSession 的说明）。手拼的 `{bucket,region,provider,credentialId}`
    // 缺 secretId → 缓存键与统计页不一致 → 修正恒为静默空操作。
    adjustStorageCache(sess.size, sessCfg);
    statsStore.addLog({ action: 'fs.upload', detail: `上传完成 ${sess.key}（${(sess.size / 1048576).toFixed(1)} MB，${parts.length} 分片${encMeta ? '，已加密存储' : ''}）` });
  } catch (e) {
    const err = e.status ? e : translateError(e);
    res.status(err.status || 500).json({ error: err.message });
    statsStore.addLog({ action: 'fs.upload', detail: '分片合并失败: ' + err.message, level: 'error' });
  }
});

// 分片上传：中止（取消上传）
router.post('/fs/upload/abort', async (req, res) => {
  try {
    requireConfig();
    const sess = uploadSessions.get(String((req.body || {}).sessionId || ''));
    if (sess) assertSessionOwner(sess, req); // SEC-10
    if (sess) {
      // FUN-03：与 complete 同理，按会话自身凭据解析 —— 切桶后取消上传也必须能成功中止，
      // 否则远端 UploadId 会永远残留（占用存储并持续计费）。
      const client = getClientForSession(sess);
      let abortErr = '';
      try { await p(client, 'multipartAbort', { Bucket: sess.bucket, Region: sess.region, Key: sess.key, UploadId: sess.uploadId }); }
      catch (e) { abortErr = e.message; }

      if (abortErr) {
        // R8-10：远端中止失败时**绝不能**删本地会话 —— 它是唯一能回收该 UploadId 的句柄。
        // 删掉它 = 云端 multipart 永久残留并持续计费，且 /fs/sessions 里再也看不到，
        // 唯一出路只剩管理员手工「清空文件碎片」；而日志还谎报"已取消"。
        // 与 upload-sessions.prune() 的「客户端不可用时保留会话、等下轮再试」同一口径（R7-12）。
        // 保留后会在下一轮 prune 里重试中止；这里如实回传，不再返回 ok:true。
        statsStore.addLog({
          action: 'fs.upload', level: 'error',
          detail: `取消上传失败，云端分片未回收：${sess.key}（${abortErr}）—— 已保留会话以待重试`,
        });
        return res.status(502).json({
          ok: false,
          error: `已在本地取消，但云端中止分片上传失败（${abortErr}）；未回收的碎片将在稍后自动重试`,
        });
      }
      uploadSessions.remove(sess.id);
      statsStore.addLog({ action: 'fs.upload', detail: '已取消上传 ' + sess.key, level: 'warn' });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// 未完成会话列表（供上传管理器展示可续传项）
//
// SEC-07：普通用户只能看到**自己创建的**会话 —— 否则会泄露他人的桶名与对象键。
// 管理员可见全部（运维需要）。
router.get('/fs/sessions', async (req, res) => {
  try {
    requireConfig();
    const isAdminUser = req.authUser && req.authUser.role === 'admin';
    const opt = isAdminUser ? undefined : { createdBy: (req.authUser && req.authUser.username) || '\u0000' };
    const list = uploadSessions.list(opt).map((s) => ({
      sessionId: s.id, key: s.key, size: s.size, chunkSize: s.chunkSize,
      uploadedCount: Object.keys(s.parts).length, updatedAt: s.updatedAt,
    }));
    res.json({ sessions: list });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

/* ============================ 下载 / 预览 ============================ */

/** 日志后缀：加密文件标注解密下发 */
function encLogSuffix(bucket, key) {
  return encStore.getMeta(bucket, key) ? '，已解密' : '';
}

/**
 * R11-05：`/fs/download` 必须显式注册 HEAD 处理器。
 *
 * express 的 `Route.prototype._handles_method` 对 HEAD 有回退 —— route 上没有
 * `head` 时把方法名退化成 `get` 再匹配。于是只写 `router.get` 的 HEAD 会走
 * `streamDownload()` **全路径**：完整 `cos.getObject`（加密对象还要整份流式解密）
 * + `sampleTraffic()` 按整份对象大小记账。
 *
 * 后果是双重的：① 1 字节的探测放大成整份对象的流量与 CPU；② **下载流量统计被
 * 凭空抬高**，仪表盘数字与真实下载行为脱钩。
 *
 * 注册顺序同 R10-12（WebDAV 侧修过的同一机制）：head 必须在 get **之前**，
 * 否则会被 get 的 route 先匹配掉。
 *
 * 与 `/s/:id/dl` 的 HEAD 同款约定：只做廉价检查 + headObject 取长度，
 * 不触对象内容、不计数、不解密。
 */
router.head('/fs/download', async (req, res) => {
  try {
    const cfg = requireConfig();
    const client = getClient(cfg);
    const key = normalizeKey(String(req.query.path || ''));
    const encMeta = encStore.getMeta(cfg.bucket, key);
    if (encMeta && encStore.passwordSet()) {
      // 令牌仅经请求头传递（S5）：与 GET 同一门禁
      const token = String(req.get('x-enc-token') || '');
      if (!encStore.verifyToken(token)) {
        return res.status(401).end();
      }
    }
    const head = await p(client, 'headObject', { Bucket: cfg.bucket, Region: cfg.region, Key: key });
    const cloudSize = Number(head.headers['content-length']) || 0;
    res.setHeader('Content-Type', head.headers['content-type'] || 'application/octet-stream');
    // 加密对象报**明文**长度（与 GET 一致：streamDownload 用的就是 origSize）
    res.setHeader('Content-Length', String(encMeta ? Number(encMeta.origSize) || 0 : cloudSize));
    // 刻意不宣告 Accept-Ranges：GET /fs/download 走 streamDownload，恒为完整 200
    res.status(200).end();
  } catch (e) {
    const err = e.status ? e : translateError(e);
    if (!res.headersSent) res.status(err.status || 500).end();
    else res.destroy();
  }
});

// 下载对象（流式转发，统计下载流量）；密文对象需通过权限验证（查看密码令牌）后解密下发
router.get('/fs/download', async (req, res) => {
  try {
    const cfg = requireConfig();
    const client = getClient(cfg);
    const key = normalizeKey(String(req.query.path || ''));
    const traffic = { bytesDown: 0 };
    const encMeta = encStore.getMeta(cfg.bucket, key);
    if (encMeta && encStore.passwordSet()) {
      // 令牌仅经请求头传递（S5）：避免出现在浏览器历史、Referer 与访问日志中
      const token = String(req.get('x-enc-token') || '');
      if (!encStore.verifyToken(token)) {
        const e = new Error('该文件已加密，请先通过加密访问密码验证');
        e.status = 401;
        e.needUnlock = true;
        throw e;
      }
    }
    await streamDownload({ cos: client, bucket: cfg.bucket, region: cfg.region, key, fileName: baseName(key), encMeta, req, res, traffic });
    statsStore.addLog({ action: 'fs.download', detail: `下载 ${key}（${traffic.bytesDown} 字节${encLogSuffix(cfg.bucket, key)}）` });
  } catch (e) {
    const err = e.status ? e : translateError(e);
    if (!res.headersSent) res.status(err.status || 500).json(Object.assign({ error: err.message }, e.needUnlock ? { needUnlock: true } : null));
    else res.destroy();
    statsStore.addLog({ action: 'fs.download', detail: '下载失败 ' + String(req.query.path || '') + ': ' + err.message, level: 'error' });
  }
});

// 缩略图：302 跳转到对象存储预签名临时 URL（1 小时有效）；加密文件返回占位图标（密文无法生成缩略图）
router.get('/fs/thumb', async (req, res) => {
  try {
    const cfg = requireConfig();
    const client = getClient(cfg);
    const key = normalizeKey(String(req.query.path || ''));
    if (encStore.getMeta(cfg.bucket, key)) {
      res.status(200).type('svg').setHeader('Cache-Control', 'private, max-age=300');
      return res.send('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" rx="12" fill="#eef2f7"/><rect x="34" y="42" width="28" height="22" rx="4" fill="none" stroke="#8a94a6" stroke-width="4"/><path d="M39 42v-6a9 9 0 0 1 18 0v6" fill="none" stroke="#8a94a6" stroke-width="4"/><circle cx="48" cy="53" r="3" fill="#8a94a6"/><text x="48" y="82" text-anchor="middle" font-size="11" fill="#616161" font-family="sans-serif">已加密</text></svg>');
    }
    const url = await new Promise((resolve, reject) => {
      client.getObjectUrl({ Bucket: cfg.bucket, Region: cfg.region, Key: key, Sign: true, Expires: 3600 }, (err, data) => (err ? reject(err) : resolve(data.Url)));
    });
    res.redirect(302, url);
  } catch (e) {
    const err = e.status ? e : translateError(e);
    res.status(err.status || 500).json({ error: err.message });
  }
});

/**
 * 生成预签名分享链接（加密文件禁止：直链只会得到密文，且绕过查看密码）
 *
 * SEC-09：直链**绕过了分享链接的全部限制**（有效期 / 次数 / 密码 / 付费 / 来源校验），
 * 因此这里做两件事：
 *  1. TTL 上限从 7 天压到 24 小时 —— 直链一旦外泄，暴露窗口缩短 7 倍；
 *  2. 补审计日志（此前完全没有）—— 谁、什么时候、对哪个对象签了多久，必须可追溯。
 *
 * ⚠️ 是否需要进一步**限管理员**属于产品决策：前端「创建分享链接 → 直链」是对所有
 *    登录用户开放的既定功能，收口会改变普通用户的可用能力，故此处先做可观测 + 收敛窗口。
 */
const MAX_PRESIGN_EXPIRES = 24 * 3600;

router.get('/fs/presign', async (req, res) => {
  try {
    const cfg = requireConfig();
    const client = getClient(cfg);
    const key = normalizeKey(String(req.query.path || ''));
    if (encStore.getMeta(cfg.bucket, key)) {
      const e = new Error('该文件已加密存储，预签名直链只会得到密文且绕过密码验证；请使用「下载」或带密码的分享链接');
      e.status = 409;
      throw e;
    }
    const expires = Math.min(MAX_PRESIGN_EXPIRES, Math.max(60, Number(req.query.expires) || 3600));
    const url = await new Promise((resolve, reject) => {
      client.getObjectUrl({ Bucket: cfg.bucket, Region: cfg.region, Key: key, Sign: true, Expires: expires }, (err, data) => (err ? reject(err) : resolve(data.Url)));
    });
    statsStore.addLog({
      action: 'fs.presign',
      detail: `签发直链 ${key}（有效期 ${Math.round(expires / 3600)} 小时，用户 ${(req.authUser && req.authUser.username) || '未知'}，IP ${security.clientIp(req)}）`,
    });
    res.json({ url, expires });
  } catch (e) {
    const err = e.status ? e : translateError(e);
    res.status(err.status || 500).json({ error: err.message });
  }
});

/* ============================ 删除 / 重命名 / 移动 ============================ */

/**
 * 删除文件夹：流式「列举一页 → 删一页」直到列完（FUN-04）
 *
 * 旧实现一次性 `listAll(cap: 100000)`：达到上限即返回，**调用方不检查是否被截断**，
 * 直接累加 `deleted` 并宣布成功；紧随其后的 `removeMetaPrefix()` 却会清理
 * 该前缀下**全部**加密元数据。于是超过 10 万对象的桶会留下：
 *   ① 云端残留对象（不可见但持续产生费用，且让「彻底删除桶」被 409 拒绝）
 *   ② 其加密元数据已被清空 → **残留密文永久无法解密**（不可逆数据损失）
 *
 * 修复要点：
 *  1. 用 {@link listAllInfo} 的 `truncated` 显式判断是否列完，循环直到列空为止（内存恒定）；
 *  2. 元数据只清理 **本批确认删除成功的 key**（逐批回调），不再按前缀无条件清空；
 *  3. 返回值携带 `truncated` / `rounds`，让上层能如实呈现「部分完成」而不是假装成功。
 *
 * @param {object} client
 * @param {object} cfg
 * @param {string} key 前缀（目录）
 * @param {(deletedKeys: string[]) => void} [onDeleted] 每批删除成功后回调（用于清理元数据）
 * @returns {Promise<{count:number, bytes:number, truncated:boolean, rounds:number}>}
 */
async function deletePrefix(client, cfg, key, onDeleted) {
  let deleted = 0;
  let bytes = 0;
  let rounds = 0;
  let truncated = true;
  /**
   * R11-01：「整批 0 成功即停下」必须落在**外层**变量上。
   *
   * 旧实现只有内层的 `break` + `truncated = true` —— break 只跳出内层 `for`，
   * 而 `truncated` 恰是外层 `while` 的继续条件，于是「停下」变成了「再跑一轮」：
   * 桶策略含 `Deny s3:DeleteObject` / 对象锁时 `okKeys` 恒为空，循环跑满
   * `MAX_ROUNDS=1000`，一次失败被放大成上千次全量列举 + 批量删除（期间该桶的
   * 列举配额被吃满、真实产生计费请求，最终仍只回一句「请再次执行删除」）。
   * 注释声称的「立刻停下」从未发生 —— 注释说明意图，代码决定事实。
   */
  let stalled = false;
  // 防御上限：正常桶在数十轮内必清空；越界说明服务端翻页异常（marker 未推进），
  // 此时必须停下并返回 truncated=true，而不是继续空转。
  const MAX_ROUNDS = 1000;
  while (truncated && !stalled && rounds < MAX_ROUNDS) {
    const info = await listAllInfo(client, cfg, key, { cap: LIMITS.DELETE });
    truncated = info.truncated;
    if (!info.items.length) break;
    for (let i = 0; i < info.items.length; i += 1000) {
      const batch = info.items.slice(i, i + 1000);
      const sizeOf = new Map(batch.map((k) => [k.key, Number(k.size || 0)]));
      /**
       * R10-03：与 `/fs/delete` 的文件分支共用同一套**白名单**判据。
       *
       * 旧实现丢弃 `deleteMultipleObject` 的返回值、无条件 `deleted += batch.length`
       * 并把整批 key 交给 `onDeleted` → 云端（S3 兼容厂商）在 200 响应体的 `<Error>`
       * 里报告的单个失败被当成成功，于是对**仍然存在**的对象清掉解密凭据
       * （永久不可解）并把分享链接标成已删除（已分发 URL 永久失效）。
       */
      const res = await deleteMultipleConfirmed(client, cfg, batch.map((k) => k.key));
      deleted += res.okKeys.length;
      bytes += res.okKeys.reduce((s, k) => s + (sizeOf.get(k) || 0), 0);
      // 仅当云端删除确实成功后才清理元数据 —— 这是「密文不可解」的最后一道防线
      if (onDeleted && res.okKeys.length) onDeleted(res.okKeys);
      // 一批里**一个都没删掉** = 卡住了（权限 / 对象锁）→ 置位 stalled 让外层
      // while 也停下，并如实报 truncated（见函数头的 R11-01 说明）
      if (!res.okKeys.length) {
        stalled = true;
        truncated = true;
        break;
      }
    }
    rounds += 1;
  }
  return { count: deleted, bytes, truncated, rounds, stalled };
}

/**
 * FUN-14：目标存在性检查 —— **云端覆写不可撤销**，写入目标前必须先探测。
 *
 * 上一轮只给「/fs/move 的目录分支」加了检查，`/fs/rename` 的文件夹分支与
 * `/fs/move` 的文件分支仍会静默覆盖：把文件夹重命名到已存在的同名文件夹时，
 * 目标内同名对象被无声替换，且没有副本可回退。
 *
 * 这里统一成一条函数，所有「会写入新 key」的分支都必须先调用它 ——
 * 避免再出现"改了其中一条、另两条漏掉"的同类问题。
 *
 * @param {object} client
 * @param {object} cfg
 * @param {string} newKey 目标 key（文件夹请以 '/' 结尾）
 * @param {string} [label] 错误文案里展示的名称（缺省取末段）
 */
async function assertNoConflict(client, cfg, newKey, label) {
  const name = label || baseName(String(newKey).replace(/\/+$/, '')) || newKey;
  if (String(newKey).endsWith('/')) {
    // 目录：只要目标前缀下存在**任意**对象即视为冲突（cap:1 够用且最省）
    const probe = await listAllInfo(client, cfg, newKey, { cap: 1 });
    if (probe.items.length) {
      throw badRequest(`目标位置“${name}”下已存在对象，请先移走或改用其它目标`);
    }
    return;
  }
  try {
    await p(client, 'headObject', { Bucket: cfg.bucket, Region: cfg.region, Key: newKey });
    throw badRequest(`目标名称“${name}”已存在`);
  } catch (e) {
    // headObject 对不存在的对象会抛错 —— 只有我们自己抛的"已存在"才需要继续上抛
    if (e && e.status === 400 && /已存在/.test(String(e.message || ''))) throw e;
  }
}

/**
 * 探测对象大小；失败返回 0（调用方按「未知」处理，走最保守的单请求复制）
 *
 * 抽出来是因为 copyOne 需要它，而 rename/move 的文件分支在改动后不再各自传大小。
 */
async function headSize(client, cfg, key) {
  try {
    const h = await p(client, 'headObject', { Bucket: cfg.bucket, Region: cfg.region, Key: key });
    return Number(h && h.headers && h.headers['content-length']) || 0;
  } catch (e) {
    return 0;
  }
}

async function copyOne(client, cfg, fromKey, toKey, size) {
  const src = copySource(cfg.provider, cfg.bucket, cfg.region, fromKey);
  // FUN-03：size 只在**调用方明确给出正数**时才采信，否则主动探测一次。
  //
  // 背景：「移动单个文件」这条分支曾恒传 0，于是永远走单请求复制 ——
  // 腾讯云 COS 上移动 >5GB 的文件必然 EntityTooLarge 失败，且被吞成
  // 「移动完成，1 项失败」，用户完全不知道是大小限制。把探测收进这里，
  // 调用方就不必各自记得传大小（那正是漏改的根源）。
  let n = Number(size);
  if (!Number.isFinite(n) || n <= 0) n = await headSize(client, cfg, fromKey);
  if (n <= COPY_SIMPLE_LIMIT) {
    await p(client, 'putObjectCopy', { Bucket: cfg.bucket, Region: cfg.region, Key: toKey, CopySource: src });
  } else if (providers.isCos(cfg.provider)) {
    // 超大对象走 COS 分块复制；S3 兼容厂商的 putObjectCopy 已支持任意大小（服务端复制）
    await p(client, 'sliceCopyFile', { Bucket: cfg.bucket, Region: cfg.region, Key: toKey, CopySource: src });
  } else {
    await p(client, 'putObjectCopy', { Bucket: cfg.bucket, Region: cfg.region, Key: toKey, CopySource: src });
  }
}

/**
 * 批量复制：受控并发 + **失败即停 + 自动回滚**（FUN-05）
 *
 * 旧实现用固定 5 路 worker 遍历共享游标，任一 `copyOne` 抛错只让 `Promise.all` 拒绝，
 * **其余 worker 仍继续取任务**，已复制的对象也不回滚。而调用方（rename / move）把
 * `deletePrefix()` 排在 `await copyBatch()` 之后 —— 于是失败时源数据完整保留、
 * 目标位置留下一堆半成品副本，接口返回错误。结果是「源与目标同时存在」的重复副本：
 * 容量费用与配额静默翻倍，用户重试还会再叠一层，且难以判断真实状态。
 *
 * 修复要点：
 *  1. 共享 `aborted` 失败标志：任一任务失败后所有 worker 立即停止取新任务（不再继续写副本）；
 *  2. 失败后自动删除**本次已成功复制**的副本 —— 使状态回到「源在目标不在」这一干净起点；
 *  3. 抛出带 `partial` 明细的错误（成功数/总数/是否回滚），便于上层如实呈现。
 *
 * @param {object} client
 * @param {object} cfg
 * @param {Array<{from:string,to:string,size:number}>} items
 * @param {number} [limit] 并发度
 * @param {object} [opts]
 * @param {boolean} [opts.rollback=true] 失败时是否回滚已复制的副本
 * @returns {Promise<{ok:true, copied:number}>}
 * @throws {Error} 存在失败项时抛出；`error.partial` 含明细
 */
async function copyBatch(client, cfg, items, limit = 5, opts = {}) {
  const concurrency = Math.max(1, Math.min(Number(limit) || 5, 8));
  const rollback = opts.rollback !== false;
  let cursor = 0;
  let aborted = false;
  const copied = []; // 本次成功复制出的目标 key（回滚依据）
  const failed = [];

  const workers = [];
  for (let w = 0; w < concurrency; w++) {
    workers.push((async () => {
      while (!aborted && cursor < items.length) {
        const item = items[cursor++];
        try {
          await copyOne(client, cfg, item.from, item.to, item.size);
          copied.push(item.to);
        } catch (e) {
          aborted = true; // 关键：让其余 worker 停止取新任务
          failed.push({ from: item.from, to: item.to, error: (e && e.message) || String(e) });
          return;
        }
      }
    })());
  }
  await Promise.all(workers);

  if (failed.length) {
    // FUN-10：回滚失败的**孤儿副本**必须留痕。
    // 旧实现 catch 里只有一句注释说"至少要留下线索"，却什么都没做 ——
    // 于是孤儿副本静默占用容量（费用翻倍），运维既没有日志也没有接口返回值可查。
    const orphans = [];
    if (rollback && copied.length) {
      // R12-04：唯一实现点（批量 + 白名单判据），与另两处复制入口同款
      const rb = await gateway.rollbackCopies(client, cfg, copied);
      for (const x of rb.errors) orphans.push({ key: x.key, error: x.message });
    }
    if (orphans.length) {
      statsStore.addLog({
        action: 'fs.copy.rollback',
        level: 'error',
        detail: `复制回滚失败，残留 ${orphans.length} 个孤儿副本需手工清理：`
          + orphans.slice(0, 20).map((o) => o.key).join('、')
          + (orphans.length > 20 ? ` 等 ${orphans.length} 个` : '')
          + `（首个错误：${orphans[0].error}）`,
      });
    }
    const err = new Error(
      `复制未完成：共 ${items.length} 个对象，成功 ${copied.length} 个后失败 —— ${failed[0].error}`
      + (rollback
        ? (orphans.length
          ? `。回滚时 ${orphans.length} 个副本删除失败，**请手工清理这些孤儿副本**（已记入日志）。`
          : `。已自动回滚${copied.length ? `这 ${copied.length} 个` : ''}副本，源数据保持不变，可安全重试。`)
        : '。**目标位置可能残留半成品副本，请手工检查。**')
    );
    err.status = 500;
    err.partial = {
      total: items.length, copied: copied.length, rolledBack: rollback, failed, orphans,
    };
    throw err;
  }
  return { ok: true, copied: copied.length };
}

// 重命名（文件或文件夹）：复制到新 Key 后删除原对象
router.post('/fs/rename', async (req, res) => {
  try {
    const cfg = requireConfig();
    const client = getClient(cfg);
    const key = normalizeKey(String((req.body || {}).path || ''));
    const newName = String((req.body || {}).newName || '').trim();
    if (!key) throw badRequest('路径不能为空');
    if (!newName || /[\\/:*?"<>|]/.test(newName)) throw badRequest('名称不能包含 \\ / : * ? " < > | 字符');
    // R14-13：`.` 与 `..` 必须挡在**写入侧**。名字校验的字符集不含点号，
    // 于是 `newName='..'` 会被拼成键 `a/..` 写进云端；而删除 / 移动 / stat 都要跑
    // `normalizeKey`（其中对含 `..` 的键抛 400）—— 该对象从此**永远删不掉**
    // （整批删除被整批拒绝），界面还会渲染出一个名为 `..` 的同级条目，点一下就是 400。
    // 它不构成路径穿越（对象键从不作为文件系统路径），真实后果是「不可逆的幽灵对象」。
    if (newName === '.' || newName === '..') throw badRequest('名称不能为 . 或 ..');
    const isFolder = key.endsWith('/');
    // 与「读 / 删」用同一把尺子：直接让拼出来的 newKey 过一遍 normalizeKey。
    // 这样将来 normalizeKey 再加任何一条规则，写入侧自动跟着收紧，不必再记着同步。
    const newKey = normalizeKey(parentOf(key) + newName + (isFolder ? '/' : ''));
    if (newKey === key) return res.json({ ok: true, unchanged: true });

    let copied = 0;
    // FUN-14：无论文件还是文件夹，写目标前都先探测 —— 云端覆写不可撤销
    await assertNoConflict(client, cfg, newKey, newName);

    if (isFolder) {
      if (newKey.startsWith(key)) throw badRequest('不能将文件夹重命名为其自身或其子路径');
      // FUN-02：必须完整列举 —— 截断就拒绝，否则「删源」会删掉没复制的对象
      const items = await listAllExact(client, cfg, key, { cap: LIMITS.STAT }, '重命名');
      const relKeys = items.map((item) => item.key.slice(key.length));
      const tasks = items.map((item, i) => ({ from: item.key, to: newKey + relKeys[i], size: item.size }));
      await copyBatch(client, cfg, tasks);
      copied = tasks.length;
      // 元数据迁移必须在**删除源对象之前**完成：若先删后才迁，中途失败会让密文失去元数据
      // R10-04：只清理"本次确实被覆盖写入"的目标条目（见 migratePrefix 的说明）。
      // rename 的目标已由 assertNoConflict 确认为空，这里传的是全部源相对键。
      encStore.migratePrefix(cfg.bucket, key, newKey, { overwriteRelKeys: new Set(relKeys) });
      // 源对象被删 → 指向它们的分享链接同步标记「文件已删除」（重命名后旧链接本就失效）
      const rm = await deletePrefix(client, cfg, key, (ks) => shareStore.markMissingByKeys(cfg.bucket, ks));
      if (rm.truncated) {
        // 源数据未删干净 —— 此时已复制出完整副本，源残留属重复占用，必须如实暴露
        const err = new Error(`重命名后清理源目录未完成（已删 ${rm.count} 个对象后仍被截断），请重试或手工清理 ${key}`);
        err.status = 500;
        throw err;
      }
    } else {
      await copyOne(client, cfg, key, newKey, Number((req.body || {}).size) || 0);
      // FUN-11：元数据迁移必须在**删除源对象之前**完成（与上面文件夹分支同序）。
      // 旧实现先 deleteObject 再 renameMeta：两步之间任何一次失败（进程退出、
      // 网络中断、renameMeta 抛错）都会让密文留在 newKey 而元数据仍挂在旧 key 上，
      // 该对象从此无法解密 —— 数据还在，但等于永久丢失。反过来最多是残留一条
      // 无人引用的元数据，可安全清理。
      encStore.renameMeta(cfg.bucket, key, newKey); // 加密元数据随迁（密文复制后参数不变）
      await p(client, 'deleteObject', { Bucket: cfg.bucket, Region: cfg.region, Key: key });
      shareStore.markMissingByKeys(cfg.bucket, [key]);
      copied = 1;
    }
    res.json({ ok: true, newKey, copied });
    statsStore.addLog({ action: 'fs.rename', detail: `重命名 ${key} -> ${newKey}${isFolder ? `（共 ${copied} 个对象）` : ''}` });
  } catch (e) {
    const err = e.status ? e : translateError(e);
    res.status(err.status || 500).json({ error: err.message });
    statsStore.addLog({ action: 'fs.rename', detail: '重命名失败: ' + err.message, level: 'error' });
  }
});

// 移动（支持批量，文件夹递归）
router.post('/fs/move', async (req, res) => {
  try {
    const cfg = requireConfig();
    const client = getClient(cfg);
    const paths = Array.isArray((req.body || {}).paths) ? req.body.paths : [];
    let targetPrefix = normalizeKey(String((req.body || {}).targetPrefix || ''));
    if (targetPrefix && !targetPrefix.endsWith('/')) targetPrefix += '/';
    if (!paths.length) throw badRequest('未选择要移动的对象');
    const keys = paths.map((raw) => normalizeKey(String(raw)));
    // 按下标回填、按入参顺序输出（目录串行 + 文件并发，两条路径不能打乱顺序）
    const results = new Array(keys.length).fill(null);

    /**
     * 移动单个对象 / 目录，返回结果条目（**不抛错** —— 单项失败不影响其余项）。
     *
     * R8-19：整段逻辑抽成闭包，是为了让「文件」分支能按受控并发跑起来 ——
     * 旧实现 200 个文件 = 200 × (1 次存在性 HEAD + 1 次复制 + 1 次删除) = 约 600 次
     * **串行**云端往返（按 30ms 估约 18 秒），浏览器早已超时且无进度。
     */
    const moveOne = async (key) => {
      const isFolder = key.endsWith('/');
      /**
       * R10-02：`baseName()` 会剥掉尾斜杠（`baseName('a/b/') === 'b'`），
       * 因此文件夹必须**显式补回** —— 否则 `newKey` 是 `dest/b` 而不是 `dest/b/`，
       * 下面 `{@link assertNoConflict}` 与 `migratePrefix` 都自己补了 `/`，
       * 唯独拼子对象目标键的那一处没补 → `a/b/x.txt` 被搬到 `dest/bx.txt`、
       * `a/b/sub/y.txt` 被搬到 `dest/bsub/y.txt`：
       *   ① 子对象变成与文件夹同级的**错名文件**，随后源目录整份删掉 —— 用户看到
       *      「移动成功」，实际目录结构已被破坏；
       *   ② 元数据按 `dest/b/` 迁移，而对象实际在 `dest/bx.txt` —— 密文失去全部
       *      解密凭据且旧条目已删除（**不可逆**）；
       *   ③ `assertNoConflict` 只探测了 `dest/b/`，错名键上的静默覆盖毫无前置检查。
       *
       * 这里一处定义、四处取用，与 rename 分支（`newKey` 自带尾斜杠）保持同一写法。
       */
      // R14-13：与 rename 分支同款 —— 拼出的 newKey 再过一次 normalizeKey。
      // 这里 `targetPrefix` 与 `baseName(key)` 都已规范化，构造上不会产出含 `..` 的键
      // （故当前不可利用），但「写侧」与「读 / 删侧」共用同一把尺子成本为零，
      // 且将来 normalizeKey 增删规则时写入侧会自动跟随，不必再记着同步。
      const newKey = normalizeKey(targetPrefix + baseName(key) + (isFolder ? '/' : ''));
      try {
        if (isFolder && newKey.startsWith(key)) throw badRequest('不能将文件夹移动到其自身内部');
        if (newKey === key) return { path: key, ok: true, skipped: true };
        // FUN-14：目标存在性检查 —— 云端覆写不可撤销
        // `newKey` 对文件夹已自带尾斜杠，可直接按前缀探测
        await assertNoConflict(client, cfg, newKey, baseName(key));

        if (isFolder) {
          // FUN-02：同上，截断即拒绝，避免"搬一半、删全部"
          const items = await listAllExact(client, cfg, key, { cap: LIMITS.STAT }, '移动');
          const relKeys = items.map((item) => item.key.slice(key.length));
          const tasks = items.map((item, i) => ({ from: item.key, to: newKey + relKeys[i], size: item.size }));
          await copyBatch(client, cfg, tasks);
          // 元数据迁移必须在删除源之前完成，否则中途失败会让密文失去元数据
          // R10-04：只清理"本次确实被覆盖写入"的目标条目（见 migratePrefix 的说明）
          encStore.migratePrefix(cfg.bucket, key, newKey, { overwriteRelKeys: new Set(relKeys) });
          const rm = await deletePrefix(client, cfg, key, (ks) => shareStore.markMissingByKeys(cfg.bucket, ks));
          if (rm.truncated) {
            const err = new Error(`移动后清理源目录未完成（已删 ${rm.count} 个对象后仍被截断），请重试或手工清理 ${key}`);
            err.status = 500;
            throw err;
          }
        } else {
          await copyOne(client, cfg, key, newKey, 0);
          // FUN-11：同 rename —— 先迁元数据，再删源（顺序颠倒会丢解密能力）
          encStore.renameMeta(cfg.bucket, key, newKey); // 加密元数据随迁
          await p(client, 'deleteObject', { Bucket: cfg.bucket, Region: cfg.region, Key: key });
          shareStore.markMissingByKeys(cfg.bucket, [key]);
        }
        return { path: key, ok: true, newKey };
      } catch (e) {
        return { path: key, ok: false, error: e.message };
      }
    };

    // R8-19：目录之间可能互相影响（先移 A 进 B、再移 B 会改变语义，且目录移动内部
    // 已是批量 + 受控并发），因此**目录一律串行**；文件彼此独立 → 受控并发（4 路）。
    for (let i = 0; i < keys.length; i++) {
      if (keys[i].endsWith('/')) results[i] = await moveOne(keys[i]);
    }
    const fileIdx = keys.map((k, i) => i).filter((i) => !keys[i].endsWith('/'));
    await mapLimit(fileIdx, 4, async (i) => { results[i] = await moveOne(keys[i]); });

    const out = results.map((r, i) => r || { path: keys[i], ok: false, error: '未处理' });
    res.json({ ok: out.every((r) => r.ok), results: out });
    statsStore.addLog({ action: 'fs.move', detail: `移动 ${paths.length} 项到 ${targetPrefix || '/'}（成功 ${out.filter((r) => r.ok).length}）` });
  } catch (e) {
    const err = e.status ? e : translateError(e);
    res.status(err.status || 500).json({ error: err.message });
    statsStore.addLog({ action: 'fs.move', detail: '移动失败: ' + err.message, level: 'error' });
  }
});

// 删除（支持批量，文件夹递归删除）
router.post('/fs/delete', async (req, res) => {
  try {
    const cfg = requireConfig();
    const client = getClient(cfg);
    const paths = Array.isArray((req.body || {}).paths) ? req.body.paths : [];
    if (!paths.length) throw badRequest('未选择要删除的对象');
    const keys = paths.map((raw) => normalizeKey(String(raw)));
    // 结果按下标回填、最后按**入参顺序**输出：目录与文件走两条处理路径，
    // 不能让它们打乱顺序（前端按 results[i] 对应选中的第 i 项）
    const results = new Array(keys.length).fill(null);
    let deleted = 0;
    let freedBytes = 0;

    /* ---- ① 目录：递归删除 ---- */
    // 目录数通常很少，且每个目录内部已经是「列一页 → 每 1000 个一批
    // deleteMultipleObject」的流式处理（deletePrefix），因此保持逐个串行。
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (!key.endsWith('/')) continue;
      try {
        // FUN-04：元数据只针对「云端确认删除成功」的 key 清理，
        // 绝不在删除可能被截断的前提下按前缀清空（否则残留密文永久不可解）
        const r = await deletePrefix(client, cfg, key, (deletedKeys) => {
          encStore.removeMetaBatch(cfg.bucket, deletedKeys);
          // 指向这些对象的分享链接一并标记为「文件已删除」—— 只认本批确认删除的 key
          shareStore.markMissingByKeys(cfg.bucket, deletedKeys);
        });
        deleted += r.count;
        freedBytes += r.bytes;
        results[i] = r.truncated
          ? {
            path: key, ok: false,
            // R11-01：stalled（云端拒绝删除，如对象锁 / 桶策略）与「对象过多未删完」
            // 是两种截然不同的原因，此前被折叠进同一句「请再次执行删除」。
            error: r.stalled
              ? `云端拒绝删除该目录下的对象（对象锁 / 桶策略），已停止；本次共删除 ${r.count} 个`
              : `该目录下对象过多，本次仅删除 ${r.count} 个后仍未清理完毕，请再次执行删除直到全部清除`,
          }
          : { path: key, ok: true };
      } catch (e) {
        results[i] = { path: key, ok: false, error: e.message };
      }
    }

    /* ---- ② 文件：批量删除 ---- */
    //
    // R8-19：旧实现对每个 path 串行 `headObject` + `deleteObject` ——
    // 多选 200 个文件 ≈ 400 次**串行**云端往返（按 30ms 估约 12 秒），
    // 浏览器早已超时、界面也没有任何进度。而**同一个接口**的目录分支早已是
    // 「每 1000 个一批 deleteMultipleObject」，两套做法效率差 1000 倍。
    //
    // 现在：① 大小探测按受控并发（8 路；仅用于用量缓存修正与审计，取不到按 0 计）；
    //      ② 删除走 deleteMultipleObject（每批 ≤ 1000，云端协议上限），按响应里的
    //         **Deleted 白名单**逐 key 判定成败 —— 只对云端明确确认删除成功的 key
    //         清理加密元数据与分享链接状态（与 FUN-04 同一约束：不做「可能失败却先
    //         按批清空」）。
    //
    // R9-02：这里曾经是黑名单（「不在 Error 里就算成功」）。而 S3 的批量删除对整批
    // 回 200、单对象失败只写在响应体 `<Error>` 里，且 `s3-client` 当时把该字段硬编码
    // 成空数组 —— 两层叠加后，失败的对象被当作已删除，触发两件**不可逆**操作。现在
    // 客户端如实解析 `<Error>`，调用方改白名单：两份判据都收紧，不确定的一律不动。
    const fileIdx = keys.map((k, i) => i).filter((i) => !keys[i].endsWith('/'));
    if (fileIdx.length) {
      const sizes = new Map();
      await mapLimit(fileIdx, 8, async (i) => {
        try {
          const head = await p(client, 'headObject', { Bucket: cfg.bucket, Region: cfg.region, Key: keys[i] });
          sizes.set(i, Number(head.headers['content-length']) || 0);
        } catch (e) { sizes.set(i, 0); }
      });

      const BATCH = 1000; // deleteMultipleObject 的单次上限
      for (let s = 0; s < fileIdx.length; s += BATCH) {
        const idxs = fileIdx.slice(s, s + BATCH);
        const batchKeys = idxs.map((i) => keys[i]);
        /**
         * R11：判据收敛到 `deleteMultipleConfirmed`（R9-02 / R10-03 的唯一实现点）。
         *
         * 这里原本是**第 5 份内联副本**：R9-02 修的就是这一段，R10-03 把另四处
         * 接到共用函数时它没跟上（语义等价，但判据从此有两份 —— 改一处漏一处是
         * 本项目反复出现的失效模式）。现在只做「按 key 回填下标」这层适配，
         * 判据本身只有一份。
         */
        const res = await deleteMultipleConfirmed(client, cfg, batchKeys);
        const okSet = new Set(res.okKeys);
        const errByKey = new Map(res.errors.map((x) => [x.key, x.message]));

        const okIdxs = idxs.filter((i) => okSet.has(keys[i]));
        if (okIdxs.length) {
          const okKeys = okIdxs.map((i) => keys[i]);
          encStore.removeMetaBatch(cfg.bucket, okKeys);
          shareStore.markMissingByKeys(cfg.bucket, okKeys);
        }
        for (const i of idxs) {
          if (okSet.has(keys[i])) {
            results[i] = { path: keys[i], ok: true };
            deleted += 1;
            freedBytes += sizes.get(i) || 0;
          } else {
            // 未确认删除 → 一律按失败处理（原因来自 deleteMultipleConfirmed 的 errMap）
            results[i] = {
              path: keys[i], ok: false,
              error: errByKey.get(keys[i])
                || '云端未确认该对象的删除结果（响应中既无 Deleted 也无 Error），已按未删除处理',
            };
          }
        }
      }
    }

    const out = results.map((r, i) => r || { path: keys[i], ok: false, error: '未处理' });
    res.json({ ok: out.every((r) => r.ok), deleted, results: out });
    adjustStorageCache(-freedBytes, cfg); // 立即修正用量缓存
    statsStore.addLog({ action: 'fs.delete', detail: `删除 ${paths.length} 项（共 ${deleted} 个对象）`, level: 'warn' });
  } catch (e) {
    const err = e.status ? e : translateError(e);
    res.status(err.status || 500).json({ error: err.message });
    statsStore.addLog({ action: 'fs.delete', detail: '删除失败: ' + err.message, level: 'error' });
  }
});

// 文件夹树（侧边栏导航，按层级懒加载）
router.get('/fs/tree', async (req, res) => {
  try {
    const cfg = requireConfig();
    const client = getClient(cfg);
    const prefix = normalizeKey(String(req.query.prefix || ''));
    const data = await p(client, 'getBucket', {
      Bucket: cfg.bucket, Region: cfg.region, Prefix: prefix, Delimiter: '/', MaxKeys: 300,
    });
    res.json({ prefix, folders: (data.CommonPrefixes || []).map((x) => x.Prefix) });
  } catch (e) {
    const err = e.status ? e : translateError(e);
    res.status(err.status || 500).json({ error: err.message });
  }
});

/* ============================ 内部工具 ============================ */

/**
 * 分片会话的桶上下文**配置**（会话记录了自己的 bucket/region/provider）
 *
 * 这里必须**按会话自身**解析凭据，而不是用「当前激活桶」—— FUN-03 的核心修复点。
 * 同时 FUN-09：桶记录缺失 / 该厂商无可用密钥时必须显式报错，
 * 不能退回激活密钥（否则会在续传末期因跨厂商 403 丢失已传的全部分片）。
 *
 * ## R10-10：调用方必须拿这里返回的**完整** cfg，不要手工拼对象
 *
 * 分片合并完成后修用量缓存时，曾手工拼了
 * `{ bucket, region, provider, credentialId: sess.credentialId }` 传下去 ——
 * 它**没有 `secretId`**（`upload-sessions.create()` 也从不写 `credentialId`，
 * 所以连 credentialId 这个字段本身都是 undefined）。而用量缓存的键
 * `bucketCacheKey()` 是 `provider|secretId|bucket|region`：
 *
 *   - 统计页写入时算出的键：`tencent|AKIDxxxx|my-125|ap-guangzhou`
 *   - 分片完成修正时算出的键：`tencent||my-125|ap-guangzhou`（secretId 为空）
 *
 * 两者**永不相等** → `adjustStorageCache()` 恒为静默空操作：分片上传完成后
 * 状态栏的用量纹丝不动，要等 15 分钟 TTL 到期才刷新。同一个函数由直传
 * （`requireConfig()`）与删除（`cfg`）调用时都传了完整配置，只有这一处是手拼的。
 *
 * 放在这里而不是给会话补落 `credentialId`：密钥可能被轮换，按桶实时解析出来的
 * 才是**当前生效**的那把，与统计页算键时的口径必然一致。
 *
 * @returns {object} 完整 cfg（含 secretId / provider）；provider 与会话记录不一致时
 *                   已按会话记录覆盖，保证与分片时用的客户端同源
 */
function configForSession(sess) {
  const cfg = configStore.effectiveForBucket(sess.bucket, sess.region);
  if (!cfg || !cfg.secretId || !cfg.secretKey) {
    const e = new Error(
      `上传会话所属的存储桶「${sess.bucket}」当前没有可用的访问密钥`
      + '（可能已被删除，或其所属服务商没有启用的密钥）。请先在系统设置中配置后重试。'
    );
    e.status = 428;
    throw e;
  }
  if (sess.provider && cfg.provider !== sess.provider) {
    return Object.assign({}, cfg, { provider: sess.provider });
  }
  return cfg;
}

function getClientForSession(sess) {
  return getClient(configForSession(sess));
}

// 用量缓存增量修正（懒加载 metrics 模块，避免循环依赖）
function adjustStorageCache(delta, cfg) {
  try {
    require('./stats').adjustStorageCache(delta, cfg);
  } catch (e) { /* 忽略 */ }
}

module.exports = router;
