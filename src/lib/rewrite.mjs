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

/** 回环来源判断（兼容 IPv4-mapped IPv6） */
export function isLoopbackAddr(addr) {
  if (!addr) return false;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
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

/** 从请求里推断客户端真实 IP（Cloudflare 会带 CF-Connecting-IP） */
export function clientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf) return cf.trim();
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
  return req.socket?.remoteAddress ?? 'unknown';
}
