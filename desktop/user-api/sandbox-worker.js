// ====================================================================
//  sandbox-worker.js — LX 自定义音源脚本的宿主（运行在 worker_threads 里）
//
//  设计对应 lx-music-mobile 的 Android 侧：
//    android/app/src/main/java/cn/toside/music/mobile/userApi/
//      UserApiModule -> JavaScriptThread(HandlerThread) -> QuickJS
//  这里换成：
//    worker_threads 线程（可 terminate 强杀，避免脚本死循环卡住主进程）
//      + node:vm 上下文（脚本看不到 require/process/fs 等宿主能力）
//      + lx-preload.js（与移动端完全相同的 lx API 契约）
//
//  宿主为脚本提供的原生能力（对应 Android 的 __lx_native_call__*）：
//    __lx_native_call__(key, action, json)      init / showUpdateAlert /
//                                               request / cancelRequest / response
//    __lx_native_call__utils_str2b64(str)
//    __lx_native_call__utils_b642buf(b64)       -> JSON 数组字符串（与原实现一致）
//    __lx_native_call__utils_str2md5(str)
//    __lx_native_call__utils_aes_encrypt(data,key,iv,mode)
//    __lx_native_call__utils_rsa_encrypt(data,key,padding)
//    __lx_native_call__set_timeout(fnId, ms)
//  反向（宿主调用脚本）：
//    __lx_native__(key, 'request' | 'response' | '__set_timeout__', json)
// ====================================================================
'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PRELOAD_PATH = path.join(__dirname, 'lx-preload.js');
const PRELOAD_SOURCE = fs.readFileSync(PRELOAD_PATH, 'utf8');

const SCRIPT_KEY = crypto.randomUUID();
const DEFAULT_REQUEST_TIMEOUT_MS = 13000;
const MAX_REQUEST_TIMEOUT_MS = 60000;
const MAX_INPUT_LENGTH = 1048576;

let sandboxContext = null;
let invokeScript = null;
let scriptInited = false;
let destroyed = false;

// 脚本发出的 lx.request -> 等待宿主抓取结果
const httpRequests = new Map();
// 宿主问脚本 -> 等待脚本回答（musicUrl / lyric / pic）
const scriptRequests = new Map();
const timers = new Map();
let nextTimerId = 1;

function post(message) {
  try {
    if (!destroyed) parentPort.postMessage(message);
  } catch (_) {
    /* 线程已退出 */
  }
}

function postLog(level, text) {
  let message = text;
  if (typeof message !== 'string') {
    try {
      message = JSON.stringify(message);
    } catch (_) {
      message = String(message);
    }
  }
  if (message && message.length > 2048) message = message.slice(0, 2048) + '...';
  post({ type: 'log', level: level || 'log', message: message || '' });
}

/* ------------------------------------------------------------------ */
/*  宿主原生能力实现（对应 Android 端 Java/Kotlin 实现）                  */
/* ------------------------------------------------------------------ */

function toBase64Utf8(value) {
  const text = typeof value === 'string' ? value : String(value == null ? '' : value);
  return Buffer.from(text, 'utf8').toString('base64');
}

function base64ToByteArrayJson(b64) {
  const buffer = Buffer.from(String(b64 || ''), 'base64');
  const bytes = new Array(buffer.length);
  for (let i = 0; i < buffer.length; i += 1) bytes[i] = buffer[i];
  return JSON.stringify(bytes);
}

// Android: URLDecoder.decode(str, 'UTF-8') 之后再取 MD5
function urlDecodeSafe(value) {
  const text = String(value == null ? '' : value);
  try {
    return decodeURIComponent(text);
  } catch (_) {
    return text;
  }
}

function md5Hex(value) {
  return crypto.createHash('md5').update(urlDecodeSafe(value), 'utf8').digest('hex');
}

function aesEncrypt(dataB64, keyB64, ivB64, mode) {
  const data = Buffer.from(String(dataB64 || ''), 'base64');
  const key = Buffer.from(String(keyB64 || ''), 'base64');
  const iv = ivB64 ? Buffer.from(String(ivB64), 'base64') : null;
  const normalized = String(mode || '');
  let algorithm;
  let autoPadding = true;
  if (normalized.indexOf('CBC') >= 0) {
    algorithm = 'aes-128-cbc';
  } else {
    // Android 的 'AES' == AES/ECB/NoPadding
    algorithm = 'aes-128-ecb';
    autoPadding = false;
  }
  const cipher = crypto.createCipheriv(algorithm, key, iv);
  cipher.setAutoPadding(autoPadding);
  const out = Buffer.concat([cipher.update(data), cipher.final()]);
  return out.toString('base64');
}

function rsaEncrypt(dataB64, keyBodyB64, padding) {
  const data = Buffer.from(String(dataB64 || ''), 'base64');
  const keyBody = String(keyBodyB64 || '').replace(/\s+/g, '');
  const pem = '-----BEGIN PUBLIC KEY-----\n' + keyBody + '\n-----END PUBLIC KEY-----\n';
  const useNoPadding = /NoPadding/i.test(String(padding || ''));
  const out = crypto.publicEncrypt(
    {
      key: pem,
      padding: useNoPadding ? crypto.constants.RSA_NO_PADDING : crypto.constants.RSA_PKCS1_PADDING,
    },
    data
  );
  return out.toString('base64');
}

function scheduleScriptTimeout(fnId, delay) {
  const id = setTimeout(() => {
    timers.delete(id);
    callScript('__set_timeout__', fnId);
  }, Math.max(0, Math.min(60000, Number(delay) || 0)));
  timers.set(id, fnId);
  return id;
}

/* ------------------------------------------------------------------ */
/*  脚本 -> 宿主：HTTP 请求                                             */
/* ------------------------------------------------------------------ */

function headersToObject(headers) {
  const result = {};
  try {
    headers.forEach((value, key) => {
      result[key] = value;
    });
  } catch (_) {}
  return result;
}

function abortHttpRequest(requestKey) {
  const entry = httpRequests.get(requestKey);
  if (!entry) return;
  httpRequests.delete(requestKey);
  try {
    entry.controller.abort();
  } catch (_) {}
}

async function performHttpRequest(requestKey, url, options) {
  const opts = options || {};
  const method = String(opts.method || 'get').toUpperCase();
  const headers = Object.assign({ Accept: 'application/json' }, opts.headers || {});
  const contentTypeKey = Object.keys(headers).find((key) => key.toLowerCase() === 'content-type');
  let body;
  let contentType = contentTypeKey ? headers[contentTypeKey] : '';

  if (method !== 'GET' && method !== 'HEAD') {
    if (opts.form && !contentType) {
      contentType = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(opts.form).toString();
    } else if (opts.formData && !contentType) {
      contentType = 'multipart/form-data';
      body = typeof opts.formData === 'string' ? opts.formData : JSON.stringify(opts.formData);
    } else if (opts.body != null) {
      if (!contentType) contentType = 'application/json';
      body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    }
    if (contentType && !contentTypeKey) headers['Content-Type'] = contentType;
  }

  const controller = new AbortController();
  httpRequests.set(requestKey, { controller });
  const rawTimeout = Number(opts.timeout);
  const timeout = Math.min(
    MAX_REQUEST_TIMEOUT_MS,
    Math.max(1000, isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : DEFAULT_REQUEST_TIMEOUT_MS)
  );
  const timer = setTimeout(() => {
    try {
      controller.abort();
    } catch (_) {}
  }, timeout);

  try {
    const response = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal,
      redirect: 'follow',
    });
    if (opts.binary === true) {
      const arrayBuffer = await response.arrayBuffer();
      resolveHttpRequest(requestKey, null, {
        statusCode: response.status,
        statusMessage: response.statusText,
        headers: headersToObject(response.headers),
        // 二进制体以 base64 字符串回传（与原实现一样无法直接透传 Buffer）
        body: Buffer.from(arrayBuffer).toString('base64'),
        url: response.url,
        ok: response.ok,
      });
      return;
    }
    const text = await response.text();
    let parsed = text;
    try {
      parsed = JSON.parse(text);
    } catch (_) {
      /* 保持纯文本 */
    }
    resolveHttpRequest(requestKey, null, {
      statusCode: response.status,
      statusMessage: response.statusText,
      headers: headersToObject(response.headers),
      body: parsed,
      url: response.url,
      ok: response.ok,
    });
  } catch (error) {
    const message = error && error.message ? error.message : 'request failed';
    resolveHttpRequest(requestKey, /abort/i.test(message) ? 'request timeout' : message, null);
  } finally {
    clearTimeout(timer);
    httpRequests.delete(requestKey);
  }
}

function resolveHttpRequest(requestKey, error, response) {
  const payload = JSON.stringify({ requestKey, error: error || null, response: response || null });
  callScript('response', payload);
}

/* ------------------------------------------------------------------ */
/*  脚本 -> 宿主：其它动作                                              */
/* ------------------------------------------------------------------ */

function normalizeInitInfo(info) {
  if (!info || typeof info !== 'object') return null;
  const sources = {};
  const rawSources = info.sources && typeof info.sources === 'object' ? info.sources : {};
  for (const [source, value] of Object.entries(rawSources)) {
    if (!value || typeof value !== 'object') continue;
    sources[source] = {
      type: value.type,
      actions: Array.isArray(value.actions) ? value.actions.slice(0, 8) : [],
      qualitys: Array.isArray(value.qualitys) ? value.qualitys.slice(0, 8) : [],
      name: typeof value.name === 'string' ? value.name.slice(0, 64) : '',
    };
  }
  return { sources };
}

function handleInit(payload) {
  scriptInited = true;
  const data = payload && typeof payload === 'object' ? payload : {};
  const info = normalizeInitInfo(data.info);
  const status = data.status === true || data.status === undefined ? data.status !== false : false;
  post({
    type: 'init',
    status: status === true && info != null,
    errorMessage: typeof data.errorMessage === 'string' ? data.errorMessage : '',
    info: info,
  });
}

function handleNativeCall(action, payload) {
  switch (action) {
    case 'init':
      handleInit(payload);
      return null;
    case 'showUpdateAlert': {
      const data = payload && typeof payload === 'object' ? payload : {};
      post({
        type: 'show-update-alert',
        name: typeof data.name === 'string' ? data.name.slice(0, 128) : '',
        log: typeof data.log === 'string' ? data.log : '',
        updateUrl: typeof data.updateUrl === 'string' ? data.updateUrl : '',
      });
      return null;
    }
    case 'request': {
      const data = payload && typeof payload === 'object' ? payload : {};
      if (!data.requestKey || typeof data.url !== 'string') return null;
      void performHttpRequest(String(data.requestKey), data.url, data.options || {});
      return null;
    }
    case 'cancelRequest':
      abortHttpRequest(String(payload || ''));
      return null;
    case 'response': {
      const data = payload && typeof payload === 'object' ? payload : {};
      const target = scriptRequests.get(String(data.requestKey || ''));
      if (!target) return null;
      scriptRequests.delete(data.requestKey);
      clearTimeout(target.timer);
      if (data.status) target.resolve(data.result);
      else target.reject(new Error(typeof data.errorMessage === 'string' ? data.errorMessage : 'failed'));
      return null;
    }
    default:
      postLog('warn', 'unknown native action: ' + String(action));
      return null;
  }
}

/* ------------------------------------------------------------------ */
/*  宿主 -> 脚本                                                        */
/* ------------------------------------------------------------------ */

function callScript(action, payload) {
  if (!invokeScript) return null;
  try {
    return invokeScript(SCRIPT_KEY, action, payload == null ? null : String(payload));
  } catch (error) {
    postLog('error', 'call script failed: ' + (error && error.message ? error.message : error));
    return null;
  }
}

function requestFromScript(data, timeoutMs) {
  const requestKey = 'req__' + Math.random().toString(36).slice(2) + '_' + Date.now();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      scriptRequests.delete(requestKey);
      reject(new Error('request timeout'));
    }, timeoutMs);
    scriptRequests.set(requestKey, { resolve, reject, timer });
    callScript('request', JSON.stringify({ requestKey, data }));
  });
}

/* ------------------------------------------------------------------ */
/*  启动沙箱                                                            */
/* ------------------------------------------------------------------ */

function createSandbox() {
  const hostGlobals = {
    console: {
      log: (...args) => postLog('log', args.map(describe).join(' ')),
      info: (...args) => postLog('info', args.map(describe).join(' ')),
      warn: (...args) => postLog('warn', args.map(describe).join(' ')),
      error: (...args) => postLog('error', args.map(describe).join(' ')),
      debug: (...args) => postLog('log', args.map(describe).join(' ')),
      trace: (...args) => postLog('log', args.map(describe).join(' ')),
    },
    __lx_native_call__: (key, action, data) => {
      if (key !== SCRIPT_KEY) return null;
      let payload = null;
      if (data != null) {
        try {
          payload = JSON.parse(data);
        } catch (_) {
          payload = null;
        }
      }
      return handleNativeCall(String(action), payload);
    },
    __lx_native_call__utils_str2b64: (value) => toBase64Utf8(checkLength(value)),
    __lx_native_call__utils_b642buf: (value) => base64ToByteArrayJson(checkLength(value)),
    __lx_native_call__utils_str2md5: (value) => md5Hex(checkLength(value)),
    __lx_native_call__utils_aes_encrypt: (data, key, iv, mode) =>
      aesEncrypt(checkLength(data), key, iv, mode),
    __lx_native_call__utils_rsa_encrypt: (data, key, padding) =>
      rsaEncrypt(checkLength(data), key, padding),
    __lx_native_call__set_timeout: (fnId, delay) => {
      scheduleScriptTimeout(fnId, delay);
      return null;
    },
  };

  const context = vm.createContext(hostGlobals, {
    name: 'mineradio-user-api',
    codeGeneration: { strings: false, wasm: false },
  });
  vm.runInContext(PRELOAD_SOURCE, context, { filename: 'lx-preload.js', timeout: 5000 });
  return context;
}

function checkLength(value) {
  if (typeof value === 'string' && value.length > MAX_INPUT_LENGTH) throw new Error('Input too long');
  return value;
}

function describe(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch (_) {
    return String(value);
  }
}

function startSandbox() {
  const info = workerData || {};
  try {
    sandboxContext = createSandbox();
  } catch (error) {
    post({ type: 'init', status: false, errorMessage: '创建脚本运行环境失败：' + (error && error.message ? error.message : error), info: null });
    return;
  }

  try {
    const setupArgs = [
      SCRIPT_KEY,
      String(info.id || ''),
      String(info.name || 'Unknown'),
      String(info.description || ''),
      String(info.version || ''),
      String(info.author || ''),
      String(info.homepage || ''),
      String(info.script || ''),
    ];
    const call = 'globalThis.lx_setup(' + setupArgs.map((arg) => JSON.stringify(arg)).join(', ') + ')';
    vm.runInContext(call, sandboxContext, { filename: 'lx-setup.js', timeout: 5000 });
  } catch (error) {
    post({ type: 'init', status: false, errorMessage: '创建脚本运行环境失败：' + (error && error.message ? error.message : error), info: null });
    return;
  }

  // __lx_native__ 是 lx_setup() 执行时才挂到 globalThis 上的，必须在 setup 之后再取
  try {
    invokeScript = sandboxContext.__lx_native__;
  } catch (_) {
    invokeScript = null;
  }
  if (typeof invokeScript !== 'function') {
    post({ type: 'init', status: false, errorMessage: '创建脚本运行环境失败：__lx_native__ 不可用', info: null });
    return;
  }

  try {
    vm.runInContext(String(info.script || ''), sandboxContext, {
      filename: 'user-api-script.js',
      timeout: 8000,
    });
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    postLog('error', '脚本执行出错：' + message);
    if (!scriptInited) {
      post({ type: 'init', status: false, errorMessage: message, info: null });
      return;
    }
  }

  post({ type: 'loaded' });
}

/* ------------------------------------------------------------------ */
/*  与主线程通信                                                        */
/* ------------------------------------------------------------------ */

parentPort.on('message', (message) => {
  if (!message || typeof message !== 'object') return;
  switch (message.type) {
    case 'request': {
      const key = String(message.requestKey || '');
      if (!key) return;
      const timeoutMs = Math.max(3000, Math.min(60000, Number(message.timeoutMs) || 30000));
      requestFromScript(message.data, timeoutMs).then(
        (result) => post({ type: 'script-response', requestKey: key, status: true, result }),
        (error) =>
          post({
            type: 'script-response',
            requestKey: key,
            status: false,
            errorMessage: error && error.message ? error.message : 'failed',
          })
      );
      return;
    }
    case 'destroy':
      destroyed = true;
      for (const entry of scriptRequests.values()) clearTimeout(entry.timer);
      scriptRequests.clear();
      for (const entry of httpRequests.values()) {
        try {
          entry.controller.abort();
        } catch (_) {}
      }
      httpRequests.clear();
      for (const id of timers.keys()) clearTimeout(id);
      timers.clear();
      sandboxContext = null;
      invokeScript = null;
      return;
    default:
      return;
  }
});

startSandbox();
