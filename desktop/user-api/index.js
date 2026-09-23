// ====================================================================
//  index.js — 自定义音源模块门面
//
//  server.js（HTTP 取链）和 desktop/main.js（IPC 面板操作）都从这里拿
//  UserApiManager 单例，保证「面板里选的源」就是「播放时用的源」。
// ====================================================================
'use strict';

const { UserApiStore, resolveDataDir, MAX_SOURCES, MAX_SCRIPT_LENGTH } = require('./store');
const { UserApiManager, getUserApiManager: getSingleton, resetUserApiManager } = require('./manager');

let manager = null;

function getUserApiManager() {
  if (!manager) manager = getSingleton();
  return manager;
}

function destroyUserApiManager() {
  if (manager) manager.destroy();
  manager = null;
  resetUserApiManager();
}

/** Mineradio 的播放平台 -> LX 音源平台标识 */
function mapProviderToLxSource(provider) {
  switch (String(provider || '').toLowerCase()) {
    case 'netease':
    case 'wy':
      return 'wy';
    case 'qq':
    case 'tx':
      return 'tx';
    case 'kugou':
    case 'kg':
      return 'kg';
    case 'kuwo':
    case 'kw':
      return 'kw';
    case 'migu':
    case 'mg':
      return 'mg';
    default:
      return '';
  }
}

/**
 * 把 Mineradio 的曲目/查询参数转成 LX 音源脚本认识的 musicInfo。
 * 字段结构对齐 lx-music-mobile 的 toOldMusicInfo()：
 *   { name, singer, source, songmid, interval, albumName, img, typeUrl,
 *     albumId, types, _types, [hash](kg), [strMediaMid/albumMid/songId](tx) }
 * 为了兼容各家音源的取值习惯，几处 id 字段会同时补齐。
 */
function buildMusicInfo(input) {
  const params = input || {};
  const lxSource = params.lxSource || mapProviderToLxSource(params.provider || params.source);
  const songid = params.songmid != null ? params.songmid : params.id;
  const hash = params.hash || params.fileHash || params.audioHash || '';
  const songmid = String(
    lxSource === 'kg' ? hash || songid || '' : songid != null ? songid : hash || ''
  );
  const info = {
    name: String(params.name || ''),
    singer: String(params.singer || params.artist || ''),
    source: lxSource,
    songmid,
    interval: Number(params.interval || 0) || 0,
    albumName: String(params.albumName || params.album || ''),
    img: String(params.img || params.pic || ''),
    typeUrl: {},
    albumId: String(params.albumId || ''),
    types: Array.isArray(params.qualitys) ? params.qualitys : [],
    _types: params._qualitys && typeof params._qualitys === 'object' ? params._qualitys : {},
    // 兜底字段：不同音源脚本取值习惯不一样，多带一份没坏处
    hash: hash || (lxSource === 'kg' ? songmid : ''),
    songId: String(params.songId != null ? params.songId : songid != null ? songid : ''),
    albumMid: String(params.albumMid || ''),
    strMediaMid: String(params.strMediaMid || params.mediaMid || ''),
    copyrightId: String(params.copyrightId || ''),
    meta: {
      id: params.songId != null ? params.songId : songid,
      songId: String(params.songId != null ? params.songId : songid != null ? songid : ''),
      albumName: String(params.albumName || ''),
      albumId: String(params.albumId || ''),
      picUrl: String(params.img || ''),
      hash: hash || '',
      strMediaMid: String(params.strMediaMid || params.mediaMid || ''),
    },
  };
  if (lxSource === 'kg') info.hash = hash || songmid;
  return info;
}

/**
 * 播放链路用：为一首歌解析自定义源链接
 * @returns {Promise<{url: string, quality: string, lxSource: string}>}
 */
async function resolveUrlForTrack(input) {
  const params = input || {};
  const instance = getUserApiManager();
  if (!instance.isReady()) throw new Error('自定义源未就绪');
  const lxSource = params.lxSource || mapProviderToLxSource(params.provider || params.source);
  if (!lxSource) throw new Error('该平台没有对应的音源类型');
  if (!instance.supportsSource(lxSource, 'musicUrl')) {
    throw new Error('当前音源不支持平台 ' + lxSource);
  }
  const musicInfo = params.musicInfo || buildMusicInfo(Object.assign({}, params, { lxSource }));
  const quality = params.quality || instance.pickQuality(lxSource);
  const result = await instance.getMusicUrl(lxSource, musicInfo, quality);
  return { url: result.url, quality: result.quality || quality, lxSource };
}

module.exports = {
  getUserApiManager,
  destroyUserApiManager,
  resolveDataDir,
  UserApiStore,
  UserApiManager,
  MAX_SOURCES,
  MAX_SCRIPT_LENGTH,
  mapProviderToLxSource,
  buildMusicInfo,
  resolveUrlForTrack,
};
