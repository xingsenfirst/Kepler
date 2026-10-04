/**
 * 更新检查 —— 「关于」卡片的「检查更新」按钮
 *
 * 目标：告诉用户「当前版本是否已是最新」，若不是，则同时给出**当前版本**与**最新版本**
 * 两个号，让用户自己决定是否去服务器终端重新安装（本系统不提供在线自助升级）。
 *
 * ## 当前版本从哪来
 *
 * 只认 `package.json` 的 `version`（**单一权威**）。页脚那句 `Build x.y.z` 虽然是同一个号，
 * 但它是**渲染进 HTML 的静态文本** —— 服务端去读它，等于读一份可能已经过期的副本。
 *
 * ## 最新版本从哪来
 *
 * 按下面的顺序取，**越靠前越权威**：
 *  1. `release`：GitHub 发布页 `/releases/latest` 的 `tag_name` —— 用户主动「发布」的版本，
 *     这正是需求里说的「通过 GitHub 发布页」；
 *  2. `tag`：仓库标签 `/tags` 的第一项 —— 只打 tag、不发 Release 时的等价物；
 *  3. `package`：默认分支 `package.json` 的 `version` —— 前两者都没有时的兜底
 *     （本仓库目前就是这样：既无 Release 也无 tag，只有第 3 级能取出号来）。
 *
 * 三级**依次尝试**，某一级取不到版本号（404 / 空数组 / 号不可解析）就换下一级；
 * 三级全失败才抛错，且错误文案里带上**每一级的失败原因** —— 否则用户只能看到一个
 * 「检查更新失败」，无从判断是断网、被墙还是仓库改名。
 *
 * ## 为什么不需要过 `assertSafeEndpoint`
 *
 * 三个地址全部**写死**在下面，不从请求里取任何参数 —— 不存在 SSRF 面。
 * `assertSafeEndpoint` 那条纪律针对的是「**可配置**的对外地址字段」（endpoint / 站点地址），
 * 与本模块无关。
 *
 * ## 缓存
 *
 * 结果缓存 10 分钟。GitHub 未认证 API 是 **60 次/小时/IP**，而「检查更新」是一个
 * 会被反复点的按钮 —— 不缓存等于把额度交给用户的点击速度。
 */

const https = require('https');

/** 仓库标识。公开只读、写死在此，不从请求里取（见文件头「为什么不需要过 assertSafeEndpoint」） */
const OWNER_REPO = 'xingsenfirst/Kepler';
const DEFAULT_BRANCH = 'main';
/** 人类可读的发布页地址（返回给前端展示用） */
const RELEASES_PAGE = `https://github.com/${OWNER_REPO}/releases`;

/**
 * 单次上游请求的超时（毫秒）。
 *
 * 不设上限会让「检查更新」在 GitHub 无响应时**永远转圈** —— 与 R29-01 修掉的
 * 「上传卡在 100%」是同一种病：只要对端不返回，前端就没有任何可观测的失败点。
 */
const REQUEST_TIMEOUT_MS = 6000;

/** 结果缓存时长（毫秒） */
const CACHE_MS = 10 * 60 * 1000;

/** 上游响应体上限：异常响应（例如被劫持成一个巨大的 HTML）不得把内存吃光 */
const MAX_BODY_BYTES = 256 * 1024;

/**
 * 最新版本的三个来源。`key` 会随结果一起返回，便于界面/日志说明「这个号是从哪儿读到的」。
 */
const SOURCES = [
  {
    key: 'release',
    url: `https://api.github.com/repos/${OWNER_REPO}/releases/latest`,
    pick: (j) => (j && typeof j.tag_name === 'string' ? j.tag_name : ''),
  },
  {
    key: 'tag',
    url: `https://api.github.com/repos/${OWNER_REPO}/tags`,
    pick: (j) => (Array.isArray(j) && j.length && typeof j[0].name === 'string' ? j[0].name : ''),
  },
  {
    key: 'package',
    url: `https://raw.githubusercontent.com/${OWNER_REPO}/${DEFAULT_BRANCH}/package.json`,
    pick: (j) => (j && typeof j.version === 'string' ? j.version : ''),
  },
];

/**
 * 解析版本号：接受 `1.2.3` / `v1.2.3` / `1.2.3-rc.1`。非法返回 `null`。
 *
 * 只认**三段式**。放宽成「两段也认」会把与版本无关的数字（例如某个 tag 叫 `2026.10`）
 * 当成版本比较 —— 宁可判「读不到版本」，也不要给出一个错的「有新版本」。
 */
function parseVersion(text) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(text == null ? '' : text).trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] || '' };
}

/**
 * 比较两个版本号。`a > b` → 1，`a < b` → -1，相等 → 0，**任一侧无法解析 → `null`**。
 *
 * `null` 与 `0` 必须严格区分：`null` 的含义是「这次比较不成立」，调用方要**换下一个来源**；
 * 而 `0` 是一个确定的结论（两边就是同一个版本）。把两者混成 falsy 会让一个无法解析的
 * tag 被当成「已是最新」，用户于是永远收不到升级提示。
 *
 * 预发布按 semver 处理：`1.4.0-rc.1` **小于** `1.4.0`。
 */
function compareVersion(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  if (x.major !== y.major) return x.major > y.major ? 1 : -1;
  if (x.minor !== y.minor) return x.minor > y.minor ? 1 : -1;
  if (x.patch !== y.patch) return x.patch > y.patch ? 1 : -1;
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1; // 1.4.0 > 1.4.0-rc.1
  if (!y.pre) return -1;
  return x.pre > y.pre ? 1 : -1;
}

/** 默认的取 JSON 实现（可被测试替换，见 `__setFetcher`） */
function defaultFetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      // GitHub 对**没有 User-Agent** 的请求直接回 403，必须显式带上
      headers: { 'User-Agent': 'Kepler-UpdateCheck', Accept: 'application/vnd.github+json' },
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        body += c;
        if (body.length > MAX_BODY_BYTES) req.destroy(new Error('响应体过大'));
      });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(`HTTP ${res.statusCode}`);
          err.statusCode = res.statusCode;
          return reject(err);
        }
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error('响应不是合法 JSON'));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`请求超时（${REQUEST_TIMEOUT_MS}ms）`)));
    req.on('error', reject);
  });
}

let fetchJson = defaultFetchJson;

/** 仅供测试：替换 / 还原上游取数实现 */
function __setFetcher(fn) {
  fetchJson = typeof fn === 'function' ? fn : defaultFetchJson;
}

/** 当前版本 —— 只认 `package.json`（单一权威） */
function currentVersion() {
  return String(require('../package.json').version || '');
}

let cache = { at: 0, value: null };

/** 仅供测试：清空结果缓存 */
function __clearCache() {
  cache = { at: 0, value: null };
}

/**
 * 检查更新。
 *
 * @param {object} [opt]
 * @param {string} [opt.current] 覆盖「当前版本」（测试用；默认取 `package.json`）
 * @param {boolean} [opt.force] 忽略缓存
 * @returns {Promise<{current:string, latest:string, hasUpdate:boolean, url:string, source:string}>}
 * @throws 三级来源全部失败时抛 `Error`（`status = 502`），`message` 含每一级的失败原因
 */
async function checkForUpdate({ current, force } = {}) {
  const cur = current == null ? currentVersion() : String(current);
  if (!force && cache.value && (Date.now() - cache.at) < CACHE_MS) {
    return Object.assign({}, cache.value, { current: cur });
  }

  const failures = [];
  for (const src of SOURCES) {
    let raw;
    try {
      raw = String(src.pick(await fetchJson(src.url)) || '').trim();
    } catch (e) {
      failures.push(`${src.key}：${(e && e.message) || e}`);
      continue;
    }
    if (!raw) { failures.push(`${src.key}：响应里没有版本号`); continue; }
    const cmp = compareVersion(raw, cur);
    if (cmp === null) {
      failures.push(`${src.key}：版本号 “${raw}” 无法解析（当前版本 “${cur}”）`);
      continue; // 换下一个来源 —— 一个不合规的 tag 不该让整次检查失败
    }
    const value = { latest: raw, hasUpdate: cmp > 0, url: RELEASES_PAGE, source: src.key };
    cache = { at: Date.now(), value };
    return Object.assign({}, value, { current: cur });
  }

  const err = new Error('无法从 GitHub 获取最新版本（' + failures.join('；') + '）');
  err.status = 502;
  throw err;
}

module.exports = {
  checkForUpdate,
  currentVersion,
  compareVersion,
  parseVersion,
  RELEASES_PAGE,
  OWNER_REPO,
  SOURCES,
  // 仅供测试
  __setFetcher,
  __clearCache,
};
