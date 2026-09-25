/**
 * 支付业务规则 —— 金额、渠道开关约束、付费是否生效
 *
 * 全部为**纯函数**（不读盘、不依赖请求上下文），因为这些都是状态机里最容易出错、
 * 又最值得被行为测试覆盖的判定。任何一处判定改动都必须能在 `tests/payment.test.js`
 * 里直接驱动，而不是靠起服务、点界面去验证。
 *
 * 三个核心概念（务必区分，混用会让状态联动写出 bug）：
 *   enabled     —— 渠道开关是否打开（用户的显式意图）
 *   configured  —— 该渠道凭证是否已完整填写（能不能真的收钱）
 *   available   —— enabled && configured（下载页能不能选它）
 */

/** 现阶段仅支持人民币 */
const CURRENCY = 'CNY';

/** 最低 0.01 元（1 分）；金额一律以「分」为整数存储，杜绝浮点误差 */
const MIN_AMOUNT_FEN = 1;
/** 上限 100000 元，防止误填天价金额 */
const MAX_AMOUNT_FEN = 10000000;

/* ============================ 金额 ============================ */

/**
 * 规范化金额：任意输入 → 以「分」为单位的整数
 * @returns {{ok: boolean, fen: number, message: string}}
 */
function normalizeAmount(v) {
  if (v === null || v === undefined || v === '') {
    return { ok: false, fen: 0, message: '请填写付费金额' };
  }
  const n = Number(v);
  if (!Number.isFinite(n)) return { ok: false, fen: 0, message: '付费金额必须是数字' };
  if (n < 0) return { ok: false, fen: 0, message: '付费金额不能为负数' };
  // 先按元四舍五入到分，再转整数分 —— 避免 0.1+0.2 这类二进制浮点误差
  const fen = Math.round(n * 100);
  if (fen < MIN_AMOUNT_FEN) {
    return { ok: false, fen: 0, message: `付费金额最低 ${formatAmount(MIN_AMOUNT_FEN)} 元` };
  }
  if (fen > MAX_AMOUNT_FEN) {
    return { ok: false, fen: 0, message: `付费金额不能超过 ${formatAmount(MAX_AMOUNT_FEN)} 元` };
  }
  return { ok: true, fen, message: '' };
}

/** 分 → 元（展示用，注意仅用于显示，不参与计算与存储） */
function fenToYuan(fen) {
  return (Number(fen) || 0) / 100;
}

/** 格式化为固定两位小数的字符串（展示用） */
function formatAmount(fen) {
  return fenToYuan(fen).toFixed(2);
}

/* ============================ 渠道开关 ============================ */

/**
 * 取各渠道开关状态。未记录的平台视为关闭。
 * @param {object} platformsCfg config.payment.platforms
 * @param {string[]} platformIds 注册表里的全部平台 id
 */
function channelStates(platformsCfg, platformIds) {
  const src = platformsCfg && typeof platformsCfg === 'object' ? platformsCfg : {};
  const out = {};
  for (const id of platformIds || []) {
    const p = src[id];
    // 只有既"有记录"又"显式开启了"才算开；历史数据没有 enabled 字段时按关闭处理
    out[id] = Boolean(p && p.enabled === true);
  }
  return out;
}

/**
 * 校验「渠道开关的某次变更」是否合法。
 *
 * 约束（对应需求二）：支付功能处于**启用**状态时，至少必须保留一个渠道开启。
 * 注意判定的是 `enabled`（开关），不是 `available`（能否真收钱）——
 * 渠道开着但凭证没填完是"待补全"，属于可接受的中间态，不该被当成违规拦下来。
 *
 * @param {object} currentStates 当前各渠道开关
 * @param {string} platformId    要变更的平台
 * @param {boolean} nextEnabled  变更后的值
 * @param {boolean} globalEnabled 支付功能总开关
 * @returns {{ok: boolean, message: string}}
 */
function checkChannelToggle(currentStates, platformId, nextEnabled, globalEnabled) {
  const states = Object.assign({}, currentStates);
  states[platformId] = !!nextEnabled;
  const anyOn = Object.values(states).some(Boolean);
  if (globalEnabled && !anyOn) {
    return { ok: false, message: '支付功能已启用，至少需要保留一个支付渠道；如需全部关闭，请先停用支付功能' };
  }
  return { ok: true, message: '' };
}

/**
 * 校验「打开支付功能总开关」是否合法。
 * 没有任何渠道开启时不允许启用 —— 否则会得到一个"开了但没人能付"的无效状态。
 */
function checkGlobalToggle(nextEnabled, currentStates) {
  if (!nextEnabled) return { ok: true, message: '' }; // 停用永远允许
  const anyOn = Object.values(currentStates || {}).some(Boolean);
  if (!anyOn) return { ok: false, message: '请先启用至少一个支付渠道，再开启支付功能' };
  return { ok: true, message: '' };
}

/* ============================ 付费是否生效 ============================ */

/**
 * 判定某条分享链接「当前是否真的需要付费」。
 *
 * 这是全局开关与链接配置之间的**唯一联动点**（对应需求四）：
 * 链接上的 `paid` 只表达分享者的意图，永远原样保留；
 * 真正生效与否由本函数在**读取时**计算，因此停用支付后重新启用，
 * 原付费配置会自然恢复，不需要任何数据迁移或清理动作。
 *
 * @param {object} ctx
 *   globalEnabled  支付功能总开关
 *   channelStates  各渠道开关 { [id]: boolean }
 *   configuredMap  各渠道凭证是否完整 { [id]: boolean }
 *   linkPaid       链接上的付费配置 { required, amountFen }
 * @returns {{required: boolean, effective: boolean, amountFen: number, currency: string, reason: string}}
 *   reason: '' | 'not-required' | 'payment-disabled' | 'no-channel'
 */
function resolvePaidState({ globalEnabled, channelStates: states, configuredMap, linkPaid }) {
  const paid = linkPaid && typeof linkPaid === 'object' ? linkPaid : {};
  const required = Boolean(paid.required);
  const amountFen = Number(paid.amountFen) || 0;
  const base = { required, effective: false, amountFen, currency: CURRENCY, reason: 'not-required' };
  if (!required) return base;

  if (!globalEnabled) return Object.assign(base, { reason: 'payment-disabled' });

  const on = Object.keys(states || {}).filter((id) => states[id]);
  const available = on.filter((id) => configuredMap && configuredMap[id]);
  if (!available.length) return Object.assign(base, { reason: 'no-channel' });

  return { required: true, effective: true, amountFen, currency: CURRENCY, reason: '' };
}

/** 当前可选的支付渠道（开关已开且凭证完整） */
function availableChannels(states, configuredMap) {
  return Object.keys(states || {}).filter((id) => states[id] && configuredMap && configuredMap[id]);
}

/**
 * 一次性算出「开关 / 凭证完整 / 可用渠道」三张表。
 * 供支付路由与分享链接路由共用，避免两处各写一遍导致口径漂移。
 *
 * @param {object} platformsCfg config.payment.platforms
 * @param {string[]} platformIds 注册表里的全部平台 id
 * @param {(id: string) => boolean} isConfigured 凭证是否完整
 */
function snapshot(platformsCfg, platformIds, isConfigured) {
  const states = channelStates(platformsCfg, platformIds);
  const configuredMap = {};
  for (const id of platformIds || []) configuredMap[id] = Boolean(isConfigured && isConfigured(id));
  return { states, configuredMap, available: availableChannels(states, configuredMap) };
}

/** 未生效的人类可读说明（下载页提示用） */
const REASON_TEXT = {
  'not-required': '',
  'payment-disabled': '分享者已停用支付功能，该文件当前可免费下载。',
  'no-channel': '分享者尚未配置可用的支付渠道，暂时无法完成支付，请联系分享者。',
};

module.exports = {
  CURRENCY, MIN_AMOUNT_FEN, MAX_AMOUNT_FEN,
  normalizeAmount, fenToYuan, formatAmount,
  channelStates, checkChannelToggle, checkGlobalToggle,
  resolvePaidState, availableChannels, snapshot, REASON_TEXT,
};
