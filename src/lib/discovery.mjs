/**
 * KimiCode Pocket — Desktop 实例发现
 *
 * 三步确认，缺一不可：
 *   ① 读注册文件，按 heartbeat_at 降序（最新的优先）
 *   ② 校验 pid 是否还活着（防残留文件）
 *   ③ 真实探活（防 pid 复用 / 端口被别的程序占用）
 *
 * 这里全部是纯函数 + 一个可注入 fetch 的工厂，方便单元测试在
 * 没有 Desktop 的机器上跑。
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_TTL_MS = 2000;

export function validPort(p) {
  return typeof p === 'number' && Number.isInteger(p) && p >= 1 && p <= 65535;
}

/**
 * 读取实例注册文件。坏文件、缺字段的一律忽略，绝不抛异常。
 * @returns {Array<{port:number, pid?:number, heartbeat_at?:number}>}
 */
export function readInstances(instancesDir) {
  if (!existsSync(instancesDir)) return [];
  let names;
  try {
    names = readdirSync(instancesDir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(instancesDir, name), 'utf8'));
      if (validPort(parsed.port)) out.push(parsed);
    } catch {
      /* 忽略坏文件 */
    }
  }
  return out;
}

/** 按 heartbeat_at 降序（最新的在前）；缺失的排最后 */
export function sortByHeartbeat(list) {
  return [...list].sort((a, b) => (b.heartbeat_at ?? 0) - (a.heartbeat_at ?? 0));
}

/**
 * pid 是否存活。kill(pid, 0) 不发信号，只做存在性检查。
 * EPERM = 进程存在但当前用户无权操作 → 也算活着。
 * @param {(pid:number)=>void} [killImpl] 测试注入
 */
export function pidAlive(pid, killImpl = process.kill) {
  if (typeof pid !== 'number') return true; // 无 pid 信息时不作为否决条件
  try {
    killImpl(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

/**
 * @param {object} opts
 * @param {string} opts.instancesDir
 * @param {string} opts.healthPath
 * @param {number} [opts.ttlMs]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {(msg:string)=>void} [opts.onDiscover]
 */
export function createDiscovery({
  instancesDir,
  healthPath,
  ttlMs = DEFAULT_TTL_MS,
  fetchImpl = globalThis.fetch,
  onDiscover = () => {},
  now = () => Date.now(),
}) {
  let cache = { port: null, at: 0 };
  // 单飞：缓存过期的一瞬间可能同时进来几十个请求（页面加载会并发拉一堆
  // /api/*），不做去重的话每个请求都会把「读目录 + 读文件 + 逐个探活」
  // 完整跑一遍。并发的第二次请求直接复用第一次的结果。
  let inflight = null;

  async function healthz(port, timeoutMs = 1500) {
    try {
      const res = await fetchImpl(`http://127.0.0.1:${port}${healthPath}`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  return {
    /** 当前缓存端口（可能为 null） */
    get cached() {
      return cache.port;
    },

    async discover({ force = false } = {}) {
      const at = now();
      if (!force && cache.port && at - cache.at < ttlMs) return cache.port;
      if (inflight) return inflight;

      inflight = (async () => {
        for (const inst of sortByHeartbeat(readInstances(instancesDir))) {
          if (!pidAlive(inst.pid)) continue;
          if (await healthz(inst.port)) {
            if (cache.port !== inst.port) onDiscover(inst.port);
            cache = { port: inst.port, at };
            return inst.port;
          }
        }
        cache = { port: null, at };
        return null;
      })();

      try {
        return await inflight;
      } finally {
        inflight = null;
      }
    },
  };
}
