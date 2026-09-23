'use strict';

/*
 * LX 音源逐一试播（换源兜底）回归
 *
 * 用户要的行为：一首歌当前音源放不了，就每隔 0.5 秒换下一个音源，
 * 第一个能取到播放地址的版本就用它播。
 *
 * 这里盖三件事：
 *   1. 节奏 —— 每换一个音源前等 0.5 秒，命中即停，不白试后面的
 *   2. 候选 —— 优先用搜索时留下的同曲其它平台版本，没有再补搜
 *   3. 接线 —— 播放链路两处失败点都接上了，且不会递归换源
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appRoot = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(appRoot, rel), 'utf8');

const scanSource = read('public/js/modules/05-playback/11a-lx-source-scan.js');
const searchSource = read('public/js/modules/05-playback/07-search.js');
const playbackSource = read('public/js/modules/05-playback/13-playback-start-audio.js');
const loaderSource = read('public/js/index-loader.js');

function namedFunctionSource(source, name) {
  const declaration = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  assert.ok(declaration, `missing ${name}()`);
  const bodyStart = source.indexOf('{', declaration.index + declaration[0].length);
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
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

/** 把整个 11a 模块放进 vm，再把依赖桩函数盖上去 */
function buildScanSandbox(overrides) {
  const sandbox = {
    console,
    setTimeout,
    Promise,
    MUSIC_SEARCH_PROVIDER_ORDER: ['netease', 'qq', 'kugou', 'kuwo', 'migu', 'qishui'],
  };
  vm.runInNewContext(`${scanSource}
this.scan = {
  findPlayable: lxSourceScanFindPlayable,
  providerQueue: lxSourceScanProviderQueue,
  providerUsable: lxSourceScanProviderUsable,
  fallback: tryLxSourceScanFallback,
  intervalMs: LX_SOURCE_SCAN_INTERVAL_MS,
  maxProviders: LX_SOURCE_SCAN_MAX_PROVIDERS
};`, sandbox);
  Object.assign(sandbox, {
    normalizePlaybackProvider: (name) => String(name || '').toLowerCase(),
    songProviderKey: (song) => String((song && (song.provider || song.source)) || '').toLowerCase(),
    searchProviderLxSource: (provider) => ({ netease: 'wy', qq: 'tx', kugou: 'kg', kuwo: 'kw', migu: 'mg' }[provider] || ''),
    userApiSupports: () => true,
    searchProviderCanSearch: () => true,
    trackSwitchToken: 1,
  }, overrides || {});
  return sandbox;
}

function alternatesProviderCalls(sandbox) {
  return sandbox.__urlCalls || [];
}

/** 换源入口用的整套播放链路桩 */
function buildFallbackSandbox(options) {
  const playQueue = [Object.assign({ name: '晴天', artist: '周杰伦', provider: 'netease', id: 'N1' }, options.songOverride || {})];
  const noticed = [];
  const plays = [];
  const sandbox = buildScanSandbox(Object.assign({
    playQueue,
    trackSwitchToken: 1,
    userApiStatusReady: () => true,
    userApiPlaybackMode: () => 'prefer',
    lxSourceScanSleep: async () => {},
    lxSourceScanSearchProvider: async (song, provider) => (provider === 'qq' ? { name: '晴天', artist: '周杰伦', provider: 'qq', mid: 'QQ1' } : null),
    userApiRequestPlaybackUrl: async () => ({ url: 'https://example.test/qq.mp3', level: '' }),
    hydrateCustomCover: (song) => song,
    restoreSourceFallbackQueueItem: (idx, originalSong) => { playQueue[idx] = originalSong; return true; },
    showSourceFallbackNotice: (title, body) => { noticed.push({ title, body }); },
    safeRenderQueuePanel: () => {},
    safeShelfRebuild: () => {},
    playQueueAt: async (idx, opts) => {
      plays.push({ idx, url: opts.preResolvedPlaybackData && opts.preResolvedPlaybackData.url, scanDepth: opts.lxSourceScanDepth, fallbackDepth: opts.fallbackDepth });
      return options.startPlayed !== false;
    },
  }, options.stubs || {}));
  sandbox.__playQueue = playQueue;
  sandbox.__noticed = noticed;
  sandbox.__plays = plays;
  return sandbox;
}

test('命中可播版本时：换成那个平台的曲目，并把播放数据直接交给播放链路', async () => {
  const sandbox = buildFallbackSandbox({});
  const song = sandbox.__playQueue[0];
  const started = await sandbox.scan.fallback(song, null, 0, 1, {}, 'lossless');

  assert.equal(started, true);
  assert.equal(sandbox.__playQueue[0].provider, 'qq', '队列条目要换成能播的那个平台版本');
  assert.equal(sandbox.__playQueue[0].lxSourceScanFrom, 'netease');
  assert.equal(sandbox.__plays.length, 1);
  assert.equal(sandbox.__plays[0].url, 'https://example.test/qq.mp3', '已经取到的地址要直接复用，别再取一次');
  assert.equal(sandbox.__plays[0].scanDepth, 1, '递归防护：换源后的那次播放要带标记');
  assert.ok(sandbox.__noticed.some((n) => n.title === '正在换音源试试'));
  assert.ok(sandbox.__noticed.some((n) => n.title === '已自动换音源'));
});

test('换过去的版本也没播起来：队列条目还原，交回既有兜底', async () => {
  const sandbox = buildFallbackSandbox({ startPlayed: false });
  const song = sandbox.__playQueue[0];
  const result = await sandbox.scan.fallback(song, null, 0, 1, {}, 'lossless');

  assert.equal(result, null, '自己没能接管就返回 null，让后面的登录平台兜底继续');
  assert.equal(sandbox.__playQueue[0].provider, 'netease', '失败后队列条目要还原');
  assert.equal(sandbox.__playQueue[0].lxSourceScanFrom, undefined);
});

test('递归防护与前置条件：换源过的播放、音源未就绪、本地曲目都不进入换源', async () => {
  const recursive = buildFallbackSandbox({});
  assert.equal(await recursive.scan.fallback(recursive.__playQueue[0], null, 0, 1, { lxSourceScanDepth: 1 }, 'lossless'), null);
  assert.equal(recursive.__plays.length, 0, '递归时不该再发起播放');

  const notReady = buildFallbackSandbox({ stubs: { userApiStatusReady: () => false } });
  assert.equal(await notReady.scan.fallback(notReady.__playQueue[0], null, 0, 1, {}, 'lossless'), null);
  assert.equal(notReady.__plays.length, 0);

  const local = buildFallbackSandbox({ songOverride: { type: 'local', provider: 'local' } });
  assert.equal(await local.scan.fallback(local.__playQueue[0], null, 0, 1, {}, 'lossless'), null);
  assert.equal(local.__plays.length, 0);

  // 取链入口没加载上时（模块被裁掉 / 加载失败），整条逻辑直接不启用
  const missingEntry = buildFallbackSandbox({ stubs: { userApiRequestPlaybackUrl: undefined } });
  assert.equal(await missingEntry.scan.fallback(missingEntry.__playQueue[0], null, 0, 1, {}, 'lossless'), null);
  assert.equal(missingEntry.__plays.length, 0);
});

test('换音源节奏：每个平台之间等 0.5 秒，命中即停', async () => {
  const sleeps = [];
  const urlCalls = [];
  const sandbox = buildScanSandbox({
    lxSourceScanSleep: async (ms) => { sleeps.push(ms); },
    lxSourceScanSearchProvider: async () => null,
    userApiRequestPlaybackUrl: async (song, provider) => {
      urlCalls.push(provider);
      return provider === 'kugou' ? { url: 'https://example.test/kugou.mp3', level: '' } : null;
    },
  });
  sandbox.__urlCalls = urlCalls;

  const song = {
    name: '晴天',
    artist: '周杰伦',
    provider: 'netease',
    lxAlternates: [
      { name: '晴天', artist: '周杰伦', provider: 'kugou', hash: 'H1' },
      { name: '晴天', artist: '周杰伦', provider: 'migu', id: 'M1' },
    ],
  };

  const hit = await sandbox.scan.findPlayable(song, 'netease', 'lossless', 1);

  assert.equal(sandbox.scan.intervalMs, 500, '间隔必须是 0.5 秒');
  // 队列是 qq → kugou → …；qq 没备选且补搜为空，kugou 命中后即停
  assert.deepEqual(urlCalls, ['kugou'], '只应真正请求到命中的那个平台');
  assert.deepEqual(sleeps, [500, 500], '每换一个平台前等一次 0.5 秒');
  assert.equal(hit.provider, 'kugou');
  assert.equal(hit.data.url, 'https://example.test/kugou.mp3');
  assert.equal(hit.song.hash, 'H1', '命中后要带上那个平台版本的曲目');
});

test('备选里没有该平台时，用歌名 + 歌手补搜一次', async () => {
  const searched = [];
  const urlCalls = [];
  const sandbox = buildScanSandbox({
    lxSourceScanSleep: async () => {},
    lxSourceScanSearchProvider: async (song, provider) => {
      searched.push(`${provider}:${song.name} ${song.artist}`);
      return provider === 'qq' ? { name: '晴天', artist: '周杰伦', provider: 'qq', mid: 'QQ1' } : null;
    },
    userApiRequestPlaybackUrl: async (song, provider) => {
      urlCalls.push(provider);
      return { url: 'https://example.test/qq.mp3', level: '' };
    },
  });

  const song = { name: '晴天', artist: '周杰伦', provider: 'netease', id: 'N1' };
  const hit = await sandbox.scan.findPlayable(song, 'netease', 'lossless', 1);

  assert.deepEqual(searched, ['qq:晴天 周杰伦'], '补搜只发生在队列里第一个平台');
  assert.deepEqual(urlCalls, ['qq']);
  assert.equal(hit.provider, 'qq');
});

test('全部平台都取不到时返回 null，且每个平台都等过一次 0.5 秒', async () => {
  const sleeps = [];
  const urlCalls = [];
  const sandbox = buildScanSandbox({
    lxSourceScanSleep: async (ms) => { sleeps.push(ms); },
    lxSourceScanSearchProvider: async (song, provider) => ({ name: '晴天', artist: '周杰伦', provider }),
    userApiRequestPlaybackUrl: async (song, provider) => { urlCalls.push(provider); return null; },
  });

  const song = { name: '晴天', artist: '周杰伦', provider: 'netease', id: 'N1' };
  const hit = await sandbox.scan.findPlayable(song, 'netease', 'lossless', 1);

  assert.equal(hit, null);
  // 队列：qq kugou kuwo migu（qishui 没有 LX 音源平台，不入队）
  assert.deepEqual(urlCalls, ['qq', 'kugou', 'kuwo', 'migu']);
  assert.equal(sleeps.length, 4, '每换一个平台前等一次');
  assert.ok(sleeps.every((ms) => ms === 500));
});

test('切歌（token 变化）后立刻放弃换源', async () => {
  const sandbox = buildScanSandbox({
    lxSourceScanSleep: async () => { sandbox.trackSwitchToken = 99; },
    lxSourceScanSearchProvider: async (song, provider) => ({ name: '晴天', artist: '周杰伦', provider }),
    userApiRequestPlaybackUrl: async () => ({ url: 'https://example.test/x.mp3' }),
  });
  const song = { name: '晴天', artist: '周杰伦', provider: 'netease', id: 'N1' };
  const hit = await sandbox.scan.findPlayable(song, 'netease', 'lossless', 1);
  assert.equal(hit, null, 'token 变了就不该再继续试');
});

test('平台队列只留能搜又能被音源取链的 LX 五家，并去掉当前平台', () => {
  const sandbox = buildScanSandbox();
  // 队列是 vm realm 里的数组，跨 realm 比原型会挂，转成字符串比
  const queueOf = (box, provider) => box.scan.providerQueue(provider).join(',');
  assert.equal(queueOf(sandbox, 'netease'), 'qq,kugou,kuwo,migu');
  assert.equal(queueOf(sandbox, 'migu'), 'netease,qq,kugou,kuwo');
  assert.ok(sandbox.scan.providerQueue('netease').indexOf('qishui') < 0, '汽水没有音源平台，不入队');

  // 音源脚本不支持某平台时，该平台要被剔除
  const limited = buildScanSandbox({ userApiSupports: (lxSource) => lxSource !== 'tx' });
  assert.equal(queueOf(limited, 'netease'), 'kugou,kuwo,migu');

  assert.equal(sandbox.scan.maxProviders, 5);
});

test('播放链路两处失败点都接了换源试播，并且不会递归换源', () => {
  assert.match(playbackSource, /if \(!data \|\| !data\.url\) \{[\s\S]{0,420}tryLxSourceScanFallback\(song, data, idx, token, retryPlaybackOpts, requestedQuality\)/);
  assert.match(
    playbackSource,
    /var lxMediaScan = typeof tryLxSourceScanFallback === 'function'[\s\S]{0,300}reason: 'media_start_failed' \}\),[\s\S]{0,200}requestedQuality\s*\)/
  );
  assert.match(playbackSource, /var lxScanFallback = typeof tryLxSourceScanFallback === 'function'[\s\S]{0,240}if \(lxScanFallback !== null\) return lxScanFallback === true;[\s\S]{0,240}await tryAutoPlaybackFallback/);
  // 换源试播要排在「已登录平台兜底」前面：音源不需要登录，先试它更划算
  assert.ok(playbackSource.indexOf('var lxScanFallback') < playbackSource.indexOf('var fallbackResult = await tryAutoPlaybackFallback'));
  assert.ok(playbackSource.indexOf('var lxMediaScan') < playbackSource.indexOf('var mediaFailureFallback = await tryAutoPlaybackFallback'));
  assert.match(scanSource, /if \(opts\.lxSourceScanDepth > 0\) return null;/);
  assert.match(scanSource, /lxSourceScanDepth: 1,/);
});

test('搜索结果合并时把同曲的其它平台版本留成备选', () => {
  const limitLine = /var LX_SEARCH_ALTERNATE_LIMIT = \d+;/.exec(searchSource);
  assert.ok(limitLine, 'missing LX_SEARCH_ALTERNATE_LIMIT');
  const sandbox = { songProviderKey: (song) => String((song && song.provider) || ''), searchProviderLxSource: (p) => (['netease', 'qq', 'kugou', 'kuwo', 'migu'].indexOf(p) >= 0 ? p : '') };
  vm.runInNewContext([
    limitLine[0],
    namedFunctionSource(searchSource, 'searchAlternateRecord'),
    namedFunctionSource(searchSource, 'collectSearchAlternate'),
    'this.record = searchAlternateRecord; this.collect = collectSearchAlternate; this.limit = LX_SEARCH_ALTERNATE_LIMIT;',
  ].join('\n'), sandbox);

  const target = { name: '晴天', artist: '周杰伦', provider: 'netease', id: 'N1', _searchScore: 90 };
  sandbox.collect(target, { name: '晴天', artist: '周杰伦', provider: 'kugou', hash: 'H1', _searchScore: 40, lxAlternates: [{ provider: 'x' }] });
  // 同平台不重复收
  sandbox.collect(target, { name: '晴天', artist: '周杰伦', provider: 'kugou', hash: 'H2' });
  // 汽水换过去也拿不到音源链接，不收
  sandbox.collect(target, { name: '晴天', artist: '周杰伦', provider: 'qishui', id: 'Q1' });
  // 自己这个平台不收
  sandbox.collect(target, { name: '晴天', artist: '周杰伦', provider: 'netease', id: 'N9' });

  assert.equal(target.lxAlternates.length, 1);
  assert.equal(target.lxAlternates[0].provider, 'kugou');
  assert.equal(target.lxAlternates[0].hash, 'H1');
  assert.equal(target.lxAlternates[0].lxAlternates, undefined, '备选里不该再嵌一层备选');
  assert.equal(target.lxAlternates[0]._searchScore, undefined, '备选里不该带搜索得分');

  assert.match(searchSource, /function mergeSongSearchResults[\s\S]{0,1400}collectSearchAlternate\(song, previous\)/);
  assert.match(searchSource, /function mergeUniqueSearchSongPools[\s\S]{0,900}collectSearchAlternate\(canonicalSeen\[canonicalKey\], song\)/);
});

test('11a 模块已注册进加载清单，且排在 11-provider-fallback 之后', () => {
  const fallbackAt = loaderSource.indexOf("'js/modules/05-playback/11-provider-fallback.js'");
  const scanAt = loaderSource.indexOf("'js/modules/05-playback/11a-lx-source-scan.js'");
  assert.ok(fallbackAt > 0 && scanAt > 0, 'index-loader.js 必须同时包含两个模块');
  assert.ok(scanAt > fallbackAt, '11a 要在 11 之后加载，才能用到它的兜底函数');
});
