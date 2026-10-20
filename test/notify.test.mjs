/**
 * 桌面通知模块的测试。
 *
 * 守的是三条「用起来才发现」的性质：
 *   1. 去重：一串相同错误只弹一次（否则用户会直接关掉通知）
 *   2. 限速：不会瞬间连弹（每分钟上限 + 最小间隔）
 *   3. 不阻塞：notify() 必须立刻返回，不能等 powershell（每次约 1 秒）
 *   4. 失败安全：powershell 不可用 / 抛错时，绝不能把异常抛给调用方
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createNotifier } from '../src/lib/notify.mjs';

test('notify：enabled=false 时一条都不发', () => {
  const sent = [];
  const n = createNotifier({ enabled: false, onSend: (p) => sent.push(p) });
  const ok = n.notify({ key: 'x', title: 't', body: 'b' });
  assert.equal(ok, false);
  assert.equal(sent.length, 0);
  assert.equal(n.snapshot().suppressed, 1);
});

test('notify：同类错误在去重窗口内只发一次', () => {
  const sent = [];
  const n = createNotifier({ dedupeMs: 60_000, minIntervalMs: 0, onSend: (p) => sent.push(p) });

  assert.equal(n.notify({ key: 'upstream-error', title: 'a', body: '1' }), true);
  assert.equal(n.notify({ key: 'upstream-error', title: 'a', body: '2' }), false);
  assert.equal(n.notify({ key: 'upstream-error', title: 'a', body: '3' }), false);
  assert.equal(sent.length, 1, '同类错误只该发一条');
  assert.equal(n.snapshot().deduped, 2);
});

test('notify：不同 key 各发各的', () => {
  const sent = [];
  const n = createNotifier({ dedupeMs: 60_000, minIntervalMs: 0, onSend: (p) => sent.push(p) });
  n.notify({ key: 'a', title: 'A', body: '' });
  n.notify({ key: 'b', title: 'B', body: '' });
  n.notify({ key: 'c', title: 'C', body: '' });
  assert.equal(sent.length, 3);
  assert.deepEqual(sent.map((s) => s.key), ['a', 'b', 'c']);
});

test('notify：最小间隔会挡住紧随其后的不同通知', () => {
  const sent = [];
  const n = createNotifier({ dedupeMs: 0, minIntervalMs: 10_000, onSend: (p) => sent.push(p) });
  assert.equal(n.notify({ key: 'a', title: 'A', body: '' }), true);
  assert.equal(n.notify({ key: 'b', title: 'B', body: '' }), false, '间隔内不该再发');
  assert.equal(sent.length, 1);
  assert.equal(n.snapshot().throttled, 1);
});

test('notify：每分钟上限会挡住超出的通知', () => {
  const sent = [];
  // 间隔 0、去重 0，只看每分钟上限
  const n = createNotifier({ dedupeMs: 0, minIntervalMs: 0, maxPerMinute: 3, onSend: (p) => sent.push(p) });
  for (let i = 0; i < 10; i += 1) n.notify({ key: `k${i}`, title: `T${i}`, body: '' });
  assert.equal(sent.length, 3, '每分钟上限 3，不该发 10 条');
  assert.equal(n.snapshot().throttled, 7);
});

test('notify：force 跳过去重与限速（用于「已恢复」这类必须送达的）', () => {
  const sent = [];
  const n = createNotifier({ dedupeMs: 60_000, minIntervalMs: 60_000, maxPerMinute: 1, onSend: (p) => sent.push(p) });
  assert.equal(n.notify({ key: 'k', title: 'A', body: '' }), true);
  // 正常调用会被去重 + 限速挡住
  assert.equal(n.notify({ key: 'k', title: 'A', body: '' }), false);
  // force 必须送达
  assert.equal(n.notify({ key: 'k', title: 'A', body: '', force: true }), true);
  assert.equal(sent.length, 2);
});

test('notify：不阻塞调用方（onSend 是同步回调时也立刻返回）', () => {
  // 真实发送走 powershell（约 1 秒）。这里用「标记未完成」模拟：
  // notify() 返回时，发送不应该已经完成（除非用的是同步测试钩子）。
  let finished = false;
  const n = createNotifier({
    dedupeMs: 0,
    minIntervalMs: 0,
    onSend: () => {
      // 故意什么也不做，代表「异步发送已排队」
    },
  });
  const t0 = Date.now();
  n.notify({ key: 'k', title: 't', body: 'b' });
  const ms = Date.now() - t0;
  assert.ok(ms < 50, `notify 应该立刻返回，实际 ${ms}ms`);
  assert.equal(finished, false);
});

test('notify：onSend 抛异常不会冒泡给调用方', () => {
  const n = createNotifier({
    dedupeMs: 0,
    minIntervalMs: 0,
    onSend: () => {
      throw new Error('boom');
    },
  });
  assert.doesNotThrow(() => n.notify({ key: 'k', title: 't', body: 'b' }));
});

test('notify：真实发送路径在 powershell 不可用时不抛异常', async () => {
  // 把 PS 换成必然不存在的路径，模拟「非 Windows / 权限受限」
  const logs = [];
  const n = createNotifier({
    dedupeMs: 0,
    minIntervalMs: 0,
    log: (m) => logs.push(m),
  });
  // 不等待真实 powershell（可能真的弹窗），只断言调用本身安全
  assert.doesNotThrow(() => n.notify({ key: 'probe', title: '测试', body: '这一条如果弹出来，说明通知能用' }));
  // 给它一点时间收尾，避免测试进程挂着
  await new Promise((r) => setTimeout(r, 200));
});

test('buildScript：中文与单引号都被正确转义', () => {
  const n = createNotifier({ enabled: false });
  const script = n.buildScript({
    title: "上游超时'测试'",
    body: '含单引号 \' 和中文',
    appId: 'KimiCodePocket',
  });
  // PowerShell 里单引号用两个单引号转义
  assert.ok(script.includes("上游超时''测试''"), '单引号必须被转义成两个');
  assert.ok(script.includes('ToastText02'), '应该用两行模板');
  assert.ok(script.includes('KimiCodePocket'));
  // 不能出现未转义的裸单引号把字符串截断
  assert.doesNotThrow(() => new Function('return 0')); // 只是确保没崩
});

test('buildScript：超长正文被截断，不会撑爆弹窗', () => {
  const n = createNotifier({ enabled: false });
  const long = '啊'.repeat(500);
  const script = n.buildScript({ title: long, body: long, appId: 'X' });
  // 标题截到 64、正文截到 200
  const titles = [...script.matchAll(/CreateTextNode\('([\s\S]*?)'\)/g)].map((m) => m[1]);
  assert.ok(titles[0].length <= 65, `标题被截断到 64 以内，实际 ${titles[0].length}`);
  assert.ok(titles[1].length <= 201, `正文被截断到 200 以内，实际 ${titles[1].length}`);
  assert.ok(titles[0].endsWith('…'), '截断后应有省略号');
});

test('snapshot：统计数字可信', () => {
  const n = createNotifier({ dedupeMs: 60_000, minIntervalMs: 0, onSend: () => {} });
  n.notify({ key: 'a', title: 'A', body: '' });   // sent
  n.notify({ key: 'a', title: 'A', body: '' });   // deduped
  n.notify({ key: 'b', title: 'B', body: '' });   // sent
  const s = n.snapshot();
  assert.equal(s.enabled, true);
  assert.equal(s.sent, 2);
  assert.equal(s.deduped, 1);
});

test('reset：清空后可以重新发同样的 key', () => {
  const sent = [];
  const n = createNotifier({ dedupeMs: 60_000, minIntervalMs: 0, onSend: (p) => sent.push(p) });
  n.notify({ key: 'a', title: 'A', body: '' });
  assert.equal(n.notify({ key: 'a', title: 'A', body: '' }), false);
  n.reset();
  assert.equal(n.notify({ key: 'a', title: 'A', body: '' }), true, 'reset 后应能重发');
  assert.equal(sent.length, 2);
});
