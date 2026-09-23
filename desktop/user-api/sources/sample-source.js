/*!
 * @name Mineradio 示例音源
 * @description 内置自检用示例：不解析真实版权，只演示 lx 接口的完整用法
 * @version 1.0.0
 * @author Mineradio
 * @homepage https://github.com/ZXXANDQIAOQ/MineradioQiaoQiao
 */

// LX 自定义源脚本的标准写法：
//   1) 用 /* ... */ 注释块声明元信息（@name / @version / @author ...）
//   2) 从 globalThis.lx 取接口
//   3) on(EVENT_NAMES.request, ...) 应答取链接请求
//   4) send(EVENT_NAMES.inited, ...) 声明自己支持哪些平台与动作
const { EVENT_NAMES, request, on, send } = globalThis.lx;

// 自检时由 desktop/user-api/selftest.js 在本机起一个假接口。
// 换成真实音源时，这里就是你自己服务端的地址。
const API_BASE = 'http://127.0.0.1:39777';

const handleGetMusicUrl = (source, musicInfo, quality) =>
  new Promise((resolve, reject) => {
    const songId = musicInfo.songmid || musicInfo.hash || musicInfo.songId || '';
    const target =
      API_BASE +
      '/api/url?source=' + encodeURIComponent(source) +
      '&id=' + encodeURIComponent(songId) +
      '&quality=' + encodeURIComponent(quality);
    request(target, { method: 'get', timeout: 10000 }, (err, resp) => {
      if (err) return reject(err);
      const body = resp && resp.body;
      if (resp.statusCode !== 200 || !body || !body.url) {
        return reject(new Error('示例音源没有取到链接'));
      }
      resolve(body.url);
    });
  });

on(EVENT_NAMES.request, ({ source, action, info }) => {
  switch (action) {
    case 'musicUrl':
      return handleGetMusicUrl(source, info.musicInfo, info.type);
    default:
      return Promise.reject(new Error('action not support: ' + action));
  }
});

send(EVENT_NAMES.inited, {
  status: true,
  openDevTools: false,
  sources: {
    wy: {
      name: '示例·网易云',
      type: 'music',
      actions: ['musicUrl'],
      qualitys: ['128k', '320k', 'flac'],
    },
    tx: {
      name: '示例·QQ音乐',
      type: 'music',
      actions: ['musicUrl'],
      qualitys: ['128k', '320k', 'flac'],
    },
    kg: {
      name: '示例·酷狗',
      type: 'music',
      actions: ['musicUrl'],
      qualitys: ['128k', '320k'],
    },
  },
});
