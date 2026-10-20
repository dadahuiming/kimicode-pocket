/**
 * 集成测试：起一个「假 Desktop」，再起真的 proxy.mjs 指向它。
 *
 * 这样不需要装 Kimi Code Desktop，也能覆盖整条链路：
 *   端口发现 → Host/Origin 改写 → 压缩 → WebSocket → 配对 → PIN
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
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

/** 造一张噪声 PNG（纯色图压缩率太高，测不出降采样收益） */
function makeTestPng(width, height) {
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();
  const crc = (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i += 1) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(typed));
    return Buffer.concat([len, typed, c]);
  };
  const channels = 3;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  let seed = 12345;
  for (let y = 0; y < height; y += 1) {
    const o = y * (stride + 1);
    raw[o] = 0;
    for (let x = 0; x < stride; x += 1) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      raw[o + 1 + x] = (seed + y * 3 + x * 2) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
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
      // 「没有截图的长会话」：真实场景里纯文本对话就是这样。
      // 瘦身逻辑会返回 null（无可压内容），此时必须原样透传 —— 曾经这里
      // 被当成失败返回 502，导致这类会话在手机上完全打不开。
      if (req.url.includes('/sessions/plain/transcript')) {
        const items = [];
        for (let i = 0; i < 40; i += 1) {
          items.push({
            stepId: `s${i}`,
            frames: [{ kind: 'thinking', text: '思考'.repeat(3000) }],
          });
        }
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': String(Buffer.byteLength(JSON.stringify({ data: { items } }))),
        });
        res.end(JSON.stringify({ data: { items } }));
        return;
      }
      // 「带截图的长会话」：应触发降采样
      if (req.url.includes('/sessions/pics/transcript')) {
        const png = makeTestPng(1600, 1000);
        const body = JSON.stringify({
          data: {
            items: [
              {
                stepId: 's0',
                frames: [
                  {
                    kind: 'tool',
                    output: [{ type: 'image_url', imageUrl: { url: `data:image/png;base64,${png.toString('base64')}` } }],
                  },
                ],
              },
            ],
          },
        });
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': String(Buffer.byteLength(body)),
        });
        res.end(body);
        return;
      }
      if (req.url === '/sse') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: hi\n\n');
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      // 结构要和真实 Desktop 的 index.html 一致（有 </body>），
      // 否则注入会退到「末尾追加」分支，测不到主路径。
      res.end('<!doctype html><html><head><title>Kimi Code</title></head><body><div id="app"></div></body></html>');
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
async function startProxy({ desktopPort, pin, noToken = false, env: extraEnv = {} } = {}) {
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
  Object.assign(env, extraEnv);
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

// ---------------------------------------------------------------- 瘦身回归
//
// 这一组防的是 v1.5.0 那个 502 事故：
// 「没有截图的会话」走瘦身分支时 trimJsonBuffer 返回 null（无可压内容），
// 旧代码把它当失败 throw，导致整条 transcript 变 502 Bad Gateway，
// 手机端看到的是 Cloudflare 错误页而不是对话内容。

test('瘦身：无截图的长会话必须 200 原样透传，不能 502', async () => {
  const r = await fetch(`${proxy.base}/api/v1/sessions/plain/transcript?agent_id=main&page_size=10`);
  assert.equal(r.status, 200, '没有可压内容时应原样透传，绝不能 502');

  // 不应带 trimmed 标记（因为什么都没改）
  assert.equal(r.headers.get('x-pocket-trimmed'), null);

  // 内容必须是完整 JSON，且文字原样
  const body = await r.json();
  assert.ok(Array.isArray(body.data.items));
  assert.equal(body.data.items.length, 40);
  assert.equal(body.data.items[0].frames[0].text, '思考'.repeat(3000));
});

test('瘦身：带截图的会话 200 且标记 trimmed，文字不变', async () => {
  const r = await fetch(`${proxy.base}/api/v1/sessions/pics/transcript?agent_id=main&page_size=10`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-pocket-trimmed'), '1');

  const body = await r.json();
  assert.ok(Array.isArray(body.data.items));
  const url = body.data.items[0].frames[0].output[0].imageUrl.url;
  // 1.6.9 起输出 JPEG：PNG 对截图几乎压不动，实测 JPEG 能省 80%
  assert.match(url, /^data:image\/jpeg;base64,/);

  // 降采样后应明显小于原图（1600x1000 → 533x333 左右）
  const outLen = Buffer.from(url.split(',')[1], 'base64').length;
  assert.ok(outLen < 900_000, `压缩后应明显变小，实际 ${outLen}`);
});

test('传输中断必须可观测（否则「HTTP 200 但 Failed to fetch」永远查不出来）', async () => {
  // 用户实测报过：手机上 HTTP 200、2063ms、失败阶段 parse、TypeError: Failed to fetch。
  // 而代理日志写着 `200 ... 13384621B`，看起来一切正常 —— 因为
  // res 的 finish 事件只表示「交给内核缓冲区」，不代表对端收到。
  // 查下来是他手机传输途中换了出口 IP（157.61.160.31 → 111.55.210.62），
  // TCP 连接直接失效。这个盲区必须补，否则下次还是查不出来。
  //
  // 两个独立信号：
  //   非压缩路径 —— 分块写 + writableFinished
  //   压缩路径   —— socket 的 ECONNRESET（writableFinished 在那儿不可靠）
  const src = readFileSync(new URL('../src/proxy.mjs', import.meta.url), 'utf8');
  assert.ok(/function writeChunked\(/.test(src), '非压缩路径必须分块写');
  assert.ok(src.includes('res.once(\'drain\', pump)'), '要等背压，否则几毫秒灌完缓冲区');
  assert.ok(/function reportDelivery\(/.test(src), '要有完成度判定');
  assert.ok(/function watchCompressedDelivery\(/.test(src), '压缩路径要单独观测');
  assert.ok(src.includes("sock.on('error', onErr)"), '压缩路径要靠 socket error 判定');
  assert.ok(src.includes('writableFinished'), '要能区分正常写完与中断');
});

// ---------------------------------------------------------------- 轮次导航
//
// 这一组防的是「手机上应该有却没有」：
// 桌面端右侧有「对话目录」，但组件里写死 `!mobile`，而 mobile 就是
// `(max-width: 640px)` —— 手机上一律不渲染。代理在 HTML 里注入一段脚本
// 自己画胶囊。注入本身必须满足：只碰 HTML、不碰 JSON、可一键关闭。

test('轮次导航：HTML 首页被注入，且 content-length 与实际字节一致', async () => {
  const r = await fetch(`${proxy.base}/`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') ?? '', /text\/html/);

  const html = await r.text();
  assert.match(html, /kimi-pocket:turn-nav/, '注入标记必须在');
  assert.match(html, /id="pocket-turn-nav-script"/, '脚本标签必须在');

  // 注入后仍要保留原始文档结构（不能把 </body> 弄丢，也不能把 #app 吞掉）
  assert.match(html, /<div id="app"><\/div>/);
  assert.ok(html.includes('</body>'), '</body> 必须还在');
  assert.ok(html.indexOf('kimi-pocket:turn-nav') < html.indexOf('</body>'), '必须插在 </body> 之前');
  assert.equal(r.headers.get('content-length'), String(Buffer.byteLength(html)));
});

test('轮次导航：脚本只出现一次（重复注入会叠加两份监听）', async () => {
  const html = await (await fetch(`${proxy.base}/`)).text();
  const hits = html.match(/id="pocket-turn-nav-script"/g) ?? [];
  assert.equal(hits.length, 1);
});

test('轮次导航：JSON 响应绝不能被注入', async () => {
  const r = await fetch(`${proxy.base}/api/v1/sessions/plain/transcript?agent_id=main`);
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.ok(!text.includes('pocket-turn-nav'), 'JSON 里出现注入标记说明改坏了数据');
  // 且仍然是合法 JSON
  assert.doesNotThrow(() => JSON.parse(text));
});

test('轮次导航：POCKET_TOC=0 时首页原样返回，一个字节都不多', async () => {
  const p = await startProxy({ desktopPort: fake.port, env: { POCKET_TOC: '0' } });
  try {
    const r = await fetch(`${p.base}/`);
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.ok(!html.includes('pocket-turn-nav'), 'POCKET_TOC=0 必须彻底关闭');
    assert.match(html, /<title>Kimi Code<\/title>/);
  } finally {
    p.stop();
  }
});

test('轮次导航：注入脚本语法合法（正则转义写错会整页白屏）', async () => {
  const html = await (await fetch(`${proxy.base}/`)).text();
  const start = html.indexOf('<script id="pocket-turn-nav-script">');
  const codeStart = start + '<script id="pocket-turn-nav-script">'.length;
  const code = html.slice(codeStart, html.indexOf('</script>', codeStart));
  assert.ok(code.length > 500, '脚本不该是空的');
  assert.doesNotThrow(() => new Function(code), '注入的脚本必须能被解析');
  // 结束标签必须被转义掉，否则 HTML 提前闭合、后面的 DOM 全变文本
  assert.ok(!/<\/script/i.test(code), '脚本体内不能出现未转义的 </script');
});
