/**
 * 服务商注册表 —— 统一描述各对象存储厂商的连接参数与能力差异
 *
 *  - kind: 'cos'  → 使用 cos-nodejs-sdk-v5（腾讯云 COS 原生协议）
 *          's3'   → 使用 AWS Signature V4 + S3 兼容 REST 协议
 *  - endpoint: S3 兼容厂商的默认服务端点（可被密钥记录中的自定义 endpoint 覆盖）
 *  - regionRequired: 是否必须填写地域
 *  - defaultRegion: 厂商要求「填了等价于没填」的固定地域值（如 R2 / GCS 的 auto）。
 *      仅作**界面提示**，不参与任何判定 —— 真正的地域解析在 {@link regionFor}。
 *  - forcePathStyle: 是否强制路径风格（`https://host/bucket/key`）。
 *      自建对象存储（MinIO 等）多以 IP / 无 DNS 泛解析的域名暴露，
 *      默认的虚拟主机风格会拼出 `bucket.<host>` 而无法解析 —— 必须走路径风格。
 *  - endpointMode: 服务端点这一栏在密钥表单里的**输入形态**，同时也是
 *      {@link composeEndpoint} 的分支依据：
 *        'derived' —— 由地域自动推导，无需用户填写（无此字段时不渲染该栏）；
 *        'required' —— 用户必须直接填写完整端点（自建部署，如 MinIO）；
 *        'template' —— 用户填写的是**端点前缀**，与本厂商的 endpointTemplate
 *                      一起拼成完整端点（如 Cloudflare R2 的账户 ID）。
 *  - endpointLabel / endpointPlaceholder / endpointHint: 端点输入栏的文案
 *  - credentialLabel: 密钥字段在各厂商控制台中的习惯叫法
 *
 * 未在此登记或 kind 为 'planned' 的厂商，仅用于界面展示与文案统一，
 * 服务端会在建立连接时给出明确的不支持提示。
 */

const PROVIDERS = [
  {
    id: 'tencent',
    name: '腾讯云',
    shortName: 'COS',
    kind: 'cos',
    endpoint: '',
    regionRequired: true,
    regionPlaceholder: '例如 ap-guangzhou',
    regionHint: '腾讯云对象存储所在地域，如 ap-guangzhou（广州）、ap-shanghai（上海）',
    credentialLabel: { id: 'SecretId', key: 'SecretKey', idPlaceholder: 'AKIDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' },
  },
  {
    id: 'aliyun',
    name: '阿里云',
    shortName: 'OSS',
    kind: 's3',
    endpoint: 'https://oss-cn-hangzhou.aliyuncs.com',
    endpointTemplate: 'https://oss-{region}.aliyuncs.com',
    regionRequired: true,
    regionPlaceholder: '例如 cn-hangzhou',
    regionHint: '阿里云对象存储所在地域，如 cn-hangzhou（杭州）、cn-beijing（北京）',
    credentialLabel: { id: 'AccessKey ID', key: 'AccessKey Secret', idPlaceholder: 'LTAIxxxxxxxxxxxxxxxx' },
  },
  {
    id: 'huawei',
    name: '华为云',
    shortName: 'OBS',
    kind: 's3',
    endpoint: 'https://obs.cn-north-4.myhuaweicloud.com',
    endpointTemplate: 'https://obs.{region}.myhuaweicloud.com',
    regionRequired: true,
    regionPlaceholder: '例如 cn-north-4',
    regionHint: '华为云对象存储所在地域，如 cn-north-4（北京四）、cn-east-3（华东三）',
    credentialLabel: { id: 'Access Key ID', key: 'Secret Access Key', idPlaceholder: '请输入 Access Key ID' },
  },
  {
    id: 'qiniu',
    name: '七牛云',
    shortName: 'Kodo',
    kind: 's3',
    endpoint: 'https://s3.cn-east-1.qiniucs.com',
    endpointTemplate: 'https://s3.{region}.qiniucs.com',
    regionRequired: true,
    regionPlaceholder: '例如 cn-east-1',
    regionHint: '七牛云 Kodo 的 S3 兼容地域，如 cn-east-1（华东-浙江）、cn-north-1（华北-河北）、cn-south-1（华南-广东）',
    credentialLabel: { id: 'AccessKey', key: 'SecretKey', idPlaceholder: '请输入 AccessKey' },
  },
  {
    id: 'upyun',
    name: '又拍云',
    shortName: 'USS',
    kind: 's3',
    endpoint: 'https://s3.api.upyun.com',
    regionRequired: false,
    regionPlaceholder: '例如 us-east-1（可留空）',
    regionHint: '又拍云 S3 兼容接口统一使用 us-east-1，通常无需修改',
    credentialLabel: { id: '操作员', key: '操作员密码', idPlaceholder: '请输入操作员名称' },
  },
  {
    /**
     * R30：**Microsoft Azure Blob Storage**（正式支持）。
     *
     * 与其它厂商的三处结构性差异，都体现在本条目里：
     *  ① `kind: 'azure'` —— 用独立鉴权协议（Shared Key）与独立 REST 接口，
     *     客户端由 `cos.js` 分派到 `azure-client.js`；
     *  ② 端点由**存储账户名**决定（`https://<账户名>.blob.core.windows.net`），
     *     与 R2 的「账户 ID 进主机名」同型，但账户名同时是**鉴权身份**（即 `secretId`），
     *     因此不再让用户重复填一遍端点 —— 组装见 {@link endpointForAccount}；
     *  ③ 没有「地域」概念（端点里不含地域），故 `regionRequired: false` +
     *     `defaultRegion: 'auto'`：与 GCS / R2 同样是「填了等价于没填」，
     *     界面上可留空、服务端补 auto，避免空串流到需要地域的地方。
     *
     * `endpointMode: 'optional'`：常规情况端点由账户名推导，**但**主权云
     * （Azure 中国 `blob.core.chinacloudapi.cn`、US Gov）与本地模拟器（Azurite）
     * 的域名不同，必须允许用户显式覆盖 —— 该栏可选填，填了就走端点守卫校验。
     */
    id: 'azure',
    name: 'Microsoft Azure',
    shortName: 'Blob',
    kind: 'azure',
    endpoint: '',
    accountEndpointTemplate: 'https://{account}.blob.core.windows.net',
    accountPattern: '^[a-z0-9]{3,24}$',
    defaultRegion: 'auto',
    regionRequired: false,
    regionPlaceholder: '固定 auto（可留空）',
    regionHint: 'Azure Blob 不按地域寻址（端点由存储账户名决定），固定使用 auto，通常无需修改',
    endpointMode: 'optional',
    endpointLabel: '服务端点（可选）',
    endpointPlaceholder: '留空即用 https://<存储账户名>.blob.core.windows.net',
    endpointHint: '仅在使用主权云（如 Azure 中国）或本地模拟器（Azurite）时才需要填写；'
      + '常规情况留空即可，系统会按存储账户名推导端点。',
    credentialLabel: {
      id: '存储账户名称',
      key: '存储账户密钥',
      idPlaceholder: '例如 myaccount（仅小写字母与数字，3–24 位）',
    },
  },
  {
    id: 'aws',
    name: 'AWS S3',
    shortName: 'S3',
    kind: 's3',
    endpoint: 'https://s3.amazonaws.com',
    endpointTemplate: 'https://s3.{region}.amazonaws.com',
    regionRequired: true,
    regionPlaceholder: '例如 us-east-1',
    regionHint: 'AWS 区域代码，如 us-east-1、ap-southeast-1',
    credentialLabel: { id: 'Access Key ID', key: 'Secret Access Key', idPlaceholder: 'AKIAxxxxxxxxxxxxxxxx' },
  },
  {
    id: 'gcs',
    name: 'Google Cloud',
    shortName: 'GCS',
    kind: 's3',
    // 地域固定为 auto（Google 的 S3 互操作层要求一个地域值，但它不参与寻址），
    // 因此端点不需要地域模板。
    endpoint: 'https://storage.googleapis.com',
    defaultRegion: 'auto',
    regionRequired: false,
    regionPlaceholder: '例如 auto（可留空）',
    regionHint: 'Google Cloud Storage 的 S3 互操作接口固定使用 auto，通常无需修改',
    credentialLabel: {
      id: 'Access Key ID（HMAC）',
      key: 'Secret（HMAC）',
      idPlaceholder: 'GOOGxxxxxxxxxxxxxxxx',
    },
    // 使用 S3 互操作层需要先创建 **HMAC 密钥**（Cloud Storage → 设置 → 互操作性），
    // 与常规的「服务账号 JSON」不是一回事；且 Cloud Storage 的桶名**全球唯一**。
  },
  {
    id: 'r2',
    name: 'Cloudflare',
    shortName: 'R2',
    kind: 's3',
    // R2 的端点形如 https://<账户 ID>.r2.cloudflarestorage.com —— 唯一带**变量前缀**
    // 的一家。这里把已确定的域名部分写进 endpointTemplate，占位符保留在主机名最前，
    // 由 composeEndpoint() 把用户填写的账户 ID 拼进去（见该函数说明）。
    endpointTemplate: '{region}.r2.cloudflarestorage.com',
    defaultRegion: 'auto',
    regionRequired: false,
    regionPlaceholder: '例如 auto（可留空）',
    regionHint: 'Cloudflare R2 不区分地域，固定使用 auto，通常无需修改',
    endpointMode: 'template',
    endpointLabel: '账户 ID（Account ID）',
    endpointPlaceholder: '例如 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d',
    endpointHint: '在 Cloudflare 控制台右侧栏可看到账户 ID；系统会据此拼出 https://<账户 ID>.r2.cloudflarestorage.com',
    credentialLabel: {
      id: 'Access Key ID',
      key: 'Secret Access Key',
      idPlaceholder: '请输入 R2 的 Access Key ID',
    },
  },
  {
    id: 'minio',
    name: 'MinIO',
    shortName: 'MinIO',
    kind: 's3',
    // 自建部署没有可推导的默认端点，必须由用户填写。
    endpoint: '',
    regionRequired: false,
    defaultRegion: 'us-east-1',
    regionPlaceholder: '例如 us-east-1（默认）',
    regionHint: 'MinIO 默认地域为 us-east-1；若服务端未另行配置，保持默认即可',
    forcePathStyle: true,
    endpointMode: 'required',
    endpointLabel: '服务端点',
    endpointPlaceholder: '例如 https://minio.example.com:9000',
    endpointHint: 'MinIO 为自建部署，请填写其访问地址（含端口）；'
      + '内网 / 回环地址与明文 http 默认被安全策略拦截，确需使用请在服务端设置 ALLOW_PRIVATE_ENDPOINT=1 / ALLOW_LOOPBACK_ENDPOINT=1',
    credentialLabel: {
      id: 'Access Key',
      key: 'Secret Key',
      idPlaceholder: '请输入 Access Key（默认 minioadmin）',
    },
  },
  {
    id: 'b2',
    name: 'Backblaze',
    shortName: 'B2',
    kind: 's3',
    endpoint: 'https://s3.us-west-004.backblazeb2.com',
    endpointTemplate: 'https://s3.{region}.backblazeb2.com',
    regionRequired: true,
    regionPlaceholder: '例如 us-west-004',
    regionHint: 'Backblaze B2 的 S3 端点地域段，如 us-west-004（在桶详情页的 Endpoint 中可见）',
    credentialLabel: {
      id: 'keyID',
      key: 'applicationKey',
      idPlaceholder: '请输入 application key ID',
    },
  },
];

const byId = new Map(PROVIDERS.map((p) => [p.id, p]));

/** 兼容早期版本：未记录 provider 的密钥一律视为腾讯云 */
const DEFAULT_PROVIDER_ID = 'tencent';

/** 返回全部厂商元数据（浅拷贝，避免调用方误改常量） */
function list() {
  return PROVIDERS.map((p) => Object.assign({}, p));
}

/** 按 id 查厂商；未知 id 返回 null */
function get(id) {
  return byId.get(String(id || '')) || null;
}

/** 解析厂商 id，未知或缺失时回退到默认厂商 */
function resolve(id) {
  return byId.get(String(id || '')) || byId.get(DEFAULT_PROVIDER_ID);
}

/** 该厂商当前是否已实现连接能力 */
function isSupported(id) {
  const p = get(id);
  return !!p && p.kind !== 'planned';
}

/** 厂商显示名（用于错误提示与界面文案） */
function nameOf(id) {
  return resolve(id).name;
}

/** 该厂商是否为腾讯云 COS 原生协议（大量参数差异以此为分支） */
function isCos(id) {
  return resolve(id).kind === 'cos';
}

/** 该厂商是否为 S3 兼容协议 */
function isS3(id) {
  return resolve(id).kind === 's3';
}

/** 该厂商是否为 Azure Blob（独立鉴权协议 + Block Blob 语义） */
function isAzure(id) {
  return resolve(id).kind === 'azure';
}

/**
 * R30：该厂商的端点是否由**账户名**推导（Azure）。
 *
 * 与 S3 那套「地域进主机名中段」的推导是两件不同的事：这里的账户名既进主机名
 * 又是鉴权身份（`secretId`），因此不能复用 `endpointFor()`（它只吃 region）。
 */
function accountEndpointTemplate(id) {
  return resolve(id).accountEndpointTemplate || '';
}

/** 账户名是否合法（规则由厂商元数据给出；未登记规则的厂商恒为 false） */
function isValidAccount(id, account) {
  const pattern = resolve(id).accountPattern;
  if (!pattern) return false;
  try {
    return new RegExp(pattern).test(String(account == null ? '' : account).trim().toLowerCase());
  } catch (e) {
    return false;
  }
}

/**
 * 由账户名推导端点（唯一实现点）。
 *
 * 为什么必须在这里校验账户名：它会**直接拼进主机名**，是不折不扣的不可信输入。
 * 放行 `evil.com/x` 这类值就等于把出站请求引向任意主机（盲 SSRF）。因此字符集
 * 收敛到厂商登记的 `accountPattern`（Azure 为 `^[a-z0-9]{3,24}$`），拼出来的端点
 * 天然只可能是 `https://<合法账户名>.blob.core.windows.net`。
 *
 * @param {string} id 厂商 id
 * @param {string} account 账户名（未登记的厂商返回空串）
 * @returns {string} 形如 https://myaccount.blob.core.windows.net；不适用时为空串
 * @throws {Error} status=400 账户名缺失或非法
 */
function endpointForAccount(id, account) {
  const tpl = accountEndpointTemplate(id);
  if (!tpl) return '';
  const raw = String(account == null ? '' : account).trim();
  if (!raw) {
    const err = new Error('缺少存储账户名称，无法确定服务端点');
    err.status = 400;
    throw err;
  }
  if (!isValidAccount(id, raw)) {
    const err = new Error(`存储账户名称格式不正确（应为 3–24 位小写字母或数字）：${raw}`);
    err.status = 400;
    throw err;
  }
  return tpl.replace('{account}', raw.toLowerCase());
}

/**
 * 该厂商是否强制**路径风格**寻址（`https://host/bucket/key`）。
 *
 * 默认的虚拟主机风格会拼出 `bucket.<host>`；自建对象存储（MinIO 等）常以 IP
 * 或未配置 DNS 泛解析的域名暴露，`bucket.<host>` 根本无法解析 —— 表现为
 * 「配置看起来全对，但每个请求都失败」。因此这条必须由厂商元数据驱动，
 * 而不是让用户去猜一个寻址开关。
 */
function forcePathStyle(id) {
  return resolve(id).forcePathStyle === true;
}

/**
 * 该厂商是否要求用户提供「服务端点」这一栏。
 *
 * 两种形态都算「要用户填」：`'required'`（MinIO，填完整访问地址）与
 * `'template'`（R2，填账户 ID）。之所以合并成一个判据，是因为对**调用方**而言
 * 两者是同一件事 —— 「这条密钥没有用户提供的端点就不完整」，而具体填什么由
 * `endpointLabel` / `endpointPlaceholder` 描述。若只认 `'required'`，
 * R2 的记录会被判为「端点可选」，从而允许一条**永远连不上**的密钥落库。
 *
 * R30 新增的 `'optional'`（Azure）**不算**「要用户填」：它的端点默认由账户名推导
 * （见 {@link endpointForAccount}），端点栏只是为「主权云 / 本地模拟器」留的覆盖口。
 * 因此这里刻意**不**把它计入 —— 计入会让一条完全正确的 Azure 密钥被判为不完整。
 */
function endpointRequired(id) {
  const m = resolve(id).endpointMode;
  return m === 'required' || m === 'template';
}

/**
 * 解析一次连接应当使用的**地域**。
 *
 * 优先级：用户填写 → 厂商默认值（`defaultRegion`）→ 空串。
 * 「厂商默认值」解决的是 R2 / GCS 这类**要求填地域但填什么都一样**的厂商：
 * 界面允许留空，这里补上 auto / us-east-1，避免把空串当作地域送给签名。
 *
 * ⚠️ 返回值**必须**经过 {@link safeRegion} —— 它会**抛错**（因此本函数也会抛）。
 * 原因：地域会被直接拼进端点模板，入参来自用户/历史配置，属于**不可信输入**。
 * 在唯一的读取点校验，胜过在每个调用点各判一次。
 */
function regionFor(id, region) {
  const p = resolve(id);
  const raw = String(region || '').trim() || String(p.defaultRegion || '').trim();
  return raw ? safeRegion(raw) : '';
}

/**
 * 按地域推导服务端点：厂商提供模板时按模板填充，否则用默认端点
 *
 * ⚠️ 只适用于「占位符在主机名**中段**」的厂商（阿里云 / 华为云 / 七牛 / AWS / B2）：
 * `s3.{region}.amazonaws.com` 这类模板里，地域恰好在它该在的位置上。
 * R2 的占位符在主机名**最前**（`{region}.r2.cloudflarestorage.com`），且那里要填的是
 * **账户 ID 而不是地域** —— 绝不能让它落到这条推导路径上：`regionFor('r2', '')` 会给
 * 出 `auto`，于是端点被拼成 `auto.r2.cloudflarestorage.com`。这是个**语法合法**的域名，
 * 不会报错，只会让每一次请求都解析失败（用户看到的是一句「网络连接异常」）。
 * 因此这里对 `endpointMode: 'template'` 的厂商直接返回空串 —— 交由调用方报
 * 「缺少服务端点」，把问题停在配置阶段。R2 的组装见 {@link composeEndpoint}。
 */
function endpointFor(id, region) {
  const p = resolve(id);
  if (p.endpointMode === 'template') return '';
  if (p.endpointTemplate && region) {
    return p.endpointTemplate.replace('{region}', safeRegion(region));
  }
  return p.endpoint || '';
}

/**
 * 把用户在「服务端点」栏里填写的内容，按厂商的 `endpointMode` 组装成完整端点。
 *
 * 这是**唯一实现点**：写入端（`config-store.addCredential/updateCredential`）
 * 与预览端（`routes/config.js` 的连接验证）都必须经过它，否则会出现
 * 「保存时看着正常、真正连接时端点缺失 / 拼错」这类只在某一条路径上暴露的分叉。
 *
 * 三种形态：
 *  - `'template'`（Cloudflare R2）：用户填的是账户 ID。这里用**非贪婪**的
 *    `{region}` 替换，把模板 `{region}.r2.cloudflarestorage.com` 拼成
 *    `https://<账户 ID>.r2.cloudflarestorage.com`。
 *      为什么不能复用 `endpointFor()`：那是**贪婪**替换（`s3.{region}.amazonaws.com`
 *      必须如此，否则会把地域后的这一段也吃掉），而 R2 的模板必须以 `.` 收尾才能
 *      正确地在最前的占位符处停下 —— 两种替换规则相反，不能共用。
 *      本分支**必须幂等**：表单回填的是库里**已组装好的完整端点**，用户不动它直接
 *      保存时若再拼一次，就会得到
 *      `https://<id>.r2.cloudflarestorage.com.r2.cloudflarestorage.com` ——
 *      而这是一个**语法完全合法**的域名，不会报错，只会在连接时静默失败。
 *  - `'required'`（MinIO）：用户填的就是完整端点，原样透传（仍是**未校验**的，
 *    由调用方紧接着送 `assertSafeEndpoint()`）。
 *  - 其余厂商（含未声明 `endpointMode` 的历史厂商）：透传。**关键**：用户在
 *    自定义端点栏里填了什么就是什么，绝不做拼接 —— 这条路径必须与历史行为逐字
 *    一致，否则存量配置会被改写。
 *
 * @param {string} id    厂商 id
 * @param {string} input 用户输入（空串表示未填写）
 * @returns {string} 可直接交由 `assertSafeEndpoint()` 校验的端点；未填写时为空串
 */
function composeEndpoint(id, input) {
  const raw = String(input === undefined || input === null ? '' : input).trim();
  if (!raw) return '';
  const p = resolve(id);
  if (p.endpointMode === 'template' && p.endpointTemplate) {
    // 幂等保护（见上）：带协议的、或已含本模板固定域名后缀的，一律视为已组装完毕
    if (/^https?:\/\//i.test(raw)) return raw;
    const suffix = p.endpointTemplate.replace('{region}', '');
    if (suffix && raw.toLowerCase().endsWith(suffix.toLowerCase())) return 'https://' + raw;
    return 'https://' + p.endpointTemplate.replace('{region}', raw);
  }
  return raw;
}

/**
 * R21-12：`region` 会被**直接拼进端点模板**（`s3.{region}.amazonaws.com`），
 * 因此它的字符集必须是「不可能改变主机或路径」的那种。
 *
 * 旧实现只做 `String(region).trim()`。而厂商默认端点这条路**不过**
 * `assertSafeEndpoint` —— `cos.js` 里只有用户自定义的 `cfg.endpoint` 走校验
 * （且 `assertSafeEndpoint('')` 是 no-op）。于是 `region` 里带 `/`、`?`、`#`
 * 就能改写模板端点的主机 / 路径，把出站请求引向别处。收敛字符集比事后解析更可靠：
 * 合法地域名只含字母、数字、`.`、`-`、`_`。
 */
const REGION_SAFE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function safeRegion(region) {
  const r = String(region).trim();
  if (!REGION_SAFE_RE.test(r)) {
    const err = new Error('存储地域（region）含有非法字符，请检查配置');
    err.status = 400;
    throw err;
  }
  return r;
}

module.exports = {
  PROVIDERS, DEFAULT_PROVIDER_ID,
  list, get, resolve, isSupported, nameOf, isCos, isS3, isAzure, endpointFor,
  forcePathStyle, endpointRequired, regionFor, composeEndpoint,
  // R30：由账户名推导端点（Azure）—— 唯一实现点，含账户名字符集校验
  accountEndpointTemplate, isValidAccount, endpointForAccount,
};
