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

// ---- 回归：v1.6.12 修掉的几个会导致「整站掉线」的缺陷 ----------------------

test('畸形 Cookie 不能让解析抛错（否则一个请求就能打挂整个代理）', () => {
  // 真实复现：`Cookie: pocket_session=%E0%A4%A` 会让 decodeURIComponent
  // 抛 URIError；这个调用发生在 async 请求处理器里，异常变成未处理的
  // Promise rejection，Node 默认直接 process.exit(1)。
  // 任何人都能发这一个请求 —— 也就是零成本远程 DoS。
  assert.doesNotThrow(() => parseCookies('pocket_session=%E0%A4%A'));
  assert.deepEqual(parseCookies('pocket_session=%E0%A4%A'), {});
});

test('畸形 Cookie 只跳过坏的那个，好 Cookie 照常解析', () => {
  const c = parseCookies('good=1; bad=%E0%A4%A; also=2');
  assert.equal(c.good, '1');
  assert.equal(c.also, '2');
  assert.equal('bad' in c, false);
});

test('正常的百分号编码 Cookie 仍然会被解码', () => {
  assert.equal(parseCookies('a=%E4%BD%A0%E5%A5%BD').a, '你好');
});

test('FailureLimiter 会清理过期记录（否则配伪造 IP 会无限涨）', () => {
  let clock = 0;
  const fl = new FailureLimiter({ max: 5, windowMs: 60_000, now: () => clock });
  for (let i = 0; i < 50; i += 1) fl.recordFailure(`1.2.3.${i}`);
  assert.equal(fl.map.size, 50);
  clock = 120_000;
  fl.sweep();
  assert.equal(fl.map.size, 0);
});

test('FailureLimiter.sweep 不会误删仍在锁定中的记录', () => {
  let clock = 0;
  const fl = new FailureLimiter({ max: 5, windowMs: 60_000, now: () => clock });
  fl.recordFailure('x');
  clock = 30_000;
  fl.sweep();
  assert.equal(fl.map.size, 1, '尚未过期，必须保留');
});
