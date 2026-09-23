// ====================================================================
//  index.js — LX 搜索层出口
//
//  把 lx-music-mobile 的五个内置音源搜索（wy / tx / kg / kw / mg）接进来，
//  统一换算成 Mineradio 的曲目结构，供 server.js 的 /api/lx/search 使用。
//
//  搜索实现（请求参数、加密签名、字段映射）与 LX 保持一致，
//  只在这里做「LX 曲目 → Mineradio 曲目」的字段搬运，不做排序/过滤改写。
//  移植自 lx-music-mobile（Apache-2.0）。
// ====================================================================
'use strict';

const { playTimeToSeconds } = require('./format');

const SOURCES = [
  { id: 'kw', name: '酷我音乐', provider: 'kuwo', short: 'KW' },
  { id: 'kg', name: '酷狗音乐', provider: 'kugou', short: 'KG' },
  { id: 'tx', name: 'QQ音乐', provider: 'qq', short: 'QQ' },
  { id: 'wy', name: '网易音乐', provider: 'netease', short: 'NE' },
  { id: 'mg', name: '咪咕音乐', provider: 'migu', short: 'MG' },
];

/** LX 音源标识 → Mineradio 的 provider 键 */
const PROVIDER_BY_SOURCE = SOURCES.reduce((acc, item) => {
  acc[item.id] = item.provider;
  return acc;
}, {});

/** Mineradio 的 provider 键 → LX 音源标识 */
const SOURCE_BY_PROVIDER = SOURCES.reduce((acc, item) => {
  acc[item.provider] = item.id;
  return acc;
}, {});

const SOURCE_ALIASES = {
  wy: 'wy', netease: 'wy', ne: 'wy', '网易云': 'wy', '网易音乐': 'wy',
  tx: 'tx', qq: 'tx', 'qq音乐': 'tx',
  kg: 'kg', kugou: 'kg', '酷狗': 'kg', '酷狗音乐': 'kg',
  kw: 'kw', kuwo: 'kw', '酷我': 'kw', '酷我音乐': 'kw',
  mg: 'mg', migu: 'mg', '咪咕': 'mg', '咪咕音乐': 'mg',
};

/** 把 panel / URL 里传来的音源标识归一化 */
function normalizeSource(source) {
  const key = String(source == null ? '' : source).trim().toLowerCase();
  return SOURCE_ALIASES[key] || '';
}

function loadSource(id) {
  // 按需 require：某个平台挂了不影响其它平台
  switch (id) {
    case 'wy': return require('./sources/wy');
    case 'tx': return require('./sources/tx');
    case 'kg': return require('./sources/kg');
    case 'kw': return require('./sources/kw');
    case 'mg': return require('./sources/mg');
    default: return null;
  }
}

function durationMs(item) {
  if (item && item._interval) return Math.max(0, Math.round(Number(item._interval))) * 1000;
  return playTimeToSeconds(item && item.interval) * 1000;
}

function typesOf(item) {
  return Array.isArray(item && item.types) ? item.types : [];
}

function hashOf(item, level) {
  const types = item && item._types;
  const entry = types && types[level];
  return (entry && entry.hash) || '';
}

/**
 * LX 曲目 → Mineradio 曲目。
 * 字段命名对齐 Mineradio 现有的各平台映射（mapSongRecord / mapQQTrack /
 * mapKugouSearchItem），这样搜索列表、右键菜单、播放取链都不用改。
 */
function toMineradioSong(sourceId, item) {
  const provider = PROVIDER_BY_SOURCE[sourceId] || sourceId;
  const songmid = item && item.songmid != null ? String(item.songmid) : '';
  const song = {
    provider,
    source: provider,
    type: provider === 'netease' ? 'song' : provider,
    lxSource: sourceId,
    id: songmid,
    songmid,
    name: item && item.name ? String(item.name) : '',
    artist: item && item.singer ? String(item.singer) : '',
    artists: item && item.singer ? String(item.singer).split('、').map(name => ({ name })) : [],
    album: item && item.albumName ? String(item.albumName) : '',
    albumId: item && item.albumId != null ? String(item.albumId) : '',
    cover: (item && item.img) || '',
    duration: durationMs(item),
    interval: Math.round(durationMs(item) / 1000),
    qualitys: typesOf(item),
    _qualitys: (item && item._types) || {},
  };

  if (provider === 'qq') {
    song.mid = songmid;
    song.qqId = item && item.songId != null ? String(item.songId) : '';
    song.mediaMid = (item && item.strMediaMid) || '';
    song.strMediaMid = song.mediaMid;
    song.albumMid = (item && item.albumMid) || '';
  } else if (provider === 'kugou') {
    song.hash = (item && item.hash) || '';
    song.fileHash = song.hash;
    song.hqHash = hashOf(item, '320k');
    song.sqHash = hashOf(item, 'flac');
    song.resHash = hashOf(item, 'flac24bit');
  } else if (provider === 'migu') {
    song.songId = songmid;
    song.copyrightId = (item && item.copyrightId) || '';
  }

  return song;
}

// LX 的音源按「页码」翻页，而且各家返回的每页条数不一定等于请求值
// （咪咕会一次给两倍）。这里按 (音源, 关键词, limit) 缓存已取过的页，
// 再把连续拼起来的列表当作一个窗口，用 offset/limit 精确切片。
const WINDOW_CACHE_MAX_KEYS = 8;
const WINDOW_CACHE_MAX_PAGES = 6;
const WINDOW_MAX_PAGES_PER_CALL = 5;
const windowCache = new Map();

function windowCacheEntry(sourceId, keyword, limit) {
  const key = `${sourceId}|${keyword}|${limit}`;
  let entry = windowCache.get(key);
  if (!entry) {
    entry = { pages: new Map() };
    windowCache.set(key, entry);
    if (windowCache.size > WINDOW_CACHE_MAX_KEYS) {
      windowCache.delete(windowCache.keys().next().value);
    }
  }
  return entry;
}

async function fetchSourcePage(mod, entry, keyword, page, limit) {
  if (entry.pages.has(page)) return entry.pages.get(page);
  const result = await mod.search(keyword, page, limit);
  const data = {
    list: Array.isArray(result && result.list) ? result.list : [],
    total: Math.max(0, Number(result && result.total) || 0),
  };
  entry.pages.set(page, data);
  if (entry.pages.size > WINDOW_CACHE_MAX_PAGES) {
    entry.pages.delete(entry.pages.keys().next().value);
  }
  return data;
}

/**
 * 搜索一个 LX 音源。
 * @param {string} source wy|tx|kg|kw|mg
 * @param {string} keywords
 * @param {{limit?:number, offset?:number}} [options]
 * @returns {Promise<{source:string, provider:string, songs:Array, limit:number, offset:number, total:number, hasMore:boolean}>}
 */
async function search(source, keywords, options) {
  const id = normalizeSource(source);
  if (!id) throw new Error('不支持的音源：' + source);
  const keyword = String(keywords == null ? '' : keywords).trim();
  if (!keyword) throw new Error('搜索关键词不能为空');

  const opts = options || {};
  const limit = Math.max(1, Math.min(50, Math.trunc(Number(opts.limit)) || 20));
  const offset = Math.max(0, Math.trunc(Number(opts.offset)) || 0);

  const mod = loadSource(id);
  if (!mod || typeof mod.search !== 'function') throw new Error('音源实现缺失：' + id);

  const entry = windowCacheEntry(id, keyword, limit);
  const wanted = offset + limit;
  const items = [];
  let total = 0;
  let page = 1;
  while (items.length < wanted && page <= WINDOW_MAX_PAGES_PER_CALL) {
    const data = await fetchSourcePage(mod, entry, keyword, page, limit);
    total = total || data.total;
    if (!data.list.length) break;
    items.push(...data.list);
    page += 1;
  }

  const songs = items
    .slice(offset, offset + limit)
    .map(item => toMineradioSong(id, item))
    .filter(song => song.name);

  return {
    source: id,
    provider: PROVIDER_BY_SOURCE[id],
    songs,
    limit,
    offset,
    total,
    hasMore: songs.length >= limit,
  };
}

module.exports = {
  SOURCES,
  PROVIDER_BY_SOURCE,
  SOURCE_BY_PROVIDER,
  normalizeSource,
  toMineradioSong,
  search,
};
