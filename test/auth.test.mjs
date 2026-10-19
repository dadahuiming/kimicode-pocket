import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  constantTimeEqual,
  newSessionToken,
  verifySessionToken,
  parseCookies,
  FailureLimiter,
  RateLimiter,
} from '../src/lib/auth.mjs';

test('会话令牌可以自校验', () => {
  const token = newSessionToken('longenough');
  assert.equal(verifySessionToken('longenough', token), true);
});

test('换个口令就验不过（换 PIN 即全端下线）', () => {
  const token = newSessionToken('longenough');
  assert.equal(verifySessionToken('different1', token), false);
});

test('令牌被篡改则验不过', () => {
  const token = newSessionToken('longenough');
  const tampered = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`;
  assert.equal(verifySessionToken('longenough', tampered), false);
  assert.equal(verifySessionToken('longenough', 'garbage'), false);
  assert.equal(verifySessionToken('longenough', ''), false);
  assert.equal(verifySessionToken('longenough', null), false);
});

test('每次生成的 nonce 不同（同一 PIN 也不应固定）', () => {
  assert.notEqual(newSessionToken('longenough'), newSessionToken('longenough'));
});

test('constantTimeEqual 长度不同直接 false', () => {
  assert.equal(constantTimeEqual('abc', 'abc'), true);
  assert.equal(constantTimeEqual('abc', 'abcd'), false);
  assert.equal(constantTimeEqual('', ''), true);
});

test('parseCookies 容错', () => {
  assert.deepEqual(parseCookies('a=1; b=2'), { a: '1', b: '2' });
  assert.deepEqual(parseCookies(''), {});
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies('novalue; x=y'), { x: 'y' });
  assert.equal(parseCookies('t=abc%2Edef').t, 'abc.def');
});

test('FailureLimiter：5 次失败后锁定，60 秒后自动解锁', () => {
  let clock = 0;
  const lim = new FailureLimiter({ max: 5, windowMs: 60_000, now: () => clock });

  for (let i = 1; i <= 4; i++) {
    lim.recordFailure('1.2.3.4');
    assert.equal(lim.isLocked('1.2.3.4'), false, `第 ${i} 次不应锁定`);
  }
  lim.recordFailure('1.2.3.4');
  assert.equal(lim.isLocked('1.2.3.4'), true);
  assert.ok(lim.retryAfterMs('1.2.3.4') > 0);

  clock = 61_000;
  assert.equal(lim.isLocked('1.2.3.4'), false);
  assert.equal(lim.retryAfterMs('1.2.3.4'), 0);
});

test('FailureLimiter：不同 IP 互不影响，clear 立即解锁', () => {
  const lim = new FailureLimiter({ max: 2, windowMs: 60_000, now: () => 1000 });
  lim.recordFailure('a');
  lim.recordFailure('a');
  assert.equal(lim.isLocked('a'), true);
  assert.equal(lim.isLocked('b'), false);

  lim.clear('a');
  assert.equal(lim.isLocked('a'), false);
});

test('RateLimiter：达到上限后拒绝，跨分钟重置', () => {
  let clock = 0;
  const rl = new RateLimiter({ perMinute: 3, now: () => clock });

  assert.equal(rl.hit('ip').allowed, true);
  assert.equal(rl.hit('ip').allowed, true);
  assert.equal(rl.hit('ip').allowed, true);
  const blocked = rl.hit('ip');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);

  clock = 60_000;
  assert.equal(rl.hit('ip').allowed, true);
});

test('RateLimiter：perMinute<=0 表示关闭', () => {
  const rl = new RateLimiter({ perMinute: 0 });
  for (let i = 0; i < 100; i++) assert.equal(rl.hit('ip').allowed, true);
});

test('RateLimiter.sweep 清掉过期桶', () => {
  let clock = 0;
  const rl = new RateLimiter({ perMinute: 10, now: () => clock });
  rl.hit('a');
  rl.hit('b');
  clock = 120_000;
  rl.sweep();
  assert.equal(rl.map.size, 0);
});
