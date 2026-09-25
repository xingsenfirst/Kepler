/**
 * 付费订单存储与状态机 —— data/payments.json（经 secure-store 加密落盘）
 *
 * 状态机（对应需求三：未支付 / 支付中 / 支付失败 / 已支付，外加人工退款）：
 *
 *   （发起）→ pending ──确认成功──→ paid ──管理员标记退款──→ refunded → 拒绝下载（凭证失效）
 *                    └──确认失败──→ failed ───────────────→ 拒绝下载，可重新发起
 *
 * 只有 `paid` 允许下载；`pending`、`failed`、`refunded` 一律拦截并给出对应提示。
 * `refunded` 是**不可逆终态**：网关查单仍会说"已支付"，但本端不认（见 markPaid）。
 *
 *   本系统**不代持资金**：`refunded` 只是人工记账（"钱已在其它渠道退还"），
 *   没有任何网关侧退款调用，也没有 `/pay/refund` 之类的模拟端点。
 *
 *   已接入支付宝 / 微信支付 / PayPal 三个真实网关（`payment-gateway.js`），
 *   模拟开关 `PAYMENT_MOCK` 与模拟端点 `/pay/confirm` **均已删除，不得复活**。
 *
 *   判定原则是**只认服务端主动查单**：全库只有 `share-routes.finalizeOrder()`
 *   会调用 `markPaid`，而它先向网关查单、拿到"确实已支付"才改状态。
 *   异步通知与回跳只当**触发器**用，其内容一律不采信；查单异常按"未支付"处理
 *   （fail-closed）。已支付订单不允许后续失败回调改判。
 *
 * 设计要点：
 *  - 金额以「分」为整数**快照**进订单：分享者事后改价，已支付订单依然有效
 *    （下载者确实付过那个价钱），新订单才按新金额计算。
 *  - 已支付凭证用 HMAC 票据绑定「链接 + 订单」，无法被猜测或跨链接复用。
 *  - 文件名 / 对象键同样**快照**进订单：分享链接被删除后，订单管理页仍要能
 *    回答"这笔钱是为哪个文件付的"。只存 linkId 的话，删链接 = 订单失去上下文。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const configStore = require('./config-store');
const secureStore = require('./secure-store');
const statsStore = require('./stats-store');
const coalesce = require('./coalesce');

// COS_DATA_DIR：与 tests/helpers.js 约定的隔离手段一致 —— 未设置时落到项目 data/，
// 测试进程可指向临时目录，避免在真实 data/ 里留下订单垃圾。
const DATA_DIR = process.env.COS_DATA_DIR ? path.resolve(process.env.COS_DATA_DIR) : path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'payments.json');

/** 单个链接最多保留的订单数（超出后丢弃最旧的终态订单，防止文件无限增长） */
const MAX_ORDERS_PER_LINK = 50;

/**
 * R14-03：`pending` 订单的**不可裁窗口**。
 *
 * 发起支付的人此刻可能正在跳往收银台：异步通知到达时要用这条订单定位
 * （`resolveNotifiedOrder` → `get(tradeNo)`），拿到它才会走 `finalizeOrder`。
 * 在这段窗口里把它裁掉，后果是 **钱已付、订单查无此单、文件永远拿不到**，
 * 且没有任何告警——本模块唯一一条会直接造成经济损失的裁剪。
 *
 * 取 2 小时：覆盖主流网关的下单有效期（支付宝默认 2h、微信 2h、PayPal 约 3h 的下限），
 * 且远大于「下单 → 付款 → 通知到达」的实际链路耗时。
 */
const PENDING_KEEP_MS = (() => {
  const raw = Number(process.env.PAYMENT_PENDING_KEEP_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 2 * 60 * 60 * 1000;
})();
/**
 * R8-25：**全局**订单数上限（跨链接）。
 *
 * 为什么单链接上限不够：`prune(linkId)` 只处理指定链接，而它的唯一调用点在
 * `create()` 内。于是「发起支付 → 删除链接」这个循环会让该 linkId **再也不会**
 * 被 prune 触及（删链接不影响既有订单，这是刻意的：订单要保留以证明"付的是什么"），
 * `payments.json` 于是无界增长。后果是随使用时长的性能衰减 ——
 * 管理端订单页每次全表排序，`persist()` 每次全量序列化。
 *
 * 保留集恒为**全部 `paid` / `refunded`**：那是钱真正流动过的对账凭据，
 * 任何情况下都不能裁（裁掉退款记录就再也证明不了"这笔钱退过"，
 * 只能看到收了一笔、对应文件还被免费下载了）。因此若全是终态订单，
 * 宁可超限也不裁 —— 上限只约束可再造的 `pending` / `failed` 流水。
 *
 * 与 `limits.js` 的列举上限同一惯例：可用环境变量覆盖，便于受控压测与回归护栏
 * 用小上限驱动这条分支（否则要真的造两万笔订单才能碰到它）。
 */
const MAX_ORDERS_TOTAL = (() => {
  const raw = process.env.PAYMENT_MAX_ORDERS_TOTAL;
  if (raw === undefined || raw === '') return 20000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 20000;
})();

/**
 * R14-09：订单落盘的**去抖窗口**（毫秒）。
 *
 * 一次真实支付流程会连续触发 `setTradeNo` / `markPaid` / `markDownloaded` 三次
 * `persist()`，而 `POST /s/:id/pay` 又是匿名可达的（20 次/10 分钟/每 IP+链接，
 * 可跨 IP 叠加）。旧实现每次都全量序列化 + 加密 + 写盘，且缩进序列化下
 * 两万条订单约 6~8MB —— 单个支付动作在事件循环上同步阻塞数百毫秒，
 * 单笔无害、量涨到一定规模后突变为全站卡顿（典型的「温水型」性能债）。
 *
 * 中间态既没人读、也活不过一个去抖窗口，所以合并掉；真正需要落盘的只有最后一次。
 * 与 `config-store` 的 250ms 同一量级。`PAYMENT_WRITE_DEBOUNCE_MS=0` 是逃生阀
 * （退回「立即写」，排查落盘问题时用）。
 *
 * 「窗口内进程被强杀会丢最后一次变更」由两处兜住：优雅停机走 `flush()`，
 * 强制退出走 `coalesce` 的统一退出钩子（同步写 + 只写不建）。
 */
const PAYMENT_WRITE_DEBOUNCE_MS = (() => {
  const raw = process.env.PAYMENT_WRITE_DEBOUNCE_MS;
  if (raw === undefined || raw === '') return 300;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 300;
})();

let cache = null;
/**
 * 读取失败标志（FUN-01）。
 *
 * 只要**任何一次** load() 没能拿到可信数据，就必须永久拒绝写入 ——
 * 否则内存里的 `{orders: []}` 会在下一次 create() 时被落盘，
 * 把磁盘上那份（可能还能人工抢救的）订单文件整体覆盖成空表。
 *
 * 这条护栏的价值在于它**不区分失败原因**：无论是文件真的损坏，
 * 还是本模块自己有代码缺陷（历史上就是漏 require('fs') 导致每次 load 都抛
 * ReferenceError），后果都被限制在「本次进程内订单不可用」，
 * 而不会升级成「历史订单被静默清空」。
 */
let loadFailed = false;

function load() {
  if (cache) return cache;
  if (loadFailed) return { orders: [] }; // 已失败过：不再重试、不再刷屏
  try {
    if (!fs.existsSync(FILE)) { cache = { orders: [] }; return cache; }
    const raw = secureStore.readJson(FILE, null);
    if (raw && Array.isArray(raw.orders)) {
      cache = raw;
      return cache;
    }
    // 文件存在且能解析，但结构不是预期的 { orders: [...] } —— 同样视为不可信
    throw new Error('内容结构不是预期的 { orders: [] }');
  } catch (e) {
    loadFailed = true;
    // 非「文件损坏」的异常（代码缺陷）额外打出堆栈，避免再被当成"文件坏了"误导排障
    if (e && e.corrupt) console.error('[payment-orders] 订单文件损坏，已降级为空列表并锁定写入：', e.message);
    else console.error('[payment-orders] 读取订单文件失败（非文件损坏，请检查代码），已锁定写入：', (e && e.stack) || e);
  }
  cache = { orders: [] };
  return cache;
}

/**
 * 落盘队列（R14-09：去抖合并写）。
 *
 * 唯一实现点是 `coalesce.debouncedPersist()` —— 本模块不再直接调用
 * `secureStore.writeJsonAsync`。快照取 `cache` 本身（内存里那份活对象），
 * 由 `coalesce` 在**真正落盘那一刻**才序列化：
 *  - `loadFailed` 必须在这里拦住 —— 内存里的 `{orders: []}` 一旦落盘，
 *    磁盘上那份（可能还能人工抢救的）订单文件就被整体覆盖成空表（FUN-01）；
 *  - `cache` 尚未加载时同样不写（`persist()` 只在变更之后被调用，正常路径
 *    上 `cache` 必定已有值；这里只是兜住「万一」）。
 */
const writer = coalesce.debouncedPersist(
  FILE,
  () => (loadFailed || !cache ? null : cache),
  { debounceMs: PAYMENT_WRITE_DEBOUNCE_MS, dataDir: DATA_DIR },
);

function persist() {
  if (loadFailed) return; // 读取失败过 → 绝不落盘，防覆盖
  writer.schedule();
}

/** 取消去抖并立即落盘（优雅停机走 `index.js`，测试用它驱动落盘断言） */
function flush() { writer.flush(); }

function newId() {
  return crypto.randomBytes(12).toString('base64url');
}

function masterKey() {
  return configStore.getMasterKey();
}

/* ============================ 生命周期 ============================ */

/**
 * 创建订单（pending）
 * @returns {object} 订单（内部形态）
 */
function create({ linkId, platform, amountFen, currency, payerIp, fileName, fileKey, tradeNo }) {
  const orders = load().orders;
  const now = new Date().toISOString();
  const o = {
    id: newId(),
    linkId: String(linkId),
    platform: String(platform || ''),
    amountFen: Number(amountFen) || 0,
    currency: currency || 'CNY',
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    paidAt: null,
    refundedAt: null, // 由管理员标记的退款时间（本系统不代持资金，无网关退款调用）
    downloadedAt: null, // 是否已下载（付费下载的核心对账字段）
    failReason: '',
    payerIp: String(payerIp || ''),
    // 文件快照：链接删除后仍能回答"付的是什么"
    fileName: String(fileName || ''),
    fileKey: String(fileKey || ''),
    // 网关侧的订单号（支付宝 trade_no / 微信 transaction_id / PayPal order id）
    tradeNo: String(tradeNo || ''),
  };
  orders.push(o);
  /**
   * R14-09：`prune()` 是**全表** filter + sort（`mine = all.filter(...)`），
   * 而它内部第一件事就是「该链接的订单数 ≤ 单链接上限就返回」。
   * 链接内订单数**必 ≤** 全表订单数，故 `orders.length > MAX_ORDERS_PER_LINK`
   * 这个 O(1) 判断可以安全地短路掉绝大多数 `create()` 上的全表扫描 ——
   * 裁剪结果完全等价（包括 `prune()` 末尾那条「上限被受保护订单占满」的告警：
   * 它只在 `mine.length > MAX_ORDERS_PER_LINK` 时才可能触发，那时总量必然也超限）。
   */
  if (orders.length > MAX_ORDERS_PER_LINK) prune(o.linkId);
  pruneGlobal(); // R8-25：跨链接的兜底上限（自身已带 O(1) 前置判断，超限才排序）
  persist();
  return o;
}

/**
 * 该订单是否**不可裁**（对账凭据，或仍在支付窗口内）。
 *
 * - `paid` / `refunded`：钱已经流动过，是对账凭据；
 * - 窗口内的 `pending`：付款者可能正在收银台，裁掉 = 钱付了拿不到文件（R14-03）；
 * - 其余（`failed`、超窗的 `pending`）按可再造的流水处理，允许裁剪。
 *
 * 年龄不可判定时按「在窗口内」保护 —— 宁可多留一条，不可裁掉在途付款。
 */
function isProtected(o, now) {
  if (o.status === 'paid' || o.status === 'refunded') return true;
  if (o.status !== 'pending') return false;
  const t = Date.parse(o.createdAt || '');
  if (!Number.isFinite(t)) return true;
  return now - t < PENDING_KEEP_MS;
}

/**
 * 裁剪动作必须留痕：以前它是静默的，订单丢了没人知道。
 */
function warnPruned(scope, n, extra) {
  try {
    statsStore.addLog({
      action: 'payment.prune', level: 'warn',
      detail: `订单裁剪：${scope} 丢弃 ${n} 条${extra ? `（${extra}）` : ''}`
        + ' —— 只有终态与超出支付窗口的 pending 可被裁，在途订单被裁会导致「钱付了拿不到文件」',
    });
  } catch (e) { /* 日志写不进去不应阻断业务 */ }
}

/**
 * 按链接裁剪：保留最近 MAX_ORDERS_PER_LINK 条，其余丢弃。
 *
 * 「永不裁剪」的集合包括已支付**与已退款**：两者都是钱已经流动过的记录，
 * 是对账凭据。若把退款订单裁掉，日后就无从证明「这笔钱退过」，
 * 只能看到收了一笔、对应文件还被免费下载了。
 *
 * 以及**仍在支付窗口内的 `pending`**（R14-03）—— 详见 {@link PENDING_KEEP_MS}。
 * 受保护的条目不计入上限配额，因此极端情况下（全是窗口内 pending）订单数会暂时超限：
 * 这是刻意的取舍，**宁可文件涨一会儿，不可裁掉一笔在途付款**。
 */
function prune(linkId) {
  const all = load().orders;
  const mine = all.filter((o) => o.linkId === linkId);
  if (mine.length <= MAX_ORDERS_PER_LINK) return;
  const now = Date.now();
  const frozen = new Set(mine.filter((o) => isProtected(o, now)).map((o) => o.id));
  const rest = mine
    .filter((o) => !frozen.has(o.id))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const keep = new Set(frozen);
  for (const o of rest.slice(0, Math.max(0, MAX_ORDERS_PER_LINK - frozen.size))) keep.add(o.id);
  const dropped = mine.length - [...keep].filter((id) => mine.some((o) => o.id === id)).length;
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].linkId === linkId && !keep.has(all[i].id)) all.splice(i, 1);
  }
  if (dropped > 0) warnPruned(`链接 ${linkId}`, dropped);
  else if (frozen.size >= MAX_ORDERS_PER_LINK) {
    // 上限被受保护订单占满 —— 多半是有人在灌单，必须可见（否则运维只会看到文件变大）
    warnPruned(`链接 ${linkId}`, 0, `上限 ${MAX_ORDERS_PER_LINK} 已被受保护订单占满，无法裁剪`);
  }
}

/**
 * R8-25：跨链接的全局裁剪，见 {@link MAX_ORDERS_TOTAL} 的说明。
 *
 * 剪裁口径与 {@link prune} **必须同源**（同一把尺子 `isProtected`）：
 * 只裁可再造的流水（`failed`、超出支付窗口的 `pending`）；
 * `paid` / `refunded` 与**窗口内的 `pending`** 永不裁（R14-03）。
 * 候选按 `createdAt` **从旧到新**，优先丢弃最久远的那批。
 *
 * @returns {number} 实际裁掉的条数
 */
function pruneGlobal() {
  const all = load().orders;
  if (all.length <= MAX_ORDERS_TOTAL) return 0;
  const drop = all.length - MAX_ORDERS_TOTAL;
  const now = Date.now();
  const candidates = all
    .filter((o) => !isProtected(o, now))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    .slice(0, drop);
  // 全是受保护状态 —— 宁可超限也不裁对账凭据与在途订单
  if (!candidates.length) return 0;
  const victims = new Set(candidates.map((o) => o.id));
  for (let i = all.length - 1; i >= 0; i--) {
    if (victims.has(all[i].id)) all.splice(i, 1);
  }
  warnPruned('全局', victims.size);
  return victims.size;
}

function get(id) {
  return load().orders.find((o) => o.id === id) || null;
}

/**
 * 按**网关侧**订单号查找（异步通知定位订单用）。
 * 微信 / PayPal 的通知里带的是网关订单号，不是我们的订单 id。
 */
function findByTradeNo(tradeNo) {
  const t = String(tradeNo || '');
  if (!t) return null;
  return load().orders.find((o) => o.tradeNo === t) || null;
}

/** 某链接的全部订单（按创建时间倒序） */
function listForLink(linkId) {
  return load().orders
    .filter((o) => o.linkId === String(linkId))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/** 某链接已支付订单数（供管理端展示收入概况） */
function paidCountForLink(linkId) {
  return listForLink(linkId).filter((o) => o.status === 'paid').length;
}

/* ============================ 状态流转 ============================ */

/**
 * 标记支付成功（终态；重复调用幂等）
 *
 * 「终态」的字面含义在这里被打破了一次：`refunded` 是比 `paid` 更靠后的终态。
 * 已退款的订单**不得被复活** —— 该订单确实付过钱，网关查单仍会回答"已支付"，
 * 若这里放行，一次异步通知就能把管理员刚退掉的订单重新变成有效凭证，
 * 下载者可以凭它继续下载（白嫖）。同理见 {@link markFailed}。
 */
function markPaid(id) {
  const o = get(id);
  if (!o) return null;
  if (o.status === 'paid' || o.status === 'refunded') return o;
  o.status = 'paid';
  o.paidAt = new Date().toISOString();
  o.failReason = '';
  o.updatedAt = o.paidAt;
  persist();
  return o;
}

/** 标记支付失败（可重新发起新订单，故不是终态语义上的"作废"） */
function markFailed(id, reason) {
  const o = get(id);
  if (!o) return null;
  if (o.status === 'paid' || o.status === 'refunded') return o; // 已支付 / 已退款的订单不允许被改判失败
  o.status = 'failed';
  o.failReason = String(reason || '支付未完成');
  o.updatedAt = new Date().toISOString();
  persist();
  return o;
}

/**
 * 标记为「已退款」（人工记账动作，终态）。
 *
 * 本项目**不代持资金**：网关侧的钱从未经过本系统，因此这里不存在真正的退款调用，
 * 只是在订单上记一笔"这笔钱已在别的渠道退还给下载者"。由此产生两个必然结论：
 *  ① 该订单的支付凭证立即失效 —— 否则退款后仍能凭旧票据下载，等于白嫖；
 *  ② 「已收」统计要把这笔扣掉 —— 钱已经退回去了，账面上就不该再算作收入。
 *
 * 只允许 `paid → refunded`：其余状态（支付中 / 失败 / 已退款）一律原样返回，
 * 由调用方（路由）负责把它翻译成 400。多次调用幂等。
 *
 * @returns {object|null} 订单不存在时返回 null
 */
function markRefunded(id) {
  const o = get(id);
  if (!o) return null;
  if (o.status !== 'paid') return o;
  o.status = 'refunded';
  o.refundedAt = new Date().toISOString();
  o.updatedAt = o.refundedAt;
  persist();
  return o;
}

/** 记录网关侧的订单号（查单 / 对账用） */
function setTradeNo(id, tradeNo) {
  const o = get(id);
  if (!o || !tradeNo) return null;
  o.tradeNo = String(tradeNo);
  o.updatedAt = new Date().toISOString();
  persist();
  return o;
}

/**
 * 标记「已下载」—— 幂等，只记首次。
 *
 * 在**放行下载之后**调用（而不是之前）：下载可能因网络中断而失败，
 * 提前标记会让"付了钱但没拿到文件"的订单在管理页显示成已下载，无法对账。
 */
function markDownloaded(id) {
  const o = get(id);
  if (!o) return null;
  if (o.downloadedAt) return o;
  o.downloadedAt = new Date().toISOString();
  o.updatedAt = o.downloadedAt;
  persist();
  return o;
}

/** 全部订单（管理端用，按创建时间倒序） */
function listAll() {
  return load().orders
    .slice()
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/* ============================ 已支付凭证（Cookie 票据） ============================ */

/**
 * 订单票据：`订单ID.HMAC`。
 * 签名输入同时包含 linkId 与 orderId —— 拿到 A 链接的票据无法用于 B 链接。
 */
function orderToken(order) {
  const body = `${order.linkId}:${order.id}`;
  const sig = crypto.createHmac('sha256', masterKey()).update('pay-order:' + body).digest('hex');
  return `${order.id}.${sig}`;
}

/**
 * 校验票据并取回订单
 * @returns {object|null} 票据无效 / 订单不存在 / 链接不匹配 时为 null
 */
function verifyToken(linkId, token) {
  if (typeof token !== 'string' || !token) return null;
  const i = token.indexOf('.');
  if (i <= 0) return null;
  const id = token.slice(0, i);
  const sig = token.slice(i + 1);
  const o = get(id);
  if (!o || o.linkId !== String(linkId)) return null;
  const expected = orderToken(o).slice(o.id.length + 1);
  if (sig.length !== expected.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch (e) {
    return null;
  }
  return o;
}

/**
 * 解析访问者的支付状态 —— 下载拦截的唯一判据
 *
 * `refunded` 与 `paid` **分开返回**：两者历史上都付过钱，但只有 `paid` 放行下载。
 * 若把 refunded 折叠进 pending/failed 里统称为"未支付"，退款者看到的提示会是
 * "请完成支付"——他明明付过，只是钱被退回去了，这是对账场景最需要区分的一类。
 *
 * @returns {{state: 'none'|'pending'|'paid'|'failed'|'refunded', order: object|null}}
 */
function payerState(linkId, token) {
  const o = verifyToken(linkId, token);
  if (!o) return { state: 'none', order: null };
  if (o.status === 'paid') return { state: 'paid', order: o };
  if (o.status === 'refunded') return { state: 'refunded', order: o };
  if (o.status === 'failed') return { state: 'failed', order: o };
  return { state: 'pending', order: o };
}

/** 安全视图（不含 IP 等内部字段） */
function view(o) {
  if (!o) return null;
  return {
    id: o.id,
    linkId: o.linkId,
    platform: o.platform,
    amountFen: o.amountFen,
    currency: o.currency,
    status: o.status,
    createdAt: o.createdAt,
    paidAt: o.paidAt || null,
    refundedAt: o.refundedAt || null,
    downloadedAt: o.downloadedAt || null,
    fileName: o.fileName || '',
    tradeNo: o.tradeNo || '',
    failReason: o.failReason || '',
  };
}

module.exports = {
  MAX_ORDERS_PER_LINK, MAX_ORDERS_TOTAL, PAYMENT_WRITE_DEBOUNCE_MS,
  create, get, findByTradeNo, listForLink, listAll, paidCountForLink,
  pruneGlobal, // R8-25：导出以供测试直接驱动跨链接裁剪
  flush, // R14-09：去抖落盘的强制刷写（优雅停机 / 测试）
  markPaid, markFailed, markRefunded, markDownloaded, setTradeNo,
  orderToken, verifyToken, payerState, view,
};
