/**
 * 跨模块不变量的静态护栏
 *
 * ## 背景
 * 前 11 轮审计里唯一**没有回潮**的纪律是「文档与清单同步」——因为它有一条脚本
 * （`docs-sync.test.js`）在守。对照之下「退出路径只写不建」讲了两轮、落地 1/3；
 * 「批量删除白名单判据」讲了两轮、落地 4/6。第 11 轮报告 §9.5 的结论是：
 * **靠人记的纪律都会漏，靠脚本守的纪律才活下来。**
 *
 * 本文件把 §9.4「类别登记表」里可静态枚举的那些行写成检查。与 `docs-sync` 同款约定：
 *  - 每条检查是**纯函数**（输入文本 → 违规点数组），因此能**自带正/反样例**自测；
 *  - 失败信息必须带上**命中位置**（`文件:行号`），避免「窗口太窄」型假护栏；
 *  - 接进 `node --test "tests/**\/*.test.js"`，违规在提测那一刻就红。
 *
 * ## 判据口径
 * 全部扫描都先跑 `stripComments` —— 注释里经常出现与违规一模一样的**反例**
 * 字样（例如「注意不能写成 `mkdirSync`」），不剥离就会把合规代码判成违规。
 * 剥离时**保留字符数与行数**，因此行号仍然准确。
 */
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const { assert, assertEqual, ROOT } = require('./helpers');

/* ============================ 通用工具 ============================ */

function jsFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const q = path.join(d, e.name);
      if (e.isDirectory()) walk(q);
      else if (e.name.endsWith('.js')) out.push(q);
    }
  };
  walk(path.join(ROOT, dir));
  return out.sort();
}

/**
 * 把注释替换成等长空格：既避免「注释里的反例」被误判成违规，又保住行号/列号。
 * `//` 之前排除 `:` 是为了不误伤 `http://` 这类 URL。
 *
 * ## R13-07 加固：从「朴素正则」改为「引号/正则感知的扫描器」
 *
 * 旧实现用 `replace(/\/\*[\s\S]*?\*\//g, …)` 找块注释 —— **看不见字符串**。
 * 而 `'/dav/*'`、`server/routes/*.js`、`**\/*.test.js` 这类**字符串或行注释里的
 * glob / 路径**恰恰含块注释起始的两个字符：正则从那里起，非贪婪地一路吞到**下一个**
 * 闭合符（星号紧跟斜杠，可能在几百行之后）。实测后果：
 *   - `server/ip-guard.js`：`/dav/*` 起吞掉 1137 字符 —— 恰好把 `resolveBucketId`
 *     的真实代码整段抹成空白；
 *   - `Develop_Document.md`：`routes/*.js` 起吞掉 27693 字符。
 * 被抹掉的区域在**所有**调用方眼里都是「没有代码」——于是检查静默失去视力（假阴性），
 * 而不是报错。这比任何单条正则的窗口都更值得先修：它是 11 条检查共用的地基。
 *
 * 现在按字符扫描，状态机认字符串（`'` `"` `` ` ``）与正则字面量，只有**真注释**
 * 才抹白。`__test__` 断言字符数不变，因此行号仍然准确。
 *
 * @param {string} src
 * @param {{md?:boolean}} [opts] `md:true` 时只剥 HTML 注释（`<!-- -->`）——
 *   markdown 里 `/*` 是普通文本，按 JS 语义剥会把整篇文档当注释。
 */
function stripComments(src, opts) {
  const md = !!(opts && opts.md);
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (md) {
      // markdown：只剥 `<!-- ... -->`
      if (c === '<' && src.startsWith('<!--', i)) {
        const end = src.indexOf('-->', i + 4);
        const j = end < 0 ? src.length : end + 3;
        out += src.slice(i, j).replace(/[^\n]/g, ' ');
        i = j;
        continue;
      }
      out += c;
      i += 1;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      // 字符串 / 模板字面量：原样保留（其中的 `//` `/*` 都不是注释）
      const q = c;
      out += c;
      i += 1;
      while (i < src.length) {
        const d = src[i];
        if (d === '\\') { out += d + (src[i + 1] || ''); i += 2; continue; }
        out += d;
        i += 1;
        if (d === q) break;
      }
      continue;
    }
    if (c === '/') {
      const next = src[i + 1];
      const prev = i > 0 ? src[i - 1] : '';
      if (next === '/') {
        // 行注释；`http://` 与转义斜杠不算注释（保留旧口径）
        if (prev === ':' || prev === '\\') { out += c; i += 1; continue; }
        let j = i;
        while (j < src.length && src[j] !== '\n') j += 1;
        out += src.slice(i, j).replace(/[^\n]/g, ' ');
        i = j;
        continue;
      }
      if (next === '*') {
        /**
         * 块注释必须**有闭合**才认。没有闭合的起始符更可能是 glob 文本
         * （`routes/*.js` 这样的路径后面不会再出现闭合符）——当注释会把剩余全文抹白。
         */
        const end = src.indexOf('*/', i + 2);
        if (end < 0) { out += c; i += 1; continue; }
        const j = end + 2;
        out += src.slice(i, j).replace(/[^\n]/g, ' ');
        i = j;
        continue;
      }
      const e = regexEnd(src, i);
      if (e > i) { out += src.slice(i, e); i = e; continue; }
    }
    out += c;
    i += 1;
  }
  /**
   * 长度自检：抹白必须**等长**（否则行号会漂移）。万一扫描器被某种未知语法
   * 带偏，退回朴素实现 —— 宁可窗口窄，也不要给出错误的行号。
   */
  if (out.length !== src.length) {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/(^|[^:'"\\])\/\/[^\n]*/g, (_m, p) => p + _m.slice(p.length).replace(/[^\n]/g, ' '));
  }
  return out;
}

/**
 * 字符串 / 模板字面量的区间表（保留原文本，只报区间）。
 *
 * R13-07：把 `tests/` 也纳入 `dataDirViolations` 的扫描范围后，`invariants.test.js`
 * **自身**的「违规样例字符串」（`bad: "const DATA_DIR = path.join(__dirname, '..', 'data');"`）
 * 会被判成违规 —— 那是护栏的测试数据，不是真代码。判据：**命中点若落在字符串字面量
 * 内部，就不是可执行代码**。真实 store 的 `path.join(__dirname, '..', 'data')` 是代码，
 * 命中点落在字符串之外，照常命中。
 */
function stringSpans(src) {
  const spans = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      const start = i;
      i += 1;
      while (i < src.length) {
        const d = src[i];
        if (d === '\\') { i += 2; continue; }
        i += 1;
        if (d === q) break;
      }
      spans.push([start, i - 1]);
      continue;
    }
    i += 1;
  }
  return spans;
}

/** index 是否落在某个字符串字面量内部 */
function insideString(spans, index) {
  return spans.some(([o, c]) => index >= o && index <= c);
}

/** 1-based 行号 */
function lineAt(text, index) {
  return text.slice(0, index).split('\n').length;
}

/** 该行行首下标 */
function lineStart(text, index) {
  return text.lastIndexOf('\n', index - 1) + 1;
}

/**
 * 若 `text[i]` 是**正则字面量**的起始 `/`，返回该字面量结束后的下标；否则返回 -1。
 *
 * 不做这一步会出真事故：`xmlEsc` 里的 `.replace(/'/g, '&apos;')` 含一个引号，
 * 朴素扫描器会把它当成字符串起始，从此**再也没法正确配对花括号** —— 实测
 * `webdav-server.js`（40KB）只能算出 5 对括号，包含复制调用点的区间数为 0。
 */
function regexEnd(text, i) {
  if (text[i] !== '/') return -1;
  let j = i - 1;
  while (j >= 0 && /\s/.test(text[j])) j -= 1;
  if (j < 0) return -1;
  const prev = text[j];
  if (/[\w$)\]]/.test(prev)) {
    // 标识符 / `)` / `]` 之后的 `/` 更可能是除法；只有关键字之后才可能是正则
    const kw = /(?:return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await)$/
      .test(text.slice(Math.max(0, j - 12), j + 1));
    if (!kw) return -1;
  }
  let inClass = false;
  for (let k = i + 1; k < text.length; k += 1) {
    const c = text[k];
    if (c === '\\') { k += 1; continue; }
    if (c === '\n') return -1; // 正则字面量不跨行
    if (inClass) { if (c === ']') inClass = false; continue; }
    if (c === '[') { inClass = true; continue; }
    if (c === '/') {
      let e = k + 1;
      while (e < text.length && /[a-z]/.test(text[e])) e += 1; // 标志位
      return e;
    }
  }
  return -1;
}

/** 从 `{` 开始做花括号配对，返回函数体文本（会跳过字符串与正则里的花括号） */
function braceBody(text, openIndex) {
  let depth = 0;
  let quote = null;
  for (let i = openIndex; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === '\\') { i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '/') { const e = regexEnd(text, i); if (e > i) { i = e - 1; continue; } }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(openIndex, i + 1);
    }
  }
  return text.slice(openIndex);
}

/** 取该行自行首到 index 的前缀（用于判断「是不是方法定义」） */
function linePrefix(text, index) {
  return text.slice(lineStart(text, index), index);
}

/** 从 `(` 起做括号配对，返回匹配的 `)` 下标 */
function matchParen(text, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === '\\') { i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * 在本文件里找具名本地函数的定义体。
 * 支持四种形态：`function f(` / `async function f(` / `const f = function` / `const f = (…) => {`。
 *
 * ⚠️ 必须**先跨过参数表**再找函数体的 `{` —— 否则 `function persistMetaSync(opts = {})`
 * 会把参数默认值里那个 `{` 当成函数体，窗口退化成一个空壳（实测正是这么漏掉的）。
 *
 * @returns {{start:number, text:string, name:string, kind:string, idx:number}|null}
 *   start 是函数体 `{` 的下标；kind ∈ 'decl' | 'expr' | 'arrow' | 'method'；idx 是定义锚点下标
 */
function findLocalFn(text, name) {
  const esc = name.replace(/\$/g, '\\$');
  const pats = [
    { re: new RegExp(`(?:^|\\n)[ \\t]*(?:async[ \\t]+)?function[ \\t]+${esc}[ \\t]*\\(`, 'g'), kind: 'decl' },
    { re: new RegExp(`(?:^|\\n)[ \\t]*(?:const|let|var)[ \\t]+${esc}[ \\t]*=[ \\t]*(?:async[ \\t]+)?function\\b`, 'g'), kind: 'expr' },
    { re: new RegExp(`(?:^|\\n)[ \\t]*(?:const|let|var)[ \\t]+${esc}[ \\t]*=[ \\t]*(?:async[ \\t]+)?\\(`, 'g'), kind: 'arrow' },
    // R13-07：对象方法简写（`{ name(…) {} }` / `{ async name(…) {} }`）——
    // 接收者调用 `ns.name()` 沿调用链展开时，定义落在这个形态上。
    { re: new RegExp(`(?:^|[\\n{,])[ \\t]*(?:async[ \\t]+)?${esc}[ \\t]*\\(`, 'g'), kind: 'method' },
  ];
  for (const { re, kind } of pats) {
    const m = re.exec(text);
    if (!m) continue;
    const paren = text.indexOf('(', m.index);
    if (paren < 0) continue;
    const close = matchParen(text, paren);
    if (close < 0) continue;
    const open = text.indexOf('{', close);
    if (open < 0) continue;
    return { start: open, text: braceBody(text, open), name, kind, idx: m.index };
  }
  return null;
}

/**
 * R13-06：「是不是同一份定义」与「取 canonical 的函数体」**必须同源**。
 *
 * 旧实现把两件事拆成了两套正则：`uniqueImplViolations` 判「私有副本」用的定义正则
 * 认得箭头/函数表达式（`const f = …`），但取函数体校验 `mustContain` 时却只认
 * `function f(` 这一种 —— 于是把 canonical 从函数声明重构成箭头函数 + `return true`，
 * 护栏被**静默跳过**（找不到 `function f(` → 整段 mustContain 校验不执行），
 * 第 12 轮的头条修复原地复活。这里把「枚举全部形态的定义」收敛成唯一实现点，
 * 判副本与取体共用同一份匹配集合，形态重构不再可能绕过。
 */
function fnDefinitions(text, name) {
  const esc = name.replace(/\$/g, '\\$');
  const pats = [
    { re: new RegExp(`(?:^|\\n)[ \\t]*(?:async[ \\t]+)?function[ \\t]+${esc}[ \\t]*\\(`, 'g'), kind: 'decl' },
    { re: new RegExp(`(?:^|\\n)[ \\t]*(?:const|let|var)[ \\t]+${esc}[ \\t]*=[ \\t]*(?:async[ \\t]+)?function\\b`, 'g'), kind: 'expr' },
    { re: new RegExp(`(?:^|\\n)[ \\t]*(?:const|let|var)[ \\t]+${esc}[ \\t]*=[ \\t]*(?:async[ \\t]+)?\\(`, 'g'), kind: 'arrow' },
    { re: new RegExp(`(?:^|[\\n{,])[ \\t]*(?:async[ \\t]+)?${esc}[ \\t]*\\(`, 'g'), kind: 'method' },
  ];
  const out = [];
  for (const { re, kind } of pats) {
    let m;
    while ((m = re.exec(text)) !== null) {
      const paren = text.indexOf('(', m.index);
      if (paren < 0) continue;
      const close = matchParen(text, paren);
      if (close < 0) continue;
      const open = text.indexOf('{', close);
      if (open < 0) continue;
      out.push({ name, kind, idx: m.index, start: open, text: braceBody(text, open) });
    }
  }
  return out;
}

/**
 * 从一段代码里收集被调用的名字及其下标。
 *
 * R13-07 扩窗：旧正则 `(?:^|[^.\w$])name(` 只收**无接收者**的裸调用，
 * `ns.ensure()` / `obj.persistMetaSync()` / `secureStore.exitPathWritable()` 这类
 * 带接收者的调用被 `[.\w$]` 挡在门外 —— 把建目录动作挪进对象方法
 * （`const ns = { ensure(){ fs.mkdirSync(D) } }; process.on('exit', () => ns.ensure())`）
 * 就能整条绕过调用链展开。现在补一个 `\.name(` 分支：method 名也收集，
 * 由 {@link findLocalFn} 去本文件里找 `name(...)` 的对象方法简写定义。
 */
function calledNames(body) {
  const out = [];
  const seen = new Set();
  const push = (name, index) => {
    const k = `${name}@${index}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ name, index });
  };
  let m;
  const bare = /(?:^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g;
  while ((m = bare.exec(body)) !== null) { if (m[1]) push(m[1], m.index); }
  const dotted = /\.([A-Za-z_$][\w$]*)\s*\(/g;
  while ((m = dotted.exec(body)) !== null) { if (m[1]) push(m[1], m.index); }
  return out;
}

/** 内置/语法关键字，不是本地函数调用 */
const NOT_LOCAL_CALL = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'new', 'await',
  'require', 'Promise', 'Object', 'Array', 'JSON', 'Math', 'Date', 'String', 'Number', 'Boolean',
  'Set', 'Map', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'parseInt', 'parseFloat',
  'encodeURIComponent', 'decodeURIComponent', 'isNaN',
]);

/**
 * 把「exit 钩子体」沿本文件内的调用链展开（R12-09）。
 *
 * 旧窗口只有钩子体自身的字面 `mkdirSync`，把建目录动作挪进辅助函数（正是
 * `enc-store.persistMetaSync` 的形态）就能绕开 —— 变异 `if (opts.exit) return`
 * → `if (false)` 时本条仍绿。这里按 BFS 展开本地函数。
 *
 * R13-07：不再封顶层数。旧实现 `depth <= 3` 时，`exit→a→b→c→d`（d 内建目录）
 * 的分层重构天然越界逃逸。已访问集合（`seen`）本就保证收敛（同名函数只展开一次、
 * 递归不会死循环），层数上限纯属人为窗口 —— 删除。
 */
function exitReachableBodies(text, rootBody, rootStart) {
  const root = { start: rootStart, text: rootBody, depth: 0, entry: 0, parent: null };
  const out = [root];
  const seen = new Set();
  let frontier = [root];
  let depth = 0;
  while (frontier.length) {
    depth += 1;
    const next = [];
    for (const parent of frontier) {
      for (const call of calledNames(parent.text)) {
        if (NOT_LOCAL_CALL.has(call.name) || seen.has(call.name)) continue;
        seen.add(call.name);
        const fn = findLocalFn(text, call.name);
        if (!fn) continue;
        const node = { start: fn.start, text: fn.text, depth, entry: call.index, parent };
        out.push(node);
        next.push(node);
      }
    }
    frontier = next;
  }
  return out;
}

/**
 * 事件在调用链上的**程序序坐标**：从根起逐层记下「进入下一层的调用点下标」，
 * 末位是事件在自身函数体内的下标。字典序即执行先后。
 */
function eventPath(node, idx) {
  const p = [];
  let n = node;
  while (n && n.depth > 0) { p.unshift(n.entry); n = n.parent; }
  p.push(idx);
  return p;
}

/** 字典序比较；`<= 0` 表示 a 不晚于 b */
function cmpPath(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/** 一次线性扫描算出全部花括号配对（跳过字符串与正则），供"由内向外"查找复用 */
function braceSpans(text) {
  const spans = [];
  const stack = [];
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === '\\') { i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '/') { const e = regexEnd(text, i); if (e > i) { i = e - 1; continue; } }
    if (c === '{') stack.push(i);
    else if (c === '}') { const o = stack.pop(); if (o !== undefined) spans.push([o, i]); }
  }
  return spans;
}

/** 包含 index 的所有花括号区间，**由内向外**排序 */
function enclosingBodies(spans, text, index) {
  return enclosingSpans(spans, index).map(([o, c]) => text.slice(o, c + 1));
}

/** 同 {@link enclosingBodies}，但返回 `[open, close]` 下标（需要块首位置时用） */
function enclosingSpans(spans, index) {
  return spans
    .filter(([o, c]) => o < index && c > index)
    .sort((a, b) => b[0] - a[0]);
}

/**
 * 求「该块首语句」的起点下标：从块 `{` 往回找最近的语句/块边界。
 * `if (cond) {` 的块首语句就是 `if (cond)` —— 判据写在条件里时可据此识别。
 *
 * ⚠️ 必须按**括号深度**回溯：条件里常带对象字面量，
 * `if (gateway.rangeServable({ a: 1 })) {` 里那个 `{` 在 `if (...)` 的括号内部，
 * 用 `lastIndexOf('{')` 会停在它上面，把窗口缩成 `{ a: 1 }))`，判据就此丢失（实测误报）。
 */
function blockHeaderStart(text, open) {
  let depth = 0;
  for (let i = open - 1; i >= 0; i -= 1) {
    const c = text[i];
    if (c === ')') depth += 1;
    else if (c === '(') depth -= 1;
    else if (depth === 0 && (c === ';' || c === '{' || c === '}')) return i + 1;
  }
  return 0;
}

/* ==================== 检查 1 · 退出路径只写不建 ==================== */

/**
 * 类别：退出路径只写不建（canonical：`secure-store.exitPathWritable()`）
 *
 * `process.on('exit')` 的处理器里出现建目录动作时，测试收尾 / 运维清理刚删掉的
 * `data/` 会被退出钩子**原样重建并写回文件** —— "清理"被自己的钩子撤销。
 * 唯一实现点是 `secure-store.exitPathWritable()`（第 11 轮 R11-07 收敛）。
 *
 * **R12-09 扩窗**：窗口原本只有钩子体自身的字面 `mkdirSync`，而真实实现是
 * 「钩子 → 辅助函数 → 建目录」（`enc-store.js` 的 `persistMetaSync` 就是这么写的）。
 * 于是把 `if (opts.exit) return` 改成 `if (false)` 这类回归**本条照样全绿**。
 * 现在按调用链展开（见 {@link exitReachableBodies}），并把「有 canonical 守卫」
 * 作为唯一的放行条件 —— 即：**凡是退出路径能触达的建目录动作，必须被
 * `exitPathWritable` 挡住**。
 */
function exitMkdirViolations(src, rel) {
  const text = stripComments(src);
  const out = [];
  // R13-07：`process.once('exit')` 与 `process.on('exit')` 同为退出钩子 —— 只认 `on`
  // 时换成 `once` 即绕过。全库现有 3 处钩子均为 `on`，此分支为防逃逸。
  const re = /process\.(?:on|once)\(\s*['"]exit['"]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const open = text.indexOf('{', m.index);
    if (open < 0) continue;
    const body = braceBody(text, open);
    const chain = exitReachableBodies(text, body, open);
    /**
     * 放行条件不是「同一段代码里出现了守卫」，而是**守卫在调用链上不晚于建目录动作**：
     *  - `config-store` 的形态：钩子层判 `exitPathWritable`（depth 0），`encrypt` →
     *    `getMasterKey` → `ensureDataDir` 才建目录（depth 3）—— 守卫更早，合规；
     *  - `enc-store` 的形态：同一函数体内先判守卫（第 309 行）再 `mkdirSync`（第 310 行）
     *    —— 同层但守卫在先，合规；把两行调换个位置就会变红。
     * 于是「把 `if (opts.exit && !exitPathWritable(…)) return` 改成 `if (false)`」
     * 这类回归必然被抓到：链上再没有任何一层有守卫。
     */
    let mkdirAt = null;
    let guardAt = null;
    for (const b of chain) {
      const bad = /mkdirSync|\.mkdir\(|ensureDataDir/.exec(b.text);
      if (bad && (!mkdirAt || cmpPath(eventPath(b, bad.index), mkdirAt.path) < 0)) {
        mkdirAt = { node: b, index: bad.index, what: bad[0], path: eventPath(b, bad.index) };
      }
      const g = /exitPathWritable/.exec(b.text);
      if (g && (!guardAt || cmpPath(eventPath(b, g.index), guardAt.path) < 0)) {
        guardAt = { node: b, index: g.index, path: eventPath(b, g.index) };
      }
    }
    if (!mkdirAt) continue;
    // 守卫必须**不晚于**建目录（含同层且在其之前）
    if (guardAt && cmpPath(guardAt.path, mkdirAt.path) <= 0) continue;
    const at = mkdirAt.node.start >= 0
      ? lineAt(text, mkdirAt.node.start + mkdirAt.index)
      : lineAt(text, open + mkdirAt.index);
    out.push(`${rel}:${at} —— 退出路径的调用链（第 ${mkdirAt.node.depth} 层）出现建目录动作「${mkdirAt.what}」`
      + (guardAt
        ? '，而 exitPathWritable 守卫在它之后（守卫必须不晚于建目录）'
        : '，且链上没有任何 exitPathWritable 守卫'));
  }
  return out;
}

/* ==================== 检查 2 · 批量删除白名单判据 ==================== */

/**
 * 类别：批量删除白名单判据（canonical：`cos.deleteMultipleConfirmed()`）
 *
 * S3 兼容厂商在整批 200 的响应体里用 `<Error>` 报告单个 key 失败。裸调
 * `deleteMultipleObject` 并自己解读返回值的入口，迟早会把「未确认删除」当成成功
 * —— 于是清掉仍在的对象的解密凭据（永久不可解）/ 标掉仍在的分享链接。
 * 判据只允许存在于唯一实现点。
 */
function rawBatchDeleteViolations(src, rel) {
  const text = stripComments(src);
  const out = [];
  const re = /\bdeleteMultipleObject\s*\(/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const before = text.slice(Math.max(0, m.index - 12), m.index);
    // 字符串里的用法（`p(cos, 'deleteMultipleObject', …)`）不算调用点
    if (/['"]$/.test(before)) continue;
    // 方法定义（`deleteMultipleObject(params, cb) {`）不算调用点
    if (/^\s*$/.test(linePrefix(text, m.index))) continue;
    // 允许唯一实现点内部通过 p() 咽喉点调用
    if (/(?:^|[^.\w])(?:callP|p)\(\s*cos\s*,\s*$/.test(before)) continue;
    out.push(`${rel}:${lineAt(text, m.index)} —— 裸调 deleteMultipleObject（应改走 cos.deleteMultipleConfirmed）`);
  }
  return out;
}

/* ==================== 检查 3 · Accept-Ranges 与 GET 同源 ==================== */

/**
 * 类别：HEAD 与 GET 同源（canonical：`fs-gateway.rangeServable()`）
 *
 * 无条件宣告 `Accept-Ranges: bytes` 却不会服务 Range 时，续传客户端按区间建多个
 * 连接、每个却收到整份内容 → 拼装出损坏文件（与 R8-23 同型）。
 * 判据只允许来自 `rangeServable`。
 */
function acceptRangesViolations(src, rel) {
  const text = stripComments(src);
  const spans = braceSpans(text);
  const out = [];
  const re = /['"]Accept-Ranges['"]/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    /**
     * R13-07：旧窗口是「该行 + 上溯两行」，于是 `if (rangeServable(...)) {` 与
     * `res.setHeader('Accept-Ranges', …)` 之间隔一行注释就误报 —— 防护栏本该只认
     * 「是否受判据约束」，不该认「排版是否紧凑」。改为按**块上溯**：从该行的全部
     * 包含花括号区间里，取最内层那一块的块首前缀（`if (…)` / `else if (…)` 条件），
     * 判据出现在条件里即合规。单行形态（`if (cond) setHeader(...)`）块内文本自带
     * 条件，同样命中。
     */
    const spans2 = enclosingSpans(spans, m.index);
    const lineIdx = lineAt(text, m.index) - 1;
    const thisLine = text.split('\n')[lineIdx] || '';
    if (/rangeServable/.test(thisLine)) continue; // 同一行/同一语句内自带判据
    /**
     * 块首条件：`if (gateway.rangeServable(…)) {` 的判据写在 `{` **之前**，
     * 因此窗口取「块首语句起点 → 块 `{`」，而不是块内文本。
     * 逐层向外找：任一层块首条件含判据即合规（覆盖 if / else if / 多分支）。
     */
    let guarded = false;
    for (const [open] of spans2) {
      const header = text.slice(blockHeaderStart(text, open), open);
      if (/rangeServable/.test(header)) { guarded = true; break; }
    }
    if (guarded) continue;
    out.push(`${rel}:${lineIdx + 1} —— 无条件宣告 Accept-Ranges（必须受 rangeServable 约束，与 GET 同源）`);
  }
  return out;
}

/* ==================== 检查 4 · 缓存键含全部区分维度 ==================== */

/**
 * 类别：缓存键含全部区分维度（canonical：`_shared.bucketCacheKey()`）
 *
 * 不同厂商 / 不同密钥下可以有**同名桶**。缓存键只写桶名时，A 厂商 `my-bucket`
 * 的列举结果会被 B 厂商的同名桶命中（第 11 轮 R11-13）。
 *
 * 判据收紧过一次又放宽过一次，两次都记录在此：
 *  - 原判据要求首参**字面**是 `bucketCacheKey(`。搜索候选集接入时，路由里出现
 *    `const ident = bucketCacheKey(cfg);` 之后多处传 `ident`，字面判据会把合规代码判成违规。
 *  - 放宽的方式**不是**「允许任意变量」（那等于废掉这条判据 —— 当年的缺陷正是
 *    `keyOf(cfg.bucket, …)`），而是要求该变量**在本文件内由 `bucketCacheKey(` 直接赋值**。
 *    `const ident = cfg.bucket;` 依旧报违规，见下方的正/反样例。
 */
function cacheKeyViolations(src, rel) {
  const text = stripComments(src);
  const out = [];
  // 本文件内「由 canonical 直接赋值」的局部变量名（如 `const ident = bucketCacheKey(cfg)`）
  const canonicalIdents = new Set(
    [...text.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*bucketCacheKey\s*\(/g)]
      .map((x) => x[1]),
  );
  const re = /\bkeyOf\s*\(/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    // 定义处（`function keyOf(...)`）不是调用点
    if (/\bfunction\s+$/.test(linePrefix(text, m.index))) continue;
    const arg = text.slice(m.index + m[0].length, m.index + m[0].length + 40);
    if (/^\s*bucketCacheKey\s*\(/.test(arg)) continue;
    const first = /^\s*([A-Za-z_$][\w$]*)\s*[,)]/.exec(arg);
    if (first && canonicalIdents.has(first[1])) continue;
    out.push(`${rel}:${lineAt(text, m.index)} —— listCache.keyOf 的首参必须是 bucketCacheKey(cfg)`
      + `（实际「${(first ? first[1] : arg.split(',')[0]).trim()}」）`);
  }
  return out;
}

/* ==================== 检查 5 · 上游状态码不占本地 401/403 ==================== */

/**
 * 类别：上游状态码不占本地 401/403 语义
 *
 * 项目硬约定「401 = 没有有效会话」：前端一见 401 就强制登出。对象存储的 401 表达
 * 的是**密钥被拒绝**，透传的结果是「踢出 → 重新登录 → 再 401」的死循环（R11-04）。
 * 凡把上游状态变量回填给 `.status` 的赋值，都必须显式把 401 映射掉。
 */
/**
 * R13-07：放行条件从「rhs 里含 401 子串」收紧为「401 被显式映射到**非 401 的值**」。
 *
 * 报告点名的逃逸样本是 `err.status = up.statusCode >= 401 ? up.statusCode : 500;` ——
 * 401 只出现在比较里，then 分支又把上游状态原样回填，等于没映射。
 * 因此判据不能只看「401 后面跟着 `?`」（那连 `401 ? up.statusCode` 都会放行），
 * 必须要求 then 分支是**字面量且不是 401**（`=== 401 ? 502 :`、`>= 401 ? 502 :`）。
 * 数据驱动型映射（`401 ? up.statusCode`）一律判违规：那是把上游值当结果，不是映射。
 */
const MAPS_401 = /401\s*\?\s*(?!401\b)(?:\d+|'[^']*'|"[^"]*")/;

function upstreamStatusViolations(src, rel) {
  const text = stripComments(src);
  const out = [];
  // `(?!=)` 是必须的：`o.status === 'paid'` 里的 `===` 也会被 `=` 命中，
  // 那是比较不是赋值 —— 少了这一段会一次性误报 9 处（实测）。
  const re = /\.status\s*=(?!=)\s*([^;\n]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const rhs = m[1];
    /**
     * R12-11：旧判据是「rhs 里出现 `status` 单词」，于是两种常见写法**双双逃过**：
     *   `err.status = e.statusCode || 500;`   （腾讯云 SDK 的字段名是 statusCode）
     *   `o.status  = st >= 400 ? st : 500;`   （上游状态被存进局部变量）
     * 新判据反过来：只要 rhs **不是以字面量开头**（数字 / 字符串），就当作"状态可能
     * 来自上游"处理 —— 常量赋值（`= 502`、`= 'paid'`）天然放行。
     * 实测该口径在全库零新增命中，即不会引入误报。
     */
    if (/^\s*(?:'[^']*'|"[^"]*"|-?\d)/.test(rhs)) continue; // 字面量赋值
    if (MAPS_401.test(rhs)) continue; // 已显式把 401 映射到非 401
    out.push(`${rel}:${lineAt(text, m.index)} —— 把上游状态原样回填「${rhs.trim().slice(0, 60)}」`
      + '（必须先把 401 映射掉，不得占用本地「会话过期」语义；若确为本地常量表达式，请改写成字面量开头）');
  }
  return out;
}

/* ==================== 检查 5b · 状态码落地调用点 ==================== */

/**
 * 类别：状态码落地调用点（R13-07；与检查 5 同一纪律的另一半）
 *
 * 检查 5 只看 `.status =` 赋值，看不见 `res.status(变量)`。全库 80+ 处非字面量
 * `.status(` 里，绝大多数是 `e.status || 500`（其 `err.status` 由 cos.js:146 或路由
 * 本地赋值，被检查 5 罩住），真正的**裸变量**形态只有个位数 —— 但正是这几处绕过了
 * 「401 不得占本地语义」。这里把裸变量/含 401 的落地调用纳入窗口：
 *  - 含字面量 401（`st === 401 ? 502 : …`）→ 已映射，放行；
 *  - 其他非字面量（`r.rangeServed ? 206 : 200` 等本地推导）→ 无法静态判定来源，
 *    信任生产侧「本地推导 / 显式白名单」写法，不在这里枚举（枚举=把全部本地推导判违规）。
 *
 * 故本检查的违规面收敛为：**落地调用里出现了 401 字样但没有紧跟 `? <非401>` 的映射**。
 */
function statusCallViolations(src, rel) {
  const text = stripComments(src);
  const out = [];
  const re = /\.status\s*\(\s*([^)\n;]+)\)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const arg = m[1];
    if (!/401/.test(arg)) continue; // 不含 401 的本地推导放行
    if (MAPS_401.test(arg)) continue; // 401 已映射到非 401
    out.push(`${rel}:${lineAt(text, m.index)} —— 状态码落地里出现 401 却未映射「${arg.trim().slice(0, 60)}」`
      + '（401 是本地「会话过期」语义；上游 401 必须映射为 502 再落地）');
  }
  return out;
}

/* ==================== 检查 6 · HEAD 必须注册在 GET 之前 ==================== */

/**
 * 类别：HEAD 与 GET 同源（注册顺序那一半）
 *
 * express 的 `Route.prototype._handles_method` 对 HEAD 有回退：route 上没有显式
 * `head` 时把方法名退化成 `get`。因此 `router.head(p)` 若注册在 `router.get(p)`
 * 之后，HEAD 会命中 GET 的 layer 走**下载全路径**（R10-12 / R11-05）。
 */
function headOrderViolations(src, rel) {
  const text = stripComments(src);
  const seen = new Map(); // `${receiver}|${path}` -> { head, get }
  /**
   * R13-07：接收者不再写死为 `router|app`。全库现为 `router.` + 字面量路径，
   * 但把路由表换成 `const r = express.Router()` 这样的别名、或把前缀抽成常量，
   * 旧正则就整条看不见（潜在窗口）。现在接收者取任意标识符、路径仍要求字面量
   * （非字面量路径无法静态配对 head/get，属已承认的窗口）。
   */
  const re = /([A-Za-z_$][\w$]*)\.(head|get)\(\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    /**
     * 路由路径必然以 `/` 开头（或 WebDAV 的 `'*'`）；而 `req.get('x-enc-token')`、
     * `headers.get('content-length')` 这类**同名方法的非路由调用**不会有这种实参。
     * 少了这层过滤，泛化接收者会凭空造出噪声命中（实测 6 处）。
     */
    if (!/^(?:\/|\*)/.test(m[3])) continue;
    const k = `${m[1]}|${m[3]}`;
    const rec = seen.get(k) || {};
    if (rec[m[2]] === undefined) rec[m[2]] = { index: m.index, line: lineAt(text, m.index) };
    seen.set(k, rec);
  }
  const out = [];
  for (const [k, rec] of seen) {
    if (!rec.head || !rec.get) continue;
    if (rec.head.index > rec.get.index) {
      out.push(`${rel}:${rec.head.line} —— ${k.split('|')[1]} 的 head 注册在 get 之后`
        + '（express 会让 HEAD 退化成 GET → 每次 HEAD 都下载整份对象）');
    }
  }
  return out;
}

/* ==================== 检查 7 · 反向变异 anchor 必须命中 ==================== */

/**
 * 类别：反向变异 anchor 有效
 *
 * `scripts/reverse-check.js` 里登记的每条变异，anchor 必须**在它自己的 file 内**
 * 命中。第 11 轮 R11-18 实测有 3 条 anchor 早已不存在 —— 而脚本只会在跑到那一条
 * 时才报「锚点未命中」，没人跑就等于没登记。**按各条自己的 file 校验，不能全库搜**：
 * 在全库搜会被历史 md 里引用的同名词骗过，误报「0 条失效」。
 */
const { CASES } = require('../scripts/reverse-check.js');

function anchorViolations() {
  const out = [];
  /**
   * 变异态豁免：`scripts/reverse-check.js` 在跑单条对照时，会把该条 anchor 从工作区
   * 文件里**故意删掉**，于是「anchor 必须命中」必然报红 —— 但那是变异生效的证据，
   * 不是锚点腐烂。本自检只对**提交态**有意义，故在变异期（由脚本注入的环境变量标记）
   * 直接跳过，避免掩盖「真实不变量到底抓没抓到」。
   */
  if (process.env.REVERSE_CHECK_MUTATING === '1') return out;
  for (const c of CASES) {
    // 退役项不再参与运行，其 anchor 腐烂也就无所谓 —— 单独由下面的
    // 「退役项必须写明原因」用例管住「退役不得偷偷摸摸」。
    if (c.retired) continue;
    if (!c.file) { out.push(`用例「${c.name}」缺少 file`); continue; }
    const target = path.join(ROOT, c.file);
    if (!fs.existsSync(target)) { out.push(`用例「${c.name}」的文件不存在：${c.file}`); continue; }
    /**
     * R13-07：比对前先剥注释 —— anchor 已被删但字面片段留在注释里时，
     * 未剥注释的原文会把失效 anchor「救活」（一段注释即可掩盖任意多条失效对照）。
     * 两侧都要剥：anchor 自身常含 `//` 说明行（如 R7-02），只剥 src 会假报警。
     * `.md` 走 `md:true`（只剥 HTML 注释）—— 文档里的 `/*` 是路径/glob 文本。
     */
    const isMd = c.file.endsWith('.md');
    const src = stripComments(fs.readFileSync(target, 'utf8'), { md: isMd });
    const steps = Array.isArray(c.mutations) ? c.mutations : [{ anchor: c.anchor }];
    steps.forEach((st, i) => {
      const needle = stripComments(String(st.anchor), { md: isMd });
      /**
       * R14 复核新增：纯注释 anchor（剥注释后只剩空白）**无法被本检查验证** ——
       * 「命中」会因为「源码里到处是空白」而恒真，唯一性更会得到荒谬的计数
       * （实测：R9-06 的旧 anchor 报「出现 67 次」）。剥离注释的代价就是看不见注释，
       * 所以 anchor 必须带上紧随其后的代码行 —— 那也正是脚本真正施加变异的位置。
       */
      if (needle.trim() === '') {
        out.push(`用例「${c.name}」第 ${i + 1} 步 anchor 全是注释，剥注释后无法验证：`
          + '请把紧随其后的代码行一起写进 anchor。'
          + JSON.stringify(String(st.anchor).slice(0, 80)));
        return;
      }
      if (src.indexOf(needle) < 0) {
        out.push(`用例「${c.name}」第 ${i + 1} 步 anchor 在 ${c.file} 内未命中：`
          + JSON.stringify(String(st.anchor).slice(0, 80)));
        return;
      }
      /**
       * R14 复核新增：anchor 还必须在文件内**唯一**。
       *
       * `scripts/reverse-check.js` 用 `String.replace(anchor, replacement)` 施加变异，
       * 而它只替换**首处**。anchor 重复时变异会打到无关分支 → 变异不生效 → 假绿
       * （`fail=0` 却不报错）。第 14 轮已在 R14-05 / R10-11 上真实中招两次，复核时又在
       * R11-06 发现一处"眼下侥幸正确"的重复 anchor（顺序一换就静默打偏）——
       * 靠人记得去数重数必然再漏，故把「命中」升级为「唯一命中」。
       */
      const n = src.split(needle).length - 1;
      if (n > 1) {
        out.push(`用例「${c.name}」第 ${i + 1} 步 anchor 在 ${c.file} 内出现 ${n} 次`
          + '（`replace` 只替换首处 → 变异可能打到无关分支，得到假绿）：'
          + JSON.stringify(String(st.anchor).slice(0, 80)));
      }
    });
  }
  return out;
}

/* ============ 检查 8 · 数据目录必须支持 COS_DATA_DIR（R12-01） ============ */

/**
 * 类别：测试隔离（canonical：`process.env.COS_DATA_DIR`）
 *
 * 第 12 轮**实际发生**了一起数据事故：`config-store` 是全库唯一一个硬编码
 * `path.join(__dirname, '..', 'data')` 的 store，于是 `npm test` 会把生产
 * `data/config.enc`（内含全部云厂商密钥）反复解密→重加密→原子替换。
 * 这条检查守住「任何 store 都不许绕过隔离开关」。
 *
 * 允许三元表达式（`?:` 的回退分支就是硬编码路径）——判据是**同一行**里必须出现
 * `COS_DATA_DIR`，因为项目里所有 store 都写成一行三元。
 */
/**
 * R13-07：匹配放宽为「`__dirname` / `process.cwd()` 参与、且参数里含 data 段」。
 * 旧正则只认 `path.join(__dirname, '..', 'data')` 三参数形态 —— 换成单参数的
 * `path.join(__dirname, '../data')` 即绕过（当时命中恰 10 处、下界 9，只剩 1 的余量）。
 * 现在按参数段判定，凡以 `__dirname`/`cwd()` 为锚、拼出 data 目录的写法都进窗口；
 * 放行条件不变（同一行含 `COS_DATA_DIR` 的三元回退分支）。
 */
const DATA_DIR_RE = /path\.(?:join|resolve)\(([^;\n]*)\)/g;

function dataDirViolations(src, rel) {
  const text = stripComments(src);
  const spans = stringSpans(text);
  const out = [];
  let m;
  while ((m = DATA_DIR_RE.exec(text)) !== null) {
    // 护栏自身的「违规样例字符串」不是代码（见 stringSpans 的说明）
    if (insideString(spans, m.index)) continue;
    const args = m[1];
    if (!/__dirname|process\.cwd\(\)/.test(args)) continue;
    if (!/['"](?:\.\.[\/\\])?data['"]/.test(args)) continue;
    const nl = text.indexOf('\n', m.index);
    const line = text.slice(lineStart(text, m.index), nl < 0 ? text.length : nl);
    if (/COS_DATA_DIR/.test(line)) continue; // 三元回退分支，合规
    out.push(`${rel}:${lineAt(text, m.index)} —— 硬编码 data 目录`
      + '（必须支持 COS_DATA_DIR —— 否则测试进程会直接改写生产配置与凭据）');
  }
  return out;
}

/* ========= 检查 9 · 唯一实现点必须被调用且无私有副本（R12-03） ========= */

/**
 * 类别：纪律的唯一实现点（第 11 轮 §9.3 R2 的机器化）
 *
 * 第 12 轮 §0.2 实测：`secure-store.exitPathWritable()` 被声明为 canonical，
 * 但**生产侧零调用**（一处私有副本 + 两处内联）。把 canonical 改成 `return true`，
 * 两套护栏**全绿** —— 说明这份"唯一实现点"没有人在守。
 *
 * 因此这里守三件事：① 全库只有一处定义；② 定义位置与登记表一致；
 * ③ 有真实调用；④ canonical 的函数体里仍含判据（不许退化成 `return true`）。
 */
const CANONICAL_IMPLS = [
  {
    name: 'exitPathWritable',
    file: 'server/secure-store.js',
    /** canonical 的函数体内必须出现这段（防止被改成 `return true`） */
    mustContain: /existsSync/,
    why: '「退出路径只写不建」的唯一判据',
    /**
     * R13-07：`minCalls` 是「计数代理」—— 全库总数够就放行，于是「删一处真实接线 +
     * 在没人读的地方补一处空调用」即可绕过。改为**按入口清单逐文件**校验：每个登记入口
     * 都必须真的出现调用。三处 exit 钩子分属三个文件，逐文件点名后此路不通。
     */
    callers: ['server/config-store.js', 'server/enc-store.js', 'server/upload-sessions.js'],
  },
  {
    name: 'rollbackCopies',
    file: 'server/fs-gateway.js',
    /**
     * canonical 必须仍走批量删除的白名单判据 —— 否则「回滚了但实际没删掉」
     * 会让日志谎报「已自动回滚 N 个副本」（R12-04 之前 `routes/fs.js` 那份
     * 逐对象 `deleteObject` 的私有实现正是这个形态）。
     */
    mustContain: /deleteMultipleConfirmed/,
    why: '「复制失败必须回滚」的唯一实现点（三处复制入口共用）',
    /** 三处复制入口：routes/fs.js、fs-gateway.movePrefix、WebDAV 目录 COPY（逐文件校验） */
    callers: ['server/routes/fs.js', 'server/fs-gateway.js', 'server/webdav-server.js'],
  },
];

/** @param {Array<{rel:string,src:string}>} files */
function uniqueImplViolations(files) {
  const out = [];
  for (const spec of CANONICAL_IMPLS) {
    const esc = spec.name.replace(/\$/g, '\\$');
    const defs = [];
    let hits = 0;
    let defHits = 0;
    for (const f of files) {
      const t = stripComments(f.src);
      // R13-06：判「私有副本」的定义枚举与下方取 canonical 函数体**同源**（fnDefinitions），
      // 四种形态 + 方法简写全覆盖 —— 重构成箭头函数不再可能让 mustContain 校验静默跳过。
      for (const def of fnDefinitions(t, spec.name)) {
        defs.push(`${f.rel}:${lineAt(t, def.idx)}`);
        // 只有「声明」与「对象方法」两种形态本身含 `name(` —— 箭头/函数表达式
        // 的定义文本是 `name = (…) =>`，不会贡献 `name(` 命中，扣减时必须区分，
        // 否则会把真实调用也扣掉（实测：箭头定义 + 一处调用被算成 0 次）。
        if (def.kind === 'decl' || def.kind === 'method') defHits += 1;
      }
      const cre = new RegExp(`${esc}\\s*\\(`, 'g');
      while (cre.exec(t) !== null) hits += 1;
    }
    if (defs.length === 0) {
      out.push(`${spec.name}（${spec.why}）已无定义 —— 唯一实现点消失了`);
      continue;
    }
    for (const d of defs) {
      if (!d.startsWith(`${spec.file}:`)) {
        out.push(`${d} —— ${spec.name} 的**私有副本**（唯一实现点是 ${spec.file}）`);
      }
    }
    if (spec.callers) {
      /**
       * R13-07：按入口清单**逐文件**校验，取代 `minCalls` 计数代理。
       * 登记入口缺一个就报一个 —— 「删一处真接线、补一处没人读的空调用」无法绕过。
       */
      for (const cf of spec.callers) {
        const f = files.find((x) => x.rel === cf);
        if (!f) { out.push(`${cf} —— 登记入口文件已不存在（唯一实现点 ${spec.name} 的接线清单过期）`); continue; }
        const t = stripComments(f.src);
        // 调用次数 = `name(` 命中数 − 该文件内**本身含 `name(` 的**定义数
        //（`function f(` 与对象方法简写；箭头/函数表达式定义不贡献命中，见上）
        const localDefs = fnDefinitions(t, spec.name)
          .filter((d) => d.kind === 'decl' || d.kind === 'method').length;
        const fileHits = (t.match(new RegExp(`${esc}\\s*\\(`, 'g')) || []).length;
        if (fileHits - localDefs < 1) {
          out.push(`${cf} —— 登记入口里没有对 ${spec.name} 的调用（${spec.why}）—— `
            + '少一处就说明该入口又自己写了一份，纪律等于没落地');
        }
      }
    } else {
      // 未配 callers 的条目退回计数口径（保留旧行为的下界）
      const calls = hits - defHits;
      const min = spec.minCalls || 1;
      if (calls < min) {
        out.push(`${spec.name}（${spec.why}）在生产侧调用数 ${calls}，应至少 ${min} 处 —— `
          + '少了就说明某个入口又自己写了一份，纪律等于没落地');
      }
    }
    const canon = files.find((f) => f.rel === spec.file);
    if (canon) {
      const t = stripComments(canon.src);
      // R13-06：取函数体与判定义同源（findLocalFn，四种形态）——
      // canonical 被重构成箭头/函数表达式时，mustContain 校验照常执行，不再静默跳过。
      const fn = findLocalFn(t, spec.name);
      if (fn) {
        if (!spec.mustContain.test(fn.text)) {
          out.push(`${spec.file}:${lineAt(t, fn.idx)} —— ${spec.name} 的函数体里已无判据`
            + `（必须仍含 ${spec.mustContain}；退化成 \`return true\` 会让整条纪律失效）`);
        }
      } else if (fnDefinitions(t, spec.name).length === 0) {
        // 定义枚举说有、findLocalFn 说没有 —— 只可能是取体失败（防御性兜底，正常不会到）
        out.push(`${spec.file} —— ${spec.name} 的函数体取不出（findLocalFn 失败），mustContain 无法校验`);
      }
    }
  }
  return out;
}

/* ======= 检查 10 · 必须同时注册 HEAD 的路径登记表（R12-10） ======= */

/**
 * 类别：HEAD 与 GET 同源（"缺失"那一半）
 *
 * 检查 6 只能抓「head 注册在 get 之后」；**把 `router.head` 整行删掉**时它因为
 * `if (!rec.head || !rec.get) continue` 而继续全绿 —— 而 §9.4 类别表承诺的违规面
 * 恰恰是「有 get 无 head」（express 会让 HEAD 退化成 GET，每次探测都整份下载）。
 * 登记表是双向闭合的：既校验表内条目仍在，也校验表外没有新的 head+get 组合。
 */
const HEAD_REQUIRED = [
  { file: 'server/routes/fs.js', path: '/fs/download' },
  { file: 'server/share-routes.js', path: '/s/:id/dl' },
  { file: 'server/webdav-server.js', path: '*' },
];

/** @param {(rel:string)=>string|null} read */
function headMissingViolations(read) {
  const out = [];
  for (const e of HEAD_REQUIRED) {
    const src = read(e.file);
    if (src === null || src === undefined) { out.push(`${e.file} 不存在（登记表条目过期）`); continue; }
    const text = stripComments(src);
    const p = e.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // R13-07：接收者泛化 —— 把路由表换成别名（`const r = express.Router()`）后，
    // 写死 `router|app` 会让本条**看不见**新注册的 head/get，登记表随之失真。
    const has = (m) => new RegExp(`[A-Za-z_$][\\w$]*\\.${m}\\(\\s*['"]${p}['"]`).test(text);
    if (!has('get')) {
      out.push(`${e.file} —— 登记表条目「${e.path}」已过期（该文件已无同名 get）`);
    } else if (!has('head')) {
      out.push(`${e.file} —— 「${e.path}」注册了 get 却没有 head`
        + '（express 会把 HEAD 退化成 GET → 每次 HEAD 都走整份下载）');
    }
  }
  return out;
}

/** 反向闭合：代码里出现了 head+get 组合，但登记表里没有 */
function headTableStaleViolations(files) {
  const out = [];
  for (const f of files) {
    const text = stripComments(f.src);
    // R13-07：接收者泛化（同 headOrderViolations），并沿用「路径以 `/` 开头或为 `*`」
    // 的过滤 —— 否则 `req.get('x-enc-token')` 之类会被当成路由登记漏项而误报。
    const re = /([A-Za-z_$][\w$]*)\.(head|get)\(\s*['"]([^'"]+)['"]/g;
    const seen = new Map();
    let m;
    while ((m = re.exec(text)) !== null) {
      if (!/^(?:\/|\*)/.test(m[3])) continue;
      const rec = seen.get(m[3]) || {};
      rec[m[2]] = rec[m[2]] ?? lineAt(text, m.index);
      seen.set(m[3], rec);
    }
    for (const [p, rec] of seen) {
      if (rec.head === undefined || rec.get === undefined) continue;
      if (!HEAD_REQUIRED.some((e) => e.file === f.rel && e.path === p)) {
        out.push(`${f.rel}:${rec.head} —— 「${p}」同时注册了 head 与 get，`
          + '但未登记进 HEAD_REQUIRED（登记表必须双向闭合）');
      }
    }
  }
  return out;
}

/* ========= 检查 11 · 批量复制入口必须有回滚（R12-04） ========= */

/**
 * 类别：复制失败必须回滚到干净起点
 *
 * 这条纪律已经重写过三遍（管理端 `routes/fs.js`、`fs-gateway.movePrefix`、
 * WebDAV 目录 COPY），每次都是**新入口漏网**。与其补第四份，第 12 轮把判据下沉成
 * `gateway.rollbackCopies()`；这里再守一层：**凡含循环/并发的复制块，都必须有回滚调用**。
 * 单对象复制（复制成功即删源）不适用，故只在块内出现 `for` / `forEach` / `Promise.all` 时要求。
 */
const BATCH_MARKER = /(?:^|[^\w.])(?:for|while)\s*\(|\.forEach\(|\.map\(|Promise\.all/;
const ROLLBACK_MARKER = /rollbackCopies|deleteMultipleConfirmed/;

/**
 * 找包含 `index` 的最内层**具名**函数，返回名字（找不到返回 null）。
 * 支持 `function f(` / `const f = (…) =>` / `const f = function` / 对象方法简写。
 */
function innermostNamedFn(text, spans, index) {
  for (const [o] of enclosingSpans(spans, index)) {
    const header = text.slice(blockHeaderStart(text, o), o);
    let m = /function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(header);
    if (m) return m[1];
    m = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(header);
    if (m) return m[1];
    m = /([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*$/.exec(header);
    if (m && !/^(?:if|for|while|switch|catch|function)$/.test(m[1])) return m[1];
  }
  return null;
}

/**
 * 在某一个「复制调用点」上判断回滚是否到位。
 * @returns {boolean|null} true=有回滚；false=有批次块但无回滚；null=该点不是批量复制
 */
function rollbackAtSite(text, spans, index) {
  const bodies = enclosingBodies(spans, text, index);
  if (!bodies.length) return null;
  /**
   * 并发/循环标记与回滚调用常常**不在同一层**：WebDAV 目录 COPY 是
   * `worker 内的 while`（复制在最内层）→ `Promise.all`（并发标记在上一层）
   * → `catch` 里的 `rollbackCopies`（回滚在最外层的处理函数里）。
   * 因此判据是：**从出现并发标记的那一层起，向外任意一层有回滚即合规**。
   */
  const batchFrom = bodies.findIndex((b) => BATCH_MARKER.test(b));
  if (batchFrom < 0) return null; // 单对象复制（复制成功即删源），不适用
  return bodies.slice(batchFrom).some((b) => ROLLBACK_MARKER.test(b));
}

function copyRollbackViolations(src, rel) {
  const text = stripComments(src);
  const spans = braceSpans(text);
  const out = [];
  const re = /\b(copyObject|putObjectCopy|sliceCopyFile)\s*\(/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    // 方法定义（`putObjectCopy(params, cb) {`）本身不是调用点
    if (/^\s*$/.test(linePrefix(text, m.index))) continue;
    // `this.putObjectCopy(...)` 是 SDK 客户端内部的方法分派（`s3-client` / `cos`），
    // 它是**复制原语**而不是复制入口 —— 由调用它的业务入口负责回滚。
    if (/\bthis\.\s*$/.test(text.slice(Math.max(0, m.index - 6), m.index))) continue;
    /**
     * R13-07：沿**调用链反查祖先批次块**。
     *
     * 旧窗口只沿花括号由内向外看：`copyOne()` 抽成 helper、批次循环留在调用者里时，
     * 复制点自己的括号链上**根本没有**批次标记 → 直接 `continue`（等于豁免），
     * 重构第一步护栏就失效（与 R12-09 的退出路径同构）。现在：本层链上没有批次块
     * 时，反查「最内层具名函数」的调用点，在调用者的链上继续判 —— 直到找到批次块
     * （给出结论）或穷尽（仍豁免）。已访问调用点集合保证收敛。
     */
    const seen = new Set([m.index]);
    const queue = [m.index];
    let verdict = null;
    while (queue.length && verdict === null) {
      const site = queue.shift();
      verdict = rollbackAtSite(text, spans, site);
      if (verdict !== null) break;
      const fn = innermostNamedFn(text, spans, site);
      if (!fn) continue;
      const cre = new RegExp(`\\b${fn.replace(/\$/g, '\\$')}\\s*\\(`, 'g');
      let cm;
      while ((cm = cre.exec(text)) !== null) {
        if (seen.has(cm.index)) continue;
        if (/^\s*$/.test(linePrefix(text, cm.index))) continue; // 定义处，不是调用
        seen.add(cm.index);
        queue.push(cm.index);
      }
    }
    if (verdict !== false) continue; // null = 非批量复制（豁免）；true = 已合规
    out.push(`${rel}:${lineAt(text, m.index)} —— 批量复制块内没有回滚`
      + '（复制中途失败会留下半份副本；唯一实现点是 gateway.rollbackCopies）');
  }
  return out;
}

/* ======== 检查 12 · 验证码脚本源必须被 CSP 允许（R14-02） ======== */

/**
 * R14-02：CSP 的 host-source 是**精确匹配** —— `recaptcha.net` 不匹配 `www.recaptcha.net`。
 * 前端 `CAPTCHA_SCRIPTS`（`public/js/main.js`）与服务端 CSP `script-src`（`server/index.js`）
 * 分处两个文件，靠人眼对齐必然漂移。一旦漂移：
 *
 *   脚本被 CSP 拦截 → 组件永不 load → 而 `captchaState.active` 已被置真
 *   → 每次点登录都只回「请先完成人机验证」→ **全站账号无法登录**（管理员自己也进不去）。
 *
 * 这是典型的「配置正确、部署正常、功能为零」，服务端日志里几乎不留痕迹，只能靠静态护栏守住。
 *
 * @param {string} mainSrc public/js/main.js 全文
 * @param {string} idxSrc server/index.js 全文
 * @returns {string[]} 违规描述
 */
function captchaSources(mainSrc) {
  const m = /const CAPTCHA_SCRIPTS\s*=\s*\{([\s\S]*?)\n\};/.exec(mainSrc);
  assert(m, 'public/js/main.js 中应存在 CAPTCHA_SCRIPTS 常量（提取不到 = 本条检查已失效）');
  return [...m[1].matchAll(/'(https?:\/\/[^']+)'/g)].map((x) => x[1]);
}

/** @param {string} idxSrc */
function cspScriptSrc(idxSrc) {
  // 必须先剥注释：`index.js` 的 SEC-06 注释里就写着「移除 script-src 的 'unsafe-inline'」，
  // 不剥离的话正则会先命中注释行，把真正的 CSP 段整个错过（R13 反复强调：地基比判据重要）。
  // CSP 由若干字符串常量拼接而成，但 `script-src …;` 整段落在同一个字面量内。
  const m = /script-src([^;"\n]*)/.exec(stripComments(idxSrc));
  assert(m, 'server/index.js 中应存在 CSP 的 script-src 段（提取不到 = 本条检查已失效）');
  return m[1];
}

/** @param {string} mainSrc @param {string} idxSrc */
function captchaCspViolations(mainSrc, idxSrc) {
  const csp = cspScriptSrc(idxSrc);
  const out = [];
  for (const url of captchaSources(mainSrc)) {
    const origin = url.replace(/^(https?:\/\/[^/]+).*$/, '$1');
    if (!csp.includes(origin)) {
      out.push(`public/js/main.js：验证码脚本源 ${origin} 不在 CSP script-src 中`
        + `（host-source 是精确匹配 —— 少一个 www 就会被拦截，进而锁死全站登录）`);
    }
  }
  return out;
}

/* ==================== 第十四轮：R14 系列静态护栏 ==================== */

/**
 * 从 `start` 起取函数/处理器体的 `{...}`（配平）。
 *
 * ## ⚠️ R14 复核修正：必须按 `start` 的形态分两路
 *
 * **函数声明 / 箭头函数**（`function create({ … }) {`、`async (a) => {`）：
 * 只取第一个 `{` 会拿到**解构参数模式本身** —— 函数体于是变成 `{ linkId, platform }`，
 * 里面当然扫不到任何东西，检查恒绿而且看不出来。R14-09 的「prune 必须被总量守卫」
 * 检查在反向对照里就是这么假绿的（撤掉守卫仍 fail=0）。故先跨过参数表。
 * 这个坑 `findLocalFn()` 早在 R13-07 就踩过并写进了注释（见其 docblock），
 * 但本函数（后来新增）没跟着修 —— 又一处「同一逻辑两份实现，修一份漏一份」。
 *
 * **路由/方法调用**（`router.get('/x', async (req, res) => {`）：
 * 这种情况下**不能**跨参数表 —— 外层 `router.get(` 的配平右括号在整条语句的末尾，
 * 跨过去会落到**下一个**路由的函数体上（实测：`/fs/stat` 的检查因此扫到了 `/fs/search`
 * 的处理器，干干净净地报出三条"违规"）。这里直接取 `start` 之后的第一个 `{` 即可，
 * 参数表里不存在花括号。
 */
function braceBodyFrom(t, start) {
  const head = t.slice(start, start + 24);
  const isFnDecl = /^(?:async\s+)?function\b/.test(head) || /^(?:async\s+)?\([^)]*\)\s*=>/.test(head);
  let open;
  if (isFnDecl) {
    const p = t.indexOf('(', start);
    const close = p >= 0 ? matchParen(t, p) : -1;
    open = t.indexOf('{', close > p ? close : start);
  } else {
    open = t.indexOf('{', start);
  }
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < t.length; i++) {
    const c = t[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return t.slice(open, i + 1); }
  }
  return t.slice(open);
}

/**
 * 检查 13 · rename 写入侧必须与 `normalizeKey` 同源（R14-13）
 *
 * 名字校验的字符集不含点号，于是 `newName='..'` 会被拼成键 `a/..` 写进云端；
 * 而删除 / 移动 / stat 都要跑 `normalizeKey`（含 `..` 即抛 400）——
 * 该对象从此**永远删不掉**，界面还渲染出一个名为 `..` 的条目，点一下就是 400。
 * 让拼出来的 `newKey` 直接过一遍 `normalizeKey`，写入侧就与读删侧共用同一把尺子。
 */
function renameKeyViolations(src, rel) {
  const t = stripComments(src);
  const out = [];
  for (const m of t.matchAll(/const\s+newKey\s*=\s*([^\n;]+);/g)) {
    if (!/normalizeKey\s*\(/.test(m[1])) {
      out.push(`${rel}:${lineAt(t, m.index)} —— 拼出的 newKey 必须过 normalizeKey`
        + '（否则会产出「写得出、删不掉」的幽灵对象）');
    }
  }
  return out;
}

/**
 * 检查 14 · 异步写不得持有 await 之前的 store 引用（R14-04）
 *
 * `load()` 在 60 秒 TTL 到期时会把 `cached` 换成**新对象**。若 `addUser` / `updateUser`
 * 在 `await hashPassword()`（scrypt，约 50~100ms）**之前**取了 store，await 之后继续改它、
 * 再 `persist()`，就会把这段时间内别人的写入整体覆盖 —— 双方都收到成功响应，
 * 一方的变更却静默消失（丢的若是角色/权限，就表现为「降权不生效」）。
 * 判据：函数体内所有 `requireStore()` 必须晚于所有 `await`。
 */
function asyncStoreWriteViolations(src, rel) {
  const t = stripComments(src);
  const out = [];
  for (const name of ['addUser', 'updateUser']) {
    const i = t.indexOf(`async function ${name}(`);
    if (i < 0) continue;
    const body = braceBodyFrom(t, i);
    const awaits = [...body.matchAll(/\bawait\s+/g)].map((m) => m.index);
    if (!awaits.length) continue; // 没有 await 就无从产生异步间隙
    for (const m of body.matchAll(/\brequireStore\s*\(/g)) {
      if (awaits.some((a) => a > m.index)) {
        out.push(`${rel}:${lineAt(t, i + t.slice(i).indexOf(body) + m.index)} —— `
          + `${name} 在 await 之前取了 store：await 期间 TTL 重载会换掉 cached 对象，`
          + '随后的写入会整体覆盖别人的变更（静默丢更新）');
      }
    }
  }
  return out;
}

/**
 * 检查 15 · 发起支付必须先查当前支付态（R14-05）
 *
 * `GET /s/:id` 与 `/s/:id/dl` 都调 `payerStateFor`，唯独 `POST /s/:id/pay` 没调 ——
 * 于是已付用户再点一次付费，新 pending 的票据**覆盖**已付票据，支付态由 paid 退回 pending
 * （管理页显示已付、用户手上却没有可用凭证）。同时每次点击都新建订单，
 * 也是 R14-03「灌单挤出在途订单」的推手。
 */
function payStateViolations(src, rel) {
  const t = stripComments(src);
  const i = t.indexOf("router.post('/s/:id/pay'");
  if (i < 0) return []; // 不是 share-routes.js
  const body = t.slice(i, i + 4000);
  const check = body.indexOf('payerStateFor');
  const create = body.indexOf('paymentOrders.create');
  const out = [];
  if (check < 0) {
    out.push(`${rel}:${lineAt(t, i)} —— POST /s/:id/pay 必须先查当前支付态（payerStateFor）`);
  } else if (create >= 0 && check > create) {
    out.push(`${rel}:${lineAt(t, i)} —— payerStateFor 必须早于 paymentOrders.create`);
  }
  return out;
}

/**
 * 检查 16 · WebDAV 独立实例必须有安全响应头，可渲染类型不得内联（R14-06）
 *
 * 8443 端口是**另一个 Express 实例**，主站那套安全头一份都不会自动带上。
 * 而 `html`/`svg` 被映射成可渲染类型，浏览器打开即在源内执行脚本，
 * 配合被缓存的 Basic 凭据 = 一个文件拿到该账户名下全部桶的读写删权限。
 */
function webdavHeaderViolations(src, rel) {
  const t = stripComments(src);
  if (!/buildApp/.test(t)) return []; // 不是 webdav-server.js
  const out = [];
  if (!/Content-Security-Policy/.test(t)) {
    out.push(`${rel} —— WebDAV 是独立的 Express 实例，必须自带 Content-Security-Policy`);
  }
  if (!/X-Content-Type-Options/.test(t)) {
    out.push(`${rel} —— WebDAV 必须自带 X-Content-Type-Options: nosniff`);
  }
  if (/['"]image\/svg\+xml['"]/.test(t) && !/Content-Disposition/.test(t)) {
    out.push(`${rel} —— 存在可渲染类型（svg）却没有 Content-Disposition 强制附件下载`);
  }
  return out;
}

/**
 * 检查 17 · WebDAV 认证：口令错误也必须走 dummyHash（R14-07）
 *
 * 「用户名不存在」分支跑一次完整 scrypt（约 50ms），而「用户名存在但口令错误」
 * 只做 AES-GCM 解密 + 两次 SHA-256（微秒级）—— 不补 dummyHash 的话侧信道恰好**反向放大**：
 * 有效用户名是「快」的那个，单次请求即可枚举全部 WebDAV 账户名。
 */
function webdavAuthTimingViolations(src, rel) {
  const t = stripComments(src);
  const i = t.indexOf('function authenticateWebdav(');
  if (i < 0) return []; // 不是 config-store.js
  const body = braceBodyFrom(t, i);
  const n = (body.match(/dummyHash\s*\(/g) || []).length;
  // 三条失败路径都要打点：未启用 / 用户名不存在 / 口令错误
  if (n < 3) {
    return [`${rel}:${lineAt(t, i)} —— authenticateWebdav 内 dummyHash 只出现 ${n} 次（应 ≥3）：`
      + '口令错误分支不打点的话，「有效用户名 = 响应更快」可被用来枚举账户名'];
  }
  return [];
}

/* ==================== 第十四轮 · 性能批次的「本地收口」 ==================== */

/**
 * 解析 `5 * 1000` 这类常量算术式。
 *
 * 刻意只接受数字与 `*`：需要的是「能不能读懂这个窗口」，而不是通用求值 ——
 * 一旦写成不可解析的形态（标识符、十六进制、下划线分隔）就**报违规**，
 * 因为「判定窗口解析失败」与「窗口合法」在结果上完全一样，那正是假护栏。
 */
function numExpr(s) {
  const raw = String(s).trim();
  if (!/^[\d\s*]+$/.test(raw)) return NaN;
  let v = 1;
  for (const part of raw.split('*')) {
    const n = Number(part.trim());
    if (!Number.isFinite(n)) return NaN;
    v *= n;
  }
  return v;
}

/**
 * 检查 18 · 订单落盘的唯一写端与 `prune()` 的总量短路（R14-09）
 *
 * 两件事都必须落在**唯一实现点**上：
 *  ① 落盘只允许经 `coalesce.debouncedPersist()`。一次真实支付流程会连续触发
 *     `setTradeNo` / `markPaid` / `markDownloaded` 三次写，而 `POST /s/:id/pay`
 *     匿名可达（20 次/10 分钟/每 IP+链接，可跨 IP 叠加）—— 每次直接
 *     `writeJsonAsync` 都是全量序列化 + AES 加密 + 写盘，两万条订单时是数百毫秒级的
 *     同步阻塞。这类「同一状态多写端」的漏网是本仓库第一号病根，故用静态护栏钉住。
 *  ② `create()` 里的 `prune()` 是全表 `filter + sort`，而它内部第一件事就是
 *     「该链接订单数 ≤ 单链接上限就返回」。链接内订单数**必 ≤** 全表订单数，
 *     因此这个 O(1) 的总量判断可以安全短路掉绝大多数全表扫描（裁剪结果完全等价）。
 */
function paymentPersistViolations(src, rel) {
  const t = stripComments(src);
  const out = [];
  if (/\bsecureStore\.writeJsonAsync\s*\(/.test(t)) {
    out.push(`${rel} —— 订单落盘不得直接调用 secureStore.writeJsonAsync：唯一写端是`
      + ' coalesce.debouncedPersist（直接写 = 每次状态变更一次全量序列化 + 加密 + 写盘）');
  }
  if (!/coalesce\.debouncedPersist\s*\(/.test(t)) {
    out.push(`${rel} —— 订单落盘必须经由 coalesce.debouncedPersist（去抖合并的唯一实现点）`);
  }
  const i = t.indexOf('function create(');
  if (i >= 0) {
    const body = braceBodyFrom(t, i);
    const at = t.indexOf(body, i);
    const p = body.indexOf('prune(');
    if (p >= 0) {
      const before = body.slice(Math.max(0, p - 200), p);
      if (!/\bif\s*\(/.test(before) || !/MAX_ORDERS_PER_LINK/.test(before)) {
        out.push(`${rel}:${lineAt(t, at + p)} —— create() 里对 prune() 的调用必须被`
          + '「总量 > MAX_ORDERS_PER_LINK」守卫：prune() 是全表 filter + sort，'
          + '而链接内订单数必 ≤ 全表订单数 —— 没有守卫就是每次 create 白扫一遍全表');
      }
    }
  }
  return out;
}

/**
 * 检查 19 · 分享页存在性探测必须去重、失败必须留痕、失败窗口必须更短（R14-10）
 *
 * 三点都是同一条推理的产物：`GET /s/:id` 会对每个链接做一次惰性 `headObject`，
 * 而它**匿名可达且此前没有任何限流器**。
 *  ① 不去重 → 同一链接的一批并发请求各打一次云端（结果缓存写在 `await` **之后**）；
 *  ② 不留痕 → 凭据失效 / 桶被删 / 端点不可达被外层 `catch` 完全吞掉，运维只看到"偶尔很慢"；
 *  ③ 失败若按成功窗口（60 秒）缓存 → 一次瞬时抖动会让整段时间内的访客都看到「文件已删除」。
 */
function probeViolations(src, rel) {
  const t = stripComments(src);
  const i = t.indexOf('async function probeObjectMissing(');
  if (i < 0) return []; // 不是 share-routes.js
  const body = braceBodyFrom(t, i);
  const out = [];
  if (!/singleFlight\s*\(/.test(body)) {
    out.push(`${rel}:${lineAt(t, i)} —— probeObjectMissing 必须包在 singleFlight 里：`
      + '结果缓存写在 await 之后，并发请求于是各打一次 headObject —— 云端调用数与费用被 N 倍放大');
  }
  if (!/statsStore\.addLog\s*\(/.test(body)) {
    out.push(`${rel}:${lineAt(t, i)} —— 探测失败必须写 statsStore.addLog：`
      + '旧实现被外层 catch 完全吞掉、零日志，真实的凭据/桶故障对运维不可见');
  }
  const ok = /const\s+EXISTS_TTL_MS\s*=\s*([^;]+);/.exec(t);
  const fail = /const\s+EXISTS_FAIL_TTL_MS\s*=\s*([^;]+);/.exec(t);
  if (!ok || !fail) {
    out.push(`${rel} —— 必须同时定义 EXISTS_TTL_MS（成功窗口）与 EXISTS_FAIL_TTL_MS（失败窗口）`);
  } else {
    const okMs = numExpr(ok[1]);
    const failMs = numExpr(fail[1]);
    if (!Number.isFinite(okMs) || !Number.isFinite(failMs)) {
      out.push(`${rel} —— 无法解析 TTL 常量（EXISTS_TTL_MS=${ok[1].trim()}，`
        + `EXISTS_FAIL_TTL_MS=${fail[1].trim()}）：「解析不了」与「窗口合法」在结果上一样，必须显式报错`);
    } else if (!(failMs < okMs)) {
      out.push(`${rel} —— 失败窗口（${failMs}ms）必须严格短于成功窗口（${okMs}ms）：`
        + '失败按成功窗口缓存时，一次瞬时抖动会让整段时间内的访客都看到「文件已删除」');
    }
  }
  return out;
}

/**
 * 检查 20 · `/fs/stat` 的文件夹计数必须走短缓存 + 并发合并（R14-12）
 *
 * 该分支是**串行翻页**（`listAll` 单页上限 1000，`LIMITS.STAT` 默认 2 万 → 最多
 * 约 21 次串行云端往返），而这条路由既没有限流器、也不需要管理员 ——
 * 任意已登录用户反复请求大文件夹的属性就能烧掉云端配额。
 * 同文件的 `/fs/list`、`/fs/search` 都用了 `listCache`，`/stats/storage` 还额外做了
 * in-flight 合并；同为「统计」语义，只有这里两个都没防。
 */
function statRouteViolations(src, rel) {
  const t = stripComments(src);
  const i = t.indexOf("router.get('/fs/stat'");
  if (i < 0) return []; // 不是 routes/fs.js
  const body = braceBodyFrom(t, i);
  const folderAt = body.indexOf("key.endsWith('/')");
  if (folderAt < 0) {
    return [`${rel}:${lineAt(t, i)} —— /fs/stat 的文件夹分支（key.endsWith('/')）未找到：`
      + '判定窗口已失效，请修本护栏，而不是让它静默失去覆盖'];
  }
  const seg = body.slice(folderAt);
  const out = [];
  if (!/listCache\.get\s*\(/.test(seg)) {
    out.push(`${rel}:${lineAt(t, i)} —— 文件夹计数必须走 listCache.get：`
      + '它是串行翻页（最多约 21 次云端往返），而本路由没有限流器');
  }
  if (!/listCache\.set\s*\(/.test(seg)) {
    out.push(`${rel}:${lineAt(t, i)} —— 文件夹计数必须写回 listCache.set（只读不写等于没有缓存）`);
  }
  if (!/singleFlight\s*\(/.test(seg)) {
    out.push(`${rel}:${lineAt(t, i)} —— 文件夹计数必须经 coalesce.singleFlight 合并并发请求`);
  }
  return out;
}

/**
 * 检查 21 · 搜索候选集的三条结构性前提（候选集缓存）
 *
 * 这层缓存的前提是「可以陈旧、但必须自己收敛」，三条前提各自对应一次性沉默失效：
 *
 *  1. **必须订阅 `listCache.onMutate`** —— 站点内每一次云端调用都过 `cos.p()`，
 *     而 `p()` 在成功与失败两条分支上都调 `noteCall()`。不订阅，写操作就不再失效，
 *     用户在 TTL 内会一直看到「刚删掉的文件还在 / 刚上传的搜不到」，且没有任何报错。
 *  2. **`put()` 必须先查 `tooBig` 再写入** —— 超限被丢弃后若能重新写入，物化出来的
 *     是一段**中间窗口**（从当前页开始）而不是从头开始的连续前缀；续扫时窗口之前的
 *     对象会被静默漏掉（候选集只提供「已物化的那一段」，前缀之外的语义全靠这个前提）。
 *  3. **桶维度必须复用 `bucketIdentMatches()`** —— 那里定义了「桶名恒为标识的倒数第
 *     2 段」与「同名桶的所有厂商一并失效」。另写一份 `split('|')`，`bucketCacheKey()`
 *     将来加第 5 个维度时就会静默失配（写完对象候选集不失效）。
 */
function searchCandidatesViolations(src, rel) {
  const t = stripComments(src);
  if (!/DEFAULT_TTL_MS/.test(t) || !/function put\(/.test(t)) return []; // 不是 search-candidates.js
  const out = [];
  if (!/listCache\.onMutate\s*\(/.test(t)) {
    out.push(`${rel} —— 候选集没有订阅 listCache.onMutate：写操作不再失效，`
      + 'TTL 内会持续返回陈旧结果（用户看到「刚删掉的文件还在」）');
  }
  const i = t.indexOf('function put(');
  const body = braceBodyFrom(t, i);
  const guard = body.indexOf('isTooBig(');
  const write = body.indexOf('store.set(');
  if (guard < 0 || write < 0 || guard > write) {
    out.push(`${rel}:${lineAt(t, i)} —— put() 必须**先查 tooBig 再写入**：超限后若还能写入，`
      + '物化出来的是一段「中间窗口」而非从头开始的连续前缀，续扫会静默漏掉窗口之前的对象');
  }
  if (!/bucketIdentMatches\s*\(/.test(t)) {
    out.push(`${rel} —— 桶维度必须复用 listCache.bucketIdentMatches()（唯一实现点）`);
  }
  if (/split\('\|'\)/.test(t) || /indexOf\('\|'\)/.test(t)) {
    out.push(`${rel} —— 出现了第二份桶标识解析（split('|')）：唯一实现点是 listCache.bucketIdentMatches()`);
  }
  return out;
}

/**
 * 检查 22 · `/fs/search` 必须同时保留「页缓存」与「候选集」两层，且仍能落到云端
 *
 * 候选集的收益是「省掉重复翻页」，而**不是**「不再翻页」。因此：
 *  - 两层缓存都要在（删掉页缓存 = 每个请求的第一页都要打云端；删掉候选集 = 回到旧行为）；
 *  - `listPage(` 必须仍在：一个"只用缓存"的改写会让结果永远停在某一次快照上，
 *    而这恰恰是「本地索引」方案被否掉的原因（永久不一致）；
 *  - `clientGone()` 的中断检测必须仍在：每多翻一页都是一次真实网络往返，而响应注定被丢弃。
 */
function searchRouteViolations(src, rel) {
  const t = stripComments(src);
  const i = t.indexOf("router.get('/fs/search'");
  if (i < 0) return []; // 不是 routes/fs.js
  const body = braceBodyFrom(t, i);
  const out = [];
  const need = [
    ['candidates.keyOf(', '候选集的键必须由 candidates.keyOf 构造（桶标识 + 前缀 + 范围）'],
    ['candidates.get(', '必须从 candidates.get 取候选集，否则这层缓存形同未接入'],
    ['listCache.keyOf(', '页缓存必须保留：删掉它等于每个请求的每一页都打云端'],
    ['listCache.get(', '页缓存必须保留（listCache.get）'],
    ['listPage(', '必须保留云端列举 listPage：只用缓存会让结果永久停在上一次快照'],
    ['clientGone(', '必须保留客户端中断检测：断开后继续翻页是纯浪费的云端往返'],
  ];
  for (const [needle, why] of need) {
    if (!body.includes(needle)) out.push(`${rel}:${lineAt(t, i)} —— ${why}`);
  }
  return out;
}

/* ============================ 样例自测 ============================ */

/**
 * 每条检查先过样例：能识别违规样本（FAIL）、也能放行合规样本（PASS）。
 * 少了这一半，一条永远返回空数组的检查同样是"绿"的 —— 那就是假护栏。
 */
const CHECKS = [
  {
    name: '退出路径只写不建',
    fn: exitMkdirViolations,
    bad: [
      // 建目录直接写在钩子体里
      "process.on('exit', () => {\n  if (!fs.existsSync(D)) fs.mkdirSync(D, { recursive: true });\n  write();\n});\n",
      // R12-09：把建目录挪进辅助函数（旧窗口对此全绿）
      'function persist() {\n  if (!fs.existsSync(D)) fs.mkdirSync(D, { recursive: true });\n  write();\n}\n'
        + "process.on('exit', () => { persist(); });\n",
      // 守卫在更深的层、建目录在更浅的层 → 守卫来不及生效
      "process.on('exit', () => {\n  ensureDir();\n  if (!exitPathWritable(D)) return;\n});\n"
        + 'function ensureDir() { fs.mkdirSync(D, { recursive: true }); }\n',
      // R13-07：`process.once('exit')` —— 只认 `on` 时换成 once 即逃脱
      "process.once('exit', () => {\n  fs.mkdirSync(D, { recursive: true });\n});\n",
      // R13-07：带接收者的调用（对象方法）—— 旧 calledNames 只收裸调用名
      'const ns = { ensure() { fs.mkdirSync(D, { recursive: true }); } };\n'
        + "process.on('exit', () => { ns.ensure(); });\n",
      // R13-07：调用链深于 3 层（旧 BFS 封顶 3 层 → 这里天然越界）
      "process.on('exit', () => { a(); });\nfunction a() { b(); }\nfunction b() { c(); }\n"
        + 'function c() { d(); }\nfunction d() { fs.mkdirSync(D, { recursive: true }); }\n',
    ],
    good: [
      "process.on('exit', () => {\n  if (!exitPathWritable(D)) return;\n  write();\n});\n",
      // 守卫下沉到辅助函数、且在建目录之前 —— enc-store.persistMetaSync 的真实形态
      'function persist() {\n  if (!exitPathWritable(D)) return;\n'
        + '  if (!fs.existsSync(D)) fs.mkdirSync(D, { recursive: true });\n  write();\n}\n'
        + "process.on('exit', () => { persist(); });\n",
      // 守卫在钩子层、建目录在更深的层 —— config-store 的真实形态
      "process.on('exit', () => {\n  if (!exitPathWritable(D)) return;\n  encrypt();\n});\n"
        + 'function encrypt() { getMasterKey(); }\nfunction getMasterKey() { ensureDataDir(); }\n'
        + 'function ensureDataDir() { fs.mkdirSync(D, { recursive: true }); }\n',
    ],
  },
  {
    name: '批量删除白名单判据',
    fn: rawBatchDeleteViolations,
    bad: "  const r = await cos.deleteMultipleObject({ Bucket: b, Delete: { Objects: ks } });\n",
    good: "  const r = await deleteMultipleConfirmed(cos, cfg, ks);\n",
  },
  {
    name: 'Accept-Ranges 与 GET 同源',
    fn: acceptRangesViolations,
    bad: [
      "  res.setHeader('Accept-Ranges', 'bytes');\n",
      // 判据在别的分支上、与本次宣告无关 → 仍必须命中
      "function other(st) { if (gateway.rangeServable(st)) return 1; }\n"
        + "  res.setHeader('Accept-Ranges', 'bytes');\n",
    ],
    good: [
      "  if (gateway.rangeServable(st)) res.setHeader('Accept-Ranges', 'bytes');\n",
      // R13-07 误报样本：条件与 setHeader 之间隔一行注释（旧 2 行窗口外）必须放行
      "      if (gateway.rangeServable({ encrypted: r.encrypted })) {\n"
        + "      // R11-11：同上 —— 只在真能服务 Range 时宣告\n"
        + "        res.setHeader('Accept-Ranges', 'bytes');\n      }\n",
      // 条件里带对象字面量（块首 `{` 在括号内）—— 按括号深度回溯才认得出来
      "  if (gateway.rangeServable({ a: 1, b: 2 })) {\n    res.setHeader('Accept-Ranges', 'bytes');\n  }\n",
    ],
  },
  {
    name: '缓存键含全部区分维度',
    fn: cacheKeyViolations,
    bad: [
      "  const k = listCache.keyOf(cfg.bucket, prefix, marker, 1000, '/', 'list');\n",
      // 放宽后最容易漏掉的形态：局部变量看着像标识，实际只是桶名
      "  const ident = cfg.bucket;\n  const k = listCache.keyOf(ident, prefix, marker, 1000, '/', 'list');\n",
    ],
    good: [
      "  const k = listCache.keyOf(bucketCacheKey(cfg), prefix, marker, 1000, '/', 'list');\n",
      // 由 canonical 直接赋值出来的局部别名必须放行（搜索候选集接入后的形态）
      '  const ident = bucketCacheKey(cfg);\n'
        + "  const a = listCache.keyOf(ident, prefix, marker, 1000, '/', 'search');\n"
        + "  const b = candidates.keyOf(ident, prefix, scope);\n",
    ],
  },
  {
    name: '上游状态码不占本地 401',
    fn: upstreamStatusViolations,
    bad: '  err.status = status >= 400 && status < 600 ? status : 500;\n',
    good: '  err.status = status === 401 ? 502 : (status >= 400 && status < 600 ? status : 500);\n',
  },
  {
    name: 'HEAD 必须注册在 GET 之前',
    fn: headOrderViolations,
    bad: "router.get('/fs/download', h);\nrouter.head('/fs/download', h);\n",
    good: "router.head('/fs/download', h);\nrouter.get('/fs/download', h);\n",
  },
  {
    name: '数据目录必须支持 COS_DATA_DIR',
    fn: dataDirViolations,
    bad: "const DATA_DIR = path.join(__dirname, '..', 'data');\n",
    good: "const DATA_DIR = process.env.COS_DATA_DIR ? path.resolve(process.env.COS_DATA_DIR) : path.join(__dirname, '..', 'data');\n",
  },
  {
    name: '批量复制入口必须有回滚',
    fn: copyRollbackViolations,
    bad: [
      // 循环 + 复制 + 无回滚
      'async function copyAll(ks) {\n  for (const k of ks) await gateway.copyObject(b, k, d);\n}\n',
      // 并发 + 复制 + 无回滚（WebDAV 目录 COPY 的第 12 轮形态）
      'async function copyAll(ks) {\n  await Promise.all(ks.map((k) => gateway.copyObject(b, k, d)));\n}\n',
      // R13-07 逃逸样本：复制原语抽进 helper，批次循环留在调用者里 —— 必须反查祖先
      'async function copyOne(k) {\n  await gateway.copyObject(b, k, d);\n}\n'
        + 'async function copyAll(ks) {\n  for (const k of ks) await copyOne(k);\n}\n',
    ],
    good: [
      'async function copyAll(ks) {\n  const created = [];\n  try {\n    for (const k of ks) { await gateway.copyObject(b, k, d); created.push(d); }\n  } catch (e) { await gateway.rollbackCopies(cos, cfg, created); throw e; }\n}\n',
      // 单对象复制不适用（复制成功即删源），不得误报
      'async function moveOne(k) {\n  await copyObject(b, k, d);\n  await p(cos, \'deleteObject\', { Key: k });\n}\n',
      // 同上，且**调用者**里也没有批次块 → 反查祖先到根仍无批次块 → 仍不适用
      'async function moveOne(k) {\n  await copyObject(b, k, d);\n}\n'
        + 'async function run(k) {\n  await moveOne(k);\n}\n',
      // R13-07：抽成 helper 但调用者的批次块里有回滚 → 合规
      'async function copyOne(k) {\n  await gateway.copyObject(b, k, d);\n}\n'
        + 'async function copyAll(ks) {\n  const created = [];\n  try {\n'
        + '    for (const k of ks) { await copyOne(k); created.push(k); }\n'
        + '  } catch (e) { await gateway.rollbackCopies(cos, cfg, created); throw e; }\n}\n',
    ],
  },
];

/** 全局型检查（输入不是单文件文本）单独自测 */
const GLOBAL_CHECKS = [
  {
    name: '唯一实现点被调用且无私有副本',
    fn: () => uniqueImplViolations([
      { rel: 'server/secure-store.js', src: 'function exitPathWritable(dir) { return fs.existsSync(dir); }\n' },
      { rel: 'server/enc-store.js', src: 'if (!secureStore.exitPathWritable(D)) return;\n' },
      { rel: 'server/config-store.js', src: 'if (!secureStore.exitPathWritable(D)) return;\n' },
      { rel: 'server/upload-sessions.js', src: 'if (!secureStore.exitPathWritable(D)) return;\n' },
      // 定义 + 自身的 `movePrefix` 那一处接线
      { rel: 'server/fs-gateway.js', src: 'async function rollbackCopies(cos, cfg, keys) { await deleteMultipleConfirmed(cos, cfg, keys); }\nawait rollbackCopies(cos, cfg, fresh);\n' },
      { rel: 'server/routes/fs.js', src: 'await gateway.rollbackCopies(client, cfg, copied);\n' },
      { rel: 'server/webdav-server.js', src: 'await gateway.rollbackCopies(cos, cfg, created);\n' },
    ]),
    bad: () => uniqueImplViolations([
      { rel: 'server/secure-store.js', src: 'function exitPathWritable(dir) { return true; }\n' },
      { rel: 'server/upload-sessions.js', src: 'function exitPathWritable() { return fs.existsSync(D); }\n' },
    ]),
  },
  {
    // R13-06：canonical 被重构成**箭头函数 / 函数表达式** + `return true` 时，
    // 旧实现只认 `function name(` → 整段 mustContain 校验被静默跳过（违规 0）。
    // 现在「找定义」与「取函数体」同源，四种形态都逃不掉。
    name: '唯一实现点 · 形态重构不得绕过判据校验（R13-06）',
    fn: () => uniqueImplViolations([
      { rel: 'server/secure-store.js', src: 'const exitPathWritable = (dir) => { return fs.existsSync(dir); };\n' },
      { rel: 'server/config-store.js', src: 'if (!secureStore.exitPathWritable(D)) return;\n' },
      { rel: 'server/enc-store.js', src: 'if (!secureStore.exitPathWritable(D)) return;\n' },
      { rel: 'server/upload-sessions.js', src: 'if (!secureStore.exitPathWritable(D)) return;\n' },
      { rel: 'server/fs-gateway.js', src: 'const rollbackCopies = async (cos, cfg, keys) => { await deleteMultipleConfirmed(cos, cfg, keys); };\nrollbackCopies(cos, cfg, fresh);\n' },
      { rel: 'server/routes/fs.js', src: 'await gateway.rollbackCopies(client, cfg, copied);\n' },
      { rel: 'server/webdav-server.js', src: 'await gateway.rollbackCopies(cos, cfg, created);\n' },
    ]),
    bad: () => uniqueImplViolations([
      // 箭头函数 + 判据已消失 → 必须抓到
      { rel: 'server/secure-store.js', src: 'const exitPathWritable = (dir) => true;\n' },
      { rel: 'server/config-store.js', src: 'if (!secureStore.exitPathWritable(D)) return;\n' },
      { rel: 'server/enc-store.js', src: 'if (!secureStore.exitPathWritable(D)) return;\n' },
      { rel: 'server/upload-sessions.js', src: 'if (!secureStore.exitPathWritable(D)) return;\n' },
      { rel: 'server/fs-gateway.js', src: 'const rollbackCopies = async (cos, cfg, keys) => { await deleteMultipleConfirmed(cos, cfg, keys); };\nrollbackCopies(cos, cfg, fresh);\n' },
      { rel: 'server/routes/fs.js', src: 'await gateway.rollbackCopies(client, cfg, copied);\n' },
      { rel: 'server/webdav-server.js', src: 'await gateway.rollbackCopies(cos, cfg, created);\n' },
    ]),
  },
  {
    // R13-07：`minCalls` 是计数代理 —— 「删一处真接线、在没人读的地方补一处空调用」即可绕过。
    // 现在逐文件点名登记入口，缺哪个报哪个。
    name: '唯一实现点 · 登记入口逐文件校验（R13-07）',
    fn: () => uniqueImplViolations([
      { rel: 'server/secure-store.js', src: 'function exitPathWritable(dir) { return fs.existsSync(dir); }\n' },
      { rel: 'server/config-store.js', src: 'if (!secureStore.exitPathWritable(D)) return;\n' },
      { rel: 'server/enc-store.js', src: 'if (!secureStore.exitPathWritable(D)) return;\n' },
      { rel: 'server/upload-sessions.js', src: 'if (!secureStore.exitPathWritable(D)) return;\n' },
      { rel: 'server/fs-gateway.js', src: 'function rollbackCopies(cos, cfg, keys) { return deleteMultipleConfirmed(cos, cfg, keys); }\nrollbackCopies(cos, cfg, fresh);\n' },
      { rel: 'server/routes/fs.js', src: 'await gateway.rollbackCopies(client, cfg, copied);\n' },
      { rel: 'server/webdav-server.js', src: 'await gateway.rollbackCopies(cos, cfg, created);\n' },
    ]),
    bad: () => uniqueImplViolations([
      { rel: 'server/secure-store.js', src: 'function exitPathWritable(dir) { return fs.existsSync(dir); }\n' },
      // enc-store 的真接线被删掉，改为在别处补两处没人读的空调用 —— 旧口径总数仍达标
      { rel: 'server/config-store.js', src: 'if (!secureStore.exitPathWritable(D)) return;\n' },
      { rel: 'server/enc-store.js', src: 'const unused = () => secureStore.exitPathWritable;\nconst alsoUnused = () => secureStore.exitPathWritable;\n' },
      { rel: 'server/upload-sessions.js', src: 'if (!secureStore.exitPathWritable(D)) return;\n' },
      { rel: 'server/fs-gateway.js', src: 'function rollbackCopies(cos, cfg, keys) { return deleteMultipleConfirmed(cos, cfg, keys); }\nrollbackCopies(cos, cfg, fresh);\n' },
      { rel: 'server/routes/fs.js', src: 'await gateway.rollbackCopies(client, cfg, copied);\n' },
      { rel: 'server/webdav-server.js', src: 'const gone = 1;\n' },
    ]),
  },
];

/** 伪造的读取器：`withHead=false` 即「把 router.head 整行删掉」的变异 */
function fakeHeadReader(withHead) {
  return (rel) => {
    const e = HEAD_REQUIRED.find((x) => x.file === rel);
    if (!e) return null;
    return `${withHead ? `router.head('${e.path}', h);\n` : ''}router.get('${e.path}', h);\n`;
  };
}

GLOBAL_CHECKS.push({
  name: '必须同时注册 HEAD 的路径登记表',
  fn: () => headMissingViolations(fakeHeadReader(true)),
  // 变异：把 `router.head` 整行删掉 —— 检查 6 对此全绿，本条必须变红
  bad: () => headMissingViolations(fakeHeadReader(false)),
});

// R14-02：两侧域名必须严格同源。bad 样本就是缺陷当时的真实形态（前端无 www、CSP 有 www）
const CSP_OK = '    + "script-src \'self\' https://www.recaptcha.net https://www.gstatic.com https://challenges.cloudflare.com; "\n';
const MAIN_OK = 'const CAPTCHA_SCRIPTS = {\n'
  + "  recaptcha: 'https://www.recaptcha.net/recaptcha/api.js?onload=x&render=explicit',\n"
  + "  turnstile: 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=x&render=explicit',\n"
  + '};\n';
const MAIN_BAD = 'const CAPTCHA_SCRIPTS = {\n'
  + "  recaptcha: 'https://recaptcha.net/recaptcha/api.js?onload=x&render=explicit',\n" // 少 www
  + "  turnstile: 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=x&render=explicit',\n"
  + '};\n';
GLOBAL_CHECKS.push({
  name: '验证码脚本源必须被 CSP 允许（R14-02）',
  fn: () => captchaCspViolations(MAIN_OK, CSP_OK),
  bad: () => captchaCspViolations(MAIN_BAD, CSP_OK),
});

/* ---------- R14-13 / R14-04 / R14-05 / R14-06 / R14-07 ---------- */

CHECKS.push({
  name: 'R14-13 rename 的 newKey 必须过 normalizeKey',
  fn: renameKeyViolations,
  bad: "const newKey = parentOf(key) + newName + (isFolder ? '/' : '');\n",
  good: "const newKey = normalizeKey(parentOf(key) + newName + (isFolder ? '/' : ''));\n",
});

CHECKS.push({
  name: 'R14-04 异步写不得在 await 之前取 store',
  fn: asyncStoreWriteViolations,
  bad: 'async function addUser(p) {\n  const cfg = requireStore();\n'
    + '  const c = await hashPassword(p);\n  cfg.users.push({ c });\n}\n',
  good: 'async function addUser(p) {\n  const c = await hashPassword(p);\n'
    + '  const cfg = requireStore();\n  cfg.users.push({ c });\n}\n',
});

CHECKS.push({
  name: 'R14-05 发起支付必须早于建单查支付态',
  fn: payStateViolations,
  bad: "router.post('/s/:id/pay', async (req, res) => {\n"
    + '  const order = paymentOrders.create({});\n});\n',
  good: "router.post('/s/:id/pay', async (req, res) => {\n"
    + '  const payer = payerStateFor(l, req);\n'
    + '  const order = paymentOrders.create({});\n});\n',
});

CHECKS.push({
  name: 'R14-06 WebDAV 独立实例必须自带安全响应头',
  fn: webdavHeaderViolations,
  bad: 'function buildApp() {\n  app.use(authMiddleware);\n}\n',
  good: 'function buildApp() {\n'
    + "  res.setHeader('Content-Security-Policy', \"default-src 'none'; sandbox\");\n"
    + "  res.setHeader('X-Content-Type-Options', 'nosniff');\n"
    + "  const RENDERABLE_TYPES = new Set(['image/svg+xml']);\n"
    + "  res.setHeader('Content-Disposition', 'attachment');\n}\n",
});

CHECKS.push({
  name: 'R14-07 WebDAV 认证三条失败路径都要跑 dummyHash',
  fn: webdavAuthTimingViolations,
  bad: 'async function authenticateWebdav(u, p) {\n  await dummyHash(p);\n  return { ok: false };\n}\n',
  good: 'async function authenticateWebdav(u, p) {\n'
    + '  if (!on) { await dummyHash(p); return { ok: false }; }\n'
    + '  if (!acc) { await dummyHash(p); return { ok: false }; }\n'
    + '  if (!eq) { await dummyHash(p); return { ok: false }; }\n'
    + '  return { ok: true };\n}\n',
});

/* ---------- R14-09 / R14-10 / R14-12（性能批次的本地收口） ---------- */

CHECKS.push({
  name: 'R14-09 订单落盘唯一写端 + prune 总量守卫',
  fn: paymentPersistViolations,
  bad: [
    // 直接落盘（旧形态）
    'function persist() {\n  secureStore.writeJsonAsync(FILE, cache);\n}\n',
    // prune 没有总量守卫（每次 create 都全表 filter + sort）
    'const coalesce = require("./coalesce");\n'
      + 'const writer = coalesce.debouncedPersist(FILE, () => cache, { debounceMs: 300 });\n'
      + 'function persist() {\n  writer.schedule();\n}\n'
      + 'function create() {\n  orders.push(o);\n  prune(o.linkId);\n  persist();\n}\n',
  ],
  good: [
    'const coalesce = require("./coalesce");\n'
      + 'const writer = coalesce.debouncedPersist(FILE, () => cache, { debounceMs: 300 });\n'
      + 'function persist() {\n  if (loadFailed) return;\n  writer.schedule();\n}\n'
      + 'function create() {\n  orders.push(o);\n'
      + '  if (orders.length > MAX_ORDERS_PER_LINK) prune(o.linkId);\n  persist();\n}\n',
  ],
});

CHECKS.push({
  name: 'R14-10 探测去重 + 失败留痕 + 失败窗口更短',
  fn: probeViolations,
  bad: [
    // 三处全缺：不去重、不留痕、失败窗口与成功窗口一样长
    'const EXISTS_TTL_MS = 60 * 1000;\nconst EXISTS_FAIL_TTL_MS = 60 * 1000;\n'
      + 'async function probeObjectMissing(l) {\n'
      + '  let missing = false;\n'
      + "  try { await p(c, 'headObject', {}); } catch (e) { missing = isNotFound(e); }\n"
      + '  return missing;\n}\n',
    // 只有失败窗口更长这一条（0 与 1 的边界：相等也不许）
    'const EXISTS_TTL_MS = 5 * 1000;\nconst EXISTS_FAIL_TTL_MS = 60 * 1000;\n'
      + 'async function probeObjectMissing(l) {\n'
      + "  return singleFlight('k', async () => {\n"
      + "    try { await p(c, 'headObject', {}); } catch (e) { statsStore.addLog({}); }\n"
      + '    return false;\n  });\n}\n',
  ],
  good: [
    'const EXISTS_TTL_MS = 60 * 1000;\nconst EXISTS_FAIL_TTL_MS = 5 * 1000;\n'
      + 'async function probeObjectMissing(l) {\n'
      + "  return singleFlight('k', async () => {\n"
      + "    try { await p(c, 'headObject', {}); } catch (e) { statsStore.addLog({ level: 'warn' }); }\n"
      + '    return false;\n  });\n}\n',
  ],
});

CHECKS.push({
  name: 'R14-12 /fs/stat 文件夹计数走短缓存与并发合并',
  fn: statRouteViolations,
  bad: [
    "router.get('/fs/stat', async (req, res) => {\n  if (key.endsWith('/')) {\n"
      + "    const objs = await listAll(client, cfg, key, { cap: STAT_CAP + 1 });\n"
      + '    return res.json({ objectCount: objs.length });\n  }\n});\n',
  ],
  good: [
    "router.get('/fs/stat', async (req, res) => {\n  if (key.endsWith('/')) {\n"
      + "    const k = listCache.keyOf(bucketCacheKey(cfg), key, '', LIMITS.STAT, '', 'stat');\n"
      + '    const cached = listCache.get(k);\n    if (cached) return res.json(cached);\n'
      + "    const payload = await singleFlight('x', async () => {\n"
      + '      const out = { ok: true };\n      listCache.set(k, out);\n      return out;\n'
      + '    });\n    return res.json(payload);\n  }\n});\n',
  ],
});

CHECKS.push({
  name: '搜索候选集的结构性前提（订阅失效 / tooBig 顺序 / 桶维度复用）',
  fn: searchCandidatesViolations,
  bad: [
    // 三处全缺：不订阅 onMutate、自己解析桶标识、tooBig 守卫排在写入之后
    'const DEFAULT_TTL_MS = 10000;\n'
      + 'function put(key, entry) {\n'
      + '  const prev = store.get(key);\n'
      + '  store.set(key, { items: entry.items, at: prev ? prev.at : Date.now() });\n'
      + '  if (isTooBig(key)) return false;\n  return true;\n}\n'
      + "function bucketOfIdent(ident) { return String(ident).split('|')[2]; }\n",
    // 只把守卫顺序写反（订阅与桶维度都合规）
    'const DEFAULT_TTL_MS = 10000;\n'
      + 'listCache.onMutate((m, params) => { drop(params && params.Bucket); });\n'
      + 'function bucketIdentMatches(a, b) { return a === b; }\n'
      + 'function put(key, entry) {\n'
      + '  store.set(key, { items: entry.items });\n'
      + '  if (isTooBig(key)) return false;\n  return true;\n}\n',
  ],
  good: [
    'const DEFAULT_TTL_MS = 10000;\n'
      + 'function put(key, entry) {\n'
      + '  if (isTooBig(key)) return false;\n'
      + '  store.set(key, { items: entry.items });\n  return true;\n}\n'
      + 'function drop(bucket) {\n'
      + '  for (const k of store.keys()) {\n'
      + '    if (listCache.bucketIdentMatches(String(k).split(SEP)[0], bucket)) store.delete(k);\n'
      + '  }\n}\n'
      + 'listCache.onMutate((method, params) => { drop(params && params.Bucket); });\n',
  ],
});

CHECKS.push({
  name: '/fs/search 两层缓存与云端兜底',
  fn: searchRouteViolations,
  bad: [
    // 「只用候选集」的改写：不再有页缓存，也不再落到云端 —— 结果会永久停在上一次快照上
    "router.get('/fs/search', async (req, res) => {\n"
      + '  const k = candidates.keyOf(ident, prefix, scope);\n'
      + '  const cand = candidates.get(k);\n'
      + '  return res.json({ matches: cand ? cand.items : [] });\n});\n',
  ],
  good: [
    "router.get('/fs/search', async (req, res) => {\n"
      + '  const clientGone = () => req.aborted;\n'
      + '  const k = candidates.keyOf(ident, prefix, scope);\n'
      + '  const cand = candidates.get(k);\n'
      + "  const pk = listCache.keyOf(ident, prefix, marker, 1000, delimiter, 'search');\n"
      + '  let page = listCache.get(pk);\n'
      + '  if (!page) { page = await listPage(client, cfg, prefix, { marker }); listCache.set(pk, page); }\n'
      + '  if (clientGone()) return res.destroy();\n'
      + '  return res.json({ matches: cand ? cand.items : page.items });\n});\n',
  ],
});

for (const c of CHECKS) {
  test(`样例自测 · ${c.name}`, () => {
    for (const b of [].concat(c.bad)) {
      const bad = c.fn(b, 'sample-bad.js');
      assert(bad.length >= 1,
        `「${c.name}」必须识别出违规样本 —— 实际命中 0 条，说明这条检查是空转的假护栏\n  ${b}`);
    }
    for (const g of [].concat(c.good)) {
      const good = c.fn(g, 'sample-good.js');
      assertEqual(good.length, 0,
        `「${c.name}」放行合规样本失败：\n  ${good.join('\n  ')}\n  ${g}`);
    }
  });
}
for (const c of GLOBAL_CHECKS) {
  test(`样例自测 · ${c.name}`, () => {
    assert(c.bad().length >= 1,
      `「${c.name}」必须识别出违规样本 —— 实际命中 0 条，说明这条检查是空转的假护栏`);
    const good = c.fn();
    assertEqual(good.length, 0,
      `「${c.name}」放行合规样本失败：\n  ${good.join('\n  ')}`);
  });
}

test('样例自测 · 注释里的反例不得被判成违规', () => {
  // 「注释里写着 `mkdirSync`」恰恰是合规代码的常见形态（"注意不能写成…"）
  const withNote = "process.on('exit', () => {\n  // 注意：这里绝不能 mkdirSync\n  if (!exitPathWritable(D)) return;\n});\n";
  assertEqual(exitMkdirViolations(withNote, 'sample-note.js').length, 0,
    '剥离注释后不得再命中注释里的反例字样');
  // 反向：真违规不能被注释剥离"洗白"
  assert(exitMkdirViolations("process.on('exit', () => {\n  fs.mkdirSync(D);\n});\n", 'x.js').length >= 1,
    '真违规必须仍然命中');
});

/* ============================ 全库扫描 ============================ */

const serverFiles = jsFiles('server').map((f) => ({
  rel: path.relative(ROOT, f).replace(/\\/g, '/'),
  src: fs.readFileSync(f, 'utf8'),
}));

test('退出路径只写不建：全库 process.on(exit) 钩子内不得建目录', () => {
  const hits = [];
  for (const f of serverFiles) hits.push(...exitMkdirViolations(f.src, f.rel));
  assertEqual(hits.length, 0,
    `命中 ${hits.length} 处（canonical：secure-store.exitPathWritable）：\n  ${hits.join('\n  ')}`);
  // 反向上限：至少得真的扫到 3 处 exit 钩子，否则是"扫了个空"
  const hooks = serverFiles.reduce((n, f) => n + (stripComments(f.src).match(/process\.on\(\s*['"]exit['"]/g) || []).length, 0);
  assert(hooks >= 3, `扫描范围自检：应至少扫到 3 个 exit 钩子，实际 ${hooks} 个`);
});

test('批量删除白名单判据：生产侧不得裸调 deleteMultipleObject', () => {
  const hits = [];
  for (const f of serverFiles) hits.push(...rawBatchDeleteViolations(f.src, f.rel));
  assertEqual(hits.length, 0,
    `命中 ${hits.length} 处（canonical：cos.deleteMultipleConfirmed）：\n  ${hits.join('\n  ')}`);
});

test('HEAD 与 GET 同源：Accept-Ranges 必须受 rangeServable 约束', () => {
  const hits = [];
  for (const f of serverFiles) hits.push(...acceptRangesViolations(f.src, f.rel));
  assertEqual(hits.length, 0,
    `命中 ${hits.length} 处（canonical：fs-gateway.rangeServable）：\n  ${hits.join('\n  ')}`);
});

test('缓存键含全部区分维度：listCache.keyOf 的首参必须是 bucketCacheKey(cfg)', () => {
  const hits = [];
  for (const f of serverFiles) hits.push(...cacheKeyViolations(f.src, f.rel));
  assertEqual(hits.length, 0,
    `命中 ${hits.length} 处（canonical：_shared.bucketCacheKey）：\n  ${hits.join('\n  ')}`);
});

test('上游状态码不占本地 401/403 语义', () => {
  const hits = [];
  for (const f of serverFiles) hits.push(...upstreamStatusViolations(f.src, f.rel));
  assertEqual(hits.length, 0,
    `命中 ${hits.length} 处（401 必须被映射掉，否则前端会当成会话过期并强制登出）：\n  ${hits.join('\n  ')}`);
});

test('HEAD 与 GET 同源：head 必须注册在同名 get 之前', () => {
  const hits = [];
  for (const f of serverFiles) hits.push(...headOrderViolations(f.src, f.rel));
  assertEqual(hits.length, 0,
    `命中 ${hits.length} 处（express 会让 HEAD 退化成 GET）：\n  ${hits.join('\n  ')}`);
});

test('测试隔离：所有 store 的数据目录必须支持 COS_DATA_DIR', () => {
  const hits = [];
  for (const f of serverFiles) hits.push(...dataDirViolations(f.src, f.rel));
  assertEqual(hits.length, 0,
    `命中 ${hits.length} 处（第 12 轮 R12-01 曾真实改写生产 data/config.enc）：\n  ${hits.join('\n  ')}`);
  // 反向上限：至少 9 个 store 定义了数据目录，否则是"扫了个空"
  const defs = serverFiles.reduce(
    (n, f) => n + (stripComments(f.src).match(/path\.(?:join|resolve)\(\s*__dirname\s*,\s*['"]\.\.['"]\s*,\s*['"]data['"]/g) || []).length,
    0,
  );
  assert(defs >= 9, `扫描范围自检：应至少扫到 9 处数据目录定义，实际 ${defs} 处`);
});

test('唯一实现点：必须被调用、无私有副本、判据未退化', () => {
  const hits = uniqueImplViolations(serverFiles);
  assertEqual(hits.length, 0,
    `命中 ${hits.length} 处（第 12 轮 §0.2：canonical 曾生产侧零调用）：\n  ${hits.join('\n  ')}`);
});

test('HEAD 缺失：登记表内的路径必须同时注册 head 与 get', () => {
  const hits = headMissingViolations((rel) => {
    const abs = path.join(ROOT, rel);
    return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
  });
  assertEqual(hits.length, 0,
    `命中 ${hits.length} 处（express 会让 HEAD 退化成 GET）：\n  ${hits.join('\n  ')}`);
});

test('HEAD 登记表双向闭合：表外不得出现新的 head+get 组合', () => {
  const hits = headTableStaleViolations(serverFiles);
  assertEqual(hits.length, 0,
    `命中 ${hits.length} 处（新增/删除都要同步 HEAD_REQUIRED）：\n  ${hits.join('\n  ')}`);
});

test('复制失败必须回滚：批量复制块内必须有回滚调用', () => {
  const hits = [];
  for (const f of serverFiles) hits.push(...copyRollbackViolations(f.src, f.rel));
  assertEqual(hits.length, 0,
    `命中 ${hits.length} 处（唯一实现点：gateway.rollbackCopies）：\n  ${hits.join('\n  ')}`);
});

/**
 * R13-07 §6.5：**扫描范围下界自检**。
 *
 * 11 条检查里原本只有 2 条带下界断言，其余**命中数归零时同样全绿** ——
 * 也就是说「判据写错/正则失效/扫错目录」与「代码全合规」在测试结果上长得一模一样。
 * 这张表给每条检查登记「生产侧至少应扫到多少个触发实例」，低于下界即视为
 * 检查本身失效（而不是代码变干净）。
 *
 * 维护约定：下界取**实测值的绝大部分**（不是 0、也不是刚好等于实测值），
 * 这样正常重构不会误报，而「检查看不见东西了」必定被抓。
 */
const SCAN_LOWER_BOUNDS = [
  { check: '退出路径只写不建', what: 'exit 钩子', re: /process\.(?:on|once)\(\s*['"]exit['"]/g, min: 3 },
  { check: '批量删除白名单判据', what: 'deleteMultipleObject 出现点', re: /\bdeleteMultipleObject\s*\(/g, min: 1 },
  { check: 'Accept-Ranges 与 GET 同源', what: 'Accept-Ranges 宣告点', re: /['"]Accept-Ranges['"]/gi, min: 2 },
  { check: '缓存键含全部区分维度', what: 'keyOf( 出现点', re: /\bkeyOf\s*\(/g, min: 3 },
  { check: '上游状态码不占本地 401', what: '.status 赋值点', re: /\.status\s*=(?!=)/g, min: 40 },
  { check: '状态码落地调用点', what: '.status( 调用点', re: /\.status\s*\(/g, min: 150 },
  { check: 'HEAD 与 GET 同源（顺序）', what: '路由 head/get 注册点', re: /[A-Za-z_$][\w$]*\.(?:head|get)\(\s*['"]/g, min: 30 },
  { check: '数据目录必须支持 COS_DATA_DIR', what: 'data 目录定义点', re: /path\.(?:join|resolve)\([^;\n]*__dirname[^;\n]*\)/g, min: 9 },
  { check: '批量复制入口必须有回滚', what: '复制原语调用点', re: /\b(?:copyObject|putObjectCopy|sliceCopyFile)\s*\(/g, min: 5 },
];

/** @param {Array<{rel:string,src:string}>} files @param {typeof SCAN_LOWER_BOUNDS} bounds */
function lowerBoundFails(files, bounds) {
  const fails = [];
  for (const b of bounds) {
    let n = 0;
    for (const f of files) {
      const t = stripComments(f.src);
      n += (t.match(b.re) || []).length;
    }
    if (n < b.min) fails.push(`${b.check}：${b.what} 只扫到 ${n} 个，下界 ${b.min} —— 检查很可能已失效`);
  }
  return fails;
}

test('样例自测 · 扫描范围下界自检本身必须有效（下界抬高即报）', () => {
  const files = [{ rel: 'a.js', src: 'process.on(\'exit\', () => {});\n' }];
  // 下界与实例数相称 → 通过
  assertEqual(lowerBoundFails(files, [{ check: 'X', what: 'exit 钩子', re: /process\.on\(\s*['"]exit['"]/g, min: 1 }]).length, 0,
    '下界等于实例数时必须通过');
  // 下界高于实例数 → 必须报（这正对应"检查扫不到东西了"）
  assert(lowerBoundFails(files, [{ check: 'X', what: 'exit 钩子', re: /process\.on\(\s*['"]exit['"]/g, min: 2 }]).length >= 1,
    '下界高于实际实例数时必须报 —— 否则这条自检本身也是空转的');
});

test('扫描范围下界自检：每条检查都必须真的扫到实例（否则命中归零也是"绿"）', () => {
  const fails = lowerBoundFails(serverFiles, SCAN_LOWER_BOUNDS);
  assertEqual(fails.length, 0, `下界自检未通过：\n  ${fails.join('\n  ')}`);
});

test('测试隔离：tests/ 侧也不得硬编码 data 目录（R13-07 §6.5）', () => {
  const testFiles = jsFiles('tests').map((f) => ({
    rel: path.relative(ROOT, f).replace(/\\/g, '/'),
    src: fs.readFileSync(f, 'utf8'),
  }));
  const hits = [];
  for (const f of testFiles) hits.push(...dataDirViolations(f.src, f.rel));
  assertEqual(hits.length, 0,
    `命中 ${hits.length} 处（测试侧硬编码 data 目录 = 直接改写生产数据）：\n  ${hits.join('\n  ')}`);
  // 下界自检：至少要扫到 20 个测试文件，否则是"扫了个空"
  assert(testFiles.length >= 20,
    `扫描范围自检：应至少扫到 20 个测试文件，实际 ${testFiles.length} 个`);
});

test('反向变异 anchor 必须在各自的 file 内命中', () => {
  const hits = anchorViolations();
  assert(CASES.length >= 50, `前置：反向对照台账应至少 50 条，实际 ${CASES.length} 条`);
  assertEqual(hits.length, 0,
    `命中 ${hits.length} 条失效 anchor（未命中 = 等于没登记反向对照）：\n  ${hits.join('\n  ')}`);
});

/**
 * 退役项**必须写明原因**（R14 复核新增）。
 *
 * `retired: true` 会让 `scripts/reverse-check.js` 跳过该条 —— 若无门槛，就等于给了
 * 「把跑不红的对照项悄悄藏起来」的后门。所以：① 退役必须有 ≥ 20 字的 `retiredReason`；
 * ② 非退役项必须四要素齐全（file / testFile / minFail / anchor 或 mutations）；
 * ③ 退役项总数设上限，逼迫定期回看（积压多了说明在拿退役掩盖问题）。
 */
test('反向变异台账：退役项必须写明原因，且数量受控', () => {
  const bad = [];
  const retired = [];
  for (const c of CASES) {
    if (c.retired) {
      retired.push(c.name);
      if (typeof c.retiredReason !== 'string' || c.retiredReason.trim().length < 20) {
        bad.push(`「${c.name}」退役但未写明原因（retiredReason 缺失或 < 20 字）`);
      }
      continue;
    }
    if (!c.file || !c.testFile || !(c.minFail >= 1)) {
      bad.push(`「${c.name}」缺少 file / testFile / minFail`);
    }
    const hasAnchor = Array.isArray(c.mutations) ? c.mutations.length > 0 : Boolean(c.anchor);
    if (!hasAnchor) bad.push(`「${c.name}」既无 anchor 也无 mutations`);
  }
  assertEqual(bad.length, 0, `台账格式问题：\n  ${bad.join('\n  ')}`);
  assert(retired.length <= 5,
    `退役项已达 ${retired.length} 条（上限 5）—— 退役是例外不是常态，请回看这些对照项为何不可证伪`);
});

test('反向变异台账：用例名不得重复', () => {
  const seen = new Map();
  const dup = [];
  for (const c of CASES) {
    if (seen.has(c.name)) dup.push(`「${c.name}」`);
    seen.set(c.name, true);
  }
  assertEqual(dup.length, 0, `重复登记的用例名：${dup.join('、')}`);
});

test('验证码脚本源必须被 CSP 允许：启用验证码后不得锁死全站登录（R14-02）', () => {
  const mainSrc = fs.readFileSync(path.join(ROOT, 'public', 'js', 'main.js'), 'utf8');
  const idxSrc = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  const hits = captchaCspViolations(mainSrc, idxSrc);
  assertEqual(hits.length, 0,
    `命中 ${hits.length} 处（脚本被 CSP 拦截 → 组件永不 load → 所有人无法登录）：\n  ${hits.join('\n  ')}`);
  // 扫描范围下界自检：提取不到东西时"命中 0"与"合规"长得一样，必须挡住
  const srcs = captchaSources(mainSrc);
  assert(srcs.length >= 2,
    `扫描范围自检：应至少提取到 2 个验证码脚本源，实际 ${srcs.length} 个 —— 检查很可能已失效`);
  assert(/recaptcha|challenges/.test(cspScriptSrc(idxSrc)),
    `扫描范围自检：CSP script-src 段应至少含一个验证码来源，实际：${cspScriptSrc(idxSrc)}`);
});

test('R14 系列：第十四轮修复的静态不变量（每条自带扫描范围下界自检）', () => {
  /**
   * 下界自检按「被检查的特征串」出现次数做（不用正则，避免转义坑）：
   * 特征扫不到时，`fn` 返回空数组与「代码全合规」在结果上完全一样 —— 那正是假护栏。
   */
  const groups = [
    { name: 'R14-13 rename newKey 同源', fn: renameKeyViolations, files: ['server/routes/fs.js'], what: 'const newKey', min: 1 },
    { name: 'R14-04 异步写不持有旧 store', fn: asyncStoreWriteViolations, files: ['server/config-store.js'], what: 'async function ', min: 2 },
    { name: 'R14-05 发起支付先查支付态', fn: payStateViolations, files: ['server/share-routes.js'], what: "router.post('/s/:id/pay'", min: 1 },
    { name: 'R14-06 WebDAV 安全响应头', fn: webdavHeaderViolations, files: ['server/webdav-server.js'], what: 'function buildApp', min: 1 },
    { name: 'R14-07 WebDAV 认证 dummyHash', fn: webdavAuthTimingViolations, files: ['server/config-store.js'], what: 'function authenticateWebdav(', min: 1 },
    /* R14-09 / R14-10 / R14-12：性能批次的「本地收口」必须落在唯一实现点上 */
    { name: 'R14-09 订单落盘唯一写端', fn: paymentPersistViolations, files: ['server/payment-orders.js'], what: 'function create(', min: 1 },
    { name: 'R14-10 探测去重与留痕', fn: probeViolations, files: ['server/share-routes.js'], what: 'async function probeObjectMissing(', min: 1 },
    { name: 'R14-12 /fs/stat 走短缓存与并发合并', fn: statRouteViolations, files: ['server/routes/fs.js'], what: "router.get('/fs/stat'", min: 1 },
    /* 搜索候选集：结构性前提（订阅失效 / tooBig 守卫顺序 / 桶维度复用）与两层缓存并存 */
    { name: '搜索候选集的结构性前提', fn: searchCandidatesViolations, files: ['server/search-candidates.js'], what: 'DEFAULT_TTL_MS', min: 1 },
    { name: '/fs/search 两层缓存与云端兜底', fn: searchRouteViolations, files: ['server/routes/fs.js'], what: "router.get('/fs/search'", min: 1 },
  ];
  const hits = [];
  const lowerFails = [];
  for (const g of groups) {
    let scanned = 0;
    for (const rel of g.files) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      const t = stripComments(src);
      let idx = 0;
      while ((idx = t.indexOf(g.what, idx)) >= 0) { scanned++; idx += g.what.length; }
      hits.push(...g.fn(src, rel));
    }
    if (scanned < g.min) {
      lowerFails.push(`${g.name}：特征「${g.what}」只扫到 ${scanned} 个，下界 ${g.min} —— 检查很可能已失效`);
    }
  }
  assertEqual(lowerFails.length, 0,
    `扫描范围下界自检未通过（命中归零同样显示为"绿"）：\n  ${lowerFails.join('\n  ')}`);
  assertEqual(hits.length, 0,
    `命中 ${hits.length} 处（第十四轮已修复项的回归）：\n  ${hits.join('\n  ')}`);
});
