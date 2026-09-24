# 在线搜索（LX 搜索层）

搜索实现来自 **lx-music-mobile** 的内置音源 SDK，界面仍然是 Mineradio 自己的搜索页
（`#search-area`：搜索框 + `#search-mode-tabs` 标签栏 + 结果卡片）。

- 上游：`lx-music-mobile`（Apache-2.0），参考版本 `fb8480728`（2026-09-19）
- 移植目录：`desktop/lx-search/`
- 界面：`public/js/modules/05-playback/07-search.js`、`public/index.html`

## 支持的平台

| 标签 | provider | LX 音源 | 搜索实现 |
| --- | --- | --- | --- |
| NE | `netease` | `wy` | eapi `/api/search/song/list/page` |
| QQ | `qq` | `tx` | `u.y.qq.com` `DoSearchForQQMusicDesktop` + zzc 签名 |
| KG | `kugou` | `kg` | `songsearch.kugou.com/song_search_v2` |
| KW | `kuwo` | `kw` | `search.kuwo.cn/r.s` |
| MG | `migu` | `mg` | `jadeite.migu.cn` `v3/search/searchAll` + 签名 |
| QS | `qishui` | — | 仍是 Mineradio 原本的汽水匹配源 |
| All | 聚合 | 五个 | 五个平台各取一页，按相关性评分合并去重 |

## 数据流

```
搜索标签栏（界面：Mineradio）
  └─ searchProviderUrl(provider, q, limit, offset)
       └─ GET /api/lx/search?source=wy|tx|kg|kw|mg&keywords=…&limit=…&offset=…
            └─ desktop/lx-search/index.js  search()
                 └─ desktop/lx-search/sources/{wy,tx,kg,kw,mg}.js   （LX 原实现）
                      └─ HTTP + 加密签名（desktop/lx-search/{http,crypto,format}.js）
```

`desktop/lx-search/sources/*.js` 与上游逐行对应，只把 ESM `import` 换成 CommonJS
`require`，请求参数、加密方式、字段映射都没有改写。加密部分在
`desktop/lx-search/crypto.js` 里用 Node 内置 `crypto` 重写了 LX 的
`eapi`（AES-128-ECB）与 `zzcSign`（SHA1 切片 + 异或打散）。

### 字段换算

LX 曲目（`{ songmid, singer, name, albumName, interval, types, _types, hash, … }`）
统一换算成 Mineradio 曲目结构，命名对齐既有的 `mapSongRecord` / `mapQQTrack` /
`mapKugouSearchItem`，所以搜索结果列表、右键菜单、播放取链都不用改：

- `netease`：`id = songmid`
- `qq`：`mid / songmid = songmid`，`qqId = songId`，`mediaMid = strMediaMid`
- `kugou`：`hash = FileHash`，`hqHash / sqHash / resHash` 从 `_types` 里取
- `kuwo`：`id = songmid`（酷我 MUSICRID 里的数字部分）
- `migu`：`id / songId = songId`，`copyrightId` 一并带上（音源脚本取链要用）

### 分页

LX 音源按「页码」翻页，各家每页返回的条数并不总等于请求值（咪咕会一次给两倍）。
`desktop/lx-search/index.js` 按 `(音源, 关键词, limit)` 缓存已取过的页，把连续页拼成
一个窗口再按 `offset/limit` 精确切片，最多为一次调用补 5 页。

## 播放说明

- **网易云 / QQ / 酷狗**：内置取链保持原样；自定义音源（优先模式）会先被问到。
- **酷我 / 咪咕**：Mineradio 没有这两家的内置取链，播放完全依赖自定义音源脚本。
  播放链路对这两个平台显式返回「没有内置地址」，不会拿别家的 id 去问网易云；
  音源脚本也拿不到时，按既有的「无可用音源」流程提示。
- 想在音源脚本里支持这两家，脚本需声明 `kw` / `mg` 平台，且支持 `musicUrl` 动作。
- **汽水**在 LX 音源模式下不参与综合搜索（它的播放能力来自已经下线的登录入口），
  标签栏里的 QS 也一并收起，避免搜出点了放不了的歌。

## 自动换平台试播

同一首《晴天》在五个平台都有条目，但某些平台的某些歌取不到可播放地址
（版权、音质档位、音源脚本支持范围）。这时不再直接弹「放不了」，
而是自动换到别的平台试试。

**换的是「播放平台」，不是「音源脚本」**：自始至终用的是同一个音源脚本，
只是让它拿另一个平台的 id 去取链（请求里的 `provider` 变，`/api/user-api/song/url` 不变）。
实现见 `public/js/modules/05-playback/11a-lx-platform-scan.js`。

触发时机（`13-playback-start-audio.js` 里两处）：

1. 本平台取不到链接（内置接口和音源都没给出地址）
2. 链接拿到了、媒体却起不来（直链失效 / 防盗链）

行为：

- 按 `netease → qq → kugou → kuwo → migu` 的顺序筛出**能搜到、且当前音源脚本
  声明支持 `musicUrl`** 的平台，去掉当前平台，最多试 5 个
- 每换一个平台**先等 0.5 秒**（`LX_PLATFORM_SCAN_INTERVAL_MS`）再取链，第一个成功即停；
  控制台会打印在试哪一个：`[LxPlatformScan] 试第 2/4 个平台：QQ音乐`
- 命中后把队列里的条目换成那个平台的版本，并把已取到的地址直接交给播放链路
  （不重复取链），同时提示「已自动切换平台」
- 全部失败就还原队列条目、返回 `null`，交回既有的「已登录平台兜底」与提示流程
- 换平台后的那次播放带 `lxPlatformScanDepth: 1`，失败不会再往下扫，避免递归

候选来源（优先用零成本的）：

1. 搜索合并时顺手留下的同曲其它平台版本 —— 见 `07-search.js` 的
   `collectSearchAlternate()`，`song.lxAlternates` 最多留 5 条
2. 没留到时，用「歌名 + 歌手」在目标平台补搜一次 `/api/lx/search`

前置条件：音源脚本已就绪（`userApiStatusReady()`）且模式不是「关闭」。
音源关掉、或平台不是 LX 五家（汽水 / Spotify / 本地曲目 / 播客）时不启用。

## 自检

```bat
:: 离线（不联网）：字段换算、加密签名、分页、前端接线、换平台试播
node --test tests/lx-search.test.js tests/lx-search-frontend.test.js tests/lx-platform-scan.test.js

:: 联网冒烟：五个平台真实接口 + /api/lx/search 端点
node scripts/check-lx-search-live.js

:: 真实渲染进程里跑一遍「搜索 → 点播放 → 取链」（会调用本机已启用的音源脚本）
node scripts/check-lx-playback-live.js
```

`check-lx-playback-live.js` 按平台逐首点播并打印 `[UserApi]` 取链日志，
排查「搜到歌放不了」时先用它，能看到 `audio.src` 到底落在内置接口还是音源脚本上。
换平台试播时控制台会多两行 `[LxPlatformScan] 试第 N/M 个平台：QQ音乐`
与 `[LxPlatformScan] 网易云音乐 → QQ音乐 找到可播放版本`。

Electron 渲染进程里的标签栏行为由 `scripts/check-user-api-panel-live.js` 的
「1d. LX 搜索标签」段覆盖。
