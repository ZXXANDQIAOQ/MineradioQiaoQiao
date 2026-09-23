// ====================================================================
//  store.js — 自定义音源的持久化与导入校验
//
//  对应移动端 src/utils/data.ts 里的
//    getUserApiList / getUserApiScript / addUserApi / removeUserApi
//  存储方式改为文件：
//    <dataDir>/sources.json        音源列表 + 当前生效的源
//    <dataDir>/scripts/<id>.js     每个源的脚本全文
//  <dataDir> 默认是 Electron 的 userData/user-api，
//  可用环境变量 MINERADIO_USER_API_DIR 覆盖（自检脚本就靠它）。
// ====================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_SOURCES = 20;
const MAX_SCRIPT_LENGTH = 9_000_000;
// 与原实现一致：脚本必须以 /* ... */ 注释块开头，块内 @name 等为元信息
const HEADER_RXP = /^\/\*[\S|\s]+?\*\//;
const INFO_NAMES = {
  name: 24,
  description: 36,
  author: 56,
  homepage: 1024,
  version: 36,
};

function resolveDataDir() {
  const override = process.env.MINERADIO_USER_API_DIR;
  if (override) return path.resolve(override);
  try {
    // 主进程里可用；纯 node 自检时走下面的兜底
    const electron = require('electron');
    if (electron && electron.app && typeof electron.app.getPath === 'function') {
      return path.join(electron.app.getPath('userData'), 'user-api');
    }
  } catch (_) {}
  return path.join(__dirname, '..', '..', '.user-api');
}

class UserApiStore {
  constructor(dataDir) {
    this.dataDir = dataDir || resolveDataDir();
    this.scriptsDir = path.join(this.dataDir, 'scripts');
    this.stateFile = path.join(this.dataDir, 'sources.json');
    this.state = null;
  }

  ensureDirs() {
    fs.mkdirSync(this.scriptsDir, { recursive: true });
  }

  readState() {
    if (this.state) return this.state;
    let state = { version: 1, activeId: '', list: [] };
    try {
      const raw = fs.readFileSync(this.stateFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        state = {
          version: 1,
          activeId: typeof parsed.activeId === 'string' ? parsed.activeId : '',
          list: Array.isArray(parsed.list) ? parsed.list.filter((item) => item && item.id) : [],
        };
      }
    } catch (_) {
      /* 首次运行或文件损坏，用空状态 */
    }
    this.state = state;
    return state;
  }

  writeState() {
    this.ensureDirs();
    const state = this.readState();
    const tmp = this.stateFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, this.stateFile);
    return state;
  }

  list() {
    return this.readState().list.map((item) => ({ ...item }));
  }

  getActiveId() {
    const state = this.readState();
    if (state.activeId && state.list.some((item) => item.id === state.activeId)) return state.activeId;
    return '';
  }

  find(id) {
    return this.readState().list.find((item) => item.id === id) || null;
  }

  scriptPath(id) {
    return path.join(this.scriptsDir, id + '.js');
  }

  readScript(id) {
    try {
      return fs.readFileSync(this.scriptPath(id), 'utf8');
    } catch (_) {
      return '';
    }
  }

  parseScriptInfo(script) {
    const header = HEADER_RXP.exec(script);
    if (!header) return null;
    const infos = {};
    const rxp = /^\s?\*\s?@(\w+)\s(.+)$/;
    for (const line of header[0].split(/\r?\n/)) {
      const result = rxp.exec(line);
      if (!result) continue;
      const key = result[1];
      if (!Object.prototype.hasOwnProperty.call(INFO_NAMES, key)) continue;
      infos[key] = result[2].trim();
    }
    for (const [key, limit] of Object.entries(INFO_NAMES)) {
      const value = infos[key] || '';
      infos[key] = value.length > limit ? value.slice(0, limit) + '...' : value;
    }
    return infos;
  }

  importScript(script) {
    const text = typeof script === 'string' ? script : String(script == null ? '' : script);
    if (!text.trim()) throw new Error('无效的自定义源文件');
    if (text.length > MAX_SCRIPT_LENGTH) throw new Error('脚本过大（上限 9MB）');
    const info = this.parseScriptInfo(text);
    if (!info) throw new Error('无效的自定义源文件：缺少 /* 开头的元信息注释块');

    const state = this.readState();
    if (state.list.length >= MAX_SOURCES) throw new Error('最多只能同时存在 ' + MAX_SOURCES + ' 个源');

    const id = 'user_api_' + Math.random().toString(36).slice(2, 5) + '_' + Date.now();
    const entry = {
      id,
      name: info.name || '未命名音源',
      description: info.description || '',
      version: info.version || '',
      author: info.author || '',
      homepage: info.homepage || '',
      allowShowUpdateAlert: true,
      importedAt: Date.now(),
      lastStatus: '',
      lastError: '',
    };

    this.ensureDirs();
    fs.writeFileSync(this.scriptPath(id), text, 'utf8');
    state.list.push(entry);
    this.writeState();
    return { ...entry };
  }

  remove(id) {
    const state = this.readState();
    const index = state.list.findIndex((item) => item.id === id);
    if (index < 0) return { removed: false, activeId: this.getActiveId(), list: this.list() };
    state.list.splice(index, 1);
    let activeId = state.activeId;
    if (activeId === id) {
      activeId = state.list.length ? state.list[0].id : '';
      state.activeId = activeId;
    }
    this.writeState();
    try {
      fs.unlinkSync(this.scriptPath(id));
    } catch (_) {}
    return { removed: true, activeId, list: this.list() };
  }

  setActive(id) {
    const state = this.readState();
    if (id && !state.list.some((item) => item.id === id)) throw new Error('音源不存在');
    state.activeId = id || '';
    this.writeState();
    return state.activeId;
  }

  updateStatus(id, status, error) {
    const state = this.readState();
    const target = state.list.find((item) => item.id === id);
    if (!target) return;
    target.lastStatus = status || '';
    target.lastError = error || '';
    this.writeState();
  }

  setAllowShowUpdateAlert(id, enabled) {
    const state = this.readState();
    const target = state.list.find((item) => item.id === id);
    if (!target) return null;
    target.allowShowUpdateAlert = enabled !== false;
    this.writeState();
    return { ...target };
  }
}

module.exports = {
  UserApiStore,
  resolveDataDir,
  MAX_SOURCES,
  MAX_SCRIPT_LENGTH,
};
