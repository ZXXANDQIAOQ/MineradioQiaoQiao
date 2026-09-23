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
    actionFns: [
      typeof importUserApiFromUrl,
      typeof importUserApiFromFile,
      typeof refreshUserApiPanel,
      typeof openUserApiDataDir
    ].join(','),
    logToggle: !!document.getElementById('user-api-log-toggle'),
    mode: typeof userApiPlaybackMode === 'function' ? userApiPlaybackMode() : '(缺)',
    statusText: (document.getElementById('user-api-status') || { textContent: '(缺)' }).textContent.slice(0, 80)
  });
})()`;

const SNAPSHOT = `(function () {
  var rows = document.querySelectorAll('#user-api-list .user-api-row');
  var activeName = document.getElementById('user-api-active-name');
  var status = document.getElementById('user-api-status');
  var busy = document.getElementById('user-api-busy');
  return JSON.stringify({
    rowCount: rows.length,
    firstRowTitle: rows.length ? rows[0].querySelector('.user-api-row-title').textContent : '',
    firstRowActive: rows.length ? rows[0].classList.contains('active') : false,
    activeName: activeName ? activeName.textContent : '',
    status: status ? status.textContent : '',
    busyHidden: busy ? busy.hidden : true,
    listEmpty: !!document.querySelector('#user-api-list .user-api-empty')
  });
})()`;

async function waitForPageTarget(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const endpoint of ['/json/list', '/json']) {
      const list = await getJson(`http://127.0.0.1:${debugPort}${endpoint}`);
      if (Array.isArray(list)) {
        const page = list.find(target => target.type === 'page' && target.webSocketDebuggerUrl);
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
  const child = spawn(electronBinary, ['.', `--remote-debugging-port=${debugPort}`], {
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
    check('四个操作按钮齐全', probe.actionButtons === 4, 'buttons=' + probe.actionButtons);
    check('操作函数已导出到全局', probe.actionFns === 'function,function,function,function', probe.actionFns);
    check('日志开关存在', probe.logToggle === true);
    check('播放模式默认兜底', probe.mode === 'fallback', 'mode=' + probe.mode);
    check('状态行已渲染', probe.statusText.length > 0, probe.statusText);

    const baselineRaw = await evaluate(
      `(async function () { var r = await window.desktopWindow.getUserApiStatus(); return JSON.stringify(r); })()`
    );
    const baseline = JSON.parse(baselineRaw);
    check('IPC 状态可用', baseline.ok === true, baseline.error || '');
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
    check('行标题是音源名', snapshot.firstRowTitle === imported.name, snapshot.firstRowTitle);

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
    check('该行标记为已启用', snapshot.firstRowActive === true);
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
