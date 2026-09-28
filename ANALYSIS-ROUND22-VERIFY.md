# Kepler 审计结论复核报告（第 22 轮 · 独立验证）

- 复核对象：`ANALYSIS-ROUND22.md` 的全部 6 条正式发现（R22-01 ~ R22-06）
- 复核方式：逐条回到源码/文档/测试核对，不采信报告自述的 grep 结论，全部重新执行
- 复核原则：不作新发现；防御（输入校验 / 参数化 / 出参编码 / 鉴权中间件 / CSRF / 边界检查）先排除，再判缺陷
- 基线：`git status` 与报告一致（18 个已修改文件 + `tests/audit21-regressions.test.js` 未跟踪）

## 判定汇总

| 编号 | 判定 | 一句话 |
| --- | --- | --- |
| R22-01 | VALID | 第三分支确未同形，匿名可区分「用户名存在且已启用 Hello」；但危害段的 reason 码列表被夸大 |
| R22-02 | VALID | 默认部署 XFF 首段确为客户端可控，黑名单/限流判据确被请求方接管；两条绕过路径均实测成立 |
| R22-03 | VALID | 4 处裸发 `e.message` 行号逐字命中，已改 2 处同样命中 |
| R22-04 | VALID | 全仓解密下发出口确为 3 处，WebDAV 出口确无任何门禁；但「中危」定性应与文档口径对齐 |
| R22-05 | VALID | README:258 原文与 Cookie 通道确矛盾，护栏确不覆盖该句 |
| R22-06 | VALID | 注释顺序与实现顺序确相反 |

无 INVALID、无 NEEDS_CONTEXT。

## 逐条判定明细

| 编号 | 判定 | 理由（引用代码/数据流） | 修正建议（若 VALID 但描述有误） |
| --- | --- | --- | --- |
| R22-01 | VALID | ① 同形性：`server/routes/auth.js:157-162` 的 `authFail` 固定回 `401 {error:'Windows Hello 验证失败，请重试'}`，**无 `reason` 键**；`:185-190` 第三分支回 `{error: webauthn.publicReason(r.reason), reason: r.reason}` —— 文案与键集两处均不同，报告判据成立。② 可达性：`server/webauthn.js:499-500` 第一句即 `consumeChallenge(expectedChallenge,'login',expectedUserId)`，**早于任何密码/凭据校验**；`auth.js:176` 传 `String(b.challenge \|\| '')`，空串命中 `webauthn.js:367 → challenge_missing`，文案见 `:554`。故 `{username}` 单字段匿名请求即可到达第三分支。③ 端点匿名：`server/index.js:139` 白名单含 `/auth/login/webauthn`；`:141` CSRF 仅要求自定义头，脚本客户端可自设，**不构成防御**。④ 限流非阻断：`auth.js:36-38` 锁定键为 `ip+username`，换用户名即换键；`index.js` 无 `app.set('trust proxy')` 之类的 IP 加固。⑤ 护栏缺口：`tests/audit21-regressions.test.js:218` 把 `isWebauthnEnabled` 打桩为恒 `false`，第三分支**物理上不可达**，故 `:226-230` 断言恒成立。 | 危害段列举的 `rp_id_mismatch` / `client_data_origin_mismatch` / `sign_count_regression` 等 reason 码**匿名不可达**：这些码位于 `webauthn.js:517/509/532`，均在 `:499` 通过 `consumeChallenge` **之后**；而有效 login challenge 仅由 `auth.js:113` 在**密码校验通过后**签发，`routes/webauthn.js:60` 的签发点需已登录会话（`me.id`）。匿名实际只能拿到 `challenge_missing` / `challenge_unknown` / `challenge_expired`。建议把危害收窄为「用户名 × 是否启用 Hello 的状态 oracle」，删去「探测服务端配置」的推测。 |
| R22-02 | VALID | ① 取值链：`server/security.js:49-55` `forwardedClientIp()` 直接 `xf.split(',')[0].trim()`，**无 IP 格式校验**；`:67-72` 经 `normalizeIp`（`:33-38`，仅剥 `::ffff:` 与 `::1`）原样返回并置 `fromForwarded:true`。② 默认部署确为危险组合：`deploy.sh:1658` 生成的 `.env` **无条件**写入 `TRUST_PROXY=1`（同段注释即为「位于 Nginx 之后」）；`deploy.sh:1914` `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` —— 该变量语义为「客户端原值 + `, $remote_addr`」，**首段即客户端原样送入的值**。③ 绕过路径 A（非法串）：`ip-guard.js:38-40` `ipv4ToInt` 正则不匹配即返 `null` → `:136-144` `parseIpInfo` 返 `null` → `:670-679` 桶级/全局黑名单**整体包在 `if (info)` 内被跳过**；随后 `:682` 判据 `!isChinaIP(ip) && !isPrivateIP(ip)`，其中 `isChinaIP` 对不可解析值返 `false`（`:230-231`），`isPrivateIP` 返 `true`（`:252-253`），故整个条件为假 → `:685` 放行。路径 B（合法私网）：`:255-257` `10/8`、`172.16/12`、`192.168/16` 均命中 `isPrivateIP` → 同样放行。④ 报告对 R17-01 边界的描述准确：`:665-667` 的回环豁免已正确限定 `!fromForwarded`，但只覆盖 `127.0.0.1` / `::1` **这一种取值**。⑤ 同源污染面确认：`security.clientIp` 被 `auth.js:42`、`share-routes.js:649/764/901/962/986/1154/1190/1304`、`routes/enc.js:51`、`webdav-server.js:350` 等十余处消费，故「限流与失败锁定一并按伪造值判定」属实。⑥ 文档自证：`Develop_Document.md:578` 原文「请确保最外层代理会**重写**而非追加该头」，与默认 `$proxy_add_x_forwarded_for` 直接冲突。 | 无（行号、变量名、判据、默认值逐项命中）。可补强一句：`ip-guard.js:713-714` 的命中记账与 `:730`（JSON body）、`:739`（`escapeHtml` 后的 HTML 页）确实回显该伪造值 —— 报告只声称「回显」未声称 XSS，表述无误（`:719-723` 已转义）。 |
| R22-03 | VALID | 逐行核对 `server/webdav-server.js` 六处同型 catch，命中率 6/6：`:706` 与 `:765` 已用 `davErrorMessage(e)`（与报告「已改 2 处」一致）；`:596`（PROPFIND）、`:784`（MKCOL）、`:815`（DELETE）、`:1103`（COPY）**确为裸 `e.message`**，其中后两处为 `... === 404 ? '404 Not Found' : e.message` 形态。`davErrorMessage`（`:38-42`）判据为 `e.statusCode !== undefined \|\| e.rawMessage !== undefined` → 上游错误走 `translateError` 分类文案，与全项目口径一致，故未改处确属偏离。护栏缺口亦确认：`tests/audit21-regressions.test.js:564-583` 仅驱动纯函数 `webdav.__davErrorMessage`（导出点 `webdav-server.js:1260`），三条断言全在函数级，无 PROPFIND/MKCOL/DELETE/COPY 的请求级用例 —— 撤掉这 4 处**不会变红**。 | 无。描述与代码逐字一致，「中危」定级亦合理（上游 SDK message 可能含请求 ID / 端点 / AccessKeyId 片段，见文件头 `:26-36` 的自述判据）。 |
| R22-04 | VALID | 出口穷举已独立复跑，结果与报告完全一致：`grep -rn "decrypt: *true" server/` 全仓**仅 1 处** = `webdav-server.js:664`；`streamDownload(` 调用点**仅 2 处** = `routes/fs.js:863`、`share-routes.js:1363`。三门禁状态：`routes/fs.js:852-856` 有 `encMeta && encStore.passwordSet()` + `verifyToken(req.get('x-enc-token'))`（HEAD 侧 `:823-829` 同）✅；`share-routes.js:200-204` `encGateNeeded()` 分别在 `:689`（分享页）、`:1247`（HEAD）、`:1278`（GET）判定 ✅；`webdav-server.js` 内 `grep "x-enc-token\|passwordSet()\|encStore"` **命中数 0** ❌。故「同一控制在不同出口结论不同」为确证事实，且 `README.md:258` 的口径（「查看 / 下载加密文件前须验证」）未排除 WebDAV。 | 把定级由「中」下调或改写为「出口口径不一致（待产品口径确认）」更稳：可利用前提是**持有管理员签发的 WebDAV 凭据**（`config-store.js:1450-1463` 起于 `cfg.webdav.accounts.find(...)`，且 `:1452` 要求 `cfg.webdav.enabled`，非自助注册），而代码注释与 README/Develop_Document 均**未声明**该控制是否覆盖 WebDAV —— 报告 §3 U2 已自承此点未确认，正文定级宜与之一致，否则属于「以未确认的设计意图支撑定级」。建议改为「文档未声明 WebDAV 出口的加密门禁归属」，把与 R21-01 同族的「口径不一致」作为主结论。 |
| R22-05 | VALID | `README.md:258` 原文逐字确认：「……令牌**仅通过 `x-enc-token` 请求头**传递」。实现侧 Cookie 通道确认存在：`share-routes.js:107` `const ENC_COOKIE = 'ke_enc'`；`:207-210` `encTokenOf()` = 请求头优先、回落 `getCookie(req, ENC_COOKIE)`；`:1172` 解锁成功即 `res.cookie(ENC_COOKIE, t.token, encCookieOptions())`（`:217-219` 起 `httpOnly`）。同时确认「两套互不干扰」为真：管理端 `routes/fs.js:826`、`:855` **只读** `x-enc-token`，不读 Cookie，故 README 该句对管理端成立、对分享路径不成立。护栏缺口确认：`tests/docs-sync.test.js` 的断言集中在目录结构（`:236-254`）、data 文件清单（`:112-138`、`:321-344`）、环境变量表（`:281-302`）、编号台账与计数（`:147-271`），**未校验该句语义**。 | 建议不删除、改为限定作用域，例如：「管理端 `/api/**` 的令牌仅经 `x-enc-token` 头传递；分享页 `/s/` 另发一枚 `HttpOnly`、`path=/s/` 的 Cookie」。定级「低」恰当（实现可接受，问题纯在文档未同步）。 |
| R22-06 | VALID | 注释 `server/security.js:144` 写明「目标选取顺序：**被允许的请求 Host → 配置的站点主/备域名 → 本机 HOST**」；实现 `:158-168` 的实际顺序为 请求 Host（`:161-163`）→ 本机 `HOST`（`:164-165`，`!isBindAllHost(local)` 即**直接返回**）→ 配置站点域名（`:166-167`）。当 `HOST` 为具体地址（非通配）且同时配置了 `cfg.domains.primary` 时，跳转目标取 `HOST`，与注释承诺相反。`isOwnSiteHost` / `configuredSiteHost`（`:109-132`）的调用关系与报告描述一致。确认为注释与实现不符，非安全缺陷（两个候选均为本站地址）。 | 改注释为「请求 Host → 本机 HOST（非通配时）→ 配置的站点主/备域名 → 通配回退并告警」，或调整实现顺序与注释一致。二者任选，但**必须只改一边**，否则下轮会再次被报为「文档不同步」。 |

## 反偏见检查记录

| 检查项 | 结论 |
| --- | --- |
| 是否因「多轮/多模型共现」而放宽判定 | 否。6 条全部回到当前工作区源码逐行复核，未引用任何前轮结论作为证据（报告中「R21-05 已判定完全修复」「R17-01 已修」「R21-16 登记未修」等跨轮表述均**未被采信**，本轮结论只依赖当前代码状态；工作区内亦不存在 `ANALYSIS-ROUND21.md` 可供交叉验证，故这些跨轮描述属不可验证陈述，不影响判定）。 |
| 是否把防御误判为漏洞 | 逐条排查：`index.js:141` CSRF 头（R22-01 中已排除为「不防 API 客户端」而非漏洞）；`ip-guard.js:665-667` 回环豁免（**正确**的防御，R22-02 明确定位其边界已排除，未误判为漏洞）；`webdav-server.js:671-673` `Content-Disposition: attachment` + CSP（未涉及）；`ip-guard.js:719-723` `escapeHtml`（**已生效**，报告未误报为 XSS）；`webauthn.js:499-500` 挑战一次性消费（R22-01 未误判为绕过，仅指响应不同形，**正确**）。无一条属防御误判。 |
| 是否因「听起来危险」而判 VALID | R22-04 是唯一存在此类风险的条目 —— 其事实成立但「是否构成越权」取决于未确认的设计意图，已在修正建议中要求下调定级并改写定性。其余 5 条均有可执行/可比对的确定性证据。 |
| 是否存在报告未覆盖但被顺带断言的结论 | 报告 §4「已核查确认无问题的项」本轮抽样复核了其中 2 项，与结论一致：① `routes/fs.js:879-882` 的 `/fs/thumb` 对密文对象确返回「已加密」占位 SVG，不解密；② `routes/fs.js:826`、`:855` 确只读 `x-enc-token`，Cookie 不能用于 `/api/**`。未发现反例。 |

## 复核结论

- **6/6 全部成立**，无需剔除；无幻觉条目、无防御误判。
- 需要**改写描述（但不改判定）**的只有 2 处：R22-01 的危害段（reason 码匿名不可达）、R22-04 的定级与定性（设计意图未确认）。
- 需要**补护栏**的最小集：`audit21-regressions.test.js` 增补第三分支用例（用户存在且已启用 Hello + 空 challenge）；`webdav` 增补 PROPFIND/MKCOL/DELETE/COPY 的请求级用例（当前仅函数级，4 处裸 `e.message` 撤掉不变红）。

## 处理记录（R22 修复轮）

> 编号与判定沿用上文；只记最终落点，不重复证据。所有护栏都做了反向变异验证（`node scripts/reverse-check.js --only=R22` → 10/10 `fail=1`）。

| 编号 | 判定 | 处置 | 落点 |
| --- | --- | --- | --- |
| R22-01 | VALID | **已修**：第三支并入 `authFail()`（状态码 / 文案 / 计数三同形），`r.reason` 只进服务端日志 | `server/routes/auth.js`；护栏 1 条；反向对照 1 条 |
| R22-02 | VALID | **已修（双保险）**：`deploy.sh` 反代片段改 `$remote_addr` **重写**；`security.forwardedClientIp` 增 `isIpLiteral()` 格式校验，非法值判为「未知且不享回环豁免」 | `deploy.sh` / `server/security.js`；护栏 2 条；反向对照 2 条 |
| R22-03 | VALID | **已修**：PROPFIND / MKCOL / DELETE / COPY 四处的裸 `e.message` 全部改调 `davErrorMessage(e)`；护栏由函数级改为**调用点层**静态不变量 | `server/webdav-server.js`；护栏 1 条；反向对照 4 条（每处一条） |
| R22-04 | VALID | **按建议改口径**：不新增门禁（会破坏现有 WebDAV 客户端），改为在 README 与开发文档写明「WebDAV 出口不叠加查看密码」，并与代码事实**双向绑定** | `README.md` / `Develop_Document.md`；护栏 1 条；反向对照 1 条 |
| R22-05 | VALID | **已修（限定作用域，不删除）**：管理端 `x-enc-token` 请求头 / 分享页 `HttpOnly` + `path=/s/` Cookie 两条通道各自写明 | `README.md`（开发文档 §1.4 同步）；护栏 1 条；反向对照 1 条 |
| R22-06 | VALID | **已修（只改注释一边）**：注释改为「请求 Host → 本机 HOST（非通配时）→ 站点主/备域名 → 通配回退并告警」，与实现逐项同序 | `server/security.js`；护栏 1 条；反向对照 1 条 |

### 「补护栏最小集」的落实

- **第三分支用例** → 新建 `tests/audit22-regressions.test.js`（未改 `audit21` 的 R21-05 用例：它钉的是「用户不存在 / 未启用」两支，与本轮的第三支互补）。新文件显式造出「已启用 Hello + 空 challenge」这条**可达**路径。
- **WebDAV 调用点层护栏** → 采用本报告给出的替代方案（「加一条静态不变量『该文件内不得存在裸 `send(e.message)`』」），并按「每个会被独立摘掉的地方都要有自己的断言落点」为四处各登记一条反向对照。判据覆盖两种同型写法：`.send(e.message)` 与 `.send(cond ? '404 Not Found' : e.message)` —— 只匹配前者的写法会让 DELETE / COPY 两处「撤不撤都不变红」（本轮的第一次实现正是踩了这个坑，跑反向对照时暴露）。

### 顺带处置（不在 6 条之内）

- `SCAN-SKIPLIST.md` 已不在工作区（该清单不纳入 git）：`audit21-regressions.test.js` 的 R21-15 用例改为「文件缺失即跳过」；`scripts/reverse-check.js` 的对应条目改 `retired: true` + 写明原因 —— 否则其 anchor 会连带把 `tests/invariants.test.js` 的「anchor 必须命中」自检拖红，把真实失效藏在环境噪音里。
- 本报告自身的表格原为 `|a|b|` 形态，触发 `docs-sync` 的紧凑型检查（该判据要求 `| a | b |`，单元格两侧各留**一个**空格），已重排。
- 版本号 v1.2.2 → **v1.2.3**（`package.json` / 锁文件 / 开发文档头部 / 前端页脚），并同步 `docs-sync` 关心的清单（测试文件数 34→35、runner 599→606、静态 `test(` 555→562、目录结构、第 6.4 节轮次表新增 R22 行）。

### 基线与验证

| 时点 | runner 汇总 |
| --- | --- |
| 本轮开始时 | 599 条 / 594 通过 / 5 红（其中 3 条是本轮新暴露的：R21-15 清单缺失、报告表格 pad、`invariants` 的 anchor 自检；另 2 条为环境性 RE-03 / R7-07） |
| 修复后 | **606 条 / 603 通过 / 1 跳过 / 2 红**（只余环境性 `RE-03` / `R7-07`，失败名单逐字未变） |

- 定向复跑：`tests/docs-sync.test.js` 20/20、`tests/invariants.test.js` 45/45、`tests/audit22-regressions.test.js` 7/7、`tests/audit21-regressions.test.js` 11/12（1 跳过）。
- 反向对照：`node scripts/reverse-check.js --only=R22` → **10/10 `fail=1`**，无 `.reversebak` 残留。
- **残留（下一轮候选）**：`forwardedClientIp` 仍取**首段**。默认部署已因 Nginx 改「重写」而不再可注入；但自建 / 老配置若仍**追加**该头，一个语法合法的内网地址（如 `10.0.0.1`）仍能通过格式校验（这属产品/部署口径，本轮按既定方案未改）。若要彻底与部署方式解耦，可改为取**最后一跳**（与「最外层代理重写」语义等价，且对追加型配置也免疫）。
