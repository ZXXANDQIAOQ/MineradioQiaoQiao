'use strict';

/*
 * LX 在线搜索的前端接线回归（离线守卫）
 *
 * 搜索实现按 lx-music-mobile 走（desktop/lx-search），界面元素仍是 Mineradio 的：
 *   · 搜索标签栏沿用 #search-mode-tabs，新增 KW / MG 两枚
 *   · 五个平台统一请求 /api/lx/search?source=wy|tx|kg|kw|mg
 *   · 综合搜索（All）把五个平台的页面结果一起合并
 *   · 酷我 / 咪咕没有内置取链，播放链路不许把它们误落到网易云分支
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appRoot = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(appRoot, rel), 'utf8');

const searchSource = read('public/js/modules/05-playback/07-search.js');
const indexHtml = read('public/index.html');
const cssText = read('public/css/index.css');
const coreStores = read('public/js/modules/00-state/00-core-stores.js');
const playbackSource = read('public/js/modules/05-playback/13-playback-start-audio.js');
const qualitySource = read('public/js/modules/05-playback/00-api-quality-output.js');
const serverText = read('server.js');

function namedFunctionSource(source, name) {
  const declaration = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  assert.ok(declaration, `missing ${name}()`);
  const bodyStart = source.indexOf('{', declaration.index + declaration[0].length);
  let depth = 0;
  let quote = '';
  let regex = false;
  let regexClass = false;
  let lineComment = false;
  let blockComment = false;
  let escaped = false;
  for (let index = bodyStart; index < source.length; index += 1) {
    const character = source[index];
    const nextCharacter = source[index + 1];
    if (lineComment) {
      if (character === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === '*' && nextCharacter === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (regex) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '[') regexClass = true;
      else if (character === ']') regexClass = false;
      else if (character === '/' && !regexClass) regex = false;
      continue;
    }
    if (character === '/' && nextCharacter === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === '/' && nextCharacter === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === '/') {
      let previousIndex = index - 1;
      while (previousIndex >= bodyStart && /\s/.test(source[previousIndex])) previousIndex -= 1;
      const previous = source[previousIndex] || '';
      if (!previous || /[=(,:;!&|?{}\[]/.test(previous)) {
        regex = true;
        regexClass = false;
        continue;
      }
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(declaration.index, index + 1);
    }
  }
  throw new Error(`unterminated ${name}()`);
}

test('搜索 provider 统一映射到 LX 音源端点', () => {
  const mapping = /var SEARCH_PROVIDER_LX_SOURCE = \{[^}]*\};/.exec(searchSource);
  assert.ok(mapping, 'missing SEARCH_PROVIDER_LX_SOURCE');
  const sandbox = { encodeURIComponent };
  vm.runInNewContext([
    mapping[0],
    namedFunctionSource(searchSource, 'searchProviderLxSource'),
    namedFunctionSource(searchSource, 'searchProviderUrl'),
    namedFunctionSource(searchSource, 'controlSourceSearchUrl'),
    'this.lx = searchProviderLxSource; this.url = searchProviderUrl; this.controlUrl = controlSourceSearchUrl;',
  ].join('\n'), sandbox);

  assert.equal(sandbox.lx('netease'), 'wy');
  assert.equal(sandbox.lx('qq'), 'tx');
  assert.equal(sandbox.lx('kugou'), 'kg');
  assert.equal(sandbox.lx('kuwo'), 'kw');
  assert.equal(sandbox.lx('migu'), 'mg');
  assert.equal(sandbox.lx('qishui'), '');
  assert.equal(sandbox.lx('spotify'), '');

  assert.match(sandbox.url('netease', '晴天', 18, 0), /^\/api\/lx\/search\?source=wy&keywords=/);
  assert.match(sandbox.url('qq', '晴天', 12, 24), /^\/api\/lx\/search\?source=tx&keywords=/);
  assert.match(sandbox.url('qq', '晴天', 12, 24), /limit=12&offset=24$/);
  assert.match(sandbox.url('kugou', '晴天', 12, 0), /source=kg/);
  assert.match(sandbox.url('kuwo', '晴天', 12, 0), /source=kw/);
  assert.match(sandbox.url('migu', '晴天', 12, 0), /source=mg/);
  // 汽水 / Spotify 仍走各自的内置端点，不受 LX 搜索层影响
  assert.match(sandbox.url('qishui', '晴天', 12, 0), /^\/api\/qishui\/search\?/);
  assert.match(sandbox.url('spotify', 'Muse', 10, 30), /^\/api\/spotify\/search\?/);
  assert.match(sandbox.controlUrl('migu', '晴天'), /^\/api\/lx\/search\?source=mg&keywords=/);
});

test('搜索标签栏沿用 Mineradio 的结构，新增 KW / MG', () => {
  assert.match(indexHtml, /id="search-mode-tabs" class="search-mode-tabs"/);
  ['song', 'netease', 'qq', 'kugou', 'kuwo', 'migu', 'qishui', 'podcast'].forEach((mode) => {
    assert.match(indexHtml, new RegExp(`id="search-mode-${mode}"`), `missing tab ${mode}`);
    assert.match(searchSource, new RegExp(`SEARCH_MODE_TAB_KEYS = \\[[^\\]]*'${mode}'`), `missing key ${mode}`);
  });
  assert.match(searchSource, /var SEARCH_MODE_TAB_KEYS = \['song', 'netease', 'qq', 'kugou', 'kuwo', 'migu', 'qishui', 'podcast'\];/);
  assert.match(searchSource, /updateSearchModeTabs\(\)\s*\{[\s\S]{0,220}SEARCH_MODE_TAB_KEYS\.forEach/);
  assert.match(searchSource, /function setSearchMode\(mode\)\s*\{[\s\S]{0,140}SEARCH_MODE_TAB_KEYS\.indexOf\(mode\) >= 0 \? mode : 'song'/);
  assert.match(searchSource, /kuwo: '搜索酷我音乐\.\.\.'/);
  assert.match(searchSource, /migu: '搜索咪咕音乐\.\.\.'/);
  assert.match(searchSource, /var SEARCH_HISTORY_MODES = \['song', 'netease', 'qq', 'kugou', 'kuwo', 'migu', 'qishui', 'podcast'\];/);
});

test('综合搜索（All）把五个平台一起合并', () => {
  assert.match(searchSource, /var MUSIC_SEARCH_PROVIDER_ORDER = \['netease', 'qq', 'kugou', 'kuwo', 'migu', 'qishui'\];/);
  assert.match(searchSource, /function searchModeProvider\(mode\)\s*\{[\s\S]{0,140}MUSIC_SEARCH_PROVIDER_ORDER\.indexOf\(mode\) >= 0/);
  assert.match(searchSource, /provider === 'kuwo' \|\| provider === 'migu'/);
  assert.match(searchSource, /function mergeSongSearchResults\(neteaseSongs, qqSongs, kugouSongs, qishuiSongs, spotifySongs, kuwoSongs, miguSongs, limit, q\)/);
  assert.match(searchSource, /\(kuwoSongs \|\| \[\]\)\.forEach\(function \(song, i\) \{ push\(song, i\); \}\);/);
  assert.match(searchSource, /\(miguSongs \|\| \[\]\)\.forEach\(function \(song, i\) \{ push\(song, i\); \}\);/);
  assert.match(searchSource, /var songsByProvider = \{ netease: \[\], qq: \[\], kugou: \[\], kuwo: \[\], migu: \[\], qishui: \[\], spotify: \[\] \};/);
  assert.match(searchSource, /var pageLimitByProvider = \{ netease: 18, qq: 12, kugou: 12, kuwo: 12, migu: 12, qishui: 12, spotify: 10 \};/);
  assert.match(searchSource, /songsByProvider\.kuwo,\s*songsByProvider\.migu,\s*MUSIC_SEARCH_MAX_RESULTS/);
});

test('来源标签与切换音源面板认得酷我 / 咪咕', () => {
  assert.match(searchSource, /if \(song && \(song\.provider === 'kuwo'[\s\S]{0,220}return 'kuwo';/);
  assert.match(searchSource, /if \(song && \(song\.provider === 'migu'[\s\S]{0,220}return 'migu';/);
  assert.match(searchSource, /\^\(netease\|qq\|kugou\|kuwo\|migu\|qishui\|spotify\)\$/);
  assert.match(searchSource, /key === 'kuwo' \? 'KW' : \(key === 'migu' \? 'MG'/);
  assert.match(searchSource, /\{ key: 'kuwo', label: 'KW', title: '酷我' \}/);
  assert.match(searchSource, /\{ key: 'migu', label: 'MG', title: '咪咕' \}/);
  assert.match(cssText, /\.tag-source\.kuwo \{/);
  assert.match(cssText, /\.tag-source\.migu \{/);
});

test('音质与平台文案补齐酷我 / 咪咕', () => {
  assert.match(coreStores, /var PLAYBACK_QUALITY_DEFAULTS = \{[^}]*kuwo: 'lossless'[^}]*migu: 'lossless'[^}]*\};/);
  assert.match(coreStores, /kuwo: \[\s*\{ key: 'hires'/);
  assert.match(coreStores, /migu: \[\s*\{ key: 'hires'/);
  assert.match(qualitySource, /if \(provider === 'kuwo'\) return 'kuwo';/);
  assert.match(qualitySource, /if \(provider === 'migu'\) return 'migu';/);
  assert.match(qualitySource, /provider === 'kuwo' \? '酷我音质: ' : \(provider === 'migu' \? '咪咕音质: '/);
});

test('酷我 / 咪咕不落网易云兜底：播放链路显式拦截', () => {
  assert.match(playbackSource, /var isKuwoPlayback = playbackProvider === 'kuwo';/);
  assert.match(playbackSource, /var isMiguPlayback = playbackProvider === 'migu';/);
  assert.match(playbackSource, /\} else if \(isKuwoPlayback \|\| isMiguPlayback\) \{[\s\S]{0,320}data = null;\s*\} else \{/);
  assert.match(playbackSource, /if \(playbackProvider === 'kuwo' \|\| playbackProvider === 'migu'\) \{[\s\S]{0,240}return null;\s*\}/);
});

test('server.js 暴露 /api/lx/search 并复用 LX 搜索层', () => {
  assert.match(serverText, /const lxSearch = require\('\.\/desktop\/lx-search'\);/);
  assert.match(serverText, /if \(pn === '\/api\/lx\/search'\) \{[\s\S]{0,900}await lxSearch\.search\(source, kw, \{ limit, offset \}\)/);
  assert.match(serverText, /nextOffset: offset \+ result\.songs\.length/);
});
