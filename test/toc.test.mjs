/**
 * 轮次导航注入的单元测试。
 *
 * 这一组守的是「注入」这件事本身的安全性：
 *   - 只碰 HTML，不碰 JSON / 空串 / 非字符串
 *   - 幂等：同一份 HTML 注入两次结果不变（上游缓存可能把带脚本的页面再吐回来）
 *   - 不破坏文档结构：</body> 必须还在原位
 *
 * 为什么要专门测 「</script> 转义」：注入的脚本里如果有未转义的结束标签，
 * 浏览器会在那里提前闭合 <script>，后面的 JS 源码就变成页面文本 ——
 * 用户看到的是满屏代码，而不是应用。这类 bug 只在运行时才炸，静态检查抓不到。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  injectTurnNav,
  alreadyInjected,
  shouldInjectNav,
  TOC_MARKER,
  TOC_SCRIPT_ID,
  MAX_HTML_BYTES,
} from '../src/lib/toc.mjs';

const PAGE = '<!doctype html><html><head><title>Kimi Code</title></head><body><div id="app"></div></body></html>';

function extractScript(html) {
  const open = `<script id="${TOC_SCRIPT_ID}">`;
  const start = html.indexOf(open);
  if (start < 0) return null;
  const from = start + open.length;
  return html.slice(from, html.indexOf('</script>', from));
}

test('正常页面：注入到 </body> 之前，文档结构不变', () => {
  const out = injectTurnNav(PAGE);
  assert.ok(out.includes(TOC_MARKER));
  assert.ok(out.includes(`id="${TOC_SCRIPT_ID}"`));
  assert.ok(out.indexOf(TOC_MARKER) < out.indexOf('</body>'), '必须插在 </body> 之前');
  assert.match(out, /<div id="app"><\/div>/);
  assert.ok(out.endsWith('</body></html>'));
});

test('幂等：同一份 HTML 注入两次，结果与一次完全相同', () => {
  const once = injectTurnNav(PAGE);
  const twice = injectTurnNav(once);
  assert.equal(twice, once, '重复注入会叠加两份监听器');
  assert.equal(alreadyInjected(once), true);
  assert.equal(alreadyInjected(PAGE), false);
});

test('没有 </body> 的页面：退到 </html> 之前，而不是直接丢弃', () => {
  const html = '<!doctype html><html><head><title>x</title></head></html>';
  const out = injectTurnNav(html);
  assert.ok(out.includes(TOC_MARKER));
  assert.ok(out.indexOf(TOC_MARKER) < out.indexOf('</html>'));
  assert.ok(out.endsWith('</html>'));
});

test('碎片 HTML（连 </html> 都没有）：追加到末尾而不是报错', () => {
  const out = injectTurnNav('<div id="app"></div>');
  assert.ok(out.includes(TOC_MARKER));
  assert.ok(out.startsWith('<div id="app"></div>'));
});

test('空串与非字符串原样返回（上游可能给空响应）', () => {
  assert.equal(injectTurnNav(''), '');
  assert.equal(injectTurnNav(null), null);
  assert.equal(injectTurnNav(undefined), undefined);
});

test('注入脚本语法合法，且不含未转义的 </script', () => {
  const code = extractScript(injectTurnNav(PAGE));
  assert.ok(code && code.length > 500, '脚本不该为空');
  assert.doesNotThrow(() => new Function(code), '脚本必须能被解析');
  assert.ok(!/<\/script/i.test(code), '</script 必须被转义');
  assert.ok(!/<\/script/i.test(injectTurnNav(PAGE).replace(/<\/script>/g, '')), '整页只有注入脚本这一个结束标签');
});

test('注入脚本只依赖语义属性，不依赖压缩后的类名', () => {
  // 守住「Kimi 发版不炸」这条底线：脚本只认 data-turn-id（官方语义属性）
  // 和 .u-bub/.composer-card 这两个稳定的语义类名。
  const code = extractScript(injectTurnNav(PAGE));
  assert.ok(code.includes('data-turn-id'), '轮次来源必须是 data-turn-id');
  assert.ok(!/\bnu\b|\bMobileTopBar\b/.test(code), '不能依赖压缩后的变量名');
});

test('轮次序号解析：真实格式是 t8:input / t8.41.f1，不是 t0', () => {
  // 这条来自线上实测：DOM 里 data-turn-id 的值是 `t8:input`（用户气泡）
  // 和 `t8.41.f1`（助手帧）。第一版正则写成 /^t(\d+)$/ 全线匹配不上，
  // 于是所有轮次都掉进 fallback，胶囊显示成错误的「2 / 5」。
  const code = extractScript(injectTurnNav(PAGE));
  assert.ok(code.includes('^t(\\d+)'), '必须只匹配开头的 t<数字>，不能锚定结尾');
  assert.ok(!code.includes('^t(\\d+)$'), '绝不能锚定 $ ，否则 t8:input 匹配不到');
});

test('列表只列真正扫到过的节点，不生成占位项', () => {
  // 实测：turnId 里夹着 task 占位轮（没有用户气泡），任何「1..N」枚举
  // 都会列出点不动的空项。现在只列已经记录到 / DOM 里真实存在的节点。
  const code = extractScript(injectTurnNav(PAGE));
  assert.ok(code.includes('knownIds()'), '必须按已记录的节点枚举');
  assert.ok(!code.includes('for (var n = 1; n <= total; n += 1)'), '不能再按 1..N 枚举');
  assert.ok(!code.includes('未加载）'), '不再出现「第 N 轮（未加载）」占位');
});

test('节点主键用 turnId 字符串，不是轮次序号', () => {
  // 桌面目录 11 个节点、手机早期只有 9 个：因为按 t(\d+) 的序号去重，
  // 把同一轮的追加消息（t0.41.f1）和首条消息（t0:input）合并了。
  // 改成整串 turnId 当主键后与桌面 1:1 对齐。
  const code = extractScript(injectTurnNav(PAGE));
  assert.ok(code.includes('cmpId('), '要有 turnId 的比较函数');
  assert.ok(code.includes("bt.setAttribute('data-turn'") || code.includes('setAttribute(\'data-turn\''), '每行要带 turnId');
  assert.ok(!code.includes('ordOf('), '不能再退回「抽数字当序号」那套');
});

test('列表不再显示序号（turnId 编号对不上用户心里的第几轮）', () => {
  const code = extractScript(injectTurnNav(PAGE));
  assert.ok(!code.includes('tn-no'), '不能渲染序号节点');
  assert.ok(!code.includes("'第 ' + ord + ' 轮'"), '不能用序号当兜底标题');
});

test('已加载轮次要持久化：回到最新消息后不能又变空', () => {
  const code = extractScript(injectTurnNav(PAGE));
  assert.ok(code.includes('localStorage'), '必须用 localStorage 缓存');
  assert.ok(code.includes('kimi-pocket.toc.'), '缓存 key 要带前缀，避免污染宿主');
  assert.ok(code.includes('loadStore'), '启动时要读回来');
  assert.ok(code.includes('saveStore'), '扫到新轮次要写回去');
});

test('预加载只扫最近若干轮，不是整篇', () => {
  const code = extractScript(injectTurnNav(PAGE));
  assert.ok(code.includes('PRELOAD_TURNS'), '要有预加载轮数上限');
  assert.ok(/PRELOAD_TURNS = \d+/.test(code), '上限必须是具体数字');
  assert.ok(code.includes('enough'), '达到上限要提前收手');
});

test('跳不过去时只提示、不乱跳', () => {
  const code = extractScript(injectTurnNav(PAGE));
  assert.ok(code.includes('notice('), '必须给出可见提示');
  assert.ok(code.includes('还没加载到'), '提示要说明原因');
});

test('跳转用浏览器原生 smooth，不再自己 rAF 逐帧推', () => {
  // 实测对比（3 万像素会话，34k 像素跳转）：
  //   自绘 rAF：40 帧里 14 帧超 33ms，p95 = 183ms，最大 283ms（肉眼就是卡）
  //   原生 smooth：p50 = p95 = 17ms，零长任务
  // 所以这里锁死「必须用 scroll-behavior:smooth + 轮询等停稳」。
  const code = extractScript(injectTurnNav(PAGE));
  assert.ok(code.includes("scrollBehavior = 'smooth'"), '必须启用原生平滑滚动');
  assert.ok(code.includes('function smoothTo'), '要有统一的平滑跳转入口');
  assert.ok(!code.includes('requestAnimationFrame(frame)'), '不能再自己逐帧推 scrollTop');
  assert.ok(code.includes('clientHeight / 2'), '对齐仍用「目标中心 - 视口一半」');
});

test('桌面端官方目录也走平滑（临时加 scroll-behavior，用户一动就撤）', () => {
  const code = extractScript(injectTurnNav(PAGE));
  assert.ok(code.includes('.conversation-toc .toc-row'), '要挂到官方目录的行上');
  assert.ok(code.includes('cancelNativeSmooth'), '必须能撤销，别影响应用的跟随最新消息');
  // 实测：官方目录是「瞬间赋值 + 自己再修正」，scrollend 会在第一跳结束时
  // 立刻触发，把刚加上的 smooth 撤掉，剩下的长距离还是硬跳。
  // 所以只能用真实用户输入（wheel/touch/keydown）触发撤销。
  assert.ok(!code.includes("addEventListener('scrollend'"), '不能用 scrollend 撤销（会自己拆掉自己）');
  assert.ok(code.includes("addEventListener('wheel', cancelNativeSmooth"), '滚轮才算用户操作');
  assert.ok(code.includes("addEventListener('touchstart', cancelNativeSmooth"), '触摸才算用户操作');
  assert.ok(code.includes('smoothStop'), '要短时间反复重设，覆盖官方的二次赋值');
});

test('胶囊与输入框上的系统按钮同款：28px 高、14px 字、10px 圆角', () => {
  // 用户明确要求「按钮样式和字体样式都和输入框上的后台 Bash / 后台 Agent 一致」。
  // 这几个值是从线上 .ui-pill 的计算样式量出来的，写死在这里防止漂移。
  const code = extractScript(injectTurnNav(PAGE));
  assert.ok(code.includes('height:28px'), '高度 28px');
  assert.ok(code.includes('font-size:14px'), '字号 14px');
  assert.ok(code.includes('line-height:20px'), '行高 20px');
  assert.ok(code.includes('border-radius:10px'), '圆角 10px');
  assert.ok(code.includes('padding:4px 8px'), '内边距与 ui-pill 一致');
  assert.ok(code.includes('gap:6px'), '图标与文字间距 6px');
  assert.ok(code.includes('blur(24px) saturate(1.8)'), '玻璃背景与 ui-pill 一致');
});

test('弹层往上方展开（胶囊在输入框上沿，往下弹会盖住输入框）', () => {
  const code = extractScript(injectTurnNav(PAGE));
  assert.ok(/\.tn-list\{[^}]*bottom:34px/.test(code), '弹层要向上');
});

test('系统按钮变多时横向滑动，历史节点位置固定', () => {
  // 用户要求：左侧系统按钮如果有第三第四个，做成向左拖拽滑动显示更多，
  // 而「历史节点」固定不动、层级更高。
  const code = extractScript(injectTurnNav(PAGE));
  assert.ok(code.includes('.dock-workbar{overflow-x:auto!important'), '系统按钮行要能横滑');
  assert.ok(code.includes('flex-wrap:nowrap!important'), '必须禁止换行（应用自己写的是 wrap）');
  assert.ok(code.includes('scrollbar-width:none'), '隐藏滚动条，手指拖就行');
  assert.ok(code.includes('z-index:2147483002'), '胶囊层级要高于 chat-dock(100)');
  assert.ok(code.includes('reserve('), '要给胶囊留出位置，别被系统按钮盖住');
});

test('定位用「缓存位置首跳 + 方向分段推进」，不用二分也不用光幕', () => {
  // 这一版把定位彻底重写了，实测结论：
  //   - 光幕遮罩：一次跳转 = 一次整屏淡入淡出，用户反复报「白屏/黑屏闪一下」，
  //     跨的节点越多越明显。闪屏来源就是遮罩自己 —— 已全部删除。
  //   - 二分/细扫：步骤多、易和虚拟列表重排抢帧，也删掉了。
  //   - 现在：先用缓存 y 一跳（实测精准到 60px），不中再按方向分段推进。
  const code = extractScript(injectTurnNav(PAGE));
  assert.ok(code.includes('function stepToward'), '要有分段推进');
  assert.ok(code.includes('function renderedSpan'), '要用已渲染节点的区间判断方向');
  assert.ok(code.includes('function nearestUserId'), '要看视口探针线附近的用户节点');
  assert.ok(code.includes('trace(\'cached\''), '首跳要用缓存位置');
  assert.ok(!code.includes('function turnBinary'), '不能再用二分');
});

test('光幕已彻底移除，绝不能再出现（这是闪屏的根源）', () => {
  const code = extractScript(injectTurnNav(PAGE));
  assert.ok(!code.includes('veil'), '不能有任何 veil 代码');
  assert.ok(!code.includes('showVeil'), '不能有 showVeil');
  assert.ok(!code.includes('pocket-turn-nav-scan'), '不能有扫描光带动画');
});

test('定位算法不许依赖「渲染区间最值」判方向（常驻锚点会骗人）', () => {
  // Kimi 把最后一条用户消息当常驻锚点留在 DOM 里，它比任何早期目标都大。
  // 用 min/max 判方向会恒判「目标在下方」，实测在底部打转。
  const code = extractScript(injectTurnNav(PAGE));
  assert.ok(code.includes('nearestUserId'), '必须用探针线附近的节点');
  assert.ok(!code.includes('function renderedRange'), '不能再用 renderedRange');
});

test('分段推进必须有硬 deadline，任何路径都不许拖住', () => {
  // 审计指出：没有 wall-clock 检查时最坏能拖 70 秒，而且全程零反馈。
  const code = extractScript(injectTurnNav(PAGE));
  assert.ok(code.includes('JUMP_DEADLINE_MS'), '要有跳转总预算');
  assert.ok(code.includes('function outOfTime'), '要有统一的时间检查');
  assert.ok(code.includes('jumpT0'), '要记录起始时间');
});

test('落地校正只做平滑，绝不瞬移、不闪任何遮罩', () => {
  const code = extractScript(injectTurnNav(PAGE));
  assert.ok(code.includes('function settleAlign'), '要有落地校正');
  assert.ok(!code.includes('showVeil'), '校正期间不能亮遮罩');
  // settleAlign 里不应出现 stepTo（瞬时跳）
  const m = /function settleAlign\([^)]*\)[\s\S]*?\n  \}/.exec(code);
  assert.ok(m, 'settleAlign 必须存在');
  assert.ok(!m[0].includes('stepTo('), 'settleAlign 里不许瞬移，只能平滑');
});

test('预扫描必须可被跳转中止，不能和跳转抢滚动', () => {
  // 审计指出：preloadScan 的定时器链在 token 体系外，每 70ms 写 scrollTop，
  // 还能和 jump 并发 —— 两条链同时改滚动位置。
  const code = extractScript(injectTurnNav(PAGE));
  assert.ok(code.includes('function abortPreload'), '要能中止预扫');
  assert.ok(code.includes('preloadToken'), '预扫要有代次');
  assert.ok(code.includes('preloadAbort'), '要有中止标记');
  assert.ok(code.includes('if (myToken !== preloadToken)'), '旧链必须能识别自己被作废');
});

test('切会话必须清空记录，并有宽限期防止旧 DOM 污染', () => {
  const code = extractScript(injectTurnNav(PAGE));
  assert.ok(code.includes('function syncSession'), '要有会话切换检测');
  assert.ok(code.includes('rec = {}'), '切换时必须清空记录');
  assert.ok(code.includes('justSwitched'), '要有切换时间戳');
  assert.ok(code.includes('SWITCH_GRACE_MS'), '要有宽限期');
});

test('节点来源只能是用户气泡，绝不能收 agent 回复', () => {
  const code = extractScript(injectTurnNav(PAGE));
  assert.ok(code.includes("querySelectorAll('.u-bub[data-turn-id]')"), '节点来源必须是 .u-bub');
  assert.ok(!code.includes("querySelectorAll('[data-turn-id]')"), '不能全量查');
  assert.ok(!code.includes('.a-msg'), '不能引用 agent 回复容器');
});

test('乐观消息不能进节点列表（用户实测：2 个节点显示成 3 个）', () => {
  // 发送瞬间前端会塞一条本地临时用户消息占位，id 形如
  //   msg_opt_<base36 时间>_<自增>   发送
  //   msg_skill_opt_…                /技能 触发
  //   msg_opt_steer_…                转发/追加
  // 它同样渲染成 .u-bub[data-turn-id]。不滤掉就会变成一条永远点不到的幽灵节点。
  const code = extractScript(injectTurnNav(PAGE));
  assert.ok(/function isRealTurnId\(/.test(code), '必须有真实轮次判定函数');
  assert.ok(/\/\^t\\d\+\(\?:\[:\.\]\|\$\)\//.test(code), '判据必须是 t<数字> 开头');

  // 三处入口都必须带上这个判定，漏一处就会从那条路径漏进幽灵节点。
  const collectBody = code.slice(code.indexOf('function collect()'), code.indexOf('function collect()') + 900);
  assert.ok(collectBody.includes('isRealTurnId'), 'collect 必须过滤');
  const recordBody = code.slice(code.indexOf('function recordFromDom'), code.indexOf('function recordFromDom') + 900);
  assert.ok(recordBody.includes('isRealTurnId'), 'recordFromDom 必须过滤');
  const findBody = code.slice(code.indexOf('function findNode'), code.indexOf('function findNode') + 600);
  assert.ok(findBody.includes('isRealTurnId'), 'findNode 必须拒绝非真实轮次');

  // 旧版本已经把幽灵节点写进了 localStorage，读取时也要滤，
  // 否则用户升级后那条还挂着，得手动清缓存 —— 不能这么交付。
  const loadBody = code.slice(code.indexOf('function loadStore'), code.indexOf('function loadStore') + 900);
  assert.ok(loadBody.includes('isRealTurnId'), 'loadStore 必须滤掉历史幽灵记录');
});

test('saveStore 不许用空记录覆盖已有缓存', () => {
  // 审计指出的真窗口：切换会话时 rec 已清空、旧 timer 却在新 key 上触发，
  // 会把目标会话原有的缓存覆盖成 {"items":[]}。
  const code = extractScript(injectTurnNav(PAGE));
  assert.ok(code.includes('if (!items.length) return;'), '空记录必须直接返回');
});

test('place 在 workbar 短暂缺失时必须隐藏，不能掉到底部', () => {
  // 审计指出：workbar 重建的那一个 tick，胶囊会先跳到屏幕底部再跳回来。
  const code = extractScript(injectTurnNav(PAGE));
  assert.ok(code.includes('sawWorkbar'), '要记住是否曾经有过 workbar');
});

test('浮层打开时胶囊必须隐藏（用户实测：抽屉/新手引导上也浮着）', () => {
  // 胶囊 z-index 是 2147483002，天然盖过全屏浮层，所以一定会露出来。
  // 早先只判断「输入框是否在视口内」，压根没考虑「被浮层盖住」。
  const code = extractScript(injectTurnNav(PAGE));
  assert.ok(/function overlayOpen\(/.test(code), '必须有浮层判定');
  // 不能用 elementFromPoint：胶囊自己 z-index 最高，永远命中自己，测不出下面。
  // 只看真实调用（注释里提到这个名字是说明为什么不用它）。
  assert.ok(!/document\.elementFromPoint\(/.test(code), '不能用命中测试判断浮层');
  const placeBody = code.slice(code.indexOf('function place()'), code.indexOf('function place()') + 500);
  assert.ok(placeBody.includes('overlayOn'), 'place 必须先判浮层');
  // 浮层状态必须进定位签名，否则关掉浮层后 place() 不会再被调用，胶囊回不来。
  assert.ok(code.includes("placeOk + '|' + overlayOn"), '浮层状态必须进 posSig');
});

test('会话没渲染出来之前不许显示（用户实测：加载中也浮着）', () => {
  // enough 用 knownIds().length 读的是 localStorage 缓存，
  // 页面刚起来缓存里就有 2 条，于是一个节点都没渲染就判定「够多了」。
  // 实测 1.6.7 第 250ms 就亮：wb=0 ubub=0 win=0。
  const code = extractScript(injectTurnNav(PAGE));
  assert.ok(code.includes('chatRendered'), '需要渲染闩');
  assert.ok(/var enough = chatRendered && knownIds\(\)\.length > 1;/.test(code),
    'enough 必须同时要求已渲染');
  const recordBody = code.slice(code.indexOf('function recordFromDom'), code.indexOf('function recordFromDom') + 1200);
  assert.ok(recordBody.includes('chatRendered = true'), '看到真实气泡才闩上');
  // 切会话要重新等，否则切过去会立刻显示旧会话的判定
  const syncBody = code.slice(code.indexOf('function syncSession'), code.indexOf('function syncSession') + 1400);
  assert.ok(syncBody.includes('chatRendered = false'), '切会话必须重置');
});

test('reserve 的 spacer 必须始终移到末尾，否则会压住系统按钮', () => {
  const code = extractScript(injectTurnNav(PAGE));
  assert.ok(code.includes('wb.appendChild(spacer)'), '无条件 appendChild 才能移回末尾');
});

test('胶囊 ID 与脚本标签 ID 不同（同名会让 CSS 全部失效）', () => {
  // 线上实测：两者都叫 pocket-turn-nav 时，getElementById 拿到的是 <script>，
  // 它是 inline 元素、没有尺寸，于是整套 position:fixed 样式全部不生效，
  // 胶囊"存在"但完全看不见 —— 这类 bug 只能靠人眼发现，必须锁死。
  const html = injectTurnNav(PAGE);
  assert.ok(html.includes('id="pocket-turn-nav-script"'), '脚本标签用独立 id');
  const code = extractScript(html);
  assert.ok(code.includes("var ROOT_ID = ID + '-root'"), '胶囊用派生 id');
  assert.ok(code.includes('root.id = ROOT_ID'), '胶囊必须挂 ROOT_ID 而不是 ID');
  assert.ok(!code.includes('root.id = ID;'), '不能退回同名写法');
});

test('默认明暗跟随宿主：不写死颜色，只用 CSS 变量回退', () => {
  const code = extractScript(injectTurnNav(PAGE));
  assert.ok(code.includes('--color-bg-translucent'), '应使用宿主配色变量');
  assert.ok(code.includes('prefers-reduced-motion'), '要尊重减少动效偏好');
});

// ---------------------------------------------------------------- 准入判断

function fakeRes(headers = {}, statusCode = 200) {
  return { statusCode, headers };
}

test('只对 200 的 text/html GET 注入', () => {
  const req = { method: 'GET' };
  const cfg = { enabled: true };
  assert.equal(shouldInjectNav(req, fakeRes({ 'content-type': 'text/html; charset=utf-8', 'content-length': '2883' }), cfg), true);

  assert.equal(shouldInjectNav(req, fakeRes({ 'content-type': 'application/json', 'content-length': '10' }), cfg), false);
  assert.equal(shouldInjectNav(req, fakeRes({ 'content-type': 'text/html', 'content-length': '10' }, 404), cfg), false);
  assert.equal(shouldInjectNav({ method: 'HEAD' }, fakeRes({ 'content-type': 'text/html', 'content-length': '10' }), cfg), false);
  assert.equal(shouldInjectNav(req, fakeRes({ 'content-type': 'text/html', 'content-length': '10' }), { enabled: false }), false);
  assert.equal(shouldInjectNav(req, fakeRes({ 'content-type': 'text/html', 'content-length': '10' }), undefined), false);
});

test('没有 content-length 也要注入（上游可能用 chunked，静默失效最难查）', () => {
  assert.equal(
    shouldInjectNav({ method: 'GET' }, fakeRes({ 'content-type': 'text/html; charset=utf-8' }), { enabled: true }),
    true,
  );
});

test('已经带 content-encoding 的不注入（压缩流里找不到 </body>）', () => {
  const res = fakeRes({
    'content-type': 'text/html',
    'content-length': '900',
    'content-encoding': 'gzip',
  });
  assert.equal(shouldInjectNav({ method: 'GET' }, res, { enabled: true }), false);
});

test('超大 HTML 不注入（主文档只有 2.8KB，上万倍就当异常处理）', () => {
  const res = fakeRes({ 'content-type': 'text/html', 'content-length': String(4 * 1024 * 1024) });
  assert.equal(shouldInjectNav({ method: 'GET' }, res, { enabled: true }), false);
});

test('正好等于上限仍注入，超过才拒绝（边界不能靠猜）', () => {
  const at = fakeRes({ 'content-type': 'text/html', 'content-length': String(MAX_HTML_BYTES) });
  assert.equal(shouldInjectNav({ method: 'GET' }, at, { enabled: true }), true);
  const over = fakeRes({ 'content-type': 'text/html', 'content-length': String(MAX_HTML_BYTES + 1) });
  assert.equal(shouldInjectNav({ method: 'GET' }, over, { enabled: true }), false);
});
