// ====================================================================
//  selftest.js — 音源模块自检（纯 node，不依赖 Electron）
//
//  跑法：
//    node desktop/user-api/selftest.js
//  它会：
//    1) 在本机 39777 起一个假音源接口
//    2) 用临时目录当数据目录，导入内置示例音源并启用
//    3) 断言：初始化成功、声明了 wy/tx/kg、能取到播放链接
//    4) 反例：无元信息头的脚本、初始化就抛错的脚本、死循环脚本
//  退出码 0 = 全通过。
// ====================================================================
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { UserApiStore } = require('./store');
const { UserApiManager } = require('./manager');

const API_PORT = 39777;
const results = [];

function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log('[' + mark + '] ' + name + (detail ? '  -> ' + detail : ''));
}

function startFakeApi() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1:' + API_PORT);
      if (url.pathname === '/api/url') {
        const source = url.searchParams.get('source') || '';
        const id = url.searchParams.get('id') || '';
        const quality = url.searchParams.get('quality') || '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            url: 'http://127.0.0.1:' + API_PORT + '/stream/' + source + '/' + quality + '/' + id + '.flac',
            from: 'selftest',
          })
        );
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
    server.listen(API_PORT, '127.0.0.1', () => resolve(server));
  });
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-user-api-'));
  console.log('数据目录:', dataDir);
  const apiServer = await startFakeApi();

  const store = new UserApiStore(dataDir);
  const manager = new UserApiManager({ store });
  const logs = [];
  manager.onEvent((event) => {
    if (event.type === 'log') logs.push(event.log.level + ': ' + event.log.message);
  });

  try {
    /* ---------- 1. 脚本头解析 ---------- */
    const sampleScript = fs.readFileSync(path.join(__dirname, 'sources', 'sample-source.js'), 'utf8');
    const parsed = store.parseScriptInfo(sampleScript);
    check(
      '解析脚本元信息',
      parsed && parsed.name === 'Mineradio 示例音源' && parsed.version === '1.0.0',
      parsed ? parsed.name + ' / v' + parsed.version : 'null'
    );

    /* ---------- 2. 导入 + 启用 ---------- */
    const info = await manager.importScript(sampleScript);
    check('导入示例音源', !!info.id, info.id + ' (' + info.name + ')');

    const active = await manager.setActive(info.id);
    const status = manager.getStatus();
    const sources = Object.keys(status.sources);
    check('音源初始化成功', active.ok === true && manager.isReady() === true, status.status.message);
    check(
      '声明支持平台 wy/tx/kg',
      sources.includes('wy') && sources.includes('tx') && sources.includes('kg'),
      sources.join(', ')
    );
    check(
      '平台可用音质解析正确',
      manager.qualitysFor('wy').join(',') === '128k,320k,flac',
      manager.qualitysFor('wy').join(',')
    );
    check('不支持的动作会被拦住', manager.supportsSource('local', 'lyric') === false, 'local 未声明');

    /* ---------- 3. 取播放链接（走 lx.request 全链路） ---------- */
    const musicInfo = {
      source: 'wy',
      songmid: '1974443814',
      name: '测试歌曲',
      singer: '测试歌手',
      interval: 245,
      albumName: '测试专辑',
      albumId: '123',
      img: '',
      types: [{ type: '320k' }],
      _types: { '320k': { size: '10MB' } },
    };
    const resolved = await manager.getMusicUrl('wy', musicInfo, '320k');
    check(
      '取到播放链接（含 HTTP 回环请求）',
      resolved && /^http:\/\/127\.0\.0\.1:39777\/stream\/wy\/320k\/1974443814\.flac$/.test(resolved.url),
      resolved && resolved.url
    );

    const lowQuality = await manager.getMusicUrl('kg', { source: 'kg', songmid: 'HASH123', hash: 'HASH123' }, '128k');
    check('酷狗 hash 走 songmid 兜底', /stream\/kg\/128k\/HASH123/.test(lowQuality.url), lowQuality.url);

    /* ---------- 4. 切源后仍可用 ---------- */
    const second = await manager.importScript(
      sampleScript.replace('@version 1.0.0', '@version 1.0.1')
    );
    await manager.setActive(second.id);
    const afterSwitch = await manager.getMusicUrl('tx', { source: 'tx', songmid: 'MIDX', strMediaMid: 'M1' }, 'flac');
    check(
      '切换音源后仍可正常取链',
      manager.isReady() === true && /stream\/tx\/flac\/MIDX/.test(afterSwitch.url),
      'active=' + manager.activeId + ' url=' + afterSwitch.url
    );

    /* ---------- 5. 反例：无元信息头 ---------- */
    let badHeaderOk = false;
    try {
      await manager.importScript('console.log("no header")');
    } catch (error) {
      badHeaderOk = /无效的自定义源文件/.test(error.message);
    }
    check('拒绝缺少元信息注释块的脚本', badHeaderOk);

    /* ---------- 6. 反例：初始化就抛错 ---------- */
    const brokenInfo = await manager.importScript(
      '/*!\n * @name 坏掉的源\n * @version 1.0.0\n */\nthrow new Error("boom in init")\n'
    );
    const broken = await manager.setActive(brokenInfo.id);
    check('初始化抛错会被报告', broken.ok === false && /boom in init/.test(broken.error), broken.error);

    /* ---------- 7. 反例：死循环脚本不卡死主进程 ---------- */
    const hangInfo = await manager.importScript(
      '/*!\n * @name 死循环的源\n * @version 1.0.0\n */\nwhile (true) {}\n'
    );
    const started = Date.now();
    const hang = await manager.setActive(hangInfo.id);
    const elapsed = Date.now() - started;
    check(
      '死循环脚本被隔离（worker 可强杀）',
      hang.ok === false && elapsed < 15000,
      '耗时 ' + elapsed + 'ms，错误=' + (hang.error || '').slice(0, 60)
    );

    /* ---------- 8. 无源状态 ---------- */
    await manager.setActive('');
    check(
      '取消启用后状态正确',
      manager.isReady() === false && manager.getStatus().activeId === '',
      manager.getStatus().status.message
    );

    /* ---------- 9. 删除源 ---------- */
    await manager.remove(second.id);
    check(
      '删除音源后列表同步',
      !manager.list().some((item) => item.id === second.id),
      '剩余 ' + manager.list().length + ' 个'
    );

    console.log('\n日志样例：');
    for (const line of logs.slice(0, 12)) console.log('  ' + line);
  } finally {
    manager.destroy();
    apiServer.close();
  }

  const failed = results.filter((item) => !item.ok);
  console.log('\n共 ' + results.length + ' 项，失败 ' + failed.length + ' 项');
  if (failed.length) {
    for (const item of failed) console.log('  FAIL: ' + item.name + ' -> ' + item.detail);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('自检异常：', error);
  process.exitCode = 1;
});
