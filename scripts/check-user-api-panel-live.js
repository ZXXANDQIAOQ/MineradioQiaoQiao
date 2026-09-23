/*
 * 自定义音源面板 live 检查（需要 Electron 运行时，手动执行）
 *
 *   node scripts/check-user-api-panel-live.js
 *
 * 做一次真实渲染进程的完整走查：
 *   1. 面板存在、模式按钮 3 个、状态行可读
 *   2. 通过 IPC 导入示例音源 → 列表多一行、状态有内容
 *   3. 启用 → 行标记 active、顶部显示当前音源
 *   4. 模式三段切换并写入 localStorage，再切回
 *   5. 未启用音源时歌词钩子短路（不打扰内置歌词）
 *   6. 删除 → 列表恢复基线，并把检查前的生效源还原回去
 *
 * 注意：会短暂启动一个 Mineradio 实例（独立调试端口），结束后关闭；
 * 检查前已有的音源列表不会被删除，生效源会在最后还原。
 */

'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const appRoot = path.resolve(__dirname, '..');
const electronBinary = path.join(appRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
const debugPort = Number(process.env.MINERADIO_USER_API_CHECK_PORT || 9231);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let pass = 0;
let fail = 0;

function check(name, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`  [PASS] ${name}${detail ? '  (' + detail + ')' : ''}`);
  } else {
    fail += 1;
    console.log(`  [FAIL] ${name}${detail ? '  (' + detail + ')' : ''}`);
  }
}

function getJson(url) {
  return new Promise(resolve => {
    http
      .get(url, res => {
        let raw = '';
        res.on('data', chunk => {
          raw += chunk;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(raw));
          } catch (_) {
            resolve(null);
          }
        });
      })
      .on('error', () => resolve(null));
  });
}

let socketUrl = '';
let sequence = 100;

/** 在渲染进程里执行一段表达式，返回其值（异常以 'EXCEPTION: ...' 字符串返回） */
function evaluate(expression) {
  return new Promise(resolve => {
    const socket = new WebSocket(socketUrl);
    const id = (sequence += 1);
    const timer = setTimeout(() => {
      try {
        socket.close();
      } catch (_) {}
      resolve(null);
    }, 20000);
    socket.addEventListener('open', () => {
      socket.send(
        JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true, awaitPromise: true },
        })
      );
    });
    socket.addEventListener('message', event => {
      let message = null;
      try {
        message = JSON.parse(event.data);
      } catch (_) {
        return;
      }
      if (!message || message.id !== id) return;
      clearTimeout(timer);
      try {
        socket.close();
      } catch (_) {}
      if (message.result && message.result.exceptionDetails) {
        resolve('EXCEPTION: ' + JSON.stringify(message.result.exceptionDetails.exception || {}).slice(0, 300));
        return;
      }
      resolve(message.result && message.result.result ? message.result.result.value : null);
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

const PANEL_PROBE = `(function () {
  var ids = [];
  var nodes = document.querySelectorAll('[id^="user-api"]');
  for (var i = 0; i < nodes.length; i++) ids.push(nodes[i].id);
  return JSON.stringify({
    readyState: document.readyState,
    panelExists: !!document.getElementById('user-api-panel'),
    modeButtons: document.querySelectorAll('#user-api-mode-seg [data-user-api-mode]').length,
    actionButtons: document.querySelectorAll('#user-api-panel .user-api-actions .fx-mini-btn').length,
    urlInput: !!document.getElementById('user-api-url'),
    urlInputType: (document.getElementById('user-api-url') || {}).type || '',
    urlImportBound: (function () {
      var el = document.getElementById('user-api-url');
      return !!(el && el.__mineradioBound);
    })(),
    urlImportButton: !!document.querySelector('#user-api-url-row .fx-mini-btn'),
    actionFns: [
      typeof importUserApiFromUrl,
      typeof importUserApiFromFile,
      typeof refreshUserApiPanel,
      typeof openUserApiDataDir
    ].join(','),
    logToggle: !!document.getElementById('user-api-log-toggle'),
    mode: typeof userApiPlaybackMode === 'function' ? userApiPlaybackMode() : '(缺)',
    defaultMode: (function () {
      // 默认值必须在「没有存过」的前提下测，否则会被上一次运行的 localStorage 带走
      var key = 'mineradio.userApiMode';
      var prev = null;
      try { prev = localStorage.getItem(key); localStorage.removeItem(key); } catch (e) { prev = null; }
      var value = typeof userApiPlaybackMode === 'function' ? userApiPlaybackMode() : '(缺)';
      try {
        if (prev === null) localStorage.removeItem(key);
        else localStorage.setItem(key, prev);
      } catch (e) {}
      return value;
    })(),
    statusText: (document.getElementById('user-api-status') || { textContent: '(缺)' }).textContent.slice(0, 80)
  });
})()`;

const SNAPSHOT = `(function () {
  var rows = document.querySelectorAll('#user-api-list .user-api-row');
  var activeName = document.getElementById('user-api-active-name');
  var status = document.getElementById('user-api-status');
  var busy = document.getElementById('user-api-busy');
  // 不能假设列表是空的：先记基线再按名字找行（本机可能已经有用户导入的音源）
  var titles = [];
  var activeTitles = [];
  for (var i = 0; i < rows.length; i++) {
    var titleNode = rows[i].querySelector('.user-api-row-title');
    var title = titleNode ? titleNode.textContent : '';
    titles.push(title);
    if (rows[i].classList.contains('active')) activeTitles.push(title);
  }
  return JSON.stringify({
    rowCount: rows.length,
    titles: titles,
    activeTitles: activeTitles,
    firstRowTitle: titles.length ? titles[0] : '',
    firstRowActive: rows.length ? rows[0].classList.contains('active') : false,
    activeName: activeName ? activeName.textContent : '',
    status: status ? status.textContent : '',
    busyHidden: busy ? busy.hidden : true,
    listEmpty: !!document.querySelector('#user-api-list .user-api-empty')
  });
})()`;

async function waitForPageTarget(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  // 主窗口是 http://localhost:PORT/ ；启动 splash、桌面歌词、壁纸窗口都排除掉。
  // 之前只判断 type === 'page'，会抢到 startup.html，而它随主窗口打开就关闭，
  // 导致后面所有 evaluate 静默返回 null。
  const isMainAppPage = (target) => {
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
        const page = list.find((target) => target.type === 'page' && isMainAppPage(target));
        if (page) return page;
      }
    }
    await sleep(800);
  }
  return null;
}

async function main() {
  if (typeof WebSocket !== 'function') {
    console.log('[SKIP] 当前 Node 没有全局 WebSocket（需 Node 22+），跳过面板 live 检查。');
    return 2;
  }
  if (!fs.existsSync(electronBinary)) {
    console.log(`[FAIL] 找不到 Electron：${electronBinary}\n       先执行 npm install（并补跑 electron 的 install.js）。`);
    return 1;
  }

  const env = Object.assign({}, process.env);
  // 这个变量会让 electron.exe 退化成纯 Node，必须清掉
  delete env.ELECTRON_RUN_AS_NODE;

  console.log(`启动 Mineradio（调试端口 ${debugPort}）…`);
  // --in-process-gpu：无头/CI/部分虚拟机上独立 GPU 进程会连不上 d3d11 而自杀
  // （日志里是「GPU process isn't usable. Goodbye.」），主窗口根本起不来。
  // 这里只是把 GPU 挪回主进程，被检查的 DOM / IPC / 面板逻辑都不受影响。
  const child = spawn(electronBinary, ['.', `--remote-debugging-port=${debugPort}`, '--in-process-gpu'], {
    cwd: appRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childLog = '';
  child.stdout.on('data', chunk => {
    childLog += chunk.toString();
  });
  child.stderr.on('data', chunk => {
    childLog += chunk.toString();
  });

  try {
    const page = await waitForPageTarget(45000);
    if (!page) {
      console.log('[FAIL] 拿不到渲染进程调试目标，启动日志尾部：\n' + childLog.slice(-1500));
      return 1;
    }
    socketUrl = page.webSocketDebuggerUrl;
    await sleep(5000);

    console.log('\n=== 1. 面板加载 ===');
    const probe = JSON.parse(await evaluate(PANEL_PROBE));
    check('面板容器存在', probe.panelExists === true);
    check('模式三段按钮齐全', probe.modeButtons === 3, 'buttons=' + probe.modeButtons);
    check('三个操作按钮齐全', probe.actionButtons === 3, 'buttons=' + probe.actionButtons);
    check('在线导入输入框存在且为文本框', probe.urlInput === true && probe.urlInputType === 'text', probe.urlInputType);
    check('在线导入输入框已绑定回车事件', probe.urlImportBound === true);
    check('在线导入按钮就位', probe.urlImportButton === true);
    check('操作函数已导出到全局', probe.actionFns === 'function,function,function,function', probe.actionFns);
    check('日志开关存在', probe.logToggle === true);
    check('播放模式默认优先音源', probe.defaultMode === 'prefer', 'default=' + probe.defaultMode);
    check('当前模式取值合法', ['off', 'fallback', 'prefer'].indexOf(probe.mode) >= 0, 'mode=' + probe.mode);
    check('状态行已渲染', probe.statusText.length > 0, probe.statusText);

    console.log('\n=== 1b. 在线导入入口（不联网） ===');
    const urlGuardRaw = await evaluate(`(function () {
      var out = {};
      var input = document.getElementById('user-api-url');
      var notice = document.getElementById('user-api-notice');
      input.value = '';
      try { importUserApiFromUrl(); } catch (e) { out.emptyThrew = String(e && e.message || e); }
      out.emptyNotice = (notice || {}).textContent || '';
      input.value = 'ftp://example.com/a.js';
      try { importUserApiFromUrl(); } catch (e) { out.badThrew = String(e && e.message || e); }
      out.badNotice = (notice || {}).textContent || '';
      input.value = '';
      return JSON.stringify(out);
    })()`);
    const urlGuard = JSON.parse(urlGuardRaw);
    check('空链接点击不抛异常', !urlGuard.emptyThrew, urlGuard.emptyThrew || '');
    check('空链接给出提示', /请先粘贴/.test(urlGuard.emptyNotice), urlGuard.emptyNotice);
    check('非 http 链接不抛异常', !urlGuard.badThrew, urlGuard.badThrew || '');
    check('非 http 链接给出提示', /http/.test(urlGuard.badNotice), urlGuard.badNotice);

    const baselineRaw = await evaluate(
      `(async function () { var r = await window.desktopWindow.getUserApiStatus(); return JSON.stringify(r); })()`
    );
    const baseline = JSON.parse(baselineRaw);
    check('IPC 状态可用', baseline.ok === true, baseline.error || '');

    console.log('\n=== 1c. LX 音源模式：平台登录入口下线 ===');
    const lxOnlyRaw = await evaluate(`(function () {
      var btn = document.getElementById('user-btn');
      var cs = btn ? getComputedStyle(btn) : null;
      var modal = document.getElementById('login-modal');
      return JSON.stringify({
        flag: typeof lxOnlyModeEnabled === 'function' ? lxOnlyModeEnabled() : null,
        htmlClass: document.documentElement.classList.contains('lx-only-mode'),
        userBtnVisibility: cs ? cs.visibility : '(缺)',
        userBtnPointer: cs ? cs.pointerEvents : '(缺)',
        userBtnAria: btn ? (btn.getAttribute('aria-hidden') || '') : '',
        modalShown: !!(modal && modal.classList.contains('show')),
        trialBtnText: (document.getElementById('trial-login-btn') || { textContent: '' }).textContent
      });
    })()`);
    const lxOnly = JSON.parse(lxOnlyRaw);
    check('LX 音源模式已开启', lxOnly.flag === true, 'flag=' + lxOnly.flag);
    check('根节点已标记 lx-only-mode', lxOnly.htmlClass === true);
    check('账号入口已隐藏', lxOnly.userBtnVisibility === 'hidden' && lxOnly.userBtnPointer === 'none',
      lxOnly.userBtnVisibility + '/' + lxOnly.userBtnPointer);
    check('账号入口对读屏也隐藏', lxOnly.userBtnAria === 'true', lxOnly.userBtnAria);
    check('初始没有登录弹窗', lxOnly.modalShown === false);

    const gateRaw = await evaluate(`(async function () {
      var modal = document.getElementById('login-modal');
      var out = {};
      await showLoginModal({ provider: 'netease', source: 'probe' });
      out.afterShow = !!(modal && modal.classList.contains('show'));
      onUserBtnClick();
      out.afterUserBtn = !!(modal && modal.classList.contains('show'));
      openProviderLogin('qq');
      out.afterProviderLogin = !!(modal && modal.classList.contains('show'));
      return JSON.stringify(out);
    })()`);
    const gate = JSON.parse(gateRaw);
    check('showLoginModal 被拦住', gate.afterShow === false);
    check('点账号按钮不会弹登录', gate.afterUserBtn === false);
    check('openProviderLogin 被拦住', gate.afterProviderLogin === false);

    console.log('\n=== 1d. LX 搜索标签（不联网，只看接线） ===');
    const searchTabs = JSON.parse(await evaluate(`(function () {
      var ids = ['song', 'netease', 'qq', 'kugou', 'kuwo', 'migu', 'qishui', 'podcast'];
      var missing = ids.filter(function (id) { return !document.getElementById('search-mode-' + id); });
      var urlFor = function (provider) {
        return typeof searchProviderUrl === 'function' ? searchProviderUrl(provider, 'probe', 12, 0) : '(缺)';
      };
      return JSON.stringify({
        missing: missing,
        mode: typeof searchMode === 'string' ? searchMode : '(缺)',
        order: typeof MUSIC_SEARCH_PROVIDER_ORDER !== 'undefined' ? MUSIC_SEARCH_PROVIDER_ORDER.join(',') : '(缺)',
        map: typeof searchProviderLxSource === 'function'
          ? ['netease', 'qq', 'kugou', 'kuwo', 'migu', 'qishui'].map(searchProviderLxSource).join(',')
          : '(缺)',
        urls: {
          netease: urlFor('netease'),
          qq: urlFor('qq'),
          kugou: urlFor('kugou'),
          kuwo: urlFor('kuwo'),
          migu: urlFor('migu'),
          qishui: urlFor('qishui')
        }
      });
    })()`));
    check('八个搜索标签都在 DOM 里', searchTabs.missing.length === 0, searchTabs.missing.join(',') || 'ok');
    check('默认是综合搜索', searchTabs.mode === 'song', 'mode=' + searchTabs.mode);
    check('综合搜索覆盖五个 LX 音源 + 汽水', searchTabs.order === 'netease,qq,kugou,kuwo,migu,qishui', searchTabs.order);
    check('平台→LX 音源映射正确', searchTabs.map === 'wy,tx,kg,kw,mg,', searchTabs.map);
    ['netease=wy', 'qq=tx', 'kugou=kg', 'kuwo=kw', 'migu=mg'].forEach(function (pair) {
      const parts = pair.split('=');
      check(
        parts[0] + ' 搜索走 /api/lx/search?source=' + parts[1],
        searchTabs.urls[parts[0]].indexOf('/api/lx/search?source=' + parts[1]) === 0,
        searchTabs.urls[parts[0]]
      );
    });
    check('汽水仍走自己的端点', searchTabs.urls.qishui.indexOf('/api/qishui/search') === 0, searchTabs.urls.qishui);

    const searchTabSwitch = JSON.parse(await evaluate(`(function () {
      setSearchMode('migu');
      var btn = document.getElementById('search-mode-migu');
      var input = document.getElementById('search-input');
      var out = {
        active: !!(btn && btn.classList.contains('active')),
        aria: btn ? btn.getAttribute('aria-selected') : '',
        placeholder: input ? input.placeholder : ''
      };
      setSearchMode('song');
      var back = document.getElementById('search-mode-song');
      out.backActive = !!(back && back.classList.contains('active'));
      return JSON.stringify(out);
    })()`));
    check('切到咪咕标签会高亮', searchTabSwitch.active === true && searchTabSwitch.aria === 'true');
    check('输入框提示跟着换', searchTabSwitch.placeholder.indexOf('咪咕') >= 0, searchTabSwitch.placeholder);
    check('能切回综合搜索', searchTabSwitch.backActive === true);

    const baselineCount = (baseline.status.list || []).length;
    const baselineActiveId = baseline.status.activeId || '';
    console.log(`  基线：已有音源 ${baselineCount} 个，生效源 ${baselineActiveId || '(无)'}`);

    let snapshot = JSON.parse(await evaluate(SNAPSHOT));
    check('列表行数与基线一致', snapshot.rowCount === baselineCount, 'rows=' + snapshot.rowCount);

    console.log('\n=== 2. 导入示例音源 ===');
    const sampleScript = fs.readFileSync(
      path.join(appRoot, 'desktop', 'user-api', 'sources', 'sample-source.js'),
      'utf8'
    );
    const importRaw = await evaluate(`(async function () {
      var r = await window.desktopWindow.importUserApi({ script: ${JSON.stringify(sampleScript)} });
      return JSON.stringify({ ok: r.ok, error: r.error || '', id: r.info ? r.info.id : '', name: r.info ? r.info.name : '' });
    })()`);
    const imported = JSON.parse(importRaw);
    check('导入成功', imported.ok === true, imported.error || imported.name);

    await evaluate('refreshUserApiPanel()');
    await sleep(2500);
    snapshot = JSON.parse(await evaluate(SNAPSHOT));
    check('列表新增一行', snapshot.rowCount === baselineCount + 1, 'rows=' + snapshot.rowCount);
    check('列表里能找到刚导入的音源', snapshot.titles.indexOf(imported.name) >= 0, snapshot.titles.join(' / '));

    console.log('\n=== 3. 启用该音源 ===');
    const selectRaw = await evaluate(
      `(async function () { var r = await window.desktopWindow.selectUserApi(${JSON.stringify(imported.id)}); return JSON.stringify(r); })()`
    );
    const selected = JSON.parse(selectRaw);
    check('启用成功', selected.ok === true, selected.error || '');
    check('音源已就绪', !!(selected.status && selected.status.status && selected.status.status.status), '');
    check(
      '示例源声明 3 个平台',
      selected.status && Object.keys(selected.status.sources || {}).length === 3,
      selected.status ? Object.keys(selected.status.sources || {}).join(',') : ''
    );

    await evaluate('refreshUserApiPanel()');
    await sleep(1500);
    snapshot = JSON.parse(await evaluate(SNAPSHOT));
    check('该行标记为已启用', snapshot.activeTitles.indexOf(imported.name) >= 0, snapshot.activeTitles.join(' / '));
    check('顶部显示当前音源', snapshot.activeName.indexOf(imported.name) >= 0, snapshot.activeName);
    check('状态行显示已就绪', snapshot.status.indexOf('已就绪') >= 0, snapshot.status);
    check('加载中提示已隐藏', snapshot.busyHidden === true);

    console.log('\n=== 4. 模式切换与持久化 ===');
    const modeRaw = await evaluate(`(function () {
      userApiSetPlaybackMode('prefer');
      var after = userApiPlaybackMode();
      var stored = localStorage.getItem('mineradio.userApiMode');
      var button = document.querySelector('#user-api-mode-seg [data-user-api-mode="prefer"]');
      var highlighted = button ? button.classList.contains('active') : false;
      userApiSetPlaybackMode('fallback');
      return JSON.stringify({ after: after, stored: stored, highlighted: highlighted, restored: userApiPlaybackMode() });
    })()`);
    const mode = JSON.parse(modeRaw);
    check('切到「优先使用」生效', mode.after === 'prefer');
    check('已写入 localStorage', mode.stored === 'prefer', mode.stored);
    check('按钮高亮同步', mode.highlighted === true);
    check('可以切回「兜底」', mode.restored === 'fallback');

    console.log('\n=== 5. 歌词钩子在兜底模式下不打扰内置链路 ===');
    const lyricRaw = await evaluate(`(async function () {
      var song = { id: '1974443814', provider: 'netease', name: '测试' };
      var r = await userApiFetchLyricResponse(song);
      return JSON.stringify({ result: r, mode: userApiPlaybackMode() });
    })()`);
    const lyric = JSON.parse(lyricRaw);
    check('非音源播放的曲目返回 null（不越权取歌词）', lyric.result === null, 'mode=' + lyric.mode);

    console.log('\n=== 6. 删除并还原 ===');
    const removeRaw = await evaluate(
      `(async function () { var r = await window.desktopWindow.removeUserApi(${JSON.stringify(imported.id)}); return JSON.stringify(r); })()`
    );
    const removed = JSON.parse(removeRaw);
    check('删除成功', removed.ok === true, removed.error || '');
    check(
      '列表回到基线数量',
      removed.status && (removed.status.list || []).length === baselineCount,
      'list=' + (removed.status ? (removed.status.list || []).length : '?')
    );

    if (baselineActiveId) {
      await evaluate(
        `(async function () { await window.desktopWindow.selectUserApi(${JSON.stringify(baselineActiveId)}); })()`
      );
      await sleep(1200);
      const restoredRaw = await evaluate(
        `(async function () { var r = await window.desktopWindow.getUserApiStatus(); return JSON.stringify(r); })()`
      );
      const restored = JSON.parse(restoredRaw);
      check('检查前的生效源已还原', restored.status.activeId === baselineActiveId, restored.status.activeId);
    } else {
      console.log('  （基线没有生效源，跳过还原）');
    }

    await evaluate('refreshUserApiPanel()');
    await sleep(1200);
    snapshot = JSON.parse(await evaluate(SNAPSHOT));
    check(
      'UI 与基线一致',
      snapshot.rowCount === baselineCount,
      'rows=' + snapshot.rowCount + ' active=' + snapshot.activeName
    );

    console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
    return fail ? 1 : 0;
  } finally {
    try {
      child.kill();
    } catch (_) {}
    await sleep(600);
  }
}

main()
  .then(code => {
    process.exit(code || 0);
  })
  .catch(error => {
    console.error('检查异常：', (error && error.stack) || error);
    process.exit(2);
  });
