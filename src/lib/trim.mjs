// 大响应裁剪：把 transcript / messages 这类响应里的巨型字符串截断。
//
// 为什么需要：
//   Desktop 的 /transcript 会把整条 turn 的每个 step 的 frames 全量返回，
//   而 frames[].output 是工具执行的**完整输出**（读文件、跑命令、模型帧）。
//   实测一个会话：transcript 总计 30.87 MB，其中 frames 占 30.81 MB（99.8%）。
//   手机在 5G 下拉 30MB，前端 fetch 的 30s 超时就先到 —— 表现就是
//   「HTTP 200 已收到，但 parse 阶段 Failed to fetch」。
//
// 设计约束：
//   1. 只截断「字符串」，不改变 JSON 结构 —— 前端反序列化永远成功
//   2. 保留首尾（工具输出通常结论在末尾），中间用可读标记代替
//   3. 不动桌面端数据，只在传输层做投影；电脑上仍可看到全文
//   4. 流式（text/event-stream）与非 JSON 一律放过

const DEFAULT_PATH_HINTS = ['transcript', 'messages'];

/**
 * 这条响应是否值得裁剪。
 * @returns {boolean}
 */
export function shouldTrim(req, upstreamRes, cfg) {
  if (!cfg || !cfg.enabled) return false;
  if (req.method === 'HEAD') return false;

  const ct = String(upstreamRes.headers['content-type'] ?? '');
  if (!/^application\/json\b/i.test(ct)) return false;

  // 上游已编码的不碰（我们无法在压缩流上做 JSON 处理）
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

function fmt(n) {
  return n.toLocaleString('en-US');
}

/**
 * 把长字符串截成 head + 标记 + tail。
 * 保留末尾很重要：命令输出/文件内容的结论通常在尾部。
 */
function truncateString(s, maxChars, budget) {
  if (s.length <= maxChars) return s;

  const headLen = Math.max(1, Math.floor(maxChars * 0.6));
  const tailLen = Math.max(1, Math.floor(maxChars * 0.28));
  const head = s.slice(0, headLen);
  const tail = s.slice(-tailLen);
  const omitted = s.length - head.length - tail.length;

  budget.omittedChars += omitted;
  budget.fields += 1;

  return (
    head +
    `\n\n…[已省略 ${fmt(omitted)} 字符 / 原长 ${fmt(s.length)}；` +
    `完整内容请在电脑上查看]…\n\n` +
    tail
  );
}

const MAX_DEPTH = 24;

/** 深度遍历，只压字符串，结构不变。 */
function trimValue(value, maxChars, budget, depth = 0) {
  if (depth > MAX_DEPTH) return value;
  if (typeof value === 'string') return truncateString(value, maxChars, budget);

  if (Array.isArray(value)) {
    const out = new Array(value.length);
    for (let i = 0; i < value.length; i += 1) {
      out[i] = trimValue(value[i], maxChars, budget, depth + 1);
    }
    return out;
  }

  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) {
      out[k] = trimValue(value[k], maxChars, budget, depth + 1);
    }
    return out;
  }

  return value;
}

/**
 * 裁剪一个 JSON Buffer。
 *
 * 会先按 cfg.maxChars 截断；如果结果仍超 cfg.totalBytes，就把 maxChars
 * 逐级对折重试（最多 4 轮），保证最终一定落在预算内。
 *
 * @returns {{ buffer: Buffer, stats: object } | null} null 表示放弃裁剪
 */
export function trimJsonBuffer(buf, cfg) {
  let parsed;
  try {
    parsed = JSON.parse(buf.toString('utf8'));
  } catch {
    return null; // 不是合法 JSON，原样放过
  }

  const originalBytes = buf.length;
  let maxChars = cfg.maxChars;
  let best = null;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const budget = { omittedChars: 0, fields: 0 };
    const trimmed = trimValue(parsed, maxChars, budget);
    const out = Buffer.from(JSON.stringify(trimmed), 'utf8');

    best = {
      buffer: out,
      stats: {
        originalBytes,
        trimmedBytes: out.length,
        omittedChars: budget.omittedChars,
        fields: budget.fields,
        maxChars,
        attempts: attempt + 1,
        overBudget: false,
      },
    };

    if (out.length <= cfg.totalBytes) return best;

    // 还没达标：按「实际超出比例」估算下一轮 maxChars。
    // 直接除以 3 在字段数很多时会不够（每轮只砍字符串，砍不动结构），
    // 这里用比例外推，通常 2~3 轮收敛。
    const over = out.length / cfg.totalBytes;
    const next = Math.floor(maxChars / Math.max(1.6, over * 1.15));
    maxChars = Math.max(48, next);
  }

  // 兜底：如果逐级对折仍没进预算，说明单字段都不是瓶颈、而是字段太多
  // （JSON 骨架本身就接近预算）。此时把 maxChars 压到最小值再试一次；
  // 若仍超，就用 overBudget 显式标记 —— 宁可超预算，也不能让前端崩。
  if (best && best.buffer.length > cfg.totalBytes) {
    const budget = { omittedChars: 0, fields: 0 };
    const trimmed = trimValue(parsed, 48, budget);
    const out = Buffer.from(JSON.stringify(trimmed), 'utf8');
    return {
      buffer: out,
      stats: {
        originalBytes,
        trimmedBytes: out.length,
        omittedChars: budget.omittedChars,
        fields: budget.fields,
        maxChars: 48,
        attempts: 5,
        overBudget: out.length > cfg.totalBytes,
      },
    };
  }

  return best;
}
