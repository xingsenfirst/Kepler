/**
 * 文档清单同步护栏
 *
 * ## 背景
 * 文档里的清单（目录结构、模块数、测试文件数、环境变量表）长期靠手工同步：
 * 上一次修订更新了正文，却没同步目录结构与计数，于是出现「正文讨论了 list-cache.js、
 * 目录里却没有它」「实际 18 个测试文件、文档写 17」这类偏差。
 *
 * 本文件把「文档写的」与「代码实际有的」做成断言 —— 新增或删除文件 / 模块 / 环境变量
 * 而忘了改文档时，这里直接变红。**清单的正确性由测试保证，不再依赖记忆。**
 *
 * ## 判据说明
 * - `*.test.js` 后缀唯一，故 tests 目录做**双向**严格比对；
 * - `public/js` 与 `server` 根目录下存在同名文件（如 `gitignore.js`、`webauthn.js`），
 *   按行解析位置成本高于收益，故这两处做**单向**包含检查（实际 ⊆ 文档列出），
 *   足以抓住「新增文件忘了写进文档」这一主要失效模式。
 * - `data/` 下的运行时文件没有目录可枚举（`data/` 不入库、测试期为空），真值只能取自
 *   **代码里的字符串字面量**，再拿它去校对正文散文、目录结构、分层图三处声明。
 *   这一条是为「正文声明与代码不符」补的：分层图曾长期列着 v3 迁移前的旧文件名
 *   （`config.json` / `users.json` / `share-links.json` / `payment-orders.json`），
 *   调试小节也写着 `data/config.json` —— 而当时所有护栏都是绿的，因为它们只看
 *   目录结构那一个围栏块。**旧文件名不会有任何运行期症状，只能靠断言拦住。**
 * - 审计编号（`SEC-*` / `FUN-*` / `PERF-*` / `LOW-*` / `P*` / `S*`）的含义登记在
 *   开发文档的「六、审计发现台账（合并存档）」。原始台账曾因意外**整体遗失**（代码里 180 余处引用一度无处可查），
 *   故这里断言「引用 ⊆ 登记」，让台账不可能再被静默删除或漏更新。
 */
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const { assert, assertEqual, ROOT } = require('./helpers');

const DOC = 'Develop_Document.md';
const README = 'README.md';

const readDoc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** 目录结构代码块（第一个围栏块） */
function structureBlock(doc) {
  const m = /```\n([\s\S]*?)\n```/.exec(doc);
  assert(m, `${DOC} 中应存在目录结构代码块`);
  return m[1];
}

/** 块中出现过的全部 *.js 文件名 */
function listedJs(block) {
  return new Set([...block.matchAll(/([A-Za-z0-9._-]+\.js)\b/g)].map((x) => x[1]));
}

/** 某章节（标题文字匹配）到下一个同级标题之间的正文 */
function sectionText(doc, title) {
  // 必须锚定标题标签内部：直接搜标题文字会先命中目录里的同名条目
  const i = doc.indexOf('>' + title + '<');
  assert(i >= 0, `文档中应存在章节：${title}`);
  const rest = doc.slice(i);
  const next = rest.indexOf('<h2 ', 1);
  return next > 0 ? rest.slice(0, next) : rest;
}

const listed = listedJs(structureBlock(readDoc(DOC)));

/* ============================ 正文声明的 data/ 文件名 ============================ */

/**
 * 为什么单独守这一条
 *
 * `data/` 既不能靠 `readdirSync` 取真值（不入库、测试期为空），也没有任何运行期症状：
 * 文档里写错一个文件名，服务照跑、测试照绿。因此真值取自**代码里的字符串字面量**
 * （`path.join(DATA_DIR, '...')` 与启动期的明文升级白名单），再反查文档的三处声明。
 */

/** data/ 下运行时文件的合法形态；新增扩展名时要回到这里登记（否则会被报成「代码里不存在」） */
const DATA_FILE_RE = /^[A-Za-z0-9._-]+\.(json|jsonl|key|enc|lock)$/;

/** 代码真值：server/** 里以字符串字面量出现的 data 文件名 → 命中位置 */
function codeDataFiles() {
  const hits = new Map();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.js')) continue;
      fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
        for (const m of line.matchAll(/'([A-Za-z0-9._-]+\.[A-Za-z0-9]+)'/g)) {
          if (!DATA_FILE_RE.test(m[1])) continue;
          if (!hits.has(m[1])) hits.set(m[1], []);
          hits.get(m[1]).push(`${path.relative(ROOT, p)}:${i + 1}`);
        }
      });
    }
  };
  walk(path.join(ROOT, 'server'));
  return hits;
}

/** 文档侧：全部 `data/<文件名>` 声明 → 出现行号（散文、行内代码、围栏块一视同仁） */
function docDataRefs(text) {
  const refs = new Map();
  String(text).split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/data\/([A-Za-z0-9._-]+\.[A-Za-z0-9]+)/g)) {
      if (!refs.has(m[1])) refs.set(m[1], []);
      refs.get(m[1]).push(i + 1);
    }
  });
  return refs;
}

/** 目录结构代码块里 data/ 子树的条目名 */
function treeDataFiles(block) {
  const lines = block.split('\n');
  const start = lines.findIndex((l) => /──\s*data\/\s/.test(l));
  assert(start >= 0, `${DOC} 的目录结构中应存在 data/ 子树`);
  const names = [];
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^\s*[├└]──\s*([^\s#]+)/.exec(lines[i]);
    if (!m) break; // data/ 是目录结构的最后一段，遇到收尾即停
    names.push(m[1]);
  }
  assert(names.length > 0, `${DOC} 的 data/ 子树应列出至少一个文件`);
  return new Set(names);
}

/**
 * 分层图里「持久化层」段落声明的 data/ 文件名。
 *
 * 注：此处**不**用围栏块正则去截取结构图 —— `` ```\n `` 只能匹配无语言标记的围栏，
 * 带标记的块（`` ```bash ``）会让其后所有配对整体错位（`structureBlock()` 取的是全文
 * 第一个无标记块，所以侥幸正确）。段落边界改用文档里已有的层标记（▼ / 下一个以 `[`
 * 开头的层名）来定：既不依赖围栏，也不依赖任何固定字符窗口。
 */
function diagramDataFiles(doc) {
  const i = doc.indexOf('持久化层');
  assert(i >= 0, `${DOC} 中应存在「持久化层」段落`);
  const rest = doc.slice(i);
  const end = rest.search(/\n\s*(?:▼|\[)/);
  const section = end > 0 ? rest.slice(0, end) : rest;
  const names = [...section.matchAll(/data\/([A-Za-z0-9._-]+\.[A-Za-z0-9]+)/g)].map((m) => m[1]);
  assert(names.length > 0,
    '分层图的「持久化层」段落应至少声明一个 data/ 文件 —— 解析到 0 个说明判定窗口已失效，'
    + '须修本护栏，而不是让它静默失去覆盖');
  return new Set(names);
}

const codeFiles = codeDataFiles();
const docRefs = docDataRefs(readDoc(DOC));

/* ============================ 审计编号台账 ============================ */

const AUDIT_LEDGER_SECTION = '六、审计发现台账（合并存档）';

/**
 * 审计编号的两种写法：
 *  - 带连字符的系列：`SEC-` / `FUN-` / `PERF-` / `LOW-`
 *  - 裸编号系列（另一轮审计）：`S6：` / `（S9）` / `（P1/P2）` / `S4/P11：`
 *
 * 裸编号按「独立的 `P`/`S` + 1~2 位数字」整体识别，再排除噪声 token。
 * **不要**改成「必须紧跟冒号」的写法：那样会漏掉 `（P1/P2）`、`（S10）`、`（S12）`
 * 这类括号收尾的写法 —— 实测漏 10 个编号（P2、P7、S1、S2、S5、S7、S8、S10、S11、S12）、共 22 处引用。
 * 位数上限 2 位，可挡住 `P256` / `P-256` 曲线名（代价：3 位以上的裸编号如 `S100` 会漏，届时需放宽）。
 */
const AUDIT_ID_RE = /\b(FUN-\d+[a-z]?|SEC-\d+|PERF-\d+|LOW-\d+)\b|\b([PS]\d{1,2})\b/g;

/**
 * 噪声 token：全库唯一一处「长得像编号但不是编号」的 `P`/`S` token 是 S3（指 S3 协议，
 * 见 `server/cos.js` 等）。若将来真的要登记 S3 编号，**不要在这里加例外** ——
 * 把 S3 从噪声集移除即可：那时「台账里的编号都能在代码中找到引用」会立刻报红，指路到本行。
 */
const AUDIT_ID_NOISE = new Set(['S3']);

/** 文本里的审计编号 → 出现行号 */
function auditIds(text) {
  const refs = new Map();
  String(text).split('\n').forEach((line, i) => {
    for (const m of line.matchAll(AUDIT_ID_RE)) {
      const id = m[1] || m[2];
      if (AUDIT_ID_NOISE.has(id)) continue;
      if (!refs.has(id)) refs.set(id, []);
      refs.get(id).push(i + 1);
    }
  });
  return refs;
}

/** 扫描目标集合（目录递归取 `.js`，文件整体读）→ 编号 → 命中位置 */
function collectAuditRefs(targets) {
  const refs = new Map();
  const add = (text, label) => {
    for (const [id, lines] of auditIds(text)) {
      if (!refs.has(id)) refs.set(id, []);
      for (const ln of lines) refs.get(id).push(`${label}:${ln}`);
    }
  };
  for (const t of targets) {
    const p = path.join(ROOT, t);
    if (fs.statSync(p).isDirectory()) {
      const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const q = path.join(dir, e.name);
          if (e.isDirectory()) walk(q);
          else if (e.name.endsWith('.js')) add(fs.readFileSync(q, 'utf8'), path.relative(ROOT, q));
        }
      };
      walk(p);
    } else {
      add(fs.readFileSync(p, 'utf8'), t);
    }
  }
  return refs;
}

/** 台账里登记的编号：本文件统一用反引号包裹编号，护栏据此识别登记项 */
const LEDGER_ID_RE = /`((?:FUN|SEC|PERF|LOW)-\d+[a-z]?|[PS]\d{1,2})`/g;

const auditRefs = collectAuditRefs(['server', 'tests', 'public', DOC, README]);
/** 台账正文：审计编号台账已从根目录 `AUDIT_FINDINGS.md` 合并进开发文档「六、审计发现台账」章节，读不到就让整个 docs-sync 失败 */
const ledgerText = (() => {
  const doc = readDoc(DOC);
  // 用完整标题标签定位正文标题：纯标题文字会先命中「目录」里的同名条目
  const i = doc.indexOf('>' + AUDIT_LEDGER_SECTION + '<');
  if (i < 0) {
    throw new Error(`开发文档中缺失「${AUDIT_LEDGER_SECTION}」章节\n`
      + '该章节登记了代码里 SEC-* / FUN-* / PERF-* / LOW-* / S* / P* 编号的含义与闭合依据，'
      + '并被 180 余处代码注释引用（原为根目录 AUDIT_FINDINGS.md，现已合并进文档）。'
      + '它曾经因意外**整体遗失**一次（早期审计报告随之不可考），'
      + '所以这里宁可让整个 docs-sync 文件直接失败，也不要静默跳过校验。'
      + '若确要移除，请连同本文件的编号护栏与代码注释里的引用一并处理。');
  }
  // 截到下一个 h1 标题（表格与编号登记全在本章内）
  const rest = doc.slice(i);
  const next = rest.indexOf('\n<h1 ', 1);
  return next > 0 ? rest.slice(0, next) : rest;
})();

const ledgerIds = new Set([...ledgerText.matchAll(LEDGER_ID_RE)].map((m) => m[1]));

test('目录结构：tests 测试文件名单与实际一致', () => {
  const actual = fs.readdirSync(path.join(ROOT, 'tests')).filter((f) => f.endsWith('.test.js')).sort();
  const inDoc = [...listed].filter((f) => f.endsWith('.test.js')).sort();
  const missing = actual.filter((f) => !inDoc.includes(f));
  const extra = inDoc.filter((f) => !actual.includes(f));
  assertEqual(missing.length, 0, `目录结构缺少测试文件：${missing.join(', ')}`);
  assertEqual(extra.length, 0, `目录结构列出了不存在的测试文件：${extra.join(', ')}`);
});

test('目录结构：public/js 模块均已列出', () => {
  const actual = fs.readdirSync(path.join(ROOT, 'public', 'js')).filter((f) => f.endsWith('.js')).sort();
  const missing = actual.filter((f) => !listed.has(f));
  assertEqual(missing.length, 0, `目录结构缺少前端模块：${missing.join(', ')}`);
});

test('目录结构：server 根目录下的模块均已列出', () => {
  const actual = fs.readdirSync(path.join(ROOT, 'server')).filter((f) => f.endsWith('.js')).sort();
  const missing = actual.filter((f) => !listed.has(f));
  assertEqual(missing.length, 0, `目录结构缺少服务端模块：${missing.join(', ')}`);
});

test('文档中的前端模块数与 public/js 实际数量一致', () => {
  const actual = fs.readdirSync(path.join(ROOT, 'public', 'js')).filter((f) => f.endsWith('.js')).length;
  const m = /(\d+)\s*个前端模块/.exec(readDoc(DOC));
  assert(m, '文档中应存在「N 个前端模块」的表述（与 frontend.test.js 的基线同源）');
  assertEqual(Number(m[1]), actual, `文档写 ${m[1]} 个前端模块，实际 ${actual} 个`);
});

test('文档中的测试文件数与实际一致（两份文档）', () => {
  const actual = fs.readdirSync(path.join(ROOT, 'tests')).filter((f) => f.endsWith('.test.js')).length;
  const mDoc = /(\d+)\s*个测试文件/.exec(readDoc(DOC));
  const mReadme = /(\d+)\s*个文件/.exec(readDoc(README));
  assert(mDoc, `${DOC} 中应存在「N 个测试文件」的表述`);
  assert(mReadme, `${README} 中应存在「N 个文件」的表述`);
  assertEqual(Number(mDoc[1]), actual, `${DOC} 写 ${mDoc[1]} 个测试文件，实际 ${actual} 个`);
  assertEqual(Number(mReadme[1]), actual, `${README} 写 ${mReadme[1]} 个文件，实际 ${actual} 个`);
});

test('文档头部声明的适用版本与 package.json 一致', () => {
  const v = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const doc = readDoc(DOC);
  assert(doc.includes(`**适用版本**：v${v}`),
    `${DOC} 头部应声明「**适用版本**：v${v}」（当前 package.json 为 ${v}）—— 版本号升了而文档没改，读者无法判断手上这份对应哪个构建`);
});

test('环境变量表收录了代码中实际读取的全部变量', () => {
  // ---- 代码侧：process.env.X 与 fromEnv('X') 两种写法都要抓 ----
  const envFromCode = new Set();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) {
        const src = fs.readFileSync(p, 'utf8');
        for (const m of src.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) envFromCode.add(m[1]);
        for (const m of src.matchAll(/fromEnv\(\s*'([A-Z][A-Z0-9_]*)'/g)) envFromCode.add(m[1]);
      }
    }
  };
  walk(path.join(ROOT, 'server'));

  // ---- 文档侧：环境变量小节里反引号包裹的变量名 ----
  const section = sectionText(readDoc(DOC), '2. 环境变量');
  const envInDoc = new Set([...section.matchAll(/`([A-Z][A-Z0-9_]{2,})`/g)].map((m) => m[1]));

  const missing = [...envFromCode].filter((v) => !envInDoc.has(v)).sort();
  assertEqual(missing.length, 0, `环境变量表缺少：${missing.join(', ')}`);
});

test('样例自测：data 文件名提取与「不存在」判定本身可用（含反例）', () => {
  // 分析器必须自带样例自测：解析器静默失效时，护栏会一直绿（这正是它要防的那种失效）
  const sample = [
    '│  data/config.enc · data/logs.jsonl',
    '│  全部经 atomic-write.js 落盘',
    '「迁移」= 复制 `data/` 目录本身',
  ].join('\n');
  assertEqual([...docDataRefs(sample).keys()].sort().join(','), 'config.enc,logs.jsonl',
    '应只提取带 data/ 前缀的文件名 —— 说明行里的 atomic-write.js 与裸 data/ 都不该被算进来');

  // 反例：合成一个代码里不存在的名字，缺失判定必须抓住它，否则这条护栏形同虚设
  const missing = [...docDataRefs('data/fake-not-in-code.json').keys()].filter((n) => !codeFiles.has(n));
  assertEqual(missing.join(','), 'fake-not-in-code.json',
    '反例未被检出 —— 缺失判定失效');
});

test('正文声明的 data/ 文件名在代码中确实存在', () => {
  const missing = [...docRefs.keys()].filter((n) => !codeFiles.has(n)).sort();
  const detail = missing.map((n) => `${n}（文档第 ${docRefs.get(n).join(' / ')} 行）`).join('；');
  assertEqual(missing.length, 0,
    `正文声明了代码里不存在的 data 文件名：${detail}`);
});

test('代码实际使用的 data 文件都已列入目录结构', () => {
  const inTree = treeDataFiles(structureBlock(readDoc(DOC)));
  const missing = [...codeFiles.keys()].filter((n) => !inTree.has(n)).sort();
  const detail = missing.map((n) => `${n}（${codeFiles.get(n)[0]}）`).join('；');
  assertEqual(missing.length, 0,
    `目录结构的 data/ 子树缺少：${detail}`);
});

test('分层图与目录结构的 data 文件清单一致', () => {
  const doc = readDoc(DOC);
  const inTree = treeDataFiles(structureBlock(doc));
  const inDiagram = diagramDataFiles(doc);
  const onlyTree = [...inTree].filter((n) => !inDiagram.has(n)).sort();
  const onlyDiagram = [...inDiagram].filter((n) => !inTree.has(n)).sort();
  assertEqual(onlyTree.length, 0,
    `分层图缺少：${onlyTree.join(', ')}（确要改成摘要时，请一并调整本断言，不要让它静默失去覆盖）`);
  assertEqual(onlyDiagram.length, 0, `分层图多出：${onlyDiagram.join(', ')}`);
});

test('样例自测：审计编号提取可用，且不误吞 S3 / P256 这类普通词（含反例）', () => {
  const sample = [
    '// 兼容 S3 协议（SigV4）；曲线 P-256；这里的 P256 不是编号',
    '// PERF-04：列举上限集中化',
    '// P8：背压水位线；S4/P11：加密落盘',
    '// FUN-04b 同型残留',
  ].join('\n');
  assertEqual([...auditIds(sample).keys()].sort().join(','), 'FUN-04b,P11,P8,PERF-04,S4',
    '应提取带连字符的系列与裸编号，并把 S3 协议、P256 / P-256 曲线排除在外');

  // 反例：编号在运行时拼出，避免这行样例本身被当成真实引用（本文件也在扫描范围内）
  const ghostId = ['FUN', '99'].join('-');
  const missing = [...auditIds(`// ${ghostId}：查无此号`).keys()].filter((id) => !ledgerIds.has(id));
  assertEqual(missing.join(','), ghostId, '反例未被检出 —— 覆盖率判定失效');
});

test('代码与文档引用的审计编号都已在台账中登记', () => {
  const missing = [...auditRefs.keys()].filter((id) => !ledgerIds.has(id)).sort();
  const detail = missing.map((id) => {
    const hits = auditRefs.get(id);
    return `${id}（${hits.slice(0, 3).join(' / ')}${hits.length > 3 ? ` …共 ${hits.length} 处` : ''}）`;
  }).join('；');
  assertEqual(missing.length, 0,
    `以下审计编号被引用但未登记在「${AUDIT_LEDGER_SECTION}」：${detail}`);
});

test('台账里的编号都能在代码或测试中找到引用（防止登记笔误）', () => {
  const codeIds = collectAuditRefs(['server', 'tests', 'public']);
  const orphan = [...ledgerIds].filter((id) => !codeIds.has(id)).sort();
  assertEqual(orphan.length, 0,
    `台账登记了代码/测试中不存在的编号：${orphan.join(', ')}（若是笔误请改正；若确为已无引用的历史编号，请在本断言里显式豁免）`);
});

/**
 * 目录（TOC）是全文手工维护的锚点清单：插入或删除一个章节会让后续编号整体位移，
 * 历史上多次出现「正文改了、目录没跟着改」导致锚点全部错位。这里把
 * 「目录条目 ↔ 正文标题」做成双向断言，任何一处漏改都会立刻变红。
 */
test('目录（TOC）与正文标题一一对应，锚点编号连续', () => {
  const doc = readDoc(DOC);

  // ---- 正文侧：全部手写标题 ----
  const headings = [...doc.matchAll(/<h([123]) id="develop_document-section(\d+)">([\s\S]*?)<\/h\1>/g)]
    .map((m) => ({ level: Number(m[1]), id: Number(m[2]), text: m[3] }));
  assert(headings.length > 0, `${DOC} 中应存在手写 HTML 标题（目录依赖其 id）`);

  // 编号必须从 1 连续递增（中间插入新章节时最容易漏改这一条）
  headings.forEach((h, i) => {
    assertEqual(h.id, i + 1, `第 ${i + 1} 个标题的 id 应为 develop_document-section${i + 1}，实际为 ${h.id}（章节增删后需整体重排）`);
  });

  // ---- 目录侧：「**目录**」到第一个 <h1> 之间 ----
  const tocStart = doc.indexOf('**目录**');
  assert(tocStart >= 0, `${DOC} 中应存在「**目录**」标记`);
  const tocEnd = doc.indexOf('<h1 ', tocStart);
  assert(tocEnd > tocStart, `${DOC} 中「**目录**」之后应存在正文标题`);
  const toc = doc.slice(tocStart, tocEnd);
  const entries = [...toc.matchAll(/^\s*- \[([^\]]+)\]\(#(develop_document-section\d+)\)\s*$/gm)]
    .map((m) => ({ text: m[1], id: m[2] }));

  assertEqual(entries.length, headings.length,
    `目录条目数（${entries.length}）与正文标题数（${headings.length}）不一致 —— 增删章节后必须同步目录`);

  entries.forEach((e, i) => {
    const h = headings[i];
    assertEqual(e.id, 'develop_document-section' + h.id,
      `目录第 ${i + 1} 条锚点为 ${e.id}，正文第 ${i + 1} 个标题为 develop_document-section${h.id}`);
    assertEqual(e.text, h.text,
      `目录第 ${i + 1} 条文字为「${e.text}」，正文标题为「${h.text}」`);
  });
});

/* ============================ 文档措辞漂移护栏（第 7 轮 D 段） ============================ */

/**
 * 第 7 轮审计查出 4 处「文档声称、代码没有」的措辞漂移（D1~D4，见开发文档「六、审计发现台账 6.4」），
 * 措辞已按代码修正。这里是**防回潮**：被证伪的说法一旦写回 README 就立刻报错。
 *
 * 每条都写明「为什么它是错的」—— 将来若真的实现了该能力，必须同时改文档与这条清单。
 */
const README_DISALLOWED = [
  {
    re: /来源 IP 可审计|监控每次下载的时间、次数与来源 IP/,
    why: 'D1：分享下载只有 downloads 计数与 lastDownloadAt，成功下载不记录来源 IP',
  },
  {
    re: /即使对方正在下载/,
    why: 'D4：IP 屏蔽是请求前置中间件，无法中断已经开始传输的响应',
  },
  {
    re: /查看用户列表 \| 全部用户 \| ✘/,
    why: 'D3：非管理员 GET /users 返回 scope=self（只含自己一条），并非完全不可见',
  },
  {
    re: /从云端获取桶列表 \| ✔（任意密钥） \| ✔/,
    why: 'D2：POST /config/verify 已收回为仅管理员，普通用户不能再拉云端桶名',
  },
];

function readmeDrift(text) {
  return README_DISALLOWED.filter((d) => d.re.test(text)).map((d) => d.why);
}

test('样例自测：README 漂移护栏能命中被证伪的措辞，也能放行修正后的措辞', () => {
  assertEqual(readmeDrift('下载量、时间、次数、来源 IP 可审计').length, 1,
    '「来源 IP 可审计」必须被检出');
  assertEqual(readmeDrift('可即时拉黑（即使对方正在下载）').length, 1,
    '「即使对方正在下载」必须被检出');
  assertEqual(readmeDrift('不记录来源 IP —— IP 只出现在登录 / 解锁限流的告警日志中').length, 0,
    '修正后的措辞必须被放行（否则护栏会误伤正常文档）');
});

test('README 不得重新引入已被证伪的能力描述（D1~D4 漂移防回潮）', () => {
  const hit = readmeDrift(readDoc(README));
  assertEqual(hit.join('；'), '',
    `README 出现了与代码不符的措辞：${hit.join('；')} —— 若确已实现该能力，请同步更新本清单`);
});

/* ============================ 表格布局规范（紧凑型） ============================ */

/**
 * 为什么守这一条
 *
 * pad 布局（分隔行填充成与内容同宽、单元格左右补空格对齐）把「排版宽度」编进了内容：
 * 改一个字就要重排整块，diff 里整表变红，而那份对齐只在本机编辑器里成立 —— 换个字体、
 * 换个渲染器就散了。紧凑型（`| --- |` + 单元格不补空格）让新增一行只影响自己那一行。
 *
 * 判据（逐单元格，不是整行 grep）：
 * - 单元格：去掉两侧各一个分隔空格后不得再有多余空格（空单元格不受限）；
 * - 分隔行：`---` / `:---` / `---:` / `:---:`，横线长度恒为 3 —— 被拉长就是 pad 残留。
 * 只认围栏外的行（代码块里的表格样例不受约束，下面的自测正是靠这一点构造反例）。
 */
function tableRowIssues(text) {
  const out = [];
  let inFence = false;
  text.split(/\r?\n/).forEach((raw, i) => {
    if (/^\s*(```|~~~)/.test(raw)) { inFence = !inFence; return; }
    if (inFence) return;
    const line = raw.replace(/\s+$/, '').replace(/^\s+/, '');
    const m = /^\|(.*)\|$/.exec(line);
    if (!m) return;
    splitRowCells(m[1]).forEach((cell) => {
      const t = cell.trim();
      if (t === '') return;
      if (/^:?-+:?$/.test(t)) {
        if (t.replace(/:/g, '').length > 3) out.push(`L${i + 1} 分隔行被拉长：${raw.trim()}`);
        return;
      }
      if (cell !== ` ${t} `) out.push(`L${i + 1} 单元格带填充空格：${raw.trim()}`);
    });
  });
  return out;
}

/** 按未转义的 `|` 切分单元格（`\|` 是内容里的竖线，不是分隔符） */
function splitRowCells(inner) {
  const cells = [];
  let buf = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '\\' && inner[i + 1] === '|') { buf += '\\|'; i++; continue; }
    if (ch === '|') { cells.push(buf); buf = ''; continue; }
    buf += ch;
  }
  cells.push(buf);
  return cells;
}

/** 项目内参与规范检查的 Markdown（排除依赖目录与 IDE 数据目录） */
function projectMarkdown(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', '.workbuddy', 'data'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...projectMarkdown(p));
    else if (e.name.toLowerCase().endsWith('.md')) out.push(p);
  }
  return out;
}

test('样例自测：紧凑型判据能抓出 pad 布局，也能放行紧凑型（含对齐标记与转义竖线）', () => {
  const pad = [
    '| 文件                     | 丢失后果      |',
    '| ---------------------- | ----------- |',
    '| `secret.key`           | 否           |',
  ].join('\n');
  assert(tableRowIssues(pad).length >= 4, `pad 布局必须被抓出，实际：${JSON.stringify(tableRowIssues(pad))}`);

  const compact = [
    '| 能力 | 管理员 | 普通用户 |',
    '| --- | :---: | ---: |',
    '| 删除 | ✔ | ✘ |',
    '| 转义 \\| 竖线 | 保持原样 | 空单元： |',
    '| | | |',
  ].join('\n');
  assertEqual(tableRowIssues(compact).join('；'), '', `紧凑型不得被误报：${JSON.stringify(tableRowIssues(compact))}`);

  // 围栏内的表格是样例，不受约束
  assertEqual(tableRowIssues('```\n| a    | b   |\n| ---- | --- |\n```').length, 0,
    '代码块里的表格样例不受布局规范约束');
});

test('项目内 Markdown 表格一律使用紧凑型布局（不得用 pad 对齐填充）', () => {
  const bad = [];
  for (const p of projectMarkdown(ROOT)) {
    const issues = tableRowIssues(fs.readFileSync(p, 'utf8'));
    if (issues.length) bad.push(`${path.relative(ROOT, p)} → ${issues.slice(0, 3).join('；')}`);
  }
  assertEqual(bad.join('\n'), '',
    `以下 Markdown 仍是 pad 布局（单元格填充空格或分隔行被拉长）：\n${bad.join('\n')}`);
});
