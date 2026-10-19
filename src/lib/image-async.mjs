// 异步图片压缩调度：用 worker 池跑 PNG 处理，主线程不再被 CPU 卡住。
//
// 设计：
//   - 池大小 = min(4, CPU 核数 - 1)，至少 1
//   - 同一个 data URL 只算一次（内容哈希去重），并发相同请求会等同一个结果
//   - 结果进 LRU 缓存（按字节上限），后续请求直接命中
//   - 任一 worker 挂掉不影响正确性：降级为主线程同步处理

import { Worker } from 'node:worker_threads';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { shrinkPngDataUrl } from './image.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(HERE, 'image-worker.mjs');

const POOL_SIZE = Math.max(1, Math.min(4, (os.cpus()?.length ?? 2) - 1));

/** @type {{worker: Worker, busy: boolean}[]} */
const pool = [];
/** @type {{url: string, opts: object, resolve: Function, id: number}[]} */
const queue = [];
let seq = 0;
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

function spawn() {
  const worker = new Worker(WORKER_PATH);
  const slot = { worker, busy: false };
  worker.on('message', (msg) => {
    const job = worker.__current;
    worker.__current = null;
    slot.busy = false;
    if (job) {
      clearTimeout(job.timer);
      job.resolve(msg);
    }
    pump();
  });
  const fail = (err) => {
    const job = worker.__current;
    worker.__current = null;
    slot.busy = false;
    if (job) {
      clearTimeout(job.timer);
      job.resolve({ ok: false, error: String(err) });
    }
    const idx = pool.indexOf(slot);
    if (idx >= 0) pool.splice(idx, 1);
    try { worker.terminate(); } catch { /* ignore */ }
    if (pool.length === 0 && queue.length > 0) {
      // 池空了但还有活：重启一个
      pool.push(spawn());
      pump();
    }
  };
  worker.on('error', fail);
  worker.on('exit', (code) => {
    if (code !== 0 && worker.__current) fail(`worker exit ${code}`);
  });
  worker.unref();
  return slot;
}

function pump() {
  while (queue.length > 0) {
    const slot = pool.find((s) => !s.busy);
    if (!slot) return;
    const job = queue.shift();
    slot.busy = true;
    slot.worker.__current = job;
    job.timer = setTimeout(() => {
      // 单张图超过 20 秒视为卡死，放弃并降级
      const cur = slot.worker.__current;
      if (cur === job) {
        slot.worker.__current = null;
        slot.busy = false;
        job.resolve({ ok: false, error: 'timeout' });
        pump();
      }
    }, 20000);
    job.timer.unref?.();
    slot.worker.postMessage({ id: job.id, url: job.url, opts: job.opts });
  }
}

function ensurePool() {
  if (pool.length > 0) return;
  for (let i = 0; i < POOL_SIZE; i += 1) pool.push(spawn());
  pump();
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
      ensurePool();
      const msg = await new Promise((resolve) => {
        queue.push({ id: (seq += 1), url, opts, resolve });
        pump();
      });
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

/** 关掉所有 worker（进程退出/测试收尾用） */
export async function shutdownWorkers() {
  const all = pool.splice(0, pool.length);
  await Promise.all(all.map((s) => s.worker.terminate().catch(() => {})));
}

/** 诊断信息 */
export function poolStats() {
  return {
    poolSize: pool.length,
    busy: pool.filter((s) => s.busy).length,
    queued: queue.length,
    cacheEntries: resultCache.size,
    cacheBytes: resultBytes,
  };
}
