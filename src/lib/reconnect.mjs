// 断线提示的「人话化」（Reconnect Notice）
//
// ------------------------------------------------------------------ 问题
//
// 用户实测反馈（手机公网访问）：
//   「每次打开 web 端页面，都会弹这个【实时连接出错】」
//   截图里是一条红色错误 toast：标题「实时连接出错」，正文「WebSocket error」，
//   下面还有「查看详情 / 复制诊断信息」两个链接。
//
// 这条提示是 Kimi Code Desktop 自己弹的（bundle 里的 warnings.wsTitle），
// 触发点是 WebSocket 的 onerror —— 也就是**握手阶段任何失败**都会弹，
// 包括「刚打开页面、第一次握手还没成功」这种完全正常的情况。
//
// 而它的文案读起来像「出故障了，你自己看着办」，实际行为却是：
//   - 客户端**本来就会自动重连**（指数退避 1s→2s→4s…封顶 30s）
//   - 连上之后 `dismissWsError()` 会自动把这条警告清掉
//
// 也就是说：这条提示 99% 的情况下只是在说「还在连，稍等」，
// 却用了「出错」这种把用户吓到的措辞，还附送一堆诊断链接。
//
// ------------------------------------------------------------------ 做法
//
// 不碰 Desktop 的代码（改包会被升级覆盖，也不该在别人的产物里改逻辑），
// 而是在代理注入的脚本里做一层**纯表现层**改写：
//
//   1. 监听 DOM，找到「标题正好是『实时连接出错』」的 toast；
//   2. 把标题换成「正在重新连接…」，正文换成一句人话；
//   3. 隐藏「查看详情 / 复制诊断信息」（用户不需要、也看不懂）；
//   4. 加一个转圈动画，让「正在连」这件事一眼可见；
//   5. 一旦连接恢复（toast 消失），什么都不用做 —— 本来就没了。
//
// 关键约束：**只在文案完全匹配时动手**。Desktop 还有「无法连接到 Kimi 服务器」
// 「Kimi 服务器返回错误」等别的 toast，那些是真错误，绝不能一起改写。
//
// ------------------------------------------------------------------ 为什么不改重连逻辑
//
// 用户问「如果是需要重连，能不能改为显示【重新连接】的弹窗」——
// 需要的只是文案，不是新机制。客户端已有重连，再加一套只会打架。
// 所以这里刻意**不创建任何 WebSocket、不拦截任何请求**，只改已经渲染出来的文字。

/** 要识别的原文案（中/英，Desktop 两套语言包） */
export const WS_TITLE_ZH = '实时连接出错';
export const WS_TITLE_EN = 'Realtime connection error';

/** 替换后的标题 */
export const RECONNECT_TITLE_ZH = '正在重新连接…';
export const RECONNECT_TITLE_EN = 'Reconnecting…';

/** 替换后的正文 */
export const RECONNECT_BODY_ZH = '网络有点波动，正在自动重连，通常几秒内恢复。';
export const RECONNECT_BODY_EN = 'Network hiccup — reconnecting automatically, usually back in seconds.';

/** toast 根容器（Desktop 的 .toasts 里每条都是一个带 role=status 的块） */
export const TOAST_SELECTOR = '.toasts [role="status"], .toasts > *';

/**
 * 判断一个 toast 元素是不是「WS 断线」那条。
 *
 * 必须**精确匹配标题文本**，不能用 includes('连接') 之类的模糊判据 ——
 * Desktop 还有「无法连接到 Kimi 服务器」（真断线）「Kimi 服务器返回错误」
 * 这些标题里都含「连接」或「服务器」，误改会把真错误也伪装成「正在重连」，
 * 那比不改更糟。
 *
 * @param {string} text toast 的全部文本
 * @returns {boolean}
 */
export function isWsToastText(text) {
  const t = String(text || '');
  if (!t) return false;
  return t.includes(WS_TITLE_ZH) || t.includes(WS_TITLE_EN);
}

/**
 * 生成注入到浏览器的客户端脚本。
 *
 * 单独导出成函数（而不是直接写死在 CLIENT_JS 里）是为了能被单测：
 * 测试可以把它塞进 jsdom/vm 跑一遍，验证「只改该改的那条」。
 *
 * @returns {string} 可直接放进 <script> 的 IIFE
 */
export function buildReconnectScript() {
  return `(function () {
  'use strict';
  if (window.__pocketReconnectNotice) return;
  window.__pocketReconnectNotice = true;

  var TITLES = ${JSON.stringify([WS_TITLE_ZH, WS_TITLE_EN])};
  var NEW_TITLE = ${JSON.stringify(RECONNECT_TITLE_ZH)};
  var NEW_BODY = ${JSON.stringify(RECONNECT_BODY_ZH)};
  var TOAST_SEL = ${JSON.stringify(TOAST_SELECTOR)};

  // 打过标记的元素不再重复处理（MutationObserver 会反复回调）
  var MARK = 'data-pocket-reconnect';

  function isWsToast(el) {
    var t = (el.textContent || '');
    for (var i = 0; i < TITLES.length; i += 1) {
      if (t.indexOf(TITLES[i]) >= 0) return true;
    }
    return false;
  }

  // 找到承载标题的那个元素。Desktop 的 toast 结构是
  //   <div role=status> <div class=title>实时连接出错</div> <div class=message>…</div> …
  // 但没有稳定的类名契约，所以按「文本完全等于标题」找最深的那个节点。
  function findTitleNode(root) {
    var all = root.querySelectorAll('*');
    var best = null;
    for (var i = 0; i < all.length; i += 1) {
      var el = all[i];
      if (el.children && el.children.length > 0) continue;   // 只要叶子
      var txt = (el.textContent || '').trim();
      for (var k = 0; k < TITLES.length; k += 1) {
        if (txt === TITLES[k]) { best = el; break; }
      }
      if (best) break;
    }
    return best;
  }

  function restyle(el) {
    if (el.getAttribute(MARK) === '1') return;
    el.setAttribute(MARK, '1');

    var titleNode = findTitleNode(el);
    if (titleNode) titleNode.textContent = NEW_TITLE;

    // 正文：把「WebSocket error」这类技术文案换成一句人话。
    // 只替换明确匹配的那几种，别的一律不动。
    var walker = el.querySelectorAll('*');
    for (var i = 0; i < walker.length; i += 1) {
      var n = walker[i];
      if (n.children && n.children.length > 0) continue;
      var t = (n.textContent || '').trim();
      if (/^WebSocket error$/i.test(t) || /^Failed to parse WS frame/i.test(t)) {
        n.textContent = NEW_BODY;
      }
    }

    // 「查看详情 / 复制诊断信息」对用户没有意义，藏掉。
    // 用 CSS 而不是删节点：Desktop 自己的事件处理器还挂着，删了可能报错。
    var links = el.querySelectorAll('button, a');
    for (var j = 0; j < links.length; j += 1) {
      var lt = (links[j].textContent || '').trim();
      if (lt === '查看详情' || lt === '复制诊断信息' ||
          lt === 'Show details' || lt === 'Copy diagnostics' ||
          lt === '收起详情' || lt === '已复制' ||
          lt === 'Hide details' || lt === 'Copied') {
        links[j].style.display = 'none';
      }
    }

    // 转圈：一个纯 CSS 的小圆环，插在标题前面。
    // 不依赖任何图标字体/图片，样式内联，不会被宿主 CSS 影响。
    if (titleNode && !el.querySelector('.pocket-spin')) {
      var spin = document.createElement('span');
      spin.className = 'pocket-spin';
      spin.setAttribute('aria-hidden', 'true');
      spin.style.cssText = [
        'display:inline-block',
        'width:12px',
        'height:12px',
        'margin-right:6px',
        'vertical-align:-1px',
        'border:2px solid currentColor',
        'border-right-color:transparent',
        'border-radius:50%',
        'animation:pocket-spin .8s linear infinite'
      ].join(';');
      titleNode.parentNode.insertBefore(spin, titleNode);
    }

    // 让整条提示看起来是「进行中」而不是「出错了」：
    // 去掉错误态的红色强调，改成中性色。
    el.style.opacity = '0.92';

    // 标题颜色也一并中性化。
    //
    // 为什么要动颜色：Desktop 把这条 toast 归为 severity=error，标题是错误红
    // （实测 rgb(255,107,107)）。文案改成「正在重新连接…」之后还留着红色，
    // 视觉上仍然在喊「出故障了」—— 用户反馈的正是「看着像报错」。
    // 用 inherit 而不是写死色值：跟随宿主的明暗主题，换主题也不会突兀。
    if (titleNode) {
      titleNode.style.color = 'inherit';
      titleNode.style.opacity = '0.95';
    }
  }

  function sweep() {
    var nodes = document.querySelectorAll(TOAST_SEL);
    for (var i = 0; i < nodes.length; i += 1) {
      if (isWsToast(nodes[i])) restyle(nodes[i]);
    }
  }

  function ensureKeyframes() {
    if (document.getElementById('pocket-spin-kf')) return;
    var st = document.createElement('style');
    st.id = 'pocket-spin-kf';
    st.textContent = '@keyframes pocket-spin{to{transform:rotate(360deg)}}';
    (document.head || document.documentElement).appendChild(st);
  }

  function boot() {
    ensureKeyframes();
    sweep();
    // toast 是 Vue 渲染出来的，出现时间不确定 —— 用 observer 盯着。
    // 只观察 childList，不观察 attributes，避免自己改样式又触发自己。
    var mo = new MutationObserver(function () { sweep(); });
    mo.observe(document.body, { childList: true, subtree: true });
    // 兜底：某些情况下 observer 可能漏（比如节点在 shadow root 里），
    // 低频率再扫一遍。开销可以忽略（一次 querySelectorAll）。
    setInterval(sweep, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();`;
}
