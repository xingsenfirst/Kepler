/**
 * 第 16 轮审计 · WebDAV「服务器地址」回归护栏（D2-01 ~ D2-05）
 *
 * ## 现场故障
 * 服务器端部署完成后，界面「系统设置 → WebDAV」里的**服务器地址恒为
 * `https://localhost:8443/dav/`**，用户把它填进 Windows 资源管理器 / macOS Finder
 * 必然连不上 —— 于是结论是「WebDAV 功能坏了」，而实际上一个配置项都没填错。
 *
 * ## 根因（两处，缺一不可）
 *  ① **地址来源错**：`serverUrl()` 只拼「监听地址 + 端口」。部署时 `.env` 写的是
 *     `HOST=0.0.0.0`，于是回落成 `localhost` —— 那是**服务器自己**的回环地址；
 *     客户端要填的是「用户此刻访问面板的那个域名」。
 *  ② **反代缺失**：Nginx 模板里的 `/dav/` 反代是一段**注释**，等用户「按提示
 *     手动取消注释」。即使地址给对了，`https://<域名>/dav/` 也会 404。
 *     两处叠加：界面上有地址、状态显示绿色「服务运行中」，但没有任何可达路径。
 *
 * ## 本文件钉住的契约
 *  - 部署脚本生成的 Nginx 配置**默认**就把 `/dav` 反代到 `WEBDAV_PORT`，且端口只有一个
 *    事实来源（`WEBDAV_PORT` 变量被 `.env` 与 Nginx 上游共用，不允许各写一份 8443）；
 *  - `.env` 必须同时产出 `WEBDAV_PORT` 与对外基地址 `WEBDAV_PUBLIC_URL`；
 *  - `serverUrl(req)` 必须优先用对外基地址 / 请求域名，经反代时**不允许**吐出
 *    `localhost`、`127.0.0.1` 这类监听地址；
 *  - 路由层必须把 `req` 传下去（不传就退化成监听地址，静态看不出、界面照常显示）；
 *  - 前端兜底不得写死 `<本机IP>:端口`（那是伪地址，是误导性建议）。
 *
 * 隔离与成本：所有 shell 断言在**同一个** bash 子进程里渲染（脚本 3300 余行，
 * Git Bash 每次进程启动约 8 秒，拆成多次会把测试时间拉成分钟级），
 * `write_file` 被替换成写临时文件，绝不触碰真实部署路径；
 * WebDAV 模块在 `COS_DATA_DIR` 临时目录下加载（见 helpers.js）。
 * ------------------------------------------------------------------ */
const fs = require('fs');
const path = require('path');
const assert = require('node:assert');
const test = require('node:test');
const { spawn } = require('node:child_process');

require('./helpers'); // 兜底 COS_DATA_DIR 到临时目录（store 层不写生产 data/）

const ROOT = path.join(__dirname, '..');
const WEBDAV_SERVER = path.join(ROOT, 'server', 'webdav-server.js');
const ROUTES_WEBDAV = path.join(ROOT, 'server', 'routes', 'webdav.js');
const PUBLIC_SETTINGS = path.join(ROOT, 'public', 'js', 'syssettings.js');

const read = (p) => fs.readFileSync(p, 'utf8');

/**
 * 渲染源码时先把注释剥掉再断言。
 *
 * 本项目的注释习惯是**举反例**（「旧实现写死 `https://<本机IP>:...`」这类），
 * 不剥注释就会把「注释里提到的坏写法」当成真的坏写法，护栏自己把自己搞红。
 * 只剥「整行注释」（`//` 开头、块注释的 `*` / `/*` 续行），不动行尾注释与字符串。
 */
function stripLineComments(src) {
  return String(src).split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
}

/**
 * 在 bash 里 source 部署脚本、替换掉落盘动作，一次性渲染出全部需要的产物。
 *
 * 用**异步 spawn**：本机 `spawnSync` 对 node/bash 一律 `EBUSY`（Windows 环境性限制），
 * 只有异步形式能真正拿到子进程输出。这是本项目写 shell 行为断言时的既定手法。
 */
function renderAll() {
  const script = `
set +e
source ./deploy.sh
set +e
OUT="$(mktemp)"
TMPD="$(mktemp -d)"
write_file() { printf '%s' "$2" > "$OUT"; }
DOMAIN="pan.example.com"
APP_PORT=3000
HTTP_PORT=80
HTTPS_PORT=443
TLS_MODE="acme"
SKIP_NGINX=0
MODE="docker"
SUB_PATH="/"
NGINX_BIN=""
NGINX_CONF="$OUT"
NGINX_LINK=""
INSTALL_DIR="$TMPD"
DATA_DIR="$TMPD/data"
sec() { printf '\\n@@%s@@\\n' "$1"; }
cert="/etc/kepler/ssl/fullchain.pem"
key="/etc/kepler/ssl/key.pem"

sec NGINX_TLS;      write_nginx_conf 1 "$cert" "$key"; cat "$OUT"
sec NGINX_HTTP;     write_nginx_conf 0 "" ""; cat "$OUT"
WEBDAV_PORT=9443
sec NGINX_TLS_9443; write_nginx_conf 1 "$cert" "$key"; cat "$OUT"
WEBDAV_PORT=8443

sec ENV_DEFAULT;    gen_env_file; cat "$OUT"
WEBDAV_PORT=9443
sec ENV_WEBDAV9443; gen_env_file; cat "$OUT"
WEBDAV_PORT=8443
HTTPS_PORT=8443
sec ENV_TLS8443;    gen_env_file; cat "$OUT"
HTTPS_PORT=443
TLS_MODE="none"; HTTP_PORT=8080
sec ENV_HTTP8080;   gen_env_file; cat "$OUT"
TLS_MODE="acme"; HTTP_PORT=80
SKIP_NGINX=1
sec ENV_SKIPNGINX;  gen_env_file; cat "$OUT"

rm -rf "$TMPD" "$OUT"
`;
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', script], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({ unavailable: e.code || String(e) }));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

/** 按 `@@名字@@` 切分渲染结果 */
function splitSections(out) {
  const map = {};
  let name = null;
  let buf = [];
  for (const line of String(out).split('\n')) {
    const m = /^@@([A-Z0-9_]+)@@$/.exec(line.trim());
    if (m) {
      if (name) map[name] = buf.join('\n');
      name = m[1];
      buf = [];
      continue;
    }
    if (name) buf.push(line);
  }
  if (name) map[name] = buf.join('\n');
  return map;
}

/** 模块级缓存：整个文件只起一个 bash 子进程 */
let renderedPromise = null;
function rendered() {
  if (!renderedPromise) renderedPromise = renderAll();
  return renderedPromise;
}

async function sections() {
  const r = await rendered();
  assert(!r.unavailable, `bash 不可用（${r.unavailable}），无法做 shell 行为断言`);
  assert.strictEqual(r.code, 0, `渲染部署脚本产物应成功，实际退出码 ${r.code}\n${r.err}`);
  const map = splitSections(r.out);
  for (const k of ['NGINX_TLS', 'NGINX_HTTP', 'NGINX_TLS_9443', 'ENV_DEFAULT',
    'ENV_WEBDAV9443', 'ENV_TLS8443', 'ENV_HTTP8080', 'ENV_SKIPNGINX']) {
    assert.ok(map[k] !== undefined && map[k].trim() !== '',
      `渲染产物缺少分段 ${k}（部署脚本片段可能没跑起来）\n${r.err}`);
  }
  return map;
}

/* ==================================================================== */
/* D2-01 · Nginx 必须**默认**反代 /dav                                    */
/* ==================================================================== */

test('D2-01 · Nginx 模板默认反代 /dav 到应用内置 WebDAV 端口（不再是让人手工取消注释）', async () => {
  const conf = (await sections()).NGINX_TLS;

  assert.match(conf, /^\s*location \^~ \/dav \{/m,
    '站点配置里必须真实存在 `location ^~ /dav` 块：它若只是「可选、请自行取消注释」，'
    + '界面给出的 https://<域名>/dav/ 必然 404，用户根本无从得知差在哪一步');
  assert.doesNotMatch(conf, /^\s*#\s*location \^~ \/dav/m,
    '/dav 反代不得以注释形式出现（注释 = 没有生效）');
  assert.match(conf, /proxy_pass https:\/\/127\.0\.0\.1:8443;/,
    '上游必须是应用内置的 WebDAV HTTPS 服务（127.0.0.1:8443）');
  assert.match(conf, /proxy_ssl_verify off;/,
    'WebDAV 用的是本机自签名证书，不关校验会握手失败');
  assert.match(conf, /proxy_set_header Authorization \$http_authorization;/,
    'WebDAV 走 Basic 认证，必须显式透传 Authorization');
  assert.match(conf, /proxy_buffering off;/,
    '大文件上传 / 下载必须关缓冲（否则整文件落内存）');
  assert.match(conf, /proxy_set_header X-Forwarded-Port \$server_port;/,
    '非 443 部署时应用侧只能靠 X-Forwarded-Port 还原对外端口：'
    + 'Nginx 的 $host 已剥掉端口，缺了它界面给出的地址会指向错误的端口');
});

test('D2-01 · WebDAV 端口只有一个事实来源：WEBDAV_PORT 变了，Nginx 上游跟着变', async () => {
  const conf = (await sections()).NGINX_TLS_9443;
  assert.match(conf, /proxy_pass https:\/\/127\.0\.0\.1:9443;/,
    '改 WEBDAV_PORT 后 Nginx 上游必须同步改：写死 8443 会让 .env 与反代各说各话，'
    + '表现为「界面有地址、反代连不上」');
  assert.doesNotMatch(conf, /127\.0\.0\.1:8443/,
    '端口被覆盖后配置里不应再残留 8443');
});

test('D2-01 · 未启用 HTTPS 的部署方式（纯 HTTP 站点）同样要反代 /dav', async () => {
  const conf = (await sections()).NGINX_HTTP;
  assert.match(conf, /^\s*location \^~ \/dav \{/m,
    'TLS_MODE=none 时站点只有 80 端口的 server 块，/dav 反代必须落在这一块里，'
    + '否则这类部署的 WebDAV 完全不可达');
  assert.match(conf, /location \/ \{/,
    '纯 HTTP 部署仍应保留根路径反代');
});

/* ==================================================================== */
/* D2-03 · .env 必须同时产出 WEBDAV_PORT 与对外基地址                      */
/* ==================================================================== */

test('D2-03 · .env 写入 WEBDAV_PORT 与对外基地址 WEBDAV_PUBLIC_URL', async () => {
  const m = await sections();

  assert.match(m.ENV_DEFAULT, /^WEBDAV_PORT=8443$/m,
    '.env 必须显式给出 WEBDAV_PORT（应用侧 DEFAULT_PORT 读的就是它）');
  assert.match(m.ENV_DEFAULT, /^WEBDAV_PUBLIC_URL=https:\/\/pan\.example\.com$/m,
    '配了 Nginx 反代时必须写死对外基地址：界面「服务器地址」按它显示，'
    + '这正是「localhost:8443」问题的修法');

  assert.match(m.ENV_WEBDAV9443, /^WEBDAV_PORT=9443$/m,
    'WEBDAV_PORT 环境变量必须原样透传到 .env（写死 8443 就会与实际监听端口脱节）');

  assert.match(m.ENV_TLS8443, /^WEBDAV_PUBLIC_URL=https:\/\/pan\.example\.com:8443$/m,
    '对外 HTTPS 不是 443 时，地址必须带上端口，否则客户端会去连 443');

  assert.match(m.ENV_HTTP8080, /^WEBDAV_PUBLIC_URL=http:\/\/pan\.example\.com:8080$/m,
    '纯 HTTP 部署时应给出 http:// 地址（Nginx 仍以 HTTPS 回源 WebDAV，对客户端透明）');

  assert.match(m.ENV_SKIPNGINX, /^WEBDAV_PUBLIC_URL=$/m,
    '--skip-nginx（用户自建反代）时必须留空：写死一个本站点没配反代的地址反而指向 404，'
    + '留空才能让应用按「用户此刻访问的域名」自行推断');
});

/* ==================================================================== */
/* D2-02 · serverUrl() 必须反映访问域名，不得恒为监听地址                   */
/* ==================================================================== */

test('D2-02 · WebDAV 服务器地址按「对外基地址 → 请求域名 → 直连回退」逐级取值', () => {
  delete process.env.WEBDAV_PUBLIC_URL;
  delete process.env.TRUST_PROXY;
  delete process.env.WEBDAV_PORT;

  const webdav = require(WEBDAV_SERVER);
  const req = (headers) => ({ headers, get: (k) => headers[k] || '' });

  // ① 未经反代直连：用面板主机名 + WebDAV 自己的端口（本机 / 内网自测），绝不能带 3000
  assert.strictEqual(webdav.serverUrl(req({ host: '10.0.0.5:3000' })), 'https://10.0.0.5:8443/dav/',
    '直连时应把「面板端口」换成 WebDAV 端口，而不是把面板端口当成 WebDAV 端口');

  // ② TRUST_PROXY 未设置时，伪造的转发头必须被忽略（否则等于把地址交给请求方决定）
  assert.strictEqual(webdav.serverUrl(req({
    host: 'pan.example.com', 'x-forwarded-proto': 'https', 'x-forwarded-for': '1.2.3.4',
  })), 'https://pan.example.com:8443/dav/',
    'TRUST_PROXY 未设置时不得采信 X-Forwarded-*，否则任何人都能伪造出任意对外地址');

  // ③ 经可信反代：取管理员此刻访问的域名 —— 这就是本故障的直接修法
  process.env.TRUST_PROXY = '1';
  const proxied = webdav.serverUrl(req({ host: 'pan.example.com', 'x-forwarded-proto': 'https' }));
  assert.strictEqual(proxied, 'https://pan.example.com/dav/',
    '经反代时应给出面板域名，而不是监听地址 localhost / 127.0.0.1');
  assert.doesNotMatch(proxied, /localhost|127\.0\.0\.1/,
    '反代场景下的地址里不允许出现回环地址 —— 那正是用户复制到资源管理器后连不上的原因');

  // ④ Nginx 的 $host 已剥掉端口，靠 X-Forwarded-Port 还原非默认端口
  assert.strictEqual(webdav.serverUrl(req({
    host: 'pan.example.com', 'x-forwarded-proto': 'https', 'x-forwarded-port': '8443',
  })), 'https://pan.example.com:8443/dav/',
    '非 443 部署必须补出端口，否则地址指向 443 同样连不上');

  // ⑤ 显式配置的对外基地址优先级最高（并容忍手写结尾斜杠）
  process.env.WEBDAV_PUBLIC_URL = 'https://pan.example.com:8443/';
  assert.strictEqual(webdav.serverUrl(req({ host: 'internal.host', 'x-forwarded-proto': 'https' })),
    'https://pan.example.com:8443/dav/',
    'WEBDAV_PUBLIC_URL 是部署脚本写入的确定性事实，必须压过一切推断');

  delete process.env.WEBDAV_PUBLIC_URL;
  delete process.env.TRUST_PROXY;
});

test('D2-02 · 末档回退只服务「无请求上下文」的启动日志，不得参与界面地址', () => {
  delete process.env.WEBDAV_PUBLIC_URL;
  process.env.TRUST_PROXY = '1';

  const webdav = require(WEBDAV_SERVER);
  const noReq = webdav.serverUrl();
  assert.match(noReq, /^https:\/\/[^/]+:8443\/dav\/$/,
    '无请求上下文时允许回落到监听地址（仅用于服务启动日志）');

  const proxied = webdav.serverUrl({
    headers: { host: 'pan.example.com', 'x-forwarded-proto': 'https' },
    get: (k) => (k.toLowerCase() === 'host' ? 'pan.example.com' : ''),
  });
  assert.notStrictEqual(proxied, noReq,
    '有请求上下文时绝不能再等于监听地址 —— 「界面显示 localhost」就是这个等号');

  // 结构上再钉一道：监听地址只允许出现在 reqHost 之后（即它只能是末档兜底）
  const src = read(WEBDAV_SERVER);
  const idxReq = src.indexOf('const host = reqHost(req);');
  const idxFallback = src.indexOf("'localhost' : HOST}");
  assert.ok(idxReq > 0, 'serverUrl 必须靠 reqHost(req) 取请求域名');
  assert.ok(idxFallback > idxReq,
    '监听地址兜底必须排在请求域名之后 —— 顺序一换，主路径就退化成 localhost');

  delete process.env.TRUST_PROXY;
});

/* ==================================================================== */
/* D2-04 · 路由必须把 req 传下去                                          */
/* ==================================================================== */

test('D2-04 · WebDAV 路由必须把 req 传给 serverUrl（不传就静默退化成监听地址）', () => {
  const src = read(ROUTES_WEBDAV);
  assert.match(src, /function webdavView\(req\)/,
    'webdavView 必须接收 req：地址要靠「管理员此刻访问的域名」推断');
  assert.match(src, /serverUrl: webdav\.serverUrl\(req\)/,
    '必须把 req 传进 serverUrl');
  assert.doesNotMatch(src, /serverUrl\(\s*\)/,
    '不允许存在不传 req 的调用：那种调用只会得到监听地址，'
    + '而界面上照样显示得「很正常」，静态根本看不出');

  const callSites = [...src.matchAll(/webdavView\(([^)]*)\)/g)].map((m) => m[1].trim());
  assert.ok(callSites.length >= 5,
    `每个返回 WebDAV 视图的端点都要带上 req（当前只找到 ${callSites.length} 处 webdavView 调用）`);
  callSites.forEach((arg, i) => {
    assert.strictEqual(arg, 'req',
      `第 ${i + 1} 处 webdavView 调用必须传 req，实际传的是「${arg}」`);
  });
});

/* ==================================================================== */
/* D2-05 · 前端兜底地址不得写死 <本机IP>:端口                              */
/* ==================================================================== */

test('D2-05 · 前端地址兜底改为「面板同源 + 挂载点」，且复制按钮与显示一致', () => {
  const src = read(PUBLIC_SETTINGS);
  const code = stripLineComments(src); // 注释里会引用旧写法做反例，必须先剥掉

  assert.match(code, /function webdavFallbackUrl\(w\)/,
    '兜底地址必须由一个函数统一给出，避免三处各拼一份、改一处漏两处');
  assert.doesNotMatch(code, /<本机IP>/,
    '不得再显示 `https://<本机IP>:<端口>` 这类伪地址：那不是可用地址，是误导性建议'
    + '（用户照抄后连不上，却看不出问题出在哪）');
  assert.match(code, /location\.origin/,
    '兜底应按「此刻打开面板的来源」推断 —— 面板本身可达的域名 / 内网 IP 加挂载点，'
    + '才是客户端真正能用的地址');
  assert.match(code, /w\.serverUrl \|\| \(w\.enabled \? webdavFallbackUrl\(w\) : ''\)/,
    '复制按钮必须能复制界面上显示的那一串，否则出现「看得见、复制不了」');
  assert.match(code, /内部端口 \$\{w\.port\}/,
    '运行状态里的端口是**内部**端口，文案要点明它不需要直连，'
    + '免得用户把 8443 当成要填进客户端的端口');
});
