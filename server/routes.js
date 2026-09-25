/**
 * API 路由聚合器
 *
 * 原先本文件承载全部 REST API（约 2200 行）。现按领域拆分为 `server/routes/` 下的子模块，
 * 本文件只负责「按正确顺序挂载」，便于定位与维护：
 *
 *   routes/_context.js  依赖汇聚（所有子模块共用）
 *   routes/_shared.js   共享工具与中间件（requireAdmin / requireConfig / 桶统计 / 排除规则…）
 *   routes/auth.js      登录认证（匿名白名单）+ Windows Hello 第二步验签
 *   routes/users.js     用户管理（仅管理员）+ 普通用户自助改资料
 *   routes/captcha.js   验证码服务配置
 *   routes/payment.js   支付平台凭证配置（仅基础配置与合法性校验，不含支付业务）
 *   routes/webauthn.js  Windows Hello（WebAuthn）凭据注册与关闭
 *   routes/config.js    系统配置 / 访问密钥 / 连接验证
 *   routes/buckets.js   存储桶管理 / 容量统计 / 清空销毁 / ACL 检查
 *   routes/ipguard.js   IP 访问屏蔽（全局 + 桶级）
 *   routes/enc.js       文件加密设置 / 上传排除设置
 *   routes/webdav.js    WebDAV 服务设置
 *   routes/links.js     分享链接管理
 *   routes/fs.js        文件系统（列表 / 上传 / 下载 / 重命名 / 移动 / 删除）
 *   routes/stats.js     监控统计 + 健康检查
 *
 * ⚠️ 挂载顺序约束（与拆分前保持一致，勿随意调整）：
 *  1. `/captcha/public` 必须在鉴权白名单内 —— 已在 index.js 的 PUBLIC_API 中声明；
 *  2. `/credentials/visibility` 与 `/credentials/:id` 由同一模块注册，顺序天然正确；
 *  3. `/buckets/local/:id/*` 各子路径分属不同模块，但互不冲突（路径前缀不同）；
 *  4. 分享链接 `/links` 早于文件系统注册，避免路径歧义；
 *  5. webauthn 模块须在 users 之后挂载 —— 它注册 `/users/:id/webauthn/disable`，
 *     路径更长更具体，Express 按声明顺序匹配，放在 users 之后可确保
 *     `/users/:id` PUT/DELETE 优先命中而不会被本模块的更长路径干扰。
 */
const express = require('express');

const router = express.Router();

router.use(require('./routes/auth'));
router.use(require('./routes/users'));
router.use(require('./routes/captcha'));
router.use(require('./routes/payment'));
router.use(require('./routes/webauthn'));
router.use(require('./routes/config'));
router.use(require('./routes/buckets'));
router.use(require('./routes/ipguard'));
router.use(require('./routes/enc'));
router.use(require('./routes/webdav'));
router.use(require('./routes/links'));
router.use(require('./routes/fs'));
router.use(require('./routes/stats'));

module.exports = router;
