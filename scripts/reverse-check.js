/**
 * 反向对照（mutation check）通用脚本
 *
 * 项目约定：每加一条回归护栏，都要**退回旧实现确认它必须 FAIL** —— 否则护栏可能只是
 * 「看起来覆盖了」，实际上根本没打在那条路径上（历史上出现过多次：护栏覆盖了它
 * 承诺之外的地方）。
 *
 * 用法：
 *   node scripts/reverse-check.js <目标文件(相对项目根)> <锚点文件> <替换文件> <测试文件> <期望最小失败数>
 *
 * 更简单的用法：直接改下面的 CASES 后 `node scripts/reverse-check.js`（见文件末尾）。
 *
 * 崩溃安全：先断言锚点命中 → 备份 → 变异 → 跑测试 → **无论如何都还原**
 * （exit / SIGINT / SIGTERM / uncaughtException 均强制还原）。
 */
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

/**
 * 跑一个测试文件并返回它的输出。
 *
 * 首选 `spawnSync`（同步、最简单）；但某些 Windows 环境下 `spawnSync` 恒返回
 * `status=null / error=EBUSY`（本项目 RE-03 / R7-07 两条用例也栽在同一处环境问题上），
 * 此时**静默退回异步 `spawn`** —— 否则 `fail` 计数取不到，每条反向对照都会被误判成失败。
 *
 * 变异期间额外注入 `REVERSE_CHECK_MUTATING=1`：此时工作区里的 anchor 是被**故意**
 * 删掉的，`invariants.test.js` 里「反向变异 anchor 必须在各自的 file 内命中」那条
 * 自检会**必然**变红 —— 它是针对提交态锚点腐烂设计的，变异态下必须豁免。否则
 * 每条反向对照都会凭空 +1 个红项，掩盖「真实不变量到底抓没抓到」这一唯一要看的信息。
 */
function runTestFile(testFile) {
  const args = ['--test', path.join('tests', testFile)];
  const env = { ...process.env, REVERSE_CHECK_MUTATING: '1' };
  return new Promise((resolve) => {
    const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', env });
    if (r.status !== null && !r.error) return resolve((r.stdout || '') + (r.stderr || ''));
    const p = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('error', () => resolve(out));
    p.on('close', () => resolve(out));
  });
}

async function runCase({ name, file, anchor, replacement, mutations, testFile, minFail }) {
  const target = path.join(ROOT, file);
  const backup = target + '.reversebak';
  let restored = false;

  /**
   * 还原 = 「写回源码」+「删掉备份」两件事，**必须分开报错**。
   *
   * 早期实现把两步放进同一个 try：删备份失败（例如被环境的批量删除护栏拦下）
   * 也会打印「还原失败！请手动用 X.reversebak 覆盖 X」—— 而实际上源码**已经**写回，
   * 这句提示会让人白跑一趟去排查并不存在的「工作区被留在变异态」。
   * 真正的灾难只有一种：`copyFileSync` 失败（源码仍是变异后的内容）。
   */
  const restore = () => {
    if (restored) return;
    restored = true;
    try {
      if (fs.existsSync(backup)) {
        fs.copyFileSync(backup, target);
        console.log('  [restore] 已还原 ' + file);
        try {
          fs.unlinkSync(backup);
        } catch (e) {
          console.warn('  [restore] 备份未能删除（源码已还原，可手动删）：' + backup
            + '（' + e.message + '）');
        }
      }
    } catch (e) {
      console.error('  [restore] 还原失败！工作区可能仍是变异态，请手动用 '
        + backup + ' 覆盖 ' + target + '：', e.message);
    }
    detach();
  };
  /**
   * 四个兜底还原钩子。**每条用例用完必须摘掉** —— 早期版本只 add 不 remove，
   * 跑满 10 条后 `process` 上堆了 40 个监听器，Node 直接抛
   * `MaxListenersExceededWarning`（真正崩溃时反而可能错过还原）。
   */
  const handlers = {
    exit: restore,
    SIGINT: () => { restore(); process.exit(130); },
    SIGTERM: () => { restore(); process.exit(143); },
    uncaughtException: (e) => { console.error(e); restore(); process.exit(1); },
  };
  const detach = () => {
    for (const k of Object.keys(handlers)) process.removeListener(k, handlers[k]);
  };
  process.on('exit', handlers.exit);
  process.on('SIGINT', handlers.SIGINT);
  process.on('SIGTERM', handlers.SIGTERM);
  process.on('uncaughtException', handlers.uncaughtException);

  console.log('\n=== ' + name + ' ===');
  const original = fs.readFileSync(target, 'utf8');
  // 支持一次用例做多步变异（如「把整段代码挪到别处」= 删除 + 插入）
  const steps = Array.isArray(mutations) ? mutations : [{ anchor, replacement }];
  for (const st of steps) {
    if (original.indexOf(st.anchor) < 0) {
      console.error('  ❌ 锚点未命中，未做任何修改：\n     ' + JSON.stringify(st.anchor.slice(0, 120)));
      return false;
    }
  }
  let patched = original;
  for (const st of steps) patched = patched.replace(st.anchor, st.replacement);
  fs.writeFileSync(backup, original);
  fs.writeFileSync(target, patched);
  console.log('  [mutate] 已退回旧实现，跑 ' + testFile + ' …');

  const out = await runTestFile(testFile);
  /**
   * 失败数解析必须同时认两种 reporter 格式：
   *  - TAP（Node 18/20 在**非 TTY**（管道）下的默认）：`# fail 3`
   *  - spec（Node ≥ 22 起成为默认）：`ℹ fail 3`
   * 只认前者时，在 Node 22+ 上每条对照都会解析成 `fail=-1` 而被判失败 ——
   * 实测本机 Node 24 下 `--only=R14-08`（既有条目）同样报 -1，**与变异的正确性无关**。
   * 护栏静默失效比护栏缺失更危险，故此处显式兼容。
   */
  const m = /^(?:#|ℹ)\s*fail\s+(\d+)/m.exec(out);
  const failCount = m ? Number(m[1]) : -1;
  restore();

  if (failCount < minFail) {
    console.error('  ❌ 反向对照失败：退回旧实现后 fail=' + failCount + '（期望 ≥ ' + minFail + '）');
    console.error(out.split('\n').filter((l) => /^(not ok|ok) /.test(l)).join('\n'));
    return false;
  }
  console.log('  ✅ fail=' + failCount + '（期望 ≥ ' + minFail + '）');
  console.log(out.split('\n').filter((l) => /^(not ok) /.test(l)).map((l) => '     ' + l).join('\n'));
  return true;
}

/**
 * R7-07 用：index.js 里 prune 的**调用点**（R11-12 之后它是 `pruneSessions();`），
 * 用于「挪到单实例锁之前」的变异。
 *
 * 注意：这里不再搬整段函数定义（R11-12 把函数抽成 `pruneSessions` 并加了定时器），
 * 只搬**调用点** —— 变异要复现的正是「启动即执行的那一次跑在锁之前」。
 */
const PRUNE_CALL = 'pruneSessions();\n';

/**
 * 全部反向对照用例。**导出**是为了让 `tests/invariants.test.js` 能在测试里
 * 校验「每条 anchor 在自己的 file 内命中」（R11-18：3 条 anchor 悄悄失效了却没人
 * 发现 —— 脚本只会在跑到那一条时才报「锚点未命中」，而没人跑就等于没登记）。
 */
const CASES = [
    {
      name: 'R7-01 · 分片会话不再记录 provider（退回「默认 tencent」）',
      file: 'server/routes/fs.js',
      anchor: '        provider: cfg.provider, // R7-01',
      replacement: '',
      testFile: 'audit7-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R7-02 · encryptBuffer 内部恢复 setMeta（元数据回到「先于云端写入」）',
      file: 'server/enc-store.js',
      anchor: '    // R7-02：不在此落盘元数据 —— 由调用方在云端写入成功后写入（见函数头部说明）\n    return { data, meta };',
      replacement: '    setMeta(bucket, key, meta);\n    return { data, meta };',
      testFile: 'audit7-regressions.test.js',
      minFail: 2,
    },
    {
      name: 'R7-03 · WebDAV 删对象不再标记分享链接',
      file: 'server/fs-gateway.js',
      anchor: '  // R7-03：云端确认删除后才标（与「元数据只按已确认删除的 key 清」同一约束）\n  shareStore.markMissingByKeys(cfg.bucket, [k]);',
      replacement: '',
      testFile: 'audit7-regressions.test.js',
      minFail: 1,
    },
    {
      // R11-18：原 anchor 是「同批确认删除的 key 一并标记…」+ `markMissingByKeys(cfg.bucket, keys)`，
      // R10-03 把该行改成按白名单 `res.okKeys` 标记后，锚点再也不存在 —— 这条等于没登记。
      // 重新指向当前代码（缩进也变了）：仍守同一条纪律（删目录必须标记分享链接）。
      // R23-03：循环收敛到 `deletePrefixAll` 后，标记动作移进网关的 `onDeleted` 回调，
      // 参数名由 `res.okKeys` 变为 `keys`（同一判据），锚点随之更新。
      name: 'R7-03 · WebDAV 删目录不再标记分享链接',
      file: 'server/fs-gateway.js',
      anchor: '    // R7-03：只认**本批确认删除**的 key，绝不按前缀\n    shareStore.markMissingByKeys(cfg.bucket, keys);',
      replacement: '',
      testFile: 'audit7-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R7-03 · 清空桶不再标记分享链接',
      file: 'server/routes/buckets.js',
      anchor: '      shareStore.markMissingByKeys(cfg.bucket, deletedKeys);',
      replacement: '',
      testFile: 'audit7-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R7-04 · resolveBucketId 不再认 /dav/*（WebDAV 退回「无桶上下文」）',
      file: 'server/ip-guard.js',
      anchor: "  if (p === '/dav' || p.indexOf('/dav/') === 0) {",
      replacement: '  if (false) {',
      testFile: 'audit7-regressions.test.js',
      minFail: 2,
    },
    {
      name: 'R7-06 · fs-gateway 的 putObject 退回「直接回调式调用」（绕过 p()）',
      file: 'server/fs-gateway.js',
      anchor: "  await p(cos, 'putObject', {\n"
        + "    Bucket: cfg.bucket, Region: cfg.region, Key: k,\n"
        + "    Body: body,\n"
        + "    ContentLength: body.length,\n"
        + "    Headers: { 'Content-Type': contentType || 'application/octet-stream' },\n"
        + '  });',
      replacement: '  await new Promise((resolve, reject) => {\n'
        + '    cos.putObject({\n'
        + '      Bucket: cfg.bucket, Region: cfg.region, Key: k,\n'
        + '      Body: body,\n'
        + '      ContentLength: body.length,\n'
        + "      Headers: { 'Content-Type': contentType || 'application/octet-stream' },\n"
        + '    }, (err) => (err ? reject(err) : resolve()));\n'
        + '  });',
      testFile: 'audit7-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R7-06 · 分片中止退回「直接回调式调用」（绕过 p()）',
      file: 'server/upload-sessions.js',
      anchor: "      const { p } = require('./cos');\n"
        + "      p(cos, 'multipartAbort', { Bucket: o.bucket, Region: o.region, Key: o.key, UploadId: o.uploadId })\n"
        + '        .catch(() => {});',
      replacement: "      cos.multipartAbort({ Bucket: o.bucket, Region: o.region, Key: o.key, UploadId: o.uploadId }, () => {});",
      testFile: 'audit7-regressions.test.js',
      minFail: 1,
    },
    {
      // R11-18：R11-03 把回滚集合从「全部复制过的」改成「本次新建的」（`fresh`），
      // 原 anchor `copied.slice(i, i + 1000)` 已不存在 —— 改锚在新写法上，变异不变。
      // R12-04：回滚又被下沉成 `gateway.rollbackCopies()`（唯一实现点），
      // 再改锚到那里 —— 锚在 canonical 上也更耐改。
      name: 'R7-11 · movePrefix 失败后不再回滚（目标留下半份副本）',
      file: 'server/fs-gateway.js',
      anchor: '    const batch = keys.slice(i, i + 1000);',
      replacement: '    const batch = [];',
      testFile: 'audit7-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R7-12 · 超上限淘汰回到「无条件删除会话」',
      file: 'server/upload-sessions.js',
      // 锚点带上 R7-12 注释：过期分支里有一行一模一样的 `if (!abortRemote(o)) continue;`
      anchor: '      // 云端分片的 UploadId 句柄随之丢失：用户既无法中止、也无法续传，分片持续计费。\n      if (!abortRemote(o)) continue;',
      replacement: '      abortRemote(o);',
      testFile: 'audit7-regressions.test.js',
      minFail: 1,
    },
    {
      name: '遗留项 · 撤掉 HEAD /s/:id/dl 短路（回到「HEAD 走完整 GET handler」）',
      file: 'server/share-routes.js',
      anchor: "router.head('/s/:id/dl',",
      replacement: "router.post('/s/__never__/dl',",
      testFile: 'audit7-regressions.test.js',
      // 只保证 1 条失败：「失效链接返回 410」这条无论走不走 HEAD 短路都会是 410，
      // 它守的是状态码映射，不是短路本身
      minFail: 1,
    },
    {
      name: 'R7-08 · 撤掉「无人接管」的令牌兜底释放（回到全靠调用方）',
      file: 'server/fs-gateway.js',
      anchor: '      armReaderHandoff(out, releaseReader); // R7-08：无人接管时兜底释放',
      replacement: '',
      testFile: 'audit7-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R7-09 · 新增一个「建了就不管」的 setInterval（前端定时器句柄约定）',
      file: 'public/js/main.js',
      anchor: 'function startStatsTimer() {',
      replacement: 'function startStatsTimer() {\n  App._leakTimer = setInterval(() => {}, 1000);',
      testFile: 'audit7-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R7-10 · 存储用量回到「缓存 rejected Promise」（失败永不恢复）',
      file: 'public/js/main.js',
      anchor: '      if (!storageCache) {\n        storageCache = API.storage().catch((e) => { storageCache = null; throw e; });\n      }',
      replacement: '      if (!storageCache) storageCache = API.storage();',
      testFile: 'audit7-regressions.test.js',
      minFail: 1,
    },
    {
      // R11-18：R11-12 把 prune 抽成 `pruneSessions()` + 定时兜底后，原 anchor
      // （整段 `uploadSessions.prune(...)` 定义）已不存在。改锚在**调用点**上。
      //
      // ⚠️ 坑（R15 实测发现）：早先这条变异是「把 `pruneSessions();` 搬到
      // `const instanceLock = ...` 之前」。但 `pruneSessions` 是**第 340 行的 `const`
      // 箭头函数**，搬到第 315 行之前会先撞 TDZ（`Cannot access before initialization`）
      // → 子进程因**未捕获异常**退出（状态码同样是 1）且一个字节都没写，
      // 于是 audit7 的两条断言（`status===1`、未写 upload-sessions.json）**双双被巧合满足**
      // → `fail=0`。这不是「护栏没抓到」，而是**变异不等价于旧实现**（假绿第六种形态）。
      // 现在改为自包含地复现旧实现的可观测后果：prune 真的在锁之前跑完并触发落盘。
      name: 'R7-07 · prune() 挪回单实例锁之前',
      file: 'server/index.js',
      mutations: [
        { anchor: PRUNE_CALL, replacement: '' },
        {
          anchor: "const instanceLock = require('./instance-lock');",
          replacement: "require('./upload-sessions').prune(() => null); // 变异：prune 回到单实例锁之前\n\nconst instanceLock = require('./instance-lock');",
        },
      ],
      testFile: 'audit7-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R7-05 · 令牌密钥重新与密码哈希解绑（改密后旧令牌仍有效）',
      file: 'server/enc-store.js',
      anchor: "    .update(String(s.passwordHash || ''))\n    .update(String(s.passwordSalt || ''))",
      replacement: '',
      testFile: 'audit7-regressions.test.js',
      minFail: 2,
    },
    {
      name: 'R7-03 · 彻底删桶不再标记分享链接',
      file: 'server/routes/buckets.js',
      anchor: '    const deadLinks = shareStore.markMissingByBucket(b.bucket);',
      replacement: '    const deadLinks = 0;',
      testFile: 'audit7-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'D3 · GET /users 对普通用户返回全部（回到「可枚举全部账户」）',
      file: 'server/routes/users.js',
      anchor: "  res.json({ users: all.filter((u) => u.id === me.id), scope: 'self' });",
      replacement: "  res.json({ users: all, scope: 'all' });",
      testFile: 'audit7-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'D1 · tryAcquire 开始记录来源 IP（文档已声称「不记录」，代码必须一致）',
      file: 'server/share-store.js',
      anchor: '  l.downloads = Number(l.downloads) + 1;\n  l.lastDownloadAt = new Date().toISOString();',
      replacement: '  l.downloads = Number(l.downloads) + 1;\n  l.lastDownloadAt = new Date().toISOString();\n  l.lastDownloadIp = (l.lastDownloadIp || \'\');\n  l.clientIps = (l.clientIps || []).concat([\'1.2.3.4\']);',
      testFile: 'audit7-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'D1/D4 · 把被证伪的措辞写回 README（漂移护栏必须报警）',
      file: 'README.md',
      anchor: '托管链接可查看**已下载次数与最近下载时间**（分享下载不记录来源 IP，IP 仅在登录 / 解锁限流的告警日志中出现）。',
      replacement: '支持监控每次下载的时间、次数与来源 IP，可即时拉黑（即使对方正在下载）。',
      testFile: 'docs-sync.test.js',
      minFail: 1,
    },
    {
      name: '文档路由覆盖 · ipguard 的 enabled 子路由压回「家族记法」',
      file: 'Develop_Document.md',
      anchor: '`/ipguard/rules/:id` · `PUT /ipguard/rules/:id/enabled`',
      replacement: '`/ipguard/rules/:id`',
      testFile: 'routes-surface.test.js',
      minFail: 1,
    },
    {
      name: '文档路由覆盖 · /fs/upload/abort 压回 `/abort`',
      file: 'Develop_Document.md',
      anchor: '`/fs/upload/complete` · `POST /fs/upload/abort`',
      replacement: '`/fs/upload/complete` · `/abort`',
      testFile: 'routes-surface.test.js',
      minFail: 1,
    },

    /* ======================= 第 8 轮（原 ANALYSIS-ROUND8.md，已并入开发文档） ======================= */

    {
      name: 'R8-01 · 微信签名调用漏传报文主体（实参整体左移 → 必然抛 TypeError）',
      file: 'server/payment-gateway.js',
      anchor: '    Authorization: wechatAuthorization(method, path, raw, cfg, { timestamp, nonce }),',
      replacement: '    Authorization: wechatAuthorization(method, path, cfg, { timestamp, nonce }),',
      testFile: 'payment-gateway.test.js',
      minFail: 1,
    },
    {
      // R11-18：R10-05 之后该常量改为 `= LIMITS.MAGIC_SYNC_MAX`（单一来源），
      // 原 anchor `const MAGIC_CHUNK_MAX = 5 * 1024 * 1024;` 已不存在。改锚在新写法上，
      // 变异仍是「把上限压到 4MB」（低于 S3 非末片 5MB 的协议下限）。
      name: 'R8-02 · magic 分片上限压到 4MB（低于 AWS S3 的 5MB 分片下限）',
      file: 'server/routes/fs.js',
      anchor: 'const MAGIC_CHUNK_MAX = LIMITS.MAGIC_SYNC_MAX;',
      replacement: 'const MAGIC_CHUNK_MAX = 4 * 1024 * 1024;',
      testFile: 'audit8-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R8-03 · 明文覆盖写入不再清旧密文元数据（magic 静默损坏 / crypto 中途死亡）',
      file: 'server/enc-store.js',
      anchor: '  if (removeMeta(bucket, key)) { flushMeta(); return true; }',
      replacement: '  if (false) { flushMeta(); return true; }',
      testFile: 'audit8-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R8-06：恢复「已标记 missing 即短路」的旧形态。
       *
       * ⚠️ R14-10 之后探测函数外面包了一层 `singleFlight`，且缓存读取抽象成了
       * `existsHit()` —— 旧 anchor（`const now = Date.now();` + `existsProbe.get`）
       * 已不存在，必须跟着改。这类「重构把 anchor 改没了」由
       * `tests/invariants.test.js` 的「反向变异 anchor 必须在各自的 file 内命中」抓出
       * （本次就是它报的红），否则这条对照会静默失效。
       */
      name: 'R8-06 · probeObjectMissing 恢复「已标记即短路」（clearMissing 变死代码）',
      file: 'server/share-routes.js',
      anchor: '  const hit = existsHit(l.id, Date.now());\n  if (hit) return hit.missing;',
      replacement: '  if (l.missingAt) return true;\n  const hit = existsHit(l.id, Date.now());\n  if (hit) return hit.missing;',
      testFile: 'share-deleted.test.js',
      minFail: 1,
    },
    {
      name: 'R8-09 · 503 分支不再回滚下载计数（服务端故障静默吞掉用户配额）',
      file: 'server/share-routes.js',
      anchor: '      shareStore.release(l.id);\n      return renderPage(res, 503, {',
      replacement: '      return renderPage(res, 503, {',
      testFile: 'share-deleted.test.js',
      minFail: 1,
    },
    {
      name: 'R8-11 · list-cache 键丢掉 kind 命名空间（list / search 互相命中）',
      file: 'server/list-cache.js',
      // R21-11 把 `keyOf` 的每一段加了 `seg()` 消毒（剥掉分隔符 `\u0000`），
      // anchor 随之更新 —— 变异仍然只针对「丢掉 kind」这一件事。
      anchor: '  return [bucket, prefix, marker, maxKeys, delimiter, kind].map(seg).join(SEP);',
      replacement: '  return [bucket, prefix, marker, maxKeys, delimiter].map(seg).join(SEP);',
      testFile: 'audit8-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R8-12 · 当前密码错误改回 401（前端会当成会话过期并强制登出）',
      file: 'server/routes/webauthn.js',
      anchor: "      return res.status(403).json({ error: '密码不正确，无法开启 Windows Hello' });",
      replacement: "      return res.status(401).json({ error: '密码不正确，无法开启 Windows Hello' });",
      testFile: 'audit8-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R8-21 · 分片列举缓存写入前不再清扫（回到只增不减）',
      file: 'server/routes/_shared.js',
      anchor: '    sweepFragmentCache(); // R8-21：写入前先清扫 + 兜住硬上限\n',
      replacement: '',
      testFile: 'audit8-regressions.test.js',
      minFail: 1,
    },
    // R11-18 · 已删除：R8-24 的变异「`l.bucket && l.bucket !== bucket` → `l.bucket !== bucket`」
    // 与下面 R9-07 那一条**互为反向**（R9-07 复核后判定严格口径才是对的，把 R8-24 的结论推翻了），
    // 因此这条的「变异方向」现在等于修复方向，不是变异。且它引用的那行代码在 R9-07 之后
    // 已不存在（现为 `if (l.bucket !== bucket) continue;`）—— 保留只会让脚本报锚点未命中。
    // 该类别由 R9-07 那一条（严格口径 = 正解）守住。
    {
      name: 'R8-25 · create() 不再做跨链接订单裁剪（删链接后订单永久滞留）',
      file: 'server/payment-orders.js',
      anchor: '  pruneGlobal(); // R8-25：跨链接的兜底上限（自身已带 O(1) 前置判断，超限才排序）\n',
      replacement: '',
      testFile: 'audit8-regressions.test.js',
      minFail: 1,
    },

    /* ======================= 第 9 轮（原 ANALYSIS-ROUND9.md，已并入开发文档） ======================= */

    {
      name: 'R9-01 · WebDAV 目录 COPY/MOVE 去掉自嵌套守卫（可复制到自身子目录 → 无界递归）',
      file: 'server/webdav-server.js',
      anchor: "      if ((dstKey.replace(/\\/+$/, '') + '/').startsWith(srcKey)) {",
      replacement: '      if (false) {',
      testFile: 'audit9-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R9-02 · deleteMultipleObject 丢弃厂商 <Error>（调用方只能拿到空列表 → 误判全部成功）',
      file: 'server/s3-client.js',
      anchor: "      for (const blk of tagAll(body, 'Error')) {",
      replacement: '      for (const blk of ([])) {',
      testFile: 'audit9-regressions.test.js',
      minFail: 1,
    },
    {
      // R11-18：第 11 轮把 routes/fs.js 的第 5 份内联副本收敛到 `deleteMultipleConfirmed`
      // 后，判据只剩 `server/cos.js` 这一处（唯一实现点），原 anchor 不存在了 —— 改锚到那里。
      name: 'R9-02 · 批量删除判据退回黑名单（未确认删除的对象被静默丢弃）',
      file: 'server/cos.js',
      anchor: '    if (!okSet.has(k) && !errMap.has(k)) {',
      replacement: '    if (false) {',
      testFile: 'audit9-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R9-03 · copyObject 回退到 copyMeta（源无元数据时不清目标 → 陈旧密文元数据残留）',
      file: 'server/fs-gateway.js',
      anchor: '  const metaCopied = encStore.reconcileAfterWrite(cfg.bucket, dstK, srcMeta || null);',
      replacement: "  encStore.copyMeta(cfg.bucket, srcK, cfg.bucket, dstK);\n  const metaCopied = 0;",
      testFile: 'audit9-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R9-04 · readObject 不再把 Range 交给云端（回 200 + 全量长度却只发一部分）',
      file: 'server/fs-gateway.js',
      anchor: '  const cloudRange = served ? `bytes=${served.start}-${served.end}` : null;',
      replacement: '  const cloudRange = null;',
      testFile: 'audit9-regressions.test.js',
      minFail: 1,
    },
    {
      // R10-09 之后闸门变成 `statusQueryDue(order) && payStatusLimiter(ip).ok`，
      // 变异只拆掉限流那一半（保留 statusQueryDue），保证变异后仍是「真的要查单」。
      // R11-18：本条的锚点在 R10-09 之后被改写（闸门顺序变了），按「R9-05」检索会漏，
      // 故登记 `原编号` 并在 name 里同时保留两个编号
      原编号: 'R9-05',
      name: 'R10-09（原 R9-05）· /pay/status 去掉按 IP 预算闸门（R8-20 节流可被绕过）',
      file: 'server/share-routes.js',
      anchor: '    if (statusQueryDue(order) && security.payStatusLimiter(ip).ok) {',
      replacement: '    if (statusQueryDue(order) && true) {',
      testFile: 'audit9-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R9-06 · WebDAV 目录 MOVE 去掉 Overwrite:F 判定（目标已存在仍静默覆盖）',
      file: 'server/webdav-server.js',
      /**
       * ⚠️ R14 复核修正：旧 anchor 是**一整行注释**。
       * `tests/invariants.test.js` 的 anchor 自检要先剥注释才能防住「anchor 被删、
       * 字面留在注释里」的假活 —— 而纯注释 anchor 剥完只剩空白，于是「命中」恒真、
       * 「唯一性」得到 67 这种荒谬计数（实测）。它此前一直"绿"，靠的是源码里到处是空白。
       * 改用紧随其后的**代码行**：既唯一（实测恰 1 处），也真正落在变异要打的地方。
       */
      anchor: '        if (!overwrite && await destinationExists(cos, cfg, dstKey, true)) {',
      replacement: '        if (false) {',
      testFile: 'audit9-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R9-07 · markMissingByBucket 回到宽松口径（跨桶误标 + 历史链接被永久 410）',
      file: 'server/share-store.js',
      anchor: '    if (l.bucket !== bucket) continue;',
      replacement: '    if (l.bucket && l.bucket !== bucket) continue;',
      testFile: 'audit8-regressions.test.js',
      minFail: 1,
    },
    {
      // R10-01 之后「测试专用开关」已删除，改由 exitPathWritable() 判定目录本身。
      // 变异直接还原成旧实现的「无条件 mkdirSync」，新的行为护栏必须变红。
      // R11-18：同上 —— 锚点是 R10-01 之后的新写法，沿用 R9-08 的名字会漏检索
      原编号: 'R9-08',
      // R12-03：私有副本 `exitPathWritable()` 已删除，退出路径改调唯一实现点
      name: 'R10-01（原 R9-08）· 退出路径退回「无条件 mkdirSync」（删掉的目录被退出钩子复活）',
      file: 'server/upload-sessions.js',
      anchor: '    if (!secureStore.exitPathWritable(DATA_DIR)) return;',
      replacement: '    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });',
      testFile: 'audit9-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R9-09 · encryptBuffer 去掉 magic 同步上限（超大缓冲同步加密数秒）',
      file: 'server/enc-store.js',
      anchor: "  if (s.mode === 'magic' && buf && buf.length > LIMITS.MAGIC_SYNC_MAX) {",
      replacement: '  if (false) {',
      testFile: 'audit9-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R9-09 · 续传残留口去掉分片大小复检（旧会话仍可提交超限分片）',
      file: 'server/routes/fs.js',
      anchor: "    } else if (encStore.currentMode() === 'magic' && sess.chunkSize > MAGIC_CHUNK_MAX) {",
      replacement: '    } else if (false) {',
      testFile: 'audit9-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R9-10 · enc.js 取消标记失效（用户主动取消被当成「无法连接本地服务」报错）',
      file: 'public/js/enc.js',
      anchor: '      if (isCancelled(e)) return;',
      replacement: '      if (false) return;',
      testFile: 'frontend.test.js',
      minFail: 1,
    },

    /* ======================= 第 10 轮（原 ANALYSIS-ROUND10.md，已并入开发文档） ======================= */

    {
      name: 'R10-02 · /fs/move 的 newKey 去掉文件夹尾斜杠（目录层级丢失 + 元数据漂移）',
      file: 'server/routes/fs.js',
      anchor: "      const newKey = normalizeKey(targetPrefix + baseName(key) + (isFolder ? '/' : ''));",
      replacement: '      const newKey = normalizeKey(targetPrefix + baseName(key));',
      testFile: 'audit10-regressions.test.js',
      minFail: 1,
    },
    {
      // 真正的旧行为是「整批按成功处理」（`okKeys = list`）。只把 errMap 那段改掉
      // 并不会影响 `okKeys`，护栏不会变红 —— 变异必须真的等价于旧实现。
      name: 'R10-03 · 批量删除判据退回「整批按成功」（未确认删除也进入元数据清理）',
      file: 'server/cos.js',
      anchor: '  const okKeys = list.filter((k) => okSet.has(k));',
      replacement: '  const okKeys = list.slice();',
      testFile: 'audit10-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R10-04 · migratePrefix 回到「清整个目标前缀」（目录 MOVE 误删目标已有元数据）',
      file: 'server/enc-store.js',
      anchor: '   const overwrite = (opts && opts.overwriteRelKeys instanceof Set) ? opts.overwriteRelKeys : null;',
      replacement: '   const overwrite = new Set(Object.keys(files).filter((k) => k.startsWith(to)).map((k) => k.slice(to.length)));',
      testFile: 'audit10-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R10-05 · init 的 simple/multipart 分界不再感知加密模式（5–8MB 死路）',
      file: 'server/routes/fs.js',
      anchor: '      ? Math.min(SIMPLE_THRESHOLD, MAGIC_CHUNK_MAX)\n      : SIMPLE_THRESHOLD;',
      replacement: '      ? SIMPLE_THRESHOLD\n      : SIMPLE_THRESHOLD;',
      testFile: 'audit10-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R10-06 · WebDAV MOVE 删源后不标记分享链接（管理端长期显示有效）',
      file: 'server/fs-gateway.js',
      anchor: '  shareStore.markMissingByKeys(cfg.bucket, [fromKey]);',
      replacement: '  // 变异：MOVE 删源不标记分享链接',
      testFile: 'audit10-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R10-07 · WebDAV HEAD 对任何 Range 都宣告 206（与 GET 的退化不一致 → 拼装损坏）',
      file: 'server/webdav-server.js',
      anchor: '        if (rh && gateway.rangeServable(st)) {',
      replacement: '        if (rh) {',
      testFile: 'audit10-regressions.test.js',
      minFail: 1,
    },
    {
      // R11-18：R11-08 把上限抽成 `chunkCap`（缺 chunkSize 时回落硬上限）后，
      // 原 anchor 已不存在 —— 改锚在 `chunkCap` 判定上，变异仍是「完全不校验」。
      name: 'R10-08 · /fs/upload/chunk 不校验分片大小（超大分片同步阻塞数秒）',
      file: 'server/routes/fs.js',
      anchor: '    if (req.body.length > chunkCap) {',
      replacement: '    if (false) {',
      testFile: 'audit10-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R10-10 · 分片 complete 的用量缓存修正退回手拼 cfg（缺 secretId → 恒不命中）',
      file: 'server/routes/fs.js',
      // R27-04：R10-10 的记账已从 `sess.size` 改为**实际字节** `actualBytes`，
      // 原 anchor（`adjustStorageCache(sess.size, sessCfg)`）已不存在。变异语义不变：
      // 仍是把「完整 cfg」退回「缺 secretId 的手拼对象」→ 缓存键永不相等 → 修正恒为空操作。
      anchor: '    adjustStorageCache(actualBytes, sessCfg);',
      replacement: '    adjustStorageCache(actualBytes, { bucket: sess.bucket, region: sess.region, provider: sess.provider, credentialId: sess.credentialId });',
      testFile: 'audit10-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R10-11 · Overwrite 判据漏掉「目标是已存在的文件」',
      file: 'server/webdav-server.js',
      anchor: '  if (bare && await head(bare)) return true;',
      replacement: '  if (false && await head(bare)) return true;',
      testFile: 'audit10-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R10-11 · Overwrite 判据漏掉「目标是空目录（仅占位对象）」',
      file: 'server/webdav-server.js',
      // ⚠ anchor 必须唯一：`if (await head(prefix)) return true;` 在 `destinationExists()`
      // 里出现**两次**（文件源分支 / 目录源分支），而 `String.replace` 只改**首处** ——
      // 只写单行 anchor 会命中文件源那处，而本用例是 `MOVE /dav/dirA/`（**目录源**），
      // 走的是另一处 → 变异不生效 → 假绿（实测 fail=0）。故带前导换行锚定行首。
      anchor: '\n  if (await head(prefix)) return true;',
      replacement: '\n  if (false) return true;',
      testFile: 'audit10-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R10-11 · 目录 COPY 退回「逐对象判定」（复制掉一部分才 412，目标留半成品）',
      file: 'server/webdav-server.js',
      // R13-04 复核后保留容器级判据（`destinationExists(..., true)` 的三种形态已覆盖
      // 「目标非空」），只是外面多了一层 `if (!overwrite) {` —— anchor 随缩进同步。
      anchor: "          if (await destinationExists(cos, cfg, dstKey, true)) {\n            return res.status(412).type('text/plain')\n              .send(`412 Precondition Failed：目标「${dstDir}」已存在且请求声明 Overwrite: F`);\n          }\n",
      replacement: "          if (false) {\n            return res.status(412).type('text/plain')\n              .send(`412 Precondition Failed：目标「${dstDir}」已存在且请求声明 Overwrite: F`);\n          }\n",
      testFile: 'audit10-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R10-12 · app.head 注册到 app.get 之后（HEAD 被 GET 吞掉 → 每次 HEAD 都下载整份对象）',
      file: 'server/webdav-server.js',
      anchor: "  app.head('*', (req, res, next) => (req.path.startsWith(MOUNT) ? getObject(req, res, true) : next()));\n  app.get('*', (req, res, next) => (req.path.startsWith(MOUNT) ? getObject(req, res, false) : next()));",
      replacement: "  app.get('*', (req, res, next) => (req.path.startsWith(MOUNT) ? getObject(req, res, false) : next()));\n  app.head('*', (req, res, next) => (req.path.startsWith(MOUNT) ? getObject(req, res, true) : next()));",
      testFile: 'audit10-regressions.test.js',
      minFail: 1,
    },

    /* ======================= 第 11 轮（原 ANALYSIS-ROUND11.md，已并入开发文档） ======================= */

    {
      // 变异只撤掉外层 while 对 stalled 的引用（内层仍置位）—— 正是 R11-01 的旧实现：
      // `break` 只跳内层 for，循环照样跑满 MAX_ROUNDS=1000。
      // R23-03：循环本体已从 `routes/fs.js` 收敛到 `fs-gateway.deletePrefixAll()`
      // （三份同构实现合一），锚点随之改指唯一实现点 —— 判据与纪律不变。
      name: 'R11-01 · deletePrefixAll 的「整批 0 成功即停下」退回到只 break 内层 for（跑满 1000 轮）',
      file: 'server/fs-gateway.js',
      anchor: '  while (truncated && !stalled && rounds < MAX_ROUNDS) {',
      replacement: '  while (truncated && rounds < MAX_ROUNDS) {',
      testFile: 'audit11-regressions.test.js',
      minFail: 1,
    },
    {
      // 两步变异：把 migratePrefix 整段挪到「删源 + 标记分享链接」之后（R11-02 的旧顺序）
      name: 'R11-02 · 目录 MOVE 的元数据迁移退回「删源之后」（中断时目标密文挂已删源 key 的凭据）',
      file: 'server/fs-gateway.js',
      mutations: [
        {
          anchor: "  const relKeys = new Set(items.map((x) => x.key.slice((srcP + '/').length)).filter(Boolean));\n  const metaMig = encStore.migratePrefix(cfg.bucket, srcP + '/', dstP + '/', { overwriteRelKeys: relKeys });\n  const metaMoved = metaMig.moved;\n",
          replacement: '',
        },
        {
          anchor: '  if (removedKeys.length) shareStore.markMissingByKeys(cfg.bucket, removedKeys);\n',
          replacement: "  if (removedKeys.length) shareStore.markMissingByKeys(cfg.bucket, removedKeys);\n"
            + "  const relKeys = new Set(items.map((x) => x.key.slice((srcP + '/').length)).filter(Boolean));\n"
            + "  const metaMig = encStore.migratePrefix(cfg.bucket, srcP + '/', dstP + '/', { overwriteRelKeys: relKeys });\n"
            + "  const metaMoved = metaMig.moved;\n",
        },
      ],
      testFile: 'audit11-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * ⏭ 已退役（2026-09-24，R14 复核时发现）。
       *
       * R12-02 之后，`movePrefix()` 会在**动手之前**就以 409 拒绝「目标下已存在同名
       * 对象」的移动（`fs-gateway.js` 的 `conflicts` 预检）。于是本用例构造的
       * 「目标侧既有对象 + 复制失败 → 回滚」场景**再也走不到回滚分支**，断言退化为
       * 「409 早退后目标未被改动」这一平凡事实 —— 实测退回 `copied.slice()` 仍 fail=0
       * （变异不可观测 = 假护栏）。同一纪律（回滚只删「本次才新建」者）已由 R13-02
       * 经 WebDAV 目录 COPY 走同一个 `rollbackCopies()` 真实覆盖，故此处退役。
       */
      name: 'R11-03 · 目录 MOVE 回滚退回「删掉所有本次复制过的目标键」（连目标侧既有对象一起删）',
      file: 'server/fs-gateway.js',
      anchor: '    const fresh = copied.filter((k) => !existedBefore.has(k));',
      replacement: '    const fresh = copied.slice();',
      testFile: 'audit11-regressions.test.js',
      minFail: 1,
      retired: true,
      retiredReason: 'R12-02 的冲突预检使「目标侧既有对象」在复制前即 409 中止，回滚分支不可达；'
        + '同纪律已由 R13-02（webdav 目录 COPY → rollbackCopies）真实覆盖',
    },
    {
      name: 'R11-04 · 上游 401 原样透传（前端当成会话过期 → 强制登出死循环）',
      file: 'server/cos.js',
      anchor: '  err.status = status === 401 ? 502 : (status >= 400 && status < 600 ? status : 500);',
      replacement: '  err.status = status >= 400 && status < 600 ? status : 500;',
      testFile: 'audit11-regressions.test.js',
      minFail: 1,
    },
    {
      // R10-12 的同款缺陷在 API 面重演：撤掉 HEAD handler，express 会把 HEAD 退化成 GET
      name: 'R11-05 · 撤掉 HEAD /fs/download（express 让 HEAD 回落 GET → 每次 HEAD 都下载整份对象）',
      file: 'server/routes/fs.js',
      anchor: "router.head('/fs/download', async (req, res) => {",
      replacement: "router.post('/fs/__never__/download', async (req, res) => {",
      testFile: 'audit11-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R11-06 · WebDAV 文件 MOVE 到自身不再拒绝（自复制 + 删源 = 静默数据丢失）',
      file: 'server/webdav-server.js',
      /**
       * ⚠️ anchor 必须**在文件内唯一**：`String.replace` 只替换**首处**。
       * `if (srcKey === dstKey) {` 在目录分支（`:884`）里还有一份同款守卫，
       * 单行 anchor 会命中**文件分支**（`:845`，本用例的目标）—— 眼下结果正确，
       * 但只要将来两个分支的先后顺序调换，变异就会静默打到另一边、照样"绿"。
       * 故带上紧跟的独有代码行（`const srcIsDir`）锁死为唯一命中。
       */
      anchor: '      if (srcKey === dstKey) {\n'
        + '        return res.status(403).type(\'text/plain\')\n'
        + '          .send(`403 Forbidden：${isMove ? \'移动\' : \'复制\'}目标与源相同`);\n'
        + '      }\n\n      const srcIsDir = srcKey.endsWith(\'/\');',
      replacement: '      if (false) {\n'
        + '        return res.status(403).type(\'text/plain\')\n'
        + '          .send(`403 Forbidden：${isMove ? \'移动\' : \'复制\'}目标与源相同`);\n'
        + '      }\n\n      const srcIsDir = srcKey.endsWith(\'/\');',
      testFile: 'audit11-regressions.test.js',
      minFail: 1,
    },
    {
      // R12-03：`enc-store` 的内联判定也改调唯一实现点了
      name: 'R11-07 · 退出路径退回「无条件 mkdirSync」（删掉的 data 目录被退出钩子复活）',
      file: 'server/enc-store.js',
      anchor: '  if (opts.exit && !secureStore.exitPathWritable(DATA_DIR)) return;\n',
      replacement: '',
      testFile: 'audit11-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * ⏭ 已退役（2026-09-24，R14 复核时发现）。
       *
       * R12-05 之后，magic + 缺 `chunkSize` 会在**入口**就被 409 挡住
       * （`routes/fs.js` 的 `base = NaN` 守卫），根本到不了本处 `chunkCap` 回落；
       * 而即便撤掉入口那道，最内层 `encryptPart` 也会以同一 409 兜住
       * （`tests/audit11-regressions.test.js:615` 的注释自陈）。可观测结果被两层
       * **同态**保证，单文件变异无法证伪（实测 fail=0）。故此条退役。
       */
      name: 'R11-08 · 分片大小上限退回「只认会话声明值」（缺 chunkSize 时完全不校验）',
      file: 'server/routes/fs.js',
      anchor: "    const chunkCap = Number(sess.chunkSize) > 0\n      ? Number(sess.chunkSize)\n      : (mode === 'magic' ? MAGIC_CHUNK_MAX : UPLOAD_CHUNK_MAX);",
      replacement: '    const chunkCap = Number(sess.chunkSize) > 0 ? Number(sess.chunkSize) : Infinity;',
      testFile: 'audit11-regressions.test.js',
      minFail: 1,
      retired: true,
      retiredReason: 'R12-05 的入口 409 使 chunkCap 回落分支不可达；撤掉入口后 encryptPart 仍兜同一状态，'
        + '单文件变异不可证伪（状态被两层同态保证）',
    },
    {
      name: 'R11-14 · /fs/upload/chunk 不再校验分片序号范围（越界序号直接打到云端）',
      file: 'server/routes/fs.js',
      anchor: '    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {',
      replacement: '    if (false) {',
      testFile: 'audit11-regressions.test.js',
      minFail: 1,
    },
    {
      // R11-17 ①：旧护栏只断言「不得 206」，判定退化成恒 false 照样全绿，
      // 这条变异必须靠新加的正向对照（小加密对象 HEAD 必须 206）变红。
      name: 'R11-17 · WebDAV HEAD 对任何 Range 都回 200（判定退化成恒 false）',
      file: 'server/webdav-server.js',
      anchor: '        if (rh && gateway.rangeServable(st)) {',
      replacement: '        if (rh && false) {',
      testFile: 'audit10-regressions.test.js',
      minFail: 1,
    },
    {
      // R11-17 ②：顺序对    {
      // R11-17 ②：顺序对调 → 限流器被无条件按压（被订单级节流拦下的轮询也扣预算）
      name: 'R11-17 · IP 查单预算闸门顺序对调（被订单级节流拦下时也扣预算）',
      file: 'server/share-routes.js',
      anchor: '    if (statusQueryDue(order) && security.payStatusLimiter(ip).ok) {',
      replacement: '    if (security.payStatusLimiter(ip).ok && statusQueryDue(order)) {',
      testFile: 'audit9-regressions.test.js',
      minFail: 1,
    },
    {
      // R13-01：撤掉 helpers 的顶层兜底 → 回到"靠每个用例自觉设 env"。
      // 那正是全量测试写生产 config.enc / stats.json 的根因（加载时序）
      name: 'R13-01 · 测试隔离退回「靠每个用例自觉」（不设 env 的进程回落生产 data/）',
      file: 'tests/helpers.js',
      anchor: 'if (!process.env.COS_DATA_DIR) {',
      replacement: 'if (false) { // 变异：撤掉默认安全',
      testFile: 'audit13-regressions.test.js',
      minFail: 1,
    },
    {
      // R13-02：回滚退回"全量 created"（丢掉 fresh 过滤）→ 删掉复制前就存在的用户对象
      name: 'R13-02 · 目录 COPY 回滚退回全量 created（删掉复制前就存在的目标对象）',
      file: 'server/webdav-server.js',
      anchor: '          const fresh = created.filter((k) => !existedBefore.has(k));',
      replacement: '          const fresh = created.slice(); // 变异：无 fresh 过滤',
      testFile: 'audit13-regressions.test.js',
      minFail: 1,
    },
    {
      // R13-03：失败后不再等在飞的 worker 落地就取快照 → 孤儿留在目标目录，日志谎报
      name: 'R13-03 · 目录 COPY 失败不再等 worker 落地（快照过早 → 目标残留孤儿）',
      file: 'server/webdav-server.js',
      anchor: '          await Promise.allSettled(workers);\n',
      replacement: '          // 变异：不再等在飞的 worker 落地\n',
      testFile: 'audit13-regressions.test.js',
      minFail: 1,
    },
    {
      // R13-04 ①：摘掉容器级判据 → 目标非空但无同名对象时被放行（违背 RFC 4918 §9.8.4）
      name: 'R13-04 · 目录 COPY 摘掉容器级 Overwrite:F 判据（目标非空仍放行）',
      file: 'server/webdav-server.js',
      anchor: '          if (await destinationExists(cos, cfg, dstKey, true)) {',
      replacement: '          if (false) { // 变异：摘掉容器级判据',
      testFile: 'audit13-regressions.test.js',
      minFail: 1,
    },
    {
      // R13-04 ②：摘掉键级兜底 → 容器级探测 fail-open 时同名对象被静默覆盖
      name: 'R13-04 · 目录 COPY 摘掉键级兜底（容器级 fail-open 时静默覆盖同名对象）',
      file: 'server/webdav-server.js',
      anchor: '          for (const t of targets) if (existedBefore.has(t.dst)) conflicts.push(t.dst);',
      replacement: '          for (const t of targets) if (false) conflicts.push(t.dst);',
      testFile: 'audit13-regressions.test.js',
      minFail: 1,
    },
    {
      // R13-05 ①：删源失败不再回滚目标副本（旧实现：源与目标并存，既不回滚也不留痕）
      name: 'R13-05 · moveObject 删源失败不再回滚目标副本（源与目标并存）',
      file: 'server/fs-gateway.js',
      anchor: '      const rb = await rollbackCopies(cos, cfg, [toKey]);',
      replacement: '      const rb = { removed: 1, errors: [] }; // 变异：不回滚，且谎报成功',
      testFile: 'audit13-regressions.test.js',
      minFail: 1,
    },
    {
      // R13-05 ②：忽略"目标原本已存在" → 回滚把用户复制前就有的对象一并删掉（不可逆）
      name: 'R13-05 · moveObject 忽略「目标原本已存在」（回滚删掉用户既有数据）',
      file: 'server/fs-gateway.js',
      anchor: '    if (dstExistedBefore) {',
      replacement: '    if (false) { // 变异：无视「目标原本已存在」',
      testFile: 'audit13-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R13-06：本条的"被测对象"是**检查器本身**。
       *
       * 旧实现「找定义」用含 `const|let|var name =` 的正则，但「取 canonical 函数体」
       * 只认 `function name(` —— 两套不同源。于是把 canonical 重构成箭头函数并
       * 删掉判据，`mustContain` 校验**静默跳过**、违规数归零（第 12 轮头条缺陷原地复活）。
       * 变异同时做两步（换成箭头形态 + 函数体退化），期望新检查器报红；
       * 若退回旧的"只认 function 声明"版本，这条会重新变绿。
       */
      name: 'R13-06 · canonical 重构成箭头函数并退化函数体（旧检查器静默跳过）',
      file: 'server/fs-gateway.js',
      mutations: [
        {
          anchor: 'async function rollbackCopies(cos, cfg, keys) {',
          replacement: 'const rollbackCopies = async (cos, cfg, keys) => { // 变异：换定义形态',
        },
        {
          anchor: '      const res = await deleteMultipleConfirmed(cos, cfg, batch);',
          replacement: '      const res = { okKeys: batch, errors: [] }; // 变异：函数体退化',
        },
      ],
      testFile: 'invariants.test.js',
      minFail: 1,
    },
    {
      /**
       * R13-07：删掉**一个登记入口**对唯一实现点的调用。
       *
       * 旧口径 `minCalls` 是"计数代理"：全库总数够就放行，于是「删一处真实接线 +
       * 在没人读的地方补一处空调用」即可绕过。逐文件点名后此路不通
       * （三处 exit 钩子分属三个文件，缺一个就报一个）。
       */
      name: 'R13-07 · 登记入口不再调用唯一实现点（旧 minCalls 计数代理照样放行）',
      file: 'server/enc-store.js',
      anchor: '  if (opts.exit && !secureStore.exitPathWritable(DATA_DIR)) return;',
      replacement: '  // 变异：登记入口不再调用唯一实现点',
      testFile: 'invariants.test.js',
      minFail: 1,
    },

    /* ================== 第 14 轮（ANALYSIS-ROUND14.md） ==================
     * 验收口径不是「逐条看代码改没改」，而是**撤掉修复，护栏必须变红**。
     * 本轮两条高危（R14-01 / R14-02）的共同点正是「486 条用例全绿、功能为零」——
     * 它们的护栏若不能反向变红，等于又给了一次同样的假阴性。
     */
    {
      // 判据退回「是不是函数」：生产四处传的是 PassThrough（object），
      // 于是全部走 arrayBuffer 分支 —— 对象被无界读进内存、传入的流永不 end、
      // 加密读信号量永久泄漏。这正是 R14-01 修复前的真实形态。
      name: 'R14-01 · S3 流式判据退回 typeof === function（非腾讯云厂商下载全断）',
      file: 'server/s3-client.js',
      anchor: '      if (out && typeof out.pipe === \'function\') {',
      replacement: '      if (typeof params.Output === \'function\') {',
      testFile: 's3-client.test.js',
      minFail: 1,
    },
    {
      // CSP 少一个域名：Turnstile 的脚本源被拦截 → 组件永不 load →
      // 而"需要验证码"的开关已打开 → 全站账号无法登录。修复前就是这个形态。
      name: 'R14-02 · CSP 去掉 challenges.cloudflare.com（启用 Turnstile 后锁死登录）',
      file: 'server/index.js',
      anchor: '    + "script-src \'self\' https://www.recaptcha.net https://www.gstatic.com https://challenges.cloudflare.com; "',
      replacement: '    + "script-src \'self\' https://www.recaptcha.net https://www.gstatic.com; "',
      testFile: 'invariants.test.js',
      minFail: 1,
    },
    {
      // 等价于「pending 不再受保护」= 修复前的裁剪口径。
      // 后果：付款者正在收银台时订单被裁 → 异步通知查无此单 → 钱付了拿不到文件。
      name: 'R14-03 · 订单裁剪不再保护支付窗口内的 pending（钱付了拿不到文件）',
      file: 'server/payment-orders.js',
      anchor: '  return now - t < PENDING_KEEP_MS;',
      replacement: '  return false;',
      testFile: 'audit14-regressions.test.js',
      minFail: 1,
    },
    {
      // 去掉支付态检查 = 修复前的形态：已付用户再点一次付费会覆盖已付票据。
      name: 'R14-05 · 发起支付不再查当前支付态（已付凭证被 pending 覆盖）',
      file: 'server/share-routes.js',
      // ⚠ anchor 必须唯一：`const payer = payerStateFor(l, req);` 在 GET /s/:id（缩进 4）、
      // POST /s/:id/pay（缩进 2）、GET /s/:id/dl（缩进 4）各出现一次，而 replace 只改**首处**。
      // 只写单行 anchor 会命中 GET 那处，支付处理器原封不动 → 变异不生效 → 假绿（fail=0）。
      // 故带前导换行锚定行首，并追加支付处理器独有的下一行代码，锁死为唯一命中。
      anchor: '\n  const payer = payerStateFor(l, req);\n  if (payer.state === \'paid\') {',
      replacement: '\n  const payer = { state: \'none\' };\n  if (payer.state === \'paid\') {',
      testFile: 'invariants.test.js',
      minFail: 1,
    },
    {
      // 口令错误分支不跑 dummyHash → 「有效用户名 = 响应更快」→ 可枚举账户名。
      name: 'R14-07 · WebDAV 口令错误分支不再跑 dummyHash（用户名枚举侧信道反向放大）',
      file: 'server/config-store.js',
      anchor: '  if (!constTimeEquals(password, plain)) { await dummyHash(password); return { ok: false }; }',
      replacement: '  if (!constTimeEquals(password, plain)) { return { ok: false }; }',
      testFile: 'invariants.test.js',
      minFail: 1,
    },
    {
      // 写入侧不再过 normalizeKey = 修复前的形态：`newName='..'` 能写出 `a/..`，
      // 此后删除 / 移动 / stat 一律 400 —— 不可逆的幽灵对象。
      name: 'R14-13 · rename 的 newKey 不再过 normalizeKey（产出删不掉的幽灵对象）',
      file: 'server/routes/fs.js',
      anchor: "    const newKey = normalizeKey(parentOf(key) + newName + (isFolder ? '/' : ''));",
      replacement: "    const newKey = parentOf(key) + newName + (isFolder ? '/' : '');",
      testFile: 'invariants.test.js',
      minFail: 1,
    },

    /* ---------- 第 14 轮 · P2 性能批次（本地收口，报告 §3.1 / §3.2(1)） ----------
     * 四条（R14-08/09/10/12）表面是四个问题，本质是同一件事：某条高频路径缺少
     * 「去抖 / 缓存 / 并发合并」中的某一层。修复载体是共享原语 `server/coalesce.js`，
     * 所以这里的每一条变异都要么废掉那一层、要么废掉那条接线。
     */
    {
      /**
       * R14-08：把序列化（含全量 AES-GCM）挪回**入队之前** —— 修复前的真实形态。
       * 两步变异：先把按引用传递的活对象序列化成一个 `text` 常量，再让队列只用它。
       * 顺带把 `null, 1` 缩进也加回去（同一缺陷的另一半）。
       */
      name: 'R14-08 · 加密退回「入队前同步执行」并带缩进（异步写仍阻塞调用栈）',
      file: 'server/secure-store.js',
      mutations: [
        {
          anchor: '  const prev = queues.get(file) || Promise.resolve();',
          replacement: '  const text = serialize(obj);\n  const prev = queues.get(file) || Promise.resolve();',
        },
        {
          anchor: '      return atomic.writeAtomic(file, serialize(obj));',
          replacement: '      return atomic.writeAtomic(file, text);',
        },
        {
          anchor: '  return JSON.stringify({ [ENC_FLAG]: ENC_VERSION, data: configStore.encrypt(obj) });',
          replacement: '  return JSON.stringify({ [ENC_FLAG]: ENC_VERSION, data: configStore.encrypt(obj) }, null, 1);',
        },
      ],
      testFile: 'audit14-perf.test.js',
      minFail: 1,
    },
    {
      /**
       * R14-09：订单落盘退回「每次状态变更立刻全量落盘」= 去抖形同不存在。
       * 一次真实支付流程（setTradeNo / markPaid / markDownloaded）会变成三次
       * 全量序列化 + 加密 + 写盘，而 POST /s/:id/pay 匿名可达。
       */
      name: 'R14-09 · 订单落盘退回「每次变更立刻全量落盘」（去抖失效）',
      file: 'server/payment-orders.js',
      anchor: '  writer.schedule();',
      replacement: '  secureStore.writeJsonAsync(FILE, cache);',
      testFile: 'audit14-perf.test.js',
      minFail: 1,
    },
    {
      /**
       * R14-09 的另一半：`create()` 上的 `prune()` 退回无守卫的全表 filter + sort。
       * 后果不可用行为断言表达（裁剪结果完全等价，只是每次 create 白扫一遍全表），
       * 故由 `tests/invariants.test.js` 的静态检查「prune 必须被总量守卫」守。
       */
      name: 'R14-09 · create 上的 prune 退回无守卫的全表扫描',
      file: 'server/payment-orders.js',
      anchor: '  if (orders.length > MAX_ORDERS_PER_LINK) prune(o.linkId);',
      replacement: '  prune(o.linkId);',
      testFile: 'invariants.test.js',
      minFail: 1,
    },
    {
      /**
       * R14-10：拆掉探测的并发去重 —— 同一链接的并发请求各打一次 headObject。
       * 变异后箭头函数**不被调用**（少了那对调用括号），整段探测根本不会执行，
       * 于是「并发只探一次」的断言拿到 0 次而失败 —— 这正是要证明的因果链。
       */
      name: 'R14-10 · 分享页探测退回「无并发去重」（同链接并发各打一次云端）',
      file: 'server/share-routes.js',
      anchor: '  return singleFlight(`share-exists:${l.id}`, async () => {',
      replacement: '  return (async () => {',
      testFile: 'audit14-perf.test.js',
      minFail: 1,
    },
    {
      /**
       * R14-12：把 `/fs/stat` 的并发合并与短缓存一起撤掉 = 修复前的形态：
       * 每次请求都串行翻页全量列举（默认上限 2 万 → 最多约 21 次云端往返），
       * 而该路由既没有限流器也不需要管理员。
       */
      name: 'R14-12 · /fs/stat 退回「无缓存、无限流的全量列举」',
      file: 'server/routes/fs.js',
      mutations: [
        {
          anchor: '      const cachedStat = listCache.get(statKey);',
          replacement: '      const cachedStat = null;',
        },
        {
          anchor: '        const again = listCache.get(statKey);',
          replacement: '        const again = null;',
        },
        {
          anchor: '        listCache.set(statKey, out);',
          replacement: '        void out;',
        },
      ],
      testFile: 'audit14-perf.test.js',
      minFail: 1,
    },
    {
      /**
       * R14-12 的另一半：只拆并发合并、保留缓存。
       *
       * 与上一条**并存**是有意的 —— 上一条证明"回到旧实现会变红"，这一条单独证明
       * 「singleFlight 那一层真的在挡并发」。少了它，一个只删 `singleFlight` 的
       * 半修（缓存还在，单请求场景全绿）就没有任何护栏能发现。
       */
      name: 'R14-12 · /fs/stat 只拆并发合并（缓存仍在，单请求测不出）',
      file: 'server/routes/fs.js',
      anchor: '      const payload = await singleFlight(`fs-stat:${statKey}`, async () => {',
      replacement: '      const payload = await (async () => {',
      testFile: 'audit14-perf.test.js',
      minFail: 1,
    },
    {
      /*
       * 把 `requireStore()` 挪回 `await` 之前 —— 这就是修复前的形态。
       *
       * 后果：`await hashPassword()`（scrypt，约 50~100ms）期间若 60 秒 TTL 到期，
       * `load()` 会把 `cached` 换成**新对象**，手上的 cfg 就此脱钩；随后的
       * `persist(cfg)` 又把 `cached` 指回旧对象 —— 这段时间内别人的写入被**整体覆盖**，
       * 双方都收到成功响应，一方静默丢更新（丢的若是角色/权限，表现为「降权不生效」）。
       *
       * 这条与 R14-06 此前**只有静态检查、没有反向对照**（`--only=R14-04` 曾因此无匹配）：
       * 静态检查只能证明「现在这样写是对的」，证明不了「退回旧写法会被抓到」。
       */
      name: 'R14-04 · addUser 把 requireStore() 挪回 await 之前（静默丢更新）',
      file: 'server/config-store.js',
      anchor: '  const { salt, hash } = await hashPassword(password);\n  const cfg = requireStore();',
      replacement: '  const cfg = requireStore();\n  const { salt, hash } = await hashPassword(password);',
      testFile: 'invariants.test.js',
      minFail: 1,
    },
    {
      /*
       * 删掉安全响应头中间件 = 修复前的形态（8443 端口是**另一个** Express 实例，
       * 主站那套头一份都不会自动带上）。可渲染类型（html / svg）被浏览器内联渲染时
       * `<script>` 即执行，配合被缓存的 Basic 凭据 = 一个文件拿到该账户名下全部桶的读写删权限。
       *
       * 替换为空串后中间件只剩 `next()`：语法合法、服务照跑，只有静态检查会报。
       * 刻意**不**在替换内容里写任何含 `Content-Security-Policy` 的字样 ——
       * 静态检查跑在 `stripComments()` 之上，但让变异体「看起来像有头」会削弱这条对照的说服力。
       */
      name: 'R14-06 · WebDAV 独立实例去掉安全响应头（html/svg 内联渲染即执行脚本）',
      file: 'server/webdav-server.js',
      anchor: "    res.setHeader('Content-Security-Policy', \"default-src 'none'; sandbox\");\n"
        + "    res.setHeader('X-Content-Type-Options', 'nosniff');\n"
        + "    res.setHeader('Referrer-Policy', 'no-referrer');",
      replacement: '',
      testFile: 'invariants.test.js',
      minFail: 1,
    },
    {
      /*
       * 撤掉「候选集订阅写操作失效」的接线 = 回到「写完不失效」。
       *
       * 后果：TTL 内用户一直看到「刚删掉的文件还在 / 刚上传的搜不到」，
       * 且**没有任何报错** —— 唯一的自愈途径是等 TTL 到期。
       */
      name: '搜索候选集 · 不订阅 onMutate（写操作不再让候选集失效）',
      file: 'server/search-candidates.js',
      anchor: 'listCache.onMutate((method, params) => {\n'
        + '  try { drop(params && params.Bucket); } catch (e) { /* 缓存失效失败不影响主流程 */ }\n'
        + '});',
      replacement: '/* 变异：不再订阅云端写操作 */',
      testFile: 'search-candidates.test.js',
      minFail: 1,
    },
    {
      /*
       * 让 `/fs/search` 永远不从候选集取条目 —— 等价于**这层缓存根本没接上**。
       *
       * 只测「结果对不对」发现不了它（结果当然还是对的），只测「重复搜索省了调用」
       * 也发现不了它 —— `listCache` 是秒级页缓存、且接入候选集**之前**就存在，
       * 「重复搜索免费」在本变异下照样成立。所以护栏必须是**关掉 listCache**
       * （`LIST_CACHE_TTL_MS=0`）之后断言「第二轮仍不打云端」：
       * 那时能省下调用的只剩候选集，本变异必然让它多打一次云端。
       *
       * 反面教材：本条初次登记时跑出 `fail=0`，正是因为当时的断言被 listCache 兜住了。
       */
      name: '搜索候选集 · /fs/search 不读候选集（这层缓存等于没接）',
      file: 'server/routes/fs.js',
      anchor: '    let cand = candidates.get(candKey);',
      replacement: '    let cand = null; // 变异：不读候选集',
      testFile: 'search-candidates.test.js',
      minFail: 1,
    },
    {
      /*
       * 游标边界从「严格大于」放宽成「大于等于」。
       *
       * 游标语义必须与对象存储的 `Marker` 一致（返回**大于**它的 key）：用 `>=`
       * 会让续扫把刚刚处理过的那个对象再返回一次 —— 用户看到重复项，且分页越多重复越多。
       */
      name: '搜索候选集 · firstAfter 的游标边界用 >=（续扫重复返回刚处理过的对象）',
      file: 'server/search-candidates.js',
      anchor: '    if (items[mid].key > cursor) hi = mid; else lo = mid + 1;',
      replacement: '    if (items[mid].key >= cursor) hi = mid; else lo = mid + 1;',
      testFile: 'search-candidates.test.js',
      minFail: 1,
    },
    {
      /*
       * `put` 覆盖已有键时刷新 `at` = 「写一次就永不过期」。
       *
       * 热条目（被反复命中的前缀）的陈旧窗口会被无限延长，而这层缓存唯一的一致性
       * 兜底就是 TTL —— 站外写入（控制台 / 生命周期规则 / 别的工具）系统收不到任何信号。
       */
      name: '搜索候选集 · put 刷新 at（热条目永不失效，站外写入的陈旧窗口无限延长）',
      file: 'server/search-candidates.js',
      anchor: '    at: prev ? prev.at : now,',
      replacement: '    at: now,',
      testFile: 'search-candidates.test.js',
      minFail: 1,
    },
    {
      /*
       * 缓存键丢掉搜索范围维度。
       *
       * 「递归」与「仅当前目录」是两套完全不同的键集合（delimiter `''` vs `'/'`），
       * 共用一份候选集时用户切了范围却拿到另一次搜索的结果 —— 界面上看不出任何异常。
       * 与 R8-11（键丢 kind 命名空间）同型。
       */
      name: '搜索候选集 · keyOf 丢掉 scope（递归与仅当前目录互相命中）',
      file: 'server/search-candidates.js',
      // R21-11 同 list-cache：每段先经 `\u0000` 消毒再拼接，anchor 随之更新。
      anchor: "  return [ident, prefix, scope || ''].map((v) => String(v == null ? '' : v).replace(/\\u0000/g, '')).join(SEP);",
      replacement: "  return [ident, prefix].map((v) => String(v == null ? '' : v).replace(/\\u0000/g, '')).join(SEP);",
      testFile: 'search-candidates.test.js',
      minFail: 1,
    },
    {
      /*
       * `put` 不再先查 tooBig = 超限被丢弃后**还能**重新写入。
       *
       * 此时物化出来的是一段「中间窗口」（从当前页开始）而不是从头开始的连续前缀；
       * 后续请求按「已物化 = 从头连续」的前提去续扫，窗口之前的对象被静默漏掉。
       * 这条同时覆盖静态检查（检查 21 的守卫顺序）。
       */
      name: '搜索候选集 · put 不查 tooBig（物化出中间窗口，续扫静默漏对象）',
      file: 'server/search-candidates.js',
      anchor: '  if (isTooBig(key, now)) return false;',
      replacement: '  if (false) return false;',
      testFile: 'invariants.test.js',
      minFail: 1,
    },
    {
      /*
       * 路由里的桶标识退化成「只有桶名」= 这条判据当初要拦的形态。
       * 用来验证 `cacheKeyViolations` 放宽后（允许 canonical 局部别名）**仍然**抓得住
       * 「看着像标识、其实是桶名」的那种写法。
       */
      name: '搜索候选集 · 桶标识退化为纯桶名（缓存键缺区分维度）',
      file: 'server/routes/fs.js',
      anchor: '    const ident = bucketCacheKey(cfg);',
      replacement: '    const ident = cfg.bucket;',
      testFile: 'invariants.test.js',
      minFail: 1,
    },
    {
      /*
       * 部署脚本（deploy.sh）此前完全没有登记反向对照 —— 它的护栏只在
       * tests/deploy-script.test.js 里，退不回旧实现就等于没验证过。
       * Debian/Ubuntu 的 nginx.conf 顶层就有 include /etc/nginx/modules-enabled/*.conf;
       * （动态模块目录，位于 http{} 之外），而该目录在装了 nginx 的机器上必然存在。
       * 退回「主配置里任意通配 include 目录」的挑法后，站点配置会被写进 modules-enabled，
       * server{} 落在 main 上下文 → nginx -t 报 "server" directive is not allowed here。
       */
      name: 'D1-01 · nginx 站点目录退回「任意通配 include 目录」（Debian 会选中 modules-enabled）',
      file: 'deploy.sh',
      mutations: [
        {
          anchor: '    [[ -n "$d" ]] || continue',
          replacement: '    [[ "$d" == *\'*\'* ]] || continue\n    d="${d%/*}"',
        },
        {
          anchor: '  done < <(nginx_http_include_dirs "$NGINX_CONF_PATH")',
          replacement: "  done < <(grep -oE 'include[[:space:]]+[^;]+;' \"$NGINX_CONF_PATH\" 2>/dev/null | sed -E 's/include[[:space:]]+//; s/;$//; s/^\"//; s/\"$//' || true)",
        },
      ],
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * 值经 stdin 传进 node，本来不需要转义；多包一层「安全转义」会把反斜杠、引号、
       * 制表符变成字面字符写进真实密码 —— 提示成功却登不上，且只有特殊字符才触发。
       */
      name: 'D1-02 · 改管理员凭据退回「先转义再传值」（docker 分支写坏真实密码）',
      file: 'deploy.sh',
      anchor: 'printf \'%s\' "$value" | docker compose run',
      replacement: 'printf \'%s\' "${value//\\\\/\\\\\\\\}" | docker compose run',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * 值若恰好长得像 JSON 字符串字面量（密码就是 "abc123" 连着引号），
       * JSON.parse 会把引号「解码」掉 → 用户拿原密码登不上。
       */
      name: 'D1-03 · 内联脚本退回 JSON.parse 解码（密码长得像 JSON 字面量时被改坏）',
      file: 'deploy.sh',
      anchor: "  const value = input.replace(/\\r?\\n$/, '');",
      replacement: "  let value = input.replace(/\\r?\\n$/, '');\n"
        + "  try { const decoded = JSON.parse(input); if (typeof decoded === 'string') value = decoded; } catch (e) {}",
      testFile: 'deploy-script.test.js',
      minFail: 2,
    },
    {
      /*
       * pkg_install 失败即 die → 它后面的 EPEL 兜底与整段「对症」提示（含 --skip-nginx）
       * 全是死代码；而 RHEL 系 nginx 在 EPEL 里，第一枪打不中是常态。
       */
      name: 'D1-04 · nginx 安装退回会中断的 pkg_install（EPEL 兜底与对症提示成死代码）',
      file: 'deploy.sh',
      anchor: '    pkg_run_pm nginx || true',
      replacement: '    pkg_install nginx',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * 放行「域名:端口」的后果：is_ip_addr 只看到冒号就当成 IP → 静默改自签名证书，
       * server_name 里带端口又让 nginx -t 失败，用户在最难懂的一步卡住。
       */
      name: 'D1-05 · 删掉「域名带端口」校验（静默自签名 + server_name 带端口打挂 nginx -t）',
      file: 'deploy.sh',
      anchor: '  if [[ "$DOMAIN" =~ :[0-9]+$ ]] && [[ "$DOMAIN" != *::* ]]; then\n'
        + '    die "域名里不要带端口：${DOMAIN}（端口请用 --https-port / --http-port 指定，例如：--domain ${DOMAIN%%:*} --https-port ${DOMAIN##*:}）"\n'
        + '  fi',
      replacement: '  : # 「带端口」校验已被反向对照移除',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * 删掉重装前的完整性预检后，安装目录里若躺着一个坏掉的 deploy.sh
       * （最典型：curl 不带 -f 把 14 字节的「404: Not Found」存成了它），
       * exec 出去就是一句「404: line 1: 404:: command not found」—— 用户完全无从下手。
       */
      name: 'D1-06 · 删掉重装前的脚本完整性预检（坏脚本被直接 exec）',
      file: 'deploy.sh',
      anchor: '  if ! head -n1 "$target" | grep -qE \'^#!.*(bash|sh)\\b\' || ! bash -n "$target" 2>/dev/null; then\n'
        + '    die "安装目录内的部署脚本不完整或已损坏：${target}（无法重装，请重新执行一键部署）"\n'
        + '  fi',
      replacement: '  : # 完整性预检已被反向对照移除',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * 一键安装命令退回「裸管道 + 不带 -f」：curl 收到 404 仍返回 0，
       * 会把 14 字节的「404: Not Found」原样存成 deploy.sh；即使带 -f，
       * 管道下 $? 取到的也是右侧 bash 的 0，下载失败会被当成成功。
       * 注意锚点必须落在 README（.md 只剥 HTML 注释）——deploy.sh 里这条命令
       * 整段都是 `#` 注释，纯注释锚点会被不变量检查判为「剥注释后无法验证」。
       */
      name: 'D1-07 · 一键安装命令退回「curl … | sudo bash」（去掉 -f 后 404 会被存成脚本）',
      file: 'README.md',
      anchor: 'curl -fLo /tmp/kepler-deploy.sh https://raw.githubusercontent.com/xingsenfirst/Kepler/main/deploy.sh \\\n'
        + '  && sudo bash /tmp/kepler-deploy.sh --domain cos.example.com',
      replacement: 'curl -fsSL https://raw.githubusercontent.com/xingsenfirst/Kepler/main/deploy.sh | sudo bash -s -- --domain cos.example.com',
      testFile: 'docs-sync.test.js',
      minFail: 1,
    },
    {
      /*
       * 把 git 退回「必需包」：git 混进 pkg_install 后，dnf 一失败就整段 die，
       * prepare_source 里那段「没有 git 也能装（把源码打包上传）」的提示永远执行不到。
       * CentOS/RHEL 8 的模块流过滤恰好会让 git 装不上 —— 用户被卡死在第一步。
       */
      name: 'D1-08 · 基础工具把 git 退回「必需包」（CentOS 8 上装不上即中断）',
      file: 'deploy.sh',
      anchor: '    if ((${#hard_pkgs[@]})); then pkg_install "${hard_pkgs[@]}"; fi\n'
        + '    if ! have git; then pkg_install_opt git || true; fi',
      replacement: '    pkg_install "${to_install[@]}"',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * 删掉「模块流被过滤」诊断分支 → 用户日志掉进通用兜底，只被告知"未能自动识别原因"，
       * 拿不到 dnf module reset/enable 这条真正的修复命令，也不知道"没有 git 也能部署"。
       *
       * （第 19 轮：判据从「本分支自己 grep 日志」收敛为 `pkg_failure_kind` 的**唯一实现点**，
       *   anchor 随之换新形态 —— 原锚点是 `elif grep -qiE 'modular filtering'`，
       *   改判据后它必然腐烂，这正是 invariants 里那条「anchor 必须命中」自检要抓的。）
       */
      name: 'D1-09 · 删掉「模块流被过滤」诊断（CentOS 8 装包失败的诊断退回通用兜底）',
      file: 'deploy.sh',
      anchor: '  elif [[ "$kind" == "modular" ]]; then',
      replacement: '  elif false; then',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * 不再识别「机器上已有 nodejs 与新版互斥」→ Node 装不上的**真原因**被埋掉。
       * 用户真实日志（CentOS Linux 8）里，dnf 明明写了
       *   cannot install both nodejs-2:20.20.2-1nodesource.x86_64 and nodejs-1:16.13.1-3.module_el8…
       * 但脚本只给「三种方式都没装上」的通用指引，用户无从知道要先卸掉系统那份 nodejs。
       * 变异成恒 false：冲突分支不再触发，行为断言（module reset nodejs / remove -y nodejs）全部落空。
       */
      name: 'D1-10 · Node 冲突判据失效（已有 nodejs 互斥的真原因不再被点出）',
      file: 'deploy.sh',
      anchor: '  log_since_mark | grep -qiE \'cannot install both|conflicts? with|obsoletes?|--allowerasing\'',
      replacement: '  return 1',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * 删掉「临时无视 exclude」那条可敲命令 → 用户被 exclude=nginx 挡住时，只被告知去
       * grep 配置、去 ls 面板路径，却没有任何一条能直接执行的命令；日志现象
       * `All matches were filtered out by exclude filtering for argument: nginx` 就此卡死。
       */
      name: 'D1-11 · 删掉 nginx 被 exclude 过滤时的绕开命令（--disableexcludes）',
      file: 'deploy.sh',
      anchor: '          add_hint "    ${PM} install -y --disableexcludes=all nginx"',
      replacement: '          add_hint ""',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * 把锁文件根条目的 devDependencies 掏空 —— 重现「包清单加了依赖、锁文件没跟着更新」。
       * 这正是 CentOS 8 日志里 `npm ci` 每次 EUSAGE 的真因（Missing: eslint@9.39.5 from lock file）：
       * 部署脚本第一枪打的就是 npm ci --omit=dev，锁文件不同步则这一枪**必然**落空，
       * 只能靠兜底 npm install 侥幸装上。锁文件是构建产物，没人会主动看 → 必须由护栏钉住。
       */
      name: 'D1-12 · 锁文件与 package.json 脱同步（npm ci 必然 EUSAGE，只能靠兜底碰运气）',
      file: 'package-lock.json',
      anchor: '      "devDependencies": {\n        "eslint": "^9.0.0"\n      }',
      replacement: '      "devDependencies": {}',
      testFile: 'invariants.test.js',
      minFail: 1,
    },
    {
      /*
       * 让「shell 的 `/*` 不是块注释开头」这条判据失效 → 剥注释再次吞掉大段代码。
       * deploy.sh 的 `[[ "$INSTALL_DIR" == /* ]]`（862 行）、`#  include …/*.conf;`（1396 行）、
       * `"$INSTALL_DIR"/*`（2711 行）会各吞掉 330 / 16 / 85 行，落在里面的反向变异 anchor
       * 永远"未命中" —— 台账全绿，但是假绿。变异后 `每个函数定义都必须还在` 必须变红。
       */
      name: 'D1-13 · 剥注释把 shell 的 /* 当块注释（大段代码从锚点视图里消失）',
      file: 'tests/invariants.test.js',
      anchor: 'function isShellPatternAt(src, i) {',
      replacement: 'function isShellPatternAt(src, i) {\n  return false;\n}\nfunction _deadShellPattern(src, i) {',
      testFile: 'invariants.test.js',
      minFail: 1,
    },
    {
      /*
       * 把 acme.sh 账户目录的推导退回「只按主机名找」——这正是最初写错的那版
       * （用通配符去匹配 ca/ 下一层目录）。acme.sh 的 CA_DIR 是 ca/<host>/<path>/，
       * 账户密钥在**最里层**，只看外层目录永远判成「没注册过」。
       * 后果：每次重跑都强索 EAB（而 acme.sh 早把 EAB 存进 ca.conf），
       * 用户被要求反复去 CA 控制台复制凭据，却怎么填都「还是没注册」。
       */
      name: 'D1-14 · acme.sh 账户目录退回「只按主机名找」（已注册的账户永远判不出来）',
      file: 'deploy.sh',
      anchor: `  printf '%s/ca/%s/%s' "$ACME_HOME" "$host" "$path"`,
      replacement: `  printf '%s/ca/%s' "$ACME_HOME" "$host"`,
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * rerun_cmd 不再脱敏 → 把原始命令行原样回显。用户带 --eab-hmac-key 重跑时，
       * 提示与日志里就会出现明文 HMAC（相当于签发密码），而且会被复制粘贴到处传。
       */
      name: 'D1-15 · 重跑提示不再抹掉 EAB HMAC（明文密钥回显到屏幕与日志）',
      file: 'deploy.sh',
      anchor: '  orig="$(redact_args "$ORIG_ARGS")"  # 原样重跑，但不把 EAB 密钥回显出来',
      replacement: '  orig="$ORIG_ARGS"',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * 去掉「非 LE 一律走 acme.sh」的分流 → 所有 CA 都落到 certbot 通道。
       * CentOS 8 的 certbot 是 1.22（Python 3.6），**不支持 --eab-kid/--eab-hmac-key**，
       * 于是 LiteSSL / ZeroSSL 这类强制 EAB 的 CA 在签发那一步必然失败 ——
       * 而失败又是「回退自签名」的非致命路径，用户只会看到一句「证书签发失败」。
       */
      name: 'D1-16 · 非 LE 的 CA 也交给 certbot（1.22 不支持 EAB，CentOS 8 那类机器必失败）',
      file: 'deploy.sh',
      anchor: '  if [[ "$CA_PROVIDER" != "letsencrypt" ]]; then\n    # 非 LE 一律 acme.sh：certbot 的 EAB 参数在 CentOS 8 那代根本不认',
      replacement: '  if false; then\n    # 非 LE 一律 acme.sh：certbot 的 EAB 参数在 CentOS 8 那代根本不认',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * 去掉 --install-cert → 证书只留在 acme.sh 的私有目录，Nginx 仍指向
       * /etc/kepler/ssl/acme/。表现极隐蔽：首次签发看着成功了（文件在别处也齐全），
       * 但**续期后 Nginx 一直用着旧证书**，直到过期才被发现。
       */
      name: 'D1-17 · 不再 --install-cert（续期只更新 acme.sh 私有目录，Nginx 一直用旧证书）',
      file: 'deploy.sh',
      anchor: '  if ! acme_install_cert "$ACME_CERT_DIR"; then',
      replacement: '  if false; then',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * 把 EAB HMAC 写进部署状态文件。状态文件是 0600 的普通文本，会被备份/同步/贴到群里
       * 排障（README 里就让人备份数据目录）；HMAC 相当于该 CA 的签发密码，泄漏即可冒名签发。
       * 而且这是**多余**的落盘：acme.sh 自己已经把 EAB 存在 ca.conf 里，重跑并不需要它。
       */
      name: 'D1-18 · EAB HMAC 密钥落进部署状态文件（多余且等于明文泄漏签发密码）',
      file: 'deploy.sh',
      anchor: 'EAB_KID=${EAB_KID}"',
      replacement: 'EAB_KID=${EAB_KID}\nEAB_HMAC_KEY=${EAB_HMAC_KEY}"',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * 把「按证书来源区分 HSTS」退回成「一律 max-age=31536000」——正是本轮之前的写法。
       * 后果：正式证书签发失败回退自签名时，浏览器已经记住了该域名的长期 HSTS，
       * 随后对自签名的证书错误不再给「继续访问」入口（提示「此网站使用了 HSTS」），
       * 站点对浏览器**彻底不可达**——回退方案比不回退还糟。
       */
      name: 'D1-19 · 自签名证书也下发长期 HSTS（回退自签名后浏览器锁死，无「继续访问」入口）',
      file: 'deploy.sh',
      anchor: '  if [[ "$cert_fullchain" == "${SELF_SIGNED_DIR}/fullchain.pem" ]]; then\n    hsts_header=\'    add_header Strict-Transport-Security "max-age=0" always;\'\n  else\n    hsts_header=\'    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;\'\n  fi',
      replacement: '  hsts_header=\'    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;\'',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * 去掉 acme.sh 的 gitee 兜底 + 落盘双检，退回 `curl … | sh`（官方安装器从
       * raw.githubusercontent.com 取文件）。国内服务器连不上 GitHub → acme.sh 装不上
       * → 所有需要 EAB 的 CA 全军覆没（certbot 又不支持 EAB），必然回退自签名。
       * 而且管道写法违反 D1-06：下载失败被右侧 sh 吞掉。
       */
      name: 'D1-20 · acme.sh 退回「curl … | sh」且无国内镜像（GitHub 不通时装不上）',
      file: 'deploy.sh',
      anchor: 'install_acme_sh() {',
      replacement: 'install_acme_sh() { bash -c "curl -fsSL https://get.acme.sh | sh -s email=${EMAIL}"; return 0; }\nfunction _dead_install_acme_sh() {',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * 把速率限制判据退回「只认 rate limit / too many / exceeded」，漏掉 acme.sh 实际的
       * 驼峰措辞 rateLimited、Le_OrderFinalize、429。后果：acme.sh 被限流时的日志（
       * error:rateLimited / status 429）匹配不到限流分支，掉进「未能识别」兜底，
       * 用户只看到笼统的「签发失败」。而且原来的分支还排在「连接失败」之后，
       * 429 的日志一旦同时含 timeout/ssl 之类词会被更宽泛的连接判据抢先吞掉，
       * 报成「连不上 CA」——方向全错（429 恰恰说明网络是通的、请求到了 CA）。
       */
      name: 'D1-21 · CA 速率限制（rateLimited/429）判据漏匹配且排到「连接失败」之后',
      file: 'deploy.sh',
      anchor: "elif grep -qiE 'rate ?limit|ratelimited|too many|exceeded|Le_OrderFinalize|429|retry after' <<<\"$tail_log\"; then",
      replacement: "elif grep -qiE 'rate limit|too many|exceeded' <<<\"$tail_log\"; then",
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * 默认 CA 退回 letsencrypt。用户实测在公共后缀域名（*.l.cd）上反复用 LE 被
       * rateLimited(429) 拒签，明确要求「不要再使用 LE」。LE 按「注册域名/公共后缀」
       * 7 天共享约 50 张配额，公共后缀下所有人都挤一个池子，不适合当默认 CA；
       * ZeroSSL 走 HTTP-01、acme.sh 能用 --email 自动换 EAB（零手工），更稳妥。
       */
      name: 'D1-22 · 默认 CA 退回 letsencrypt（公共后缀域名反复 rateLimited）',
      file: 'deploy.sh',
      anchor: 'CA_PROVIDER="zerossl"',
      replacement: 'CA_PROVIDER="letsencrypt"',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * 把 acme_install_cert 退回「拿 run 返回码直接判失败」。宝塔/自编译的 nginx 不是
       * systemd native service（systemctl reload 报 "is not active, cannot reload"），
       * acme.sh 的 --install-cert 会先把 key/fullchain 写进指定路径、之后才跑 --reloadcmd，
       * reload 失败时 acme.sh 返回非零打 "Reload error"，但证书其实已经装好了。
       * 拿返回码判失败 → 误回退自签名，用户看到的是「证书签发失败」而证书其实已到手。
       */
      name: 'D1-23 · acme 证书落盘后仍因 reload 失败误判「安装失败」回退自签名',
      file: 'deploy.sh',
      anchor: '  if ! run "$(acme_bin)" "${args[@]}" </dev/null; then\n'
        + '    warn "acme.sh --install-cert 返回非零（多半是 --reloadcmd 那步失败）；证书可能已落盘，继续核对文件。"\n'
        + '  fi',
      replacement: '  if ! run "$(acme_bin)" "${args[@]}" </dev/null; then return 1; fi',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * 「界面显示 https://localhost:8443/dav/，WebDAV 用不了」两处根因之一：
       * Nginx 站点配置里的 /dav 反代只是一段**注释**（「应用内开启后取消注释」），
       * 于是 https://<域名>/dav/ 根本没人转发 → 404。把 location 行退回注释态即可复现。
       */
      name: 'D2-01 · Nginx 的 /dav 反代退回「注释待手工启用」（界面给的地址必然 404）',
      file: 'deploy.sh',
      anchor: '    location ^~ /dav {',
      replacement: '    # location ^~ /dav {',
      testFile: 'audit16-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * 同一条链路的第二种坏法：反代在、端口写死。用户改 WEBDAV_PORT 后 .env 与 Nginx
       * 各说各话 —— 应用监听 9443、Nginx 转发 8443，界面有地址但连不上。
       * 这是「端口只有一个事实来源」这条契约的反向对照。
       */
      name: 'D2-01 · Nginx 上游端口写死 8443（WEBDAV_PORT 改了也不跟，反代打空）',
      file: 'deploy.sh',
      anchor: '        proxy_pass https://127.0.0.1:${WEBDAV_PORT};',
      replacement: '        proxy_pass https://127.0.0.1:8443;',
      testFile: 'audit16-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * .env 里的 WEBDAV_PORT 写死 8443：应用侧 DEFAULT_PORT 读的是它，
       * 于是「脚本以为的端口」与「应用实际监听的端口」脱节，反代必然打空。
       */
      name: 'D2-03 · .env 的 WEBDAV_PORT 写死 8443（不再跟随环境变量）',
      file: 'deploy.sh',
      anchor: 'WEBDAV_PORT=${WEBDAV_PORT}',
      replacement: 'WEBDAV_PORT=8443',
      testFile: 'audit16-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * serverUrl 退回「只拼监听地址 + 端口」——即故障现场那一版。
       * `.env` 里 HOST=0.0.0.0，于是界面恒显示 https://localhost:8443/dav/。
       * 变异手法：让主路径拿不到请求主机（退化成末档兜底），等价于原来的行为。
       */
      name: 'D2-02 · WebDAV 地址退回「只拼监听地址」（界面恒显示 localhost:8443）',
      file: 'server/webdav-server.js',
      anchor: '  const host = reqHost(req);',
      replacement: "  const host = '';",
      testFile: 'audit16-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * 路由层不把 req 传下去：serverUrl 拿不到请求主机 → 退化成监听地址。
       * 这条最隐蔽 —— 界面照常显示地址、服务照常「运行中」，静态读代码看不出问题。
       */
      name: 'D2-04 · WebDAV 路由不把 req 传给 serverUrl（地址静默退化成监听地址）',
      file: 'server/routes/webdav.js',
      anchor: '    serverUrl: webdav.serverUrl(req),',
      replacement: '    serverUrl: webdav.serverUrl(),',
      testFile: 'audit16-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * 前端兜底退回写死的 `https://<本机IP>:<端口>`：那不是可用地址而是伪地址，
       * 用户照抄必然连不上，且完全看不出问题出在哪。
       */
      name: 'D2-05 · 前端地址兜底退回「写死 <本机IP>:端口」（误导性伪地址）',
      file: 'public/js/syssettings.js',
      anchor: "  const urlEl = document.getElementById('webdav-url');\n"
        + '  if (urlEl) urlEl.textContent = w.serverUrl || (w.enabled ? webdavFallbackUrl(w) : \'—\');',
      replacement: "  const urlEl = document.getElementById('webdav-url');\n"
        + "  if (urlEl) urlEl.textContent = w.serverUrl || (w.enabled ? 'https://<本机IP>:' + w.port + w.mount : '—');",
      testFile: 'audit16-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R17-01：把 ip-guard 的取 IP 退回「只看 socket.remoteAddress」——即故障现场那一版。
       * 默认部署是「Nginx 反代 + TRUST_PROXY=1」，socket 对端恒为 127.0.0.1，
       * 于是守卫判定的永远是回环地址，紧接着被「本机永远放行」短路。
       * 症状是**所有屏蔽规则整体失效而界面一切正常**。
       */
      name: 'R17-01 · ip-guard 取 IP 退回「只看 socket」（反代下恒见 127.0.0.1）',
      file: 'server/ip-guard.js',
      anchor: 'function clientIp(req) {\n  return security.clientIpInfo(req).ip;\n}',
      replacement: "function clientIp(req) {\n  return (req && req.socket && req.socket.remoteAddress) || '';\n}",
      testFile: 'audit17-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R17-01：把「回环豁免」退回**无条件**。此时 TRUST_PROXY=1 下任何人只要发一个
       * `X-Forwarded-For: 127.0.0.1` 就把自己变成「本机」——R17-01 的修复被一个请求头
       * 整条抵消（等价于没修）。这条对照钉的就是「豁免只对 socket 对端成立」。
       */
      name: 'R17-01 · 「本机永远放行」退回无条件（一个 XFF: 127.0.0.1 即重获豁免）',
      file: 'server/ip-guard.js',
      anchor: '  if (!fromForwarded && (ip === \'127.0.0.1\' || ip === \'::1\')) {',
      replacement: "  if (ip === '127.0.0.1' || ip === '::1') {",
      testFile: 'audit17-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R17-02：把 `httpsUrl` 退回「只查协议不查主机」——即报告里的原始实现。
       * 于是 `https://127.0.0.1:8443/gateway.do`、云元数据地址都能通过支付设置校验并存盘，
       * 服务端会带着商户私钥主动出站（`alipayQuery`），并把下载者 302 过去。
       */
      name: 'R17-02 · 支付宝网关地址退回「只查协议」（内网 / 元数据地址被放行）',
      file: 'server/payment-providers.js',
      anchor: '    try {\n      assertSafeEndpoint(v);\n    } catch (e) {\n      return e.message;\n    }\n',
      replacement: '',
      testFile: 'audit17-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R17-03：把「站点对外地址」退回「只查形状」。该值会被拼成 return_url 交给支付
       * 网关，支付完成后由网关把用户浏览器重定向过来 —— 指向外站就是一条经网关背书的
       * 开放重定向（地址栏走的是支付宝 → 攻击者站点）。
       */
      name: 'R17-03 · 「站点对外地址」退回「只查形状」（外站可被当作回跳目标）',
      file: 'server/routes/payment.js',
      anchor: 'if (url && !security.isOwnSiteHost(url, [req.headers.host])) {',
      replacement: 'if (url && false) {',
      testFile: 'audit17-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R17-03 的第二道：`siteUrlFor()` 对**配置值**的兜底校验。保存路径已挡了外站，
       * 但配置可能是旧版本写入或手改的文件 —— 少了这道兜底，展示层会把付款人 302 到外站。
       */
      name: 'R17-03 · siteUrlFor 不再兜底校验配置值（旧配置可把付款人 302 到外站）',
      file: 'server/share-routes.js',
      anchor: "  if (base && !security.isOwnSiteHost(base, [])) base = '';",
      replacement: "  if (false) base = '';",
      testFile: 'audit17-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R17-04：asyncHandler 把抛错「吞掉」而不是交给 next(err)。Express 4 既不接
       * async 抛错、这里又不转交，于是客户端拿不到任何响应 —— 请求永久挂起（转圈），
       * 比 500 更难排查。
       */
      name: 'R17-04 · asyncHandler 吞掉抛错而非 next(err)（请求永久挂起）',
      file: 'server/routes/_shared.js',
      anchor: '    Promise.resolve(fn(req, res, next)).catch(next);',
      replacement: '    Promise.resolve(fn(req, res, next)).catch(() => {});',
      testFile: 'audit17-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R17-04 的第二道：某个公开匿名可达的 async 处理器退回「裸 async」。
       * 静态上少一层包装看不出来，实际效果是这条路径的抛错不再有兜底 ——
       * 正是 8 处清单要钉住的契约。
       */
      name: 'R17-04 · /s/:id/pay 退回裸 async handler（该路径抛错即挂起）',
      file: 'server/share-routes.js',
      anchor: "router.post('/s/:id/pay', asyncHandler(async (req, res) => {",
      replacement: "router.post('/s/:id/pay', async (req, res) => {",
      testFile: 'audit17-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * D3-01（第 18 轮）：把 `acme_issue_skipped` 的退出码判据退回「认不出的码」。
       *
       * acme.sh 的 `RENEW_SKIP=2` 是「证书未到续期时间」的**成功**语义（源码第 93 行
       * `RENEW_SKIP=2`，`issue()` 打印 "Skipping. Next renewal time is: …" 后 `return $RENEW_SKIP`）。
       * 丢掉这个判据后就只剩「措辞」那一层兜底 —— 而现场日志里退出码是被放大到
       * `[错误] 命令执行失败（退出码 2）` 呈现的，用户看到的正是这一行。
       * 后果：`issue_acme_sh` 判签发失败 → `setup_tls` 回退自签名 → 点「重新安装」SSL 掉级。
       */
      name: 'D3-01 · acme_issue_skipped 不再认退出码 2（重装把正式证书降级为自签名）',
      file: 'deploy.sh',
      anchor: '  if ((rc == 2)); then return 0; fi\n',
      replacement: '  if ((rc == 99)); then return 0; fi\n',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * D3-02（第 18 轮）：绕过 `_run_impl` 的「容忍列表」—— 无论调用方声明了什么退出码，
       * 一律打 `[错误] 命令执行失败（退出码 N）`。
       * 现场表现就是「上一行：已存在 ZeroSSL 的 ACME 账户，跳过注册。下一行：[错误] 命令执行失败」，
       * 明明两行说的是同一件正常的事，读起来却像证书坏了。
       */
      name: 'D3-02 · run_allow_rc 的容忍列表失效（被允许的退出码照样打成错误）',
      file: 'deploy.sh',
      anchor: '    if ((tolerated == 0)); then\n',
      replacement: '    if ((1)); then\n',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * D3-03（第 18 轮）：`tls_cert_reusable` 的文件判据退回「存在即算」更狠的一档 ——
       * 直接 `return 0`，等于「有目录就算有证书」。空文件、垃圾内容、缺失的 privkey
       * 全部被判成「可复用」→ 跳过申请 → Nginx 拿一张读不出来的证书起不来，
       * 而「已跳过证书申请」的输出看着一切正常，现场很难往证书上想。
       */
      name: 'D3-03 · tls_cert_reusable 退回「有文件即算可复用」（空/垃圾证书被跳过申请）',
      file: 'deploy.sh',
      anchor: '  [[ -s "${dir}/fullchain.pem" && -s "${dir}/privkey.pem" ]] || return 1\n'
        + '  have openssl || return 1\n',
      replacement: '  return 0\n',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * D3-04（第 18 轮）：`setup_tls` 的 auto|acme 分支退回「无条件申请」（跳过分支失效）。
       * 证书明明装好且在有效期内，重装还是跑去 `--issue`；只要那次申请失败
       * （CA 配额 / 网络 / EAB 任何一项），后面就接 `gen_self_signed` —— 正式证书被降级。
       * 这正是用户报的「重新安装后 SSL 又只能退回自签名」的后半段：
       * 症状的根因是「不该跑的步骤跑了」，而不是「申请本身有 bug」。
       */
      name: 'D3-04 · setup_tls 退回「无条件申请」（已完成步骤被重做，失败即降级）',
      file: 'deploy.sh',
      anchor: '      if [[ "$FORCE_CERT" != "1" ]] && tls_cert_reusable "$ACME_CERT_DIR"; then\n',
      replacement: '      if false; then\n',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * D3-05（第 18 轮）：把 CERT_REUSE_MIN_DAYS 从 30 抬到 365。
       * 分工是「本脚本只负责首次签发 / 补签，续期归 acme.sh 的每日任务（它在到期前
       * 60 天自己续）」。阈值一旦越过 acme.sh 的续期窗口，两边就都不可信：
       * 90 天有效期的证书被判成「不够新」而去重签，而真正的边界含义也随之上移。
       * 阈值是「跳过申请」这件事的**唯一尺度**，尺度错了，跳过与不跳过都失去意义。
       */
      name: 'D3-05 · CERT_REUSE_MIN_DAYS 越过 acme.sh 的续期窗口（两边的分工被打乱）',
      file: 'deploy.sh',
      anchor: 'CERT_REUSE_MIN_DAYS=30\n',
      replacement: 'CERT_REUSE_MIN_DAYS=365\n',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * D3-06（第 19 轮）：`pkg_auto_repair` 的 modular 分支失效 —— 回到「只诊断、不修复」。
       *
       * 这一条钉的是用户的原话：「脚本自动安装 git 失败。这种最基础的操作不应该出问题。」
       * 旧实现**已经能识别**这是模块流问题，却只把 `dnf module reset perl` 打印出来让人去敲；
       * 而 git 走的是**可选**通道，装不上只降级不中断 —— 于是重装时 `prepare_source`
       * 才发现没有 git，整个部署卡在拉源码那一步。
       * 把 case 分支改成一个永不匹配的标签，就等于退回那个「识别了但不作为」的版本。
       */
      name: 'D3-06 · 包装不上时不再自动修模块流（退回「只诊断不修复」，git 仍然装不上）',
      file: 'deploy.sh',
      anchor: '  case "$(pkg_failure_kind "$(log_since_mark)")" in\n    modular)\n',
      replacement: '  case "$(pkg_failure_kind "$(log_since_mark)")" in\n    never_matches)\n',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * D3-07（第 19 轮）：把 `--nobest` 提到判据**之前**（无条件放宽候选版本）。
       *
       * `--nobest` 是 dnf 自己的建议，但它只在「已经确认是模块流不一致」之后才值得用；
       * 无条件先试，就是在没搞清原因的情况下换一个版本装上、把问题推给下一个环节 ——
       * 网络类失败也会去装一个「非最佳版本」的包，并骗过「自动修复没碰系统」这条边界。
       */
      name: 'D3-07 · 自动修复无条件放宽候选版本（--nobest 越过原因判据）',
      file: 'deploy.sh',
      anchor: '  case "$(pkg_failure_kind "$(log_since_mark)")" in\n',
      replacement: '  if pkg_run_pm_nobest "${pkgs[@]}"; then return 0; fi\n'
        + '  case "$(pkg_failure_kind "$(log_since_mark)")" in\n',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * D3-08（第 19 轮）：删掉 failovermethod 的无害警告说明。
       *
       * 现场日志里那 5 行 `Invalid configuration value: failovermethod=…` 是最显眼的东西，
       * 但它**不是**失败原因（旧版 yum 的选项，dnf 不支持）。脚本不主动说清，
       * 用户就会顺着它把排查方向整个搞错 —— 真实故障现场里正是如此。
       */
      name: 'D3-08 · 删除 failovermethod 无害警告说明（用户被最显眼的那几行带偏）',
      file: 'deploy.sh',
      anchor: "  if grep -qiE 'Invalid configuration value.*failovermethod' <<<\"$tail_log\"; then\n",
      replacement: '  if false; then\n',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * D3-09（第 19 轮）：模块名不再验证 —— 直接把包名当模块名去 reset。
       *
       * 报错里给的是**包名**（perl-libs），`module reset` 要的是**模块名**（perl）。
       * 跳过 `module list` 验证就等于把 perl-libs 拿去 reset —— 它根本不是模块，
       * 只会多刷一行错，而真正要复位的 perl 一次都没被动过。
       * 表现：`module reset -y perl-libs` 看着像做了事，git 依旧装不上。
       */
      name: 'D3-09 · 包名被直接当模块名 reset（跳过一次 module list 验证）',
      file: 'deploy.sh',
      anchor: '      if module_exists "$cand"; then mod="$cand"; break; fi\n',
      replacement: '      mod="$cand"; break\n',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * D3-10（第 19 轮）：`pkg_install_opt` 不接自动修复 —— **git 走的正是这条通道**。
       *
       * 只在必需通道里修等于没修：用户看到的「git 装不上」恰好发生在这条可选通道上。
       * 后果与 D3-06 同类，但更隐蔽 —— 必需通道（nginx/nodejs）一切正常，
       * 只有 git 这一条路径悄悄退回「只编号不干活」。
       */
      name: 'D3-10 · 可选通道不接自动修复（git 恰好走的就是这条通道）',
      file: 'deploy.sh',
      anchor: '    if pkg_auto_repair "${pkgs[@]}"; then return 0; fi\n'
        + '    # on_pkg_failure 在「可选」分支里 return 1（表示未装上）。这里是**裸调用**，\n',
      replacement: '    # on_pkg_failure 在「可选」分支里 return 1（表示未装上）。这里是**裸调用**，\n',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * D3-11（第 19 轮）：自动修复里**去掉「绕过模块过滤」这一档**，退回「只 reset/enable」。
       *
       * 用户现场是**全新安装的纯净系统** —— 模块流状态本来就是对的，`module reset perl`
       * 与 `module enable perl:5.26` 全是空转，那台机器上永远修不好。
       * 真正的机制是 RHEL 8 的 module failsafe（按模块的包级过滤清单屏蔽 perl-libs），
       * 只有 `module_hotfixes`（让仓库按包级视图求解）能过。
       */
      name: 'D3-11 · 撤掉「绕过模块过滤」档（纯净系统上 reset/enable 全是空转，git 依旧装不上）',
      file: 'deploy.sh',
      anchor: '          if pkg_run_pm_hotfixes "${pkgs[@]}"; then return 0; fi\n',
      replacement: '',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * D3-12（第 19 轮）：给 `--setopt='*.module_hotfixes=true'` **去掉引号**。
       *
       * 那个 `*` 不引起来会被 shell 当通配符，在当前工作目录里做 glob 展开 ——
       * dnf 收到的是被换成文件名的垃圾参数，而失败信息完全看不出是这个原因。
       * 这是本条修复里最容易被"顺手简化"掉的一个字符。
       *
       * ⚠️ anchor 必须带上 `"${pkgs[@]}"` 这一截才**唯一**：命令原文在 deploy.sh 里出现两次
       * （实现处 + 诊断提示处），只写命令本身会命中首处之外的第二处、或让护栏以为"还在"。
       * 护栏侧对应地断言「**每一处** `--setopt=` 后面都紧跟引号」。
       */
      name: 'D3-12 · --setopt 的通配符丢掉引号（被 shell 展开成文件名，dnf 收到垃圾参数）',
      file: 'deploy.sh',
      anchor: "--setopt='*.module_hotfixes=true' \"${pkgs[@]}\"",
      replacement: '--setopt=*.module_hotfixes=true "${pkgs[@]}"',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * D3-13（第 19 轮）：把「绕过模块过滤」挪到「复位模块流」**之后**。
       *
       * 顺序反了的后果：纯净系统上先去 reset/enable 空转一遍（那是**全局**状态变更，
       * 副作用大且对这个故障无效），再去绕过过滤 —— 结果虽然也可能装上，但用户机器
       * 的模块流已被无谓改过。零副作用的那一档必须在前。
       */
      name: 'D3-13 · 修复档顺序颠倒（先动全局模块流，再试零副作用的绕过过滤）',
      file: 'deploy.sh',
      mutations: [
        {
          anchor: '          if pkg_run_pm_hotfixes "${pkgs[@]}"; then return 0; fi\n',
          replacement: '',
        },
        {
          anchor: '          if pkg_repair_modular_streams "${pkgs[@]}"; then return 0; fi ;;',
          replacement: '          if pkg_repair_modular_streams "${pkgs[@]}"; then return 0; fi\n'
            + '          if pkg_run_pm_hotfixes "${pkgs[@]}"; then return 0; fi ;;',
        },
      ],
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * D3-14（第 19 轮）：失败判据不再认 `modulefailsafe` 这个机制名。
       *
       * 判据只认 `filtered out by modular filtering` 时，日志里出现的是
       * `modulefailsafe` 措辞的那些变体就落进通用兜底 —— 用户拿不到「绕过模块过滤」这条
       * 唯一有效的命令。判据漏一个机制名，整条修复路径就整段失效。
       */
      name: 'D3-14 · 失败判据不认 modulefailsafe（掉进通用兜底，拿不到对症命令）',
      file: 'deploy.sh',
      anchor: '|modulefailsafe|module_hotfixes|requires module\\(|',
      replacement: '|requires module\\(|',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      /*
       * D3-15（第 20 轮）：把证书「内容可用」的判据退回「只看文件字节数」。
       *
       * 两处**一起**退，缺一不可：
       *   ① `cert_file_ok` 里对 subject/issuer「必须有实值」的检查 ——
       *      这才是拦住「字段全空白证书」的那一句；只删其中一行不行，
       *      另一行（issuer）照样把它拦下，变异就等于没做；
       *   ② `tls_cert_reusable` 里对 `cert_file_ok` 的调用 —— 复用判据若只看 `-s`，
       *      一份坏证书会被**每次重装永久复用**，永远修不回来。
       *
       * 两处一起退，红项落在**两个不同用例**上（分工，不是冗余）：
       *   ① 打红第 39 条 —— 守「签发安装时坏证书不得被当成成功」（`cert_file_ok` 里
       *      subject/issuer 的实值检查 + 行为桩 `BLANK_SUBJ=1`）；
       *   ② 打红第 39 条与第 31 条（`tls_cert_reusable 的判据与阈值`）—— 第 39 条管
       *      「三处调用点都在」，第 31 条管「**复用这一处**的内容校验不能被摘掉」。
       * 合计 2 个不同用例，故 `minFail: 2`（本脚手架一次施加全部变异、只取合计 `# fail`，
       * 无法按变异归因）：只退 ① 时只有第 39 条红（=1），到不了 2。
       * 早期第 31 条还没单独断言 `cert_file_ok` 时，退回旧实现只打中第 39 条一个用例、
       * `fail=1` —— 正是这么暴露「复用路径那一半没被独立守着」的。
       */
      name: 'D3-15 · 证书判据退回「只看文件非空」（字段全空白的证书被当成签发成功 / 被永久复用）',
      file: 'deploy.sh',
      mutations: [
        {
          anchor: '  [[ "$s" == subject=* && -n "${s#subject=}" ]] || return 1\n'
            + '  [[ "$i" == issuer=*  && -n "${i#issuer=}"  ]] || return 1\n',
          replacement: '',
        },
        {
          anchor: '  cert_file_ok "${dir}/fullchain.pem" "${dir}/privkey.pem" || return 1\n',
          replacement: '',
        },
      ],
      testFile: 'deploy-script.test.js',
      minFail: 2,
    },
    {
      /*
       * D3-16（第 20 轮）：撤掉 `setup_tls` 收尾的「实际对外提供的是哪份证书」比对。
       *
       * `nginx -t` 只能证明我们写的配置能被解析，证明不了浏览器看到的就是这份证书。
       * 撤掉这一步，「脚本说 ZeroSSL 签发成功、浏览器却说不安全」这种错配就再也
       * 没有任何地方能发现 —— 现场只能靠人去猜，而这一猜就是几十分钟。
       */
      name: 'D3-16 · 撤掉「实际对外提供的证书」收尾比对（浏览器看到的不是这份，脚本仍报成功）',
      file: 'deploy.sh',
      anchor: '  tls_probe_served || true\n',
      replacement: '',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },

    /* ==================================================================
     * 第 21 轮（R21-xx）
     *
     * 每条都断言「退回旧实现后，`tests/audit21-regressions.test.js` 必须变红」。
     * 变异刻意**等效于旧实现的可观测后果**，而不是「把源码搬个位置」：
     *   · R21-01 把门禁判据整体置假（= 旧实现根本没有这道门禁）；
     *   · R21-03 把写入并发上限放到无穷（= 旧实现只有单请求上限）；
     *   · R21-12 撤掉 `redirect: 'manual'`（= 旧实现默认 follow，请求会真的打到 Location）。
     * ================================================================== */
    {
      name: 'R21-01 · 分享下载的加密门禁整体失效（密文对象照样下发明文）',
      file: 'server/share-routes.js',
      anchor: 'function encGateNeeded(l) {\n  if (!l) return false;',
      replacement: 'function encGateNeeded(l) {\n  if (true) return false; // 变异：门禁失效，等价于旧实现没有这道判据',
      testFile: 'audit21-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R21-03 · 流式写入并发上限失效（WebDAV PUT 可无限并发，N×256MB）',
      file: 'server/fs-gateway.js',
      anchor: 'const MAX_WRITE_STREAMS = 2;',
      replacement: 'const MAX_WRITE_STREAMS = Infinity; // 变异：等价于旧实现只有单请求上限',
      testFile: 'audit21-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R21-05 · Windows Hello 失败分支恢复可区分（用户名 oracle 复活）',
      file: 'server/routes/auth.js',
      anchor: "    if (!configStore.isWebauthnEnabled(raw)) return authFail('该账户未启用 Windows Hello');",
      replacement: "    if (!configStore.isWebauthnEnabled(raw)) return res.status(400).json({ error: '该账户未启用 Windows Hello，请使用密码登录' });",
      testFile: 'audit21-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R21-06 · notifyUrl 退回「请求体渠道」（下单走 A、回调地址写 B）',
      file: 'server/share-routes.js',
      anchor: '    notifyUrl: `${base}/pay/notify/${encodeURIComponent(chargePlatform)}`,',
      replacement: '    notifyUrl: `${base}/pay/notify/${encodeURIComponent(platform)}`,',
      testFile: 'audit21-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R21-09 · 自助改密不再校验当前密码（会话劫持即可永久接管账户）',
      file: 'server/routes/users.js',
      anchor: "      const current = String(b.currentPassword == null ? '' : b.currentPassword);",
      replacement: "      const current = 'correct-pw'; // 变异：等价于旧实现完全不校验当前密码",
      testFile: 'audit21-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R21-10 · 撤掉抢锁宽限期（新鲜空锁被当成无主 → 双持有）',
      file: 'server/instance-lock.js',
      anchor: '      if (!cur && !force && lockAgeMs() < LOCK_SHAPE_GRACE_MS) {\n        return { ok: false, stale: false, pid: null };\n      }\n',
      replacement: '',
      testFile: 'audit21-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R21-11 · 列举缓存键不再消毒分隔符（参数可注入 → 进程级串味）',
      file: 'server/list-cache.js',
      anchor: '  return [bucket, prefix, marker, maxKeys, delimiter, kind].map(seg).join(SEP);',
      replacement: '  return [bucket, prefix, marker, maxKeys, delimiter, kind].join(SEP);',
      testFile: 'audit21-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R21-11 · 搜索候选集键不再消毒分隔符（同型串味）',
      file: 'server/search-candidates.js',
      anchor: "  return [ident, prefix, scope || ''].map((v) => String(v == null ? '' : v).replace(/\\u0000/g, '')).join(SEP);",
      replacement: "  return [ident, prefix, scope || ''].join(SEP);",
      testFile: 'audit21-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R21-12 · S3 客户端恢复默认 follow（3xx 被静默跟随到内网地址）',
      file: 'server/s3-client.js',
      anchor: "    const init = { method, headers: signed, redirect: 'manual' };",
      replacement: '    const init = { method, headers: signed };',
      testFile: 'audit21-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R21-12 · 支付网关恢复默认 follow（带商户凭据的请求被打到 Location 指向处）',
      file: 'server/payment-gateway.js',
      anchor: "    const res = await fetch(url, Object.assign({}, init, { signal: ctrl.signal, redirect: 'manual' }));",
      replacement: '    const res = await fetch(url, Object.assign({}, init, { signal: ctrl.signal }));',
      testFile: 'audit21-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R21-13 · HTTPS 跳转目标退回 HOST（Docker 下 301 到 https://0.0.0.0:3443/…）',
      file: 'server/security.js',
      anchor: '  if (!isBindAllHost(local)) return { host: local, fallbackToBindAll: false };\n'
        + '  const dom = configuredSiteHost();\n'
        + '  if (dom) return { host: dom, fallbackToBindAll: false };\n'
        + '  return { host: local, fallbackToBindAll: true };\n',
      replacement: '  return { host: local, fallbackToBindAll: false };\n',
      testFile: 'audit21-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R21-14 · WebDAV 错误响应回显上游原始 message（泄漏请求 ID / 端点 / 密钥片段）',
      file: 'server/webdav-server.js',
      anchor: '  const fromUpstream = !!e && (e.statusCode !== undefined || e.rawMessage !== undefined);\n'
        + "  if (!fromUpstream) return String((e && e.message) || '操作失败，请重试');\n"
        + '  return translateError(e).message;\n',
      replacement: "  return String((e && e.message) || '操作失败，请重试');\n",
      testFile: 'audit21-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R21-15 · 跳过清单版本号漂移（读者无法判断清单对应哪个构建）',
      file: 'SCAN-SKIPLIST.md',
      anchor: '- 项目：`object-manager` v1.2.2',
      replacement: '- 项目：`object-manager` v1.2.0',
      testFile: 'audit21-regressions.test.js',
      minFail: 1,
      /**
       * R22 退役：该清单从未纳入 git（仓库管理决策），R22 复核时已不在工作区 ——
       * 目标文件不存在 ⇒ 变异无法施加，且对应的护栏（`audit21-regressions.test.js`
       * 的 R21-15 用例）已改为「文件缺失即跳过」，撤掉修复与否都不可观测。
       * 退役而非删除：留痕可审计；文件若回归仓库，把本条的 `retired` 去掉即可复活。
       */
      retired: true,
      retiredReason: 'SCAN-SKIPLIST.md 未纳入 git 且已不在工作区，变异无目标、护栏空转；'
        + '对应用例改为「文件缺失即跳过」，撤不撤修复都不可观测，故退役保留留痕。',
    },

    /* ==================== 第 22 轮（R22-01 ~ R22-06） ==================== */

    {
      name: 'R22-01 · Windows Hello 第三支恢复可区分（「用户名存在且已启用二次验证」的 oracle 复活）',
      file: 'server/routes/auth.js',
      anchor: '      return authFail(`验签失败（${r.reason}）`);',
      replacement: '      return res.status(401).json({ error: webauthn.publicReason(r.reason), reason: r.reason });',
      testFile: 'audit22-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R22-02 · 转发头取值不再校验格式（非法串各自成为独立来源 → 限流 / 锁定键随头轮换）',
      file: 'server/security.js',
      anchor: "  return isIpLiteral(first) ? first : '';",
      replacement: '  return first;',
      testFile: 'audit22-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R22-02 · 部署脚本退回追加语义（该头首段 = 客户端原值，IP 守卫与限流按伪造值判定）',
      file: 'deploy.sh',
      anchor: '        proxy_set_header X-Forwarded-For \\$remote_addr;',
      replacement: '        proxy_set_header X-Forwarded-For \\$proxy_add_x_forwarded_for;',
      testFile: 'audit22-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R22-03 · PROPFIND 出口退回裸发上游 message（泄漏请求 ID / 端点 / 密钥片段）',
      file: 'server/webdav-server.js',
      anchor: '      return res.status(207).send(multistatus([propResponse(hrefFor(key), item)]));\n'
        + '    } catch (e) {\n'
        + '      // R22-03：与其余同型 catch 同一口径 —— 上游原始 message 只进服务端日志\n'
        + "      if (!res.headersSent) res.status(e.status || 500).type('text/plain').send(davErrorMessage(e));",
      replacement: '      return res.status(207).send(multistatus([propResponse(hrefFor(key), item)]));\n'
        + '    } catch (e) {\n'
        + '      // R22-03：与其余同型 catch 同一口径 —— 上游原始 message 只进服务端日志\n'
        + "      if (!res.headersSent) res.status(e.status || 500).type('text/plain').send(e.message);",
      testFile: 'audit22-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R22-03 · MKCOL 出口退回裸发上游 message',
      file: 'server/webdav-server.js',
      anchor: '      res.status(201).end();\n'
        + '    } catch (e) {\n'
        + '      // R22-03：MKCOL 同型收口\n'
        + "      if (!res.headersSent) res.status(e.status || 500).type('text/plain').send(davErrorMessage(e));",
      replacement: '      res.status(201).end();\n'
        + '    } catch (e) {\n'
        + '      // R22-03：MKCOL 同型收口\n'
        + "      if (!res.headersSent) res.status(e.status || 500).type('text/plain').send(e.message);",
      testFile: 'audit22-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R22-03 · DELETE 出口退回裸发上游 message',
      file: 'server/webdav-server.js',
      anchor: "        res.status(st === 404 ? 404 : 500).type('text/plain').send(st === 404 ? '404 Not Found' : davErrorMessage(e));",
      replacement: "        res.status(st === 404 ? 404 : 500).type('text/plain').send(st === 404 ? '404 Not Found' : e.message);",
      testFile: 'audit22-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R22-03 · COPY 出口退回裸发上游 message',
      file: 'server/webdav-server.js',
      anchor: '        const out = st === 401 ? 502 : (st >= 400 && st < 500 ? st : 500);\n'
        + "        res.status(out).type('text/plain').send(out === 404 ? '404 Not Found' : davErrorMessage(e));",
      replacement: '        const out = st === 401 ? 502 : (st >= 400 && st < 500 ? st : 500);\n'
        + "        res.status(out).type('text/plain').send(out === 404 ? '404 Not Found' : e.message);",
      testFile: 'audit22-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R22-04 · README 删去「WebDAV 出口不叠加查看密码」的口径（文档又变成含糊承诺）',
      file: 'README.md',
      anchor: '；**WebDAV 挂载（`/dav`）不叠加这道门禁**，它由独立的 Basic 认证与 IP 守卫把关，凭据须由管理员授予。',
      replacement: '。',
      testFile: 'audit22-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R22-05 · README 退回「令牌仅通过 x-enc-token 请求头传递」（与分享页 Cookie 通道矛盾）',
      file: 'README.md',
      anchor: '管理端只从 `x-enc-token` 请求头读取该令牌，分享页另发一枚 `HttpOnly`、`path=/s/` 的 Cookie 复用（不进入 `/api/**`）；',
      replacement: '令牌**仅通过 `x-enc-token` 请求头**传递；',
      testFile: 'audit22-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R22-06 · httpsRedirectHost 注释退回与实现相反的顺序（下轮会被再报一次文档不同步）',
      file: 'server/security.js',
      anchor: '/**\n'
        + ' * R21-13：明文 → HTTPS 跳转目标的**唯一实现点**。\n'
        + ' *\n'
        + ' * 目标选取顺序（R22-06：注释必须与 `:158-168` 的实现**逐项同序**，否则下轮会被\n'
        + ' * 当成「文档不同步」再报一次）：**被允许的请求 Host → 本机 HOST（非通配时）\n'
        + ' * → 配置的站点主/备域名 → 通配回退并告警**。\n'
        + ' *\n'
        + ' * 为什么不直接用 HOST 兜底：`Dockerfile` 里 `HOST=0.0.0.0`（容器必须监听通配地址\n'
        + ' * 才能被外部访问），而 `0.0.0.0` 作为**跳转目标**毫无意义 —— 按 README 的 Docker\n'
        + ' * 快速启动（不注入 `TRUST_PROXY`、不配置站点域名）访问 `http://<服务器>:3000`，\n'
        + ' * 会被 301 到 `https://0.0.0.0:3443/…`（Windows 上根本无法解析）。这不是安全问题，\n'
        + ' * 而是「照文档做即坏」。因此通配绑定地址**不再作为首选兜底**：先看有没有配置站点\n'
        + ' * 域名；都没有时保留原行为并置 `fallbackToBindAll`，由调用方打一条显式告警\n'
        + ' * （保持跳转比默默不跳更可诊断 —— 后者会让人以为 HTTPS 已经就绪，而部署模式下\n'
        + ' * Secure Cookie 其实不会下发）。\n'
        + ' *\n'
        + ' * @param {string} rawHost 请求的 Host 头（可带端口）\n'
        + ' * @returns {{ host: string, fallbackToBindAll: boolean }}\n'
        + ' */\n'
        + 'function httpsRedirectHost(rawHost) {',
      replacement: '/**\n'
        + ' * R21-13：明文 → HTTPS 跳转目标的**唯一实现点**。\n'
        + ' *\n'
        + ' * 目标选取顺序：**被允许的请求 Host → 配置的站点主/备域名 → 本机 HOST**。\n'
        + ' */\n'
        + 'function httpsRedirectHost(rawHost) {',
      testFile: 'audit22-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R23-01：UploadPart 的 ETag 退回「只从响应体解析」。
       * S3 的 UploadPart 成功响应**体为空**、ETag 只在 `ETag` 响应头，故空串会被存进
       * 会话、合并时提交 `<ETag></ETag>` → 云端 InvalidPart：五家 S3 兼容厂商（OSS /
       * OBS / 七牛 / 又拍 / AWS）所有 >8MB 文件在最后一步必失败。
       */
      name: 'R23-01 · 分片上传 ETag 退回「只解析响应体」（S3 兼容厂商大文件合并必失败）',
      file: 'server/s3-client.js',
      anchor: '      // R23-01：必须取 raw 响应 —— ETag 只在响应头（S3 的 UploadPart 响应体为空）\n'
        + '      const { res, body } = await this._send({\n'
        + "        method: 'PUT', bucket, key: params.Key || '',\n"
        + '        query: { partNumber: String(partNumber), uploadId: params.UploadId },\n'
        + '        body: params.Body, contentLength: params.ContentLength,\n'
        + "        streamBody: params.Body && typeof params.Body.pipe === 'function',\n"
        + '      }, { raw: true });\n'
        + '      return { ETag: etagOf(res, body) };',
      replacement: '      const body = await this._send({\n'
        + "        method: 'PUT', bucket, key: params.Key || '',\n"
        + '        query: { partNumber: String(partNumber), uploadId: params.UploadId },\n'
        + '        body: params.Body, contentLength: params.ContentLength,\n'
        + "        streamBody: params.Body && typeof params.Body.pipe === 'function',\n"
        + '      });\n'
        + "      return { ETag: tag(body, 'ETag') };",
      testFile: 's3-client.test.js',
      minFail: 1,
    },
    {
      /**
       * R23-02：落盘失败补偿退回「同步 try/catch + 先清 dirty」。
       * 默认写入器是异步的（`writeJsonAsync`），同步 catch 既抓不到拒绝、也读不到
       * `resolve(false)`；dirty 已清零 → 变更静默丢失且后续 flush / 退出同步写全部跳过。
       */
      name: 'R23-02 · 去抖落盘失败补偿退回「同步 try/catch」（写失败静默丢变更）',
      file: 'server/coalesce.js',
      anchor: '    let ret;\n'
        + '    try {\n'
        + '      ret = write(file, snap);\n'
        + '    } catch (e) {\n'
        + '      markWriteFailed(e); // 同步写入器抛错（如 corrupt 文件拒绝写，或注入的同步假写入器）\n'
        + '      return;\n'
        + '    }\n'
        + '    if (ret && typeof ret.then === \'function\') {\n'
        + '      ret.then((ok) => {\n'
        + '        // 注入的假写入器若 resolve(undefined) 视为成功；只有显式 false / 拒绝算失败。\n'
        + "        if (ok === false) markWriteFailed(new Error('写入器返回失败（false）'));\n"
        + '        else lastError = null;\n'
        + '      }, (e) => markWriteFailed(e));\n'
        + '    } else {\n'
        + '      lastError = null;\n'
        + '    }',
      replacement: '    try {\n'
        + '      write(file, snap);\n'
        + '    } catch (e) {\n'
        + '      console.error(`[coalesce] 排队落盘失败 ${path.basename(file)}: ${(e && e.message) || e}`);\n'
        + '    }',
      testFile: 'audit14-perf.test.js',
      minFail: 2,
    },
    {
      /**
       * R23-04：把 `/fs/search` 从 `apiHandler(...)` 包装退回**未包装的裸 async**。
       * 两步变异（同时改开头与结尾，保证仍是**语法合法**的代码 —— 只删 `try {` 会留下
       * 孤儿 catch、让子进程直接崩在解析阶段，那是「变异不等价」的假红，正是本项目
       * 反复强调要避免的形态）。
       *
       * 退回后该处理器既无包装、也无自带 try/catch → Express 4 不捕获它的 rejection，
       * 抛错即请求永久挂起（既不 500 也不结束）。静态护栏必须报红。
       */
      name: 'R23-04 · 路由处理器退回「未包装的裸 async」（Express 4 下抛错即请求永久挂起）',
      file: 'server/routes/fs.js',
      mutations: [
        {
          anchor: "router.get('/fs/search', apiHandler(async (req, res) => {",
          replacement: "router.get('/fs/search', async (req, res) => {",
        },
        {
          anchor: '      hint: !exhausted ? `该目录下还有未扫描的对象（本轮已扫描 ${scanned} 个），可继续搜索。` : \'\',\n    });\n}));',
          replacement: '      hint: !exhausted ? `该目录下还有未扫描的对象（本轮已扫描 ${scanned} 个），可继续搜索。` : \'\',\n    });\n});',
        },
      ],
      testFile: 'invariants.test.js',
      minFail: 1,
    },
    /* ======================= 第 24 轮（P2 安全加固批次） ======================= */
    {
      /**
       * R24-01：站点对外地址的兜底退回「直接信任请求 Host」。
       * 这是回调劫持的原始形态：付费链接的任意访问者带自定义 Host 即可让
       * `notify_url` / `return_url` 指向自己的域。
       */
      name: 'R24-01 · 支付回调地址退回「直接信任请求 Host」（异步通知被劫持）',
      file: 'server/share-routes.js',
      anchor: "  if (host && security.isOwnSiteHost(host, [])) return (proto + '://' + host).replace(/\\/+$/, '');",
      replacement: "  if (host) return (proto + '://' + host).replace(/\\/+$/, '');",
      testFile: 'audit17-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R24-02：WebAuthn 的 rpId 退回「无条件按请求 Host 推导」。
       * 把域名解析到同一 IP 的钓鱼站于是能完整代理两步登录，防钓鱼属性被抵消。
       */
      name: 'R24-02 · WebAuthn rpId 退回「按请求 Host 推导」（钓鱼站可代理两步登录）',
      file: 'server/routes/_shared.js',
      anchor: '  if (security.IS_DEPLOY && !security.isOwnSiteHost(rpId, []) && !isLoopbackHostname(rpId)) {',
      replacement: '  if (false && security.IS_DEPLOY && !security.isOwnSiteHost(rpId, []) && !isLoopbackHostname(rpId)) {',
      testFile: 'audit17-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R24-03：解密侧退回「只用密文流里的 IV」而不与元数据比对。
       * 重排等长分段时每段自洽、GCM 认证全部通过 → 静默产出被重排的明文。
       */
      name: 'R24-03 · 分段 IV 退回「不与元数据比对」（重排 / 拼接密文静默通过）',
      file: 'server/enc-store.js',
      anchor: "            const wantIv = segs[si] && segs[si].iv ? String(segs[si].iv).toLowerCase() : '';",
      replacement: "            const wantIv = ''; // 退回：只认密文流里的 IV，不与元数据比对",
      testFile: 'crypto-storage.test.js',
      minFail: 1,
    },
    {
      /**
       * R24-06：CSRF 退回「只认自定义头」的单点判据。
       * 该判据依赖「浏览器不让跨站请求伪造自定义头」—— 一旦引入 CORS 或反代补头，
       * 防线静默消失且没有任何症状。
       */
      name: 'R24-06 · CSRF 退回「只认 X-Requested-With」单点判据（跨站来源不再校验）',
      file: 'server/security.js',
      anchor: '  let from = \'\';\n'
        + '  try { from = new URL(src).host; } catch (e) { return false; }\n'
        + '  const want = normalizeHost(String(req.get(\'host\') || \'\'));\n'
        + '  return normalizeHost(from) !== \'\' && normalizeHost(from) === want;',
      replacement: '  return true; // 退回：只认自定义头，不校验来源',
      testFile: 'audit17-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R23-04（棘轮）：在路由里**多复制一份**内联错误响应。
       *
       * 本轮的棘轮护栏（`invariants.test.js` 的 `INLINE_ERROR_COPY_MAX`）只许减不许增，
       * 这条对照把总数从冻结点推高 1 —— 若棘轮失效（判据被改坏 / 上限被悄悄上调），
       * 这里就撤不红。注入的行是**静态注入**（该文件在 `invariants.test.js` 里只被当作
       * 文本读取、从不执行），因此无需保证运行时可达。
       */
      name: 'R23-04（棘轮）· 路由内联错误响应副本数增加 1（收敛点形同虚设）',
      file: 'server/routes/fs.js',
      anchor: '    res.json(payload);\n}));\n',
      replacement: '    const err = e.status ? e : translateError(e); // 棘轮反例：多复制一份\n'
        + '    res.json(payload);\n}));\n',
      testFile: 'invariants.test.js',
      minFail: 1,
    },

    /* ==================== R25 · 负载均衡（按 API Key 的空间配额） ====================
     *
     * 本轮的判据全部集中在「谁被算进用量」与「每个写入入口都真的接了闸门」两件事上。
     * 每条对照对应 `tests/audit25-regressions.test.js` 里**各自**的断言落点 ——
     * 只有这样才能证明「某处闸门被摘掉」会真的变红，而不是被另一处的断言掩盖。
     */
    {
      name: 'R25-01 · 用量聚合只看 credentialId（未绑定密钥的桶被漏算）',
      file: 'server/bucket-stats.js',
      anchor: 'const mine = (cfg.buckets || []).filter((b) => configStore.credentialIdForBucket(cfg, b) === credId);',
      replacement: "const mine = (cfg.buckets || []).filter((b) => (b.credentialId || '') === credId);",
      testFile: 'audit25-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R25-02 · 配额判定不再拒绝（闸门整条失效）',
      file: 'server/bucket-stats.js',
      anchor: 'if (usage.usedBytes + addBytes > usage.quotaBytes) {',
      replacement: 'if (false) {',
      testFile: 'audit25-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R25-03 · 判定不再并入未取样增量（缓存期内可无限超额）',
      file: 'server/bucket-stats.js',
      anchor: 'const pending = Math.max(0, pendingUsageDelta(r.cfg));',
      replacement: 'const pending = 0;',
      testFile: 'audit25-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R25-04 · 咽喉点不再把写入增量喂给配额记账',
      file: 'server/routes/stats.js',
      anchor: '  recordUsageDelta(cfg, delta);\n',
      replacement: '',
      testFile: 'audit25-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R25-05【mkdir】· 新建文件夹不再过配额闸门',
      file: 'server/routes/fs.js',
      // 三处闸门（mkdir / rename / move）的 `await` 行**逐字相同**，仅靠注释行区分时，
      // 注释被 `stripComments` 抹白成等长空格，注释长度一旦相同两条 anchor 就会互相命中
      // （`String.replace` 只替换首处 → 变异打偏 → 假绿）。故 anchor 必须带上紧随其前的
      // **真实代码行**（各不相同），唯一性才由代码而非注释长度决定。
      // R28-02：anchor 改为**纯代码行**（不再夹注释）—— 本轮给每个闸门后面追加了
      // `assertBucketQuota`，夹注释的 anchor 会因为「注释变长」而失配（注释在扫描前
      // 被抹成等长空白，长度一变就命中不了）。代码行本身足以唯一。
      anchor: '    await assertCredentialQuota(cfg.credentialId, { addBytes: 0 });\n'
        + '    const client = getClient(cfg);\n'
        + '    await assertBucketQuota(client, cfg, { addBytes: 0 });',
      replacement: '    const client = getClient(cfg);',
      testFile: 'audit25-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R25-05【simple】· 直传不再过配额闸门',
      file: 'server/routes/fs.js',
      anchor: '    await assertCredentialQuota(cfg.credentialId, { addBytes: req.body.length });',
      replacement: '    void 0;',
      testFile: 'audit25-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R25-05【init】· 分片上传初始化不再过配额闸门',
      file: 'server/routes/fs.js',
      // R28-02：init 的净增量先落到 `netAdd` 变量再进闸门（两处闸门共用同一口径），
      // 故 anchor 随之改为这三行纯代码。
      anchor: '      const netAdd = Math.max(0, size - already);\n'
        + '      await assertCredentialQuota(cfg.credentialId, { addBytes: netAdd });\n'
        + '      await assertBucketQuota(client, cfg, { addBytes: netAdd });',
      replacement: '      const netAdd = Math.max(0, size - already);',
      testFile: 'audit25-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R25-05【rename】· 重命名不再过配额闸门',
      file: 'server/routes/fs.js',
      anchor: '    if (newKey === key) return res.json({ ok: true, unchanged: true });\n\n'
        + '    // R25：重命名是「复制到新键 + 删源键」，同桶内净占用不变 → `addBytes=0`（仅「已超额」时拒绝）\n'
        + '    await assertCredentialQuota(cfg.credentialId, { addBytes: 0 });',
      replacement: '    if (newKey === key) return res.json({ ok: true, unchanged: true });\n\n'
        + '    // R25：（变异）闸门已摘除',
      testFile: 'audit25-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R25-05【move】· 移动不再过配额闸门',
      file: 'server/routes/fs.js',
      anchor: "    if (!paths.length) throw badRequest('未选择要移动的对象');\n"
        + '    // R25：移动同桶内净占用不变 → `addBytes=0`（仅「已超额」时拒绝）\n'
        + '    await assertCredentialQuota(cfg.credentialId, { addBytes: 0 });',
      replacement: "    if (!paths.length) throw badRequest('未选择要移动的对象');\n"
        + '    // R25：（变异）闸门已摘除',
      testFile: 'audit25-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R25-06 · 新建存储桶不再过配额闸门',
      file: 'server/routes/buckets.js',
      anchor: '      await assertCredentialQuota(targetCred, { addBytes: 0 });',
      replacement: '      void 0;',
      testFile: 'audit25-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R25-07【WebDAV PUT·目录】· 不再过配额闸门',
      file: 'server/webdav-server.js',
      // R28-02：同「mkdir」—— anchor 去注释化，靠 8 空格缩进与 MKCOL/COPY 的 6 空格区分
      anchor: '        await bucketStats.assertCredentialQuota(cfg.credentialId, { addBytes: 0 });\n'
        + '        await bucketStats.assertBucketQuota(cos, cfg, { addBytes: 0 });',
      replacement: '        void 0;',
      testFile: 'audit25-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R25-07【WebDAV PUT·文件】· 不再过配额闸门',
      file: 'server/webdav-server.js',
      anchor: '      await bucketStats.assertCredentialQuota(cfg.credentialId, { addBytes: putLen });',
      replacement: '      void 0;',
      testFile: 'audit25-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R25-07【WebDAV MKCOL】· 不再过配额闸门',
      file: 'server/webdav-server.js',
      anchor: "      const dirKey = key.endsWith('/') ? key : key + '/';\n"
        + '      // R25：新建集合是 0 字节对象 → `addBytes=0`\n'
        + '      await bucketStats.assertCredentialQuota(cfg.credentialId, { addBytes: 0 });',
      replacement: "      const dirKey = key.endsWith('/') ? key : key + '/';",
      testFile: 'audit25-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R25-07【WebDAV COPY·MOVE】· 不再过配额闸门',
      file: 'server/webdav-server.js',
      anchor: '      await bucketStats.assertCredentialQuota(cfg.credentialId, { addBytes: 0 });\n'
        + '      await bucketStats.assertBucketQuota(cos, cfg, { addBytes: 0 });\n'
        + '      if (!srcIsDir) {',
      replacement: '      if (!srcIsDir) {',
      testFile: 'audit25-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R25-08 · 前端配额错误码与服务端不一致（弹窗永不触发）',
      file: 'public/js/util.js',
      anchor: "export const QUOTA_EXCEEDED_CODE = 'CREDENTIAL_QUOTA_EXCEEDED';",
      replacement: "export const QUOTA_EXCEEDED_CODE = 'CREDENTIAL_QUOTA_EXCEEDED_TYPO';",
      testFile: 'audit25-regressions.test.js',
      minFail: 1,
    },
    /* ==================== R26 · 新增四家 S3 兼容服务商 ====================
     *
     * 本轮的判据全部落在**厂商差异点**上：R2 的账户 ID 前缀、MinIO 的路径风格、
     * 「地域可留空」的建桶闸门、以及「重新保存不得改写厂商/端点」。
     * 每条对照对应 `tests/audit26-regressions.test.js` 里**各自**的断言落点。
     *
     * ⚠️ 有些差异点由**三处**协同实现（元数据 → 客户端工厂 → 寻址判据），
     * 每一处都单独登记一条 —— 只钉住其中一处时，另外两处被摘掉照旧全绿。
     */
    {
      name: 'R26-01 · 前端展示顺序漏掉新增厂商（与服务端注册表漂移）',
      file: 'public/js/provider-logos.js',
      // R30：Azure 正式接入后 ORDER 变为「又拍云 → Azure → AWS S3」，锚点随之更新；
      // 变异语义不变（删掉一家 → 前端顺序与服务端注册表逐项比对必然错位）。
      anchor: "const ORDER = ['tencent', 'aliyun', 'huawei', 'qiniu', 'upyun', 'azure', 'aws', 'gcs', 'r2', 'minio', 'b2'];",
      replacement: "const ORDER = ['tencent', 'aliyun', 'huawei', 'qiniu', 'upyun', 'aws', 'gcs', 'r2', 'minio', 'b2'];",
      testFile: 'audit26-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R26-01b · 商标图形被换成别的版本（viewBox 与源文件不一致）',
      file: 'public/js/provider-logos.js',
      anchor: "    viewBox: '0 0 2048 1024',",
      replacement: "    viewBox: '0 0 1024 1024',",
      testFile: 'audit26-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R26-02 · R2 端点组装不再幂等（重复保存把域名拼成两层）',
      file: 'server/providers.js',
      anchor: '    if (/^https?:\\/\\//i.test(raw)) return raw;\n'
        + "    const suffix = p.endpointTemplate.replace('{region}', '');\n"
        + "    if (suffix && raw.toLowerCase().endsWith(suffix.toLowerCase())) return 'https://' + raw;",
      replacement: '    if (/^https?:\\/\\//i.test(raw)) return raw;',
      testFile: 'audit26-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R26-03 · R2 回到「地域填主机名中段」的推导路径（拼出 auto.r2... 假域名）',
      file: 'server/providers.js',
      anchor: "  if (p.endpointMode === 'template') return '';\n  if (p.endpointTemplate && region) {",
      replacement: '  if (p.endpointTemplate && region) {',
      testFile: 'audit26-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R26-04a · 地域字符集不再受限（可拼进端点改写主机 / 路径）',
      file: 'server/providers.js',
      anchor: 'const REGION_SAFE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;',
      replacement: 'const REGION_SAFE_RE = /^[\\s\\S]*$/;',
      testFile: 'audit26-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R26-04b · 允许留空的厂商不再补默认地域（空串进入签名串）',
      file: 'server/providers.js',
      anchor: "  const raw = String(region || '').trim() || String(p.defaultRegion || '').trim();",
      replacement: "  const raw = String(region || '').trim();",
      testFile: 'audit26-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R26-05a · MinIO 不再强制路径风格（拼出解析不了的 bucket.<host>）',
      file: 'server/providers.js',
      anchor: '  return resolve(id).forcePathStyle === true;',
      replacement: '  return false;',
      testFile: 'audit26-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R26-05b · 客户端工厂漏传 forcePathStyle（元数据对了但没接上线）',
      file: 'server/cos.js',
      anchor: '    forcePathStyle: providers.forcePathStyle(pid),',
      replacement: '    forcePathStyle: false,',
      testFile: 'audit26-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R26-05c · 寻址判据丢掉 forcePathStyle（唯一的 _virtualHosted 实现）',
      file: 'server/s3-client.js',
      anchor: "    return !this.forcePathStyle && this.basePath === '';",
      replacement: "    return this.basePath === '';",
      testFile: 'audit26-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R26-06a · 「只改备注」的保存把端点一并清空（旧实现的无条件写入）',
      file: 'server/config-store.js',
      anchor: '      exist.endpoint = ep;',
      replacement: '      void 0;',
      testFile: 'audit26-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R26-06b · 重新保存无条件改写厂商（R2 密钥被回落成腾讯云）',
      file: 'server/config-store.js',
      anchor: '    if (explicitProvider) exist.provider = pid;',
      replacement: '    exist.provider = pid;',
      testFile: 'audit26-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R26-06c · 端点组装改用入参厂商（重新保存 R2 时按腾讯云组装 → 账户 ID 送校验被拒）',
      file: 'server/config-store.js',
      anchor: '  const epProvider = explicitProvider || (exist && exist.provider) || pid;',
      replacement: '  const epProvider = pid;',
      testFile: 'audit26-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R26-06d · 不再要求「必填端点」的厂商真的填端点（落库一条永远连不上的密钥）',
      file: 'server/config-store.js',
      anchor: '  if (endpoint || !providers.endpointRequired(pid)) return;',
      replacement: '  return;',
      testFile: 'audit26-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R26-06e · 更新密钥时先落值后校验（被拒绝的更新把内存里的端点改坏）',
      file: 'server/config-store.js',
      anchor: '    assertEndpointProvided(c.provider, nextEndpoint);',
      replacement: '    // 变异：校验挪到落值之后',
      testFile: 'audit26-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R26-07a · 建桶时不再为「地域可留空」的厂商补默认地域（空串落库）',
      file: 'server/routes/buckets.js',
      anchor: "      region = providers.regionFor(effectiveProvider, '');",
      replacement: '      void 0;',
      testFile: 'audit26-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R26-07b · 建桶的地域闸门整体失效（必填厂商也放行空地域）',
      file: 'server/routes/buckets.js',
      anchor: "      return res.status(400).json({ error: '请填写存储桶地域（Region）' });",
      replacement: '      void 0;',
      testFile: 'audit26-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R26-08a · 表单的服务端点栏不再按厂商显隐',
      file: 'public/js/credmgr.js',
      anchor: '    epItem.hidden = !mode;',
      replacement: '    epItem.hidden = false;',
      testFile: 'audit26-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R26-08b · 保存密钥时不再提交服务端点（前端收了值却发不出去）',
      file: 'public/js/credmgr.js',
      anchor: '      await API.addCredential({ provider: pickedProvider, secretId: sid, secretKey: skey, remark, visibleToUsers, endpoint });',
      replacement: '      await API.addCredential({ provider: pickedProvider, secretId: sid, secretKey: skey, remark, visibleToUsers });',
      testFile: 'audit26-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R26-08c · 建桶表单的地域星号不再按厂商隐显（界面说必填、服务端允许留空）',
      file: 'public/js/main.js',
      anchor: '    if (regionReq) regionReq.hidden = prov.regionRequired === false;',
      replacement: '    if (regionReq) regionReq.hidden = false;',
      testFile: 'audit26-regressions.test.js',
      minFail: 1,
    },

    /* ============================================================== *
     * R27 台账补登（外部独立审计 26 条）
     *
     * 第 27 轮当时只加了 tests/audit27-regressions.test.js 的行为护栏，
     * 未登记反向对照 —— 于是「撤掉修复是否真的变红」从未被验证过。
     * 这里按铁律补齐：每条都撤销该轮引入的**判据本身**（而非某个副作用）。
     * ============================================================== */
    {
      name: 'R27-01 · 重命名入口重新引用 explorer 上不存在的成员（对话框不弹、静默无反应）',
      file: 'public/js/ops.js',
      anchor: '    const item = explorer.itemOf(key);',
      replacement: '    const item = explorer.__noSuchMember(key);',
      testFile: 'audit27-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R27-03 · 分享页同源校验退回裸 req.secure（反代 TLS 终结下全部 POST 被自己挡成 403）',
      file: 'server/share-routes.js',
      anchor: '    secure: security.requestIsSecure(req), // R27-03：与上面同一判据（Referer 回退分支同病）',
      replacement: '    secure: req.secure,',
      testFile: 'audit27-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R27-07 · XFF 规范化不再拒绝前导零写法（同一地址得到多个限流键 → 预算可轮换）',
      file: 'server/ip-guard.js',
      anchor: '    if (/(^|\\.)0\\d/.test(s)) return null;',
      replacement: '    void 0;',
      testFile: 'audit27-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R27-09 · 规则目标 `1.2.3.4/` 重新退化成 /0（一条笔误屏蔽全网）',
      file: 'server/ip-guard.js',
      anchor: "    if (prefixPart !== null && prefixPart === '') return null;",
      replacement: '    void 0;',
      testFile: 'audit27-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R27-10 · 畸形百分号编码重新把 ip-guard 打成 500（未认证可达 + 日志刷屏）',
      file: 'server/ip-guard.js',
      anchor: '    try {\n'
        + '      return decodeURIComponent(m[1]);\n'
        + '    } catch (e) {\n'
        + '      return null;\n'
        + '    }',
      replacement: '    return decodeURIComponent(m[1]);',
      testFile: 'audit27-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R27-11 · AES-GCM 在认证通过前就把明文下发（等长错误明文先到客户端）',
      file: 'server/enc-store.js',
      anchor: '            segPlain.push(decipher.update(t)); // R27-11：先攒着，认证通过后再 push',
      replacement: '            this.push(decipher.update(t));',
      testFile: 'audit27-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R27-13 · 主密钥回到「先以默认权限落地再 chmod」（存在同机可读私钥的窗口）',
      file: 'server/config-store.js',
      anchor: "writeAtomicSync(KEY_FILE, key.toString('hex'), { mode: 0o600 })",
      replacement: "writeAtomicSync(KEY_FILE, key.toString('hex'))",
      testFile: 'audit27-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R27-14 · 原子写不再 fsync（断电后 rename 可能先于数据落盘）',
      file: 'server/atomic-write.js',
      anchor: '    fs.fsyncSync(fd);',
      replacement: '    void 0;',
      testFile: 'audit27-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R27-15 · S3 签名路径不再删除点段（含 `.` 段的键必然 SignatureDoesNotMatch）',
      file: 'server/s3-client.js',
      anchor: "    if (seg === '.') continue;",
      replacement: '    void 0;',
      testFile: 'audit27-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R27-20 · 二维码走位不再跳过第 6 列（第 0 列永远拿不到数据位）',
      file: 'server/qrcode.js',
      anchor: '    if (right === 6) right = 5;',
      replacement: '    void 0;',
      testFile: 'audit27-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R27-25 · 端点黑名单比对不再去掉尾点（`localhost.` / 元数据主机名可绕过）',
      file: 'server/endpoint-guard.js',
      anchor: '  const hostKey = normalizeHostForCompare(host); // R27-25：去尾点后再比对黑名单',
      replacement: "  const hostKey = String(host || '').toLowerCase();",
      testFile: 'audit27-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R27-26 · gzip 跳过判据不再小写化（/api/fs/DOWNLOAD 被纳入压缩流程）',
      file: 'server/gzip.js',
      anchor: "  const path = String(req.path || '').toLowerCase();",
      replacement: "  const path = String(req.path || '');",
      testFile: 'audit27-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R27-04/12 · 合并完成不再按实际字节记账（重回客户端在 init 声明的 size）',
      file: 'server/routes/fs.js',
      anchor: '    adjustStorageCache(actualBytes, sessCfg);',
      replacement: '    adjustStorageCache(sess.size, sessCfg);',
      testFile: 'audit27-regressions.test.js',
      minFail: 1,
    },

    /* ============================================================== *
     * R28 台账补登（第二轮独立审计 6 条）
     * ============================================================== */
    {
      name: 'R28-01 · 派生缓存 `_parsed` 重新被一并加密落盘（IPv6 规则重启后永不命中）',
      file: 'server/ip-guard.js',
      anchor: '      delete copy._parsed;',
      replacement: '      void 0;',
      testFile: 'audit28-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R28-02 · /fs/mkdir 的桶级配额闸门被摘除（quotaBytes 退回「只展示、零拦截」）',
      file: 'server/routes/fs.js',
      anchor: '    const client = getClient(cfg);\n'
        + '    await assertBucketQuota(client, cfg, { addBytes: 0 });\n'
        + "    let key = normalizeKey(String((req.body || {}).path || ''));",
      replacement: '    const client = getClient(cfg);\n'
        + "    let key = normalizeKey(String((req.body || {}).path || ''));",
      testFile: 'audit28-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R28-03 · 带 Range 的请求重新进入压缩流程（206 与 Content-Encoding 打架）',
      file: 'server/gzip.js',
      // 本轮的修复是**两层**（`shouldCompress` 按请求头 `Range` 早退 + `end()` 阶段按真实 206 /
      // `Content-Range` 兜底），任何一层单独摘掉都不可观测（另一层仍然拦住）—— 这正是
      // 「纵深防御」的正常形态。故这里用多步变异把**两层一起**退回旧实现，
      // 判据是真实 Range 请求的响应头（audit28 的端到端用例）。
      mutations: [
        { anchor: '  if (req.headers && req.headers.range) return false;', replacement: '  void 0;' },
        {
          anchor: '    const ranged = Number(res.statusCode) === 206 || Boolean(res.getHeader(\'Content-Range\'));',
          replacement: '    const ranged = false;',
        },
      ],
      testFile: 'audit28-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R28-04 · 弱签名判据回到 X509Certificate#signatureAlgorithm（Node 18/20/22 无此属性 → 恒 false）',
      file: 'server/local-cert.js',
      anchor: '    const oid = signatureOidOf(new crypto.X509Certificate(certPem).raw);\n'
        + '    return !oid || WEAK_SIGNATURE_OIDS.has(oid);',
      replacement: "    return /sha1/i.test(String(new crypto.X509Certificate(certPem).signatureAlgorithm || ''));",
      testFile: 'audit28-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R28-04 · 判据函数还在、但读取路径不再调用它（重签分支永远不可达）',
      file: 'server/local-cert.js',
      anchor: '      if (c.key && c.cert && fresh && !isWeakSignature(c.cert)) return c;',
      replacement: '      if (c.key && c.cert && fresh) return c;',
      testFile: 'audit28-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R28-05 · 接管时「先让锁文件消失再放行」（第三实例可趁隙抢到锁）',
      file: 'server/instance-lock.js',
      // 早期实现（R27-21）是「把锁文件 rename 挪走 → 校验 → 建新锁」，R28-05 换成
      // 「抢 O_EXCL 接管标记 → 就地覆写」。这里复现**可观测后果**：接管时把 LOCK_FILE
      // 删掉并直接放行（不抢标记）—— 锁文件在窗口内不存在，第三实例的 wx 创建会成功
      // 并与原持有者形成双持锁（见 audit28 的 R28-05 用例）。
      anchor: "      fs.writeFileSync(TAKEOVER_FILE, payload, { flag: 'wx' });",
      replacement: '      try { fs.unlinkSync(LOCK_FILE); } catch (e) { /* 变异：锁文件已不存在 */ }\n'
        + '      return true;',
      testFile: 'audit28-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R28-06 · unparsable 与「规则命中」文案重新分不清（把人引去找一条不存在的规则）',
      file: 'server/ip-guard.js',
      anchor: "  if (reason === 'unparsable') return '无法识别您的来源地址（反代未按模板转发 X-Forwarded-For，或该值非法），已拒绝访问';",
      replacement: "  if (reason === 'unparsable') return '您的 IP 已被管理员屏蔽';",
      testFile: 'audit28-regressions.test.js',
      minFail: 1,
    },
    /* ============ R29 / R30 / AZ · Azure 接入 + 用户报告问题的修复 ============
     *
     * 第 29 轮（用户报告的两个运行期问题）与第 30 轮（Azure 接入）此前**只写了行为护栏、
     * 没登记变异**（台账停在 233），这里连同第 30 轮缺陷检测（`AZ-01`~`AZ-05`）一并补登。
     *
     * ⚠️ Azure 这一组要绕开两类「改了也全绿」：
     *  ① **假服务的期望值曾与实现同源**（SAS 规范资源一处照抄了客户端的错误形态）——
     *     两侧共享同一假设时，验签只能证明自洽。现在假服务按官方规范写死期望值，
     *     故 AZ-01 的变异是**真的**会红（这也是它当初能骗过 20 条用例的原因）。
     *  ② **纵深防御的各层单独摘掉都不可观测**：块列表的「只发一页」与「按分片号去重」
     *     互为兜底，任一层单独摘掉都不改变可观测结果 → R30-02 按**多步变异**登记
     *     （一起退回旧实现：既多打一次请求，又把同一批分片重复累加）。
     *
     * ⚠️ 补登后逐条实跑，又逼出四处台账自身的问题（判据与修法都写在这里，别再踩）：
     *  ① **变异必须自包含，不能只删一半**：AZ-03 最初只锚到 `if (!this._isGone(e)) throw e;`
     *     那一行，替换后留下一个悬空的 `}` ⇒ 整个测试文件语法错误、以
     *     `not ok 1 - tests\azure-client.test.js`（**文件级**）计入 fail。计数同样是 1，
     *     `fail>=1` 被**巧合满足**而一条行为断言都没跑 —— 与 R7-07（搬源码撞 TDZ）同型。
     *     判据：红的是**用例名**，还是文件本身？只看 `fail>=1` 看不出来，必须看名单。
     *  ② **期望失败数要按实测写**：R30-02 / AZ-05 原本写 `minFail: 2`，实测各只有 1 条用例
     *     能观测（两层防御的另一层在单页 / 同会话场景下无从触发）。写高了会把**正确**的
     *     变异误判成失败，写低了才是真放过。
     *  ③ **护栏可能被注释满足**：R29-02b 首跑 `fail=0`，追下去是 `audit29-regressions.test.js`
     *     的 `src.slice(i, i + 900).includes('App.onConfigChanged(')` —— 而 `toggleBucketEnabled`
     *     上方那段**说明注释里也有同样字样**，真调用被摘掉后注释照旧命中。判据改为只认
     *     代码行（该文件里的 `codeLines()`）后正常变红。**这正是为什么每条护栏都要跑一次
     *     反向变异**：护栏自称覆盖了 N 处，与它真的打在那 N 处上，是两件事。
     */
    {
      name: 'R30-01 · 账户级请求（列容器）被误回退成默认容器（getService 打到 /容器?comp=list）',
      file: 'server/azure-client.js',
      anchor: "      return this.basePath || '/'; // 账户级请求：路径即根",
      replacement: "      return this.basePath + '/' + encodeURIComponent(this.container); // 旧实现：误当成「用默认容器」",
      testFile: 'azure-client.test.js',
      minFail: 1,
    },
    {
      // 多步变异：① 去掉按分片号去重；② 只要响应带游标就再取一次同一页（旧实现的 marker 循环
      // 从未把 marker 送进请求，因此第二圈拿到的还是第一页）—— 合起来正是旧实现的可观测后果：
      // 请求数 +1 且分片被重复累加（实测 [1,2,1,2]）。
      name: 'R30-02 · Get Block List 被写成翻页循环（多打一次请求 + 同一批分片重复累加）',
      file: 'server/azure-client.js',
      mutations: [
        {
          anchor: "        if (!n || seen.has(n)) continue;\n        seen.add(n);",
          replacement: "        if (!n) continue;",
        },
        {
          anchor: "      const { text } = await this._request({\n        method: 'GET', bucket, key, query: { comp: 'blocklist', blocklisttype: 'uncommitted' },\n      });",
          replacement: "      let { text } = await this._request({\n        method: 'GET', bucket, key, query: { comp: 'blocklist', blocklisttype: 'uncommitted' },\n      });\n"
            + "      if (tag(text, 'NextMarker')) { // 旧实现：游标从未进入请求 ⇒ 再取一次仍是同一页\n"
            + "        const again = await this._request({\n          method: 'GET', bucket, key, query: { comp: 'blocklist', blocklisttype: 'uncommitted' },\n        });\n"
            + '        text += again.text;\n      }',
        },
      ],
      testFile: 'azure-client.test.js',
      minFail: 1, // 实测：只有「带游标」那条用例能观测到（无游标时单页，两层防御都无从触发）
    },
    {
      name: 'AZ-01 · SAS 规范资源退回旧形态（缺 /blob 服务名、且用编码后的路径去签）',
      file: 'server/azure-client.js',
      anchor: "      const canonicalizedResource = `/blob/${this.accountName}/${bucket}`\n        + (key ? '/' + String(key) : '');",
      replacement: "      const canonicalizedResource = `/${this.accountName}${path}`;",
      testFile: 'azure-client.test.js',
      minFail: 2,
    },
    {
      name: 'AZ-02 · 复制源 URL 硬编码公有云域名（主权云 / Azurite 下复制必然失败）',
      file: 'server/azure-client.js',
      anchor: "    return `${this.protocol}//${this.host}${this.basePath}${p}`;",
      replacement: "    return `https://${this.accountName}.blob.core.windows.net${p}`;",
      testFile: 'azure-client.test.js',
      minFail: 2,
    },
    {
      name: 'AZ-03 · 单删退回「不存在即报错」（与 S3/COS 及本文件批删口径分叉）',
      file: 'server/azure-client.js',
      // ⚠️ 锚点必须**带上收尾的 `}`**。第一版只锚到 `if (!this._isGone(e)) throw e;` 那一行，
      // 替换后留下一个孤立的 `}` ⇒ 整个 azure-client.test.js 变成语法错误、以
      // `not ok 1 - tests\azure-client.test.js`（文件级）计入 fail —— 计数同样是 1，
      // 「撤掉修复必须变红」被**巧合满足**，而实际上一条行为断言都没跑到。
      // 这正是 R7-07 那类「变异把源码弄成另一件事」的坑（判据：看红的是**用例名**还是文件本身）。
      anchor: "      try {\n        await this._request({ method: 'DELETE', bucket, key });\n      } catch (e) {\n"
        + "        if (!this._isGone(e)) throw e; // 本就不存在 = 已达成删除（与 S3 / COS 的幂等语义一致）\n      }",
      replacement: "      await this._request({ method: 'DELETE', bucket, key });",
      testFile: 'azure-client.test.js',
      minFail: 1,
    },
    {
      // 旧实现用的是一个「宽容解码」助手（非法转义原样保留）。这里把两半都复现出来，
      // 避免变异引入原实现没有的异常路径（那会让"进程因别的原因死掉"混进来）。
      name: 'AZ-04 · 查询值在签名里被重复解码（键名含字面 %XX 时签名与实发不符 ⇒ 403）',
      file: 'server/azure-client.js',
      anchor: "    out += '\\n' + name.toLowerCase() + ':' + value;",
      replacement: "    let decoded;\n    try { decoded = decodeURIComponent(String(value)); } catch (err) { decoded = String(value); }\n"
        + "    out += '\\n' + name.toLowerCase() + ':' + decoded;",
      testFile: 'azure-client.test.js',
      minFail: 1,
    },
    {
      // 旧实现不按会话过滤：Azure 的未提交块挂在目标对象上，他次会话遗留的块照样被当成进度。
      // 判据取「提交结果里出现了外来的那个块」，而不是「块名长什么样」——后者改不动行为。
      name: 'AZ-05 · 块列表不再按会话令牌过滤（采信上一次会话遗留的块）',
      file: 'server/azure-client.js',
      anchor: "        if (blockTokenIn(name) !== own) continue; // 他次会话的遗留块：不认，否则会跳过本应重传的分片",
      replacement: "        // 旧实现不按会话过滤：他次会话的块照样被当成「已落云」的进度",
      testFile: 'azure-client.test.js',
      minFail: 1, // 实测：本文件里只有这条专属用例构造了「他次会话遗留的块」；同会话内续传照旧全绿
    },
    {
      name: 'R29-01a · 上传停滞看门狗被摘掉（服务端不回应就永远停在「上传中」）',
      file: 'public/js/api.js',
      anchor: "    const armWatchdog = () => {\n      clearWatchdog();",
      replacement: "    const armWatchdog = () => {\n      if (UPLOAD_IDLE_MS >= 0) return; // 旧实现：没有任何停滞保护（不 arm 定时器）\n      clearWatchdog();",
      testFile: 'audit29-regressions.test.js',
      minFail: 2,
    },
    {
      name: 'R29-01b · 停滞错误被标成 aborted（本该重试两次变成一次即失败）',
      file: 'public/js/api.js',
      anchor: "        err.stalled = true; // 不设 aborted：让上层按既有的重试策略再试",
      replacement: "        err.stalled = true;\n        err.aborted = true; // 旧实现：标成 aborted ⇒ uploadWithRetry 直接放弃",
      testFile: 'audit29-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R29-01c · 进度条不再封顶 99%（请求体一发完就显示 100%，看起来就是「假死」）',
      file: 'public/js/upload.js',
      anchor: "  t.progress = t.size ? Math.min(99, (t.loaded / t.size) * 100) : 99;",
      replacement: "  t.progress = t.size ? Math.min(100, (t.loaded / t.size) * 100) : 100;",
      testFile: 'audit29-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R29-01d · 丢掉「服务器处理中」相位（字节已发完却仍写「上传中」）',
      file: 'public/js/upload.js',
      anchor: "      if (t.state === 'uploading' && t.phase === 'processing') st[0] = '服务器处理中…';",
      replacement: "      // 旧实现没有「服务器处理中」这一相位",
      testFile: 'audit29-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R29-01e · 上传成功后的界面刷新不再吞异常（业务成功却被改判成「失败」）',
      file: 'public/js/upload.js',
      anchor: "  try { App.refreshStorage && App.refreshStorage(); } catch (e) { /* 立即刷新状态栏存储用量 */ }",
      replacement: "  App.refreshStorage && App.refreshStorage();",
      testFile: 'audit29-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R29-02a · 密钥可见性改完不再刷新全局配置（存储桶弹窗的密钥下拉读的是快照）',
      file: 'public/js/credmgr.js',
      anchor: "    await API.updateCredential(cred.id, { visibleToUsers: want });\n    toast(`该密钥已${want ? '对普通用户可见' : '设为仅管理员可见'}`, { type: 'success' });\n    refresh();\n    App.reloadConfig();",
      replacement: "    await API.updateCredential(cred.id, { visibleToUsers: want });\n    toast(`该密钥已${want ? '对普通用户可见' : '设为仅管理员可见'}`, { type: 'success' });\n    refresh();",
      testFile: 'audit29-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R29-02b · 启停存储桶退回只派发 buckets-changed（侧边栏读的是快照，没人重新取数）',
      file: 'public/js/bucketmgr.js',
      anchor: "    App.onConfigChanged();\n  } catch (e) {\n    toast(`${label}失败：` + e.message, { type: 'error' });",
      replacement: "    window.dispatchEvent(new CustomEvent('buckets-changed'));\n  } catch (e) {\n    toast(`${label}失败：` + e.message, { type: 'error' });",
      testFile: 'audit29-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R29-02c · 清空桶 / 桶内容变动后不再走全局刷新（被删掉的文件仍留在文件列表里）',
      file: 'public/js/bucketmgr.js',
      anchor: "function afterBucketMutated(row) {\n  App.onConfigChanged();\n  if (row && row.active) App.refreshStorage();\n}",
      replacement: "function afterBucketMutated(row) {\n  window.dispatchEvent(new CustomEvent('buckets-changed'));\n  if (row && row.active) { App.refreshStorage(); App.refresh(); }\n}",
      testFile: 'audit29-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R31-01 / R31-02：批量删除的 Content-MD5。
       *
       * 缺陷来源（用户报障）：网页界面删文件，Toast 显示
       * 「删除完成，N 项失败：MissingArgument: Missing Some Required Arguments.」
       *
       * 定位链：`ops.js` → `API.del` → `POST /api/fs/delete` → `deleteMultipleConfirmed`
       * → `s3-client.deleteMultipleObject` → `_send()` 的 `${code}: ${message}`。
       * 报错文案形如 `Name: Message.`，说明**上游**返回了
       * `<Code>MissingArgument</Code><Message>Missing Some Required Arguments.</Message>`
       * —— 项目内四个错误整形点（`cos.translateError`、`davErrorMessage`、
       * `deleteMultipleConfirmed`、`routes/fs.js`）输出的全是中文，故这句原文只可能来自云端。
       *
       * 定位到厂商与缺失项：`DeleteObjects`（`POST /<bucket>?delete`）**必须**带
       * `Content-MD5` —— AWS S3 明确「required for all Multi-Object Delete requests」，
       * 阿里云 OSS 的请求头表把 Content-MD5 标为「是」并示范 `Content-MD5: MD5Value`；
       * 缺失时 OSS 回的就是上面那句**不点明缺什么**的 `MissingArgument`（现实世界同形
       * 报错：lobe-chat#6746「s3 为阿里云的对象存储」，结论同样是补 Content-MD5）。
       * 本项目的 `deleteMultipleObject` 一直只发 `content-type`，故**所有**文件
       * （含刚上传成功的）在任何走该厂商的桶上都删不掉，而同桶列举/上传/下载全正常。
       *
       * 两条变异各自有独立的可观测后果（不是同一条的重复）：
       *  - R31-01 摘掉请求头 → 伪服务回 400 MissingArgument，整批抛错；
       *  - R31-02 把 base64 换成 hex（值不对）→ 伪服务回 400 InvalidDigest。
       *    这条专门证明护栏**校验的是值**而不是「有没有这个头」：只断言 presence
       *    的护栏挡不住「随便写个常量」。
       *
       * 伪服务的期望值按 AWS/OSS 规范写死（自己算 base64(MD5)），**不引用**客户端
       * 的任何片段；并带一条「缺头必须被拒」的自检，避免伪服务形同虚设（第 30 轮
       * SAS 假绿即「期望值与实现同源」）。
       */
      name: 'R31-01a · 批量删除丢掉 Content-MD5（阿里云 OSS 回 MissingArgument，任何文件都删不掉）',
      file: 'server/s3-client.js',
      anchor: "          headers: {\n            'content-type': 'application/xml',\n            'content-md5': md5Base64Of(xmlBuf),\n          },\n          body: xmlBuf,",
      replacement: "          headers: { 'content-type': 'application/xml' },\n          body: xml,",
      testFile: 's3-client.test.js',
      minFail: 1,
    },
    {
      name: 'R31-01b · Content-MD5 用 hex 而非 base64（值不对 → 上游判 InvalidDigest）',
      file: 'server/s3-client.js',
      anchor: "            'content-md5': md5Base64Of(xmlBuf),",
      replacement: "            'content-md5': crypto.createHash('md5').update(xmlBuf).digest('hex'),",
      testFile: 's3-client.test.js',
      minFail: 1,
    },
    {
      /**
       * R31-02 / R31-03：用户报障的第二件事 ——（设置页两张卡片）
       * 「支付设置」「登录验证」填好信息保存成功后，若功能当前是**停用**状态，
       * 应自动把状态置为启用。用户明确的两个前提：
       *  ① 必须是**本次新填了**信息（不能「关了又被自动打开」，否则开关再也关不掉）；
       *  ② 填写的信息必须**符合规则**（凭证完整）；
       * 支付卡片只自动开**总开关**，不动渠道开关。
       *
       * 实现落在两处调用链上：
       *  - `public/js/syssettings.js` 的 `saveCaptchaSettings()`（把 enabled 一并提交，
       *    不额外发请求 ⇒ 不存在「已保存但启用失败」的半途状态）；
       *  - `public/js/paysettings.js` 的 `doSave()`（保存成功后追加一次
       *    `API.setPaymentEnabled(true)`；能否开由服务端 `paymentRules.checkGlobalToggle`
       *    裁定，前端**不复刻**该规则 —— 复刻就成了同一个判据的第二个实现点）。
       *
       * 这三条闸门**每一条都对应一个会红的用例**（不是同一个断言的重复）：
       *  - ② `typedNew`：R31-02b / R31-03a 摘掉后，「没填新信息时保存」那两条用例转红；
       *  - ① 「保存前已是启用态」：R31-02a / R31-03b 摘掉后，可停用性用例转红；
       *  - ③ 「凭证完整」：R31-02c / R31-03c 摘掉后，不完整凭证用例转红。
       * 之所以要三条分立，是因为「护栏覆盖了 N 处」与「它真的打在那 N 处上」是两件事
       * （R29-02b 的 `fail=0`、AZ-03 的「文件级红灯」都栽在这里）。
       *
       * 判据落在**真实调用链**上：测试用桩模块图在 Node 里 import 真实的
       * syssettings.js / paysettings.js，用假 DOM 触发真实的保存点击，
       * 断言「实际提交给服务端的 payload」。只断言源码字样的护栏挡不住
       * 「闸门写反了 / 条件恒真」，也挡不住「自动启用根本没接到保存流程上」。
       */
      name: 'R31-02a · 登录验证自动启用不再要求「保存前是停用」（取消勾选保存也会被强行打开）',
      file: 'public/js/syssettings.js',
      anchor: "  const autoEnable = !checked && !(captchaCfg && captchaCfg.enabled)\n    && typedNew && !!siteKey && hasSecret;",
      replacement: "  const autoEnable = !checked\n    && typedNew && !!siteKey && hasSecret;",
      testFile: 'audit31-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R31-02b · 登录验证自动启用不再要求「本次新填了信息」（只拨开关再保存就被打开）',
      file: 'public/js/syssettings.js',
      anchor: "    && typedNew && !!siteKey && hasSecret;\n  const enabled = checked || autoEnable;",
      replacement: "    && !!siteKey && hasSecret;\n  const enabled = checked || autoEnable;",
      testFile: 'audit31-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R31-02c · 登录验证自动启用不再要求「凭证完整」（只填站点密钥就被启用）',
      file: 'public/js/syssettings.js',
      anchor: "  const autoEnable = !checked && !(captchaCfg && captchaCfg.enabled)\n    && typedNew && !!siteKey && hasSecret;",
      replacement: "  const autoEnable = !checked && !(captchaCfg && captchaCfg.enabled)\n    && typedNew && !!siteKey;",
      testFile: 'audit31-regressions.test.js',
      minFail: 1, // 实测 2（「只填站点密钥」与「早已配好密钥」两条一起红）；取 1 留余量
    },
    {
      name: 'R31-03a · 支付自动启用不再要求「本次新填了信息」（没改任何字段保存也会开总开关）',
      file: 'public/js/paysettings.js',
      anchor: "    if (!globalEnabled && typedNew && r.complete) {",
      replacement: "    if (!globalEnabled && r.complete) {",
      testFile: 'audit31-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R31-03b · 支付自动启用不再要求「总开关处于停用」（已开着也再切一次）',
      file: 'public/js/paysettings.js',
      anchor: "    if (!globalEnabled && typedNew && r.complete) {",
      replacement: "    if (typedNew && r.complete) {",
      testFile: 'audit31-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R31-03c · 支付自动启用不再要求「凭证完整」（半配好就开总开关）',
      file: 'public/js/paysettings.js',
      anchor: "    if (!globalEnabled && typedNew && r.complete) {",
      replacement: "    if (!globalEnabled && typedNew) {",
      testFile: 'audit31-regressions.test.js',
      minFail: 1,
    },
  ];

module.exports = { runCase, CASES };

/* 直接运行时执行下面登记的用例 */
if (require.main === module) {
  // `--only=<片段>` 按 name 过滤，便于单条复核（全量跑一遍耗时较长）
  const onlyArg = process.argv.find((a) => a.startsWith('--only='));
  const only = onlyArg ? onlyArg.slice('--only='.length) : '';
  const matched = only ? CASES.filter((c) => c.name.indexOf(only) >= 0) : CASES;
  if (only && !matched.length) {
    console.error('没有 name 含「' + only + '」的用例');
    process.exit(2);
  }
  /**
   * 退役项**不参与**「撤掉修复必须变红」的判定 —— 它们的变异已被后续轮次的修复
   * 变成不可观测（原因见各自条目上的 `retiredReason`）。但仍然**打印**出来，
   * 退役不是删除：台账里留痕、可审计，且 `invariants.test.js` 会把「退役必须写明
   * 原因」当作硬断言，防止有人用 `retired` 把跑不红的对照项悄悄藏起来。
   */
  const retired = matched.filter((c) => c.retired);
  const cases = matched.filter((c) => !c.retired);
  for (const c of retired) {
    console.log('\n=== ' + c.name + ' ===');
    console.log('  ⏭ 已退役（不再可证伪）：' + (c.retiredReason || '（未写原因！）'));
  }
  if (retired.length) {
    console.log(`\n（另有 ${retired.length} 条已退役，未计入下面的通过判定）`);
  }
  let allOk = true;
  (async () => {
    for (const c of cases) allOk = (await runCase(c)) && allOk;
    process.exit(allOk ? 0 : 1);
  })();
}
