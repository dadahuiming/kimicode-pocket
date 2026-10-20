// 大响应瘦身：**只压缩工具截图，文字一个字符都不动**。
//
// 来龙去脉（这段历史值得留着，因为踩过一次方向性错误）：
//   1.0 阶段遇到「手机打开长会话报 Failed to fetch，但 HTTP 状态是 200」。
//   当时的判断是「响应太大」，于是按总预算对折所有字符串 —— 结果一个会话里
//   5 MB 的 base64 截图没降下来多少，反倒把 846 字符的正文砍成了 41 字符。
//   用户看到的就是「回复正文被吃掉、只剩一行省略号」。
//
//   后来逐字段统计才看清真相：单个长会话 /messages 共 5.41 MB，
//   其中 imageUrl.url（截图的 base64 PNG）占 5.36 MB = 99.1%，
//   而全部对话文字加起来不到 50 KB；/transcript 更极端 ——
//   51 MB 里 48.6 MB 是 38 张截图（95.4%），文字只有 1.95 MB。
//
//   所以正确的做法是：**只动图片**。图片是有损也无所谓的呈现层，
//   降分辨率后照样看得清；文字少一个字都可能改变语义，不能碰。
//
// 现在的行为：
//   - 两阶段：先同步扫描出所有 PNG data URL，再异步并行压缩，最后同步组装
//   - 其余任何字符串（正文、思考、工具输出、命令行）**原样保留**
//   - 结构、字段名、数组长度全部不变
//   - 没有任何「总预算」逻辑 —— 不再为了凑体积而牺牲内容
//
// 性能：
//   - 图片本体压缩跑在 worker 线程（见 image-async.mjs），主线程不被阻塞
//   - 结果按内容哈希缓存；同一会话第二次打开 ~20ms

import crypto from 'node:crypto';

import { shrinkAsync, clearAsyncCaches, shutdownWorkers, poolStats } from './image-async.mjs';

const DEFAULT_PATH_HINTS = ['transcript', 'messages'];

// ---------------------------------------------------------------- 缓存

const responseCache = new Map(); // key: sha256(响应 buffer) -> { buffer, stats }
let responseBytes = 0;
const RESPONSE_CACHE_MAX_BYTES = 128 * 1024 * 1024;
const RESPONSE_CACHE_MAX_ENTRIES = 32;

function hash(buf) {
  return crypto.createHash('sha256').update(buf).digest('base64');
}

function lruGet(map, key) {
  const v = map.get(key);
  if (v === undefined) return undefined;
  map.delete(key);
  map.set(key, v);
  return v;
}

function lruSet(map, key, value, sizeFn, { maxBytes, maxEntries }, counter) {
  if (map.has(key)) {
    counter.bytes -= sizeFn(map.get(key));
    map.delete(key);
  }
  map.set(key, value);
  counter.bytes += sizeFn(value);
  while (map.size > maxEntries || counter.bytes > maxBytes) {
    const firstKey = map.keys().next().value;
    if (firstKey === undefined) break;
    counter.bytes -= sizeFn(map.get(firstKey));
    map.delete(firstKey);
  }
}

const respBytes = { bytes: 0 };

// ---------------------------------------------------------------- 并发闸门
//
// 真实事故：前端会在会话打开时**并发**打多个 /transcript（实测一次 13 个，
// 生产日志里同一秒最多 7 个，单个 92MB）。如果任由它们同时进来：
//   - 4 个 worker 被抢爆，每个请求排队等 CPU
//   - 主线程同时持有 7 × 92MB ≈ 644MB 的 Buffer
//   - 结果全都超时，页面永远「加载中」
//
// 所以必须限流：同一时刻只处理 N 个瘦身任务，其余排队。
//
// ⚠️ 这个闸门**必须在读流之前**占名额，否则等于没做。
//
// 早先的实现是「proxy 先把整包读进内存 → 再调 trimJsonBuffer → 里面才 acquireSlot」。
// 那时排队的是**CPU 阶段**，内存阶段完全没有约束：7 个 92MB 请求会先把
// 644MB 全部读进来，然后才开始排队。注释里「排队时上游流不读取，靠 TCP 背压
// 把压力推回 Desktop」这句话，在旧顺序下**根本不成立**。
//
// 实测（7 并发 × 276MB，走真实 trimJsonBuffer）：
//   旧顺序（先缓冲后占名额）：峰值 RSS 2516MB
//   新顺序（先占名额后读流）：峰值 RSS 1432MB   ← 降 43%
// 背压也确实成立：不读流时上游只写出 4.38MB/60MB（7.3%）就停住，23ms 内触发。
//
// 现在由 proxy 在 `for await (const chunk of proxyRes)` **之前**调用
// acquireSlot()，读完（或失败）后 releaseSlot()。
const MAX_CONCURRENT_TRIM = 2;
let running = 0;
const waiting = [];
const inflightResponses = new Map(); // respKey -> Promise<{buffer,stats}|null>

/**
 * 占用一个瘦身名额。**在读上游流之前调用。**
 * @returns {Promise<void>}
 */
export function acquireSlot() {
  if (running < MAX_CONCURRENT_TRIM) {
    running += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}

/** 释放名额。必须在 finally 里调用，否则名额泄漏会让后续请求永久排队。 */
export function releaseSlot() {
  const next = waiting.shift();
  if (next) {
    next(); // 名额直接转交，running 不变
  } else {
    running -= 1;
  }
}

/** 诊断：当前占用/排队情况（测试与 /__status 用） */
export function slotStats() {
  return { running, waiting: waiting.length, max: MAX_CONCURRENT_TRIM };
}

/** 清空缓存（测试用） */
export async function clearCaches() {
  responseCache.clear();
  responseBytes = 0;
  respBytes.bytes = 0;
  clearAsyncCaches();
}

/** 缓存现状（诊断用） */
export function cacheStats() {
  return {
    responseEntries: responseCache.size,
    responseBytes: respBytes.bytes,
    ...poolStats(),
  };
}

/** 进程退出时收尾（测试用） */
export async function shutdown() {
  await shutdownWorkers();
}

/**
 * 这条响应是否值得处理。
 * @returns {boolean}
 */
export function shouldTrim(req, upstreamRes, cfg) {
  if (!cfg || !cfg.enabled) return false;
  if (req.method === 'HEAD') return false;

  const ct = String(upstreamRes.headers['content-type'] ?? '');
  if (!/^application\/json\b/i.test(ct)) return false;

  // 上游已编码的不碰（无法在压缩流上做 JSON 处理）
  if (upstreamRes.headers['content-encoding']) return false;

  const len = Number(upstreamRes.headers['content-length'] ?? 0);
  // 没有 content-length 视为流式/未知大小，避免无界缓冲
  if (!Number.isFinite(len) || len <= 0) return false;
  if (len < cfg.minBytes) return false;
  // 超过缓冲上限就放过（宁可让这条失败，也不要把进程内存打爆）
  if (len > cfg.maxBufferBytes) return false;

  const url = String(req.url ?? '');
  const pathname = url.split('?')[0].toLowerCase();
  return cfg.paths.some((hint) => pathname.includes(String(hint).toLowerCase()));
}

const MAX_DEPTH = 64;

function fmt(n) {
  return n.toLocaleString('en-US');
}

/**
 * 阶段一：同步扫描，找出所有需要压缩的 PNG data URL。
 *
 * 顺手把「相同内容只记一次」做了 —— 同一个会话里同一张截图可能被引用多次，
 * 压缩一次就够。
 */
function collectImages(value, cfg, found, seen, depth = 0) {
  if (depth > MAX_DEPTH) return;
  if (typeof value === 'string') {
    // 快速排除：绝大多数字符串连前缀都不匹配，不做任何额外工作
    if (value.length < cfg.image.minChars) return;
    if (!value.startsWith('data:image/png;base64,')) return;
    if (seen.has(value)) return;
    seen.add(value);
    found.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) collectImages(value[i], cfg, found, seen, depth + 1);
    return;
  }
  if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) collectImages(value[k], cfg, found, seen, depth + 1);
  }
}

/**
 * 阶段二：同步组装，把命中的图片换掉。
 * map 的 key 是压缩后的结果（可能为 null 表示原样放过）。
 */
function applyImages(value, results, stats, depth = 0) {
  if (depth > MAX_DEPTH) return value;

  if (typeof value === 'string') {
    const res = results.get(value);
    if (res === undefined) return value; // 没扫描到的（太短或不是 PNG）
    if (!res) return value; // 扫描到了但决定不压缩

    stats.images += 1;
    stats.originalImageBytes += res.originalBytes;
    stats.outImageBytes += res.outBytes;
    stats.details.push({
      factor: res.factor,
      from: `${res.width}x${res.height}`,
      to: `${res.outWidth}x${res.outHeight}`,
      before: res.originalBytes,
      after: res.outBytes,
    });
    return res.url;
  }

  if (Array.isArray(value)) {
    let changed = false;
    const out = new Array(value.length);
    for (let i = 0; i < value.length; i += 1) {
      out[i] = applyImages(value[i], results, stats, depth + 1);
      if (out[i] !== value[i]) changed = true;
    }
    return changed ? out : value;
  }

  if (value && typeof value === 'object') {
    let changed = false;
    const out = {};
    for (const k of Object.keys(value)) {
      out[k] = applyImages(value[k], results, stats, depth + 1);
      if (out[k] !== value[k]) changed = true;
    }
    return changed ? out : value;
  }

  return value;
}

/**
 * 瘦身一个 JSON Buffer（异步版）。
 *
 * 只压缩 base64 PNG 截图；文字内容与 JSON 结构完全不变。
 *
 * @param {Buffer} buf
 * @param {object} cfg
 * @param {{ slotHeld?: boolean }} [opts]
 *        slotHeld=true 表示调用方**已经**用 acquireSlot() 占了名额
 *        （proxy 现在就是在读流前占的，见文件顶部闸门注释）。
 *        此时本函数不再自己占，也不再自己释放 —— 由调用方负责。
 *        不传则维持旧行为（自己占、自己放），保证既有测试与其它调用点不受影响。
 * @returns {Promise<{ buffer: Buffer, stats: object } | null>}
 *          null 表示「不改动，原样放过」
 */
export async function trimJsonBuffer(buf, cfg, opts = {}) {
  const originalBytes = buf.length;
  const slotHeld = opts.slotHeld === true;

  // ---- 整响应缓存 ----
  // 手机每次进会话都会重新 fetch 同一个 /messages。内容没变时直接复用上次结果，
  // 省掉「JSON 解析 + 遍历 + 序列化」的全部开销（51MB 的 transcript 从 3s 降到 20ms）。
  const respKey = hash(buf);
  const cachedResp = lruGet(responseCache, respKey);
  if (cachedResp !== undefined) {
    return {
      buffer: cachedResp.buffer,
      stats: { ...cachedResp.stats, cachedResponse: true },
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(buf.toString('utf8'));
  } catch {
    return null; // 不是合法 JSON，原样放过
  }

  // 阶段一：找出所有候选图片（轻量，同步）
  const found = [];
  collectImages(parsed, cfg, found, new Set(), 0);
  if (found.length === 0) return null; // 没有图片 → 不需要动

  // ---- 合并重复请求 ----
  // 前端会并发打同一个 /transcript（实测一次 13 个一模一样的请求）。
  // 第一个进来算，其余的等它的结果，避免重复烧 CPU。
  const pending = inflightResponses.get(respKey);
  if (pending !== undefined) {
    const shared = await pending;
    return shared === null ? null : { buffer: shared.buffer, stats: { ...shared.stats, deduped: true } };
  }

  const task = (async () => {
    // slotHeld=true 时名额已经由调用方在读流前占好了，这里不能再占
    // （再占一次会自我死锁：自己等自己刚占的那个名额）。
    if (!slotHeld) await acquireSlot();
    try {
      // 阶段二：并行压缩（worker 线程，主线程不被阻塞）
      const results = new Map();
      await Promise.all(
        found.map(async (url) => {
          const res = await shrinkAsync(url, cfg.image);
          if (res) results.set(url, res);
        }),
      );

      if (results.size === 0) return null; // 一张都没压成

      const stats = {
        originalBytes,
        trimmedBytes: originalBytes,
        images: 0,
        originalImageBytes: 0,
        outImageBytes: 0,
        cachedResponse: false,
        details: [],
      };

      // 阶段三：同步组装
      const slim = applyImages(parsed, results, stats, 0);
      const out = Buffer.from(JSON.stringify(slim), 'utf8');
      stats.trimmedBytes = out.length;

      lruSet(responseCache, respKey, { buffer: out, stats }, (e) => e.buffer.length, {
        maxBytes: RESPONSE_CACHE_MAX_BYTES,
        maxEntries: RESPONSE_CACHE_MAX_ENTRIES,
      }, respBytes);

      return { buffer: out, stats };
    } finally {
      // slotHeld 时名额归调用方所有，这里不能替它释放 ——
      // 否则调用方的 finally 会再 release 一次，running 变负数，
      // 闸门从此形同虚设（而且不会有任何报错）。
      if (!slotHeld) releaseSlot();
    }
  })();

  inflightResponses.set(respKey, task);
  try {
    return await task;
  } finally {
    inflightResponses.delete(respKey);
  }
}

/** 给日志用的一句话摘要。 */
export function formatStats(stats) {
  const saved = stats.originalImageBytes - stats.outImageBytes;
  const pct = stats.originalImageBytes > 0
    ? ((saved / stats.originalImageBytes) * 100).toFixed(1)
    : '0.0';
  const factors = [...new Set(stats.details.map((d) => d.factor))].sort((a, b) => a - b);
  const detail = factors.length ? `÷${factors.join('/')}` : '';
  const size = stats.details.length
    ? `${stats.details[0].from}→${stats.details[0].to}`
    : '';
  const respHit = stats.cachedResponse ? '，整响应缓存命中' : '';
  return (
    `图片 ${stats.images} 张 ${(stats.originalImageBytes / 1024 / 1024).toFixed(2)}MB → ` +
    `${(stats.outImageBytes / 1024).toFixed(0)}KB（−${pct}%）` +
    (size ? ` [${size} ${detail}]` : '') +
    `；正文原样保留 ${fmt(stats.originalBytes - stats.originalImageBytes)} 字节` +
    respHit
  );
}
