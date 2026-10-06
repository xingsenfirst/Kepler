/**
 * 路由：配置备份（R38）
 *
 * ## 四个接口，各自解决一件事
 *
 *  - `GET  /backup/status`  —— 页面初始化：现在能不能导入、备份了哪几项、实时码指纹
 *  - `GET  /backup/code`    —— 取**实时码**（明文，随配置变化）
 *  - `POST /backup/export`  —— 校验**账户口令**后，用**备份密码**把实时码加密成导出码
 *  - `POST /backup/import`  —— 用备份密码解开导出码，**仅在全新实例上**覆盖写入
 *
 * ## 三个刻意的取舍
 *
 * ① **全部挂 `requireAdmin`。** 实时码里含 API Key、支付凭证与 WebDAV 账户口令的
 *    **明文**（它们本来就在 `config.enc` 里，只是被整文件加密保护）。这既是对需求
 *    「所有用户均不在备份范围内」的自然延伸，也是唯一安全的默认：普通用户拿到的
 *    任何一份配置副本都等于拿到了密钥。
 *
 * ② **导入与导出走同一个解密实现**（`backup.open()`），因此「导出码被改过一个字节」
 *    与「备份密码打错」在服务端是**同一类失败**（GCM 认证失败）—— 这是对的：
 *    两者对用户的可执行动作都是「重新核对密码与备份码」，强行区分只会给出
 *    一个无法验证的猜测。文案里把两种可能一并列出，而不是二选一。
 *
 * ③ **导入的准入判据放在服务端**（`backup.canImport()`），而不是只把按钮置灰。
 *    前端置灰是「提示」，服务端拒绝才是「约束」；这个接口一旦被误调到已配置的实例上，
 *    后果是把线上配置整批覆盖掉，不可撤销。
 *
 * @see server/backup.js —— 备份范围、实时码、加解密与落盘的唯一实现点
 */
const { express, security } = require('./_context');
const configStore = require('../config-store');
const backup = require('../backup');
const { requireAdmin, apiHandler } = require('./_shared');

const router = express.Router();

/** 导出前必须校验账户口令：用与登录 / 改密码 / WebDAV **同一处**校验实现 */
async function assertAccountPassword(req, password) {
  const me = req.authUser;
  if (!me) throw Object.assign(new Error('未登录'), { status: 401 });
  const ok = await configStore.verifyUserPassword(me.id, password);
  if (!ok) throw Object.assign(new Error('账户密码不正确'), { status: 403 });
}

/** 导出限流：拿 IP 当键（与 encUnlockLimiter 同款） */
function guardExportRate(req) {
  const ip = security.clientIp(req) || 'unknown';
  const r = security.backupExportLimiter(ip);
  if (!r.ok) {
    const e = Object.assign(new Error(`操作过于频繁，请 ${r.retryAfter} 秒后重试`), { status: 429 });
    throw e;
  }
}

/**
 * 页面状态。
 *
 * `canImport` 每次现算（不缓存）：它是**唯一准入判据**，缓存一分钟就可能让用户在
 * 「刚配好一个密钥」之后仍然看到「可以导入」的按钮 —— 而那一次点击是破坏性的。
 */
router.get('/backup/status', requireAdmin, (req, res) => {
  res.json({
    canImport: backup.canImport(),
    scopes: backup.SCOPES.map((s) => s.label),
    sections: backup.SECTIONS.slice(),
    passwordMin: backup.PASSWORD_MIN,
    passwordMax: backup.PASSWORD_MAX,
  });
});

/** 实时码（明文，随配置变化；管理员专属 —— 见文件头第 ① 条） */
router.get('/backup/code', requireAdmin, (req, res) => {
  const code = backup.buildCode();
  res.json({
    code,
    fingerprint: backup.fingerprint(code),
    summary: backup.summarize(backup.collect()),
  });
});

/**
 * 导出：账户口令（权限验证）+ 备份密码（独立于账户口令）。
 *
 * 需求原话：「导出该代码需进行权限验证（输入密码）；导出时需额外设置一个独立密码」。
 * 两步都在这里做：口令错 → 403 且**不产生**任何导出码；备份密码不合规 → 400。
 */
router.post('/backup/export', requireAdmin, apiHandler(async (req, res) => {
  guardExportRate(req);
  const b = req.body || {};
  await assertAccountPassword(req, b.password);
  const plain = backup.buildCode();
  const code = backup.seal(plain, b.backupPassword);
  res.json({
    code,
    fingerprint: backup.fingerprint(code),
    plainFingerprint: backup.fingerprint(plain),
    summary: backup.summarize(backup.collect()),
  });
}));

/**
 * 导入：备份密码 + 导出码。**仅在全新实例上允许**（`canImport()`）。
 *
 * 顺序刻意的：先判准入、再解密。反过来会让「在已配置的实例上反复试密码」成为一条
 * 可用的口令爆破信道，而准入判据本身就与密码对不对无关。
 */
router.post('/backup/import', requireAdmin, apiHandler(async (req, res) => {
  const b = req.body || {};
  if (!backup.canImport()) {
    // ⚠️ 刻意**不**在错误对象上挂结构化标志（如 `backupImportClosed: true`）：
    // `apiHandler` 只下发 `{ error: err.message }`，挂在错误上的自定义字段**到不了客户端**
    // —— 那是本项目已经吃过一次亏的「不可观测代码」。前端的判据只能是 HTTP 状态码 409。
    throw Object.assign(new Error(
      '当前实例已有配置，导入会直接覆盖并全部丢失，因此已禁用；'
      + '请在一台全新部署、尚未配置任何项目的实例上导入',
    ), { status: 409 });
  }
  const data = backup.open(b.code, b.backupPassword);
  const summary = backup.apply(data);
  res.json({ ok: true, summary });
}));

module.exports = router;
