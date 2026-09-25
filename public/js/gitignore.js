/**
 * .gitignore 语法解析与匹配（浏览器端 ESM 版，逻辑与 server/gitignore.js 保持一致）
 * —— 遵循 git 官方规范：注释、! 取反、尾随 /（仅目录）、** 通配、* ? [..]、转义、锚定规则。
 *
 * ⚠️ SEC-04：必须与服务端一样使用**线性匹配器**，绝不能改回"编译成正则"。
 * 旧实现在客户端同样被用户提供的 .gitignore 文本驱动（本模块直接吃到上传目录里的
 * .gitignore 内容），`**\/**\/**\/…` 或大量 `*a*a*a…` 会让浏览器主线程卡死（页面假死）。
 * 详见 server/gitignore.js 的模块注释。
 */

const T_LIT = 1;   // 字面字符
const T_CLS = 2;   // 字符类 [..]
const T_ONE = 3;   // ?  单个非 / 字符
const T_SEG = 4;   // *  任意个非 / 字符
const T_ANY = 5;   // ** 任意个字符（含 /）
const T_DIR = 6;   // 内部虚拟 token：`**\/`（零个或多个「非空目录段 + /」）

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 把 glob 模式编译为 token 数组 */
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
          // `**/` → 单个 T_DIR。注意只有 `**/` 用该语义；
          // `*/`（单星）是 `[^/]*/`（可匹配空段），二者不能合并。
          toks.push({ t: T_DIR });
          i++;
        } else toks.push({ t: T_ANY });
      } else { toks.push({ t: T_SEG }); i++; }
    } else if (c === '?') { toks.push({ t: T_ONE }); i++; }
    else if (c === '[') {
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

function mergeSteps(toks) { return toks; }

/** 分析编译结果，得到用于剪枝的元信息 */
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
  return { steps, hasCross, segCount, plain: plainOk ? plain : null };
}

/**
 * 线性匹配（动态规划，永不回溯）。
 * @returns {Uint8Array} vec[j]===1 表示整个模式恰好匹配 text[0..j)
 */
function matchVector(steps, text) {
  const m = text.length;
  let cur = new Uint8Array(m + 1);
  cur[0] = 1;
  for (const tk of steps) {
    const next = new Uint8Array(m + 1);
    if (tk.t === T_SEG) {
      let reach = 0;
      for (let j = 0; j <= m; j++) {
        if (j > 0 && text[j - 1] === '/') reach = 0;
        if (cur[j]) reach = 1;
        next[j] = reach;
      }
    } else if (tk.t === T_ANY) {
      let reach = 0;
      for (let j = 0; j <= m; j++) {
        if (cur[j]) reach = 1;
        next[j] = reach;
      }
    } else if (tk.t === T_DIR) {
      const nextSlash = new Int32Array(m + 1);
      nextSlash[m] = -1;
      for (let q = m - 1; q >= 0; q--) nextSlash[q] = text[q] === '/' ? q : nextSlash[q + 1];
      const can = Uint8Array.from(cur);
      for (let k = 0; k <= m; k++) {
        if (!can[k]) continue;
        const q = nextSlash[k];
        if (q > k) can[q + 1] = 1;
      }
      next.set(can);
    } else {
      for (let j = 0; j < m; j++) {
        if (!cur[j]) continue;
        const ch = text[j];
        let ok = false;
        if (tk.t === T_LIT) ok = ch === tk.c;
        else if (tk.t === T_ONE) ok = ch !== '/';
        else ok = tk.test(ch);
        if (ok) next[j + 1] = 1;
      }
    }
    cur = next;
  }
  return cur;
}

function matchSteps(steps, text) {
  return matchVector(steps, text)[text.length] === 1;
}

const MAX_TEXT = 64 * 1024;
const MAX_RULES = 500;
const MAX_LINE = 2048;
const MAX_PATH = 4096;
const MAX_DEPTH = 64;

function parseLine(line) {
  line = line.replace(/(?<!\\)\s+$/, '');
  if (!line) return null;
  let negated = false;
  if (line[0] === '!') { negated = true; line = line.slice(1); }
  else if (line[0] === '#') return null;
  if (!line) return null;
  let dirOnly = false;
  if (line.endsWith('/')) { dirOnly = true; line = line.slice(0, -1); }
  if (!line) return null;
  line = line.replace(/^\.\//, '');
  let anchored = false;
  if (line[0] === '/') { anchored = true; line = line.slice(1); }
  if (line.includes('/')) anchored = true;
  if (line.length > MAX_LINE) line = line.slice(0, MAX_LINE);
  return Object.assign({ negated, dirOnly, anchored, source: line }, analyze(compile(line)));
}

function ruleMatchesPath(rule, parts, depth, rel, bounds) {
  if (rule.anchored) {
    if (rule.segCount + 1 > depth) return false;
    if (!rule.hasCross) {
      const i = rule.segCount + 1;
      const isDir = i < depth;
      if (rule.dirOnly && !isDir) return false;
      const prefix = rel.slice(0, bounds[i]);
      return rule.plain !== null ? prefix === rule.plain : matchSteps(rule.steps, prefix);
    }
    const vec = matchVector(rule.steps, rel);
    for (let i = 1; i <= depth; i++) {
      if (rule.dirOnly && i >= depth) continue;
      if (vec[bounds[i]] === 1) return true;
    }
    return false;
  }
  const last = rule.dirOnly ? depth - 1 : depth;
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
    isIgnored(relPath) {
      let rel = String(relPath || '').replace(/\\/g, '/');
      rel = rel.replace(/^\.\//, '').replace(/\/+$/, '');
      if (!rel || rel.length > MAX_PATH) return false;
      const parts = rel.split('/');
      const depth = Math.min(parts.length, MAX_DEPTH);
      const bounds = new Int32Array(depth + 1);
      let segDone = 0;
      for (let k = 0; k < rel.length; k++) {
        if (rel[k] !== '/') continue;
        segDone++;
        if (segDone > depth) break;
        bounds[segDone] = k;
      }
      for (let i = segDone + 1; i <= depth; i++) bounds[i] = rel.length;
      // 「最后命中者生效」→ 从后往前，命中即可提前返回
      for (let ri = rules.length - 1; ri >= 0; ri--) {
        const rule = rules[ri];
        if (ruleMatchesPath(rule, parts, depth, rel, bounds)) return !rule.negated;
      }
      return false;
    },
  };
}

/** 解析 .gitignore 文本并返回匹配器（超限时截断并在 truncated 上标记） */
export function createMatcher(text) {
  let src = String(text || '');
  let truncated = false;
  if (src.length > MAX_TEXT) { src = src.slice(0, MAX_TEXT); truncated = true; }
  const rules = [];
  for (const raw of src.split(/\r?\n/)) {
    if (rules.length >= MAX_RULES) { truncated = true; break; }
    const r = parseLine(raw);
    if (r) rules.push(r);
  }
  return matcherFrom(rules, truncated);
}
