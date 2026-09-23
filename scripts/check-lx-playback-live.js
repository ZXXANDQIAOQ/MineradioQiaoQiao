/*
 * LX 播放链路 live 检查（需要 Electron 运行时，手动执行）
 *
 *   node scripts/check-lx-playback-live.js
 *
 * 用真实渲染进程走一遍「搜索 → 点播放 → 取链」：
 *   1. 读当前音源状态（模式 / 是否就绪 / 脚本声明支持哪些平台）
 *   2. 真实搜索关键词，看搜索层返回多少条
 *   3. 按平台逐个点播（网易云 / 酷狗 / 酷我 / 咪咕），采样 audio.src 与提示卡片
 *   4. 打印页面控制台日志，[UserApi] 那几行就是取链结果
 *
 * 注意：
 *   · 会真实联网、真实调用本机已启用的音源脚本，跑之前先在应用里选好音源；
 *   · 检查期间会临时把音源模式切成「优先使用」，结束前还原；
 *   · 只在无音频输出设备的机器上跑时，audio 会停在 readyState 0，
 *     这时看 src 是不是音源地址就够了。
 */
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const appRoot = path.resolve(__dirname, '..');
const electronBinary = path.join(appRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
const debugPort = Number(process.env.PROBE_PORT || 9241);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function getJson(url) {
  return new Promise(resolve => {
    http.get(url, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (_) { resolve(null); } });
    }).on('error', () => resolve(null));
  });
}

let socketUrl = '';
let sequence = 100;

function evaluate(expression) {
  return new Promise(resolve => {
    const socket = new WebSocket(socketUrl);
    const id = (sequence += 1);
    const timer = setTimeout(() => { try { socket.close(); } catch (_) {} resolve(null); }, 40000);
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
    });
    socket.addEventListener('message', event => {
      let message = null;
      try { message = JSON.parse(event.data); } catch (_) { return; }
      if (!message || message.id !== id) return;
      clearTimeout(timer);
      try { socket.close(); } catch (_) {}
      if (message.result && message.result.exceptionDetails) {
        resolve('EXCEPTION: ' + JSON.stringify(message.result.exceptionDetails.exception || {}).slice(0, 400));
        return;
      }
      resolve(message.result && message.result.result ? message.result.result.value : null);
    });
    socket.addEventListener('error', () => { clearTimeout(timer); resolve(null); });
  });
}

async function waitForPageTarget(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const isMainAppPage = target => {
    const url = String(target.url || '');
    if (!target.webSocketDebuggerUrl) return false;
    if (/^(about:|devtools:)/i.test(url)) return false;
    if (/startup\.html|desktop-lyrics\.html|wallpaper/i.test(url)) return false;
    return /^https?:\/\//i.test(url) || /index\.html/i.test(url);
  };
  while (Date.now() < deadline) {
    for (const endpoint of ['/json/list', '/json']) {
      const list = await getJson(`http://127.0.0.1:${debugPort}${endpoint}`);
      if (Array.isArray(list)) {
        const page = list.find(t => t.type === 'page' && isMainAppPage(t));
        if (page) return page;
      }
    }
    await sleep(800);
  }
  return null;
}

const HOOK = `(function () {
  if (window.__probeLogs) return 'already';
  window.__probeLogs = [];
  ['log','warn','error','info'].forEach(function (k) {
    var o = console[k];
    console[k] = function () {
      try {
        var a = [].slice.call(arguments).map(function (x) {
          try { return typeof x === 'string' ? x : JSON.stringify(x); } catch (e) { return String(x); }
        }).join(' ');
        window.__probeLogs.push(k + ': ' + a.slice(0, 400));
      } catch (e) {}
      return o.apply(console, arguments);
    };
  });
  window.addEventListener('error', function (e) { window.__probeLogs.push('onerror: ' + (e.message || '')); });
  return 'ok';
})()`;

async function main() {
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  console.log(`启动 Mineradio（调试端口 ${debugPort}）…`);
  const child = spawn(electronBinary, ['.', `--remote-debugging-port=${debugPort}`, '--in-process-gpu'], {
    cwd: appRoot, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childLog = '';
  child.stdout.on('data', c => { childLog += c.toString(); });
  child.stderr.on('data', c => { childLog += c.toString(); });

  try {
    const page = await waitForPageTarget(45000);
    if (!page) {
      console.log('[FAIL] 拿不到渲染进程，日志尾部：\n' + childLog.slice(-1500));
      return 1;
    }
    socketUrl = page.webSocketDebuggerUrl;
    await sleep(6000);
    console.log('HOOK:', await evaluate(HOOK));

    // 临时切到「优先使用音源」，跑完还原（不动用户的设置）
    const originalMode = await evaluate("(function () { try { return localStorage.getItem('mineradio.userApiMode') || '(未设置)'; } catch (e) { return '(读取失败)'; } })()");
    console.log('原模式:', originalMode);
    await evaluate("(function () { if (typeof userApiSetPlaybackMode === 'function') userApiSetPlaybackMode('prefer'); return 'ok'; })()");

    console.log('\n=== 音源状态 ===');
    console.log(await evaluate(`JSON.stringify({
      mode: typeof userApiPlaybackMode === 'function' ? userApiPlaybackMode() : '(缺)',
      ready: typeof userApiStatusReady === 'function' ? userApiStatusReady() : '(缺)',
      active: (typeof MINERADIO_USER_API_STATUS_CACHE !== 'undefined' && MINERADIO_USER_API_STATUS_CACHE && MINERADIO_USER_API_STATUS_CACHE.active) || null,
      sources: (typeof MINERADIO_USER_API_STATUS_CACHE !== 'undefined' && MINERADIO_USER_API_STATUS_CACHE && MINERADIO_USER_API_STATUS_CACHE.sources) || null,
      statusText: (document.getElementById('user-api-status') || {}).textContent || ''
    }, null, 1)`));

    console.log('\n=== 真实搜索：晴天 ===');
    const searchResult = await evaluate(`(async function () {
      var input = document.getElementById('search-input');
      if (input) input.value = '晴天';
      if (typeof doSearch !== 'function') return JSON.stringify({ error: 'doSearch 缺失' });
      await doSearch('晴天');
      await new Promise(function (r) { setTimeout(r, 600); });
      var state = (typeof searchMusicRenderState !== 'undefined') ? searchMusicRenderState : {};
      var songs = (state.songs || []).map(function (s) {
        return { name: s.name, artist: s.artist, provider: s.provider, id: s.id, hash: s.hash || '' };
      });
      var empty = document.querySelector('#search-results .search-empty');
      return JSON.stringify({
        count: songs.length,
        songs: songs.slice(0, 8),
        emptyText: empty ? empty.textContent : '',
        notice: (typeof searchProviderNotice !== 'undefined' ? searchProviderNotice : ''),
        rendered: document.querySelectorAll('#search-results .search-result').length
      }, null, 1);
    })()`);
    console.log(searchResult);

    const SAMPLE = `(function () {
      var m = (typeof playbackMedia !== 'undefined' && playbackMedia) ? playbackMedia
        : (typeof audio !== 'undefined' ? audio : null);
      var cards = [].slice.call(document.querySelectorAll('.source-fallback-card')).map(function (c) {
        return c.textContent.slice(0, 220);
      });
      var banner = document.getElementById('trial-banner');
      return JSON.stringify({
        media: m ? {
          src: String(m.src || '').slice(0, 180),
          paused: m.paused,
          readyState: m.readyState,
          currentTime: m.currentTime,
          duration: m.duration,
          error: m.error ? (m.error.code + ':' + m.error.message) : ''
        } : null,
        playing: (typeof isPlaying !== 'undefined') ? isPlaying : null,
        queueLen: (typeof playQueue !== 'undefined') ? playQueue.length : -1,
        currentIdx: (typeof currentIdx !== 'undefined') ? currentIdx : -1,
        currentSong: (typeof currentSong !== 'undefined' && currentSong) ? {
          name: currentSong.name,
          provider: currentSong.provider,
          resolved: currentSong.resolvedPlaybackProvider,
          playbackSource: currentSong.playbackSource,
          trial: !!currentSong.trial
        } : null,
        cards: cards,
        trialBanner: (banner && banner.classList.contains('show')) ? ((document.getElementById('trial-text') || {}).textContent || '') : ''
      }, null, 1);
    })()`;

    for (const target of ['netease', 'kugou', 'kuwo', 'migu']) {
      const idxRaw = await evaluate(`(function () {
        var list = (typeof playlist !== 'undefined' && playlist) ? playlist : [];
        for (var i = 0; i < list.length; i++) {
          if (String(list[i].provider || '') === '${target}') return String(i);
        }
        return '-1';
      })()`);
      const idx = Number(idxRaw);
      console.log(`\n=== 播放 ${target}（playlist 下标 ${idx}）===`);
      if (!(idx >= 0)) { console.log('  搜索结果里没有这个平台'); continue; }
      console.log(await evaluate(`(function () { playSearchResult(${idx}); return 'clicked'; })()`));
      for (let step = 1; step <= 4; step++) {
        await sleep(4000);
        console.log(`  [${step * 4}s] ` + await evaluate(SAMPLE));
      }
    }

    console.log('\n=== 页面日志 ===');
    console.log(await evaluate('JSON.stringify((window.__probeLogs || []).slice(-80), null, 1)'));

    // 还原用户原本的音源模式
    await evaluate(`(function () {
      var key = 'mineradio.userApiMode';
      var prev = ${JSON.stringify(originalMode)};
      try {
        if (prev === '(未设置)' || prev === '(读取失败)') localStorage.removeItem(key);
        else localStorage.setItem(key, prev);
      } catch (e) {}
      if (typeof renderUserApiModeSegment === 'function') renderUserApiModeSegment();
      return 'restored';
    })()`);
  } finally {
    try { child.kill(); } catch (_) {}
    await sleep(1200);
  }
  return 0;
}

main().then(code => process.exit(code)).catch(err => { console.error(err); process.exit(1); });
