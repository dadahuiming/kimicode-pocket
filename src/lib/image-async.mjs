// 异步图片压缩调度：用 worker 池跑 PNG 处理，主线程不再被 CPU 卡住。
//
// 设计：
//   - 池大小 = min(4, CPU 核数 - 1)，至少 1
//   - 同一个 data URL 只算一次（内容哈希去重），并发相同请求会等同一个结果
//   - 结果进 LRU 缓存（按字节上限），后续请求直接命中
//   - 任一 worker 挂掉不影响正确性：降级为主线程同步处理
//
// 调度器本身在 lib/pool.mjs —— 拆出去是为了能被**直接单测**：
// 那些保命逻辑（id 校验、退出回收、超时销毁）只在异常时序下触发，
// 端到端跑真实图片永远走不到（实测：删掉 id 校验，端到端测试照样全绿）。

import { Worker } from 'node:worker_threads';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { shrinkPngDataUrl } from './image.mjs';
import { createPool } from './pool.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(HERE, 'image-worker.mjs');

const POOL_SIZE = Math.max(1, Math.min(4, (os.cpus()?.length ?? 2) - 1));

const pool = createPool({
  poolSize: POOL_SIZE,
  timeoutMs: 20_000,
  // Node 22 的 test runner 在「事件循环里只剩 unref 的 worker」时会判定
  // 「Promise resolution is still pending but the event loop has already resolved」，
  // 直接把还在等的 await 判成失败（Node 24 宽松些，只在 22 上炸）。
  // 策略：空闲时 unref（不阻止进程退出），派活时 ref —— 由 pool.mjs 负责。
  spawnWorker: () => new Worker(WORKER_PATH),
});

let inflight = new Map(); // hash -> Promise<result>

// 结果缓存（与 trim.mjs 里的图片缓存分开：这里是「原始串 → 结果」的原始层）
const resultCache = new Map();
let resultBytes = 0;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 512;

function cacheGet(key) {
  const v = resultCache.get(key);
  if (v === undefined) return undefined;
  resultCache.delete(key);
  resultCache.set(key, v);
  return v;
}

function cachePut(key, value) {
  // value 可能是 null（表示「这张图不压，原样放过」）—— 也要缓存，
  // 否则每次请求都会重新解码一遍才发现不值得压。
  const sizeOf = (v) => (v && v.url ? v.url.length : 0);

  if (resultCache.has(key)) {
    resultBytes -= sizeOf(resultCache.get(key));
    resultCache.delete(key);
  }
  resultCache.set(key, value);
  resultBytes += sizeOf(value);
  while (resultCache.size > MAX_CACHE_ENTRIES || resultBytes > MAX_CACHE_BYTES) {
    const k = resultCache.keys().next().value;
    if (k === undefined) break;
    resultBytes -= sizeOf(resultCache.get(k));
    resultCache.delete(k);
  }
}

/**
 * 异步压缩一张 PNG data URL。
 *
 * @param {string} url
 * @param {object} opts
 * @returns {Promise<object|null>} 与 shrinkPngDataUrl 返回值一致；null 表示原样放过
 */
export async function shrinkAsync(url, opts) {
  const key = crypto.createHash('sha256').update(url).digest('base64');

  const hit = cacheGet(key);
  if (hit !== undefined) return hit;

  // 同一张图并发请求合并，只算一次
  const running = inflight.get(key);
  if (running) return running;

  const p = (async () => {
    let res = null;
    try {
      const msg = await pool.submit(url, opts);
      if (msg && msg.ok) {
        res = msg.res;
      } else {
        // worker 不可用/超时 → 主线程兜底（宁可慢一次，也不能丢功能）
        res = shrinkPngDataUrl(url, opts);
      }
    } catch {
      res = shrinkPngDataUrl(url, opts);
    }
    cachePut(key, res);
    inflight.delete(key);
    return res;
  })();

  inflight.set(key, p);
  return p;
}

/** 清空（测试用） */
export function clearAsyncCaches() {
  resultCache.clear();
  resultBytes = 0;
  inflight = new Map();
}

/**
 * 等待当前所有在跑/排队的任务结束。
 *
 * Node 22 的 test runner 比 24 严格：如果它认为事件循环空了而 Promise 还在等，
 * 会直接判 `Promise resolution is still pending`。收尾时先把这个等干净。
 */
export async function drain() {
  // 只等 inflight 里的 promise —— 它们会在 settle 后自己清除。
  // 不要拿 pool.busy 当循环条件：池空时那个条件恒为 false，
  // 而 inflight 里的 promise 可能还在等超时兜底，那样会漏等。
  const pending = [...inflight.values()].map((p) => p.catch(() => {}));
  if (pending.length === 0) return;
  await Promise.all(pending);
}

/** 关掉所有 worker（进程退出/测试收尾用） */
export async function shutdownWorkers() {
  await drain();
  await pool.shutdown();
}

/** 诊断信息 */
export function poolStats() {
  const s = pool.stats();
  return {
    poolSize: s.poolSize,
    busy: s.busy,
    queued: s.queued,
    cacheEntries: resultCache.size,
    cacheBytes: resultBytes,
  };
}
