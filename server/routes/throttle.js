/**
 * 路由：下载限速（R37）
 *
 * 只有一个接口：`GET /throttle/ceiling` —— 查**上层**已经设了多小的限速，
 * 用于四个设置入口给出「已在 XX 中设置限速为 N MB/S」这句提示。
 *
 * ## 为什么不在这里提供「设置限速」的接口
 *
 * 限速值是**实体自身的字段**（密钥 / 存储桶 / 用户 / 分享链接各一条记录），
 * 因此写入走各实体既有的 `POST/PUT`（`speedLimit` 作为普通入参），与本轮之前
 * 的 `quotaBytes` 完全同款。若另开一个 `PUT /throttle/limit`，就会出现
 * 「同一字段两条写路径」—— 校验、审计日志、权限白名单都要各写一份，
 * 正是本项目反复修掉的「同一状态多入口，改一处漏一处」。
 *
 * ## 为什么读要单独一个接口（而不能在前端拼）
 *
 * 「上层设了多小」需要**跨层聚合**：一条分享链接要同时看它所在桶绑定的密钥、
 * 桶本身、以及分享创建者那条用户记录 —— 前端拿不到「桶 → 密钥」的归属（那是
 * `config-store.activeCredential` 的判据，唯一的实现点在服务端）。让前端拼，
 * 就等于在浏览器里重写一份归属推导，必然与下载时实际生效的那份分叉。
 *
 * @see server/throttle.js —— 生效值的唯一判据（`resolveLimit` / `pickEffective`）
 */
const { express } = require('./_context');
const configStore = require('../config-store');
const shareStore = require('../share-store');
const throttle = require('../throttle');

const router = express.Router();

/** 可以配置限速的四类实体（与前端四个入口一一对应） */
const SCOPES = ['credential', 'bucket', 'user', 'link'];

/**
 * 解析「某实体之上还有哪些层」，并按各层限速取最小值。
 *
 * 语义要点：**只算比 `scope` 优先级更高的层**。同层或更低层的值不应该出现在
 * 提示里 —— 用户在这个对话框里填的正是 `scope` 这一层，拿它自己当「上限」是循环论证。
 *
 * 各 scope 的「上层」：
 *  - `credential`（API Key 管理）：最高层，没有上层 → 不限；
 *  - `bucket`（存储桶管理）：上层只有**该桶绑定的密钥**；
 *  - `user`（用户管理）：上层是密钥与桶，但**无法确定**这个用户会用哪个桶 / 哪把密钥
 *    （同一用户可访问多个桶），故按「不限」处理 —— 这是刻意的**不猜**：
 *    随便挑一个桶来当上限会给出一个看似有理、实际错误的数字；
 *  - `link`（文件分享 / 链接管理）：上层是密钥、桶、以及**分享创建者**那条用户记录。
 *
 * 参数两种给法（覆盖「编辑已有链接」与「新建链接」两种场景）：
 *  - `id=<实体 id>`：读该实体自身，桶 / 用户从记录里取；
 *  - `bucket=<桶名>`：新建分享时链接还不存在，桶由对话框里刚选的那一个给出，
 *    用户固定为**当前登录用户**（他就是这条链接的创建者）。
 *
 * 返回 `{ limit, source, sourceLabel, layers }`：
 * `limit` 单位是字节/秒（0 = 上层没设限），`layers` 只给可展示的
 * `{ source, label, mbps }` —— **不带任何 id**，免得把「这个桶归哪把密钥」
 * 这类归属信息顺带发给普通用户。
 */
router.get('/throttle/ceiling', (req, res) => {
  const scope = String(req.query.scope || '').trim();
  if (SCOPES.indexOf(scope) < 0) return res.status(400).json({ error: '参数 scope 无效' });
  const id = String(req.query.id || '').trim();
  const bucketName = String(req.query.bucket || '').trim();

  const ctx = { method: req.method };

  if (scope !== 'credential') {
    // 桶与密钥：已有链接以记录为准，新建链接以对话框里选的桶名为准
    let bucketNameResolved = bucketName;
    let createdBy = '';
    if (scope === 'link' && id) {
      const l = shareStore.get(id);
      if (!l) return res.status(404).json({ error: '链接不存在' });
      bucketNameResolved = l.bucket;
      createdBy = l.createdBy;
    }
    if (scope === 'bucket' || scope === 'link') {
      const full = configStore.load() || { buckets: [], credentials: [] };
      const b = (full.buckets || []).find((x) => (id && scope === 'bucket' ? x.id === id : x.bucket === bucketNameResolved));
      if (!b) return res.status(404).json({ error: '存储桶不存在' });
      ctx.bucketId = b.id;
      // 与下载时「用哪把密钥」同源：归属判据只在 config-store 里，前端拿不到
      const credId = configStore.credentialIdForBucket(full, b);
      if (credId) ctx.credentialId = credId;
    }
    if (scope === 'link') {
      // 匿名下载的用户层按**分享创建者**判（与 share-routes 的下载路径同一口径）
      ctx.userName = createdBy || (req.authUser && req.authUser.username) || '';
    }
    if (scope === 'user') {
      const u = id ? configStore.getUserById(id) : null;
      if (!u) return res.status(404).json({ error: '用户不存在' });
      // 用户层之上无法确定具体的密钥/桶 → 按不限处理（理由见函数头注释）
      return res.json({ limit: 0, source: '', sourceLabel: '', layers: [] });
    }
  }

  const r = throttle.resolveLimit(ctx);
  res.json({
    limit: r.limit, // 字节/秒；0 = 上层没有更严的限制
    source: r.source,
    sourceLabel: r.sourceLabel,
    layers: r.layers.map((l) => ({
      source: l.source,
      label: l.label || throttle.LAYER_LABELS[l.source] || l.source,
      mbps: throttle.toMBps(l.bytesPerSec),
    })),
  });
});

module.exports = router;
