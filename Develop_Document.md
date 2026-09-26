# 开发文档

**前言**

为同时管理多家云服务厂商的对象存储系统，并同时有多用户管理、加密、分享、付费、流量监控管理、WebDAV 等需求（**同时也是为了展现本人技术力**），特此研发本系统。

以上。

1. **适用版本**：v1.1.8（取自 `package.json` 的 `version`，由 `tests/docs-sync.test.js` 护栏校验）  
2. **渲染前提与目录兜底**：本文标题为手写 HTML（`<h1 id="develop_document-sectionN">`），目录依赖这些 `id`。若目标渲染器清洗原始 HTML 并剥离 `id`，**目录链接会失效，但目录本身仍然可用**，请按下述方式定位：
   - 目录条目本身是一份完整的章节清单，条目文字与正文标题严格一致（由 `docs-sync` 双向断言保证），按标题文字在页面内搜索即可跳到对应章节；
   - 章节编号 `develop_document-sectionN` 从 1 起**连续递增**（同样由护栏断言），因此「第 N 章」的表述在标题被剥离后仍可换算；
   - 若渲染器连标签一起剥离（标题退化为纯文本），改用保留原始 HTML 的渲染器——GitHub / GitLab / VS Code 预览均保留。
   >
   > **为什么不「在构建期生成锚点」**：本项目**没有构建步骤**（前端是原生 ESM，`public/js/*.js` 直接由浏览器加载；文档是纯 Markdown，不经过任何生成器）。为一个不存在的构建期设计兜底方案没有意义，故此处给的是「失效后如何阅读」而非「如何让它不失效」。

3. **本页面仅适用于开发者，记录设计取舍及具体技术解析等内容。无二次开发或了解技术实现等需求、开箱即用则请直接忽略本文，只需阅读 [README.md](./README.md) 即可。**

4. 由于本系统功能庞杂，且已历经十数个版本迭代、审计和测试，因此必须将所有设计理念、设计意图、测试须知、二开示例等内容全部展开详细讲解才能防止对二开造成困扰，文档内容之巨可能远超阁下的想象。请只选择自己需要的章节进行阅读，阅读整个开发文档是不理智的行为。

5. 整体项目和文档的编写、修改仅由作者一人完成，难免有不足、错误和疏漏之处。若读者发现错漏之处，或有其它建议，请致函 <xingsen2005@sjtu.edu.cn> 指正，在此对所有提出修改建议的朋友表示感谢。

**目录**

- [一、项目概括](#develop_document-section1)
  - [1. 目录结构](#develop_document-section2)
  - [2. 环境变量](#develop_document-section3)
  - [3. 多云架构](#develop_document-section4)
- [二、技术说明](#develop_document-section5)
  - [1. 设计背景与刻意取舍](#develop_document-section6)
    - [1.1 多云协议的历史原因](#develop_document-section7)
    - [1.2 用户 / IP 管理界面按角色物理分离](#develop_document-section8)
    - [1.3 支付系统设计取向](#develop_document-section9)
    - [1.4 支付结果仅限服务端查单返回](#develop_document-section10)
    - [1.5 订单冗余字段用于对账](#develop_document-section11)
    - [1.6 WebDAV 口令为可恢复加密](#develop_document-section12)
    - [1.7 为何不引入 SM4 作为文件加密算法](#develop_document-section13)
    - [1.8 为何不使用对象存储自带的服务端加密](#develop_document-section14)
  - [2. 技术限制与已知局限](#develop_document-section15)
  - [3. 威胁模型与不设防边界](#develop_document-section16)
  - [4. 审计后的行为变更](#develop_document-section17)
  - [5. 安全说明](#develop_document-section18)
  - [6. REST API 模块化组织](#develop_document-section19)
  - [7. HTTP API](#develop_document-section20)
    - [7.1 认证与用户](#develop_document-section21)
    - [7.2 配置、密钥与存储桶](#develop_document-section22)
    - [7.3 文件与上传](#develop_document-section23)
    - [7.4 分享、加密、IP、WebDAV、统计](#develop_document-section24)
  - [8. 支付设置](#develop_document-section25)
    - [8.1 主要校验规则](#develop_document-section26)
    - [8.2 开关层级](#develop_document-section27)
    - [8.3 接口](#develop_document-section28)
    - [8.4 支付状态机](#develop_document-section29)
    - [8.5 各状态切换的字段变化、校验与异常处理](#develop_document-section30)
    - [8.6 已支付凭证](#develop_document-section31)
    - [8.7 订单退款（人工记账）](#develop_document-section32)
    - [8.8 真实支付网关](#develop_document-section33)
    - [8.9 支付结果确认（服务端查单）](#develop_document-section34)
  - [9. 搜索](#develop_document-section35)
  - [10. 性能与可靠性](#develop_document-section36)
- [三、核心模块实现](#develop_document-section37)
  - [1. 文件加密与元数据](#develop_document-section38)
    - [1.1 三种方式与密文结构](#develop_document-section39)
    - [1.2 元数据是解密的唯一凭据](#develop_document-section40)
    - [1.3 分片路径与完整性校验](#develop_document-section41)
    - [1.4 查看密码与访问令牌](#develop_document-section42)
    - [1.5 孤儿元数据巡检](#develop_document-section43)
  - [2. 统一文件网关](#develop_document-section44)
    - [2.1 收口的理由](#develop_document-section45)
    - [2.2 读取路径：信号量与范围请求](#develop_document-section46)
    - [2.3 删除、复制与移动的截断契约](#develop_document-section47)
  - [3. 分片上传与断点续传](#develop_document-section48)
  - [4. 分享链接生命周期](#develop_document-section49)
    - [4.1 标识与快照字段](#develop_document-section50)
    - [4.2 状态判定顺序](#develop_document-section51)
    - [4.3 下载配额与来源判定](#develop_document-section52)
  - [5. 请求上下文与会话鉴权](#develop_document-section53)
  - [6. IP 访问守卫](#develop_document-section54)
  - [7. 速率限制与失败锁定](#develop_document-section55)
  - [8. 列举上限与目录缓存](#develop_document-section56)
  - [9. 统计与操作日志](#develop_document-section57)
  - [10. WebDAV 服务](#develop_document-section58)
  - [11. 服务端点守卫](#develop_document-section59)
  - [12. 上传过滤匹配器](#develop_document-section60)
  - [13. 持久化、启动与关闭](#develop_document-section61)
  - [14. 前端模块与渲染约定](#develop_document-section62)
- [四、测试](#develop_document-section63)
  - [1. 测试与 CI](#develop_document-section64)
  - [2. 测试护栏编写约定](#develop_document-section65)
- [五、开始二次开发](#develop_document-section66)
  - [1. 高层架构总览](#develop_document-section67)
    - [1.1 分层视图与请求链路](#develop_document-section68)
    - [1.2 状态存放与启动顺序](#develop_document-section69)
  - [2. 本地启动与调试](#develop_document-section70)
    - [2.1 启动方式与端口](#develop_document-section71)
    - [2.2 服务端调试](#develop_document-section72)
    - [2.3 前端调试](#develop_document-section73)
  - [3. 最小示例 A：新增一个只读接口](#develop_document-section74)
    - [3.1 第一步：写路由](#develop_document-section75)
    - [3.2 第二步：挂载与依赖注入](#develop_document-section76)
    - [3.3 第三步：补护栏并验证](#develop_document-section77)
  - [4. 最小示例 B：新增一个前端卡片](#develop_document-section78)
  - [5. 二次开发检查清单](#develop_document-section79)
- [六、审计发现台账（合并存档）](#develop_document-section80)

---

<h1 id="develop_document-section1">一、项目概括</h1>

<h2 id="develop_document-section2">1. 目录结构</h2>

```
main/
├── server/
│   ├── index.js            # 入口：HTTP + HTTPS、安全头、鉴权、静态资源、优雅关闭
│   ├── routes.js           # REST API 聚合器（按序挂载 routes/ 子模块）
│   ├── routes/             # 各领域 REST API 子模块 + _context.js / _shared.js
│   ├── providers.js        # 【多云】厂商注册表（唯一元数据来源）
│   ├── payment-providers.js# 【支付】平台凭证字段定义 + 校验引擎（可扩展为真实校验）
│   ├── payment-rules.js    # 【支付】业务规则纯函数：金额 / 渠道开关约束 / 付费是否生效
│   ├── payment-orders.js   # 【支付】付费订单状态机与已支付票据（pending→paid|failed）
│   ├── payment-gateway.js  # 【支付】真实支付网关：支付宝 RSA2 / 微信 APIv3 / PayPal Orders v2（查单确认，零依赖）
│   ├── qrcode.js           # 【支付】自研二维码生成（输出 SVG，零依赖）
│   ├── cos.js              # 【多云】客户端工厂：按 provider 分派 COS SDK / S3Client + 错误翻译
│   ├── s3-client.js        # 【多云】S3 兼容客户端（手写 SigV4，零新增依赖）
│   ├── fs-gateway.js       # 统一文件网关：透明加解密 + 元数据联动 + 审计
│   ├── download-stream.js  # 统一下载流：响应头/管道/背压/超时/流量统计
│   ├── config-store.js     # 配置 v3（多云+多密钥+多桶+用户）AES-256-GCM 加密存储与迁移
│   ├── secure-store.js     # 其他敏感 JSON 的加密落盘（自动升级历史明文）
│   ├── atomic-write.js     # 临时文件 + rename 原子写入 + 启动孤儿 tmp 清扫
│   ├── coalesce.js         # 异步原语：去抖合并写 + 并发合并读（退出收口只注册一个处理器）
│   ├── enc-store.js        # 文件加密核心（三种方式 / 解密流 / 查看令牌 / 元数据迁移）
│   ├── upload-sessions.js  # 分片上传会话持久化与碎片清理
│   ├── share-store.js      # 分享链接存储
│   ├── share-routes.js     # 公开分享页与下载（/s/:id）
│   ├── stats-store.js      # 流量/请求按天聚合 + 操作日志（JSONL）
│   ├── ip-guard.js         # IP 屏蔽（黑名单/海外屏蔽，全局+桶级）
│   ├── china-ips.txt       # 国内 IPv4 段数据（二分查找）
│   ├── auth-session.js     # 内存登录会话（并发上限/强制登出/过期清理）
│   ├── captcha.js          # 登录验证码（含 reCAPTCHA / Cloudflare 开关）
│   ├── webauthn.js         # Windows Hello 校验（零依赖 ES256 + CBOR/COSE 解析 + 挑战池）
│   ├── security.js         # 部署判定/CSRF/失败锁定等公共安全工具
│   ├── endpoint-guard.js   # 服务端点守卫：拦截元数据服务/私网/回环/明文 http（防 SSRF）
│   ├── limits.js           # 列举与扫描上限集中定义
│   ├── list-cache.js       # 目录列举短缓存（进程内，写操作即失效整个桶）
│   ├── search-candidates.js# 搜索候选集缓存（带 TTL，订阅 list-cache 的失效通知，超限自动退化）
│   ├── request-context.js  # 请求上下文（会话 token / 角色 / 当前桶）
│   ├── share-origin.js     # 分享下载「来源判定」纯函数（Sec-Fetch-Site + Referer 分层校验）
│   ├── gzip.js             # 响应 gzip（/api JSON + 静态文本资源，流式接口自动跳过）
│   ├── gitignore.js        # .gitignore 规则解析与过滤
│   ├── local-cert.js       # 本地自签名证书生成与缓存
│   ├── instance-lock.js    # 单实例锁（防止两个进程同时写 data/ 覆盖配置）
│   └── webdav-server.js    # WebDAV（仅 HTTPS，挂载点 /dav/，Basic 认证）
├── public/
│   ├── index.html
│   ├── css/style.css
│   └── js/
│       ├── main.js           # 应用骨架、状态、桶/设置弹窗
│       ├── provider-logos.js # 【多云】7 家厂商元数据与 LOGO（内联 SVG）
│       ├── payment-logos.js  # 【支付】3 家支付平台 LOGO（内联 SVG）
│       ├── paysettings.js    # 【支付】支付设置卡片（表单渲染 / 校验 / 保存，规则全部取自服务端）
│       ├── ordermgr.js       # 【支付】订单管理页（订单流水与对账）
│       ├── credmgr.js        # 访问密钥卡片（厂商选择器 + 服务商列）
│       ├── bucketmgr.js      # 存储桶管理页
│       ├── explorer.js · tree.js · upload.js · ops.js · linkmgr.js
│       ├── dashboard.js      # 监控仪表盘
│       ├── settings.js · syssettings.js · enc.js
│       ├── profile.js        # 「编辑资料」自助弹窗（所有角色可用，与用户管理分离）
│       ├── webauthn.js       # Windows Hello 前端（注册 / 断言 / 就绪判定与错误分类）
│       ├── gitignore.js · help.js
│       ├── api.js · util.js
│       ├── share-status.js  # 分享链接状态判定（与服务端 status() 同序，无 DOM 依赖）
│       ├── pay-poll.js      # 【分享页】支付结果轮询（**普通脚本，非 ESM**：需 document.currentScript 取 data-link-id）
├── tests/                  # 零依赖测试（node:test + 自研断言）
│   ├── helpers.js          # 断言、临时目录、HTTP 请求、端口等待、ESM 语法校验
│   ├── routes-surface.test.js  # 路由表面积护栏
│   ├── payment.test.js     # 支付凭证 / 开关约束 / 金额 / 付费生效判定 / 订单状态机 / 路由鉴权
│   ├── payment-gateway.test.js # 真实网关：签名构造 / 域名选择 / 查单失败即关闭
│   ├── qrcode.test.js      # 自研二维码（对照 ISO 18004）
│   ├── auth-session.test.js     # 登录会话行为
│   ├── s3-client.test.js
│   ├── crypto-storage.test.js
│   ├── frontend.test.js
│   ├── webauthn.test.js    # CBOR / ES256 / authData / 挑战池 / 注册与认证全流程
│   ├── gzip.test.js
│   ├── search-cursor.test.js # 搜索续扫游标与「仅当前目录」单级列举
│   ├── list-cache.test.js   # 目录列举短缓存：失效范围 / TTL / 条目上限
│   ├── search-candidates.test.js # 搜索候选集：TTL / 超限退化 / 等价性（与纯扫描逐字段相同）
│   ├── share-deleted.test.js # 分享链接「对象已删除」标记与惰性探测
│   ├── config-verify-permission.test.js # POST /config/verify 的权限边界
│   ├── docs-sync.test.js   # 文档清单同步护栏（目录结构 / 模块数 / 环境变量表）
│   ├── deploy-script.test.js # 部署脚本护栏：状态持久化 / 全局 kepler 命令 / 菜单编号与分支对应、改初始管理员凭据的内联脚本（vm 内跑真实 config-store）、改密取值必须原样落盘、Nginx 站点目录探测（Debian modules-enabled 陷阱）、nginx 装不上时的兜底可达性、域名带端口校验
│   ├── audit-regressions.test.js  # 回归护栏
│   ├── audit3-regressions.test.js # 第三轮审计护栏
│   ├── audit5-regressions.test.js # 第五轮审计护栏
│   ├── audit6-regressions.test.js # 第六轮审计护栏
│   ├── audit7-regressions.test.js # 第七轮审计护栏
│   ├── audit8-regressions.test.js # 第八轮审计护栏
│   ├── audit9-regressions.test.js  # 第九轮审计护栏（修复验收 + 新发现）
│   ├── audit10-regressions.test.js # 第十轮审计护栏（对第九轮修复的对抗式验收）
│   ├── audit11-regressions.test.js # 第十一轮审计护栏（第 11 轮修复的行为护栏）
│   ├── audit12-regressions.test.js # 第十二轮审计护栏（数据隔离 / 覆盖冲突 / 复制回滚 / 并发回滚）
│   ├── audit13-regressions.test.js # 第十三轮审计护栏（默认安全隔离 / fresh 回滚 / 快照时序 / Overwrite:F / 删源回滚）
│   ├── audit14-regressions.test.js # 第十四轮审计护栏（支付窗口内 pending 不得被裁 / 裁剪必须留日志）
│   ├── audit14-perf.test.js # 第十四轮性能护栏（去抖合并写 / 并发合并读 / 探测去重 / stat 短缓存）
│   └── invariants.test.js        # 跨模块不变量的静态护栏（退出路径 / 删除判据 / 缓存键 …）
├── scripts/lint.js         # ESLint 包装器（未安装时降级）
├── .github/workflows/ci.yml # CI：多平台多版本测试 + Docker 构建冒烟
├── README.md · Develop_Document.md  # 使用说明 / 开发文档（审计发现台账已并入「六、审计发现台账」）
├── Dockerfile · .dockerignore
├── eslint.config.js · .editorconfig
└── data/                   # 运行时数据（自动创建，勿提交 git）
    ├── secret.key          # 配置主密钥（32 字节随机，本机生成）
    ├── config.enc          # 系统配置（含密钥/桶/用户），AES-256-GCM
    ├── enc.key             # 文件加密主密钥（启用加密后生成，务必备份）
    ├── enc-settings.json   # 加密方式与查看密码（加密落盘）
    ├── enc-meta.json       # 密文对象解密参数，按 bucket|key 索引（加密落盘，务必备份）
    ├── links.json          # 分享链接（加密落盘）
    ├── ipguard.json        # IP 屏蔽规则（加密落盘）
    ├── upload-sessions.json# 分片上传会话（加密落盘）
    ├── payments.json       # 支付订单与已支付票据（加密落盘；退款记录永不裁剪）
    ├── stats.json          # 流量与请求统计
    ├── logs.jsonl          # 操作审计日志
    ├── local-cert.json     # 本地自签名证书缓存
    └── .instance.lock      # 单实例锁（含持有者 pid；崩溃残留的脏锁会被自动接管）
```

**`data/` 备份清单**（运维最需要的一页：丢了会怎样、能不能重建）

| 文件 | 丢失后果 | 可从云端重建 | 备份优先级 |
| --- | --- | --- | --- |
| `secret.key` | 配置主密钥丢失 → `config.enc` 与全部敏感 JSON 永久不可读 | 否 | **最高** |
| `enc.key` | 已上云的 crypto 密文永久不可解 | 否 | **最高** |
| `enc-meta.json` | 同上：即使 `enc.key` 仍在，缺 IV / TAG / 盐 依然解不开 | 否 | **最高** |
| `config.enc` | 访问密钥、桶、用户、支付凭证全部丢失 | 否 | 高 |
| `enc-settings.json` | 加密模式与查看密码丢失（查看密码可重置，模式需重设） | 否 | 高 |
| `links.json` | 全部分享链接失效 | 否 | 中 |
| `payments.json` | 订单流水与已支付 / 已退款凭证丢失 —— 退款订单「永不裁剪」本是为了日后可举证，丢了就无从证明 | 否 | 中 |
| `ipguard.json` | 屏蔽规则丢失（可重建） | 否 | 中 |
| `upload-sessions.json` | 未完成的续传会话作废，需重新上传并产生新的分片计费 | 否 | 低 |
| `stats.json` | 历史流量 / 请求统计丢失，不影响功能 | — | 低 |
| `logs.jsonl` | 审计日志丢失（见「技术限制与已知局限」） | — | 低 |
| `local-cert.json` | 下次启动重新生成自签名证书，客户端需重新信任 | — | 无 |

三点必须同时成立才算备份成功：**① `secret.key` + `enc.key` + `enc-meta.json` 三者一起备份**——只备份其中一个等于没备份；② 备份时服务处于停止或空闲状态，避免复制到写了一半的文件；③ 备份点与本机的威胁模型一致（`secret.key` 与 `config.enc` 同目录，能读 `data/` 的人同时拿到二者即可解出全部密钥）。


**换机迁移 / 恢复步骤**（答案是「复制 `data/`」——状态全在该目录，没有数据库）：

1. **停服务**再复制（避免复制到写了一半的文件；所有落盘都走「临时文件 + rename」，但复制过程本身仍可能跨过 rename 时刻）。
2. **整目录复制，必须含 `secret.key` 与 `enc.key`**——只复制 `config.enc` 是不够的，见下。
3. 目标机启动前**删掉 `.instance.lock`**：崩溃残留的脏锁会被自动接管，但跨机复制过来的 pid 在目标机上毫无意义，留着只会多一次无谓的接管判断。
4. 启动后打 `GET /api/health`，确认 `configured: true` 且 `corrupted` 为假；再用 `GET /api/config` 的 `selfTest` 确认密钥材料可用。
5. 若界面能列出桶与对象、但加密文件无法打开——先怀疑 `enc-meta.json` 或 `enc.key` 没跟上，而不是「文件坏了」。

**密钥对应关系**（谁加密了谁，决定了「丢一把密钥到底损失什么」）：

```
secret.key ─┬─派生─→ config.enc            （访问密钥 / 桶 / 用户 / 支付凭证）
            └─派生─→ enc-settings.json · enc-meta.json · links.json
                     ipguard.json · upload-sessions.json · payments.json
enc.key    ───直接─→ 云端对象里的 crypto / magic 密文（文件数据本身）
```

- 丢 `secret.key` → 上面**七个**文件全部读不出，而不只是 `config.enc`；
- 丢 `enc.key` → 云端密文不可解，但 `config.enc` 等**不受影响**（两条链彼此独立）；
- **只复制 `config.enc` 而漏了 `secret.key`**：服务会**新生成一把主密钥**，随后 `config.enc` 解密失败被判为「损坏」→ 备份为 `.corrupt-<时间戳>` 并拒绝写入，服务起不来。**不会**静默清空配置（这是刻意的保护，见「审计后的行为变更」）。此时把 `secret.key` 补回去、把 `.corrupt-*` 改回原名重启即可。

**`enc-meta.json` 的重建边界**（丢了还能不能救）：

| 模式 | 解密参数存在哪 | 缺元数据时可否重建 |
| --- | --- | --- |
| crypto | IV / TAG **同时**写在密文段结构里（`[魔数][IV‖密文‖TAG]…`），元数据里只是**冗余**存了一份 | 参数**冗余存在于云端密文**，理论上可解析重建——但**项目不提供任何重建入口**，手工解析还需知道分片边界（`ctLen`）。**不要依赖它做恢复方案** |
| magic | 异或盐与**被魔数覆写的原始文件头**只存在于元数据 | **不可重建**：盐随机生成且从不写进密文，原始文件头在云端已被覆写 |
| none | — | 不涉及 |

结论不变：`enc-meta.json` 与 `enc.key` 必须**同等备份**，二者缺其一，crypto 密文在操作层面即永久不可解。反向的顾虑（元数据膨胀）由「孤儿元数据巡检」处理，它会列出候选但**不自动删除**（见「核心模块实现 → 孤儿元数据巡检」）。

**密钥轮换：当前版本不可轮换（设计层面的硬约束）**

`secret.key` 与 `enc.key` 都是「文件不存在就新生成一把」，代码里**没有任何 rekey 路径**。由此产生两条必须写进运维手册的后果：

- **不能靠「删掉密钥文件让它重新生成」来轮换**——那等于丢弃旧密钥，旧密文与旧配置立即永久不可读。
- **`secret.key` 泄露**：只能在各厂商控制台吊销并重建子账号访问密钥、重设 WebDAV 口令、重设用户密码（`config.enc` 里的口令哈希随之整体作废）。
- **`enc.key` 泄露**：只能走「全量下载 → 用新密钥重加密 → 重新上传」。顺序是 ① 备份现有 `enc.key` + `enc-meta.json`；② 逐个下载解密出明文（**这一步依赖老元数据，先动密钥就再也解不开**）；③ 停服、移除 `enc.key`（下次启动生成新密钥）；④ 重新上传，由服务端用新密钥加密并写入新元数据。**全程服务不可用，且产生双倍流量与存储费用**。

> 引入密钥版本（`keyId`）+ 平滑轮换需要给每个密文对象与每个敏感 JSON 加版本标记并保留多代密钥，改动面覆盖 `config-store` / `enc-store` / `enc-meta` 索引，风险显著——目前**没有计划**，请按「不可轮换」来做容量与应急预案。

<h2 id="develop_document-section3">2. 环境变量</h2>

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 监听地址；设为 `0.0.0.0` 即进入部署模式（HTTP 强制跳转 HTTPS） |
| `PORT` | `3000` | 本机 HTTP 端口 |
| `HTTPS_PORT` | `3443` | HTTPS 端口（自签名证书） |
| `WEBDAV_PORT` | `8443` | WebDAV 端口（仅 HTTPS） |
| `TRUST_PROXY` | 未设置 | 置于 Nginx / CDN 之后时设为 `1`，信任 `X-Forwarded-*`（识别真实 IP / 协议）；**Windows Hello 场景下若通过反向代理暴露，也必须设置此项**，否则服务端推导的 `origin` 会是内网 `http://` 而拒绝验签。**反向风险**：直连暴露时**严禁**设置——任何人都能用 `X-Forwarded-For` 伪造来源 IP，IP 屏蔽与全部限流会同时失效 |
| `COS_TIMEOUT_MS` | `120000` | 腾讯云 SDK 请求超时 |
| `S3_TIMEOUT_MS` | `120000` | S3 兼容客户端请求超时 |
| `ALLOW_LOOPBACK_ENDPOINT` | 未设置 | 设为 `1` 允许自定义端点指向回环地址（本地 MinIO 等调试场景）；默认拒绝 |
| `ALLOW_PRIVATE_ENDPOINT` | 未设置 | 设为 `1` 允许自定义端点使用私网 / 链路本地 / 保留 IP 字面量（内网对象存储）；默认拒绝 |
| `LIST_SCAN_CAP` | `5000` | 搜索与用量估算的扫描上限 |
| `LIST_STAT_CAP` | `20000` | 文件夹属性（对象计数）的列举上限 |
| `LIST_DELETE_CAP` | `5000` | 删除 / 清空时单次列举上限（循环调用，内存恒定） |
| `LIST_PROPFIND_CAP` | `5000` | WebDAV `Depth: infinity` 的列举上限 |
| `LIST_CACHE_TTL_MS` | `3000` | 目录列举缓存的存活时间；`0` 表示整体关闭 |
| `SEARCH_CANDIDATES_TTL_MS` | `10000` | 搜索候选集缓存的存活时间（从首次物化算起，命中不续期）；`0` 表示整体关闭 |
| `SEARCH_CANDIDATES_MAX_ITEMS` | `10000` | 搜索候选集单条目的最大键数；超限即整条丢弃并退回逐页列举 |
| `FRAGMENT_CACHE_TTL_MS` | `30000` | 分片列表缓存的存活时间；`0` 表示整体关闭 |
| `CONFIG_WRITE_DEBOUNCE_MS` | `250` | 配置落盘的去抖窗口（毫秒） |
| `PAYMENT_WRITE_DEBOUNCE_MS` | `300` | 支付订单落盘的去抖窗口（毫秒）；`0` 表示关闭去抖、每次变更立即落盘（排查落盘问题时用）。窗口内连续变更只写最后一次的状态 |
| `PAYMENT_MAX_ORDERS_TOTAL` | `20000` | 订单文件的**跨链接**总量上限（`paid` / `refunded` 永不裁）；配置它主要为受控压测与回归护栏提供一个可驱动的小上限 |
| `PAYMENT_PENDING_KEEP_MS` | `7200000`（2 小时） | **支付窗口**：`pending` 订单未超此时长即受裁剪保护（裁掉 = 异步通知查无此单 = 钱付了拿不到文件）；`paid` / `refunded` 无条件永不裁。回归护栏把它压到极小值以驱动裁剪路径 |
| `NO_RESTART_ON_UNCAUGHT` | 未设置 | 设为 `1` 时，发生未捕获异常后不自动退出（调试用）；默认记录后触发优雅关闭 |
| `COS_DATA_DIR` | 未设置 | 运行时数据目录；未设置时落到项目 `data/`，测试进程可指向临时目录做数据隔离 |
| `CAPTCHA_ENABLED` · `CAPTCHA_PROVIDER` · `CAPTCHA_SITE_KEY` · `CAPTCHA_SECRET_KEY` | 未设置 | 登录验证码的预设值；**仅当环境变量真实存在时**才写入配置，用于无界面部署时预设，不会用空值覆盖已保存的配置 |

> 列举上限另有一个 50000 的硬性天花板（`server/limits.js` 的 `HARD_MAX`），任何调用方都不得越过。上述上限本身也受它约束。

<h2 id="develop_document-section4">3. 多云架构</h2>

系统通过一层**存储抽象**屏蔽各厂商差异，上层业务（路由 / 文件网关 / WebDAV）只有一套写法：

```
业务层   routes/*.js · fs-gateway.js · webdav-server.js
              │  统一调用界面：getBucket / headObject / putObject / multipart* ...
抽象层   cos.js（客户端工厂 + 错误翻译 + 调用埋点）
       ┌──────┴───────────────────────────┐
   kind: 'cos'                         kind: 's3'
腾讯云原生 SDK                    s3-client.js（内置）
cos-nodejs-sdk-v5                · AWS Signature V4（HMAC-SHA256 派生链）
                                 · Node 原生 fetch / Readable，无新增依赖
                                 · 轻量正则 XML 解析
                                 · 路径风格寻址、UNSIGNED-PAYLOAD 流式上传
                                 · CopySource 自动兼容 /bucket/key
元数据   providers.js（厂商注册表：id / 名称 / kind / Endpoint 模板 /
                      地域是否必填 / 字段标签与界面提示，唯一真相来源）
```

- **配置结构 v3**：`credentials[]` 与 `buckets[]` 每条记录都带 `provider` 与 `endpoint`；v1（扁平结构）加载时自动迁移，v2（无 provider 字段）统一兜底为腾讯云。
- **Endpoint 解析**：密钥自定义 Endpoint 优先，其次按厂商模板用地域填充，最后回退厂商默认端点。
- **能力差异**：仅腾讯云支持的操作（如官方容量统计 `?stats`、大文件 `sliceCopyFile`）按 `provider` 判定，S3 厂商自动走等价路径或返回估算结果。
- **新增一家云厂商的步骤**：① 在 `providers.js` 注册表追加条目（`id` / 名称 / `kind` / `endpointTemplate` / 地域是否必填 / 字段标签与界面提示）——这是厂商元数据的唯一真相来源，**`endpointTemplate` 必须提供**，否则该厂商无法解析出端点；② 走 S3 兼容协议时填 `kind: 's3'` 即可，`cos.js` 会自动分派到 `s3-client.js`，无需改动客户端工厂；③ 仅腾讯云具备的能力按 `provider` 分支判定，新厂商自动落到等价路径或估算逻辑；④ 前端在 `public/js/provider-logos.js` 追加内联 SVG 与显示名。全程不引入新依赖。

---

<h1 id="develop_document-section5">二、技术说明</h1>

<h2 id="develop_document-section6">1. 设计背景与刻意取舍</h2>

<h3 id="develop_document-section7">1.1 多云协议的历史原因</h3>

初始版本仅面向腾讯云 COS，因此原生支持腾讯云对象存储 SDK（`cos-nodejs-sdk-v5`）。其它云服务商为后续添加，统一使用 S3 兼容协议（SigV4）。这是历史演进的结果，属已知且可接受的架构现状，并非缺陷。

<h3 id="develop_document-section8">1.2 用户 / IP 管理界面按角色物理分离</h3>

早期版本使同一张卡片同时服务两种角色（在「用户管理」与「我的资料」两种形态间切换），若任意一条分支被忽略，则切换账号时会残留上一角色的 DOM —— 这会导致「管理员登出后普通用户仍能看到全部用户与添加按钮」。

现行设计将两种用途**物理分离**，角色切换只剩「显示 / 隐藏一个整块」，不存在需要还原的中间状态，从结构上消除了这类缺陷。配套实现约定：

- `syssettings.js` 的 `ADMIN_ONLY_CARDS` 含 `sysset-user-card`，`loadUsers()` 在非管理员时直接返回，不发起用户列表请求；
- `renderUserMenu()` 中 `ipguard-card.hidden = !isAdmin`，`refreshIpGuard()` 在卡片隐藏时直接返回，同时切断规则列表请求；
- `renderUserMenu()` 中 `credmgr-domain-card.hidden = !isAdmin`（自定义请求域名：保存走 `PUT /api/config`，且是全局共享设置），`credmgr.refresh()` 在卡片隐藏时既不回填输入框、也不再拉取 `/api/config`；
- `openBucketDialog()` 的管理员专属项按 `isAdminUser` **整项条件渲染**：「访问密钥」与「从云端获取桶列表」（`POST /config/verify` 仅管理员）、「对普通用户可见」（服务端对非管理员丢弃 `credentialId` / `visibleToUsers`，留着只是无效开关）；提交时元素不存在即按「不指定密钥 / 可见」处理；
- **桶集合由管理员维护，普通用户只读**：`POST /buckets/local` 挂 `requireAdmin`，`renderUserMenu()` 隐藏两处「添加存储桶」入口（侧栏 `btn-bucket-add` 与管理页 `btn-buckets-add`）；`bucketmgr` 对普通用户不渲染「操作」列（解绑走 `DELETE /buckets/local/:id`，同样是管理员专属）。可见桶由 `GET /buckets/stats` 按角色过滤后直接列出，空列表时提示「联系管理员开放」而不是引导其自行添加；
- 登出与登录成功两个时点均调用 `resetMainView()` 将主视图切回文件浏览（纵深防御）。

<h3 id="develop_document-section9">1.3 支付系统设计取向</h3>

| 取向 | 说明 |
| --- | --- |
| **不强行统一字段名** | 三家平台各自沿用官方文档命名：支付宝 `app_id` / `private_key` / `alipay_public_key` / `sign_type`；微信支付 `mchid` / `appid` / `api_v3_key` / `serial_no` / `private_key`；PayPal `client_id` / `client_secret` / `mode`。界面在每个字段旁标注官方字段名，可直接对照其控制台填写 |
| **校验规则集中** | 全部 `pattern` 与专用校验器（PEM 私钥 / 公钥、https URL）都写在 `server/payment-providers.js` 一处；前端拿到的是同一份规则的可序列化副本，用于即时提示，**最终裁定永远在服务端** |
| **可扩展为真实校验** | 提供 `registerValidator(platformId, fn)` 扩展点。接入 SDK 后登记联机校验即可将「本地格式校验」升级为「凭证有效性校验」，路由与前端无需改动 |
| **敏感字段不外泄** | 密钥 / 证书 / Secret 任何接口都不回传明文，只返回「是否已配置」；保存时留空 = 保持现有值不变，避免界面保存误清空 |
| **校验不通过不落盘** | `PUT` 先校验再写入，失败时返回逐字段错误，界面在对应输入框下方标红 |
| **站点地址唯一来源** | 卡片顶部的「站点地址」用于拼装**同步回跳地址**与**异步回调地址**。留空时按当前请求的 `Host` 推导，但生产环境务必显式填写（反向代理后浏览器看到的 Host 与网关回跳的并不一致）；值会被去掉末尾斜杠后保存 |

<h3 id="develop_document-section10">1.4 支付结果仅限服务端查单返回</h3>

这是支付模块最重要的设计约束：

```
下单（pending）→ 下载者付款 → 回跳 / 轮询 / 异步通知 任一到达
                                    └─→ 服务端主动向平台查单
                                            ├─ 明确成功   → markPaid（唯一入口）
                                            ├─ 明确失败   → markFailed
                                            └─ 未找到/异常 → 保持 pending（失败即关闭）
```

- **异步通知只当触发器，不作证据**：`POST /pay/notify/:platform` 收到后只解析出商户单号进行查验，只接受返回结果更改状态；通知内容（金额、签名、状态字段）一概不用于判定成功。
- **失败即关闭（fail-closed）**：查询超时、网络异常、返回不可解析一律视为**未支付**，绝不放行下载。返回失败仅需要求下载者重新刷新页面，而放行未支付下载的代价是文件被免费获取。
- 全库**只有一处**调用 `markPaid`（`share-routes.js` 的 `finalizeOrder`），已支付订单不允许被后续失败回调改判。
- 开发期用过的模拟支付端点与开关（`PAYMENT_MOCK` / `/s/:id/pay/confirm`）已**彻底删除**，不允许复活。
- **付费拦截发生在扣减下载次数之前**：否则反复支付失败即可耗尽下载次数额度。完整的放行判定顺序见「分享链接生命周期 → 下载配额与来源判定」（唯一权威定义）。

<h3 id="develop_document-section11">1.5 订单冗余字段用于对账</h3>

订单记录冗余保存了文件名与对象 key，目的是使订单管理在**分享链接被删除后依然可对账**——否则历史收款记录会随链接一起消失。

<h3 id="develop_document-section12">1.6 WebDAV 口令为可恢复加密</h3>

第三方 WebDAV 客户端只支持 Basic 认证，服务端必须能还原出口令原文，因此无法只保存 scrypt 哈希。该口令经主密钥加密落盘，与登录口令隔离。使用约束：**请勿复用登录密码作为 WebDAV 口令**，且 WebDAV 仅应监听本机回环地址。

<h3 id="develop_document-section13">1.7 为何不引入 SM4 作为文件加密算法</h3>

> **结论**：评估后**不引入**。不是否定国密，而是 Node 侧的 SM4 在当前形态下同时踩中两个硬伤——**没有 AEAD 模式**、**吞吐比 AES-NI 慢一个数量级**，而本项目的整条加密链路正是围绕「有 AEAD + 足够快」这两点搭起来的。以下数据均为本机实测（脚本可复现），不是引用第三方结论。

**测量环境**：Node v22.22.2 / Windows x64 / AMD Ryzen 5 5600 / OpenSSL 3.5.5；样本为 32MB 随机缓冲区，取 3 次运行的最优值。

| 观测项 | 实测结果 | 对方案的影响 |
| --- | --- | --- |
| Node 提供的 SM4 模式 | `sm4`、`sm4-cbc`、`sm4-cfb`、`sm4-ctr`、`sm4-ecb`、`sm4-ofb` | **`sm4-gcm` / `sm4-ccm` 不存在**（`crypto.getCiphers()` 中查无此二项）→ 无法照搬 GCM 语义 |
| `aes-256-gcm` 吞吐 | **2037 MB/s**（AES-NI） | 这是现有加密「可以放在请求处理器里同步做」的唯一前提 |
| `sm4-ctr` 吞吐 | **120 MB/s** | 比 AES-GCM 慢 **17 倍**——最大的约束 |
| `sm4-cbc` 吞吐 | 114 MB/s | 与 CTR 同量级，换分组模式救不了 |
| HMAC-SHA256 | 2025 MB/s | MAC 成本可忽略 |
| HMAC-SM3 | **239 MB/s** | 比 SHA-256 慢约 8.5 倍 → 「SM4 + SM3」这条路会再叠加一层慢速 MAC |
| SM4 的 IV 长度 | **只接受 16 字节**（传 12 字节直接抛 `Invalid initialization vector`） | 现有 IV 约定是 12 字节（AES-GCM 接受 12/16）→ 必须参数化 |
| 块大小 | 16 字节（与 AES 一致：CBC 下 1 字节明文 → 16 字节密文） | 分片与块对齐逻辑**不用改** |
| Dockerfile 基础镜像 | `node:22-alpine`（OpenSSL 3） | 部署侧 SM4 可用，无需换镜像 |

**阻断理由一：没有 AEAD，得自己拼，而拼错的代价不可回滚**

现有 AES-256-GCM 的三样东西（逐段 `authTag` 校验、每段独立 IV、可 seek 解密）都是 `crypto` 模块给的，本仓库不实现它们。换成 SM4 就只能自己搭 **CTR + HMAC 的 encrypt-then-MAC**：

- SM3 确实存在，但实测只有 239 MB/s——用它会让「加密 + 认证」的总耗时进一步恶化；改用 HMAC-SHA256 则成了「SM4 加密 + SHA-256 认证」的混搭，届时它也**不构成实质上的国密方案**；
- AEAD 的认证覆盖范围、nonce 复用判定、常量时间比较都要自己写对。**这类错误没有任何运行期症状**：写错不会报错，只会让密文在某次读取时解不开，最坏情况下允许伪造篡改而不被发现。参照本仓库对「SM4 元数据改错即永久不可解」的判断，这是不能接受的风险面。

**阻断理由二：17 倍会把「可接受」变成「必须重构」**

本项目**已经有过一次同型教训**：`magic` 模式的密钥流是无硬件加速的纯位置函数，结果 48MB 分片会在单线程里同步阻塞约 3 秒、全站失去响应，最后只能把单片上限压到 5MB 来兜住（见「技术限制与已知局限」）。

也就是说，**「没有硬件加速的同步加密」这条路本项目走过一次，代价是把性能上限写死成了功能限制**。SM4 正是同一形态：若照现有链路接入，分片上传的同步加密会从毫秒级跳到百毫秒级，直传与 WebDAV PUT 的整文件加密直接踩进秒级阻塞。唯一的正确解法是把整条加密链路**重写为流式**（边加密边上传），而这条链当前是同步的、且被 Range 请求、回溯校验、断点续传等多处依赖——**这才是工作量的主体**，与「换一个算法名」不是一个量级。

**阻断理由三：现有格式没有预留算法位**

引入第二种算法，前提是密文自己能说清「我用的哪个算法、IV 多长、TAG 多长」。现在这三点全是隐含约定：

| 现状 | 位置 | 为什么它是障碍 |
| --- | --- | --- |
| 加密元数据**没有算法字段**（全 server 侧唯一的 `alg` 属于 WebAuthn 的 COSE 算法标识，与文件加密无关） | `enc-store.js` 元数据写入 | 新旧密文无法按算法区分，只能靠 IV 长度反推——这是最不可靠的一种推断方式 |
| IV / TAG 长度约定存在**至少两份独立实现**：`enc-store.js` 的 `IV_LEN = 12` / `TAG_LEN = 16`（文件内 10 处引用），以及 `config-store.js` 里写死的 `12` / `28` / `29` 字面量（附带布局注释） | 两处 | 改一处必漏另一处。这正是本项目反复验证过的失效模式——「同一约定多份实现，必有改一半」 |
| `enc-meta.json` 出错的代价是**永久不可解** | 元数据存储 | 上面两项叠加后，一次改错的后果不可回滚 |

**还有两笔必须一并付出的成本**

- **IV 长度参数化**：SM4-CTR 的 nonce 固定 16 字节（实测传 12 字节直接报错），现有 12 字节约定必须参数化；偏移量算错一位就是整段密文错位。
- **主密钥跨算法复用**：把 32 字节主密钥截断成 16 字节给 SM4 是最容易犯的错——不同算法之间**绝不能共用同一份密钥材料**，正确做法是 HKDF 派生出两个独立子密钥。这一步一旦省掉，两个算法的安全性会互相牵连。

**什么情况下会重新考虑**

| 触发条件 | 说明 |
| --- | --- |
| Node 提供 `sm4-gcm` 或等价 AEAD | 阻断理由一消失，不必自己拼认证加密 |
| 出现 AES-NI 级别、或明显接近的 SM4 实现 | 阻断理由二缓解，不必先重构为流式 |
| 有明确的合规要求，且愿意同时承担「流式重构 + 17 倍吞吐 + 格式迁移」三项成本 | 此时它是需求驱动而非技术驱动；迁移必须保留旧路径，存量密文仍按原算法解密 |

> 在此之前，文件加密维持 `AES-256-GCM`（crypto 模式）与文件头魔数（magic 模式）两种，**不使用国密算法**。「威胁模型与不设防边界」的合规一行也登记了同一结论，那里只给结论，判定细节以本节为准。

<h3 id="develop_document-section14">1.8 为何不使用对象存储自带的服务端加密</h3>

云厂商的对象存储普遍提供**服务端加密**（SSE）：开通后云端在写入时自动加密、读取时自动解密，原生支持 AES-256 与国密 SM4，客户端无需任何改造——它看上去正好绕开了 1.7 里讨论的全部性能与实现成本。本系统**刻意不使用**，因为两者的目标根本不同：

| 维度 | 对象存储服务端加密（SSE） | 本系统的加密（客户端加密） |
| --- | --- | --- |
| 密钥在哪 | 厂商托管，或由其 KMS 管理 | **全程留在本机**，密钥与元数据缺一则密文不可解 |
| 厂商能否读到明文 | **能**——控制台里看到的就是明文对象 | 不能，落到云端的是密文 |
| 控制台可见性 | 对象可被正常浏览、下载与预览 | 密文文件头已被覆写，直接打开不可用 |
| 保护的场景 | 介质层面：磁盘失窃、退役介质残留 | 数据主权：服务商可接触数据但无法解读 |

加密模块的设计意图是「**控制台不可见、服务商无法审核**」。把密钥交给云厂商托管，等于把这个目标从根上放弃——**托管加密保护的是「厂商的磁盘」，而这里要防的是「厂商自己」**。

因此本系统坚持**先在本地加密、再上传**：密钥与元数据全程留在本机，厂商侧（含其 IDC 与控制台）看到的恒为密文。代价是密文格式演进、性能与密钥保管的责任全部落在自己身上——**这正是为这个目标专门写一套加密模块的理由**，而不是复用云厂商现成的能力。

厂商 SDK 虽另有客户端加密可让服务商只见密文，但它绑定单一厂商 SDK，与本系统「多云统一抽象、零新增依赖」的架构冲突，也无法支撑本系统所需的分片密文结构（断点续传、Range 切片、WebDAV 透明加解密、查看密码令牌）与魔数混淆模式。

故本系统自研加密：密钥完全掌握在用户手中，云厂商侧只能看到密文。其代价是 enc.key 与 enc-meta.json 必须与 secret.key 同等备份、缺一即密文永久不可解。

<h2 id="develop_document-section15">2. 技术限制与已知局限</h2>

- 本项目为个人项目，未经企业级安全审计，请勿直接用于企业生产环境。
- WebDAV 的 **PUT 写入**为全量缓冲（整份文件进内存后才加密上传），属设计权衡，暂不优化；**读取侧支持 HTTP Range 断点续传**，二者不冲突——前者是写入路径，后者是读取路径。
- **`magic` 加密模式有硬性性能上限**：它的密钥流是纯位置函数（每 32 字节做一次 SHA-256），生成成本与数据量线性相关，且**在单线程里同步生成**。48MB 的分片会把事件循环阻塞约 3 秒，期间全站（含 WebDAV 与所有下载）失去响应。因此分片上传在 `magic` 模式下把单片上限压到 **5MB**（`MAGIC_CHUNK_MAX`），代价是同样的文件产生更多分片与更多请求。**这个值不能继续下调**：AWS S3 要求「除最后一片外」每片 ≥ 5MB，再小会在合并时报 `EntityTooSmall`（腾讯云 COS 允许 1MB、阿里云 OSS / 华为云 OBS 允许 100KB，但必须取各厂商中最严的那个）。**该上限同时约束三条入口**：分片上传的 `chunkSize`、直传（`/fs/upload/simple`，`express.raw` 上限 64MB）与 WebDAV PUT（全量缓冲后一次性加密）——后两者由加密入口 `encryptBuffer` 自身按模式拒绝，不再依赖调用方各自计算；此外「会话创建时为非 magic、上传中途管理员切到 magic」的续传路径会被**如实拒绝**（409），因为分片偏移由 `chunkSize` 决定，中途改小会与已传分片边界错位（涉及已落盘数据语义的参数不可中途变更）。彻底解决需要把密钥流换成可并行 / 可预计算的构造，那会改动密文格式并影响存量数据，**当前不做**。启用 `magic` 前请评估单文件大小与并发上传数；对性能敏感的场景请用 `crypto`（AES-256-GCM 走原生实现，无此问题）。
- **加密对象的 HTTP Range 有 32MB 分界**：读取侧对加密对象是「完整下载 → 内存解密 → 切片」，因此**明文超过 `MAX_RANGE_BUFFER`（32MB）时会退化为全量流式解密并忽略 Range**，返回 200 + 全量长度。此时 WebDAV 的 HEAD **也不会宣告 206 + `Content-Range`**（R10-07）——否则续传客户端会按区间建多个连接、每个却收到整份内容，拼装出损坏文件。
- **WebDAV 挂载写入不支持分片上传**：资源管理器里往挂载盘写大文件时走的是 PUT（全量缓冲），没有分片通道。因此在 `magic` 模式下写入超过 5MB 的文件会被明确拒绝（413），提示中会给出可执行出路（改用 `AES-256-GCM` 加密模式，或改用管理界面的文件上传——那里会自动按上限切分）。这不是 bug，而是「写入路径没有分片」这一设计事实的外显。
- 会话令牌滚动续期涉及底层改动，暂不实现。
- 子用户规模通常较小，不考虑多实例 / 集群部署。
- CSRF Origin 校验目前以同源自定义头实现，更严格的 Origin 白名单校验计划在正式版提供。
- **attestation 不做完整性链校验**：仅覆盖 ES256 签名算法，不处理 `packed` / `tpm` 等 attestation 格式的证书链验证（本系统信任首次注册的凭据，不做认证器厂商背书）。
- 为安全起见，修改回源设置、跨域设置、修改访问权限等操作需前往服务商控制台，本程序不提供此类功能。
- **审计日志不是取证级证据**：`data/logs.jsonl` 为**明文**、上限 5000 条且会轮转重写（高负载下可能只覆盖很短的时间窗），本机有权限的用户可随意编辑。它能回答「刚才发生了什么、谁在什么时候做了什么」，但**不具备抗篡改能力，不能用于抗抵赖**。需要长期留存请把日志外发到独立的日志系统。
- **密钥不可轮换**：`secret.key` 与 `enc.key` 都没有 rekey 路径，两者的语义都是「文件不存在就新生成一把」。因此**删掉密钥文件再重启不是轮换，是销毁**——旧密文与旧配置立即永久不可读。`enc.key` 一旦泄露，处置只有「全量下载 → 用新密钥重加密 → 重新上传」，且必须**先保住老的 `enc-meta.json`**（否则连第一步的解密都做不了）。完整步骤见「目录结构 → 密钥轮换：当前版本不可轮换」。

**关于 Windows Hello 的技术约束**：

- 仅支持 **ES256（ECDSA P-256 + SHA-256）**，与 Windows Hello 平台认证器默认算法一致；注册时只声明该算法，避免浏览器协商出服务端无法验证的算法。验签遵循标准 `ecdsa-with-SHA256` 语义——对**原始被签名数据**（`authData || SHA-256(clientDataJSON)`）做一次 SHA-256；签名同时兼容 DER 与裸 `r||s`（64 字节）两种编码；
- WebAuthn 要求**安全上下文**：`https://` 或 `localhost` / `127.0.0.1`（浏览器视回环地址为安全），因此通过**局域网 IP + 明文 HTTP** 访问时该功能不可用；
- **本地优先使用** **`localhost`**：`rpId` 必须是**有效域名**，IP 字面量不合法（部分浏览器直接抛 `SecurityError`，与是否 HTTPS 无关）。前端 `webauthnReadiness()` 将不可用原因分类（浏览器不支持 / 非安全上下文 / 使用了 IP 地址 / 正常），并给出可执行的修复动作；
- 服务端校验 `challenge`（一次性、5 分钟时效）、`origin`、`rpIdHash`、凭据 ID 一致性，并**强制要求 UP 与 UV 两个标志位**（任一项未置位即拒绝，Windows Hello 的生物识别 / PIN 一定满足）；另维护 `signCount` 递增以检测凭据克隆——**但该检查仅在认证器上报非零计数时生效**：Windows Hello 等平台认证器普遍恒为 0，实现中 `prev > 0 && next > 0` 两个条件都成立才比对，即该场景下**不提供克隆检测**（硬要比对反而会让这部分用户永远登不进来）；
- 公钥与凭据 ID **不下发前端**，前端只拿到 `webauthnEnabled` 布尔值与随机挑战。


<h2 id="develop_document-section16">3. 威胁模型与不设防边界</h2>

**设防（设计上明确抵御）**

| 威胁方 | 抵御手段 |
| --- | --- |
| 云厂商 / 对象存储侧 | 启用加密后云端只有密文（crypto 为 AES-256-GCM，magic 为混淆级）；只拿到云端数据无法读出内容 |
| 网络中间人 | 非回环部署强制 HTTPS 并 301 跳转，会话 Cookie 自动附加 `Secure`；自定义端点必须 https 且通过端点守卫 |
| 未授权访客 | `/api/**` 一律需会话；分享链接为 128 位熵 ID，可叠加密码 / 有效期 / 次数；写操作必须携带同源头 |
| 暴力破解与撞库 | 登录、查看密码、分享密码、WebDAV 认证均有 IP 级与用户名级限流及指数退避锁定；登录口令以 scrypt 派生 |
| 凭据被滥用 | 建议使用各厂商子账号并最小化授权；密钥不明文回传、界面只显示掩码；对象存储错误统一脱敏 |
| 第三方页面越权调用 | 有副作用的 GET 校验 `Sec-Fetch-Site` / `Referer`；支付票据 Cookie 为 `SameSite=Lax`，跨站子资源请求不会携带 |

**不设防（明确不在防护范围内）**

| 场景 | 后果 |
| --- | --- |
| 本机被攻陷（管理员 / root，或任何能读 `data/` 的账号） | `secret.key` 与 `config.enc` 同目录存放，同时拿到二者即可解出全部访问密钥与 WebDAV 口令。本系统不提供任何本机越权防护 |
| 浏览器侧被控（恶意扩展、XSS） | 会话可被冒用。CSP 与「默认纯文本渲染」只降低概率，不声称可防 |
| 平台认证器被伪造 / 设备丢失 | 见上文 Windows Hello：`signCount` 在平台认证器上通常恒为 0，克隆检测在该场景不生效 |
| 云端密文被删除或截断 | 完整性校验只能「检出」，不能「恢复」。答案在备份，见「目录结构」的备份清单 |
| 内网对象存储的域名被 DNS 劫持 | 端点守卫刻意**不做** DNS 解析（见「服务端点守卫」），只拦截 IP 字面量与元数据地址 |
| 合规 / 国密 / 等保要求 | 未做算法合规性评估。支付宝的 SM2 仅为其平台侧的签名算法选项，本系统的文件加密不使用国密。SM4 未引入的**实测依据与三条阻断理由**见「1.7 为何不引入 SM4 作为文件加密算法」（唯一权威定义） |

**magic 模式的明确定位**：它是**混淆级**保护，用于对抗「有人顺手打开云盘控制台、看到一堆文件就想点开看看」这类弱动机窥探（密文文件头被魔数覆写，直接双击无法打开）。它**不**用于对抗有动机的攻击者：异或密钥流不具备语义安全——同一主密钥 + 同一盐下相同明文必产生相同密文，且只要知道任意一段明文就能反推出该段的密钥流，进而还原对象其余部分。需要真正的保密性请使用 crypto 模式。

<h2 id="develop_document-section17">4. 审计后的行为变更</h2>

| 变更 | 影响 |
| --- | --- |
| 权限判定改为**实时读取**用户记录 | 管理员改名 / 降权 / 删户 / 改密后，该用户的**已有会话立即失效**（旧行为：最长 24 小时仍有效） |
| 操作日志 / ACL 检查 / 上传会话列表改为管理员专属 | 普通用户不再能看到日志与全部上传会话，侧边栏入口同步隐藏 |
| 桶配置写入改为**字段白名单** | 普通用户只能修改 `remark` / `quotaBytes`，对于`provider` / `region` / `enabled` / `credentialId` 一律忽略 |
| 服务端点强制校验 | 自定义 endpoint 必须是 https，且不得指向云平台元数据服务、私网与回环地址（调试可设为 `ALLOW_LOOPBACK_ENDPOINT=1`） |
| 列举上限集中治理 | `listAll` 默认上限由 20 万降至 5 万；达到上限时**显式返回** **`truncated`**，调用方必须检查，不再静默截断 |
| magic 加密增加完整性校验 | 新增的 magic 密文会在解密时校验 SHA-256，被篡改即报错（历史无摘要文件仍可正常解密，向后兼容） |
| 敏感数据文件损坏时**拒绝写入** | `enc-meta.json` 等文件解析失败会重命名为 `.corrupt-<时间戳>` 备份并拒绝覆盖，需人工恢复后重启 |
| CSP 移除 `script-src 'unsafe-inline'` | 前端不再使用内联事件处理器（缩略图 `onload` 等已改为事件委托） |
| 「当前桶」改为**会话级** | 普通用户切换当前桶**只影响自己的会话**，不再改变全局默认桶；全局值的语义降级为「系统默认桶」，仅由管理员切换，供 WebDAV / 分享链接 / 无会话场景回退。界面读端（`listBucketsFor` / `safeView`）与操作读端（`get` / `effective` → `requireConfig()`）**必须同源**，普通用户不会被回退到对其不可见的桶 |
| 分享下载校验请求来源 | 无票据且 `Sec-Fetch-Site` 缺失时，回退校验 `Referer`：跨源即拒绝。curl / wget 等直连客户端仍可用，但会落审计日志 |
| 重命名 / 移动统一做目标冲突检查 | 目标已存在时直接报错，不再静默覆盖（此前仅目录移动分支有检查） |
| 删除目录改为**循环删除 + 截断守卫** | 超过一轮上限或列举被截断时如实报错，且加密元数据只清理**已确认删除**的 key，杜绝残留密文永久不可解 |
| 分享链接的「文件已删除」不再是终态 | 对象被重新上传回**同一个 key** 后链接自动恢复有效（此前一旦标记就不再探测，`deleted` 成了不可逆的假终态，与界面上「重新上传同名文件即可恢复」的承诺相反） |
| 覆盖写入后必须对账加密元数据 | 明文覆盖写入会清掉旧密文元数据。残留条目会让 magic 密文**静默解出错误内容**、crypto 密文下载中途死亡 —— 两者都比直接报错更糟 |
| WebDAV 降为声明 **DAV level 1** | 不再宣称支持 locking；未实现的动词（`LOCK` / `UNLOCK` / `PROPPATCH`）改回 405 加 `Allow` 头，而不是落到 SPA 兜底的 404；目录列举被截断时经 `X-WebDAV-Truncated` 响应头与审计日志如实告知 |
| 批量删除 / 移动改为**批量接口 + 受控并发** | `POST /fs/delete` 的文件分支改走 `deleteMultipleObject`（每批 ≤1000）加 8 路并发探测；`/fs/move` 的文件分支 4 路并发。旧实现是逐对象**串行**往返（200 个文件约 400 次串行云端调用，浏览器早已超时） |
| 服务端故障不再吞掉用户的下载配额 | `/s/:id/dl` 在「配置失效 / 传输前失败」时回滚已占用的名额，只有客户端主动中断才计入。旧实现每点一次白扣一次，`maxDownloads=3` 的链接点三次即转**终态** exhausted |
| 加密查看密码的状态对所有角色可读 | 新增 `GET /enc/status`（只回 `passwordSet`，不含加密模式与魔数）。此前普通用户路径下 `ensureUnlocked()` 恒真，密码验证框永不出现，加密文件实际无法下载 |
| 登出同时复位加密令牌与上传队列 | 会话态的模块级缓存（查看令牌、上传任务列表）在登出点统一清空；否则下一个账号可**免密解密下载**，并看到上一个账号的完整对象键与进度 |
| 当前密码不正确返回 403 而不是 401 | 前端把任意 401 统一当成「会话过期」并强制登出。用户只是手误打错一次密码，却被踢回登录页、弹窗内容丢失、提示文案还是错的 |
| 批量删除以**白名单**判定成败 | 只把「明确出现在云端 `Deleted` 里」的对象算作删除成功；云端未确认的（协议外行为 / 解析退化）一律按**未删除**处理。旧实现硬编码 `Error: []` 丢弃厂商的 `<Error>`，并把「不在 Error 里就算成功」当判据 → 对**仍然存在**的对象清掉解密凭据（永久不可解）并标记分享链接（已分发链接永久失效），两件都不可逆 |
| 复制覆盖写入同样要对账加密元数据 | 复制是一次「覆盖写入」，语义与上传完全相同。旧实现只搬元数据、源无元数据时不清目标 → 目标残留陈旧密文记录（magic 分支会静默解出错误内容）。现与上传路径统一走 `reconcileAfterWrite` |
| WebDAV 目录 COPY / MOVE 拒绝自嵌套 | 复制到自身子目录会形成无界递归复制（请求永不返回 + 持续计费）；目录 MOVE 同时补齐 `Overwrite: F` → 412，不再静默覆盖目标已有对象 |
| WebDAV 的 Range 响应与 HEAD 两端一致 | 带 `Range` 的 GET 如实回 206 + 区间长度 + `Content-Range`（越界回 416）；旧实现宣告全量长度却只发区间字节 → 大文件续传报「传输被提前关闭」/ 下载损坏 |
| 支付轮询补按 IP 的查单预算 | `/s/:id/pay/status` 原本只有订单级节流（3 秒一次）而无按 IP 总量上限，持票据者可造多个订单把网关查单预算放大到约 66 倍。现叠加 200/10 分钟的按 IP 预算，超限时静默返回当前状态（不打断正常 3 秒轮询） |
| `magic` 上限下沉到加密入口 | 上限不再只在分片路径生效：直传与 WebDAV PUT 两条「整文件一次加密」入口由 `encryptBuffer` 自身按模式拒绝（超限 413）；「中途切到 magic 的续传会话」如实拒绝并要求重建任务，避免单个大分片同步阻塞数秒 |

<h2 id="develop_document-section18">5. 安全说明</h2>

- **密钥加密存储**：配置写入 `data/config.enc`，AES-256-GCM（随机 IV + 认证标签）；主密钥为本机随机生成的 `data/secret.key`；访问密钥不回传浏览器，界面仅显示掩码。
- **账号口令存储**：登录口令以 **scrypt** 派生后只存盐与摘要——16 字节随机盐（32 位十六进制）、32 字节输出、代价参数取 Node 默认（N=16384 / r=8 / p=1）；校验用 `timingSafeEqual` 做定长比较，避免时序侧信道。必须使用**异步** scrypt（理由见「文件加密与元数据」）：同步版本会占满单线程事件循环，几十个并发请求就能让全站（含正在进行的下载与 WebDAV）一起卡死。WebDAV 口令因协议限制只能可恢复加密，与登录口令完全隔离（见「设计背景与刻意取舍」）。
- **文件加密**：加解密只在本机服务内发生，云端为密文；crypto 主密钥存于 `data/enc.key`、解密参数（IV / TAG / 盐 / 原始文件头）存于 `data/enc-meta.json`——**二者缺其一即永久不可解，必须同等备份**（完整清单见「目录结构」中的备份表）；查看密码以 scrypt 哈希存储、与加密密钥独立；加密对象禁止预签名直链，防止绕过查看密码。
- **部署强制 HTTPS**：`HOST` 非回环时明文 HTTP 一律 301 跳转 HTTPS，会话 Cookie 自动附加 `Secure`；WebDAV 仅提供 HTTPS。
- **暴力破解防护**：登录、加密查看密码、分享密码、WebDAV 认证均有 IP / 用户名级速率限制，连续失败触发指数退避锁定（上限 30 分钟）。
- **CSRF 与安全头**：非安全方法必须携带同源自定义头 `X-Requested-With`；统一下发 CSP、`X-Content-Type-Options`、`Referrer-Policy`、`frame-ancestors` 等响应头。
- **敏感数据加密落盘**：`enc-settings.json`、`enc-meta.json`、`links.json`、`ipguard.json`、`upload-sessions.json` 均经 `secret.key` 派生密钥加密（自动兼容并升级历史明文文件）；`enc.key` 写入后收紧为仅当前用户可读。
- **原子写入**：所有持久化文件采用「临时文件 + rename」，避免进程被强制结束时截断；临时文件名带随机量（防同毫秒重名覆盖），启动时自动清扫历史遗留的孤儿临时文件（仅清理进程已不存在的）。
- **单实例保护**：启动时获取 `data/.instance.lock` 独占锁，检测到另一个活跃实例即拒绝启动，避免两个进程交替整体覆盖 `config.enc`；崩溃残留的脏锁自动接管。
- **错误消息脱敏**：对象存储错误被翻译为分类化中文提示（如「签名错误：请检查 AccessKey / SecretKey 是否正确」「网络连接异常」），SDK 原始信息仅写入服务端日志。
- **会话治理**：每用户最多 10 个并发会话（超出淘汰最早），支持强制登出全部设备与管理员强制登出指定用户；默认有效期 24 小时，勾选「记住登录状态」为 30 天，Cookie `Max-Age` 始终与服务端剩余有效期一致；权限判定**实时读取用户记录**（改密 / 降权 / 删户后旧会话立即失效）。
- **反向代理**：限流与 IP 屏蔽依赖真实客户端 IP，置于 Nginx / CDN 之后须设置 `TRUST_PROXY=1`，否则默认使用 TCP 对端地址（防伪造 `X-Forwarded-For` 绕过）。**反向风险同样要紧**：直连暴露时**严禁**设置，否则任何人都能伪造 `X-Forwarded-For`，IP 屏蔽与全部限流同时失效。该开关的语义是「信任请求头里的全部跳数」，在 CDN → Nginx 这类链路上，请确保最外层代理会**重写**而非追加该头。
- **最小权限建议**：请在各厂商控制台创建**子用户 / 子账号**（腾讯云 CAM、阿里云 RAM、华为云 IAM 等），仅授予所需桶的对象存储读写权限，勿使用主账号密钥。
- **操作审计**：上传 / 下载 / 删除 / 重命名 / 移动 / 配置变更等关键操作记录于 `data/logs.jsonl`，界面内可筛选查看。
- **支付结果只认服务端查单**：规则见「设计背景与刻意取舍 → 支付结果仅限服务端查单返回」（权威定义，此处不重复）。已支付票据为 `订单ID.HMAC(linkId:orderId)` 的签名 Cookie（`httpOnly` + `SameSite=Lax`），签名输入同时绑定链接与订单，无法跨链接复用。

<h2 id="develop_document-section19">6. REST API 模块化组织</h2>

`server/routes.js` 是一个轻量**聚合器**，按业务领域将路由分散到 `server/routes/` 下的子模块，各子模块互不依赖：

```
server/routes/
├── _context.js   # 依赖汇聚：统一 re-export 全部 server 模块（单一 DI 点）
├── _shared.js    # 共享工具与中间件：requireAdmin / requireConfig / 桶解析与统计缓存 / 错误响应
├── auth.js       # 登录 / 登出 / 当前用户 / 初始化（匿名白名单，最先挂载）
├── users.js      # 用户 CRUD（全部管理员）
├── captcha.js    # 验证码与验证码配置
├── config.js     # 系统配置 / 访问密钥 / 连通性验证
├── buckets.js    # 本地桶增删改启停 + ACL 检查 + 容量统计 / 碎片 / 彻底删除（云端桶列表走 config.js 的 /config/verify）
├── ipguard.js    # IP 屏蔽规则（全部管理员）
├── enc.js        # 加密设置 / 解锁 / 上传排除规则
├── payment.js    # 支付平台凭证配置（仅基础配置与合法性校验，全部管理员）
├── webdav.js     # WebDAV 账户与服务控制（含明文密码接口，全部管理员）
├── links.js      # 分享链接（按创建者隔离）
├── fs.js         # 文件列表 / 搜索 / 上传 / 下载 / 重命名 / 移动 / 删除 / 目录树
└── stats.js      # 测速 / 容量 / 概览 / 审计日志 / 健康检查
```

约定：

- **新增路由落在对应领域子模块**；新增领域则建 `routes/<name>.js` 并在 `routes.js` 追加一行 `router.use()`。
- **挂载顺序有语义**：`auth` 必须最先（匿名白名单依赖它先命中）；`/credentials/visibility` 必须注册在 `/credentials/:id` 之前，否则会被参数路由吞掉。改动顺序前先运行 `npm test`。
- **路由表面积受测试保护**：`tests/routes-surface.test.js` 维护期望路由基线，增删路由必须同步更新，避免误删或意外遮蔽。

<h2 id="develop_document-section20">7. HTTP API</h2>

除登录 / 初始化 / 验证码与公开分享页外，`/api/**` 均需登录会话，非安全方法须携带同源头 `X-Requested-With`。

**通用约定**（下列各表均适用）：

- **会话**：Cookie 名 `cosmgr_session`（`HttpOnly`，非回环部署自动附加 `Secure`，`SameSite=Lax`）。除 `/auth/init`、`/auth/login`、验证码与 `/s/*` 公开页外，其余接口无有效会话即 401。
- **写操作同源头校验**：`POST` / `PUT` / `DELETE` 必须携带 `X-Requested-With`，缺失一律拒绝——这是 CSRF 防线，不是可选的装饰。
- **响应封装**：成功直接返回业务对象；失败统一为 `{ error: string }`，文案已脱敏并可直接展示给用户。
- **请求体规范**：本章对**有请求体的接口**给出「字段 / 类型 / 必填 / 约束 / 缺省」子表。缺省值一律以路由的校验代码为准（`server/routes/*.js`）——改动 `parseLinkParams`、`upload/init` 这类校验逻辑时必须同步本表。未列出的字段会被忽略（不做透传）。
- **状态码**：`400` 参数或业务校验失败 · `401` 未登录 / 会话失效 · `403` 权限不足 · `404` 对象或资源不存在 · `405` 方法不允许 · `409` 资源或状态冲突 · `410` 分享链接已删除 / 已过期 / 次数用尽 · `429` 触发限流（响应含重试等待秒数）· `402` 需付费后下载 · `500` 服务端异常。
  > **`409` 与「目标已存在」不是一回事**：`409` 用于**资源或状态**级冲突——系统已初始化（`POST /auth/init`）、用户名 / 应用账户 / IP 屏蔽规则重复、分片参数与会话声明不一致、WebDAV 目录移动遇同名对象。**重命名 / 移动到已存在的对象 key 是 `400`**（管理端 `assertNoConflict` 走 `badRequest`），WebDAV 侧的同型冲突才是 `409`（目录）或 `412`（`Overwrite: F`）。早期文档把两者都写成「409 目标已存在」，此处已按代码更正。
- **分页与游标**：`/fs/list` 用 `marker` 续页，`/fs/search` 用 `cursor` 续扫（原样回传即可）。两者都返回 `truncated`——为真即表示**结果不完整**（已达列举上限或被截断），调用方必须检查，不得当作「全部」。
- **幂等与并发**：创建类接口不幂等（重复提交会产生新记录）；重命名 / 移动先做目标冲突检查，已存在即报错而非覆盖；下载计数「先计数后传输」，传输启动前失败则回滚。

**错误判定口径**（写客户端前必读）：

失败响应体**只有 `{ error: string }` 一个字段，没有机器可判定的错误码**。因此：

- **分支请按 HTTP 状态码判**，不要匹配 `error` 文案——文案是给人看的，措辞随时会调整，匹配文案的客户端会在某次更新后静默失效。
- 同一个状态码会覆盖多种成因，需要区分时只能靠**调用上下文** 而不是响应本身：

| 状态码 | 常见成因（按接口上下文区分） |
| --- | --- |
| `400` | 参数缺失 / 类型不合法；业务规则不满足（如「已开启需付费下载但未填金额」）；目标冲突（重命名 / 移动到已存在的 key） |
| `401` | 未登录或会话失效；用户名或密码错误 |
| `403` | 权限不足（非管理员）；缺 `X-Requested-With`（CSRF）；上传会话不属于当前用户（SEC-10） |
| `404` | 对象不存在或无权访问；链接 / 订单 / 用户不存在 |
| `410` | 分享链接已删除 / 已过期 / 次数用尽（三者不细分） |
| `428` | 尚未完成配置（`configured: false`），例如未配访问密钥或未选择当前桶 |
| `429` | 触发限流或失败锁定 |

> 若确实需要稳定的机器可读码（如 `INVALID_PARAM` / `QUOTA_EXCEEDED`），需要改造 `server/routes/_shared.js` 的 `sendError()` 与各 `badRequest()` 调用点，属 API 契约变更——**当前版本未提供**，请勿依赖。

**客户端集成建议**（在「没有错误码」这个前提下怎么把集成写稳）：

| 客户端要做的判断 | 依据 |
| --- | --- |
| 是否需要重新登录 | **只看 401**。403 不要当成会话过期——前端正是靠 401 触发强制登出，把 403 也算进去会让用户手误打错一次密码就被踢回登录页 |
| 能否重试 | `429` 按响应里的等待秒数重试；`5xx` 可退避重试；**其余 4xx 一律不重试**（输入不变则结果不变，重试只是放大限流计数） |
| 是否已到终态不必再轮询 | `410` 是分享链接终态（删除 / 过期 / 用尽三者不细分），`409` 在 `/auth/init` 上是终态 |
| 「没配置好」与「没权限」 | `428` = 配置未完成（`configured: false`）；`403` = 权限不足或同源头校验失败。二者处理路径完全不同 |
| 该展示什么给用户 | `error` 文案已脱敏，**可直接原样展示**，无需自己再映射一份文案表 |

`400` 的细分只能靠**调用上下文**（响应本身不提供）：

| 端点族 | `400` 的常见成因 | 客户端可做的事前自校 |
| --- | --- | --- |
| 写接口的参数校验（`/fs/upload/init`、`/config/verify`、支付设置） | 缺字段 / 类型不合法 / 越界 | 提交前按本章「请求体规范」子表自校，不要等 400 |
| 业务规则（创建分享链接、开关付费下载） | 规则组合不满足（如「已开启需付费下载但未填金额」） | 先 `GET` 当前配置再反推哪条规则没满足，比解析文案可靠 |
| 重命名 / 移动 | 目标 key 已存在（`assertNoConflict`） | 先做一次存在性探测，或直接提示用户改名 |

> 这套做法的代价是**客户端必须理解业务语义**，无法靠响应体自洽。这是已知的取舍：给 `error` 加机器可读码要改 `sendError()` 与全部 `badRequest()` 调用点（约几十处），属于破坏性契约变更，当前版本不做。若你确实需要它，改造入口就在上一段引用的那两个符号。

<h3 id="develop_document-section21">7.1 认证与用户</h3>

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查（是否已完成配置） |
| POST | `/auth/init` | 首次启动初始化管理员 |
| POST | `/auth/login` · `/auth/logout` · `/auth/logout-all` | 登录 / 登出 / 登出全部设备 |
| GET | `/auth/me` | 当前会话用户 |
| POST | `/auth/login` | 登录第一步：人机验证 + 密码；若已启用 Windows Hello 则返回 `webauthnRequired` + 一次性挑战（**不签发会话**） |
| POST | `/auth/login/webauthn` | 登录第二步：校验 Windows Hello 断言，通过后签发会话 |
| GET/PUT | `/users/me` | 当前用户资料（**所有登录用户可用**；PUT 仅接受用户名 / 密码，显式拒绝 role / permissions） |
| GET | `/users` | 用户列表：管理员返回全部（`scope:'all'`），普通用户仅返回自己（`scope:'self'`）。普通用户前端不显示用户管理卡片、也不调用此接口 |
| POST | `/users` · `PUT/DELETE /users/:id` | 增删改用户（管理员）。**授权只按 `role` 判定**：`permissions` 字段目前仅原样存储与回传，不参与任何鉴权判定 |
| POST | `/users/:id/logout` | 管理员强制登出指定用户 |
| POST | `/webauthn/register/options` · `/webauthn/register/verify` | 注册 Windows Hello（**需当前密码**）：下发挑战+注册选项 / 校验 attestation 并保存公钥 |
| POST | `/webauthn/disable` | 关闭自己的 Windows Hello（**需当前密码**） |
| POST | `/users/:id/webauthn/disable` | 管理员清除指定用户的 Windows Hello 凭据（救济通道） |
| GET/PUT | `/captcha/config` · `GET /captcha/public` | 验证码开关与下发 |

**请求样例**（登录；`-i` 可以看到服务端下发的 `Set-Cookie`，`-c` 把 Cookie 存进文件供后续请求复用）：

```bash
curl -i -c cookie.txt -X POST http://127.0.0.1:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -H 'X-Requested-With: XMLHttpRequest' \
  -d '{"username":"admin","password":"你的密码"}'
```

**响应样例 · 密码正确且未启用 Windows Hello**（直接签发会话）：

```json
{
  "ok": true,
  "user": {
    "id": "u_8f21c0",
    "username": "admin",
    "role": "admin",
    "permissions": {},
    "webauthnEnabled": false,
    "webauthnCreatedAt": null,
    "createdAt": "2026-09-01T02:11:30.000Z",
    "updatedAt": "2026-09-12T08:24:05.000Z"
  }
}
```

**响应样例 · 已启用 Windows Hello**：同一个请求**不签发会话**（密码通过只是第一步），改为下发一次性挑战，客户端验签通过后再调 `POST /api/auth/login/webauthn`：

```json
{
  "ok": false,
  "webauthnRequired": true,
  "challenge": "vJ8dQ2lRbXk...（base64url，服务端一次性）",
  "rpId": "storage.example.com",
  "timeout": 60000,
  "username": "admin",
  "remember": false,
  "credentialId": "AQIDBAUGBwg..."
}
```

**请求 / 响应样例**（读取当前会话用户；未登录时**不报错**，返回 `user: null`）：

```bash
curl -s -b cookie.txt http://127.0.0.1:3000/api/auth/me
```

```json
{ "ok": true, "user": { "id": "u_8f21c0", "username": "admin", "role": "admin", "permissions": {}, "webauthnEnabled": false, "webauthnCreatedAt": null, "createdAt": "2026-09-01T02:11:30.000Z", "updatedAt": "2026-09-12T08:24:05.000Z" } }
```

```json
{ "ok": true, "user": null, "initialized": true }
```

**失败响应**统一为 `{ "error": "..." }`，文案已脱敏、可直接展示给用户：

- `401` 密码错误 → `{ "error": "用户名或密码错误" }`
- `429` 连续失败触发锁定 → `{ "error": "失败次数过多，账户已临时锁定，请 27 秒后重试" }`
- `403` 写操作缺 `X-Requested-With` → `{ "error": "请求缺少同源校验头，已拒绝（CSRF 防护）" }`
- `401` 无会话访问受保护接口 → `{ "error": "未登录或会话已过期，请重新登录" }`


<h3 id="develop_document-section22">7.2 配置、密钥与存储桶</h3>

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/PUT | `/config` | 读取（掩码）/ 保存配置 |
| POST | `/config/verify` | 测试连接（**仅管理员**）。可携带未保存的 provider/密钥/地域，也可引用已保存密钥的 `credentialId`；自定义 Endpoint 一律经 `assertSafeEndpoint` 校验。**理由两条**：① 请求方可控的 endpoint / 凭据会带来盲 SSRF（SEC-03）；② 本接口会回传该密钥可见的**全部云端桶名**，属账号资产（SEC-11，与 `GET /buckets` 同一口径）。普通用户添加存储桶时请手填桶名与地域，服务端会做存在性探测 |
| GET/POST | `/credentials` · `PUT/DELETE /credentials/:id` | 密钥列表（掩码）/ 新增 / 改备注 / 删除 |
| PUT | `/credentials/:id/active` · `/credentials/visibility` | 设为当前密钥 / 调整可见性 |
| GET/POST | `/buckets/local` · `PUT/DELETE /buckets/local/:id` | 本地桶列表 / **添加（仅管理员）** / 编辑（普通用户仅备注与配额） / 本地删除（仅管理员）。普通用户看到的是管理员开放的桶，只读 |
| PUT | `/buckets/local/:id/active` · `/buckets/local/:id/enabled` · `/buckets/visibility` | 切换当前桶 / 启停 / 可见性 |
| GET | `/buckets/stats` | 每桶容量、累计流量、请求数、碎片统计 |
| POST | `/buckets/local/:id/clear` | 清空桶（`nameConfirm` 须与桶名完全一致） |
| GET/POST | `/buckets/local/:id/fragments` · `/buckets/local/:id/fragments/clear` | 碎片列表 / 中止未完成分片 |
| GET/POST | `/buckets/local/:id/destroy-check` · `/destroy` | 彻底删桶条件检查 / 删除（三重校验） |
| GET | `/acl-check` · `PUT /acl-check/disabled` | 桶 ACL 公有读告警 / 关闭提醒 |

**请求 / 响应样例**（读取配置；密钥一律掩码，任何接口都不回传 `secretKey`）：

```bash
curl -s -b cookie.txt http://127.0.0.1:3000/api/config
```

```json
{
  "selfTest": true,
  "configured": true,
  "corrupted": false,
  "provider": "cos",
  "providerName": "腾讯云 COS",
  "secretIdMasked": "AKID****************************Wxyz",
  "hasSecret": true,
  "bucket": "my-bucket-1250000000",
  "region": "ap-guangzhou",
  "bucketRemark": "生产",
  "quotaBytes": 0,
  "domains": { "primary": "", "backup": "" },
  "uploadExcludes": [],
  "credentials": [ … ],
  "activeCredentialId": "c_7a1f",
  "buckets": [ … ],
  "activeBucketId": "b_2e9c",
  "updatedAt": "2026-09-12T08:24:05.000Z"
}
```

> `credentials` / `buckets` 的元素结构分别见 `GET /api/credentials` 与 `GET /api/buckets/local`；两者都按角色过滤——普通用户只能看到「对其可见且已启用」的条目。

**请求 / 响应样例**（写操作必须带 `X-Requested-With`，否则 403）：

```bash
curl -s -b cookie.txt -X PUT http://127.0.0.1:3000/api/config \
  -H 'Content-Type: application/json' \
  -H 'X-Requested-With: XMLHttpRequest' \
  -d '{"provider":"cos","region":"ap-guangzhou"}'
```

- 成功 → `{ "ok": true }`
- `400` 服务商不支持 → `{ "error": "当前版本暂不支持该服务商，请选择其他服务商" }`
- `403` 非管理员 → `{ "error": "仅管理员可执行该操作" }`（前端隐藏入口只是第一层，接口层一律强制校验）

<h3 id="develop_document-section23">7.3 文件与上传</h3>

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/fs/list` · `/fs/tree` · `/fs/stat` · `/fs/search` | 分页列表 / 目录树 / 属性 / 搜索（默认递归整个子树，`scope=current` 时单级列举；逐页扫描并按游标续扫，客户端断开即停止翻页） |
| POST | `/fs/mkdir` · `/fs/rename` · `/fs/move` · `/fs/delete` | 新建 / 重命名 / 移动 / 删除（递归） |
| PUT | `/fs/upload/simple` | 小文件直传（≤ 8MB） |
| POST | `/fs/upload/init` | 分片上传初始化（返回 `mode` / `sessionId` / `chunkSize` / 已传分片；**载荷见下方请求体表**） |
| PUT | `/fs/upload/chunk` | 上传单个分片（query 传 `session` / `part`，请求体为原始字节） |
| POST | `/fs/upload/complete` · `POST /fs/upload/abort` | 合并 / 取消（请求体 `{ sessionId }`） |
| GET | `/fs/sessions` | 进行中的上传会话（断点续传） |
| GET | `/fs/download` · `/fs/thumb` · `/fs/presign` | 下载（密文校验令牌后解密）/ 缩略图 / 预签名链接 |

**请求 / 响应样例**（目录列举；`contents` 是对象、`prefixes` 是子目录，**两个数组分开返回**）：

```bash
curl -s -b cookie.txt 'http://127.0.0.1:3000/api/fs/list?prefix=photos/&maxKeys=100'
```

```json
{
  "prefix": "photos/",
  "contents": [
    {
      "key": "photos/2026/shanghai.jpg",
      "name": "shanghai.jpg",
      "size": 248192,
      "lastModified": "2026-09-10T03:21:44.000Z",
      "etag": "3b6a1f0c9d2e4a7b8c5d6e7f8a9b0c1d",
      "storageClass": "STANDARD",
      "isFolder": false,
      "type": "image",
      "encrypted": true
    }
  ],
  "prefixes": [
    { "prefix": "photos/2025/", "name": "2025", "isFolder": true, "type": "folder", "size": 0, "lastModified": "" }
  ],
  "isTruncated": true,
  "nextMarker": "photos/2026/shanghai.jpg"
}
```

> `isTruncated` 为真表示**结果不完整**，下一页把 `nextMarker` 原样作为 `marker` 传回。`encrypted: true` 表示云端存的是密文，下载 / 查看时由本地解密。

**请求 / 响应样例**（搜索；`cursor` 原样回传即可续扫）：

```bash
curl -s -b cookie.txt 'http://127.0.0.1:3000/api/fs/search?prefix=photos/&q=shanghai&type=image'
```

```json
{
  "matches": [
    { "key": "photos/2026/shanghai.jpg", "name": "shanghai.jpg", "size": 248192, "isFolder": false, "type": "image", "lastModified": "2026-09-10" }
  ],
  "scanned": 137,
  "limit": 200,
  "cursor": "photos/2026/shanghai.jpg",
  "truncated": true,
  "hint": "该目录下还有未扫描的对象（本轮已扫描 137 个），可继续搜索。"
}
```

**请求 / 响应样例**（小文件直传：请求体是**原始字节**，不是 JSON；`path` 放在 query 上）：

```bash
curl -s -b cookie.txt -X PUT 'http://127.0.0.1:3000/api/fs/upload/simple?path=notes/a.txt' \
  -H 'Content-Type: application/octet-stream' \
  -H 'X-Requested-With: XMLHttpRequest' \
  --data-binary @a.txt
```

```json
{ "ok": true, "key": "notes/a.txt", "encrypted": true }
```

> 超过 8MB 请走分片路径（`/fs/upload/init` → `/fs/upload/chunk` → `/fs/upload/complete`）。**上传排除规则的校验在服务端**，直传与分片两条路径都必须带 `gitignore` / `gitignoreRel` 参数，缺一就会绕过排除规则。

**查询参数 · `PUT /api/fs/upload/simple`**（请求体是**原始字节**，不是 JSON）：

| 参数 | 类型 | 必填 | 约束 / 缺省 |
| --- | --- | --- | --- |
| `path` | string | ✔ | 目标对象 key，服务端 `normalizeKey()` 规范化 |
| `gitignore` | string | ✔ | 排除规则文本；**不传不报错，但等于放弃服务端兜底**（FUN-09），无规则时显式传空串 |
| `gitignoreRel` | string | ✔ | 规则文件的相对目录；同上 |
| `mtime` | string | ✘ | 原文件修改时间，写入云端 `x-cos-meta-file-mtime` |

**请求体 · `POST /api/fs/upload/init`**：

| 字段 | 类型 | 必填 | 约束 / 缺省 |
| --- | --- | --- | --- |
| `key` | string | ✔ | 目标对象 key |
| `size` | number | ✔ | 文件总字节数，须为有限数且 ≥ 0 |
| `gitignore` | string | ✔ | 同直传：服务端兜底校验排除规则 |
| `gitignoreRel` | string | ✔ | 同上 |

```bash
curl -s -b cookie.txt -X POST http://127.0.0.1:3000/api/fs/upload/init \
  -H 'Content-Type: application/json' -H 'X-Requested-With: XMLHttpRequest' \
  -d '{"key":"videos/trip.mp4","size":2147483648,"gitignore":"","gitignoreRel":""}'
```

响应的 `mode` 决定后面走哪条路，**客户端必须按它分支**，不能自己拿 8MB 去猜：

| `mode` | 含义 | 响应字段 |
| --- | --- | --- |
| `simple` | `size` ≤ 直传上限（见下），**服务端不创建会话** | `{ mode, key }` —— 请改调 `/fs/upload/simple` |
| `multipart` | 走分片 | `{ mode, sessionId, chunkSize, uploadedParts, key }` |

- **直传上限是随加密模式变化的（R10-05）**：未开启加密 / `AES-256-GCM` 模式为 **8MB**；「文件头魔数（magic）」模式为 **5MB**（`LIMITS.MAGIC_SYNC_MAX`）。magic 模式的同步加密有 5MB 上限，若 `init` 仍按 8MB 分界，`(5MB, 8MB]` 的文件会被判为 `simple` → 直传必然 413，而前端拿到 `simple` 又不会改走分片 —— 是一条死路。客户端**不要自己写死 8MB**，一律按响应的 `mode` 分支。
- `chunkSize` 由服务端计算：`min(48MB, max(8MB, ceil(size/10000/1MB)·1MB))`，magic 模式再压一道 `min(·, 5MB)`（R8-02：单片同步阻塞上限；同时它是 AWS S3「除末片外每片 ≥ 5MB」的协议下限，两者在此重合，不可再往下调）。
- `uploadedParts` 非空即**命中断点续传**：按「Key + Size + 创建者 + 目标桶」匹配到未完成会话且远端 `uploadId` 仍有效，客户端应跳过这些分片。
- 会话 `provider` 随会话落盘（R7-01），后续 `chunk` / `complete` / `abort` 都按**会话自身**的厂商与桶解析凭据——上传中途切桶不会让已传分片作废。

**其余两个接口的入参**：`PUT /api/fs/upload/chunk` 走 query（`session`、`part`，从 1 开始，请求体为原始分片字节）；`POST /api/fs/upload/complete` 与 `/abort` 走请求体 `{ sessionId }`。三者都会校验会话归属（SEC-10：仅创建者本人或管理员可操作）。

- `chunk` 会校验分片大小 ≤ 会话的 `chunkSize`，超限返回 **400**（R10-08）：分片偏移已由 `chunkSize` 确定，超大的分片既无法正确合并，也会让 magic 的同步 XOR 独占事件循环数秒。

<h3 id="develop_document-section24">7.4 分享、加密、IP、WebDAV、统计</h3>

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/links` | 分享链接列表（管理员全部，普通用户仅自己创建的） |
| POST | `/links` | 创建链接：对目标对象做 `headObject` 校验并快照文件名 / 大小；**载荷见下方请求体表** |
| PUT | `/links/:id` | 改有效期 / 次数 / 密码 / 付费 / 重置计数；普通用户仅限自己创建的 |
| DELETE | `/links/:id` | 删除本地分享记录（**不影响云端对象**）；普通用户仅限自己创建的 |
| GET/POST | `/s/:id` · `GET /s/:id/dl` | 公开分享页 / 密码提交 / 下载（匿名，挂在根路径） |
| POST | `/s/:id/pay` | 发起支付（选渠道 → 返回跳转 URL 或二维码） |
| GET | `/s/:id/pay/return` | 支付平台同步回跳（触发一次查单后回到分享页） |
| POST | `/s/:id/pay/check` · `GET /s/:id/pay/status` | 主动查单 / 状态轮询（最小间隔 3 秒，防刷） |
| POST | `/pay/notify/:platform` | 异步通知（**仅作触发器**，结果以服务端查单为准） |
| GET | `/api/payment/orders` | 订单列表（管理员） |
| POST | `/api/payment/orders/:id/refund` | 标记订单为已退款（管理员；仅作记账，不发起网关退款） |
| PUT | `/api/payment/site-url` | 站点地址（管理员，回跳 / 回调基准） |
| GET/PUT | `/enc/settings` | 加密设置（管理员）：读当前模式 / 改模式与查看密码 |
| GET | `/enc/status` | 加密状态（**所有角色可用**）：只回 `{ passwordSet }`，前端据此决定要不要弹查看密码框 |
| POST | `/enc/unlock` | 查看密码验证换取 30 分钟令牌（仅经 `x-enc-token` 头传递） |
| GET | `/ipguard` · `GET /ipguard/test` | 规则列表 / 预检某个 IP 是否会被拦 |
| POST | `/ipguard/rules` | 新增规则 |
| PUT | `/ipguard/rules/:id` · `PUT /ipguard/rules/:id/enabled` | 修改规则 / **单独切换启用状态**（与整条修改分开的接口） |
| DELETE | `/ipguard/rules/:id` | 删除规则 |
| PUT | `/buckets/local/:id/block-overseas` | 按桶开关海外 IP 屏蔽 |
| GET | `/webdav` · `PUT /webdav/enabled` | 服务状态 / 总开关 |
| POST | `/webdav/accounts` | 新增账户 |
| PUT | `/webdav/accounts/:id` · `DELETE /webdav/accounts/:id` | 修改 / 删除账户 |
| GET | `/webdav/accounts/:id/password` | **回传明文口令**（管理员）。Basic 认证要求服务端能还原原文，口令只能可恢复加密存储——这是设计取舍而非疏漏，见「设计背景与刻意取舍 → WebDAV 口令为可恢复加密」 |
| GET/PUT | `/upload-excludes` | 上传排除规则 |
| GET | `/stats/storage` · `/stats/summary` · `/stats/speed` · `/stats/logs` | 用量 / 汇总 / 速度 / 操作日志 |

**关于退款功能的详解**：

本系统不代持资金，因此无法真正通过本系统退款。此处的退款功能仅作标记之用，真实退款操作仍需用户在支付平台真正为其返还钱款，然后再在本系统标记为“退款”。退款完毕后，下载者将失去下载权限。

该功能仅对支付状态为“已支付”的订单生效。

1. 服务端（`payment-orders.js`）的 refunded 终态与 `markRefunded()`（仅 paid 可转、幂等），记录 `refundedAt`，已使用三条硬约束：

① 不可逆：`markPaid` / `markFailed` / `finalizeOrder()` 三处都显式拒绝改写 —— 付款记录确实存在，网关查单仍会应答"已支付"，若只阻挡一处则会被异步通知复活，导致退款仍可下载；

② 凭证失效：`payerState` 返回 `refunded`（仍可查单得知该用户已付款），下载放行恒为白名单判定 === 'paid'；

③ 永不裁剪：退款订单纳入 `prune` 的保留集合，否则日后无法证明该订单是否确实有成功付款记录。

2. 路由 `POST /api/payment/orders/:id/refund`（`requireAdmin` + 审计）。不发起任何网关退款调用 —— 本系统不代持资金，退款在渠道后台完成，只作记账。
3. 前端（`ordermgr.js`）：确认后订单整行划线失效、状态徽章显示「已退款」、该笔金额从「已收」扣除并单列「已退款」。统计与列渲染抽成 `computeTotals / fmtActions / rowClassOf` 三个纯函数，测试可直接驱动。

**请求 / 响应样例**（分享链接列表；普通用户只返回自己创建的）：

```bash
curl -s -b cookie.txt http://127.0.0.1:3000/api/links
```

```json
{
  "links": [
    {
      "id": "s_9c1e4b7a",
      "key": "photos/2026/shanghai.jpg",
      "bucket": "my-bucket-1250000000",
      "region": "ap-guangzhou",
      "fileName": "shanghai.jpg",
      "size": 248192,
      "createdAt": "2026-09-12T08:24:05.000Z",
      "createdBy": "admin",
      "expiresAt": "2026-09-19T08:24:05.000Z",
      "maxDownloads": 0,
      "downloads": 3,
      "lastDownloadAt": "2026-09-13T01:02:03.000Z",
      "hasPassword": false,
      "missingAt": null,
      "missing": false,
      "paid": { "required": true, "amountFen": 500, "currency": "CNY" }
    }
  ]
}
```

**请求体 · `POST /api/links`**（`PUT /api/links/:id` 复用同一套校验，另多一个 `resetCount`）：

| 字段 | 类型 | 必填 | 约束 / 缺省 |
| --- | --- | --- | --- |
| `path` | string | ✔ | **字段名是 `path`，不是 `key`**。必须指向文件——以 `/` 结尾（目录）一律 400「不支持分享文件夹」 |
| `expiresHours` | number / null | ✘ | 缺省 **168**（7 天）。`0` / `null` / `''` 表示**永久有效**；否则须为正数，上限 `24 × 3650`（10 年） |
| `maxDownloads` | integer | ✘ | 缺省 `0` = 不限制。须为 ≥ 0 的整数，上限 1e9 |
| `password` | string / null | ✘ | 缺省 `null`。长度 1–64 字符；传 `null` / `''` 表示不启用或**清除**已有密码 |
| `paid` | object / null | ✘ | `null` = 关闭付费下载。否则为 `{ required, amount }`——**`amount` 单位是「元」**，与响应里的 `amountFen`（分）不同。`required: true` 而金额 ≤ 0 → 400；`required: false` 时金额**仍会保留**，便于下次直接打开开关 |
| `resetCount` | boolean | ✘ | 仅 `PUT` 有效：是否把已下载次数清零。非布尔值 → 400 |


```bash
curl -s -b cookie.txt -X POST http://127.0.0.1:3000/api/links \
  -H 'Content-Type: application/json' -H 'X-Requested-With: XMLHttpRequest' \
  -d '{"path":"photos/2026/shanghai.jpg","expiresHours":72,"maxDownloads":5,"password":"s3cret","paid":{"required":true,"amount":5}}'
```

```json
{ "ok": true, "id": "s_9c1e4b7a", "key": "photos/2026/shanghai.jpg", "fileName": "shanghai.jpg", "size": 248192,
  "expiresAt": "2026-09-15T12:00:00.000Z", "maxDownloads": 5, "downloads": 0, "hasPassword": true,
  "paid": { "required": true, "amountFen": 500, "currency": "CNY" }, "warn": "" }
```

- `bucket` / `region` / `createdBy` **不来自请求体**：服务端按当前会话的桶上下文与用户名快照，客户端无法指定。
- 目标对象不存在或无权访问 → `404`（创建前会先 `headObject`）。
- `warn` 是**提示不是错误**：支付功能停用、或没有可用渠道时，付费配置依然保存，只是该链接暂时按免费下载处理——付费开关是系统状态，分享者意图不应被它冲掉。

**请求 / 响应样例**（订单列表，管理员）：

```bash
curl -s -b cookie.txt http://127.0.0.1:3000/api/payment/orders
```

```json
{
  "orders": [
    {
      "id": "po_1d3f5a",
      "linkId": "s_9c1e4b7a",
      "platform": "alipay",
      "amountFen": 500,
      "currency": "CNY",
      "status": "paid",
      "createdAt": "2026-09-13T01:00:00.000Z",
      "paidAt": "2026-09-13T01:01:12.000Z",
      "refundedAt": null,
      "downloadedAt": null,
      "fileName": "shanghai.jpg",
      "tradeNo": "2026091322001...",
      "failReason": "",
      "fileKey": "photos/2026/shanghai.jpg",
      "linkExists": true,
      "linkUrl": "/s/s_9c1e4b7a",
      "platformName": "支付宝"
    }
  ]
}
```

**请求 / 响应样例**（标记退款；仅 `status: "paid"` 可转，其余状态 400）：

```bash
curl -s -b cookie.txt -X POST http://127.0.0.1:3000/api/payment/orders/po_1d3f5a/refund \
  -H 'X-Requested-With: XMLHttpRequest'
```

```json
{
  "ok": true,
  "order": {
    "id": "po_1d3f5a", "linkId": "s_9c1e4b7a", "platform": "alipay",
    "amountFen": 500, "currency": "CNY", "status": "refunded",
    "createdAt": "2026-09-13T01:00:00.000Z", "paidAt": "2026-09-13T01:01:12.000Z",
    "refundedAt": "2026-09-14T09:30:00.000Z", "downloadedAt": null,
    "fileName": "shanghai.jpg", "tradeNo": "2026091322001...", "failReason": ""
  }
}
```

- `404` 订单不存在 → `{ "error": "订单不存在" }`
- `400` 重复退款 → `{ "error": "该订单已标记为已退款" }`
- `400` 未支付成功 → `{ "error": "该订单未支付成功，无需退款" }`
- `400` 尚未支付 → `{ "error": "该订单尚未完成支付，无法退款" }`

<h2 id="develop_document-section25">8. 支付设置</h2>

系统设置页内的「支付设置」卡片用于登记各支付平台的 API 凭证与站点地址。凭证部分只做**必填与格式校验**（不代持资金、不做联机验证）；下单与查单由 `server/payment-gateway.js` 直连各平台官方接口完成。

<h3 id="develop_document-section26">8.1 主要校验规则</h3>

| 平台 | 字段 | 规则 |
| --- | --- | --- |
| 支付宝 | 应用 ID `app_id` | 16 ~ 32 位纯数字 |
| 支付宝 | 应用私钥 / 支付宝公钥 `private_key` · `alipay_public_key` | PEM（`-----BEGIN … PRIVATE/PUBLIC KEY-----` 成对）或足够长的 Base64 密钥体 |
| 支付宝 | 签名算法 `sign_type` | `RSA2` / `RSA` / `SM2` |
| 支付宝 | 网关 `gateway` | 必须 `https://`（默认生产网关，沙箱可换 `openapi-sandbox.dl.alipaydev.com`） |
| 支付宝 | 证书序列号 `app_cert_sn` · `alipay_root_cert_sn` | 选填，仅「公钥证书」加签模式需要 |
| 微信支付 | 商户号 `mchid` | 10 位纯数字 |
| 微信支付 | 应用 ID `appid` | `wx` 前缀 + 16 位字母数字，需已绑定至该商户号 |
| 微信支付 | APIv3 密钥 `api_v3_key` | 32 位字母数字；用于解密平台回调资源与下载平台证书 |
| 微信支付 | 商户证书序列号 `serial_no` | 40 位十六进制；仅用于让平台定位验签用的公钥 |
| 微信支付 | 商户 API 私钥 `private_key` | PKCS#8 PEM（`apiclient_key.pem` 的内容）。**必填**：APIv3 下单的 `Authorization` 为 `WECHATPAY2-SHA256-RSA2048`，必须用该私钥做 SHA256-RSA 签名；`api_v3_key` 只负责解密，**不能代替它** |
| 微信支付 | 子商户号 / 子应用 ID `sub_mchid` · `sub_appid` | 选填，仅服务商 / 渠道商模式需要 |
| PayPal | Client ID / Client Secret | 20 ~ 128 位，可含 `-` `_` |
| PayPal | 运行环境 `mode` | `sandbox` / `live` |

<h3 id="develop_document-section27">8.2 开关层级</h3>

| 层级 | 字段 | 说明 |
| --- | --- | --- |
| 总开关 | `config.payment.enabled` | 卡片右上角「启用 / 停用」。**停用后所有付费链接自动转为免费下载** |
| 渠道开关 | `config.payment.platforms[id].enabled` | 每家平台独立开关，可任意组合 |
| 约束 | — | 总开关为**启用**时，至少保留一个渠道开启；关闭最后一个会被拒绝（400）并提示先停用支付功能 |

三态区分（界面与接口均体现）：`enabled`（开关打开）→ `configured`（凭证填完）→ `available`（= 两者皆真，下载者才可选它付款）。渠道开启但凭证未填完时状态为**待补全**，不参与可收款渠道列表。

<h3 id="develop_document-section28">8.3 接口</h3>

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/payment/config` | 总开关 + 三家平台表单定义 + 已保存配置 + 可用渠道（敏感字段仅回传是否已配置） |
| `PUT` | `/api/payment/enabled` | 总开关；无任何渠道开启时拒绝启用 |
| `PUT` | `/api/payment/site-url` | 站点地址（回跳 / 回调基准），必须以 `http(s)://` 开头 |
| `GET` | `/api/payment/orders` | 订单列表（含文件名、链接、商户单号、付款时间、是否已下载） |
| `PUT` | `/api/payment/config/:platform/enabled` | 渠道开关；关闭最后一个时拒绝 |
| `POST` | `/api/payment/config/:platform/validate` | 仅校验不落盘；敏感字段留空时沿用已保存值参与校验 |
| `PUT` | `/api/payment/config/:platform` | 校验通过才保存（首次填写默认开启该渠道）；全空提交 = 清空 |
| `DELETE` | `/api/payment/config/:platform` | 清除该平台凭证（连带关闭渠道，同样受约束校验） |
| `POST` | `/api/payment/orders/:id/refund` | 将订单标记为**已退款**（仅「已支付」订单可操作；本系统不代持资金，不发起任何网关退款调用） |

> 九条接口全部挂载 `requireAdmin`；该卡片列入 `ADMIN_ONLY_CARDS`，普通用户整卡不可见且不发请求。凭证随系统配置一同以 AES-256-GCM 加密保存于 `data/config.enc`。

<h3 id="develop_document-section29">8.4 支付状态机</h3>

```
（访问链接）→ 未支付 ──选渠道发起──→ 支付中 ──成功──→ 已支付 ──管理员标记退款──→ 已退款（凭证失效）
                                       └──失败──→ 支付失败 ─┘（可重新发起）
```

| 状态 | 下载 | 下载者看到的提示 |
| --- | --- | --- |
| 未支付 | ❌ 402 | 需要付费后才能下载（展示金额与可选渠道） |
| 支付中 | ❌ 402 | 支付尚未完成，请完成支付后再试 |
| 支付失败 | ❌ 402 | 上一次支付未成功：具体原因（可重新发起） |
| 已支付 | ✅ | 信息页显示已支付，直接下载 |
| 已退款 | ❌ 402 | 订单已退款，原支付凭证已失效（可重新支付） |

> 下载放行是**白名单判定**（`payerState(...) === 'paid'` 才放行），而不是"只要不是未支付就放行"的黑名单 —— 后者在新增状态时会被默认放行，退款后仍能下载等于下载者可免费获取文件。

<h3 id="develop_document-section30">8.5 各状态切换的字段变化、校验与异常处理</h3>

| 切换 | 字段变化 | 校验规则 | 异常场景 |
| --- | --- | --- | --- |
| 设置付费（创建 / 编辑链接） | `link.paid = { required, amountFen, currency }`，金额以**分**为整数存储 | 勾选即要求金额 ≥ 0.01 元；上限 100000 元；浮点金额一律四舍五入到分；**币种恒为 `CNY`** | 未填金额 → 400；金额低于 0.01 → 400；支付停用或无可用渠道时**仍允许保存**，返回 `warn` 由界面提示「配置已保存，但暂时按免费处理」 |
| 取消勾选付费 | `required=false`，**金额原样保留** | — | 重新勾选时金额仍在，无需重填 |
| 停用总开关 | 只改 `payment.enabled`，**不动任何链接** | 停用永远允许 | 付费链接自动转免费；下载页展示「分享者已停用支付功能，当前可免费下载」 |
| 重新启用总开关 | 只改 `payment.enabled` | 至少一个渠道开启，否则 400 | 付费逻辑按原配置恢复，金额与停用前一致（读取时计算，无需数据迁移） |
| 关闭某渠道 | 只改该渠道 `enabled` | 总开关启用时不允许关闭最后一个 | 若因此没有可用渠道，付费链接转免费并提示「尚未配置可用支付渠道」 |
| 发起支付 | 新建订单 `status=pending`，金额**快照**进订单 | 渠道必须在可用列表内；同 IP 同链接限流 | 渠道非法 → 回付费页并提示重新选择；操作过频 → 提示等待 |
| 支付成功 | `status=paid` + `paidAt` | — | 已支付订单**不允许**被后续失败回调改判 |
| 支付失败 | `status=failed` + `failReason` | — | 可发起新订单重试；旧失败订单不再作为凭证 |
| 标记为已退款 | `status=refunded` + `refundedAt` | 仅「已支付」订单可标记；管理员操作，走二次确认 | 不可逆：`markPaid` / `markFailed` 一律拒绝改写；重复标记保持幂等（第二次返回 400） |
| 分享者改价 | 只改 `link.paid.amountFen` | 同上金额规则 | **已支付订单仍有效**（按支付时的金额快照）；新订单按新价 |

> **币种语义**：`currency` 恒为 `CNY`——它是 `payment-rules.js` 中的常量，写入分享链接时由 `normalisePaid` 强制归一，接口不接受其他取值。PayPal 本身支持多币种，但本系统不开放：各币种的最小单位并不相同（JPY 无小数位、KWD 为三位小数），「以分为整数」这一金额语义只对人民币成立，放开币种等于引入一整类舍入错误。

<h3 id="develop_document-section31">8.6 已支付凭证</h3>

支付成功后下发 Cookie 票据 `订单ID.HMAC(linkId:orderId)`，`httpOnly` + `SameSite=Lax`。签名输入同时绑定链接与订单，因此票据**无法跨链接复用**、也无法伪造；下载端只认 `status === 'paid'` 的订单。

标记为已退款后，票据依然能被识别（`payerState` 返回 `refunded` 而非 `none`）——这让下载者看到「这笔已退款，请重新支付」而不是「请付费下载」，但**不产生任何放行效果**；退款订单同样纳入「永不裁剪」集合，否则日后无从证明这笔钱退过。

<h3 id="develop_document-section32">8.7 订单退款（人工记账）</h3>

**本系统不代持资金**——下载者付的钱从未经过这台服务器，退款是在支付宝 / 微信支付 / PayPal 的商户后台手动完成的。因此退款功能**不发起、也不可能有**任何网关退款调用，它只做三件事：

1. 把订单状态置为 `refunded` 并记下 `refundedAt`；
2. 让该订单的支付凭证立即失效（下载者需重新支付才能下载）；
3. 让这笔金额从管理页的「已收」小计中扣除，并单列进「已退款」。

| 约束 | 说明 |
| --- | --- |
| 仅管理员 | 接口挂 `requireAdmin`（普通用户 403），不依赖前端隐藏按钮 |
| 仅「已支付」订单 | 支付中 / 失败 / 已退款一律返回 400 并给出可读原因（未收款谈不上退款） |
| 二次确认 | 界面弹出危险确认框，明确「因本系统不代持资金，标记退款仅代表已在其它渠道退还钱款，本系统仅作记账和标记」 |
| 不可逆 | `markPaid` / `markFailed` 都显式拒绝改写已退款订单；网关查单仍会回答「已支付」，照它办理等于把钱退了还能下载 |
| 幂等 | 重复标记不改变状态（接口层在第二次返回 400，storage 层保持 `refunded`） |

> **为什么不做真退款**：真退款需要商户私钥去调用网关的退款接口，并要求处理异步退款通知、部分退款、退款失败重试与手续费退还。本系统的定位是「托管下载 + 记账」，引入这些等于引入一条全新的资金流链路和相应的一致性责任；相比之下，人工在商户后台退款 + 在此处打标记，语义更诚实：系统不会假装自己经手了钱。

<h3 id="develop_document-section33">8.8 真实支付网关</h3>

`server/payment-gateway.js` 直连三家平台的官方接口，**零新增依赖**（RSA-SHA256 签名、AES-256-GCM 解密、HTTP 调用全部基于 Node 内置模块）：

| 平台 | 下单方式 | 下载者体验 | 结果确认 |
| --- | --- | --- | --- |
| 支付宝 | `alipay.trade.page.pay`（RSA2 签名后跳转收银台） | 跳转到支付宝页面付款，付完自动回跳 | `alipay.trade.query` |
| 微信支付 | Native 下单（APIv3，`Authorization` 五段式签名） | 页面展示二维码，用微信扫码付款 | 按 `out_trade_no` 查单 |
| PayPal | Orders v2 创建订单后跳转 `approve` 链接 | 跳转 PayPal 审批页，付完自动回跳 | 查询订单，`APPROVED` 时补一次 capture |

微信 Native 的二维码由 `server/qrcode.js` 自行生成（字节模式、纠错等级 M、版本 1–10、按 ISO/IEC 18004 计算纠错码字与掩码惩罚分，输出内联 SVG），不引入二维码库；`tests/qrcode.test.js` 按标准逐项校验。

<h3 id="develop_document-section34">8.9 支付结果确认（服务端查单）</h3>

规则同「设计背景与刻意取舍 → [支付结果仅限服务端查单返回](#develop_document-section10)」（**权威定义，此处不重复**）。支付侧的两个具体落点：

- **三个触发点**：同步回跳 `/s/:id/pay/return`、前端轮询 `/s/:id/pay/check`、异步通知 `POST /pay/notify/:platform`。三者都只负责**触发一次查单**，成功与否一律以查单结果为准。
- **两处限流**：轮询最小间隔 3 秒，且查单接口本身挂限流器。该端点匿名可达，且会携带真实商户凭据向平台查单——缺少限流时任何人扫到回调地址即可反复触发查单、刷光平台的查单配额。

**新增一家支付平台的步骤**：① 在 `server/payment-providers.js` 定义 `fields`（含 `official` 官方字段名、`pattern` / `validator` / `secret` 标记、`maxLength`）；② 需要联机校验时用 `registerValidator(platformId, fn)` 登记，路由与前端无需改动；③ 在 `server/payment-gateway.js` 实现 `createCharge` / `queryCharge`——**查单必须 fail-closed**（异常即视为未支付，不放行）；④ 前端 `paysettings.js` 的表单由服务端下发的同一份字段定义渲染，通常无需改动，只需在 `payment-logos.js` 追加 LOGO。

<h2 id="develop_document-section35">9. 搜索</h2>

搜索的**正确性**已经完整（逐页扫描 + 游标续扫、不重不漏、客户端断开即停止翻页），本节只讨论**性能**：还有哪些社区建议没有采纳，以及为什么。

先纠正一个流传的误解。曾有一种说法是「搜索慢是因为本项目有 15 个写入口，任何一个没登记就会永久不一致」，据此认为「强一致的本地元数据索引」不可行。**这个前提与代码事实不符**：

- 云端调用早已收口到 `cos.js` 里的唯一出口 `p()` —— 全库所有对象的读 / 写 / 列举 / 分片 / 复制都要经过它。因此「新增一个写入口就要在旁边补一次缓存失效」这种**登记成本在结构上并不存在**：按「最终发出**写**方法的 `p()` 调用点」实测为 **26 处、分布在 7 个文件**（连同只读调用一起算则是 57 处 / 12 个文件）。
- 判据与代码同源、不需要人来维护：`list-cache.js` 用**只读白名单**判定，只读方法之外的**未知方法一律按写处理**（宁可多失效），所以新增任何云端调用都自动进失效链，无需回来登记。
- `p()` 在**成功与失败两条分支**上都会把该次调用播报给 `list-cache.js`，后者对外只有一个通知点；候选集缓存只订阅这一个点，接线**仅 1 处**，且不必逐个接口登记。

据此，本项目把原先设想的「强一致本地索引」**降级为带 TTL 的候选集缓存**（`server/search-candidates.js`：默认 TTL 10 秒、单条上限 1 万键，越限即整条丢弃并退回逐页列举）。它只回答「这些键上次确实存在」，**允许过期、靠 TTL 自愈**，任何时候都不充当「桶里有什么」的判据。一旦接受最终一致，「漏一处写入口即永久不一致」这个否决理由就自动失效 —— 这正是采纳它的原因。

仍未优化 / 未实现的内容如下：

| 社区建议方案 | 未实现原因 |
| --- | --- |
| **前端结果缓存** | 浏览器无法感知他人（或 WebDAV、分享页）的写入，会比服务端缓存多出一个不一致面。而服务端缓存已覆盖同一场景。 |
| **并行/预取分页** | 对象存储列举只能顺序翻页，服务端仍是串行，提前预取下一页只能省下每页约几毫秒的本地过滤时间。 |
| **关键词下推为** **`Prefix`** | 语义不等价： `Prefix` 只能做前缀匹配，导致结果不完全/不可信。 |
| **调大单页上限** | 已是 S3 API 硬上限 1000。 |

候选集缓存也**消除不掉**的两条物理限制如下。它们不是「还没做」，而是做不掉：

- **站外写入不可感知**：别人绕过本系统（直接在控制台操作、或经其他工具写桶）时，本进程收不到任何信号，只能等 TTL 到期。这与「缓存多久」无关，是分布式系统的固有代价 —— 影响范围只是「最多陈旧一个 TTL」。
- **首轮必须真扫一遍**：候选集只能让**后续**搜索免费；第一次搜索（或 TTL 过期后）仍要按页翻完整个前缀。若单桶对象数到 10 万量级，首扫延迟会变得显眼 —— 此时正确的做法是**后台扫描作业**（定时物化候选集），而不是继续加长 TTL。

<h2 id="develop_document-section36">10. 性能与可靠性</h2>

- **异步 I/O**：日志内存缓冲（50 条或 2 秒）批量落盘；配置、加密元数据、分享链接、上传会话、统计均异步 / 串行写入，避免阻塞事件循环。
- **缓存与并发**：解密配置 60 秒 TTL 缓存；多桶统计并发上限 3，腾讯云优先调用官方 `?stats`、失败回退对象列举（S3 厂商直接走列举估算），容量结果缓存 15 分钟。
- **高效匹配**：国内 IP 段（6000+）预排序 + 二分查找；搜索无筛选条件时降低扫描量，结果超限给出提示。
- **传输优化**：`/api` JSON 响应与静态文本资源（`.html/.js/.css/.svg/.json/.webmanifest` 等）启用 gzip——实测 `main.js` 体积降约 71%、`style.css` 降约 77%（**测量口径**：`zlib.gzipSync` 默认压缩级别，样本为当时的仓库产物；压缩比随文件内容浮动，请按「量级」而非绝对值理解，复现时以你手上的文件为准）；流式下载 / 缩略图 / 测速接口与已压缩二进制（`.png/.woff2/.mp4` 等）自动跳过，避免大文件缓冲进内存；JS / CSS 静态资源 5 分钟强缓存（HTML no-cache）；下载以 `stream.pipeline` 传递背压并设无活动超时；WebDAV **读取**支持 HTTP Range 断点续传（写入侧为全量缓冲，见「技术限制与已知局限」）。

---

<h1 id="develop_document-section37">三、核心模块实现</h1>

<h2 id="develop_document-section38">1. 文件加密与元数据</h2>


<h3 id="develop_document-section39">1.1 三种方式与密文结构</h3>

`server/enc-store.js` 提供三种模式，密文结构互不相同：

| 模式 | 密文结构 | 与原文长度关系 |
| --- | --- | --- |
| crypto | `[魔数 COSCENC01(10B)][段1: IV(12B) ‖ 密文 ‖ TAG(16B)][段2 …]` | 大于原文 |
| magic | `[用户魔数(M B)][异或(原文[M:])]`（被覆写的原始文件头存入本地元数据） | 与原文等长 |
| none | 不加密 | — |

- crypto 的段与分片一一对应：直传即单段，分片上传则每个分片一个独立段，因此断点续传与进程重启后继续都不必重建加密上下文。
- magic 的密钥流是**纯位置函数**：块 i = `SHA256(主密钥 ‖ 盐 ‖ u32be(i))`，不依赖会话状态，任意偏移均可独立解密。实现上按 32 位字批量异或，并逐块生成、就地消耗，避免一次性分配与明文等长的缓冲。
- 魔数输入支持十六进制（`0x` 前缀）与 UTF-8 文本，长度 1–64 字节；随机盐恒开。

> 魔数模式属于混淆级保护，非强加密，建议仅用于防止 IDC 服务商审核。若涉及隐私或敏感数据请务必选择 crypto 模式。

<h3 id="develop_document-section40">1.2 元数据是解密的唯一凭据</h3>

解密参数（IV / TAG / 盐 / 原始文件头 / 原始大小）保存在 `data/enc-meta.json`，按 `<bucket>|<key>` 索引。该文件是 crypto 与 magic 两种模式解密的**唯一**凭据来源，因此围绕它有一组硬性约束：

- 读取失败时以空表继续运行以保证服务可用，同时置「损坏」标记并**拒绝写入**，磁盘原件另存为 `.corrupt-<时间戳>` 备份等待人工恢复——绝不用空表覆盖。
- 密文一旦安全落云，立即把解密凭据同步落盘，将「云端已有密文、本地尚无元数据」的窗口压到零；上传完成等关键节点与进程退出钩子各兜一次。
- 重命名 / 移动 / 复制时同步迁移元数据；只有**云端确认删除成功**的对象才清理其元数据。按前缀无条件清空的接口已从代码中移除：它与「列举被截断」组合时会只删掉前 N 个对象却清空整个前缀的元数据，残留密文永久不可解。

<h3 id="develop_document-section41">1.3 分片路径与完整性校验</h3>

分片加密状态随上传会话持久化，magic 模式的盐与原始文件头在首次加密时即固定，进程重启后续传仍保持一致。

magic 属混淆级保护，本身没有认证标签：密文一旦被篡改或损毁，旧实现会静默产出看似正常但内容错误的明文。现改为在元数据中记录明文摘要、并在解密流末尾校验：

- 直传记录整文 SHA-256；分片路径在分片**连续且按序**到齐时给出逐片摘要，解密时在确定性边界上逐段校验；任一分片缺失则不声称可校验（回退旧行为）。
- 摘要按**还原后的完整明文**分段，而密文体偏移不含被魔数覆写的头部，故解密侧需维护独立的明文游标；跨分段边界的缓冲区必须按边界切分后分别累加，否则正常文件会被误判为篡改。
- crypto 模式为**每段独立**的 GCM 认证：段内任何字节被篡改，都会在该段 `decipher.final()` 处报错；密文被**截断**时，末尾的分段状态机走不完，`flush` 直接判为「数据不完整」——也就是说「尾部少一段 / 少几个字节」是可以检出的。
- 但**逐段 GCM 只认证单段**：AAD 为空，段序号与对象身份都没有被绑定进认证。因此把两个**等长**段的 `IV ‖ 密文 ‖ TAG` 整块互换、或把同一密钥下另一个对象的段拼进来，每段自身依然能通过认证——解出的是顺序错误或来源错误的明文，且无从察觉。这是**已知局限**：补 AAD 需要版本号与迁移路径（老密文没有 AAD，直接改会让历史对象全部解不开），因此暂未引入。

<h3 id="develop_document-section42">1.4 查看密码与访问令牌</h3>

查看密码是可选的访问控制层，与加密密钥相互独立（以 scrypt 哈希存储，忘记可重置）。校验通过后签发 30 分钟有效的 HMAC 令牌，令牌**仅经 `x-enc-token` 请求头**传递，不进入 URL、浏览器历史、Referer 与访问日志。

口令校验入口一律使用异步 scrypt：该类入口攻击者可达，同步版本会占满单线程事件循环，数十个并发请求即可让全站失去响应。

<h3 id="develop_document-section43">1.5 孤儿元数据巡检</h3>

对象被本系统之外的工具删除，或云端操作成功而本地元数据写入失败，都会留下指向已不存在对象的元数据。孤儿记录本身只造成无谓膨胀，但元数据丢失意味着密文永久不可解，二者方向相反、不可简单取舍。因此提供巡检接口：列出某桶下「本地有元数据、云端已无对应对象」的候选，**交由调用方决定是否清理**，巡检过程本身不删除任何记录。

<h2 id="develop_document-section44">2. 统一文件网关</h2>

<h3 id="develop_document-section45">2.1 收口的理由</h3>

`server/fs-gateway.js` 是全部对象读写删操作的唯一入口，管理端路由与 WebDAV 共用。收口之前 WebDAV 直连 SDK，会产生四类问题：写入未加密、读取直接下发密文（用户编辑回写即永久损坏）、删除 / 复制 / 移动不联动元数据、全链路无审计日志。

网关行为随加密模式自动切换：不加密时走直通路径，行为与未启用加密完全一致；加密时写操作自动加密后上传，读操作挂载解密流透明还原，删除与复制移动同步联动元数据并记录审计。

<h3 id="develop_document-section46">2.2 读取路径：信号量与范围请求</h3>

- 加密读取受信号量限流（并发上限 3），避免多路大文件同时解密造成内存线性增长。释放器必须幂等且带下界保护：可销毁流在带错误销毁时会先 `error` 后 `close`，若两个回调各递减一次，计数将漂移为负，此后并发上限永久失效。
- 加密对象的范围请求需完整下载解密后在内存中切片；明文超过上限即退化为全量流式解密（忽略 Range），避免单请求占用与明文等量的内存。非加密对象的 Range 由对象存储原生处理。

<h3 id="develop_document-section47">2.3 删除、复制与移动的截断契约</h3>

前缀删除（目录删除）必须遵守同一套契约，且全项目只允许一份实现：

1. 显式判定列举是否被截断，循环执行「列举一页 → 删除一页」直至清空或达到轮次上限；
2. **仅当云端删除确实成功后**才按批清理元数据，绝不先清元数据再删对象；
3. 目录标记对象在全部子对象删除成功后再删，截断时不删；
4. 仍被截断时如实返回截断标记，由调用方告警——绝不返回成功。

复制同样存在大小阈值：服务端单次复制有上限，超出必须先探测对象大小再决定是否分块复制，否则会出现「同一操作在管理界面成功、在 WebDAV 必然失败」的行为分裂。`CopySource` 的格式由客户端工厂统一生成（S3 厂商为 `/bucket/key`，腾讯云为外链形式），不再本地硬编码。

<h2 id="develop_document-section48">3. 分片上传与断点续传</h2>

- 会话持久化在 `data/upload-sessions.json`，记录 uploadId、已上传分片 ETag 与**分片加密参数**；加密参数同样受敏感数据保护。
- 恢复上传按「Key + Size + 创建者 + 目标桶」匹配。仅按 Key + Size 匹配会命中其他用户或其他桶的会话：前者泄露他人会话标识与分片进度（存在性侧信道），后者会让续传落到错误的桶上。
- 启动时的过期清理会尽力中止远端分片（避免持续计费）且不等待其完成；会话总数设上限，超出时按更新时间淘汰最旧的记录。
- 落盘采用去抖合并，但**去抖窗口内进程被强制终止会丢失分片加密参数**——已上传的分片将无法解密，表现为「上传成功但文件无法打开」，重新上传还会产生新的计费分片。因此优雅停机必须强制落盘；退出钩子的兜底必须使用同步写，异步写在 `exit` 处理器返回后永远不会被调度。
- 会话列表按创建者过滤，管理员可见全部。

<h2 id="develop_document-section49">4. 分享链接生命周期</h2>

<h3 id="develop_document-section50">4.1 标识与快照字段</h3>

链接 ID 为 16 字节 base64url（22 字符，128 位熵）——它会暴露在公开 URL 中，故不能过短；历史 8 / 12 字符 ID 仍可正常访问。链接在创建时快照目标对象、所属桶、展示用文件名与大小；分享者的收费意图同样原样保留在链接上。

快照只表达意图，是否真的收费由付费规则在**读取时**计算：停用支付功能后链接自动转为免费，重新启用又自然恢复，全程无需改动链接数据。

**管理页的列**：除文件与状态外，还展示**分享者**（`createdBy`）与**存储桶**（`bucket`），两者同样取自创建时的快照 —— 管理员看到一条陌生链接时，先要知道它是谁建的、指向哪个桶，才能决定是联系创建者还是直接处理。早于「按创建者隔离」那次改造创建的链接没有 `createdBy`，界面显示占位符而不是把空白当成某个用户。

<h3 id="develop_document-section51">4.2 状态判定顺序</h3>

状态序为 `已删除 > 已过期 > 次数用尽 > 有效`。「对象已不存在」排在最前：它是最根本的事实，否则管理页仍显示「有效」，管理员会去调整有效期或次数，改完照样无法下载。前端判定独立成模块并与服务端同序，避免出现「管理页显示有效、访客打开却提示文件已删除」。

对象缺失有两个判定来源：系统内删除对象时，按**已确认删除的 key 集合**批量标记（不接受前缀，理由同元数据清理）；系统外删除则依靠分享页的惰性探测补齐，且只有云端明确返回「不存在」才予标记，其余一律按「仍存在」处理——误标会让一条正常的链接被永久判死。

<h3 id="develop_document-section52">4.3 下载配额与来源判定</h3>

**放行判定顺序**（唯一权威定义；改动此处请同步「设计背景与刻意取舍 → 支付结果仅限服务端查单返回」）：

1. **来源判定**——有副作用的 GET 若无来源校验，第三方页面用一行 `<img src>` 就能刷掉额度；
2. **分享密码**——未通过即到此为止，不触碰任何计数；
3. **付费校验**——必须排在扣减配额**之前**，否则反复支付失败即可耗尽下载次数；
4. **扣减下载配额**——先计数后传输，读-改-写在单线程下全程同步，并发不会突破上限；
5. **对象存在性**——启动前失败（对象已不存在等）则**回滚**第 4 步的计数；
6. **传输**。

判定细节与其余要点：

- 来源判定分层：持有有效票据 → 放行（票据为 `SameSite=Lax`，跨站子资源请求不会携带，天然阻断预取）；浏览器显式声明跨站 → 拒绝；缺失来源头 → 回退校验 `Referer`，有 `Referer` 但不同源即拒绝，无 `Referer` 视为直连客户端，放行但记录审计。
- 密码通过后签发的令牌与**当前密码哈希**绑定，而非仅与链接 ID 绑定：修改或清除密码后旧令牌立即失效。否则「修改分享密码」这一动作无法撤回已获授权的访问者。

<h2 id="develop_document-section53">5. 请求上下文与会话鉴权</h2>

- 「当前桶」是会话级状态；全局默认桶的语义降级为**系统默认桶**，仅在无会话场景（WebDAV、分享链接、启动自检）与首次登录时作为回退。
- 上下文基于 `AsyncLocalStorage`，在鉴权中间件里建立一次，后续任意深度的异步调用都可取到，路由层无需逐个传参——避免为几十个调用点补参数时的漏改。切换当前桶可直接更新上下文，无需重新登录。
- 权限判定一律以**实时用户记录**为准，不使用登录时写入会话的角色快照；用户在配置中已不存在时直接销毁会话。
- 会话 Cookie 的 `Max-Age` 由服务端剩余有效期推导；勾选「记住登录状态」时有效期由 24 小时延长至 30 天。浏览器本地只保存用户名——真正免于重复登录的是会话有效期，而非本地存储的凭据。
- 未捕获异常不因已打印而继续服务：本服务持有「加密元数据」与「配置」两类一旦写坏即不可逆的状态，继续接受请求会让故障在用户数据上放大，因此记录后触发优雅关闭。

<h2 id="develop_document-section54">6. IP 访问守卫</h2>

- 规则模型：目标（单 IP 或 CIDR）、作用范围（空 = 全局，否则为桶集合）、方法（空 = 全部方法）、启用状态与命中计数。历史单桶字段在加载时迁移为数组。
- 判定优先级：**回环放行 → 桶级规则（仅作用于目标桶的请求）→ 全局规则 → 按桶屏蔽海外 IP**，任一级别命中即屏蔽；桶级与全局规则互不覆盖，各自独立生效。
- 目标桶必须按会话解析。若直接读取全局默认桶，用户切换当前桶后「对 A 桶生效的封禁」会在切到 B 桶时失效，反之 A 桶的合法请求可能撞上 B 桶的封禁。
- 「屏蔽海外 IP」按桶生效：仅当请求能解析出目标桶且该桶开启开关时才参与判定，避免误伤管理界面导致自身被拒。
- **IP 段数据须自行维护**：`china-ips.txt` 的正确性完全依赖这份数据，而 IP 段会持续分配与回收——请自行确认其数据来源、许可证与更新周期，并定期替换（替换后重启服务生效）。加载时折叠为「互不相交且升序」的闭区间这一不变量，由 `tests/audit-regressions.test.js` 断言保护：不变量一旦被破坏，二分定位会**静默漏判**（既不报错也不命中）。
- 中间件必须挂在鉴权之前（否则被屏蔽的请求会先执行一遍业务逻辑），因此需自行解析一次会话 token。WebDAV 服务复用同一套判定——它监听独立端口，此前完全不受约束，等于为屏蔽规则开了一道旁门。
- 命中提示页会回显客户端 IP；该值在启用 `TRUST_PROXY` 后来自请求方可控的请求头，必须转义。

<h2 id="develop_document-section55">7. 速率限制与失败锁定</h2>

- 限流采用滑动计数窗口，按 IP（可拼接业务键）统计，超限返回 429 并给出重试等待秒数。
- 失败锁定在「同一窗口内连续失败达阈值」后触发，冻结时长随失败次数指数增长（有上限）。计数必须按窗口衰减：终身累计会让隔数日手误一次的正常用户在第 N 次被锁在门外。**但锁定期内不得重置**——否则等到窗口滑过再失败一次即可清零，等于为锁定留了后门。
- 条目回收条件需覆盖「从未被锁定」的条目，且在记录失败的路径上同样执行回收，不能只依赖查询路径顺带触发。
- 跟踪表设有键数硬上限，达上限时优先淘汰未锁定的条目；该上限只承担内存安全职责，不作为安全边界——各入口自身的限流器才是边界。
- 预置实例覆盖登录、加密查看密码、分享密码、系统初始化、口令校验类管理动作、WebDAV 认证、分享下载与支付异步通知。其中支付通知端点匿名可达，且会携带真实商户凭据向网关查单：缺少限流时，任何人扫到回调地址即可反复触发查单、刷光查单配额。

<h2 id="develop_document-section56">8. 列举上限与目录缓存</h2>

- 所有列举上限集中在 `server/limits.js`：搜索与用量估算 5000、文件夹属性计数 20000、删除与清空 5000、WebDAV `Depth: infinity` 5000，另设 50000 的硬性天花板。此前这些数字散落在四个文件中，取值从 2 万到 20 万不等且互不知情。全部可用环境变量覆盖，便于受控压测。
- 目录缓存定位为「加速重复刷新」，**绝不作为真值来源**：TTL 仅 3 秒（`LIST_CACHE_TTL_MS=0` 可整体关闭），且任何写操作立即失效整个桶的缓存。
- 失效挂在全项目唯一的云端调用咽喉点上，按「方法是否为写」判定：只读方法用白名单，**未知方法一律按写处理**（宁可多失效）。这样新增任何云端调用都不必回来登记。其他需要「云端一写即失效」的模块在此订阅，咽喉点仍然只有一处。
- 缓存不做持久化：一旦落盘就要同时面对一致性、跨用户可见性与敏感 key 存储三件事，进程内缓存重启即空，天然没有这些问题。

**搜索候选集缓存**（`server/search-candidates.js`）是在同一个咽喉点上订阅的第二个消费者：

- 它是一份**明确可能过期的对象键清单**，只用于省掉「重复搜索时重新翻页」，**任何时候都不充当「桶里有什么」的判据**。与之相对，「本地元数据索引」意味着可信真值，那才要求每一处写入口同步维护、且漏一处即永久静默不一致 —— 本项目刻意不做那一层。
- 因为失效通知来自唯一的咽喉点，**新增写入口的登记成本在结构上是 0**，接线只有 1 处（订阅 `list-cache.js` 的写操作通知，而后者由 `cos.p()` 在成功与失败两条分支上喂入）。
- 代价是必须接受**最终一致**：站外写入（别人直接在控制台操作、生命周期规则、其他工具）本进程收不到任何信号，只能等 TTL 到期。所以 TTL 取保守的 10 秒（`SEARCH_CANDIDATES_TTL_MS`），且**从首次物化算起、命中不续期** —— 否则热条目永不失效，站外写入造成的陈旧窗口可以被无限延长。
- 容量上单条目上限 1 万键（`SEARCH_CANDIDATES_MAX_ITEMS`）：**越限即整条丢弃**并记一条 `warn` 日志，该子树退回「逐页列举 + 秒级页缓存」的既有行为。丢弃之后**不允许从当前页重新积累** —— 那样物化出来的是一段「中间窗口」而非从头开始的连续前缀，续扫时会静默漏掉窗口之前的对象。大桶不适合物化候选集，正确的做法是上后台扫描作业。
- 对象存储的列举游标是**独占**语义（返回**大于** `Marker` 的键），故候选集内的二分切片必须用严格大于：用「大于等于」会让续扫把刚处理过的对象再发一次。

<h2 id="develop_document-section57">9. 统计与操作日志</h2>

- 统计按天聚合（保留最近 30 天），另有按桶累计的上传 / 下载字节数与请求数；实时速率为内存采样，不持久化。
- 操作日志写入 `data/logs.jsonl`，上限 5000 条：内存缓冲合并写入，避免每次请求同步追加阻塞事件循环；字段经清洗去除控制字符并截断长度，避免污染 JSONL 结构。
- 轮转由定时器在空闲时执行：先刷出缓冲再轮转（否则两者几乎必然相撞、轮转长期得不到执行），且只在确实超出上限时做异步流式重写，不再无条件全量重写整个文件。
- 统计文件的损坏降级语义与敏感数据不同：统计并非核心数据，不因它拒绝启动，但**读降级为空表、写永久锁定**，磁盘原件备份为 `.corrupt-<时间戳>` 等待人工恢复。

<h2 id="develop_document-section58">10. WebDAV 服务</h2>

- 独立 HTTPS 端口（复用本地自签名证书），Basic 认证；未启用或无有效账户时不监听。
- **能力声明必须与实际实现一致**：`OPTIONS` 返回 `DAV: 1`，**不是 `1, 2`**。`2` 在 RFC 4918 里意味着支持 locking，而本服务不实现 `LOCK` / `UNLOCK` / `PROPPATCH`；声明了却拿不到实现，资源管理器与 Office 在写入前先试 `LOCK`，会退化成「能浏览但写不了」。未实现的动词一律回 `405` 加 `Allow` 头（而不是落到 SPA 兜底的 `404`：`404` 会让客户端以为「这个 URL 不存在」而放弃重试，`405` 才表达「资源在、但这个动词不支持」）。`Allow` 头与适配动词集合取自同一处定义。
- **HEAD 不读对象体**：必须在使用文件网关的 `readObject` **之前**分流到 `headObject`。`readObject` 在返回前就已经发出了 `getObject` 请求，拿到返回再 `destroy()` 的写法会让每个 HEAD 都真拉一次对象体（对大文件等于整份下载）。
- 挂载点边界由**前置统一中间件**保证：除根重定向与健康探测外，任何不在挂载点之下的路径一律 404。此前逐方法判断，漏掉的 PUT 会在桶中创建只能通过挂载点以外路径写入的幽灵对象。
- 路径到对象 Key 的归一化与管理端共用同一函数，禁止 `..`，并对畸形百分号编码做容错——否则会写出界面既看不到也删不掉、却持续计费的对象。
- 认证限流分两层：按 IP 的全局限流（仅按用户名锁定时，攻击者更换用户名即可绕开并持续触发口令哈希），叠加按用户名的失败锁定。**两层都只统计认证失败**：成功请求也计数会把正常使用顶到上限——客户端挂载一次目录动辄几十个 `PROPFIND`，限流很快就会被自己的合法流量打满，表现为「挂载用一会儿就再也连不上」。
- 读写删改一律经文件网关：自动加解密、联动元数据、记录审计。删除目录未删完时如实报错，绝不返回 204；`MOVE` / `COPY` 的目标必须位于本服务挂载点之下且主机一致，失败原因如实透传 4xx，不折叠成 500。
- `COPY` 目录必须**逐页复制到底**，而不是只复制第一页；`Overwrite: F` 时目标已存在的对象要逐个判 `412` 并汇总，不能整目录静默放行。
- **不得把目录 COPY / MOVE 到自身或其子目录**。此前只对文件分支做了 `srcKey === dstKey` 判断，目录分支一旦指向自身内部（如 `/a/` → `/a/b/`），复制出的对象又会落入待复制集合，形成**无界递归复制**：请求永不返回、存储持续膨胀并计费。判定必须在进入复制循环**之前**完成（与目标是否已存在无关）。
- **目录 `MOVE` 也要认 `Overwrite: F`**（RFC 4918 §9.9.4）。此前该判定只用在了文件分支与目录 `COPY` 分支，目录 `MOVE` 直接合并覆盖——带「不覆盖」策略的同步工具会在自己以为安全的前提下静默覆盖目标已有对象。判定只需列举目标**一层**（`Delimiter: '/'`）即可确认「非空」，不必递归。
- **Range 响应两端必须自洽**：读取侧支持断点续传，因此带 `Range` 的 `GET` 必须回 **206 + 区间长度 + `Content-Range`**，`HEAD` 也须给出同一套事实。此前 `GET` 把 `Range` 交给云端（只拿回区间字节）却宣告**全量** `Content-Length`，客户端按宣告长度继续等剩余字节，最终报「传输被提前关闭」——大文件表现为下载损坏 / 播放失败（VLC、PDF 阅读器、Office、多线程下载器的续传都走这条路径）。越界范围回 `416`（并带 `Content-Range: bytes */total`），不得折叠成 500，否则客户端会当成服务端故障而无限重试。
- 列举上限同样取自集中定义，不再在本模块硬编码。**截断必须显式告出**：`Depth: 1` 的 `PROPFIND` 取满上限时返回 `X-WebDAV-Truncated` / `X-WebDAV-Truncated-Reason` 响应头并写一条 `warn` 审计日志（含具体路径与条数）。刻意**不**往 207 体里塞伪 `<D:response>`——那会被资源管理器当成真实条目渲染成幽灵文件，比不提示更糟。

<h2 id="develop_document-section59">11. 服务端点守卫</h2>

自定义 `endpoint` 决定服务端把凭据发往何处，因此校验策略默认从严：

- 仅接受 http / https 协议；非回环地址一律要求 https，否则访问密钥将以明文暴露在链路上；
- 回环地址与私网 / 链路本地 / 保留 IP 字面量默认拒绝，可用 `ALLOW_LOOPBACK_ENDPOINT=1`、`ALLOW_PRIVATE_ENDPOINT=1` 显式放开内网对象存储场景；
- 云平台实例元数据地址永远拒绝，不受上述开关影响；
- **不对域名做 DNS 解析后再判定**：解析会引入新的解析面与 TOCTOU 问题，且内网对象存储常以内部域名暴露。只判定 IP 字面量与元数据主机名，是在不破坏既有内网部署前提下的务实边界。

<h2 id="develop_document-section60">12. 上传过滤匹配器</h2>

`.gitignore` 语法解析遵循 git 官方规范：注释、`!` 取反、尾随 `/`（仅匹配目录）、`**` 前导 / 中间 / 尾随、`* ? [..]` 通配、反斜杠转义；含 `/` 的规则锚定在 `.gitignore` 所在目录，否则可匹配任意层级；同一路径按规则顺序「最后命中者生效」。

实现必须是**线性匹配器**（模式编译为 token 序列后以动态规划推进），绝不可编译为正则：`.gitignore` 文本来自客户端，多条通配符相邻会形成嵌套量词，`**/**/**/…` 或大量 `*a*a*a…` 会让 V8 正则进入灾难性回溯，单线程事件循环被占满，全站（含 WebDAV 与所有下载）失去响应。服务端与浏览器端各有一份实现，逻辑必须保持一致。

解析设有结构性上限，超出时**截断并在匹配器上标记**，由调用方决定是否告警——静默丢弃会让「本该被忽略的文件却被上传」难以排查。

<h2 id="develop_document-section61">13. 持久化、启动与关闭</h2>

- 全部持久化文件采用「临时文件 + rename」的原子写入。直接写目标文件会先清空再写入，进程在两步之间退出即留下 0 字节文件。临时文件名必须包含随机量：仅用毫秒时间戳会在同一毫秒内重名，后一次写入以 `w` 模式打开同一临时文件并先行截断，两次写入将共用一份数据。
- 启动时清扫孤儿临时文件，三重条件缺一不可：文件名匹配本模块规则、文件名中的 pid 已不存活、修改时间早于阈值。Windows 上 `process.kill(pid, 0)` 对系统服务返回 `EPERM`，需再核对一次进程列表，避免将系统服务误判为孤儿。PID 复用会导致漏删，清扫属尽力而为，宁可漏删不可误删。
- 日志类追加改用 `appendFile` 而非「读全文件 + 整体替换」，消除 O(n) 写放大；代价是崩溃时可能只损坏最后一行，对日志场景可以接受。配置类文件仍走原子写入。
- 敏感 JSON 统一以 AES-256-GCM 加密落盘，主密钥复用配置主密钥；兼容历史明文文件，读取时自动识别、写入时自动升级。写入按文件维度串行化，避免并发交错导致文件损坏。
- 单实例锁基于独占创建的锁文件，锁内记录 pid；持有者进程已不存在时自动接管。其目的在于避免两个进程各自持有配置缓存并交替整体覆盖 `config.enc`。
- 优雅关闭顺序：停止接收新请求 → 刷出日志缓冲 → 等待敏感数据异步写完成 → 配置落盘 → 停止 WebDAV → 退出，并设置兜底超时。

<h2 id="develop_document-section62">14. 前端模块与渲染约定</h2>

- 前端为原生 ES Module，无构建步骤；模块按职责划分，管理端能力按角色物理分离（动机见「设计背景与刻意取舍」）。
- **唯一的非 ESM 例外是 `pay-poll.js`**：它服务于服务端渲染的分享页，需要从 `<script data-link-id>` 属性上取参数，而 `document.currentScript` 在 `type="module"` 脚本里恒为 `null`，因此写成普通脚本。它曾经是页面里的内联 `<script>`——CSP 移除 `script-src 'unsafe-inline'` 后那段脚本被浏览器静默拒绝执行，「支付成功后自动放行」的承诺随之失效；抽成同源静态文件即落回 `script-src 'self'` 之内。**分享页与主站共用同一套 CSP**，因此分享页模板里同样不允许出现内联脚本或内联事件处理器。
- **请求序号**：文件区所有异步加载共用一个计数器，发起前自增，响应到达时若自身已不是最新一次则丢弃结果。在途时直接返回会把用户的后续操作静默丢弃，比不互斥更糟。自增必须落在「确认会发起请求」之后——早退分支同样自增会把在途请求判为过期而无人收尾，加载态将永久卡住。
- 序号只解决「旧结果不该覆盖新结果」，解决不了「服务端那一轮仍在空转扫描」，因此另配 `AbortController`：发起新一轮前取消上一轮，服务端检测到连接断开即停止翻页。主动取消必须原样抛出，不可被改写成「无法连接本地服务」这类误导性提示。
- 渲染必须幂等。登出与登录成功两个时点都要重置主视图并清空各模块的渲染缓存，否则下一个账号会看到上一个账号停留的区块。
- 富文本渲染默认按纯文本转义：弹窗与 Toast 默认纯文本，需要富文本必须显式声明并自行转义插值，使「未转义即渲染」从沉默的默认行为变为显眼的、可被评审发现的声明。
- 定时器句柄一律保存，并在登出或目标元素不存在时停止，否则会出现登出后仍持续轮询接口的无效请求。

---

<h1 id="develop_document-section63">四、测试</h1>


<h2 id="develop_document-section64">1. 测试与 CI</h2>

项目使用 Node 内置的 `node:test` runner，不引入任何测试依赖：

| 测试文件 | 覆盖范围 |
| --- | --- |
| `tests/routes-surface.test.js` | 路由表面积护栏：总数基线、无丢失/无重复、敏感接口 `requireAdmin` 覆盖、路由优先级 |
| `tests/s3-client.test.js` | S3 客户端：缓冲/流式/Range/404、分页双游标语义、SigV4 签名 host 一致性 |
| `tests/crypto-storage.test.js` | 加密往返、XOR 等价性、原子写入、追加不整体替换（文件对象同一性探针，非墙钟阈值）、孤儿 tmp 清扫、单实例锁、IP 段判定 |
| `tests/frontend.test.js` | 24 个前端模块 ESM 语法、import 路径存在性、转义工具复用、Windows Hello 就绪判定与错误分类、权限门控约定、角色界面分离、会话切换的主视图重置、请求序号自增不得早于早退校验（结构不变量分析器，自带样例自测）、搜索的请求取消三要素（AbortController / signal 透传 / limit 与范围）、主动取消不被误报为「无法连接本地服务」（真实 ESM + fetch 打桩） |
| `tests/webauthn.test.js` | WebAuthn 零依赖实现：CBOR 解码、`coseToSpki` 一致性、ES256 验签（反双重哈希护栏与裸 `r\|\|s` 兼容）、authData 解析、挑战一次性、注册与认证全流程及负数路径 |
| `tests/gzip.test.js` | 压缩判定与端到端 `Content-Encoding` 还原 |
| `tests/payment.test.js` | 支付凭证与付费下载：字段官方命名、必填/格式/枚举校验、PEM 与 https 校验器、敏感字段不回传明文、「留空保持不变」合并语义、`registerValidator` 扩展点、开关约束与渠道三态、金额最低 0.01 元、付费生效判定、订单状态机与票据防跨链接复用、支付路由全部挂载 `requireAdmin` |
| `tests/payment-gateway.test.js` | 真实支付网关：支付宝待签名串排序与空值剔除、RSA2 签名结构、微信 Authorization 五段式与 GCM 解密、PayPal 沙箱/生产域名选择、`createCharge` / `queryCharge` 的失败即关闭语义 |
| `tests/qrcode.test.js` | 自研二维码：按 ISO/IEC 18004 校验版本 1–10 字节模式容量、格式信息位、GF(256) 乘法、掩码惩罚分与模块矩阵可解码性 |
| `tests/auth-session.test.js` | 登录会话（起真实 express 应用请求）：连续调用 `/auth/me` 不销毁会话、用户被删/降权立即生效、记住登录 TTL 与 Cookie `Max-Age` 同源 |
| `tests/audit-regressions.test.js` | 审计回归护栏：越权写桶、会话实时鉴权、SSRF、ReDoS、损坏文件不静默回落、信号量幂等、列举上限集中治理、magic 完整性校验、分享令牌绑密码、会话级当前桶（四读端同源）、删除目录截断守卫、分享下载来源判定、重命名/移动冲突检查等（均经反向对照验证） |
| `tests/audit3-regressions.test.js` | 第三轮审计护栏：订单落盘字段、`markDownloaded` 仅在下载成功后调用、模拟支付端点不存在、支付结果只能由查单确认 |
| `tests/search-cursor.test.js` | 搜索续扫：`limit` 触顶与扫满上限时游标落在最后处理的 key、空页 + IsTruncated 不死循环、续扫不重不漏；「仅当前目录」的单级列举（子目录与文件混排不重不漏、页边界游标、目录占位对象过滤、缓存键含 delimiter）、客户端断开后服务端停止翻页 |
| `tests/list-cache.test.js` | 目录列举短缓存：按桶失效不误伤、写操作失效 / 读操作不失效、未知方法按写处理、TTL 过期与开关、条目上限、路由级命中不访云端 |
| `tests/search-candidates.test.js` | 搜索候选集（`search-candidates.js` 与 `/fs/search` 的接入）：游标切片必须是**严格大于**（与对象存储 `Marker` 同语义，用 `>=` 会让续扫重发刚处理过的对象）、TTL 命中不续期、超限整条丢弃且**不再重新物化**（从当前页重新积累会得到「中间窗口」，续扫静默漏对象）、`keyOf` 四个区分维度、`TTL=0` 安全阀、**等价性**（候选集开关/命中与否，同一请求的结果必须逐字段相同）、**候选集的增量**（关掉 `list-cache` 后重复搜索仍不打云端 —— 只测「重复搜索免费」会被页缓存兜住，抓不到「路由根本没接候选集」）、写操作与写失败都立即失效、scope 分离、客户端断开不得被缓存绕过 |
| `tests/audit5-regressions.test.js` | 第五轮审计护栏：IP 屏蔽中间件 HTML 分支不再 500、提示页含客户端 IP 且已转义、回环放行 |
| `tests/audit6-regressions.test.js` | 第六轮审计护栏：stats.json 损坏拒绝落盘、IP 守卫按会话桶解析、新增桶存在性探测（含路由短路）、文件夹重命名的父目录前缀、rename 先迁元数据再删源、复制回滚孤儿副本留痕、`/s/*` 跨站拒绝与支付回调豁免、日志轮转不再被缓冲饿死、配置写去抖合并、分片列举缓存与按桶失效；复核新增「失败计数按窗口衰减 + 条目可回收 + 键数硬上限」（虚拟时钟驱动）与「退出兜底必须同步写」（真实子进程验证）两项 |
| `tests/config-verify-permission.test.js` | `POST /api/config/verify` 的权限边界：必须挂载 `requireAdmin`（云端桶名的唯一入口），非管理员一律 403，且**即便持「可见且已启用」的密钥也不得拿到云端桶列表**（防盲 SSRF + 防账号资产枚举） |
| `tests/share-deleted.test.js` | 分享链接「对象已删除」：状态序、批量标记按桶隔离且幂等、分享页 410、惰性探测落标与二次访问零调用、下载侧补标、前端判定与服务端同序 |
| `tests/docs-sync.test.js` | 文档清单同步护栏：目录结构列出的测试文件 / 前端模块 / 服务端模块与实际一致，文档声明的模块数与测试文件数与实际一致，环境变量表收录了代码中实际读取的全部变量，文档头部声明的适用版本与 `package.json` 一致，**目录（TOC）条目与正文标题一一对应且锚点编号连续**（增删章节忘了同步目录会立刻变红） |
| `tests/audit7-regressions.test.js` | 第七轮审计护栏：分片上传会话必须记录 `provider`（非腾讯云厂商 >8MB 上传不得退化成 COS SDK）、加密元数据必须在云端写入**成功之后**才落盘（写入失败时旧凭据不得被覆盖），均起真实 express + 打桩云端客户端做行为断言 |
| `tests/audit8-regressions.test.js` | 第八轮审计护栏：`magic` 分片上限既要压小同步阻塞又不得低于厂商 5MB 下限、覆盖写入后的元数据对账（明文覆盖必须清旧密文元数据）、`list-cache` 键的调用方命名空间、当前密码错误回 403（回 401 会被前端当成会话过期）、分片列举缓存的容量上限、整桶标记与按 key 标记对历史链接同口径、跨链接订单上限（`paid` / `refunded` 永不裁） |
| `tests/audit9-regressions.test.js` | 第九轮审计护栏（修复验收 + 新发现）：批量删除解析厂商 `<Error>` 且调用方按**白名单**判成败（未确认即视为失败，不得误清元数据 / 误标分享链接）、覆盖复制的元数据对账（源无元数据必须清目标）、WebDAV 目录 COPY/MOVE 自嵌套守卫与 `Overwrite: F` → 412、WebDAV Range 返回 206 + `Content-Range`（含越界 416）与 HEAD 两端一致、`/s/:id/pay/status` 按 IP 预算闸门（不得复用 60/10 分钟的查单限流）、`magic` 同步上限下沉到加密入口（超限 413）、测试临时目录不被退出钩子重建，均起真实 express / 真实 WebDAV HTTPS 做行为断言 |
| `tests/audit11-regressions.test.js` | 第十一轮审计护栏：**「整批 0 成功即停下」必须落在外层循环**（`break` 只跳内层 `for` 时一次失败被放大成上千次云端往返，三处 `deletePrefix` 同构）、目录 MOVE 的元数据迁移必须**早于删源**（中断时目标密文不得挂在已删源 key 的凭据上）、回滚只撤**本次新建**的目标对象（不得删掉目标侧既有对象）、对象存储的 401 必须映射为 502（不得占用本地「会话过期」语义，否则前端强制登出死循环）、`HEAD /api/fs/download` 不得触发对象下载（express 会让 HEAD 退化成 GET）、文件 MOVE 到自身必须 403（自复制 + 删源 = 静默数据丢失）、退出路径只写不建（`enc-store` 同款纪律）、分片上限在**缺 `chunkSize`** 与**模式切换后放大**两条绕行上都要生效（最内层 `encryptPart` 兜底）、文件 COPY 到已存在的目录必须 412、`Accept-Ranges` 与 GET 同源、同名桶在不同厂商/密钥下不得共用列举缓存、分片序号必须是 1–10000 的整数、目录 `displayname` 不得带百分号编码 |
| `tests/audit12-regressions.test.js` | 第十二轮审计护栏：`config-store` 的落盘必须跟随 `COS_DATA_DIR` **且不得改写生产 `data/config.enc`**（第 12 轮实际发生过的数据事故）、目录 MOVE 遇目标同名对象必须**动手前整体拒绝 409**（覆盖不可撤销，回滚删不掉）、退出路径的判据必须走**唯一实现点**（打桩 canonical 后必须真的不写 / 判据为真时真的写 —— 双向）、WebDAV 目录 COPY 中途失败必须回滚到「源在目标不在」、magic 缺 `chunkSize` 时 `encryptPart` **自身**拒绝（`NaN` 偏移会让任务永久卡死）、目标目录过大给专属文案且零改动、元数据迁移后必须已同步落盘、`bucketOfIdent` 取倒数第 2 段（加维度不失效）、并发回滚后目标侧**零残留**且失败后不再启动新任务 |
| `tests/audit13-regressions.test.js` | 第十三轮审计护栏：**测试进程必须默认拿到临时数据目录**（在不设 `COS_DATA_DIR` 的子进程里只 require `helpers.js`，必须已被兜底到临时目录且不是生产 `data/` —— 第 12 轮的隔离靠"每个用例自觉"，实测全量测试仍在写生产数据）、目录 COPY 失败回滚**不得删「复制前就存在的目标对象」**（fresh 过滤；删掉即是不可逆的用户数据丢失）、并发失败必须**先等 worker 落地再取快照**（`stopped` + `allSettled`，目标侧零孤儿，且回滚日志不得谎报 `X/Y`）、`Overwrite: F` 必须整体拒绝（容器级判据覆盖"目标非空但无同名对象"这一**只有它能挡**的形态，键级比对作探测 fail-open 时的兜底）、`moveObject` 删源失败必须回滚本次新建的目标（目标原本已存在时 fail-closed 不删，避免毁掉用户既有数据） |
| `tests/audit14-regressions.test.js` | 第十四轮审计护栏：**支付窗口内的 `pending` 订单不得被裁剪**（裁掉 = 异步通知查无此单 = 钱付了拿不到文件）、裁剪动作必须写 `warn` 日志、超出窗口的 `failed` 仍可裁（证明上限机制没有因保护而失效）。本文件**故意使用默认的 2 小时支付窗口**，与 `audit8` 把窗口压到 1ms 的做法语义相反，常量在模块加载时读取，故必须独立进程 |
| `tests/audit14-perf.test.js` | 第十四轮审计四条性能项（R14-08 / R14-09 / R14-10 / R14-12）与它们共用的两个原语：**去抖合并写**（窗口内多次 `schedule()` 只落盘一次、快照取「真正落盘那一刻」的值、返回 `null` 即本次不写、`debounceMs: 0` 是逃生阀）、**并发合并读**（同一 key 的并发调用只执行一次，失败**不缓存**）、退出兜底必须**同步**写且「只写不建」；以及四条修复各自的**可观测后果**：`secure-store` 落盘时序列化已移出调用栈（断言 `writeJsonAsync` 返回时 `encrypt` 调用次数为 0）且文件不再带缩进换行、`payment-orders` 一次支付流程的 4 次状态变更在去抖窗口内 **0 次**落盘、窗口过后**恰 1 次**且内容是最新快照、分享页惰性探测 5 并发只打 **1 次** `headObject` 且失败要留 `warn` 痕迹并短窗口缓存、`/fs/stat` 文件夹计数命中短缓存且写操作即失效。**假云端客户端必须注入延迟**（`headDelay` / `listDelay`）——不注入就观测不到「请求仍在飞」，撤掉并发合并也照样只打一次（反向对照会假绿） |
| `tests/invariants.test.js` | **跨模块不变量的静态护栏**（第 11 轮报告 §9.4「类别登记表」里可机器化的那些行）：`process.on('exit')` 钩子内不得建目录、生产侧不得裸调 `deleteMultipleObject`（唯一实现点 `cos.deleteMultipleConfirmed`）、`Accept-Ranges` 必须受 `rangeServable` 约束、`listCache.keyOf` 首参必须是 `bucketCacheKey(cfg)`、上游状态回填必须先把 401 映射掉、`router.head` 必须注册在同名 `router.get` 之前、`scripts/reverse-check.js` 的每条 anchor 必须在各自的 `file` 内**唯一**命中（`String.replace` 只替换**首处**，anchor 重复时会打到无关分支 → 变异不生效 → `fail=0` 假绿，R14-05 / R10-11 各中招一次），且**纯注释 anchor 判为违规**；**变异还必须真的等价于旧实现** —— 把某个调用点搬到它自己的 `const` 定义之前，会先撞 TDZ（`Cannot access before initialization`）让子进程因**未捕获异常**退出（状态码同样是 1）、一个字节都没写，于是行为断言的 `status===1` 与「未写 data/upload-sessions.json」**双双被巧合满足**（R7-07 实测 `fail=0`；正确改法是自包含地复现旧实现的可观测后果，而不是搬源码）（锚点校验跑在 `stripComments()` 之上，纯注释剥完只剩空白 → 「命中」恒真、唯一性得到荒谬计数，实测 R9-06 报「67 次」）。第 13 轮又补了四层：**判"私有副本"与"取 canonical 函数体"必须同源**（枚举 `decl` / `expr` / `arrow` / `method` 四种定义形态 —— 旧实现取体只认 `function name(`，把 canonical 重构成箭头函数即可让判据校验静默跳过）、**唯一实现点的接线按登记入口逐文件点名**（取代 `minCalls` 计数代理：删一处真接线再补一处空调用无法绕过）、**每条检查都带扫描范围下界自检**（命中归零时同样全绿，是既有护栏的通病）、`tests/` 侧也纳入数据目录硬编码扫描。注释剥离改为引号/正则感知的扫描器 —— 旧正则把 `'/dav/*'`、`server/routes/*.js` 这类 glob 当成块注释起点，实测吞掉 `ip-guard.js` 1137 字符、文档 27693 字符（全部检查共用的地基缺陷，表现为静默失明）。每条检查都是纯函数且**自带正/反样例自测**，失败信息带 `文件:行号`。第 14 轮再补 5 类静态不变量（`rename` 的 `newKey` 必须过 `normalizeKey`、异步写不得在 `await` 之前取 store、发起支付必须先查支付态、WebDAV 独立实例必须带安全响应头且可渲染类型转 `attachment`、WebDAV 认证三条失败路径都要跑 `dummyHash`）与一条跨文件检查（`public/js/main.js` 声明的验证码脚本源必须被 `server/index.js` 的 CSP `script-src` 允许）。同时把「反向变异 anchor 必须命中」改为**变异期豁免**：`reverse-check.js` 跑单条对照时会**故意删掉**该条 anchor，那条自检会凭空变红，掩盖「真实不变量到底抓没抓到」这一唯一要看的信息，故由脚本注入 `REVERSE_CHECK_MUTATING=1` 使其跳过；并新增「退役项必须写明 `retiredReason` 且总数 ≤ 5」的元护栏，防止用 `retired` 把跑不红的对照项悄悄藏起来 |
| `tests/audit10-regressions.test.js` | 第十轮审计护栏（**对第九轮修复的对抗式验收**）：移动文件夹必须保留目录层级（`dest/b/x.txt` 不得退化成 `dest/bx.txt`）、三处 `deletePrefix` 共用白名单判据（云端未确认删除 → 元数据与分享链接都不动）、目录 MOVE 是 merge 语义（不得清目标侧已有元数据）、`init` 的 simple/multipart 分界必须感知加密模式（消除 5–8MB 死路）、分片大小必须与会话声明一致（超限 400）、WebDAV MOVE 删源必须标记分享链接、加密大对象 HEAD 不得宣告 206、分片完成的用量缓存修正必须命中（缓存键须含 `secretId`）、`Overwrite: F` 判据统一（覆盖「目标是文件」/「目标是空目录」两种漏判，且 COPY 必须在动手之前整体拒绝）、HEAD 不得被 `app.get` 吞掉（一次都不许下载对象）。全部走真实路由 / 真实 WebDAV HTTPS 服务；R10-01 的异步落盘护栏在 `audit9-regressions.test.js`（与退出路径成对断言） |

> 文件名中的轮次编号（1 / 3 / 5 / 6 / 7 / 8 / 9 / 10 / 11 / 12 / 13 / 14）沿用审计当时的命名：第 2、4 轮没有各自的独立护栏文件，其结论已并入相邻轮次，因此编号不连续——**这并不表示存在护栏缺口**。`invariants.test.js` 不属于任何一轮，它是跨轮次不变量的常驻护栏。同一轮可以有两个文件（第 14 轮即 `audit14-regressions` 管正确性、`audit14-perf` 管性能与新增原语）。各轮护栏也不按版本切分：任何一次部署都应让全部护栏通过，不存在「某个版本只需跑其中几条」。

> 共 **31 个测试文件、500+ 条用例**（实测 `node --test "tests/**/*.test.js"` 全绿；runner 汇总为 528 条。本机 `RE-03` / `R7-07` 依赖 `spawnSync`，在部分 Windows 环境恒返回 `status=null`（EBUSY），属环境性失败而非回归，见「六、审计发现台账」的说明），全部零依赖，可直接 `npm test` 运行。修改路由、前端模块或 WebAuthn 相关代码后请先运行。文件数由 `docs-sync` 护栏校验；**用例总数没有护栏**——静态统计（`test(` 调用点 484 处）与 runner 实际计数口径不同（后者含 `t.test()` 子测试），无法用静态方式锁定，故此处只给量级、请勿当作精确基线；确切条数以 `npm test` 结尾的汇总行为准。
>
> **本节是全文唯一的用例计数口径**：其他章节提到用例条数时一律写「见「四、测试 → 1. 测试与 CI」」而**不得另写数字**——曾经「测试与 CI」写 480+、「服务端调试」写 300+，两处都是手抄数字，没有护栏，于是静静地漂移了若干个版本。散落的数字必然失同步，收敛成一个入口才不会。

CI（`.github/workflows/ci.yml`）在 Linux（Node 18/20/22）与 Windows（Node 22）上运行测试，并额外构建 Docker 镜像做容器健康检查冒烟。

<h2 id="develop_document-section65">2. 测试护栏编写约定</h2>

- **护栏优先写成行为断言**：早期有两条只检查「源码里能否 grep 到某个词」，退回旧实现后照样全部通过（形同虚设），已改写为行为断言。**确需读源码时（如「全库仅一处调用 `markPaid`」这类结构性承诺），断言的扫描范围必须与承诺范围一致**——只扫一个文件的话，在别的文件里调用一次就能同时骗过文档与护栏；这类断言应遍历全部源码文件，并在失败信息里列出命中位置。


- **写回归断言要枚举「同一状态的所有读取入口」，而不是只测改动的那一处**：某次回归断言只覆盖了「全局不变 / 会话记住 / `listBucketsFor`」即告通过，遗漏 `get()`，导致界面显示新桶、实际操作仍打全局桶。现行护栏一次性校验 `listBucketsFor` / `safeView` / `get` / `effective` 四者**必须同源**。
- **禁止墙钟阈值断言**（`assert(ms < 20)` 之类）：负载下一红一绿，而「偶发红」会让所有人学会忽略红灯，等于毁掉「全绿」这个信号本身。改用**与耗时无关的确定性探针**：
  - 判断「文件是否被整体替换」→ 比较追加前后的 `fs.stat().ino`（win32 亦可用；tmp+rename 必变）；
  - 判断时间窗口/锁定/去抖语义 → **虚拟时钟**（临时替换 `Date.now`，基准取真实当前时间再小幅推进，避免跨天影响按日期分桶的模块），比真实 `sleep` 更快且完全确定；
  - 判断「退出阶段能否落盘」→ 起**真实子进程**（`spawnSync` + `COS_DATA_DIR` 指向临时目录），父进程读回文件比对。
- **静态分析器（读源码的护栏）必须自带样例自测**，且判定窗口要由**结构**决定，不能用魔数长度：有分析器曾用 400 字符的固定窗口，而目标函数的守卫前导约 480 字符 → 退回旧实现后照样全绿。同理，抽取方法体要**配平花括号**（先跳过参数括号），不能截到下一个 `},`——search 内部有 try/catch/finally 嵌套，按缩进截会让断言范围缩水；样例自身也要花括号配平，否则解析提前收尾、自测先假红。
- **测「连接断开后停止工作」这类时序行为，用挂起的假依赖而不是 sleep**：让假 `getBucket` 把回调存起来，测试端先 `destroy()`、再手动放行首页，之后是否发起第 2 次调用就完全由被测代码的判断决定，与机器快慢无关（放行后仍需一个宽限期让事件循环推进，但那是等待而非断言）。
- 所有审计回归护栏均经**反向对照**验证检出能力：退回旧实现必须 FAIL。变异脚本要**先断言锚点命中**（静默变异失败会伪装成「护栏没抓住」），并做到崩溃安全（登记 + `exit`/`SIGINT`/`SIGTERM`/`uncaughtException` 强制还原 + `data/` 快照）。

<h1 id="develop_document-section66">五、开始二次开发</h1>

本章面向**第一次接触本仓库的开发者**：读完 `1. 高层架构总览` 就知道代码分几层，照着 `2. 本地启动与调试` 能在几分钟内把服务跑起来并看到界面，`3` / `4` 是两个可照抄的最小改动示例，`5` 是提交前必须过一遍的自检清单。

> 本章只讲「路怎么走」，不重复前四章的结论。凡本章与前文冲突，**以前文为准**并请顺手修正本章。

<h2 id="develop_document-section67">1. 高层架构总览</h2>

<h3 id="develop_document-section68">1.1 分层视图与请求链路</h3>

整个系统是**一个单体 Node 进程**：没有消息队列、没有数据库、没有前端构建产物（前端是浏览器直接加载的原生 ESM）。状态全部落在 `data/` 的 JSON 文件里。分层只有四层，且**依赖方向严格自上而下**——领域层模块不知道 HTTP 的存在，因此可以脱离 express 单独测试。

```
浏览器（原生 ESM：无打包 / 无转译 / 无框架）
│  public/index.html · public/css/style.css · public/js/*.js
│  main.js 负责主视图切换，api.js 统一封装 fetch，其余模块各管一块业务
│
│  fetch('/api/**')
│    · Cookie: cosmgr_session（HttpOnly，由服务端签发）
│    · X-Requested-With（POST / PUT / DELETE 必带 —— CSRF 防线，不是装饰）
▼
[ 入口层 ]  server/index.js
│  挂载：/ 静态资源 · /api/** 业务接口 · /s/:id 公开分享页（匿名）
│        /pay/notify/:platform 支付异步通知 · /webdav WebDAV 服务
│  端口：PORT=3000（HTTP）· HTTPS_PORT=3443（自签证书）
│  中间件链（顺序有语义）：请求日志 → 会话解析 → CSRF 校验
│                        → IP 守卫 → 限流 / 失败锁定 → 路由分发
▼
[ 路由层 ]  server/routes.js（只负责挂载）→ server/routes/*.js（13 个领域子模块）
│  _context.js 依赖汇聚（唯一 DI 点）· _shared.js 中间件与工具
│  每个子模块导出一个 express.Router，子模块之间互不 require
▼
[ 领域服务层 ]  server/*.js（纯逻辑，不感知 HTTP）
│  fs-gateway 统一读写网关 · cos.js 客户端工厂 + 错误翻译 · s3-client.js 自研 SigV4
│  providers.js 厂商注册表 · endpoint-guard.js 防盲 SSRF · limits.js 列举上限唯一来源
│  config-store（配置与用户，加密落盘）· enc-store · share-store · list-cache
│  payment-orders / payment-rules / payment-gateway / payment-providers
│  auth-session · webauthn · security（限流 / 失败锁定）· ip-guard · webdav-server
▼
[ 持久化层 ]  data/
│  data/config.enc（含密钥、桶、用户）· data/secret.key · data/enc.key
│  data/enc-settings.json · data/enc-meta.json · data/links.json · data/ipguard.json
│  data/upload-sessions.json · data/payments.json · data/stats.json · data/logs.jsonl
│  data/local-cert.json · data/.instance.lock
│  全部经 atomic-write.js 落盘（tmp + rename），不存在「写了一半」的中间态
▼
[ 外部依赖 ]
   腾讯云 COS（cos-nodejs-sdk-v5）· S3 兼容厂商（自建 SigV4）
   支付宝 / 微信支付 / PayPal（下单与查单直连官方接口）
```

各层的职责边界，以及「想改点什么时该先看哪里」：

| 层 | 代码位置 | 职责 | 改动前先读 |
| --- | --- | --- | --- |
| 入口 | `server/index.js` | 静态资源、中间件链顺序、端口与 HTTPS、优雅停机 | 二.5 安全说明、二.6 REST API 模块化组织 |
| 路由 | `server/routes/*.js` | 参数校验、权限判定、组装响应 | 二.7 HTTP API |
| 领域 | `server/*.js` | 业务规则、与云端 / 支付网关的交互 | 三、核心模块实现 |
| 持久化 | `server/atomic-write.js` + `data/` | 原子落盘、损坏检测与拒绝写入 | 三.13 持久化、启动与关闭 |

**一次 `GET /api/fs/list` 的完整链路**——照着这条线读一遍代码，是最快的入门路径：

1. 前端 `explorer.js` 调 `API.list(prefix, marker)` → `api.js` 带上 Cookie 与 `X-Requested-With` 发请求；
2. `index.js` 的会话中间件解析 `cosmgr_session`，并**用实时用户记录**（不是登录时的快照）判定角色；随后 IP 守卫、限流依次放行；
3. `routes.js` 命中 `routes/fs.js` 注册的 `GET /fs/list`；
4. 路由先用 `requireConfig()` 确认已配置密钥与桶，再由 `cos.js` 的 `getClient()` 取得客户端；
5. `listCache` 命中就直接返回（同目录重复刷新不访云端）；未命中才调云端 `getBucket`，并用 `encStore.encryptedSetFor()` 标出哪些对象是密文；
6. 组装 `{ prefix, contents, prefixes, isTruncated, nextMarker }` 返回，前端按 `isTruncated` 决定是否显示「加载更多」。

<h3 id="develop_document-section69">1.2 状态存放与启动顺序</h3>

**状态全在 `data/`**，没有数据库。因此「备份」= 复制 `data/` 目录；「迁移」= 复制目录 + 保证目标机器上有同样的 `data/*.key`。写测试时优先用 `COS_DATA_DIR` 指向临时目录做隔离（多数存储模块支持；`config-store` 不支持，涉及它的用例要另想办法）。

启动顺序（`server/index.js` 末尾自上而下，顺序本身有含义）：

1. 注册 `SIGINT` / `SIGTERM`（Windows 还有 `SIGBREAK`）→ 优雅停机，`flush` 后关端口；
2. **单实例锁**：两个进程同时操作同一份 `data/` 会交替整体覆盖加密配置，因此检测到活跃实例直接拒绝启动（崩溃残留的脏锁会被自动接管，真卡住时删 `data/.instance.lock`）；
3. 清扫 atomic-write 留下的孤儿 `*.tmp`（条件：pid 已死 + mtime 超 10 分钟）；
4. 起 HTTP（`PORT`，默认 3000）与 HTTPS（`HTTPS_PORT`，默认 3443，自签证书失败则只提供 HTTP）；
5. 把历史遗留的明文数据文件升级为加密存储；
6. 配置损坏（`isCorrupted()`）时打印警告——**不静默回落**；
7. 按已保存配置启动 WebDAV；
8. 注册 `uncaughtException`：记录后优雅退出（认为进程已进入未定义状态，继续服务会把故障放大到用户数据上）。调试时可用 `NO_RESTART_ON_UNCAUGHT=1` 关闭该行为。

<h2 id="develop_document-section70">2. 本地启动与调试</h2>

<h3 id="develop_document-section71">2.1 启动方式与端口</h3>

```bash
npm install            # 只有 3 个运行时依赖（cos-nodejs-sdk-v5 / express / selfsigned）
npm start              # node server/index.js
npm run dev            # node --watch server/index.js —— 改服务端代码自动重启
npm test               # node --test "tests/**/*.test.js"
npm run lint           # node scripts/lint.js（ESLint 包装器：未装 eslint 时给安装指引并以 0 退出）
```

> **容器化部署不在本节**：Docker 镜像构建、卷挂载（`data/` 必须持久化，否则重启即丢密钥）与端口映射见 `README.md`「3.4 Docker 部署」。本节只覆盖本机源码启动与调试。

启动后访问 `http://127.0.0.1:3000`：

- 首次启动页面会引导创建管理员（`POST /api/auth/init`，仅当系统尚无任何用户时可用）；
- `http://127.0.0.1:3000/api/health` 是最省事的探活端点，返回 `{ ok, time, configured, corrupted }`——`configured: false` 表示还没配密钥，界面会停在引导页；
- HTTPS 默认在 `3443`（自签证书，浏览器会告警，点「继续」即可）。

常用环境变量（完整清单见 `2. 环境变量`）：

| 变量 | 用途 |
| --- | --- |
| `PORT` / `HTTPS_PORT` / `HOST` | 监听端口与绑定地址（默认 3000 / 3443 / 127.0.0.1） |
| `COS_DATA_DIR` | 把状态目录指向别处（写测试、并行跑实例时用） |
| `TRUST_PROXY` | 仅在可信反向代理后设为 `1`，否则不信任 `X-Forwarded-For` |
| `NO_RESTART_ON_UNCAUGHT` | 设为 `1` 时未捕获异常不触发退出，便于现场调试 |

> 调试时**不要直接对着真实 `data/` 反复折腾**：起第二个实例会被单实例锁拒绝，而误改配置可能导致加密数据损坏。优先 `COS_DATA_DIR` 指向一个临时目录。

<h3 id="develop_document-section72">2.2 服务端调试</h3>

- **断点**：`node --inspect-brk server/index.js`，再用 Chrome 打开 `chrome://inspect`（或 VS Code 的 attach 配置）。前端代码直接在浏览器 DevTools 里断点即可。
- **看日志**：操作审计落在 `data/logs.jsonl`（滚动保留，不追求长期明细），管理员可 `GET /api/stats/logs` 拉取；启动期与异常直接打在控制台。
- **看状态**：改完配置想确认是否落盘成功，直接看 `data/config.enc`（加密）与 `GET /api/config` 的 `selfTest`（自研加密自检，失败说明密钥材料有问题）。
- **接口试探**：按 `7. HTTP API` 里的 curl 样例来。写操作记得带 `-H 'X-Requested-With: XMLHttpRequest'`，否则 403——这是最常见的「登录了却被拒」的原因。
- **测改动**：`npm test` 跑全量；用例条数的量级见「四、测试 → 1. 测试与 CI」（此处**故意不写数字**，避免第二处计数再次漂移）。只想跑其中一个文件用 `node --test tests/<file>.test.js`。**`npm test` 的 glob 必须带引号**，否则某些 shell 会先展开路径。
- **本机跑不起来的两条**：`RE-03` 与 `R7-07` 依赖 `spawnSync`，在部分 Windows 环境恒返回 `status=null`（EBUSY），属**环境性失败而非回归**；判定方法是看这两条之外的用例是否全绿。

<h3 id="develop_document-section73">2.3 前端调试</h3>

前端是原生 ESM、无构建步骤：**改完 `public/js/*.js` 刷新页面即可**（浏览器对 ESM 有缓存，必要时硬刷新）。

- 主视图是一个个 `<section id="...">`，由 `main.js` 的 `MAIN_VIEWS` + `switchMainView()` 统一显隐。**新增视图必须登记进 `MAIN_VIEWS`**，否则登出 / 登录切换时不会被 `resetMainView()` 复位，会残留上一个会话的 DOM。
- 仅管理员可见的内容要**整块隐藏并且不发请求**（见 `syssettings.js` 的 `ADMIN_ONLY_CARDS`），不要只靠服务端 403 兜底。
- 异步列表渲染一律走「请求序号」机制，避免旧响应覆盖新结果；渲染函数要幂等（同一份数据渲染两次结果一致）。
- 冒烟可用无头 Chrome：`chrome --headless=new --dump-dom http://127.0.0.1:3000`（Windows 下用绝对路径调用 `chrome.exe`）。

<h2 id="develop_document-section74">3. 最小示例 A：新增一个只读接口</h2>

**需求**：加一个 `GET /api/demo/ping`，返回当前登录用户名与服务器时间，仅管理员可访问。这个例子覆盖了新增后端能力要动的**全部三个地方**：路由文件、`routes.js` 挂载、路由表面积护栏。

<h3 id="develop_document-section75">3.1 第一步：写路由</h3>

新建 `server/routes/demo.js`。约定：从 `_context.js` 取依赖（唯一 DI 点）、从 `_shared.js` 取中间件，文件末尾导出一个 `express.Router`：

```js
/**
 * 路由：二次开发示例（可整文件删除，不影响其它功能）
 */
const { express } = require('./_context');
const { requireAdmin } = require('./_shared');

const router = express.Router();

// 判权限一律用 requireAdmin 中间件；不要自己比较 req.authUser.role。
// 会话里的 user 是登录那一刻的快照，管理员降权后旧快照仍会带着原 role。
router.get('/demo/ping', requireAdmin, (req, res) => {
  res.json({
    ok: true,
    user: (req.authUser && req.authUser.username) || '',
    time: new Date().toISOString(),
  });
});

module.exports = router;
```

<h3 id="develop_document-section76">3.2 第二步：挂载与依赖注入</h3>

在 `server/routes.js` 里加一行。**挂载顺序有语义**（`auth` 必须最先；`/credentials/visibility` 必须早于 `/credentials/:id`，否则会被参数路由吞掉），新模块一般追加在末尾即可：

```js
router.use(require('./routes/stats'));
router.use(require('./routes/demo'));   // 新增
```

需要用到其它 server 模块时，**先加到 `server/routes/_context.js`** 再从 `_context` 解构，不要在自己的文件里直接 `require('../config-store')`——否则测试无法对单一模块做依赖替换。

<h3 id="develop_document-section77">3.3 第三步：补护栏并验证</h3>

`tests/routes-surface.test.js` 维护着路由表面积基线：**新增路由不登记，测试会红**。这一步是刻意的设计——它保证「删了一个路由」这种事不会被静默放过。

```js
// tests/routes-surface.test.js —— EXPECTED 数组追加一行
'GET /demo/ping',

// mustBeAdmin 数组也追加一行（本接口挂了 requireAdmin）
'GET /demo/ping',
```

然后验证：

```bash
node --test tests/routes-surface.test.js   # 表面积护栏
npm test                                   # 全量
curl -s -b cookie.txt http://127.0.0.1:3000/api/demo/ping
```

如果只想验证「接口真的挂上了 `requireAdmin`」，可以照 `tests/config-verify-permission.test.js` 的写法：起一个真实 express 应用，用普通用户与管理员的会话各打一次，断言 403 / 200。**不要写「源码里 grep 到 `requireAdmin` 这四个字」这类断言**——它抓不到「挂错了路由」和「条件写反了」。

最后把新接口补进 `7. HTTP API` 的表格（否则文档与代码分叉，`docs-sync` 不会发现这一点）。

<h2 id="develop_document-section78">4. 最小示例 B：新增一个前端卡片</h2>

**需求**：加一个「示例卡片」主视图，进入时拉取上面那个 `/api/demo/ping` 并显示结果。三个改动点：

1. **`public/index.html`**：在主视图同级加一个区块，默认 `hidden`：
   ```html
   <section id="democard" class="card-view" hidden>
     <div class="card">
       <div class="card-head"><h3>示例卡片</h3></div>
       <div id="democard-body" class="card-body">加载中…</div>
     </div>
   </section>
   ```
   容器样式由类驱动（`.card-view`），**不要给它写 ID 白名单样式**——ID 白名单每加一个视图就要改一次 CSS，是回归的温床。
2. **`public/js/democard.js`**：导出 `refresh()` / `reset()`，请求统一走 `api.js`：
   ```js
   import { API } from './api.js';
   import { toast } from './util.js';

   export function refresh() {
     API.ping()
       .then((r) => { document.getElementById('democard-body').textContent = `${r.user} @ ${r.time}`; })
       .catch((e) => { toast(String((e && e.message) || e), { type: 'error' }); });
   }
   export function reset() { document.getElementById('democard-body').textContent = '加载中…'; }
   ```
   `public/js/api.js` 里补一个 `ping: () => request('GET', '/api/demo/ping')`。
3. **`public/js/main.js`**：登记视图 + 接上入口按钮：
   ```js
   const MAIN_VIEWS = ['explorer', /* … */, 'democard'];            // ① 必须登记，否则 resetMainView 复位不到
   else if (v === 'democard') democard.refresh();                    // ② switchMainView 分支
   $('side-demo').onclick = () => { switchMainView('democard'); closeSidebar(); };
   ```
   若这块内容仅管理员可见：把它加进 `syssettings.js` 的 `ADMIN_ONLY_CARDS` 一类机制——**整卡隐藏 + `refresh()` 在隐藏时提前 return**，避免「看得见拒绝操作」。

前端改动执行 `npm test` 也会覆盖一部分：`tests/frontend.test.js` 会校验所有前端模块的 ESM 语法、`import` 路径是否存在、主视图列表与 DOM 是否一致。改动后应将 `1. 目录结构` 里的模块清单补上（`docs-sync` 会进行检查）。

<h2 id="develop_document-section79">5. 二次开发检查清单</h2>

- [1] **落盘使用 `atomic-write`**？直接 `writeFile` 会先截断，进程中断就留下 0 字节文件。
- [2] **权限判定用的是实时用户记录**（`findUserRawById()`）而不是会话快照？降权 / 删户 / 改密后是否主动销毁了对方会话？
- [3] **服务端点经过 `endpoint-guard`**？任何来自用户输入的 URL 都可能是一次盲 SSRF。
- [4] **新增路由登记进 `tests/routes-surface.test.js`**，敏感接口进 `mustBeAdmin`。
- [5] **新增文件 / 环境变量 / 模块补进 `1. 目录结构` 与 `2. 环境变量`**——`tests/docs-sync.test.js` 会校验文件清单与环境变量表，漏了直接红。
- [6] **文档同步**：`7. HTTP API` 表格、以及涉及的章节；若插 / 删了一节，记得目录锚点会整体位移（改完用 `docs-sync` 里的目录护栏确认目录与标题仍然一一对应）。
- [7] **护栏是行为断言而不是源码 grep**：写完把实现退回旧版，确认测试真的会 FAIL。
- [8] **改动触及某个审计编号时**（代码里的 `SEC-*` / `FUN-*` / `PERF-*` / `LOW-*` / `S*` / `P*` 注释），先查本文件「六、审计发现台账」：它登记每个编号的含义与闭合依据，并由 `docs-sync` 护栏保证不遗漏。**注意编号不是全局唯一的**：已确证 11 个编号存在同号异义，且 `S4` 与 `SEC-04`、`P3` 与 `PERF-03` 是两套独立系列——因此**新引用必须带轮次或日期限定**（如 `audit6/PERF-01`、`SEC-04（2026-09-14）`）；需要无歧义指代时请用 `6.5` 的限定别名（如 `FUN-12@unbounded-map`）。
- [9] **同一事实只在一处展开细节**：凡文档标注「唯一权威定义」的内容（如「下载放行判定顺序」在 `4.3 下载配额与来源判定`），**其余引用处只写「结论 + 指向」，不复述步骤、顺序或阈值**。复述一次就多一处同步负担，而这类内容恰恰是最容易只改一半的（改了顺序却漏改复述处，读者按旧顺序实现就是错的）。当前两处「唯一权威定义」已按此纪律收口；新增同类内容时请沿用。

> 完整测试跑法与护栏编写约定见 `四、测试`。

---

<h1 id="develop_document-section80">六、审计发现台账（合并存档）</h1>

> 本节把原先散落在仓库根目录的多份审计文档（`AUDIT_FINDINGS.md`、`ANALYSIS-ROUND7.md`～`ANALYSIS-ROUND13.md`、`fix-record.md`）**缩减、合并**成下述两张表，并作为其唯一正本。这些单文件已删除。审计编号的「含义与闭合依据」登记在此，由 `tests/docs-sync.test.js` 护栏保证不遗漏（引用 ⊆ 登记、登记 ⊆ 引用，双向闭合）。

## 6.1 编号台账主表（含义与闭合依据）

> 编号空间**不是全局唯一**的：同一编号在不同轮次被复用，已确证 11 个同号异义（见 6.2）。因此**新引用必须带轮次或日期限定**（如 `audit6/PERF-01`、`SEC-04（2026-09-14）`）；需要无歧义指代时用 6.5 的限定别名。本节所有编号一律用反引号包裹（护栏据此识别登记项）。

**「验证依据」列的可信度分级**（把「有护栏兜着」与「靠反推」区分开，不要一律当既成事实读）：

| 标记 | 含义 | 读者应如何使用 |
| --- | --- | --- |
| 无标记 | 有回归测试直接断言，或源码可当场核对 | 可当作事实 |
| `[推断]` | 原始报告已遗失，由代码注释与回归护栏**反推**得出；结论方向可信，但**严重度与时间是估计值** | 可用于定位，勿当作验收证据 |
| `[未确证]` | 仅见于间接引用，含义无法从残卷或代码复原 | 只知道「曾有此编号」，其余不可考 |

| 编号 | 严重度 | 问题 | 状态 | 验证依据 |
| --- | --- | --- | --- | --- |
| `SEC-01` | 🔴 严重 | 存储桶写接口缺管理员鉴权 | ✅ 已修复 | 路由白名单 + `updateBucket()` 不接受 provider |
| `SEC-02` | 🔴 严重 | 权限变更后会话不失效 | ✅ 已修复 | `index.js` 实时 `findUserRawById()`，用户不存在即销毁会话 |
| `SEC-03` | 🟠 高 | `/config/verify` 盲 SSRF | ✅ 已修复 | `requireAdmin` + `endpoint-guard`；实测 7 类攻击端点全拒 |
| `SEC-04` | 🟠 高 | `.gitignore` 灾难性回溯 | ✅ 已修复 | 重写为线性 DP；实测最坏 7.6ms/次（**测量口径**：当时的本机一次性实测，Windows / Node 22 / x64 单线程同步执行。它**不是护栏断言**——护栏用确定性探针而非墙钟阈值（见「四、测试 → 2. 测试护栏编写约定」），换机器会有量级差异，请按「不再随输入规模爆炸」理解） |
| `SEC-05` | 🟠 高 | 同步 scrypt + 无限流 | ✅ 已修复 | 全库无 `scryptSync`；WebDAV 按 IP、Hello 注册、/auth/init 均有限流 |
| `SEC-06` | 🟡 中 | CSP 含 `unsafe-inline` | ✅ 已修复 | 已移除并补 `object-src`/`base-uri`/`form-action`；前端无内联处理器 |
| `SEC-07` | 🟡 中 | 日志/ACL/会话接口越权 | ✅ 已修复 | `/stats/logs`、`/acl-check` 挂 `requireAdmin`；`/fs/sessions` 按 `createdBy` 过滤 |
| `SEC-08` | 🟡 中 | 分享下载是副作用 GET | ✅ 已修复 | 限流 + `share-origin.js` 纯函数分层判定；行为测试覆盖 7 种组合 |
| `SEC-09` | 🟡 中 | 元数据被空表覆盖 | ✅ 已修复 | 行为测试：损坏必抛错、拒绝写入、留 `.corrupt-*` 备份 |
| `SEC-10` | 🟡 中 | 分享令牌不绑密码 | ✅ 已修复 | 行为测试：改密码/清密码/跨链接均失效 |
| `SEC-11` | 🔵 低 | WebAuthn 挑战不绑用户 | ✅ 已修复 | 行为测试：`challenge_user_mismatch` |
| `SEC-12` | 🔵 低 | WebDAV 口令可逆存储 | ✅ 已修复 | 该风险已在 `1.6 WebDAV 口令为可恢复加密` 与 `3. 威胁模型与不设防边界` 显式文档化。残卷原文写作「README 威胁模型章节标注 SEC-12」，与实际不符：README 无该章节，全库亦无 `SEC-12` 字样标注 |
| `SEC-13` | 🔵 低 | `/auth/init` 无保护 | ✅ 已修复 | `initLimiter` + 进程内互斥 + 临界区内二次检查 |
| `SEC-14` | 🔵 低 | 规则 ID 用 `Math.random` | ✅ 已修复 | 源码检查：无 `Math.random`，用 `crypto.randomBytes` |
| `FUN-01` | 🟠 高 | 上传 `.json` 必然失败 | ✅ 已修复 | raw 解析先于 `express.json`；实测 `isBuffer: true` |
| `FUN-02` | 🟠 高 | 信号量双重释放 | ✅ 已修复 | 行为测试：重复释放不漂负、达上限必排队 |
| `FUN-03` | 🟠 高 | 分片 complete/abort 用错凭据 | ✅ 已修复 | 两处均改 `getClientForSession(sess)` |
| `FUN-04` | 🟡 中 | 前缀删除截断 + 元数据先清 | ✅ 已修复 | `fs.js`/`buckets.js`/`fs-gateway.js` 三处均循环删除 + 截断时保留元数据 |
| `FUN-04b` | 🟡 中 | WebDAV 删目录同型残留 | ✅ 已修复 | `fs-gateway.deletePrefix` 收敛为同一契约；`removeMetaPrefix` 已从全库彻底删除（护栏全库扫描） |
| `FUN-05` | 🟡 中 | 批量复制无回滚 | ✅ 已修复 | `aborted` 标志 + `rollback` + `partial` 明细 |
| `FUN-06` | 🟡 中 | WebDAV 未校验挂载前缀 | ✅ 已修复 | 统一前置中间件 + `Destination` 校验主机与前缀。注意同号异义（见 6.2） |
| `FUN-07` | 🟡 中 | WebDAV 复制不支持大于 5GB | ✅ 已修复 | 网关 `copyObject` 引入 `COPY_SIMPLE_LIMIT` + `sliceCopyFile` |
| `FUN-08` | 🟡 中 | 白名单回溯 8 条漏判 | ✅ 已修复 | 区间归一化；5000+ 探测点穷举对照零差异 |
| `FUN-09` | 🟡 中 | 跨厂商密钥串访 | ✅ 已修复 | 真实逻辑修复：已知厂商无同厂商密钥即 `return null`。注意同号异义（见 6.2） |
| `FUN-10` | 🟡 中 | HEAD 定时器泄漏 | ✅ 已修复 | 抽出 `_head()`，响应到达即 `clearTimeout` |
| `FUN-11` | 🟡 中 | magic 无完整性校验 | ✅ 已修复 | 行为测试：篡改密文必报错，历史文件向后兼容 |
| `FUN-12` | 🔵 低 | `/users/me` 原始记录回退 | ✅ 已修复 | 删除 `\|\| fresh` 分支，未找到即 404。注意同号异义（见 6.2） |
| `FUN-13` | 🔵 低 | `safeView` 口径不一致 | ✅ 已修复 | 复用 `listBucketsFor()`。注意同号异义（见 6.2） |
| `FUN-14` | 🔵 低 | 移动/重命名可能静默覆盖 | ✅ 已修复 | 抽出 `assertNoConflict()`，rename 与 move 的文件/目录全分支覆盖，断言先于写入 |
| `FUN-15` | 🔵 低 | `activeBucketId` 全局污染 | ✅ 已修复 | 隔离已达成（普通用户切桶只写会话、不污染全局）；原缺口已闭合：`effective()` 改走 `resolveEffectiveBucket()`（`config-store.js`），`get()` 委托 `effective()`，`requireConfig()` 与全部 `/api/fs/*` 操作读端同源；`tests/audit-regressions.test.js` 校验 `listBucketsFor` / `safeView` / `get` / `effective` 四读端同源 |
| `PERF-01` | 🟡 中 | 碎片列举短缓存：命中即免云端调用，分片写操作立即失效 | ✅ 已修复 | `[推断]` 见 `6.3 不再完整立档的遗失项` 反推 |
| `PERF-02` | 🟡 中 | 配置落盘去抖合并：连续变更合并为一次写，关闭去抖后恢复逐次写 | ✅ 已修复 | `tests/audit6-regressions.test.js` |
| `PERF-03` | 🟡 中 | 分片加密 5 份缓冲 | ✅ 已修复 | 窗口化密钥流；14210 组穷举差分零差异。注意同号异义（见 6.2） |
| `PERF-04` | 🟡 中 | 列举上限过大 | ✅ 已修复 | `limits.js` 集中化，`HARD_MAX=50000`、`DELETE=5000`。注意同号异义（见 6.2） |
| `PERF-05` | 🟡 中 | 统计缓存单槽 | ✅ 已修复 | 改为按 `bucketCacheKey` 的 Map + LRU。注意同号异义（见 6.2） |
| `PERF-06` | 🟡 中 | 统计写放大 | ✅ 已修复 | 行为测试：1000 chunk 仅 ≤2 次写统计，字节数仍精确。注意同号异义（见 6.2） |
| `PERF-07` | 🔵 低 | 日志全量同步读写 | ✅ 已修复 | 异步化 + 未超限不碰磁盘 |
| `PERF-08` | 🔵 低 | gzip 无背压 | ✅ 已修复 | 超限即透传 + 无条件 `Vary` |
| `PERF-09` | 🔵 低 | 下载流双消费者 | ✅ 已修复 | 改用显式 `Transform` |
| `PERF-16` | 🔵 低 | 加密 Range 缓冲区上限收敛（峰值 384MB → 96MB） | ✅ 已修复 | `tests/audit3-regressions.test.js` |
| `LOW-21` | 🔵 低 | 凭据视图不再回传 SecretId 尾号（减少密钥标识外泄） | ✅ 已修复 | `tests/audit3-regressions.test.js` |
| `LOW-26` | 🔵 低 | 未捕获异常不能只打印就继续服务 | ✅ 已修复 | `server/index.js` |
| `LOW-28` | 🔵 低 | `/fs/list` 单页上限取自 `limits.js`（旧实现硬编码 1000） | ✅ 已修复 | `tests/audit3-regressions.test.js` |
| `S1` | 🟠 高 | 明文链路防护：HTTPS 强制与 HSTS | ✅ 已修复 | `[推断]` `server/index.js`（含义自代码反推，报告已遗失） |
| `S2` | 🟡 中 | 匿名暴力破解防护：认证失败冻结 | ✅ 已修复 | `server/share-routes.js` |
| `S4` | 🟡 中 | 敏感 JSON 统一加密落盘（兼容历史明文、读取时自动升级）；`enc.key` 落盘后收紧为 0600；复用同一主密钥 | ✅ 已修复 | `secure-store.js`、`enc-store.js`、`ip-guard.js`、`share-store.js`、`upload-sessions.js`、`config-store.js` |
| `S5` | 🔵 低 | 令牌仅经请求头传递（避免出现在历史、Referer 与访问日志） | ✅ 已修复 | `server/routes/fs.js`、`public/js/enc.js` |
| `S6` | 🟡 中 | 基础安全响应头（API 与静态资源全覆盖；`frame-ancestors` 替代 `X-Frame-Options`） | ✅ 已修复 | `server/index.js` |
| `S7` | 🟡 中 | 恒定时间字符串比较（各自取 SHA-256 再比） | ✅ 已修复 | `server/config-store.js` |
| `S8` | 🔵 低 | 同源校验头：非简单请求要求 `X-Requested-With` | ✅ 已修复 | `server/index.js` |
| `S9` | 🔵 低 | 私钥文件权限收紧（`local-cert.js`）／错误信息分类化、不外泄内部字段（`cos.js`）。同号异义 | ✅ 已修复 | `server/local-cert.js`、`server/cos.js` |
| `S10` | 🟡 中 | IPv6 私有/保留地址判定（回环、ULA、链路本地等） | ✅ 已修复 | `server/ip-guard.js` |
| `S11` | 🟡 中 | 会话数上限与强制登出（超出即淘汰最早；支持登出某用户全部设备） | ✅ 已修复 | `auth-session.js`、`routes/auth.js`、`routes/users.js` |
| `S12` | 🟡 中 | 日志详情清洗：防止污染 JSONL 文件 | ✅ 已修复 | `server/stats-store.js` |
| `P1` | 🟡 中 | 落盘异步化：加密密钥、安全存储与统计写入不阻塞事件循环（原子写） | ✅ 已修复 | `enc-store.js`、`secure-store.js`、`stats-store.js` |
| `P2` | 🔵 低 | 含义未确证：仅见于「日志缓冲合并写入」等间接引用，应与日志/统计落盘相关 | ✅ 已修复 | `[未确证]` `server/stats-store.js`（据此推定，无直接证据） |
| `P3` | 🟡 中 | 多桶统计并行（带并发上限）+ 优先官方 `?stats` 接口 | ✅ 已修复 | `server/routes/_shared.js` |
| `P5` | 🟡 中 | 国内 IP 段按起始地址升序 + 二分查找 | ✅ 已修复 | `server/ip-guard.js` |
| `P6` | 🟡 中 | 网络异常时请求不永久挂起（默认 120s） | ✅ 已修复 | `server/cos.js` |
| `P7` | 🔵 低 | 下载类响应超时（无数据活动时 10 分钟） | ✅ 已修复 | `server/download-stream.js` |
| `P8` | 🟡 中 | 密文流背压 + WebDAV PUT 全量缓冲上限收敛（512MB → 128MB） | ✅ 已修复 | `enc-store.js`、`fs-gateway.js` |
| `P10` | 🔵 低 | 静态 JS/CSS 允许 5 分钟强缓存（配合 ETag） | ✅ 已修复 | `server/index.js` |
| `P11` | 🔵 低 | 会话落盘「加密 + 按文件维度串行原子写」 | ✅ 已修复 | `server/upload-sessions.js` |
| `P12` | 🔵 低 | gzip 压缩必须早于路由与静态中间件注册 | ✅ 已修复 | `server/index.js`、`server/gzip.js` |
| `P13` | 🔵 低 | 配置解密缓存带 60 秒 TTL | ✅ 已修复 | `server/config-store.js` |

> **编号缺口**（两条性质不同，不再混为一谈）：
>
> - **S 系列缺第 3 号 —— 刻意避开，可核实**：S3 是对象存储协议名（S3 兼容协议 / AWS S3），全库出现数百处。把它登记成编号会让「S3」这个 token 在文档与代码里彻底歧义；护栏 `docs-sync` 里的噪声集 `AUDIT_ID_NOISE` 正是为此把 S3 排除在编号识别之外。**判据可当场验证**：把 S3 从噪声集移除，「台账登记的编号都能在代码中找到引用」会立刻报红。
> - **P 系列缺第 4、9 号 —— 原因不可考，不声称是设计**：残卷未收录这两号的任何描述，代码中也没有引用痕迹。此处据实标注为「不可考」，而不是含糊地归为「刻意设计」——**无法核实的设计意图与遗失没有区别**，写成前者只会让读者以为有据可查。

## 6.2 同号异义登记（已在 6.5 建立别名层）

同一个编号被用于互不相关的发现。这也是 6.1 要求新引用带轮次/日期限定、不能只靠一张 ID 表解析编号的原因。

| 编号 | 主表登记的发现 | 代码里另作他用的地方 |
| --- | --- | --- |
| `FUN-01` | 上传 `.json` 必然失败（请求体解析顺序） | IP 守卫 HTML 提示页分支恒抛 `ReferenceError` 被吞成 500（`ip-guard.js`）；订单读取失败标志（`payment-orders.js`） |
| `FUN-06` | WebDAV 未校验挂载前缀 | 不再顺手改写全局当前密钥/当前桶（`config-store.js`）；统计文件损坏护栏（`stats-store.js`）；新增桶不再自动设为当前桶（`routes/buckets.js`、`routes/config.js`） |
| `FUN-09` | 跨厂商密钥串访 | `gitignore` 参数缺失导致上传排除失效（`routes/fs.js`）；前端同名引用（`explorer.js`、`upload.js`） |
| `FUN-12` | `/users/me` 原始记录回退 | **7 处**指「无界 Map / 条目只增不减」：`ip-guard.js`、`list-cache.js`、`security.js`、`routes/_shared.js`、`share-routes.js` |
| `FUN-13` | `safeView` 口径不一致 | 写盘失败必须让内存缓存失效（`config-store.js`）；日志轮转被缓冲饿死、`logs.jsonl` 无界增长（`stats-store.js`） |
| `SEC-04` | `.gitignore` 灾难性回溯（该处带日期限定） | `/s/*` 非安全方法同源校验（`share-routes.js`，无日期限定） |
| `S9` | 私钥文件权限收紧 | 存储服务错误信息的分类化提示（`cos.js`） |
| `PERF-03` | 分片加密 5 份缓冲（密钥流窗口化） | 轮询定时器句柄必须保存并可停止（`public/js/main.js`） |
| `PERF-04` | 列举上限过大 | 前端请求序号（`public/js/bucketmgr.js`、`dashboard.js`） |
| `PERF-05` | 统计缓存单槽 | 单次渲染的 DOM 条数上限（`public/js/explorer.js`） |
| `PERF-06` | 统计写放大 | 上传会话去抖窗口内进程被强杀会丢元数据（`upload-sessions.js`、`index.js`） |

> **未穷举**：上表覆盖已机械扫描并人工确认的冲突；若某编号的引用文件跨越了互不相关的模块，值得按同样方法复核。

## 6.3 系列清单与不再完整立档的遗失项

**系列清单**：

| 系列 | 形态 | 来源 | 备注 |
| --- | --- | --- | --- |
| `SEC-nn` | 带连字符 | 自审 + 社区 | 安全类 |
| `FUN-nn`（含 `FUN-04b`） | 带连字符 | 自审 | 功能/正确性类 |
| `PERF-nn` | 带连字符 | 自审 + 社区 | 性能类 |
| `LOW-nn` | 带连字符 | 某一轮审计 | 低危类；残卷未收录 |
| `P-nn` | 裸编号 | 另一轮审计 | 性能系列 `P1`–`P13`，**与 `PERF-nn` 是两套独立编号**：`P3` 指多桶统计并行，`PERF-03` 指分片加密缓冲 |
| `S-nn` | 裸编号 | 另一轮审计 | 安全加固系列 `S1`–`S12`，**与 `SEC-nn` 是两套独立编号**：`S4` 指敏感数据加密落盘，`SEC-04` 指 `.gitignore` 灾难性回溯；S3 是协议名非编号 |

**原始台账已遗失**：早期审计报告不再可得，`AUDIT_FINDINGS.md` 本由一份留存残卷（`fix-record.md`）重建并逐条与代码核对，其中 §4（`PERF-01/02/16`、`LOW-21/26/28` 与裸编号 `S*`/`P*` 系列）残卷未收录、仅靠代码注释与回归护栏反推——**只保留结论，严重度与时间均为推断**。其含义已并入 6.1，此处不再单列「严重度半可信」的独立表。

## 6.4 历轮审计汇总（第 7–13 轮）

> 每轮都以「**对抗式验收上一轮修复 + 扫描新缺陷**」为主轴。这批报告（`ANALYSIS-ROUND7~13.md`）已删除，本表只保留每轮的**范围/基线/发现数/核心结论/闭合**，细节不再立档。第 1–6 轮的独立护栏已并入 `audit-regressions` / `audit3` / `audit5` / `audit6`。

| 轮 | 定位 | 发现数 | 本轮最重要结论 |
| --- | --- | --- | --- |
| R7 | 首次对抗式扫描 | 15（R7-01~15）+ 4 文档漂移 D1~D4 | 分片会话漏记 provider、加密元数据先于云端写入被覆盖（二者都致密文不可解） |
| R8 | 深挖 + 验收 | 27 | 27 条中 10 条是「修一半」；微信签名参数错位、magic 大文件同步阻塞 3s、覆盖写残留元数据 |
| R9 | 验收到第 8 轮 | 10 | 7 条是「修复不完整」的产物；WebDAV 目录 COPY 自嵌套无界递归、S3 `<Error>` 被丢弃 |
| R10 | 验收到第 9 轮 | 11 + 1 | 4 条高危中 2 条是上一轮修复引入的；异步落盘被未声明变量打死、目录 MOVE 少一个尾斜杠 |
| R11 | 验收到第 10 轮 | 19 | 「整批 0 成功即停」的 `break` 只跳内层循环（一次失败放大成上千次云端往返） |
| R12 | 验收到第 11 轮 | 13 + 自审 4 | 首起真实数据事故：`npm test` 改写生产 `config.enc`；首次落地「纪律落到唯一实现点」 |
| R13 | 验收到第 12 轮 | 7 | 否掉 R12「可停止开新轮次」：测试仍写生产数据、「唯一实现点」护栏可被箭头函数绕过 |
| R14 | 验收到第 13 轮 | 24（高 3 / 中 11 / 低 10） | 护栏与**生产调用方脱节**：流式判据写成 `typeof === 'function'` 而生产四处传 `PassThrough`（测试与实现对齐、与需求脱节）；CSP 脚本源漏 `challenges.cloudflare.com` → 启用验证码即锁死全站登录；支付窗口内的 `pending` 被裁 → 钱付了拿不到文件。**截至 v1.1.7 已修 12（高 3 / 中 9）、余 12（中 2 / 低 10）**：P2 四条性能项按「一次收敛」抽成 `server/coalesce.js` 的去抖合并写 / 并发合并读两个原语，不再四处内联；同时补齐 R14-04 / R14-06 缺失的反向对照，并把「anchor 必须**唯一**命中」「纯注释 anchor 判违规」两条升为机器护栏（详见 `ANALYSIS-ROUND14.md` 第 4 节） |

## 6.5 同号异义的收敛方案：限定别名层

**结论：给每个用途补一个作用域限定的别名，但不动原编号。** 先把「为什么不干脆重编号」讲清楚，否则这看起来像偷懒：

| 可选方案 | 代价 | 采用与否 |
| --- | --- | --- |
| 全局重编号（新名 + 映射表，改全部引用） | 一次性改写全部代码注释与测试引用 | **不采用**：`docs-sync` 的双向闭合断言（引用 ⊆ 登记、登记 ⊆ 引用）**不允许分批推进**——新旧编号并存一天，「旧编号已无引用」与「新编号未登记」就同时报红。护栏事实上强制这次改动必须是**原子的一次全库手术** |
| 仅靠「引用时带轮次 / 日期」的行文约定 | 零成本 | **不充分**：靠人记的纪律都会漏（本项目已反复验证过这一点），且无法被护栏检查 |
| 别名层（本方案） | 加一张表，代码零改动 | **采用**：立即恢复检索价值；别名可被 grep；将来真要重命名时，这张表就是现成的映射表 |

代码侧实测（`server` + `public`）有 **311 处**审计编号引用，加 `tests` 与文档更多。而本项目连续 7 轮的元规律是「同一状态多个入口 / 同一逻辑多份实现处，必有改一半的漏网之鱼」——**在这种记录下做一次 300+ 处的全库重命名，风险显著高于收益**。

**命名规则**：`编号@作用域`，作用域取自该发现所在的模块或主题，全小写、连字符分词。

| 编号 | 限定别名 | 指代的发现 | 主要落点 |
| --- | --- | --- | --- |
| `FUN-01` | `FUN-01@upload-json` | 上传 `.json` 必然失败（请求体解析顺序） | `server/routes/fs.js` |
| `FUN-01` | `FUN-01@ip-guard-html` | IP 守卫 HTML 提示页分支恒抛 `ReferenceError` 被吞成 500 | `server/ip-guard.js` |
| `FUN-01` | `FUN-01@order-read-flag` | 订单读取失败标志 | `server/payment-orders.js` |
| `FUN-06` | `FUN-06@webdav-mount-prefix` | WebDAV 未校验挂载前缀 | WebDAV 路由 |
| `FUN-06` | `FUN-06@no-implicit-global-switch` | 不再顺手改写全局当前密钥 / 当前桶 | `server/config-store.js` |
| `FUN-06` | `FUN-06@stats-corrupt-guard` | 统计文件损坏护栏 | `server/stats-store.js` |
| `FUN-06` | `FUN-06@no-auto-current-bucket` | 新增桶不再自动设为当前桶 | `server/routes/buckets.js`、`config.js` |
| `FUN-09` | `FUN-09@cross-vendor-credential` | 跨厂商密钥串访 | 凭据解析 |
| `FUN-09` | `FUN-09@gitignore-param` | `gitignore` 参数缺失导致上传排除失效 | `server/routes/fs.js`、`public/js/explorer.js`、`upload.js` |
| `FUN-12` | `FUN-12@users-me` | `/users/me` 原始记录回退 | `server/routes/users.js` |
| `FUN-12` | `FUN-12@unbounded-map` | 无界 Map / 条目只增不减（**7 处**同一个编号） | `ip-guard.js`、`list-cache.js`、`security.js`、`routes/_shared.js`、`share-routes.js` |
| `FUN-13` | `FUN-13@safe-view` | `safeView` 口径不一致 | 桶视图 |
| `FUN-13` | `FUN-13@cache-invalidate-on-write-fail` | 写盘失败必须让内存缓存失效 | `server/config-store.js` |
| `FUN-13` | `FUN-13@log-rotation-starvation` | 日志轮转被缓冲饿死、`logs.jsonl` 无界增长 | `server/stats-store.js` |
| `SEC-04` | `SEC-04@gitignore-redos` | `.gitignore` 灾难性回溯（**带日期限定**） | `server/gitignore.js` |
| `SEC-04` | `SEC-04@share-same-origin` | `/s/*` 非安全方法同源校验（**无日期限定**） | `server/share-routes.js` |
| `S9` | `S9@cert-key-mode` | 私钥文件权限收紧 | `server/local-cert.js` |
| `S9` | `S9@error-classification` | 存储服务错误信息的分类化提示 | `server/cos.js` |
| `PERF-03` | `PERF-03@chunk-key-stream` | 分片加密缓冲（密钥流窗口化） | 加密入口 |
| `PERF-03` | `PERF-03@poll-timer-handle` | 轮询定时器句柄必须保存并可停止 | `public/js/main.js` |
| `PERF-04` | `PERF-04@list-limit` | 列举上限过大 | `server/limits.js` |
| `PERF-04` | `PERF-04@request-seq` | 前端请求序号（旧响应不得覆盖新结果） | `public/js/bucketmgr.js`、`dashboard.js` |
| `PERF-05` | `PERF-05@stats-cache-slot` | 统计缓存单槽 | 统计缓存 |
| `PERF-05` | `PERF-05@render-dom-cap` | 单次渲染的 DOM 条数上限 | `public/js/explorer.js` |
| `PERF-06` | `PERF-06@stats-write-amp` | 统计写放大 | 统计写入 |
| `PERF-06` | `PERF-06@upload-session-debounce-loss` | 上传会话去抖窗口内进程被强杀会丢元数据 | `server/upload-sessions.js`、`server/index.js` |

> 别名是**文档层的检索辅助**：不写进代码注释、不进护栏识别（`docs-sync` 仍按原编号做双向闭合）。新增引用时请给出「原编号 + 本节别名 + 轮次 / 日期」中的至少两项。

> **贯穿全程的元规律**：凡「同一状态多个读写入口」「同一逻辑多份实现」处，必有改一半的漏网之鱼；「修一处漏一处」连续 7 轮，直到第 11 轮书面确立「收敛闸门」与「唯一实现点」纪律、第 13 轮把静态护栏的地基（引号/正则感知的注释剥离）与四条反向对照纪律补齐，才真正闭环。**结论：100+ 项缺陷全部出现在用例全绿的前提下——测试绿不代表没有缺陷，只代表测试没盖到这些路径。**

