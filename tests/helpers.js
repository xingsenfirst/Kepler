/**
 * 零依赖测试工具（Node 内置 node:test + 自研断言辅助）
 *
 * 用法：node --test tests/
 *  — 不引入 vitest / jest 等任何 devDependency，保持项目「零新增依赖」原则。
 *  — 提供：临时数据目录隔离、测试用户、HTTP 客户端、断言辅助。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');

/* ============================ R13-01：测试隔离默认安全 ============================ */

/**
 * 第 13 轮审计 §0.1 / R13-01：**测试仍在写生产数据**。
 *
 * 根因不在 store 层（它们全都支持 `COS_DATA_DIR` 了），而在**加载时序**：
 * 有的用例「设 env + `delete require.cache`」加载一个隔离实例，测完 `restore()`
 * （还原 env **并再次删缓存**）—— 此后同一文件里任何一次 `require`（无论是直接
 * 还是通过 `cos.js` / 路由 / WebDAV 传递加载）拿到的都是绑定到**生产 `data/`**
 * 的实例。实测 `audit6` 的 PERF-02 改写生产 `config.enc`、`audit3` 的 FUN-02
 * 改写生产 `stats.json`（桶 b 的 req 667→672，真实污染）。
 *
 * 修法是「默认安全」而不是「靠每个用例自觉」：本文件是**所有**测试文件的公共
 * 入口（`require('./helpers')`），在它顶层把 `COS_DATA_DIR` 兜底到进程级临时
 * 目录 —— 凡是没有自己设 env 的测试进程，store 一律落进临时目录；
 * 已设 env 的文件（audit7~12 等）不受影响（`if (!...)`）。
 *
 * 退出清理的时序是安全的：本 hook 注册得比任何 store 的 exit 钩子都早，
 * 先删目录 → store 钩子后跑 → 「退出路径只写不建」（`exitPathWritable`）自然跳过。
 */
if (!process.env.COS_DATA_DIR) {
  const defaultDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-testroot-'));
  process.env.COS_DATA_DIR = defaultDataDir;
  process.on('exit', () => {
    try { fs.rmSync(defaultDataDir, { recursive: true, force: true }); } catch (e) { /* 退出阶段尽力而为 */ }
  });
}

/* ============================ 断言辅助 ============================ */

function assert(cond, msg) {
  if (!cond) throw new Error('断言失败：' + (msg || ''));
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`断言失败：${msg || ''}\n  期望: ${JSON.stringify(expected)}\n  实际: ${JSON.stringify(actual)}`);
  }
}

function assertMatch(str, re, msg) {
  if (!re.test(String(str))) {
    throw new Error(`断言失败：${msg || ''}\n  ${JSON.stringify(String(str).slice(0, 200))} 不匹配 ${re}`);
  }
}

function assertReject(fn, msg) {
  return Promise.resolve().then(fn).then(
    () => { throw new Error('断言失败：期望抛出异常，但成功返回' + (msg ? '（' + msg + '）' : '')); },
    () => true,
  );
}

/* ============================ 临时数据目录 ============================ */

/**
 * 在隔离的临时目录中加载一个 server 模块。
 *  — 通过设置 COS_DATA_DIR 环境变量（若模块支持）或直接替换其内部路径不可行时，
 *    采用「进程级临时目录 + 清理」策略：测试进程独占，不触碰项目真实 data/。
 *
 * ⚠️ 项目模块均以 `path.join(__dirname, '..', 'data')` 解析数据目录，
 *    因此这里通过 child_process 方式运行需要真实目录的测试；纯函数测试则无需隔离。
 */
function makeTempDir(prefix = 'cos-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dir,
    /**
     * 同步回收（适合没有异步写队列的用例）。
     *
     * R8-26：**失败必须告警**，不能像旧实现那样 `catch { /* ignore *\/ }` 静默吞掉 ——
     * 「清理没成功却没有任何痕迹」正是本机悄悄累积 134 个临时目录的原因。
     * 若被测模块有去抖/异步写队列，请改用 {@link cleanupTempDir}（先刷干再删）。
     */
    cleanup() {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        if (fs.existsSync(dir)) {
          console.warn(`[tests] 临时目录仍存在（可能有句柄未释放）：${dir}`);
        }
      } catch (e) {
        console.warn(`[tests] 临时目录清理失败：${dir}\n  ${(e && e.message) || String(e)}`);
      }
    },
  };
}

/* ============================ R8-26：临时目录的统一回收 ============================ */

/**
 * R9-08 / R10-01：为什么 `cleanupTempDir` 只需要「先刷干、再删除」。
 *
 * ## 为什么单靠「先刷干再删」不够（R9-08 实测）
 *
 * R8-26 把清理顺序修正为「刷干 → 删除」之后，临时目录**仍然在泄漏**。现场证据：
 * `os.tmpdir()` 下 5 个 `cos-audit8-*` + 5 个 `cos-audit7-*` + 1 个 `cos-share-del-*`，
 * 且 `cos-audit8-*` 里**只有** `upload-sessions.json`（863B）—— 正是"删完之后又被写回"的形状。
 *
 * 真正的根因不在清理函数，而在**退出钩子**：
 * ```js
 * // server/upload-sessions.js
 * function persistNowSync() {
 *   if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });  // ← 重建目录
 *   secureStore.writeJson(FILE, sessions);
 * }
 * process.on('exit', () => { try { flushSync(); } catch (e) {} });
 * ```
 * `test.after` 里 `rmSync` 删掉目录 → 进程退出时 `exit` 钩子执行 `flushSync()` →
 * `mkdirSync` 把目录整份重建并写回 `upload-sessions.json`。**时机在清理之后**，
 * 所以问题不是"写得太早"或"异常被吞"，而是"清理的最后一个动作被退出钩子撤销"。
 *
 * ## 现在的做法（R10-01）：**不要用测试开关控制生产行为**
 *
 * R9-08 当时的修法是让本函数在删除后置一个进程级标记
 * （`process.env.__cosTestDataDirCleaned`），生产代码的退出路径读到它就不再建目录。
 * 让**测试专用开关去控制生产行为**本身就是坏味道，而且它直接酿成了 R10-01：
 * 那条判定被复制进 `persistNow()` 却漏了变量声明 → `ReferenceError` 被空 `catch`
 * 吞掉 → 整条异步落盘路径恒为静默空操作（高危）。
 *
 * 正解是让生产侧的退出路径**只写、不建**（`upload-sessions.exitPathWritable()`：
 * 目录不存在就不写），判据是"目录本身在不在"，与测试无关。于是本函数只剩下
 * 它本来就该做的两件事：刷干 → 删除。删完之后退出钩子自然不会再写出任何东西，
 * 也就不会再有目录被复活。
 */

/**
 * 临时目录回收：**先刷干异步写队列，再删目录，失败必须告警**。
 *
 * ## 为什么不能直接 rmSync（R8-26 实测）
 *
 * 旧写法 `try { fs.rmSync(TMP, {recursive:true,force:true}) } catch { /* ignore *\/ }`
 * 有两个叠加的问题：
 *  ① **时机太早** —— `upload-sessions` 有 300ms 去抖写、`stats-store` 有日志缓冲
 *     （500ms 去抖）、`secure-store` 有串行写队列，它们都会在 `test.after` **之后**
 *     把文件写回已被删除的目录。实测：跑一次 `audit7-regressions.test.js`，
 *     `os.tmpdir()` 下 `cos-audit7-*` 目录数 133 → 134，且 134 个**全部非空**
 *     （内容为 upload-sessions.json，部分还含 ipguard.json / links.json / logs.jsonl）。
 *  ② **失败被吞** —— `catch { /* ignore *\/ }` 让"没删掉"这件事完全不可见，
 *     于是既泄漏又没人知道；本机就这样悄悄累积了 134 个目录。
 *
 * R9-08 补充了第三个、也是**最后一个**遗漏：删完之后退出钩子会把目录重建回来。
 * 这一半现在由生产侧自己兜住 —— 退出路径「只写不建」（见本文件上方
 * 「R9-08 / R10-01：为什么 cleanupTempDir 只需要先刷干、再删除」的说明），
 * 目录不存在时它连写都不会写，自然也不会把目录复活回来。
 *
 * ## 用法
 * ```js
 * test.after(async () => {
 *   await cleanupTempDir(TMP, {
 *     label: 'audit7-regressions',
 *     flushers: [
 *       { name: 'upload-sessions', flush: () => uploadSessions.flushSync() },
 *       { name: 'stats-store',     flush: () => statsStore.flushStatsSync() },
 *       { name: 'secure-store',    flush: () => secureStore.flush() },
 *     ],
 *   });
 * });
 * ```
 * `flushers` 按数组顺序执行（同步的刷干去抖 → 最后异步的刷干写队列）。
 * 用 `flushSync()` 而非 `flush()` 是有意的：`flush()` 只是把去抖队列转交给
 * `secure-store` 的异步写队列，必须再等 `secureStore.flush()` 才真正落盘。
 *
 * @param {string} dir
 * @param {object} [opts]
 * @param {string} [opts.label] 告警文案里的标识（默认取目录名）
 * @param {Array<{name: string, flush: () => (void|Promise<void>)}>} [opts.flushers]
 * @returns {Promise<{ok: boolean, removed: boolean, errors: string[]}>}
 */
async function cleanupTempDir(dir, opts = {}) {
  const errors = [];
  const label = opts.label || path.basename(String(dir || '')) || String(dir);

  for (const f of opts.flushers || []) {
    try {
      await f.flush();
    } catch (e) {
      errors.push(`${f.name} 刷盘失败：${(e && e.message) || String(e)}`);
    }
  }

  let removed = false;
  try {
    // maxRetries/retryDelay：Windows 上文件句柄释放略有延迟，重试比直接放弃划算
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    removed = !fs.existsSync(dir);
  } catch (e) {
    errors.push(`删除失败：${(e && e.message) || String(e)}`);
  }
  if (!removed && !errors.length) {
    errors.push('rmSync 未抛错，但目录仍然存在（可能有句柄未释放）');
  }

  /**
   * 删除失败时**必须如实告警**（下面这段），且不能假装已经清理干净。
   *
   * R9-08 曾在这里置一个进程级「已清理」标记来封住退出钩子；R10-01 之后改由生产侧
   * 「退出路径只写不建」兜住（见本文件顶部说明），这里不再需要任何开关。
   */
  if (errors.length) {
    // ⚠️ 绝不静默：这正是旧写法最坑的地方 —— 清理没成功却没有任何痕迹
    console.warn(`[tests] 临时目录清理未完全成功：${label}\n  ${errors.join('\n  ')}\n  路径：${dir}`);
  }
  return { ok: errors.length === 0, removed, errors };
}

/** 统计 `os.tmpdir()` 下匹配前缀的目录数（供用例断言「不再泄漏」） */
function countTempDirs(prefix) {
  try {
    return fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(prefix)).length;
  } catch (e) {
    return -1;
  }
}

/* ============================ HTTP 客户端 ============================ */

function request(port, method, urlPath, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === null ? null : (Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)));
    const opts = {
      host: '127.0.0.1',
      port,
      method,
      path: urlPath,
      headers: Object.assign(
        { 'X-Requested-With': 'XMLHttpRequest' },
        data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : null,
        headers,
      ),
    };
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch (e) { /* 非 JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, raw, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/** 轮询等待端口就绪（避免固定 sleep） */
async function waitForPort(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await request(port, 'GET', '/api/auth/me');
      return true;
    } catch (e) {
      await new Promise((r) => setTimeout(r, 120));
    }
  }
  throw new Error(`端口 ${port} 在 ${timeoutMs}ms 内未就绪`);
}

/* ============================ 前端模块语法检查 ============================ */

/**
 * 校验 public/js 下的 ESM 模块语法（无构建步骤项目最容易引入的低级错误）。
 * 用 `node --check` 无法校验 ESM，故改用「编译到 CJS」的方式探测语法错误。
 */
function checkEsmSyntax(file) {
  const vm = require('vm');
  const src = fs.readFileSync(file, 'utf8');
  try {
    // SourceTextModule 需要 --experimental-vm-modules；退化为动态 import 解析检查
    new vm.SourceTextModule(src, { identifier: file });
    return { ok: true };
  } catch (e) {
    if (e.code === 'ERR_VM_MODULES_NOT_ENABLED') {
      // 环境未开启 vm modules：退化为静态语法扫描（import/export 结构）
      return checkEsmSyntaxFallback(src, file);
    }
    return { ok: false, error: e.message };
  }
}

function checkEsmSyntaxFallback(src, file) {
  // 去掉 import/export 语句后，用 Function 构造器做语法解析
  const stripped = src
    .replace(/^\s*import\s+[^;]+;?\s*$/gm, '')
    .replace(/^\s*export\s+default\s+/gm, 'const __default__ = ')
    .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
    .replace(/^\s*export\s+(const|let|var|function|class|async)\s+/gm, '$1 ');
  try {
    // eslint-disable-next-line no-new-func
    new Function(stripped);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `${file}: ${e.message}` };
  }
}

module.exports = {
  ROOT,
  assert, assertEqual, assertMatch, assertReject,
  makeTempDir, request, waitForPort,
  // R8-26：临时目录的统一回收 + 泄漏计数
  // R9-08 / R10-01：退出钩子重建目录由生产侧「只写不建」兜住，本文件不再提供测试开关
  cleanupTempDir, countTempDirs,
  checkEsmSyntax, checkEsmSyntaxFallback,
};
