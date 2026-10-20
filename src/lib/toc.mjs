// 历史节点（Turn Navigator / History Nodes）
//
// ---- 为什么需要它 ----------------------------------------------------------
// 桌面端右侧有一条「对话目录」（ConversationToc）：每轮提问一根小竖条，
// 当前轮加长，点一下跳过去。手机上没有，因为它被一条媒体查询挡住了：
//
//     const u = D(() => !n.mobile && !n.sessionLoading && n.items.length > 1)
//     const $8e = 640, z8e = `(max-width: ${$8e}px)`   // _u()
//
// 也就是说窗口 ≤640px 时 mobile=true，整个目录组件根本不渲染。
// 桌面端和 web 端读的是同一份数据、同一个 /transcript 接口 —— 不是数据缺失，
// 纯粹是一个宽度阈值。
//
// ---- 为什么用注入而不是改 Kimi 的包 ----------------------------------------
// 改官方 bundle 有两个硬伤：
//   1. 变量名是压缩过的（nu / u / MobileTopBar 都只是当前版本的样子），
//      每次 Kimi 发版都要重新人肉定位；
//   2. 官方 TOC 用 `left: calc(50% + content-max/2 + 14px)` 定位，手机窄屏上
//      会压在正文上，且 toc-bar 只有 3px 宽，手指点不中。
//
// 注入版只依赖**语义属性**：`[data-turn-id]`（用户气泡上的轮次 id，
// 官方自己加的）。这个属性一旦消失，脚本会静默退出，白屏是不可能的。
//
// ---- 形态 --------------------------------------------------------------
// 与输入框上方的「后台 Bash / 后台 Agent」同款胶囊，文案「历史节点」，
// 固定在输入框右上角上方那一行的右端；点开是节点列表（向上弹出）。
//
// ---- 节点模型：按 data-turn-id 字符串，不按轮次序号 ----------------------
// 早期版本用 `t(\d+)` 抽轮次号当主键，结果把同一轮里的「追加消息」
// （steered message，如 t0.41.f1）和首条消息（t0:input）合并成一条，
// 桌面 11 个节点、手机只剩 9 个，而且序号还跳号。
// 现在直接用 turnId 字符串当主键，排序用「数字段 + 后续段」比较，
// 与桌面目录 1:1 对齐。
//
// ---- 平滑滚动 -----------------------------------------------------------
// 官方目录点击后是「瞬移 + 短距离缓动」：几万像素的会话里那一帧要重排整段
// 虚拟列表，看起来就是卡一下。这里做两件事：
//   1. 自己跳转时用 rAF 缓动（每帧只走一段，虚拟列表跟得上）；
//   2. 桌面端点官方目录时，临时给滚动容器加 `scroll-behavior:smooth`，
//      让应用自己的 scrollTop 赋值变成浏览器合成的平滑滚动（实测
//      34k 像素全程 60fps、无长任务），用户一滚就撤销，不影响流式跟随。
//
// ---- 兼容性契约 ---------------------------------------------------------
//   - 只在服务端注入到 text/html 的 </body> 前，不改任何 JSON
//   - POCKET_TOC=0 完全关闭（连 script 标签都不出现）
//   - 找不到锚点 → 自己不渲染，不影响原页面
//   - 宿主页面用 data-color-scheme 表达明暗（与 Kimi 自己的 _u 体系一致）

export const TOC_SCRIPT_ID = 'pocket-turn-nav-script';

/** 注入标记：测试和排障时用来确认「注入确实发生了」 */
export const TOC_MARKER = `<!-- kimi-pocket:turn-nav -->`;

/**
 * 这条响应是否要注入历史节点。
 *
 * 只认 HTML 主文档：
 *   - text/html + 200：正常入口
 *   - 不碰 JSON / SSE / 静态资源（那些要么是数据，要么会破坏缓存语义）
 *   - 上游已压缩的不碰（没法在压缩流上找 </body>）
 *   - HEAD 不碰
 *
 * 关于 content-length：**有就用来提前止损，没有也不拒绝**。
 * 早先这里写成「没有 content-length 一律不注入」，集成测试立刻发现假
 * Desktop 用 chunked 编码发 HTML 时注入整段失效 —— 而真实上游哪天换成
 * chunked 也一样会静默失效，而且**完全没有任何报错**，只是功能不见了。
 * 现在改成：没长度就带硬上限缓冲（MAX_HTML_BYTES），超限则降级原样透传。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').IncomingMessage} upstreamRes
 * @param {{enabled?: boolean}} cfg
 * @returns {boolean}
 */
export function shouldInjectNav(req, upstreamRes, cfg) {
  if (!cfg || !cfg.enabled) return false;
  if (req.method !== 'GET') return false;
  const status = upstreamRes.statusCode ?? 0;
  if (status !== 200) return false;
  const ct = String(upstreamRes.headers['content-type'] ?? '');
  if (!/^text\/html\b/i.test(ct)) return false;
  if (upstreamRes.headers['content-encoding']) return false;
  const len = Number(upstreamRes.headers['content-length'] ?? 0);
  // 已知长度且过大 → 说明不是主文档（或上游吐了错误页），不碰
  if (Number.isFinite(len) && len > MAX_HTML_BYTES) return false;
  return true;
}

/** HTML 缓冲硬上限：主文档只有 2.8KB，2MB 已经是上万倍余量 */
export const MAX_HTML_BYTES = 2 * 1024 * 1024;

const MAX_TITLE_CHARS = 40;

/**
 * HTML 里是否已经注入过（防止上游缓存把带 script 的页面再注入一次）。
 * @param {string} html
 * @returns {boolean}
 */
export function alreadyInjected(html) {
  return html.includes(TOC_SCRIPT_ID);
}

/**
 * 把历史节点脚本塞进 HTML。
 *
 * 为什么找 </body> 而不是 </head>：脚本要操作 DOM，放在 body 末尾能保证
 * #app 已经在树里；虽然脚本内部有等待逻辑，但少一层等待总是好的。
 *
 * 找不到 </body> 时退到 </html>，再退到末尾追加 —— 宁可样式怪一点，
 * 也不要因为宿主 HTML 少个标签就整个页面崩掉。
 *
 * @param {string} html 上游返回的 HTML
 * @returns {string}
 */
export function injectTurnNav(html) {
  if (typeof html !== 'string' || html.length === 0) return html;
  if (alreadyInjected(html)) return html;

  const snippet = TOC_MARKER + buildScriptTag();
  const lower = html.toLowerCase();

  const bodyEnd = lower.lastIndexOf('</body>');
  if (bodyEnd >= 0) return html.slice(0, bodyEnd) + snippet + html.slice(bodyEnd);

  const htmlEnd = lower.lastIndexOf('</html>');
  if (htmlEnd >= 0) return html.slice(0, htmlEnd) + snippet + html.slice(htmlEnd);

  return html + snippet;
}

function buildScriptTag() {
  // 单引号包裹 script 内容：里面全是双引号，不会提前闭合。
  // 仍然把 </script 转义掉，避免字符串里出现结束标签。
  const code = CLIENT_JS.replace(/<\/script/gi, '<\\/script');
  return `<script id="${TOC_SCRIPT_ID}">${code}</script>`;
}

// ---------------------------------------------------------------- 会话标识
//
// 缓存 key 必须能**唯一标识一个会话**，否则两个会话共用一份记录，
// 表现就是「B 会话里出现 A 会话的历史节点」。
//
// 早先这里直接用 location.pathname。对**已存在的会话**这是准确的
// （路径就是 /sessions/session_<uuid>），但对「新建会话」不行 ——
// Desktop 自己的路径构造是：
//     id 为空  → "/"
//     id 有值  → "/sessions/" + encodeURIComponent(id)
// （核对过 bundle 里的 $he() / EU() 两个函数）
// 所以新建会话在**拿到 id 之前**路径都是 "/"，多个新会话共用同一份缓存。
//
// 修法：路径能取到 id 就用 id（s:<id>）；取不到就用
// 「路径 + 最小真实 turn id 指纹」（p:<path>#t0）区分。
// 新会话拿到 id 后由 migrateKey 把过渡记录搬过去。
//
// 这几个函数在这里定义（而不是塞进 CLIENT_JS 字符串里），是为了能被
// **直接单测** —— 注入脚本是一整个 IIFE，在 Node 里跑它需要伪造整套 DOM，
// 太脆。下面 CLIENT_JS 里会原样复用这同一份实现。

const SESSION_PATH_RE = '/sessions/';

/** 从 pathname 里取出会话 id；取不到返回 '' */
export function sessionIdFromPath(p) {
  if (!p || p.indexOf(SESSION_PATH_RE) !== 0) return '';
  const rest = p.slice(SESSION_PATH_RE.length);
  // 带子路径（/sessions/<id>/children 之类）不算会话页
  if (!rest || rest.indexOf('/') >= 0) return '';
  try {
    return decodeURIComponent(rest) || '';
  } catch {
    return '';
  }
}

/** 真实轮次 id 判定（乐观消息 msg_opt_* 不算） */
export function isRealTurnIdForSession(id) {
  return /^t\d+(?:[:.]|$)/.test(String(id || ''));
}

/**
 * 会话指纹：给定一组 turn id，取**最小**的真实轮次号。
 * 拿不到返回 ''。
 *
 * 用「最小」而不是「最新」：用户往下滚会加载更多历史，最新那条一直在变，
 * 最小那条（t0）在会话内稳定。
 */
export function sessionFingerprintFrom(turnIds) {
  let best = '';
  let bestN = Infinity;
  for (const id of turnIds || []) {
    if (!isRealTurnIdForSession(id)) continue;
    const m = /^t(\d+)/.exec(String(id));
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (n < bestN) {
      bestN = n;
      best = `t${n}`;
    }
  }
  return best;
}

/**
 * 当前会话的缓存 key。
 *
 * 形态：
 *   /sessions/<uuid>  →  "s:<uuid>"            （精确，最常用）
 *   其它路径          →  "p:<pathname>#<fp>"   （过渡态，靠指纹区分）
 *
 * 前缀 s:/p: 让两种形态永不相撞 —— 万一某个会话 id 恰好叫 "p:/"，
 * 加前缀也不会串。
 *
 * @param {string} pathname
 * @param {string[]} turnIds 当前 DOM 里的 data-turn-id 列表
 */
export function sessionKeyFor(pathname, turnIds) {
  const p = pathname || '/';
  const sid = sessionIdFromPath(p);
  if (sid) return `s:${sid}`;
  const fp = sessionFingerprintFrom(turnIds);
  return `p:${p}${fp ? `#${fp}` : ''}`;
}

/**
 * 过渡 key → 精确 key 的迁移。
 *
 * 新会话时序：路径 "/"（此时已在记录）→ 应用 replaceState 到
 * /sessions/<uuid>。不迁移的话，刚记下的节点留在 p:/#t0 里，
 * 而新 key 是空的 —— 用户会看到「刚发的消息不在目录里」。
 *
 * 允许的迁移方向（其余一律拒绝）：
 *   p:<path>        → s:<id>       新会话拿到 id，过渡态收尾
 *   p:<path>        → p:<path>#t0  同一新会话内指纹出现（发第一条消息时）
 *   s:/p: 之间其它组合、精确态内部迁移 —— 全部拒绝，避免串会话。
 *
 * 为什么需要第二条：新会话刚打开时 DOM 里还没有消息，key 是 p:/；
 * 用户发出第一条消息后指纹变成 t0，key 变成 p:/#t0。
 * 不做这条迁移的话，用户会在「刚发出第一条消息」的瞬间丢掉刚记下的东西。
 *
 * @param {(k:string)=>string|null} getItem
 * @param {(k:string,v:string)=>void} setItem
 * @param {(k:string)=>void} removeItem
 */
export function migrateKeyWith(fromKey, toKey, { getItem, setItem, removeItem }) {
  if (!fromKey || !toKey || fromKey === toKey) return false;
  const fromIsTransient = fromKey.indexOf('p:') === 0;
  const toIsPrecise = toKey.indexOf('s:') === 0;
  const toIsTransient = toKey.indexOf('p:') === 0;
  if (!fromIsTransient) return false;
  // 过渡态 → 精确态，或 过渡态 → 过渡态（指纹细化，同一路径）
  const transientRefine =
    toIsTransient && fromKey === toKey.split('#')[0];
  if (!toIsPrecise && !transientRefine) return false;
  try {
    // 目标已有记录就不动它（那才是它自己的）
    if (getItem(toKey)) return false;
    const raw = getItem(fromKey);
    if (!raw) return false;
    setItem(toKey, raw);
    removeItem(fromKey);
    return true;
  } catch {
    return false;
  }
}

// 上面三个函数会被**原样注入**到浏览器脚本里（见 CLIENT_JS 里的 ${CLIENT_HELPERS}）。
// 为什么要注入源码而不是重写一遍：重写就会出现两份实现，
// 改了一边忘另一边 —— 这正是本项目已经踩过的坑（headersWithLength 那四处复制粘贴）。
//
// 注入时做两件事：
//   - 去掉 export 关键字与类型注解（源码本身就是 ES5 兼容的写法）
//   - 保持函数名一致，客户端直接调用
function clientSourceOf(fn) {
  return fn
    .toString()
    .replace(/^export\s+/, '')
    // 函数名保留；这里只是确保没有 TS 残留
    .trim();
}

// 注入到浏览器时，这些函数会改名（避免和页面自身的全局符号撞车），
// 而且函数体内部的互相调用也必须跟着改 —— 只改 `function 旧名(` 会留下
// 悬空引用：keyFor 里调 sessionIdFromPath()，但客户端只有 sidFromPath()。
// 实测这个错误会让整个注入脚本在第一次 syncSession 时抛 ReferenceError，
// 胶囊直接不出现（而 new Function(code) 语法检查是通的，抓不到）。
const CLIENT_RENAMES = [
  [isRealTurnIdForSession, 'isRealTurnIdX'],
  [sessionFingerprintFrom, 'fpFromIds'],
  [sessionIdFromPath, 'sidFromPath'],
  [sessionKeyFor, 'keyFor'],
  [migrateKeyWith, 'migrateWith'],
];

function renamedSource(fn, newName) {
  let src = clientSourceOf(fn);
  // 先把函数声明本身改名
  src = src.replace(/^function\s+[A-Za-z0-9_$]+\s*\(/, 'function ' + newName + '(');
  // 再把函数体里对**其它**待注入函数的调用改名
  for (const [target, alias] of CLIENT_RENAMES) {
    const oldName = target.name;
    if (!oldName || oldName === newName) continue;
    // 只替换作为函数调用出现的形态，避免误伤字符串/注释里的同名文本
    src = src.replace(new RegExp('\\b' + oldName + '\\s*\\(', 'g'), alias + '(');
  }
  return src;
}

const CLIENT_HELPERS = CLIENT_RENAMES.map(([fn, alias]) => renamedSource(fn, alias)).join('\n');

// ---------------------------------------------------------------- 客户端脚本
//
// 这段字符串会被原样发到浏览器。约束：
//   - 不能有 ES2022+ 的新语法（老 Android WebView 也要跑）
//   - 不能抛异常（整个 try/catch 包住，失败就静默）
//   - 体积要小（每次打开页面都要下载一次，没法缓存 —— 它内联在 HTML 里）
//
// 节点来源：`.u-bub[data-turn-id]`。屏幕外的节点不在 DOM 里（虚拟列表），
// 但数据其实已经在内存里（transcript 一次拉全），所以滚过去就会渲染出来。

const CLIENT_JS = String.raw`
(function () {
  'use strict';
  var ID = 'pocket-turn-nav';
  var ROOT_ID = ID + '-root';
  if (window.__pocketTurnNav) return;
  window.__pocketTurnNav = true;

  var LABEL = '历史节点';
  var PRELOAD_TURNS = 5;
  var STORE_PREFIX = 'kimi-pocket.toc.';
  var STORE_VERSION = 3;
  var MAX_TITLE = ${MAX_TITLE_CHARS};
  var PILL_H = 28;

  var CSS = [
    // ---- 胶囊：与输入框上方的 .ui-pill 同尺寸同字体 ----
    '#' + ROOT_ID + '{position:fixed;z-index:2147483002;right:12px;font-family:inherit;',
    '-webkit-tap-highlight-color:transparent;transition:opacity .16s ease;opacity:0;pointer-events:none;}',
    '#' + ROOT_ID + '.on{opacity:1;pointer-events:auto;}',
    '#' + ROOT_ID + ' .tn-btn{display:inline-flex;align-items:center;gap:6px;height:28px;',
    'padding:4px 8px;margin:0;border:0;border-radius:10px;cursor:pointer;user-select:none;',
    'font-family:inherit;font-size:14px;font-weight:400;line-height:20px;letter-spacing:normal;',
    'white-space:nowrap;color:var(--color-text,rgba(255,255,255,.9));',
    'background:var(--color-hover,rgba(255,255,255,.05));',
    'backdrop-filter:blur(24px) saturate(1.8);-webkit-backdrop-filter:blur(24px) saturate(1.8);}',
    '#' + ROOT_ID + ' .tn-btn:hover,#' + ROOT_ID + ' .tn-btn:focus-visible{',
    'background:var(--color-line,rgba(255,255,255,.12));outline:none;}',
    '#' + ROOT_ID + ' .tn-btn:active{opacity:.72;}',
    '#' + ROOT_ID + ' .tn-ico{flex:none;width:16px;height:16px;display:block;opacity:.85;}',
    '#' + ROOT_ID + ' .tn-tx2{display:block;}',
    // ---- 弹层 ----
    '#' + ROOT_ID + ' .tn-list{position:absolute;right:0;bottom:34px;width:min(280px,72vw);',
    'max-height:min(52vh,340px);overflow-y:auto;overscroll-behavior:contain;',
    'padding:6px;border-radius:14px;display:none;',
    'border:1px solid var(--color-line,rgba(128,128,128,.28));',
    'background:var(--color-bg-translucent,rgba(24,24,24,.94));',
    'backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);',
    'box-shadow:0 8px 28px rgba(0,0,0,.34);}',
    '#' + ROOT_ID + '.open .tn-list{display:block;}',
    '#' + ROOT_ID + ' .tn-item{display:flex;align-items:center;gap:8px;width:100%;',
    'padding:8px;border:0;border-radius:9px;background:none;cursor:pointer;',
    'color:var(--color-text-muted,rgba(235,235,235,.72));text-align:left;',
    'font:inherit;font-size:14px;line-height:1.35;}',
    '#' + ROOT_ID + ' .tn-item:hover,#' + ROOT_ID + ' .tn-item:focus-visible{',
    'background:var(--color-hover,rgba(255,255,255,.07));outline:none;}',
    '#' + ROOT_ID + ' .tn-item.act{color:var(--color-text,rgba(255,255,255,.94));}',
    '#' + ROOT_ID + ' .tn-bar{flex:none;width:3px;height:14px;border-radius:2px;',
    'background:currentColor;opacity:.28;}',
    '#' + ROOT_ID + ' .tn-item.act .tn-bar{opacity:.95;}',
    '#' + ROOT_ID + ' .tn-item .tn-tx{flex:1;min-width:0;overflow:hidden;',
    'text-overflow:ellipsis;white-space:nowrap;}',
    '@media(prefers-reduced-motion:reduce){#' + ROOT_ID + '{transition:none;}}',
    // ---- 「跳不过去」的轻提示 ----
    '#pocket-turn-nav-toast{position:fixed;left:50%;bottom:calc(env(safe-area-inset-bottom,0px) + 150px);',
    'transform:translateX(-50%);z-index:2147483003;max-width:78vw;padding:9px 14px;',
    'border-radius:12px;font-size:13px;line-height:1.35;text-align:center;',
    'color:var(--color-text,rgba(255,255,255,.92));',
    'background:var(--color-bg-translucent,rgba(24,24,24,.94));',
    'border:1px solid var(--color-line,rgba(128,128,128,.28));',
    'backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);',
    'box-shadow:0 6px 24px rgba(0,0,0,.32);}',
    // ---- 左侧系统按钮那一行：多了就横向滑动，别把「历史节点」挤走 ----
    // 必须 !important：应用自己写了 .dock-workbar[data-v-faeab9c7]{flex-wrap:wrap}
    // 这类属性选择器，特异度和我这条单类名相同、而它的样式表在文档里更靠后，
    // 不加 !important 会被压回 wrap（实测溢出为 0，根本不产生横向滚动）。
    '.dock-workbar{overflow-x:auto!important;overflow-y:hidden!important;',
    'scrollbar-width:none!important;flex-wrap:nowrap!important;',
    '-webkit-overflow-scrolling:touch;}',
    '.dock-workbar::-webkit-scrollbar{display:none;width:0;height:0;}',
    '.dock-workbar>*{flex:0 0 auto!important;}'
  ].join('');

  var styleInjected = false;
  function ensureStyle() {
    if (styleInjected || document.getElementById(ID + '-css')) return;
    var s = document.createElement('style');
    s.id = ID + '-css';
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
    styleInjected = true;
  }

  // ---- 节点标识 ------------------------------------------------------------
  // 这个 data-turn-id 是不是一个**真实轮次**（已经落到会话里的）。
  //
  // 用户实测报过：「这个会话实际上一共只有 2 个节点，但是历史会话列表显示有 3 个」。
  // 根因不在缓存 key，在于**乐观消息**：
  //
  //   发出消息的瞬间，前端先塞一条本地临时用户消息进列表占位，
  //   它的 id 是 msg_opt_<base36 时间>_<自增>（技能触发是 msg_skill_opt_…，
  //   转发的 steer 是 msg_opt_steer_<promptId>）。这条同样渲染成
  //   .u-bub[data-turn-id]，于是被采集器当成第 3 个节点记下来。
  //
  //   等服务端把真正的轮次推下来，DOM 里换成 t<n>:input，
  //   但 localStorage 里那条 msg_opt_* 已经在，keyOf 解析不出 t<数字>
  //   就把它排到末位，于是一直挂在列表最下面 —— 幽灵节点。
  //
  // 判据就一条：真实轮次一定是 t<数字> 开头。乐观 id 一律不进目录。
  function isRealTurnId(id) {
    return /^t\d+(?:[:.]|$)/.test(String(id || ''));
  }
  // data-turn-id 的真实形态：t0:input / t0.41.f1 / t8:input …
  // 排序比较「t 后面的数字」再比较剩余段，':input' 视作本轮起点。
  function cmpId(a, b) {
    var ka = keyOf(a), kb = keyOf(b);
    if (ka[0] !== kb[0]) return ka[0] - kb[0];
    var pa = ka[1], pb = kb[1];
    for (var i = 0; i < pa.length && i < pb.length; i += 1) {
      var x = pa[i], y = pb[i];
      if (x.n !== undefined && y.n !== undefined) {
        if (x.n !== y.n) return x.n - y.n;
      } else if (String(x.t) !== String(y.t)) {
        return String(x.t) < String(y.t) ? -1 : 1;
      }
    }
    return pa.length - pb.length;
  }

  function keyOf(id) {
    var m = /^t(\d+)(.*)$/.exec(String(id || ''));
    if (!m) return [1e9, []];
    var rest = m[2];
    var segs = [];
    // ':input' 是本轮第一条消息，必须排在任何 '.<frame>' 之前
    if (rest.charAt(0) === ':') rest = '';
    var parts = rest.match(/\d+|\D+/g) || [];
    for (var i = 0; i < parts.length; i += 1) {
      segs.push(/^\d+$/.test(parts[i]) ? { n: Number(parts[i]) } : { t: parts[i] });
    }
    return [Number(m[1]), segs];
  }

  function cmpSeed(a, b) { return cmpId(a, b); }

  // 找「小于等于 anchor 的最大已知节点」：视口里往往是助手帧（t8.41.f2），
  // 要把它归到它前面那条用户消息（t8.41.f1）上。
  function greatestLE(anchor, ids) {
    var lo = 0, hi = ids.length - 1, best = ids[0];
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (cmpId(ids[mid], anchor) <= 0) { best = ids[mid]; lo = mid + 1; }
      else hi = mid - 1;
    }
    return best;
  }

  function pickTitle(bub) {
    var t = bub.querySelector('.u-text');
    var text = (t ? t.textContent : bub.textContent) || '';
    text = text.replace(/\s+/g, ' ').trim();
    if (!text) text = '（含附件/图片）';
    return text.length > MAX_TITLE ? text.slice(0, MAX_TITLE) + '…' : text;
  }

  // 找某个 turnId 对应的 DOM 节点 —— **只认用户气泡**（.u-bub）。
  //
  // 这里踩过一个很典型的坑，值得记下来：目录里出现「已工作 1m37s…」
  // 「关键发现：dash.cloudflar…」这种 agent 回复，被用户一眼看出来是 bug。
  // 起因是我把来源改成了全量 [data-turn-id]，本意是修「.fN 结尾的条目
  // 点不到」，但那次诊断本身就是错的 —— t8.41.f1 / t0.49.f1 一直是
  // .u-bub（用户在同一轮里追加提问），根本不需要查 agent 回复容器。
  // 全量查询的副作用是把 agent 回复（可能几千像素高）也收进目录。
  function findNode(id) {
    // 不拼选择器字符串，直接遍历比对 —— turnId 里含 ":" 和 "."，
    // 手写转义很容易出错（试过一次，反斜杠在多层字符串里被吃掉，
    // 变成非法正则，整段脚本解析失败）。遍历虽然朴素但绝对安全。
    // 必须过滤零尺寸节点：虚拟列表会留下 0x0 的折叠行，
    // 命中它会让 alignToEl 把视口对到看不见的位置
    // （表现是「点了没反应，但内容跳走了」）。
    if (!isRealTurnId(id)) return null;   // 乐观消息不是节点
    var nodes = document.querySelectorAll('.u-bub[data-turn-id]');
    for (var i = 0; i < nodes.length; i += 1) {
      if (nodes[i].getAttribute('data-turn-id') !== id) continue;
      var rb = nodes[i].getBoundingClientRect();
      if (!rb.width && !rb.height) continue;
      return nodes[i];
    }
    return null;
  }

  // 采集当前渲染出来的全部节点。
  //
  // 节点来源只有一种：用户消息气泡 .u-bub。
  //
  // 桌面那条目录也只列「用户发出去的话」，agent 的回复不进目录 ——
  // 这点必须严格对齐，否则列表里会混进「已工作 1m37s…」「关键发现：…」
  // 这类 agent 输出（用户实测截图指出来的 bug）。
  //
  // 同一轮里的**追加提问**（t8.41.f1 / t0.49.f1）也是 .u-bub，所以
  // 「一轮里问了好几次」会各占一个节点，这是对的，和桌面一致。
  //
  // 但**乐观消息**不是节点：msg_opt_* 只是发送瞬间的本地占位，
  // 真实轮次（t<n>:input）一到它就该消失。见 isRealTurnId 的注释。
  function collect() {
    // 切换会话的宽限期内先返回空：DOM 上还挂着旧会话的节点，
    // 这时候列出来用户会看到「目录闪一下别人的话」。
    if (justSwitched && Date.now() - justSwitched < SWITCH_GRACE_MS) return [];
    var nodes = document.querySelectorAll('.u-bub[data-turn-id]');
    var out = [];
    var seen = {};
    for (var i = 0; i < nodes.length; i += 1) {
      var el = nodes[i];
      var id = el.getAttribute('data-turn-id');
      if (!id || seen[id] || !isRealTurnId(id)) continue;
      var box = el.getBoundingClientRect();
      if (!box.width && !box.height) continue;   // 跳掉零尺寸的占位节点
      seen[id] = true;
      out.push({ id: id, title: pickTitle(el), el: el });
    }
    out.sort(function (a, b) { return cmpSeed(a.id, b.id); });
    return out;
  }

  // ---- 本地记录：只存标题 + 一个「大概位置」提示 --------------------------
  // 位置**不能当准数**：实测同一个会话滚到不同位置时 scrollHeight 在
  // 48201 ~ 55556 之间来回变（虚拟列表在滚动中不断重测行高），任何存下来的
  // 绝对像素都会偏。所以这里只留一个 hint，真正做到「跳得准」靠 locate()
  // 在**当前**布局上做插值收窄（见下面）。
  var rec = {};      // id -> { title, y }
  var dirty = false;
  var saveTimer = 0;
  var storeH = 0;    // 上次记录时的文档可滚高度，用于把旧偏移按比例折算

  // 当前缓存属于哪个会话。这个变量是修一个严重数据污染 bug 的关键：
  // Kimi 是 SPA，点左侧会话列表切换会话时**页面不会重载**，
  // location.pathname 变了但脚本还在跑。早先 rec 从不清空，
  // 于是会话 A 记下的节点会留在内存里，等到会话 B 里 recordFromDom
  // 一跑，它们就被 saveStore() 一起写进**会话 B 的 key** ——
  // 用户在 B 里看到自己从没发过的「重新创建一个 HTML…」（实测报障），
  // 而且刷新也在，因为脏数据已经落盘了。
  var activeKey = '';

  // 刚切完会话的时间戳。切换后短暂窗口内**不许吸收 DOM、也不许列目录**：
  // SPA 切换是异步的，新会话内容要过一会儿才渲染，而这几百毫秒里
  // DOM 上挂的还是**旧会话的节点**。不挡住的话，旧节点会被当成新会话的
  // 节点记下来（实测切过去立刻读到 3 条旧的），之后又被存进新会话缓存 ——
  // 正是用户报的「B 会话里出现 A 会话的话」。
  var justSwitched = 0;
  var SWITCH_GRACE_MS = 1200;

  // ---- 会话标识 ------------------------------------------------------------
  //
  // 缓存 key 必须能**唯一标识一个会话**，否则两个会话会共用一份记录，
  // 表现就是「B 会话里出现 A 会话的历史节点」。
  //
  // 早先这里直接返回 location.pathname，对**已存在的会话**是准确的
  // （路径就是 /sessions/session_<uuid>），但对「新建会话」不行：
  // 应用自己的路径构造是
  //     id 为空 → "/"        id 有值 → "/sessions/" + encodeURIComponent(id)
  // （核对过 Desktop bundle 里的 $he() / EU() 两个函数）
  // 也就是说，新会话在**拿到 id 之前**路径就是 "/"，
  // 于是「新建会话 1」「新建会话 2」……全都落在同一个 key 上，互相污染。
  //
  // 修法分两层：
  //   1. 路径是 /sessions/<id> → 直接用 <id>（最可靠，应用自己也这么解析）
  //   2. 路径是别的（含 "/"）→ 用路径 + 「会话指纹」组成复合 key。
  //      指纹取当前 DOM 里最小的真实 turn id（t0 / t1 …）。
  //      一旦应用 replaceState 到 /sessions/<id>，立刻切到精确 key，
  //      并把过渡期记录**迁移**过去（见 migrateKey）。
  //
  // 下面这几个函数是从模块级**原样注入**的（见 CLIENT_HELPERS），
  // 不在这里重写一遍 —— 两份实现必然有一天不同步。
  // 注入的函数名：fpFromIds / keyFor / migrateWith
  ${CLIENT_HELPERS}

  /**
   * 会话指纹：当前 DOM 里最小的真实 turn id。
   * 拿不到（还没渲染任何消息）返回 ''。
   *
   * 用「最小」而不是「最新」：用户往下滚会加载更多历史，最新那条一直在变，
   * 最小那条（t0）在会话内是稳定的。
   */
  function sessionFingerprint() {
    var nodes = document.querySelectorAll('.u-bub[data-turn-id]');
    var ids = [];
    for (var i = 0; i < nodes.length; i += 1) {
      ids.push(nodes[i].getAttribute('data-turn-id') || '');
    }
    return fpFromIds(ids);
  }

  /**
   * 当前会话的缓存 key。
   *
   * 形态：
   *   /sessions/<uuid>  →  "s:<uuid>"            （精确，最常用）
   *   其它路径          →  "p:<pathname>#<fp>"   （过渡态，靠指纹区分）
   *
   * 前缀 s:/p: 是为了让两种形态永不相撞 —— 万一某个会话 id 恰好叫
   * "p:/"，加上前缀也不会串。
   *
   * 注意：真正的判定逻辑在 keyFor()（由 CLIENT_HELPERS 注入），这里只负责从 DOM 取
   * turn id 再交给它。两边共用同一份实现，避免「改了一边忘了另一边」。
   */
  function sessionKey() {
    return keyFor((location && location.pathname) || '/', sessionFingerprintIds());
  }

  /** 只取 id 列表（给 sessionKeyFor 用） */
  function sessionFingerprintIds() {
    var nodes = document.querySelectorAll('.u-bub[data-turn-id]');
    var ids = [];
    for (var i = 0; i < nodes.length; i += 1) {
      ids.push(nodes[i].getAttribute('data-turn-id') || '');
    }
    return ids;
  }

  /**
   * 过渡 key → 精确 key 的迁移。
   *
   * 新会话的时序是：路径 「/」（此时已经在记录）→ 应用 replaceState 到
   * /sessions/<uuid>。如果不迁移，刚记下的节点会留在 「p:/#t0」 里，
   * 而新 key 是空的 —— 用户会看到「刚发的消息不在目录里」，
   * 直到下次重新采集。所以切换时把旧 key 的记录搬过去。
   *
   * 只在「旧 key 是过渡态、新 key 是精确态、且新 key 还没有记录」时迁移，
   * 避免把 A 会话的内容搬进 B 会话。
   *
   * 判定逻辑在 migrateWith()（由 CLIENT_HELPERS 注入），这里只注入 localStorage 的存取。
   */
  function migrateKey(fromKey, toKey) {
    return migrateWith(fromKey, toKey, {
      getItem: function (k) { return localStorage.getItem(STORE_PREFIX + k); },
      setItem: function (k, v) { localStorage.setItem(STORE_PREFIX + k, v); },
      removeItem: function (k) { localStorage.removeItem(STORE_PREFIX + k); },
    });
  }

  // 会话切换检测：换 key 时先把旧 key 的待写内容落盘，再清空内存重新加载。
  function syncSession() {
    var k = sessionKey();
    if (!activeKey) { activeKey = k; return false; }
    if (k === activeKey) return false;

    // 无论如何先清掉待写的定时器 —— 否则它会在切换后以**新** key 触发，
    // 而此时 rec 已被清空，会把新会话的旧缓存覆盖成空（审计指出的真窗口：
    // pagehide 已经成功落盘、dirty 变 false，timer 却没被清）。
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = 0; }
    // 旧会话还有没写盘的改动 → 用旧 key 写掉，绝不能记到新会话名下
    if (dirty) saveStore(activeKey, storeH);
    // 过渡态 → 精确态的迁移：新会话拿到 id 后，把「/」时期记下的节点
    // 搬到 /sessions/<uuid> 名下，否则用户会看到「刚发的消息不在目录里」。
    // 必须在下面 loadStore(k) 之前做，这样能直接读到迁移过来的数据。
    migrateKey(activeKey, k);
    // 作废正在跑的预扫链（它还在写 scrollTop），并解除互斥
    preloadToken += 1;
    preloadAbort = false;
    preloading = false;
    activeKey = k;
    rec = {};
    storeH = 0;
    dirty = false;
    preloadKey = '';
    preloading = false;
    lastListSig = '';
    chatRendered = false;   // 新会话要重新等它渲染出来
    justSwitched = Date.now();
    loadStore(k);
    return true;
  }



  function loadStore(key) {
    try {
      var raw = localStorage.getItem(STORE_PREFIX + (key || activeKey || sessionKey()));
      if (!raw) return;
      var obj = JSON.parse(raw);
      if (!obj || obj.v !== STORE_VERSION || !obj.items) return;
      for (var i = 0; i < obj.items.length; i += 1) {
        var it = obj.items[i];
        if (!it || !it.id) continue;
        // 旧版本把乐观消息也存了进来（msg_opt_*）。读取时滤掉，
        // 否则用户升级后那条幽灵节点还挂在列表里，得手动清缓存才好 —— 不能这么交付。
        if (!isRealTurnId(it.id)) continue;
        rec[it.id] = {
          title: String(it.title || ''),
          y: Number(it.y) || 0,
          pos: Number(it.pos) || 0,
          size: Number(it.size) || 0,
        };
      }
      storeH = Number(obj.h) || 0;
    } catch (e) {
      /* 隐私模式 / 旧格式：当作空 */
    }
  }

  // 真防抖：有 pending 就重置计时。早先写成「已有 timer 就 return」，
  // 那是节流 —— 最后一次改动可能迟迟不落盘，WebView 被系统杀掉就丢了。
  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      saveTimer = 0;
      saveStore();
    }, 800);
  }

  function saveStore(key, docHeight) {
    try {
      var ids = knownIds();
      var items = [];
      for (var i = 0; i < ids.length; i += 1) {
        var r = rec[ids[i]];
        if (!r || !r.title) continue;
        items.push({
          id: ids[i],
          title: r.title,
          y: Math.round(r.y || 0),
          pos: r.pos || 0,
          size: r.size || 0,
        });
      }
      // 空记录不落盘：否则「切换会话时 rec 已被清空、旧 timer 却在新 key 上触发」
      // 会把目标会话原有的缓存覆盖成空（审计指出的真窗口）。
      if (!items.length) return;
      // h 必须由调用方按「那个会话」的高度传入。
      // 早先在内部取 scrollMax()（当前容器），切换会话时会把这个会话的高度
      // 写进另一个会话的缓存里。
      var h = typeof docHeight === 'number' && isFinite(docHeight)
        ? Math.round(docHeight)
        : Math.round(scrollMax());
      localStorage.setItem(STORE_PREFIX + (key || activeKey || sessionKey()), JSON.stringify({
        v: STORE_VERSION, items: items, h: h,
      }));
      dirty = false;
    } catch (e) {
      /* 配额满 / 隐私模式，忽略 */
    }
  }

  function knownIds() {
    var out = [];
    for (var k in rec) {
      if (Object.prototype.hasOwnProperty.call(rec, k)) out.push(k);
    }
    out.sort(cmpSeed);
    return out;
  }

  function scrollMax() {
    var sc = scroller();
    if (!sc) return 0;
    return Math.max(0, sc.scrollHeight - sc.clientHeight);
  }

  // 把当前渲染出来的节点吸收进记录（心跳每 400ms 一次）。
  // 手动上滑加载出来的节点也是这样进列表的 —— 不需要额外操作。
  function recordFromDom(sc) {
    if (!sc) return false;
    // 每次吸收前先确认「现在还在同一个会话」。
    // 放在这里是因为 recordFromDom 被心跳和滚动回调频繁调用，
    // 是发现 SPA 会话切换最早、最可靠的时机。
    syncSession();
    if (justSwitched && Date.now() - justSwitched < SWITCH_GRACE_MS) return false;
    // 只吸收用户气泡。agent 回复不属于「历史节点」。
    var nodes = document.querySelectorAll('.u-bub[data-turn-id]');
    var changed = false;
    for (var i = 0; i < nodes.length; i += 1) {
      var el = nodes[i];
      var id = el.getAttribute('data-turn-id');
      if (!id || !isRealTurnId(id)) continue;
      var nb = el.getBoundingClientRect();
      if (!nb.width && !nb.height) continue;
      var y = Math.round(el.getBoundingClientRect().top + sc.scrollTop);
      chatRendered = true;   // 会话内容真的渲染出来了
      var prev = rec[id];
      if (!prev) {
        rec[id] = { title: pickTitle(el), y: y };
        changed = true;
        dirty = true;
      } else {
        if (!prev.title) { prev.title = pickTitle(el); changed = true; dirty = true; }
        if (Math.abs((prev.y || 0) - y) > 6) { prev.y = y; dirty = true; }
      }
    }
    // 顺手把虚拟列表的 pos 记下来（定位靠它做二分，比像素位置可靠）
    capturePosQuiet();
    if (dirty) scheduleSave();
    return changed;
  }

  // 收集 aria-posinset。放在这里而不是单开一个定时器，
  // 是因为它和 recordFromDom 的调用时机（每次心跳 + 每次滚动后）完全一致。
  function capturePosQuiet() {
    var rows = document.querySelectorAll('.history-row[aria-posinset]');
    for (var i = 0; i < rows.length; i += 1) {
      var key = rows[i].getAttribute('data-history-key') || '';
      var m = /^(t\d+(?::input|(?:\.\d+)*\.f\d+))$/.exec(key);
      if (!m) continue;
      var id = m[1];
      var p = Number(rows[i].getAttribute('aria-posinset'));
      var sz = Number(rows[i].getAttribute('aria-setsize'));
      if (!p || !sz) continue;
      var prev = rec[id];
      if (!prev) continue;               // 标题还没记过，等下一轮
      if (prev.pos !== p || prev.size !== sz) {
        prev.pos = p;
        prev.size = sz;
        dirty = true;
      }
    }
  }

  // ---- 滚动容器 / 平滑 ---------------------------------------------------
  function scroller() {
    return document.querySelector('.panes.chat-scroll') ||
      document.querySelector('.panes') ||
      document.querySelector('.chat-scroll');
  }

  // 应用把「跟随最新消息」做成一个 is-following 状态：直接改 scrollTop 会被
  // 立刻弹回底部。先派发一次 wheel 让它退出跟随，才能自由滚动。
  function breakFollow(sc) {
    try {
      sc.dispatchEvent(new WheelEvent('wheel', {
        deltaY: -120, bubbles: true, cancelable: true,
      }));
    } catch (e) {
      /* 老 WebView 没有 WheelEvent，忽略 */
    }
  }

  // ---- 平滑滚动：统一复用浏览器的原生 smooth ------------------------------
  //
  // 这条是实测出来的，值得记一笔。最初自己用 rAF 每帧写 scrollTop 做缓动，
  // 想的是「每帧只走一小段，虚拟列表跟得上」。结果正好相反：
  //   自绘 rAF：40 帧里 14 帧超 33ms，p95 = 183ms，最大 283ms（肉眼就是卡顿）
  //   原生 smooth：34k 像素全程 p50 = p95 = 17ms，零长任务
  // 原因很清楚：rAF 版本每帧都要同步读一次 scrollHeight / 元素位置来推进，
  // 逼着浏览器在滚动过程中反复重排；而 CSS scroll-behavior:smooth 由合成器
  // 驱动，根本不经过主线程，主线程再忙也不掉帧。
  //
  // 所以这里不再自己算插值：临时给滚动容器加 scroll-behavior:smooth，
  // 写一次 scrollTop，然后轮询等它自己停稳。
  var settleTimer = 0;

  function stopScroll() {
    if (settleTimer) {
      clearTimeout(settleTimer);
      settleTimer = 0;
    }
  }

  // smoothTo(sc, to, done, maxMs)
  // maxMs 是本次平滑的硬上限。审计指出早先这里固定 2800ms、完全无视
  // 跳转总预算，导致病态路径能拖到十几秒（实测已有 4110ms 的实例）。
  function smoothTo(sc, to, done, maxMs) {
    stopScroll();
    var max = Math.max(0, sc.scrollHeight - sc.clientHeight);
    var target = Math.max(0, Math.min(max, Math.round(to)));
    if (Math.abs(target - sc.scrollTop) < 2) {
      if (done) done();
      return;
    }
    var budget = (typeof maxMs === 'number' && maxMs > 0) ? maxMs : 2800;
    try {
      sc.style.scrollBehavior = 'smooth';
    } catch (e) {
      /* 忽略 */
    }
    sc.scrollTop = target;

    var last = sc.scrollTop;
    var still = 0;
    var t0 = Date.now();

    // 停稳判定必须同时满足「位置不动了」和「确实到过目标附近」。
    //
    // 这里踩过一个很隐蔽的坑：早先只看「连续 8 次不动」就判定结束，
    // 结果大距离滚动会在**中途卡顿一下**（虚拟列表重排），那 8 次不动
    // 被误判成「结束」，于是滚动在 38509 就停了 —— 目标是 23872，
    // 差了一万五，用户看到的是「点了没反应」。
    //
    // 现在：只要还没到目标附近，就绝不提前结束；用 2800ms 硬超时兜底。
    function poll() {
      var now = sc.scrollTop;
      if (Math.abs(now - last) < 1) still += 1;
      else still = 0;
      last = now;
      var nearTarget = Math.abs(now - target) < 4;
      var elapsed = Date.now() - t0;
      if (nearTarget && still >= 2) {
        finish();
        return;
      }
      if (elapsed > budget) {
        // 真到不了了（可能被跟随底部拽住）：尽力而为，不无限等
        finish();
        return;
      }
      settleTimer = setTimeout(poll, 60);
    }
    function finish() {
      settleTimer = 0;
      try {
        sc.style.scrollBehavior = '';
      } catch (e) {
        /* 忽略 */
      }
      if (done) done();
    }
    settleTimer = setTimeout(poll, 60);
  }

  // 搜索用的「一步」：这里要的是快，不需要动画，瞬时赋值即可。
  function stepTo(sc, to) {
    stopScroll();
    var max = Math.max(0, sc.scrollHeight - sc.clientHeight);
    try {
      sc.style.scrollBehavior = '';
    } catch (e) {
      /* 忽略 */
    }
    sc.scrollTop = Math.max(0, Math.min(max, Math.round(to)));
  }

  // ---- 桌面端：让官方目录自己变平滑 --------------------------------------
  // 不拦官方的事件、不改它的滚动逻辑，只在它点击的那一刻给滚动容器加
  // scroll-behavior:smooth —— 它那句 scrollTop = X 就自动变成合成器驱动的
  // 平滑滚动。用户一动手指就撤销，绝不影响它自己的「跟随最新消息」。
  //
  // 这里有个坑：不能靠 scrollend 撤销。实测官方目录是「瞬间赋值 + 自己再修正」
  // 的写法，scrollend 会在第一跳结束时立刻触发，于是刚加上的 smooth 被自己撤掉，
  // 剩下的长距离还是硬跳（实测 37k → 1.7k 一帧到位，p95 无改善）。
  // 现在只有**真实用户输入**（滚轮/触摸/按键）才撤销，其余交给定时轮询收尾。
  var smoothTimer = 0;
  var smoothStop = 0;

  function nativeSmooth(ms) {
    var sc = scroller();
    if (!sc) return;
    try {
      sc.style.scrollBehavior = 'smooth';
    } catch (e) {
      /* 忽略 */
    }
    if (smoothTimer) clearTimeout(smoothTimer);
    smoothTimer = setTimeout(cancelNativeSmooth, ms || 2500);

    // 官方那边可能是「先跳一帧、再补一次」，所以短时间内反复重设，
    // 保证它两次赋值都走在平滑通道上。
    if (smoothStop) clearInterval(smoothStop);
    var n = 0;
    smoothStop = setInterval(function () {
      n += 1;
      var s = scroller();
      if (!s || n > 8) {
        clearInterval(smoothStop);
        smoothStop = 0;
        return;
      }
      try {
        s.style.scrollBehavior = 'smooth';
      } catch (e) {
        /* 忽略 */
      }
    }, 90);
  }

  function cancelNativeSmooth() {
    if (smoothTimer) {
      clearTimeout(smoothTimer);
      smoothTimer = 0;
    }
    if (smoothStop) {
      clearInterval(smoothStop);
      smoothStop = 0;
    }
    var sc = scroller();
    if (sc && sc.style.scrollBehavior) {
      try {
        sc.style.scrollBehavior = '';
      } catch (e) {
        /* 忽略 */
      }
    }
  }

  function bindNativeToc() {
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      if (!t.closest('.conversation-toc .toc-row')) return;
      nativeSmooth(2500);
    }, true);
    // 只有真实输入才代表「用户自己想滚了」，这时候必须立刻恢复默认行为
    document.addEventListener('wheel', cancelNativeSmooth, true);
    document.addEventListener('touchstart', cancelNativeSmooth, true);
    document.addEventListener('keydown', cancelNativeSmooth, true);
  }

  // ---- 渲染 ---------------------------------------------------------------
  var root = null;
  var btn = null;
  var list = null;
  var isOpen = false;
  var spacer = null;

  function build() {
    root = document.createElement('div');
    // 用 ROOT_ID 而不是 ID：ID 已被 <script id> 占用，
    // 同名会导致 CSS 选择器命中脚本标签（它没有尺寸），整块样式全部失效。
    root.id = ROOT_ID;
    root.setAttribute('role', 'navigation');
    root.setAttribute('aria-label', LABEL);

    btn = document.createElement('button');
    btn.className = 'tn-btn';
    btn.type = 'button';
    btn.setAttribute('aria-haspopup', 'true');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-label', LABEL);
    btn.innerHTML =
      '<svg class="tn-ico" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
      '<path d="M4 7h16M4 12h11M4 17h14" stroke="currentColor" stroke-width="1.7" ' +
      'stroke-linecap="round"/></svg><span class="tn-tx2">' + LABEL + '</span>';

    list = document.createElement('div');
    list.className = 'tn-list';
    list.setAttribute('role', 'menu');

    root.appendChild(list);
    root.appendChild(btn);
    (document.body || document.documentElement).appendChild(root);

    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      toggle(!isOpen);
    });
    btn.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle(!isOpen);
      } else if (e.key === 'Escape') {
        toggle(false);
      }
    });
    document.addEventListener('click', function (e) {
      if (isOpen && root && !root.contains(e.target)) toggle(false);
    }, true);
    window.addEventListener('resize', place, { passive: true });
  }

  function toggle(next) {
    if (!root) return;
    isOpen = next;
    root.classList.toggle('open', isOpen);
    btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    if (isOpen) renderList();
  }

  var lastListSig = '';

  function renderList() {
    if (!list) return;
    list.textContent = '';
    var ids = knownIds();
    if (!ids.length) {
      var empty = document.createElement('div');
      empty.className = 'tn-item';
      empty.textContent = '这次会话还没有历史节点';
      list.appendChild(empty);
      return;
    }

    // 只列**已经加载到过的节点**：没加载的根本不出现，也不显示序号
    // （turnId 里夹着 task 占位轮，任何编号都对不上用户心里的「第几轮」）。
    var sc = scroller();
    var actId = currentNode(sc);

    for (var i = 0; i < ids.length; i += 1) {
      (function (id) {
        var row = document.createElement('button');
        row.className = 'tn-item' + (id === actId ? ' act' : '');
        row.type = 'button';
        row.setAttribute('role', 'menuitem');
        row.setAttribute('data-turn', id);

        var bar = document.createElement('span');
        bar.className = 'tn-bar';
        var tx = document.createElement('span');
        tx.className = 'tn-tx';
        tx.textContent = (rec[id] && rec[id].title) || '（无标题）';

        row.appendChild(bar);
        row.appendChild(tx);
        row.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          jumpTo(id);
        });
        list.appendChild(row);
      })(ids[i]);
    }

    // 打开列表时把当前节点滚到视野中间，长会话里不至于总是从最早的一条开始
    var actRow = list.querySelector('.tn-item.act');
    if (actRow && actRow.scrollIntoView) {
      try {
        actRow.scrollIntoView({ block: 'center' });
      } catch (e) {
        /* 老 WebView 不支持参数，忽略 */
      }
    }
    lastListSig = ids.length + '|' + actId;
  }

  // ---- 当前节点 -----------------------------------------------------------
  // 贴底 / 贴顶直接给首尾；中间用所有锚点（含助手帧）里最靠近探针线的那个，
  // 再折算成「它前面最近的一条用户消息」。
  function currentNode(sc) {
    var ids = knownIds();
    if (!ids.length) return '';
    if (!sc) return ids[ids.length - 1];

    var max = Math.max(0, sc.scrollHeight - sc.clientHeight);
    if (sc.scrollTop >= max - 300) return ids[ids.length - 1];
    if (sc.scrollTop <= 40) return ids[0];

    var probe = sc.clientHeight * 0.42;
    var bestId = '';
    var bestD = Infinity;
    var nodes = document.querySelectorAll('.u-bub[data-turn-id]');
    for (var i = 0; i < nodes.length; i += 1) {
      var id = nodes[i].getAttribute('data-turn-id');
      if (!id || !isRealTurnId(id)) continue;
      var r = nodes[i].getBoundingClientRect();
      if (!r.width && !r.height) continue;
      var d = Math.abs(r.top - probe);
      if (d < bestD) { bestD = d; bestId = id; }
    }
    if (!bestId) return ids[0];
    return greatestLE(bestId, ids);
  }

  // ---- 跳转：先「加载」，再「滑过去」 --------------------------------------
  //
  // 用户的原话是：点一个更早的节点，先做一个加载动作（1 秒内完成），
  // 加载完再以 60fps 稳定地滑到目标。
  //
  // 实测数据证明这个拆法是对的 —— 卡顿根本不在「滑动」上：
  //   瞬时大跳（搜索阶段）：  p95 = 83ms，8 帧超 33ms    ← 卡顿 100% 来自这里
  //   平滑滑动 700px：        p50 = p95 = 17ms，0 帧超标
  //   平滑滑动 3500px：       p50 = p95 = 17ms，0 帧超标
  //   跳转后虚拟列表稳定：   150 ~ 330ms
  //   缓存位置按高度折算后误差：78 ~ 763px（原始存的误差 1240 ~ 1971px）
  //
  // 也就是说：搜索时必须反复大跳，每次大跳文档高度都变、虚拟列表重排一大段，
  // 这些重排是躲不掉的。但**可以让用户看不见** —— 用一层光幕盖住内容区，
  // 在下面把目标找出来、滚到目标附近，然后撤掉光幕，只剩一小段平滑滑动。
  //
  // 流水线（总预算 1s）：
  //   ① 0ms        捕获快照 + 亮起光幕
  //   ② 0~900ms    定位：先在缓存位置附近找（大部分一次命中），找不到才二分
  //   ③ 定位成功   滚到「目标 - 预滚距离」，让稍后的滑动有方向感
  //   ④ 撤光幕     smoothTo 到目标，全程合成器驱动
  //   ⑤ 闭环校正   虚拟列表重排后可能有几十像素偏差，补 1~2 次
  //
  // 为什么不用「先跳到底再滑回来」省掉方向判断：实测短距离滑动那一段
  // 是零掉帧的，保留它才能让用户看出「我在往回翻」，而不是页面凭空换了内容。


  // 一次跳转的「代次」。所有异步链条（creep / 二分 / 细扫 / 对齐）都带
  // 一个 token，代次一变就立刻退出。
  //
  // 为什么必须有它：这些链条是 setTimeout 串起来的，只比较目标 id
  // 只能防「换了一个目标」，防不住「同一个目标被点了两次」—— 上一轮的
  // 定时器还在跑，会和新一轮抢着改 scrollTop，最终表现为要么很久才落位，
  // 要么落位后被上一轮带偏（实测出现过 landedY=null）。
  var jumpToken = 0;

  function nextToken() {
    jumpToken += 1;
    return jumpToken;
  }

  // 调试埋点：只写最后一个目标的事件流，供线上排查用。
  // 保留着是有意的 —— 这类「点了没反应」的问题只能靠它定位，
  // 而且开销可以忽略（一次跳转几十条）。
  function trace(kind, a, b, c, d, e) {
    if (!window.__pocketTocTrace) return;
    window.__pocketTocTrace.push([kind, a, b, c, d, e]);
  }

  function tokenAlive(token) {
    return token === jumpToken;
  }
  // 跳转到某个节点：**远距离瞬移 + 近距离平滑**两段式。
  //
  // 为什么必须是这两段的组合，是实测逼出来的：
  //
  //   ① 纯原生 smooth 滑长距离 → 走不动。Kimi 在滚动过程中会自己写
  //      scrollTop（跟随/重排），我的平滑滚动被反复打断：实测从 41363
  //      滑向 16545，只走了 1685px 就停住。
  //   ② 纯 rAF 逐帧推 → 27fps、p95 = 217ms，肉眼可见卡。
  //   ③ 纯瞬间跳 → 用户看到的是一整屏内容凭空换掉，没有「翻过去」的感觉。
  //
  // 而「一次瞬移到目标前 1.5 屏 + smooth 走完最后 1.5 屏」实测是：
  //   瞬移 402ms（这段用户看不见过程，只是一次换屏）+ 平滑 558ms = 960ms，
  //   落点精确（16548 vs 目标 16545），最后这段因为距离短，不会被应用打断。
  //
  // 视觉上正是用户要的「中间一大段快速过去，快到的时候慢下来」。
  // 跳转到某个节点。
  //
  // 这一版是反复实测后的最终形态，核心结论两条：
  //
  //   ① **必须先用一次瞬时赋值把视口送到目标附近**，不能指望平滑滚动走长距离。
  //      实测：解除「跟随底部」后把 scrollTop 直接设到目标，一次就到、不被拽回
  //      （95ms）；而用 scroll-behavior:smooth 走同样的 3 万像素，会被应用
  //      自己的 scrollTop 写入反复打断，只走 1~2 屏就停住。
  //
  //   ② **落地前那一段用平滑演出来**，这才是「丝滑」的来源。
  //      实测「瞬移到目标外 2.5 屏 + smooth 滑回目标」：
  //        瞬移 256ms（用户看不见过程）+ 平滑 767ms
  //        平滑段 p95 = 17ms、59fps、零帧超 50ms
  //      视觉上正是用户要的「中间一大段快速过去，快到的时候慢下来」。
  //
  // 放弃的方案（都实测过）：
  //   - 光幕遮罩：一次跳转 = 一次整屏淡入淡出，用户反复报「白屏/黑屏闪一下」，
  //     且跨的节点越多闪得越明显。闪屏来源就是遮罩自己。
  //   - 纯 rAF 逐帧推：跨长距离只有 27fps（每帧强制同步布局）。
  //   - 二分/细扫边找边跳：步骤多，容易和虚拟列表重排抢帧。
  var ACT_SCREENS = 2.5;         // 「演」多长：目标外 2.5 屏
  var JUMP_DEADLINE_MS = 1800;   // 整次跳转硬上限，任何路径都不许拖过它

  var jumpT0 = 0;
  var jumpRelease = 0;

  function jumpTo(id) {
    var sc = scroller();
    toggle(false);
    if (!sc) return;

    var token = nextToken();
    jumpT0 = Date.now();
    stopScroll();
    cancelNativeSmooth();
    breakFollow(sc);
    abortPreload();               // 预扫与这次跳转会抢滚动，先让它停

    var hit = findNode(id);
    trace('jump', id, !!hit, Math.round(sc.scrollTop), token, jumpToken);

    // 跳转结束后必须解除对预扫的封锁。
    // 审计指出：preloadAbort 只置 true、只在 syncSession 置回 false，
    // 于是「点过任意节点之后预扫永久静默失效」—— 新会话再不会补齐节点。
    // 这里挂两个兜底定时器，无论走哪条分支都会恢复。
    if (jumpRelease) clearTimeout(jumpRelease);
    jumpRelease = setTimeout(function () { preloadAbort = false; }, 1200);
    setTimeout(function () { preloadAbort = false; }, JUMP_DEADLINE_MS + 600);

    if (hit) { alignToEl(hit, id, token); return; }

    try {
      stepToward(id, token, 0);
    } catch (err) {
      trace('ERR', String(err && err.message), String(err && err.stack).slice(0, 260));
    }
  }

  function outOfTime(token) {
    if (!tokenAlive(token)) return true;
    if (Date.now() - jumpT0 < JUMP_DEADLINE_MS) return false;
    notice('这条还没加载到，先手动上滑一下再点');
    return true;
  }

  // 本次跳转剩余预算，给需要自己设上限的异步段用（smoothTo 等）。
  // 审计指出：早先只有 stepToward 受 1800ms 约束，smoothTo/sweepNear/
  // settleAlign 全在预算外，所谓「硬上限」形同虚设。
  function remainingMs() {
    var left = JUMP_DEADLINE_MS - (Date.now() - jumpT0);
    return left > 80 ? left : 80;
  }

  function stepToward(id, token, step) {
    try {
      stepTowardInner(id, token, step);
    } catch (err) {
      trace('ERR2', String(err && err.message), String(err && err.stack).slice(0, 260));
    }
  }

  // 一步：先尝试「一次瞬移到缓存位置」，不行再用方向 + 大步推进。
  //
  // 为什么优先用缓存 y：实测「知道真实位置就一定能 405ms 命中」，
  // 所以最省事的做法是**先信缓存里的 y 一次**（它是上次在这个会话里
  // 真实量到的绝对位置，通常只差一两屏），跳到它附近再验证。
  //
  // 只有缓存不可用时，才退回「方向 + 大步」，而那种情况本来就是
  // 第一次进入这个会话，慢一点可以接受。
  function stepTowardInner(id, token, step) {
    var sc = scroller();
    if (!sc || !tokenAlive(token)) return;
    if (outOfTime(token)) return;

    var el = findNode(id);
    if (el) { alignToEl(el, id, token); return; }

    if (step >= 12) {
      // 兜底：从缓存 y 附近做一次密扫（步长 0.8 屏，±6 屏）。
      // 覆盖「缓存 y 本身偏差较大」的情况：分段大步会跳过这种窄窗口。
      if (sweepNear(id, token, 0)) return;
      notice('这条还没加载到，先手动上滑一下再点');
      return;
    }

    var vh = sc.clientHeight;
    var maxNow = Math.max(1, sc.scrollHeight - sc.clientHeight);
    var here = sc.scrollTop;

    // ① 首跳：直接用缓存 y（按文档高度同比缩放，吸收文档变高带来的偏移）
    if (step === 0 && rec[id] && rec[id].y > 0) {
      var lastH = storeH > 0 ? storeH : maxNow;
      var guess = Math.round(rec[id].y / lastH * maxNow);
      // 往前留 1.2 屏，避免正好落在目标上方看不到
      guess = Math.max(0, Math.min(maxNow, guess - Math.round(vh * 1.2)));
      if (Math.abs(guess - here) > vh * 0.5) {
        trace('cached', Math.round(here), guess, rec[id].y, lastH);
        stepTo(sc, guess);
        setTimeout(function () {
          if (!tokenAlive(token)) return;
          var e0 = findNode(id);
          if (e0) { alignToEl(e0, id, token); return; }
          stepTowardInner(id, token, 1);
        }, 180);
        return;
      }
    }

    // ② 方向：拿视口探针线附近的用户节点比大小
    var probeId = nearestUserId();
    var span = renderedSpan();
    var ref = probeId || span.min;
    var dir = 0;
    if (ref) {
      var cRef = cmpId(id, ref);
      if (cRef === 0) {
        // 探针线命中的就是目标：直接对齐，不要瞎判方向
        var selfEl = document.querySelector('.u-bub[data-turn-id="' + id + '"]');
        if (selfEl) { alignToEl(selfEl, id, token); return; }
        dir = 1;
      } else {
        dir = cRef < 0 ? -1 : 1;
      }
    }

    if (!dir) {
      var mid = Math.round(maxNow / 2);
      if (Math.abs(mid - here) < vh) { notice('这条还没加载到，先手动上滑一下再点'); return; }
      stepTo(sc, mid);
      setTimeout(function () {
        if (!tokenAlive(token)) return;
        stepTowardInner(id, token, step + 1);
      }, 150);
      return;
    }

    // ③ 大步推进。段长按「剩余距离未知」处理：一次 6 屏。
    //    瞬时赋值只重排一次，比连续平滑更不容易掉帧；
    //    而段数少 = 总的「换屏次数」少 = 用户看到的变化少。
    // 「相邻」不能用 |cmpId| —— 它返回的是段长度差：
    // cmpId('t8:input','t8.41.f1') = -4（同轮、只差几个段），
    // 会被误判成「很远」，于是大跨一步再反向，来回振荡。
    // 正确判据：同一个基段（tN 相同）视为相邻。
    var adjacent = false;
    if (probeId) {
      var mb = /^t(\d+)/.exec(probeId);
      var mt = /^t(\d+)/.exec(id);
      if (mb && mt && mb[1] === mt[1]) adjacent = true;
    }
    var stride = adjacent ? Math.round(vh * 1.2) : Math.round(vh * 6);
    var next = here + dir * stride;
    next = Math.max(0, Math.min(maxNow, Math.round(next)));

    if (Math.abs(next - here) < 8) {
      // 撞到文档边界（顶/底）。不能立刻判失败 —— 虚拟列表可能只是
      // 还没把那一行挂上来（150~330ms）。先原地等一轮再试。
      if (step < 3) {
        setTimeout(function () {
          if (!tokenAlive(token)) return;
          var eB = findNode(id);
          if (eB) { alignToEl(eB, id, token); return; }
          stepTowardInner(id, token, step + 1);
        }, 220);
        return;
      }
      if (sweepNear(id, token, 0)) return;
      notice('这条还没加载到，先手动上滑一下再点');
      return;
    }

    trace('step', step, Math.round(here), next, probeId, dir);

    stepTo(sc, next);

    setTimeout(function () {
      if (!tokenAlive(token)) return;
      var e = findNode(id);
      if (e) { alignToEl(e, id, token); return; }
      stepTowardInner(id, token, step + 1);
    }, adjacent ? 180 : 110);
  }

  // 密扫兜底：以「缓存 y 折算后的位置」为中心，上下各 6 屏、步长 0.8 屏。
  // 用于分段大步刚好跨过目标的情况（实测 t2 会遇到）。
  // 返回 true 表示已接管本次跳转。
  function sweepNear(id, token, attempt) {
    var sc = scroller();
    if (!sc) return false;
    if (attempt >= 2) return false;

    var vh = sc.clientHeight;
    var maxNow = Math.max(1, sc.scrollHeight - sc.clientHeight);
    var base;
    if (rec[id] && rec[id].y > 0) {
      var lastH = storeH > 0 ? storeH : maxNow;
      base = Math.round(rec[id].y / lastH * maxNow);
    } else {
      base = sc.scrollTop;
    }
    base = Math.max(0, Math.min(maxNow, base));

    var lo = Math.max(0, base - vh * 8);
    var hi = Math.min(maxNow, base + vh * 8);
    var stepPx = Math.round(vh * 1.4);
    var pos = lo;
    var guard = 0;

    function go() {
      if (!tokenAlive(token)) return;
      var e = findNode(id);
      if (e) { alignToEl(e, id, token); return; }
      if (outOfTime(token)) return;
      guard += 1;
      if (pos > hi || guard > 14) {
        // 这一轮没扫到：换一个中心再来一次（如果还有预算）
        if (sweepNear(id, token, attempt + 1)) return;
        notice('这条还没加载到，先手动上滑一下再点');
        return;
      }
      stepTo(sc, Math.round(pos));
      pos += stepPx;
      setTimeout(go, 85);
    }
    trace('sweepNear', Math.round(base), Math.round(lo), Math.round(hi));
    go();
    return true;
  }

  // 当前渲染出的全部节点（用户气泡）的 turnId 最小/最大值。
  // 只统计有尺寸的节点 —— 虚拟列表会留下零尺寸的占位行。
  function renderedSpan() {
    var nodes = document.querySelectorAll('.u-bub[data-turn-id]');
    var min = '';
    var max = '';
    for (var i = 0; i < nodes.length; i += 1) {
      var nid = nodes[i].getAttribute('data-turn-id');
      if (!nid || !isRealTurnId(nid)) continue;
      var r = nodes[i].getBoundingClientRect();
      if (!r.width && !r.height) continue;
      if (!min || cmpId(nid, min) < 0) min = nid;
      if (!max || cmpId(nid, max) > 0) max = nid;
    }
    return { min: min, max: max };
  }

  // 视口探针线附近的那个「用户节点」。返回其 turnId。
  // 用 .u-bub 而不是 .history-row：只有用户气泡才是节点。
  function nearestUserId() {
    var sc = scroller();
    var nodes = document.querySelectorAll('.u-bub[data-turn-id]');
    if (!nodes.length) return '';
    var probe = sc ? sc.scrollTop + sc.clientHeight * 0.42 : 0;
    var best = '';
    var bestD = Infinity;
    for (var i = 0; i < nodes.length; i += 1) {
      var nid = nodes[i].getAttribute('data-turn-id');
      if (!nid || !isRealTurnId(nid)) continue;
      var r = nodes[i].getBoundingClientRect();
      if (!r.width && !r.height) continue;
      var absTop = r.top + (sc ? sc.scrollTop : 0);
      var d = Math.abs(absTop - probe);
      if (d < bestD) { bestD = d; best = nid; }
    }
    return best;
  }

  // 精确对齐：目标已在 DOM，用平滑把它的中心对到视口中间。
  function alignToEl(el, id, token) {
    var sc = scroller();
    if (!sc) { trace('align', 'no-sc'); return; }
    if (!tokenAlive(token)) { trace('align', 'token-dead'); return; }
    stopScroll();
    cancelNativeSmooth();
    breakFollow(sc);

    var box = el.getBoundingClientRect();
    var max = Math.max(0, sc.scrollHeight - sc.clientHeight);
    var want = Math.round(box.top + sc.scrollTop - sc.clientHeight / 2 + box.height / 2);
    want = Math.max(0, Math.min(max, want));

    trace('align', Math.round(sc.scrollTop), want, Math.round(box.top), Math.round(box.height));
    if (Math.abs(want - sc.scrollTop) < 3) { flash(el); return; }

    // 距离远时先瞬移到目标外 1.4 屏，再用平滑演完最后一段 ——
    // 这样无论目标原来在多远，用户看到的永远是「滑过去」而不是「闪一下」。
    var vh = sc.clientHeight;
    if (Math.abs(want - sc.scrollTop) > vh * 1.8) {
      // 目标位置是精确已知的，预滚只需留出「一点方向感」，不必留一屏多。
      var stage = want + (want < sc.scrollTop ? vh * 0.7 : -vh * 0.7);
      stage = Math.max(0, Math.min(max, Math.round(stage)));
      stepTo(sc, stage);
      setTimeout(function () {
        if (!tokenAlive(token)) return;
        var e = findNode(id) || el;
        if (!e) return;
        var b2 = e.getBoundingClientRect();
        var mm = Math.max(0, sc.scrollHeight - sc.clientHeight);
        var w2 = Math.round(b2.top + sc.scrollTop - sc.clientHeight / 2 + b2.height / 2);
        w2 = Math.max(0, Math.min(mm, w2));
        smoothTo(sc, w2, function () { settleAlign(id, token); }, 1100);
      }, 240);
      return;
    }

    // 这一段是用户看到的主要滑动，固定给 1100ms 预算
    // （主预算在收尾阶段往往只剩几十毫秒，会把动画压成一跳）。
    smoothTo(sc, want, function () {
      settleAlign(id, token);
    }, 1100);
  }

  // 落地校正：只做小幅平滑修正，绝不瞬移。
  function settleAlign(id, token) {
    var sc = scroller();
    if (!sc) return;
    var attempts = 0;

    function attempt() {
      if (!tokenAlive(token)) return;
      var el = findNode(id);
      if (!el) {
        if (attempts < 3) { attempts += 1; setTimeout(attempt, 120); }
        return;
      }
      var box = el.getBoundingClientRect();
      var targetTop = sc.clientHeight / 2 - box.height / 2;
      var delta = Math.round(box.top - targetTop);
      if (Math.abs(delta) <= 24 || attempts >= 2) { flash(el); return; }
      attempts += 1;
      // 收尾校正用独立预算（900ms），不能借跳转主预算 ——
      // 跳转临近 deadline 时剩余可能只有 80ms，会让校正刚起步就被截断，
      // 于是要重试，反而更慢（实测平均耗时从 573ms 涨到 1295ms）。
      smoothTo(sc, sc.scrollTop + delta, function () {
        if (!tokenAlive(token)) return;
        setTimeout(attempt, 60);
      }, 900);
    }
    attempt();
  }

  // ---- 预扫描：把「已下载但没渲染」的最近几轮翻出来 ----------------------
  // transcript 是一次性拉全的（实测 22 条 / 9 轮 / 2.1MB，has_more=false），
  // 所以节点不是「没加载」，而是「没渲染」。但整篇扫一遍代价太大
  // （3 万像素的会话要 40+ 屏），只补最近 PRELOAD_TURNS 个。
  var preloadKey = '';
  var preloading = false;
  // 预扫描的代次 + 与跳转互斥的开关。
  //
  // 审计指出两个真问题：
  //   ① preloadScan 的 setTimeout 链完全在 token 体系外，每 70ms 无条件写
  //      scrollTop（最多 60 次 ≈ 4.2s），finish() 还会再写一次把落点拽走；
  //   ② syncSession 里把 preloading 置 false 来「放行」，旧链却还在跑，
  //      于是新旧两条链同时改 scrollTop。
  // 现在：代次一变旧链立刻退出；jumpTo 会 abortPreload()，跳转期间不预扫。
  var preloadToken = 0;
  var preloadAbort = false;

  function abortPreload() {
    preloadToken += 1;
    preloadAbort = true;
    preloading = false;
  }

  function preloadScan(done) {
    var sc = scroller();
    if (!sc || preloading || preloadAbort) { if (done) done(); return; }
    preloading = true;
    var myToken = preloadToken;
    cancelNativeSmooth();
    var origin = sc.scrollTop;
    breakFollow(sc);
    recordFromDom(sc);

    var max = Math.max(0, sc.scrollHeight - sc.clientHeight);
    var stepPx = Math.max(320, Math.floor(sc.clientHeight));
    var pos = max;
    var guard = 0;
    var baseCount = knownIds().length;

    function finish() {
      if (myToken !== preloadToken) { preloading = false; if (done) done(); return; }
      try {
        // 预扫描会让文档变高，原来的 scrollTop 就不再是「底部」了：
        // 用户本来贴着最新消息，扫完必须重新贴回底部。
        if (myToken === preloadToken) {
          var newMax = Math.max(0, sc.scrollHeight - sc.clientHeight);
          var wasAtBottom = origin >= max - 260;
          sc.scrollTop = wasAtBottom ? newMax : Math.min(origin, newMax);
        }
      } catch (e) { /* 忽略 */ }
      preloading = false;
      if (done) done();
    }

    function step() {
      if (myToken !== preloadToken) { preloading = false; return; }
      guard += 1;
      // 够 PRELOAD_TURNS 个就停，更早的交给用户手动上滑
      var enough = knownIds().length >= Math.max(PRELOAD_TURNS, baseCount + 1);
      if (pos <= 0 || guard > 60 || enough) { finish(); return; }
      pos = Math.max(0, pos - stepPx);
      sc.scrollTop = pos;
      setTimeout(function () {
        recordFromDom(sc);
        step();
      }, 70);
    }

    sc.scrollTop = max;
    setTimeout(step, 70);
  }

  function maybePreload() {
    if (preloading || preloadAbort) return;
    var key = sessionKey();
    if (key === preloadKey) return;
    if (knownIds().length === 0 && collect().length === 0) return;
    preloadKey = key;
    if (knownIds().length >= PRELOAD_TURNS) return;
    preloadScan(null);
  }

  // ---- 定位：输入框右上角上方那一行 --------------------------------------
  // 「后台 Bash / 后台 Agent」在 .dock-workbar 这一行里，胶囊贴同一行右端，
  // 尺寸/字体与 .ui-pill 完全一致，所以看起来就是同一组按钮的最后一个。
  var anchorTop = -1;
  var placeOk = true;
  var sawWorkbar = false;

  // 这个会话**真的渲染出来过**没有。
  //
  // 用户实测报过：「刷新的时候，在会话数据加载中时，胶囊也出现了」。
  // 原因是 enough 用的是 knownIds().length，而它读的是 **localStorage 缓存** ——
  // 页面刚起来、缓存里已经有 2 条记录，于是一个节点都没渲染就已经判定「够多了」。
  // 实测第 250ms 就亮起来：wb=0 ubub=0 win=0，页面上只有输入框占位。
  //
  // 所以「够多」必须是两个条件同时成立：缓存里够多 **且** 这个会话真渲染过。
  // 单独用「当前渲染的 .u-bub 数 >= 1」不行 —— 虚拟列表滚到两个用户气泡
  // 之间的长区域时，视口里可能一个 .u-bub 都没有，胶囊会闪没。
  // 用「曾经渲染过」这个一次性的闩就没这个问题。
  var chatRendered = false;
  // 浮层状态由 tick 每轮算一次并缓存。
  // 必须进定位签名 —— 否则浮层关掉后签名没变，place() 不会再被调用，
  // placeOk 就永远停在 false，胶囊再也回不来（实测跳过新手引导后不复现）。
  var overlayOn = false;

  // 宿主是否有**盖住输入框的浮层**（会话列表抽屉、新手引导、确认框…）。
  //
  // 用户实测报过两次：
  //   ① 打开「切换会话」抽屉时，胶囊浮在抽屉上面 —— 抽屉是全屏浮层，
  //      胶囊的 z-index 是 2147483002，天然盖过一切，所以一定会露出来；
  //   ② 新手引导页上，胶囊飘在「继续」按钮右边。
  //
  // 早先只判断「输入框是否在视口内」，压根没考虑「被浮层盖住」这种情况。
  // 注意不能拿 elementFromPoint 判断：胶囊自己的 z-index 全场最高，
  // 命中的永远是它自己，测不出下面有没有浮层。只能显式看已知浮层。
  //
  // 判据要保守 —— 浮层类名是宿主的实现细节，宁可漏判也不能误判：
  // 误判的后果是用户正常看会话时胶囊莫名消失，那比浮在浮层上更糟。
  function overlayOpen() {
    // .wizard 是新手引导，正常会话里也存在但 display:none / 无子节点，
    // 所以不能只看类名，必须要求「真的占了视口一大块」。
    var sel = '.sheet-root, .sheet-scrim, [role="dialog"], [role="alertdialog"], [aria-modal="true"]';
    var nodes = document.querySelectorAll(sel);
    var vw = window.innerWidth || 0;
    var vh = window.innerHeight || 0;
    for (var i = 0; i < nodes.length; i += 1) {
      var el = nodes[i];
      // 胶囊自己的 toast/列表也在 body 上，别把自己算成浮层
      if (root && (el === root || root.contains(el))) continue;
      var cs = window.getComputedStyle ? window.getComputedStyle(el) : null;
      if (cs) {
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
        if (cs.pointerEvents === 'none') continue;
      }
      var r = el.getBoundingClientRect();
      if (r.width < vw * 0.6 || r.height < vh * 0.3) continue;   // 小气泡不算
      return true;
    }
    return false;
  }
  function place() {
    if (!root) return;
    // 有浮层盖着就先藏起来。放在最前面：下面所有分支都在算坐标，
    // 但此刻根本不该显示，算出来的位置都是错的。
    if (overlayOn) {
      placeOk = false;
      root.classList.remove('on');
      return;
    }
    var wb = document.querySelector('.dock-workbar');
    var card = document.querySelector('.composer-card') || document.querySelector('.composer');
    var vh = window.innerHeight || 0;

    if (wb) { sawWorkbar = true; }

    if (!wb && sawWorkbar) {
      // 曾经有过 workbar，现在短暂缺失（会话切换 / 输入框重建）：
      // 保持隐藏，等它回来。绝不能掉到「屏幕底部固定 96px」那条降级分支，
      // 否则胶囊会先跳到页面下方再跳回来。
      placeOk = false;
      anchorTop = -998;
      root.classList.remove('on');
      return;
    }

    if (wb) {
      var r = wb.getBoundingClientRect();
      // 输入框整行被顶出视口（键盘弹起等）就别显示，免得飘在内容上
      if (r.top > vh || r.bottom < 0) {
        placeOk = false;
        anchorTop = -999;
        root.classList.remove('on');
        return;
      }
      placeOk = true;
      anchorTop = Math.round(r.top);
      // 直接量同一行里真实存在的 .ui-pill 的顶边，而不是用 workbar 的
      // padding 推算：workbar 是 padding:4px 28px 0，推算会差 2px，
      // 两个胶囊并排时那 2px 看得出来。
      var sib = wb.querySelector('.ui-pill');
      var sibTop = sib ? sib.getBoundingClientRect().top : 0;
      var top = sibTop || (r.top + Math.max(0, (r.height - PILL_H) / 2));
      root.style.top = Math.round(top) + 'px';
      var rightEdge = card ? card.getBoundingClientRect().right : (r.right - 4);
      root.style.right = Math.max(8, Math.round(window.innerWidth - rightEdge)) + 'px';
      root.style.bottom = 'auto';
      reserve(wb, r);
      return;
    }

    anchorTop = -1;
    placeOk = true;
    if (card) {
      var rc = card.getBoundingClientRect();
      if (rc.top > vh || rc.bottom < 0) {
        placeOk = false;
        root.classList.remove('on');
        return;
      }
      root.style.top = Math.max(8, Math.round(rc.top - PILL_H - 6)) + 'px';
      root.style.right = Math.max(10, Math.round(window.innerWidth - rc.right + 4)) + 'px';
      root.style.bottom = 'auto';
      return;
    }
    root.style.top = 'auto';
    root.style.bottom = 'calc(env(safe-area-inset-bottom, 0px) + 96px)';
    root.style.right = '12px';
  }

  // 在 .dock-workbar 末尾留出胶囊的宽度：这样左侧系统按钮再多也不会被
  // 胶囊压住（配合 CSS 的 overflow-x:auto，多了可以向左滑）。
  function reserve(wb, rect) {
    var w = btn ? Math.round(btn.getBoundingClientRect().width) : 96;
    if (!w) w = 96;
    var width = w + 10;
    if (!spacer) {
      spacer = document.createElement('div');
      spacer.setAttribute('data-pocket', 'spacer');
      spacer.setAttribute('aria-hidden', 'true');
      spacer.style.cssText = 'flex:0 0 auto;height:1px;pointer-events:none;';
    }
    // 无条件 appendChild：对「已在末尾」是空操作，对「被 Vue patch 挤到中间」
    // 会把它移回末尾；对「挂在前一个容器里」会把它迁过来。
    // 早先只在 parentNode !== wb 时才 append，导致 spacer 被新按钮挤到中间后
    // 占位失效，最右侧的系统按钮会被胶囊压住。
    wb.appendChild(spacer);
    if (spacer.style.width !== width + 'px') spacer.style.width = width + 'px';
    if (rect.scrollWidth > rect.width + 1) wb.setAttribute('data-pocket-scroll', '1');
  }

  // ---- 轻提示 -------------------------------------------------------------
  function notice(msg) {
    if (!document.body) return;
    var old = document.getElementById('pocket-turn-nav-toast');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var t = document.createElement('div');
    t.id = 'pocket-turn-nav-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () {
      if (t.parentNode) t.parentNode.removeChild(t);
    }, 2800);
  }

  function flash(el) {
    if (!el) return;
    el.style.transition = 'background-color .5s ease';
    var prev = el.style.backgroundColor;
    el.style.backgroundColor = 'var(--color-accent-soft, rgba(80,140,255,.16))';
    setTimeout(function () {
      el.style.backgroundColor = prev || '';
    }, 620);
  }

  // 定位签名要用「实时算出来的锚点位置」，不能用 place() 里存下来的值：
  // 那会变成自己引用自己 —— place 没被调用过，anchorTop 就永远是旧值，
  // 于是输入框从屏幕中间滑到底部时胶囊留在原地（实测停在 y=355，
  // 而 .dock-workbar 已经在 y=686）。
  //
  // 还必须带上卡片右边缘和胶囊自身宽度：首次渲染时 .composer-card 还没
  // 出现（只有 .dock-workbar），右对齐算出来是 12px；等卡片挂上来后
  // anchorTop 不变，签名不变就不会重算，胶囊会一直偏在右边。
  function anchorAt() {
    var wb = document.querySelector('.dock-workbar');
    var card = document.querySelector('.composer-card') || document.querySelector('.composer');
    var a = wb ? Math.round(wb.getBoundingClientRect().top) : -999;
    var c = card ? Math.round(card.getBoundingClientRect().right) : -999;
    var w = btn ? Math.round(btn.getBoundingClientRect().width) : 0;
    return a + ':' + c + ':' + w;
  }

  // ---- 主循环 -------------------------------------------------------------
  var lastPos = '';
  function tick() {
    try {
      // 无条件先同步会话：早先只有 recordFromDom 里才调 syncSession，
      // 而它被 scroller() 门控 —— 切会话瞬间滚动容器可能短暂为 null，
      // 于是这次切换被推迟到下一次 tick 才被发现。
      syncSession();
      var sc = scroller();
      if (sc) recordFromDom(sc);
      maybePreload();

      // 桌面端有自己的目录（>640px 时渲染），别让两条同时出现
      var native = document.querySelector('.conversation-toc');
      var nativeVisible = native && native.offsetParent !== null;
      overlayOn = overlayOpen();
      var enough = chatRendered && knownIds().length > 1;
      root.classList.toggle('on', placeOk && !nativeVisible && enough);

      if (isOpen) {
        var sc2 = scroller();
        var sig = knownIds().length + '|' + currentNode(sc2);
        if (sig !== lastListSig) renderList();
      }

      var posSig = placeOk + '|' + overlayOn + '|' + anchorAt() + '|' + window.innerHeight + '|' + window.innerWidth;
      if (posSig !== lastPos) {
        lastPos = posSig;
        place();
      }    } catch (e) {
      /* 任何异常都不能影响宿主页面 */
    }
  }

  function boot() {
    if (!document.body) { setTimeout(boot, 60); return; }
    ensureStyle();
    activeKey = sessionKey();
    loadStore();
    build();
    bindNativeToc();
    place();
    tick();
    setInterval(tick, 400);
    window.addEventListener('pagehide', function () {
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = 0; }
      if (dirty) saveStore();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();`;
