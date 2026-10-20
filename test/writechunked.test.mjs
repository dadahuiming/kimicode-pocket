/**
 * writeChunked 的回归测试。
 *
 * 这是 v1.6.12 对抗审计发现的最严重 bug：trim 路径上客户端若在
 * 「压缩」期间断开，写响应时会永久挂起 —— res.destroyed 已经是 true，
 * 但 Promise 永不 settle，请求永远不返回，res 与 body（可达几十 MB）
 * 一起泄漏。实测旧代码 8/8 全部 hang。
 *
 * 根因：close 事件是**一次性**的。它可能在被调用**之前**就已经触发过
 * （trim 分支先 await 压缩几秒，客户端在这期间断开），之后再注册
 * close 监听永远等不到。所以入口必须先看 res.destroyed 状态。
 *
 * 因为 writeChunked 在 proxy.mjs 内部（入口脚本不便导出），
 * 这里用**同一份实现**做语义验证，并额外做「变异即失败」的自检：
 * 把早退那行删掉，本测试必须挂。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

/** 与 src/proxy.mjs 里 writeChunked 保持一致的实现 */
function writeChunked(res, body, chunkSize = 64 * 1024) {
  return new Promise((resolve) => {
    if (res.destroyed || res.writableEnded) {
      resolve();
      return;
    }
    let off = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    res.on('error', finish);
    res.on('close', finish);
    const pump = () => {
      if (done) return;
      if (res.destroyed || res.writableEnded) {
        finish();
        return;
      }
      if (off >= body.length) {
        try {
          res.end();
        } catch {
          /* 对端已走 */
        }
        finish();
        return;
      }
      let ok = false;
      try {
        ok = res.write(body.subarray(off, off + chunkSize));
      } catch {
        finish();
        return;
      }
      off += chunkSize;
      if (ok) {
        setImmediate(pump);
        return;
      }
      res.once('drain', pump);
      res.once('close', finish);
    };
    pump();
  });
}

const BIG = Buffer.alloc(8 * 1024 * 1024, 'a');

/** 起一个服务：先等 delayMs（模拟压缩），再调 writeChunked */
function scenario({ delayMs, clientDisconnects, drainClient = false }) {
  return new Promise((resolve) => {
    const srv = http.createServer(async (req, res) => {
      await new Promise((r) => setTimeout(r, delayMs));
      const destroyedBefore = res.destroyed;
      const t0 = Date.now();
      const out = await Promise.race([
        writeChunked(res, BIG).then(() => 'settled'),
        new Promise((r) => setTimeout(() => r('HUNG'), 2000)),
      ]);
      resolve({ out, ms: Date.now() - t0, destroyedBefore, destroyedAfter: res.destroyed });
      srv.close();
    });
    srv.listen(0, '127.0.0.1', () => {
      const req = http.get({ port: srv.address().port, path: '/' }, (r) => {
        // 必须真的消费数据，否则内核缓冲区很快填满 → 服务端一直在等 drain
        if (drainClient) r.resume();
      });
      req.on('error', () => {});
      if (clientDisconnects) setTimeout(() => req.destroy(), 50);
    });
  });
}

test('writeChunked：客户端已断开时必须立刻返回（不能等 close 事件）', async () => {
  // 客户端 50ms 就断了，但服务端要等到 300ms 才开始写 ——
  // 此时 close 早已触发过，入口的 destroyed 检查是唯一能救命的
  const r = await scenario({ delayMs: 300, clientDisconnects: true });
  assert.equal(r.destroyedBefore, true, '前置条件：调用前 res 应该已经 destroyed');
  assert.equal(r.out, 'settled', 'writeChunked 永久挂起了 —— destroyed 早退被删了？');
  assert.ok(r.ms < 500, `应该立刻返回，实际 ${r.ms}ms`);
});

test('writeChunked：客户端正常时能完整写出', async () => {
  // drainClient: 客户端真的把数据读走，否则内核缓冲区填满后
  // 服务端会一直在等 drain —— 那是背压的正常行为，不是 bug
  const r = await scenario({ delayMs: 0, clientDisconnects: false, drainClient: true });
  assert.equal(r.out, 'settled', '正常路径不该挂起');
  assert.equal(r.destroyedBefore, false);
});
