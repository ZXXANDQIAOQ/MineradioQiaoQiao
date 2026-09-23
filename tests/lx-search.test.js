'use strict';

/*
 * LX 在线搜索回归（desktop/lx-search，移植自 lx-music-mobile）
 *
 * 离线覆盖：
 *   · 格式化工具：sizeFormate / formatPlayTime / decodeName / formatSingerName / objStr2JSON
 *   · 加密签名：eapi 参数可解回原文、zzcSign 形状与确定性
 *   · LX 曲目 → Mineradio 曲目 的字段搬运（wy / tx / kg / kw / mg）
 *   · 搜索分页：offset 换算成「页码 + 页内偏移」
 *
 * 真实接口连通性由 scripts/check-lx-search-live.js 覆盖（需要联网）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '..');
const lxSearchRoot = path.join(appRoot, 'desktop', 'lx-search');

const format = require(path.join(lxSearchRoot, 'format'));
const { eapi, zzcSign } = require(path.join(lxSearchRoot, 'crypto'));
const lxSearch = require(lxSearchRoot);

test('格式化工具与 LX 保持一致', () => {
  assert.equal(format.sizeFormate(0), '0 B');
  assert.equal(format.sizeFormate(1024 * 1024 * 3.5), '3.50 MiB');
  assert.equal(format.formatPlayTime(223), '03:43');
  assert.equal(format.formatPlayTime(0), '--/--');
  assert.equal(format.playTimeToSeconds('03:43'), 223);
  assert.equal(format.playTimeToSeconds('1:02:03'), 3723);
  assert.equal(format.decodeName('A&amp;B &#39;x&#x27;'), "A&B 'x'");
  assert.equal(format.decodeName(''), '');
  assert.equal(format.formatSingerName([{ name: '周杰伦' }, { name: '费玉清' }]), '周杰伦、费玉清');
  assert.equal(format.formatSinger('周杰伦&费玉清'), '周杰伦、费玉清');
  assert.deepEqual(format.objStr2JSON("{'abslist': [{'SONGNAME': '晴天'}], 'TOTAL': '1'}"), {
    abslist: [{ SONGNAME: '晴天' }],
    TOTAL: '1',
  });
  assert.deepEqual(format.coerceJson('{"a":1}'), { a: 1 });
  assert.deepEqual(format.coerceJson({ a: 1 }), { a: 1 });
});

test('网易云 eapi 参数解开后是 url-分隔-md5 三段式', () => {
  const url = '/api/search/song/list/page';
  const payload = { keyword: '稻香', limit: 3, offset: 0, total: true };
  const { params } = eapi(url, payload);
  assert.match(params, /^[0-9A-F]+$/);
  assert.equal(params.length % 16, 0);

  const decipher = crypto.createDecipheriv('aes-128-ecb', Buffer.from('e82ckenh8dichen8'), null);
  const plain = Buffer.concat([decipher.update(Buffer.from(params, 'hex')), decipher.final()]).toString('utf8');
  const text = JSON.stringify(payload);
  const digest = crypto.createHash('md5').update(`nobody${url}use${text}md5forencrypt`).digest('hex');
  assert.equal(plain, `${url}-36cd479b6b5-${text}-36cd479b6b5-${digest}`);
});

test('QQ zzcSign 形状稳定且随输入变化', () => {
  const a = zzcSign('{"a":1}');
  const b = zzcSign('{"a":1}');
  const c = zzcSign('{"a":2}');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^zzc[a-z0-9]+$/);
  // 8 位 part1 + base64 段 + 8 位 part2 = 至少 17 个字符
  assert.ok(a.length > 17);
  assert.equal(a.slice(3, 11), a.slice(3, 11).toLowerCase());
});

const WY_ITEM = {
  singer: '周杰伦', name: '稻香', albumName: '魔杰座', albumId: 123,
  source: 'wy', interval: '03:43', songmid: 185809, img: 'http://p1.music.126.net/x.jpg',
  types: [{ type: '128k', size: '3.5 MiB' }, { type: 'flac', size: '20 MiB' }],
  _types: { '128k': { size: '3.5 MiB' }, flac: { size: '20 MiB' } },
};
const TX_ITEM = {
  singer: '周杰伦', name: '稻香', albumName: '魔杰座', albumId: '002Neh8l0hK7XZ', source: 'tx',
  interval: '03:43', songId: 449205, albumMid: '002Neh8l0hK7XZ', strMediaMid: '003aAYrm3GE0Ac',
  songmid: '003aAYrm3GE0Ac', img: 'https://y.gtimg.cn/music/photo_new/T002R500x500M000002Neh8l0.jpg',
  types: [{ type: '128k', size: '3.5 MiB' }], _types: { '128k': { size: '3.5 MiB' } },
};
const KG_ITEM = {
  singer: '周杰伦', name: '稻香', albumName: '魔杰座', albumId: '12345', songmid: '332453',
  source: 'kg', interval: '03:43', _interval: 223, hash: 'ABCDEF', img: null,
  types: [{ type: '128k', size: '3.5 MiB' }, { type: '320k', size: '8 MiB' }, { type: 'flac', size: '20 MiB' }],
  _types: { '128k': { size: '3.5 MiB', hash: 'ABC128' }, '320k': { size: '8 MiB', hash: 'ABC320' }, flac: { size: '20 MiB', hash: 'ABCFLAC' } },
};
const KW_ITEM = {
  singer: '周杰伦', name: '稻香', source: 'kw', songmid: '440613', albumId: '99',
  interval: '03:43', albumName: '魔杰座', img: null, types: [], _types: {},
};
const MG_ITEM = {
  singer: '周杰伦', name: '稻香', albumName: '魔杰座', albumId: '88', songmid: '697066',
  copyrightId: '60054702010', source: 'mg', interval: '03:43',
  img: 'http://d.musicapp.migu.cn/x.jpg', types: [{ type: '128k', size: '3.5 MiB' }], _types: {},
};

test('LX 曲目换算成 Mineradio 曲目：平台标识与 id 各归各位', () => {
  const wy = lxSearch.toMineradioSong('wy', WY_ITEM);
  assert.equal(wy.provider, 'netease');
  assert.equal(wy.type, 'song');
  assert.equal(wy.id, '185809');
  assert.equal(wy.duration, 223000);
  assert.equal(wy.interval, 223);
  assert.equal(wy.cover, WY_ITEM.img);
  assert.deepEqual(wy.qualitys.map(t => t.type), ['128k', 'flac']);

  const tx = lxSearch.toMineradioSong('tx', TX_ITEM);
  assert.equal(tx.provider, 'qq');
  assert.equal(tx.id, '003aAYrm3GE0Ac');
  assert.equal(tx.mid, '003aAYrm3GE0Ac');
  assert.equal(tx.qqId, '449205');
  assert.equal(tx.mediaMid, '003aAYrm3GE0Ac');
  assert.equal(tx.albumMid, '002Neh8l0hK7XZ');

  const kg = lxSearch.toMineradioSong('kg', KG_ITEM);
  assert.equal(kg.provider, 'kugou');
  assert.equal(kg.hash, 'ABCDEF');
  assert.equal(kg.fileHash, 'ABCDEF');
  assert.equal(kg.hqHash, 'ABC320');
  assert.equal(kg.sqHash, 'ABCFLAC');
  assert.equal(kg.resHash, '');
  assert.equal(kg.albumId, '12345');

  const kw = lxSearch.toMineradioSong('kw', KW_ITEM);
  assert.equal(kw.provider, 'kuwo');
  assert.equal(kw.id, '440613');
  assert.equal(kw.cover, '');

  const mg = lxSearch.toMineradioSong('mg', MG_ITEM);
  assert.equal(mg.provider, 'migu');
  assert.equal(mg.songId, '697066');
  assert.equal(mg.copyrightId, '60054702010');
  assert.equal(mg.cover, MG_ITEM.img);
});

test('音源标识归一化：面板/URL 里常见的几种写法都认', () => {
  ['wy', 'netease', 'NE', '网易云'].forEach(value => assert.equal(lxSearch.normalizeSource(value), 'wy'));
  ['tx', 'qq'].forEach(value => assert.equal(lxSearch.normalizeSource(value), 'tx'));
  ['kg', 'kugou'].forEach(value => assert.equal(lxSearch.normalizeSource(value), 'kg'));
  ['kw', 'kuwo'].forEach(value => assert.equal(lxSearch.normalizeSource(value), 'kw'));
  ['mg', 'migu'].forEach(value => assert.equal(lxSearch.normalizeSource(value), 'mg'));
  assert.equal(lxSearch.normalizeSource('spotify'), '');
  assert.equal(lxSearch.normalizeSource(''), '');
});

test('搜索结果向 Mineradio 平台双向映射齐全', () => {
  assert.equal(lxSearch.PROVIDER_BY_SOURCE.wy, 'netease');
  assert.equal(lxSearch.PROVIDER_BY_SOURCE.tx, 'qq');
  assert.equal(lxSearch.PROVIDER_BY_SOURCE.kg, 'kugou');
  assert.equal(lxSearch.PROVIDER_BY_SOURCE.kw, 'kuwo');
  assert.equal(lxSearch.PROVIDER_BY_SOURCE.mg, 'migu');
  assert.equal(lxSearch.SOURCE_BY_PROVIDER.kuwo, 'kw');
  assert.equal(lxSearch.SOURCE_BY_PROVIDER.migu, 'mg');
  assert.deepEqual(lxSearch.SOURCES.map(s => s.id), ['kw', 'kg', 'tx', 'wy', 'mg']);
});

test('分页：offset 换算成「页码 + 页内偏移」，并透出 hasMore', async () => {
  const sourcePath = require.resolve(path.join(lxSearchRoot, 'sources', 'tx.js'));
  const previous = require.cache[sourcePath];
  const calls = [];
  require.cache[sourcePath] = {
    id: sourcePath,
    filename: sourcePath,
    loaded: true,
    exports: {
      search(keyword, page, limit) {
        calls.push({ keyword, page, limit });
        return Promise.resolve({
          source: 'tx',
          total: 100,
          list: Array.from({ length: limit }, (_, index) => Object.assign({}, TX_ITEM, {
            songmid: 'mid-' + page + '-' + index,
            name: '稻香 ' + page + '-' + index,
          })),
        });
      },
    },
  };
  try {
    const first = await lxSearch.search('qq', ' 稻香 ', { limit: 10, offset: 0 });
    assert.deepEqual(calls[0], { keyword: '稻香', page: 1, limit: 10 });
    assert.equal(first.songs.length, 10);
    assert.equal(first.songs[0].provider, 'qq');
    assert.equal(first.hasMore, true);
    assert.equal(first.total, 100);

    // 窗口按「页拼接」取：offset=25 落在第 3 页末尾，需要补到第 4 页才够 10 条
    const second = await lxSearch.search('tx', '稻香', { limit: 10, offset: 25 });
    assert.equal(second.songs.length, 10);
    assert.equal(second.songs[0].id, 'mid-3-5');
    assert.equal(second.songs[4].id, 'mid-3-9');
    assert.equal(second.songs[5].id, 'mid-4-0');
    assert.equal(second.songs[9].id, 'mid-4-4');
    assert.equal(second.hasMore, true);
    // 第 1 页是上一次调用留下的缓存，这次只为 2~4 页发了请求
    assert.deepEqual(calls.slice(1), [
      { keyword: '稻香', page: 2, limit: 10 },
      { keyword: '稻香', page: 3, limit: 10 },
      { keyword: '稻香', page: 4, limit: 10 },
    ]);

    // 翻到长尾：单次调用最多拼 5 页，取不满就如实返回，不会无限翻
    const tail = await lxSearch.search('tx', '稻香', { limit: 10, offset: 900 });
    assert.equal(tail.songs.length, 0);
    assert.equal(tail.hasMore, false);
  } finally {
    if (previous) require.cache[sourcePath] = previous;
    else delete require.cache[sourcePath];
  }
});

test('搜索参数守卫：空关键词 / 未知音源直接报错，不发起请求', async () => {
  await assert.rejects(() => lxSearch.search('wy', '   '), /关键词/);
  await assert.rejects(() => lxSearch.search('spotify', '稻香'), /不支持的音源/);
});
