# 自定义音源（LX 音源脚本）

把 [lx-music-mobile](https://github.com/lyswhut/lx-music-mobile) 的「自定义源」能力接到了 Mineradio 上：
导入一个 `.js` 音源脚本，播放取链和歌词就交给它，用来补内置接口拿不到的链接（比如需要会员/版权受限的歌）。

## 入口在哪

控制台（`#fx-panel`）→ **系统** 页 → **自定义音源** 分组。
首页那格「导入 LX 音源」也直接跳到这个面板。

## LX 音源模式（默认开启）

界面与播放逻辑仍是 Mineradio 的，但**播放内容获取交给 LX 音源**，因此平台登录入口整体下线：

- 顶部账号按钮、启动登录引导、首页「登录同步歌单」磁贴、播放链路的「去登录」提示都不再通向登录；
  触发时会提示去导入音源。
- 需要账号的写入类操作（红心 / 收藏同步）会明确提示「已下线」，不再弹登录。
- 开关是 `public/js/modules/00-state/12-lx-only-mode.js` 顶部的 `MINERADIO_LX_ONLY_MODE`，
  改成 `false` 就恢复登录入口（底层 cookie / 退出登录 / 相关接口都没删）。
- 音源脚本**只管取链、歌词、封面**：搜索、歌单、榜单仍走内置接口 —— 这是 LX 自定义源契约的限制，
  脚本的 `actions` 里没有 search 这一项。

## 三种运行模式

| 模式 | 行为 |
| --- | --- |
| **关闭** | 完全不使用自定义音源，一切走内置接口 |
| **取链失败时兜底** | 内置接口没给出可用地址时，才去问音源 |
| **优先使用**（默认） | 先问音源要链接，拿不到再回落到内置接口 |

模式存在 `localStorage` 的 `mineradio.userApiMode`，与队列、播放器状态无关，切歌不影响。
默认是「优先使用」——LX 音源是播放内容的主要来源；想回到内置接口优先就切「兜底」。

## 导入方式

- **在线导入**：面板顶部的输入框里粘贴脚本直链（`http://` / `https://`，`.js`），点「在线导入」或直接回车。由本机主进程下载，不受渲染进程跨域限制。
  - 从浏览器地址栏复制的 GitHub / Gitee 代码页链接会被自动改写成 raw 直链（`github.com/u/r/blob/...` → `raw.githubusercontent.com/u/r/...`；`gitee.com/u/r/blob/...` → `gitee.com/u/r/raw/...`）。
  - 如果链接返回的是网页而不是脚本，会提示改用直链，不会写入半截内容。
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

四条命令，从快到全：

```bash
node tests/user-api-custom-source.test.js        # 单元回归（不联网、不起 Electron）
node desktop/user-api/selftest.js                # 沙箱自检（本机起假接口，跑通全链路）
node scripts/check-user-api-panel-live.js        # 面板 live 检查（真起 Electron，走完导入→启用→删除）
quick-check.bat                                  # 仓库总自检（已接入第一条）
quick-check.bat full                             # 再加 Electron 运行时冒烟
```

- **单元回归**（`tests/user-api-custom-source.test.js`）覆盖：元信息解析与长度上限、导入即生效、取链与音质挑选、未声明动作被拒、`lyric` 契约校验、初始化抛错上报、删除后回退、在线导入协议校验 / 直链纠正 / 网页响应识别 / 本机回环真下载、面板不依赖 `window.prompt`、数量上限、provider→LX 字段映射。
- **沙箱自检**覆盖：导入 / 初始化 / 取链 / 歌词 / 切源 / 删除 / 坏脚本拒绝 / 死循环强杀。
- **面板 live 检查**覆盖：面板 DOM 与按钮、在线导入输入框与空链接 / 非法链接的提示（不联网）、IPC 通路、导入→启用→状态渲染、模式切换持久化、歌词钩子短路、删除后回到基线（检查前已有的音源不会被删，生效源会还原）。

> 面板里不要用 `window.prompt` / `window.alert` 之外的浏览器弹窗能力：Electron 渲染进程调用 `prompt()` 会直接抛 `prompt() is not supported.`，静默失败。需要输入一律用页面内表单元素。

脚本契约提醒：`lyric` 动作必须返回**对象**（`{ lyric, tlyric?, rlyric?, lxlyric? }`），返回纯字符串会被 preload 判为失败 —— 这一条在单元回归里有两个方向的断言。

## 安全

脚本跑在同一台机器的独立 worker 线程里，通过 `vm` 建上下文，只注入 `lx` 对象；文件、进程、`require` 都不可见；`lx.request` 只走宿主代理，且只有 `http(s)`。

但**沙箱不是保险箱**：恶意脚本仍可能滥用网络与内存。只导入你信任来源的音源；面板里也保留了每个源的「脚本日志」用于排查。

## 已知限制

- 只有桌面版（Electron）支持；纯浏览器访问 `localhost` 时面板会提示不可用。
- 封面（`pic`）接口已通但未接入 UI，封面仍来自内置接口。
- 音源脚本不做混淆/签名校验，导入即为信任。
- 音质档位（`qualitys`）由脚本声明，与内置档位不是一套，所以不会触发「音质降级」提示。
  播放时 Mineradio 会把内置档位先翻译成脚本认识的标识，再按脚本声明的音质表退让：

  | Mineradio | 音源脚本 |
  | --- | --- |
  | `standard` | `128k` |
  | `exhigh` | `320k` |
  | `lossless` | `flac` |
  | `hires` / `jymaster` | `flac24bit` |

  例如脚本只声明 `128k / 320k / flac` 时，请求 `hires` 会落到 `flac`，
  不会把 `lossless` 这类内置档位原样透传（那会变成 `level=undefined`）。

## 来源与许可

`desktop/user-api/lx-preload.js` 移植自 `lx-music-mobile`（Apache-2.0）的
`android/app/src/main/assets/script/user-api-preload.js`，保留原实现以保证接口契约一致；
其余（sandbox worker / store / manager / 面板 / 播放接入）为 Mineradio 侧实现。
详见 `docs/THIRD_PARTY_PORTS.md`。
