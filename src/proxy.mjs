#!/usr/bin/env node
/**
 * KimiCode Pocket — 固定端口反向代理
 *
 * 解决的问题（两个，一次解决）：
 *
 *   1. Kimi Code Desktop 的内置 Web 服务器**端口是动态的**（每次重启可能变），
 *      而 Cloudflare 隧道的 ingress 必须指向一个**固定端口**。
 *
 *   2. Desktop 服务器有 **Host / Origin 白名单校验**（已实测）：
 *      - 带非回环 Host 直连 → 403
 *      - WebSocket 带公网 Origin → 403；**不带 Origin 反而放行 101**
 *      所以必须改写而不是删除头。
 *
 * 安全默认值：**只绑 127.0.0.1**。唯一入口应当是隧道。
 * 若确实需要绑非回环地址，必须同时设置 POCKET_PIN，否则拒绝启动。
 *
 * 环境变量：见 README「配置」一节，或跑 `node src/proxy.mjs --help`。
 */

import http from 'node:http';
import net from 'node:net';
import {
  readFileSync,
  mkdirSync,
  appendFile,
  appendFileSync,
  existsSync,
  statSync,
  renameSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomInt } from 'node:crypto';
import { createBrotliCompress, createGzip, constants as zlibConstants } from 'node:zlib';

import { loadConfig, ConfigError } from './lib/config.mjs';
import { parseArgs, parsePairCount, MAX_PAIR_COUNT } from './lib/args.mjs';
import { createDiscovery } from './lib/discovery.mjs';
import { rewriteHeaders, rewriteRawHeaders, isLocalRequest, clientIp } from './lib/rewrite.mjs';
import { shouldTrim, trimJsonBuffer, formatStats } from './lib/trim.mjs';
import { injectTurnNav, shouldInjectNav, MAX_HTML_BYTES } from './lib/toc.mjs';
import {
  newSessionToken,
  verifySessionToken,
  constantTimeEqual,
  parseCookies,
  FailureLimiter,
  RateLimiter,
} from './lib/auth.mjs';
import { loginPage, pairPage, pairRejectedPage, errorPage } from './lib/pages.mjs';
import { encode as qrEncode, toPng as qrPng, toTerminal as qrTerminal } from './lib/qr.mjs';
import { watchPairProgress } from './lib/pairwatch.mjs';

const SESSION_COOKIE = 'pocket_session';
const SESSION_TTL_SEC = 7 * 24 * 3600;
const CREDENTIAL_TTL_DAYS = 7;
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const LOG_FLUSH_MS = 500;
const LOG_FLUSH_LINES = 64;
const VERSION = '1.6.11';

const HELP = `KimiCode Pocket ${VERSION}

用法:
  node src/proxy.mjs [选项]
  node src/proxy.mjs --pair-only --base https://kimicode.example.com

选项:
  --port <端口>      监听端口（等同 POCKET_PORT，默认 50980）
  --pin <口令>       访问口令（等同 POCKET_PIN，至少 6 位）
  --base <地址>      公网入口，如 https://kimicode.example.com
                     给了就在启动后打印一条配对链接 + 终端二维码
  --pair-only        只生成配对链接并退出（代理需已在运行）
  --pair-count <n>   配合 --pair-only 一次生成 n 条（1~${MAX_PAIR_COUNT}，默认 1）
  -h, --help         显示本帮助
  -v, --version      显示版本

环境变量:
  POCKET_PORT                 监听端口（默认 50980）
  POCKET_BIND                 绑定地址（默认 127.0.0.1；改非回环必须同时设 PIN）
  POCKET_APP_HOME             Desktop 配置目录（默认 ~/.kimi-code）
  POCKET_HEALTH_PATH          探活路径（默认 /api/v1/healthz）
  POCKET_LOG_DIR              日志目录（默认 <状态目录>/logs，不在仓库里写）
  POCKET_PUBLIC_URL           公网入口，等同 --base
  POCKET_PIN                  额外访问口令（至少 6 位，可选）
  POCKET_UPSTREAM_TIMEOUT_MS  上游空闲超时（默认 120000）
  POCKET_MAX_BODY_MB          请求体上限（默认 64）
  POCKET_COMPRESS             JSON 响应压缩 1/0（默认 1）
  POCKET_ACCESS_LOG           访问日志 1/0（默认 1）
  POCKET_RATE_LIMIT           单 IP 每分钟请求上限，0=关闭（默认 600）
  POCKET_PAIR_TTL_SEC         配对口令有效期秒数（默认 180，最小 30）

代理自有端点:
  GET  /__healthz     探活（非本机来源只返回 ok 布尔值）
  GET  /__status      运行状态（仅本机直连）
  GET  /__pair        配对页（必须带一次性 code）
  GET  /__paircode    取一次性配对口令（仅本机直连）
  GET  /__pairstatus  口令是否已被兑换（仅本机直连；终端用它回显结果）
  GET  /__login       口令登录页（仅 POCKET_PIN 开启时）
  POST /__qrcode      把文本渲染成二维码 PNG（仅本机直连）

"本机直连" = 回环 socket **且** 不带 Cloudflare 头。经隧道进来的请求
即使 socket 是 127.0.0.1（cloudflared 在本机），也不算本机。
`;

// ---- 启动参数 ---------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (args.version) {
  process.stdout.write(`kimicode-pocket ${VERSION}\n`);
  process.exit(0);
}
if (args.errors.length) {
  process.stderr.write(`${args.errors.map((e) => `[参数错误] ${e}`).join('\n')}\n\n${HELP}`);
  process.exit(2);
}

let pairCount;
try {
  pairCount = parsePairCount(args.pairCount);
} catch (e) {
  process.stderr.write(`[参数错误] ${e.message}\n`);
  process.exit(2);
}

// ---- 配置与日志 -------------------------------------------------------------

const envOverlay = { ...process.env };
if (args.port) envOverlay.POCKET_PORT = args.port;
if (args.pin) envOverlay.POCKET_PIN = args.pin;
if (args.base) envOverlay.POCKET_PUBLIC_URL = args.base;

let cfg;
try {
  cfg = loadConfig(envOverlay);
} catch (e) {
  if (e instanceof ConfigError) {
    process.stderr.write(`[配置错误] ${e.message}\n`);
    process.exit(2);
  }
  throw e;
}

if (args.pairOnly && !cfg.publicUrl) {
  process.stderr.write(
    '[参数错误] --pair-only 需要公网入口，配对链接才能被手机打开：\n' +
      '  node src/proxy.mjs --pair-only --base https://kimicode.example.com\n',
  );
  process.exit(2);
}

// ---- 日志：异步缓冲，热路径不碰磁盘 ----------------------------------------
//
// 之前是每个请求 mkdir + exists + stat + append 四次同步调用，直接阻塞
// 事件循环；长会话页面一屏能并发几十个请求，这里会成为明显的毛刺源。

const LOG_FILE = join(cfg.logDir, 'proxy.log');
let logBytes = 0;
let logPending = [];
let logFlushing = false;

function openLog() {
  try {
    mkdirSync(cfg.logDir, { recursive: true });
    logBytes = existsSync(LOG_FILE) ? statSync(LOG_FILE).size : 0;
    if (logBytes > MAX_LOG_BYTES) rotateLog();
  } catch {
    /* 日志目录不可用也不影响转发 */
  }
}

function rotateLog() {
  // 这里没有打开中的句柄（用 appendFile 而不是 createWriteStream），
  // 所以 Windows 上 rename 一个正在被写的文件这种坑不会出现。
  try {
    renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch {
    /* 轮转失败就继续写原文件 */
  }
  logBytes = 0;
}

function flushLog() {
  if (logFlushing || logPending.length === 0) return;
  const chunk = logPending.join('');
  const size = Buffer.byteLength(chunk);
  logPending = [];
  if (logBytes + size > MAX_LOG_BYTES) rotateLog();
  logBytes += size;
  logFlushing = true;
  appendFile(LOG_FILE, chunk, (err) => {
    logFlushing = false;
    if (err) return; // 丢一条日志可以接受，绝不冒泡影响转发
    if (logPending.length) flushLog();
  });
}

function log(message) {
  logPending.push(`${new Date().toISOString()} ${message}\n`);
  if (logPending.length >= LOG_FLUSH_LINES) flushLog();
}

/** 进程退出前把缓冲写完（异步 flush 可能还没落地） */
function flushLogSync() {
  if (logPending.length === 0) return;
  const chunk = logPending.join('');
  logPending = [];
  try {
    if (logBytes + Buffer.byteLength(chunk) > MAX_LOG_BYTES) rotateLog();
    appendFileSync(LOG_FILE, chunk);
  } catch {
    /* ignore */
  }
}

openLog();
const logTimer = setInterval(flushLog, LOG_FLUSH_MS);
logTimer.unref();

function logAccess(req, res, status, startedAt, bytes) {
  if (!cfg.accessLog) return;
  // 只记 path，绝不记 query —— 配对参数与 client_id 都在 query 里
  let path = req.url ?? '/';
  const q = path.indexOf('?');
  if (q >= 0) path = path.slice(0, q);
  const ms = Date.now() - startedAt;
  log(
    `access ${clientIp(req)} ${req.method} ${path} ${status} ${ms}ms` +
      (bytes !== undefined ? ` ${bytes}B` : ''),
  );
  // 异常状态（401/403/429/5xx）立刻落盘：真出事时这几行最值钱，
  // 不能让它们躺在 0.5 秒的缓冲区里等着被硬杀丢掉。
  if (status >= 400) flushLog();
}

/**
 * 记录「大响应对端到底收全了没有」。
 *
 * 必须单独记，因为 res 的 finish 事件只表示数据交给了内核缓冲区，
 * **不代表对端收到**。用户实测报过一次：
 *
 *   HTTP 200、2063ms、失败阶段 parse、TypeError: Failed to fetch
 *   （代理日志写着 200 13384621B，看起来一切正常）
 *
 * 查下来是他手机在传输途中换了出口 IP（157.61.160.31 → 111.55.210.62），
 * 那条 TCP 连接直接失效。代理把 13MB 全写进缓冲区就记了「成功」，
 * 从日志完全看不出对端没收到 —— 这个盲区必须补，否则下次还是查不出来。
 *
 * 用 socket.bytesWritten 的**增量**（不是绝对值）：keep-alive 下同一 socket
 * 会复用给多个响应，绝对值里混着别的请求。大响应期间基本独占，够用。
 */
const deliveryStart = new WeakMap();

function trackDelivery(res) {
  if (res.socket) deliveryStart.set(res, res.socket.bytesWritten || 0);
}

/**
 * 分块写一个 body，让「客户端中途断掉」有机会被观测到。
 *
 * 为什么不能直接 res.end(body)：那是一次性把整个 body 塞进内核缓冲区。
 * 实测 6MB 在本地回环 4ms 就写完了，此时 writableFinished=true、
 * bytesWritten 是完整值 —— 服务端**根本无从得知**对端没读。
 * 这正是用户那次「HTTP 200 但 Failed to fetch」在日志里完全看不出来的原因。
 *
 * 分块 + 等 drain 之后，一旦对端消失，socket 会抛 ECONNRESET 且
 * writableFinished 保持 false，这时才真正可判定。
 * 实测 20MB / 客户端 576KB 后断开：375ms 时拿到
 *   sock-err:ECONNRESET | finished=false | destroyed=true | wrote=4480KB
 */
function writeChunked(res, body, chunkSize = 64 * 1024) {
  return new Promise((resolve) => {
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
      if (off >= body.length) {
        res.end();
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
      if (ok) setImmediate(pump);
      else res.once('drain', pump);   // 背压：等内核缓冲区腾空
    };
    pump();
  });
}

function reportDelivery(req, res, declaredBytes) {
  if (!declaredBytes || declaredBytes < 512 * 1024) return;   // 小响应不记
  if (res.writableFinished) return;                            // 正常写完
  let wrote = 0;
  try {
    const base = deliveryStart.get(res);
    const now = res.socket ? res.socket.bytesWritten || 0 : 0;
    wrote = base === undefined ? now : Math.max(0, now - base);
  } catch {
    /* socket 已销毁，拿不到就记 0 */
  }
  let path = req.url ?? '/';
  const q = path.indexOf('?');
  if (q >= 0) path = path.slice(0, q);
  log(
    `传输中断 ${clientIp(req)} ${req.method} ${path}: ` +
      `声明 ${declaredBytes}B，实际写出 ${wrote}B —— 客户端没收到完整响应`,
  );
  flushLog();   // 这条最值钱，立刻落盘
}

/**
 * 压缩路径专用的中断观测。
 *
 * 为什么不能复用 reportDelivery：压缩是用 z.pipe(res) 输出的，
 * 压缩流会把数据一路推进内核缓冲区，等到 close 事件时
 * writableFinished 往往已经是 true —— 实测 br/gzip 两条路径都测不出来，
 * 而这个观测恰好只在压缩路径上才真正有用（浏览器一律带 Accept-Encoding）。
 *
 * 可靠信号是 socket 上的 ECONNRESET / EPIPE：
 * 对端消失时内核会先给 socket 一个 error，再 close。
 * 实测「12MB 随机数据 + 客户端 300KB 后断开」：
 *   sock-err:ECONNRESET | finished=false | destroyed=true
 * 所以这里盯 socket error，而不是 res 的完成状态。
 */
function watchCompressedDelivery(req, res, declaredBytes) {
  if (!declaredBytes || declaredBytes < 512 * 1024) return;
  const sock = res.socket;
  if (!sock) return;
  let broken = false;
  const onErr = (e) => {
    if (broken) return;
    broken = true;
    let path = req.url ?? '/';
    const q = path.indexOf('?');
    if (q >= 0) path = path.slice(0, q);
    log(
      `传输中断 ${clientIp(req)} ${req.method} ${path}: ` +
        `声明 ${declaredBytes}B，客户端没收到完整响应（${e.code || 'socket-error'}）`,
    );
    flushLog();
  };
  sock.on('error', onErr);
  res.on('close', () => {
    // close 之后 socket 可能还能读到 error 标志；已写过就不重复记
    if (!broken && sock.errored) onErr(sock.errored);
  });
}

// ---- 实例发现 ---------------------------------------------------------------

const discovery = createDiscovery({
  instancesDir: cfg.instancesDir,
  healthPath: cfg.healthPath,
  onDiscover: (port) => log(`discovered desktop port ${port}`),
});

// ---- 访问控制 ---------------------------------------------------------------

const failureLimiter = new FailureLimiter({ max: 5, windowMs: 60_000 });
// 配对码是 6 位数字：没有失败计数的话，一个 60 秒窗口内理论上能试掉
// 十万分之几。单独限速后这条路径的爆破概率直接归零。
const pairLimiter = new FailureLimiter({ max: 5, windowMs: 60_000 });
const rateLimiter = new RateLimiter({ perMinute: cfg.rateLimitPerMin });

/** 从 Cookie 判断是否已通过 PIN */
function hasValidSession(req) {
  if (!cfg.pinEnabled) return true;
  const cookies = parseCookies(req.headers.cookie);
  return verifySessionToken(cfg.pin, cookies[SESSION_COOKIE]);
}

function requestIsHttps(req) {
  const proto = req.headers['x-forwarded-proto'];
  if (typeof proto === 'string' && proto.split(',')[0].trim() === 'https') return true;
  const cfv = req.headers['cf-visitor'];
  if (typeof cfv === 'string' && cfv.includes('https')) return true;
  return false;
}

function sessionSetCookie(req) {
  const parts = [
    `${SESSION_COOKIE}=${newSessionToken(cfg.pin)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_TTL_SEC}`,
  ];
  if (requestIsHttps(req)) parts.push('Secure');
  return parts.join('; ');
}

// ---- 一次性配对口令 ---------------------------------------------------------
//
// 记录从「用完即删」改成「标记已兑换并多留一会儿」。
// 删掉之后，终端就没法区分"被用掉了"和"过期了"——这正是
// "手机上已经登录成功、电脑上还在说已失效"的根因。
// 留 10 分钟足够终端那一侧轮询读到结果，之后照旧清掉。

const PAIR_REDEEMED_RETENTION_MS = 10 * 60_000;
// 硬上限：码空间只有 100 万个，`do…while (pairCodes.has(code))` 在塞满时
// 会永久自旋。正常使用远到不了这个量级（每台设备一个码），所以超了就
// 从最旧的开始丢——宁可丢状态，也不能把事件循环卡死。
const MAX_PAIR_RECORDS = 5000;

const pairCodes = new Map(); // code -> { expiresAt, redeemedAt }

function sweepPairCodes() {
  const now = Date.now();
  for (const [code, rec] of pairCodes) {
    if (rec.redeemedAt) {
      if (now - rec.redeemedAt > PAIR_REDEEMED_RETENTION_MS) pairCodes.delete(code);
    } else if (rec.expiresAt <= now) {
      pairCodes.delete(code);
    }
  }
}

function issuePairCode() {
  sweepPairCodes();
  while (pairCodes.size >= MAX_PAIR_RECORDS) {
    // 先丢已兑换的（对用户已经没用了），实在没有才动最旧的有效码
    let victim = null;
    for (const [k, v] of pairCodes) {
      if (v.redeemedAt) { victim = k; break; }
    }
    if (!victim) victim = pairCodes.keys().next().value ?? null;
    if (!victim) break;
    pairCodes.delete(victim);
  }
  let code;
  do {
    code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  } while (pairCodes.has(code));
  pairCodes.set(code, { expiresAt: Date.now() + cfg.pairTtlMs, redeemedAt: 0 });
  return code;
}

/**
 * 单个码的当前状态。
 * unknown 有两种可能：从没发出过，或已过期被清理——对调用方都是"没戏了"。
 */
function pairStateOf(code) {
  const rec = pairCodes.get(code);
  if (!rec) return 'unknown';
  if (rec.redeemedAt) return 'redeemed';
  if (rec.expiresAt <= Date.now()) return 'expired';
  return 'pending';
}

/** 未兑换且未过期的码数量 */
function pendingPairCount() {
  const now = Date.now();
  let n = 0;
  for (const rec of pairCodes.values()) if (!rec.redeemedAt && rec.expiresAt > now) n++;
  return n;
}

/**
 * 一次性消费：先标记再返回，重放看到 redeemedAt 直接拒绝。
 * 不再立即删除记录——删除会让状态无从查询。
 */
function consumePairCode(code) {
  if (!code) return false;
  const rec = pairCodes.get(code);
  if (!rec) return false;
  if (rec.redeemedAt) return false;
  if (rec.expiresAt <= Date.now()) {
    pairCodes.delete(code);
    return false;
  }
  rec.redeemedAt = Date.now();
  return true;
}

function readDesktopToken() {
  try {
    return readFileSync(cfg.tokenFile, 'utf8').trim();
  } catch {
    return '';
  }
}

// ---- 配对链接输出 -----------------------------------------------------------

function pairUrlFor(code) {
  return `${cfg.publicUrl}/__pair?code=${code}`;
}

/** 终端二维码：强制黑块白底，深色终端里也能扫 */
function qrBlock(text) {
  const art = qrTerminal(qrEncode(text, { ecc: 'M' }), { quiet: 2 });
  const padded = art
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
  return process.stdout.isTTY ? `\x1b[30;47m${padded}\x1b[0m` : padded;
}

/**
 * 代理自己的可达地址。
 *
 * 只绑 `::1` 时（POCKET_BIND=::1）127.0.0.1 是连不上的，CLI 取码与
 * 状态轮询都会失败，还会被报成"代理没在运行"。这里跟着 bind 走。
 */
function probeBase() {
  // ::1 与 :: 都走 IPv6 回环：绑定 :: 时若 IPV6_V6ONLY=1，127.0.0.1 是连不上的
  return cfg.bind === '::1' || cfg.bind === '::' ? 'http://[::1]' : 'http://127.0.0.1';
}

/** 问本机代理：这几个码现在什么状态（仅本机可访问） */
async function fetchPairStates(codes) {
  const url =
    `${probeBase()}:${cfg.port}/__pairstatus` +
    `?codes=${encodeURIComponent(codes.join(','))}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`/__pairstatus 返回 HTTP ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body?.codes)) throw new Error('/__pairstatus 返回体缺少 codes');
  return body;
}

/**
 * 打印配对链接与二维码，然后盯着它的状态直到结束。
 * @param {string[]} codes
 * @param {{withQr?: boolean, deadline: number}} opts
 * @returns {Promise<{ok: boolean, redeemed: number, total: number}>}
 */
function printPairLinks(codes, { withQr = true, deadline } = {}) {
  for (const code of codes) {
    const url = pairUrlFor(code);
    process.stdout.write(`\n配对链接（一次性，用后立即失效）\n  ${url}\n`);
    if (withQr) process.stdout.write(`\n${qrBlock(url)}\n`);
  }
  process.stdout.write(
    `\n  一台设备一个码；该设备凭证 ${CREDENTIAL_TTL_DAYS} 天有效。` +
      (codes.length === 1 ? ' 多设备加 --pair-count。' : '') +
      '\n',
  );
  return watchPairProgress(codes, deadline, { poll: fetchPairStates });
}

/**
 * 向正在运行的代理要 n 个一次性口令。
 * @returns {Promise<{codes: string[], expiresInSec: number}>}
 */
async function requestPairCodes(count) {
  const codes = [];
  let expiresInSec = Math.round(cfg.pairTtlMs / 1000);
  for (let i = 0; i < count; i++) {
    const res = await fetch(`${probeBase()}:${cfg.port}/__paircode`);
    if (!res.ok) throw new Error(`/__paircode 返回 HTTP ${res.status}`);
    const body = await res.json();
    if (!body?.code) throw new Error('/__paircode 未返回 code');
    if (Number.isFinite(body.expiresInSec)) expiresInSec = Number(body.expiresInSec);
    codes.push(body.code);
  }
  return { codes, expiresInSec };
}

// ---- --pair-only：只出码，不起服务 ------------------------------------------

if (args.pairOnly) {
  let issued;
  try {
    issued = await requestPairCodes(pairCount);
  } catch (e) {
    process.stderr.write(
      `[配对失败] 连不上 ${probeBase()}:${cfg.port}/__paircode —— 代理没在运行？\n` +
        `  原因: ${e.message}\n` +
        `  先启动代理: node src/proxy.mjs --base ${cfg.publicUrl}\n`,
    );
    process.exit(1);
  }

  process.stdout.write(`\n公网入口 ${cfg.publicUrl}\n`);
  // 用服务端返回的有效期算截止时刻，比本地 TTL 更准（还含了请求往返）
  const deadline = Date.now() + issued.expiresInSec * 1000;
  await printPairLinks(issued.codes, { deadline });
  process.exit(0);
}

// ---- 小型响应工具 -----------------------------------------------------------

function send(res, { status = 200, headers = {}, body = '' }) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(obj),
  });
}

function redirect(res, location, extraHeaders = {}) {
  res.writeHead(302, { location, 'cache-control': 'no-store', ...extraHeaders });
  res.end();
}

async function readBody(req, limitBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new Error('body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// ---- 响应压缩 ---------------------------------------------------------------

function pickEncoding(req) {
  const ae = String(req.headers['accept-encoding'] ?? '');
  if (/\bbr\b/.test(ae)) return 'br';
  if (/\bgzip\b/.test(ae)) return 'gzip';
  return null;
}

/**
 * 只压缩 JSON。理由：
 *   - 实测 Desktop 响应**没有** Content-Encoding，长会话 JSON 原样走 4G
 *   - text/event-stream 是流式的，压缩会破坏逐条 flush，必须放过
 *   - 已压缩过的（有 content-encoding）不重复压
 */
function shouldCompress(req, upstreamRes) {
  if (!cfg.compress) return false;
  if (req.method === 'HEAD') return false;
  const ct = String(upstreamRes.headers['content-type'] ?? '');
  if (!/^application\/json\b/i.test(ct)) return false;
  if (upstreamRes.headers['content-encoding']) return false;
  const len = Number(upstreamRes.headers['content-length'] ?? 0);
  if (len > 0 && len < 1024) return false;
  return pickEncoding(req) !== null;
}

// ---- 上游连接池 -------------------------------------------------------------
//
// Node 19 之前的全局 agent 默认 keepAlive=false，也就是说每个代理请求都要
// 重新握手一次 TCP。页面加载会并发几十个请求，这个差值是肉眼可见的。
// 现在要求 Node 22+，默认已开，但仍然显式写死——不依赖上游默认值。

const upstreamAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 64,
  maxFreeSockets: 16,
  timeout: 60_000,
});

// ---- 主服务 -----------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const startedAt = Date.now();
  let pathname = '/';
  let query = new URLSearchParams();
  try {
    const url = new URL(req.url ?? '/', 'http://placeholder');
    pathname = url.pathname;
    query = url.searchParams;
  } catch {
    send(res, { status: 400, body: '请求路径非法' });
    return;
  }

  // 「本机」必须同时满足两点：回环 socket + 不带 Cloudflare 头。
  // cloudflared 在本机发起连接，只看 remoteAddress 会把公网请求当成本机。
  const fromLocal = isLocalRequest(req);

  // ---- 全局限速 ----
  // /__healthz 也参与限速：它每次都会真去探活 Desktop，不该成为
  // 一个免费的放大入口（监控 30 次/分钟也远低于默认上限）。
  if (cfg.rateLimitPerMin > 0) {
    const { allowed } = rateLimiter.hit(clientIp(req));
    if (!allowed) {
      logAccess(req, res, 429, startedAt);
      sendJson(res, 429, { ok: false, error: 'rate_limited' });
      return;
    }
  }

  // ---- 代理自有端点 ----

  if (pathname === '/__healthz') {
    const port = await discovery.discover({ force: true });
    if (fromLocal) {
      sendJson(res, port ? 200 : 503, {
        ok: !!port,
        proxyPort: cfg.port,
        desktopPort: port,
        pin: cfg.pinEnabled,
        version: VERSION,
        ts: Date.now(),
      });
    } else {
      // 不回显内部端口：公网只知道"活着没"
      sendJson(res, port ? 200 : 503, { ok: !!port });
    }
    logAccess(req, res, port ? 200 : 503, startedAt);
    return;
  }

  if (pathname === '/__status') {
    if (!fromLocal) {
      send(res, { status: 404, body: '404' });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      version: VERSION,
      proxyPort: cfg.port,
      bind: cfg.bind,
      desktopPort: discovery.cached,
      appHome: cfg.appHome,
      publicUrl: cfg.publicUrl || null,
      pinEnabled: cfg.pinEnabled,
      compress: cfg.compress,
      accessLog: cfg.accessLog,
      rateLimitPerMin: cfg.rateLimitPerMin,
      pairCodesPending: pendingPairCount(),
      uptimeSec: Math.round(process.uptime()),
      node: process.version,
    });
    logAccess(req, res, 200, startedAt);
    return;
  }

  if (pathname === '/__pairstatus') {
    // 仅本机：泄露"某个码是否已被兑换"等于送出一条旁路探测通道
    if (!fromLocal) {
      send(res, { status: 404, body: '404' });
      logAccess(req, res, 404, startedAt); // 公网来探测这条路径必须留痕
      return;
    }
    if (req.method !== 'GET') {
      send(res, { status: 405, body: 'Method Not Allowed' });
      logAccess(req, res, 405, startedAt);
      return;
    }
    const raw = query.get('codes') ?? query.get('code') ?? '';
    const wanted = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, MAX_PAIR_COUNT);
    const now = Date.now();
    const list = wanted.map((code) => {
      const rec = pairCodes.get(code);
      return {
        code,
        state: pairStateOf(code),
        redeemedAt: rec?.redeemedAt || null,
        expiresInSec:
          rec && !rec.redeemedAt ? Math.max(0, Math.round((rec.expiresAt - now) / 1000)) : 0,
      };
    });
    const redeemed = list.filter((x) => x.state === 'redeemed').length;
    // 刻意不记访问日志：终端每秒问一次，180 秒就是 180 行噪音，
    // 而真正值得留痕的事件（谁兑换了码）在 /__pair 那条日志里。
    sendJson(res, 200, {
      total: list.length,
      redeemed,
      pending: list.filter((x) => x.state === 'pending').length,
      codes: list,
    });
    return;
  }

  if (pathname === '/__paircode') {
    if (!fromLocal) {
      send(res, { status: 404, body: '404' });
      return;
    }
    if (req.method !== 'GET') {
      send(res, { status: 405, body: 'Method Not Allowed' });
      return;
    }
    const code = issuePairCode();
    logAccess(req, res, 200, startedAt);
    sendJson(res, 200, {
      code,
      path: `/__pair?code=${code}`,
      expiresInSec: Math.round(cfg.pairTtlMs / 1000),
    });
    return;
  }

  if (pathname === '/__qrcode') {
    if (!fromLocal) {
      send(res, { status: 404, body: '404' });
      return;
    }
    let data = query.get('data');
    if (!data && req.method === 'POST') {
      try {
        data = (await readBody(req, 2048)).toString('utf8').trim();
      } catch {
        send(res, { status: 413, body: '内容过长' });
        return;
      }
    }
    if (!data) {
      send(res, { status: 400, body: '缺少 data 参数' });
      return;
    }
    if (data.length > 1024) {
      send(res, { status: 413, body: 'data 超过 1024 字符' });
      return;
    }
    try {
      const png = qrPng(qrEncode(data, { ecc: 'M' }));
      send(res, {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': String(png.length) },
        body: png,
      });
    } catch (e) {
      send(res, { status: 500, body: `二维码生成失败: ${e.message}` });
    }
    return;
  }

  if (pathname === '/__login') {
    if (!cfg.pinEnabled) {
      send(res, { status: 404, body: '404' });
      return;
    }
    const ip = clientIp(req);
    const lockedFor = failureLimiter.retryAfterMs(ip);
    if (failureLimiter.isLocked(ip)) {
      send(res, loginPage({ lockedFor }));
      logAccess(req, res, 401, startedAt);
      return;
    }

    if (req.method === 'GET') {
      const next = query.get('next') ?? '/';
      send(res, loginPage({ next }));
      logAccess(req, res, 200, startedAt);
      return;
    }

    if (req.method === 'POST') {
      let body;
      try {
        body = (await readBody(req, 4096)).toString('utf8');
      } catch {
        send(res, { status: 413, body: '请求体过大' });
        return;
      }
      const form = new URLSearchParams(body);
      const pin = form.get('pin') ?? '';
      const next = form.get('next') ?? '/';
      const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : '/';

      if (constantTimeEqual(pin, cfg.pin)) {
        failureLimiter.clear(ip);
        logAccess(req, res, 302, startedAt);
        redirect(res, safeNext, { 'set-cookie': sessionSetCookie(req) });
        return;
      }

      failureLimiter.recordFailure(ip);
      log(`auth failure from ${ip}`);
      const locked = failureLimiter.isLocked(ip);
      send(res, loginPage({ next: safeNext, error: locked ? '' : '口令不正确', lockedFor: locked ? 60_000 : 0 }));
      logAccess(req, res, 401, startedAt);
      return;
    }

    send(res, { status: 405, body: 'Method Not Allowed' });
    return;
  }

  if (pathname === '/__pair') {
    const ip = clientIp(req);
    if (pairLimiter.isLocked(ip)) {
      log(`pair locked out: ${ip}`);
      sendJson(res, 429, { ok: false, error: 'too_many_attempts' });
      logAccess(req, res, 429, startedAt);
      return;
    }

    const code = query.get('code');

    // 这里**没有**"本机免 code"的分支：本机豁免曾经看着方便，
    // 但 cloudflared 也在本机发起连接，于是"本机"就成了"全网"。
    // 现在一律要求一次性口令，本机也一样。
    if (!code) {
      pairLimiter.recordFailure(ip);
      send(res, pairRejectedPage('缺少配对口令。'));
      logAccess(req, res, 401, startedAt);
      return;
    }

    // 先确认拿得到 Desktop 凭证，再兑换口令。
    // 反过来做会出一个很难查的 bug：码已经烧掉、页面却发不出去（503），
    // 而终端只看到"码被兑换了"，于是把失败报成配对成功。
    const token = readDesktopToken();
    if (!token) {
      send(
        res,
        errorPage({
          title: '找不到 Desktop 凭证',
          detail: `读取 ${cfg.tokenFile} 失败。`,
          hint: '确认 Kimi Code Desktop 已经启动过至少一次。口令没有消耗，启动后再扫一次即可。',
        }),
      );
      logAccess(req, res, 503, startedAt);
      return;
    }

    if (!consumePairCode(code)) {
      pairLimiter.recordFailure(ip);
      send(res, pairRejectedPage('口令错误、已过期或已被使用过。'));
      logAccess(req, res, 401, startedAt);
      return;
    }
    pairLimiter.clear(ip);
    log(`pair page opened from ${ip}`);

    const headers = {};
    // 配对页下发时顺手发一个 PIN 会话，免得再过一次口令墙
    if (cfg.pinEnabled) headers['set-cookie'] = sessionSetCookie(req);
    const pageResult = pairPage({ token, days: CREDENTIAL_TTL_DAYS });
    send(res, { ...pageResult, headers: { ...pageResult.headers, ...headers } });
    logAccess(req, res, 200, startedAt);
    return;
  }

  // ---- PIN 闸门（以上端点已自行处理）----

  if (!hasValidSession(req)) {
    if (pathname.startsWith('/api/')) {
      sendJson(res, 401, { ok: false, error: 'pin_required' });
    } else if (req.method === 'GET' || req.method === 'HEAD') {
      redirect(res, `/__login?next=${encodeURIComponent(pathname + (query.toString() ? `?${query}` : ''))}`);
    } else {
      sendJson(res, 401, { ok: false, error: 'pin_required' });
    }
    logAccess(req, res, 401, startedAt);
    return;
  }

  // ---- 转发到 Desktop ----

  const port = await discovery.discover();
  if (!port) {
    send(
      res,
      errorPage({
        title: 'Kimi Code Desktop 未运行',
        detail: '代理是活的，但找不到已注册的 Desktop 实例。',
        hint: '在电脑上启动 Kimi Code Desktop，然后在手机上下拉刷新。',
      }),
    );
    logAccess(req, res, 503, startedAt);
    return;
  }

  const declaredLength = Number(req.headers['content-length'] ?? 0);
  if (declaredLength > cfg.maxBodyBytes) {
    send(res, { status: 413, body: `请求体超过上限（${cfg.maxBodyBytes} 字节）` });
    logAccess(req, res, 413, startedAt);
    return;
  }

  const headers = rewriteHeaders(req.headers, port);

  const proxyReq = http.request(
    { host: '127.0.0.1', port, path: req.url, method: req.method, headers, agent: upstreamAgent },
    (proxyRes) => {
      const hdrs = { ...proxyRes.headers };

      // ---- 轮次导航注入 ----------------------------------------------------
      // 桌面端右侧有「对话目录」，但组件里写死了 `!mobile`，而 mobile 就是
      // `(max-width: 640px)` —— 手机上一律不渲染。这里在 HTML 里补一段脚本，
      // 用官方的 data-turn-id 自己画一个胶囊，贴在输入框右上角。
      //
      // 为什么在代理做而不是改 Kimi 的包：见 lib/toc.mjs 顶部注释。
      if (shouldInjectNav(req, proxyRes, cfg.turnNav)) {
        void (async () => {
          const chunks = [];
          let size = 0;
          let overflow = false;
          try {
            for await (const chunk of proxyRes) {
              chunks.push(chunk);
              size += chunk.length;
              if (size > MAX_HTML_BYTES) {
                // 上游没给 content-length 且体量失控：不再缓冲，已读部分当降级内容
                overflow = true;
                break;
              }
            }
            const raw = Buffer.concat(chunks);
            if (overflow) {
              log(`轮次导航注入跳过 ${pathname}: HTML 超过 ${MAX_HTML_BYTES} 字节`);
              const h = { ...hdrs };
              delete h['content-length'];
              h['content-length'] = String(raw.length);
              res.writeHead(200, h);
              res.end(raw);
              logAccess(req, res, 200, startedAt, raw.length);
              return;
            }
            const html = injectTurnNav(raw.toString('utf8'));
            const out = Buffer.from(html, 'utf8');
            const h = { ...hdrs };
            delete h['content-length'];
            delete h['transfer-encoding'];
            h['content-length'] = String(out.length);
            res.writeHead(200, h);
            res.end(out);
            logAccess(req, res, 200, startedAt, out.length);
          } catch (e) {
            // 注入失败绝不能拖垮首页：只要能拿到原始 HTML 就原样发。
            log(`轮次导航注入跳过 ${pathname}: ${e.message}`);
            if (!res.headersSent) {
              const raw = Buffer.concat(chunks);
              if (raw.length > 0) {
                res.writeHead(200, { ...hdrs, 'content-length': String(raw.length) });
                res.end(raw);
                logAccess(req, res, 200, startedAt, raw.length);
              } else {
                res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
                res.end('页面读取失败');
                logAccess(req, res, 502, startedAt);
              }
            } else {
              res.end();
            }
          }
        })();
        return;
      }

      // ---- 大响应瘦身（优先于压缩）------------------------------------------
      // transcript / messages 里工具截图是 base64 PNG。实测 /transcript 51MB
      // 里 48.6MB 是 38 张截图（95.4%），文字只有 1.95MB。
      // 这里只降图片分辨率，文字一个字符都不动；压缩跑在 worker 线程。
      if (shouldTrim(req, proxyRes, cfg.trim)) {
        void (async () => {
          // 在 try 外声明：catch 里要用它做降级透传
          const chunks = [];
          let rawBody = null;
          let rawLen = 0;
          try {
            for await (const chunk of proxyRes) {
              rawLen += chunk.length;
              if (rawLen > cfg.trim.maxBufferBytes) {
                // 太大的不缓冲，直接放弃瘦身并把已读的部分算进去
                rawBody = null;
                throw new Error('trim buffer overflow');
              }
              chunks.push(chunk);
            }
            const raw = Buffer.concat(chunks);
            rawBody = raw;
            const result = await trimJsonBuffer(raw, cfg.trim);

            // null = 「这条响应里没有可压的截图」或「不是合法 JSON」。
            // 这是正常情况，**必须原样透传**，不能当失败。
            // 曾经这里写成 throw new Error('nothing to shrink')，导致所有
            // 「没有截图的长会话」（比如纯文本对话）一律 502 Bad Gateway ——
            // 用户手机上看到的就是 Cloudflare 的错误页。
            if (!result) {
              const passthrough = { ...hdrs };
              delete passthrough['content-length'];
              passthrough['content-length'] = String(raw.length);
              res.writeHead(proxyRes.statusCode ?? 200, passthrough);
              res.end(raw);
              logAccess(req, res, proxyRes.statusCode ?? 200, startedAt, raw.length);
              return;
            }

            const body = result.buffer;
            const out = { ...hdrs };
            delete out['content-length'];
            delete out['transfer-encoding'];
            out['content-length'] = String(body.length);
            out['x-pocket-trimmed'] = '1';

            log(
              `瘦身 ${pathname}: ${(result.stats.originalBytes / 1024 / 1024).toFixed(2)}MB → ` +
                `${(result.stats.trimmedBytes / 1024 / 1024).toFixed(2)}MB；` +
                formatStats(result.stats),
            );

            // 记录「对端到底收全了没有」。瘦身后的响应仍有几 MB，
            // 是弱网中途断掉的重灾区；不记的话日志里只会看到「200 成功」。
            //
            // 这里传的是**未压缩**的 body.length，不是 content-length：
            // 压缩路径会删掉 content-length 改用 chunked，那时代理会把
            // reportDelivery 里的判据当成 0 而直接跳过 —— 实测 br/gzip 下
            // 中断完全记不下来，等于这个观测在真实使用路径上是失效的。
            // 用未压缩大小当阈值是安全的：它只会让「更小的实际传输」也进统计。
            trackDelivery(res);
            res.on('close', () => reportDelivery(req, res, body.length));
            // 压缩路径另用一个观测（writableFinished 在那儿不可靠）
            watchCompressedDelivery(req, res, body.length);

            // 裁剪后一般只有几百 KB，压缩收益有限；但手机流量仍是钱，
            // 保留压缩（条件与 shouldCompress 一致，只是不看 size 门槛）。
            if (cfg.compress && req.method !== 'HEAD' && pickEncoding(req)) {
              const enc = pickEncoding(req);
              out['content-encoding'] = enc;
              out['vary'] = 'accept-encoding';
              delete out['content-length'];
              res.writeHead(proxyRes.statusCode ?? 502, out);
              const z =
                enc === 'br'
                  ? createBrotliCompress({ params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 6 } })
                  : createGzip({ level: 6 });
              z.on('error', () => res.destroy());
              res.on('close', () => z.destroy());
              // 先接管道再写入：写成 z.end(body, () => z.pipe(res)) 会让
              // 压缩流在 pipe 接上之前就结束，数据全丢、连接挂到超时。
              // 交给管道处理背压即可 —— 压缩流本身会分块输出，
              // 天然不会一次性把几 MB 全灌进内核缓冲区。
              z.pipe(res);
              z.end(body);
            } else {
              res.writeHead(proxyRes.statusCode ?? 502, out);
              // 分块写：一次性 end 会让 6MB 在几毫秒内全部进内核缓冲区，
              // 于是「对端没读」这件事在服务端完全不可见（见 writeChunked 注释）。
              await writeChunked(res, body);
            }
            logAccess(req, res, proxyRes.statusCode ?? 502, startedAt, body.length);
          } catch (e) {
            // 瘦身失败**不能拖垮请求**：只要上游数据已经完整读到，就原样透传。
            // 瘦身是锦上添花，不是必需品 —— 宁可慢一点（手机可能超时），
            // 也不要直接 502 让整个会话打不开。
            log(`瘦身跳过 ${pathname}: ${e.message}`);
            if (!res.headersSent) {
              if (rawLen > 0 && rawBody) {
                res.writeHead(proxyRes.statusCode ?? 200, {
                  ...hdrs,
                  'content-length': String(rawBody.length),
                });
                res.end(rawBody);
                logAccess(req, res, proxyRes.statusCode ?? 200, startedAt, rawBody.length);
              } else {
                // 连数据都没拿到（缓冲溢出等），只能报错
                res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
                res.end(`响应过大且无法处理: ${e.message}`);
                logAccess(req, res, 502, startedAt);
              }
            } else {
              res.end();
            }
          }
        })();
        return;
      }

      if (shouldCompress(req, proxyRes)) {
        const enc = pickEncoding(req);
        // 大响应（长会话 JSON）用更高的压缩比，小响应不为了几个字节
        // 多花 CPU —— 手机走 4G 时前者省的是真流量。
        const big = Number(proxyRes.headers['content-length'] ?? 0) > 512 * 1024;
        delete hdrs['content-length'];
        hdrs['content-encoding'] = enc;
        hdrs['vary'] = 'accept-encoding';
        res.writeHead(proxyRes.statusCode ?? 502, hdrs);
        const z =
          enc === 'br'
            ? createBrotliCompress({
                params: { [zlibConstants.BROTLI_PARAM_QUALITY]: big ? 6 : 4 },
                flush: zlibConstants.BROTLI_OPERATION_FLUSH,
              })
            : createGzip({ level: big ? 6 : 5, flush: zlibConstants.Z_SYNC_FLUSH });
        z.on('error', () => res.destroy());
        res.on('close', () => z.destroy());
        proxyRes.pipe(z).pipe(res);
      } else {
        res.writeHead(proxyRes.statusCode ?? 502, hdrs);
        proxyRes.pipe(res);
      }

      res.on('finish', () => logAccess(req, res, proxyRes.statusCode ?? 502, startedAt));
      // 未走瘦身的透传路径也可能很大（比如被 trim 排除的路径）。
      // 只在大响应上挂钩，避免每个请求都多挂一个 close 监听。
      const passLen = Number(proxyRes.headers['content-length'] ?? 0);
      if (passLen >= 512 * 1024) {
        res.on('close', () => reportDelivery(req, res, passLen));
      }
    },
  );

  proxyReq.on('error', (e) => {
    log(`http proxy error -> ${port}: ${e.message}`);
    if (!res.headersSent) {
      send(res, { status: 502, body: `上游错误: ${e.message}` });
    } else {
      res.end();
    }
    logAccess(req, res, 502, startedAt);
  });

  // 空闲超时（不是总时长）。SSE 会持续有字节，不会被误杀。
  proxyReq.setTimeout(cfg.upstreamTimeoutMs, () => {
    proxyReq.destroy(new Error(`上游 ${cfg.upstreamTimeoutMs}ms 无响应`));
  });

  // 流式上传也做兜底计数，防止无 Content-Length 的 chunked 大包
  let sent = 0;
  req.on('data', (chunk) => {
    sent += chunk.length;
    if (sent > cfg.maxBodyBytes) {
      proxyReq.destroy(new Error('请求体超过上限'));
      req.destroy();
    }
  });

  req.pipe(proxyReq);
});

// ---- WebSocket 升级透传 -----------------------------------------------------

server.on('upgrade', async (req, clientSocket, head) => {
  const reject = (line) => {
    try {
      clientSocket.end(line);
    } catch {
      /* ignore */
    }
  };

  // 升级请求同样要过 PIN 闸门（浏览器会带上 Cookie）
  if (!hasValidSession(req)) {
    reject('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return;
  }

  const port = await discovery.discover();
  if (!port) {
    reject('HTTP/1.1 503 Service Unavailable\r\n\r\n');
    return;
  }

  const upstream = net.connect(port, '127.0.0.1', () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`, ...rewriteRawHeaders(req.rawHeaders, port)];
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) upstream.write(head);
    upstream.setKeepAlive(true, 30_000);
    clientSocket.setKeepAlive(true, 30_000);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });

  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    upstream.destroy();
    clientSocket.destroy();
  };

  upstream.on('error', (e) => {
    log(`ws upstream error -> ${port}: ${e.message}`);
    cleanup();
  });
  clientSocket.on('error', cleanup);
  // 网页关掉 / 手机切后台断网时，两端都要收摊；只挂 error 事件会漏掉
  // 正常 close 和 RST 的情形，留下半开的 socket。
  clientSocket.on('close', cleanup);
  upstream.on('close', cleanup);
  // 不设应用层空闲超时：长连接本来就可能长时间没有字节。两端的
  // TCP keepalive（30s）负责发现半开连接，不会永久驻留。
});

server.on('error', (e) => {
  log(`proxy server error: ${e.message}`);
  flushLogSync();
  process.stderr.write(`[启动失败] ${e.message}\n`);
  process.exit(1);
});

server.on('connection', (socket) => {
  socket.setKeepAlive(true, 30_000);
});

// 慢速上行（大文件/弱网）不要被默认 300s 掐断
server.requestTimeout = 30 * 60 * 1000;
server.headersTimeout = 60_000;

// 定期清理限速表与过期口令
const sweeper = setInterval(() => {
  rateLimiter.sweep();
  sweepPairCodes();
}, 60_000);
sweeper.unref();

// ---- 启动 -------------------------------------------------------------------

server.listen(cfg.port, cfg.bind, async () => {
  const port = await discovery.discover({ force: true });
  log(
    `proxy listening on ${cfg.bind}:${cfg.port}` +
      ` (pin=${cfg.pinEnabled ? 'on' : 'off'}, compress=${cfg.compress ? 'on' : 'off'})`,
  );

  const base = `http://${cfg.bind === '0.0.0.0' ? '127.0.0.1' : cfg.bind}:${cfg.port}`;
  process.stdout.write(`KimiCode Pocket ${VERSION} 代理已启动: ${base}\n`);
  process.stdout.write(`  健康检查   ${base}/__healthz\n`);
  process.stdout.write(`  运行状态   ${base}/__status\n`);
  process.stdout.write(`  口令保护   ${cfg.pinEnabled ? '已开启' : '未开启（仅靠 Desktop token）'}\n`);
  process.stdout.write(
    `  Desktop    ${port ? `127.0.0.1:${port}` : '未发现（启动 Kimi Code Desktop 后会自动跟上）'}\n`,
  );
  if (!isLoopbackHostSafe(cfg.bind)) {
    process.stdout.write(`  ⚠ 绑定在 ${cfg.bind}：局域网内其他设备可直达，请确认这是你要的\n`);
  }

  // 给了公网入口就顺手出一条配对链接：少一次"再开个窗口跑脚本"。
  if (cfg.publicUrl) {
    process.stdout.write(`  公网入口   ${cfg.publicUrl}\n`);
    // 不 await：服务已经起来了，倒计时只是给用户看的
    printPairLinks([issuePairCode()], { deadline: Date.now() + cfg.pairTtlMs });
  } else {
    process.stdout.write(
      `\n  要给手机配对，加 --base https://<你的域名> 启动，或另开一个终端跑：\n` +
        `    node src/proxy.mjs --pair-only --base https://<你的域名>\n`,
    );
  }
});

function isLoopbackHostSafe(host) {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

// ---- 退出 -------------------------------------------------------------------

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`received ${sig}, shutting down`);
    flushLogSync();
    server.close(() => process.exit(0));
    // keep-alive / WebSocket 会占住 close，主动把它们送走
    server.closeIdleConnections?.();
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
