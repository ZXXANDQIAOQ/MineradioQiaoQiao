// ====================================================================
//  http.js — LX 搜索层的请求实现
//
//  对应 lx-music-mobile 的 `src/utils/request.js` 里的 httpFetch：
//  返回 { promise, cancelHttp }，promise 解析成 { body, meta, statusCode, headers, raw }。
//  body 优先解析成对象，解析不了就返回原文；meta 取响应体里的 meta 字段
//  （QQ 音乐接口用 data.meta.sum 给总数）。
//
//  移植自 lx-music-mobile（Apache-2.0），实现换成 Node 内置 fetch。
// ====================================================================
'use strict';

const { coerceJson } = require('./format');

const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/69.0.3497.100 Safari/537.36',
};

function encodeForm(data) {
  const params = new URLSearchParams();
  Object.keys(data || {}).forEach(key => {
    const value = data[key];
    if (value === undefined || value === null) return;
    if (typeof value === 'object') params.append(key, JSON.stringify(value));
    else params.append(key, String(value));
  });
  return params.toString();
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Buffer.isBuffer(value) && !(value instanceof URLSearchParams);
}

/**
 * 发一次请求。
 * @param {string} url
 * @param {{method?:string, headers?:object, form?:object, body?:any, timeoutMs?:number}} options
 * @returns {{ promise: Promise<{body:any, meta:any, statusCode:number, headers:object, raw:string}>, cancelHttp: Function }}
 */
function httpFetch(url, options) {
  options = options || {};
  const method = String(options.method || 'get').toUpperCase();
  const controller = new AbortController();
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers = Object.assign({}, DEFAULT_HEADERS, options.headers || {});
  let body;
  if (options.form) {
    body = encodeForm(options.form);
    if (!headers['Content-Type'] && !headers['content-type']) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
  } else if (options.body !== undefined && options.body !== null) {
    if (typeof options.body === 'string' || Buffer.isBuffer(options.body)) {
      body = options.body;
    } else if (isPlainObject(options.body)) {
      body = JSON.stringify(options.body);
      if (!headers['Content-Type'] && !headers['content-type']) {
        headers['Content-Type'] = 'application/json';
      }
    }
  }

  const promise = (async () => {
    let response;
    try {
      response = await fetch(url, { method, headers, body, signal: controller.signal, redirect: 'follow' });
    } catch (err) {
      const message = err && (err.name === 'AbortError' ? '请求超时' : err.message);
      throw new Error(message || '网络请求失败');
    } finally {
      clearTimeout(timer);
    }
    const raw = await response.text();
    const parsed = coerceJson(raw);
    const bodyValue = parsed == null ? raw : parsed;
    const meta = isPlainObject(bodyValue) && isPlainObject(bodyValue.meta) ? bodyValue.meta : {};
    const outHeaders = {};
    try {
      response.headers.forEach((value, key) => { outHeaders[key.toLowerCase()] = value; });
    } catch (e) { /* 忽略 */ }
    return { body: bodyValue, meta, statusCode: response.status, headers: outHeaders, raw };
  })();

  return {
    promise,
    cancelHttp() {
      try { controller.abort(); } catch (e) { /* 忽略 */ }
    },
  };
}

module.exports = { httpFetch, DEFAULT_HEADERS, encodeForm };
