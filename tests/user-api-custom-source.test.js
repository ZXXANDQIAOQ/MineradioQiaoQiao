'use strict';

/*
 * 自定义音源（移植自 lx-music-mobile）回归测试。
 *
 * 覆盖范围为「纯 node 可跑」的部分，不联网、不起 Electron：
 *   · 脚本元信息注释块的解析与长度上限
 *   · 导入即生效、取链、音质挑选
 *   · 未声明动作被拒绝（lyric / pic 白名单）
 *   · 初始化抛错的源会被标记为失败
 *   · 移除生效中的源会回退到列表里的下一个
 *   · 在线导入只接受 http/https
 *   · 在线导入把 GitHub / Gitee 网页链接纠正成直链、识别网页响应
 *   · 音源面板在线导入不依赖 Electron 不支持的 window.prompt
 *   · 音源数量上限
 *   · Mineradio provider 与 LX musicInfo 的字段映射
 *
 * 端到端的 HTTP 端点与面板交互由以下两处覆盖（需要真实运行时，不放进本文件）：
 *   · desktop/user-api/selftest.js（沙箱自检）
 *   · scripts/quick-check.js full（Electron 冒烟）
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { UserApiStore, MAX_SOURCES } = require('../desktop/user-api/store');
const { UserApiManager, normalizeSourceUrl, looksLikeHtml } = require('../desktop/user-api/manager');
const userApiFacade = require('../desktop/user-api');

const DEFAULT_SOURCES = {
  wy: {
    name: '测试·网易云',
    type: 'music',
    actions: ['musicUrl'],
    qualitys: ['128k', '320k'],
  },
};

function makeDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-user-api-'));
}

/**
 * 生成一个符合 LX 2.0.0 契约的音源脚本。
 * 返回值直接在本机拼字符串返回，不依赖任何外部接口。
 */
function buildScript(options) {
  const opt = options || {};
  const declared = opt.sources || DEFAULT_SOURCES;
  const lines = [
    '/*!',
    ' * @name ' + (opt.name || '测试音源'),
    ' * @version ' + (opt.version || '1.0.0'),
    ' * @author ' + (opt.author || 'unittest'),
  ];
  if (opt.homepage) lines.push(' * @homepage ' + opt.homepage);
  lines.push(' * @description ' + (opt.description || '单元测试用音源'));
  lines.push(' */');
  lines.push('const { EVENT_NAMES, on, send } = globalThis.lx;');
  if (opt.initError) lines.push('throw new Error(' + JSON.stringify(opt.initError) + ');');
  lines.push('on(EVENT_NAMES.request, ({ source, action, info }) => {');
  lines.push("  if (action === 'musicUrl') {");
  lines.push('    const detail = info || {};');
  lines.push('    const musicInfo = detail.musicInfo || {};');
  lines.push("    const id = musicInfo.songmid || musicInfo.hash || musicInfo.songId || '';");
  lines.push('    return Promise.resolve(');
  lines.push("      'http://127.0.0.1:1/audio/' + source + '/' + encodeURIComponent(id) + '?q=' + (detail.type || ''));");
  lines.push('  }');
  // 注意：LX 契约里 lyric 必须返回对象（preload 的 verifyLyricInfo 会校验
  // typeof info == 'object' 且 info.lyric 是字符串），返回纯字符串会被判失败。
  lines.push("  if (action === 'lyric') return Promise.resolve({ lyric: '[00:01.00]测试歌词', tlyric: '[00:01.00]test lyric' });");
  lines.push("  if (action === 'pic') return Promise.resolve('http://127.0.0.1:1/pic.jpg');");
  lines.push("  return Promise.reject(new Error('action not support: ' + action));");
  lines.push('});');
  lines.push('send(EVENT_NAMES.inited, { status: true, sources: ' + JSON.stringify(declared) + ' });');
  return lines.join('\n');
}

function withManager(task) {
  const manager = new UserApiManager({ dataDir: makeDataDir() });
  return Promise.resolve()
    .then(() => task(manager))
    .finally(() => manager.destroy());
}

test('脚本元信息按注释块解析，超长字段按上限截断', () => {
  const store = new UserApiStore(makeDataDir());
  const longName = '名'.repeat(60);

  const info = store.parseScriptInfo(buildScript({ name: longName, homepage: 'https://example.com/x' }));
  assert.equal(info.name, '名'.repeat(24) + '...');
  assert.equal(info.version, '1.0.0');
  assert.equal(info.author, 'unittest');
  assert.equal(info.homepage, 'https://example.com/x');

  assert.equal(store.parseScriptInfo('console.log("no header")'), null);
  assert.throws(() => store.importScript('console.log("no header")'), /无效的自定义源文件/);
  assert.throws(() => store.importScript('   '), /无效的自定义源文件/);
});

test('导入音源后自动生效，并能取回脚本给出的播放链接', async () => {
  await withManager(async (manager) => {
    const info = await manager.importScript(buildScript());

    assert.match(info.id, /^user_api_[a-z0-9]+_\d+$/);
    assert.equal(manager.isReady(), true);
    assert.equal(manager.getStatus().active.name, info.name);
    assert.deepEqual(Object.keys(manager.getStatus().sources), ['wy']);
    assert.deepEqual(manager.qualitysFor('wy'), ['128k', '320k']);
    assert.equal(manager.pickQuality('wy'), '320k');
    assert.equal(manager.supportsSource('wy', 'musicUrl'), true);
    assert.equal(manager.supportsSource('tx', 'musicUrl'), false);

    const result = await manager.getMusicUrl('wy', { songmid: '1974443814' });
    assert.equal(result.url, 'http://127.0.0.1:1/audio/wy/1974443814?q=320k');
    assert.equal(result.quality, '320k');

    // 音质显式指定时按指定值请求
    const lower = await manager.getMusicUrl('wy', { songmid: '1974443814' }, '128k');
    assert.equal(lower.url, 'http://127.0.0.1:1/audio/wy/1974443814?q=128k');
  });
});

test('只声明 musicUrl 的源不会响应 lyric / pic', async () => {
  await withManager(async (manager) => {
    await manager.importScript(buildScript());
    await assert.rejects(() => manager.getLyric('wy', { songmid: '1' }), /不支持歌词/);
    await assert.rejects(() => manager.getPic('wy', { songmid: '1' }), /不支持封面/);
  });
});

test('声明了 lyric / pic 的源可以取歌词与封面', async () => {
  await withManager(async (manager) => {
    await manager.importScript(
      buildScript({
        name: '带歌词的源',
        sources: {
          wy: {
            name: '测试·网易云',
            type: 'music',
            actions: ['musicUrl', 'lyric', 'pic'],
            qualitys: ['128k'],
          },
        },
      })
    );

    const lyric = await manager.getLyric('wy', { songmid: '1' });
    assert.equal(lyric.lyric, '[00:01.00]测试歌词');
    assert.equal(lyric.tlyric, '[00:01.00]test lyric');
    assert.equal(await manager.getPic('wy', { songmid: '1' }), 'http://127.0.0.1:1/pic.jpg');
  });
});

test('lyric 返回纯字符串（不符合 LX 契约）会被判为失败', async () => {
  await withManager(async (manager) => {
    // preload 的 verifyLyricInfo 要求 { lyric: string }，这里刻意违反
    const script = buildScript({
      name: '歌词契约不符的源',
      sources: {
        wy: { name: '测试', type: 'music', actions: ['musicUrl', 'lyric'], qualitys: ['128k'] },
      },
    }).replace(
      "return Promise.resolve({ lyric: '[00:01.00]测试歌词', tlyric: '[00:01.00]test lyric' });",
      "return Promise.resolve('[00:01.00]测试歌词');"
    );

    await manager.importScript(script);
    await assert.rejects(() => manager.getLyric('wy', { songmid: '1' }), /failed/);
  });
});

test('初始化抛错的脚本会被标记为失败且不可用', async () => {
  await withManager(async (manager) => {
    const info = await manager.importScript(buildScript({ name: '坏掉的源', initError: 'boom in init' }));

    const status = manager.getStatus();
    assert.equal(manager.isReady(), false);
    assert.equal(status.status.status, false);
    assert.match(status.status.message, /boom in init/);
    assert.equal(manager.store.find(info.id).lastStatus, 'failed');
    assert.match(manager.store.find(info.id).lastError, /boom in init/);
    await assert.rejects(() => manager.getMusicUrl('wy', { songmid: '1' }), /未就绪/);
  });
});

test('移除生效中的音源会回退到列表里的下一个', async () => {
  await withManager(async (manager) => {
    const first = await manager.importScript(buildScript({ name: '源A' }));
    const second = await manager.importScript(buildScript({ name: '源B' }));

    await manager.setActive(second.id);
    assert.equal(manager.getStatus().activeId, second.id);

    const removed = await manager.remove(second.id);
    assert.equal(removed.removed, true);
    assert.equal(manager.getStatus().activeId, first.id);
    assert.equal(manager.isReady(), true);
    assert.match((await manager.getMusicUrl('wy', { songmid: '2' })).url, /\/audio\/wy\/2\?/);

    await manager.setActive('');
    assert.equal(manager.isReady(), false);
    assert.equal(manager.getStatus().activeId, '');
  });
});

test('在线导入只接受 http/https 链接', async () => {
  await withManager(async (manager) => {
    await assert.rejects(() => manager.importFromUrl('ftp://example.com/a.js'), /http/);
    await assert.rejects(() => manager.importFromUrl('file:///tmp/a.js'), /http/);
    await assert.rejects(() => manager.importFromUrl(''), /http/);
  });
});

test('在线导入会把代码托管页链接纠正成直链', () => {
  assert.equal(
    normalizeSourceUrl('https://github.com/foo/bar/blob/main/sources/test.js'),
    'https://raw.githubusercontent.com/foo/bar/main/sources/test.js'
  );
  assert.equal(
    normalizeSourceUrl('https://gitee.com/foo/bar/blob/master/a.js'),
    'https://gitee.com/foo/bar/raw/master/a.js'
  );
  assert.equal(
    normalizeSourceUrl('  https://raw.githubusercontent.com/a/b/main/c.js  '),
    'https://raw.githubusercontent.com/a/b/main/c.js'
  );
  assert.equal(normalizeSourceUrl('https://example.com/a.js?t=1'), 'https://example.com/a.js?t=1');
  assert.equal(normalizeSourceUrl(''), '');
});

test('在线导入按纠正后的直链发起请求，脚本能正常入库', async () => {
  let requested = '';
  const manager = new UserApiManager({
    dataDir: makeDataDir(),
    fetch: async (url) => {
      requested = url;
      return { ok: true, status: 200, text: async () => buildScript({ name: '在线音源' }) };
    },
  });
  try {
    const info = await manager.importFromUrl('https://github.com/a/b/blob/main/c.js');
    assert.equal(requested, 'https://raw.githubusercontent.com/a/b/main/c.js');
    assert.equal(info.name, '在线音源');
    assert.equal(manager.isReady(), true);
  } finally {
    manager.destroy();
  }
});

test('在线导入遇到网页响应、HTTP 错误时给出可读提示', async () => {
  const htmlManager = new UserApiManager({
    dataDir: makeDataDir(),
    fetch: async () => ({ ok: true, status: 200, text: async () => '<!DOCTYPE html>\n<html lang="zh">' }),
  });
  try {
    await assert.rejects(() => htmlManager.importFromUrl('https://example.com/a.js'), /网页而不是脚本/);
    assert.equal(htmlManager.getStatus().list.length, 0);
  } finally {
    htmlManager.destroy();
  }

  const notFoundManager = new UserApiManager({
    dataDir: makeDataDir(),
    fetch: async () => ({ ok: false, status: 404, text: async () => '' }),
  });
  try {
    await assert.rejects(() => notFoundManager.importFromUrl('https://example.com/404.js'), /HTTP 404/);
  } finally {
    notFoundManager.destroy();
  }

  assert.equal(looksLikeHtml('<html>'), true);
  assert.equal(looksLikeHtml('  <!doctype HTML>'), true);
  assert.equal(looksLikeHtml('/*! @name 音源 */'), false);
  assert.equal(looksLikeHtml(''), false);
});

test('在线导入走真实 HTTP 下载（本机回环服务）', async () => {
  const script = buildScript({ name: '回环音源' });
  const server = http.createServer((req, res) => {
    if (req.url === '/source.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end(script);
      return;
    }
    if (req.url === '/page.js') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!DOCTYPE html><html><body>404</body></html>');
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const manager = new UserApiManager({ dataDir: makeDataDir() });
  try {
    const info = await manager.importFromUrl(`http://127.0.0.1:${port}/source.js`);
    assert.equal(info.name, '回环音源');
    assert.equal(manager.isReady(), true);
    assert.equal(manager.getStatus().list.length, 1);
    await assert.rejects(() => manager.importFromUrl(`http://127.0.0.1:${port}/missing.js`), /HTTP 404/);
    await assert.rejects(() => manager.importFromUrl(`http://127.0.0.1:${port}/page.js`), /网页而不是脚本/);
    assert.equal(manager.getStatus().list.length, 1);
  } finally {
    manager.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('音源面板的在线导入走输入框，不依赖 Electron 不支持的 window.prompt', () => {
  const panelPath = path.join(__dirname, '..', 'public', 'js', 'modules', '12-user-api', '00-user-api-panel.js');
  const panel = fs.readFileSync(panelPath, 'utf8');
  assert.doesNotMatch(panel, /window\.prompt\s*\(/);
  assert.match(panel, /getElementById\('user-api-url'\)/);
  assert.match(panel, /importUserApi\(\{ url: url \}\)/);

  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /id="user-api-url"[^>]*>/);
  assert.match(html, /id="user-api-url-import"[^>]*onclick="importUserApiFromUrl\(\)"/);
});

test('同时存在的音源数量上限为 MAX_SOURCES', () => {
  const store = new UserApiStore(makeDataDir());
  for (let i = 0; i < MAX_SOURCES; i += 1) {
    store.importScript(buildScript({ name: '源' + i }));
  }
  assert.equal(store.list().length, MAX_SOURCES);
  assert.throws(() => store.importScript(buildScript({ name: '超限' })), /最多只能同时存在/);
});

test('Mineradio provider 与 LX musicInfo 字段映射符合脚本取值习惯', () => {
  assert.equal(userApiFacade.mapProviderToLxSource('netease'), 'wy');
  assert.equal(userApiFacade.mapProviderToLxSource('QQ'), 'tx');
  assert.equal(userApiFacade.mapProviderToLxSource('kugou'), 'kg');
  assert.equal(userApiFacade.mapProviderToLxSource('kuwo'), 'kw');
  assert.equal(userApiFacade.mapProviderToLxSource('migu'), 'mg');
  assert.equal(userApiFacade.mapProviderToLxSource('spotify'), '');

  // 酷狗：脚本按 hash 取歌，songmid 与 hash 都要给到
  const kg = userApiFacade.buildMusicInfo({
    provider: 'kugou',
    hash: 'HASH123',
    name: '歌曲',
    singer: '歌手',
    qualitys: ['320k'],
  });
  assert.equal(kg.source, 'kg');
  assert.equal(kg.songmid, 'HASH123');
  assert.equal(kg.hash, 'HASH123');
  assert.deepEqual(kg.types, ['320k']);

  // QQ：songmid / songId / mediaMid 三件套
  const tx = userApiFacade.buildMusicInfo({
    provider: 'qq',
    songmid: '001QuXxx',
    songId: '123456',
    mediaMid: 'M500xxx',
    albumMid: '002Album',
    interval: 240,
  });
  assert.equal(tx.source, 'tx');
  assert.equal(tx.songmid, '001QuXxx');
  assert.equal(tx.songId, '123456');
  assert.equal(tx.strMediaMid, 'M500xxx');
  assert.equal(tx.albumMid, '002Album');
  assert.equal(tx.interval, 240);
  assert.equal(tx.meta.id, '123456');
});

test('音源音质档位：内置档位翻译成脚本标识，并按脚本声明的能力退让', async () => {
  const manager = new UserApiManager({ store: new UserApiStore(makeDataDir()) });
  manager.runtime = {
    inited: true,
    sources: { kg: { type: 'music', actions: ['musicUrl'], qualitys: ['128k', '320k', 'flac'] } },
    canHandle: () => true,
    request: async (payload) => {
      manager.__lastRequest = payload;
      return { data: { url: 'https://example.com/a.mp3' } };
    },
  };
  manager.status = { status: true, message: 'ok' };

  // 内置档位 → 脚本标识
  assert.equal(manager.normalizeQuality('kg', 'standard'), '128k');
  assert.equal(manager.normalizeQuality('kg', 'exhigh'), '320k');
  assert.equal(manager.normalizeQuality('kg', 'lossless'), 'flac');
  // 脚本没有 flac24bit：hires / jymaster 退到 flac，而不是原样透传
  assert.equal(manager.normalizeQuality('kg', 'hires'), 'flac');
  assert.equal(manager.normalizeQuality('kg', 'jymaster'), 'flac');
  // 已经是脚本标识就原样保留；空值挑脚本最高可用
  assert.equal(manager.normalizeQuality('kg', '320k'), '320k');
  assert.equal(manager.normalizeQuality('kg', ''), 'flac');

  // 真正取链时带过去的必须是翻译后的档位
  // （曾经把 lossless 原样透传，脚本拿到的 level=undefined）
  await manager.getMusicUrl('kg', { source: 'kg', songmid: 'HASH' }, 'lossless');
  assert.equal(manager.__lastRequest.info.type, 'flac');

  // 脚本只声明到 320k 时继续往下退
  manager.runtime.sources.kg.qualitys = ['128k', '320k'];
  assert.equal(manager.normalizeQuality('kg', 'lossless'), '320k');
  assert.equal(manager.pickQuality('kg'), '320k');
});
