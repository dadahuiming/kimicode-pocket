// 图片压缩 worker：把 PNG 解码/降采样/编码这些纯 CPU 活挪出主线程。
//
// 为什么必须用 worker：
//   Node 是单线程。31 张图同步处理要 3.1 秒，这 3.1 秒里主线程什么都不响应 ——
//   同一时刻手机的其它请求（会话列表、状态轮询、WebSocket 心跳）全部排队，
//   表现出来的就是「页面卡死、WS 断开、加载中转圈」。
//
//   放进 worker 后主线程只负责 IO，CPU 活在另一个线程并行跑，
//   HTTP 服务始终可响应。

import { parentPort } from 'node:worker_threads';
import { shrinkPngDataUrl } from './image.mjs';

parentPort.on('message', (msg) => {
  const { id, url, opts } = msg;
  try {
    const res = shrinkPngDataUrl(url, opts);
    parentPort.postMessage({ id, ok: true, res });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: String(err && err.message ? err.message : err) });
  }
});
