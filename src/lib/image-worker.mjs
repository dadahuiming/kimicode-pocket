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

// 收到关闭信号就退出。
// 注意不能靠「parentPort 的 message 监听自动让 worker 存活」这一点：
// 一旦主线程忘了 terminate，worker 会一直挂着，测试进程退不出去
// （macOS + Node 22 上实测卡死 6 分钟以上）。
parentPort.on('close', () => {
  process.exit(0);
});

// 兜底：空闲超过 30 秒自行退出。
// 主线程的 worker 是 ref 住的，正常情况会主动 terminate；
// 万一某条路径漏了（异常、测试提前结束），这个定时器保证进程能退出去。
// 池子发现 worker 没了会在下次派活时重建，功能不受影响。
let idleTimer = setTimeout(() => process.exit(0), 30000);
idleTimer.unref?.();

parentPort.on('message', () => {
  // 每收到一个任务就重置空闲计时
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => process.exit(0), 30000);
  idleTimer.unref?.();
});


