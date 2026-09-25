/**
 * .gitignore 语法解析与匹配 —— 遵循 git 官方规范
 *
 * 支持：# 注释、! 取反、尾随 /（仅匹配目录）、** 前导/中间/尾随、* ? [..] 通配、
 * 反斜杠转义；含 / 的规则锚定在 .gitignore 所在目录，否则可匹配任意层级。
 * 目录规则会连带匹配其下的所有内容；同一路径按规则顺序「最后命中者生效」。
 *
 * ⚠️ SEC-04（2026-09-14）：**本模块绝不能再改回"编译成正则"的实现**。
 *
 * 旧实现把每个通配符翻译成正则片段（`**\/` → `(?:[^/]+\/)*`、`*` → `[^/]*`、
 * 尾部 `**` → `.*`），多条通配符相邻即形成**嵌套量词**。而 `.gitignore` 文本
 * 来自客户端（`POST /api/fs/upload/init` 的请求体，上限受 2MB JSON 约束），
 * 于是 `**\/**\/**\/**\/**\/**\/x`、或大量 `*a*a*a…` 都会让 V8 正则进入
 * 灾难性回溯 —— **单线程事件循环被占满，全站（含 WebDAV 与所有下载）无响应**。
 *
 * 现在改为**线性匹配器**：先把模式编译成 token 序列，再用动态规划逐 token
 * 推进（`O(模式长度 × 路径长度)`，永无回溯放大）。既消除了 ReDoS，
 * 也比正则更快、更可预测。`public/js/gitignore.js` 需保持同一套实现。
 */

/* ------------------------------ 编译：模式 → token ------------------------------ */

const T_LIT = 1;   // 字面字符
const T_CLS = 2;   // 字符类 [..]
const T_ONE = 3;   // ?  单个非 / 字符
const T_SEG = 4;   // *  任意个非 / 字符
const T_ANY = 5;   // ** 任意个字符（含 /）
const T_DIR = 6;   // 内部虚拟 token：`**\/`（零个或多个「非空目录段 + /」）

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 把 glob 模式编译为 token 数组。
 * @returns {Array<{t:number, c?:string, test?:Function}>}
 */
function compile(pattern) {
  const toks = [];
  let i = 0;
  const n = pattern.length;
  while (i < n) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        while (pattern[i] === '*') i++; // 吸收连续 *
        if (pattern[i] === '/') {
          // `**/` = 零个或多个「非空目录段 + /」→ 单个 T_DIR token。
          // ⚠️ 只能对 `**/` 用这个语义；`*/`（单星）是 `[^/]*/`（可匹配空段，如 `a//c`），
          //    二者绝不能合并，否则会改变匹配语言。
          toks.push({ t: T_DIR });
          i++;
        } else {
          toks.push({ t: T_ANY }); // 尾随/中间 ** 匹配该位置之后的一切
        }
      } else { toks.push({ t: T_SEG }); i++; } // * 任意非 / 序列
    } else if (c === '?') { toks.push({ t: T_ONE }); i++; }
    else if (c === '[') {
      // 字符类（git 支持 [!..] 取反写法）。字符类只匹配单个字符，
      // 用定长正则（^[cls]$）实现，不存在回溯风险。
      let j = i + 1, cls = '', closed = false;
      if (pattern[j] === '!' || pattern[j] === '^') { cls += '^'; j++; }
      if (pattern[j] === ']') { cls += '\\]'; j++; }
      while (j < n) {
        if (pattern[j] === ']') { closed = true; break; }
        if (pattern[j] === '\\') { cls += '\\\\' + (pattern[j + 1] || ''); j += 2; continue; }
        cls += escapeRe(pattern[j]);
        j++;
      }
      if (closed) {
        let re = null;
        try { re = new RegExp('^[' + cls + ']$'); } catch (e) { re = null; }
        // 非法字符类（如 [z-a]）按字面 '[' 处理，与旧实现的容错一致
        if (re) toks.push({ t: T_CLS, test: (ch) => re.test(ch) });
        else toks.push({ t: T_LIT, c: '[' });
        i = j + 1;
      } else { toks.push({ t: T_LIT, c: '[' }); i++; }
    } else if (c === '\\') {
      toks.push({ t: T_LIT, c: pattern[i + 1] === undefined ? '\\' : pattern[i + 1] });
      i += 2;
    } else {
      toks.push({ t: T_LIT, c });
      i++;
    }
  }
  return toks;
}

/**
 * 线性匹配（动态规划）。永不回溯，`O(steps × text)`。
 *
 * @param {Array} steps mergeSteps() 的输出
 * @param {string} text 待匹配字符串
 * @returns {Uint8Array} 长度 text.length+1 的状态向量：
 *          `vec[j] === 1` 表示**整个模式恰好匹配 text[0..j)**。
 *          取 vec[text.length] 即为「整串匹配」；用于锚定规则时，
 *          还可直接读取各「段边界」位置来判断是否匹配某个**前缀**
 *          —— 这样一条规则只需跑一次 DP，而不是每个前缀跑一次。
 */
function matchVector(steps, text) {
  const m = text.length;
  let cur = new Uint8Array(m + 1);
  cur[0] = 1;

  for (const tk of steps) {
    const next = new Uint8Array(m + 1);
    if (tk.t === T_SEG) {
      // 任意个非 / 字符：从任一可达位置出发，一路吃非 / 字符
      let reach = 0;
      for (let j = 0; j <= m; j++) {
        if (j > 0 && text[j - 1] === '/') reach = 0; // 不能跨越 /
        if (cur[j]) reach = 1;
        next[j] = reach;
      }
    } else if (tk.t === T_ANY) {
      // 任意个字符（含 /）：一旦可达，之后全部可达
      let reach = 0;
      for (let j = 0; j <= m; j++) {
        if (cur[j]) reach = 1;
        next[j] = reach;
      }
    } else if (tk.t === T_DIR) {
      // 零个或多个「非空目录段 + /」：只在「段边界」之间跳转，一次前向扫描即可
      const nextSlash = new Int32Array(m + 1);
      nextSlash[m] = -1;
      for (let q = m - 1; q >= 0; q--) nextSlash[q] = text[q] === '/' ? q : nextSlash[q + 1];
      const can = Uint8Array.from(cur);
      for (let k = 0; k <= m; k++) {
        if (!can[k]) continue;
        const q = nextSlash[k];
        if (q > k) can[q + 1] = 1; // 段内至少一个字符，且 q<m ⇒ q+1<=m
      }
      next.set(can);
    } else {
      // 单字符 token
      for (let j = 0; j < m; j++) {
        if (!cur[j]) continue;
        const ch = text[j];
        let ok = false;
        if (tk.t === T_LIT) ok = ch === tk.c;
        else if (tk.t === T_ONE) ok = ch !== '/';
        else ok = tk.test(ch); // T_CLS
        if (ok) next[j + 1] = 1;
      }
    }
    cur = next;
  }
  return cur;
}

/** 整串匹配的便捷包装 */
function matchSteps(steps, text) {
  return matchVector(steps, text)[text.length] === 1;
}

/**
 * 把 token 序列整理为可执行步骤。
 *
 * 编译阶段已把 `**\/` 直接产出为 T_DIR，这里只需原样返回；
 * 保留该函数是为了让「步骤」与「原始 token」在语义上分离（便于将来再做优化）。
 */
function mergeSteps(toks) {
  return toks;
}

/**
 * 分析编译结果，得出用于**剪枝**的元信息 —— 这是把 `isIgnored` 从
 * 「规则数 × 全部前缀 × 完整匹配」的乘法成本降下来的关键。
 */
function analyze(toks) {
  const steps = mergeSteps(toks);
  let hasCross = false;
  let segCount = 0;
  let plain = '';
  let plainOk = true;
  for (const s of steps) {
    if (s.t === T_ANY || s.t === T_DIR) hasCross = true;
    if (s.t === T_LIT) {
      if (s.c === '/') segCount++;
      plain += s.c;
    } else plainOk = false;
  }
  return {
    steps,
    hasCross,
    segCount,
    plain: plainOk ? plain : null, // 纯字面量规则 → 可直接字符串比较
  };
}

/**
 * 兼容入口：编译单个模式并直接对 text 求值（供测试/调试使用）。
 */
function matchTokens(toks, text) {
  return matchSteps(mergeSteps(toks), text);
}

/* ------------------------------ 规则解析 ------------------------------ */

/** 结构性上限：防止用超大输入拖垮解析（匹配本身已是线性，这里只防解析与内存放大） */
const MAX_TEXT = 64 * 1024;   // 整个 .gitignore 文本
const MAX_RULES = 500;        // 规则条数
const MAX_LINE = 2048;        // 单行长度
const MAX_PATH = 4096;        // 单次判定的路径长度（病态超长路径直接放行）
const MAX_DEPTH = 64;         // 参与前缀匹配的最大目录层级

/** 解析一行规则；返回 null 表示空行/注释（不产生规则） */
function parseLine(line) {
  // 去除未被反斜杠转义的尾随空格
  line = line.replace(/(?<!\\)\s+$/, '');
  if (!line) return null;
  let negated = false;
  if (line[0] === '!') { negated = true; line = line.slice(1); }
  else if (line[0] === '#') return null; // 注释
  if (!line) return null;
  let dirOnly = false;
  if (line.endsWith('/')) { dirOnly = true; line = line.slice(0, -1); }
  if (!line) return null;
  line = line.replace(/^\.\//, ''); // 去掉开头的 ./
  // 前导 / 是锚定标记（不参与字面匹配），含 /（非末尾）同样表示相对 .gitignore 所在目录锚定
  let anchored = false;
  if (line[0] === '/') { anchored = true; line = line.slice(1); }
  if (line.includes('/')) anchored = true;
  if (line.length > MAX_LINE) line = line.slice(0, MAX_LINE);
  // 锚定规则必然是完整路径匹配；未锚定规则只看单个路径段（因此其模式内不可能含 /）
  return Object.assign(
    { negated, dirOnly, anchored, source: line },
    analyze(compile(line))
  );
}

/**
 * 单条规则是否命中「路径的某个前缀段」。
 *
 * @param {object} rule
 * @param {string[]} parts 路径按 / 切分后的段
 * @param {number} depth 参与判定的层数（<= parts.length）
 * @param {string} rel 完整相对路径（= parts.join('/')）
 * @param {Int32Array} bounds bounds[i] = 第 i 段结束（即其后若有 / 则是该 / 的下标）在 rel 中的位置
 */
function ruleMatchesPath(rule, parts, depth, rel, bounds) {
  if (rule.anchored) {
    // 锚定规则需按「逐级前缀」匹配。段数下界剪枝：T_DIR 可匹配零段，
    // 因此模式能匹配的最少段数 = 固定 '/' 的个数 + 1。
    if (rule.segCount + 1 > depth) return false;

    if (!rule.hasCross) {
      // 无跨段通配符（每个 T_SEG/T_ONE/T_CLS 都不含 /）→ 匹配串的段数必定恰好
      // 等于 segCount+1，因此**只有一个前缀**可能是候选。
      // 注意不能只比完整路径：`a/b/c` 也必须能命中 `a/b/c/d` 的祖先前缀 `a/b/c`。
      const i = rule.segCount + 1;
      const isDir = i < depth;
      if (rule.dirOnly && !isDir) return false;
      const prefix = rel.slice(0, bounds[i]);
      return rule.plain !== null ? prefix === rule.plain : matchSteps(rule.steps, prefix);
    }

    // 含跨段通配符：**只跑一次 DP**，再读取各段边界处的状态即可判断是否匹配某个前缀
    // （旧写法对每个前缀各跑一次完整匹配，成本是这里的 depth 倍）。
    const vec = matchVector(rule.steps, rel);
    const top = depth;
    for (let i = 1; i <= top; i++) {
      if (rule.dirOnly && i >= depth) continue; // 该前缀必须仍是目录（i < depth）
      if (vec[bounds[i]] === 1) return true;
    }
    return false;
  }

  // 未锚定规则只看「最后一个路径段」，因此逐级前缀等价于逐段测试
  const last = rule.dirOnly ? depth - 1 : depth; // dirOnly 要求该段是目录 → 不含最后一段
  for (let i = 0; i < last; i++) {
    const seg = parts[i];
    if (rule.plain !== null ? seg === rule.plain : matchSteps(rule.steps, seg)) return true;
  }
  return false;
}

function matcherFrom(rules, truncated) {
  return {
    rules,
    truncated: !!truncated,
    /**
     * 判断相对路径是否被忽略。
     * @param {string} relPath 相对 .gitignore 所在目录的路径（/ 分隔，可带末尾 /）
     * @returns {boolean}
     */
    isIgnored(relPath) {
      let rel = String(relPath || '').replace(/\\/g, '/');
      rel = rel.replace(/^\.\//, '').replace(/\/+$/, '');
      if (!rel || rel.length > MAX_PATH) return false;
      const parts = rel.split('/');
      const depth = Math.min(parts.length, MAX_DEPTH);

      // 段边界表：bounds[i] = 第 i 段结束处在 rel 中的下标（供锚定规则读取前缀）
      const bounds = new Int32Array(depth + 1);
      let segDone = 0;
      for (let k = 0; k < rel.length; k++) {
        if (rel[k] !== '/') continue;
        segDone++;
        if (segDone > depth) break;
        bounds[segDone] = k;
      }
      for (let i = segDone + 1; i <= depth; i++) bounds[i] = rel.length;

      // 「最后命中者生效」→ 从后往前找，第一条命中的就是权威结果（可提前返回）
      for (let ri = rules.length - 1; ri >= 0; ri--) {
        const rule = rules[ri];
        if (ruleMatchesPath(rule, parts, depth, rel, bounds)) return !rule.negated;
      }
      return false;
    },
  };
}

/**
 * 解析 .gitignore 文本并返回匹配器。
 *
 * 超过结构性上限时**截断并在 matcher.truncated 上标记**，由调用方决定是否告警
 * （不静默丢弃 —— 静默会让"本该被忽略的文件被上传"难以排查）。
 */
function createMatcher(text) {
  let src = String(text || '');
  let truncated = false;
  if (src.length > MAX_TEXT) { src = src.slice(0, MAX_TEXT); truncated = true; }
  const rules = [];
  const lines = src.split(/\r?\n/);
  for (const raw of lines) {
    if (rules.length >= MAX_RULES) { truncated = true; break; }
    const r = parseLine(raw);
    if (r) rules.push(r);
  }
  return matcherFrom(rules, truncated);
}

module.exports = {
  createMatcher, parseLine, matchTokens, compile, mergeSteps, matchSteps, analyze,
  MAX_TEXT, MAX_RULES, MAX_LINE, MAX_PATH, MAX_DEPTH,
};
