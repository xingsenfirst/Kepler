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
      // R36：`writeObject` 新增第 7 个参数 `uploader`，Headers 由字面量改成
      // `Object.assign(...)` —— 旧 anchor 不再命中，锚点随重构一起迁移。
      // 变异**只**改「走不走 p()」这一件事：Headers 保持与现实现逐字相同，
      // 否则就变成「顺带把上传者元数据也丢了」的另一处变异，红的原因就不唯一了。
      name: 'R7-06 · fs-gateway 的 putObject 退回「直接回调式调用」（绕过 p()）',
      file: 'server/fs-gateway.js',
      anchor: "  await p(cos, 'putObject', {\n"
        + "    Bucket: cfg.bucket, Region: cfg.region, Key: k,\n"
        + "    Body: body,\n"
        + '    ContentLength: body.length,\n'
        + '    // R36：WebDAV 上传同样记录上传者（属性面板与网页上传看到的是同一份数据）。\n'
        + '    Headers: Object.assign(\n'
        + "      { 'Content-Type': contentType || 'application/octet-stream' },\n"
        + '      uploaderMeta(uploader),\n'
        + '    ),\n'
        + '  });',
      replacement: '  await new Promise((resolve, reject) => {\n'
        + '    cos.putObject({\n'
        + '      Bucket: cfg.bucket, Region: cfg.region, Key: k,\n'
        + '      Body: body,\n'
        + '      ContentLength: body.length,\n'
        + '      Headers: Object.assign(\n'
        + "        { 'Content-Type': contentType || 'application/octet-stream' },\n"
        + '        uploaderMeta(uploader),\n'
        + '      ),\n'
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
      // R34：这两行的挂载点判据由手写 `req.path.startsWith(MOUNT)` 收敛为 `inMount(req.path)`，
      // 锚点**随代码一起迁移**（否则本条会静默失效 —— 脚本只在跑到它时才报「锚点未命中」，
      // 而没人跑就等于没登记）。守的判据不变：head 必须注册在 get 之前。
      anchor: "  app.head('*', (req, res, next) => (inMount(req.path) ? getObject(req, res, true) : next()));\n  app.get('*', (req, res, next) => (inMount(req.path) ? getObject(req, res, false) : next()));",
      replacement: "  app.get('*', (req, res, next) => (inMount(req.path) ? getObject(req, res, false) : next()));\n  app.head('*', (req, res, next) => (inMount(req.path) ? getObject(req, res, true) : next()));",
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
      anchor: '    + "script-src \'self\' https://www.recaptcha.net https://www.gstatic.com https://www.gstatic.cn https://challenges.cloudflare.com; "',
      replacement: '    + "script-src \'self\' https://www.recaptcha.net https://www.gstatic.com https://www.gstatic.cn; "',
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
       *
       * ⚠️ R39 把这段内联判据（shebang + `bash -n`）收敛进了唯一实现点 `script_is_sane()`
       * （与「自我交接」共用同一份），**旧 anchor 随之失效**（本条曾在全量里报「未命中」）。
       * 按纪律「重构挪旧锚点位置时连旧锚点一起迁移」：锚点改指 `reinstall_now` 里那次
       * **委托调用**，变异意图不变 —— 撤掉预检，坏脚本照样被直接 exec。
       */
      name: 'D1-06 · 删掉重装前的脚本完整性预检（坏脚本被直接 exec）',
      file: 'deploy.sh',
      anchor: '  if ! script_is_sane "$target"; then\n'
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
      anchor: "  const autoEnable = !checked && !(captchaCfg && captchaCfg.enabled)\n    && typedNew && !!sel.siteKey && hasSecret;",
      replacement: "  const autoEnable = !checked\n    && typedNew && !!sel.siteKey && hasSecret;",
      testFile: 'audit31-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R31-02b · 登录验证自动启用不再要求「本次新填了信息」（只拨开关再保存就被打开）',
      file: 'public/js/syssettings.js',
      anchor: "    && typedNew && !!sel.siteKey && hasSecret;\n  const enabled = checked || autoEnable;",
      replacement: "    && !!sel.siteKey && hasSecret;\n  const enabled = checked || autoEnable;",
      testFile: 'audit31-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R31-02c · 登录验证自动启用不再要求「凭证完整」（只填站点密钥就被启用）',
      file: 'public/js/syssettings.js',
      anchor: "  const autoEnable = !checked && !(captchaCfg && captchaCfg.enabled)\n    && typedNew && !!sel.siteKey && hasSecret;",
      replacement: "  const autoEnable = !checked && !(captchaCfg && captchaCfg.enabled)\n    && typedNew && !!sel.siteKey;",
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
    {
      /**
       * R32-01 / R32-02：两个新增的批量清理按钮。
       *
       * 需求：① 订单管理加「删除失效订单」（清掉全部**支付失败**的订单）；
       * ② 链接管理加「删除失效链接」（清掉**文件已删除**与**已过期**的链接）。
       *
       * 这一轮最容易做错的地方全都不是「功能有没有写」，而是**边界**：
       *  - 订单那边有个现成的 `isProtected()`，顺手写成「删掉所有可裁流水」就会连
       *    **超出支付窗口的 pending** 一起清 —— 那是「付款者可能正在收银台上」的灰色地带
       *    （R14-03），自动裁剪按容量兜住即可，不该由一次人工点击静默清掉；
       *  - 链接那边「已关闭」（下载次数用尽）是**可逆**状态（调大次数即可复活），
       *    一旦被当成失效删掉就不可逆了；
       *  - 链接管理页**普通用户也能进**，作用域必须靠 `canManage` 隔离，不能照抄
       *    订单那边「反正调用方是管理员」的前提（那边挂了 requireAdmin，这边**不能挂**）；
       *  - 新增的 `DELETE /links/dead` 与既有参数路由 `DELETE /links/:id` 同前缀，
       *    注册顺序反了就会被参数路由吞掉 —— 而路由表里两条路径看起来都在。
       *
       * 九条变异各自瞄准一个独立的落点（`fail>=minFail` 只能说明「有东西红了」，
       * 所以每条的期望都是「至少一条、且必须包含它指名的那个用例」）：
       *  - R32-01a 判据放宽成 `!isProtected` → 超窗 pending 被删；
       *  - R32-01b 去掉 `persist()` → 重启后失效订单整批复活；
       *  - R32-01c 路由丢掉 requireAdmin → 普通用户可批量删流水；
       *  - R32-01d 前端漏接线 → 按钮点了没有任何请求；
       *  - R32-02a 服务端把 exhausted 当失效 → 可逆状态被不可逆地删掉；
       *  - R32-02b 服务端丢掉作用域 → 普通用户越权删别人的链接；
       *  - R32-02c 路由注册在 /links/:id 之后 → dead 被参数路由吞掉；
       *  - R32-02d 前端 DEAD_STATUS 多收 exhausted → 界面承诺的条数与实际删除数不符；
       *  - R32-02e 前端漏接线 → 按钮点了没有任何请求。
       */
      name: 'R32-01a · 删除失效订单的判据放宽成「所有可裁流水」（超窗 pending 被一并清掉）',
      file: 'server/payment-orders.js',
      anchor: "  const victims = all.filter((o) => o.status === 'failed' && !isProtected(o, now));",
      replacement: '  const victims = all.filter((o) => !isProtected(o, now));',
      testFile: 'audit32-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R32-01b · 删除失效订单后不落盘（只改内存，重启后失效订单整批复活）',
      file: 'server/payment-orders.js',
      anchor: '  persist();\n  return victims.length;',
      replacement: '  return victims.length;',
      testFile: 'audit32-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R32-01c · 批量删除订单的路由漏挂 requireAdmin（普通用户可清空订单流水）',
      file: 'server/routes/payment.js',
      anchor: "router.delete('/payment/orders/failed', requireAdmin, (req, res) => {",
      replacement: "router.delete('/payment/orders/failed', (req, res) => {",
      testFile: 'routes-surface.test.js',
      minFail: 1,
    },
    {
      name: 'R32-01d · 前端「删除失效订单」按钮没接上线（点了不发任何请求）',
      file: 'public/js/ordermgr.js',
      anchor: "  const clean = document.getElementById('btn-orders-clean');\n  if (clean) clean.onclick = () => removeFailedOrders();",
      replacement: '  // （按钮未接线）',
      testFile: 'audit32-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R32-02a · 服务端把「已关闭」也当成失效链接删掉（可逆状态被不可逆地清除）',
      file: 'server/share-store.js',
      anchor: "    if (st !== 'deleted' && st !== 'expired') continue;",
      replacement: "    if (st !== 'deleted' && st !== 'expired' && st !== 'exhausted') continue;",
      testFile: 'audit32-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R32-02b · 删除失效链接丢掉作用域判定（普通用户可删别人创建的链接）',
      file: 'server/share-store.js',
      anchor: "    if (!canManage(l, role, username)) continue;\n    links.splice(i, 1);",
      replacement: '    links.splice(i, 1);',
      testFile: 'audit32-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * 顺序类缺陷的**唯一**可观测后果：把注册动作挪到 `DELETE /links/:id` 之后，
       * 路径里的 `dead` 就会被 `:id` 当成链接 id 吞掉。此时路由表里两条路径**都还在**、
       * 「无路由丢失」「路由总数」照样全绿 —— 只有真发请求才暴露。
       * 因此这里用两步变异（先摘掉、再追加到文件末尾）真实还原「注册顺序反了」。
       *
       * 锚点里含 `${who}` 与反引号，故**必须**用双引号字符串书写（模板串会把它当插值）。
       */
      name: 'R32-02c · 失效链接路由注册在 /links/:id 之后（dead 被参数路由吞掉，按钮点了只提示「链接不存在」）',
      file: 'server/routes/links.js',
      mutations: [
        {
          anchor: "router.delete('/links/dead', (req, res) => {\n  const role = roleOf(req);\n  const who = (req.authUser && req.authUser.username) || '';\n  const removed = shareStore.removeDead(role, who);\n  if (removed > 0) {\n    statsStore.addLog({\n      action: 'share.delete',\n      level: 'warn',\n      detail: `「${who}」删除失效分享链接 ${removed} 条（文件已删除 / 已过期）`,\n    });\n  }\n  res.json({ ok: true, removed });\n});\n\n",
          replacement: '',
        },
        {
          anchor: '\nmodule.exports = router;',
          replacement: "\nrouter.delete('/links/dead', (req, res) => {\n  const role = roleOf(req);\n  const who = (req.authUser && req.authUser.username) || '';\n  const removed = shareStore.removeDead(role, who);\n  if (removed > 0) {\n    statsStore.addLog({\n      action: 'share.delete',\n      level: 'warn',\n      detail: `「${who}」删除失效分享链接 ${removed} 条（文件已删除 / 已过期）`,\n    });\n  }\n  res.json({ ok: true, removed });\n});\n\nmodule.exports = router;",
        },
      ],
      testFile: 'routes-surface.test.js',
      minFail: 1,
    },
    {
      name: 'R32-02d · 前端「失效」集合多收「已关闭」（界面承诺删 3 条、服务端只删 2 条）',
      file: 'public/js/share-status.js',
      anchor: "export const DEAD_STATUS = new Set(['deleted', 'expired']);",
      replacement: "export const DEAD_STATUS = new Set(['deleted', 'expired', 'exhausted']);",
      testFile: 'audit32-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R32-02e · 前端「删除失效链接」按钮没接上线（点了不发任何请求）',
      file: 'public/js/linkmgr.js',
      anchor: "  const clean = document.getElementById('btn-links-clean');\n  if (clean) clean.onclick = () => removeDeadLinks();",
      replacement: '  // （按钮未接线）',
      testFile: 'audit32-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R33：用户管理「封禁」功能（管理员封禁他人 + 到期时间 + 解封 + 封禁原因 +
       * 被封者登录时可见原因与解封时间）。
       *
       * 这一轮的落点比上一轮散：**存储判据、路由守卫、登录顺序、前端接线**四处，
       * 每一处都能单独做错，且做错之后的症状都极具误导性：
       *  - 判据里漏掉到期时间 → 封禁永不到期，管理员设的「到期时间」形同虚设；
       *  - 写入后不落盘 → 跑得好好的，重启之后封禁整体消失；
       *  - 漏掉 requireAdmin → 任何登录用户都能封掉管理员；
       *  - 漏掉自封禁保护 → 系统里最后一个管理员能把自己锁在门外，且没人能解开；
       *  - 封禁后不吊销会话 → 被封者拿着旧会话继续读写对象存储最长 30 天；
       *  - **登录判定的顺序反了**（先按用户名判封禁、再验密码）→ 响应差异重新变成
       *    用户名枚举通道，把 R21-05 / R22-01 刚收敛掉的东西又漏开一条；
       *  - 第二步（Windows Hello）回带 banned 的 403 → 同上，还额外多一处；
       *  - 前端把 datetime-local 的裸字符串直接提交 → 跨时区部署时封禁错位若干小时。
       *
       * 十七条各自瞄准一个独立的落点（`fail>=minFail` 只说明「有东西红了」，
       * 所以每条的期望都是「至少一条、且必须包含它指名的那个用例」）。
       */
      name: 'R33-01a · 封禁判据忽略到期时间（管理员设的「到期时间」永不生效）',
      file: 'server/config-store.js',
      anchor: '  const active = Boolean(b.active) && (permanent || t > at);',
      replacement: '  const active = Boolean(b.active);',
      testFile: 'audit33-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R33-01b · 封禁写入后不落盘（重启之后封禁整体消失）',
      file: 'server/config-store.js',
      anchor: "  user.ban = { active: true, reason: text, until: iso };\n  user.updatedAt = new Date().toISOString();\n  persist(cfg);",
      replacement: "  user.ban = { active: true, reason: text, until: iso };\n  user.updatedAt = new Date().toISOString();",
      testFile: 'audit33-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R33-01c · 去掉「到期时间必须晚于当前时间」的校验（写下一条出生即失效的封禁却回 ok）',
      file: 'server/config-store.js',
      anchor: "  if (iso && Date.parse(iso) <= Date.now()) {\n    throw Object.assign(new Error('封禁到期时间必须晚于当前时间'), { status: 400 });\n  }",
      replacement: '',
      testFile: 'audit33-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R33-01d · 去掉「封禁原因必填」的校验（登录页只剩一句没有信息量的"你被封了"）',
      file: 'server/config-store.js',
      anchor: "  if (!text) throw Object.assign(new Error('请填写封禁原因'), { status: 400 });",
      replacement: '',
      testFile: 'audit33-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R33-01e · userView 不再暴露封禁状态（列表与登录页都拿不到状态与原因）',
      file: 'server/config-store.js',
      anchor: '    ban: banInfo(u),\n',
      replacement: '',
      testFile: 'audit33-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R33-02a · 封禁路由漏挂 requireAdmin（任何登录用户都能封掉管理员）',
      file: 'server/routes/users.js',
      anchor: "router.post('/users/:id/ban', requireAdmin, (req, res) => {",
      replacement: "router.post('/users/:id/ban', (req, res) => {",
      // 判据走 audit33（真发 HTTP 断言 403），而不是 routes-surface 的静态清单：
      // 后者守的「mustBeAdmin」机制已由 R32-01c 反向对照过，这里要证的是**行为**。
      testFile: 'audit33-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R33-02b · 去掉自封禁保护（最后一个管理员能把自己锁在门外，且没人能解开）',
      file: 'server/routes/users.js',
      anchor: "    if (target.id === req.authUser.id) {\n      return res.status(400).json({ error: '不能封禁当前登录的账户' });\n    }\n",
      replacement: '',
      testFile: 'audit33-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R33-02c · 封禁后不吊销该用户的会话（被封者拿旧会话继续用最长 30 天）',
      file: 'server/routes/users.js',
      anchor: "    const n = authSession.destroyUserSessions(target.id);\n    statsStore.addLog({\n      action: 'users.ban', level: 'warn',",
      replacement: "    const n = 0;\n    statsStore.addLog({\n      action: 'users.ban', level: 'warn',",
      testFile: 'audit33-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R33-02d · 去掉解封的「当前未被封禁」判据（一个永远成功的解封按钮）',
      file: 'server/routes/users.js',
      anchor: "    if (configStore.banInfo(target).state === 'none') {\n      return res.status(400).json({ error: '该用户当前未被封禁' });\n    }\n",
      replacement: '',
      testFile: 'audit33-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R33-03a · 登录路径不判封禁（被封者凭密码照常进入系统）',
      file: 'server/routes/auth.js',
      anchor: '    const ban = configStore.banInfo(raw);\n    if (ban.active) {',
      replacement: '    const ban = configStore.banInfo(raw);\n    if (ban.active && false) {',
      testFile: 'audit33-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * 顺序类缺陷的可观测后果：封禁判定一旦挪到**密码校验之前**，把密码打错的人
       * 也会先收到「该账户已被封禁 + 原因 + 解封时间」的 403 —— 登录接口于是免费
       * 提供了一条「该用户名存在且已被封禁」的枚举通道。
       *
       * 用两步变异真实还原「把判定挪到前面去」：先摘掉原位置的那段，再插到
       * `authenticateUser` 之前（并按用户名查记录）。锚点含 `${user.username}` 与反引号，
       * 故**必须**用双引号字符串书写（模板串会把 `${}` 当插值）。
       */
      name: 'R33-03b · 封禁判定挪到密码校验之前（密码错也能问出"这个号被封了"→ 用户名枚举）',
      file: 'server/routes/auth.js',
      mutations: [
        {
          anchor: "    const ban = configStore.banInfo(raw);\n    if (ban.active) {\n      statsStore.addLog({\n        action: 'auth.fail', level: 'warn',\n        detail: `被封禁的账户尝试登录（用户名：${user.username}；解封时间：${ban.until || '永久'}）`,\n      });\n      return res.status(403).json({\n        error: '该账户已被封禁',\n        banned: true,\n        reason: ban.reason,\n        until: ban.until,\n      });\n    }\n\n",
          replacement: '',
        },
        {
          anchor: '    const user = await configStore.authenticateUser(username, password);',
          replacement: "    const _earlyBan = configStore.banInfo(configStore.findUserRaw(username));\n    if (_earlyBan.active) {\n      return res.status(403).json({ error: '该账户已被封禁', banned: true, reason: _earlyBan.reason, until: _earlyBan.until });\n    }\n    const user = await configStore.authenticateUser(username, password);",
        },
      ],
      testFile: 'audit33-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R33-03c · 登录第二步回带 banned 的 403（匿名端点重新变成"该号存在且被封"的 oracle）',
      file: 'server/routes/auth.js',
      anchor: "    if (configStore.banInfo(raw).active) return authFail('该账户已被封禁');",
      replacement: "    if (configStore.banInfo(raw).active) return res.status(403).json({ error: '该账户已被封禁', banned: true });",
      testFile: 'audit33-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R33-04a · 前端「封禁」按钮没接上线（点了不弹窗、不发请求）',
      file: 'public/js/syssettings.js',
      anchor: "    } else if (act === 'ban') {\n      btn.onclick = () => showBanForm(user);\n    }",
      replacement: '    }',
      testFile: 'audit33-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R33-04b · 前端「解封」按钮没接上线（点了不发任何请求）',
      file: 'public/js/syssettings.js',
      anchor: "    } else if (act === 'unban') {\n      btn.onclick = () => unbanUser(user);\n    }",
      replacement: '    }',
      testFile: 'audit33-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R33-04c · datetime-local 的裸字符串直接提交（跨时区部署时封禁错位若干小时）',
      file: 'public/js/syssettings.js',
      anchor: '    until = ms;',
      replacement: '    until = raw;',
      testFile: 'audit33-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R33-04d · 登录失败不按 e.banned 分岔（被封者只看到"用户名或密码错误"，反复重试密码）',
      file: 'public/js/main.js',
      anchor: "    showAuthError(e && e.banned ? banNotice(e) : (e.message || '登录失败'));",
      replacement: "    showAuthError(e.message || '登录失败');",
      testFile: 'audit33-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R33-04e · api.js 不把 banned/reason/until 挂回错误对象（登录页拿不到原因与解封时间）',
      file: 'public/js/api.js',
      anchor: "    if (data && data.banned) {\n      err.banned = true;\n      err.reason = data.reason || '';\n      err.until = data.until || '';\n    }\n",
      replacement: '',
      testFile: 'audit33-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R34：WebDAV 根路径挂载失败 —— `OPTIONS /` 答 200 + `DAV: 1`，`PROPFIND /` 却回
       * **HTML 404**，Windows WebClient 于是报「输入的文件夹似乎无效，请选择另一个」。
       *
       * 根因：「路径是否在挂载点内」这一判据**手写在 9 处**，而 `/` 只在部分地方被放行。
       * 八条各自瞄准一个独立落点，做错之后的症状都极具误导性：
       *  - 退回手写前缀 → 根路径重新落进 Express 兜底（报文与真实原因毫无关系）；
       *  - 去掉 `OPTIONS *` 豁免 → 服务级能力探测被边界答成 404，`DAV` 头缺席；
       *  - 把 `inMount` 放宽到整个根命名空间 → 顺手撤销 FUN-06 的边界；
       *  - 前缀剥离退回字符级 → `/davx` 造出「界面看不到、WebDAV 却能读」的幽灵 key `x`；
       *  - 405 兜底退回手写前缀 → `LOCK /` 由 405 退化成 404（客户端以为资源不存在而放弃）；
       *  - 摘掉 `/` 的写保护 → PUT / MKCOL / DELETE 在根路径上**真的动手**。
       */
      name: 'R34-01a · PROPFIND 包装退回手写前缀判据（根路径重新落到 Express 兜底 HTML 404）',
      file: 'server/webdav-server.js',
      anchor: "  app['propfind']('*', (req, res, next) => {\n    if (!inMount(req.path)) return next();",
      replacement: "  app['propfind']('*', (req, res, next) => {\n    if (!req.path.startsWith(MOUNT)) return next();",
      testFile: 'audit34-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R34-01b · 去掉 `OPTIONS *` 的服务级豁免（能力探测被边界答成 404，且没有 DAV 头）',
      file: 'server/webdav-server.js',
      anchor: "    if (req.method === 'OPTIONS' && req.path === '*') return next();\n",
      replacement: '',
      testFile: 'audit34-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R34-01c · inMount 放宽到整个根命名空间（把 FUN-06 的边界一并撤销）',
      file: 'server/webdav-server.js',
      anchor: "  return reqPath === '/' || reqPath === MOUNT || reqPath.indexOf(MOUNT + '/') === 0;",
      replacement: "  return reqPath.charAt(0) === '/';",
      testFile: 'audit34-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R34-01d · 前缀剥离退回字符级 startsWith（`/davx` 产生界面看不到的幽灵 key `x`）',
      file: 'server/webdav-server.js',
      anchor: '  if (pth === MOUNT || pth.indexOf(MOUNT + \'/\') === 0) pth = pth.slice(MOUNT.length);',
      replacement: '  if (pth.indexOf(MOUNT) === 0) pth = pth.slice(MOUNT.length);',
      testFile: 'audit34-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R34-01e · 405 兜底退回手写前缀判据（`LOCK /` 由 405 退化成 Express 默认 404）',
      file: 'server/webdav-server.js',
      anchor: "  app.use((req, res, next) => {\n    if (!inMount(req.path)) return next();\n    const m = String(req.method || '').toUpperCase();\n    if (WEBDAV_METHODS.has(m)) return next();",
      replacement: "  app.use((req, res, next) => {\n    if (!req.path.startsWith(MOUNT)) return next();\n    const m = String(req.method || '').toUpperCase();\n    if (WEBDAV_METHODS.has(m)) return next();",
      testFile: 'audit34-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R34-01f · 摘掉 MKCOL 的根路径写保护（`MKCOL /` 从 409 变成真的建集合）',
      file: 'server/webdav-server.js',
      anchor: '      const key = reqPathToKey(req.path);\n      if (!key) return res.status(409).end();',
      replacement: '      const key = reqPathToKey(req.path);',
      testFile: 'audit34-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R34-01g · 摘掉 PUT 的根路径写保护（`PUT /` 不再回 409）',
      file: 'server/webdav-server.js',
      anchor: "      if (!key) return res.status(409).type('text/plain').send('409 Conflict：无法上传到根路径');",
      replacement: '',
      testFile: 'audit34-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R34-01h · 摘掉 DELETE 的根路径写保护（`DELETE /` 不再回 403）',
      file: 'server/webdav-server.js',
      anchor: "      if (!key) return res.status(403).type('text/plain').send('403：禁止删除存储桶根');",
      replacement: '',
      testFile: 'audit34-regressions.test.js',
      minFail: 1,
    },
    {
      /**
       * R34（其二）：「关于」卡片「检查更新」。
       *
       * 这一轮的落点分散在**纯函数 / 路由 / 文案 / DOM 接线**四处，每处都能单独做错，
       * 且症状都很误导：
       *  - 版本比较按**字符串**比 → `1.10.0` 被判成小于 `1.9.9`，升级提示永远发不出来；
       *  - 无法解析时返回 0（相等）而不是 null → 一个不合规的 tag 被当成「已是最新」，
       *    功能看着正常，用户永远收不到提示；
       *  - `/update/check` 误挂 requireAdmin → 「关于」是唯一对普通用户可见的卡片，
       *    普通用户一点就 403；
       *  - 按钮没接线 → 点了毫无反应；
       *  - 去掉缓存 → 未认证的 GitHub API 只有 60 次/小时，连点几下就打光额度，
       *    之后所有人都只能看到「检查更新失败」。
       */
      name: 'R34-02a · updateNotice 分支写反（有新版本却提示"当前已是最新版本"）',
      file: 'public/js/util.js',
      anchor: '  if (r.hasUpdate) {',
      replacement: '  if (!r.hasUpdate) {',
      testFile: 'audit34-update.test.js',
      minFail: 1,
    },
    {
      name: 'R34-02b · 版本号无法解析时返回 0（不合规的 tag 被当成"已是最新"，静默失效）',
      file: 'server/update-check.js',
      anchor: '  if (!x || !y) return null;',
      replacement: '  if (!x || !y) return 0;',
      testFile: 'audit34-update.test.js',
      minFail: 1,
    },
    {
      name: 'R34-02c · /update/check 误挂 requireAdmin（普通用户的按钮一点就 403）',
      file: 'server/routes/stats.js',
      anchor: "router.get('/update/check', asyncHandler(async (req, res) => {",
      replacement: "router.get('/update/check', requireAdmin, asyncHandler(async (req, res) => {",
      testFile: 'audit34-update.test.js',
      minFail: 1,
    },
    {
      name: 'R34-02d · 前端「检查更新」按钮没接上线（点了没有任何反应）',
      file: 'public/js/syssettings.js',
      anchor: '  if (btnUpdate) btnUpdate.onclick = checkUpdate;',
      replacement: '  if (btnUpdate) btnUpdate.onclick = null;',
      testFile: 'audit34-update.test.js',
      minFail: 1,
    },
    {
      name: 'R34-02e · 去掉 10 分钟结果缓存（连点按钮打光 GitHub 未认证额度）',
      file: 'server/update-check.js',
      anchor: '  if (!force && cache.value && (Date.now() - cache.at) < CACHE_MS) {',
      replacement: '  if (false) {',
      testFile: 'audit34-update.test.js',
      minFail: 1,
    },
    {
      name: 'R34-02f · 来源回退失效：某一级失败就整次报错（Release 不存在时功能直接不可用）',
      file: 'server/update-check.js',
      anchor: '      failures.push(`${src.key}：${(e && e.message) || e}`);\n      continue;',
      replacement: '      failures.push(`${src.key}：${(e && e.message) || e}`);\n      break;',
      testFile: 'audit34-update.test.js',
      minFail: 1,
    },
    {
      name: 'R34-02g · 号不可解析时直接当"已是最新"返回（换来源的兜底被摘掉）',
      file: 'server/update-check.js',
      anchor: '      continue; // 换下一个来源 —— 一个不合规的 tag 不该让整次检查失败',
      replacement: '      return Object.assign({}, { latest: raw, hasUpdate: false, url: RELEASES_PAGE, source: src.key }, { current: cur });',
      testFile: 'audit34-update.test.js',
      minFail: 1,
    },
    {
      name: 'R34-02h · 前端沙箱的 util 桩缺一个导出（ESM 链接期报错 → 9 条无关用例整片变红）',
      file: 'tests/audit31-regressions.test.js',
      anchor: "export const updateNotice = (r) => (r && r.hasUpdate ? '有新版本' : '当前已是最新版本。');",
      replacement: '',
      testFile: 'audit34-update.test.js',
      minFail: 1,
    },

    /* ---------------- R35 · 用户管理：10 条预览 + 「显示全部」对话框 ---------------- */
    {
      name: 'R35-01a · 卡片不再截断（11 位用户全渲染 → 「最多展示 10 个」名存实亡）',
      file: 'public/js/syssettings.js',
      anchor: '  const shown = users.slice(0, USER_PREVIEW_LIMIT);',
      replacement: '  const shown = users;',
      testFile: 'audit35-regressions.test.js',
      minFail: 1,
    },
    {
      // R36：判据下沉到 `util.previewMoreState()`（四张卡片共用），锚点随之迁到
      // 那个**唯一实现点**上 —— 变异仍只改「严格大于 vs 大于等于」这一件事。
      name: 'R35-01b · 「显示全部」判据写成 >=（正好 10 位也摆出按钮，点开是与卡片一字不差的副本）',
      file: 'public/js/util.js',
      anchor: '  const over = total > limit;',
      replacement: '  const over = total >= limit;',
      testFile: 'audit35-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R35-01c · 「显示全部」永久隐藏（超过 10 位也出不来按钮 → 后 40 个用户无从管理）',
      file: 'public/js/syssettings.js',
      anchor: '  if (more) more.hidden = !over;',
      replacement: '  if (more) more.hidden = true;',
      testFile: 'audit35-regressions.test.js',
      minFail: 1,
    },
    {
      // R36：对话框改为「只提供数据 + 行渲染回调」，截断动作改在行渲染里复现
      // （`rowHtml` 收到的是**已过滤的完整列表**，切片到 10 就等价于旧 bug）。
      name: 'R35-01d · 对话框也按 10 条截断（「显示全部」里仍然看不全）',
      file: 'public/js/syssettings.js',
      anchor: '    rowHtml: (shown) => userTableHtml(shown, currentId),',
      replacement: '    rowHtml: (shown) => userTableHtml(shown.slice(0, USER_PREVIEW_LIMIT), currentId),',
      testFile: 'audit35-regressions.test.js',
      minFail: 1,
    },
    {
      // R36：搜索框接线移入 `listdialog.js`（四张卡片共用）—— 锚点随之下沉，
      // 变异仍是「干脆不接线」。
      name: 'R35-01e · 搜索框不接线（弹窗里那个输入框输什么都没反应）',
      file: 'public/js/listdialog.js',
      anchor: '  search.oninput = () => { state.query = search.value; repaint(); };',
      replacement: '',
      testFile: 'audit35-regressions.test.js',
      minFail: 2,
    },
    {
      name: 'R35-01f · 搜索改成大小写敏感（`ali` 查不到 `Alice`）',
      file: 'public/js/util.js',
      anchor: "  const q = String(query == null ? '' : query).trim().toLowerCase();",
      replacement: "  const q = String(query == null ? '' : query).trim();",
      testFile: 'audit35-regressions.test.js',
      minFail: 2,
    },
    {
      // R36：`filterUsersByName()` 的空串短路下沉到 `matchesQuery()`（四张卡片共用
      // 同一条关键词规则）—— 锚点随之迁到那里；变异仍是「空关键词谁都匹配不上」，
      // 表现为搜索框一清空整个列表白屏。
      name: 'R35-01g · 空关键词返回空数组（搜索框一清空、整个列表就白屏）',
      file: 'public/js/util.js',
      anchor: '  if (!q) return true;',
      replacement: '  if (!q) return false;',
      testFile: 'audit35-regressions.test.js',
      minFail: 2,
    },
    {
      // R36：行按钮绑定改由 `listdialog.js` 统一调用卡片传入的 `bindRows()` ——
      // 锚点下沉，变异仍是「渲染了行、却不绑按钮」（看得见、点不动）。
      name: 'R35-01h · 对话框里的行不绑按钮（看得见、点不动）',
      file: 'public/js/listdialog.js',
      anchor: '    if (o.bindRows) o.bindRows(list, shown);',
      replacement: '',
      testFile: 'audit35-regressions.test.js',
      minFail: 2,
    },
    {
      name: 'R35-01i · 卡片刷新后不重绘对话框（在对话框里删掉的人继续留在对话框里）',
      file: 'public/js/syssettings.js',
      anchor: '  updateUserMore(users.length);\n  repaintAllUsers(); // 对话框开着时同步刷新：删/封/改名之后两边必须一致',
      replacement: '  updateUserMore(users.length);',
      testFile: 'audit35-regressions.test.js',
      minFail: 1,
    },
    {
      // R36：`clearUserDom()` 改调 `usersDialog.close()` 关窗，但**显式清空容器**这一步
      // 仍然必须保留（关闭只是把弹窗从 #modal-root 移除，容器节点里的用户名 / 角色 /
      // 封禁原因不会自己消失）。锚点即这两行，变异把它们去掉。
      name: 'R35-01j · 登出不清理对话框（换账号后上一个账号的用户列表仍留在 DOM 里）',
      file: 'public/js/syssettings.js',
      anchor: "  const allList = document.getElementById('user-all-body');\n  if (allList) allList.innerHTML = '';",
      replacement: '',
      testFile: 'audit35-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R35-01k · 关闭弹窗时不复位状态（第二次点「显示全部」再也打不开）',
      file: 'public/js/syssettings.js',
      anchor: '    onClose: () => { usersDialog = null; },',
      replacement: '    onClose: () => {},',
      testFile: 'audit35-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R35-01l · 去掉 `.list-more[hidden]` 规则（容器是 display:flex，hidden 属性彻底失效 → 按钮一直露着）',
      file: 'public/css/style.css',
      anchor: '.list-more[hidden] { display: none; }\n',
      replacement: '',
      testFile: 'audit35-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R35-01m · 滚动容器去掉高度上限与 overflow（对话框再也滚不动，长列表把弹窗撑爆）',
      file: 'public/css/style.css',
      anchor: '  max-height: min(54vh, 460px); overflow: auto; border: 1px solid var(--border);',
      replacement: '  border: 1px solid var(--border);',
      testFile: 'audit35-regressions.test.js',
      minFail: 1,
    },
    {
      // R36：对话框不再自己渲染表格（改调卡片传入的 `rowHtml`），故把「另抄一份表头」
      // 复现为在 `rowHtml` 里额外拼一段表头 —— 静态断言数 `syssettings.js` 里
      // `<th>用户名</th>` 的出现次数，凭空多一份即变红（两处迟早分叉）。
      name: 'R35-01n · 对话框里另抄一份表格表头（用户表格出现两份 → 两处迟早分叉）',
      file: 'public/js/syssettings.js',
      anchor: '    rowHtml: (shown) => userTableHtml(shown, currentId),',
      replacement: "    rowHtml: (shown) => '<table class=\"lk-table user-tbl\"><thead><tr><th>用户名</th></tr></thead><tbody></tbody></table>'"
        + ' + userTableHtml(shown, currentId),',
      testFile: 'audit35-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R35-01o · 去掉「仅管理员」守卫（普通用户也能打开全部用户对话框）',
      file: 'public/js/syssettings.js',
      anchor: 'function showAllUsers() {\n  if (!canManageUsers()) return;',
      replacement: 'function showAllUsers() {',
      testFile: 'audit35-regressions.test.js',
      minFail: 1,
    },
    {
      // R36：`filterUsersByName()` 改为委托 `matchesQuery()` 之后，「空关键词返回入参本体」
      // **不再是单步变异能复现的** —— `.filter()` 本身就会新建数组，光去掉防御性 `.slice()`
      // 已经测不出来（本轮实测 fail=0）。改为两步，合起来才等于旧实现：
      //   ① 去掉 `.slice()`（`all` 就是调用方的数组本体）；
      //   ② 空关键词短路 `return all`（旧写法正是 `if (!q) return all;`）。
      name: 'R35-01p · 空关键词返回入参本体（把模块级 usersState 交出去，调用方一 sort 就改到全局状态）',
      file: 'public/js/util.js',
      mutations: [
        {
          anchor: '  const all = Array.isArray(list) ? list.slice() : [];',
          replacement: '  const all = Array.isArray(list) ? list : [];',
        },
        {
          anchor: '  return all.filter((u) => matchesQuery(query, (u && u.username) || \'\')',
          replacement: '  if (!String(query == null ? \'\' : query).trim()) return all;\n'
            + '  return all.filter((u) => matchesQuery(query, (u && u.username) || \'\')',
        },
      ],
      testFile: 'audit35-regressions.test.js',
      minFail: 1,
    },
    {
      // R36：过滤动作改由「卡片传入的 `filter()` 回调」承担（骨架在 listdialog.js），
      // 锚点随之迁到 `showAllUsers` 里那份回调上；变异仍是「无视搜索关键词」。
      name: 'R35-01q · 对话框忽略搜索关键词（过滤与「刷新后保持过滤」两条用例同时变红）',
      file: 'public/js/syssettings.js',
      anchor: '    filter: (list, st) => filterUsersByName(list, st.query, st.filters.role),',
      replacement: "    filter: (list, st) => filterUsersByName(list, '', st.filters.role),",
      testFile: 'audit35-regressions.test.js',
      minFail: 2,
    },
    {
      name: 'R35-01r · 反向对照脚本不再拒绝位置参数（`R35-01` 被静默忽略 → 跑满全量数小时）',
      file: 'scripts/reverse-check.js',
      // ⚠️ 本条的**目标文件就是台账自身**，因此 anchor 必须**跨行**（字面量里写 `\n` 转义，
      //    而不是真换行）。单行 anchor 会在本文件里命中两次：CASES 里那处字面量
      //    （行号更靠前！）与真正的代码，而 `String.replace` 只替**首处** —— 变异会打在
      //    台账的字符串上、被测代码毫发无伤，实跑得到 fail=0「护栏没抓到」的假象（已踩一次）。
      anchor: '  if (stray.length) {\n    return {\n      error: \'无法识别的参数：\' + stray.join(\' \')',
      replacement: '  if (false) {\n    return {\n      error: \'无法识别的参数：\' + stray.join(\' \')',
      testFile: 'audit35-regressions.test.js',
      minFail: 1,
    },

    /* ---------------- R36 · 四张列表卡片「显示全部」+ 属性面板「创建者 / 上传者」+ 上传者元数据 ----------------
     * 本轮是**功能需求**（不是缺陷），反向对照的落点因此分三类：
     *  ① 共享判据层（util.matchesQuery / util.previewMoreState / listdialog.openListDialog）——
     *     四张卡片都靠它们，改坏一处四张一起坏（其中「严格大于」那条由 R35-01b 继续守着）；
     *  ② 各卡片自己的接线（截断上限、下拉筛选、搜索字段、全量 vs 子集判定）；
     *  ③ 服务端「上传者」元数据的唯一实现点与各写入出口。
     */
    {
      // 需求 2②③④ / 3：一张卡片要同时搜多个字段（密钥：备注+ID；桶：桶名+备注；
      // 链接：文件名+分享者），全靠 matchesQuery 的 `.some`。退化成只比第一个字段，
      // 表现为「搜第二个字段永远搜不到」。
      name: 'R36-01a · matchesQuery 只比较第一个字段（多字段搜索退化成单字段）',
      file: 'public/js/util.js',
      anchor: '  const list = Array.isArray(texts) ? texts : [texts];',
      replacement: '  const list = Array.isArray(texts) ? texts.slice(0, 1) : [texts];',
      testFile: 'audit36-regressions.test.js',
      minFail: 2,
    },
    {
      // 打开时快照一份数据集：后台刷新（删除 / 新增）之后对话框里还是旧的那一份，
      // 表现为「在对话框里删掉一条，它却还在」。
      name: 'R36-01b · openListDialog 打开时快照 items（后台刷新后对话框不更新）',
      file: 'public/js/listdialog.js',
      anchor: '  function currentAll() {\n    return (o.items && o.items()) || [];\n  }',
      replacement: '  const __snap = (o.items && o.items()) || [];\n  function currentAll() {\n    return __snap;\n  }',
      testFile: 'audit36-regressions.test.js',
      minFail: 1,
    },
    {
      // 「筛不到」与「一条都没有」必须两句话 —— 合并之后用户分不清是数据没了还是筛错了。
      name: 'R36-01c · openListDialog 把「无匹配」与「一条都没有」合并成同一句文案',
      file: 'public/js/listdialog.js',
      anchor: "      list.innerHTML = `<div class=\"lk-empty\">${all.length ? (o.emptyMatch || '没有匹配的项') : (o.emptyAll || '暂无数据')}</div>`;",
      replacement: "      list.innerHTML = `<div class=\"lk-empty\">${o.emptyMatch || '没有匹配的项'}</div>`;",
      testFile: 'audit36-regressions.test.js',
      minFail: 1,
    },
    {
      // 筛选生效时计数必须同时给出「匹配 x / 共 N」；只写「共 N」时用户无法确认到底筛没筛到。
      name: 'R36-01d · openListDialog 计数不再给出「匹配 x / 共 N」',
      file: 'public/js/listdialog.js',
      anchor: '        ? `匹配 ${shown.length} / 共 ${all.length} ${unitShort}`',
      replacement: '        ? `共 ${all.length} ${unitShort}`',
      testFile: 'audit36-regressions.test.js',
      minFail: 1,
    },
    {
      // 服务商下拉不去重：同一家出现多次（数据集里同厂商的密钥 / 桶通常占多数）。
      name: 'R36-01e · providerSelectOptions 不去重（下拉里同一服务商出现多次）',
      file: 'public/js/listdialog.js',
      anchor: '    if (!seen.includes(pid)) seen.push(pid);',
      replacement: '    seen.push(pid);',
      testFile: 'audit36-regressions.test.js',
      minFail: 1,
    },
    {
      // bucket 为空的**历史链接**若占一个选项，就是一个「选了必然为空」的空选项 ——
      // 它们在「全部存储桶」下本来仍然可见（见 R36-05 的「历史链接不得被筛掉」）。
      name: 'R36-01f · bucketSelectOptions 把空 bucket 也列成一个选项',
      file: 'public/js/listdialog.js',
      anchor: '    if (b && !seen.includes(b)) seen.push(b);',
      replacement: '    if (!seen.includes(b)) seen.push(b);',
      testFile: 'audit36-regressions.test.js',
      minFail: 1,
    },
    {
      // 需求 1 的核心判据：「标签随对象类型变」只在 util.propertyBodyHtml 里写一次。
      // 写反即变红（文件夹属性里出现「上传者」、文件属性里出现「创建者」）。
      name: 'R36-02a · propertyBodyHtml 把标签写反（文件夹显示「上传者」、文件显示「创建者」）',
      file: 'public/js/util.js',
      anchor: "  const ownerRow = row(st.isFolder ? '创建者' : '上传者', ownerText(st.uploader));",
      replacement: "  const ownerRow = row(st.isFolder ? '上传者' : '创建者', ownerText(st.uploader));",
      testFile: 'audit36-regressions.test.js',
      minFail: 1,
    },
    {
      // 历史对象没有元数据。**不能**拿「当前登录用户」或「最后操作者」顶替 ——
      // 那是在编造一个看起来合理的事实，属性面板的价值恰恰在于它说的是真的。
      name: 'R36-02b · ownerText 对空值顶替一个「合理」的名字（而不是如实显示「—」）',
      file: 'public/js/util.js',
      anchor: "  const name = String(u == null ? '' : u).trim();\n  if (name) return escapeHtml(name);",
      replacement: "  const name = String(u == null ? '' : u).trim() || '未知用户';\n  if (name) return escapeHtml(name);",
      testFile: 'audit36-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R36-03a · 密钥卡片不再截断（11 个密钥全渲染 → 需求 2① 名存实亡）',
      file: 'public/js/credmgr.js',
      anchor: '  const shown = creds.slice(0, CRED_PREVIEW_LIMIT);',
      replacement: '  const shown = creds;',
      testFile: 'audit36-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R36-03b · 密钥卡片对话框忽略服务商筛选（下拉成了摆设）',
      file: 'public/js/credmgr.js',
      anchor: '    filter: (list, st) => filterCreds(list, st.query, st.filters.provider),',
      replacement: "    filter: (list, st) => filterCreds(list, st.query, ''),",
      testFile: 'audit36-regressions.test.js',
      minFail: 1,
    },
    {
      // 需求 2② 明说「搜索备注」——但密钥卡片同时要能按「访问密钥 ID」搜（占位符里写了）。
      name: 'R36-03c · 密钥卡片搜索不再匹配「访问密钥 ID」（只搜备注）',
      file: 'public/js/credmgr.js',
      anchor: "    && matchesQuery(query, [(c && c.remark) || '', (c && c.secretIdMasked) || '']));",
      replacement: "    && matchesQuery(query, [(c && c.remark) || '']));",
      testFile: 'audit36-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R36-04a · 存储桶卡片不再截断（11 个存储桶全渲染 → 需求 2① 名存实亡）',
      file: 'public/js/bucketmgr.js',
      anchor: '  const shown = cache.slice(0, BUCKET_PREVIEW_LIMIT);',
      replacement: '  const shown = cache;',
      testFile: 'audit36-regressions.test.js',
      minFail: 1,
    },
    {
      // ⚠️ 本轮最容易犯的语义错误：把**筛过的子集**当成全域去数启用桶，
      // 于是「按厂商筛选后只剩 1 个启用桶」的假象把本该可停用的按钮锁死。
      name: 'R36-04b · 存储桶的「只剩一个启用桶不得停用」按筛过的子集判定',
      file: 'public/js/bucketmgr.js',
      anchor: '    rowHtml: (shown) => bucketTableHtml(shown, cache),',
      replacement: '    rowHtml: (shown) => bucketTableHtml(shown, shown),',
      testFile: 'audit36-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R36-04c · 存储桶对话框忽略服务商筛选（下拉成了摆设）',
      file: 'public/js/bucketmgr.js',
      anchor: '    filter: (list, st) => filterBuckets(list, st.query, st.filters.provider),',
      replacement: "    filter: (list, st) => filterBuckets(list, st.query, ''),",
      testFile: 'audit36-regressions.test.js',
      minFail: 1,
    },
    {
      // 需求 2④：**一个**搜索框同时搜「存储桶名称」与「备注」。只搜桶名即退化为半个功能。
      name: 'R36-04d · 存储桶搜索只搜桶名、不搜备注（需求 2④「一个框搜两者」名存实亡）',
      file: 'public/js/bucketmgr.js',
      anchor: "    && matchesQuery(query, [(r && r.bucket) || '', (r && r.remark) || '']));",
      replacement: "    && matchesQuery(query, [(r && r.bucket) || '']));",
      testFile: 'audit36-regressions.test.js',
      minFail: 1,
    },
    {
      // 需求 3：分享链接卡片的预览上限是 **100**（与另两张卡片的 10 不同）。
      name: 'R36-05a · 分享链接卡片的预览上限从 100 改成 10（与需求 3 不符）',
      file: 'public/js/linkmgr.js',
      anchor: 'const LINK_PREVIEW_LIMIT = 100;',
      replacement: 'const LINK_PREVIEW_LIMIT = 10;',
      testFile: 'audit36-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R36-05b · 分享链接筛选忽略存储桶（下拉成了摆设）',
      file: 'public/js/linkmgr.js',
      anchor: "  return (Array.isArray(list) ? list : []).filter((l) => (!want || String((l && l.bucket) || '') === want)",
      replacement: '  return (Array.isArray(list) ? list : []).filter((l) => (!want || true)',
      testFile: 'audit36-regressions.test.js',
      minFail: 1,
    },
    {
      // 需求 3：搜索要同时覆盖「文件名」与「分享者」。
      name: 'R36-05c · 分享链接搜索忽略分享者（只搜文件名）',
      file: 'public/js/linkmgr.js',
      anchor: "    && matchesQuery(query, [(l && (l.fileName || l.key)) || '', (l && l.createdBy) || '']));",
      replacement: "    && matchesQuery(query, [(l && (l.fileName || l.key)) || '']));",
      testFile: 'audit36-regressions.test.js',
      minFail: 1,
    },
    {
      // 需求 0：用户对话框新增角色下拉。
      name: 'R36-06a · 全部用户对话框忽略角色筛选（新增的下拉成了摆设）',
      file: 'public/js/syssettings.js',
      anchor: '    filter: (list, st) => filterUsersByName(list, st.query, st.filters.role),',
      replacement: "    filter: (list, st) => filterUsersByName(list, st.query, ''),",
      testFile: 'audit36-regressions.test.js',
      minFail: 1,
    },
    {
      // 角色条件写死成恒真：选了「管理员」也照样把普通用户列出来。
      name: 'R36-06b · filterUsersByName 的角色条件失效（选了角色仍列出全部用户）',
      file: 'public/js/util.js',
      anchor: "    && (!wantRole || String((u && u.role) || '') === wantRole));",
      replacement: '    && (!wantRole || true));',
      testFile: 'audit36-regressions.test.js',
      minFail: 1,
    },
    {
      // 静态结构护栏：四张卡片必须共用 util.previewMoreState，不得就地重写判据 ——
      // 「严格大于」写两份，必然有一天其中一份被改成 >=（R35-01b 守的就是这里）。
      name: 'R36-07a · 密钥卡片不再共用 previewMoreState（就地重写了一份判据）',
      file: 'public/js/credmgr.js',
      anchor: "  const { over, hint: hintText } = previewMoreState(total, CRED_PREVIEW_LIMIT, '个密钥');",
      replacement: "  const over = total > CRED_PREVIEW_LIMIT;\n  const hintText = over ? '卡片仅显示前 10 个密钥，共 ' + total + ' 个密钥' : '';",
      testFile: 'audit36-regressions.test.js',
      minFail: 1,
    },
    {
      // 静态结构护栏：对话框骨架只允许一份（listdialog.openListDialog）。
      // 这里用一个**最小可判定的代理变异** —— 把共用函数换成模块自有的名字，
      // 静态断言 `openListDialog(` 随即失配（即「各写一份」的形态）。
      name: 'R36-07b · 分享链接卡片不再共用 openListDialog（对话框各写一套）',
      file: 'public/js/linkmgr.js',
      anchor: '  linksDialog = openListDialog({',
      replacement: '  linksDialog = openListDialogInline({',
      testFile: 'audit36-regressions.test.js',
      minFail: 1,
    },
    {
      // 截断上限必须引用常量：就地写死数字 10 之后，改上限时卡片与提示文案会分家。
      name: 'R36-07c · 存储桶卡片把截断上限写死成数字（与提示文案分家）',
      file: 'public/js/bucketmgr.js',
      anchor: '  const shown = cache.slice(0, BUCKET_PREVIEW_LIMIT);',
      replacement: '  const shown = cache.slice(0, 10);',
      testFile: 'audit36-regressions.test.js',
      minFail: 1,
    },
    {
      // 元数据键名只能在 cos.js 出现一次（协议护栏：期望值按约定写死在测试里）。
      name: 'R36-08a · 上传者元数据键名不再是 x-cos-meta-uploader',
      file: 'server/cos.js',
      anchor: "const UPLOADER_META = 'x-cos-meta-uploader';",
      replacement: "const UPLOADER_META = 'x-meta-uploader';",
      testFile: 'audit36-regressions.test.js',
      minFail: 1,
    },
    {
      // gateway.writeObject 的第 7 个参数 `uploader` 若半路丢掉，网页上传能记上传者、
      // WebDAV 上传却永远显示「—」—— 同一条链路两个出口两套行为。
      name: 'R36-08b · gateway.writeObject 丢掉 uploader（第 7 个参数半路流失）',
      file: 'server/fs-gateway.js',
      anchor: '      uploaderMeta(uploader),',
      replacement: '      {},',
      testFile: 'audit36-regressions.test.js',
      minFail: 1,
    },
    {
      // 适配器必须把上层的 `x-cos-meta-*` 翻译成各自厂商的头（S3 → x-amz-meta-*）。
      name: 'R36-08c · s3-client 不再翻译 x-cos-meta-*（元数据到了云端变成自定义残留头）',
      file: 'server/s3-client.js',
      anchor: "      if (k.toLowerCase().startsWith('x-cos-meta-')) {",
      replacement: '      if (false) {',
      testFile: 'audit36-regressions.test.js',
      minFail: 1,
    },
    {
      // 新建文件夹的目录标记对象也要带上传者，否则文件夹属性永远只能显示「—」。
      name: 'R36-08d · mkdir 写入点不带上传者（文件夹属性永远显示「—」）',
      file: 'server/routes/fs.js',
      anchor: "      Headers: uploaderMeta(req.authUser && req.authUser.username),\n    });\n    res.json({ ok: true, key });",
      replacement: '      Headers: {},\n    });\n    res.json({ ok: true, key });',
      testFile: 'audit36-regressions.test.js',
      minFail: 1,
    },
    {
      // 移动文件夹时重建空目录标记，必须**沿用**原标记的上传者 —— 否则一次移动就把
      // 文件夹的「创建者」抹成「—」（文件的上传者反而因为复制保留元数据而幸存）。
      name: 'R36-08e · movePrefix 重建空目录标记时不沿用原上传者（移动一次创建者就丢）',
      file: 'server/fs-gateway.js',
      anchor: '      markerMeta = uploaderMeta(readUploader(h.headers));',
      replacement: '      markerMeta = {};',
      testFile: 'audit36-regressions.test.js',
      minFail: 1,
    },

    /* ---------------- R37 · 下载限速（五层取最小）+ IP 地址管理页 ----------------
     * 本轮是**功能需求**，且它的失效方式有一个共同特征：**看起来全都配好了、实际一点没限**。
     * 因此对照分四类：
     *  ① 多层取最小 / 层聚合的语义（取成最大、把 0 当有效值、IP 层传错形状）；
     *  ② 节拍器本身（限速失效、写间隔无上界、并发不公平）—— 这一层**只有计时能证伪**；
     *  ③ 两类 IP 规则互斥（屏蔽不产生限速、限速不拦截、禁用/0 速率不生效）；
     *  ④ 接线与迁移（三个下载出口漏一个、接口表字段半路流失、卡片搬回去）。
     */
    {
      // 「各层取最小值」写反成取最大值 = 限速整体失效（用户以为设了 5MB/s，实际按最大的那层走）。
      name: 'R37-01a · pickEffective 改成取**最大值**（多层限速的语义反了）',
      file: 'server/throttle.js',
      anchor: '    if (l.bytesPerSec < best.bytesPerSec) best = l; // 严格小于：同值保持更高优先层',
      replacement: '    if (l.bytesPerSec > best.bytesPerSec) best = l; // 变异：取最大',
      testFile: 'audit37-regressions.test.js',
      minFail: 1,
    },
    {
      // 0 = 「这一层没设」，必须先从候选里剔掉；否则取最小值会得到 0，
      // 表现是「一设限速就完全下不动」——而且是在**别的层**设的限速把它压死的。
      name: 'R37-01b · pickEffective 把 0 当作有效限速参与取最小（下载被压成 0）',
      file: 'server/throttle.js',
      anchor: '    .filter((l) => l && normalizeSpeedLimit(l.bytesPerSec) > 0)',
      replacement: '    .filter((l) => Boolean(l))',
      testFile: 'audit37-regressions.test.js',
      minFail: 1,
    },
    {
      // 本轮的**头号静默失效**：`speedLimitFor` 只接受原始 IP 字符串，传
      // `{ip, fromForwarded}` 包装对象时 CIDR 匹配读到 `undefined`，恒不命中 ——
      // IP 限速「配好了、保存成功、界面显示生效」，实际全速下载。
      name: 'R37-01c · resolveLimit 给 speedLimitFor 传包装对象（IP 限速静默失效）',
      file: 'server/throttle.js',
      anchor: "  const ipHit = ipGuard.speedLimitFor(ctx.ip, ctx.method || 'GET', ctx.bucketId);",
      replacement: "  const ipHit = ipGuard.speedLimitFor({ ip: ctx.ip, fromForwarded: false }, ctx.method || 'GET', ctx.bucketId);",
      testFile: 'audit37-regressions.test.js',
      minFail: 1,
    },
    {
      // 退回朴素的「攒够一整块、等够这一块的时间、再整块放行」实现：平均速率看着是对的，
      // 但**写间隔没有任何上界**（1KB/s + 64KB 分块 = 64 秒静默），
      // `res.setTimeout(10min)` 这个**无活动**超时会把正常下载判死。
      // 这是本轮唯一只有计时类断言能证伪的形态。
      name: 'R37-02a · 节拍器退回「攒够一整块再放行」（写间隔无上界 → 无活动超时误杀）',
      file: 'server/throttle.js',
      anchor: '    if (!timer && !t.destroyed) timer = setTimeout(pump, SLICE_MS);',
      replacement: '    if (!timer && !t.destroyed) timer = setTimeout(pump, Math.max(SLICE_MS, Math.floor((buf ? buf.length : 1) / Math.max(1, b.rate / 1000))));',
      testFile: 'audit37-regressions.test.js',
      minFail: 1,
    },
    {
      // 同一实体上的并发下载不按连接数均分每拍额度：总量看着没超，但**分配极不公平**
      // （先到的把每一拍吃满，后到的长期排队）。实测过的原始症状是 2×/1×，即 `active` 未参与。
      name: 'R37-02b · 节拍器不按并发数均分额度（同一实体的两条下载严重不公平）',
      file: 'server/throttle.js',
      anchor: '    const perTick = Math.max(1, Math.floor(b.cap / Math.max(1, b.active || 1)));',
      replacement: '    const perTick = Math.max(1, b.cap);',
      testFile: 'audit37-regressions.test.js',
      minFail: 1,
    },
    {
      // 接口层的入参校验若漏掉负数，`-1` 会被存成 0 = **不限速**：
      // 用户以为设了限速、实际全速（与 `quotaBytes` 踩过的坑同型）。
      name: 'R37-03a · parseSpeedLimitInput 接受负数（静默变成「不限速」）',
      file: 'server/limits.js',
      anchor: "  if (!Number.isFinite(n) || n < 0) return { ok: false, error: '限速值不能为负数（0 表示不限速）' };",
      replacement: '  if (!Number.isFinite(n)) return { ok: false, error: "请输入数字" };',
      testFile: 'audit37-regressions.test.js',
      minFail: 1,
    },
    {
      // 屏蔽判定若不跳过 `kind === 'speed'` 的规则，一条「限速」规则会把请求直接 403 ——
      // 需求写明限速**只慢不拦**，这种错法用户完全无法理解（"我明明设的是限速"）。
      name: 'R37-04a · matchRules 不再跳过限速规则（限速规则把请求 403 掉）',
      file: 'server/ip-guard.js',
      anchor: "    if (r.kind === 'speed') continue;",
      replacement: '    if (false) continue;',
      testFile: 'audit37-regressions.test.js',
      minFail: 1,
    },
    {
      // 「禁用」按钮对限速规则必须同样有效：漏掉 enabled 判定之后，界面上写着「已禁用」、
      // 实际仍在限速，用户唯一的自救手段是删掉规则。
      // ⚠️ 锚点必须**跨行**：单行 `if (!r.enabled) continue;` 在本文件里有两处
      //（matchRules 与本函数各一处），而 `String.replace` 只替首处 —— 会打到无关分支上。
      name: 'R37-04b · speedLimitFor 不再检查 enabled（已禁用的限速规则仍在限速）',
      file: 'server/ip-guard.js',
      anchor: "    if (!r.enabled) continue;\n    if (r.kind !== 'speed') continue;                 // 屏蔽规则不参与限速\n    if (!(Number(r.speedLimit) > 0)) continue;        // 未填速率 = 这条规则不起作用",
      replacement: "    if (r.kind !== 'speed') continue;                 // 屏蔽规则不参与限速\n    if (!(Number(r.speedLimit) > 0)) continue;        // 未填速率 = 这条规则不起作用",
      testFile: 'audit37-regressions.test.js',
      minFail: 1,
    },
    {
      // 速率为 0 的限速规则必须等价于「没设」。若拿 0 当有效速率，命中它的下载会被
      // 卡在 1 字节/秒的下限上 —— 表现是「下载永远不动」，比屏蔽还难排查。
      name: 'R37-04c · speedLimitFor 接受 0 速率（命中后下载几乎停滞）',
      file: 'server/ip-guard.js',
      anchor: "    if (!(Number(r.speedLimit) > 0)) continue;        // 未填速率 = 这条规则不起作用",
      replacement: "    if (!(Number(r.speedLimit) >= 0)) continue;       // 变异：0 也算有效速率",
      testFile: 'audit37-regressions.test.js',
      minFail: 1,
    },
    {
      // 节拍器插错位置（放在计量**之后**）：traffic / statsStore 记的与实际下发不一致，
      // 且解密后的明文字节不再是被计量的那一份，「今天下载了多少」从此对不上账。
      name: 'R37-05a · download-stream 把节拍器插在计量环节之后（计量口径与限速不一致）',
      file: 'server/download-stream.js',
      anchor: '  const stages = throttle ? [out, throttle, meter, res] : [out, meter, res];',
      replacement: '  const stages = throttle ? [out, meter, throttle, res] : [out, meter, res];',
      testFile: 'audit37-regressions.test.js',
      minFail: 1,
    },
    {
      // WebDAV 的 GET 是完全独立的下发路径：漏掉这一处接线，主站限速生效、挂载盘全速 ——
      // 「限速」成了一个可以被换条路绕过的摆设。这是本轮最容易漏的一处。
      name: 'R37-05b · WebDAV 下载出口漏接限速（挂载盘成了全速旁路）',
      file: 'server/webdav-server.js',
      anchor: '      const throttle = makeThrottle({\n        ip: security.clientIp(req),\n        method: req.method,\n        credentialId: cfg.credentialId,\n        bucketId: cfg.bucketId,\n      });',
      replacement: '      const throttle = null;',
      testFile: 'audit37-regressions.test.js',
      minFail: 2,
    },
    {
      // 前端把限速值拼进请求体这一步若丢掉，用户在「文件分享」里填了限速、界面提示保存成功，
      // 而记录上仍是 0（= 不限速）——「填了不生效」是最难被用户定位的一类失效。
      name: 'R37-06a · 文件分享对话框不再提交 speedLimit（填了不生效）',
      file: 'public/js/ops.js',
      anchor: '            body.speedLimit = sp.bytes;',
      replacement: '',
      testFile: 'audit37-regressions.test.js',
      minFail: 1,
    },
    {
      // 「文件分享」与「链接管理」是**同一条记录上的同一个字段**（已与用户确认）。
      // create 不落这个字段 → 在文件分享里设的限速不会被保存。
      name: 'R37-06b · share-store.create 不落 speedLimit（文件分享设的限速丢失）',
      file: 'server/share-store.js',
      anchor: '    speedLimit: normalizeSpeedLimit(speedLimit), // R37：链接级下载限速（0 = 不限）',
      replacement: '',
      testFile: 'audit37-regressions.test.js',
      minFail: 1,
    },
    {
      // 迁移若做成「复制一份回桶页」，就会出现两张卡片各自渲染、各自请求同一份规则表
      // （同一状态两条读路径），而且用户会以为改了一个另一个也跟着变。
      name: 'R37-07a · IP 屏蔽卡片被复制回存储桶页（迁移退化成两份）',
      file: 'public/index.html',
      anchor: '        <section id="bucketmgr" class="card-view" hidden>',
      replacement: '        <section id="bucketmgr" class="card-view" hidden>\n          <div class="dash-card wide" id="ipguard-card"><div id="ipguard-table"></div></div>',
      testFile: 'audit37-regressions.test.js',
      minFail: 1,
    },

    /* ============ R38-01 · Windows Hello「当前访问地址不是本站域名」 ============ */

    {
      // 根因就是这一行漏了 `SITE_DOMAIN`：允许集里只剩 `HOST=0.0.0.0` 这个**通配
      // 绑定地址**（请求的 `Host` 头永远不可能等于它）加上两个默认空字符串 ——
      // 允许集**实际为空**，于是用真实域名访问本站反而被判成「访问了外站」。
      name: 'R38-01a · SITE_DOMAIN 未纳入「本站域名」允许集（用户报的 403 原样复现）',
      file: 'server/security.js',
      anchor: '  const own = new Set([normalizeHost(DEPLOY_HOST), SITE_DOMAIN]);',
      replacement: '  const own = new Set([normalizeHost(DEPLOY_HOST)]);',
      testFile: 'audit38-regressions.test.js',
      minFail: 1,
    },
    {
      // 修这个根因时最顺手的做法就是「把这道判据放宽」—— 而那会把 R24-02 的防钓鱼面
      // 一起拆掉：任何域名都成了「本站」，攻击者可以在仿冒域上骗取 Windows Hello 签名。
      name: 'R38-01b · 干脆把 isOwnSiteHost 放宽成恒真（防钓鱼面被一起拆掉）',
      file: 'server/security.js',
      anchor: '  return own.has(h);\n}',
      replacement: '  return true;\n}',
      testFile: 'audit38-regressions.test.js',
      minFail: 1,
    },
    {
      // `0.0.0.0` 留在允许集里**不会**造成误放行（请求 `Host` 不可能等于它），
      // 但会让 `httpsRedirectHost()` 的回退分支把「无域名可用」误判成「有域名可用」，
      // 跳转目标于是变成 `https://0.0.0.0:3443/…` —— 一个必然打不开的地址。
      name: 'R38-01c · 不再剔除通配绑定地址（跳转目标退回 https://0.0.0.0:3443/…）',
      file: 'server/security.js',
      anchor: '  for (const x of [...own]) { if (isBindAllHost(x)) own.delete(x); }',
      replacement: '',
      testFile: 'audit38-regressions.test.js',
      minFail: 1,
    },
    {
      // 「本站叫什么」与「分享链接优先用哪个域名」是两件事：后者只是展示偏好，
      // 拿它做 HTTPS 跳转目标会把用户送到一个并不提供本系统的域名上。
      name: 'R38-01d · HTTPS 跳转目标不认 SITE_DOMAIN（用户被送到分享用 CDN 域名）',
      file: 'server/security.js',
      anchor: '  if (SITE_DOMAIN) return SITE_DOMAIN;',
      replacement: '  if (false) return SITE_DOMAIN;',
      testFile: 'audit38-regressions.test.js',
      minFail: 1,
    },
    {
      // 只改应用侧，只能救「手动设了 SITE_DOMAIN」的那一半；一键部署的站点完全靠
      // 这一行拿到自己的域名 —— 少了它，自动部署的站点原样踩同一个坑。
      name: 'R38-01f · 部署脚本不写 SITE_DOMAIN（自动部署的站点仍被判「外站」）',
      file: 'deploy.sh',
      anchor: 'SITE_DOMAIN=${DOMAIN}',
      replacement: '',
      testFile: 'audit38-regressions.test.js',
      minFail: 1,
    },

    /* ==================== R38-02 · 设置页「备份配置」 ==================== */

    {
      // 需求把「API Key 管理」与「负载均衡」列成两项，但它们在 `config.enc` 里是
      // **同一条 credentials 记录**（`quotaBytes`）。另立一个分区 = 同一个字段两个
      // 来源，导入时谁覆盖谁全凭顺序。
      name: 'R38-02b · 「负载均衡」被拆成独立分区（同一条记录两个来源）',
      file: 'server/backup.js',
      anchor: "  { label: '负载均衡', section: 'credentials' },",
      replacement: "  { label: '负载均衡', section: 'loadbalance' },",
      testFile: 'audit38-regressions.test.js',
      minFail: 1,
    },
    {
      // 需求原话：「所有用户均不在备份范围内（包括管理员）」。账户与口令哈希属于
      // **这台实例**的身份，跨实例搬运等于把「谁能登录」一起搬走。
      name: 'R38-02c · 备份把用户表一起带上（跨实例搬运把「谁能登录」也搬走）',
      file: 'server/backup.js',
      anchor: '    ipguard: {\n      rules: clone(ipGuard.listRules() || []), // listRules 已剥掉派生缓存 `_parsed`\n    },\n  };',
      replacement: '    ipguard: {\n      rules: clone(ipGuard.listRules() || []), // listRules 已剥掉派生缓存 `_parsed`\n    },\n    users: clone(cfg.users || []),\n  };',
      testFile: 'audit38-regressions.test.js',
      minFail: 1,
    },
    {
      // WebDAV 口令在 `config.enc` 里是**字段级密封**（绑定本实例的 `data/secret.key`）。
      // 原样把 `passwordSealed` 搬走，在目标实例上是一段永远解不开的密文 ——
      // 症状是「导入成功、WebDAV 却登录不上」，且界面上看不出任何异常。
      name: 'R38-02k · 备份里带上 passwordSealed（跨实例永远解不开）',
      file: 'server/backup.js',
      anchor: "      password: String(full.password || ''),\n    };",
      replacement: "      password: String(full.password || ''),\n      passwordSealed: String(a.passwordSealed || 'sealed'),\n    };",
      testFile: 'audit38-regressions.test.js',
      minFail: 1,
    },
    {
      // 准入判据要求「备份范围内每一项都算数」。漏掉任何一项，都会让「已经配过该项
      // 的实例」仍然显示可导入 —— 而那一次点击是**不可撤销**的整批覆盖。
      //
      // R41 起「登陆验证」的判据有**两半**：新结构的 `providers`（任一套填过即算数）
      // 与旧载荷的扁平 `siteKey`/`secretKey`。本条的变异摘掉的是**旧扁平键那一半**
      // （`R41-02g` 守的是 `providers` 那一半），两侧各有一条对照，不会互相遮蔽。
      name: 'R38-02l · 准入判据漏掉「登陆验证」的旧扁平键一侧（配过却仍允许导入线上实例）',
      file: 'server/backup.js',
      anchor: '  if (cap.siteKey || cap.secretKey) return false;\n',
      replacement: '',
      testFile: 'audit38-regressions.test.js',
      minFail: 1,
    },
    {
      // 另一侧的失效：分区清单里列了、实际没写回。界面上「导入成功 7 项」，
      // 而上传排除一个字都没变 —— 没有任何运行期症状。
      name: 'R38-02m · 导入漏还原「上传排除」分区（清单列了、实际没写回）',
      file: 'server/backup.js',
      anchor: '  configStore.save({\n    uploadExcludes: {\n      dsStore: boolOf(ue.dsStore),\n      thumbsDb: boolOf(ue.thumbsDb),\n      gitignore: boolOf(ue.gitignore),\n    },\n  });',
      replacement: '  void ue; // 变异：整个分区不写回',
      testFile: 'audit38-regressions.test.js',
      minFail: 1,
    },
    {
      // 导入若图省事循环调 `addRule()`，会丢掉 `id` 与 `enabled` ——
      // 「备份时停用的屏蔽规则，还原后变成启用」，用户只会觉得「导入把配置弄坏了」。
      name: 'R38-02o · 整批替换丢掉规则的 id / 停用状态（停用的屏蔽规则悄悄生效）',
      file: 'server/ip-guard.js',
      anchor: '  guard.rules = (Array.isArray(rules) ? rules : []).map((r) => {\n    const o = normalizeRule(r);\n    if (!o.id) o.id = newId();\n    return o;\n  });',
      replacement: '  guard.rules = (Array.isArray(rules) ? rules : []).map((r) => (\n    Object.assign({}, normalizeRule(r), { id: newId(), enabled: true })\n  ));',
      testFile: 'audit38-regressions.test.js',
      minFail: 1,
    },
    {
      // 实时码里含 API Key / 支付凭证 / WebDAV 口令的**明文**。
      name: 'R38-02q · /backup/code 漏挂 requireAdmin（普通用户可读走全部密钥明文）',
      file: 'server/routes/backup.js',
      anchor: "router.get('/backup/code', requireAdmin, (req, res) => {",
      replacement: "router.get('/backup/code', (req, res) => {",
      testFile: 'audit38-regressions.test.js',
      minFail: 1,
    },
    {
      // 需求原话：「导出该代码需进行权限验证（输入密码）」。拿掉这一步，任何持有
      // 有效会话的人都能把整份配置（含全部密钥明文）导出走。
      name: 'R38-02r · 导出不再校验账户口令（有会话就能导出全部密钥）',
      file: 'server/routes/backup.js',
      anchor: '  await assertAccountPassword(req, b.password);',
      replacement: '',
      testFile: 'audit38-regressions.test.js',
      minFail: 1,
    },
    {
      // 顺序本身就是安全属性：先解密再判准入，会让「在已配置实例上反复试备份密码」
      // 成为一条可利用的**口令爆破信道**（响应差异可区分密码对不对）。
      name: 'R38-02s · 导入准入判据被摘掉（已配置实例上可反复试密码）',
      file: 'server/routes/backup.js',
      anchor: '  if (!backup.canImport()) {',
      replacement: '  if (false) {',
      testFile: 'audit38-regressions.test.js',
      minFail: 1,
    },
    {
      // 准入判据被写成定值（「现算」的反面）—— 用户刚配好一个密钥，页面仍然显示
      // 「可以导入」，而那次点击会把线上配置整批覆盖掉。
      //
      // ⚠️ 这条对照**首次登记时 fail=0**，两次都错在同一个思路上：先去改 `backup.canImport()`
      // 的**本体**（加一个 module 级缓存），而护栏在 R38-02l 里已经先调过一次该函数、
      // 之后实例一直是「已配置」状态，缓存值恰好与期望值相同，于是变异测不出。
      // 打在**接口返回值**上才真正落在这条用例的判据上 —— 登记前实跑一遍的价值就在这里。
      name: 'R38-02t · 准入判据被写成定值（已配置实例仍显示「可以导入」）',
      file: 'server/routes/backup.js',
      anchor: '    canImport: backup.canImport(),',
      replacement: '    canImport: true,',
      testFile: 'audit38-regressions.test.js',
      minFail: 1,
    },
    {
      // 「仅管理员可见」是这道功能的**第一层**保护：实时码里就是密钥明文。
      name: 'R38-02w · 备份卡片未纳入 ADMIN_ONLY_CARDS（普通用户也能读到实时码）',
      file: 'public/js/syssettings.js',
      anchor: "'sysset-payment-card', 'sysset-backup-card'];",
      replacement: "'sysset-payment-card'];",
      testFile: 'audit38-regressions.test.js',
      minFail: 1,
    },
    {
      // 需求把「所有用户」排除在备份之外，于是导入**只覆盖备份范围里的顶层键**。
      // 顺手把载荷里的用户表也写进去（载荷里没有就写成空数组），后果不是「某个设置
      // 没还原」，而是把系统导成**零管理员** —— 管理页打不开、也没有自助恢复通道。
      name: 'R38-02x · 导入顺手写了用户表（把系统导成零管理员 → 永久锁死）',
      file: 'server/backup.js',
      anchor: '  configStore.flush();\n  return summarize(collect());',
      replacement: '  configStore.save({ users: Array.isArray(data.users) ? data.users : [] });\n  configStore.flush();\n  return summarize(collect());',
      testFile: 'audit38-regressions.test.js',
      minFail: 1,
    },

    /* ======== R39-01 · 部署脚本与应用的版本对齐（「修完重新部署仍复现」） ======== */

    {
      // 用户报的「重新部署后故障依旧」的最小复现：判据退化成「永不交接」，
      // 于是旧脚本继续生成环境变量、应用却已是新代码 —— 新文案 + 旧环境。
      name: 'R39-01a · 自我交接判据退化成「永不交接」（新代码 + 旧环境原样复现）',
      file: 'deploy.sh',
      anchor: '  if [[ "$th" == "$SELF_SCRIPT_HASH" ]]; then return 1; fi\n  return 0',
      replacement: '  if [[ "$th" == "$SELF_SCRIPT_HASH" ]]; then return 1; fi\n  return 1',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      // 反向的一半：内容一致也交接 —— 每次正常部署都白跑一整趟。
      name: 'R39-01b · 判据退化成「永远交接」（同版本也白跑一趟）',
      file: 'deploy.sh',
      anchor: '  if [[ "$th" == "$SELF_SCRIPT_HASH" ]]; then return 1; fi',
      replacement: '  if [[ 1 == 0 ]]; then return 1; fi',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      // 摘掉防环兜底 → 交出去的脚本会再交接回来，部署成了无限递归。
      name: 'R39-01c · 摘掉防环标记（自我交接变成无限递归）',
      file: 'deploy.sh',
      anchor: '  if [[ "${KEPLER_SELF_HANDOFF:-0}" == "1" ]]; then return 1; fi',
      replacement: '  if [[ "${KEPLER_SELF_HANDOFF:-0}" == "__never__" ]]; then return 1; fi',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      // 脚本走管道（curl | bash）时无法自证版本，取向**必须**是「交给安装目录里那份」。
      // 反过来（不交接）就等于「管道部署永远拿不到新环境变量」，坑照旧。
      name: 'R39-01d · 自证不了版本时改为「不交接」（管道部署仍用旧环境变量）',
      file: 'deploy.sh',
      anchor: '  if [[ -z "${SELF_SCRIPT_HASH:-}" ]]; then return 0; fi',
      replacement: '  if [[ -z "${SELF_SCRIPT_HASH:-}" ]]; then return 1; fi',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      // ⭐ 本轮根因的正面对照：主流程不再交接 → 后面每一步都由上一版逻辑跑完，
      // 环境变量由旧 gen_env_file 生成。位置断言（必须在 gen_env_file 之前）即变红。
      name: 'R39-01e · 主流程不再做版本交接（环境变量仍由上一版逻辑生成）',
      file: 'deploy.sh',
      anchor: '\n  handoff_to_installed_script\n',
      replacement: '\n',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      // exec 不触发 EXIT trap：不摘旧 trap，新进程一启动就撞上自己留下的锁，
      // 直接判「另一个部署进程正在运行」—— 交接等于没发生。
      name: 'R39-01f · exec 前不摘 EXIT trap（新进程撞上自己的锁直接退出）',
      file: 'deploy.sh',
      anchor: '  trap - EXIT\n  if ((${#ORIGINAL_ARGV[@]} > 0)); then',
      replacement: '  if ((${#ORIGINAL_ARGV[@]} > 0)); then',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      // 不带域名 → 第二趟会再问一次域名；非交互场景（管道 / CI）直接判失败。
      name: 'R39-01g · 交接时不带已解析的域名（第二趟重复提问 / 非交互直接失败）',
      file: 'deploy.sh',
      anchor: 'KEPLER_SELF_HANDOFF=1 DOMAIN="$DOMAIN" \\\n      bash "$target" "${ORIGINAL_ARGV[@]}"',
      replacement: 'KEPLER_SELF_HANDOFF=1 \\\n      bash "$target" "${ORIGINAL_ARGV[@]}"',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      // 不带锁 → 与 R39-01f 同后果的另一条实现路径：锁没交接，新进程自锁。
      name: 'R39-01h · 交接时不带单实例锁（新进程判「另一个部署进程正在运行」）',
      file: 'deploy.sh',
      anchor: 'KEPLER_SELF_HANDOFF=1 DOMAIN="$DOMAIN" \\\n      bash "$target" "${ORIGINAL_ARGV[@]}"',
      replacement: 'DOMAIN="$DOMAIN" \\\n      bash "$target" "${ORIGINAL_ARGV[@]}"',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      // exec 前不做完整性预检 → 会把安装目录里被污染的文件（例如把下载到的
      // `404: Not Found` 响应体存成的「脚本」）当成脚本执行，以一句无从下手的报错中断。
      name: 'R39-01i · 交接前不做脚本完整性预检（把污染文件当脚本执行）',
      file: 'deploy.sh',
      anchor: '  if ! script_is_sane "$target"; then\n    warn "安装目录里的部署脚本疑似损坏',
      replacement: '  if false; then\n    warn "安装目录里的部署脚本疑似损坏',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      // 第二趟以安装目录自身为源码目录；若不短路，就会对它做
      // `tar -cf - . | tar -xf - -C 自己` —— 一边读一边覆盖自己。
      name: 'R39-01j · 取消「源码目录==安装目录」短路（对自己做 tar 自解压）',
      file: 'deploy.sh',
      anchor: '  if [[ -n "$src_real" && "$src_real" == "$dst_real" ]]; then',
      replacement: '  if false; then',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },
    {
      // 启动瞬间不采样指纹 → 判据永远认为「自己就是最新那份」（运行中被覆盖后再读自己，
      // 读到的已经是新内容），于是这个坑重新变成不可发现的。
      name: 'R39-01k · 启动时不采样自身指纹（判据永远认为「自己是最新」）',
      file: 'deploy.sh',
      anchor: 'SELF_SCRIPT_HASH="$(script_content_hash "$SELF_SCRIPT_FILE")"',
      replacement: 'SELF_SCRIPT_HASH=""',
      testFile: 'deploy-script.test.js',
      minFail: 1,
    },

    /* ======== R40-01 · EL8 上装 Node.js：模块包版本互斥 ======== */

    {
      // 用户给的那条命令的关键就是 `--allowerasing`：没有它，EL8 的 AppStream
      // nodejs:16 模块包与 NodeSource 的 nodejs20 直接互斥，dnf 连事务都进不去。
      name: 'R40-01a · 唯一实现点退化成「一个参数都不给」（EL8 装 Node 仍进不了事务）',
      file: 'deploy.sh',
      anchor: '  if [[ "${PM:-}" == "dnf" ]]; then printf \'%s\' "--allowerasing"; fi\n  return 0',
      replacement: '  return 0',
      testFile: 'audit40-regressions.test.js',
      minFail: 1,
    },
    {
      // 反向的一半：无条件给。`--allowerasing` 是 dnf 的参数，旧版 yum / apt / apk / zypper
      // 收到它会直接报未知选项 —— 「修好了 EL8、弄坏了 EL7 与 Debian」。
      name: 'R40-01b · 参数变成「所有包管理器都给」（旧 yum / apt / apk 因未知选项直接失败）',
      file: 'deploy.sh',
      anchor: '  if [[ "${PM:-}" == "dnf" ]]; then printf \'%s\' "--allowerasing"; fi',
      replacement: '  if [[ 1 == 1 ]]; then printf \'%s\' "--allowerasing"; fi',
      testFile: 'audit40-regressions.test.js',
      minFail: 1,
    },
    {
      // 两处安装点各是一条独立的路：只改一处 = 走另一条路（NodeSource / 发行版源）的
      // 机器仍然装不上。护栏数的是「两处都带」，撤掉一处即变红。
      name: 'R40-01c · 发行版源那条 node 安装退回不带额外参数（走这条路的 EL8 仍装不上）',
      file: 'deploy.sh',
      anchor: '    dnf|yum) run_soft "$PM" install -y nodejs $(node_pm_extra_args) ;;',
      replacement: '    dnf|yum) run_soft "$PM" install -y nodejs ;;',
      testFile: 'audit40-regressions.test.js',
      minFail: 1,
    },
    {
      name: 'R40-01d · NodeSource 那条 node 安装退回不带额外参数（装完源之后照样失败）',
      file: 'deploy.sh',
      anchor: '        && run_soft "$PM" install -y nodejs $(node_pm_extra_args)',
      replacement: '        && run_soft "$PM" install -y nodejs',
      testFile: 'audit40-regressions.test.js',
      minFail: 1,
    },
    {
      // 本轮改动的另一半：不再显式装 `npm` 这个独立包名 —— 单独 install npm 会把
      // AppStream 的 nodejs-npm 等模块包整串拉回来，正好又撞上同一个互斥。
      name: 'R40-01e · RPM 分支退回 `install -y nodejs npm`（把模块包整串拉回来，又撞同一个冲突）',
      file: 'deploy.sh',
      anchor: '    dnf|yum) run_soft "$PM" install -y nodejs $(node_pm_extra_args) ;;',
      replacement: '    dnf|yum) run_soft "$PM" install -y nodejs npm ;;',
      testFile: 'audit40-regressions.test.js',
      minFail: 1,
    },
    {
      // 装包命令已经带了 --allowerasing，指引的第一条就该是它；退回旧版「先 module reset」
      // 会把用户推去动全局模块状态（副作用大、且不是对症的那一档）。
      // ⚠️ 必须整段替换：`--allowerasing` 在同一段里出现**两次**（第 1 条与第 4 条），
      //    只改第 1 条的话输出里仍有这个词，护栏照样全绿（实测过）。
      name: 'R40-01f · 冲突指引退回「先 module reset」且不再给 --allowerasing',
      file: 'deploy.sh',
      anchor: '      add_hint "    1) ${PM} install -y nodejs --allowerasing   # 先试这条：让 dnf 直接替换掉冲突的旧模块包"\n'
        + '      add_hint "    2) ${PM} module reset nodejs"\n'
        + '      add_hint "    3) ${PM} remove -y nodejs npm nodejs-full-i18n nodejs-libs nodejs-devel"\n'
        + '      add_hint "    4) curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - && ${PM} install -y nodejs --allowerasing" ;;',
      replacement: '      add_hint "    1) ${PM} module reset nodejs"\n'
        + '      add_hint "    2) ${PM} remove -y nodejs npm nodejs-full-i18n nodejs-libs nodejs-devel"\n'
        + '      add_hint "    3) curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - && ${PM} install -y nodejs" ;;',
      testFile: 'audit40-regressions.test.js',
      minFail: 1,
    },

    /* ======== R40-02 · 「用户管理」里不能编辑自己 ======== */

    {
      // 需求原文：「隐藏自己那一列的『编辑』按钮」。判据是 `isSelf`，把它短路成 false
      // 就等于「自己那一行也渲染编辑按钮」—— 管理员又能把自己改废了。
      name: 'R40-02a · 自己那一行也渲染「编辑」按钮（isSelf 判据被短路）',
      file: 'public/js/syssettings.js',
      anchor: '          const editBtn = isSelf ? \'\'',
      replacement: '          const editBtn = false ? \'\'',
      testFile: 'audit35-regressions.test.js',
      minFail: 1,
    },
    {
      // 反向的一半：算了却不渲染。`editBtn` 是插值进行模板的，撤掉那一行 = 谁都编辑不了
      // —— proves「按钮算出来了」与「按钮真的在行里」是两件事。
      name: 'R40-02b · 行模板不再插 ${editBtn}（按钮算了却没渲染，所有人都不能编辑）',
      file: 'public/js/syssettings.js',
      anchor: '              ${editBtn}\n              ${banBtn}',
      replacement: '              ${banBtn}',
      testFile: 'audit35-regressions.test.js',
      minFail: 1,
    },

    /* ======== R40-03 · 日间 / 暗黑快捷切换 ======== */

    {
      // 多步变异 = 把按钮**搬到**账户菜单右侧（而不是删掉它）：需求是「在账户菜单的
      // **左侧**」，位置断言是 `btn < menu`，只有真的换位置才能证伪它。
      name: 'R40-03a · 切换按钮被挪到账户菜单右侧（需求是左侧）',
      file: 'public/index.html',
      mutations: [
        {
          anchor: '          <button id="btn-theme" class="tb-btn theme-btn" type="button" title="切换到暗黑模式" aria-pressed="false">\n'
            + '            <svg class="ic-moon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12.3 2.2a9.9 9.9 0 1 0 9.5 12.6 7.9 7.9 0 0 1-9.5-12.6z"/></svg>\n'
            + '            <svg class="ic-sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.3" fill="currentColor"/><g stroke="currentColor" stroke-width="1.9" stroke-linecap="round" fill="none"><path d="M12 2.7v2.3M12 19v2.3M2.7 12H5M19 12h2.3M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7"/></g></svg>\n'
            + '          </button>\n',
          replacement: '',
        },
        {
          anchor: '          <span class="tb-sep"></span>\n          <button id="btn-syssettings"',
          replacement: '          <span class="tb-sep"></span>\n'
            + '          <button id="btn-theme" class="tb-btn theme-btn" type="button" title="切换到暗黑模式" aria-pressed="false">\n'
            + '            <svg class="ic-moon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12.3 2.2a9.9 9.9 0 1 0 9.5 12.6 7.9 7.9 0 0 1-9.5-12.6z"/></svg>\n'
            + '            <svg class="ic-sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.3" fill="currentColor"/><g stroke="currentColor" stroke-width="1.9" stroke-linecap="round" fill="none"><path d="M12 2.7v2.3M12 19v2.3M2.7 12H5M19 12h2.3M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7"/></g></svg>\n'
            + '          </button>\n'
            + '          <button id="btn-syssettings"',
        },
      ],
      testFile: 'audit40-regressions.test.js',
      minFail: 1,
    },
    {
      // 「不闪白」的全部秘密就是这一句：解析期同步落属性。改成等 DOMContentLoaded
      // 就等于「暗色用户每次加载先看一帧白」—— 而这正是本轮要避免的。
      name: 'R40-03b · theme.js 不再在解析期落属性（暗色用户每次加载先闪一帧白）',
      file: 'public/js/theme.js',
      anchor: '  if (root.document) init(root.document);',
      replacement: '  if (false) init(root.document);',
      testFile: 'audit40-regressions.test.js',
      minFail: 1,
    },
    {
      // 「当前是哪个主题」必须读 DOM 属性。改读 storage 之后，隐私模式（storage 恒抛）
      // 下每次读到的都是日间 → 第一次点击之后再也切不回亮色（单向切换）。
      name: 'R40-03c · toggle 改以 storage 为「当前值」（隐私模式下点两下切不回去）',
      file: 'public/js/theme.js',
      anchor: '        setTheme(doc, st, toggle(doc.documentElement.getAttribute(ATTR)));',
      replacement: '        setTheme(doc, st, toggle(read(st)));',
      testFile: 'audit40-regressions.test.js',
      minFail: 1,
    },
    {
      // 脏值必须归到日间。改成「真值即暗色」之后，localStorage 里任何残留字符串都会
      // 让页面变暗 —— 主题成了脏数据说了算。
      name: 'R40-03d · normalize 退化成「真值即暗色」（脏数据决定主题）',
      file: 'public/js/theme.js',
      anchor: '  function normalize(value) {\n    return value === DARK ? DARK : LIGHT;\n  }',
      replacement: '  function normalize(value) {\n    return value ? DARK : LIGHT;\n  }',
      testFile: 'audit40-regressions.test.js',
      minFail: 1,
    },
    {
      // 明暗两套变量必须一一对应。少一格 = 那个面在暗色下仍是亮色（实测里最刺眼的是
      // 输入框 / 对话框 / 提示块那几块白）。
      name: 'R40-03e · 暗色块漏掉一个颜色变量（那个面在暗色下仍是亮色）',
      file: 'public/css/style.css',
      anchor: '  --muted: #8b93a1;',
      replacement: '',
      testFile: 'audit40-regressions.test.js',
      minFail: 1,
    },
    {
      // 图标靠 CSS 按主题显隐。少了这一条，日间模式下两颗图标会一起出现
      //（月亮与太阳叠在一起），且点了没有视觉反馈。
      name: 'R40-03f · 暗色模式下不再露出太阳图标（两颗图标同时出现）',
      file: 'public/css/style.css',
      anchor: '[data-theme="dark"] .theme-btn .ic-sun { display: inline; }',
      replacement: '[data-theme="dark"] .theme-btn .ic-sun { display: none; }',
      testFile: 'audit40-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R41-01：把实现脚本真正所在的那个域名从 CSP 里撤掉 = 修复前的形态。
       *
       * 实测（无头 Chrome + DevTools 协议）：`www.recaptcha.net` 下发的只是**引导脚本**，
       * 它再注入 `recaptcha/releases/<版本>/recaptcha__*.js`，该实现在中国大陆解析到
       * `www.gstatic.cn`。CSP 的 host-source 是**精确匹配**，站点里只列了 `www.gstatic.com`
       * ⇒ 实现在 `script-src-elem` 上报违规 ⇒ `grecaptcha` 永不 ready ⇒
       * 界面永远停在「正在加载人机验证组件…」（实测轮询 20.28s 耗尽）。
       */
      name: 'R41-01a · CSP 去掉 www.gstatic.cn（reCAPTCHA 卡在「正在加载人机验证组件…」）',
      file: 'server/index.js',
      anchor: '    + "script-src \'self\' https://www.recaptcha.net https://www.gstatic.com https://www.gstatic.cn https://challenges.cloudflare.com; "',
      replacement: '    + "script-src \'self\' https://www.recaptcha.net https://www.gstatic.com https://challenges.cloudflare.com; "',
      testFile: 'audit41-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R41-01b：少写一个 `www` —— 最像「已经修好了」的错法。
       *
       * host-source 精确匹配，`https://gstatic.cn` **不**匹配 `https://www.gstatic.cn`：
       * 源码里肉眼看是「加了 gstatic.cn」，浏览器里照样拦。
       */
      name: 'R41-01b · CSP 把实现脚本域名写成 gstatic.cn（少一个 www = 仍然被拦）',
      file: 'server/index.js',
      anchor: '    + "script-src \'self\' https://www.recaptcha.net https://www.gstatic.com https://www.gstatic.cn https://challenges.cloudflare.com; "',
      replacement: '    + "script-src \'self\' https://www.recaptcha.net https://www.gstatic.com https://gstatic.cn https://challenges.cloudflare.com; "',
      testFile: 'audit41-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R41-02a：保存时只写「当前选中」的那一套（= 旧扁平结构的思路）。
       * 后果：切一次服务商，另一家的密钥就被悄悄丢弃 —— 需求要的正是「两套同时保存」。
       */
      name: 'R41-02a · saveCaptcha 只写选中服务商（切换服务商即丢掉另一套）',
      file: 'server/config-store.js',
      anchor: '  for (const name of CAPTCHA_PROVIDERS) {\n'
        + '    const e = incoming[name];\n'
        + '    if (!e || typeof e !== \'object\') continue;',
      replacement: '  for (const name of CAPTCHA_PROVIDERS.filter((n) => n === provider)) {\n'
        + '    const e = incoming[name];\n'
        + '    if (!e || typeof e !== \'object\') continue;',
      testFile: 'audit41-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R41-02b：派生视图写死取 reCAPTCHA 那一套（而不是选中那一套）。
       * 后果：切到 Turnstile 后，服务端仍在用 reCAPTCHA 的密钥校验、前端仍渲染 reCAPTCHA 组件 ——
       * 「切换」在界面上看着成功了，实际一点没生效。
       */
      name: 'R41-02b · getCaptcha 的派生 siteKey/secretKey 固定取 reCAPTCHA（切换不生效）',
      file: 'server/config-store.js',
      anchor: '  const providersMap = captchaProvidersOf(c);\n  const sel = providersMap[provider];',
      replacement: '  const providersMap = captchaProvidersOf(c);\n  const sel = providersMap.recaptcha;',
      testFile: 'audit41-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R41-02c：**顺序陷阱** —— 先取密钥、再决定用哪一家。
       *
       * 环境变量 `CAPTCHA_PROVIDER` 把生效方切到 Turnstile，而密钥却按**存储里**的
       * reCAPTCHA 取：前端会拿着 reCAPTCHA 的 siteKey 去渲染 Turnstile 组件（渲染失败），
       * 服务端也会拿错密钥去回源校验。
       */
      name: 'R41-02c · resolveConfig 先取密钥再定服务商（环境变量切家后取错那一套）',
      file: 'server/captcha.js',
      anchor: '  const sel = (byProvider[merged.provider] && typeof byProvider[merged.provider] === \'object\')\n'
        + '    ? byProvider[merged.provider] : null;',
      replacement: '  const keyProvider = stored.provider === \'turnstile\' ? \'turnstile\' : \'recaptcha\';\n'
        + '  const sel = (byProvider[keyProvider] && typeof byProvider[keyProvider] === \'object\')\n'
        + '    ? byProvider[keyProvider] : null;',
      testFile: 'audit41-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R41-02d：旧扁平配置不再被迁进它当时选中的那一套。
       * 后果：升级到本版本后，管理员原有的 siteKey/secretKey 凭空消失，登录页无验证码可用。
       */
      name: 'R41-02d · 旧扁平配置不再迁进 providers[provider]（升级后密钥凭空消失）',
      file: 'server/config-store.js',
      anchor: '    if (!e.siteKey && !e.secretKey && p === flatProvider) {',
      replacement: '    if (!e.siteKey && !e.secretKey && p === \'recaptcha\') {',
      testFile: 'audit41-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R41-02e：把「空串 = 保持原密钥」当成「清空」。
       * 后果：界面上的密码框永远不回填明文、每次保存都提交空串 ⇒ 管理员只改一下超时时间，
       * 两套密钥当场清空，登录立刻被 `captcha_not_configured` 拦死。
       */
      name: 'R41-02e · saveCaptcha 把空串当作清除密钥（改一次超时即清空密钥、锁死登录）',
      file: 'server/config-store.js',
      anchor: '    else if (e.secretKey !== undefined && e.secretKey !== \'\') cur.secretKey = String(e.secretKey);',
      replacement: '    else if (e.secretKey !== undefined && e.secretKey !== null) cur.secretKey = String(e.secretKey || \'\');',
      testFile: 'audit41-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R41-02f：管理端视图把明文 secretKey 一起下发。
       * 后果：服务端密钥只该用于回源校验，一旦进入响应体就等于「任何拿到管理员会话的人
       * 都能把密钥导出带走」（浏览器缓存 / 代理日志 / 前端内存四处都是）。
       */
      name: 'R41-02f · GET /captcha/config 下发明文 secretKey（密钥外泄）',
      file: 'server/routes/captcha.js',
      anchor: '    out[name] = { siteKey: String(e.siteKey || \'\'), hasSecret: Boolean(e.secretKey) };',
      replacement: '    out[name] = { siteKey: String(e.siteKey || \'\'), hasSecret: Boolean(e.secretKey), secretKey: String(e.secretKey || \'\') };',
      testFile: 'audit41-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R41-02g：空判据只看扁平键（漏掉 providers）。
       * 后果：只配了 Turnstile 的实例被判定为「全新」⇒ 导入闸门打开 ⇒ 一次点击把已配置的
       * 那一套静默覆盖掉，而界面上没有任何提示。
       */
      name: 'R41-02g · isEmptyData 漏掉 providers（只配了 Turnstile 仍允许导入、静默覆盖）',
      file: 'server/backup.js',
      anchor: '  const capProvs = (cap.providers && typeof cap.providers === \'object\') ? cap.providers : {};',
      replacement: '  const capProvs = {};',
      testFile: 'audit41-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R41-02h：备份不再携带两套凭证。
       * 后果：恢复后另一家（多半是尚未启用的那一家）的密钥没了，管理员得回服务商控制台
       * 重新申请一遍 —— 备份「能用」但没保住该保住的东西。
       */
      name: 'R41-02h · 备份不再携带两套凭证（恢复后另一家密钥丢失）',
      file: 'server/backup.js',
      anchor: 'function captchaProviders(cap) {\n  return configStore.captchaProvidersOf(cap || {});\n}',
      replacement: 'function captchaProviders(cap) {\n  return { recaptcha: { siteKey: \'\', secretKey: \'\' }, turnstile: { siteKey: \'\', secretKey: \'\' } };\n}',
      testFile: 'audit41-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R41-02i：前端只提交「当前选中」那一家的输入框。
       * 后果：正是需求点名的那个毛病 —— 切换服务商时另一套被清空。
       */
      name: 'R41-02i · 前端只提交选中服务商（切家即清空另一套）',
      file: 'public/js/syssettings.js',
      anchor: '  for (const p of CAPTCHA_PROVIDERS) {\n'
        + '    const sk = document.getElementById(\'captcha-sitekey-\' + p);\n'
        + '    const se = document.getElementById(\'captcha-secretkey-\' + p);',
      replacement: '  for (const p of [chipValue(\'captcha-provider\') || \'recaptcha\']) {\n'
        + '    const sk = document.getElementById(\'captcha-sitekey-\' + p);\n'
        + '    const se = document.getElementById(\'captcha-secretkey-\' + p);',
      testFile: 'audit31-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R41-02j：回填时把两家的站点密钥都写进 reCAPTCHA 那一个输入框（串台）。
       * 后果：界面显示的密钥与它标注的服务商对不上，管理员照着改只会越改越乱。
       */
      name: 'R41-02j · 前端回填串台（两家的密钥都写进 reCAPTCHA 的输入框）',
      file: 'public/js/syssettings.js',
      anchor: '    const siteKey = document.getElementById(\'captcha-sitekey-\' + p);\n'
        + '    if (siteKey) siteKey.value = e.siteKey || \'\';',
      replacement: '    const siteKey = document.getElementById(\'captcha-sitekey-recaptcha\');\n'
        + '    if (siteKey) siteKey.value = e.siteKey || \'\';',
      testFile: 'audit31-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R41-02k：通用 `save()` 不再归一 captcha。
       * 后果：一次带扁平 `siteKey` 的部分写入会与 `providers` 并存两个真相，而读取侧只认
       * `providers` ⇒ **写入静默失效**（接口回 ok、界面显示已保存，登录页却拿不到 siteKey）。
       */
      name: 'R41-02k · save() 不再归一 captcha（扁平键写入静默失效）',
      file: 'server/config-store.js',
      anchor: '  normalizeCaptchaInto(cur);\n  return persist(cur);',
      replacement: '  return persist(cur);',
      testFile: 'audit41-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R41-02l：启用校验把「另一家配好了」当成「这一家配好了」。
       * 后果：管理员切到一家空配置的服务商并点保存，功能被启用、登录页却渲染不出组件 ⇒
       * 所有人被 `captcha_not_configured` 挡在门外。
       */
      name: 'R41-02l · 启用校验拿另一家的凭证放行（切换后锁死登录）',
      file: 'public/js/syssettings.js',
      anchor: '    if (!sel.siteKey) { showMsg(`启用验证码需填写「${captchaProviderName(provider)}」的站点密钥（Site Key）`, \'bad\'); return; }',
      replacement: '    const otherKey = CAPTCHA_PROVIDERS.some((x) => { const el = document.getElementById(\'captcha-sitekey-\' + x); return !!(el && (el.value || \'\').trim()); });\n'
        + '    if (!sel.siteKey && !otherKey) { showMsg(`启用验证码需填写「${captchaProviderName(provider)}」的站点密钥（Site Key）`, \'bad\'); return; }',
      testFile: 'audit31-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R41-02m：路由把空串也当成「清除密钥」。
       * 后果与 R41-02e 同型，只是发生在边界层：前端每次保存都提交空串（密码框不回填明文），
       * 于是每点一次「保存设置」都会把这一家的服务端密钥清掉。
       */
      name: 'R41-02m · PUT /captcha/config 把空 secretKey 当成清除（每次保存都清密钥）',
      file: 'server/routes/captcha.js',
      anchor: '  if (entry.secretKey === null) out.secretKey = null;',
      replacement: '  if (entry.secretKey === null || entry.secretKey === \'\') out.secretKey = null;',
      testFile: 'audit41-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R42-01a：把「跨厂商不继承」这条判据整个去掉 = 修复前的形态。
       *
       * 后果：`/api/config/verify` 验证**别家**密钥时，会把当前激活桶的
       * region / bucket / endpoint 一起带上 —— 用华为云密钥实际打向
       * `obs.ap-southeast-2.myhuaweicloud.com`（华为云没有该地域）⇒ DNS 失败，
       * 界面只说「网络连接异常」；又拍云更隐蔽：端点固定且正确，错的是**签名地域**。
       * 用户可见症状即「密钥完全正确却验不过」，且「谁先配好谁正常」。
       */
      name: 'R42-01a · /config/verify 跨厂商继承激活桶的 region/bucket/endpoint（正确的 key 也验不过）',
      file: 'server/routes/config.js',
      anchor: '    const sameProvider = !reqProvider\n      || reqProvider === String(stored.provider || providers.DEFAULT_PROVIDER_ID);',
      replacement: '    const sameProvider = true;',
      testFile: 'audit42-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R42-01b：只把 `region` 的一处继承放开（bucket / endpoint 仍受控）。
       * 单点变异，用来定位「究竟是哪一项污染了验证」——
       * 端点由地域推导的厂商（华为云 / 七牛 / B2）会因此打到不存在的主机。
       */
      name: 'R42-01b · /config/verify 只把 region 的继承放开（端点被别家地域拼走）',
      file: 'server/routes/config.js',
      anchor: 'const region = (b.region && String(b.region).trim()) || inherit(stored.region);',
      replacement: "const region = (b.region && String(b.region).trim()) || stored.region || '';",
      testFile: 'audit42-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R42-01c：只把 `bucket` 的继承放开。
       * 后果：拿激活桶（属于别家厂商）的名字去本厂商做 headBucket 存在性探测 ——
       * 即便密钥有效，也会得到「未找到存储桶 / 存储桶验证失败」。
       */
      name: 'R42-01c · /config/verify 只把 bucket 的继承放开（拿别家的桶名去探测）',
      file: 'server/routes/config.js',
      anchor: 'const bucket = (b.bucket && String(b.bucket).trim()) || inherit(stored.bucket);',
      replacement: "const bucket = (b.bucket && String(b.bucket).trim()) || stored.bucket || '';",
      testFile: 'audit42-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R42-01d：只把 `endpoint` 的继承放开。
       * 后果最直白：阿里云等「有固定端点」的厂商 `effective().endpoint` **恒非空**，
       * 于是别家密钥的请求被原样发到它的域名上。
       */
      name: 'R42-01d · /config/verify 只把 endpoint 的继承放开（请求发到别家域名）',
      file: 'server/routes/config.js',
      anchor: '(b.endpoint && String(b.endpoint).trim()) || inherit(stored.endpoint)',
      replacement: "(b.endpoint && String(b.endpoint).trim()) || stored.endpoint || ''",
      testFile: 'audit42-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R42-02a：撤掉华为云的 UNSIGNED-PAYLOAD 声明。
       * 华为云 OBS 的 V4 只支持 UNSIGNED-PAYLOAD（与流式分块），发真实载荷哈希
       * 必得 403 SignatureDoesNotMatch，且报文不带任何线索 ⇒ 界面显示
       * 「签名错误：请检查 AccessKey / SecretKey 是否正确」，把运维引向轮换一把
       * 完全有效的密钥。
       */
      name: 'R42-02a · 华为云不再声明 unsignedPayload（发真实载荷哈希 = OBS 403）',
      file: 'server/providers.js',
      anchor: '    unsignedPayload: true,',
      replacement: '    unsignedPayload: false,',
      testFile: 'audit42-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R42-02b：把「按厂商下发」改成「一律 true」——
       * 看着更「安全」，实际会把七牛打挂（其 S3 文档明确要求每个请求带 payload 的 sha256）。
       * 这条同时压住两个方向：华为云必须开，别家必须不开。
       */
      name: 'R42-02b · unsignedPayload 不再按厂商判定（一律 true = 七牛等被拒）',
      file: 'server/providers.js',
      anchor: 'return resolve(id).unsignedPayload === true;',
      replacement: 'return true;',
      testFile: 'audit42-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R42-02c：客户端拿到标志却不用（注册表是对的，`s3-client` 丢了）。
       * 「配置层改好了、执行层没执行」—— 本项目反复踩过的形态，必须单独一条。
       */
      name: 'R42-02c · s3-client 忽略 unsignedPayload 标志（注册表正确但执行层失效）',
      file: 'server/s3-client.js',
      anchor: 'if (this.unsignedPayload) payloadHash = UNSIGNED_PAYLOAD;',
      replacement: 'if (false && this.unsignedPayload) payloadHash = UNSIGNED_PAYLOAD;',
      testFile: 'audit42-regressions.test.js',
      minFail: 1,
    },
    {
      /*
       * R42-02d：顺手给七牛也开上（「多开一家更保险」的直觉错法）。
       * 七牛 Kodo 的 S3 文档明确要求真实载荷 sha256，开成 UNSIGNED-PAYLOAD 会被拒。
       */
      name: 'R42-02d · 七牛云也被声明 unsignedPayload（该家明确要求真实载荷哈希）',
      file: 'server/providers.js',
      anchor: "credentialLabel: { id: 'AccessKey', key: 'SecretKey', idPlaceholder: '请输入 AccessKey' },",
      replacement: "credentialLabel: { id: 'AccessKey', key: 'SecretKey', idPlaceholder: '请输入 AccessKey' },\n    unsignedPayload: true,",
      testFile: 'audit42-regressions.test.js',
      minFail: 1,
    },
  ];

module.exports = { runCase, CASES, parseArgs };

/**
 * 解析命令行参数（**独立成函数**，便于被测试直接驱动）。
 *
 * 过滤**只认** `--only=<片段>`；位置参数一律**报错**。
 *
 * ⚠️ 早期版本对被忽略的位置参数一声不吭：`node scripts/reverse-check.js R35-01`
 * （本意「只跑这一轮」）会**静默**跑满全量台账 —— 全量 315 条里含 36 条以
 * `deploy-script.test.js` 为对象的对照，而那一个文件单跑就要约 2.5 分钟，加起来是
 * **数小时**。实测踩过一次：10 分钟才跑完 14 条，只能强杀，而强杀会留下一个
 * **正处于变异态**的源文件（`*.reversebak` 里能看出是哪一个）。
 *
 * 「看着筛了、其实没筛」与护栏假绿同源（都是判据没落在它声称要守的东西上），
 * 故这里直接报错，而不是打个提示继续跑。
 *
 * 校验**放在纯函数里**而不是内联在主流程：内联的话只能用「源码里有没有这段字样」
 * 去断言，而本文件里还存着这条对照自己的 anchor 字面量 —— 文本断言会被那份副本满足，
 * 于是**永远为真**（实测就是这么得到一次 fail=0 的假绿）。
 */
function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const onlyArg = args.find((a) => a.startsWith('--only='));
  const stray = args.filter((a) => a.indexOf('--only=') !== 0);
  if (stray.length) {
    return {
      error: '无法识别的参数：' + stray.join(' ')
        + '\n按用例名过滤请用 `--only=<片段>`（例如 --only=R35-01）；'
        + '不带参数 = 跑**全量**台账（很慢，且含 36 条 2.5 分钟级的 deploy-script 对照）。',
    };
  }
  return { only: onlyArg ? onlyArg.slice('--only='.length) : '' };
}

/* 直接运行时执行下面登记的用例 */
if (require.main === module) {
  // `--only=<片段>` 按 name 过滤，便于单条复核（全量跑一遍耗时较长）
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    console.error(parsed.error);
    process.exit(2);
  }
  const only = parsed.only;
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
