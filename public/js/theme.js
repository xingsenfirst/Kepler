/*
 * 主题（日间 / 暗黑）唯一实现点 —— R40。
 *
 * 为什么必须是**普通脚本**、而且放在 <head>：
 *   它要赶在首屏绘制之前把 `data-theme` 写到 <html> 上。`type="module"` 天然 defer
 *   （等 HTML 解析完才执行），深色用户每次刷新都会先看到一帧亮色再变黑 —— 也就是
 *   「闪白」。而 CSP 的 `script-src` **没有** `'unsafe-inline'`（SEC-06 刻意移除，
 *   见 server/index.js），内联脚本同样走不通。于是只剩「<head> 里的外部普通脚本」这一条路。
 *   代价是它不能用 import，所以本文件刻意不依赖任何其它模块。
 *
 * 状态只有一个落点：`<html data-theme="dark" | "light">`。
 *   · 属性缺失 = 日间（`:root` 的默认值就是亮色），所以「清掉属性」也是日间，不必额外分支；
 *   · 持久化用 localStorage；读不到 / 被禁用（隐私模式会直接抛）/ 值非法，一律退回日间。
 *     主题读不出来最多是不好看，绝不该把整个应用拦在启动前。
 *
 * 按钮 `#btn-theme` 里的太阳与月亮**两颗图标都写在 HTML 里**，露哪一颗由 CSS 决定
 * （`[data-theme="dark"] .theme-btn .ic-sun`）。JS 只切属性 + 存值 + 更新 title / aria-pressed，
 * 因此既没有 innerHTML 写入，也不会出现「图标已经换了、页面还是旧主题」的中间态。
 *
 * 「当前是哪个主题」以 **DOM 属性**为准（不是 storage）：storage 不可用时 toggle 仍然
 * 能正确来回切。写 storage 只是尽力而为。
 */
(function (root) {
  'use strict';

  const STORAGE_KEY = 'kepler-theme';
  const ATTR = 'data-theme';
  const DARK = 'dark';
  const LIGHT = 'light';

  /** 非法值（null / 空串 / 大小写不符 / 别的主题名）一律归到日间 */
  function normalize(value) {
    return value === DARK ? DARK : LIGHT;
  }

  /** 取默认存储；隐私模式下**访问 `localStorage` 这个属性本身**就会抛，所以要包起来 */
  function defaultStorage() {
    try {
      return root.localStorage || null;
    } catch (e) {
      return null;
    }
  }

  function read(storage) {
    try {
      if (!storage) return LIGHT;
      return normalize(storage.getItem(STORAGE_KEY));
    } catch (e) {
      return LIGHT;
    }
  }

  function write(storage, theme) {
    try {
      if (storage) storage.setItem(STORAGE_KEY, normalize(theme));
    } catch (e) {
      // 存不下就算了：本次会话已经生效，下次打开退回日间而已
    }
  }

  function apply(doc, theme) {
    if (!doc || !doc.documentElement) return LIGHT;
    const t = normalize(theme);
    doc.documentElement.setAttribute(ATTR, t);
    return t;
  }

  function toggle(theme) {
    return normalize(theme) === DARK ? LIGHT : DARK;
  }

  /** 图标显示的是**点下去会变成什么**，所以文案也跟着说「切换到 X」 */
  function titleFor(theme) {
    return normalize(theme) === DARK ? '切换到日间模式' : '切换到暗黑模式';
  }

  function syncButton(doc, theme) {
    if (!doc || !doc.getElementById) return;
    const btn = doc.getElementById('btn-theme');
    if (!btn || !btn.setAttribute) return;
    const t = normalize(theme);
    btn.setAttribute('title', titleFor(t));
    btn.setAttribute('aria-pressed', t === DARK ? 'true' : 'false');
  }

  /** 切主题的**唯一**动作序列：写属性 → 存值 → 同步按钮文案 */
  function setTheme(doc, storage, theme) {
    const t = apply(doc, theme);
    write(storage, t);
    syncButton(doc, t);
    return t;
  }

  function init(doc, storage) {
    const st = storage === undefined ? defaultStorage() : storage;
    const current = apply(doc, read(st)); // 先落属性：此刻 <body> 还没开始渲染
    if (!doc || !doc.addEventListener) return current;

    const bind = function () {
      const btn = doc.getElementById && doc.getElementById('btn-theme');
      if (!btn || !btn.addEventListener) return;
      syncButton(doc, doc.documentElement.getAttribute(ATTR));
      btn.addEventListener('click', function () {
        // 以 DOM 属性为「当前值」，storage 不可用时也能正确来回切
        setTheme(doc, st, toggle(doc.documentElement.getAttribute(ATTR)));
      });
    };

    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', bind);
    else bind();
    return current;
  }

  root.KeplerTheme = {
    STORAGE_KEY: STORAGE_KEY,
    ATTR: ATTR,
    DARK: DARK,
    LIGHT: LIGHT,
    normalize: normalize,
    defaultStorage: defaultStorage,
    read: read,
    write: write,
    apply: apply,
    toggle: toggle,
    titleFor: titleFor,
    syncButton: syncButton,
    setTheme: setTheme,
    init: init,
  };

  // 浏览器里随解析同步执行 —— 这一句就是「不闪白」的全部秘密
  if (root.document) init(root.document);
})(typeof globalThis !== 'undefined' ? globalThis : this);
