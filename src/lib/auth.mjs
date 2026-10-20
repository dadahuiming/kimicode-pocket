/**
 * KimiCode Pocket — 访问控制
 *
 * 三层，按成本从低到高：
 *   1. PIN 会话（可选）：token 之外再加一道口令，泄露止损用
 *   2. 失败限速：/__login 与 /__pair 的口令猜解，5 次 / 60 秒
 *   3. 全局限速：单 IP 每分钟请求数，防扫描与误用
 *
 * 注意：Desktop 的 server.token 是 43 字符随机串（约 250 bit 熵），
 * 爆破在数学上不可行。PIN 的价值不是"防爆破"，而是
 * 「token 泄露后还有一层」+「可以随时换口令而不动 Desktop」。
 */

import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

const SESSION_SALT = 'kimicode-pocket/session/v1';

/** 定长常量时间比较（长度不同直接 false，避免 timingSafeEqual 抛错） */
export function constantTimeEqual(a, b) {
  const ab = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function sessionMac(pin, nonce) {
  const key = createHmac('sha256', SESSION_SALT).update(pin).digest();
  return createHmac('sha256', key).update(nonce).digest('hex');
}

/**
 * 会话令牌 = nonce.hmac(pin, nonce)
 * 密钥由 PIN 派生 → 换 PIN 即全端下线；进程重启后旧令牌仍有效（体验优先）。
 */
export function newSessionToken(pin) {
  const nonce = randomBytes(16).toString('hex');
  return `${nonce}.${sessionMac(pin, nonce)}`;
}

export function verifySessionToken(pin, token) {
  if (typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return false;
  const nonce = token.slice(0, dot);
  return constantTimeEqual(token, `${nonce}.${sessionMac(pin, nonce)}`);
}

/**
 * 解析 Cookie 头。
 *
 * 单个 Cookie 编码非法时**跳过它**，绝不能让异常冒出去。
 * 这条路径在 PIN 开启时对每个请求（含 WS upgrade）都会走，
 * 而 `decodeURIComponent('...%E0%A4%A')` 会抛 URIError；
 * http server 的 handler 是 async 函数，抛出的异常变成未处理的
 * Promise rejection，Node 默认直接 `process.exit(1)` ——
 * 也就是**任何人发一个畸形 Cookie 就能打挂整个代理**（远程 DoS）。
 * 实测：`Cookie: pocket_session=%E0%A4%A` 即可复现进程退出。
 */
export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    let v;
    try {
      v = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // 坏 Cookie 当作不存在。故意不写 out[k]，
      // 这样下游读到 undefined，与「没带这个 Cookie」完全一致。
      continue;
    }
    out[k] = v;
  }
  return out;
}

/** 失败计数限速器：同一 key 连续失败 max 次后锁定 windowMs */
export class FailureLimiter {
  constructor({ max = 5, windowMs = 60_000, now = () => Date.now() } = {}) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
    this.map = new Map();
  }

  /** 返回剩余锁定毫秒数，0 表示未锁 */
  retryAfterMs(key) {
    const rec = this.map.get(key);
    if (!rec) return 0;
    const left = rec.until - this.now();
    if (left <= 0) {
      this.map.delete(key);
      return 0;
    }
    return left;
  }

  recordFailure(key) {
    const t = this.now();
    const rec = this.map.get(key) ?? { count: 0, until: 0 };
    rec.count += 1;
    rec.until = t + this.windowMs;
    this.map.set(key, rec);
    return rec.count;
  }

  isLocked(key) {
    const rec = this.map.get(key);
    if (!rec) return false;
    if (rec.until <= this.now()) {
      this.map.delete(key);
      return false;
    }
    return rec.count >= this.max;
  }

  clear(key) {
    this.map.delete(key);
  }

  /**
   * 周期性清理过期记录。
   *
   * 以前只有 `retryAfterMs` / `isLocked` 在**被查询时**顺手删自己那一条，
   * 于是「只失败一次就再也没回来」的 key 会永久留在 map 里。
   * 配合可伪造的客户端 IP（见 rewrite.mjs 的 clientIp），
   * 每次换一个 IP 就能塞一条永久记录 —— map 无界增长。
   */
  sweep() {
    const t = this.now();
    for (const [k, v] of this.map) {
      if (v.until <= t) this.map.delete(k);
    }
  }
}

/** 固定窗口请求计数，防扫描/误用 */
export class RateLimiter {
  constructor({ perMinute = 600, now = () => Date.now() } = {}) {
    this.perMinute = perMinute;
    this.now = now;
    this.map = new Map();
  }

  /** @returns {{allowed:boolean, remaining:number}} */
  hit(key) {
    if (this.perMinute <= 0) return { allowed: true, remaining: Infinity };
    const bucket = Math.floor(this.now() / 60_000);
    const rec = this.map.get(key);
    if (!rec || rec.bucket !== bucket) {
      this.map.set(key, { bucket, count: 1 });
      return { allowed: true, remaining: this.perMinute - 1 };
    }
    rec.count += 1;
    return { allowed: rec.count <= this.perMinute, remaining: Math.max(0, this.perMinute - rec.count) };
  }

  /** 周期性清理，避免长跑内存增长 */
  sweep() {
    const bucket = Math.floor(this.now() / 60_000);
    for (const [k, v] of this.map) if (v.bucket !== bucket) this.map.delete(k);
  }
}
