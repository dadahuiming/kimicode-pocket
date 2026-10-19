// 图片降采样：把 transcript / messages 里的 base64 截图在传输层重新编码成更小的图。
//
// 为什么需要：
//   长会话的体积几乎全在工具截图里。实测一个会话 /messages 有 5.41 MB，
//   其中 5.36 MB 是 4 张 2000x1250 的 base64 PNG —— 占 99.1%；
//   而真正的对话正文（markdown、思考、工具输出）合计不到 50 KB。
//   手机在 5G 下拉 5 MB 会超过前端 fetch 的超时，表现就是「HTTP 200 但解析失败」。
//
// 设计原则（与文字裁剪的本质区别）：
//   **文字一律不动，只压图片。** 旧版按总预算「对折字符串」的做法会把 846 字符的
//   正文砍成 41 字符 —— 用信息的完整性去换体积，是错的。图片是有损也无所谓的
//   呈现层，降分辨率后仍能看清内容，而文字少一个字都可能改变语义。
//
// 做法：
//   1. 只处理 data:image/png;base64,... （JPEG/WebP 已经是压缩格式，不碰）
//   2. 纯 JS 解码 PNG（非隔行、8 位深），按整数倍箱式降采样
//   3. 重新编码为 PNG，base64 塞回原来的位置
//   4. 整个过程不依赖任何第三方库（本项目坚持零依赖）

import zlib from 'node:zlib';

// ---------------------------------------------------------------- CRC32

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

// ---------------------------------------------------------------- PNG 解码

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * 解码 PNG 到 8 位 RGBA / RGB / 灰度。
 * 只支持非隔行、8 位深 —— 工具截图都是这种，其余一律返回 null 走原样放过。
 * @returns {{width:number,height:number,channels:number,pixels:Buffer}|null}
 */
export function decodePng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) return null;

  let off = 8;
  let ihdr = null;
  const idat = [];

  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    if (off + 12 + len > buf.length) return null;
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);

    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }

  if (!ihdr || !idat.length) return null;
  // 隔行 / 非 8 位深 / 调色板图：交回上层原样放过，不自作聪明
  if (ihdr.interlace !== 0 || ihdr.bitDepth !== 8) return null;
  if (ihdr.colorType === 3) return null;

  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[ihdr.colorType];
  if (!channels) return null;

  const { width, height } = ihdr;
  if (width < 1 || height < 1 || width * height > 40_000_000) return null;

  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }

  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return null;

  const out = Buffer.alloc(stride * height);
  const bpp = channels;
  let pos = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos];
    pos += 1;
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const o = y * stride;
    const up = o - stride;

    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? out[o + x - bpp] : 0;
      const b = y > 0 ? out[up + x] : 0;
      const c = y > 0 && x >= bpp ? out[up + x - bpp] : 0;
      let v = line[x];

      switch (filter) {
        case 0:
          break;
        case 1:
          v += a;
          break;
        case 2:
          v += b;
          break;
        case 3:
          v += (a + b) >> 1;
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default:
          return null; // 未知滤波器，别冒险
      }
      out[o + x] = v & 0xff;
    }
  }

  return { width, height, channels, pixels: out };
}

// ---------------------------------------------------------------- 降采样

/**
 * 箱式（box）降采样：每个目标像素取 factor×factor 邻域的均值。
 * 比最近邻平滑得多，不会把截图里的细小文字打成雪花。
 */
export function downscale(img, factor) {
  const { width, height, channels, pixels } = img;
  if (factor <= 1) return img;

  const nw = Math.max(1, Math.floor(width / factor));
  const nh = Math.max(1, Math.floor(height / factor));
  const out = Buffer.alloc(nw * nh * channels);

  for (let y = 0; y < nh; y += 1) {
    const y0 = y * factor;
    for (let x = 0; x < nw; x += 1) {
      const x0 = x * factor;
      const acc = [0, 0, 0, 0];
      let cnt = 0;

      for (let dy = 0; dy < factor; dy += 1) {
        const sy = y0 + dy;
        if (sy >= height) break;
        const row = sy * width;
        for (let dx = 0; dx < factor; dx += 1) {
          const sx = x0 + dx;
          if (sx >= width) continue;
          const p = (row + sx) * channels;
          for (let c = 0; c < channels; c += 1) acc[c] += pixels[p + c];
          cnt += 1;
        }
      }

      const q = (y * nw + x) * channels;
      for (let c = 0; c < channels; c += 1) out[q + c] = Math.round(acc[c] / cnt);
    }
  }

  return { width: nw, height: nh, channels, pixels: out };
}

// ---------------------------------------------------------------- PNG 编码

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([len, typed, crc]);
}

/**
 * 把像素编码成 PNG。用 Sub 滤波，对截图这类渐变色块压缩率最好。
 *
 * 压缩级别默认 6（zlib 默认值），不是 9：
 *   实测 666x416 的截图，level 9 要 399ms / 131KB，level 6 只要 37ms / 140KB
 *   —— 体积只差 7%，速度快 10 倍。裁剪是在请求路径上同步跑的，
 *   这点体积换来 10 倍延迟改善明显更划算（一屏 31 张图就是 10 秒 vs 1 秒）。
 */
export function encodePng(img, level = 6) {
  const { width, height, channels, pixels } = img;
  const colorType = { 1: 0, 2: 4, 3: 2, 4: 6 }[channels];
  if (colorType === undefined) throw new Error(`unsupported channels: ${channels}`);

  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);

  for (let y = 0; y < height; y += 1) {
    const o = y * (stride + 1);
    raw[o] = 1; // Sub
    const src = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? pixels[src + x - channels] : 0;
      raw[o + 1 + x] = (pixels[src + x] - a) & 0xff;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    PNG_SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- data URL

const DATA_URL_RE = /^data:image\/png;base64,([A-Za-z0-9+/=\s]+)$/s;

/**
 * 压缩一个 data:image/png;base64 URL。
 *
 * @param {string} url
 * @param {{maxPixels:number, minBytes:number, maxInputBytes:number}} opts
 * @returns {{url:string, originalBytes:number, outBytes:number, factor:number,
 *            width:number, height:number, outWidth:number, outHeight:number}|null}
 *          返回 null 表示「这张图不处理，请原样放过」
 */
export function shrinkPngDataUrl(url, opts) {
  const m = DATA_URL_RE.exec(url);
  if (!m) return null;

  const buf = Buffer.from(m[1], 'base64');
  if (buf.length < opts.minBytes) return null;
  if (buf.length > opts.maxInputBytes) return null;

  const img = decodePng(buf);
  if (!img) return null;

  // 已经足够小就不动，避免无意义的二次编码损失
  const pixels = img.width * img.height;
  if (pixels <= opts.maxPixels) return null;

  // 按「像素数降到目标上限」估算倍率，至少 2 倍才有收益
  let factor = Math.max(2, Math.round(Math.sqrt(pixels / opts.maxPixels)));
  factor = Math.min(factor, 16);

  const small = downscale(img, factor);
  if (small.width < 160 || small.height < 100) return null;

  let enc;
  try {
    enc = encodePng(small);
  } catch {
    return null;
  }

  // 重编码反而更大（罕见：原图已是高压缩比纯色图）就没必要换
  if (enc.length >= buf.length * 0.95) return null;

  return {
    url: `data:image/png;base64,${enc.toString('base64')}`,
    originalBytes: buf.length,
    outBytes: enc.length,
    factor,
    width: img.width,
    height: img.height,
    outWidth: small.width,
    outHeight: small.height,
  };
}
