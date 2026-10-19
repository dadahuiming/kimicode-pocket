/**
 * 配对状态回显的终端行为。
 *
 * 这几条对应真实踩过的坑：
 *   · 手机上已经配对成功，终端还在打「已失效」——状态从来没回传过
 *   · 非 TTY（管道 / 定时任务）被一段动画卡住
 *   · 多设备时不知道哪台配上了
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  watchPairProgress,
  PAIR_EXPIRED_TEXT,
  PAIR_SUCCESS_TEXT,
} from '../src/lib/pairwatch.mjs';

/** 收集输出，替代真实 stdout */
function sink() {
  return {
    buf: [],
    write(s) {
      this.buf.push(s);
      return true;
    },
    text() {
      return this.buf.join('');
    },
  };
}

test('非 TTY：只打一行失效时刻，立刻返回，不轮询', async () => {
  const out = sink();
  let polled = 0;
  const res = await watchPairProgress(['111111'], Date.now() + 10_000, {
    out,
    isTTY: false,
    poll: async () => {
      polled++;
      return { total: 1, redeemed: 0 };
    },
    tickMs: 5,
    pollMs: 5,
  });

  assert.equal(res.ok, false);
  assert.equal(res.skipped, true);
  assert.equal(polled, 0, '非 TTY 不该发起轮询');
  assert.match(out.text(), /链接于 \d{2}:\d{2}:\d{2} 失效/);
  assert.doesNotMatch(out.text(), /⏳/);
});

test('TTY：配对成功立即收尾，不再干等剩下的倒计时', async () => {
  const out = sink();
  const startedAt = Date.now();
  const res = await watchPairProgress(['222222'], Date.now() + 30_000, {
    out,
    isTTY: true,
    poll: async () => ({ total: 1, redeemed: 1 }),
    tickMs: 5,
    pollMs: 5,
  });

  assert.equal(res.ok, true);
  assert.equal(res.redeemed, 1);
  assert.ok(Date.now() - startedAt < 2_000, '应该立刻返回，而不是等 30 秒');
  assert.match(out.text(), new RegExp(PAIR_SUCCESS_TEXT));
  assert.doesNotMatch(out.text(), new RegExp(PAIR_EXPIRED_TEXT));
});

test('TTY：一直没人扫，到点报失效', async () => {
  const out = sink();
  const res = await watchPairProgress(['333333'], Date.now() + 40, {
    out,
    isTTY: true,
    poll: async () => ({ total: 1, redeemed: 0 }),
    tickMs: 5,
    pollMs: 5,
  });

  assert.equal(res.ok, false);
  assert.match(out.text(), new RegExp(PAIR_EXPIRED_TEXT));
  assert.doesNotMatch(out.text(), new RegExp(PAIR_SUCCESS_TEXT));
});

test('TTY：多设备部分成功时，过期文案带已配对数量', async () => {
  const out = sink();
  const res = await watchPairProgress(['444444', '555555'], Date.now() + 60, {
    out,
    isTTY: true,
    poll: async () => ({ total: 2, redeemed: 1 }),
    tickMs: 5,
    pollMs: 5,
  });

  assert.equal(res.ok, false);
  assert.equal(res.redeemed, 1);
  assert.match(out.text(), /已配对 1\/2/);
  // 已经配好一台，主体结论就不能再是"全部失效"
  assert.doesNotMatch(out.text(), new RegExp(PAIR_EXPIRED_TEXT));
});

test('TTY：多设备一个都没扫，到点报完整失效', async () => {
  const out = sink();
  const res = await watchPairProgress(['888888', '999999'], Date.now() + 40, {
    out,
    isTTY: true,
    poll: async () => ({ total: 2, redeemed: 0 }),
    tickMs: 5,
    pollMs: 5,
  });

  assert.equal(res.ok, false);
  assert.equal(res.redeemed, 0);
  assert.match(out.text(), new RegExp(PAIR_EXPIRED_TEXT));
});

test('TTY：状态查询失败不影响本地倒计时', async () => {
  const out = sink();
  const res = await watchPairProgress(['666666'], Date.now() + 40, {
    out,
    isTTY: true,
    poll: async () => {
      throw new Error('代理重启中');
    },
    tickMs: 5,
    pollMs: 5,
  });

  assert.equal(res.ok, false);
  assert.match(out.text(), new RegExp(PAIR_EXPIRED_TEXT));
});

test('TTY：没传 poll 时退化为纯倒计时，不会崩', async () => {
  const out = sink();
  const res = await watchPairProgress(['777777'], Date.now() + 40, {
    out,
    isTTY: true,
    tickMs: 5,
  });

  assert.equal(res.ok, false);
  assert.match(out.text(), new RegExp(PAIR_EXPIRED_TEXT));
});
