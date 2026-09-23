// ====================================================================
//  format.js — LX 搜索层用到的格式化工具
//
//  对应 lx-music-mobile 里的：
//    src/utils/common.ts   → sizeFormate / formatPlayTime
//    src/utils/index.ts    → decodeName / toMD5
//    src/utils/musicSdk/utils.js → formatSingerName
//    src/utils/musicSdk/kw/util.js → formatSinger / objStr2JSON
//
//  移植自 lx-music-mobile（Apache-2.0），只保留搜索链路用得到的部分。
// ====================================================================
'use strict';

const crypto = require('crypto');

/** 与 LX 一致：0 → '0 B'，其余按 1024 进制取两位小数 */
function sizeFormate(size) {
  // https://gist.github.com/thomseddon/3511330
  if (!size) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const number = Math.floor(Math.log(size) / Math.log(1024));
  return `${(size / Math.pow(1024, Math.floor(number))).toFixed(2)} ${units[number]}`;
}

const numFix = n => (n < 10 ? `0${n}` : n.toString());

/** 秒 → 'mm:ss'；0 秒时 LX 给 '--/--' */
function formatPlayTime(time) {
  const m = Math.trunc(Number(time) / 60);
  const s = Math.trunc(Number(time) % 60);
  return m == 0 && s == 0 ? '--/--' : numFix(m) + ':' + numFix(s);
}

/** 'mm:ss' → 秒（用于回填 Mineradio 的 duration 字段，单位毫秒） */
function playTimeToSeconds(text) {
  if (typeof text === 'number') return Math.max(0, Math.trunc(text));
  const parts = String(text || '').split(':');
  if (parts.length < 2) return 0;
  let total = 0;
  let unit = 1;
  while (parts.length) {
    const value = parseInt(parts.pop(), 10);
    total += (Number.isFinite(value) ? value : 0) * unit;
    unit *= 60;
  }
  return Math.max(0, total);
}

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', hellip: '…',
  middot: '·', times: '×', ndash: '–', mdash: '—', copy: '©', reg: '®',
  deg: '°', shy: '\u00ad', eacute: 'é', egrave: 'è',
};

/**
 * HTML 实体解码。LX 用的是 `he.decode`，这里实现搜索元数据里会出现的子集：
 * 数值实体（&#39; / &#x27;）+ 常见命名实体，未识别的原样保留。
 */
function decodeName(str) {
  if (!str) return '';
  const text = String(str);
  if (text.indexOf('&') === -1) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (raw, body) => {
    if (body.charAt(0) === '#') {
      const hex = body.charAt(1) === 'x' || body.charAt(1) === 'X';
      const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return raw;
      try { return String.fromCodePoint(code); } catch (e) { return raw; }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? raw : named;
  });
}

function toMD5(str) {
  return crypto.createHash('md5').update(String(str), 'utf8').digest('hex');
}

/** 歌手数组 → '张三、李四'（与 LX formatSingerName 一致） */
function formatSingerName(singers, nameKey = 'name', join = '、') {
  if (Array.isArray(singers)) {
    const names = [];
    singers.forEach(item => {
      const name = item && item[nameKey];
      if (!name) return;
      names.push(name);
    });
    return decodeName(names.join(join));
  }
  return decodeName(String(singers == null ? '' : singers));
}

/** 酷我返回的 ARTIST 用 '&' 分隔，改成顿号 */
const formatSinger = rawData => String(rawData == null ? '' : rawData).replace(/&/g, '、');

/**
 * 把单引号形式的「伪 JSON」转成真 JSON。
 * 酷我搜索接口（rformat=json）历史上会返回 {'abslist': [...]} 这种形式，
 * 对应 LX 的 kw/util.js objStr2JSON。
 */
function objStr2JSON(str) {
  return JSON.parse(String(str).replace(/('(?=(,\s*')))|('(?=:))|((?<=([:,]\s*))')|((?<={)')|('(?=}))/g, '"'));
}

/** 尽可能把响应体解析成对象：真 JSON → 伪 JSON → 原文 */
function coerceJson(text) {
  if (text == null) return null;
  if (typeof text === 'object') return text;
  const raw = String(text).trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { /* 继续尝试伪 JSON */ }
  try { return objStr2JSON(raw); } catch (e) { /* 交给调用方 */ }
  return text;
}

module.exports = {
  sizeFormate,
  formatPlayTime,
  formatPlayTime2: formatPlayTime,
  playTimeToSeconds,
  decodeName,
  toMD5,
  formatSingerName,
  formatSinger,
  objStr2JSON,
  coerceJson,
};
