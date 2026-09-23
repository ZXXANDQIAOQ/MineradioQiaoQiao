#!/usr/bin/env node
'use strict';

/*
 * LX 在线搜索 · 真实接口冒烟（需要联网）
 *
 *   node scripts/check-lx-search-live.js [关键词]
 *
 * 做两件事：
 *   1. 直接调用 desktop/lx-search 的五个音源，确认能拿到曲目
 *   2. 起一个临时 server，走 /api/lx/search 确认端点、分页字段、字段换算
 *
 * 因为依赖外网，不放进 quick-check；平台侧接口变动时手动跑一遍即可。
 */

const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const appRoot = path.resolve(__dirname, '..');
const lxSearch = require(path.join(appRoot, 'desktop', 'lx-search'));

const KEYWORDS = process.argv[2] || '周杰伦 稻香';
const PORT = Number(process.env.LX_SEARCH_LIVE_PORT || 3412);

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  [' + detail + ']' : ''}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    return { parseError: text.slice(0, 160) };
  }
}

async function checkSourcesDirectly() {
  console.log(`\n=== 1. 直接调用五个音源（关键词：${KEYWORDS}）`);
  for (const source of lxSearch.SOURCES) {
    const startedAt = Date.now();
    try {
      const result = await lxSearch.search(source.id, KEYWORDS, { limit: 5, offset: 0 });
      const first = result.songs[0];
      check(`${source.id}（${source.name}）返回曲目`, result.songs.length > 0, `${result.songs.length} 条 / ${Date.now() - startedAt}ms`);
      check(`${source.id} provider 换算正确`, result.provider === source.provider, result.provider);
      if (first) {
        check(`${source.id} 首条有歌名与歌手`, !!first.name && !!first.artist, `${first.name} — ${first.artist}`);
        check(`${source.id} 首条时长已换算成毫秒`, first.duration > 30000 && first.duration < 3600000, String(first.duration));
        check(`${source.id} 首条带上 lxSource`, first.lxSource === source.id, String(first.lxSource));
      }
    } catch (err) {
      check(`${source.id}（${source.name}）返回曲目`, false, (err && err.message) || 'unknown');
    }
  }
}

async function checkServerEndpoint() {
  console.log(`\n=== 2. /api/lx/search 端点（端口 ${PORT}）`);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: appRoot,
    env: Object.assign({}, process.env, { PORT: String(PORT), HOST: '127.0.0.1' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', chunk => { serverLog += chunk; });
  child.stderr.on('data', chunk => { serverLog += chunk; });

  try {
    let ready = false;
    for (let i = 0; i < 30 && !ready; i += 1) {
      await sleep(500);
      try {
        const probe = await fetch(`http://127.0.0.1:${PORT}/api/user-api/status`);
        ready = probe.ok;
      } catch (e) { /* 还没起来 */ }
    }
    if (!ready) {
      check('临时 server 启动', false, serverLog.split('\n').slice(-3).join(' | '));
      return;
    }
    check('临时 server 启动', true);

    for (const source of lxSearch.SOURCES) {
      const payload = await getJson(`http://127.0.0.1:${PORT}/api/lx/search?source=${source.id}&keywords=${encodeURIComponent(KEYWORDS)}&limit=4&offset=0`);
      const songs = Array.isArray(payload.songs) ? payload.songs : [];
      check(`/api/lx/search?source=${source.id}`, songs.length > 0, `${songs.length} 条 / total=${payload.total}`);
      check(`${source.id} 端点回传 provider`, payload.provider === source.provider, String(payload.provider));
      check(`${source.id} 端点回传分页字段`, payload.limit === 4 && payload.offset === 0 && typeof payload.nextOffset === 'number',
        `limit=${payload.limit} offset=${payload.offset} next=${payload.nextOffset} hasMore=${payload.hasMore}`);
    }

    const page = await getJson(`http://127.0.0.1:${PORT}/api/lx/search?source=tx&keywords=${encodeURIComponent(KEYWORDS)}&limit=4&offset=4`);
    const pageSongs = Array.isArray(page.songs) ? page.songs : [];
    check('offset 分页可用（tx offset=4）', pageSongs.length > 0, `${pageSongs.length} 条`);

    const bad = await getJson(`http://127.0.0.1:${PORT}/api/lx/search?source=unknown&keywords=x`);
    check('未知音源返回错误而不是 500 崩溃', !!bad.error || bad.songs.length === 0, String(bad.error || 'empty'));
  } finally {
    child.kill();
  }
}

(async () => {
  await checkSourcesDirectly();
  await checkServerEndpoint();
  console.log(`\n结果：PASS ${pass} / FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
})();
