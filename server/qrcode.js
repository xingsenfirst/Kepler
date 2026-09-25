/**
 * 二维码生成器（Byte 模式 / 纠错级别 M）—— 零依赖自研
 *
 * 为什么自研：本项目严守「仅 3 个依赖」的约定，不为一张二维码引入 npm 包。
 * 用途：微信支付 Native 下单返回 code_url 后，服务端直接渲染成 SVG 供扫码。
 *
 * 实现范围（够用即止，不追求全规范）：
 *  - 版本 1 ~ 10（每版本容量见 CAPACITY），纠错级别固定 M（约 15% 纠错）
 *  - 仅 Byte 模式（UTF-8），这对「把 code_url 编进去」完全够用
 *  - 输出：模块矩阵 / SVG 字符串
 *
 * 正确性要点（写错其中任何一条，扫码器都会解不出）：
 *  1. 数据位流：模式指示符 0100 → 字符数（V1-9 用 8 位，V10+ 用 16 位）→ 数据 → 终止符 → 补齐
 *  2. 分块 RS：每个数据块独立算纠错码，再按规范交织（不是简单拼接）
 *  3. 掩码：8 种掩码算惩罚分取最低，**且掩码编号必须写进格式信息**
 *  4. 剩余位（remainder bits）：V2-6 有 7 个，V7-13 为 0 —— 少放就会整体错位
 */
'use strict';

/* ============================ GF(256) 运算 ============================ */

const EXP = new Array(512);
const LOG = new Array(256);
(function initGf() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // 本原多项式 x^8+x^4+x^3+x^2+1
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/** 生成多项式 (x-α^0)(x-α^1)…(x-α^(n-1))，系数从高次到低次，首项恒为 1 */
function genPoly(n) {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const ng = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      ng[j] ^= g[j];                  // 乘 x
      ng[j + 1] ^= gfMul(g[j], EXP[i]); // 乘 α^i
    }
    g = ng;
  }
  return g;
}

/** 多项式长除法取余 → n 个纠错码字 */
function ecCodewords(data, n) {
  const g = genPoly(n);
  const res = new Array(n).fill(0);
  for (const d of data) {
    const factor = d ^ res[0];
    res.shift();
    res.push(0);
    if (factor !== 0) {
      for (let i = 0; i < n; i++) res[i] ^= gfMul(g[i + 1], factor);
    }
  }
  return res;
}

/* ============================ 容量表（纠错级别 M） ============================ */

/**
 * 下标即版本号（0 未用）。
 *   blocks   各数据块的数据码字数（长度即块数）
 *   ec       每块的纠错码字数
 *   total    该版本总码字数（用于校验表本身没写错）
 */
const CAPACITY = [
  null,
  { blocks: [16], ec: 10, total: 26 },
  { blocks: [28], ec: 16, total: 44 },
  { blocks: [44], ec: 26, total: 70 },
  { blocks: [32, 32], ec: 18, total: 100 },
  { blocks: [43, 43], ec: 24, total: 134 },
  { blocks: [27, 27, 27, 27], ec: 16, total: 172 },
  { blocks: [31, 31, 31, 31], ec: 18, total: 196 },
  { blocks: [38, 38, 39, 39], ec: 22, total: 242 },
  { blocks: [36, 36, 36, 37, 37], ec: 22, total: 292 },
  { blocks: [43, 43, 43, 43, 44], ec: 26, total: 346 },
];

/** 对齐图案中心坐标（版本 1 无） */
const ALIGN = [
  null, [],
  [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];

/** 每版本的数据容量（字节） */
function capacityBytes(version) {
  const c = CAPACITY[version];
  if (!c) return 0;
  return c.blocks.reduce((s, n) => s + n, 0);
}

/** 按字节数挑最小可用版本；超出支持范围返回 0 */
function pickVersion(byteLen) {
  for (let v = 1; v < CAPACITY.length; v++) {
    // 扣掉模式指示符(4bit) + 字符数(8/16bit) 后仍能装下的最大字节数
    const countBits = v <= 9 ? 8 : 16;
    const usableBits = capacityBytes(v) * 8 - 4 - countBits;
    if (usableBits >= byteLen * 8) return v;
  }
  return 0;
}

/* ============================ 位流编码 ============================ */

function buildDataCodewords(bytes, version) {
  const capBytes = capacityBytes(version);
  const bits = [];
  const push = (value, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };

  push(0b0100, 4); // Byte 模式
  push(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);

  // 终止符 + 补齐到字节边界 + 交替填充 0xEC / 0x11
  const capBits = capBytes * 8;
  for (let i = 0; i < 4 && bits.length < capBits; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    out.push(v);
  }
  const pads = [0xec, 0x11];
  let pi = 0;
  while (out.length < capBytes) out.push(pads[pi++ % 2]);
  return out;
}

/** 分块 → 纠错 → 交织，得到最终码字序列 */
function interleave(dataCodewords, version) {
  const c = CAPACITY[version];
  const blocks = c.blocks.map((size) => ({ size, data: [], ec: [] }));
  let cursor = 0;
  for (const b of blocks) {
    b.data = dataCodewords.slice(cursor, cursor + b.size);
    cursor += b.size;
    b.ec = ecCodewords(b.data, c.ec);
  }
  const out = [];
  const maxData = Math.max.apply(null, blocks.map((b) => b.size));
  for (let i = 0; i < maxData; i++) {
    for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  }
  for (let i = 0; i < c.ec; i++) {
    for (const b of blocks) out.push(b.ec[i]);
  }
  return out;
}

/* ============================ 矩阵布局 ============================ */

function newMatrix(size) {
  const m = [];
  for (let r = 0; r < size; r++) m.push(new Array(size).fill(0));
  return m;
}
function newFlag(size) {
  const f = [];
  for (let r = 0; r < size; r++) f.push(new Array(size).fill(false));
  return f;
}

/** 定位（探测）图案 + 分隔符；同时把 8×8 区域标记为已占用 */
function placeFinder(m, f, r0, c0) {
  for (let dr = -1; dr <= 7; dr++) {
    for (let dc = -1; dc <= 7; dc++) {
      const r = r0 + dr, c = c0 + dc;
      if (r < 0 || r >= m.length || c < 0 || c >= m.length) continue;
      const inRing = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
      const dark = inRing
        && (dr === 0 || dr === 6 || dc === 0 || dc === 6
          || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
      m[r][c] = dark ? 1 : 0;
      f[r][c] = true;
    }
  }
}

function placeAlign(m, f, version) {
  const coords = ALIGN[version];
  if (!coords || !coords.length) return;
  const last = m.length - 1;
  for (const r0 of coords) {
    for (const c0 of coords) {
      // 与三个定位图案重叠的位置不放置
      if ((r0 === 6 && c0 === 6) || (r0 === 6 && c0 === last - 6) || (r0 === last - 6 && c0 === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          m[r0 + dr][c0 + dc] = dark ? 1 : 0;
          f[r0 + dr][c0 + dc] = true;
        }
      }
    }
  }
}

function placeTiming(m, f) {
  const size = m.length;
  for (let i = 8; i < size - 8; i++) {
    const v = i % 2 === 0 ? 1 : 0;
    m[6][i] = v; f[6][i] = true;
    m[i][6] = v; f[i][6] = true;
  }
}

/** 预留格式信息区（含固定的深色模块） */
function reserveFormat(m, f) {
  const size = m.length;
  for (let i = 0; i <= 8; i++) {
    if (!f[8][i]) f[8][i] = true;
    if (!f[i][8]) f[i][8] = true;
  }
  for (let i = 0; i < 8; i++) {
    f[8][size - 1 - i] = true;
    f[size - 1 - i][8] = true;
  }
  m[size - 8][8] = 1; // 固定深色模块
  f[size - 8][8] = true;
}

/** 版本信息（V7+）区域 */
function reserveVersion(m, f, version) {
  if (version < 7) return;
  const size = m.length;
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 3; j++) {
      f[i][size - 11 + j] = true;
      f[size - 11 + j][i] = true;
    }
  }
}

function placeVersionBits(m, version) {
  if (version < 7) return;
  let d = version << 12;
  for (let i = 0; i < 6; i++) {
    if (((d >>> (17 - i)) & 1) === 1) d ^= 0x1f25 << (5 - i);
  }
  const bits = (version << 12) | d;
  const size = m.length;
  for (let i = 0; i < 18; i++) {
    const bit = (bits >>> i) & 1;
    const r = Math.floor(i / 3);
    const c = i % 3;
    m[size - 11 + c][r] = bit;
    m[r][size - 11 + c] = bit;
  }
}

/** 数据位填充（从右下角开始的两列一组蛇形走位，跳过第 6 列） */
function placeData(m, f, codewords, version) {
  const size = m.length;
  let bitIndex = 0;
  const total = codewords.length * 8 + (version >= 2 && version <= 6 ? 7 : 0);
  const getBit = (i) => (i < codewords.length * 8 ? ((codewords[i >> 3] >>> (7 - (i & 7))) & 1) : 0);

  for (let right = size - 1; right >= 1; right -= 2) {
    const colA = right === 6 ? right - 1 : right; // 跳过第 6 列（定时图案）
    const colB = colA - 1;
    for (let vert = 0; vert < size; vert++) {
      for (let k = 0; k < 2; k++) {
        const upward = ((right + 1) & 2) === 0;
        const row = upward ? size - 1 - vert : vert;
        const col = k === 0 ? colA : colB;
        if (col < 0) continue;
        if (f[row][col]) continue;
        m[row][col] = bitIndex < total ? getBit(bitIndex) : 0;
        bitIndex += 1;
      }
    }
  }
}

/* ============================ 掩码 ============================ */

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function applyMask(m, f, maskId) {
  const fn = MASKS[maskId];
  const size = m.length;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (f[r][c]) continue;
      if (fn(r, c)) m[r][c] ^= 1;
    }
  }
}

/** 惩罚分（规则 1~4，分越低越好） */
function penalty(m) {
  const size = m.length;
  let score = 0;

  const runScore = (line) => {
    let s = 0, run = 1;
    for (let i = 1; i < line.length; i++) {
      if (line[i] === line[i - 1]) run += 1;
      else { if (run >= 5) s += run - 2; run = 1; }
    }
    if (run >= 5) s += run - 2;
    return s;
  };

  // 规则 1：同色连续 5 格以上
  for (let r = 0; r < size; r++) score += runScore(m[r]);
  for (let c = 0; c < size; c++) score += runScore(m.map((row) => row[c]));

  // 规则 2：2×2 同色块
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
    }
  }

  // 规则 4：黑白比例偏离 50%
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += m[r][c];
  score += Math.floor(Math.abs(dark * 20 / (size * size) - 10)) * 10;

  return score;
}

/** 格式信息：5 位数据（EC 级别 M = 00 + 掩码）经 BCH(15,5) 后与 0x5412 异或 */
function formatBits(maskId) {
  let d = (0b00 << 3) | maskId; // M 级别指示符为 00
  let v = d << 10;
  for (let i = 0; i < 5; i++) {
    if (((v >>> (14 - i)) & 1) === 1) v ^= 0x537 << (4 - i);
  }
  return ((d << 10) | v) ^ 0x5412;
}

function placeFormat(m, maskId) {
  const size = m.length;
  const bits = formatBits(maskId);
  const get = (i) => (bits >>> i) & 1;
  // 左上（横 + 竖）
  for (let i = 0; i <= 5; i++) m[8][i] = get(i);
  m[8][7] = get(6);
  m[8][8] = get(7);
  m[7][8] = get(8);
  for (let i = 9; i <= 14; i++) m[14 - i][8] = get(i);
  // 右上 + 左下（副本）
  for (let i = 0; i <= 7; i++) m[size - 1 - i][8] = get(i);
  for (let i = 8; i <= 14; i++) m[8][size - 15 + i] = get(i);
  m[size - 8][8] = 1; // 固定深色模块
}

/* ============================ 对外接口 ============================ */

/**
 * 生成二维码矩阵
 * @param {string} text 待编码内容
 * @returns {{version: number, size: number, modules: number[][]}|null} 超出容量返回 null
 */
function encode(text) {
  const bytes = Buffer.from(String(text), 'utf8');
  const version = pickVersion(bytes.length);
  if (!version) return null;

  const size = version * 4 + 17;
  const codewords = interleave(buildDataCodewords(bytes, version), version);

  const m = newMatrix(size);
  const f = newFlag(size);
  placeFinder(m, f, 0, 0);
  placeFinder(m, f, 0, size - 7);
  placeFinder(m, f, size - 7, 0);
  placeTiming(m, f);
  placeAlign(m, f, version);
  reserveFormat(m, f);
  reserveVersion(m, f, version);
  placeVersionBits(m, version);
  placeData(m, f, codewords, version);

  // 8 种掩码各算一次惩罚分，取最低者（掩码编号会写进格式信息，编码与解码因此一致）
  let best = null, bestScore = Infinity;
  for (let id = 0; id < 8; id++) {
    const cand = m.map((row) => row.slice());
    applyMask(cand, f, id);
    placeFormat(cand, id);
    const s = penalty(cand);
    if (s < bestScore) { bestScore = s; best = cand; }
  }
  return { version, size, modules: best };
}

/**
 * 渲染为 SVG 字符串（同一行的连续黑块合并成一个矩形，标记数量显著减少）
 * @param {string} text
 * @param {{scale?: number, margin?: number}} [opts]
 */
function toSvg(text, opts) {
  const q = encode(text);
  if (!q) return '';
  const o = opts || {};
  const scale = o.scale || 6;
  const margin = o.margin === undefined ? 4 : o.margin;
  const dim = (q.size + margin * 2) * scale;
  const rects = [];
  for (let r = 0; r < q.size; r++) {
    let c = 0;
    while (c < q.size) {
      if (!q.modules[r][c]) { c += 1; continue; }
      let run = 1;
      while (c + run < q.size && q.modules[r][c + run]) run += 1;
      rects.push(`<rect x="${(c + margin) * scale}" y="${(r + margin) * scale}" width="${run * scale}" height="${scale}"/>`);
      c += run;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges">`
    + `<rect width="${dim}" height="${dim}" fill="#fff"/>`
    + `<g fill="#000">${rects.join('')}</g></svg>`;
}

module.exports = {
  encode, toSvg, capacityBytes, pickVersion,
  genPoly, ecCodewords, interleave, formatBits,
  gfMul, MASKS, CAPACITY,
};
