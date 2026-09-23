'use strict';

/*
 * LX 音源模式回归：界面与播放逻辑仍是 Mineradio 的，
 * 但平台登录入口整体下线，播放内容改由 LX 自定义音源提供。
 *
 * 这里只做静态守卫（不联网、不起 Electron）：
 *   · 开关常量存在，且在业务模块之前加载
 *   · 登录弹窗只有一个打开漏斗 showLoginModal，漏斗处已短路
 *   · 启动登录引导、顶部账号按钮、首页登录磁贴都不再通向登录
 *   · 播放链路里的「去登录」改成「去导入音源」
 *   · 自定义音源默认模式为「优先使用」
 *
 * 真实渲染进程的行为由 scripts/check-user-api-panel-live.js 覆盖。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(appRoot, rel), 'utf8');

const modeText = read('public/js/modules/00-state/12-lx-only-mode.js');
const loaderText = read('public/js/index-loader.js');
const loginFlowText = read('public/js/modules/08-account/03-login-modal-flows.js');
const loginUtilsText = read('public/js/modules/08-account/01-login-modal-utils.js');
const guideText = read('public/js/modules/08-account/05-startup-login-guide.js');
const fallbackText = read('public/js/modules/05-playback/11-provider-fallback.js');
const startAudioText = read('public/js/modules/05-playback/13-playback-start-audio.js');
const homeTilesText = read('public/js/modules/05-playback/03-home-discover-weather.js');
const homeActionsText = read('public/js/modules/05-playback/05-home-actions.js');
const trackDetailText = read('public/js/modules/05-playback/06-track-detail-lyrics-actions.js');
const loginStatusText = read('public/js/modules/08-account/02-login-status.js');
const panelText = read('public/js/modules/12-user-api/00-user-api-panel.js');
const cssText = read('public/css/index.css');

/** 断言 a 在 b 之前出现（同一段自检文本里比较先后的紧凑写法） */
function appearsBefore(haystack, first, second) {
  const i = haystack.indexOf(first);
  const j = haystack.indexOf(second);
  assert.notEqual(i, -1, `缺少 ${first}`);
  assert.notEqual(j, -1, `缺少 ${second}`);
  assert.ok(i < j, `${first} 应该出现在 ${second} 之前`);
}

test('LX 音源模式开关存在，且排在所有业务模块之前加载', () => {
  assert.match(modeText, /var MINERADIO_LX_ONLY_MODE = true;/);
  assert.match(modeText, /function lxOnlyModeEnabled\(\)/);
  assert.match(modeText, /function lxOnlyModeHint\(/);
  assert.match(loaderText, /'js\/modules\/00-state\/12-lx-only-mode\.js'/);

  const modeIndex = loaderText.indexOf('00-state/12-lx-only-mode.js');
  assert.ok(modeIndex < loaderText.indexOf('05-playback/00-api-quality-output.js'), '要早于播放模块');
  assert.ok(modeIndex < loaderText.indexOf('08-account/00-login-easter-egg.js'), '要早于账号模块');
  assert.ok(modeIndex < loaderText.indexOf('12-user-api/00-user-api-panel.js'), '要早于音源面板');
});

test('登录弹窗的唯一漏斗 showLoginModal 在 LX 音源模式下短路', () => {
  assert.match(loginFlowText, /async function showLoginModal\(opts\) \{[\s\S]{0,500}lxOnlyModeEnabled\(\)[\s\S]{0,200}return;/);
  // 走到短路之后才允许出现原来的弹窗逻辑
  appearsBefore(loginFlowText, 'lxOnlyModeEnabled()', "openGsapModal(modal)");
});

test('顶部账号入口与首页登录磁贴都不再通向登录', () => {
  assert.match(loginUtilsText, /function onUserBtnClick\(\)[\s\S]{0,400}lxOnlyModeEnabled\(\)/);
  assert.match(cssText, /html\.lx-only-mode #user-btn/);
  assert.match(cssText, /html\.lx-only-mode \.user-capsule-hide-btn/);

  assert.match(homeTilesText, /kind: 'source', title: '导入 LX 音源'/);
  appearsBefore(homeTilesText, "kind: 'source'", "kind: 'login'");
  assert.match(homeActionsText, /item\.kind === 'source'[\s\S]{0,200}toggleFxPanel\(true\)/);

  assert.match(trackDetailText, /function ensureLoggedInForAction\(provider\)[\s\S]{0,500}lxOnlyModeEnabled\(\)/);
});

test('启动登录引导与播放链路的登录引导都被替换', () => {
  assert.match(guideText, /function maybeRunStartupLoginGuide\(source\) \{[\s\S]{0,400}lxOnlyModeEnabled\(\)[\s\S]{0,120}return;/);
  assert.match(guideText, /function maybeRunStartupLoginGuide\(source\) \{[\s\S]{0,1200}runLoginGuideParticles/);

  assert.match(fallbackText, /lxOnlyModeEnabled\(\)[\s\S]{0,400}lxOnlyModeHint/);
  appearsBefore(fallbackText, 'lxOnlyModeHint', "openProviderLogin(provider)");

  assert.match(startAudioText, /trialLoginBtn\.textContent = '去导入音源'/);
  assert.match(startAudioText, /内置取链只给到试听片段/);
});

test('自定义音源默认「优先使用」，内置取链退为兜底', () => {
  assert.match(panelText, /function userApiPlaybackMode\(\)[\s\S]{0,500}return 'prefer';/);
  assert.match(panelText, /if \(value === 'off' \|\| value === 'fallback' \|\| value === 'prefer'\) return value;/);
});

test('平台登录态轮询在 LX 音源模式下不再启动', () => {
  ['startQQLoginStatusAutoRefresh', 'startKugouLoginStatusAutoRefresh',
    'startQishuiLoginStatusAutoRefresh', 'startSpotifyLoginStatusAutoRefresh'].forEach((name) => {
    const at = loginStatusText.indexOf(`function ${name}(`);
    assert.notEqual(at, -1, `缺少 ${name}`);
    const body = loginStatusText.slice(at, at + 260);
    assert.match(body, /lxOnlyModeEnabled\(\)\) return;/, `${name} 应先判断 LX 音源模式`);
  });
});
