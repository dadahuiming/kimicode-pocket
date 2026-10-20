import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  rewriteHeaders,
  rewriteRawHeaders,
  isLoopbackAddr,
  isTunneledRequest,
  isLocalRequest,
  clientIp,
} from '../src/lib/rewrite.mjs';

test('Host 被改写为回环地址（带端口）', () => {
  const out = rewriteHeaders({ host: 'evil.example.com', accept: '*/*' }, 54321);
  assert.equal(out.host, '127.0.0.1:54321');
  assert.equal(out.accept, '*/*');
});

test('Origin 被改写而不是被删除', () => {
  const out = rewriteHeaders({ host: 'x', origin: 'https://evil.example.com' }, 5000);
  assert.equal(out.origin, 'http://127.0.0.1:5000');

  // 没有 Origin 时不应凭空加一个：Desktop 对「无 Origin」是放行的，
  // 加上反而可能改变语义。
  const noOrigin = rewriteHeaders({ host: 'x' }, 5000);
  assert.equal('origin' in noOrigin, false);
});

test('头名大小写不敏感（Origin / ORIGIN / origin 都要处理）', () => {
  assert.equal(rewriteHeaders({ Origin: 'https://a' }, 1).Origin, 'http://127.0.0.1:1');
  assert.equal(rewriteHeaders({ ORIGIN: 'https://a' }, 1).ORIGIN, 'http://127.0.0.1:1');
});

test('缺少 Host 时补一个', () => {
  const out = rewriteHeaders({ accept: '*/*' }, 7000);
  assert.equal(out.host, '127.0.0.1:7000');
});

test('不改动入参对象', () => {
  const input = { host: 'evil', origin: 'https://evil' };
  rewriteHeaders(input, 1);
  assert.equal(input.host, 'evil');
  assert.equal(input.origin, 'https://evil');
});

test('rawHeaders 重建：保持顺序、重复头、大小写，只换 Host/Origin', () => {
  const raw = [
    'Host', 'evil.example.com',
    'Upgrade', 'websocket',
    'Connection', 'Upgrade',
    'Sec-WebSocket-Key', 'dGhlIHNhbXBsZSBub25jZQ==',
    'Sec-WebSocket-Protocol', 'kimi-code.bearer.abc123',
    'Sec-WebSocket-Protocol', 'second.proto',
    'Origin', 'https://evil.example.com',
  ];
  const lines = rewriteRawHeaders(raw, 54321);

  assert.equal(lines[0], 'Host: 127.0.0.1:54321');
  assert.equal(lines[1], 'Upgrade: websocket');
  assert.ok(lines.includes('Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=='));
  assert.ok(lines.includes('Sec-WebSocket-Protocol: kimi-code.bearer.abc123'));
  // 重复头必须保留两条，不能被合并
  assert.equal(lines.filter((l) => l.startsWith('Sec-WebSocket-Protocol:')).length, 2);
  assert.ok(lines.includes('Origin: http://127.0.0.1:54321'));
});

test('rawHeaders 缺少 Host 时补一个', () => {
  const lines = rewriteRawHeaders(['Upgrade', 'websocket'], 8080);
  assert.ok(lines.includes('Host: 127.0.0.1:8080'));
  assert.ok(lines.includes('Upgrade: websocket'));
});

test('isLoopbackAddr 识别 IPv4 / IPv6 / IPv4-mapped', () => {
  assert.equal(isLoopbackAddr('127.0.0.1'), true);
  assert.equal(isLoopbackAddr('::1'), true);
  assert.equal(isLoopbackAddr('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddr('8.8.8.8'), false);
  assert.equal(isLoopbackAddr(undefined), false);
});

test('clientIp 优先取 CF-Connecting-IP，其次 X-Forwarded-For', () => {
  const base = { socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(
    clientIp({ ...base, headers: { 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '9.9.9.9' } }),
    '1.2.3.4',
  );
  assert.equal(clientIp({ ...base, headers: { 'x-forwarded-for': '9.9.9.9, 8.8.8.8' } }), '9.9.9.9');
  assert.equal(clientIp({ ...base, headers: {} }), '127.0.0.1');
});

test('isTunneledRequest：CF-Connecting-IP 或 CF-Ray 任一存在即为隧道来客', () => {
  assert.equal(isTunneledRequest({ headers: { 'cf-connecting-ip': '203.0.113.7' } }), true);
  assert.equal(isTunneledRequest({ headers: { 'cf-ray': '8a1b2c3d4e5f6a7b-HKG' } }), true);
  assert.equal(isTunneledRequest({ headers: {} }), false);
  assert.equal(isTunneledRequest({}), false);
  assert.equal(isTunneledRequest(undefined), false);
});

test('isLocalRequest：cloudflared 也是从 127.0.0.1 来的，必须靠 CF 头排除', () => {
  const loop = { socket: { remoteAddress: '127.0.0.1' } };
  // 本机浏览器直连：没有 CF 头
  assert.equal(isLocalRequest({ ...loop, headers: { host: '127.0.0.1:50980' } }), true);
  // 经隧道进来：socket 同样是回环，但带 CF 头 → 不是本机
  assert.equal(
    isLocalRequest({ ...loop, headers: { 'cf-connecting-ip': '203.0.113.7', 'cf-ray': 'x-HKG' } }),
    false,
  );
  // 非回环来源永远不算本机
  assert.equal(
    isLocalRequest({ socket: { remoteAddress: '203.0.113.9' }, headers: {} }),
    false,
  );
  assert.equal(isLocalRequest({ headers: {} }), false);
});

// ---- 回归：v1.6.12 审查发现的 IPv6 回环覆盖不足 ---------------------------

test('isLoopbackAddr：IPv6 回环的各种写法都要认', () => {
  // 这个函数是**安全判据** —— 它决定 clientIp 要不要信任
  // CF-Connecting-IP / X-Forwarded-For。判错的后果是所有公网用户
  // 共享同一个限速桶，一个攻击者就能把所有人锁在门外。
  //
  // 实测 Node 的 socket.remoteAddress 总是给规范化形式
  // （::ffff:127.0.0.1 全小写 / ::1），所以下面这些变体实际上
  // 不会从 Node 冒出来。但仍然要认 —— 不该让安全判据依赖
  // 「上游一定规范化」这种隐含约定。
  const loopbacks = [
    '127.0.0.1',
    '::1',
    '::ffff:127.0.0.1',
    '::FFFF:127.0.0.1', // 大写
    '0:0:0:0:0:0:0:1', // 全展开
    '::ffff:7f00:1', // IPv4-mapped 十六进制
    '127.0.0.53', // Linux 常见的其它 127/8
    'localhost',
  ];
  for (const a of loopbacks) {
    assert.equal(isLoopbackAddr(a), true, `${a} 应该被认成回环`);
  }
});

test('isLoopbackAddr：非回环一律 false（不能放宽）', () => {
  const others = [
    '10.0.0.1',
    '192.168.1.1',
    '2001:db8::1',
    '0.0.0.0',
    '128.0.0.1', // 127/8 之外
    '::2',
    '',
    null,
    undefined,
  ];
  for (const a of others) {
    assert.equal(isLoopbackAddr(a), false, `${a} 不该被认成回环`);
  }
});
