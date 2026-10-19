/**
 * KimiCode Pocket — 配置解析
 *
 * 设计原则：
 *   1. 全部来自环境变量，不落配置文件（无状态，回滚=换代码）
 *   2. 危险组合直接拒绝启动，而不是打印警告后继续跑
 *      （最典型：绑非回环地址却没有设 PIN）
 */

import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** <repo>/src/lib/config.mjs → <repo> */
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export class ConfigError extends Error {}

/**
 * 默认状态目录（日志、配对产物都放这里）。
 *
 * 刻意**不**落在仓库里：这个包是"可交付物"，不是运行目录。
 * 从仓库里 `node src/proxy.mjs` 跑一次就往工作树写 .logs，会把
 * `git status` 弄脏，也让"干净发布"变成一件需要靠 .gitignore 兜底的事。
 */
export function defaultStateDir(env = process.env, platform = process.platform) {
  const home = homedir();
  if (platform === 'win32') {
    return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'kimicode-pocket');
  }
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'kimicode-pocket');
  }
  return join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'kimicode-pocket');
}

function toInt(name, raw, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ConfigError(`${name} 必须是 ${min}~${max} 之间的整数，收到: ${raw}`);
  }
  return n;
}

function toBool(name, raw, fallback) {
  if (raw === undefined || raw === '') return fallback;
  const v = String(raw).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  throw new ConfigError(`${name} 只接受 1/0、true/false，收到: ${raw}`);
}

/** 判断是否回环绑定地址 */
export function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

/**
 * 规范化公网入口地址（配对链接就是拼在它后面的）。
 *
 * 只允许 http(s)、去掉尾部斜杠；回环地址直接拒绝——那会生成一条
 * 手机根本打不开的二维码，属于"看着成功、实际不可用"的坑。
 */
export function normalizePublicUrl(raw) {
  const s = String(raw ?? '').trim().replace(/\/+$/, '');
  if (!s) return '';
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new ConfigError(`POCKET_PUBLIC_URL 不是合法 URL，收到: ${raw}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new ConfigError(`POCKET_PUBLIC_URL 只支持 http/https，收到: ${raw}`);
  }
  // URL.hostname 会把 IPv6 连方括号一起返回（`[::1]`），比较前先剥掉
  const hostname = u.hostname.replace(/^\[|\]$/g, '');
  if (isLoopbackHost(hostname)) {
    throw new ConfigError(
      `POCKET_PUBLIC_URL 不能用回环地址（${hostname}）：手机扫这个二维码打不开。\n` +
        `  这里要填隧道对外暴露的域名，例如 https://kimicode.example.com`,
    );
  }
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
}

/**
 * @param {Record<string,string|undefined>} env
 * @returns {object} 冻结后的配置
 */
export function loadConfig(env = process.env) {
  const appHome = env.POCKET_APP_HOME || join(homedir(), '.kimi-code');
  const bind = env.POCKET_BIND || '127.0.0.1';
  const pin = (env.POCKET_PIN || '').trim();
  const compress = toBool('POCKET_COMPRESS', env.POCKET_COMPRESS, true);
  const accessLog = toBool('POCKET_ACCESS_LOG', env.POCKET_ACCESS_LOG, true);

  const cfg = {
    port: toInt('POCKET_PORT', env.POCKET_PORT, 50980, { min: 1, max: 65535 }),
    bind,
    appHome,
    instancesDir: join(appHome, 'server', 'instances'),
    tokenFile: join(appHome, 'server.token'),
    healthPath: env.POCKET_HEALTH_PATH || '/api/v1/healthz',
    logDir: env.POCKET_LOG_DIR || join(defaultStateDir(), 'logs'),
    publicUrl: normalizePublicUrl(env.POCKET_PUBLIC_URL),

    // 上游空闲超时。Desktop 的流式输出会在 WS 上，但普通长任务
    // （会话压缩、大文件读写）可能长时间无字节，30s 会误杀。
    upstreamTimeoutMs: toInt('POCKET_UPSTREAM_TIMEOUT_MS', env.POCKET_UPSTREAM_TIMEOUT_MS, 120000, {
      min: 1000,
      max: 3600000,
    }),
    maxBodyBytes: toInt('POCKET_MAX_BODY_MB', env.POCKET_MAX_BODY_MB, 64, { min: 1, max: 1024 }) * 1024 * 1024,

    compress,
    accessLog,

    // ---- 大响应裁剪 ----------------------------------------------------------
    // Desktop 的 /transcript 会把每个 step 的 frames[].output（工具完整输出）
    // 全量返回。实测一个会话 30.87 MB，其中 frames 占 30.81 MB（99.8%）。
    // 手机在 5G 下拉 30MB，前端 fetch 的 30s 超时先到 → 「HTTP 200 但
    // parse 阶段 Failed to fetch」。这里在传输层做投影，不动桌面端数据。
    trim: {
      enabled: toBool('POCKET_TRIM', env.POCKET_TRIM, true),
      // 单个字符串最多保留多少字符（首 60% + 尾 28%，中间省略）
      maxChars: toInt('POCKET_TRIM_MAX_CHARS', env.POCKET_TRIM_MAX_CHARS, 32 * 1024, {
        min: 512,
        max: 4 * 1024 * 1024,
      }),
      // 裁剪后整体目标上限：超过就对折 maxChars 重试
      totalBytes: toInt('POCKET_TRIM_TOTAL_KB', env.POCKET_TRIM_TOTAL_KB, 1024, {
        min: 64,
        max: 64 * 1024,
      }) * 1024,
      // 小于这个大小的响应不处理（省 CPU）
      minBytes: toInt('POCKET_TRIM_MIN_KB', env.POCKET_TRIM_MIN_KB, 256, {
        min: 1,
        max: 64 * 1024,
      }) * 1024,
      // 超过这个大小的响应不缓冲（保护进程内存，宁可这条原样失败）
      maxBufferBytes: toInt('POCKET_TRIM_MAX_BUFFER_MB', env.POCKET_TRIM_MAX_BUFFER_MB, 128, {
        min: 1,
        max: 1024,
      }) * 1024 * 1024,
      // 只对这些路径生效（子串匹配，小写）
      paths: String(env.POCKET_TRIM_PATHS || 'transcript,messages')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    },

    rateLimitPerMin: toInt('POCKET_RATE_LIMIT', env.POCKET_RATE_LIMIT, 600, { min: 0, max: 100000 }),
    // 默认 180 秒：60 秒实测太紧——扫码、过 Access 登录、再点确认，
    // 手慢一点就过期了。3 分钟是"够用但又不敢放着不管"的长度。
    pairTtlMs: toInt('POCKET_PAIR_TTL_SEC', env.POCKET_PAIR_TTL_SEC, 180, { min: 30, max: 3600 }) * 1000,

    pin,
    pinEnabled: pin.length > 0,
  };

  if (pin && pin.length < 6) {
    throw new ConfigError(`POCKET_PIN 至少 6 位，当前 ${pin.length} 位`);
  }

  // 安全闸门：公开绑定 + 无 PIN = 把能执行代码的 Desktop 裸奔，拒绝启动
  if (!isLoopbackHost(bind) && !cfg.pinEnabled) {
    throw new ConfigError(
      `拒绝启动：POCKET_BIND=${bind} 会把代理暴露到回环之外，但你没有设置 POCKET_PIN。\n` +
        `  要么设 POCKET_PIN=<至少6位口令>，要么把 POCKET_BIND 改回 127.0.0.1（推荐）。`,
    );
  }

  return Object.freeze(cfg);
}
