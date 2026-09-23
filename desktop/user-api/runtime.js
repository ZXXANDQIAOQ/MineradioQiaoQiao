// ====================================================================
//  runtime.js — 音源脚本运行时（主进程侧）
//
//  负责在 worker_threads 里跑一个音源脚本，并把「宿主问脚本」这类调用
//  封装成 Promise。对应移动端 core/userApi.ts + nativeModules/userApi.ts
//  的位置：上层只管 loadScript / 发请求 / 销毁，具体执行在独立线程。
//
//  为什么用 worker 而不是直接在主进程 vm 里跑：
//    · 音源脚本可能死循环 —— 主进程跑会直接冻住整个 UI；
//      worker 可以 terminate() 强杀（对齐移动端的 JavaScriptThread）。
//    · 脚本拿不到 require/process/fs，只能通过 lx API 出网。
// ====================================================================
'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');

const WORKER_PATH = path.join(__dirname, 'sandbox-worker.js');
const DEFAULT_INIT_TIMEOUT_MS = 20000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;

class UserApiRuntime {
  /**
   * @param {object} options
   * @param {object} options.info   音源元信息 { id, name, description, version, author, homepage }
   * @param {string} options.script 脚本全文
   * @param {(event: object) => void} [options.onEvent] 事件回调（log / show-update-alert / init）
   */
  constructor(options) {
    const opts = options || {};
    this.info = opts.info || {};
    this.script = String(opts.script || '');
    this.onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};

    this.worker = null;
    this.destroyed = false;
    this.inited = false;
    this.initError = '';
    this.sources = {};
    this.updateAlert = null;
    this.updateAlertGraceTimer = null;
    this.pending = new Map();
    this.initPromise = null;
  }

  start(initTimeoutMs) {
    if (this.initPromise) return this.initPromise;
    this.initPromise = new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        this.initError = this.initError || '自定义源初始化超时';
        this.destroy();
        finish({ ok: false, error: this.initError, sources: {} });
      }, Math.max(3000, Number(initTimeoutMs) || DEFAULT_INIT_TIMEOUT_MS));

      try {
        this.worker = new Worker(WORKER_PATH, {
          workerData: {
            id: this.info.id,
            name: this.info.name,
            description: this.info.description,
            version: this.info.version,
            author: this.info.author,
            homepage: this.info.homepage,
            script: this.script,
          },
        });
      } catch (error) {
        this.initError = '启动脚本线程失败：' + (error && error.message ? error.message : error);
        finish({ ok: false, error: this.initError, sources: {} });
        return;
      }

      this.worker.on('message', (message) => this.handleWorkerMessage(message, finish));
      this.worker.on('error', (error) => {
        const text = error && error.message ? error.message : String(error);
        this.initError = this.initError || text;
        this.onEvent({ type: 'log', level: 'error', message: '脚本线程异常：' + text });
        this.rejectAllPending(new Error(text));
        finish({ ok: false, error: text, sources: {} });
      });
      this.worker.on('exit', (code) => {
        this.worker = null;
        this.rejectAllPending(new Error('音源脚本线程已退出'));
        if (!this.inited) finish({ ok: false, error: this.initError || '脚本线程已退出 (code=' + code + ')', sources: {} });
      });
    });
    return this.initPromise;
  }

  handleWorkerMessage(message, finishInit) {
    if (!message || typeof message !== 'object') return;
    switch (message.type) {
      case 'log':
        this.onEvent({ type: 'log', level: message.level, message: message.message });
        return;
      case 'show-update-alert':
        this.updateAlert = {
          name: message.name,
          log: message.log,
          updateUrl: message.updateUrl,
        };
        this.onEvent({
          type: 'show-update-alert',
          name: message.name,
          log: message.log,
          updateUrl: message.updateUrl,
        });
        // 有些音源发现有新版本后会故意不初始化（LX 上也是这个行为）。
        // 这里给一个宽限期，避免用户干等满 20 秒才看到失败。
        if (!this.inited && !this.updateAlertGraceTimer) {
          this.updateAlertGraceTimer = setTimeout(() => {
            this.updateAlertGraceTimer = null;
            if (this.inited) return;
            this.initError = '该音源提示需要更新新版本，已停止初始化';
            finishInit({ ok: false, error: this.initError, sources: {} });
            this.destroy();
          }, 5000);
        }
        return;
      case 'init': {
        this.inited = message.status === true;
        this.initError = message.errorMessage || '';
        this.sources = (message.info && message.info.sources) || {};
        this.onEvent({ type: 'init', status: this.inited, errorMessage: this.initError, sources: this.sources });
        finishInit({ ok: this.inited, error: this.initError, sources: this.sources });
        return;
      }
      case 'script-response': {
        const entry = this.pending.get(message.requestKey);
        if (!entry) return;
        this.pending.delete(message.requestKey);
        clearTimeout(entry.timer);
        if (message.status) entry.resolve(message.result);
        else entry.reject(new Error(message.errorMessage || 'failed'));
        return;
      }
      default:
        return;
    }
  }

  rejectAllPending(error) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  /**
   * 向脚本发一个请求（对应 lx.on(EVENT_NAMES.request) 的回调参数）
   * @param {{source: string, action: string, info: object}} data
   */
  request(data, timeoutMs) {
    if (!this.worker || this.destroyed) return Promise.reject(new Error('音源未就绪'));
    const requestKey = 'host__' + Math.random().toString(36).slice(2) + '_' + Date.now();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestKey);
        reject(new Error('自定义源响应超时'));
      }, Math.max(2000, Math.min(60000, Number(timeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS)));
      this.pending.set(requestKey, { resolve, reject, timer });
      try {
        this.worker.postMessage({ type: 'request', requestKey, data, timeoutMs });
      } catch (error) {
        this.pending.delete(requestKey);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  supportedSources() {
    return Object.keys(this.sources || {});
  }

  canHandle(source, action) {
    const entry = this.sources && this.sources[source];
    if (!entry) return false;
    if (entry.type !== 'music') return false;
    if (!action) return true;
    return Array.isArray(entry.actions) && entry.actions.includes(action);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.inited = false;
    if (this.updateAlertGraceTimer) {
      clearTimeout(this.updateAlertGraceTimer);
      this.updateAlertGraceTimer = null;
    }
    this.rejectAllPending(new Error('音源已卸载'));
    const worker = this.worker;
    this.worker = null;
    if (worker) {
      try {
        worker.postMessage({ type: 'destroy' });
      } catch (_) {}
      try {
        void worker.terminate();
      } catch (_) {}
    }
  }
}

module.exports = {
  UserApiRuntime,
  DEFAULT_INIT_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
};
