/**
 * 服务商注册表 —— 统一描述各对象存储厂商的连接参数与能力差异
 *
 *  - kind: 'cos'  → 使用 cos-nodejs-sdk-v5（腾讯云 COS 原生协议）
 *          's3'   → 使用 AWS Signature V4 + S3 兼容 REST 协议
 *  - endpoint: S3 兼容厂商的默认服务端点（可被密钥记录中的自定义 endpoint 覆盖）
 *  - regionRequired: 是否必须填写地域
 *  - regionPlaceholder / regionHint: 管理界面提示文案
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
    id: 'azure',
    name: 'Microsoft Azure',
    shortName: 'Blob',
    kind: 'planned',
    endpoint: '',
    regionRequired: false,
    regionPlaceholder: '',
    regionHint: 'Azure Blob 采用独立的鉴权协议，当前版本尚未开放',
    credentialLabel: { id: '账户名称', key: '账户密钥', idPlaceholder: '请输入存储账户名称' },
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

/** 按地域推导服务端点：厂商提供模板时按模板填充，否则用默认端点 */
function endpointFor(id, region) {
  const p = resolve(id);
  if (p.endpointTemplate && region) {
    return p.endpointTemplate.replace('{region}', String(region).trim());
  }
  return p.endpoint || '';
}

module.exports = {
  PROVIDERS, DEFAULT_PROVIDER_ID,
  list, get, resolve, isSupported, nameOf, isCos, isS3, endpointFor,
};
