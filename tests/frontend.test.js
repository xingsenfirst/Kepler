/**
 * 测试：前端 ES Module 语法与安全约定
 *
 * 项目前端为原生 ES Module、无构建步骤 —— 语法错误只能在浏览器运行时暴露，
 * 是最容易漏掉的一类低级事故。这里用静态方式兜住：
 *  1. 所有 public/js 模块语法可解析；
 *  2. import 的模块路径真实存在（无构建步骤不会帮你发现拼写错误）；
 *  3. 危险 API（innerHTML 赋值）的使用点符合安全约定。
 */
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { assert, assertEqual, ROOT } = require('./helpers');

const JS_DIR = path.join(ROOT, 'public', 'js');
const MODULES = fs.readdirSync(JS_DIR).filter((f) => f.endsWith('.js'));

/** 用 Function 构造器做语法解析（剥离 import/export 语句后；等价于 node --check 对 ESM 的校验） */
function syntaxOk(src) {
  const stripped = src
    .replace(/^\s*import\s+[\s\S]*?from\s*['"][^'"]+['"]\s*;?\s*$/gm, '')
    .replace(/^\s*import\s*['"][^'"]+['"]\s*;?\s*$/gm, '')
    .replace(/^\s*export\s+default\s+/gm, 'const __default__ = ')
    .replace(/^\s*export\s*\{[^}]*\}\s*(?:from\s*['"][^'"]+['"])?\s*;?\s*$/gm, '')
    .replace(/^\s*export\s+(const|let|var|function|class|async)\s+/gm, '$1 ')
    .replace(/^\s*export\s*\{[^}]*\}\s*;?\s*$/gm, '');
  try {
    // eslint-disable-next-line no-new-func
    new Function(stripped);
    return null;
  } catch (e) {
    return e.message;
  }
}

test('前端模块数量符合预期（未意外增删）', () => {
  assertEqual(MODULES.length, 24, `public/js 模块数应为 24，实际 ${MODULES.length}（新增/删除模块时请同步此基线）`);
  assert(MODULES.includes('webauthn.js'), '应包含 webauthn.js（Windows Hello 前端模块）');
  assert(MODULES.includes('profile.js'), '应包含 profile.js（「编辑资料」自助弹窗）');
  assert(MODULES.includes('ordermgr.js'), '应包含 ordermgr.js（订单管理页）');
  assert(MODULES.includes('share-status.js'), '应包含 share-status.js（分享链接状态判定，与服务端 status() 同序）');
  assert(MODULES.includes('pay-poll.js'), '应包含 pay-poll.js（分享页支付轮询，R8-07 从内联脚本抽出）');
});

for (const f of MODULES) {
  test(`前端模块语法可解析：${f}`, () => {
    const src = fs.readFileSync(path.join(JS_DIR, f), 'utf8');
    const err = syntaxOk(src);
    assertEqual(err, null, `${f} 存在语法错误`);
  });
}

test('前端 import 的相对模块路径均真实存在', () => {
  const missing = [];
  for (const f of MODULES) {
    const src = fs.readFileSync(path.join(JS_DIR, f), 'utf8');
    const re = /from\s*['"](\.[^'"]+)['"]/g;
    let m;
    while ((m = re.exec(src))) {
      const target = path.resolve(JS_DIR, m[1]);
      const candidates = [target, target + '.js', path.join(target, 'index.js')];
      if (!candidates.some((c) => fs.existsSync(c))) {
        missing.push(`${f} -> ${m[1]}`);
      }
    }
  }
  assertEqual(missing.length, 0, '以下 import 路径不存在：\n  ' + missing.join('\n  '));
});

test('util.js 提供转义工具与模态安全通道', () => {
  const src = fs.readFileSync(path.join(JS_DIR, 'util.js'), 'utf8');
  assert(/export\s+function\s+escapeHtml/.test(src) || /export\s*\{[^}]*escapeHtml/.test(src),
    'util.js 应导出 escapeHtml');
  assert(/textContent/.test(src), 'openModal 应支持 textContent 安全通道（{ text } 形式）');
  assert(/allowHtml/.test(src), 'confirmDialog 应支持 allowHtml 开关');
});

test('tree.js 复用 util.js 的 escapeHtml（无重复实现）', () => {
  const src = fs.readFileSync(path.join(JS_DIR, 'tree.js'), 'utf8');
  assert(/from\s*['"]\.\/util\.js['"]/.test(src), 'tree.js 应从 ./util.js 引入共享工具');
  assert(!/function\s+escapeHtml2/.test(src), 'tree.js 不应再保留本地 escapeHtml2 重复实现');
});

test('enc.js 下载优先使用流式落盘（File System Access API）', () => {
  const src = fs.readFileSync(path.join(JS_DIR, 'enc.js'), 'utf8');
  assert(/showSaveFilePicker/.test(src), 'enc.js 应优先尝试 showSaveFilePicker 流式落盘');
  assert(/pipeTo|getWriter/.test(src), 'enc.js 应支持流式写入（pipeTo/getWriter）');
});

/* ------------------------- Windows Hello（WebAuthn） ------------------------- */

test('webauthn.js 提供注册与验证两个核心入口，且不依赖第三方库', () => {
  const src = fs.readFileSync(path.join(JS_DIR, 'webauthn.js'), 'utf8');
  assert(/export\s+(async\s+)?function\s+registerWindowsHello/.test(src), '应导出 registerWindowsHello');
  assert(/export\s+(async\s+)?function\s+verifyWindowsHello/.test(src), '应导出 verifyWindowsHello');
  assert(/export\s+(async\s+)?function\s+webauthnSupported/.test(src), '应导出 webauthnSupported');
  assert(/navigator\.credentials\.create/.test(src), '注册应调用 navigator.credentials.create');
  assert(/navigator\.credentials\.get/.test(src), '验证应调用 navigator.credentials.get');
  assert(!/from\s*['"][^.'"]/.test(src), 'webauthn.js 不应引入外部依赖（无构建步骤项目无法解析裸模块名）');
});

test('webauthn.js 处理非安全上下文（明文 HTTP 且非回环时 WebAuthn 不可用）', () => {
  const src = fs.readFileSync(path.join(JS_DIR, 'webauthn.js'), 'utf8');
  assert(/isSecureContext/.test(src), '应检查 isSecureContext');
  assert(/127\.0\.0\.1|localhost/.test(src), '应识别回环地址（浏览器视其为安全上下文）');
});

/**
 * 回归：启用 Windows Hello 在本地 HTTP **和** HTTPS 下都报
 * 「安全上下文校验失败：请通过 HTTPS 或 127.0.0.1 访问本系统」。
 *
 * 真实原因是 rpId 不合法（WebAuthn 要求 rpId 是有效域名，IP 字面量不合法），
 * 却被旧版 `describeError()` 一律归因成"没走 HTTPS" —— 用户换协议怎么试都没用。
 * 修复要点：
 *  1. 提供结构化就绪判定 `webauthnReadiness()`，把「为什么不可用」分类；
 *  2. 识别 IP 字面量主机名并给出可执行动作（改用 localhost）；
 *  3. SecurityError 不得再被无条件映射成"安全上下文"文案。
 */
test('webauthn.js：SecurityError 不得被笼统归因为"安全上下文"（本地 HTTP/HTTPS 双失败的根因）', () => {
  const src = fs.readFileSync(path.join(JS_DIR, 'webauthn.js'), 'utf8');
  assert(/export\s+function\s+webauthnReadiness/.test(src), '应导出 webauthnReadiness() 做结构化就绪判定');
  assert(/export\s+function\s+isIpLiteralHost/.test(src), '应导出 isIpLiteralHost() 识别 IP 字面量主机名');
  assert(/ip_literal_rpid/.test(src), '应把「IP 作为 rpId」单列为一个可诊断的原因码');

  // SecurityError 分支内必须先做环境细分，不能再一行返回"安全上下文"文案
  const secIdx = src.indexOf("name === 'SecurityError'");
  assert(secIdx > 0, '应显式处理 SecurityError');
  const secBlock = src.slice(secIdx, secIdx + 900);
  assert(/isSecureContextOK\s*\(/.test(secBlock), 'SecurityError 分支内应区分是否真的处于非安全上下文');
  assert(/isIpLiteralHost\s*\(/.test(secBlock), 'SecurityError 分支内应区分是否因 IP 字面量导致 rpId 非法');

  // rpId 与服务端返回值的交叉校验：调用 API 前先拦截不一致
  assert(/serverRpId\s*!==\s*location\.hostname/.test(src),
    '注册前应校验服务端 rpId 与浏览器 hostname 一致，避免把 SecurityError 甩给用户');
});

test('webauthn.js：注册与验证统一走 webauthnReadiness（不再各自复制前置校验）', () => {
  const src = fs.readFileSync(path.join(JS_DIR, 'webauthn.js'), 'utf8');
  const reg = src.slice(src.indexOf('export async function registerWindowsHello'),
    src.indexOf('export async function verifyWindowsHello'));
  const ver = src.slice(src.indexOf('export async function verifyWindowsHello'));
  assert(/webauthnReadiness\s*\(/.test(reg), 'registerWindowsHello 应使用 webauthnReadiness()');
  assert(/webauthnReadiness\s*\(/.test(ver), 'verifyWindowsHello 应使用 webauthnReadiness()');
});

test('syssettings.js：编辑自己时提供与「编辑资料」一致的 Windows Hello 开关', () => {
  const src = fs.readFileSync(path.join(JS_DIR, 'syssettings.js'), 'utf8');
  // 管理员从「用户管理」点自己那行的「编辑」时，必须能看到启用开关（此前只有状态+清除按钮）
  assert(/isSelf\s*\?/.test(src), '应针对 isSelf 分支渲染不同的 Windows Hello 区块');
  assert(/id="u-f-hello"/.test(src), '编辑自己时应渲染 #u-f-hello 复选框');
  assert(/id="u-f-hello-reset"/.test(src), '编辑他人时应保留"清除凭据"救济按钮');
  // 两处入口共用同一套注册流程与就绪判定，避免判定漂移
  assert(/from\s*['"]\.\/webauthn\.js['"]/.test(src), 'syssettings.js 应从 webauthn.js 引入共享逻辑');
  assert(/registerWindowsHello/.test(src), '编辑自己时应复用 registerWindowsHello()');
  assert(/webauthnReadiness/.test(src), '应复用 webauthnReadiness() 判定可用性');
});

test('main.js 登录时按 webauthnRequired 触发 Windows Hello 第二步', () => {
  const src = fs.readFileSync(path.join(JS_DIR, 'main.js'), 'utf8');
  assert(/webauthnRequired/.test(src), 'main.js 应识别服务端的 webauthnRequired 标记');
  assert(/verifyWindowsHello/.test(src), 'main.js 应调用 verifyWindowsHello 完成第二步');
});

test('syssettings.js：管理员专属卡片集合完整（含用户管理）', () => {
  const src = fs.readFileSync(path.join(JS_DIR, 'syssettings.js'), 'utf8');
  assert(/ADMIN_ONLY_CARDS/.test(src), '应定义 ADMIN_ONLY_CARDS 用于隐藏管理员专属卡片');
  for (const card of ['sysset-user-card', 'sysset-enc-card', 'sysset-excludes-card', 'sysset-webdav-card', 'sysset-captcha-card']) {
    assert(new RegExp(card).test(src), `${card} 应纳入管理员专属集合`);
  }
  assert(/webauthnEnabled/.test(src), '用户管理应展示 Windows Hello 启用状态');
  assert(/adminDisableWebauthn/.test(src), '管理员应能清除他人的 Windows Hello 凭据');
});

test('api.js 暴露全部 Windows Hello 与自助资料接口', () => {
  const src = fs.readFileSync(path.join(JS_DIR, 'api.js'), 'utf8');
  for (const name of ['loginWebauthn', 'myProfile', 'updateMyProfile',
    'webauthnRegisterOptions', 'webauthnRegisterVerify', 'webauthnDisable', 'adminDisableWebauthn']) {
    assert(new RegExp('\\b' + name + '\\b').test(src), `api.js 应暴露 ${name}`);
  }
  assert(/auth\/login\/webauthn/.test(src), '第二步登录应打到 /auth/login/webauthn');
  assert(/webauthn\/register\/options/.test(src), '注册选项端点路径应为 /webauthn/register/options');
  assert(/webauthn\/register\/verify/.test(src), '注册校验端点路径应为 /webauthn/register/verify');
});

/* ------------------------- 会话切换的界面状态重置 ------------------------- */

/**
 * 回归：「管理员登录 → 退出 → 普通用户登录」时普通用户仍能看到全部用户、
 *      「添加用户」按钮可点、且看不到自己。
 *
 * 最终采用的方案是**结构上消除**而非状态修补：
 *   - 用户管理卡片对普通用户**整体隐藏**（只有管理员看得到）；
 *   - 普通用户的自助资料编辑改由账户菜单「编辑资料」承载（独立的 profile.js 弹窗）。
 * 这样同一张卡片不再需要同时服务两种角色，角色切换只是"显隐一个整块"，
 * 不存在需要还原的中间状态。
 *
 * 同时保留主视图重置（登出 / 登录两个时点）作为纵深防御。
 */
test('main.js 在登出与登录成功两个时点重置主视图（防跨会话越权显示）', () => {
  const src = fs.readFileSync(path.join(JS_DIR, 'main.js'), 'utf8');
  assert(/function\s+resetMainView\s*\(/.test(src), '应定义 resetMainView()');
  const body = src.slice(src.indexOf('function resetMainView'));
  const fn = body.slice(0, body.indexOf('\n}') + 2);
  assert(/id\s*!==\s*'explorer'/.test(fn), 'resetMainView 应只保留 explorer，其余一律 hidden');

  // 区块清单已抽成常量 MAIN_VIEWS（新增页面只需改一处，避免两处清单漂移）
  const decl = /const MAIN_VIEWS\s*=\s*\[([^\]]+)\]/.exec(src);
  assert(decl, '应定义 MAIN_VIEWS 常量作为主视图区块的唯一清单');
  for (const id of ['systemsettings', 'linkmgr', 'ordermgr', 'credmgr', 'dashboard']) {
    assert(decl[1].includes(`'${id}'`), `MAIN_VIEWS 应包含 ${id}（否则换账号后该区块会残留）`);
  }
  assert(/for \(const id of MAIN_VIEWS\)/.test(fn), 'resetMainView 应遍历 MAIN_VIEWS');

  const lo = src.slice(src.indexOf('function forceLogout'));
  const loFn = lo.slice(0, lo.indexOf('\n}') + 2);
  assert(/resetMainView\s*\(/.test(loFn), 'forceLogout 必须调用 resetMainView()');
  assert(/syssettings\.reset\s*\(/.test(loFn), 'forceLogout 应调用 syssettings.reset() 丢弃上一账号的渲染缓存');

  const loginIdx = src.indexOf('if (r && r.user) {');
  assert(loginIdx > 0, '应能定位登录成功分支');
  const loginBlock = src.slice(loginIdx, loginIdx + 400);
  assert(/resetMainView\s*\(/.test(loginBlock), '登录成功后必须调用 resetMainView()');
  assert(loginBlock.indexOf('resetMainView') < loginBlock.indexOf('bootstrapApp'),
    'resetMainView 应在 bootstrapApp 之前执行，避免先渲染出旧账号的界面');
});

test('syssettings.js：用户管理卡片整体归属管理员（普通用户不看、不请求）', () => {
  const src = fs.readFileSync(path.join(JS_DIR, 'syssettings.js'), 'utf8');
  // 用户卡片必须纳入管理员专属集合 —— 这是"结构上消除"的核心
  assert(/ADMIN_ONLY_CARDS\s*=\s*\[[^\]]*'sysset-user-card'/.test(src),
    'sysset-user-card 必须列入 ADMIN_ONLY_CARDS（普通用户整卡隐藏）');
  // 单一判据，避免多处判断漂移
  assert(/function\s+canManageUsers\s*\(/.test(src), '应提供 canManageUsers() 作为唯一判据');
  // 普通用户不得发起用户列表请求
  assert(/if\s*\(!canManageUsers\(\)\)\s*\{\s*reset\(\);\s*return;/.test(src),
    'loadUsers() 应在非管理员时直接 reset 并 return，不发起请求');
  // 不应再残留按角色来回切换的双形态文案
  assert(!/USER_CARD_COPY/.test(src), '不应再保留 USER_CARD_COPY（卡片已改为管理员专用，无需双形态）');
  assert(!/usersScope/.test(src), '不应再保留 usersScope（普通用户不再走这条渲染路径）');
  // 竞态保护仍在
  assert(/myId\s*!==\s*usersRenderId/.test(src), '响应回来时应比对序号，过期则丢弃');
});

test('profile.js：账户菜单「编辑资料」自助弹窗（所有角色可用）', () => {
  const src = fs.readFileSync(path.join(JS_DIR, 'profile.js'), 'utf8');
  assert(/export\s+function\s+openProfileDialog/.test(src), '应导出 openProfileDialog');
  assert(/API\.updateMyProfile/.test(src), '保存资料应走 /users/me（updateMyProfile）');
  assert(/registerWindowsHello/.test(src), '应支持自行启用 Windows Hello');
  assert(/webauthnDisable/.test(src), '取消勾选时应走 webauthnDisable 关闭');
  assert(/reauthRequired/.test(src), '改用户名后应处理 reauthRequired（强制重新登录）');
  assert(/不能自行修改/.test(src) || /role/.test(src), '应提示角色不可自行修改');
  assert(!/from\s*['"][^.'"]/.test(src), 'profile.js 不应引入外部依赖');
});

test('main.js 账户菜单接入「编辑资料」入口', () => {
  const src = fs.readFileSync(path.join(JS_DIR, 'main.js'), 'utf8');
  assert(/from\s*['"]\.\/profile\.js['"]/.test(src), 'main.js 应引入 profile.js');
  assert(/getElementById\('um-profile'\)/.test(src), '应绑定 #um-profile 菜单项');
  assert(/openProfileDialog\s*\(/.test(src), '点击「编辑资料」应调用 openProfileDialog()');
});

test('index.html 用户管理卡片与「编辑资料」菜单项就位', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert(/id="sysset-user-card"/.test(src), '应保留 id="sysset-user-card" 供整卡显隐');
  assert(/id="um-profile"[^>]*>\s*编辑资料/.test(src), '账户菜单应含「编辑资料」项');
  assert(/id="um-users"/.test(src), '账户菜单应保留「用户管理」项（仅管理员可见）');
});

/* ==================================================================
 * 管理员专属卡片：界面整卡隐藏 + 不发请求
 *
 * 「IP 访问屏蔽」的增删改与预检全部是管理员专属，规则详情还含其它用户的来源 IP。
 * 只隐藏按钮是不够的 —— 普通用户仍会看到空卡片，且列表请求必然 403。
 * 约定：卡片自身带 id，在**角色权威渲染点**（main.js renderUserMenu）统一 hidden，
 * 数据侧（bucketmgr.refreshIpGuard）发现卡片已隐藏就直接返回，不发请求。
 * ================================================================== */
test('IP 屏蔽卡片对普通用户整卡隐藏，且不发起规则请求', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const main = fs.readFileSync(path.join(JS_DIR, 'main.js'), 'utf8');
  const bm = fs.readFileSync(path.join(JS_DIR, 'bucketmgr.js'), 'utf8');

  assert(/id="ipguard-card"/.test(html), 'IP 屏蔽卡片应有 id 供整卡显隐');

  // ① 在角色权威渲染点按角色赋值（换账号不残留）
  const fn = /function renderUserMenu\(\)\s*\{([\s\S]*?)\n\}/.exec(main);
  assert(fn, 'main.js 应存在 renderUserMenu（角色权威渲染点）');
  assert(/ipguard-card[\s\S]{0,200}?hidden\s*=\s*!isAdmin/.test(fn[1]),
    'renderUserMenu 应按角色设置 IP 屏蔽卡片的 hidden');

  // ② 数据侧：卡片隐藏时直接返回，不发请求（否则必有 403 噪音与错误提示）
  const rf = /async function refreshIpGuard\(\)\s*\{([\s\S]*?)\n\}/.exec(bm);
  assert(rf, 'bucketmgr.js 应存在 refreshIpGuard');
  assert(/ipguard-card/.test(rf[1]) && /card\.hidden\)\s*return/.test(rf[1]),
    'refreshIpGuard 应在卡片隐藏时直接返回，避免无谓请求');
});

/* ==================================================================
 * 管理员专属卡片：自定义请求域名
 *
 * 保存走 PUT /api/config（requireAdmin），且域名是全局生效的共享设置。
 * 普通用户整卡隐藏（卡片带 id，由 main.js 的角色权威渲染点赋值 hidden），
 * credmgr 据此跳过域名回填，也不再拉那一次 /api/config。
 * ================================================================== */
test('自定义域名卡片对普通用户整卡隐藏，且不拉取全局配置', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const main = fs.readFileSync(path.join(JS_DIR, 'main.js'), 'utf8');
  const cm = fs.readFileSync(path.join(JS_DIR, 'credmgr.js'), 'utf8');

  assert(/id="credmgr-domain-card"/.test(html), '自定义域名卡片应有 id 供整卡显隐');

  // ① 在角色权威渲染点按角色赋值（换账号不残留）
  const fn = /function renderUserMenu\(\)\s*\{([\s\S]*?)\n\}/.exec(main);
  assert(fn, 'main.js 应存在 renderUserMenu（角色权威渲染点）');
  assert(/credmgr-domain-card[\s\S]{0,200}?hidden\s*=\s*!isAdmin/.test(fn[1]),
    'renderUserMenu 应按角色设置自定义域名卡片的 hidden');

  // ② 数据侧：卡片隐藏时不回填、也不请求（否则就是"看得见却用不了"的空壳）
  const rf = /export function refresh\(\)\s*\{([\s\S]*?)\n\}/.exec(cm);
  assert(rf, 'credmgr.js 应存在 refresh');
  assert(/credmgr-domain-card/.test(rf[1]), 'refresh 应读取卡片的 hidden 状态');
  assert(/domainVisible\s*\?\s*API\.getConfig\(\)\s*:\s*null/.test(rf[1]),
    '卡片隐藏时不应再拉取 /api/config（隐藏即不请求）');
});

/* ==================================================================
 * 「添加 / 编辑存储桶」对话框：可见性开关为管理员专属
 *
 * 服务端对非管理员走**字段白名单**，visibleToUsers 一律丢弃（SEC-01）——
 * 普通用户勾不勾结果都一样。留着这个开关只会让人以为自己能改。
 * 约定：整项按角色条件渲染（不是渲染后隐藏），提交时元素不存在即按「可见」处理。
 * ================================================================== */
test('添加存储桶对话框：管理员专属项仅管理员渲染', () => {
  const src = fs.readFileSync(path.join(JS_DIR, 'main.js'), 'utf8');
  const fn = /function openBucketDialog\(existing\)\s*\{([\s\S]*?)\n\}/.exec(src);
  assert(fn, 'main.js 应存在 openBucketDialog');

  // ① 单一判据（避免多处判断漂移）
  assert(/isAdminUser\s*=\s*!!\(App\.state\.user\s*&&\s*App\.state\.user\.role === 'admin'\)/.test(fn[1]),
    'openBucketDialog 应定义 isAdminUser 作为唯一判据');

  // ② 三处管理员专属内容都按该判据条件渲染：非管理员根本不产出这段 DOM
  //    - 访问密钥选择器：非管理员提交的 credentialId 会被服务端丢弃（SEC-01）
  //    - 从云端获取桶列表：POST /config/verify 已收回为仅管理员（SEC-11）
  //    - 对普通用户可见：同上，visibleToUsers 会被丢弃
  assert(/\$\{isEdit \|\| !isAdminUser \? '' : `[\s\S]{0,400}?bk-cred[\s\S]{0,400}?`\}/.test(fn[1]),
    '「访问密钥」选择器应由 isAdminUser 条件渲染');
  assert(/\$\{isEdit \|\| !isAdminUser \? '' : `[\s\S]{0,400}?bk-load-cloud[\s\S]{0,400}?`\}/.test(fn[1]),
    '「从云端获取桶列表」应由 isAdminUser 条件渲染');
  assert(/\$\{isAdminUser \? `[\s\S]{0,400}?bk-visible[\s\S]{0,400}?` : ''\}/.test(fn[1]),
    '「对普通用户可见」整项应由 isAdminUser 条件渲染');

  // ③ 提交时容忍元素不存在（否则非管理员点「添加」直接抛错）
  assert(/visibleEl \? visibleEl\.checked : true/.test(fn[1]),
    '提交时应容忍 #bk-visible 未被渲染，按「可见」处理');
  assert(!/querySelector\('#bk-visible'\)\.checked/.test(src),
    '不应再直接取 #bk-visible.checked（非管理员未渲染该元素会抛错）');
  assert(/credSel \? credSel\.value : ''/.test(fn[1]),
    '提交时应容忍 #bk-cred 未被渲染，按「不指定密钥」处理');
});

/* ==================================================================
 * 桶集合由管理员维护：普通用户只读
 *
 * 普通用户不知道桶名与地域，云端桶列表也不对其开放（SEC-11），
 * 因此「添加存储桶」两处入口（侧栏 + 管理页）与「解绑」按钮都不应出现 ——
 * 它们点了只会 403 或造出一条填错的桶记录。
 * ================================================================== */
test('「添加存储桶」入口仅管理员可见', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const main = fs.readFileSync(path.join(JS_DIR, 'main.js'), 'utf8');
  assert(/id="btn-bucket-add"/.test(html) && /id="btn-buckets-add"/.test(html),
    '两处「添加存储桶」按钮都应带 id 供按角色显隐');

  const fn = /function renderUserMenu\(\)\s*\{([\s\S]*?)\n\}/.exec(main);
  assert(fn, 'main.js 应存在 renderUserMenu（角色权威渲染点）');
  assert(/for \(const id of \['btn-bucket-add', 'btn-buckets-add'\]\)[\s\S]{0,160}?hidden\s*=\s*!isAdmin/.test(fn[1]),
    'renderUserMenu 应按角色隐藏两处「添加存储桶」按钮');
});

test('普通用户在存储桶管理页只读：无操作列、无解绑', () => {
  const bm = fs.readFileSync(path.join(JS_DIR, 'bucketmgr.js'), 'utf8');
  // 操作列整列按角色渲染（不是渲染后隐藏按钮）
  assert(/isAdmin\(\) \? '<th style="width:320px">操作<\/th>' : ''/.test(bm),
    '「操作」列应仅管理员渲染（普通用户没有任何可执行的操作）');
  const cell = /isAdmin\(\) \? `<td class="lk-acts">([\s\S]*?)<\/td>` : ''/.exec(bm);
  assert(cell, '操作单元格应整体由 isAdmin() 条件渲染');
  assert(/data-act="unbind"/.test(cell[1]), '解绑按钮应落在管理员专属的操作单元格内');
  // 空列表提示要分角色：普通用户不能再被引导去「添加存储桶」
  assert(/管理员尚未为你开放任何存储桶/.test(bm), '普通用户空列表应提示联系管理员开放，而不是让其自行添加');
});

/* ==================================================================
 * CSS · .form-item 的通用 label 规则必须是**直接子代**
 *
 * 用后代选择器会一并命中 .form-item 内嵌套的「label 作为卡片」组件
 * （.pv-picker > .pv-opt 厂商选择器、.enc-modes > .enc-mode-opt 加密方式），
 * 把它们从 flex 拉成 block —— 表现为厂商 LOGO 与名称挤在同一行。
 * ================================================================== */
test('CSS · .form-item 的通用 label 规则必须用直接子代（否则会命中卡片式 label）', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'style.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  // `.form-item label` / `.form-item > label` 的区分点：中间是否有 `>`
  const bad = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const raw of m[1].split(',')) {
      const sel = raw.trim().replace(/\s+/g, ' ');
      if (/\.form-item\s+label(?![\w-])/.test(sel)) bad.push(sel);
    }
  }
  assertEqual(bad.length, 0,
    `这些规则用后代选择器命中了嵌套的卡片式 label（应改为 .form-item > label）：\n  ${bad.join('\n  ')}`);
  assert(/\.form-item\s*>\s*label/.test(css), '应由 .form-item > label 提供表单标题样式');
});

/* ==================================================================
 * 卡片式主视图：容器样式必须由「类」驱动，不能是 ID 白名单
 *
 * 历史写法 `#dashboard, #bucketmgr, #linkmgr, #credmgr, #systemsettings { padding:16px }`
 * 要求每新增一个主视图都记得回来补 ID —— 订单管理页就漏了，表现为卡片直接贴边、
 * 无内边距、内容溢出不滚动（与其余页面间距明显不一致）。
 *
 * 现在统一由 `.card-view` 类驱动，护栏校验「main.js 的 MAIN_VIEWS」与
 * 「index.html 里带该类的 section」一一对应（文件浏览页 #explorer 除外，
 * 它有自己的工具栏 / 内容区 / 状态栏布局）。
 * ================================================================== */
test('卡片式主视图的容器样式由类驱动，新增视图不会漏配内边距', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const main = fs.readFileSync(path.join(JS_DIR, 'main.js'), 'utf8');
  // ⚠️ 必须剥注释后再判定：说明文字里会引用旧写法（历史上已两次出现
  // 「grep 到注释里的同名词」的假护栏），带注释扫描会永远命中。
  const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'style.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  const mv = /MAIN_VIEWS\s*=\s*\[([^\]]+)\]/.exec(main);
  assert(mv, 'main.js 应定义 MAIN_VIEWS（主视图清单）');
  const views = [...mv[1].matchAll(/'([\w-]+)'/g)].map((m) => m[1]);
  assert(views.length >= 6, `MAIN_VIEWS 应覆盖全部主视图，实际 ${views.length} 个`);

  // ① 样式必须由类提供，且确实带内边距（否则整页卡片贴边）
  assert(/\.card-view\s*\{[^}]*padding:\s*16px/.test(css), 'CSS 应由 .card-view 提供 16px 内边距');
  assert(!/#dashboard\s*,\s*#bucketmgr/.test(css), '不应再保留主视图的 ID 白名单写法（漏配的根源）');

  // ② 每个主视图 section 都必须在 index.html 里带上该类（explorer 除外）
  const missing = [];
  for (const id of views) {
    if (id === 'explorer') continue;
    const tag = new RegExp(`<section\\s+id="${id}"[^>]*>`).exec(html);
    if (!tag) { missing.push(`${id}（section 不存在）`); continue; }
    if (!/class="[^"]*\bcard-view\b[^"]*"/.test(tag[0])) missing.push(id);
  }
  assertEqual(missing.length, 0,
    `这些主视图的 <section> 缺少 class="card-view"，会导致该页无内边距/不滚动：${missing.join('、')}`);

  // ③ 反向：带了该类却不在 MAIN_VIEWS 里的，说明清单与页面已经漂移
  const tagged = [...html.matchAll(/<section\s+id="([\w-]+)"[^>]*class="[^"]*\bcard-view\b[^"]*"/g)].map((m) => m[1]);
  const stray = tagged.filter((id) => !views.includes(id));
  assertEqual(stray.length, 0, `带 card-view 的 section 不在 MAIN_VIEWS 中：${stray.join('、')}`);
});

/* ==================================================================
 * CSS · 「label 内嵌 checkbox」不得被 .form-item 的输入框样式命中
 *
 * `.form-item input { width:100%; height:34px; border:... }` 会命中文档流里
 * **任何**后代 input，于是 `.check-line` / `.u-hello-label` 这种写法里的复选框
 * 被拉成一个整行的大方框。这个坑已复发三次（Windows Hello 开关、权限穿梭框、
 * 登录页「记住登录状态」），根因都是「后来补的覆盖规则权重相同或更低」。
 *
 * 这里按**选择器结构**判定（而非 grep 关键词）：凡作用域含 .form-item、
 * 且以「无类型限定的裸 input」结尾的规则，必须显式排除 checkbox；
 * 裸 label 同理必须排除 .check-line。分析器本身也用小样例自测，
 * 避免它退化成「什么都检不出」的假护栏。
 * ================================================================== */

/** 从规则体里找出「会把 checkbox 拉成整行输入框」的选择器 */
function findCheckboxStompers(css) {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, ''); // 去注释，注释里的示例不得参与判定
  const NOT_CB = /:not\(\s*\[type=["']?checkbox["']?\]\s*\)/i;
  const NOT_CL = /:not\(\s*\.check-line\s*\)/;
  const bad = [];
  for (const m of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const rawSel of m[1].split(',')) {
      const sel = rawSel.trim().replace(/\s+/g, ' ');
      if (!sel.includes('.form-item')) continue;
      const tokens = sel.split(' ');
      const last = tokens[tokens.length - 1];
      const base = last.replace(NOT_CB, '').replace(NOT_CL, '');
      if (/\[/.test(base)) continue;               // 带类型/属性限定 → 不是「通吃」规则
      // 仅当该选择器**通吃**这类元素（既没排除 checkbox，也不是专门针对它）时才算隐患
      const targeted = NOT_CB.test(last) || NOT_CL.test(last) || /\.(check-line|u-hello-label)\b/.test(last);
      if (targeted) continue;
      if (/^input(\b|:)/.test(base) || /^label(\b|:)/.test(base)) bad.push(sel);
    }
  }
  return bad;
}

test('CSS · .form-item 的输入框样式不得命中复选框（复选框被拉成整行）', () => {
  // ① 分析器自测：典型坏规则必须被检出，已知的合规写法必须放行
  assertEqual(
    findCheckboxStompers('.form-item input { width:100%; height:34px; }').length, 1,
    '分析器应能检出「裸 input」规则');
  assertEqual(
    findCheckboxStompers('.form-item label { display:block; }').length, 1,
    '分析器应能检出「裸 label」规则');
  assertEqual(
    findCheckboxStompers('.form-item input:not([type="checkbox"]) { width:100% }').length, 0,
    '已排除 checkbox 的规则不应被误报');
  assertEqual(
    findCheckboxStompers('.form-item .u-hello-label input[type="checkbox"] { width:16px }').length, 0,
    '明确针对 checkbox 的规则不应被误报');
  assertEqual(
    findCheckboxStompers('.perm-search input { width:100% }').length, 0,
    '不在 .form-item 作用域内的规则不应被误报');
  assertEqual(
    findCheckboxStompers('.form-item label.check-line { display:inline-flex }').length, 0,
    '专门针对 .check-line 的复位规则不应被误报');

  // ② 真实样式表：不允许存在任何「通吃」规则
  const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'style.css'), 'utf8');
  const bad = findCheckboxStompers(css);
  assertEqual(bad.length, 0,
    `这些规则会把 label 内嵌的复选框拉成整行输入框，必须加 :not([type="checkbox"]) / :not(.check-line)：\n  ${bad.join('\n  ')}`);
});

/* ==================================================================
 * 前端 · 请求序号自增不得早于早退校验（RE-02，与 FUN-09 同型）
 *
 * 序号模式的正确写法是「确认会发请求之后才自增」：
 *
 *     if (!还能发请求) return;        // ← 早退分支
 *     const seq = ++loadSeq;          // ← 自增
 *     const r = await API.xxx(...);   // ← 真正发起请求
 *
 * 反过来写（先自增、再校验）有两个后果，而且都不是"轻微"的：
 *   ① 在途的 refresh / loadMore 被这次自增判成过期 → 它们的响应被丢弃；
 *   ② 而自己又不发请求 → 没有谁再到 finally 里把 state.loading 复位，
 *      「加载更多」于是永久点不动（界面卡死，只能刷新页面）。
 *
 * explorer.search() 的「条件为空 / 未配置」两个早退分支就踩了这个坑 ——
 * 正是 FUN-09 那一轮改动在 refresh / loadMore 上做了、却在 search 上漏掉的同一个模式。
 *
 * 这里按**结构不变量**判定（不是 grep 某个关键词）：自增与其后首个请求发起
 * 之间不得出现 return。分析器自带样例自测，避免退化成假护栏。
 * ================================================================== */

/** 前端异步列表用到的序号变量（新增时请同步加入，否则该处不受护栏覆盖） */
const SEQ_VARS = 'loadSeq|statsSeq|storageSeq|summarySeq|usersRenderId';

/**
 * 去注释，但**保留每个字符的原始偏移**（注释内容替换为等长空白）。
 * — 必须去注释：`const seq = ++loadSeq; // 不再用 if (loading) return 丢弃意图`
 *   这种说明性注释里就带着 return，带注释扫描会永远误报（本项目已三次踩到这个坑）。
 * — 必须保留偏移：这样才能报出准确行号。
 */
function blankComments(src) {
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:\w])\/\/[^\n]*/g, blank);
}

/**
 * 找出「序号自增后、首个请求发起前夹着 return」的位置。
 *
 * 窗口口径：自增之后，到「首个请求发起」或「所在函数收尾」为止，取更早的那个。
 * — 必须给窗口封顶在函数收尾处：若某处自增后本函数内根本没发请求，无封顶的窗口
 *   会一路漫到后面的函数里去，把它们的 return 误判成本次违规。
 * — ⚠️ 不能只用一个固定字符数当窗口：`search()` 的守卫前导（空条件 / 未配置两个
 *   早退分支）有 ~480 字符，400 字符的小窗口会让它整体漏检 —— 反向对照时这条
 *   变异正是这样逃过护栏的（护栏自己先"绿"了，等于没写）。
 * @returns {{line:number, text:string}[]} 空数组表示合规
 */
function findSeqBumpBeforeGuard(src) {
  const code = blankComments(src);
  const re = new RegExp(`\\+\\+\\s*(?:${SEQ_VARS})\\b`, 'g');
  const bad = [];
  let m;
  while ((m = re.exec(code))) {
    const after = code.slice(m.index + m[0].length);
    // 请求发起点：await 或 Promise 风格的 .then(
    const req = /(\bawait\b|\.then\s*\()/.exec(after);
    // 函数收尾：顶格或两格缩进的右花括号（对象方法 / 顶层函数）
    const fnEnd = /\n\s{0,2}\}/.exec(after);
    const bounds = [req && req.index, fnEnd && fnEnd.index].filter((i) => typeof i === 'number' && i >= 0);
    const end = bounds.length ? Math.min.apply(null, bounds) : after.length;
    const guard = after.slice(0, end);
    if (!/\breturn\b/.test(guard)) continue;
    bad.push({
      line: code.slice(0, m.index).split('\n').length,
      text: (guard.trim().split('\n')[0] || '').slice(0, 90),
    });
  }
  return bad;
}

test('前端 · 请求序号自增必须在早退校验之后（否则在途请求被作废、loading 卡死）', () => {
  // ① 分析器自测：典型坏写法必须被检出，合规写法必须放行
  assertEqual(
    findSeqBumpBeforeGuard('async function f(){ const seq = ++loadSeq; if (!q) return; await API.list({}); }').length,
    1, '应检出「先自增、后早退」的写法');
  assertEqual(
    findSeqBumpBeforeGuard('async function f(){ if (!q) return; const seq = ++loadSeq; await API.list({}); }').length,
    0, '校验在自增之前 → 合规');
  assertEqual(
    findSeqBumpBeforeGuard(
      'async function f(){\n  const seq = ++loadSeq; // 不再用 if (loading) return 丢弃意图\n  await API.list({});\n}').length,
    0, '注释里出现的 return 不得触发误报');
  assertEqual(
    findSeqBumpBeforeGuard('function f(){ const seq = ++statsSeq; box.innerHTML = "x"; API.bucketStats().then((r) => {}); }').length,
    0, 'Promise 风格（.then）也应被认作请求发起点');
  assertEqual(
    findSeqBumpBeforeGuard('function f(){ if (!x) { reset(); return; } const myId = ++usersRenderId; await API.users(); }').length,
    0, '早退分支在自增之前（即便带花括号）也合规');
  // 长前导：窗口若按固定字符数截断就会整体漏检（RE-02 真实形状）
  const longPrologue = [
    '  async search(opt) {',
    '    const seq = ++loadSeq;',
    "    const q = document.getElementById('search-input').value.trim();",
    '    const f = window.__filter || {};',
    '    if (!opt.cont) {',
    '      if (!q && !f.type && !f.from && !f.to && !f.minMB && !f.maxMB) return;',
    '      if (!App.state.config || !App.state.config.configured) return ops.needConfig();',
    '      state.searchCursor = ""; state.searchMatches = []; state.searchScanned = 0;',
    '    }',
    '    state.loading = true;',
    '    try {',
    '      const r = await API.search({ prefix: App.state.prefix, q });',
    '    } finally { /**/ }',
    '  },',
  ].join('\n');
  assertEqual(findSeqBumpBeforeGuard(longPrologue).length, 1,
    '守卫前导很长（>400 字符）时也必须检出 —— 短窗口会让 RE-02 这类真实形状整体漏检');

  // ② 真实源码
  const bad = [];
  for (const f of MODULES) {
    for (const hit of findSeqBumpBeforeGuard(fs.readFileSync(path.join(JS_DIR, f), 'utf8'))) {
      bad.push(`${f}:${hit.line} → ${hit.text}`);
    }
  }
  assertEqual(bad.length, 0,
    '这些地方先自增序号再做早退校验：不发请求却让在途请求的结果作废，且 loading 永远不会复位'
    + `（表现为「加载更多」点不动）：\n  ${bad.join('\n  ')}`);
});

/* ===================== 搜索：请求可取消 / 单轮条数 / 搜索范围 ===================== */

/**
 * 抽取 `async search(...)` 的方法体（跳过参数括号后再配平花括号）。
 *
 * 用配平而不是「截到下一个 `},`」：search 内部有 catch/finally 嵌套，
 * 按缩进截会在第一个内层块就提前收尾，断言范围缩水、反向对照时漏检。
 */
function extractMethodBody(code, at) {
  let i = code.indexOf('(', at);
  let depth = 0;
  for (; i < code.length; i++) {
    if (code[i] === '(') depth += 1;
    else if (code[i] === ')') { depth -= 1; if (depth === 0) { i += 1; break; } }
  }
  const start = code.indexOf('{', i);
  if (start < 0) return '';
  let d = 0;
  for (let j = start; j < code.length; j++) {
    if (code[j] === '{') d += 1;
    else if (code[j] === '}') { d -= 1; if (d === 0) return code.slice(start, j + 1); }
  }
  return '';
}

/**
 * 检查 `search()` 是否具备「请求可取消 + 单轮限流 + 搜索范围」三要素。
 *
 * 与 `findSeqBumpBeforeGuard` 同一口径：只看 search 自己的方法体 ——
 * 全文 grep 会被别处的同名调用（navigate/exitSearch 里的 abortInFlightSearch）蒙混过去。
 * @returns {string[]} 缺失项清单，空数组表示合规
 */
function searchAbortChecklist(src) {
  const code = blankComments(src);
  const at = code.search(/async\s+search\s*\(/);
  if (at < 0) return ['未找到 search()'];
  const body = extractMethodBody(code, at);
  if (!body) return ['无法解析 search() 方法体'];
  const miss = [];
  if (!/abortInFlightSearch\s*\(\s*\)/.test(body)) miss.push('未在 search() 内取消在途搜索（abortInFlightSearch）');
  if (!/new\s+AbortController\s*\(\s*\)/.test(body)) miss.push('未创建 AbortController');
  if (!/\bsignal\s*:/.test(body)) miss.push('signal 未透传给请求（前端取消传不到网络层，服务端也无从停止翻页）');
  if (!/AbortError/.test(body)) miss.push('catch 未识别 AbortError（取消会被当成故障弹「无法连接本地服务」）');
  if (!/\blimit\s*:\s*[1-9]\d{0,2}\b/.test(body)) miss.push('未把单轮 limit 压到 200 量级（单次渲染 DOM 与云端翻页数都会翻倍）');
  if (!/searchCurrentOnly/.test(body)) miss.push('未把搜索范围（scope）随请求发出');
  return miss;
}

test('前端 · search() 具备请求取消 / 单轮限流 / 搜索范围三要素', () => {
  // ① 分析器自测：每个要素各造一个缺失样例，确认都能被检出
  const okBody = [
    'async search() {',
    '  abortInFlightSearch();',
    '  const ac = new AbortController();',
    '  try {',
    '    const r = await API.search({ limit: 200, scope: App.state.searchCurrentOnly ? "current" : "" }, { signal: ac.signal });',
    '  } catch (e) { if (e.name === "AbortError") return; }',
    '}',
  ].join('\n');
  assertEqual(searchAbortChecklist(okBody).length, 0, `完整实现应判定合规（实际缺失：${searchAbortChecklist(okBody).join('；')}）`);
  assert(searchAbortChecklist(okBody.replace('abortInFlightSearch();', '')).length === 1, '缺「取消在途搜索」应被检出');
  assert(searchAbortChecklist(okBody.replace(/signal: ac\.signal/, '')).length === 1, '缺 signal 透传应被检出');
  assert(searchAbortChecklist(okBody.replace('AbortError', 'OtherError')).length === 1, '缺 AbortError 识别应被检出');
  assert(searchAbortChecklist(okBody.replace('limit: 200', 'limit: 1000')).length === 1, 'limit 未压到 200 量级应被检出');
  assert(searchAbortChecklist(okBody.replace(/scope: [^,]+,/, '')).length === 1, '缺搜索范围应被检出');
  // 别处的同名调用不得让检查蒙混过关（这是限定方法体的意义所在）
  const outside = searchAbortChecklist('function navigate(){ abortInFlightSearch(); }\nasync search(){ await API.search({}); }');
  assert(outside.length >= 4,
    `方法体外的 abortInFlightSearch 不应算作 search 的取消措施（实际只检出 ${outside.length} 项：${outside.join('；')}）`);

  // ② 真实源码
  const miss = searchAbortChecklist(fs.readFileSync(path.join(JS_DIR, 'explorer.js'), 'utf8'));
  assertEqual(miss.length, 0,
    `explorer.js 的 search() 缺少以下改进项：\n  ${miss.join('\n  ')}`);
});

/* ===================== 订单管理：退款（纯函数行为断言） ===================== */

/**
 * `ordermgr.js` 的统计与操作列渲染是本 bour 次改动里最容易写错的地方（金额是否扣除退款、
 * 按钮是否对非支付订单出现），抽成纯函数后可以直接驱动 —— 无需 DOM。
 */
async function loadOrderMgr() {
  return import(pathToFileURL(path.join(JS_DIR, 'ordermgr.js')).href);
}

test('订单管理 · 退款按钮只出现在「已支付」的订单行', async () => {
  const m = await loadOrderMgr();
  assert(/data-act="refund"/.test(m.fmtActions({ status: 'paid' })),
    '已支付订单必须提供退款按钮');
  // 其余三种状态：按钮一旦给出，点了就是 400，比没有按钮更糟
  for (const st of ['pending', 'failed', 'refunded']) {
    assert(!/data-act="refund"/.test(m.fmtActions({ status: st })),
      `${st} 状态的订单不应给出退款按钮（服务端也会拒绝，属无效操作）`);
  }
  assert(!/data-act="refund"/.test(m.fmtActions(null)), '空订单不得渲染出按钮');
});

test('订单管理 · 已收款统计扣除已退款金额，退款金额单独列出', async () => {
  const m = await loadOrderMgr();
  const t = m.computeTotals([
    { status: 'paid', amountFen: 1000 },
    { status: 'refunded', amountFen: 250 },
    { status: 'pending', amountFen: 9999 }, // 支付中不得计入收入
    { status: 'failed', amountFen: 8888 },
  ]);
  assertEqual(t.receivedFen, 1000,
    '「已收」只能统计仍处于已支付状态的订单 —— 退款后仍计入等于账面虚高');
  assertEqual(t.refundedFen, 250, '已退款金额应单独汇总，便于核对总额为何减少');
  assertEqual(t.count, 4, '笔数应统计全部订单');

  // 退款后重算：同一批订单少了 250 元收入
  const before = m.computeTotals([{ status: 'paid', amountFen: 1000 }]);
  const after = m.computeTotals([{ status: 'refunded', amountFen: 1000 }]);
  assertEqual(before.receivedFen, 1000, '退款前应计入已收');
  assertEqual(after.receivedFen, 0, '退款后这笔钱不再算作已收（用户要求的「已收xx元应减少」）');
  assertEqual(after.refundedFen, 1000, '退款金额应出现在退款小计里');

  // 空 / 脏数据不得抛异常（界面刷新时可能拿到空数组）
  assertEqual(m.computeTotals([]).receivedFen, 0, '空列表应返回 0 而不是抛错');
  assertEqual(m.computeTotals(null).receivedFen, 0, '非数组入参不得崩溃');
  assertEqual(m.computeTotals([{ status: 'paid' }]).receivedFen, 0, '缺少金额字段按 0 处理');
});

test('订单管理 · 已退款订单整行划线失效（row-refunded）', async () => {
  const m = await loadOrderMgr();
  assertEqual(m.rowClassOf({ status: 'refunded' }), 'row-refunded',
    '已退款订单的行必须带 row-refunded（CSS 负责整行置灰 + 数据列划线）');
  for (const st of ['pending', 'paid', 'failed']) {
    assertEqual(m.rowClassOf({ status: st }), '', `${st} 状态的订单行不应被划线失效`);
  }
  assertEqual(m.rowClassOf(null), '', '空订单不应产生行样式类');
});

test('订单管理 · 退款前有二次确认，且文案讲明本系统不代持资金', () => {
  // confirmDialog 依赖 DOM，无法在 Node 里驱动，这里退化为「结构 + 文案」断言。
  // 作用域限定在 refund() 方法体（配平花括号），否则任何别处的 confirmDialog 都会让它空过。
  const code = blankComments(fs.readFileSync(path.join(JS_DIR, 'ordermgr.js'), 'utf8'));
  const at = code.search(/async\s+function\s+refund\s*\(/);
  assert(at >= 0, 'ordermgr.js 应存在 refund() 函数');
  const body = extractMethodBody(code, at);
  assert(body, '应能解析出 refund() 方法体');

  assert(/confirmDialog\s*\(/.test(body),
    '退款必须走二次确认对话框 —— 一个不可逆的终态切换不该点一下就生效');
  assert(/danger\s*:\s*true/.test(body), '确认框必须标记为危险操作（视觉警示 + 非默认焦点）');
  assert(/API\.refundOrder\s*\(/.test(body), '必须调用服务端退款接口，而不是前端本地改状态');
  assert(/REFUND_NOTICE/.test(body), '确认文案必须真正被用上（只定义不引用等于没有）');

  // 文案本身是安全边界：少了它，管理员会以为点一下钱就自动退回去了
  const notice = /const REFUND_NOTICE = '([^']+)'/.exec(code);
  assert(notice, '应存在 REFUND_NOTICE 常量');
  assert(/不代持资金/.test(notice[1]), '文案必须说明本系统不代持资金');
  assert(/已在其它渠道退还钱款给下载者/.test(notice[1]), '文案必须说明退款发生在其它渠道');
  assert(/仅作记账和标记/.test(notice[1]), '文案必须点明本步只作记账');
});

test('前端 · 主动取消请求不得被误报为「无法连接本地服务」', async () => {
  const api = await import(pathToFileURL(path.join(JS_DIR, 'api.js')).href);
  assert(typeof api.API.search === 'function', 'API.search 应存在');

  const seen = [];
  const prevFetch = global.fetch;
  // 打桩一个「永不返回、只等 abort」的 fetch —— 取消行为与真实网络无关，
  // 这样既不依赖网络，也不依赖任何墙钟。
  global.fetch = async (_url, opt) => {
    seen.push(opt);
    return new Promise((_resolve, reject) => {
      opt.signal.addEventListener('abort', () => {
        const e = new Error('The user aborted a request.');
        e.name = 'AbortError';
        reject(e);
      });
    });
  };

  try {
    const ac = new AbortController();
    const p = api.API.search({ prefix: 'a/', q: 'x' }, { signal: ac.signal });
    await new Promise((r) => setImmediate(r)); // 让 fetch 真的发起
    ac.abort();
    let caught = null;
    try { await p; } catch (e) { caught = e; }

    assertEqual(seen.length, 1, '应发起一次 fetch');
    assertEqual(seen[0].signal, ac.signal,
      'signal 必须透传给 fetch —— 传不下去，前端的取消就到不了网络层，服务端也就不会停止翻页');
    assert(caught, '取消后应抛出异常（否则调用方会拿着 undefined 继续渲染）');
    assertEqual(caught.name, 'AbortError',
      '取消产生的错误必须保持 AbortError（被改写成「无法连接本地服务」会严重误导用户）');
    assert(!/无法连接/.test(caught.message), `错误文案不得是「无法连接本地服务」：${caught.message}`);
  } finally {
    if (prevFetch === undefined) delete global.fetch;
    else global.fetch = prevFetch;
  }
});

/* ============ R9-10 · 加密下载「用户取消密码验证」不得落进 blob 回退 ============ */

/**
 * 报告 §2 的 R9-10：`openDownload()` 的流式分支有一个 catch，把「其余错误」一律
 * 回退到 blob 方式。用户取消密码验证时旧实现抛的是普通 `Error('下载失败（HTTP 401）')`,
 * 于是被自己的 catch 接住 → ① 走 blob 分支**再 fetch 一次** → 再 401 → 密码框弹第二次；
 * ② 本次下载被静默降级为「整文件读进内存」。
 *
 * 这条护栏的作用域必须**限定在 `openDownload()` 的方法体**内（配平花括号）：
 * 全文 grep `CANCELLED` 会被常量定义那一行蒙混过去（正是"grep 到同名词"的假护栏）。
 *
 * @returns {string[]} 缺失项清单，空数组表示合规
 */
function openDownloadCancelChecklist(src) {
  const code = blankComments(src);
  const at = code.search(/async\s+function\s+openDownload\s*\(/);
  if (at < 0) return ['未找到 openDownload()'];
  const body = extractMethodBody(code, code.indexOf('(', at));
  if (!body) return ['无法解析 openDownload() 方法体'];
  const miss = [];

  // ① 必须存在哨兵与识别函数（哨兵本身可以定义在函数体外，这里只看是否被**用到**）
  if (!/isCancelled\s*\(/.test(body)) {
    miss.push('openDownload() 内未使用 isCancelled() 识别「用户取消」哨兵');
  }

  // ② 流式分支：取消时必须以哨兵结束，不得落到 catch 的 blob 回退
  const streamTry = /if\s*\(\s*res\.status\s*===\s*401[\s\S]{0,300}?throw\s+CANCELLED/.test(body);
  if (!streamTry) {
    miss.push('流式分支 401 时未抛 CANCELLED 哨兵（用户取消会被当成 HTTP 401 错误）');
  }

  /**
   * ③ 流式分支的 catch 里必须先识别哨兵并 return。
   *
   * ⚠️ 必须**锚定在流式分支自己的 catch** 上：`openDownload` 里有两个 catch，
   * 后一个（blob 分支）也含 `isCancelled(e)`。若用「某个 catch 之后 400 字符内出现
   * isCancelled」这种宽窗口，删掉前一个 catch 的判断后仍会被后一个蒙混过去
   * （窗口过宽 → 假护栏，正是第 9 轮 §4 点名的失效模式）。
   *
   * 切分点：流式分支以 `showSaveFilePicker` 起、以 blob 分支的 `res.blob()` 止。
   * 用**代码**标记（而非注释）作为边界 —— 注释已被 `blankComments` 清掉。
   */
  const streamStart = body.indexOf('showSaveFilePicker');
  const blobStart = body.indexOf('res.blob()');
  const streamSeg = (streamStart >= 0 && blobStart > streamStart)
    ? body.slice(streamStart, blobStart)
    : '';
  if (!streamSeg) {
    miss.push('无法切出流式分支（未找到 showSaveFilePicker / res.blob() 边界）');
  } else if (!/catch\s*\([^)]*\)\s*\{[\s\S]{0,300}?if\s*\(\s*isCancelled\s*\(\s*[A-Za-z_$][\w$]*\s*\)\s*\)\s*return\s*;/.test(streamSeg)) {
    miss.push('流式分支的 catch 未在回退到 blob 之前拦下 CANCELLED（会弹第二次密码框 + 降级为整文件入内存）');
  }

  // ④ blob 分支内 handleUnauthorized 返回 false（用户取消）时不得继续
  if (!/handleUnauthorized[\s\S]{0,120}?\)\s*\)\s*return\s*;/.test(body)) {
    miss.push('blob 分支未在用户取消（handleUnauthorized 返回 false）时结束');
  }
  return miss;
}

test('前端 · 加密下载必须把「用户取消密码验证」与「验证失败」分开（不落 blob 回退）', () => {
  const src = fs.readFileSync(path.join(JS_DIR, 'enc.js'), 'utf8');
  const miss = openDownloadCancelChecklist(src);
  assertEqual(miss.length, 0,
    'R9-10 缺失项：\n  ' + miss.join('\n  '));

  // 正向确认哨兵本身存在（上面只验证「被用到」，这里验证「有定义」）
  assert(/__encCancelled\s*:\s*true/.test(src),
    'R9-10：应存在带标记的 CANCELLED 哨兵对象（用对象而非字符串，避免与普通错误文案撞车）');
});

test('R9-10 · 样例自测：分析器能命中被证伪的写法，也能放行修正后的写法', () => {
  const bad = [
    'async function openDownload(key, isRetry) {',
    '  if (typeof window.showSaveFilePicker === "function") {',
    '    try {',
    '      const res = await fetch(url);',
    '      if (res.status === 401 && !isRetry) {',
    '        if (!(await handleUnauthorized(res))) throw new Error("下载失败（HTTP 401）");',
    '        return await openDownload(key, true);',
    '      }',
    '    } catch (e) {',
    '      if (e && e.name === "AbortError") return;',
    '    }',
    '  }',
    '  try {',
    '    const res = await fetch(url);',
    '    if (res.status === 401 && !isRetry) { await handleUnauthorized(res); return await openDownload(key, true); }',
    '    const blob = await res.blob();',
    '  } catch (e) { toast("x"); }',
    '}',
  ].join('\n');
  const good = [
    'const CANCELLED = { __encCancelled: true };',
    'function isCancelled(e) { return !!(e && e.__encCancelled); }',
    'async function openDownload(key, isRetry) {',
    '  if (typeof window.showSaveFilePicker === "function") {',
    '    try {',
    '      const res = await fetch(url);',
    '      if (res.status === 401 && !isRetry) {',
    '        if (!(await handleUnauthorized(res))) throw CANCELLED;',
    '        return await openDownload(key, true);',
    '      }',
    '    } catch (e) {',
    '      if (e && e.name === "AbortError") return;',
    '      if (isCancelled(e)) return;',
    '    }',
    '  }',
    '  try {',
    '    const res = await fetch(url);',
    '    if (res.status === 401 && !isRetry) {',
    '      if (!(await handleUnauthorized(res))) return;',
    '      return await openDownload(key, true);',
    '    }',
    '    const blob = await res.blob();',
    '  } catch (e) { toast("x"); }',
    '}',
  ].join('\n');

  assert(openDownloadCancelChecklist(bad).length > 0,
    '样例自测失败：把 R9-10 退回旧实现后，分析器必须报出缺失项（否则这条护栏形同虚设）');
  assertEqual(openDownloadCancelChecklist(good).length, 0,
    '样例自测失败：修正后的写法必须被放行（否则护栏会误报，团队会学会忽略红灯）');

  /**
   * 追加一条**窄窗口自证**：只删掉流式分支 catch 里的判断、保留 blob 分支的判断时，
   * 分析器仍必须报红 —— 否则就是「窗口过宽 → 被后一个 catch 蒙混过去」的假护栏。
   */
  const narrow = good.replace('      if (isCancelled(e)) return;\n', '');
  assert(openDownloadCancelChecklist(narrow).length > 0,
    '样例自测失败：只去掉流式分支 catch 的判断（blob 分支仍有）时，'
    + '分析器必须报红 —— 否则窗口过宽，删掉接线后会被后一个 catch 蒙混过去');
});

