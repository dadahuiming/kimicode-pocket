import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { encode, toSvg, toTerminal, toPng } from '../src/lib/qr.mjs';

/** 对模块矩阵取指纹，用来锁死"编码结果不许悄悄变" */
function fingerprint(qr) {
  return createHash('sha256').update(Buffer.from(qr.modules)).digest('hex').slice(0, 16);
}

// 这些期望值由「与 qrcode@1.x 逐模块对拍通过」的实现产出，作为回归基线。
const VECTORS = [
  { text: 'hello', ecc: 'M', version: 1, size: 21, mask: 0, hash: '19cb2fb2c3452552' },
  {
    text: 'https://abc-def-ghi.trycloudflare.com/__pair?code=123456',
    ecc: 'M',
    version: 4,
    size: 33,
    mask: 2,
    hash: 'fde9d5aa58559325',
  },
  {
    text: 'https://xx.trycloudflare.com/__pair?code=987654',
    ecc: 'L',
    version: 3,
    size: 29,
    mask: 0,
    hash: '3fe1d2b18ef7af30',
  },
  { text: 'a'.repeat(200), ecc: 'Q', version: 12, size: 65, mask: 1, hash: 'e35bcf540f9c4210' },
];

for (const v of VECTORS) {
  test(`编码矩阵稳定：${v.text.length} 字节 / ECC ${v.ecc}`, () => {
    const qr = encode(v.text, { ecc: v.ecc });
    assert.equal(qr.version, v.version);
    assert.equal(qr.size, v.size);
    assert.equal(qr.mask, v.mask);
    assert.equal(qr.modules.length, v.size * v.size);
    assert.equal(fingerprint(qr), v.hash);
  });
}

test('版本自动选择：内容越长版本越大', () => {
  const versions = [1, 20, 80, 200, 600].map((n) => encode('a'.repeat(n), { ecc: 'M' }).version);
  for (let i = 1; i < versions.length; i++) {
    assert.ok(versions[i] >= versions[i - 1], `第 ${i} 项版本应不小于前一项`);
  }
});

test('同一内容在不同 ECC 等级下都是合法方阵', () => {
  for (const ecc of ['L', 'M', 'Q', 'H']) {
    const qr = encode('https://example.com/__pair?code=123456', { ecc });
    assert.equal(qr.modules.length, qr.size * qr.size);
    // 定位图案左上角 (0,0) 必须是暗模块
    assert.equal(qr.modules[0], 1);
    // 左上定位图案中心 3x3 全暗
    for (const [r, c] of [
      [2, 2],
      [3, 3],
      [4, 4],
    ]) {
      assert.equal(qr.modules[r * qr.size + c], 1);
    }
    // 定位图案与中心之间的白环 (1,1) 必须是亮模块
    assert.equal(qr.modules[1 * qr.size + 1], 0);
  }
});

test('四个角都有定位图案（右上/左下）', () => {
  const qr = encode('test', { ecc: 'M' });
  const n = qr.size;
  // 右上定位图案外框暗
  assert.equal(qr.modules[0 * n + (n - 1)], 1);
  // 左下定位图案外框暗
  assert.equal(qr.modules[(n - 1) * n + 0], 1);
});

test('强制 mask 参数生效', () => {
  for (let mask = 0; mask < 8; mask++) {
    assert.equal(encode('hello', { ecc: 'M', mask }).mask, mask);
  }
});

test('超长内容抛错而不是静默截断', () => {
  assert.throws(() => encode('a'.repeat(5000), { ecc: 'H' }), /超出二维码容量/);
});

test('未知 ECC 等级抛错', () => {
  assert.throws(() => encode('x', { ecc: 'Z' }), /未知纠错等级/);
});

test('SVG 输出结构与极性', () => {
  const svg = toSvg(encode('hello', { ecc: 'M' }));
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.ok(svg.includes('fill="#ffffff"'), '必须有白色底（极性正确）');
  assert.ok(svg.includes('<rect'), '必须有深色模块');
  assert.ok(svg.trim().endsWith('</svg>'));
});

test('终端字符画行数与宽度正确', () => {
  const qr = encode('hello', { ecc: 'M' });
  const lines = toTerminal(qr, { quiet: 2 }).split('\n');
  assert.equal(lines.length, Math.ceil((qr.size + 4) / 2));
  assert.equal([...lines[0]].length, qr.size + 4);
});

test('PNG 是合法文件头，且尺寸含静区', () => {
  const qr = encode('hello', { ecc: 'M' });
  const png = toPng(qr, { scale: 4, quiet: 4 });
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.equal(png.subarray(12, 16).toString('ascii'), 'IHDR');
  const width = png.readUInt32BE(16);
  assert.equal(width, (qr.size + 8) * 4);
  assert.equal(png.subarray(png.length - 8, png.length - 4).toString('ascii'), 'IEND');
});
