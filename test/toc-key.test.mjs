/**
 * 会话缓存 key 的隔离测试（v1.6.12）。
 *
 * 这一组守的是一个用户能直接感知的 bug：「B 会话里出现 A 会话的历史节点」。
 *
 * 背景：缓存 key 早先直接取 location.pathname。对已存在的会话这是准确的
 * （路径就是 /sessions/session_<uuid>），但对「新建会话」不行 ——
 * Desktop 自己的路径构造是：
 *     id 为空  → "/"
 *     id 有值  → "/sessions/" + encodeURIComponent(id)
 * （核对过 bundle 里的 $he() / EU()）
 * 所以新建会话在拿到 id 之前路径都是 "/"，多个新会话共用一份缓存。
 *
 * 修法：路径能取到 id 就用 id（s:<id>）；取不到就用
 * 「路径 + 最小真实 turn id 指纹」（p:<path>#t0）区分；
 * 新会话拿到 id 后把过渡记录迁移过去。
 *
 * 测试直接打**模块级纯函数** —— 这几个函数同时被注入到浏览器脚本里
 * （见 toc.mjs 的 CLIENT_HELPERS），所以测它们等于测生产代码。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  sessionIdFromPath,
  sessionFingerprintFrom,
  sessionKeyFor,
  migrateKeyWith,
  isRealTurnIdForSession,
  injectTurnNav,
  TOC_SCRIPT_ID,
} from '../src/lib/toc.mjs';

// ---------------------------------------------------------------- 路径解析

test('路径解析：/sessions/<uuid> 取出 uuid', () => {
  assert.equal(
    sessionIdFromPath('/sessions/session_26eca3aa-181f-4e24-bc78-fdeb14d7f72a'),
    'session_26eca3aa-181f-4e24-bc78-fdeb14d7f72a',
  );
});

test('路径解析：百分号编码会被 decode', () => {
  assert.equal(sessionIdFromPath('/sessions/session%5Fabc'), 'session_abc');
});

test('路径解析：根路径取不到 id', () => {
  assert.equal(sessionIdFromPath('/'), '');
});

test('路径解析：带子路径不算会话页（/sessions/<id>/children）', () => {
  assert.equal(sessionIdFromPath('/sessions/abc/children'), '');
  assert.equal(sessionIdFromPath('/sessions/abc/export'), '');
});

test('路径解析：只有 /sessions/ 没有 id 取不到', () => {
  assert.equal(sessionIdFromPath('/sessions/'), '');
});

test('路径解析：非法编码不抛异常', () => {
  assert.doesNotThrow(() => sessionIdFromPath('/sessions/%E0%A4%A'));
  assert.equal(sessionIdFromPath('/sessions/%E0%A4%A'), '');
});

// ---------------------------------------------------------------- 指纹

test('指纹：取最小的真实 turn 号，不是最新的', () => {
  // 用户往下滚会加载更多历史，最新那条一直在变；最小那条（t0）是稳定的
  assert.equal(sessionFingerprintFrom(['t5', 't2', 't9']), 't2');
  assert.equal(sessionFingerprintFrom(['t0', 't1', 't2']), 't0');
});

test('指纹：乐观消息不参与（msg_opt_* 不是真实轮次）', () => {
  assert.equal(sessionFingerprintFrom(['msg_opt_abc_1', 't3']), 't3');
  assert.equal(sessionFingerprintFrom(['msg_opt_abc_1']), '');
});

test('指纹：空输入返回空串', () => {
  assert.equal(sessionFingerprintFrom([]), '');
  assert.equal(sessionFingerprintFrom(null), '');
  assert.equal(sessionFingerprintFrom(undefined), '');
});

test('指纹：只认 t<数字> 开头', () => {
  assert.equal(isRealTurnIdForSession('t0:input'), true);
  assert.equal(isRealTurnIdForSession('t8.41.f1'), true);
  assert.equal(isRealTurnIdForSession('t12'), true);
  assert.equal(isRealTurnIdForSession('msg_opt_x'), false);
  assert.equal(isRealTurnIdForSession('x-t0'), false);
  assert.equal(isRealTurnIdForSession(''), false);
});

// ---------------------------------------------------------------- key

test('key：/sessions/<uuid> → s:<uuid>', () => {
  const sid = 'session_26eca3aa-181f-4e24-bc78-fdeb14d7f72a';
  assert.equal(sessionKeyFor(`/sessions/${sid}`, []), `s:${sid}`);
});

test('key：两个不同会话必须得到不同 key（这是 bug 的核心）', () => {
  const a = 'session_aaaaaaaa-1111-2222-3333-444444444444';
  const b = 'session_bbbbbbbb-1111-2222-3333-444444444444';
  assert.notEqual(sessionKeyFor(`/sessions/${a}`, []), sessionKeyFor(`/sessions/${b}`, []));
});

test('key：根路径无消息 → p:/ （过渡态）', () => {
  const k = sessionKeyFor('/', []);
  assert.ok(k.startsWith('p:'), `应该是过渡态，实际 ${k}`);
  assert.ok(!k.startsWith('s:'));
});

test('key：根路径有消息 → 带指纹', () => {
  const k = sessionKeyFor('/', ['t5', 't2', 't9']);
  assert.ok(k.includes('#t2'), `指纹应该取最小 turn（t2），实际 ${k}`);
});

test('key：根路径 + 不同指纹 → 不同 key（区分两个新会话）', () => {
  const k1 = sessionKeyFor('/', ['t0']);
  const k2 = sessionKeyFor('/', ['t7']);
  assert.notEqual(k1, k2, '两个新会话指纹不同却共用 key');
});

test('key：s: 与 p: 前缀永不相撞', () => {
  // 万一某个会话 id 恰好叫 "p:/"，加前缀也不会串
  const k1 = sessionKeyFor('/sessions/p:/', []);
  const k2 = sessionKeyFor('/', []);
  assert.notEqual(k1, k2);
});

// ---------------------------------------------------------------- 迁移

function memStore(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    raw: m,
  };
}

const PAYLOAD = JSON.stringify({ v: 3, items: [{ id: 't0', title: 'x', y: 0, pos: 1, size: 1 }], h: 100 });

test('迁移：过渡态记录会搬到精确 key，且旧 key 被清掉', () => {
  const s = memStore({ 'p:/#t0': PAYLOAD });
  const moved = migrateKeyWith('p:/#t0', 's:session_x', s);
  assert.equal(moved, true, '应该发生迁移');
  assert.equal(s.raw.get('s:session_x'), PAYLOAD, '目标 key 应该有数据');
  assert.equal(s.raw.has('p:/#t0'), false, '旧 key 应该被清掉');
});

test('迁移：目标已有自己的记录时绝不覆盖', () => {
  const MINE = JSON.stringify({ v: 3, items: [{ id: 't9', title: 'mine', y: 0, pos: 1, size: 1 }], h: 50 });
  const s = memStore({ 's:session_x': MINE, 'p:/#t0': PAYLOAD });
  const moved = migrateKeyWith('p:/#t0', 's:session_x', s);
  assert.equal(moved, false, '目标已有记录，不该迁移');
  assert.equal(s.raw.get('s:session_x'), MINE, '自己的记录被覆盖了 —— 严重数据错误');
});

test('迁移：只允许 过渡态 → 精确态', () => {
  const s = memStore({ 's:aaa': PAYLOAD });
  // 精确 → 过渡：不允许
  assert.equal(migrateKeyWith('s:aaa', 'p:/#t0', s), false);
  // 精确 → 精确：不允许
  assert.equal(migrateKeyWith('s:aaa', 's:bbb', s), false);
  // 过渡 → 过渡：不允许
  assert.equal(migrateKeyWith('p:/', 'p:/#t0', s), false);
  // 源数据没被动过
  assert.equal(s.raw.get('s:aaa'), PAYLOAD);
});

test('迁移：源不存在时返回 false，不创建空记录', () => {
  const s = memStore();
  assert.equal(migrateKeyWith('p:/#t0', 's:session_x', s), false);
  assert.equal(s.raw.size, 0);
});

test('迁移：存取抛异常时安全返回 false', () => {
  const boom = {
    getItem() { throw new Error('boom'); },
    setItem() { throw new Error('boom'); },
    removeItem() { throw new Error('boom'); },
  };
  assert.doesNotThrow(() => migrateKeyWith('p:/#t0', 's:x', boom));
  assert.equal(migrateKeyWith('p:/#t0', 's:x', boom), false);
});

// ---------------------------------------------------------------- 注入一致性

test('注入：客户端脚本里真的有这几个函数（不是只写注释）', () => {
  const html = injectTurnNav('<!doctype html><html><body></body></html>');
  const open = `<script id="${TOC_SCRIPT_ID}">`;
  const i = html.indexOf(open);
  assert.ok(i > 0, '应该注入了脚本');
  const code = html.slice(i + open.length, html.indexOf('</script>', i));
  for (const name of ['fpFromIds', 'sidFromPath', 'keyFor', 'migrateWith', 'isRealTurnIdX']) {
    assert.ok(code.includes(`function ${name}(`), `客户端脚本缺少 ${name}`);
  }
  // 而且必须能解析
  assert.doesNotThrow(() => new Function(code));
});

// ---- 过渡态内部的指纹细化 ------------------------------------------------

test('迁移：p:/ → p:/#t0（新会话发出第一条消息，指纹出现）', () => {
  // 新会话刚打开时 DOM 里没有消息 → key 是 p:/；
  // 用户发出第一条消息后指纹变成 t0 → key 变成 p:/#t0。
  // 不做这条迁移，用户会在「刚发出第一条消息」的瞬间丢掉刚记下的东西。
  const s = memStore({ 'p:/': PAYLOAD });
  const moved = migrateKeyWith('p:/', 'p:/#t0', s);
  assert.equal(moved, true, '同一新会话内的指纹细化应该迁移');
  assert.equal(s.raw.get('p:/#t0'), PAYLOAD);
  assert.equal(s.raw.has('p:/'), false, '旧 key 应清掉');
});

test('迁移：不同路径的过渡态之间绝不迁移（会串会话）', () => {
  const s = memStore({ 'p:/': PAYLOAD });
  // 路径不同 → 不是同一个会话
  assert.equal(migrateKeyWith('p:/', 'p:/other#t0', s), false);
  assert.equal(migrateKeyWith('p:/foo', 'p:/bar#t0', s), false);
  assert.equal(s.raw.get('p:/'), PAYLOAD, '源数据不该被动');
});

test('迁移：指纹细化时目标已有记录则不覆盖', () => {
  const MINE = JSON.stringify({ v: 3, items: [{ id: 't9', title: 'mine', y: 0, pos: 1, size: 1 }], h: 50 });
  const s = memStore({ 'p:/#t0': MINE, 'p:/': PAYLOAD });
  assert.equal(migrateKeyWith('p:/', 'p:/#t0', s), false);
  assert.equal(s.raw.get('p:/#t0'), MINE);
});

// ---- 注入脚本的自洽性（防「改名只改了一半」）----------------------------

test('注入：函数改名必须连带函数体内部的调用一起改', () => {
  // 踩过的坑：只把 `function 旧名(` 改成 `function 新名(`，
  // 但函数体里还调着旧名（keyFor 里调 sessionIdFromPath()，
  // 而客户端只有 sidFromPath()）—— 整个脚本在第一次 syncSession 时
  // 抛 ReferenceError，胶囊直接不出现。而 new Function(code) 语法检查是通的，
  // 静态语法检查抓不到这种「名字不存在」的错误。
  const html = injectTurnNav('<!doctype html><html><body></body></html>');
  const open = `<script id="${TOC_SCRIPT_ID}">`;
  const i = html.indexOf(open);
  const raw = html.slice(i + open.length, html.indexOf('</script>', i));

  // 剥掉注释（注释里提到函数名是正常的）
  const code = raw
    .split('\n')
    .map((l) => {
      const idx = l.indexOf('//');
      return idx >= 0 ? l.slice(0, idx) : l;
    })
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  const mustExist = ['isRealTurnIdX', 'fpFromIds', 'sidFromPath', 'keyFor', 'migrateWith'];
  for (const n of mustExist) {
    assert.ok(code.includes(`function ${n}(`), `客户端脚本缺少 ${n}`);
  }

  // 模块级原名不能在客户端脚本里被**调用**
  const stale = ['isRealTurnIdForSession', 'sessionFingerprintFrom', 'sessionIdFromPath', 'sessionKeyFor', 'migrateKeyWith'];
  for (const n of stale) {
    // 用字符串拼接构造正则，避免转义层级混乱
    const re = new RegExp('(^|[^.\\w$])' + n + '\\s*\\(', 'm');
    assert.ok(!re.test(code), `客户端脚本仍在调用未定义的原名 ${n}()`);
  }
});
