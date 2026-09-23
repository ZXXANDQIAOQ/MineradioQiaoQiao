// ====================================================================
//  manager.js — 自定义音源总入口
//
//  对应移动端 core/apiSource.ts + core/init/userApi/index.ts 的职责：
//    · 维护「当前生效的源」，切换时销毁旧脚本、加载新脚本
//    · 把脚本声明出来的 sources 映射成 getMusicUrl / getLyric / getPic
//    · 保存初始化状态与日志，供 UI 展示与排查
//
//  上层用法：
//    const manager = getUserApiManager()
//    await manager.init()                       // 恢复到上次选择的源
//    await manager.getMusicUrl(source, musicInfo, quality)
// ====================================================================
'use strict';

const { UserApiStore } = require('./store');
const { UserApiRuntime } = require('./runtime');

const MAX_LOGS = 300;

/** LX 音源脚本认的音质标识，从高到低 */
const LX_QUALITY_LEVELS_DESC = ['flac24bit', 'flac', '320k', '128k'];

/** Mineradio 的音质档位 → LX 音质标识（音源脚本只认右边这一套） */
const QUALITY_ALIAS = {
  standard: '128k', low: '128k', normal: '128k', '128k': '128k',
  high: '320k', exhigh: '320k', higher: '320k', '320k': '320k',
  lossless: 'flac', sq: 'flac', flac: 'flac',
  hires: 'flac24bit', 'hi-res': 'flac24bit', jymaster: 'flac24bit', master: 'flac24bit', flac24bit: 'flac24bit',
};

/**
 * 把常见的「网页版」代码链接纠正成直链。
 * 用户从浏览器地址栏复制过来的多半是 blob 页面，直接拿去 fetch 只会拿到 HTML。
 */
function normalizeSourceUrl(url) {
  let target = String(url || '').trim();
  if (!target) return target;
  const github = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/i.exec(target);
  if (github) return `https://raw.githubusercontent.com/${github[1]}/${github[2]}/${github[3]}`;
  const gitee = /^https?:\/\/(?:www\.)?gitee\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/i.exec(target);
  if (gitee) return `https://gitee.com/${gitee[1]}/${gitee[2]}/raw/${gitee[3]}`;
  return target;
}

/** 下载回来的内容是不是一个网页（而不是脚本） */
function looksLikeHtml(text) {
  const head = String(text || '').slice(0, 600).trim().toLowerCase();
  if (!head) return false;
  return head.startsWith('<!doctype html') || head.startsWith('<html') || /<html[\s>]/.test(head);
}

let singleton = null;

class UserApiManager {
  constructor(options) {
    const opts = options || {};
    this.store = opts.store || new UserApiStore(opts.dataDir);
    this.fetchImpl = typeof opts.fetch === 'function' ? opts.fetch : globalThis.fetch.bind(globalThis);
    this.runtime = null;
    this.activeId = '';
    this.status = { status: false, message: '未启用' };
    this.lastUpdateAlert = null;
    this.logs = [];
    this.listeners = new Set();
    this.switchToken = 0;
    this.initPromise = null;
  }

  /* --------------------------- 事件 --------------------------- */

  onEvent(listener) {
    if (typeof listener !== 'function') return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (_) {}
    }
  }

  pushLog(level, message) {
    const entry = { time: Date.now(), level: level || 'log', message: String(message || '') };
    this.logs.push(entry);
    if (this.logs.length > MAX_LOGS) this.logs.splice(0, this.logs.length - MAX_LOGS);
    this.emit({ type: 'log', log: entry });
  }

  getLogs() {
    return this.logs.slice();
  }

  clearLogs() {
    this.logs = [];
    return [];
  }

  /* ------------------------- 状态查询 ------------------------- */

  getStatus() {
    const entry = this.activeId ? this.store.find(this.activeId) : null;
    return {
      activeId: this.activeId,
      active: entry
        ? {
            id: entry.id,
            name: entry.name,
            version: entry.version,
            author: entry.author,
            description: entry.description,
            homepage: entry.homepage,
          }
        : null,
      status: { ...this.status },
      sources: this.runtime && this.runtime.inited ? this.runtime.sources : {},
      updateAlert: this.lastUpdateAlert || null,
      list: this.store.list(),
      dataDir: this.store.dataDir,
      maxSources: require('./store').MAX_SOURCES,
    };
  }

  /* ------------------------- 列表操作 ------------------------- */

  list() {
    return this.store.list();
  }

  getDataDir() {
    return this.store.dataDir;
  }

  async importScript(script) {
    const info = this.store.importScript(script);
    this.pushLog('info', '已导入音源：' + info.name + (info.version ? ' v' + info.version : ''));
    // 之前没有生效的源时，新导入的自动生效（对齐移动端「导入即用」的手感）
    if (!this.activeId) await this.setActive(info.id);
    this.emit({ type: 'list', list: this.store.list() });
    return info;
  }

  async importFromUrl(url) {
    const target = normalizeSourceUrl(url);
    if (!/^https?:\/\//i.test(target)) throw new Error('请输入 http/https 开头的链接');
    const response = await this.fetchImpl(target, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        Accept: 'text/plain, application/javascript, */*',
      },
      redirect: 'follow',
    });
    if (!response || !response.ok) {
      throw new Error('下载失败：HTTP ' + (response ? response.status : '??'));
    }
    const text = await response.text();
    if (looksLikeHtml(text)) {
      throw new Error('这个链接返回的是网页而不是脚本，请改用脚本文件的直链（raw / jsDelivr）');
    }
    return this.importScript(text);
  }

  async importFromFile(filePath) {
    const fs = require('node:fs');
    const text = fs.readFileSync(filePath, 'utf8');
    return this.importScript(text);
  }

  async remove(id) {
    const result = this.store.remove(id);
    if (result.removed) {
      this.pushLog('info', '已移除音源：' + id);
      if (this.activeId === id) {
        await this.setActive(result.activeId || '');
      }
    }
    this.emit({ type: 'list', list: this.store.list() });
    return result;
  }

  setAllowShowUpdateAlert(id, enabled) {
    const entry = this.store.setAllowShowUpdateAlert(id, enabled);
    this.emit({ type: 'list', list: this.store.list() });
    return entry;
  }

  /* ------------------------- 生效的源 ------------------------- */

  async setActive(id) {
    const target = id || '';
    this.switchToken += 1;
    const token = this.switchToken;

    this.destroyRuntime();
    this.activeId = target;
    this.lastUpdateAlert = null;
    this.store.setActive(target);

    if (!target) {
      this.setStatus(false, '未启用');
      this.emit({ type: 'state', status: this.getStatus() });
      return { ok: true, activeId: '' };
    }

    const entry = this.store.find(target);
    if (!entry) {
      this.setStatus(false, '音源不存在');
      return { ok: false, error: '音源不存在' };
    }
    const script = this.store.readScript(target);
    if (!script) {
      this.setStatus(false, '脚本文件缺失');
      this.store.updateStatus(target, 'failed', '脚本文件缺失');
      this.emit({ type: 'state', status: this.getStatus() });
      return { ok: false, error: '脚本文件缺失' };
    }

    this.setStatus(false, '初始化中…');
    this.pushLog('info', '正在加载音源：' + entry.name);

    const runtime = new UserApiRuntime({
      info: entry,
      script,
      onEvent: (event) => this.handleRuntimeEvent(runtime, token, event),
    });
    this.runtime = runtime;

    const result = await runtime.start();
    if (token !== this.switchToken) return { ok: false, error: '已被新的切换操作取代' };

    if (!result.ok) {
      this.setStatus(false, result.error || '初始化失败');
      this.store.updateStatus(target, 'failed', result.error || '初始化失败');
      this.pushLog('error', '音源初始化失败：' + (result.error || '未知错误'));
      this.emit({ type: 'state', status: this.getStatus() });
      return { ok: false, error: result.error || '初始化失败' };
    }

    const sourceCount = Object.keys(result.sources || {}).length;
    if (!sourceCount) {
      const message = '该音源没有声明任何可用平台';
      this.setStatus(false, message);
      this.store.updateStatus(target, 'failed', message);
      this.pushLog('warn', message);
      this.emit({ type: 'state', status: this.getStatus() });
      return { ok: false, error: message };
    }

    this.setStatus(true, '初始化成功');
    this.store.updateStatus(target, 'ready', '');
    this.pushLog('info', '音源就绪，支持平台：' + Object.keys(result.sources).join(' / '));
    this.emit({ type: 'state', status: this.getStatus() });
    return { ok: true, activeId: target, sources: result.sources };
  }

  handleRuntimeEvent(runtime, token, event) {
    if (token !== this.switchToken) return;
    switch (event.type) {
      case 'log':
        this.pushLog(event.level, event.message);
        return;
      case 'show-update-alert': {
        const entry = this.activeId ? this.store.find(this.activeId) : null;
        if (entry && entry.allowShowUpdateAlert === false) return;
        this.lastUpdateAlert = event;
        this.pushLog('info', '音源提示新版本：' + (event.log || '').slice(0, 200));
        this.emit({ type: 'update-alert', info: event });
        return;
      }
      case 'init':
        if (!event.status && event.errorMessage) this.pushLog('error', '初始化失败：' + event.errorMessage);
        return;
      default:
        return;
    }
  }

  setStatus(status, message) {
    this.status = { status: !!status, message: message || '' };
  }

  destroyRuntime() {
    if (this.runtime) {
      try {
        this.runtime.destroy();
      } catch (_) {}
      this.runtime = null;
    }
  }

  /* ------------------------- 生命周期 ------------------------- */

  /** 启动时调用：把上次选择的源恢复起来 */
  init() {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      const activeId = this.store.getActiveId();
      if (!activeId) {
        this.activeId = '';
        this.setStatus(false, '未启用');
        return { ok: true, activeId: '' };
      }
      return this.setActive(activeId);
    })();
    return this.initPromise;
  }

  isReady() {
    return !!(this.runtime && this.runtime.inited && this.status.status);
  }

  supportsSource(source, action) {
    if (!this.isReady()) return false;
    return this.runtime.canHandle(source, action || 'musicUrl');
  }

  /** 音源为某平台声明的可用音质 */
  qualitysFor(source) {
    if (!this.isReady()) return [];
    const entry = this.runtime.sources[source];
    return entry && Array.isArray(entry.qualitys) ? entry.qualitys.slice() : [];
  }

  /**
   * 取播放链接
   * @param {string} source     LX 平台标识 wy / tx / kg / kw / mg
   * @param {object} musicInfo  LX 结构的 musicInfo
   * @param {string} quality    音质（128k / 320k / flac / flac24bit）
   */
  async getMusicUrl(source, musicInfo, quality) {
    if (!this.isReady()) throw new Error('自定义源未就绪');
    if (!this.runtime.canHandle(source, 'musicUrl')) throw new Error('该音源不支持平台 ' + source);
    const type = this.normalizeQuality(source, quality);
    const result = await this.runtime.request({
      source,
      action: 'musicUrl',
      info: { type, musicInfo },
    });
    const url = result && result.data ? result.data.url : '';
    if (!url) throw new Error('音源没有返回可用链接');
    return { url, quality: (result.data && result.data.type) || type };
  }

  async getLyric(source, musicInfo) {
    if (!this.isReady()) throw new Error('自定义源未就绪');
    if (!this.runtime.canHandle(source, 'lyric')) throw new Error('该音源不支持歌词');
    const result = await this.runtime.request({ source, action: 'lyric', info: { type: '', musicInfo } });
    return (result && result.data) || null;
  }

  async getPic(source, musicInfo) {
    if (!this.isReady()) throw new Error('自定义源未就绪');
    if (!this.runtime.canHandle(source, 'pic')) throw new Error('该音源不支持封面');
    const result = await this.runtime.request({ source, action: 'pic', info: { type: '', musicInfo } });
    return (result && result.data) || '';
  }

  /** 优先挑高质量，脚本不支持时逐级退让 */
  pickQuality(source) {
    const list = this.qualitysFor(source);
    for (const candidate of LX_QUALITY_LEVELS_DESC) {
      if (list.includes(candidate)) return candidate;
    }
    return list[0] || '128k';
  }

  /**
   * 把 Mineradio 的音质档位翻译成 LX 音源脚本认识的标识。
   *
   * Mineradio 用的是 standard / exhigh / lossless / hires / jymaster，
   * 音源脚本只认 128k / 320k / flac / flac24bit —— 直接透传会变成
   * level=undefined，脚本要么报错要么给出无效链接。
   * 翻译完再按脚本声明的音质表逐级退让，避免请求了它给不出的档位。
   */
  normalizeQuality(source, quality) {
    const raw = String(quality || '').trim().toLowerCase();
    const mapped = QUALITY_ALIAS[raw] || (LX_QUALITY_LEVELS_DESC.includes(raw) ? raw : '');
    if (!mapped) return this.pickQuality(source);
    const supported = this.qualitysFor(source);
    if (!supported.length) return mapped;
    const wanted = LX_QUALITY_LEVELS_DESC.indexOf(mapped);
    for (let i = wanted; i < LX_QUALITY_LEVELS_DESC.length; i += 1) {
      if (supported.includes(LX_QUALITY_LEVELS_DESC[i])) return LX_QUALITY_LEVELS_DESC[i];
    }
    return this.pickQuality(source);
  }

  destroy() {
    this.destroyRuntime();
    this.listeners.clear();
  }
}

function getUserApiManager(options) {
  if (!singleton) singleton = new UserApiManager(options);
  return singleton;
}

function resetUserApiManager() {
  if (singleton) singleton.destroy();
  singleton = null;
}

module.exports = {
  UserApiManager,
  getUserApiManager,
  resetUserApiManager,
  normalizeSourceUrl,
  looksLikeHtml,
};
