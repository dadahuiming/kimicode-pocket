// 断线提示改写（Reconnect Notice）的测试。
//
// 背景：用户手机公网访问时，每次打开页面都弹红色「实时连接出错 / WebSocket error」。
// 客户端本来就会自动重连（指数退避），只是文案像故障。这里把它改成
// 「正在重新连接…」+ 转圈，并藏掉诊断链接。
//
// 本文件要守住的三件事：
//   1. 该改的确实改了（标题/正文/转圈/隐藏链接）；
//   2. **不该改的绝不能碰** —— Desktop 还有「无法连接到 Kimi 服务器」
//      「Kimi 服务器返回错误」等真错误 toast，误改会把真故障伪装成「正在重连」；
//   3. 幂等 —— MutationObserver 会反复回调，重复处理不能把文案改乱。

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import {
  isWsToastText,
  buildReconnectScript,
  WS_TITLE_ZH,
  WS_TITLE_EN,
  RECONNECT_TITLE_ZH,
  RECONNECT_BODY_ZH,
} from '../src/lib/reconnect.mjs';

// ---------------------------------------------------------------- 假 DOM
//
// 只实现改写脚本用到的部分。刻意保持最小 —— 缺什么就报错，而不是静默通过。

function makeEl(tag = 'div', text = '') {
  const el = {
    tagName: String(tag).toUpperCase(),
    nodeType: 1,
    children: [],
    parentNode: null,
    style: {},
    _attrs: {},
    _text: text,
    className: '',
    getAttribute(n) { return Object.prototype.hasOwnProperty.call(el._attrs, n) ? el._attrs[n] : null; },
    setAttribute(n, v) { el._attrs[n] = String(v); },
    removeAttribute(n) { delete el._attrs[n]; },
    appendChild(c) { c.parentNode = el; el.children.push(c); return c; },
    insertBefore(c, ref) {
      const i = el.children.indexOf(ref);
      c.parentNode = el;
      if (i < 0) el.children.push(c); else el.children.splice(i, 0, c);
      return c;
    },
    removeChild(c) {
      const i = el.children.indexOf(c);
      if (i >= 0) el.children.splice(i, 1);
      c.parentNode = null;
      return c;
    },
    contains(n) {
      let p = n;
      while (p) { if (p === el) return true; p = p.parentNode; }
      return false;
    },
    // 朴素实现：递归收集所有后代
    querySelectorAll(sel) {
      const out = [];
      const wantSpin = sel === '.pocket-spin';
      const wantAny = sel === '*';
      const walk = (n) => {
        for (const c of n.children) {
          if (wantSpin) { if (c.className === 'pocket-spin') out.push(c); }
          else if (wantAny || sel === 'button, a') {
            if (wantAny) out.push(c);
            else if (c.tagName === 'BUTTON' || c.tagName === 'A') out.push(c);
          }
          walk(c);
        }
      };
      walk(el);
      return out;
    },
    querySelector(sel) {
      const r = el.querySelectorAll(sel);
      return r.length ? r[0] : null;
    },
  };

  // `el.id = X` 是属性赋值，不走 setAttribute —— 假 DOM 必须两者同步，
  // 否则脚本明明建好了节点，getElementById 却找不着。
  // （这个坑在 toc-inject.test.mjs 里踩过一次，这里同样要防。）
  Object.defineProperty(el, 'id', {
    get() { return el._attrs.id === undefined ? '' : String(el._attrs.id); },
    set(v) { el._attrs.id = String(v); },
    configurable: true,
    enumerable: true,
  });

  // textContent 必须像真 DOM 一样**递归聚合子节点文本**。
  // 早先写成普通属性（只存自己的字），于是 toast 根节点的 textContent 是空串，
  // isWsToast() 永远返回 false —— 7 个用例集体误报，而生产代码其实是对的。
  Object.defineProperty(el, 'textContent', {
    get() {
      if (el.children.length === 0) return el._text;
      return el.children.map((c) => c.textContent).join('');
    },
    set(v) {
      // 真 DOM 的行为：赋值会清空所有子节点
      el._text = String(v);
      el.children.length = 0;
    },
    configurable: true,
    enumerable: true,
  });

  return el;
}

/** 造一条 Desktop 风格的 toast */
function makeToast({ title, message, withLinks = true }) {
  const root = makeEl('div');
  root.setAttribute('role', 'status');
  const titleEl = makeEl('div', title);
  const msgEl = makeEl('div', message);
  root.appendChild(titleEl);
  root.appendChild(msgEl);
  if (withLinks) {
    const b1 = makeEl('button', '查看详情');
    const b2 = makeEl('button', '复制诊断信息');
    root.appendChild(b1);
    root.appendChild(b2);
  }
  return root;
}

/** 造一个能跑改写脚本的最小环境 */
function makeEnv(toasts) {
  const body = makeEl('body');
  const toastsBox = makeEl('div');
  toastsBox.className = 'toasts';
  for (const t of toasts) toastsBox.appendChild(t);
  body.appendChild(toastsBox);

  const head = makeEl('head');
  const store = new Map();

  const doc = {
    readyState: 'complete',
    body,
    head,
    documentElement: body,
    getElementById: (id) => {
      // 必须同时搜 body 和 head —— 注入的 <style> 挂在 head 上，
      // 早先只搜 body，导致「没有注入 @keyframes」的误报。
      const walk = (n) => {
        if (n._attrs && n._attrs.id === id) return n;
        for (const c of n.children) { const r = walk(c); if (r) return r; }
        return null;
      };
      return walk(body) || walk(head);
    },
    createElement: (t) => makeEl(t),
    querySelectorAll(sel) {
      // 改写脚本用的选择器
      if (sel === '.toasts [role="status"], .toasts > *') {
        const box = body.children.find((c) => c.className === 'toasts');
        return box ? box.children.slice() : [];
      }
      return [];
    },
    addEventListener(ev, fn) { if (ev === 'DOMContentLoaded') fn(); },
    removeEventListener() {},
  };

  const win = {
    innerWidth: 390,
    innerHeight: 844,
    document: doc,
    location: { pathname: '/', href: 'https://example.test/' },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    addEventListener() {},
    removeEventListener() {},
    setTimeout: (fn) => setTimeout(fn, 0),
    clearTimeout,
    setInterval: () => 0,      // 不要真的起定时器，测试会挂
    clearInterval: () => {},
    MutationObserver: class {
      constructor(cb) { this.cb = cb; }
      observe() {}
      disconnect() {}
    },
    navigator: { userAgent: 'node-test' },
  };
  win.window = win;
  win.globalThis = win;
  win.self = win;
  win.console = { log() {}, warn() {}, error() {}, info() {} };

  return { win, doc, body, toastsBox };
}

function run(toasts) {
  const env = makeEnv(toasts);
  const code = buildReconnectScript();
  const ctx = vm.createContext(env.win);
  vm.runInContext(code, ctx, { timeout: 5000, filename: 'pocket-reconnect.js' });
  return env;
}

/** 取某个 toast 的标题文本（跳过转圈元素） */
function titleOf(toast) {
  for (const c of toast.children) {
    if (c.className === 'pocket-spin') continue;
    const t = (c.textContent || '').trim();
    if (t) return t;
  }
  return '';
}

// ---------------------------------------------------------------- 测试

test('识别：中文/英文原文案都能认出', () => {
  assert.equal(isWsToastText('实时连接出错'), true);
  assert.equal(isWsToastText('实时连接出错 WebSocket error'), true);
  assert.equal(isWsToastText('Realtime connection error'), true);
  assert.equal(isWsToastText('  Realtime connection error  WebSocket error '), true);
});

test('识别：其它 toast 绝不能被误判（否则真错误会被伪装成「正在重连」）', () => {
  // 这些标题里都含「连接」「服务器」，用模糊判据就会踩雷
  assert.equal(isWsToastText('无法连接到 Kimi 服务器'), false);
  assert.equal(isWsToastText('Kimi 服务器返回错误'), false);
  assert.equal(isWsToastText('Kimi 服务器响应超时'), false);
  assert.equal(isWsToastText('无法加载当前会话内容'), false);
  assert.equal(isWsToastText('发送失败'), false);
  assert.equal(isWsToastText('操作失败'), false);
  assert.equal(isWsToastText('Cannot connect to Kimi server'), false);
  assert.equal(isWsToastText('Kimi server response timed out'), false);
  assert.equal(isWsToastText(''), false);
  assert.equal(isWsToastText(null), false);
});

test('改写：标题变成「正在重新连接…」，正文变成人话', () => {
  const toast = makeToast({ title: WS_TITLE_ZH, message: 'WebSocket error' });
  run([toast]);

  assert.equal(titleOf(toast), RECONNECT_TITLE_ZH, '标题没被改写');

  // 正文节点：按文本找，不要用下标 —— 转圈是插在标题**前面**的，
  // 下标会整体后移一位（第一版就是这么误报的）。
  const texts = toast.children.map((c) => (c.textContent || '').trim());
  assert.ok(
    texts.includes(RECONNECT_BODY_ZH),
    '正文没被改写，实际：' + JSON.stringify(texts),
  );
  assert.ok(
    !texts.includes('WebSocket error'),
    '技术文案「WebSocket error」没有被替换掉',
  );
});

test('改写：英文 toast 也认', () => {
  const toast = makeToast({ title: WS_TITLE_EN, message: 'WebSocket error' });
  run([toast]);
  assert.equal(titleOf(toast), RECONNECT_TITLE_ZH);
});

test('改写：诊断链接被隐藏（用户不需要，也不该看到）', () => {
  const toast = makeToast({ title: WS_TITLE_ZH, message: 'WebSocket error' });
  run([toast]);

  const btns = toast.children.filter((c) => c.tagName === 'BUTTON');
  assert.ok(btns.length >= 2, '测试构造有问题：应该有诊断按钮');
  for (const b of btns) {
    assert.equal(b.style.display, 'none', `按钮「${b.textContent}」没有被隐藏`);
  }
});

test('改写：加了转圈元素，且带 CSS 动画', () => {
  const toast = makeToast({ title: WS_TITLE_ZH, message: 'WebSocket error' });
  const env = run([toast]);

  const spin = toast.querySelector('.pocket-spin');
  assert.ok(spin, '没有插入转圈元素');
  assert.match(spin.style.cssText || '', /animation/, '转圈元素没有动画');

  // keyframes 必须真的注入到 head
  const kf = env.doc.getElementById('pocket-spin-kf');
  assert.ok(kf, '没有注入 @keyframes');
  assert.match(kf.textContent || '', /@keyframes pocket-spin/);
});

test('不改写：真错误 toast 原样保留', () => {
  const real = makeToast({ title: '无法连接到 Kimi 服务器', message: 'Web 没有拿到 Kimi 服务器的响应。' });
  const before = titleOf(real);
  run([real]);
  assert.equal(titleOf(real), before, '真错误标题被改了 —— 这会让故障看起来像正常重连');
  assert.equal(real._attrs['data-pocket-reconnect'], undefined, '真错误被打了处理标记');
});

test('混合：一条真错误 + 一条 WS，只改 WS 那条', () => {
  const real = makeToast({ title: 'Kimi 服务器返回错误', message: 'HTTP 500' });
  const ws = makeToast({ title: WS_TITLE_ZH, message: 'WebSocket error' });
  run([real, ws]);

  assert.equal(titleOf(real), 'Kimi 服务器返回错误', '真错误被误改');
  assert.equal(titleOf(ws), RECONNECT_TITLE_ZH, 'WS 提示没改');
});

test('幂等：同一 toast 被 sweep 多次也不会被改乱', () => {
  // 真实场景：MutationObserver 会在**同一个实例内**反复调 sweep()。
  //
  // 说明（诚实记录）：这条用例**抓不到**「删掉 MARK 守卫」这个变异 ——
  // 我试过，删了仍然全绿。原因是还有两道独立的天然屏障：
  //   1. 第二次 findTitleNode 找不到原文案（已经被改成「正在重新连接…」），返回 null；
  //   2. 转圈有 !el.querySelector('.pocket-spin') 检查。
  // 也就是说 MARK 守卫是**性能优化**（省掉重复的 querySelectorAll 扫描），
  // 不是正确性的唯一依靠。这里如实标注，免得以后有人以为它有测试保护。
  const toast = makeToast({ title: WS_TITLE_ZH, message: 'WebSocket error' });
  const env = makeEnv([toast]);
  const ctx = vm.createContext(env.win);

  const code = buildReconnectScript();
  // 把 sweep 暴露到全局，便于直接反复调用
  vm.runInContext(
    code.replace('function boot() {', 'window.__sweep = sweep;\n  function boot() {'),
    ctx,
    { timeout: 5000 },
  );

  assert.equal(typeof env.win.__sweep, 'function', '没能暴露 sweep');
  for (let i = 0; i < 5; i += 1) env.win.__sweep();

  assert.equal(titleOf(toast), RECONNECT_TITLE_ZH, '重复 sweep 后标题乱了');
  const spins = toast.querySelectorAll('.pocket-spin');
  assert.equal(spins.length, 1, `重复 sweep 插入了 ${spins.length} 个转圈`);
  const texts = toast.children.map((c) => (c.textContent || '').trim());
  assert.ok(texts.includes(RECONNECT_BODY_ZH), '重复 sweep 后正文乱了');
});

test('幂等：全局守卫防止脚本被执行两次', () => {
  const toast = makeToast({ title: WS_TITLE_ZH, message: 'WebSocket error' });
  const env = makeEnv([toast]);
  const code = buildReconnectScript();
  const ctx = vm.createContext(env.win);

  vm.runInContext(code, ctx, { timeout: 5000 });
  assert.equal(env.win.__pocketReconnectNotice, true, '没有设置全局守卫');

  // 第二次执行应该直接 return，不再重复处理
  vm.runInContext(code, ctx, { timeout: 5000 });
  const spins = toast.querySelectorAll('.pocket-spin');
  assert.equal(spins.length, 1, '守卫失效，转圈被插入了两次');
});

test('改写：标题颜色被中性化（不能保留错误红）', () => {
  // Desktop 把这条 toast 归为 severity=error，标题是错误红。
  // 只改文案不改颜色，视觉上仍然在喊「出故障了」。
  const toast = makeToast({ title: WS_TITLE_ZH, message: 'WebSocket error' });
  run([toast]);

  // 找到标题节点（跳过转圈）
  const titleNode = toast.children.find((c) => c.className !== 'pocket-spin' && (c.textContent || '').trim());
  assert.ok(titleNode, '找不到标题节点');
  assert.equal(titleNode.style.color, 'inherit', '标题颜色没有中性化，仍然是错误红');
});

test('脚本本身：不含会破坏 String.raw 的反引号', () => {
  // 这个项目已经三次栽在「注释里写反引号」上：CLIENT_JS 是 String.raw 模板，
  // 一个反引号就能让整个模块语法错误。这里直接钉死。
  const code = buildReconnectScript();
  assert.ok(!code.includes('`'), '注入脚本里出现了反引号，会终止外层 String.raw 模板');
});
