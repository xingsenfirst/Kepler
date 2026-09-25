/**
 * 路由公共依赖汇聚（依赖注入点）
 *
 * 所有子路由模块统一从这里 import，好处有二：
 *  1. 避免每个子模块重复 10+ 行 require，也让依赖关系一眼可见；
 *  2. 测试时可对单一模块做依赖替换，无需加载整个 express 应用。
 */
module.exports = {
  express: require('express'),
  path: require('path'),
  providers: require('../providers'),
  paymentProviders: require('../payment-providers'),
  paymentRules: require('../payment-rules'),
  paymentOrders: require('../payment-orders'),
  security: require('../security'),
  configStore: require('../config-store'),
  statsStore: require('../stats-store'),
  uploadSessions: require('../upload-sessions'),
  shareStore: require('../share-store'),
  gitignore: require('../gitignore'),
  webdav: require('../webdav-server'),
  authSession: require('../auth-session'),
  captcha: require('../captcha'),
  webauthn: require('../webauthn'),
  encStore: require('../enc-store'),
  ipGuard: require('../ip-guard'),
  cos: require('../cos'),
  streamDownload: require('../download-stream').streamDownload,
};
