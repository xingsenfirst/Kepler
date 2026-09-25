/** 设置界面 —— 已迁移为「密钥管理」独立页面（credmgr.js）。保留本模块作兼容委托。 */
import { App } from './main.js';

export const settings = {
  init() {},

  async open() {
    // 兼容旧调用点：统一跳转到密钥管理独立页面
    if (App.switchMainView) App.switchMainView('credmgr');
  },
};
