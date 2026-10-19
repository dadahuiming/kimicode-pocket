import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import { shouldTrim, trimJsonBuffer, formatStats, clearCaches, shutdown, cacheStats } from '../src/lib/trim.mjs';
import { decodePng, downscale, encodePng, shrinkPngDataUrl } from '../src/lib/image.mjs';
import { loadConfig } from '../src/lib/config.mjs';

const trimCfg = loadConfig({}).trim;

after(async () => {
  await shutdown();
});

/** 造一个「像 messages」的响应头 */
function jsonHeaders(len) {
  return { 'content-type': 'application/json; charset=utf-8', 'content-length': String(len) };
}

// ---------------------------------------------------------------- 工具：造 PNG

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([len, typed, crc]);
}

/**
 * 造一张「噪声感」的 PNG（纯色图压缩率太高，测不出降采样收益）。
 */
function makePng(width, height, { channels = 3 } = {}) {
  const colorType = { 1: 0, 3: 2, 4: 6 }[channels];
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed & 0xff;
  };
  for (let y = 0; y < height; y += 1) {
    const o = y * (stride + 1);
    raw[o] = 0; // None 滤波，保留噪声
    for (let x = 0; x < stride; x += 1) {
      raw[o + 1 + x] = (rnd() + y * 3 + x * 2) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  return Buffer.concat([
    SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngDataUrl(width, height, opts) {
  return `data:image/png;base64,${makePng(width, height, opts).toString('base64')}`;
}

/** 造一条带截图的 messages 响应 */
function makeMessagesWithImages({ textLen = 2000, images = 2, w = 800, h = 500 } = {}) {
  const items = [];
  for (let i = 0; i < images; i += 1) {
    items.push({
      id: `tool_${i}`,
      role: 'tool',
      content: [
        {
          type: 'tool_result',
          output: [
            { type: 'image_url', imageUrl: { url: pngDataUrl(w, h) } },
            { type: 'text', text: '截图已保存' },
          ],
        },
      ],
    });
  }
  items.push({
    id: 'assistant_0',
    role: 'assistant',
    content: [{ type: 'text', text: 'A'.repeat(textLen) }],
  });
  return { code: 0, msg: 'success', data: { items } };
}

// ---------------------------------------------------------------- shouldTrim

test('shouldTrim：非 JSON 直接放过', () => {
  const req = { method: 'GET', url: '/api/v1/sessions/x/messages' };
  const res = { headers: { 'content-type': 'text/html', 'content-length': '999999' } };
  assert.equal(shouldTrim(req, res, trimCfg), false);
});

test('shouldTrim：上游已压缩的不处理', () => {
  const req = { method: 'GET', url: '/api/v1/sessions/x/messages' };
  const res = {
    headers: { 'content-type': 'application/json', 'content-length': '999999', 'content-encoding': 'gzip' },
  };
  assert.equal(shouldTrim(req, res, trimCfg), false);
});

test('shouldTrim：小于 minBytes 不处理', () => {
  const req = { method: 'GET', url: '/api/v1/sessions/x/messages' };
  const res = { headers: jsonHeaders(1000) };
  assert.equal(shouldTrim(req, res, trimCfg), false);
});

test('shouldTrim：无 content-length 视为流式，放过', () => {
  const req = { method: 'GET', url: '/api/v1/sessions/x/messages' };
  const res = { headers: { 'content-type': 'application/json' } };
  assert.equal(shouldTrim(req, res, trimCfg), false);
});

test('shouldTrim：超过 maxBufferBytes 放过（保护内存）', () => {
  const req = { method: 'GET', url: '/api/v1/sessions/x/messages' };
  const res = { headers: jsonHeaders(trimCfg.maxBufferBytes + 1) };
  assert.equal(shouldTrim(req, res, trimCfg), false);
});

test('shouldTrim：HEAD 请求放过', () => {
  const req = { method: 'HEAD', url: '/api/v1/sessions/x/messages' };
  const res = { headers: jsonHeaders(999999) };
  assert.equal(shouldTrim(req, res, trimCfg), false);
});

test('shouldTrim：只对配置的路径生效', () => {
  const res = { headers: jsonHeaders(999999) };
  const hit = { method: 'GET', url: '/api/v1/sessions/x/messages' };
  const miss = { method: 'GET', url: '/api/v1/sessions/x/something-else' };
  assert.equal(shouldTrim(hit, res, trimCfg), true);
  assert.equal(shouldTrim(miss, res, trimCfg), false);
});

test('shouldTrim：开关关闭时一律不处理', () => {
  const req = { method: 'GET', url: '/api/v1/sessions/x/messages' };
  const res = { headers: jsonHeaders(999999) };
  assert.equal(shouldTrim(req, res, { ...trimCfg, enabled: false }), false);
});

// ---------------------------------------------------------------- 核心：文字不动

test('trimJsonBuffer：没有任何图片时返回 null（不改动）', async () => {
  const body = JSON.stringify({ code: 0, data: { items: [{ content: [{ type: 'text', text: 'x'.repeat(50000) }] }] } });
  const res = await trimJsonBuffer(Buffer.from(body), trimCfg);
  assert.equal(res, null, '没有图片就不该动它');
});

test('trimJsonBuffer：超长正文一个字符都不截断', async () => {
  const longText = '这是一段很长的正文。'.repeat(20000); // 20 万字
  const body = JSON.stringify({
    code: 0,
    data: { items: [{ content: [{ type: 'text', text: longText }] }] },
  });
  // 没有图 → 不动
  assert.equal(await trimJsonBuffer(Buffer.from(body), trimCfg), null);

  // 混入一张大图后仍然不动正文
  const withImg = JSON.stringify({
    code: 0,
    data: {
      items: [
        { content: [{ type: 'text', text: longText }] },
        { content: [{ output: [{ imageUrl: { url: pngDataUrl(1600, 1000) } }] }] },
      ],
    },
  });
  const r2 = await trimJsonBuffer(Buffer.from(withImg), trimCfg);
  assert.ok(r2, '有图应该被处理');
  const parsed = JSON.parse(r2.buffer.toString('utf8'));
  assert.equal(parsed.data.items[0].content[0].text, longText, '正文必须逐字符相同');
});

test('trimJsonBuffer：文字里有省略号样式也不受影响', async () => {
  const tricky = '…[已省略 805 字符 / 原长 846]…' + '尾巴'.repeat(100);
  const body = JSON.stringify({
    code: 0,
    data: {
      items: [
        { content: [{ type: 'text', text: tricky }] },
        { content: [{ output: [{ imageUrl: { url: pngDataUrl(1600, 1000) } }] }] },
      ],
    },
  });
  const res = await trimJsonBuffer(Buffer.from(body), trimCfg);
  const parsed = JSON.parse(res.buffer.toString('utf8'));
  assert.equal(parsed.data.items[0].content[0].text, tricky);
});

test('trimJsonBuffer：结构、字段名、数组长度全部不变', async () => {
  const before = makeMessagesWithImages({ images: 3, w: 1600, h: 1000 });
  const buf = Buffer.from(JSON.stringify(before));
  const res = await trimJsonBuffer(buf, trimCfg);
  assert.ok(res);

  const after = JSON.parse(res.buffer.toString('utf8'));
  assert.equal(after.data.items.length, before.data.items.length);
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
  assert.deepEqual(Object.keys(after.data).sort(), Object.keys(before.data).sort());
  for (let i = 0; i < before.data.items.length; i += 1) {
    assert.deepEqual(
      Object.keys(after.data.items[i]).sort(),
      Object.keys(before.data.items[i]).sort(),
    );
  }
});

// ---------------------------------------------------------------- 图片压缩

test('shrinkPngDataUrl：大图被降采样，体积显著变小', () => {
  const url = pngDataUrl(2000, 1250);
  const res = shrinkPngDataUrl(url, trimCfg.image);
  assert.ok(res, '2000x1250 应该被处理');
  assert.ok(res.factor >= 2, `倍率应 >= 2，实际 ${res.factor}`);
  assert.ok(res.outWidth < res.width, '宽度应变小');
  assert.ok(res.outBytes < res.originalBytes, '体积应变小');
  assert.match(res.url, /^data:image\/png;base64,/);
});

test('shrinkPngDataUrl：小图不动（不值得二次编码）', () => {
  const url = pngDataUrl(300, 200);
  const res = shrinkPngDataUrl(url, trimCfg.image);
  assert.equal(res, null, '像素数低于上限应原样放过');
});

test('shrinkPngDataUrl：非 PNG data URL 不处理', () => {
  assert.equal(shrinkPngDataUrl('data:image/jpeg;base64,AAAA', trimCfg.image), null);
  assert.equal(shrinkPngDataUrl('data:image/webp;base64,AAAA', trimCfg.image), null);
  assert.equal(shrinkPngDataUrl('https://example.com/a.png', trimCfg.image), null);
  assert.equal(shrinkPngDataUrl('not a url', trimCfg.image), null);
});

test('shrinkPngDataUrl：损坏的 base64 不抛异常，原样放过', () => {
  const bad = `data:image/png;base64,${Buffer.from('not a real png at all').toString('base64')}`;
  assert.equal(shrinkPngDataUrl(bad, trimCfg.image), null);
});

test('shrinkPngDataUrl：超过 maxInputBytes 不处理', () => {
  const cfg = { ...trimCfg.image, maxInputBytes: 1024 };
  const url = pngDataUrl(2000, 1250);
  assert.equal(shrinkPngDataUrl(url, cfg), null);
});

test('shrinkPngDataUrl：压缩后的图仍是合法 PNG', () => {
  const url = pngDataUrl(2000, 1250);
  const res = shrinkPngDataUrl(url, trimCfg.image);
  const bin = Buffer.from(res.url.split(',')[1], 'base64');
  const decoded = decodePng(bin);
  assert.ok(decoded, '应该能重新解码');
  assert.equal(decoded.width, res.outWidth);
  assert.equal(decoded.height, res.outHeight);
});

// ---------------------------------------------------------------- 编解码往返

test('decodePng / encodePng：往返后像素一致', () => {
  const bin = makePng(64, 48);
  const img = decodePng(bin);
  assert.ok(img);
  assert.equal(img.width, 64);
  assert.equal(img.height, 48);

  const re = encodePng(img, 6);
  const img2 = decodePng(re);
  assert.equal(img2.width, 64);
  assert.equal(img2.height, 48);
  assert.ok(img.pixels.equals(img2.pixels), '往返后像素应完全一致');
});

test('decodePng：非 PNG 返回 null', () => {
  assert.equal(decodePng(Buffer.from('hello world')), null);
  assert.equal(decodePng(Buffer.alloc(0)), null);
});

test('downscale：倍率 1 原样返回', () => {
  const img = decodePng(makePng(32, 32));
  assert.equal(downscale(img, 1), img);
});

test('downscale：÷2 尺寸减半，÷4 尺寸四分之一', () => {
  const img = decodePng(makePng(100, 80));
  const d2 = downscale(img, 2);
  assert.equal(d2.width, 50);
  assert.equal(d2.height, 40);
  const d4 = downscale(img, 4);
  assert.equal(d4.width, 25);
  assert.equal(d4.height, 20);
  assert.equal(d4.pixels.length, 25 * 20 * img.channels);
});

// ---------------------------------------------------------------- 统计与缓存

test('stats：图片张数与字节数统计可信', async () => {
  const before = makeMessagesWithImages({ images: 3, w: 1600, h: 1000 });
  const buf = Buffer.from(JSON.stringify(before));
  const res = await trimJsonBuffer(buf, trimCfg);
  assert.ok(res);
  assert.equal(res.stats.images, 3);
  assert.ok(res.stats.originalImageBytes > res.stats.outImageBytes);
  assert.equal(res.stats.details.length, 3);
  assert.ok(res.stats.trimmedBytes < res.stats.originalBytes);
});

test('formatStats：摘要包含图片数与正文保留', async () => {
  const before = makeMessagesWithImages({ images: 2, w: 1600, h: 1000 });
  const res = await trimJsonBuffer(Buffer.from(JSON.stringify(before)), trimCfg);
  const line = formatStats(res.stats);
  assert.match(line, /图片 2 张/);
  assert.match(line, /正文原样保留/);
});

test('缓存：同一响应第二次命中，结果一致', async () => {
  const before = makeMessagesWithImages({ images: 2, w: 1600, h: 1000 });
  const buf = Buffer.from(JSON.stringify(before));

  const r1 = await trimJsonBuffer(buf, trimCfg);
  const r2 = await trimJsonBuffer(buf, trimCfg);
  assert.ok(r1 && r2);
  assert.ok(r2.buffer.equals(r1.buffer), '缓存命中应返回完全相同的结果');
  assert.equal(r2.stats.cachedResponse, true);

  const st = cacheStats();
  assert.ok(st.responseEntries >= 1);
});

test('并发：同一响应同时请求，只算一次且结果一致', async () => {
  const before = makeMessagesWithImages({ images: 2, w: 1600, h: 1000 });
  const buf = Buffer.from(JSON.stringify(before));

  const [a, b, c] = await Promise.all([
    trimJsonBuffer(buf, trimCfg),
    trimJsonBuffer(buf, trimCfg),
    trimJsonBuffer(buf, trimCfg),
  ]);
  assert.ok(a && b && c);
  assert.ok(a.buffer.equals(b.buffer));
  assert.ok(a.buffer.equals(c.buffer));
});

test('clearCaches：清空后重新计算，结果仍一致', async () => {
  const before = makeMessagesWithImages({ images: 1, w: 1600, h: 1000 });
  const buf = Buffer.from(JSON.stringify(before));

  const r1 = await trimJsonBuffer(buf, trimCfg);
  await clearCaches();
  const r2 = await trimJsonBuffer(buf, trimCfg);
  assert.ok(r1 && r2);
  assert.ok(r1.buffer.equals(r2.buffer));
});

// ---------------------------------------------------------------- 健壮性

test('trimJsonBuffer：非 JSON 返回 null', async () => {
  assert.equal(await trimJsonBuffer(Buffer.from('not json at all'), trimCfg), null);
  assert.equal(await trimJsonBuffer(Buffer.from('<html></html>'), trimCfg), null);
});

test('trimJsonBuffer：深层嵌套不爆栈', async () => {
  let node = { deep: pngDataUrl(1600, 1000) };
  for (let i = 0; i < 200; i += 1) node = { child: node };
  const body = JSON.stringify({ code: 0, data: node });
  const res = await trimJsonBuffer(Buffer.from(body), trimCfg);
  if (res) assert.ok(res.buffer.length > 0);
});

test('trimJsonBuffer：数组里混着图片与文字，只换图片', async () => {
  const items = [
    pngDataUrl(1600, 1000),
    '纯文字',
    123,
    null,
    { nested: pngDataUrl(1600, 1000) },
    [pngDataUrl(1600, 1000)],
  ];
  const body = JSON.stringify({ code: 0, data: { items } });
  const res = await trimJsonBuffer(Buffer.from(body), trimCfg);
  assert.ok(res);
  const after = JSON.parse(res.buffer.toString('utf8'));
  assert.equal(after.data.items[1], '纯文字');
  assert.equal(after.data.items[2], 123);
  assert.equal(after.data.items[3], null);
  assert.equal(after.data.items.length, 6);
  assert.equal(res.stats.images, 3, '应该换了 3 张图');
});
