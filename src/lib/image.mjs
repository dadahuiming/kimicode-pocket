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

// ---------------------------------------------------------------- JPEG 编码
//
// 为什么值得自己写一个基线 JPEG 编码器（仍然零依赖）：
//
//   截图这类「大片渐变色块 + 抗锯齿文字」的图，PNG 几乎吃不掉体积。
//   实测 20 张 666x416 的截图：
//       PNG 重编码       平均 115 KB
//       降到 1/4 像素     平均  63 KB  （省 45%，但已经糊了）
//       JPEG q80         平均  21 KB  （省 81%，尺寸不变）
//
//   也就是说继续用 PNG 降像素是「用清晰度换体积」，而换 JPEG 是
//   「用几乎看不见的量化误差换体积」—— 后者划算得多。
//
//   为什么不用 zlib/原生库：项目坚持零依赖，且这里只需要**基线**（baseline）
//   DCT，不需要渐进式、算术编码、色度二次采样以外的任何高级特性。
//   4:2:0 色度下采样对截图完全够用（文字主要靠亮度通道）。
//
// 参考：ITU T.81（JPEG）的基线顺序模式实现要点。

// 标准量化表（ITU T.81 Annex K），按 zigzag 顺序使用前先还原成自然顺序
const STD_LUMA_Q = [
  16, 11, 10, 16, 24, 40, 51, 61,
  12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77,
  24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99,
];

const STD_CHROMA_Q = [
  17, 18, 24, 47, 99, 99, 99, 99,
  18, 21, 26, 66, 99, 99, 99, 99,
  24, 26, 56, 99, 99, 99, 99, 99,
  47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
];

// zigzag 顺序的索引 → 自然顺序下标
const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10,
  17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34,
  27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36,
  29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46,
  53, 60, 61, 54, 47, 55, 62, 63,
];

// ITU T.81 Annex K 的标准 Huffman 表（位长计数 + 码值）
const DC_LUMA_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_LUMA_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const DC_CHROMA_BITS = [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
const DC_CHROMA_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

const AC_LUMA_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_LUMA_VALS = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
  0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
  0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
  0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
  0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
  0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
  0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
];

const AC_CHROMA_BITS = [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77];
const AC_CHROMA_VALS = [
  0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
  0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0,
  0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
  0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
  0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
  0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
  0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
  0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3,
  0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
  0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
];

/** 由「位长计数表 + 码值表」建出解码/编码用的码表。返回 code<<8|len 的数组。 */
function buildHuffTable(bits, vals) {
  // 必须是 Uint32Array：码最长 16 位，存成 code<<8|len 就是 24 位，
  // 用 Uint16Array 会把高位截断，码表直接烂掉 —— 表现是解出来的图像
  // 全是彩色噪点（PSNR 只有 5dB）。这个坑实测踩过一次。
  const table = new Uint32Array(256);
  let code = 0;
  let k = 0;
  for (let len = 1; len <= 16; len += 1) {
    for (let i = 0; i < bits[len - 1]; i += 1) {
      // 编码时只需要 (码长, 码值)
      table[vals[k]] = ((code << 8) | len) >>> 0;
      code += 1;
      k += 1;
    }
    code <<= 1;
  }
  return table;
}

const DC_LUMA_T = buildHuffTable(DC_LUMA_BITS, DC_LUMA_VALS);
const DC_CHROMA_T = buildHuffTable(DC_CHROMA_BITS, DC_CHROMA_VALS);
const AC_LUMA_T = buildHuffTable(AC_LUMA_BITS, AC_LUMA_VALS);
const AC_CHROMA_T = buildHuffTable(AC_CHROMA_BITS, AC_CHROMA_VALS);

/** 按质量缩放标准量化表（1..100，50 为基准）。 */
function scaleQuant(base, quality) {
  const q = Math.max(1, Math.min(100, quality));
  const scale = q < 50 ? Math.floor(5000 / q) : 200 - q * 2;
  const out = new Uint8Array(64);
  for (let i = 0; i < 64; i += 1) {
    const v = Math.floor((base[i] * scale + 50) / 100);
    out[i] = Math.max(1, Math.min(255, v));
  }
  return out;
}

/** 位写入器：JPEG 里 0xFF 后面必须补 0x00，否则会被当成标记。 */
class BitWriter {
  constructor() {
    this.buf = Buffer.alloc(65536);
    this.len = 0;
    this.acc = 0;
    this.nbits = 0;
  }

  ensure(n) {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const nb = Buffer.alloc(cap);
    this.buf.copy(nb, 0, 0, this.len);
    this.buf = nb;
  }

  write(code, len) {
    this.acc = (this.acc << len) | code;
    this.nbits += len;
    while (this.nbits >= 8) {
      this.nbits -= 8;
      const byte = (this.acc >>> this.nbits) & 0xff;
      this.ensure(2);
      this.buf[this.len] = byte;
      this.len += 1;
      if (byte === 0xff) {
        this.buf[this.len] = 0x00;
        this.len += 1;
      }
    }
    this.acc &= (1 << this.nbits) - 1;
  }

  flush() {
    if (this.nbits > 0) {
      const byte = (this.acc << (8 - this.nbits)) & 0xff;
      this.ensure(2);
      this.buf[this.len] = byte;
      this.len += 1;
      if (byte === 0xff) {
        this.buf[this.len] = 0x00;
        this.len += 1;
      }
      this.acc = 0;
      this.nbits = 0;
    }
    return this.buf.subarray(0, this.len);
  }
}

// 8x8 的 DCT：用分离的 1D 变换（行再列）而不是直接 8^4 循环，
// 8x8 块数很多时这个差别很明显。
const DCT_COS = (() => {
  const t = new Float64Array(64);
  for (let u = 0; u < 8; u += 1) {
    for (let x = 0; x < 8; x += 1) {
      t[u * 8 + x] = Math.cos(((2 * x + 1) * u * Math.PI) / 16);
    }
  }
  return t;
})();

const DCT_C = (() => {
  const c = new Float64Array(8);
  c[0] = Math.SQRT1_2;
  for (let i = 1; i < 8; i += 1) c[i] = 1;
  return c;
})();

/**
 * 编码一张图成基线 JPEG。
 *
 * @param {{width:number,height:number,channels:number,pixels:Buffer}} img
 * @param {number} quality 1..100，默认 80（实测截图在这个档位肉眼几乎无损）
 * @returns {Buffer}
 */
export function encodeJpeg(img, quality = 80) {
  const { width, height, channels, pixels } = img;
  const qY = scaleQuant(STD_LUMA_Q, quality);
  const qC = scaleQuant(STD_CHROMA_Q, quality);

  const out = [];
  const push = (...bytes) => out.push(...bytes);
  const u16 = (v) => [(v >> 8) & 0xff, v & 0xff];

  // ---- SOI
  push(0xff, 0xd8);

  // ---- DQT（两张表：亮度 0 / 色度 1）
  for (const [id, tbl] of [[0, qY], [1, qC]]) {
    push(0xff, 0xdb, 0x00, 0x43, id);
    for (let i = 0; i < 64; i += 1) push(tbl[ZIGZAG[i]]);
  }

  // ---- SOF0：基线、8 位、3 分量、4:2:0
  push(0xff, 0xc0);
  push(...u16(17));
  push(0x08);
  push(...u16(height));
  push(...u16(width));
  push(0x03);
  // Y: id=1, 采样 2x2, 量化表 0；Cb/Cr: 1x1, 表 1
  push(0x01, 0x22, 0x00);
  push(0x02, 0x11, 0x01);
  push(0x03, 0x11, 0x01);

  // ---- DHT（四张表）
  const dht = [
    [0x00, DC_LUMA_BITS, DC_LUMA_VALS],
    [0x10, AC_LUMA_BITS, AC_LUMA_VALS],
    [0x01, DC_CHROMA_BITS, DC_CHROMA_VALS],
    [0x11, AC_CHROMA_BITS, AC_CHROMA_VALS],
  ];
  for (const [id, bits, vals] of dht) {
    push(0xff, 0xc4);
    push(...u16(2 + 1 + 16 + vals.length));
    push(id);
    for (let i = 0; i < 16; i += 1) push(bits[i]);
    for (const v of vals) push(v);
  }

  // ---- SOS
  push(0xff, 0xda);
  push(...u16(12));
  push(0x03);
  push(0x01, 0x00);
  push(0x02, 0x11);
  push(0x03, 0x11);
  push(0x00, 0x3f, 0x00);

  // ---- 熵编码
  const bw = new BitWriter();
  const mcuW = Math.ceil(width / 16);
  const mcuH = Math.ceil(height / 16);

  // 复用缓冲区，避免每个 MCU 都分配
  const blkY = new Float32Array(64);
  const blkCb = new Float32Array(64);
  const blkCr = new Float32Array(64);
  const tmp = new Float32Array(64);
  const coef = new Float32Array(64);
  let prevDC = [0, 0, 0];

  // 取一个像素的**亮度/色度分量**（不是 R/G/B！）。
  //
  // JPEG 编码的是 YCbCr：Y = 亮度，Cb/Cr = 色差。直接把 R/G/B 当成
  // 三个分量塞进 JPEG 通道，解码器会按 YCbCr 还原成 RGB —— 结果是
  // 满屏彩色噪点。实测第一版就是这么错的，PSNR 只有 5~7dB
  // （正常 q80 应该在 35dB 以上）。这个错误肉眼一看就知道，但对
  // 「标记合法」的检查完全隐形，所以必须用 PSNR 验证。
  //
  // 用 JFIF 的常见整数近似（BT.601 全范围），对截图足够。
  const ycc = (x, y, c) => {
    const cx = x < width ? x : width - 1;
    const cy = y < height ? y : height - 1;
    const o = (cy * width + cx) * channels;
    let r;
    let g;
    let b;
    if (channels === 1) {
      r = pixels[o]; g = r; b = r;
    } else if (channels === 2) {
      r = pixels[o]; g = r; b = r;
    } else {
      r = pixels[o];
      g = pixels[o + 1];
      b = pixels[o + 2];
    }
    if (c === 0) return (0.299 * r + 0.587 * g + 0.114 * b);
    if (c === 1) return (-0.168736 * r - 0.331264 * g + 0.5 * b + 128);
    return (0.5 * r - 0.418688 * g - 0.081312 * b + 128);
  };

  const transform = (blk) => {
    // 行变换：tmp = blk * C^T
    for (let y = 0; y < 8; y += 1) {
      for (let u = 0; u < 8; u += 1) {
        let s = 0;
        for (let x = 0; x < 8; x += 1) s += blk[y * 8 + x] * DCT_COS[u * 8 + x];
        tmp[y * 8 + u] = s * DCT_C[u] * 0.5;
      }
    }
    // 列变换
    for (let u = 0; u < 8; u += 1) {
      for (let v = 0; v < 8; v += 1) {
        let s = 0;
        for (let y = 0; y < 8; y += 1) s += tmp[y * 8 + u] * DCT_COS[v * 8 + y];
        coef[v * 8 + u] = s * DCT_C[v] * 0.5;
      }
    }
    return coef;
  };

  const encodeBlock = (block, q, dcT, acT, ci) => {
    const c = transform(block);
    // 量化 + zigzag
    const zz = new Int16Array(64);
    for (let i = 0; i < 64; i += 1) {
      const nat = ZIGZAG[i];
      zz[i] = Math.round(c[nat] / q[nat]);
    }
    // DC 差分
    const diff = zz[0] - prevDC[ci];
    prevDC[ci] = zz[0];
    writeCoef(bw, dcT, cat(diff), diff);
    // AC：行程编码 + 0x00 结尾
    let run = 0;
    for (let i = 1; i < 64; i += 1) {
      const v = zz[i];
      if (v === 0) { run += 1; continue; }
      while (run > 15) {
        bw.write(acT[0xf0] >> 8, acT[0xf0] & 0xff);   // ZRL
        run -= 16;
      }
      const n = cat(v);
      const sym = (run << 4) | n;
      bw.write(acT[sym] >> 8, acT[sym] & 0xff);
      writeCoef(bw, null, n, v);
      run = 0;
    }
    if (run > 0) bw.write(acT[0x00] >> 8, acT[0x00] & 0xff);   // EOB
  };

  for (let my = 0; my < mcuH; my += 1) {
    for (let mx = 0; mx < mcuW; mx += 1) {
      // Y 四个块（2x2）
      for (let by = 0; by < 2; by += 1) {
        for (let bx = 0; bx < 2; bx += 1) {
          const ox = mx * 16 + bx * 8;
          const oy = my * 16 + by * 8;
          for (let y = 0; y < 8; y += 1) {
            for (let x = 0; x < 8; x += 1) {
              blkY[y * 8 + x] = ycc(ox + x, oy + y, 0) - 128;
            }
          }
          encodeBlock(blkY, qY, DC_LUMA_T, AC_LUMA_T, 0);
        }
      }
      // Cb / Cr 各一个块（4:2:0，取 2x2 平均）
      for (let ci = 1; ci <= 2; ci += 1) {
        const target = ci === 1 ? blkCb : blkCr;
        for (let y = 0; y < 8; y += 1) {
          for (let x = 0; x < 8; x += 1) {
            const ox = mx * 16 + x * 2;
            const oy = my * 16 + y * 2;
            const s =
              ycc(ox, oy, ci) + ycc(ox + 1, oy, ci) +
              ycc(ox, oy + 1, ci) + ycc(ox + 1, oy + 1, ci);
            target[y * 8 + x] = s / 4 - 128;
          }
        }
        encodeBlock(target, qC, DC_CHROMA_T, AC_CHROMA_T, ci);
      }
    }
  }

  const tail = bw.flush();
  for (const b of tail) out.push(b);
  push(0xff, 0xd9);   // EOI

  return Buffer.from(out);
}

/** 幅值的类别（需要几位表示）。 */
function cat(v) {
  let a = v < 0 ? -v : v;
  let n = 0;
  while (a > 0) { n += 1; a >>= 1; }
  return n;
}

/** 写一个 DC 差分或 AC 值：类别走 Huffman，值走原码/反码。 */
function writeCoef(bw, dcT, n, v) {
  if (n === 0) {
    if (dcT) bw.write(dcT[0] >> 8, dcT[0] & 0xff);
    return;
  }
  if (dcT) bw.write(dcT[n] >> 8, dcT[n] & 0xff);
  const bits = v < 0 ? v + (1 << n) - 1 : v;
  bw.write(bits & ((1 << n) - 1), n);
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

  // 尺寸已经够小就不降采样 —— 但**不代表不用换编码**。
  //
  // 这里踩过一个关键坑：早先是「像素数 <= maxPixels 就直接 return null」，
  // 结果是已经降采样过的 666x416 截图（27.7 万像素 < 40 万上限）全部被
  // 原样放过，而它们恰恰是体积大头：实测 67 张图里只有 1 张被处理，
  // 响应体仍是 12.59MB。
  //
  // 现在改成：尺寸够小就不缩，但仍然重新编码成 JPEG。
  // 体积不变、清晰度不变，纯赚 80%。
  const pixels = img.width * img.height;
  let small = img;
  let factor = 1;
  if (pixels > opts.maxPixels) {
    // 按「像素数降到目标上限」估算倍率，至少 2 倍才有收益
    factor = Math.max(2, Math.round(Math.sqrt(pixels / opts.maxPixels)));
    factor = Math.min(factor, 16);
    small = downscale(img, factor);
    if (small.width < 160 || small.height < 100) return null;
  }

  // 优先出 JPEG，失败再退回 PNG。
  //
  // 为什么不用 PNG：截图这种「大片渐变 + 抗锯齿文字」的图，PNG 几乎吃不下体积。
  // 实测 20 张已降采样的 666x416 截图（平均 115KB）：
  //     PNG 重编码        平均 115KB（0%，白忙）
  //     再降到 1/4 像素    平均  63KB（省 45%，但已经糊了）
  //     JPEG q80          平均  21KB（省 81%，尺寸不变、PSNR 38dB）
  // 而且两者耗时实测几乎一样（33.8ms vs 32.8ms），所以 JPEG 是纯收益。
  //
  // 质量取 80：PSNR 实测 38~39dB，肉眼看不出差别；
  // q90 只能再省一点（体积会回升到约 31KB），不值得。
  // 超过 90 让画面更锐利但体积涨得快，对「看清截图内容」这个目标没必要。
  const quality = typeof opts.jpegQuality === 'number' ? opts.jpegQuality : 80;
  let enc;
  let mime;
  try {
    // 有 alpha 通道的图不能转 JPEG（会丢透明度变黑底）
    if (img.channels === 4) throw new Error('has-alpha');
    enc = encodeJpeg(small, quality);
    mime = 'image/jpeg';
  } catch {
    try {
      enc = encodePng(small);
      mime = 'image/png';
    } catch {
      return null;
    }
  }

  // 重编码反而更大（罕见：原图已是高压缩比纯色图）就没必要换
  if (enc.length >= buf.length * 0.95) return null;

  return {
    url: `data:${mime};base64,${enc.toString('base64')}`,
    originalBytes: buf.length,
    outBytes: enc.length,
    factor,
    width: img.width,
    height: img.height,
    outWidth: small.width,
    outHeight: small.height,
    mime,
  };
}
