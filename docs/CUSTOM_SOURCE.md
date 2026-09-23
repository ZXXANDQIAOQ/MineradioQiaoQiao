# 自定义音源（LX 音源脚本）

把 [lx-music-mobile](https://github.com/lyswhut/lx-music-mobile) 的「自定义源」能力接到了 Mineradio 上：
导入一个 `.js` 音源脚本，播放取链和歌词就交给它，用来补内置接口拿不到的链接（比如需要会员/版权受限的歌）。

## 入口在哪

控制台（`#fx-panel`）→ **系统** 页 → **自定义音源** 分组。

## 三种运行模式

| 模式 | 行为 |
| --- | --- |
| **关闭** | 完全不使用自定义音源，一切走内置接口 |
| **取链失败时兜底**（默认） | 内置接口没给出可用地址时，才去问音源 |
| **优先使用** | 先问音源要链接，拿不到再回落到内置接口 |

模式存在 `localStorage` 的 `mineradio.userApiMode`，与队列、播放器状态无关，切歌不影响。

## 导入方式

- **在线导入**：粘贴脚本直链（`http://` / `https://`，`.js`）。由本机主进程下载，不受渲染进程跨域限制。
- **本地导入**：文件选择器，只允许 `.js`。

脚本必须以 `/* ... */` 注释块开头，块里声明元信息：

```js
/*!
 * @name 我的音源
 * @description 一句话说明
 * @version 1.0.0
 * @author 作者
 * @homepage https://example.com
 */
```

限制：单个脚本 ≤ 9 MB；最多同时保存 20 个源；`@name` ≤ 24 字，`@description` ≤ 36 字，`@author` ≤ 56 字。

## 支持范围

| 项 | 说明 |
| --- | --- |
| 接口版本 | LX 自定义源接口 `2.0.0`（`lx.version`） |
| 平台 | `wy` 网易云 / `tx` QQ音乐 / `kg` 酷狗 / `kw` 酷我 / `mg` 咪咕 |
| 动作 | `musicUrl`（取播放链接）、`lyric`（歌词）、`pic`（封面，接口已具备，UI 暂未接入） |
| 曲线 | 网易云走 `id`，QQ 走 `mid`/`mediaMid`，酷狗走 `hash`，字段会按各家习惯补齐 |

**不接管**的部分：搜索、歌单、榜单仍然走内置接口。音源只负责「拿到歌之后，去哪儿取真正的播放链接」。

## 与上游 LX 的差异

- **放行了 `lyric` / `pic`**：上游只允许脚本声明 `musicUrl`（`lyric`/`pic` 仅对 `local` 平台开放），这里对音乐平台也放行了，因此音源脚本可以顺带提供歌词。脚本不声明这两个动作时，行为与上游完全一致。
- **存储改为文件**：上游用 AsyncStorage，这里是 `<userData>/user-api/sources.json` + `scripts/<id>.js`。
- **运行环境是 Node worker + `vm`**：上游是 Android 侧 QuickJS 沙箱。`lx` API 契约（`lx.request` / `lx.send` / `lx.on` / `lx.utils` / `lx.EVENT_NAMES`）原样保留，`lx.env` 为 `pc`。
- **等待超时**：取链 12 s、歌词 9 s、脚本初始化 8 s（死循环脚本会被强杀，不影响播放器）。

## 数据与目录

- 默认目录：`%APPDATA%/Mineradio/user-api/`
- 可用环境变量 `MINERADIO_USER_API_DIR` 覆盖（自检脚本就用它）
- 面板上的「打开目录」按钮会直接打开这个文件夹

## 自检

不启动桌面版也能验证沙箱（会临时改数据目录，跑完即清理）：

```bash
node desktop/user-api/selftest.js
```

脚本覆盖：导入 / 元信息解析 / 初始化 / 取链 / 歌词 / 切源 / 删除 / 坏脚本拒绝 / 初始化抛错上报 / 死循环强杀。

## 安全

脚本跑在同一台机器的独立 worker 线程里，通过 `vm` 建上下文，只注入 `lx` 对象；文件、进程、`require` 都不可见；`lx.request` 只走宿主代理，且只有 `http(s)`。

但**沙箱不是保险箱**：恶意脚本仍可能滥用网络与内存。只导入你信任来源的音源；面板里也保留了每个源的「脚本日志」用于排查。

## 已知限制

- 只有桌面版（Electron）支持；纯浏览器访问 `localhost` 时面板会提示不可用。
- 封面（`pic`）接口已通但未接入 UI，封面仍来自内置接口。
- 音源脚本不做混淆/签名校验，导入即为信任。
- 音质档位（`qualitys`）由脚本声明，与内置档位不是一套，所以不会触发「音质降级」提示。

## 来源与许可

`desktop/user-api/lx-preload.js` 移植自 `lx-music-mobile`（Apache-2.0）的
`android/app/src/main/assets/script/user-api-preload.js`，保留原实现以保证接口契约一致；
其余（sandbox worker / store / manager / 面板 / 播放接入）为 Mineradio 侧实现。
详见 `docs/THIRD_PARTY_PORTS.md`。
