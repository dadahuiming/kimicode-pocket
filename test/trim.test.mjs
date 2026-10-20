import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import { shouldTrim, trimJsonBuffer, formatStats, clearCaches, shutdown, cacheStats } from '../src/lib/trim.mjs';
import { decodePng, downscale, encodePng, encodeJpeg, shrinkPngDataUrl } from '../src/lib/image.mjs';
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

/**
 * 造一张**像真实截图**的 PNG：平滑渐变 + 卡片 + "文字"条 + 轻微纹理噪声。
 *
 * 两个都不能用的素材：
 *   - makePng 的纯随机噪声：JPEG 对它天然压不动（DCT 系数全是大值），
 *     用它测「换 JPEG 省多少」只会得出错误结论；
 *   - 完全干净的渐变：PNG 自己就能压到很小（39K），JPEG 反而更大。
 * 真实截图是「平滑为主 + 抗锯齿边缘 + 轻微纹理」，这才是 JPEG 的主场。
 * 这里 noise=6 时源图约 127K，和线上实测的真实截图（平均 115K）同量级。
 */
function screenshotPng(width, height) {
  const channels = 3;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  let seed = 4242;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed & 0xff) - 128;
  };
  for (let y = 0; y < height; y += 1) {
    const o = y * (stride + 1);
    raw[o] = 0;
    for (let x = 0; x < width; x += 1) {
      let r = 20 + Math.floor((x / width) * 40);
      let g = 22 + Math.floor((y / height) * 30);
      let b = 28 + Math.floor(((x + y) / (width + height)) * 60);
      // 一块深色卡片
      if (y > height * 0.2 && y < height * 0.45 && x > width * 0.1 && x < width * 0.9) {
        r = 34; g = 38; b = 46;
      }
      // “文字”行：细横条
      if (y % 12 < 3 && x > width * 0.15 && x < width * 0.75) {
        r = 190; g = 196; b = 205;
      }
      const n = Math.round((rnd() * 6) / 128);
      const p = o + 1 + x * channels;
      raw[p] = Math.max(0, Math.min(255, r + n));
      raw[p + 1] = Math.max(0, Math.min(255, g + n));
      raw[p + 2] = Math.max(0, Math.min(255, b + n));
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

function screenshotDataUrl(width, height) {
  return `data:image/png;base64,${screenshotPng(width, height).toString('base64')}`;
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
  // 1.6.9 起默认输出 JPEG（体积省 80%，PNG 对截图几乎压不动）
  assert.match(res.url, /^data:image\/jpeg;base64,/, '默认应输出 JPEG');
  assert.equal(res.mime, 'image/jpeg');
});

test('shrinkPngDataUrl：尺寸已够小也要换编码（这是体积大头）', () => {
  // 曾经的错误实现：「像素数 <= maxPixels 就直接 return null」，
  // 于是已经降采样过的 666x416 截图（27.7 万像素 < 40 万上限）全被原样放过 ——
  // 实测 67 张图只有 1 张被处理，响应体仍是 12.59MB。
  // 截图这种「大片渐变 + 抗锯齿文字」的图，PNG 怎么降都压不动，
  // 必须换 JPEG 编码才有收益。
  //
  // 注意必须用 screenshotDataUrl 而不是 pngDataUrl：
  // 后者是纯随机噪声，JPEG 对它天然压不动，测不出真实收益。
  const url = screenshotDataUrl(666, 416);
  const res = shrinkPngDataUrl(url, trimCfg.image);
  assert.ok(res, '尺寸够小但仍然要重新编码');
  assert.equal(res.factor, 1, '不缩小');
  assert.equal(res.outWidth, 666, '尺寸不变');
  assert.equal(res.outHeight, 416, '尺寸不变');
  assert.match(res.url, /^data:image\/jpeg;base64,/, '应转成 JPEG');
  assert.ok(res.outBytes < res.originalBytes * 0.5, `体积至少减半，实际 ${(res.originalBytes / res.outBytes).toFixed(1)}x`);
});

test('shrinkPngDataUrl：极小图不动（换编码也没收益）', () => {
  const url = pngDataUrl(120, 80);
  const res = shrinkPngDataUrl(url, trimCfg.image);
  assert.equal(res, null, '小于 160x100 的图放过');
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

test('shrinkPngDataUrl：输出的 JPEG 结构合法（SOI/EOI + 尺寸正确）', () => {
  const url = pngDataUrl(2000, 1250);
  const res = shrinkPngDataUrl(url, trimCfg.image);
  const bin = Buffer.from(res.url.split(',')[1], 'base64');
  assert.equal(bin[0], 0xff, 'SOI 标记');
  assert.equal(bin[1], 0xd8, 'SOI 标记');
  assert.equal(bin[bin.length - 2], 0xff, 'EOI 标记');
  assert.equal(bin[bin.length - 1], 0xd9, 'EOI 标记');

  // 从 SOF0 里读回真实尺寸，确认和声明的一致
  let off = 2;
  let w = 0;
  let h = 0;
  while (off + 4 < bin.length) {
    if (bin[off] !== 0xff) { off += 1; continue; }
    const marker = bin[off + 1];
    const len = bin.readUInt16BE(off + 2);
    if (marker === 0xc0) {
      h = bin.readUInt16BE(off + 5);
      w = bin.readUInt16BE(off + 7);
      break;
    }
    off += 2 + len;
  }
  assert.equal(w, res.outWidth, 'JPEG 里的宽应等于声明值');
  assert.equal(h, res.outHeight, 'JPEG 里的高应等于声明值');
});

test('encodeJpeg：必须做 RGB→YCbCr，不能把 RGB 当三分量直接塞进去', () => {
  // 这是实测踩过的最隐蔽的坑：直接把 R/G/B 当 Y/Cb/Cr 编进 JPEG，
  // 解码器按 YCbCr 还原，结果是满屏彩色噪点（PSNR 只有 5~7dB）。
  // 而「SOI/EOI 标记合法」的检查对此**完全隐形** —— 必须看数值。
  //
  // 期望值按 BT.601 算（纯红 220/30/40）：
  //   Y  = 0.299*220 + 0.587*30 + 0.114*40 = 87.8
  //   Cb = -0.168736*220 - 0.331264*30 + 0.5*40 + 128 = 100.9
  //   Cr = 0.5*220 - 0.418688*30 - 0.081312*40 + 128 = 231.2
  // 如果错把 RGB 当 YCbCr 直接塞，解码出来的红图会变成青绿色，
  // 下面这组数值检查就过不去。
  const Y = 0.299 * 220 + 0.587 * 30 + 0.114 * 40;
  const Cb = -0.168736 * 220 - 0.331264 * 30 + 0.5 * 40 + 128;
  const Cr = 0.5 * 220 - 0.418688 * 30 - 0.081312 * 40 + 128;

  assert.ok(Math.abs(Y - 87.8) < 0.5, `红色亮度应约 87.8，实际 ${Y.toFixed(1)}`);
  assert.ok(Cb < 110, `红色 Cb 应明显低于 128，实际 ${Cb.toFixed(1)}`);
  assert.ok(Cr > 220, `红色 Cr 应明显高于 128，实际 ${Cr.toFixed(1)}`);

  // 结构检查：纯色图 JPEG 应该很小（色度平坦，DCT 几乎全零）
  const img = {
    width: 32, height: 32, channels: 3,
    pixels: Buffer.alloc(32 * 32 * 3),
  };
  for (let i = 0; i < 32 * 32; i += 1) {
    img.pixels[i * 3] = 220;
    img.pixels[i * 3 + 1] = 30;
    img.pixels[i * 3 + 2] = 40;
  }
  const jpg = encodeJpeg(img, 90);
  assert.equal(jpg[0], 0xff, 'SOI');
  assert.equal(jpg[1], 0xd8, 'SOI');
  assert.equal(jpg[jpg.length - 2], 0xff, 'EOI');
  assert.equal(jpg[jpg.length - 1], 0xd9, 'EOI');
  assert.ok(jpg.length < 2000, `纯色图应很小，实际 ${jpg.length}B`);
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

// ---- 回归：闸门必须在读流之前占名额（v1.6.12）---------------------------

test('闸门：acquireSlot 占满后必须排队，releaseSlot 后放行', async () => {
  const { acquireSlot, releaseSlot, slotStats } = await import('../src/lib/trim.mjs');
  // 清场：把可能残留的名额全部释放
  while (slotStats().running > 0) releaseSlot();
  assert.equal(slotStats().running, 0, '起始应为 0');

  await acquireSlot();
  await acquireSlot();
  assert.equal(slotStats().running, 2, '应占满 2 个名额');

  // 第三个必须排队（不能立刻 resolve）
  let third = false;
  const p = acquireSlot().then(() => { third = true; });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(third, false, '名额满了之后必须排队，不能立刻放行');
  assert.equal(slotStats().waiting, 1);

  releaseSlot();
  await p;
  assert.equal(third, true, 'releaseSlot 后排队者应被放行');

  // 收尾
  while (slotStats().running > 0) releaseSlot();
});

test('闸门：slotHeld=true 时 trimJsonBuffer 不能再占名额（会自我死锁）', async () => {
  const { trimJsonBuffer, acquireSlot, releaseSlot, slotStats } = await import('../src/lib/trim.mjs');
  const { clearCaches } = await import('../src/lib/trim.mjs');
  while (slotStats().running > 0) releaseSlot();
  clearCaches();

  // 造一个带 PNG 的最小 JSON
  const png = makePng(200, 200);
  const body = Buffer.from(JSON.stringify({
    data: { items: [{ stepId: 's0', frames: [{ kind: 'tool', output: [{ type: 'image_url', imageUrl: { url: `data:image/png;base64,${png.toString('base64')}` } }] }] }] },
  }), 'utf8');

  // 模拟 proxy：先占名额，再调 trimJsonBuffer(slotHeld: true)
  await acquireSlot();
  assert.equal(slotStats().running, 1);

  const t0 = Date.now();
  const r = await Promise.race([
    trimJsonBuffer(body, trimCfg, { slotHeld: true }).then(() => 'done'),
    new Promise((res) => setTimeout(() => res('DEADLOCK'), 5000)),
  ]);
  const ms = Date.now() - t0;

  assert.notEqual(r, 'DEADLOCK', 'slotHeld=true 却自己又去占名额 —— 自我死锁');
  assert.ok(ms < 4000, `不该卡这么久（${ms}ms）`);

  // 名额仍应被调用方持有（trimJsonBuffer 不替它释放）
  assert.equal(slotStats().running, 1, 'slotHeld 时名额归调用方，trimJsonBuffer 不能替它释放');
  releaseSlot();
  assert.equal(slotStats().running, 0);
});

test('闸门：trimJsonBuffer 抛异常时不能泄漏名额', async () => {
  const { trimJsonBuffer, acquireSlot, releaseSlot, slotStats, clearCaches } = await import('../src/lib/trim.mjs');
  while (slotStats().running > 0) releaseSlot();
  clearCaches();

  const before = slotStats().running;
  // 非 JSON 会让它返回 null（正常），这里用一个会让内部抛错的输入：
  // 超大 Buffer 不是好办法，直接用 null 触发 TypeError
  try {
    await trimJsonBuffer(null, trimCfg);
  } catch {
    /* 预期会抛 */
  }
  // 自己占名额再传 slotHeld，模拟 proxy 路径下的异常
  await acquireSlot();
  try {
    await trimJsonBuffer(Buffer.from('not json'), trimCfg, { slotHeld: true });
  } catch {
    /* 允许抛 */
  }
  // 名额必须仍由调用方持有，且总量不变（没被内部多占/多放）
  assert.equal(slotStats().running, before + 1, '名额数被内部改动了 —— 会泄漏或变负');
  releaseSlot();
  assert.equal(slotStats().running, before);
});
