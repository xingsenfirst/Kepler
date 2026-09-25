/**
 * 支付平台注册表与凭证校验引擎
 *
 * 职责边界：本模块**只做凭证的字段定义与合法性校验**，不涉及任何下单 / 退款 / 回调等支付业务。
 * 后续接入真实 SDK 时，只需在此登记自定义校验器（见 registerValidator）即可把「本地格式校验」
 * 升级为「联机校验」，上层路由与前端代码无需改动。
 *
 * 设计要点：
 *  1. **字段按平台各自官方命名**，不强行统一成同一个字段名 —— 支付宝是 app_id / private_key，
 *     微信支付是 mchid / appid / api_v3_key / serial_no，PayPal 是 client_id / client_secret。
 *     强行统一会让使用者无法对照官方控制台，是本模块最想避免的事。
 *  2. **校验逻辑集中在此**：pattern / validator 都写在注册表里，前端拿到的只是同一份规则的可序列化副本，
 *     服务端永远做最终校验（前端的即时提示仅供参考）。
 *  3. 敏感字段（secret）任何接口都不回传明文，仅返回「是否已配置」。
 */

/* ============================ 字段级校验器 ============================ */

/** 是否是 PEM 包裹的密钥 / 证书（允许头尾前后有空行与说明文字） */
function isPemLike(v, marker) {
  const s = String(v);
  const begin = new RegExp('-----BEGIN [A-Z ]*' + marker + '-----');
  const end = new RegExp('-----END [A-Z ]*' + marker + '-----');
  return begin.test(s) && end.test(s);
}

/** 是否是"裸" Base64 密钥体（未带 PEM 头的单行 / 多行 Base64） */
function isBase64Blob(v, minLen) {
  const body = String(v).replace(/[\s\r\n]/g, '');
  if (body.length < minLen) return false;
  return /^[A-Za-z0-9+/=_-]+$/.test(body);
}

/**
 * 字段级校验器表
 * 每个校验器返回 true 表示通过，返回字符串表示失败原因。
 */
const VALIDATORS = {
  /** 私钥：PEM（PKCS#1 / PKCS#8 / EC）或裸 Base64 密钥体 */
  privateKey(v) {
    if (isPemLike(v, 'PRIVATE KEY') || isPemLike(v, 'RSA PRIVATE KEY') || isPemLike(v, 'EC PRIVATE KEY')) return true;
    if (isBase64Blob(v, 200)) return true;
    return '不是有效的私钥：应为 PEM 格式（-----BEGIN PRIVATE KEY-----）或至少 200 字符的 Base64 密钥体';
  },
  /** 公钥：PEM（PUBLIC KEY / RSA PUBLIC KEY）或裸 Base64 密钥体 */
  publicKey(v) {
    if (isPemLike(v, 'PUBLIC KEY') || isPemLike(v, 'RSA PUBLIC KEY')) return true;
    if (isBase64Blob(v, 100)) return true;
    return '不是有效的公钥：应为 PEM 格式（-----BEGIN PUBLIC KEY-----）或至少 100 字符的 Base64 密钥体';
  },
  /** 网关 / 回调地址：必须为 https */
  httpsUrl(v) {
    let u;
    try {
      u = new URL(v);
    } catch (e) {
      return '不是合法的 URL 地址';
    }
    if (u.protocol !== 'https:') return '必须使用 https:// 协议';
    return true;
  },
};

/**
 * 平台级校验器登记处（**扩展点**）
 *
 * 现阶段为空 —— 只做本地格式校验。后续接入 SDK 后可登记例如：
 *
 *   registerValidator('alipay', async (values) => {
 *     const ok = await alipaySdk.checkCredentials(values);
 *     return ok ? [] : [{ field: 'appId', message: '应用 ID 与私钥不匹配' }];
 *   });
 *
 * @param {string} platformId
 * @param {(values: object) => Array<{field: string, message: string}>|Promise<...>} fn
 */
const CUSTOM_VALIDATORS = new Map();

function registerValidator(platformId, fn) {
  if (typeof fn !== 'function') throw new TypeError('校验器必须是函数');
  CUSTOM_VALIDATORS.set(platformId, fn);
}

/* ============================ 平台注册表 ============================ */

/**
 * 各支付平台的凭证字段定义
 * 字段说明：
 *   key         存储键（本系统内部用）
 *   official    该平台官方文档中的字段名（界面副标题展示，便于对照控制台）
 *   label       中文标签
 *   input       text | secret | textarea | select
 *   required    是否必填
 *   secret      是否敏感（true 时接口不回传明文，保存时留空 = 保持不变）
 *   pattern     正则字符串（前后端同一份）
 *   validator   VALIDATORS 中的自定义校验器名
 */
const PLATFORMS = {
  // ---------------------------------------------------------------- 支付宝
  alipay: {
    id: 'alipay',
    name: '支付宝',
    shortName: 'Alipay',
    doc: '支付宝开放平台 → 控制台 → 我的应用 → 应用信息 / 接口加签方式',
    fields: [
      {
        key: 'appId', official: 'app_id', label: '应用 ID', input: 'text', required: true,
        placeholder: '例如 2021004100000000',
        pattern: '^\\d{16,32}$', patternHint: '16 ~ 32 位纯数字', maxLength: 32,
        hint: '开放平台创建应用后生成的应用唯一标识（APPID）。',
      },
      {
        key: 'privateKey', official: 'private_key', label: '应用私钥', input: 'textarea', required: true, secret: true,
        placeholder: '-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----',
        validator: 'privateKey', maxLength: 8192,
        hint: 'RSA2 / SM2 应用私钥，用于请求签名。支持 PEM 或单行 Base64。',
      },
      {
        key: 'alipayPublicKey', official: 'alipay_public_key', label: '支付宝公钥', input: 'textarea', required: true, secret: true,
        placeholder: '-----BEGIN PUBLIC KEY-----\n…\n-----END PUBLIC KEY-----',
        validator: 'publicKey', maxLength: 8192,
        hint: '用于验签支付宝的响应与异步通知（回调），勿与应用公钥混淆。',
      },
      {
        key: 'signType', official: 'sign_type', label: '签名算法', input: 'select', required: true, default: 'RSA2',
        options: [
          { value: 'RSA2', label: 'RSA2（SHA256，推荐）' },
          { value: 'RSA', label: 'RSA（SHA1，旧版）' },
          { value: 'SM2', label: 'SM2（国密）' },
        ],
        hint: '需与开放平台上该应用配置的加签方式一致。',
      },
      {
        key: 'gateway', official: 'gateway', label: '网关地址', input: 'text', required: false,
        default: 'https://openapi.alipay.com/gateway.do',
        validator: 'httpsUrl', maxLength: 256,
        placeholder: 'https://openapi.alipay.com/gateway.do',
        hint: '沙箱环境请换成 https://openapi-sandbox.dl.alipaydev.com/gateway.do',
      },
      {
        key: 'appCertSn', official: 'app_cert_sn', label: '应用公钥证书序列号', input: 'text', required: false,
        pattern: '^[0-9A-Fa-f]{32,64}$', patternHint: '32 ~ 64 位十六进制字符', maxLength: 64,
        placeholder: '证书模式：例如 6a9f1c...(32 位)',
        hint: '仅「公钥证书」加签模式需要；普通公钥模式可留空。',
      },
      {
        key: 'rootCertSn', official: 'alipay_root_cert_sn', label: '支付宝根证书序列号', input: 'text', required: false,
        pattern: '^[0-9A-Fa-f_]{32,80}$', patternHint: '32 位十六进制，多段以 _ 连接', maxLength: 80,
        placeholder: '证书模式：例如 687b5919..._02941eef...',
        hint: '仅「公钥证书」加签模式需要；普通公钥模式可留空。',
      },
    ],
  },

  // ---------------------------------------------------------------- 微信支付
  wechat: {
    id: 'wechat',
    name: '微信支付',
    shortName: 'WeChat Pay',
    doc: '微信支付商户平台 → 账户中心 → API 安全（API v3 密钥 / 商户 API 证书）',
    fields: [
      {
        key: 'mchId', official: 'mchid', label: '商户号', input: 'text', required: true,
        placeholder: '例如 1900000109',
        pattern: '^\\d{10}$', patternHint: '10 位纯数字', maxLength: 10,
        hint: '微信支付分配的商户号（mchid），10 位数字。',
      },
      {
        key: 'appId', official: 'appid', label: '应用 ID', input: 'text', required: true,
        placeholder: '例如 wx1234567890abcdef',
        pattern: '^wx[0-9a-zA-Z]{16}$', patternHint: 'wx 前缀 + 16 位字母数字，共 18 位', maxLength: 18,
        hint: '公众号 / 小程序 / 移动应用的 appid，需已绑定至该商户号。',
      },
      {
        key: 'apiV3Key', official: 'api_v3_key', label: 'APIv3 密钥', input: 'secret', required: true, secret: true,
        placeholder: '32 位字母数字',
        pattern: '^[A-Za-z0-9]{32}$', patternHint: '32 位字母数字', maxLength: 32,
        hint: '商户平台「API 安全」中自行设置的 32 位密钥，用于解密平台回调内容。',
      },
      {
        key: 'certSerialNo', official: 'serial_no', label: '商户证书序列号', input: 'text', required: true,
        placeholder: '例如 1A2B3C4D5E6F7A8B9C0D1E2F3A4B5C6D7E8F9A0B',
        pattern: '^[0-9A-Fa-f]{40}$', patternHint: '40 位十六进制字符', maxLength: 40,
        hint: '商户 API 证书的序列号，与下方私钥成对使用。',
      },
      {
        key: 'privateKey', official: 'private_key', label: '商户 API 私钥', input: 'textarea', required: true, secret: true,
        placeholder: '-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----',
        validator: 'privateKey', maxLength: 8192,
        hint: 'apiclient_key.pem 的内容（PKCS#8 PEM）。证书与私钥由商户平台下载。',
      },
      {
        key: 'subMchId', official: 'sub_mchid', label: '子商户号', input: 'text', required: false,
        placeholder: '服务商模式填写',
        pattern: '^\\d{10}$', patternHint: '10 位纯数字', maxLength: 10,
        hint: '仅服务商 / 渠道商模式需要，直连商户可留空。',
      },
      {
        key: 'subAppId', official: 'sub_appid', label: '子应用 ID', input: 'text', required: false,
        placeholder: '服务商模式填写',
        pattern: '^wx[0-9a-zA-Z]{16}$', patternHint: 'wx 前缀 + 16 位字母数字', maxLength: 18,
        hint: '仅服务商模式下子商户的应用 ID，直连商户可留空。',
      },
    ],
  },

  // ---------------------------------------------------------------- PayPal
  paypal: {
    id: 'paypal',
    name: 'PayPal',
    shortName: 'PayPal',
    doc: 'PayPal Developer Dashboard → Apps & Credentials → 对应 App 的 API credentials',
    fields: [
      {
        key: 'clientId', official: 'client_id', label: 'Client ID', input: 'text', required: true,
        placeholder: '约 80 位，由 PayPal 开发者后台生成',
        pattern: '^[A-Za-z0-9_-]{20,128}$', patternHint: '20 ~ 128 位，可含字母数字与 - _', maxLength: 128,
        hint: 'REST API 的客户端标识，与 Secret 成对生成。',
      },
      {
        key: 'clientSecret', official: 'client_secret', label: 'Client Secret', input: 'secret', required: true, secret: true,
        placeholder: '留空表示保持现有值不变',
        pattern: '^[A-Za-z0-9_-]{20,128}$', patternHint: '20 ~ 128 位，可含字母数字与 - _', maxLength: 128,
        hint: '用于换取访问令牌（access token），请勿泄露。',
      },
      {
        key: 'mode', official: 'mode', label: '运行环境', input: 'select', required: true, default: 'sandbox',
        options: [
          { value: 'sandbox', label: 'sandbox（沙箱）' },
          { value: 'live', label: 'live（生产）' },
        ],
        hint: '沙箱与生产的凭证不通用，切换环境需同步更换 Client ID / Secret。',
      },
      {
        key: 'merchantId', official: 'merchant_id', label: '商家账号 ID', input: 'text', required: false,
        placeholder: '例如 ABCD1234EFGHI',
        pattern: '^[A-Za-z0-9]{13}$', patternHint: '13 位字母数字（Payer ID）', maxLength: 13,
        hint: '收款方 PayPal 账号的 Payer ID，部分接口（如订单收款方指定）需要。',
      },
      {
        key: 'webhookId', official: 'webhook_id', label: 'Webhook ID', input: 'text', required: false,
        placeholder: '例如 0EH40505U7162512P',
        pattern: '^[0-9A-Za-z-]{6,64}$', patternHint: '6 ~ 64 位字母数字，可含 -', maxLength: 64,
        hint: '用于校验 PayPal 事件通知的签名，未启用 Webhook 可留空。',
      },
    ],
  },
};

/** 界面展示顺序 */
const ORDER = ['alipay', 'wechat', 'paypal'];

/* ============================ 查询接口 ============================ */

/** 取平台定义（未知 id 返回 null） */
function platform(id) {
  return Object.prototype.hasOwnProperty.call(PLATFORMS, id) ? PLATFORMS[id] : null;
}

/** 平台列表（按界面顺序） */
function list() {
  return ORDER.map((id) => PLATFORMS[id]);
}

/** 是否已知平台 id */
function isKnown(id) {
  return Boolean(platform(id));
}

/** 取某平台某字段定义 */
function field(platformId, key) {
  const p = platform(platformId);
  if (!p) return null;
  return p.fields.find((f) => f.key === key) || null;
}

/**
 * 可序列化的平台定义（下发前端用于渲染表单）
 * 与服务端用的是同一份数据，pattern 因此天然同步；前端做即时提示，服务端做最终裁定。
 */
function clientSchema() {
  return list().map((p) => ({
    id: p.id,
    name: p.name,
    shortName: p.shortName,
    doc: p.doc,
    fields: p.fields.map((f) => ({
      key: f.key,
      official: f.official,
      label: f.label,
      input: f.input,
      required: !!f.required,
      secret: !!f.secret,
      placeholder: f.placeholder || '',
      hint: f.hint || '',
      pattern: f.pattern || '',
      patternHint: f.patternHint || '',
      maxLength: f.maxLength || 0,
      default: f.default === undefined ? '' : f.default,
      options: f.options ? f.options.slice() : null,
    })),
  }));
}

/* ============================ 校验 ============================ */

/** 把任意输入规整为待校验的字符串（null/undefined → ''，其余转字符串并去首尾空白） */
function asValue(raw) {
  if (raw === null || raw === undefined) return '';
  return typeof raw === 'string' ? raw.trim() : String(raw).trim();
}

/**
 * 校验某一平台的凭证
 * @param {string} platformId
 * @param {object} values 字段键值
 * @returns {{ok: boolean, errors: Array<{field: string, message: string}>, normalized: object}}
 */
function validate(platformId, values) {
  const p = platform(platformId);
  if (!p) {
    return { ok: false, errors: [{ field: 'platform', message: `未知的支付平台：${platformId}` }], normalized: {} };
  }
  const src = values && typeof values === 'object' ? values : {};
  const errors = [];
  const normalized = {};

  for (const f of p.fields) {
    const v = asValue(src[f.key]);

    // 必填
    if (!v) {
      if (f.required) errors.push({ field: f.key, message: `${f.label}为必填项` });
      continue;
    }
    // 长度上限
    if (f.maxLength && v.length > f.maxLength) {
      errors.push({ field: f.key, message: `${f.label}长度不能超过 ${f.maxLength} 个字符（当前 ${v.length}）` });
      continue;
    }
    // 枚举
    if (f.options && !f.options.some((o) => o.value === v)) {
      errors.push({
        field: f.key,
        message: `${f.label}只能是：${f.options.map((o) => o.value).join(' / ')}`,
      });
      continue;
    }
    // 正则
    if (f.pattern && !new RegExp(f.pattern).test(v)) {
      errors.push({
        field: f.key,
        message: f.patternHint ? `${f.label}格式不正确，应为${f.patternHint}` : `${f.label}格式不正确`,
      });
      continue;
    }
    // 自定义校验器
    if (f.validator) {
      const fn = VALIDATORS[f.validator];
      if (fn) {
        const r = fn(v);
        if (r !== true) {
          errors.push({ field: f.key, message: r || `${f.label}未通过校验` });
          continue;
        }
      }
    }
    normalized[f.key] = v;
  }

  // 平台级自定义校验（扩展点，现阶段无登记即为纯本地格式校验）
  const custom = CUSTOM_VALIDATORS.get(platformId);
  if (custom) {
    const r = custom(normalized);
    if (Array.isArray(r) && r.length) {
      for (const e of r) {
        if (e && e.message) errors.push({ field: String(e.field || ''), message: String(e.message) });
      }
    }
  }

  return { ok: errors.length === 0, errors, normalized };
}

/* ============================ 敏感字段处理 ============================ */

/**
 * 掩码：仅用于界面提示是否"看起来像已配置"，任何情况下都不回传完整明文。
 * PEM 类密钥头尾固定，中间打码并标注字符数。
 */
function maskSecret(v) {
  const s = String(v == null ? '' : v);
  if (!s) return '';
  if (isPemLike(s, 'PRIVATE KEY') || isPemLike(s, 'RSA PRIVATE KEY') || isPemLike(s, 'EC PRIVATE KEY')
    || isPemLike(s, 'PUBLIC KEY') || isPemLike(s, 'RSA PUBLIC KEY')) {
    const first = s.trim().split(/\r?\n/)[0];
    return `${first} … 已配置（共 ${s.length} 字符）`;
  }
  if (s.length <= 8) return '*'.repeat(s.length);
  return `${s.slice(0, 4)}${'*'.repeat(Math.min(12, s.length - 8))}${s.slice(-4)}`;
}

/**
 * 生成下发给前端的视图：非敏感字段给值，敏感字段只给"是否已配置"
 * @returns {{values: object, configured: object}}
 */
function publicView(platformId, stored) {
  const p = platform(platformId);
  const values = {};
  const configured = {};
  if (!p) return { values, configured };
  const s = stored && typeof stored === 'object' ? stored : {};
  for (const f of p.fields) {
    const v = asValue(s[f.key]);
    if (f.secret) {
      values[f.key] = '';
      configured[f.key] = Boolean(v);
    } else {
      values[f.key] = v;
      configured[f.key] = Boolean(v);
    }
  }
  return { values, configured };
}

/**
 * 合并保存：把前端提交的补丁应用到已有配置上
 *  - 敏感字段留空 / undefined → 保持原值（避免界面保存时误清空密钥）
 *  - 显式传 null 或空字符串的非敏感字段 → 清空
 *  - 未知字段一律丢弃（防止写入注册表之外的键）
 * @returns {object} 合并后的完整配置对象
 */
function applySave(platformId, prev, patch) {
  const p = platform(platformId);
  if (!p) return {};
  const old = prev && typeof prev === 'object' ? prev : {};
  const src = patch && typeof patch === 'object' ? patch : {};
  const merged = {};
  for (const f of p.fields) {
    const has = Object.prototype.hasOwnProperty.call(src, f.key);
    if (!has) {
      // 未提交：敏感字段保持原值，其余也保持原值（补丁语义）
      const keep = asValue(old[f.key]);
      if (keep) merged[f.key] = keep;
      continue;
    }
    const v = asValue(src[f.key]);
    if (!v) {
      // 提交了空值：敏感字段视为"保持不变"，非敏感字段视为"清空"
      if (f.secret) {
        const keep = asValue(old[f.key]);
        if (keep) merged[f.key] = keep;
      }
      continue;
    }
    merged[f.key] = v;
  }
  return merged;
}

/** 必填字段是否都已填写（用于判断某平台是否已完整配置） */
function isConfigured(platformId, stored) {
  const p = platform(platformId);
  if (!p) return false;
  const s = stored && typeof stored === 'object' ? stored : {};
  return p.fields.filter((f) => f.required).every((f) => Boolean(asValue(s[f.key])));
}

/** 按平台取默认值（新建表单时预填） */
function defaults(platformId) {
  const p = platform(platformId);
  if (!p) return {};
  const d = {};
  for (const f of p.fields) if (f.default !== undefined) d[f.key] = f.default;
  return d;
}

module.exports = {
  VALIDATORS,
  registerValidator,
  PLATFORMS,
  ORDER,
  platform,
  list,
  isKnown,
  field,
  clientSchema,
  validate,
  maskSecret,
  publicView,
  applySave,
  isConfigured,
  defaults,
};
