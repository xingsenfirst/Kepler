/**
 * ESLint 包装器 —— 在未安装 ESLint 时给出清晰指引而非晦涩报错
 *
 * 背景：本项目的运行时依赖刻意维持在 3 个（express / cos-nodejs-sdk-v5 / selfsigned），
 * ESLint 属可选开发工具。直接 `eslint ...` 在未安装时只会输出 "command not found"，
 * 对使用者不友好；这里做一次探测并给出可操作的提示。
 *
 * 用法：npm run lint
 */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');

function hasEslint() {
  // 1) 本地 node_modules
  try {
    require.resolve('eslint/package.json', { paths: [ROOT] });
    return true;
  } catch (e) { /* 继续探测 */ }
  // 2) npx / 全局
  const probe = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['--no-install', 'eslint', '--version'], { encoding: 'utf8', shell: process.platform === 'win32' });
  return probe.status === 0;
}

if (!hasEslint()) {
  console.log('');
  console.log('  ESLint 未安装（属可选的开发工具，不影响项目运行与测试）。');
  console.log('');
  console.log('  如需启用代码检查，请执行其一：');
  console.log('    npm install -D eslint @eslint/js    # 安装到本项目');
  console.log('    npm run lint                        # 然后重试');
  console.log('');
  console.log('  提示：`npm test` 无需任何额外依赖，可直接运行。');
  console.log('');
  process.exit(0);
}

const args = ['eslint', 'server/', 'public/js/', 'tests/'];
const r = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['--no-install'].concat(args),
  { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
process.exit(r.status === null ? 1 : r.status);

void fs;
