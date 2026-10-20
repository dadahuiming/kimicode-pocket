/**
 * worker 池的**端到端冒烟测试**（直接打真实模块 + 真实 worker 线程）。
 *
 * ⚠️ 诚实说明它**测不到什么**：
 *
 * 这些测试只覆盖「正常路径」——冷启动、并发去重、多图不错投、
 * shutdown 后能重建。它们**无法捕获**调度器的异常时序缺陷。
 *
 * 实测证据（变异测试）：把下面三处修复分别删掉，本文件依然 4/4 全绿：
 *   - `msg.id !== job.id` 的校验
 *   - worker exit(0) 时的 slot 回收
 *   - 超时分支的 worker 销毁
 *
 * 原因是真实图片几乎不会超过 20 秒，那条超时路径永远走不到；
 * 而 worker 也不会在测试期间空闲 30 秒自杀。
 *
 * 真正锁住这些缺陷的是 `test/pool-sched.test.mjs` —— 它注入可控时序的
 * 假 worker，直接跑 `src/lib/pool.mjs` 的生产代码，精确构造
 * 「超时 / 迟到 / 自杀 / 持任务退出」，每条都做过变异验证。
 *
 * 所以这两个文件的分工是：
 *   pool.test.mjs       → 真实 worker 能不能正常干活（冒烟）
 *   pool-sched.test.mjs → 异常时序下的状态机是否正确（回归防线）
 *
 * 这里曾经在注释里宣称自己「锁住了那两个缺陷」，属于文档与实测不符，
 * 已按审计意见更正。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import { shrinkAsync, poolStats, shutdownWorkers, clearAsyncCaches } from '../src/lib/image-async.mjs';

// ---- 造一张真实可压缩的 PNG（纯 data URL，不落盘）------------------------

function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n += 1) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

/** 生成 W×H 的渐变 PNG data URL（渐变能压，随机噪声不能） */
function makeGradientPngUrl(W = 256, H = 256) {
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y += 1) {
    raw[y * (W * 3 + 1)] = 0; // filter: none
    for (let x = 0; x < W; x += 1) {
      const o = y * (W * 3 + 1) + 1 + x * 3;
      raw[o] = x & 0xff;
      raw[o + 1] = y & 0xff;
      raw[o + 2] = (x ^ y) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

const OPTS = { maxPixels: 1024 * 1024, quality: 80 };

after(async () => {
  await shutdownWorkers();
});

test('池：冷启动能压缩出结果（真模块，非逻辑复刻）', async () => {
  clearAsyncCaches();
  const t0 = Date.now();
  const r = await shrinkAsync(makeGradientPngUrl(256, 256), OPTS);
  const ms = Date.now() - t0;
  assert.ok(r, '应该拿到压缩结果');
  assert.match(r.url, /^data:image\/(jpeg|png)/, '输出应该是图片 data URL');
  assert.ok(ms < 10000, `冷启动不该慢到 ${ms}ms`);
});

test('池：worker 全死后能重建（冒烟，非 exit 回收的证明）', async () => {
  // 线上必然触发：image-worker.mjs 里 idleTimer 空闲 30 秒就 process.exit(0)。
  // 旧代码 `if (code !== 0 && worker.__current) fail(...)` 对 code 0 什么都不做，
  // pool 里留着已死线程的 slot；往死 worker postMessage **不会抛错**（实测），
  // 消息石沉大海 —— 任务只能等满 20s 超时再降级主线程。
  //
  // ⚠️ 但这条测试**证明不了** exit 回收修好了：实测把 exit 回调还原成旧写法，
  // 它依然通过（因为 shutdownWorkers 是主动 terminate，slot 被直接清空，
  // 走不到「worker 自己 exit(0)」那条路径）。
  // 真正验证的是 pool-sched.test.mjs 里那条「worker exit(0) 也必须回收」。
  // 实测旧版本（4 worker 全自杀后）：20007 / 20006 / 20012ms。
  clearAsyncCaches();
  await shrinkAsync(makeGradientPngUrl(128, 128), OPTS);
  assert.ok(poolStats().poolSize > 0, '池应该已建立');

  // shutdownWorkers 把所有 worker terminate —— 等价于 idle 自杀，
  // 但不用真的等 30 秒。修复后 exit 事件会无条件回收 slot，
  // 所以 shutdown 之后 poolSize 必须是 0（旧代码会残留）。
  await shutdownWorkers();
  assert.equal(poolStats().poolSize, 0, 'shutdown 后池必须干净（残留即僵尸 slot）');

  clearAsyncCaches();
  const t0 = Date.now();
  const r = await shrinkAsync(makeGradientPngUrl(256, 256), OPTS);
  const ms = Date.now() - t0;
  assert.ok(r, '池重建后应该能正常压缩');
  assert.ok(ms < 10000, `重建后首次处理不该慢到 ${ms}ms（僵尸 slot 会让它 ~20s）`);
  assert.ok(poolStats().poolSize > 0, '处理完池应该还在');
});

test('池：同一张图并发只算一次，结果一致', async () => {
  clearAsyncCaches();
  const url = makeGradientPngUrl(200, 200);
  const [a, b, c] = await Promise.all([
    shrinkAsync(url, OPTS),
    shrinkAsync(url, OPTS),
    shrinkAsync(url, OPTS),
  ]);
  assert.ok(a && b && c, '三个都应该有结果');
  assert.equal(a.url, b.url, '并发去重后结果必须一致');
  assert.equal(a.url, c.url, '并发去重后结果必须一致');
});

test('池：多张不同图片并发，结果不会串（冒烟，非 id 校验的证明）', async () => {
  // 每张图内容不同 → 压缩结果必然不同。
  // 这条只能证明「正常并发下不会串」，**不能**证明 id 校验有效：
  // 实测把 `msg.id !== job.id` 删掉，这条依然通过（正常路径不会超时，
  // 也就没有迟到消息）。真正验证 id 校验的是 pool-sched.test.mjs。
  clearAsyncCaches();
  const urls = [
    makeGradientPngUrl(180, 180),
    makeGradientPngUrl(220, 220),
    makeGradientPngUrl(260, 260),
    makeGradientPngUrl(300, 300),
  ];
  const results = await Promise.all(urls.map((u) => shrinkAsync(u, OPTS)));
  assert.equal(results.length, 4);
  for (const r of results) assert.ok(r, '每张都应该有结果');

  // 每张图的结果必须与「单独处理它」得到的结果完全一致
  for (let i = 0; i < urls.length; i += 1) {
    const solo = await shrinkAsync(urls[i], { ...OPTS });
    // solo 会命中缓存，但缓存键是内容哈希，所以这里比较的是同一张图的结果
    assert.equal(results[i].url, solo.url, `第 ${i} 张图的结果被串了 —— 错投回归`);
  }

  // 不同尺寸的图压出来不该全都一样（否则说明真的串了）
  const uniq = new Set(results.map((r) => r.url));
  assert.ok(uniq.size > 1, '4 张不同的图压出了同一个结果 —— 严重错投');
});
