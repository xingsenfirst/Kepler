/**
 * R38：配置备份 —— 「备份配置」卡片那串长代码的**唯一实现点**。
 *
 * ## 一、备份范围（需求逐项对应，且**必须**与需求同序）
 *
 * 用户可见的是 8 项，真正落进 `data` 的是 7 处 —— 「负载均衡」不是独立的一份数据：
 * 它展示与编辑的是**每个 API Key 的空间上限**（`credentials[].quotaBytes`），
 * 与「API Key 管理」在 `config.enc` 里本就是**同一条记录**。刻意不另存一份，
 * 否则「同一条记录的同一个字段」会有两个来源，导入时谁覆盖谁全凭顺序。
 *
 * ## 二、刻意**不在**备份范围内的东西（每一项都有明确理由，别顺手加回来）
 *
 *  - **用户列表**（`cfg.users`）：需求明确「所有用户均不在备份范围内（包括管理员）」。
 *    另外它本身也不该被备份 —— 账户与其口令哈希属于**这台实例**的身份，跨实例搬运
 *    等于把「谁能登录」一起搬走；而「重装系统后恢复管理员」应该走安装流程重新建号。
 *  - **分享链接**（`data/links.json`）与**支付订单**（`data/payments.json`）：运行时数据，
 *    且体量不确定。全量备份要经 `PUT`/`POST` 的 JSON 请求体，而 `express.json` 默认
 *    上限是 **2MB** —— 链接与订单一旦多起来，备份请求会先被 413 拒掉，
 *    表现为「备份莫名其妙失败」，比不备份更糟。
 *  - **加密密钥文件**（`data/secret.key` / `enc.key` / `enc-settings.json` / `enc-meta.json`）：
 *    **无法备份，也绝不能备份**。`secret.key` 是配置主密钥，把它随备份一起流传出去，
 *    等于把整份配置的密文一起交出去；`enc.key` + `enc-meta.json` 能解开云端**全部**
 *    已加密文件。它们必须靠离线介质单独保管。这也是为什么备份里**没有**「文件加密选项」——
 *    还原了加密开关却没有 `enc.key`，只会让系统以为文件是加密的、实际一份也解不开。
 *  - **自定义请求域名**（`cfg.domains`）：不在需求列出的 8 项之内，故不含
 *    （它是「分享链接优先用哪个域名」的展示偏好，与「本站叫什么」是两件事；
 *    后者看部署环境变量 `SITE_DOMAIN`，见 `server/security.js`）。
 *
 * ## 三、两种码，两种用途
 *
 *  - **实时码**（`buildCode()`）：由**当前配置**直接推导，因此「改了设置它自己就变」。
 *    明文、可读、管理员专属，页面上一直显示它，方便肉眼核对与随手复制。
 *  - **导出码**（`seal()`）：用**用户自己设的备份密码**（与账户口令完全无关）加密后的码。
 *    只有它能跨实例搬运 —— 因为实时码里的 WebDAV 账户口令是明文，
 *    且它不含完整性保护，谁都能改一个字节再让服务端吃进去。
 *
 * ⚠️ 实时码里含 API Key / 支付凭证 / WebDAV 口令**明文**（它们本就在 `config.enc`
 * 的明文里，只是被整文件加密）。因此：该页面只对管理员开放，实时码不得出现在日志、
 * 审计记录或任何下行给普通用户的响应里。
 */
const crypto = require('crypto');
const configStore = require('./config-store');
const ipGuard = require('./ip-guard');

/** 明文实时码的抬头（便于肉眼识别与版本演进） */
const CODE_HEAD = 'KEPLER-CONFIG-V1';
/** 加密导出码的抬头 */
const SEAL_HEAD = 'KEPLER-CONFIG-SEALED-V1';
const FORMAT_VERSION = 1;

/** scrypt 参数：与账户口令体系**完全独立**，只用于保护这一段密文 */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const SALT_BYTES = 16;
const IV_BYTES = 12;
/** 备份密码长度约束（与 WebDAV 账户口令同一上限，避免同一套界面两种口径） */
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;

/**
 * 用户可见的 8 个备份项 → 它们真正的存储位置（7 处）。
 * 「负载均衡」与「API Key 管理」同指 `credentials`（见文件头第一节）。
 */
const SCOPES = [
  { label: 'API Key 管理', section: 'credentials' },
  { label: '负载均衡', section: 'credentials' },
  { label: '上传排除', section: 'uploadExcludes' },
  { label: '登陆验证', section: 'captcha' },
  { label: 'WebDAV 服务', section: 'webdav' },
  { label: '支付设置', section: 'payment' },
  { label: '存储桶管理', section: 'buckets' },
  { label: 'IP 地址管理', section: 'ipguard' },
];

/** 实际写进 `data` 的分区（去重后 7 条） */
const SECTIONS = [...new Set(SCOPES.map((s) => s.section))];

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (str) => Buffer.from(String(str), 'base64url');

/* ============================ 采集 / 还原 ============================ */

/** 深拷一层（备份载荷与运行期配置之间不留共享引用） */
function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function numOr0(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * 逐字段重建一份「干净」的密钥记录。
 *
 * 为什么不直接 `clone(cfg.credentials)`：`config.enc` 里的记录是**历史累积**的，
 * 可能带着早已废弃的字段（例如 R25 之前没有 `quotaBytes`）或新版本试验期的临时键。
 * 备份是要跨版本搬运的，只带**当前已知的字段**，还原时由 `normalize()` 补默认值 ——
 * 这样「旧版本导出的备份」到「新版本导入」才是一条可预期的路径。
 */
function sanitizeCredential(c) {
  return {
    id: String((c && c.id) || ''),
    provider: String((c && c.provider) || ''),
    secretId: String((c && c.secretId) || ''),
    secretKey: String((c && c.secretKey) || ''),
    remark: String((c && c.remark) || ''),
    endpoint: String((c && c.endpoint) || ''),
    quotaBytes: numOr0(c && c.quotaBytes),
    speedLimit: numOr0(c && c.speedLimit),
    visibleToUsers: !(c && c.visibleToUsers === false),
    enabled: !(c && c.enabled === false),
    createdAt: String((c && c.createdAt) || ''),
  };
}

function sanitizeBucket(b) {
  return {
    id: String((b && b.id) || ''),
    provider: String((b && b.provider) || ''),
    bucket: String((b && b.bucket) || ''),
    region: String((b && b.region) || ''),
    remark: String((b && b.remark) || ''),
    endpoint: String((b && b.endpoint) || ''),
    quotaBytes: numOr0(b && b.quotaBytes),
    speedLimit: numOr0(b && b.speedLimit),
    credentialId: String((b && b.credentialId) || ''),
    visibleToUsers: !(b && b.visibleToUsers === false),
    enabled: !(b && b.enabled === false),
    blockOverseasIP: (b && b.blockOverseasIP === true),
    createdAt: String((b && b.createdAt) || ''),
  };
}

function boolOf(v) { return v === true; }

/**
 * 取「两套验证码凭证」的归一化副本（R41）。
 *
 * 导出与导入都走这里，保证备份载荷里 `captcha.providers` 的结构与
 * `config-store` 侧完全一致（唯一实现点：归一化交给 `configStore.captchaProvidersOf`，
 * 这里绝不自己重写一遍合并规则）。旧载荷只有扁平 `siteKey`/`secretKey` 时，
 * 归一化会把它们落进 `provider` 指向的那一套，因此历史备份照样能导入。
 */
function captchaProviders(cap) {
  return configStore.captchaProvidersOf(cap || {});
}

/**
 * 采集当前配置 → 备份载荷的 `data` 部分。
 *
 * ⚠️ WebDAV 账户口令在此**取明文**（`revealWebdavPassword`）。落盘的 `passwordSealed`
 * 是用**本实例**的配置主密钥封的，跨实例原样搬运只会得到一段解不开的密文 ——
 * 表现为「导入成功、WebDAV 却登录不上」。故导出取明文、导入用目标实例的主密钥重封。
 */
function collect() {
  const cfg = configStore.load() || {};
  const creds = Array.isArray(cfg.credentials) ? cfg.credentials : [];
  const buckets = Array.isArray(cfg.buckets) ? cfg.buckets : [];
  const ue = cfg.uploadExcludes || {};
  const cap = cfg.captcha || {};
  const pay = cfg.payment || {};
  const wd = cfg.webdav || {};

  const webdavAccounts = (Array.isArray(wd.accounts) ? wd.accounts : []).map((a) => {
    // 走 config-store 的既有出口（唯一实现点），绝不在这里自己解密码
    const full = configStore.revealWebdavPassword(a.id) || {};
    return {
      appName: String(full.appName || ''),
      username: String(full.username || ''),
      password: String(full.password || ''),
    };
  });

  return {
    credentials: {
      credentials: creds.map(sanitizeCredential),
      activeCredentialId: String(cfg.activeCredentialId || ''),
    },
    uploadExcludes: {
      dsStore: boolOf(ue.dsStore),
      thumbsDb: boolOf(ue.thumbsDb),
      gitignore: boolOf(ue.gitignore),
    },
    captcha: {
      enabled: boolOf(cap.enabled),
      provider: String(cap.provider || 'recaptcha'),
      // R41：两套凭证都随备份走（各自独立保存，切服务商时不必重填）
      providers: captchaProviders(cap),
      timeoutMs: Number.isFinite(Number(cap.timeoutMs)) ? Number(cap.timeoutMs) : 5000,
      onError: String(cap.onError || 'block'),
    },
    webdav: { enabled: boolOf(wd.enabled), accounts: webdavAccounts },
    payment: {
      enabled: boolOf(pay.enabled),
      platforms: clone(pay.platforms || {}),
      siteUrl: String(pay.siteUrl || ''),
    },
    buckets: {
      buckets: buckets.map(sanitizeBucket),
      activeBucketId: String(cfg.activeBucketId || ''),
    },
    ipguard: {
      rules: clone(ipGuard.listRules() || []), // listRules 已剥掉派生缓存 `_parsed`
    },
  };
}

/**
 * 「这台实例是否全新」—— 导入开关的**唯一判据**。
 *
 * 需求：「仅在项目首次启动并创建用户后，才允许在此导入配置」。判据刻意取
 * **「备份范围内的每一项都还是默认值」**，而不是某个一次性标记：
 *  - 标记要在导入后重置、要在配置损坏时兜底，任何一环漏掉就是「第二次导入把线上配置全冲掉」；
 *  - 而「还没配过任何东西」是一个**可从当前状态直接算出**的事实，不需要维护。
 *
 * 注意它**不检查用户表** —— 全新实例上已经有第一个管理员（否则你也打不开这个页面），
 * 这正是需求说的「首次启动并创建用户后」那个窗口。
 */
function isEmptyData(data) {
  const c = data.credentials || {};
  if ((c.credentials || []).length) return false;
  if (String(c.activeCredentialId || '')) return false;
  const ue = data.uploadExcludes || {};
  if (ue.dsStore || ue.thumbsDb || ue.gitignore) return false;
  const cap = data.captcha || {};
  if (cap.enabled) return false;
  // R41：两套凭证里任一套填过即算「已配置」；旧载荷的扁平键同样算数
  const capProvs = (cap.providers && typeof cap.providers === 'object') ? cap.providers : {};
  for (const name of Object.keys(capProvs)) {
    const e = capProvs[name] || {};
    if (e.siteKey || e.secretKey) return false;
  }
  if (cap.siteKey || cap.secretKey) return false;
  const w = data.webdav || {};
  if (w.enabled || (w.accounts || []).length) return false;
  const p = data.payment || {};
  if (p.enabled || p.siteUrl) return false;
  if (Object.keys(p.platforms || {}).length) return false;
  const b = data.buckets || {};
  if ((b.buckets || []).length) return false;
  if (String(b.activeBucketId || '')) return false;
  if (((data.ipguard || {}).rules || []).length) return false;
  return true;
}

/** 当前实例是否还处于「可导入」窗口 */
function canImport() {
  return isEmptyData(collect());
}

/* ============================ 实时码 ============================ */

function payloadOf(data) {
  // ⚠️ 刻意**不含时间戳**：码必须是「当前配置内容」的纯函数 ——
  // 否则每刷新一次页面码就变一次，用户根本分不清「我改了设置」与「它自己又变了」。
  // 需求要的是「修改设置后随时更新」，而不是「每次请求都不一样」。
  return JSON.stringify({
    app: 'kepler',
    kind: 'config-backup',
    v: FORMAT_VERSION,
    sections: SECTIONS,
    data,
  });
}

/**
 * 实时码：由当前配置推导，`JSON` → base64url。
 * 同一份配置必然得到**同一串**码；只要有一项备份范围内设置变了，码就随之改变。
 */
function buildCode() {
  return CODE_HEAD + '.' + b64u(payloadOf(collect()));
}

/** 短指纹：给界面显示「这串码对应哪一版配置」，不含任何配置内容 */
function fingerprint(code) {
  return crypto.createHash('sha256').update(String(code || '')).digest('hex').slice(0, 12);
}

/** 解码实时码（仅限本模块内部与测试使用；不对外提供「粘贴实时码导入」的口子） */
function decodeCode(code) {
  const s = String(code || '').trim();
  if (!s.startsWith(CODE_HEAD + '.')) throw badCode('备份码抬头不正确');
  let obj;
  try {
    obj = JSON.parse(unb64u(s.slice(CODE_HEAD.length + 1)).toString('utf8'));
  } catch (e) {
    throw badCode('备份码内容无法解析（可能复制不完整）');
  }
  if (!obj || obj.app !== 'kepler' || obj.kind !== 'config-backup') throw badCode('备份码内容无法识别');
  if (Number(obj.v) !== FORMAT_VERSION) throw badCode('备份码版本不受支持');
  if (!obj.data || typeof obj.data !== 'object') throw badCode('备份码缺少配置内容');
  return obj.data;
}

function badCode(msg) {
  return Object.assign(new Error(msg), { status: 400, backupCodeInvalid: true });
}

/* ============================ 导出码（加密） ============================ */

function deriveKey(password, salt) {
  return crypto.scryptSync(String(password), salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
    // 历史 Node 默认 maxmem 偏小，显式放宽（16MB 足够本参数）
    maxmem: 64 * 1024 * 1024,
  });
}

function normalizePassword(pw) {
  const p = String(pw == null ? '' : pw);
  if (p.length < PASSWORD_MIN) {
    throw Object.assign(new Error(`备份密码至少 ${PASSWORD_MIN} 位`), { status: 400 });
  }
  if (p.length > PASSWORD_MAX) {
    throw Object.assign(new Error(`备份密码最长 ${PASSWORD_MAX} 个字符`), { status: 400 });
  }
  return p;
}

/**
 * 用**备份密码**把实时码加密成导出码。
 *
 * 格式：`KEPLER-CONFIG-SEALED-V1.<salt>.<iv>.<tag>.<密文>`（各段 base64url）。
 * AES-256-GCM 而非 CBC：导入时**必须先认证后使用** —— 否则一段被篡改（甚至只是复制时
 * 少了一个字符）的密文会解出半截配置，而半截配置的导入是**破坏性**的
 * （见 `apply()` 的覆盖语义）。认证失败 → 抛「密码错误或备份码已损坏」，绝不落盘。
 */
function seal(code, backupPassword) {
  const pw = normalizePassword(backupPassword);
  const plain = Buffer.from(String(code || ''), 'utf8');
  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(pw, salt), iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [SEAL_HEAD, b64u(salt), b64u(iv), b64u(tag), b64u(ct)].join('.');
}

/** 解开导出码；密码错 / 被篡改一律抛错（GCM 认证失败），不返回半截结果 */
function open(sealedCode, backupPassword) {
  const parts = String(sealedCode || '').trim().split('.');
  if (parts.length !== 5 || parts[0] !== SEAL_HEAD) {
    throw badCode('导出码抬头不正确（请确认粘贴的是「导出」得到的那串码）');
  }
  const pw = normalizePassword(backupPassword);
  const salt = unb64u(parts[1]);
  const iv = unb64u(parts[2]);
  const tag = unb64u(parts[3]);
  const ct = unb64u(parts[4]);
  if (salt.length !== SALT_BYTES || iv.length !== IV_BYTES || !ct.length) {
    throw badCode('导出码内容不完整（可能复制时缺了一段）');
  }
  let plain;
  try {
    const dec = crypto.createDecipheriv('aes-256-gcm', deriveKey(pw, salt), iv);
    dec.setAuthTag(tag);
    plain = Buffer.concat([dec.update(ct), dec.final()]);
  } catch (e) {
    throw Object.assign(new Error('备份密码错误，或导出码已被篡改'), { status: 400, backupCodeInvalid: true });
  }
  return decodeCode(plain.toString('utf8'));
}

/* ============================ 导入（覆盖） ============================ */

/**
 * 把备份载荷写回**本实例**。
 *
 * 两条必须守住的性质：
 *  ① **覆盖而不是合并**（需求：「导入配置后，原有设置项将被直接覆盖、全部丢失」）。
 *     逐项 `configStore.save({...})` 替换整个顶层键，而不是 `Object.assign` 进旧值。
 *  ② **WebDAV 账户口令重新封**（`addWebdavAccount` 会用本实例的主密钥 `sealPassword()`），
 *     绝不能把别的实例的 `passwordSealed` 原样塞进来 —— 那是永远解不开的密文。
 *
 * 调用方必须先过 `canImport()`；本函数**不做**这道判断（它是「怎么写」的实现点，
 * 「准不准写」是路由层的职责），但会在写完后 `flush()`，避免去抖窗口内进程退出丢配置。
 */
function apply(data) {
  if (!data || typeof data !== 'object') throw badCode('备份内容为空');

  // ① API Key + 负载均衡（同一条记录：`quotaBytes` 就是「负载均衡」里的空间上限）
  const creds = data.credentials || {};
  const credentials = (Array.isArray(creds.credentials) ? creds.credentials : []).map(sanitizeCredential);
  const activeCredentialId = String(creds.activeCredentialId || '');
  // ② 存储桶管理
  const bk = data.buckets || {};
  const buckets = (Array.isArray(bk.buckets) ? bk.buckets : []).map(sanitizeBucket);
  const activeBucketId = String(bk.activeBucketId || '');

  configStore.save({
    credentials,
    activeCredentialId: credentials.some((c) => c.id === activeCredentialId) ? activeCredentialId : (credentials[0] ? credentials[0].id : ''),
    buckets,
    activeBucketId: buckets.some((b) => b.id === activeBucketId) ? activeBucketId : (buckets[0] ? buckets[0].id : ''),
  });

  // ③ 上传排除
  const ue = data.uploadExcludes || {};
  configStore.save({
    uploadExcludes: {
      dsStore: boolOf(ue.dsStore),
      thumbsDb: boolOf(ue.thumbsDb),
      gitignore: boolOf(ue.gitignore),
    },
  });

  // ④ 登陆验证
  const cap = data.captcha || {};
  configStore.save({
    captcha: {
      enabled: boolOf(cap.enabled),
      provider: String(cap.provider || 'recaptcha'),
      // R41：两套凭证整批还原（旧载荷只有扁平 siteKey/secretKey 时，落到 provider 那一套）
      providers: captchaProviders(cap),
      timeoutMs: Number.isFinite(Number(cap.timeoutMs)) ? Number(cap.timeoutMs) : 5000,
      onError: String(cap.onError || 'block'),
    },
  });

  // ⑤ 支付设置
  const pay = data.payment || {};
  configStore.save({
    payment: {
      enabled: boolOf(pay.enabled),
      platforms: clone(pay.platforms || {}),
      siteUrl: String(pay.siteUrl || ''),
      updatedAt: new Date().toISOString(),
    },
  });

  // ⑥ WebDAV 服务（先清空再用本实例主密钥重新封口令）
  const wd = data.webdav || {};
  const existing = (configStore.getWebdav().accounts || []);
  for (const a of existing) configStore.removeWebdavAccount(a.id);
  for (const a of (Array.isArray(wd.accounts) ? wd.accounts : [])) {
    const appName = String(a.appName || '').trim();
    const username = String(a.username || '').trim();
    if (!appName || !username) continue; // 缺关键字段的账户跳过，不让整次导入失败
    try {
      configStore.addWebdavAccount({ appName, username, password: String(a.password || '') });
    } catch (e) { /* 单条账户不合法（如口令为空）不影响其余配置还原 */ }
  }
  configStore.setWebdavEnabled(boolOf(wd.enabled));

  // ⑦ IP 地址管理（整批替换，保留 id / enabled）
  ipGuard.replaceAllRules(((data.ipguard || {}).rules) || []);

  configStore.flush();
  return summarize(collect());
}

/** 导入 / 导出后回给界面的摘要（只给计数，不回传任何密钥内容） */
function summarize(data) {
  const d = data || {};
  return {
    scopes: SCOPES.map((s) => s.label),
    sections: SECTIONS.slice(),
    credentials: ((d.credentials || {}).credentials || []).length,
    buckets: ((d.buckets || {}).buckets || []).length,
    webdavAccounts: ((d.webdav || {}).accounts || []).length,
    ipRules: ((d.ipguard || {}).rules || []).length,
  };
}

module.exports = {
  CODE_HEAD, SEAL_HEAD, FORMAT_VERSION, SCOPES, SECTIONS,
  PASSWORD_MIN, PASSWORD_MAX,
  collect, buildCode, decodeCode, fingerprint, seal, open,
  apply, canImport, isEmptyData, summarize,
};
