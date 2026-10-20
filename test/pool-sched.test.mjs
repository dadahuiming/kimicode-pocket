/**
 * worker 池调度器（lib/pool.mjs）的回归测试。
 *
 * 为什么必须单独测这个文件：
 * 调度器里所有保命逻辑走的都是**异常时序** —— 超时、迟到、自杀。
 * 真实图片处理几乎不会超过 20 秒，所以端到端测试永远走不到这些分支。
 * 实测证据：把 `msg.id !== job.id` 这行删掉，端到端测试（test/pool.test.mjs）
 * 照样全绿 —— 那种测试保护不了这个缺陷。
 *
 * 这里通过注入「可控时序」的假 worker，直接跑**生产代码**，
 * 精确复现每个异常时序。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createPool } from '../src/lib/pool.mjs';

/**
 * 可控时序的假 worker。
 * delays: { url: 毫秒 }，决定该任务多久后回消息。
 */
function fakeWorker(delays = {}, { onPost } = {}) {
  const w = new EventEmitter();
  w.__current = null;
  w.terminated = false;
  w.refCount = 0;
  /** 所有未触发的定时器，terminate 与测试收尾时要清掉 */
  const timers = new Set();
  w.postMessage = (m) => {
    onPost?.(m);
    const d = delays[m.url] ?? 5;
    // 注意 unref：否则「60 秒不回消息」这种测试会把进程拖住到定时器到点，
    // 表现为整份测试文件跑 60+ 秒（实测 61.7s，而各用例合计只有 2.3s）。
    const t = setTimeout(() => {
      timers.delete(t);
      if (w.terminated) return; // 已销毁的 worker 不再发消息
      w.emit('message', { id: m.id, ok: true, res: { which: m.url, forId: m.id } });
    }, d);
    t.unref?.();
    timers.add(t);
  };
  w.terminate = () => {
    if (w.terminated) return;
    w.terminated = true;
    for (const t of timers) clearTimeout(t);
    timers.clear();
    // 真实 Worker.terminate() 会触发 exit
    setTimeout(() => w.emit('exit', 0), 0).unref?.();
    return Promise.resolve();
  };
  w.ref = () => { w.refCount += 1; };
  w.unref = () => { w.refCount -= 1; };
  /** 测试收尾：清掉所有挂着的定时器 */
  w.dispose = () => {
    w.terminated = true;
    for (const t of timers) clearTimeout(t);
    timers.clear();
  };
  return w;
}

// ---------------------------------------------------------------- 错投

test('错投：任务在等时收到 id 不匹配的消息，必须丢弃', async () => {
  // 这是 id 校验**唯一**要挡的东西，也是最直接的验证方式：
  // 任务 A 正在等结果，此时来了一条 id 对不上的消息。
  //
  // 为什么不用「超时 + 迟到」来测：超时分支现在会把 worker 销毁，
  // 迟到消息根本不会到达，测出来是假绿（我第一版就是这样，
  // 变异测试里删掉 id 校验照样通过）。这里直接把消息喂进去，
  // 时序完全确定，跑的就是生产代码。
  let w;
  const pool = createPool({
    spawnWorker: () => {
      w = fakeWorker({ never: 60_000 }); // 自己不会回
      return w;
    },
    poolSize: 1,
    timeoutMs: 60_000,
  });

  let settled = null;
  const p = pool.submit('never').then((v) => {
    settled = v;
    return v;
  });

  // 等任务派出去
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(pool.stats().busy, 1, '任务应该在跑');

  // 喂一条 id 对不上的过期消息
  w.emit('message', { id: 999, ok: true, res: { which: 'STALE' } });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(settled, null, 'id 不匹配的消息把任务 resolve 了 —— id 校验失效');

  // 再喂正确的 id（任务 id 是 1，因为这是池里第一个任务）
  w.emit('message', { id: 1, ok: true, res: { which: 'never', forId: 1 } });
  const r = await p;
  assert.equal(r.ok, true);
  assert.equal(r.res.which, 'never', '正确的消息应该被正常投递');

  await pool.shutdown();
});

test('错投：超时后迟到的结果不会被投给下一个任务', async () => {
  // 端到端带一点运气的版本：worker 不真销毁，让迟到消息仍能到达。
  // 断言的是「B 绝不拿到 A 的载荷」这个不变量。
  const made = [];
  const pool = createPool({
    spawnWorker: () => {
      const wk = fakeWorker({ slow: 1200, med: 400 });
      wk.terminate = () => Promise.resolve(); // 模拟消息已在队列里的竞态
      made.push(wk);
      return wk;
    },
    poolSize: 1,
    timeoutMs: 700,
  });

  const a = await pool.submit('slow');
  assert.equal(a.error, 'timeout', 'A 必须超时');

  const b = await pool.submit('med');
  assert.notEqual(b.res?.which, 'slow', 'B 拿到了 A 的结果 —— 错投缺陷回归了');
  assert.notEqual(b.id, 1, 'B 收到了 A 的消息 —— id 校验失效了');
  if (b.ok) assert.equal(b.res.which, 'med');

  await pool.shutdown();
});

test('错投：超时时必须销毁 worker，不能只清指针', async () => {
  // 这是上一条的**机制**验证：如果超时后 worker 还被复用，
  // 它那次没算完的计算会继续跑并占用时间；更糟的是它已经证明
  // 20 秒算不完一张图，继续用只会继续超时。
  const made = [];
  const pool = createPool({
    spawnWorker: () => {
      const w = fakeWorker({ slow: 5000 });
      made.push(w);
      return w;
    },
    poolSize: 1,
    timeoutMs: 300,
  });

  const a = await pool.submit('slow');
  assert.equal(a.error, 'timeout');
  // 超时后第一个 worker 必须已被 terminate
  assert.equal(made[0].terminated, true, '超时后 worker 没有被销毁 —— 会继续超时');
  await pool.shutdown();
});

// ---------------------------------------------------------------- 退出回收

test('退出回收：worker exit(0) 也必须回收 slot（否则每张图白等 20 秒）', async () => {
  // 线上必然触发：image-worker.mjs 的 idleTimer 空闲 30 秒就 process.exit(0)。
  // 旧代码 `if (code !== 0 && worker.__current) fail(...)` 对 code 0 什么都不做，
  // slot 留在 pool 里但线程已经没了；往死 worker postMessage **不会抛错**（实测），
  // 消息石沉大海 —— 任务只能等满 20s 超时再降级。
  // 实测旧版本：20007 / 20006 / 20012ms。
  const made = [];
  const pool = createPool({
    spawnWorker: () => {
      const w = fakeWorker({ x: 50 });
      made.push(w);
      return w;
    },
    poolSize: 2,
    timeoutMs: 60_000, // 故意设很大：如果靠超时兜底就会卡住
  });

  // 先跑一个任务让池建起来
  const first = await pool.submit('x');
  assert.equal(first.ok, true);
  assert.ok(pool.stats().poolSize > 0);

  // 模拟 idle 自杀：所有 worker 自己 exit(0)
  for (const w of made) w.emit('exit', 0);
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(pool.stats().poolSize, 0, 'exit 后必须回收 slot（残留即僵尸）');

  // 池被回收后，新任务应该立刻重建 worker 并快速完成，
  // 而不是等满 timeoutMs（这里 60 秒，会明显超时）
  const t0 = Date.now();
  const again = await pool.submit('x');
  const ms = Date.now() - t0;
  assert.equal(again.ok, true, '池重建后应该能正常出结果');
  assert.ok(ms < 2000, `重建后应该很快（${ms}ms），僵尸 slot 会拖到 timeout`);

  await pool.shutdown();
});

test('退出回收：持任务时退出，任务必须被 resolve 而不是永久挂起', async () => {
  // 关键：如果 exit 时不 resolve 当前 job，那个 Promise 永远不 settle，
  // 上层 await 卡死，整条请求链挂住。
  const made = [];
  const pool = createPool({
    spawnWorker: () => {
      const w = fakeWorker({ hang: 60_000 });
      made.push(w);
      return w;
    },
    poolSize: 1,
    timeoutMs: 60_000,
  });

  const p = pool.submit('hang');
  // 等任务真的派出去
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(pool.stats().busy, 1, '任务应该在跑');

  // worker 突然死掉
  made[0].emit('exit', 1);

  const r = await Promise.race([
    p,
    new Promise((res) => setTimeout(() => res({ TIMEOUT: true }), 1000)),
  ]);
  assert.equal(r.TIMEOUT, undefined, '任务在 worker 死后永久挂起了 —— 必须 resolve 成失败');
  assert.equal(r.ok, false, 'worker 死了，任务应该 resolve 成失败让上层降级');

  await pool.shutdown();
});

// ---------------------------------------------------------------- 安全

test('安全：fail() 不会因 terminate → exit 递归', async () => {
  // terminate() 会触发 exit 事件，exit 又调 fail()。
  // 必须有 slot.dead 挡住第二次，否则无限递归 / 重复 resolve。
  let failCount = 0;
  const made = [];
  const pool = createPool({
    spawnWorker: () => {
      const w = fakeWorker({ x: 5000 });
      made.push(w);
      // 每次 emit exit 都计数，用来观察是否被重复处理
      const origEmit = w.emit.bind(w);
      w.emit = (ev, ...args) => {
        if (ev === 'exit') failCount += 1;
        return origEmit(ev, ...args);
      };
      return w;
    },
    poolSize: 1,
    timeoutMs: 200,
  });

  const a = await pool.submit('x');
  assert.equal(a.error, 'timeout');
  // 让 terminate 排的 exit 事件跑完
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(pool.stats().poolSize, 0, '超时后池应该被清空（等下一个任务重建）');

  // 再跑一个，确认没有残留状态把池搞坏
  const b = await pool.submit('x');
  assert.ok(b, '池应该还能工作');
  await pool.shutdown();
});

test('安全：池不会超过上限', async () => {
  const pool = createPool({
    spawnWorker: () => fakeWorker({ x: 10 }),
    poolSize: 2,
    timeoutMs: 5000,
  });
  await Promise.all(Array.from({ length: 10 }, () => pool.submit('x')));
  assert.ok(pool.stats().poolSize <= 2, `池超上限了：${pool.stats().poolSize}`);
  await pool.shutdown();
});

test('安全：shutdown 之后池为空，且能重新提交', async () => {
  const pool = createPool({
    spawnWorker: () => fakeWorker({ x: 10 }),
    poolSize: 2,
    timeoutMs: 5000,
  });
  await pool.submit('x');
  assert.ok(pool.stats().poolSize > 0);
  await pool.shutdown();
  assert.equal(pool.stats().poolSize, 0);
  // 重新提交应能重建
  const r = await pool.submit('x');
  assert.equal(r.ok, true, 'shutdown 后应该还能用');
  await pool.shutdown();
});

test('安全：shutdown 时排队中的任务必须 settle，不能永久挂起', async () => {
  // 这些 promise 已经通过 submit() 返回给调用方了。
  // 如果 shutdown 只是 queue.length = 0，调用方的 await 永远不返回 ——
  // 在测试里表现为整个进程挂住，在生产里表现为请求一直转圈。
  let posted = 0;
  const pool = createPool({
    spawnWorker: () => fakeWorker({ x: 10 }, { onPost: () => { posted += 1; } }),
    poolSize: 1,          // 只有 1 个并发位
    timeoutMs: 60_000,    // 故意设大：不能靠超时兜底
  });

  // 塞 5 个任务，只有第 1 个能立刻跑，其余 4 个排队
  const all = Array.from({ length: 5 }, () => pool.submit('x'));
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(pool.stats().queued > 0, '应该有任务在排队');

  await pool.shutdown();

  const results = await Promise.race([
    Promise.all(all),
    new Promise((res) => setTimeout(() => res('TIMEOUT'), 1000)),
  ]);
  assert.notEqual(results, 'TIMEOUT', 'shutdown 后排队任务永久挂起了');
  for (const r of results) {
    assert.ok(r, '每个任务都必须 settle');
    assert.equal(r.ok, false, 'shutdown 应该让任务失败，好让上层降级');
  }
});
