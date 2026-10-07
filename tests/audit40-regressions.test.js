/**
 * 第四十轮护栏（R40）—— 三件事，一件一个章节：
 *
 *  A. `deploy.sh` 装 Node.js 在 EL8 上必然失败
 *     系统可能是 RockyLinux 8 / CentOS Stream 8 等 EL8：AppStream 模块流自带 nodejs:16，
 *     模块包（nodejs-full-i18n / nodejs-libs / nodejs-devel）把版本钉死在 16，与 NodeSource
 *     的 nodejs20 **直接互斥**（`cannot install both …`），直接 `dnf install` 连事务都进不去。
 *     修法：RPM 系一律带上 `--allowerasing`（dnf 官方给出的解法），且不再显式装 npm
 *     （npm 由 nodejs 包自带；单独装 npm 会把 AppStream 的模块包整串拉回来，又撞同一个冲突）。
 *
 *  B. 「用户管理」里管理员不能编辑自己
 *     → 行为护栏在 `tests/audit35-regressions.test.js`（那张卡片的假 DOM 与夹具只在那里，
 *       另抄一份等于把「同一份实现两处各写一遍」这个老毛病搬进测试里）。
 *
 *  C. 顶部新增「日间 / 暗黑」快捷切换（账户菜单左侧）
 *
 * 断言分层（每层都要，缺一层就留下假绿）：
 *   ① **行为层**：`node_pm_extra_args()` 真跑 bash 看返回值；`theme.js` 用 `vm` + 假 DOM
 *      真跑（含 storage 抛异常、值非法、点击往返）；
 *   ② **位置/结构层**：需求里「在账户菜单**左侧**」「不闪白（head 里的普通脚本）」
 *      「图标由 CSS 按主题显隐」都只有静态断言拦得住；
 *   ③ **一致性层**：明暗两套变量必须一一对应（漏一个 = 那个面在暗色下仍是亮色）。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const test = require('node:test');
const { spawn } = require('node:child_process');
const { assert, assertEqual, ROOT } = require('./helpers.js');

const DEPLOY = path.join(ROOT, 'deploy.sh');
const readDeploy = () => fs.readFileSync(DEPLOY, 'utf8');
const readIndex = () => fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const readCss = () => fs.readFileSync(path.join(ROOT, 'public', 'css', 'style.css'), 'utf8');
const readTheme = () => fs.readFileSync(path.join(ROOT, 'public', 'js', 'theme.js'), 'utf8');

/** deploy.sh 里函数的两种写法（function f() / f()）都要认 */
const hasFn = (src, name) => new RegExp(`^[ \\t]*(function[ \\t]+)?${name}[ \\t]*\\([ \\t]*\\)`, 'm').test(src);
/** 抽函数体：deploy.sh 的顶层函数都以行首 `}` 收尾 */
function fnBody(src, name) {
  const m = new RegExp(`\\n(?:function[ \\t]+)?${name}\\(\\) \\{`).exec(src);
  assert(m, `deploy.sh 里应存在函数 ${name}（取不到 = 本条检查已失效）`);
  const end = src.indexOf('\n}', m.index);
  assert(end !== -1, `${name}() 应有正常的函数体结束`);
  return src.slice(m.index, end);
}
/** 剥掉整行注释再断言：注释里常举反例（比如「早期是 `install -y nodejs npm`」） */
const codeOnly = (body) => body.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
/** 剥掉 /* … *\/ 块注释：注释里提到某个词不等于代码里用了它（本轮实测踩过两次） */
const stripBlockComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '');

function spawnBashSnippet(script) {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', script], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({ unavailable: e.code || String(e) }));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

/* ================================================================== *
 * A · EL8 上装 Node.js
 * ================================================================== */

test('R40 · deploy.sh：RPM 系的 node 安装必须带 --allowerasing（EL8 模块包互斥的唯一解法）', async () => {
  const src = readDeploy();
  assert(hasFn(src, 'node_pm_extra_args'),
    '必须有一个唯一实现点决定「RPM 系要不要额外参数」，而不是在两处调用点各写一份判断');

  // ① 行为：真跑 bash 看四种取值。判据必须是**行为**而不是「源码里有没有 --allowerasing」
  //    —— 那字样也会出现在注释、提示文案与 dnf 的报错原文里，文本断言必假绿。
  const probe = `
set -Eeuo pipefail
source ./deploy.sh
trap - ERR
for p in dnf yum apt apk zypper; do printf '%s=%s\\n' "$p" "$(PM=$p; node_pm_extra_args)"; done
printf 'unset=%s\\n' "$(unset PM; node_pm_extra_args)"
`;
  const r = await spawnBashSnippet(probe);
  if (r.unavailable) return; // 本机没有 bash：跳过（与环境有关，与代码对错无关）
  const got = Object.fromEntries(
    r.out.trim().split('\n').filter((l) => l.includes('=')).map((l) => l.split('=')),
  );
  assertEqual(r.code, 0, `探针应正常退出（stderr: ${r.err.slice(0, 300)}）`);
  assertEqual(got.dnf, '--allowerasing',
    'dnf 下必须给 --allowerasing：EL8 的 AppStream nodejs:16 模块包与新版本互斥，没有它事务进不去');
  for (const pm of ['yum', 'apt', 'apk', 'zypper']) {
    assertEqual(got[pm], '', `${pm} 下不得带上 --allowerasing —— 旧版 yum 不认这个选项，会直接报 no such option`);
  }
  assertEqual(got.unset, '', 'PM 未设时同理返回空（脚本不会因此崩）');

  // ② 结构：两处安装点都必须走这个唯一实现点，且 apt 分支不得沾上 RPM 的参数
  const inst = codeOnly(fnBody(src, 'install_node'));
  assertEqual((inst.match(/install -y nodejs \$\(node_pm_extra_args\)/g) || []).length, 2,
    '「发行版源」与「NodeSource」两处 node 安装都必须带 $(node_pm_extra_args)（少一处 = 那条路在 EL8 上仍然装不上）');
  assert(!/apt-get install[^\n]*node_pm_extra_args/.test(inst),
    'apt 分支不得沾上 RPM 的参数（--allowerasing 是 dnf 的参数，apt 会直接报未知选项）');

  // ③ 不再显式安装 npm 这个**独立包名**：npm 由 nodejs 包自带，而单独 install npm
  //    会把 AppStream 的 nodejs-npm 模块包一起拉回来，正好又撞上同一个冲突。
  assert(!/install -y nodejs npm\b/.test(inst),
    'RPM 分支不得再写 `install -y nodejs npm` —— 这正是 EL8 上必然失败的那条命令');
});

test('R40 · deploy.sh：冲突指引必须先给「--allowerasing」这条一条就够的解法', async () => {
  // 上一版把用户直接推去 `module reset` + `remove`，那是有副作用的重活；
  // 既然安装命令本身已经带 --allowerasing，指引的第一条就该是它。
  const probe = `
set -Eeuo pipefail
source ./deploy.sh
trap - ERR
PM=dnf
FAKE_LOG=' - cannot install both nodejs-2:20.20.2-1nodesource.x86_64 and nodejs-1:16.13.1-3.module_el8.5.0+1059+1852da12.x86_64'
log_since_mark() { printf '%s' "$FAKE_LOG"; }
HINTS=()
if node_conflict_detected; then node_conflict_hints; fi
printf '%s\\n' "\${HINTS[@]}"
`;
  const r = await spawnBashSnippet(probe);
  if (r.unavailable) return;
  const all = r.out + r.err;
  assert(/--allowerasing/.test(all),
    `指引里必须给出 --allowerasing（用户照着敲就能装上的那一条）：${all.slice(0, 500)}`);
  // 既有的两条经验命令不能被这次改写弄丢（deploy-script.test.js 另有用例盯着它们，
  // 这里再钉一次是因为本轮动过这个函数的顺序与措辞）
  assert(/module reset nodejs/.test(all) && /remove -y nodejs npm/.test(all),
    `「复位模块流」与「卸掉系统那份」两条兜底命令都必须在：${all.slice(0, 500)}`);
  assert(/\/usr\/local/.test(all), '「用官方二进制包绕开包管理器」这条最省事的路必须保留');
});

/* ================================================================== *
 * C · 日间 / 暗黑快捷切换
 * ================================================================== */

/** 严格假 DOM：`getElementById` 只返回**注册过**的元素（凭空造元素是标准的假绿来源） */
function makeThemeEnv(opts = {}) {
  const listeners = {};
  const els = {};
  const attrs = {};
  const doc = {
    readyState: opts.readyState || 'loading',
    documentElement: {
      setAttribute: (k, v) => { attrs[k] = v; },
      getAttribute: (k) => (k in attrs ? attrs[k] : null),
    },
    getElementById: (id) => els[id] || null,
    addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); },
    fire: (t) => (listeners[t] || []).forEach((f) => f()),
  };
  const store = opts.noStore ? null : {
    data: Object.assign({}, opts.initial),
    getItem(k) { if (opts.throwing) throw new Error('SecurityError'); return k in this.data ? this.data[k] : null; },
    setItem(k, v) { if (opts.throwing) throw new Error('SecurityError'); this.data[k] = v; },
  };
  const sandbox = { document: doc, localStorage: store, console };
  sandbox.globalThis = sandbox;
  return {
    doc,
    attrs,
    store,
    theme: () => attrs['data-theme'],
    /** 注册按钮 + 触发 DOMContentLoaded，返回按钮本身（点击 = 调 btn.click()） */
    mount: () => {
      els['btn-theme'] = {
        attrs: {},
        setAttribute(k, v) { this.attrs[k] = v; },
        addEventListener(t, f) { if (t === 'click') this.click = f; },
      };
      doc.fire('DOMContentLoaded');
      return els['btn-theme'];
    },
    run: () => { vm.runInNewContext(readTheme(), sandbox); return sandbox.KeplerTheme; },
  };
}

test('R40 · 主题：状态只有一个落点 <html data-theme>，非法值与不可用 storage 一律退回日间', () => {
  // 存过 dark → 解析期就落属性（这一句就是「不闪白」）。
  let e = makeThemeEnv({ initial: { 'kepler-theme': 'dark' } });
  e.run();
  assertEqual(e.theme(), 'dark', '存了 dark 时应立刻把 data-theme 写到 <html> 上');

  // 没存过 / 值非法 → 日间。**绝不让脏数据决定主题**。
  for (const [name, initial] of [
    ['没存过', {}],
    ['大写 DARK', { 'kepler-theme': 'DARK' }],
    ['乱值', { 'kepler-theme': 'blurple' }],
  ]) {
    e = makeThemeEnv({ initial });
    e.run();
    assertEqual(e.theme(), 'light', `${name} 时应退回日间`);
  }

  // storage 整个抛异常（隐私模式）：主题读不出来最多是不好看，不该把应用拦在启动前。
  e = makeThemeEnv({ throwing: true });
  e.run();
  assertEqual(e.theme(), 'light', 'storage 抛异常时必须吞掉并退回日间，而不是把异常抛到全局');
  e = makeThemeEnv({ noStore: true });
  e.run();
  assertEqual(e.theme(), 'light', '连 localStorage 属性都没有时同样退回日间');
});

test('R40 · 主题：点一下 = 属性 / storage / 按钮文案三处一起变，且 storage 不可用时仍能来回切', () => {
  const e = makeThemeEnv({ initial: { 'kepler-theme': 'dark' } });
  e.run();
  const btn = e.mount();

  assertEqual(btn.attrs.title, '切换到日间模式',
    '图标显示的是「点下去会变成什么」，title 必须跟着说同一件事（否则提示与行为相反）');
  assertEqual(btn.attrs['aria-pressed'], 'true', '暗色态应 aria-pressed=true（读屏用户也要知道当前状态）');

  btn.click();
  assertEqual(e.theme(), 'light', '点击后必须真的切到日间');
  assertEqual(e.store.data['kepler-theme'], 'light', '选择必须落盘（下次打开还是这个主题）');
  assertEqual(btn.attrs.title, '切换到暗黑模式', 'title 要跟着反向更新');
  assertEqual(btn.attrs['aria-pressed'], 'false', 'aria-pressed 同样要更新');

  btn.click();
  assertEqual(e.theme(), 'dark', '再点一次必须回到暗色（来回切不能单向）');
  assertEqual(e.store.data['kepler-theme'], 'dark', '第二次点击同样要落盘');

  // 「当前是哪个主题」以 **DOM 属性**为准而不是 storage：隐私模式下 storage 每次都读成
  // 日间，若拿它当当前值，第一次点击后就再也切不回去了（永远算出 light）。
  const t = makeThemeEnv({ throwing: true });
  t.run();
  const b2 = t.mount();
  b2.click();
  assertEqual(t.theme(), 'dark', 'storage 不可用时点第一下仍要能进暗色');
  b2.click();
  assertEqual(t.theme(), 'light', 'storage 不可用时点第二下必须能切回日间（以 DOM 属性为当前值）');
});

test('R40 · 主题：脚本必须是 <head> 里的普通脚本（写成 module 就会「闪白」）', () => {
  const html = readIndex();
  const tag = html.indexOf('<script src="js/theme.js">');
  assert(tag !== -1, '<head> 里应有一个到 js/theme.js 的普通 <script src>');

  assert(tag < html.indexOf('<body>'), '主题脚本必须出现在 <body> 之前 —— 否则等它跑起来页面已经画过一帧了');
  assert(html.indexOf('js/theme.js') < html.indexOf('js/main.js'),
    '它必须排在 main.js 之前（main.js 是 module，天然 defer）');

  const scriptTag = html.slice(html.lastIndexOf('<script', tag), html.indexOf('>', tag) + 1);
  assert(!/type\s*=\s*["']module["']/.test(scriptTag),
    '不得写成 type="module"：module 天然 defer，深色用户每次刷新都会先看到一帧白 —— 这正是要避免的「闪白」');
  assert(!/\b(defer|async)\b/.test(scriptTag), '也不得加 defer/async —— 同样会把首屏让给亮色');

  // CSP 没有 'unsafe-inline'（SEC-06），所以内联脚本也走不通 —— 把这条前提钉住，
  // 免得将来有人为了「顺手」把它改成内联。
  // ⚠️ 判据必须落在**那条 CSP 指令字面量**上：源码里 `// SEC-06：移除 script-src 的
  //    'unsafe-inline'` 这句注释本身就含这两个词，对全文做正则会「被注释满足」（实测踩过）。
  //    所以只认「同一行里同时出现双引号与 script-src」的那一行 —— 注释行没有双引号。
  const index = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  const cspLines = index.split('\n').filter((l) => /"script-src/.test(l));
  assertEqual(cspLines.length, 1,
    '应有且只有一行以双引号开头的 script-src 指令（多行 = 判据取错位置）');
  assert(/'self'/.test(cspLines[0]), `script-src 必须允许同源脚本（否则本站脚本全被拦）：${cspLines[0]}`);
  assert(!/unsafe-inline/.test(cspLines[0]), `script-src 不得含 unsafe-inline：${cspLines[0]}`);
  // 自证：同一套取法必须能取到**确有** unsafe-inline 的 style-src，否则上面的「没有」毫无意义
  const styleLine = index.split('\n').find((l) => /"style-src/.test(l));
  assert(styleLine && /unsafe-inline/.test(styleLine),
    '前置自证：style-src 那行确实带 unsafe-inline —— 取法若连它都取不到，上面「script-src 没有」就是假绿');
});

test('R40 · 主题：切换按钮在账户菜单**左侧**，两颗图标都在 HTML 里', () => {
  const html = readIndex();
  const btn = html.indexOf('id="btn-theme"');
  const menu = html.indexOf('id="user-menu-wrap"');
  assert(btn !== -1, 'index.html 里应有 #btn-theme');
  assert(menu !== -1, 'index.html 里应有 #user-menu-wrap');
  assert(btn < menu, '需求：切换按钮在「账户菜单」的**左侧**（DOM 顺序即视觉顺序，它俩都在 .tb-right 里）');

  // 两颗图标都写在 HTML 里，露哪一颗由 CSS 决定 —— JS 只切属性，因此不存在
  // 「图标已经换了、页面还是旧主题」的中间态，也没有 innerHTML 写入。
  const tag = html.slice(btn, html.indexOf('</button>', btn));
  assert(/class="ic-moon"/.test(tag) && /class="ic-sun"/.test(tag),
    '太阳与月亮两颗图标都必须写在按钮里（由 CSS 按 data-theme 显隐）');
  assert(!/innerHTML/.test(stripBlockComments(readTheme())),
    'theme.js 不得写 innerHTML：图标是声明式的，无需动态拼 HTML（也顺手守住 CSP 的既有约定）');
});

test('R40 · 主题：CSS 的明暗两套变量必须一一对应，且暗色块排在 :root 之后', () => {
  const css = readCss();
  const blockOf = (sel) => {
    const i = css.indexOf(sel);
    assert(i !== -1, `style.css 里应存在 ${sel} 规则块`);
    return css.slice(i, css.indexOf('}', i));
  };
  const varsOf = (sel) => {
    const out = {};
    for (const m of blockOf(sel).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
    return out;
  };
  const light = varsOf(':root {');
  const dark = varsOf('[data-theme="dark"] {');

  // 几何与字体不需要换主题；**颜色**槽位一个都不能漏，漏掉的那个面在暗色下仍是亮色，
  // 而它在界面上往往就是一块刺眼的白（输入框 / 对话框 / 提示块）。
  const GEOMETRY = new Set(['--radius', '--tb-h', '--sb-h', '--font']);
  const missing = Object.keys(light).filter((k) => !GEOMETRY.has(k) && !(k in dark));
  assertEqual(missing.length, 0,
    `暗色块未覆盖这些颜色变量（它们在暗色下仍会用亮色值）：${missing.join(', ')}`);
  assertEqual(Object.keys(dark).filter((k) => !(k in light)).length, 0,
    '暗色块不得凭空定义 :root 里没有的变量（那是暗色专用的一次性值，应该走选择器覆盖层）');

  // 同名同值的槽位 = 这一格根本没改（典型的复制粘贴漏改）。
  const identical = Object.keys(dark).filter((k) => dark[k] === light[k] && !GEOMETRY.has(k));
  assertEqual(identical.length, 0, `两套取值完全相同，疑似漏改：${identical.join(', ')}`);

  assert(css.indexOf('[data-theme="dark"] {') > css.indexOf(':root {'),
    '暗色块必须排在 :root **之后**：两者特异度同为 (0,1,0)，靠先后顺序决胜');
  // ⚠️ 选择器字符串必须带上 ` {`：文件里第一处 `[data-theme="dark"]` 其实是 .theme-btn
  //    那几条（在 .tb-sep 附近），只写方括号会切到那一段上去（实测踩过）。
  assert(/color-scheme:\s*dark/.test(blockOf('[data-theme="dark"] {')),
    '暗色块要声明 color-scheme: dark —— 否则原生下拉、复选框、滚动条仍是亮色');
  assert(/\.theme-btn \.ic-sun\s*\{\s*display:\s*none/.test(css),
    '日间模式下必须把太阳藏起来（否则两颗图标会同时出现）');
  assert(/\[data-theme="dark"\] \.theme-btn \.ic-sun\s*\{\s*display:\s*inline/.test(css)
    && /\[data-theme="dark"\] \.theme-btn \.ic-moon\s*\{\s*display:\s*none/.test(css),
    '暗色模式下必须反过来：露太阳、藏月亮（图标显示的是「点下去会变成什么」）');
});
