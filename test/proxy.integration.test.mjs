/**
 * 集成测试：起一个「假 Desktop」，再起真的 proxy.mjs 指向它。
 *
 * 这样不需要装 Kimi Code Desktop，也能覆盖整条链路：
 *   端口发现 → Host/Origin 改写 → 压缩 → WebSocket → 配对 → PIN
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROXY = join(REPO, 'src', 'proxy.mjs');

/** 找一个空闲端口 */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** 假 Desktop：覆盖探活、回显头、大 JSON、WebSocket */
function startFakeDesktop() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/api/v1/healthz') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
        return;
      }
      if (req.url.startsWith('/echo')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ host: req.headers.host ?? null, origin: req.headers.origin ?? null }));
        return;
      }
      if (req.url === '/big.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ pad: 'x'.repeat(200_000) }));
        return;
      }
      if (req.url === '/sse') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: hi\n\n');
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>Kimi Code</title>');
    });

    server.on('upgrade', (req, socket) => {
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
      );
    });

    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/** 起一个真 proxy 实例，指向给定假 Desktop */
async function startProxy({ desktopPort, pin, noToken = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'pocket-e2e-'));
  mkdirSync(join(home, 'server', 'instances'), { recursive: true });
  writeFileSync(
    join(home, 'server', 'instances', 'inst.json'),
    JSON.stringify({ port: desktopPort, pid: process.pid, heartbeat_at: Date.now() }),
  );
  if (!noToken) writeFileSync(join(home, 'server.token'), 'test-token-0123456789');

  const port = await freePort();
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('POCKET_')) delete env[k];
  Object.assign(env, {
    POCKET_PORT: String(port),
    POCKET_APP_HOME: home,
    POCKET_LOG_DIR: join(home, 'logs'),
    POCKET_ACCESS_LOG: '0',
    POCKET_RATE_LIMIT: '0',
  });
  if (pin) env.POCKET_PIN = pin;

  const proc = spawn(process.execPath, [PROXY], { env, stdio: 'ignore' });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/__status`);
      if (r.ok) break;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  return {
    base,
    home,
    proc,
    stop() {
      proc.kill();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

let fake;
let proxy;

before(async () => {
  fake = await startFakeDesktop();
  proxy = await startProxy({ desktopPort: fake.port });
});

after(async () => {
  proxy?.stop();
  await new Promise((r) => fake?.server.close(r));
});

test('健康检查回显 desktopPort（回环来源）', async () => {
  const r = await fetch(`${proxy.base}/__healthz`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.desktopPort, fake.port);
  assert.equal(j.proxyPort, Number(new URL(proxy.base).port));
});

test('首页直达 Web UI', async () => {
  const r = await fetch(`${proxy.base}/`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /<title>Kimi Code<\/title>/);
});

test('伪造 Host 也能通（代理改写了 Host）', async () => {
  const r = await fetch(`${proxy.base}/echo`, { headers: { host: 'evil.example.com' } });
  const j = await r.json();
  assert.equal(j.host, `127.0.0.1:${fake.port}`);
});

test('Origin 被改写为回环来源，而不是被删除', async () => {
  const r = await fetch(`${proxy.base}/echo`, { headers: { origin: 'https://evil.example.com' } });
  const j = await r.json();
  assert.equal(j.origin, `http://127.0.0.1:${fake.port}`);
});

test('无 Origin 的请求不会被凭空加上 Origin', async () => {
  const r = await fetch(`${proxy.base}/echo`);
  const j = await r.json();
  assert.equal(j.origin, null);
});

/** 用原始 http 请求量「线上字节数」——fetch 会自动解压，测不出压缩效果 */
function rawGet(url, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      { host: u.hostname, port: u.port, path: u.pathname + u.search, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            wireBytes: Buffer.concat(chunks).length,
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('JSON 响应按 Accept-Encoding 压缩，且线上字节显著变小', async () => {
  const plain = await rawGet(`${proxy.base}/big.json`, { 'accept-encoding': 'identity' });
  assert.equal(plain.status, 200);
  assert.equal(plain.headers['content-encoding'], undefined);

  const br = await rawGet(`${proxy.base}/big.json`, { 'accept-encoding': 'br' });
  assert.equal(br.headers['content-encoding'], 'br');
  assert.ok(
    br.wireBytes < plain.wireBytes / 10,
    `压缩后应显著更小：${br.wireBytes} vs ${plain.wireBytes}`,
  );
  assert.match(br.headers.vary ?? '', /accept-encoding/i);
  // 压缩后不能再带 content-length（改成 chunked）
  assert.equal(br.headers['content-length'], undefined);
});

test('不支持压缩的客户端拿到原样响应', async () => {
  const r = await rawGet(`${proxy.base}/big.json`, { 'accept-encoding': 'gzip' });
  assert.equal(r.headers['content-encoding'], 'gzip');
  assert.ok(r.wireBytes < 200_000);
});

test('text/event-stream 不压缩（流式不能被缓冲）', async () => {
  const r = await fetch(`${proxy.base}/sse`, { headers: { 'accept-encoding': 'br, gzip' } });
  assert.equal(r.headers.get('content-encoding'), null);
  assert.match(r.headers.get('content-type') ?? '', /text\/event-stream/);
});

test('WebSocket 升级透传成功（101）', async () => {
  const status = await new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port: Number(new URL(proxy.base).port),
      path: '/api/v1/ws?client_id=t',
      headers: {
        Host: 'evil.example.com',
        Origin: 'https://evil.example.com',
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      },
    });
    req.on('upgrade', (res) => {
      res.socket.destroy();
      resolve(101);
    });
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', () => resolve(0));
    req.end();
    setTimeout(() => resolve(-1), 5000);
  });
  assert.equal(status, 101);
});

/** 模拟一条经 Cloudflare 隧道进来的请求：socket 仍是 127.0.0.1，但带 CF 头 */
const CF_HEADERS = {
  'cf-connecting-ip': '203.0.113.7',
  'cf-ray': '8a1b2c3d4e5f6a7b-HKG',
  'x-forwarded-proto': 'https',
};

test('经隧道来的请求不算本机：仅本机端点一律 404', async () => {
  for (const p of ['/__status', '/__paircode', '/__pairstatus?codes=123456', '/__qrcode?data=hello']) {
    const r = await fetch(`${proxy.base}${p}`, { headers: CF_HEADERS });
    assert.equal(r.status, 404, `${p} 应对外部不可见`);
  }
});

test('经隧道来的健康检查只回 ok 布尔值，不泄漏任何内部信息', async () => {
  const r = await fetch(`${proxy.base}/__healthz`, { headers: CF_HEADERS });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
});

test('经隧道来的配对请求即使带合法 code 也要正常生效（回归：别把功能一起关掉）', async () => {
  const { code } = await (await fetch(`${proxy.base}/__paircode`)).json();
  const r = await fetch(`${proxy.base}/__pair?code=${code}`, { headers: CF_HEADERS });
  assert.equal(r.status, 200);
  assert.match(await r.text(), /kimi-web\.server-credential/);
});

test('配对：一次性口令只能消费一次', async () => {
  const r = await fetch(`${proxy.base}/__paircode`);
  const { code } = await r.json();
  assert.match(code, /^\d{6}$/);

  const ok = await fetch(`${proxy.base}/__pair?code=${code}`);
  assert.equal(ok.status, 200);
  const html = await ok.text();
  assert.match(html, /kimi-web\.server-credential/);
  assert.match(html, /location\.replace/);

  const replay = await fetch(`${proxy.base}/__pair?code=${code}`);
  assert.equal(replay.status, 401);
});

test('配对：不带 code 一律拒绝，本机也不例外（P0 回归）', async () => {
  const r = await fetch(`${proxy.base}/__pair`);
  assert.equal(r.status, 401);
  assert.match(await r.text(), /缺少配对口令/);
});

test('配对状态回显：pending → redeemed，且已兑换的码仍不可重放', async () => {
  const { code } = await (await fetch(`${proxy.base}/__paircode`)).json();

  const before = await (await fetch(`${proxy.base}/__pairstatus?codes=${code}`)).json();
  assert.equal(before.total, 1);
  assert.equal(before.redeemed, 0);
  assert.equal(before.codes[0].state, 'pending');

  const ok = await fetch(`${proxy.base}/__pair?code=${code}`);
  assert.equal(ok.status, 200);

  const after = await (await fetch(`${proxy.base}/__pairstatus?codes=${code}`)).json();
  assert.equal(after.redeemed, 1);
  assert.equal(after.codes[0].state, 'redeemed');
  assert.ok(after.codes[0].redeemedAt > 0, '兑换时间要能被读到');

  const replay = await fetch(`${proxy.base}/__pair?code=${code}`);
  assert.equal(replay.status, 401);
});

test('配对：拿不到 Desktop 凭证时不得烧掉口令，也不得让终端以为成功', async () => {
  const p = await startProxy({ desktopPort: fake.port, noToken: true });
  try {
    const { code } = await (await fetch(`${p.base}/__paircode`)).json();

    const r = await fetch(`${p.base}/__pair?code=${code}`);
    assert.equal(r.status, 503);

    const st = await (await fetch(`${p.base}/__pairstatus?codes=${code}`)).json();
    assert.equal(st.redeemed, 0, '失败路径绝不能标成 redeemed');
    assert.equal(st.codes[0].state, 'pending', '口令必须仍然可用');
  } finally {
    p.stop();
  }
});

test('配对状态回显：不存在的码是 unknown，绝不误报成功', async () => {
  const body = await (await fetch(`${proxy.base}/__pairstatus?codes=999999999`)).json();
  assert.equal(body.total, 1);
  assert.equal(body.redeemed, 0);
  assert.equal(body.codes[0].state, 'unknown');
});

test('配对：连续猜错 5 次后锁定 429', async () => {
  const p = await startProxy({ desktopPort: fake.port });
  try {
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`${p.base}/__pair?code=${String(100000 + i)}`);
      assert.equal(r.status, 401, `第 ${i + 1} 次应是 401`);
    }
    const locked = await fetch(`${p.base}/__pair?code=111111`);
    assert.equal(locked.status, 429);
  } finally {
    p.stop();
  }
});

test('配对：错误口令被拒绝', async () => {
  const r = await fetch(`${proxy.base}/__pair?code=000000`);
  assert.equal(r.status, 401);
});

test('二维码端点返回合法 PNG', async () => {
  const r = await fetch(`${proxy.base}/__qrcode?data=${encodeURIComponent('https://example.com/x')}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/png');
  const buf = Buffer.from(await r.arrayBuffer());
  assert.deepEqual([...buf.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});

test('二维码端点拒绝超长内容', async () => {
  const r = await fetch(`${proxy.base}/__qrcode?data=${'a'.repeat(2000)}`);
  assert.equal(r.status, 413);
});

test('Desktop 挂掉后健康检查转为 503', async () => {
  const tmp = await startFakeDesktop();
  const p = await startProxy({ desktopPort: tmp.port });
  try {
    assert.equal((await fetch(`${p.base}/__healthz`)).status, 200);
    await new Promise((r) => tmp.server.close(r));
    const after = await fetch(`${p.base}/__healthz`);
    assert.equal(after.status, 503);
    const j = await after.json();
    assert.equal(j.ok, false);
    // 页面给出可读错误，而不是白屏
    const page = await fetch(`${p.base}/`);
    assert.equal(page.status, 503);
    assert.match(await page.text(), /Desktop 未运行/);
  } finally {
    p.stop();
  }
});

test('开启 PIN 后：页面跳登录、API 返回 401 JSON、配对可免 PIN', async () => {
  const p = await startProxy({ desktopPort: fake.port, pin: 'testpin123' });
  try {
    const page = await fetch(`${p.base}/`, { redirect: 'manual' });
    assert.equal(page.status, 302);
    assert.match(page.headers.get('location') ?? '', /\/__login\?next=/);

    const api = await fetch(`${p.base}/api/v1/providers`);
    assert.equal(api.status, 401);
    assert.equal((await api.json()).error, 'pin_required');

    const loginPage = await fetch(`${p.base}/__login`);
    assert.equal(loginPage.status, 200);
    assert.match(await loginPage.text(), /name="pin"/);

    // 错误口令
    const bad = await fetch(`${p.base}/__login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'pin=wrong',
      redirect: 'manual',
    });
    assert.equal(bad.status, 401);

    // 正确口令
    const good = await fetch(`${p.base}/__login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'pin=testpin123&next=/',
      redirect: 'manual',
    });
    assert.equal(good.status, 302);
    const cookie = (good.headers.get('set-cookie') ?? '').split(';')[0];
    assert.match(cookie, /^pocket_session=/);

    const home = await fetch(`${p.base}/`, { headers: { cookie } });
    assert.equal(home.status, 200);
    assert.match(await home.text(), /<title>Kimi Code<\/title>/);

    // 配对链接自带头令，免 PIN
    const { code } = await (await fetch(`${p.base}/__paircode`)).json();
    const pair = await fetch(`${p.base}/__pair?code=${code}`, { redirect: 'manual' });
    assert.equal(pair.status, 200);
  } finally {
    p.stop();
  }
});
