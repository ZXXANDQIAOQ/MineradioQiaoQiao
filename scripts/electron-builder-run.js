#!/usr/bin/env node
/*
 * electron-builder 启动器：把 Electron 发行包与打包工具集的下载源固定到国内镜像。
 *
 * 为什么需要它：
 *   electron-builder 默认从 GitHub Releases 拉两样东西 ——
 *     · Electron 运行时压缩包（约 140 MB）
 *     · winCodeSign / nsis 等打包工具集
 *   国内直连 GitHub 经常在 "packaging" 这一步一动不动，看起来像卡死，
 *   实际是在等 GitHub 超时。镜像换源后同一步只要一两分钟。
 *
 * 用法与原生 electron-builder 完全一致，参数原样透传：
 *   node scripts/electron-builder-run.js --win dir
 *   node scripts/electron-builder-run.js --win nsis --publish never
 *
 * 已经存在的同名环境变量不会被覆盖，想换别的源自己 export 就行。
 */

const path = require('path');
const { spawnSync } = require('child_process');

const MIRRORS = {
  ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR: 'https://npmmirror.com/mirrors/electron-builder-binaries/'
};

const args = process.argv.slice(2);
const env = Object.assign({}, process.env);
const applied = [];

Object.keys(MIRRORS).forEach(function (key) {
  if (!env[key]) {
    env[key] = MIRRORS[key];
    applied.push(key);
  }
});

console.log('[build] electron-builder ' + args.join(' '));
if (applied.length) console.log('[build] 下载源已指向镜像：' + applied.join(', '));

let cli;
try {
  cli = require.resolve('electron-builder/out/cli/cli.js');
} catch (error) {
  console.error('[build] 找不到 electron-builder，先在工程目录执行 npm install。');
  process.exit(1);
}

const result = spawnSync(process.execPath, [cli].concat(args), {
  stdio: 'inherit',
  cwd: path.join(__dirname, '..'),
  env: env
});

if (result.error) {
  console.error('[build] 启动 electron-builder 失败：' + result.error.message);
  process.exit(1);
}

process.exit(result.status === null ? 1 : result.status);
