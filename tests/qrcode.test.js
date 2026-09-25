/**
 * 二维码生成器（server/qrcode.js）—— 行为断言
 *
 * 这是**自研实现**，没有第三方库可对照，所以校验策略是「拿规范里的标准常量 + 数学性质」
 * 双重夹逼，而不是"跑一遍看不报错"：
 *   1. 生成多项式：对照 ISO/IEC 18004 的 α 幂次表（能对上说明 GF(256) 与多项式乘法都对）
 *   2. 生成多项式：额外验证 g(α^i) ≡ 0（不依赖记忆的数学自校验，覆盖表外的 n）
 *   3. 格式信息：对照 8 种掩码在纠错级别 M 下的 15 位标准串
 *   4. 端到端：编码后按规范位置回读，结构必须自洽
 */
const path = require('path');
const test = require('node:test');
const { assert, assertEqual, assertMatch, ROOT } = require('./helpers');

const qr = require(path.join(ROOT, 'server', 'qrcode.js'));

/* GF(256) 的对数表（模块内部未导出，测试里重建一份用于换算 α 幂次） */
const LOG = new Array(256);
(function () {
  let x = 1;
  for (let i = 0; i < 255; i++) { LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
})();

/* ================================================================== *
 * 1 · GF(256) 与生成多项式
 * ================================================================== */

test('GF(256) 基本性质：α^0=1、α^255=1、乘法可逆', () => {
  assertEqual(qr.gfMul(1, 1), 1, 'α^0 · α^0 = 1');
  assertEqual(qr.gfMul(0, 123), 0, '0 乘任何数为 0');
  // α^254 · α^1 = α^255 = 1
  let a254 = 1;
  for (let i = 0; i < 254; i++) a254 = qr.gfMul(a254, 2);
  assertEqual(qr.gfMul(a254, 2), 1, 'α^255 = 1（本原多项式闭合）');
});

// 生成多项式的标准 α 幂次表（ISO/IEC 18004）
// 注：只收录能可靠对照的项；其余 n 由下面的数学自校验覆盖
const GEN_STD = {
  7: [0, 87, 229, 146, 149, 238, 102, 21],
  10: [0, 251, 67, 46, 61, 118, 70, 64, 94, 32, 45],
  13: [0, 74, 152, 176, 100, 86, 100, 106, 104, 130, 218, 206, 140, 78],
  18: [0, 215, 234, 158, 94, 184, 97, 118, 170, 79, 187, 152, 148, 252, 179, 5, 98, 96, 153],
  22: [0, 210, 171, 247, 242, 93, 230, 14, 109, 221, 53, 200, 74, 8, 172, 98, 80, 219, 134, 160, 105, 165, 231],
};

test('生成多项式与标准 α 幂次表一致', () => {
  for (const n of Object.keys(GEN_STD)) {
    const g = qr.genPoly(Number(n));
    assertEqual(g.length, Number(n) + 1, `genPoly(${n}) 应有 ${Number(n) + 1} 项`);
    const actual = g.map((v) => (v === 0 ? -1 : LOG[v]));
    assertEqual(JSON.stringify(actual), JSON.stringify(GEN_STD[n]), `genPoly(${n}) 的 α 幂次序列`);
  }
});

/** α^k（k 可为 0） */
function alphaPow(k) {
  let v = 1;
  for (let j = 0; j < k; j++) v = qr.gfMul(v, 2);
  return v;
}

test('生成多项式在 α^0 … α^(n-1) 处取值恒为 0（数学自校验）', () => {
  for (let n = 1; n <= 26; n++) {
    const g = qr.genPoly(n);
    for (let i = 0; i < n; i++) {
      // Horner 法代入 x = α^i；g(x) = ∏(x - α^j) 在这些点必为 0
      let acc = 0;
      for (const coef of g) acc = qr.gfMul(acc, alphaPow(i)) ^ coef;
      assertEqual(acc, 0, `genPoly(${n}) 在 α^${i} 处应为 0`);
    }
  }
});

/* ================================================================== *
 * 2 · 格式信息
 * ================================================================== */

// 纠错级别 M（指示符 00）下 8 种掩码的 15 位格式串（bit14 → bit0）
const FORMAT_M = [
  '101010000010010', '101000100100101', '101111001111100', '101101101001011',
  '100010111111001', '100000011001110', '100111110010111', '100101010100000',
];

test('格式信息：8 种掩码均与标准 15 位串一致', () => {
  for (let mask = 0; mask < 8; mask++) {
    const s = qr.formatBits(mask).toString(2).padStart(15, '0');
    assertEqual(s, FORMAT_M[mask], `掩码 ${mask} 的格式串`);
  }
});

/* ================================================================== *
 * 3 · 版本与容量
 * ================================================================== */

test('容量表自洽：数据码字 + 纠错码字 = 总码字', () => {
  for (let v = 1; v <= 10; v++) {
    const c = qr.CAPACITY[v];
    const data = c.blocks.reduce((s, n) => s + n, 0);
    assertEqual(data + c.ec * c.blocks.length, c.total, `版本 ${v} 的总码字数`);
  }
});

test('版本选择：按字节数挑最小可用版本，超出范围返回 0', () => {
  assertEqual(qr.pickVersion(2), 1, '2 字节 → 版本 1');
  assertEqual(qr.pickVersion(500), 0, '500 字节超出版本 10 的容量 → 0');
  // 单调递增：容量需求越大，选出的版本不应更小
  let prev = 0;
  for (let n = 1; n <= 200; n++) {
    const v = qr.pickVersion(n);
    assert(v >= prev, `字节数 ${n} 时版本不应回退（${v} < ${prev}）`);
    prev = v;
  }
});

/* ================================================================== *
 * 4 · 端到端结构
 * ================================================================== */

test('编码结果满足 QR 的结构约束', () => {
  const q = qr.encode('weixin://wxpay/bizpayurl?pr=abcdefg');
  assert(q, '编码应成功');
  assertEqual(q.size, q.version * 4 + 17, '尺寸 = 4×版本 + 17');

  const row = (r) => q.modules[r].join('');
  assertEqual(row(0).slice(0, 7), '1111111', '左上定位图案外框');
  assertEqual(row(0).slice(-7), '1111111', '右上定位图案外框');
  assertEqual(row(q.size - 7).slice(0, 7), '1111111', '左下定位图案外框');
  assertEqual(q.modules[3][3], 1, '定位图案中心为深色');
  assertEqual(row(0)[7], '0', '定位图案右侧分隔符为白');
  assertEqual(q.modules[q.size - 8][8], 1, '固定深色模块');

  // 定时图案：第 6 行 / 第 6 列黑白交替
  for (let i = 8; i < q.size - 8; i++) {
    assertEqual(q.modules[6][i], i % 2 === 0 ? 1 : 0, `第 6 行第 ${i} 列的定时图案`);
  }
});

test('回读格式信息：应命中纠错级别 M 下的某一掩码（位序 bit14→bit0）', () => {
  const q = qr.encode('weixin://wxpay/bizpayurl?pr=abcdefg');
  const read = [];
  for (let i = 0; i <= 5; i++) read.push(q.modules[8][i]);
  read.push(q.modules[8][7], q.modules[8][8], q.modules[7][8]);
  for (let i = 9; i <= 14; i++) read.push(q.modules[14 - i][8]);
  const s = read.slice().reverse().join(''); // get(i) 是 bit i，标准串按 bit14→bit0 书写
  assert(FORMAT_M.includes(s), `回读的格式串 ${s} 应命中 M 级别掩码之一`);
});

test('SVG 输出：尺寸与内容正确', () => {
  const svg = qr.toSvg('https://example.com/pay/abc', { scale: 4, margin: 3 });
  assertMatch(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, '应以 svg 根标签开头');
  assert(svg.includes('<rect'), '应包含矩形');
  assert(svg.includes('fill="#fff"'), '应有白色底');
  assert(!/undefined|NaN/.test(svg), 'SVG 中不应出现 undefined / NaN');
});

test('超出容量时返回 null 与空 SVG（不抛异常）', () => {
  const long = 'x'.repeat(500);
  assertEqual(qr.encode(long), null, '超长内容应返回 null');
  assertEqual(qr.toSvg(long), '', '超长内容的 SVG 应为空串');
});
