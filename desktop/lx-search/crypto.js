// ====================================================================
//  crypto.js — LX 搜索层的加密与签名
//
//  对应 lx-music-mobile：
//    src/utils/musicSdk/wy/utils/crypto.js  → eapi（网易云）
//    src/utils/musicSdk/wy/utils/index.js   → eapiRequest
//    src/utils/musicSdk/tx/utils/crypto.js  → zzcSign（QQ 音乐）
//    src/utils/musicSdk/tx/utils/index.js   → signRequest
//
//  LX 侧跑在 Android 原生模块（aesEncryptSync / hashSHA1）上，这里换成
//  Node 内置 crypto，算法与参数逐一对照原实现。
//  移植自 lx-music-mobile（Apache-2.0）。
// ====================================================================
'use strict';

const crypto = require('crypto');
const { toMD5 } = require('./format');
const { httpFetch } = require('./http');

// ---------------------------------------------------------------- 网易云
// LX: const iv = btoa('0102030405060708') 等一串 base64 常量，native 侧统一按
// base64 解码后使用，所以这里直接用原始字符串。
const EAPI_KEY = 'e82ckenh8dichen8';

function aesEncryptEcb(text, key) {
  const cipher = crypto.createCipheriv('aes-128-ecb', Buffer.from(key, 'utf8'), null);
  return Buffer.concat([cipher.update(Buffer.from(text, 'utf8')), cipher.final()]);
}

/** eapi 签名体：与 LX eapi() 完全一致 */
function eapi(url, object) {
  const text = typeof object === 'object' ? JSON.stringify(object) : String(object);
  const message = `nobody${url}use${text}md5forencrypt`;
  const digest = toMD5(message);
  const data = `${url}-36cd479b6b5-${text}-36cd479b6b5-${digest}`;
  // LX: Buffer.from(aesEncrypt(Buffer.from(data).toString('base64'), ECB, eapiKey, ''), 'base64')
  //       .toString('hex').toUpperCase()
  const packed = aesEncryptEcb(data, EAPI_KEY);
  return { params: packed.toString('hex').toUpperCase() };
}

/** 网易云 eapi 批量接口（搜索走这里） */
function eapiRequest(url, data) {
  return httpFetch('http://interface.music.163.com/eapi/batch', {
    method: 'post',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36',
      Origin: 'https://music.163.com',
    },
    form: eapi(url, data),
  });
}

// ------------------------------------------------------------- QQ 音乐
const PART_1_INDEXES = [23, 14, 6, 36, 16, 40, 7, 19];
const PART_2_INDEXES = [16, 1, 32, 12, 19, 27, 8, 5];
const SCRAMBLE_VALUES = [89, 39, 179, 150, 218, 82, 58, 252, 177, 52, 186, 123, 120, 64, 242, 133, 143, 161, 121, 179];

function sha1Hex(text) {
  return crypto.createHash('sha1').update(String(text), 'utf8').digest('hex');
}

function pickHashByIdx(hash, indexes) {
  return indexes.map(idx => hash[idx]).join('');
}

function base64Encode(data) {
  return Buffer.from(data).toString('base64').replace(/[\\/+=]/g, '');
}

/** QQ 音乐 zzc 签名：SHA1 切片 + 逐字节异或打散 */
function zzcSign(text) {
  const hash = sha1Hex(text);
  const part1 = pickHashByIdx(hash, PART_1_INDEXES);
  const part2 = pickHashByIdx(hash, PART_2_INDEXES);
  const part3 = SCRAMBLE_VALUES.map((value, i) => value ^ parseInt(hash.slice(i * 2, i * 2 + 2), 16));
  const b64Part = base64Encode(part3).replace(/[\\/+=]/g, '');
  return `zzc${part1}${b64Part}${part2}`.toLowerCase();
}

/** QQ 音乐搜索请求：musics.fcg + zzc 签名 */
function signRequest(data) {
  const sign = zzcSign(JSON.stringify(data));
  return httpFetch(`https://u.y.qq.com/cgi-bin/musics.fcg?sign=${sign}`, {
    method: 'post',
    headers: { 'User-Agent': 'QQMusic 14090508(android 12)' },
    body: data,
  }).promise;
}

module.exports = { eapi, eapiRequest, zzcSign, signRequest, aesEncryptEcb };
