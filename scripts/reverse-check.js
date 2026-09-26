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
  const m = /^# fail (\d+)/m.exec(out);
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
      name: 'R7-03 · WebDAV 删目录不再标记分享链接',
      file: 'server/fs-gateway.js',
      anchor: '        // R7-03：只认**本批确认删除**的 key，绝不按前缀\n        shareStore.markMissingByKeys(cfg.bucket, res.okKeys);',
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
      anchor: '  return [bucket, prefix, marker, maxKeys, delimiter, kind].join(SEP);',
      replacement: '  return [bucket, prefix, marker, maxKeys, delimiter].join(SEP);',
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
      anchor: '    adjustStorageCache(sess.size, sessCfg);',
      replacement: '    adjustStorageCache(sess.size, { bucket: sess.bucket, region: sess.region, provider: sess.provider, credentialId: sess.credentialId });',
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
      name: 'R11-01 · deletePrefix 的「整批 0 成功即停下」退回到只 break 内层 for（跑满 1000 轮）',
      file: 'server/routes/fs.js',
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
      anchor: "  return [ident, prefix, scope || ''].join(SEP);",
      replacement: '  return [ident, prefix].join(SEP);',
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
      anchor: '  if [[ "$DOMAIN" =~ ^[^:]+:[0-9]+$ ]]; then\n'
        + '    die "域名里不要带端口：${DOMAIN}（端口请用 --https-port / --http-port 指定，例如：--domain ${DOMAIN%%:*} --https-port ${DOMAIN##*:}）"\n'
        + '  fi',
      replacement: '',
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
