/* ====================================================================
 *  LX 音源模式（默认开启）
 *
 *  界面与播放逻辑仍然是 Mineradio 的，但「播放内容获取」交给 LX 自定义音源：
 *  取链 / 歌词 / 封面都由导入的音源脚本提供，因此不再需要平台账号，
 *  于是把 QQ音乐、网易云、汽水音乐、酷狗音乐 的登录入口整体下线。
 *
 *  下线的是「入口」，不是底层能力 —— cookie 读写、退出登录、相关接口都还在，
 *  要恢复登录界面把下面这个常量改成 false 即可（其余代码无需改动）。
 *
 *  加载顺序：本文件在 index-loader.js 里排在所有业务模块之前，
 *  后面的模块可以直接用 lxOnlyModeEnabled() 判断。
 * ==================================================================== */

var MINERADIO_LX_ONLY_MODE = true;

var MINERADIO_LX_ONLY_HINT = '已切换为 LX 音源模式：无需登录平台，播放内容由音源脚本提供。';

function lxOnlyModeEnabled() {
  return MINERADIO_LX_ONLY_MODE === true;
}

/** 需要提示「登录入口已下线」的地方统一走这里，保证口径一致 */
function lxOnlyModeHint(detail) {
  var text = MINERADIO_LX_ONLY_HINT + (detail ? detail : '');
  if (typeof showToast === 'function') {
    try { showToast(text); } catch (_) { console.info('[LxOnlyMode]', text); }
  } else {
    console.info('[LxOnlyMode]', text);
  }
  return text;
}

/**
 * 把账号入口从界面上摘掉。
 * 用 visibility 而不是 display:none —— 顶部右侧的胶囊定位、玻璃折射贴图
 * 都拿 user-btn 的 rect 当锚点，display:none 会让这些计算全部塌成 0。
 */
function applyLxOnlyModeChrome() {
  if (!lxOnlyModeEnabled()) return;
  var root = document.documentElement;
  if (root && root.classList) root.classList.add('lx-only-mode');
  var btn = document.getElementById('user-btn');
  if (!btn) return;
  btn.setAttribute('aria-hidden', 'true');
  btn.setAttribute('tabindex', '-1');
  btn.title = '账号入口已下线（LX 音源模式）';
}

applyLxOnlyModeChrome();

if (typeof document !== 'undefined' && document.addEventListener) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyLxOnlyModeChrome);
  } else {
    applyLxOnlyModeChrome();
  }
}
