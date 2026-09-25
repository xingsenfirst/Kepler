/**
 * 分享页「支付结果轮询」—— 独立静态脚本（**非** ES Module，也**非**内联脚本）
 *
 * ## 为什么必须是独立文件（R8-07）
 *
 * SEC-06 为了堵住整站 XSS 纵深，从 CSP 里移除了 `script-src 'unsafe-inline'`。
 * 但当时只为「主站那一个内联事件处理器」做了改造，分享页两个支付页里残留的
 * 内联 `<script>` 被漏掉了 —— 而 `shareRoutes` 挂在 `app.use('/', …)` 之后，
 * **同样受该 CSP 约束**，于是这段脚本被浏览器直接拒绝执行：
 * 「支付成功后本页会自动放行，无需其他操作」的承诺失效，用户停在「支付中…」，
 * 只能自己去点兜底按钮。抽成同源静态文件后落在 `script-src 'self'` 之内。
 *
 * ## 为什么是 classic script 而不是 module
 *
 * 参数只能由页面注入（链接 id 是动态的，无法写死在文件里），而
 * `document.currentScript` 在 `type="module"` 脚本中恒为 `null`。
 * 因此这里刻意使用普通脚本 + `data-link-id` 属性。
 *
 * 用法（由 `share-routes.js` 的 `payingPage` / `qrPayPage` 渲染）：
 *   <script src="/js/pay-poll.js" data-link-id="<链接 id>" defer></script>
 *
 * ## 安全
 *  · 链接 id 先经 `encodeURIComponent` 再拼进 URL，不会造成路径注入；
 *  · 只做 `fetch` 轮询，不读写 localStorage，不引入任何外部资源；
 *  · 状态页是幂等的只读接口（`/pay/status` 内部自带 3 秒查询节流）。
 */
(function () {
  'use strict';

  var self = document.currentScript;
  var linkId = (self && self.getAttribute('data-link-id')) || '';

  // 兜底：从地址栏取一次（POST 响应渲染的页面，location 仍是 /s/<id>/pay）
  if (!linkId) {
    var m = /^\/s\/([^/]+)\//.exec(location.pathname);
    linkId = m ? decodeURIComponent(m[1]) : '';
  }
  if (!linkId) return;

  var url = '/s/' + encodeURIComponent(linkId) + '/pay/status';
  var INTERVAL_MS = 3000;
  var MAX_ROUNDS = 200; // 10 分钟：超过就停轮询，避免用户把页面开着过夜时无限打服务端

  var timer = null;
  var rounds = 0;
  var stopped = false;

  function stop() {
    stopped = true;
    if (timer) { clearInterval(timer); timer = null; }
  }

  /** 状态文案元素（两处支付页都用 #pay-state） */
  function stateBox() {
    return document.getElementById('pay-state');
  }

  function tick() {
    if (stopped) return;
    if (++rounds > MAX_ROUNDS) { stop(); return; }
    fetch(url, { headers: { 'X-Requested-With': 'fetch' }, credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d) return;
        if (d.state === 'paid') {
          var box = stateBox();
          if (box) box.textContent = '已支付';
          stop();
          location.reload();
        } else if (d.state === 'failed') {
          stop();
          location.reload();
        }
      })
      .catch(function () { /* 网络抖动，下一轮再试 */ });
  }

  // 页面被切到后台时暂停轮询（省流量也省服务端），回到前台立即补一次
  document.addEventListener('visibilitychange', function () {
    if (stopped) return;
    if (document.hidden) {
      if (timer) { clearInterval(timer); timer = null; }
    } else if (!timer) {
      tick();
      timer = setInterval(tick, INTERVAL_MS);
    }
  });

  timer = setInterval(tick, INTERVAL_MS);
  tick(); // 立刻来一次，别让用户干等 3 秒
})();
