/**
 * KimiCode Pocket — 零依赖二维码编码器
 *
 * 为什么自己写：本项目的卖点之一是「零依赖、不 npm install」。为了在终端和
 * 配对页上出二维码而引入 qrcode / qrcode-terminal，等于为了一个附加功能破坏
 * 核心承诺。所以这里按 ISO/IEC 18004 自己实现一份最小可用的编码器。
 *
 * 支持范围（够用即止，不做全量）：
 *   - 模式：Byte（8-bit）——配对 URL 全是 ASCII，够用
 *   - ECC ：L / M / Q / H
 *   - 版本：1 ~ 40（自动选最小可用版本）
 *   - 掩码：按惩罚分自动选优，也支持强制指定
 *
 * 不做：Numeric / Alphanumeric / Kanji / ECI / FNC1 / 结构化追加。
 *
 * 正确性验证：test/qr.test.mjs 用真值表交叉校验编码结果；仓库外的开发期
 * 还对拍过 qrcode@1.x 的模块矩阵（8 种掩码逐一比对），见 CHANGELOG。
 */

// ---- 标准常量表（来自 ISO/IEC 18004 表 9 / 表 7，属规范事实）----------------

import { deflateSync } from 'node:zlib';

// 每个版本、每个纠错等级的分块数。顺序 L M Q H，版本 1..40。
const EC_BLOCKS = [
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 1, 2, 2, 4, 1, 2, 4, 4,
  2, 4, 4, 4, 2, 4, 6, 5, 2, 4, 6, 6, 2, 5, 8, 8, 4, 5, 8, 8,
  4, 5, 8, 11, 4, 8, 10, 11, 4, 9, 12, 16, 4, 9, 16, 16, 6, 10, 12, 18,
  6, 10, 17, 16, 6, 11, 16, 19, 6, 13, 18, 21, 7, 14, 21, 25, 8, 16, 20, 25,
  8, 17, 23, 25, 9, 17, 23, 34, 9, 18, 25, 30, 10, 20, 27, 32, 12, 21, 29, 35,
  12, 23, 34, 37, 12, 25, 34, 40, 13, 26, 35, 42, 14, 28, 38, 45, 15, 29, 40, 48,
  16, 31, 43, 51, 17, 33, 45, 54, 18, 35, 48, 57, 19, 37, 51, 60, 19, 38, 53, 63,
  20, 40, 56, 66, 21, 43, 59, 70, 22, 45, 62, 74, 24, 47, 65, 77, 25, 49, 68, 81,
];

// 每个版本、每个纠错等级的纠错码字总数。顺序 L M Q H。
const EC_CODEWORDS = [
  7, 10, 13, 17, 10, 16, 22, 28, 15, 26, 36, 44, 20, 36, 52, 64,
  26, 48, 72, 88, 36, 64, 96, 112, 40, 72, 108, 130, 48, 88, 132, 156,
  60, 110, 160, 192, 72, 130, 192, 224, 80, 150, 224, 264, 96, 176, 260, 308,
  104, 198, 288, 352, 120, 216, 320, 384, 132, 240, 360, 432, 144, 280, 408, 480,
  168, 308, 448, 532, 180, 338, 504, 588, 196, 364, 546, 650, 224, 416, 600, 700,
  224, 442, 644, 750, 252, 476, 690, 816, 270, 504, 750, 900, 300, 560, 810, 960,
  312, 588, 870, 1050, 336, 644, 952, 1110, 360, 700, 1020, 1200, 390, 728, 1050, 1260,
  420, 784, 1140, 1350, 450, 812, 1200, 1440, 480, 868, 1290, 1530, 510, 924, 1350, 1620,
  540, 980, 1440, 1710, 570, 1036, 1530, 1800, 570, 1064, 1590, 1890, 600, 1120, 1680, 1980,
  630, 1204, 1770, 2100, 660, 1260, 1860, 2220, 720, 1316, 1950, 2310, 750, 1372, 2040, 2430,
];

// 每个版本的总码字数（数据 + 纠错），下标即版本号。
const TOTAL_CODEWORDS = [
  0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346,
  404, 466, 532, 581, 655, 733, 815, 901, 991, 1085,
  1156, 1258, 1364, 1474, 1588, 1706, 1828, 1921, 2051, 2185,
  2323, 2465, 2611, 2761, 2876, 3034, 3196, 3362, 3532, 3706,
];

// 纠错等级：ord 是表内偏移，bit 是写进格式信息的 2 位值
const ECL = {
  L: { ord: 0, bit: 1 },
  M: { ord: 1, bit: 0 },
  Q: { ord: 2, bit: 3 },
  H: { ord: 3, bit: 2 },
};

// ---- GF(256) ---------------------------------------------------------------
// 本原多项式 x^8 + x^4 + x^3 + x^2 + 1 = 0x11D

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/** 生成 n 个纠错码字所需的生成多项式（系数从高次到低次，首项恒为 1） */
function rsGenPoly(n) {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      next[j + 1] ^= gfMul(g[j], EXP[i]);
    }
    g = next;
  }
  return g;
}

/** 对一个数据块求纠错码字 */
function rsEncode(block, ecLen) {
  const gen = rsGenPoly(ecLen);
  const buf = new Uint8Array(block.length + ecLen);
  buf.set(block, 0);
  for (let i = 0; i < block.length; i++) {
    const coef = buf[i];
    if (coef === 0) continue;
    for (let j = 1; j < gen.length; j++) buf[i + j] ^= gfMul(gen[j], coef);
  }
  return buf.subarray(block.length);
}

// ---- 版本与容量 ------------------------------------------------------------

function symbolSize(version) {
  return version * 4 + 17;
}

function dataCodewords(version, ecl) {
  return TOTAL_CODEWORDS[version] - EC_CODEWORDS[(version - 1) * 4 + ECL[ecl].ord];
}

/** Byte 模式下某版本可容纳的字节数 */
function capacityBytes(version, ecl) {
  const ccBits = version < 10 ? 8 : 16;
  const usable = dataCodewords(version, ecl) * 8 - 4 - ccBits;
  return Math.max(0, Math.floor(usable / 8));
}

function pickVersion(byteLen, ecl) {
  for (let v = 1; v <= 40; v++) {
    if (byteLen <= capacityBytes(v, ecl)) return v;
  }
  throw new Error(`内容过长（${byteLen} 字节），超出二维码容量上限`);
}

// ---- 位缓冲 ----------------------------------------------------------------

class BitBuffer {
  constructor() {
    this.bits = [];
  }
  push(value, length) {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
  get length() {
    return this.bits.length;
  }
}

// ---- 数据码字 --------------------------------------------------------------

function buildCodewords(text, version, ecl) {
  const data = Buffer.from(text, 'utf8');
  const buf = new BitBuffer();
  buf.push(0b0100, 4); // Byte 模式
  buf.push(data.length, version < 10 ? 8 : 16);

  for (const byte of data) buf.push(byte, 8);

  const totalDataBytes = dataCodewords(version, ecl);

  // 终止符最多 4 位
  const term = Math.min(4, totalDataBytes * 8 - buf.length);
  buf.push(0, term);
  // 补齐到字节边界
  while (buf.length % 8 !== 0) buf.bits.push(0);

  const codewords = [];
  for (let i = 0; i < buf.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | buf.bits[i + j];
    codewords.push(b);
  }
  // 交替填充 0xEC / 0x11
  for (let i = 0; codewords.length < totalDataBytes; i++) {
    codewords.push(i % 2 === 0 ? 0xec : 0x11);
  }
  return codewords;
}

/** 分块 + 纠错 + 交织，得到最终码字序列 */
function interleave(dataWords, version, ecl) {
  const numBlocks = EC_BLOCKS[(version - 1) * 4 + ECL[ecl].ord];
  const ecTotal = EC_CODEWORDS[(version - 1) * 4 + ECL[ecl].ord];
  const ecPerBlock = ecTotal / numBlocks;
  const totalData = dataWords.length;
  const shortLen = Math.floor(totalData / numBlocks);
  const longCount = totalData % numBlocks;

  const blocks = [];
  let offset = 0;
  for (let i = 0; i < numBlocks; i++) {
    const len = shortLen + (i >= numBlocks - longCount ? 1 : 0);
    const data = Uint8Array.from(dataWords.slice(offset, offset + len));
    offset += len;
    blocks.push({ data, ec: rsEncode(data, ecPerBlock) });
  }

  const out = [];
  const maxLen = shortLen + (longCount > 0 ? 1 : 0);
  for (let i = 0; i < maxLen; i++) {
    for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const b of blocks) out.push(b.ec[i]);
  }
  return out;
}

// ---- 矩阵构建 --------------------------------------------------------------

function alignmentCoords(version) {
  if (version === 1) return [];
  const posCount = Math.floor(version / 7) + 2;
  const size = symbolSize(version);
  const intervals = size === 145 ? 26 : Math.ceil((size - 13) / (2 * posCount - 2)) * 2;
  const positions = [size - 7];
  for (let i = 1; i < posCount - 1; i++) positions[i] = positions[i - 1] - intervals;
  positions.push(6);
  return positions.reverse();
}

const MASK_FN = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r * c) % 3) + ((r + c) % 2)) % 2 === 0,
];

const G15 = 0b10100110111;
const G15_MASK = 0b101010000010010;

function bchDigit(data) {
  let n = 0;
  while (data !== 0) {
    n++;
    data >>>= 1;
  }
  return n;
}

function formatBits(eclBit, mask) {
  const data = (eclBit << 3) | mask;
  let d = data << 10;
  while (bchDigit(d) - bchDigit(G15) >= 0) d ^= G15 << (bchDigit(d) - bchDigit(G15));
  return ((data << 10) | d) ^ G15_MASK;
}

function versionBits(version) {
  const G18 = (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | 1;
  let d = version << 12;
  while (bchDigit(d) - bchDigit(G18) >= 0) d ^= G18 << (bchDigit(d) - bchDigit(G18));
  return (version << 12) | d;
}

function buildMatrix(version, ecl, codewords, mask) {
  const size = symbolSize(version);
  const mod = new Uint8Array(size * size);
  const fun = new Uint8Array(size * size);
  const at = (r, c) => r * size + c;
  const setFun = (r, c, v) => {
    if (r < 0 || c < 0 || r >= size || c >= size) return;
    mod[at(r, c)] = v ? 1 : 0;
    fun[at(r, c)] = 1;
  };

  // 定位图案（含 1 模块白边分隔符）
  const drawFinder = (r0, c0) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = r0 + dr;
        const c = c0 + dc;
        if (r < 0 || c < 0 || r >= size || c >= size) continue;
        if (dr < 0 || dr > 6 || dc < 0 || dc > 6) {
          setFun(r, c, 0); // 分隔符
        } else {
          const d = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
          setFun(r, c, d !== 2 ? 1 : 0);
        }
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // 定时图案
  for (let i = 8; i < size - 8; i++) {
    const v = i % 2 === 0 ? 1 : 0;
    setFun(6, i, v);
    setFun(i, 6, v);
  }

  // 校正图案
  const coords = alignmentCoords(version);
  for (const r of coords) {
    for (const c of coords) {
      if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const d = Math.max(Math.abs(dr), Math.abs(dc));
          setFun(r + dr, c + dc, d !== 1 ? 1 : 0);
        }
      }
    }
  }

  // 先占位格式信息区域（真实值在掩码之后写）
  const drawFormat = (m) => {
    const bits = formatBits(ECL[ecl].bit, m);
    const bit = (i) => (bits >>> i) & 1;
    for (let i = 0; i <= 5; i++) setFun(i, 8, bit(i));
    setFun(7, 8, bit(6));
    setFun(8, 8, bit(7));
    setFun(8, 7, bit(8));
    for (let i = 9; i < 15; i++) setFun(8, 14 - i, bit(i));
    // 第二副本：8 位在 row 8 右侧，7 位在 col 8 下侧
    for (let i = 0; i < 8; i++) setFun(8, size - 1 - i, bit(i));
    for (let i = 8; i < 15; i++) setFun(size - 15 + i, 8, bit(i));
    setFun(size - 8, 8, 1); // 恒暗模块
  };
  drawFormat(0);

  // 版本信息（v7+）
  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const b = (bits >>> i) & 1;
      setFun(Math.floor(i / 3), size - 11 + (i % 3), b);
      setFun(size - 11 + (i % 3), Math.floor(i / 3), b);
    }
  }

  // 数据区填充（右下起，两列一组蛇形）
  let idx = 0;
  const totalBits = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        const upward = ((right + 1) & 2) === 0;
        const r = upward ? size - 1 - vert : vert;
        if (fun[at(r, c)]) continue;
        if (idx < totalBits) {
          mod[at(r, c)] = (codewords[idx >>> 3] >>> (7 - (idx & 7))) & 1;
          idx++;
        }
      }
    }
  }

  // 掩码
  const fn = MASK_FN[mask];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (fun[at(r, c)]) continue;
      if (fn(r, c)) mod[at(r, c)] ^= 1;
    }
  }

  // 写真实格式信息
  drawFormat(mask);

  return { size, modules: mod, isFunction: fun };
}

// ---- 掩码评分 --------------------------------------------------------------

function penalty(m) {
  const { size, modules } = m;
  const get = (r, c) => modules[r * size + c];
  let score = 0;

  // N1：同色连续 >= 5
  for (let r = 0; r < size; r++) {
    for (const horizontal of [true, false]) {
      let run = 1;
      for (let i = 1; i < size; i++) {
        const prev = horizontal ? get(r, i - 1) : get(i - 1, r);
        const cur = horizontal ? get(r, i) : get(i, r);
        if (cur === prev) run++;
        else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  }

  // N2：2x2 同色块
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = get(r, c);
      if (v === get(r, c + 1) && v === get(r + 1, c) && v === get(r + 1, c + 1)) score += 3;
    }
  }

  // N3：形似定位图案的 1:1:3:1:1 序列
  const P1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const P2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c <= size - 11; c++) {
      for (const pat of [P1, P2]) {
        let ok = true;
        for (let k = 0; k < 11; k++) {
          if (get(r, c + k) !== pat[k]) {
            ok = false;
            break;
          }
        }
        if (ok) score += 40;
      }
    }
  }
  for (let c = 0; c < size; c++) {
    for (let r = 0; r <= size - 11; r++) {
      for (const pat of [P1, P2]) {
        let ok = true;
        for (let k = 0; k < 11; k++) {
          if (get(r + k, c) !== pat[k]) {
            ok = false;
            break;
          }
        }
        if (ok) score += 40;
      }
    }
  }

  // N4：深色比例偏离 50%
  let dark = 0;
  for (let i = 0; i < modules.length; i++) dark += modules[i];
  const pct = Math.floor((dark * 100) / modules.length);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;

  return score;
}

// ---- 对外 API --------------------------------------------------------------

/**
 * 编码为模块矩阵
 * @param {string} text
 * @param {{ecc?: 'L'|'M'|'Q'|'H', mask?: number}} [opts]
 * @returns {{size:number, modules:Uint8Array, version:number, ecc:string, mask:number}}
 */
export function encode(text, opts = {}) {
  const ecc = opts.ecc ?? 'M';
  if (!ECL[ecc]) throw new Error(`未知纠错等级: ${ecc}`);

  const data = Buffer.from(text, 'utf8');
  const version = opts.version ?? pickVersion(data.length, ecc);
  const codewords = interleave(buildCodewords(text, version, ecc), version, ecc);

  if (opts.mask !== undefined) {
    const m = buildMatrix(version, ecc, codewords, opts.mask);
    return { size: m.size, modules: m.modules, version, ecc, mask: opts.mask };
  }

  let best = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const m = buildMatrix(version, ecc, codewords, mask);
    const s = penalty(m);
    if (s < bestScore) {
      bestScore = s;
      best = mask;
    }
  }
  const m = buildMatrix(version, ecc, codewords, best);
  return { size: m.size, modules: m.modules, version, ecc, mask: best };
}

/** 渲染成 SVG（白底、深色模块，极性正确，可直接嵌进 HTML） */
export function toSvg(qr, { scale = 8, quiet = 4, dark = '#111827', light = '#ffffff' } = {}) {
  const { size, modules } = qr;
  const dim = (size + quiet * 2) * scale;
  const rects = [];
  for (let r = 0; r < size; r++) {
    let c = 0;
    while (c < size) {
      if (!modules[r * size + c]) {
        c++;
        continue;
      }
      let run = 0;
      while (c + run < size && modules[r * size + c + run]) run++;
      rects.push(
        `<rect x="${(c + quiet) * scale}" y="${(r + quiet) * scale}" width="${run * scale}" height="${scale}"/>`,
      );
      c += run;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges">` +
    `<rect width="${dim}" height="${dim}" fill="${light}"/>` +
    `<g fill="${dark}">${rects.join('')}</g></svg>`
  );
}

/** 渲染成终端字符画（半块字符，一行两模块） */
export function toTerminal(qr, { quiet = 2 } = {}) {
  const { size, modules } = qr;
  const darkAt = (r, c) => {
    const rr = r - quiet;
    const cc = c - quiet;
    if (rr < 0 || cc < 0 || rr >= size || cc >= size) return false;
    return modules[rr * size + cc] === 1;
  };
  const lines = [];
  for (let r = 0; r < size + quiet * 2; r += 2) {
    let line = '';
    for (let c = 0; c < size + quiet * 2; c++) {
      const top = darkAt(r, c);
      const bot = darkAt(r + 1, c);
      line += top && bot ? '█' : top ? '▀' : bot ? '▄' : ' ';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

// ---- PNG 输出（自己实现，避免引入图像库）-----------------------------------

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (const b of buf) crc = (crc >>> 8) ^ crcTable[(crc ^ b) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** 输出 8-bit 灰度 PNG Buffer */
export function toPng(qr, { scale = 8, quiet = 4 } = {}) {
  const { size, modules } = qr;
  const dim = (size + quiet * 2) * scale;

  const raw = Buffer.alloc((dim + 1) * dim, 0xff);
  for (let y = 0; y < dim; y++) {
    const rowStart = y * (dim + 1);
    raw[rowStart] = 0; // filter: none
    const my = Math.floor(y / scale) - quiet;
    for (let x = 0; x < dim; x++) {
      const mx = Math.floor(x / scale) - quiet;
      const dark =
        my >= 0 && my < size && mx >= 0 && mx < size && modules[my * size + mx] === 1;
      raw[rowStart + 1 + x] = dark ? 0x11 : 0xff;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(dim, 0);
  ihdr.writeUInt32BE(dim, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = deflateSync(raw, { level: 9 });

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
