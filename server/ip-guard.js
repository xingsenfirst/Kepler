/**
 * IP 访问守卫 —— 黑名单规则 + 国内白名单（仅放行中国大陆 IP）
 *
 *  - 规则存储：data/ipguard.json（{ rules: [...] }）
 *  - 每条规则：{ id, target(单 IP 或 CIDR), remark, methods: []（空=全部方法）,
 *               bucketIds: []（空=全局，作用于所有存储桶；否则仅作用于列出的桶，支持多个）, enabled, createdAt, hits }
 *               （历史字段 bucketId 单值在 load() 时自动迁移为 bucketIds）
 *  - 作用范围与优先级：黑名单叠加语义——回环放行后，先判定「桶级规则」（仅当请求目标为该桶时参与），
 *    再判定「全局规则」，最后判定「按桶屏蔽海外 IP」；任一级别命中即屏蔽，全部未命中才放行。
 *  - 中间件：回环地址（127.0.0.1 / ::1）永远放行，保证本机管理界面不会被锁死
 *  - 按桶屏蔽海外 IP：存储桶的 blockOverseasIP = true 时，访问该桶的请求仅放行国内 IP
 *    （server/china-ips.txt 白名单）与内网/回环地址，其余全部屏蔽。
 *    该开关随存储桶保存（见 config-store.js），因此可针对单个桶独立启用，互不影响。
 *    历史版本曾使用全局 chinaMode，load() 时会一次性迁移到当时的全部存储桶并移除该字段。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const configStore = require('./config-store');
const shareStore = require('./share-store');
const secureStore = require('./secure-store');

// COS_DATA_DIR：与 stats-store / payment-orders / enc-store / share-store 一致的测试隔离
// 开关 —— 未设置时落到项目 data/，测试进程可指向临时目录（否则用例会写真实 ipguard.json）。
const DATA_DIR = process.env.COS_DATA_DIR ? path.resolve(process.env.COS_DATA_DIR) : path.join(__dirname, '..', 'data');
const GUARD_FILE = path.join(DATA_DIR, 'ipguard.json');
const CHINA_LIST_FILE = path.join(__dirname, 'china-ips.txt');

const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'HEAD'];

/* ------------------------- IP 解析与 CIDR 匹配（IPv4） ------------------------- */

/** 点分十进制 → 32 位整数；非法返回 null */
function ipv4ToInt(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || '').trim());
  if (!m) return null;
  let v = 0;
  for (let i = 1; i <= 4; i++) {
    const n = Number(m[i]);
    if (n > 255) return null;
    v = v * 256 + n;
  }
  return v >>> 0;
}

/**
 * IPv6 文本 → 16 字节 Buffer（支持 :: 简写与内嵌 IPv4，如 ::ffff:192.168.1.1）。非法返回 null
 */
function ipv6ToBytes(ip) {
  let s = String(ip || '').trim();
  if (!s || !s.includes(':')) return null;
  s = s.replace(/^\[/, '').replace(/\].*$/, '').replace(/%.*$/, ''); // 去方括号与 zone id
  // 内嵌 IPv4（如 ::ffff:192.168.1.5）先折算为两个十六进制组，保证 8 组结构正确
  const v4In = /(?:^|:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  if (v4In) {
    const v = ipv4ToInt(v4In[1]);
    if (v === null) return null;
    s = s.slice(0, v4In.index) + ':' + (((v >>> 16) & 0xffff).toString(16)) + ':' + ((v & 0xffff).toString(16));
  }
  const d = s.indexOf('::');
  let groups;
  if (d >= 0) {
    const head = s.slice(0, d) ? s.slice(0, d).split(':') : [];
    const tail = s.slice(d + 2) ? s.slice(d + 2).split(':') : [];
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = head.concat(new Array(fill).fill('0'), tail);
  } else {
    groups = s.split(':');
  }
  if (groups.length !== 8) return null;
  const out = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) {
    const g = groups[i];
    if (g.indexOf('.') >= 0) { // 内嵌 IPv4（仅允许位于最后 32 位）
      if (i !== 7) return null;
      const v = ipv4ToInt(g);
      if (v === null) return null;
      out.writeUInt32BE(v >>> 0, 12);
      continue;
    }
    const v = parseInt(g, 16);
    if (!Number.isFinite(v) || v < 0 || v > 0xffff) return null;
    out[i * 2] = (v >> 8) & 0xff;
    out[i * 2 + 1] = v & 0xff;
  }
  return out;
}

/** 规范化目标：IPv4（1.2.3.4 / 10.0.0.0/8）或 IPv6（2001:db8::1 / 2001:db8::/32）。非法返回 null */
function parseTarget(target) {
  const s = String(target || '').trim();
  if (!s) return null;
  const slash = s.indexOf('/');
  const ipPart = (slash === -1 ? s : s.slice(0, slash)).trim();
  const prefixPart = slash === -1 ? null : s.slice(slash + 1).trim();
  if (ipPart.includes(':')) {
    const bytes = ipv6ToBytes(ipPart);
    if (!bytes) return null;
    const prefix = prefixPart === null ? 128 : Number(prefixPart);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) return null;
    return { v6: true, bytes, prefix, text: prefixPart === null ? ipPart : `${ipPart}/${prefix}` };
  }
  const ip = ipv4ToInt(ipPart);
  if (ip === null) return null;
  const prefix = prefixPart === null ? 32 : Number(prefixPart);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  return { v6: false, ip, prefix, text: prefixPart === null ? ipPart : `${ipPart}/${prefix}` };
}

/** 判断 ipInt 是否落在 { ip, prefix } 网段内（IPv4） */
function cidrContains(ipInt, cidr) {
  if (cidr.prefix === 0) return true;
  const mask = (0xFFFFFFFF << (32 - cidr.prefix)) >>> 0;
  return ((ipInt & mask) >>> 0) === ((cidr.ip & mask) >>> 0);
}

/** 判断 IPv6 地址（16 字节）是否落在网段内 */
function cidrContainsV6(bytes, cidr) {
  if (!bytes || !cidr || !cidr.bytes) return false;
  const fullBytes = cidr.prefix >> 3;
  const remBits = cidr.prefix & 7;
  for (let i = 0; i < fullBytes; i++) if (bytes[i] !== cidr.bytes[i]) return false;
  if (remBits) {
    const mask = (0xff << (8 - remBits)) & 0xff;
    if ((bytes[fullBytes] & mask) !== (cidr.bytes[fullBytes] & mask)) return false;
  }
  return true;
}

/** 解析客户端 IP 为统一结构：{ v6, ip } 或 { v6, bytes }；非法返回 null */
function parseIpInfo(ip) {
  const s = String(ip || '').trim();
  if (s.includes(':')) {
    const bytes = ipv6ToBytes(s);
    return bytes ? { v6: true, bytes } : null;
  }
  const v = ipv4ToInt(s);
  return v === null ? null : { v6: false, ip: v };
}

/** 统一 CIDR 匹配：IP 版本与目标网段版本必须一致（v4 规则不会命中 v6 地址，反之亦然） */
function cidrMatch(ipInfo, cidr) {
  if (!ipInfo || !cidr) return false;
  if (!!ipInfo.v6 !== !!cidr.v6) return false;
  return ipInfo.v6 ? cidrContainsV6(ipInfo.bytes, cidr) : cidrContains(ipInfo.ip, cidr);
}

/* ------------------------- 国内 IP 白名单 ------------------------- */

let chinaRanges = null; // [{ ip, prefix }] —— 原始 CIDR（供其它逻辑复用）
let chinaIntervals = null; // [{ start, end }] —— 归一化后的不相交区间（isChinaIP 使用）
let chinaLoaded = false;

function loadChinaList() {
  if (chinaLoaded) return chinaRanges;
  chinaLoaded = true;
  chinaRanges = [];
  try {
    const text = fs.readFileSync(CHINA_LIST_FILE, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      const c = parseTarget(s);
      if (c) chinaRanges.push(c);
    }
    // P5：按起始 IP 升序排列，便于二分查找（替代 6000+ 段线性扫描）
    chinaRanges.sort((a, b) => a.ip - b.ip);
    // FUN-08：把 CIDR 折叠为**互不相交**的闭区间数组。
    // 见 chinaIntervals 的说明 —— 折叠后二分定位到的区间是唯一候选，无需回溯窗口。
    chinaIntervals = buildIntervals(chinaRanges);
  } catch (e) {
    console.warn('[ip-guard] 国内 IP 白名单加载失败：', e.message);
    chinaRanges = [];
    chinaIntervals = [];
  }
  return chinaRanges;
}

/**
 * 把 CIDR 列表归一化为升序、互不相交的闭区间数组（FUN-08）
 *
 * ## 为什么必须归一化
 *
 * 二分查找只能定位「最后一个 start ≤ 目标」的段。若白名单里存在**重叠或被完全包含**
 * 的网段（例如既收录了 1.0.0.0/8 又收录了 1.2.0.0/16，或若干同起点的条目），
 * 真正命中的那条可能排在更靠前的位置 —— 那时无论回溯窗口取多大都可能漏判。
 * 旧实现固定回溯 8 条，正是用一个 magic number 掩盖了这个结构性问题。
 *
 * 归一化为「不相交且按 start 升序」之后：命中与否由**唯一**的那个候选区间决定，
 * 判定退化为一次 O(log n) 二分 + 一次比较，既正确又无需任何魔法数字。
 *
 * @param {Array<{ip:number, prefix:number}>} cidrs
 * @returns {Array<{start:number, end:number}>}
 */
function buildIntervals(cidrs) {
  const raw = [];
  for (const c of cidrs) {
    if (c.v6) continue; // 白名单当前仅处理 IPv4
    const mask = c.prefix === 0 ? 0 : ((0xFFFFFFFF << (32 - c.prefix)) >>> 0);
    const start = (c.ip & mask) >>> 0;
    const span = (~mask >>> 0);
    const end = Math.min(0xFFFFFFFF, start + span);
    raw.push({ start, end });
  }
  raw.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const it of raw) {
    const last = merged[merged.length - 1];
    // 「end + 1」表示相邻区间也可合并：1.0.0.0-1.255.255.255 与 2.0.0.0-… 本就连续
    if (last && it.start <= last.end + 1) {
      if (it.end > last.end) last.end = it.end;
    } else {
      merged.push({ start: it.start, end: it.end });
    }
  }
  return merged;
}

/**
 * 是否国内 IP（白名单为 IPv4 列表，IPv6 一律返回 false → chinaMode 下按海外处理）
 * 说明：如需放行 IPv6，请在规则中显式添加放行规则或关闭国内白名单模式。
 */
function isChinaIP(ip) {
  if (String(ip || '').includes(':')) return false;
  const v = ipv4ToInt(ip);
  if (v === null) return false;
  loadChinaList();
  const segs = chinaIntervals || [];
  if (!segs.length) return false;
  // FUN-08：区间已归一化为「不相交 + 升序」，二分定位到的候选是唯一的：
  // 只要目标 ≤ 该区间的 end 就必然命中，否则必然不命中 —— 无需任何回溯窗口。
  let lo = 0;
  let hi = segs.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segs[mid].start <= v) { idx = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  if (idx < 0) return false;
  return v <= segs[idx].end;
}

/** 内网 / 回环 / 链路本地等保留地址（chinaMode 下同样放行，避免把局域网设备挡掉） */
function isPrivateIP(ip) {
  const s = String(ip || '');
  if (s.includes(':')) return isPrivateIPv6(s);
  const v = ipv4ToInt(ip);
  if (v === null) return true; // 解析不了的地址不按公网处理
  const a = (v >>> 24) & 0xff, b = (v >>> 16) & 0xff;
  if (a === 10 || a === 127) return true;                    // 10/8, 127/8
  if (a === 172 && b >= 16 && b <= 31) return true;          // 172.16/12
  if (a === 192 && b === 168) return true;                   // 192.168/16
  if (a === 169 && b === 254) return true;                   // 链路本地
  if (a === 0 || a >= 224) return true;                      // 0/8 与组播/保留段
  return false;
}

/** IPv6 私有/保留地址判定（S10）：回环、ULA、链路本地、组播与未指定地址视为内网 */
function isPrivateIPv6(ip) {
  const b = ipv6ToBytes(ip);
  if (!b) return true; // 解析失败按非公网处理，避免误伤
  if (b.every((x) => x === 0)) return true;                 // :: 未指定
  const loopback = ipv6ToBytes('::1');
  if (loopback && b.equals(loopback)) return true;           // ::1 回环
  if ((b[0] & 0xfe) === 0xfc) return true;                   // fc00::/7 唯一本地地址
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true;  // fe80::/10 链路本地
  if (b[0] === 0xff) return true;                            // 组播
  // IPv4-mapped（::ffff:a.b.c.d）→ 按内嵌 IPv4 规则判定
  let mapped = true;
  for (let i = 0; i < 10; i++) if (b[i] !== 0) { mapped = false; break; }
  if (mapped && b[10] === 0xff && b[11] === 0xff) {
    return isPrivateIP(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`);
  }
  return false;
}

/* ------------------------- 规则存储 ------------------------- */

let guard = null; // { rules: [], updatedAt }

function load() {
  if (guard) return guard;
  // S4：加密存储（兼容历史明文文件）
  // SEC-09：readJson 现在区分「文件不存在」与「存在但损坏」——后者抛错。
  // 这里捕获后降级为空规则集继续运行（不阻断服务），但 secure-store 已锁定该文件写入，
  // 因此磁盘上那份损坏文件不会被空规则集覆盖。
  let j = null;
  try {
    j = secureStore.readJson(GUARD_FILE, null);
  } catch (e) {
    console.error('[ip-guard] IP 屏蔽规则文件损坏，已降级为空规则并锁定写入：', e.message);
  }
  if (j && typeof j === 'object') {
    guard = {
      rules: Array.isArray(j.rules) ? j.rules : [],
      updatedAt: j.updatedAt || '',
    };
  } else {
    guard = { rules: [], updatedAt: '' };
  }
  // 迁移历史单桶字段 bucketId → bucketIds 数组（幂等）
  for (const r of guard.rules) {
    if (!Array.isArray(r.bucketIds)) {
      const legacy = String(r.bucketId || '').trim();
      r.bucketIds = legacy ? [legacy] : [];
    }
    r.bucketIds = r.bucketIds.map((x) => String(x || '').trim()).filter(Boolean);
    delete r.bucketId;
  }
  // 预解析每条规则的 target → _parsed，避免每次 evaluate 都重复 parseTarget（性能 #1）
  for (const r of guard.rules) {
    if (!r._parsed || r._parsed.text !== String(r.target || '').trim()) {
      r._parsed = parseTarget(r.target);
    }
  }
  // 迁移历史全局 chinaMode → 按桶 blockOverseasIP（幂等；仅执行一次）
  // 语义等价：原先全局生效，迁移后等价于「当时存在的每个桶都开启」
  if (j && typeof j === 'object' && j.chinaMode !== undefined) {
    if (j.chinaMode) {
      try {
        const cfg = configStore.load();
        if (cfg && Array.isArray(cfg.buckets)) {
          for (const b of cfg.buckets) configStore.updateBucket(b.id, { blockOverseasIP: true });
        }
      } catch (e) { /* 迁移失败不影响守卫可用性 */ }
    }
    delete guard.chinaMode;
    persist();
  }
  return guard;
}

function persist() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  guard.updatedAt = new Date().toISOString();
  secureStore.writeJson(GUARD_FILE, guard);
}

/**
 * 规则 ID（SEC-14）
 *
 * 旧实现用 `Date.now() + Math.random()` —— 非密码学安全随机源，且与项目
 * 「统一 `crypto.randomBytes()` 作为实体 ID」的约定不一致。改用 CSPRNG 后
 * 与其它实体（用户 / 密钥 / 桶 / 分享链接）实现统一。
 */
function newId() {
  return crypto.randomBytes(16).toString('hex');
}

function listRules() { return load().rules.map((r) => ({ ...r })); }

/**
 * 校验并规范化作用范围（多桶）：返回去重后的桶 id 数组；空数组 = 全局。
 * 兼容传入单值（字符串）：视为单元素数组。
 */
function normalizeBucketIds(bucketIds) {
  const arr = Array.isArray(bucketIds)
    ? bucketIds.map((x) => String(x || '').trim()).filter(Boolean)
    : (bucketIds && String(bucketIds).trim() ? [String(bucketIds).trim()] : []);
  const known = new Set(configStore.listBuckets().buckets.map((b) => b.id));
  for (const id of arr) {
    if (!known.has(id)) { const e = new Error('指定的存储桶不存在（可能已被解绑）'); e.status = 400; throw e; }
  }
  return [...new Set(arr)];
}

/** 作用范围签名（用于去重比较）：'' = 全局；'id1,id2,…' = 桶集合 */
function scopeKey(ids) { return [...(ids || [])].sort().join(','); }

function addRule({ target, remark, methods, bucketIds }) {
  const t = parseTarget(target);
  if (!t) { const e = new Error('IP 或 CIDR 格式不正确（示例：1.2.3.4 或 10.0.0.0/8）'); e.status = 400; throw e; }
  const bids = normalizeBucketIds(bucketIds);
  const g = load();
  // 同一作用范围内不允许重复目标；不同范围（全局 vs 某桶集合）允许同名目标共存
  if (g.rules.some((r) => r.target === t.text && scopeKey(r.bucketIds) === scopeKey(bids))) {
    const e = new Error('该 IP / IP 段在此作用范围内已存在屏蔽规则'); e.status = 409; throw e;
  }
  const rule = {
    id: newId(), target: t.text, _parsed: t,
    remark: String(remark || '').slice(0, 100),
    methods: normalizeMethods(methods), bucketIds: bids, enabled: true,
    createdAt: new Date().toISOString(), hits: 0,
  };
  g.rules.push(rule);
  persist();
  return { ...rule };
}

function normalizeMethods(methods) {
  if (!Array.isArray(methods) || !methods.length) return []; // 空 = 屏蔽全部方法
  return [...new Set(methods.map((m) => String(m).toUpperCase()))]
    .filter((m) => ALLOWED_METHODS.includes(m));
}

function updateRule(id, { target, remark, methods, bucketIds }) {
  const g = load();
  const r = g.rules.find((x) => x.id === id);
  if (!r) { const e = new Error('规则不存在'); e.status = 404; throw e; }
  if (bucketIds !== undefined) r.bucketIds = normalizeBucketIds(bucketIds);
  if (target !== undefined) {
    const t = parseTarget(target);
    if (!t) { const e = new Error('IP 或 CIDR 格式不正确'); e.status = 400; throw e; }
    if (g.rules.some((x) => x.id !== id && x.target === t.text && scopeKey(x.bucketIds) === scopeKey(r.bucketIds))) {
      const e = new Error('该 IP / IP 段在此作用范围内已存在屏蔽规则'); e.status = 409; throw e;
    }
    r.target = t.text;
    r._parsed = t; // 更新预解析缓存（性能 #1）
  }
  if (remark !== undefined) r.remark = String(remark).slice(0, 100);
  if (methods !== undefined) r.methods = normalizeMethods(methods);
  persist();
  return { ...r };
}

/**
 * 桶被解绑 / 彻底删除时同步清理规则引用，返回受影响规则条数：
 *  - 仅作用于该桶的规则 → 整条删除
 *  - 作用于多桶的规则   → 从 bucketIds 中移除该桶（范围缩小）
 */
function removeRulesForBucket(bucketId) {
  const g = load();
  let affected = 0;
  const kept = [];
  for (const r of g.rules) {
    const bids = Array.isArray(r.bucketIds) ? r.bucketIds : [];
    if (!bids.includes(bucketId)) { kept.push(r); continue; }
    affected++;
    const rest = bids.filter((x) => x !== bucketId);
    if (!rest.length) continue; // 只剩该桶 → 整条删除（避免退化为全局而意外扩大范围）
    r.bucketIds = rest;
    kept.push(r);
  }
  g.rules = kept;
  if (affected) persist();
  return affected;
}

function removeRule(id) {
  const g = load();
  const i = g.rules.findIndex((x) => x.id === id);
  if (i === -1) { const e = new Error('规则不存在'); e.status = 404; throw e; }
  const [removed] = g.rules.splice(i, 1);
  persist();
  return removed;
}

function setRuleEnabled(id, enabled) {
  const g = load();
  const r = g.rules.find((x) => x.id === id);
  if (!r) { const e = new Error('规则不存在'); e.status = 404; throw e; }
  r.enabled = !!enabled;
  persist();
  return { ...r };
}

/**
 * 设置指定存储桶是否屏蔽海外 IP（写入存储桶配置，非本模块文件）。
 * @returns {{ ok: boolean, bucketId: string, blockOverseasIP: boolean, chinaRangeCount: number }}
 */
function setBucketOverseas(bucketId, enabled) {
  const cfg = configStore.load();
  if (!cfg || !(cfg.buckets || []).some((b) => b.id === bucketId)) {
    const e = new Error('存储桶不存在'); e.status = 404; throw e;
  }
  configStore.updateBucket(bucketId, { blockOverseasIP: !!enabled });
  return { ok: true, bucketId, blockOverseasIP: !!enabled, chinaRangeCount: loadChinaList().length };
}

/**
 * 解析某桶是否开启海外屏蔽（带缓存：同一桶 5 秒内不重复读配置，避免高频请求反复解密配置）
 */
const overseasCache = new Map(); // bucketId -> { v, at }
const OVERSEAS_CACHE_TTL_MS = 5000;
/** FUN-12：桶 id 数量本就有界，但这里仍设上限 —— 无界 Map 是这个项目反复出现的形态 */
const OVERSEAS_CACHE_MAX = 500;
function bucketBlocksOverseas(bucketId) {
  if (!bucketId) return false;
  const hit = overseasCache.get(bucketId);
  const now = Date.now();
  if (hit && now - hit.at < OVERSEAS_CACHE_TTL_MS) return hit.v;
  let v = false;
  try { v = configStore.bucketBlockOverseas(configStore.load(), bucketId); } catch (e) { v = false; }
  // FUN-12：写入时顺带清掉过期项（旧实现只判 TTL 从不删除，条目只增不减）
  for (const [k, e] of overseasCache) {
    if (now - e.at > OVERSEAS_CACHE_TTL_MS) overseasCache.delete(k);
  }
  while (overseasCache.size >= OVERSEAS_CACHE_MAX) {
    const oldest = overseasCache.keys().next();
    if (oldest.done) break;
    overseasCache.delete(oldest.value);
  }
  overseasCache.set(bucketId, { v, at: now });
  return v;
}

/** 清除海外屏蔽判定缓存（桶开关变更后立即生效） */
function invalidateOverseasCache(bucketId) {
  if (bucketId) overseasCache.delete(bucketId);
  else overseasCache.clear();
}

/* ------------------------- 判定与中间件 ------------------------- */

/** 从请求中提取客户端 IPv4（处理 IPv4-mapped IPv6） */
function clientIp(req) {
  let ip = (req.socket && req.socket.remoteAddress) || '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1') ip = '127.0.0.1';
  return ip;
}

/**
 * 解析本次请求所属会话的「当前桶」与角色（FUN-07）
 *
 * ip-guard 必须挂在鉴权中间件**之前**（不然被屏蔽的请求会先走一遍业务逻辑），
 * 因此执行到这里时 AsyncLocalStorage 里还没有会话上下文，只能自己解析一次 token。
 *
 * 这一步的存在意义：桶级 IP 规则要作用在**请求的真实目标桶**上。若这里读
 * 全局 `cfg.activeBucketId`，那么普通用户切桶后 —— 界面打的是自己的桶、操作层
 * 打的是自己的桶，唯独 IP 守卫按全局默认桶判定 —— 于是「对 A 桶生效的封禁」
 * 在用户切到 B 桶时失效，反之 A 桶用户的合法请求可能撞上 B 桶的封禁。
 * 与 FUN-15 同源：目标桶只能是会话级解析结果。
 *
 * @returns {{bucketId: string, role: string}} 无会话/无上下文时返回空桶 id 与 'admin'
 */
function sessionBucketOf(req) {
  let authSession;
  try {
    authSession = require('./auth-session');
  } catch (e) {
    return { bucketId: '', role: 'admin' };
  }
  let ctx = null;
  try { ctx = require('./request-context'); } catch (e) { /* 上下文不可用时按无会话处理 */ }
  const direct = ctx ? ctx.activeBucketId() : '';
  if (direct) return { bucketId: direct, role: (ctx.role() || 'admin') };
  const token = (ctx && ctx.token()) || authSession.parseToken(req);
  if (!token) return { bucketId: '', role: 'admin' };
  const s = authSession.getSession(token);
  if (!s) return { bucketId: '', role: 'admin' };
  // 与鉴权中间件一致：角色取**实时用户记录**，不用会话里的快照
  let role = (s.user && s.user.role) || 'user';
  try {
    const live = configStore.findUserRawById(s.user && s.user.id);
    if (live && live.role) role = live.role;
    else if (live === null || live === undefined) role = (s.user && s.user.role) || 'user';
  } catch (e) { /* 配置不可读时退回会话快照 */ }
  return { bucketId: s.activeBucketId || '', role };
}

/**
 * 解析本次请求的目标存储桶（本地绑定 id）
 *  - /api/buckets/local/:id/...  → URL 中的桶 id
 *  - /s/:id（分享页/下载）       → 分享链接快照桶名 → 本地绑定 id
 *  - /api/fs/... 、/api/stats/... → 本次会话生效的桶（与操作层同源，见 sessionBucketOf）
 *  - /dav/...（WebDAV）          → 全局激活桶（WebDAV 无会话，操作的就是它，见下）
 *  - 其余（配置管理、IP 规则管理、静态页面等）→ null（仅全局规则参与判定）
 */
function resolveBucketId(req) {
  const p = (req && req.path) || '';
  let m = /^\/api\/buckets\/local\/([^/?]+)/.exec(p);
  if (m) return decodeURIComponent(m[1]);
  m = /^\/s\/([A-Za-z0-9_-]+)/.exec(p);
  if (m) {
    try {
      const link = shareStore.get(m[1]);
      if (link && link.bucket) {
        const cfg = configStore.load();
        const b = cfg && cfg.buckets.find((x) => x.bucket === link.bucket);
        return b ? b.id : null;
      }
    } catch (e) { /* ignore */ }
    return null;
  }
  // R7-04：WebDAV 跑在**独立端口**上（`webdav-server.js`，挂载点 `/dav`），请求路径形如
  // `/dav/dir/file.txt`。此前这里不认 `/dav/*` → 一律返回 null → 桶级 IP 规则与
  // 「一键屏蔽海外 IP」对 WebDAV 客户端形同虚设（SEC-07 只补上了「全局」这一半）。
  //
  // WebDAV 没有会话上下文，它的读写走 fs-gateway → configStore.get()，操作对象就是
  // **全局激活桶** —— 因此这里也必须取全局激活桶，才能与操作层同源。
  if (p === '/dav' || p.indexOf('/dav/') === 0) {
    try {
      const cfg = configStore.load();
      if (!cfg || !cfg.buckets || !cfg.buckets.length) return null;
      const b = cfg.buckets.find((x) => x.id === cfg.activeBucketId) || cfg.buckets[0];
      return b ? b.id : null;
    } catch (e) { return null; }
  }
  if (/^\/api\/(fs|stats)\//.test(p)) {
    const cfg = configStore.load();
    if (!cfg || !cfg.buckets.length) return null;
    // FUN-07：与「当前桶」的其它读端同源 —— 走 listBucketsFor（可见性 + 会话优先），
    // 而不是直接读全局 cfg.activeBucketId。
    const { bucketId, role } = sessionBucketOf(req);
    try {
      const { activeBucketId } = configStore.listBucketsFor(role === 'admin' ? 'admin' : 'user', bucketId);
      return activeBucketId || null;
    } catch (e) {
      const b = cfg.buckets.find((x) => x.id === cfg.activeBucketId) || cfg.buckets[0];
      return b.id;
    }
  }
  return null;
}

/** 在指定规则集合中查找命中项（命中方法才拦截；方法为空 = 全部方法） */
function matchRules(rules, ipInfo, method) {
  if (!ipInfo) return null;
  for (const r of rules) {
    if (!r.enabled) continue;
    // 用预解析缓存（load 或 addRule/updateRule 时计算），未缓存则惰性解析
    const t = r._parsed || parseTarget(r.target);
    if (!t || !cidrMatch(ipInfo, t)) continue;
    if (r.methods.length && !r.methods.includes(method)) continue; // 不涉及本次请求方法 → 放行
    return r;
  }
  return null;
}

/**
 * 判定一次请求是否放行
 * @param {string} ip 客户端 IPv4
 * @param {string} method HTTP 方法
 * @param {string|null} bucketId 请求的目标存储桶（本地绑定 id）；null/'' 表示无桶上下文
 * @returns {ok: boolean, reason?: 'rule'|'overseas', rule?: object, ip: string, bucketId: string|null}
 *
 * 优先级与生效逻辑（黑名单叠加）：
 *   回环放行 → 桶级规则（仅作用于目标桶的请求）→ 全局规则（作用于所有请求）→ 按桶屏蔽海外 IP。
 *   任一级别命中即屏蔽；桶级规则与全局规则同时存在时互不覆盖、各自独立生效。
 *
 * 海外屏蔽为「按桶生效」：仅当请求能解析出目标桶（bucketId 非空）且该桶开启了
 * blockOverseasIP 时才参与判定。无法解析目标桶的请求（配置管理、IP 规则管理、静态页面、
 * 全局分享页等）不受任何海外屏蔽影响 —— 避免误伤管理界面导致自己被锁在门外。
 */
function evaluate(ip, method, bucketId) {
  const m = String(method || 'GET').toUpperCase();
  const g = load();

  if (ip === '127.0.0.1' || ip === '::1') return { ok: true, ip, bucketId: bucketId || null }; // 本机永远放行

  const info = parseIpInfo(ip); // IPv4 / IPv6 统一结构（S10）
  if (info) {
    // 1) 桶级规则（更具体，优先判定）
    if (bucketId) {
      const hit = matchRules(g.rules.filter((r) => (r.bucketIds || []).includes(bucketId)), info, m);
      if (hit) return { ok: false, reason: 'rule', rule: { ...hit }, ip, bucketId };
    }
    // 2) 全局规则（bucketIds 为空 = 全局）
    const hit = matchRules(g.rules.filter((r) => !(r.bucketIds || []).length), info, m);
    if (hit) return { ok: false, reason: 'rule', rule: { ...hit }, ip, bucketId: bucketId || null };
  }

  // 3) 按桶屏蔽海外 IP：仅放行国内 IP 与内网/回环地址（仅对该桶生效）
  if (bucketId && bucketBlocksOverseas(bucketId) && !isChinaIP(ip) && !isPrivateIP(ip)) {
    return { ok: false, reason: 'overseas', ip, bucketId };
  }
  return { ok: true, ip, bucketId: bucketId || null };
}

let dirty = false;
function markHit(ruleId) {
  const g = load();
  const r = g.rules.find((x) => x.id === ruleId);
  if (r) { r.hits = (r.hits || 0) + 1; dirty = true; }
}
let overseasHits = 0;
function markOverseasHit() { overseasHits++; dirty = true; }

// 命中计数节流落盘（3 秒）
setInterval(() => {
  if (dirty) { dirty = false; persist(); }
}, 3000).unref();

/**
 * 判定一次请求是否放行，并记账（命中次数 / 海外命中）。
 *
 * 抽出来是为了让 **WebDAV 服务（:8443）复用同一套判定**（SEC-07）——
 * 它此前完全不受 IP 屏蔽约束，等于给屏蔽规则开了一个旁门。
 * 响应形态（JSON / HTML / 纯文本）由各调用方自行决定。
 */
function guardRequest(req) {
  const ip = clientIp(req);
  const v = evaluate(ip, req.method, resolveBucketId(req));
  if (!v.ok) {
    if (v.reason === 'rule') markHit(v.rule.id); else markOverseasHit();
  }
  return v;
}

/** HTML 转义（403 提示页要回显客户端 IP，开启 TRUST_PROXY 后它是请求方可控输入） */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** Express 中间件 */
function middleware(req, res, next) {
  const v = guardRequest(req);
  if (v.ok) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(403).json({ error: 'IP 已被屏蔽，禁止访问', blocked: true, ip: v.ip });
  }
  // HTML 提示页（分享页 / 前端页面）
  //
  // 注意：这里只能用 `v.ip`（guardRequest 的返回值），`middleware()` 作用域内
  // 并没有 `ip` 变量 —— 曾经写成 `${ip}` 导致页面类请求恒抛 ReferenceError，
  // 被 Express 错误处理器吞成 500，屏蔽功能对分享页完全失效（FUN-01 高危）。
  const tip = v.reason === 'overseas' ? '该服务仅对中国大陆 IP 开放访问' : '您的 IP 已被管理员屏蔽';
  // 开启 TRUST_PROXY 后 IP 取自 X-Forwarded-For 头，属请求方可控输入，必须转义
  const ipText = escapeHtml(String(v.ip || ''));
  res.status(403).type('html').send(
    `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>403 - 禁止访问</title></head>` +
    `<body style="font-family:'Segoe UI','Microsoft YaHei',sans-serif;background:#f6f7f9;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">` +
    `<div style="text-align:center;color:#595959"><div style="font-size:48px">🚫</div>` +
    `<h2 style="margin:12px 0 6px;color:#1b1b1b">403 禁止访问</h2>` +
    `<p>${tip}（IP: ${ipText}）</p></div></body></html>`
  );
}

function view() {
  const g = load();
  return {
    rules: g.rules.map((r) => ({ ...r })),
    chinaRangeCount: loadChinaList().length,
    overseasHits,
    updatedAt: g.updatedAt,
    ipv6: {
      supported: true,
      // 提示前端：国内白名单仅覆盖 IPv4；某桶开启海外屏蔽时公网 IPv6 访问会被视为海外
      overseasNote: '国内 IP 白名单仅包含 IPv4 段；若某存储桶开启「屏蔽海外 IP」，访问该桶的公网 IPv6 请求将被拦截。',
    },
  };
}

module.exports = {
  middleware, guardRequest, clientIp, evaluate, view, resolveBucketId,
  listRules, addRule, updateRule, removeRule, setRuleEnabled, setBucketOverseas, removeRulesForBucket,
  invalidateOverseasCache,
  isChinaIP, isPrivateIP, isPrivateIPv6, parseTarget, parseIpInfo,
  ipv4ToInt, ipv6ToBytes, cidrContains, cidrContainsV6, cidrMatch, clientIp,
  buildIntervals, normalizeRanges,     // FUN-08：可在测试中直接验证归一化性质
  ALLOWED_METHODS,
};

/**
 * 测试钩子：注入归一化后的白名单区间，使 isChinaIP 无需依赖 china-ips.txt 文件。
 * 仅用于单测/验证，生产路径从不调用。
 */
function __setChinaIntervalsForTest(segs) {
  chinaRanges = null;
  chinaIntervals = segs || [];
  chinaLoaded = true;
}
module.exports.__setChinaIntervalsForTest = __setChinaIntervalsForTest;

/** 统一称呼：`normalizeRanges` 是 `buildIntervals` 的语义别名（对外强调归一化意图） */
function normalizeRanges(cidrs) { return buildIntervals(cidrs); }
