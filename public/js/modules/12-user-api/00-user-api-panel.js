/* ====================================================================
 *  自定义音源面板 + 播放链路适配
 *
 *  这个模块把 lx-music-mobile 的「自定义源」能力接到 Mineradio 上：
 *    - 面板：导入 / 选择 / 删除 / 看日志（走 preload 暴露的 IPC）
 *    - 播放：把当前曲目交给选中的音源换一个可播放地址
 *    - 歌词：内置歌词拿不到时，向音源要一份
 *
 *  脚本本体跑在 Electron 主进程的 worker 沙箱里（desktop/user-api/），
 *  这里只负责 UI 和 HTTP 调用。
 * ==================================================================== */

var MINERADIO_USER_API_MODE_KEY = 'mineradio.userApiMode';
var MINERADIO_USER_API_STATUS_CACHE = null;
var MINERADIO_USER_API_LOG_OPEN = true;
var MINERADIO_USER_API_BUSY = false;
var MINERADIO_USER_API_NOTICE_TIMER = null;
var MINERADIO_USER_API_LOG_TIMER = null;

/* ---------- 运行模式（关闭 / 兜底 / 优先） ---------- */

function userApiPlaybackMode() {
  var value = '';
  try { value = localStorage.getItem(MINERADIO_USER_API_MODE_KEY) || ''; } catch (e) { value = ''; }
  // 默认「优先使用」：LX 音源是播放内容的主要来源，内置取链只在音源拿不到时兜底
  if (value === 'off' || value === 'fallback' || value === 'prefer') return value;
  return 'prefer';
}

function userApiSetPlaybackMode(mode) {
  var next = mode === 'off' || mode === 'prefer' ? mode : 'fallback';
  try { localStorage.setItem(MINERADIO_USER_API_MODE_KEY, next); } catch (e) {}
  renderUserApiModeSegment();
  renderUserApiStatusLine();
  return next;
}

function renderUserApiModeSegment() {
  var current = userApiPlaybackMode();
  var buttons = document.querySelectorAll('#user-api-mode-seg [data-user-api-mode]');
  for (var i = 0; i < buttons.length; i++) {
    var button = buttons[i];
    if (button.getAttribute('data-user-api-mode') === current) button.classList.add('active');
    else button.classList.remove('active');
  }
}

/* ---------- 平台映射 ---------- */

/** Mineradio 的播放平台 -> LX 音源平台标识；返回空串表示没有对应音源类型 */
function userApiLxSourceForProvider(provider) {
  switch (String(provider || '').toLowerCase()) {
    case 'netease': return 'wy';
    case 'qq': return 'tx';
    case 'kugou': return 'kg';
    case 'kuwo': return 'kw';
    case 'migu': return 'mg';
    default: return '';
  }
}

function userApiProviderKeyOf(song) {
  if (!song) return '';
  if (typeof songProviderKey === 'function') {
    try { return songProviderKey(song) || ''; } catch (e) {}
  }
  return String(song.provider || song.source || 'netease').toLowerCase();
}

/** 当前曲目对应的音源平台标识，没有的话返回空串 */
function userApiLxSourceOf(song) {
  return userApiLxSourceForProvider(userApiProviderKeyOf(song));
}

/* ---------- 状态缓存 ---------- */

function userApiStatusSnapshot() {
  return MINERADIO_USER_API_STATUS_CACHE || null;
}

function userApiStatusReady() {
  var cache = MINERADIO_USER_API_STATUS_CACHE;
  // 缓存里放的是主进程 getStatus() 的整包返回：
  //   { activeId, active, status: { status: true, message }, sources, list, ... }
  // 「有没有就绪」看的是 status.status，别再往下多剥一层
  // （多剥一层会永远拿到 undefined，取链被静默跳过，酷我/咪咕就没有内置接口可兜底了）。
  return !!(cache && cache.status && cache.status.status === true);
}

function userApiActiveName() {
  var cache = MINERADIO_USER_API_STATUS_CACHE;
  if (!cache) return '';
  if (cache.active && cache.active.name) return cache.active.name;
  return cache.activeName || '';
}

/** 音源是否声明支持某平台的某个动作 */
function userApiSupports(lxSource, action) {
  var cache = MINERADIO_USER_API_STATUS_CACHE;
  if (!cache || !cache.sources || !lxSource) return false;
  var entry = cache.sources[lxSource];
  if (!entry) return false;
  var actions = entry.actions || [];
  for (var i = 0; i < actions.length; i++) {
    if (actions[i] === action) return true;
  }
  return false;
}

function applyUserApiStatus(payload) {
  if (payload && payload.status) MINERADIO_USER_API_STATUS_CACHE = payload.status;
  else if (payload && payload.ok === false) MINERADIO_USER_API_STATUS_CACHE = null;
  renderUserApiPanel();
}

function refreshUserApiPanel() {
  if (!window.desktopWindow || typeof window.desktopWindow.getUserApiStatus !== 'function') {
    applyUserApiStatus({ ok: false });
    return Promise.resolve();
  }
  return window.desktopWindow.getUserApiStatus().then(function (payload) {
    applyUserApiStatus(payload || { ok: false });
    return refreshUserApiLogs();
  }).catch(function () {
    applyUserApiStatus({ ok: false });
  });
}

function refreshUserApiLogs() {
  if (!window.desktopWindow || typeof window.desktopWindow.getUserApiLogs !== 'function') return Promise.resolve();
  return window.desktopWindow.getUserApiLogs().then(function (payload) {
    renderUserApiLogs(payload && payload.ok ? payload.logs : []);
  }).catch(function () {});
}

/* ---------- 面板渲染 ---------- */

function userApiSetText(id, value) {
  var node = document.getElementById(id);
  if (node) node.textContent = value == null ? '' : String(value);
}

function renderUserApiStatusLine() {
  var cache = MINERADIO_USER_API_STATUS_CACHE;
  var node = document.getElementById('user-api-status');
  if (!node) return;
  var modeLabel = userApiPlaybackMode() === 'off'
    ? '已关闭自定义音源'
    : (userApiPlaybackMode() === 'prefer' ? '优先使用自定义音源' : '内置取链失败时用自定义音源兜底');
  var status = cache && cache.status ? cache.status : null;
  var pieces = [modeLabel];
  if (!status) pieces.push('状态读取失败');
  else if (status.status === true) pieces.push('已就绪：' + (status.message || '初始化成功'));
  else pieces.push(status.message || '未启用');
  if (cache && cache.updateAlert && cache.updateAlert.log) {
    pieces.push('音源提示新版本：' + String(cache.updateAlert.log).slice(0, 60));
  }
  node.textContent = pieces.join(' · ');
}

function renderUserApiList() {
  var host = document.getElementById('user-api-list');
  if (!host) return;
  var cache = MINERADIO_USER_API_STATUS_CACHE;
  var list = cache && cache.list ? cache.list : [];
  var activeId = cache && cache.activeId ? cache.activeId : '';
  host.innerHTML = '';
  if (!list.length) {
    var empty = document.createElement('div');
    empty.className = 'user-api-empty';
    empty.textContent = '还没有导入音源。点上面的「在线导入」或「本地导入」加一个。';
    host.appendChild(empty);
    return;
  }
  for (var i = 0; i < list.length; i++) {
    host.appendChild(buildUserApiRow(list[i], list[i].id === activeId));
  }
}

function buildUserApiRow(entry, isActive) {
  var row = document.createElement('div');
  row.className = 'user-api-row' + (isActive ? ' active' : '');

  var main = document.createElement('div');
  main.className = 'user-api-row-main';

  var title = document.createElement('div');
  title.className = 'user-api-row-title';
  title.textContent = entry.name || '未命名音源';
  main.appendChild(title);

  var meta = document.createElement('div');
  meta.className = 'user-api-row-meta';
  var bits = [];
  if (entry.version) bits.push('v' + entry.version);
  if (entry.author) bits.push(entry.author);
  if (entry.allowShowUpdateAlert === false) bits.push('已关闭更新提示');
  meta.textContent = bits.join(' · ') || '本地脚本';
  main.appendChild(meta);

  if (entry.description) {
    var desc = document.createElement('div');
    desc.className = 'user-api-row-desc';
    desc.textContent = entry.description;
    main.appendChild(desc);
  }

  row.appendChild(main);

  var actions = document.createElement('div');
  actions.className = 'user-api-row-act';

  var selectButton = document.createElement('button');
  selectButton.type = 'button';
  selectButton.className = 'fx-mini-btn ghost';
  selectButton.textContent = isActive ? '已启用' : '启用';
  selectButton.disabled = isActive;
  selectButton.onclick = function () { selectUserApiSource(entry.id); };
  actions.appendChild(selectButton);

  var removeButton = document.createElement('button');
  removeButton.type = 'button';
  removeButton.className = 'fx-mini-btn ghost';
  removeButton.textContent = '删除';
  removeButton.onclick = function () { removeUserApiSource(entry.id, entry.name); };
  actions.appendChild(removeButton);

  var alertButton = document.createElement('button');
  alertButton.type = 'button';
  alertButton.className = 'fx-mini-btn ghost';
  var alertOn = entry.allowShowUpdateAlert !== false;
  alertButton.textContent = alertOn ? '更新提示开' : '更新提示关';
  alertButton.title = alertOn ? '点击后不再显示该音源的新版本提示' : '点击后恢复该音源的新版本提示';
  alertButton.onclick = function () { toggleUserApiUpdateAlert(entry.id, !alertOn); };
  actions.appendChild(alertButton);

  row.appendChild(actions);
  return row;
}

function renderUserApiPanel() {
  var cache = MINERADIO_USER_API_STATUS_CACHE;
  var list = cache && cache.list ? cache.list : [];
  var maxSources = cache && cache.maxSources ? cache.maxSources : 20;
  var activeName = userApiActiveName();
  userApiSetText('user-api-active-name', activeName ? ('当前：' + activeName) : '当前：未启用');
  userApiSetText('user-api-count', list.length + ' / ' + maxSources);
  renderUserApiModeSegment();
  renderUserApiStatusLine();
  renderUserApiList();
  var busy = document.getElementById('user-api-busy');
  if (busy) busy.hidden = !MINERADIO_USER_API_BUSY;
  var urlInput = userApiUrlInput();
  if (urlInput) urlInput.disabled = !!MINERADIO_USER_API_BUSY;
  var urlButton = document.getElementById('user-api-url-import');
  if (urlButton) urlButton.disabled = !!MINERADIO_USER_API_BUSY;
}

function renderUserApiLogs(logs) {
  var node = document.getElementById('user-api-log');
  if (!node) return;
  var rows = Array.isArray(logs) ? logs : [];
  if (!rows.length) {
    node.textContent = '暂无脚本日志。';
    return;
  }
  var lines = [];
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i] || {};
    var time = '';
    try { time = new Date(Number(row.time) || 0).toLocaleTimeString(); } catch (e) { time = ''; }
    lines.push('[' + time + '][' + String(row.level || 'log') + '] ' + String(row.message == null ? '' : row.message));
  }
  node.textContent = lines.join('\n');
  node.scrollTop = node.scrollHeight;
}

/* ---------- 面板操作 ---------- */

function userApiFlash(message, tone) {
  var node = document.getElementById('user-api-notice');
  if (!node) return;
  node.textContent = message || '';
  node.className = 'user-api-notice' + (tone ? ' ' + tone : '');
  if (MINERADIO_USER_API_NOTICE_TIMER) clearTimeout(MINERADIO_USER_API_NOTICE_TIMER);
  MINERADIO_USER_API_NOTICE_TIMER = setTimeout(function () {
    node.textContent = '';
    node.className = 'user-api-notice';
  }, 6000);
}

function userApiUrlInput() {
  return document.getElementById('user-api-url');
}

function importUserApiFromUrl() {
  if (!window.desktopWindow || typeof window.desktopWindow.importUserApi !== 'function') {
    userApiFlash('仅桌面版支持自定义音源', 'error');
    return;
  }
  // 注意：Electron 的渲染进程里 window.prompt / window.alert 之外的 prompt 会直接抛
  // 「prompt() is not supported.」，所以这里必须用面板里的输入框拿链接。
  var input = userApiUrlInput();
  if (!input) {
    userApiFlash('找不到在线导入输入框，请刷新页面后重试', 'error');
    return;
  }
  var url = String(input.value || '').trim();
  if (!url) {
    userApiFlash('请先粘贴音源脚本的直链', 'error');
    input.focus();
    return;
  }
  if (!/^https?:\/\//i.test(url)) {
    userApiFlash('链接必须以 http:// 或 https:// 开头', 'error');
    input.focus();
    return;
  }
  if (MINERADIO_USER_API_BUSY) return;
  userApiImportByUrl(url);
}

function userApiImportByUrl(url) {
  MINERADIO_USER_API_BUSY = true;
  renderUserApiPanel();
  userApiFlash('正在下载并加载音源...');
  return window.desktopWindow.importUserApi({ url: url }).then(function (result) {
    MINERADIO_USER_API_BUSY = false;
    if (!result || result.ok !== true) {
      refreshUserApiPanel();
      userApiFlash('导入失败：' + ((result && result.error) || '未知错误'), 'error');
      return;
    }
    var input = userApiUrlInput();
    if (input) input.value = '';
    if (result.status) applyUserApiStatus({ status: result.status });
    refreshUserApiLogs();
    var name = result.info && result.info.name ? result.info.name : '音源';
    userApiFlash('已导入「' + name + '」，正在初始化...');
    return refreshUserApiPanel();
  }).catch(function (error) {
    MINERADIO_USER_API_BUSY = false;
    renderUserApiPanel();
    userApiFlash('导入失败：' + ((error && error.message) || '未知错误'), 'error');
  });
}

function importUserApiFromFile() {
  if (!window.desktopWindow || typeof window.desktopWindow.importUserApiFile !== 'function') {
    userApiFlash('仅桌面版支持自定义音源', 'error');
    return;
  }
  MINERADIO_USER_API_BUSY = true;
  renderUserApiPanel();
  window.desktopWindow.importUserApiFile().then(function (result) {
    MINERADIO_USER_API_BUSY = false;
    if (!result || result.ok !== true) {
      renderUserApiPanel();
      if (result && result.canceled) return;
      userApiFlash('导入失败：' + ((result && result.error) || '未知错误'), 'error');
      return;
    }
    if (result.canceled) {
      renderUserApiPanel();
      return;
    }
    applyUserApiStatus({ status: result.status });
    refreshUserApiLogs();
    var name = result.info && result.info.name ? result.info.name : '音源';
    userApiFlash('已导入「' + name + '」，正在初始化...');
    return refreshUserApiPanel();
  }).catch(function (error) {
    MINERADIO_USER_API_BUSY = false;
    renderUserApiPanel();
    userApiFlash('导入失败：' + ((error && error.message) || '未知错误'), 'error');
  });
}

function selectUserApiSource(id) {
  if (!window.desktopWindow || typeof window.desktopWindow.selectUserApi !== 'function') return;
  MINERADIO_USER_API_BUSY = true;
  renderUserApiPanel();
  userApiFlash('正在切换音源...');
  window.desktopWindow.selectUserApi(id).then(function (result) {
    MINERADIO_USER_API_BUSY = false;
    if (result && result.status) applyUserApiStatus({ status: result.status });
    refreshUserApiLogs();
    if (!result || result.ok !== true) {
      userApiFlash('启用失败：' + ((result && result.error) || '未知错误'), 'error');
      return;
    }
    userApiFlash('音源已启用');
  }).catch(function (error) {
    MINERADIO_USER_API_BUSY = false;
    renderUserApiPanel();
    userApiFlash('启用失败：' + ((error && error.message) || '未知错误'), 'error');
  });
}

function removeUserApiSource(id, name) {
  if (!window.desktopWindow || typeof window.desktopWindow.removeUserApi !== 'function') return;
  if (!window.confirm('删除音源「' + (name || '未命名') + '」？脚本会从本地数据目录移除。')) return;
  MINERADIO_USER_API_BUSY = true;
  renderUserApiPanel();
  window.desktopWindow.removeUserApi(id).then(function (result) {
    MINERADIO_USER_API_BUSY = false;
    if (result && result.status) applyUserApiStatus({ status: result.status });
    if (!result || result.ok !== true) {
      userApiFlash('删除失败：' + ((result && result.error) || '未知错误'), 'error');
      return;
    }
    userApiFlash('音源已删除');
    return refreshUserApiPanel();
  }).catch(function (error) {
    MINERADIO_USER_API_BUSY = false;
    renderUserApiPanel();
    userApiFlash('删除失败：' + ((error && error.message) || '未知错误'), 'error');
  });
}

function toggleUserApiUpdateAlert(id, enabled) {
  if (!window.desktopWindow || typeof window.desktopWindow.setUserApiAllowUpdateAlert !== 'function') return;
  window.desktopWindow.setUserApiAllowUpdateAlert(id, enabled).then(function (result) {
    if (result && result.status) applyUserApiStatus({ status: result.status });
    if (!result || result.ok !== true) {
      userApiFlash('设置失败：' + ((result && result.error) || '未知错误'), 'error');
      return;
    }
    userApiFlash(enabled ? '已恢复该音源的更新提示' : '已关闭该音源的更新提示');
    return refreshUserApiPanel();
  }).catch(function (error) {
    userApiFlash('设置失败：' + ((error && error.message) || '未知错误'), 'error');
  });
}

function toggleUserApiLog() {
  MINERADIO_USER_API_LOG_OPEN = !MINERADIO_USER_API_LOG_OPEN;
  var node = document.getElementById('user-api-log');
  var button = document.getElementById('user-api-log-toggle');
  if (node) node.hidden = !MINERADIO_USER_API_LOG_OPEN;
  if (button) button.textContent = MINERADIO_USER_API_LOG_OPEN ? '收起' : '展开';
}

function clearUserApiLogs() {
  if (!window.desktopWindow || typeof window.desktopWindow.clearUserApiLogs !== 'function') return;
  window.desktopWindow.clearUserApiLogs().then(function (payload) {
    renderUserApiLogs(payload && payload.ok ? payload.logs : []);
  }).catch(function () {});
}

function openUserApiDataDir() {
  if (!window.desktopWindow || typeof window.desktopWindow.openUserApiDataDir !== 'function') return;
  window.desktopWindow.openUserApiDataDir();
}

/* ---------- 播放链路适配 ---------- */

/**
 * 把 Mineradio 的曲目拼成自定义音源端点认识的查询串。
 * 字段结构对齐 lx-music-mobile 的 toOldMusicInfo()，几处 id 兜底多带一份。
 */
function userApiPlaybackQuery(song, quality) {
  var provider = userApiProviderKeyOf(song);
  var lxSource = userApiLxSourceForProvider(provider);
  if (!lxSource) return null;
  var parts = [];
  var push = function (key, value) {
    if (value == null || value === '') return;
    parts.push(key + '=' + encodeURIComponent(String(value)));
  };
  var hash = song.hash || song.fileHash || song.audioHash || '';
  var songId = song.id != null ? song.id : (song.songmid != null ? song.songmid : '');
  push('provider', provider);
  push('lxSource', lxSource);
  push('quality', quality);
  if (lxSource === 'kg') {
    push('hash', hash || songId);
    push('songmid', hash || songId);
  } else {
    push('songmid', songId || song.mid || hash);
  }
  push('songId', song.qqId || song.songId || songId);
  push('albumMid', song.albumMid || song.album_mid || '');
  push('mediaMid', song.mediaMid || song.strMediaMid || song.albumMediaMid || '');
  push('name', song.name || song.title || '');
  push('singer', song.singer || song.artist || song.artists || '');
  push('albumName', song.albumName || song.album || '');
  push('albumId', song.albumId || song.album_id || '');
  var interval = Number(song.interval || song.duration || 0);
  push('interval', interval ? Math.round(interval) : '');
  push('img', song.pic || song.picUrl || song.cover || song.img || '');
  var qualitys = song.qualitys || song.types || [];
  if (qualitys && qualitys.length) push('qualitys', JSON.stringify(qualitys));
  return parts.join('&');
}

/**
 * 优先模式用：先问自定义音源要链接，拿不到就返回 null 让内置接口继续。
 * 任何失败都只记一条日志，不打断播放。
 */
async function userApiResolvePreferredData(song, provider, quality) {
  if (userApiPlaybackMode() !== 'prefer') return null;
  return userApiRequestPlaybackUrl(song, provider, quality, '优先');
}

/**
 * 兜底模式用：内置接口没拿到可用地址时再问自定义音源。
 */
async function userApiResolveFallbackData(song, provider, quality) {
  if (userApiPlaybackMode() !== 'fallback') return null;
  return userApiRequestPlaybackUrl(song, provider, quality, '兜底');
}

async function userApiRequestPlaybackUrl(song, provider, quality, reason) {
  if (!userApiStatusReady()) {
    console.warn('[UserApi] 音源还没就绪，跳过' + reason + '取链');
    return null;
  }
  var lxSource = userApiLxSourceOf(song);
  if (!lxSource) {
    console.warn('[UserApi] ' + userApiProviderKeyOf(song) + ' 没有对应的音源平台，跳过' + reason + '取链');
    return null;
  }
  if (!userApiSupports(lxSource, 'musicUrl')) {
    console.warn('[UserApi] 当前音源不支持平台 ' + lxSource + '，跳过' + reason);
    return null;
  }
  var query = userApiPlaybackQuery(song, quality);
  if (!query) return null;
  try {
    var result = await apiJson('/api/user-api/song/url?' + query, { timeoutMs: 12000 });
    if (!result || result.ok !== true || !result.url) {
      console.warn('[UserApi] ' + reason + '取链失败：' + ((result && result.error) || '无可用链接'));
      return null;
    }
    console.log('[UserApi] ' + reason + '取链成功 source=' + lxSource + ' quality=' + (result.quality || quality || ''));
    return {
      url: result.url,
      // level 留空：内置接口的音质档位和音源脚本的不是一套，填上会误报「音质降级」
      level: '',
      source: 'user-api',
      provider: 'user-api',
      sourceMatch: false,
      userApi: true,
      userApiSource: lxSource,
      userApiQuality: result.quality || quality || '',
      userApiName: userApiActiveName(),
    };
  } catch (error) {
    console.warn('[UserApi] ' + reason + '取链异常：' + ((error && error.message) || error));
    return null;
  }
}

/**
 * 歌词：自定义音源声明支持 lyric 时，优先用它（歌词和播放源同源，滚动更对得上）。
 * 只在「这首歌确实是走自定义源播的」或「优先模式」下才启用，避免给每首歌
 * 都多打一次请求。
 * @returns {Promise<null|{lyric:string,tlyric:string,source:string}>}
 */
async function userApiFetchLyricResponse(song) {
  var mode = userApiPlaybackMode();
  if (mode === 'off') return null;
  if (!userApiStatusReady() || !song) return null;
  if (mode === 'fallback' && song.playbackSource !== 'user-api') return null;
  var lxSource = userApiLxSourceOf(song);
  if (!lxSource || !userApiSupports(lxSource, 'lyric')) return null;
  var query = userApiPlaybackQuery(song, '');
  if (!query) return null;
  try {
    var result = await apiJson('/api/user-api/song/lyric?' + query, { timeoutMs: 9000 });
    if (!result || result.ok !== true || !result.lyric) return null;
    return {
      lyric: result.lyric || '',
      tlyric: result.translation || '',
      source: 'user-api',
    };
  } catch (error) {
    return null;
  }
}

/* ---------- 启动 ---------- */

function bindUserApiPanelEvents() {
  var segment = document.getElementById('user-api-mode-seg');
  if (segment && !segment.__mineradioBound) {
    segment.__mineradioBound = true;
    segment.addEventListener('click', function (event) {
      var target = event.target && event.target.closest ? event.target.closest('[data-user-api-mode]') : null;
      if (!target) return;
      userApiSetPlaybackMode(target.getAttribute('data-user-api-mode'));
    });
  }
  var urlInput = userApiUrlInput();
  if (urlInput && !urlInput.__mineradioBound) {
    urlInput.__mineradioBound = true;
    // 粘贴完直接回车就走导入，省掉一次点按钮
    urlInput.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.keyCode !== 13) return;
      event.preventDefault();
      importUserApiFromUrl();
    });
  }
}

function initMineradioUserApiPanel() {
  bindUserApiPanelEvents();
  renderUserApiModeSegment();
  renderUserApiStatusLine();
  if (window.desktopWindow && typeof window.desktopWindow.onUserApiStatus === 'function') {
    window.desktopWindow.onUserApiStatus(function (status) {
      applyUserApiStatus({ status: status });
      refreshUserApiLogs();
    });
  }
  refreshUserApiPanel();
  MINERADIO_USER_API_LOG_TIMER = setInterval(refreshUserApiLogs, 4000);
}

setTimeout(initMineradioUserApiPanel, 600);
