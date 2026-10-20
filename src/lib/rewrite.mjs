/**
 * KimiCode Pocket — Host / Origin 改写
 *
 * 为什么必须改写（已实测，见 docs/how-it-works.md）：
 *   - Host 白名单：直连 Desktop 带 `Host: evil.example.com` → 403
 *   - WS Origin 校验：直连 `/api/v1/ws` 带公网 Origin → 403；**不带 Origin → 101 放行**
 *
 * 第二条决定了「改写而不是删除」：删掉 Origin 反而会让校验放行，
 * 等于帮攻击者绕过。保留字段、改成回环来源，语义仍是"来自本机"。
 */

/** 把 Host / Origin 改写成回环地址（大小写不敏感） */
export function rewriteHeaders(headers, port) {
  const target = `127.0.0.1:${port}`;
  const out = {};
  let sawHost = false;

  for (const [key, value] of Object.entries(headers)) {
    const k = key.toLowerCase();
    if (k === 'host') {
      out[key] = target;
      sawHost = true;
    } else if (k === 'origin') {
      out[key] = `http://${target}`;
    } else {
      out[key] = value;
    }
  }
  if (!sawHost) out.host = target;
  return out;
}

/**
 * 用 rawHeaders 重建 WebSocket 请求头。
 *
 * 之所以不用 `headers`：它会把重复头合并、大小写规范化，重建时可能改变语义
 * （尤其 `Sec-WebSocket-*` 与 `Sec-WebSocket-Protocol` 里的 bearer 令牌）。
 * rawHeaders 是 [k1,v1,k2,v2,...]，逐字节保真。
 */
export function rewriteRawHeaders(rawHeaders, port) {
  const target = `127.0.0.1:${port}`;
  const out = [];
  let sawHost = false;

  for (let i = 0; i < rawHeaders.length; i += 2) {
    const key = rawHeaders[i];
    const value = rawHeaders[i + 1];
    const k = String(key).toLowerCase();
    if (k === 'host') {
      out.push(`Host: ${target}`);
      sawHost = true;
    } else if (k === 'origin') {
      out.push(`Origin: http://${target}`);
    } else {
      out.push(`${key}: ${value}`);
    }
  }
  if (!sawHost) out.push(`Host: ${target}`);
  return out;
}

/**
 * 回环来源判断（兼容 IPv4-mapped IPv6 的各种写法）。
 *
 * 实测 Node 在 `socket.remoteAddress` 上**总是给规范化后的形式**：
 *   IPv4 连接 → "127.0.0.1"
 *   IPv6 监听下的 IPv4 连接 → "::ffff:127.0.0.1"（全小写）
 *   IPv6 loopback → "::1"
 * 所以 `::FFFF:127.0.0.1`（大写）和 `0:0:0:0:0:0:0:1`（全展开）
 * 实际上不会从 Node 冒出来。
 *
 * 但还是把它们都认了 —— 理由不是「现在会出问题」，而是这个函数是
 * **安全判据**（决定要不要信任 CF-Connecting-IP），依赖「上游一定规范化」
 * 这种隐含约定太脆：换 Node 版本、换反向代理、或者哪天有人把
 * 代理链路改成 unix socket / 自定义 transport，都可能让形式变掉。
 * 判错的后果是所有公网用户共享同一个限速桶（一个攻击者能锁住所有人）。
 */
export function isLoopbackAddr(addr) {
  if (!addr) return false;
  const s = String(addr).trim().toLowerCase();
  if (s === '127.0.0.1' || s === '::1' || s === 'localhost') return true;
  // IPv4-mapped：::ffff:127.0.0.1 以及十六进制写法 ::ffff:7f00:1
  if (s === '::ffff:127.0.0.1' || s === '::ffff:7f00:1') return true;
  // 全展开的 IPv6 loopback
  if (s === '0:0:0:0:0:0:0:1') return true;
  // 整个 127.0.0.0/8 都是回环（Linux 上常见 127.0.0.53 等）
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(s)) return true;
  return false;
}

/**
 * 请求是否来自 Cloudflare 隧道。
 *
 * 这一条看着多余，其实是全项目最容易写错的地方：
 * `cloudflared` 是在**本机**发起回环连接的，所以经隧道进来的公网请求，
 * `remoteAddress` 同样是 `127.0.0.1`。只看 remoteAddress 等于把全世界的
 * 请求都当成"本机直连"——`/__pair`、`/__paircode`、`/__status` 会直接裸奔。
 *
 * Cloudflare 一定会在请求里注入 `CF-Connecting-IP` 与 `CF-Ray`，
 * 本机浏览器直连则不会带。用它俩区分是可靠的；客户端自己伪造这两个头
 * 只会让请求被判成"来自公网"（更严格），不会反过来放宽，所以无需额外校验。
 */
export function isTunneledRequest(req) {
  const headers = req?.headers ?? {};
  return headers['cf-connecting-ip'] !== undefined || headers['cf-ray'] !== undefined;
}

/**
 * 真正意义上的"本机直连"：回环 socket **且** 不是经隧道转来的。
 * 所有"仅本机"端点都必须用它，不能用裸的 isLoopbackAddr(remoteAddress)。
 */
export function isLocalRequest(req) {
  return isLoopbackAddr(req?.socket?.remoteAddress) && !isTunneledRequest(req);
}

/**
 * 从请求里推断客户端真实 IP。
 *
 * **只在来源可信时才看头**。CF-Connecting-IP / X-Forwarded-For 都是客户端
 * 能自己写的：如果 `POCKET_BIND` 配成非回环（config 允许，只要配了 PIN），
 * 攻击者绕过 Cloudflare 直连代理，每条请求换一个 X-Forwarded-For，
 * 就能让 FailureLimiter 的「5 次/60 秒锁定」和 RateLimiter 的全局限速
 * 同时失效 —— 于是 6 位 PIN 可以被无限猜。
 *
 * 判据：只有来源是回环（也就是确实由本机的 cloudflared 转发进来）时，
 * 这些头才有意义。非回环来源一律用 socket 地址，头一概不信。
 */
export function clientIp(req) {
  const remote = req.socket?.remoteAddress;
  if (!isLoopbackAddr(remote)) return remote ?? 'unknown';
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) return cf.trim();
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim();
  return remote ?? 'unknown';
}
