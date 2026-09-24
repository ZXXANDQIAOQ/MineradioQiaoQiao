/* ====================================================================
 *  多平台逐一试播（换的是「播放平台」，不是「音源脚本」）
 *
 *  背景：同一首《晴天》在网易云 / QQ / 酷狗 / 酷我 / 咪咕 都有条目，
 *  但某些平台某些歌取不到可播放地址（版权、音质档位、音源脚本支持范围）。
 *  用户点了发现放不出来，是最伤的体验。
 *
 *  这里的做法：
 *    自始至终用的是同一个音源脚本，只是让它换一个平台去取链接 ——
 *    当前平台取不到地址（或地址拿到了、媒体却起不来）时，
 *    按固定顺序换去其它平台，每隔 0.5 秒试一个，
 *    第一个能取到链接的就用它播，并把队列里的条目换成那个平台版本。
 *
 *  候选从哪来：
 *    1. 搜索结果合并时顺手留下的同曲其它平台版本（零额外请求）
 *    2. 没留到时，用「歌名 + 歌手」在目标平台补搜一次
 *
 *  取链一律走同一个自定义音源（/api/user-api/song/url），
 *  所以「音源脚本没就绪」或「音源模式关掉」时整条逻辑直接不启用。
 * ==================================================================== */

/** 换下一个平台之前等多久（用户要求的节奏：0.5 秒） */
var LX_PLATFORM_SCAN_INTERVAL_MS = 500;
/** 最多往下试几个平台，避免卡太久 */
var LX_PLATFORM_SCAN_MAX_PROVIDERS = 5;
var LX_PLATFORM_SCAN_SEARCH_TIMEOUT_MS = 6500;
/** 兜底顺序：MUSIC_SEARCH_PROVIDER_ORDER 不在时的静态副本 */
var LX_PLATFORM_SCAN_FALLBACK_ORDER = ['netease', 'qq', 'kugou', 'kuwo', 'migu'];

function lxPlatformScanSleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/** 音源模式关掉、或音源脚本没就绪时，换平台试播没有意义（取链要经过它） */
function lxPlatformScanEnabled() {
  if (typeof userApiPlaybackMode === 'function' && userApiPlaybackMode() === 'off') return false;
  // 取链入口来自 12-user-api 面板模块；万一没加载上，宁可整条逻辑不启用
  if (typeof userApiRequestPlaybackUrl !== 'function') return false;
  return typeof userApiStatusReady === 'function' && userApiStatusReady();
}

function lxPlatformScanProviderLabel(provider) {
  if (typeof sourceFallbackProviderTitle === 'function') return sourceFallbackProviderTitle(provider);
  return String(provider || '');
}

/**
 * 这个平台既要搜得到，音源脚本也得声明能取链，才值得排队去试。
 * 两边都满足才有意义：搜不到就没 id 可取，音源脚本不支持就注定失败。
 */
function lxPlatformScanProviderUsable(provider) {
  provider = normalizePlaybackProvider(provider);
  if (!provider) return false;
  var lxSource = typeof searchProviderLxSource === 'function' ? searchProviderLxSource(provider) : '';
  if (!lxSource) return false;
  if (typeof userApiSupports === 'function' && !userApiSupports(lxSource, 'musicUrl')) return false;
  if (typeof searchProviderCanSearch === 'function' && !searchProviderCanSearch(provider)) return false;
  return true;
}

/** 要依次去试的平台队列（去掉当前平台，去重，限量） */
function lxPlatformScanProviderQueue(currentProvider) {
  var order = (typeof MUSIC_SEARCH_PROVIDER_ORDER !== 'undefined' && MUSIC_SEARCH_PROVIDER_ORDER && MUSIC_SEARCH_PROVIDER_ORDER.length)
    ? MUSIC_SEARCH_PROVIDER_ORDER
    : LX_PLATFORM_SCAN_FALLBACK_ORDER;
  var out = [];
  order.forEach(function (provider) {
    provider = normalizePlaybackProvider(provider);
    if (!provider || provider === currentProvider) return;
    if (out.indexOf(provider) >= 0) return;
    if (!lxPlatformScanProviderUsable(provider)) return;
    out.push(provider);
  });
  return out.slice(0, LX_PLATFORM_SCAN_MAX_PROVIDERS);
}

function lxPlatformScanAlternates(song) {
  if (!song || !song.lxAlternates || !song.lxAlternates.length) return [];
  return song.lxAlternates.slice();
}

/** 平台 -> 搜索时留下的那个备选版本 */
function lxPlatformScanAlternateMap(song) {
  var map = {};
  lxPlatformScanAlternates(song).forEach(function (alternate) {
    var provider = normalizePlaybackProvider(songProviderKey(alternate));
    if (!provider || map[provider]) return;
    map[provider] = alternate;
  });
  return map;
}

function lxPlatformScanKeyword(song) {
  if (!song) return '';
  var artist = '';
  if (typeof artistNameParts === 'function') {
    var parts = artistNameParts(song);
    artist = (parts && parts[0]) || '';
  }
  if (!artist) artist = String(song.artist || '');
  return [String(song.name || song.title || ''), artist].filter(Boolean).join(' ').trim();
}

/** 备选里没有该平台时，用歌名 + 歌手补搜一次 */
async function lxPlatformScanSearchProvider(song, provider) {
  var keyword = lxPlatformScanKeyword(song);
  var lxSource = typeof searchProviderLxSource === 'function' ? searchProviderLxSource(provider) : '';
  if (!keyword || !lxSource) return null;
  try {
    var data = await apiJson(
      '/api/lx/search?source=' + encodeURIComponent(lxSource) + '&keywords=' + encodeURIComponent(keyword) + '&limit=8',
      { timeoutMs: LX_PLATFORM_SCAN_SEARCH_TIMEOUT_MS }
    );
    var list = (data && data.songs) || [];
    for (var i = 0; i < list.length; i += 1) {
      var candidate = list[i];
      if (!candidate) continue;
      if (typeof isSameTitleArtist === 'function' && !isSameTitleArtist(song, candidate)) continue;
      return typeof cloneSong === 'function' ? cloneSong(candidate) : Object.assign({}, candidate);
    }
  } catch (error) {
    console.warn('[LxPlatformScan] 补搜 ' + provider + ' 失败：' + ((error && error.message) || error));
  }
  return null;
}

/**
 * 按 0.5 秒间隔依次去其它平台取链，命中就返回那个平台的曲目 + 播放数据。
 * 全部失败返回 null（调用方再走既有的登录平台兜底 / 提示）。
 *
 * 注意：换的只是「拿哪个平台的 id 去问音源脚本要链接」，音源脚本本身不换。
 */
async function lxPlatformScanFindPlayable(song, currentProvider, quality, token) {
  var providers = lxPlatformScanProviderQueue(currentProvider);
  if (!providers.length) return null;
  var alternateMap = lxPlatformScanAlternateMap(song);
  for (var index = 0; index < providers.length; index += 1) {
    var provider = providers[index];
    if (token != null && token !== trackSwitchToken) return null;
    // 用户要的节奏：当前平台不行，等 0.5 秒再换下一个平台
    await lxPlatformScanSleep(LX_PLATFORM_SCAN_INTERVAL_MS);
    if (token != null && token !== trackSwitchToken) return null;
    var candidateSong = alternateMap[provider] || await lxPlatformScanSearchProvider(song, provider);
    if (!candidateSong) continue;
    if (token != null && token !== trackSwitchToken) return null;
    console.log('[LxPlatformScan] 试第 ' + (index + 1) + '/' + providers.length + ' 个平台：' +
      lxPlatformScanProviderLabel(provider));
    var candidateData = await userApiRequestPlaybackUrl(candidateSong, provider, quality, '换平台');
    if (token != null && token !== trackSwitchToken) return null;
    if (candidateData && candidateData.url) {
      console.log('[LxPlatformScan] ' + lxPlatformScanProviderLabel(currentProvider) + ' → ' +
        lxPlatformScanProviderLabel(provider) + ' 找到可播放版本');
      return { provider: provider, song: candidateSong, data: candidateData };
    }
  }
  return null;
}

/**
 * 播放链路入口。跟 tryAutoPlaybackFallback 一样的约定：
 *   true  = 已经换成别的平台并播起来了
 *   false = 换平台过程中用户切了歌（调用方应直接返回）
 *   null  = 这里没能接管（没候选 / 都没取到），交给后面的逻辑继续
 */
async function tryLxPlatformScanFallback(song, data, idx, token, opts, requestedQuality) {
  opts = opts || {};
  // 递归防护：换平台后的那次播放再失败就不再往下扫了
  if (opts.lxPlatformScanDepth > 0) return null;
  if (!lxPlatformScanEnabled()) return null;
  if (!song || !song.name) return null;
  if (song.type === 'local' || song.source === 'local' || song.localUrl) return null;
  if (song.type === 'podcast' || song.source === 'podcast') return null;
  if (song.type === 'spotify' || song.source === 'spotify') return null;
  if (opts.albumGaplessHandoff) return null;

  var currentProvider = normalizePlaybackProvider(songProviderKey(song));
  var providers = lxPlatformScanProviderQueue(currentProvider);
  if (!providers.length) return null;

  if (!opts.startupAutoplay) {
    showSourceFallbackNotice(
      '当前平台放不了，正在换平台试试',
      (song.name || '这首歌') + ' 在 ' + lxPlatformScanProviderLabel(currentProvider) +
        ' 取不到可播放地址，按 ' + providers.map(lxPlatformScanProviderLabel).join(' → ') +
        ' 的顺序换平台试，每个间隔 0.5 秒（音源脚本不变）。'
    );
  }

  var hit = await lxPlatformScanFindPlayable(song, currentProvider, requestedQuality, token);
  if (token !== trackSwitchToken) return false;
  if (!hit) return null;

  var hasQueueSlot = idx >= 0 && idx < playQueue.length;
  var originalSong = hasQueueSlot ? playQueue[idx] : null;
  var committedSong = typeof hydrateCustomCover === 'function'
    ? hydrateCustomCover(Object.assign({}, hit.song))
    : Object.assign({}, hit.song);
  committedSong.autoFallbackFrom = currentProvider;
  committedSong.lxPlatformScanFrom = currentProvider;
  if (hasQueueSlot) {
    playQueue[idx] = committedSong;
    if (typeof safeRenderQueuePanel === 'function') {
      safeRenderQueuePanel('lx-platform-scan', { scrollCurrent: typeof miniQueueOpen !== 'undefined' && miniQueueOpen });
    }
    if (typeof safeShelfRebuild === 'function') safeShelfRebuild('lx-platform-scan');
  }

  var scanOpts = Object.assign({}, opts, {
    lxPlatformScanDepth: 1,
    fallbackDepth: 1,
    suppressPlayFailureNotice: true,
    preResolvedPlaybackData: hit.data,
    fallbackOriginalSong: originalSong,
    fallbackCandidateSong: committedSong
  });
  var started = await playQueueAt(idx, scanOpts);
  if (token !== trackSwitchToken) return false;
  if (started === true) {
    if (!opts.startupAutoplay) {
      showSourceFallbackNotice(
        '已自动切换平台',
        (song.name || '当前歌曲') + ' 已从 ' + lxPlatformScanProviderLabel(currentProvider) +
          ' 换到 ' + lxPlatformScanProviderLabel(hit.provider) + ' 播放（还是同一个音源脚本）。'
      );
    }
    return true;
  }
  // 换过去的版本也没播起来，把队列条目还原
  if (hasQueueSlot && originalSong && typeof restoreSourceFallbackQueueItem === 'function') {
    restoreSourceFallbackQueueItem(idx, originalSong, committedSong, trackSwitchToken);
  }
  return null;
}
