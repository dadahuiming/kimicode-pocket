// 注入脚本的**运行时**护栏。
//
// 为什么需要这个文件：
//   v1.6.12 把缓存 key 改成「会话 id + 指纹」时，把 /sessions/ 前缀提到了
//   模块作用域（SESSION_PATH_RE），而 sessionIdFromPath() 会被 .toString()
//   抽出来注入浏览器。注入出去的那份代码里只有名字、没有定义，于是：
//       ReferenceError: SESSION_PATH_RE is not defined
//   boot() 里第一句就是 sessionKey() → 整个 IIFE 当场死掉 → 胶囊消失。
//
//   而当时的护栏只做了两件事：new Function(code) 查语法、正则查有没有残留
//   的模块级函数名。两件都**查不出自由变量** —— 语法是对的，名字也是对的，
//   只是那个名字在浏览器里不存在。测试全绿，线上全黑。
//
// 所以这里改成真的跑：给注入脚本造一个最小的 DOM/localStorage 环境，
// 用 vm 执行整段代码，然后断言胶囊真的建出来了、位置真的算出来了。
// 只要注入代码里还残留任何一个「模块里有、浏览器里没有」的标识符，
// 这个测试就会红。

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { injectTurnNav, TOC_SCRIPT_ID, sessionIdFromPath } from '../src/lib/toc.mjs';

/** 从注入后的 HTML 里把 <script> 正文抠出来 */
function clientCode() {
  const html = injectTurnNav('<!doctype html><html><body></body></html>');
  const open = `<script id="${TOC_SCRIPT_ID}">`;
  const i = html.indexOf(open);
  assert.ok(i >= 0, '注入没有发生');
  const j = html.indexOf('</script>', i);
  assert.ok(j > i, 'script 标签没有闭合');
  return html.slice(i + open.length, j).replace(/<\\\/script/gi, '</script');
}

// ---------------------------------------------------------------- 假 DOM
//
// 只实现注入脚本真正用到的那一小撮 API。刻意保持「少」：
// 少到一旦脚本开始依赖新 API，这里就会抛错，提醒补环境 —— 而不是
// 悄悄用 undefined 混过去。

function fakeRect(top = 0, right = 0, width = 0, height = 0) {
  return { top, right, bottom: top + height, left: right - width, width, height, x: right - width, y: top };
}

function makeClassList(el) {
  const set = new Set();
  return {
    add: (...n) => n.forEach((x) => set.add(x)),
    remove: (...n) => n.forEach((x) => set.delete(x)),
    contains: (n) => set.has(n),
    toggle: (n, force) => {
      const on = force === undefined ? !set.has(n) : !!force;
      if (on) set.add(n); else set.delete(n);
      return on;
    },
    _set: set,
  };
}

function makeEl(tag = 'div', attrs = {}) {
  const el = {
    tagName: String(tag).toUpperCase(),
    nodeType: 1,
    children: [],
    parentNode: null,
    style: {},
    dataset: {},
    _attrs: { ...attrs },
    textContent: '',
    innerHTML: '',
    className: '',
    offsetParent: {},
    scrollTop: 0,
    scrollHeight: 4000,
    clientHeight: 800,
    getAttribute(n) {
      if (n === 'class') return el.className;
      return Object.prototype.hasOwnProperty.call(el._attrs, n) ? String(el._attrs[n]) : null;
    },
    setAttribute(n, v) { el._attrs[n] = String(v); },
    removeAttribute(n) { delete el._attrs[n]; },
    hasAttribute(n) { return Object.prototype.hasOwnProperty.call(el._attrs, n); },
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
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect() { return fakeRect(); },
    closest() { return null; },
    focus() {},
    click() {},
    setPointerCapture() {},
    releasePointerCapture() {},
  };
  el.classList = makeClassList(el);
  // `root.id = X` 是属性赋值，不会走 setAttribute —— 假 DOM 必须两者同步，
  // 否则脚本明明建好了节点，测试却按 _attrs 找不着（第一版就栽在这）。
  Object.defineProperty(el, 'id', {
    get() { return el._attrs.id === undefined ? '' : String(el._attrs.id); },
    set(v) { el._attrs.id = String(v); },
    configurable: true,
    enumerable: true,
  });
  el.classList.add = (...n) => {
    n.forEach((x) => el.classList._set.add(x));
    el.className = [...el.classList._set].join(' ');
  };
  el.classList.remove = (...n) => {
    n.forEach((x) => el.classList._set.delete(x));
    el.className = [...el.classList._set].join(' ');
  };
  return el;
}

/**
 * 造一个够注入脚本跑完 boot() 的最小环境。
 *
 * 关键点：`.u-bub[data-turn-id]` 必须**真的存在两条以上**，否则脚本会认为
 * 「节点不够」而把胶囊藏起来 —— 那也能跑通，但测不出 key 计算的路径。
 * 这里给三条真实轮次，正好走到 keyFor() → sidFromPath()。
 */
function makeEnv({ pathname = '/sessions/session_test-0001', nativeToc: nativeTocSpec = null } = {}) {
  const body = makeEl('body');
  const workbar = makeEl('div');
  workbar.className = 'dock-workbar';
  workbar._attrs.class = 'dock-workbar';
  const pill = makeEl('button');
  pill.className = 'ui-pill';
  pill._attrs.class = 'ui-pill';
  pill.getBoundingClientRect = () => fakeRect(1000, 700, 96, 28);
  workbar.appendChild(pill);
  workbar.getBoundingClientRect = () => fakeRect(1000, 900, 800, 36);

  const card = makeEl('div');
  card.className = 'composer-card';
  card._attrs.class = 'composer-card';
  card.getBoundingClientRect = () => fakeRect(1010, 900, 800, 120);

  const scrollerEl = makeEl('div');
  scrollerEl.className = 'panes chat-scroll';
  scrollerEl._attrs.class = 'panes chat-scroll';
  scrollerEl.scrollHeight = 4000;
  scrollerEl.clientHeight = 800;

  const bubbles = ['t0:input', 't1:input', 't2:input'].map((id, i) => {
    const b = makeEl('div');
    b.className = 'u-bub';
    b._attrs.class = 'u-bub';
    b._attrs['data-turn-id'] = id;
    b.getBoundingClientRect = () => fakeRect(200 + i * 300, 600, 400, 80);
    b.textContent = 'user message ' + id;
    return b;
  });

  const all = [workbar, card, scrollerEl, ...bubbles];

  // 桌面自带的目录。默认「不存在」—— 窄屏（手机）下 Desktop 根本不渲染它。
  // 需要模拟 iPad / 折叠屏时由测试塞进来（见 opts.nativeToc）。
  let nativeToc = null;
  if (nativeTocSpec) {
    nativeToc = makeEl('nav');
    nativeToc.className = 'conversation-toc';
    nativeToc._attrs.class = 'conversation-toc';
    // 关键：Desktop 在窄容器里**仍然留着这个元素**，只是 visibility:hidden。
    // offsetParent 对 visibility:hidden 依然非 null（这是这个 bug 的成因）。
    nativeToc.offsetParent = nativeTocSpec.offsetParent === false ? null : body;
    nativeToc.getBoundingClientRect = () => fakeRect(
      nativeTocSpec.top ?? 400,
      nativeTocSpec.right ?? 700,
      nativeTocSpec.width ?? 13,
      nativeTocSpec.height ?? 59,
    );
    nativeToc._computed = {
      visibility: nativeTocSpec.visibility || 'visible',
      display: nativeTocSpec.display || 'flex',
    };
  }

  // localStorage：真的存，注入脚本会读会写
  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    clear: () => store.clear(),
    key: (i) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  };

  const doc = {
    readyState: 'complete',
    body,
    documentElement: body,
    head: makeEl('head'),
    title: 'test',
    createElement: (t) => makeEl(t),
    createTextNode: (t) => ({ nodeType: 3, textContent: t }),
    createDocumentFragment: () => makeEl('fragment'),
    getElementById: (id) => {
      const walk = (n) => {
        if (n._attrs && n._attrs.id === id) return n;
        for (const c of n.children) { const r = walk(c); if (r) return r; }
        return null;
      };
      return walk(body);
    },
    querySelector(sel) {
      if (sel === '.dock-workbar') return workbar;
      if (sel === '.composer-card' || sel === '.composer') return card;
      if (sel === '.panes.chat-scroll') return scrollerEl;
      if (sel === '.conversation-toc') return nativeToc;
      return null;
    },
    querySelectorAll(sel) {
      if (sel === '.u-bub[data-turn-id]') return bubbles;
      if (sel === '.history-row[aria-posinset]') return [];
      if (sel.includes('role="dialog"') || sel.includes('aria-modal')) return [];
      if (sel === '.sheet-root, .sheet-scrim, [role="dialog"], [role="alertdialog"], [aria-modal="true"]') return [];
      return [];
    },
    addEventListener(ev, fn) { if (ev === 'DOMContentLoaded') fn(); },
    removeEventListener() {},
    activeElement: null,
    elementFromPoint: () => null,
  };
  // 上面那些 all 只是为了让静态分析看到它们在用，实际靠 querySelector 返回
  void all;

  const win = {
    innerWidth: 900,
    innerHeight: 1200,
    devicePixelRatio: 1,
    location: { pathname, href: 'https://example.test' + pathname, origin: 'https://example.test' },
    document: doc,
    localStorage,
    // 按元素返回：nativeToc 可以带自己的 visibility（模拟 .toc-clipped）
    getComputedStyle: (el) => {
      const base = {
        display: 'block', visibility: 'visible', opacity: '1', pointerEvents: 'auto',
        position: 'static', overflowY: 'visible', overflowX: 'visible',
      };
      if (el && el._computed) return { ...base, ...el._computed };
      return base;
    },
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms || 0, 5)),
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    navigator: { userAgent: 'node-test' },
    performance: { now: () => Date.now() },
    scrollTo() {},
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    KeyboardEvent: class {},
    MouseEvent: class {},
    Event: class {},
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
    Element: class {},
    HTMLElement: class {},
  };
  win.window = win;
  win.globalThis = win;
  win.self = win;
  win.console = { log() {}, warn() {}, error() {}, info() {}, debug() {} };
  win.location.pathname = pathname;

  return { win, doc, body, store, bubbles, workbar, card, scrollerEl };
}

/**
 * 跑注入脚本，返回捕获到的第一个错误。
 *
 * 必须 await：脚本里 recordFromDom() 之后走的是 800ms 防抖落盘，
 * 同步断言时 localStorage 还是空的（第一版就误判成「一条都没写」）。
 * 这里把 setTimeout 夹到 5ms，然后等 40ms 让它跑完。
 */
async function runClient({ pathname, nativeToc } = {}) {
  const code = clientCode();
  const env = makeEnv({ pathname, nativeToc });
  const errors = [];
  // vm 里抛出的 ReferenceError 会直接冒出来 —— 这正是我们要抓的
  const ctx = vm.createContext(env.win);
  try {
    vm.runInContext(code, ctx, { timeout: 5000, filename: 'pocket-turn-nav.js' });
  } catch (e) {
    errors.push(e);
  }
  await new Promise((r) => setTimeout(r, 40));
  return { errors, env, ctx, code };
}

/** 递归收集节点上的文字：textContent + innerHTML（假 DOM 不解析 innerHTML） */
function textOf(node, out = []) {
  if (!node) return out;
  if (node.textContent) out.push(String(node.textContent));
  if (node.innerHTML) out.push(String(node.innerHTML));
  for (const c of node.children || []) textOf(c, out);
  return out;
}

// ---------------------------------------------------------------- 测试

test('注入脚本：整段代码必须能在最小 DOM 环境里无异常跑完', async () => {
  // 这是本文件存在的**唯一理由**。v1.6.12 的 SESSION_PATH_RE 就是在这里
  // 被抓到的：语法检查通过、改名检查通过，但一跑就 ReferenceError。
  const { errors } = await runClient();
  assert.deepEqual(
    errors.map((e) => `${e.name}: ${e.message}`),
    [],
    '注入脚本在浏览器环境里抛异常了 —— 胶囊会完全不出现',
  );
});

test('注入脚本：自由变量检查（模块级标识符不能漏进注入代码）', () => {
  const code = clientCode();

  // 这些是模块里定义、但**没有**被注入到浏览器的东西。
  // 注入代码里只要出现它们（且不是属性访问），运行时就是 ReferenceError。
  const moduleOnly = [
    'SESSION_PATH_RE',
    'TOC_SCRIPT_ID',
    'TOC_MARKER',
    'MAX_HTML_BYTES',
    'MAX_TITLE_CHARS',
    'CLIENT_RENAMES',
    'CLIENT_HELPERS',
    'CLIENT_JS',
  ];
  // 去掉注释和字符串，避免注释里的说明文字误报
  const stripped = code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => { const i = l.indexOf('//'); return i >= 0 ? l.slice(0, i) : l; })
    .join('\n')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');

  for (const name of moduleOnly) {
    const re = new RegExp('(^|[^.\\w$])' + name + '(?![\\w$])');
    assert.ok(
      !re.test(stripped),
      `注入代码里引用了模块级标识符 ${name} —— 浏览器里没有它，会 ReferenceError`,
    );
  }
});

test('注入脚本：三条真实轮次 → 胶囊真的被建出来并亮起', async () => {
  const { errors, env } = await runClient();
  assert.deepEqual(errors.map((e) => e.message), []);

  // 胶囊的根节点必须在 body 上
  const root = env.body.children.find((c) => c._attrs && c._attrs.id && String(c._attrs.id).includes('pocket-turn-nav'));
  assert.ok(root, '胶囊根节点没有被挂到 body 上');

  // 按钮文案必须是「历史节点」
  // 注意：假 DOM 不解析 innerHTML，所以文案要从 innerHTML 字符串里找。
  const texts = textOf(root);
  assert.ok(
    texts.some((t) => t.includes('历史节点')),
    '胶囊文案里没有「历史节点」，实际：' + JSON.stringify(texts.slice(0, 10)),
  );

  // 3 条真实轮次 > 1，够多；且已经渲染过 → 应该亮起（class 里有 on）
  assert.ok(
    root.classList.contains('on'),
    '有三条真实轮次，胶囊却没有亮起（class="' + root.className + '"）',
  );

  // 位置必须算出来（不是默认的 0/undefined）
  assert.ok(root.style.top && root.style.top !== 'auto', '胶囊没有算出 top：' + root.style.top);
  assert.ok(root.style.right, '胶囊没有算出 right：' + root.style.right);
});

test('注入脚本：没有消息时不亮（防止空会话里挂个空胶囊）', async () => {
  const code = clientCode();
  const env = makeEnv({ pathname: '/' });
  env.bubbles.length = 0;
  env.win.document.querySelectorAll = (sel) => (sel === '.u-bub[data-turn-id]' ? [] : []);
  const ctx = vm.createContext(env.win);
  vm.runInContext(code, ctx, { timeout: 5000, filename: 'pocket-turn-nav.js' });
  await new Promise((r) => setTimeout(r, 40));

  const root = env.body.children.find((c) => c._attrs && c._attrs.id && String(c._attrs.id).includes('pocket-turn-nav'));
  assert.ok(root, '根节点应该建出来（只是不亮）');
  assert.equal(root.classList.contains('on'), false, '空会话里胶囊不该亮');
});

test('注入脚本：写进 localStorage 的 key 是 s:<id>，不是裸 pathname', async () => {
  const { errors, env } = await runClient({ pathname: '/sessions/session_test-0001' });
  assert.deepEqual(errors.map((e) => e.message), []);

  const keys = [...env.store.keys()];
  assert.ok(keys.length > 0, '一条记录都没写进 localStorage');
  assert.ok(
    keys.every((k) => k.startsWith('kimi-pocket.toc.s:session_test-0001')),
    '缓存 key 形态不对：' + JSON.stringify(keys),
  );
});

// ---- 响应式可见性：折叠屏 / iPad / 阔直板 --------------------------------
//
// 用户报的：「折叠屏会不会显示出来？我怕你只限制在直屏机上了，
// 没有兼顾 iPad、折叠机、阔直板」—— 这个担心是对的，实测确实有 bug。
//
// Desktop 的 ConversationToc 判定是
//     g = 父容器右边界 - 目录左边界 - 12
//     g >= 160 ? 显示 : 加 .toc-clipped → visibility:hidden
// 但它在**任何宽度下都留在 DOM 里**。而 offsetParent 对 visibility:hidden
// 的元素依然非 null（visibility 不参与布局）。所以早先的
//     nativeVisible = native.offsetParent !== null
// 在 700~1280px 恒为 true：胶囊躲起来，桌面目录却看不见 —— 两边全空。
// 这几条用例就是钉住这个区间。

/** 取胶囊根节点 */
function rootOf(env) {
  return env.body.children.find((c) => c._attrs && c._attrs.id && String(c._attrs.id).includes('pocket-turn-nav'));
}

test('响应式：手机直屏（桌面目录不存在）→ 胶囊显示', async () => {
  const { errors, env } = await runClient({ nativeToc: null });
  assert.deepEqual(errors.map((e) => e.message), []);
  assert.ok(rootOf(env).classList.contains('on'), '手机窄屏下胶囊必须显示');
});

test('响应式：折叠屏展开 / iPad（桌面目录在 DOM 里但 visibility:hidden）→ 胶囊必须显示', async () => {
  // 这是线上真实踩到的场景：元素存在、offsetParent 非 null、但用户看不见
  const { errors, env } = await runClient({
    nativeToc: { visibility: 'hidden', width: 13, height: 59 },
  });
  assert.deepEqual(errors.map((e) => e.message), []);
  assert.ok(
    rootOf(env).classList.contains('on'),
    '桌面目录 visibility:hidden 时胶囊仍然躲起来了 —— 折叠屏/iPad 上会两边都看不见',
  );
});

test('响应式：桌面目录真的可见 → 胶囊让位（不重复显示）', async () => {
  const { errors, env } = await runClient({
    nativeToc: { visibility: 'visible', width: 13, height: 59 },
  });
  assert.deepEqual(errors.map((e) => e.message), []);
  assert.equal(
    rootOf(env).classList.contains('on'),
    false,
    '桌面目录可见时胶囊不该抢位置',
  );
});

test('响应式：桌面目录尺寸为 0 → 视为不可见，胶囊显示', async () => {
  const { errors, env } = await runClient({
    nativeToc: { visibility: 'visible', width: 0, height: 0 },
  });
  assert.deepEqual(errors.map((e) => e.message), []);
  assert.ok(rootOf(env).classList.contains('on'), '零尺寸的目录不算可见，胶囊要显示');
});

test('sessionIdFromPath：模块侧与注入侧行为一致', () => {
  // 注入侧靠 runClient 覆盖；这里守模块侧的边界，两边实现是同一份源码
  assert.equal(sessionIdFromPath('/sessions/abc'), 'abc');
  assert.equal(sessionIdFromPath('/sessions/a%20b'), 'a b');
  assert.equal(sessionIdFromPath('/'), '');
  assert.equal(sessionIdFromPath('/sessions/'), '');
  assert.equal(sessionIdFromPath('/sessions/a/children'), '');
  assert.equal(sessionIdFromPath('/sessions/%E0%A4%A'), '', '非法百分号编码必须吞掉，不能抛');
});
