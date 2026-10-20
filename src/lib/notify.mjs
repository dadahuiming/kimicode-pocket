// Windows 桌面通知：代理出错时弹窗告诉用户。
//
// 设计约束（都是实测出来的，不是拍脑袋）：
//
// 1. **必须异步**。实测每次 Toast 约 1000ms（起 powershell 进程 + WinRT 调用）。
//    如果同步发，一次通知就能把一个正在服务的请求卡住 1 秒 ——
//    通知本来是为了发现问题，结果自己制造问题。
//
// 2. **必须去重**。真实故障往往是「一串相同错误」（上游挂了，接下来每个请求
//    都报同样的错）。不去重的话会连弹几十个窗口，用户会直接把通知关掉，
//    那还不如没有。这里用「同类错误在窗口期内只弹一次」。
//
// 3. **必须限速**。即使错误种类不同，也不能超过每分钟 N 条。
//
// 4. **中文必须走 -EncodedCommand**。实测直接 -Command 传中文在部分场景会乱码；
//    用 UTF-16LE base64 传给 -EncodedCommand 是唯一稳定的方式（已验证中文完整）。
//
// 5. **失败绝不影响主流程**。powershell 起不来、WinRT 不可用、超时 ——
//    全部吞掉，只写日志。通知系统自己崩了不能拖垮代理。
//
// 用法：
//   const notifier = createNotifier({ enabled: true, appId: 'KimiCodePocket' });
//   notifier.notify({ key: 'upstream-timeout', title: '...', body: '...' });

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

const PS_CANDIDATES = [
  'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
  'powershell.exe',
];

function findPowershell() {
  for (const p of PS_CANDIDATES) {
    if (p === 'powershell.exe' || existsSync(p)) return p;
  }
  return 'powershell.exe';
}

/**
 * 构造发送 Toast 的 PowerShell 脚本。
 *
 * 用 ToastText02 模板（标题 + 正文两行）。appId 决定通知归属，
 * 同一个 appId 的通知会归到一组，不会每次冒出一个新来源。
 */
function buildScript({ title, body, appId }) {
  const esc = (s) => String(s == null ? '' : s).replace(/'/g, "''");
  // 正文过长会让 toast 溢出，截断到合理长度（保留信息量，不撑爆弹窗）
  const clip = (s, n) => {
    const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
  };
  const T = clip(title, 64);
  const B = clip(body, 200);
  return `
$ErrorActionPreference = 'Stop'
try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
  $t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
  $t.GetElementsByTagName('text').Item(0).AppendChild($t.CreateTextNode('${esc(T)}')) | Out-Null
  $t.GetElementsByTagName('text').Item(1).AppendChild($t.CreateTextNode('${esc(B)}')) | Out-Null
  $toast = [Windows.UI.Notifications.ToastNotification]::new($t)
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${esc(appId)}').Show($toast)
  Write-Output 'OK'
} catch {
  Write-Output ('FAIL:' + $_.Exception.Message)
}
`;
}

/**
 * @param {object} opts
 * @param {boolean} [opts.enabled=true]     总开关（POCKET_NOTIFY=0 可关）
 * @param {string}  [opts.appId]           通知来源标识
 * @param {number}  [opts.dedupeMs]        同类错误去重窗口，默认 5 分钟
 * @param {number}  [opts.minIntervalMs]   任意两条通知之间的最小间隔，默认 3 秒
 * @param {number}  [opts.maxPerMinute]    每分钟上限，默认 6 条
 * @param {(m:string)=>void} [opts.log]    日志回调（默认吞掉）
 * @param {(payload)=>void} [opts.onSend]  测试钩子：替换真实发送
 */
export function createNotifier(opts = {}) {
  const enabled = opts.enabled !== false;
  const appId = opts.appId || 'KimiCodePocket';
  const dedupeMs = opts.dedupeMs ?? 5 * 60_000;
  const minIntervalMs = opts.minIntervalMs ?? 3_000;
  const maxPerMinute = opts.maxPerMinute ?? 6;
  const log = opts.log || (() => {});
  const onSend = opts.onSend || null;

  /** key -> 上次发送时间 */
  const lastSent = new Map();
  /** 最近一分钟的发送时间戳 */
  let recent = [];
  let lastAny = 0;
  /** 正在发送中的数量（避免堆积） */
  let inflight = 0;
  const MAX_INFLIGHT = 2;

  const stats = { sent: 0, deduped: 0, throttled: 0, failed: 0, suppressed: 0 };

  function nowMs() {
    return Date.now();
  }

  function pruneRecent(t) {
    recent = recent.filter((x) => t - x < 60_000);
  }

  /**
   * 发送一条通知（异步、不等待）。
   *
   * @param {object} p
   * @param {string} p.key    去重键（同类错误共用）
   * @param {string} p.title  标题
   * @param {string} p.body   正文
   * @param {boolean} [p.force] 跳过去重与间隔限制（用于「服务已恢复」这类必须送达的）
   * @returns {boolean} 是否真的投递了（false = 被去重/限速/关闭）
   */
  function notify({ key, title, body, force = false } = {}) {
    if (!enabled) {
      stats.suppressed += 1;
      return false;
    }
    const t = nowMs();
    const k = String(key || title || 'default');

    if (!force) {
      // 同类去重
      const prev = lastSent.get(k);
      if (prev !== undefined && t - prev < dedupeMs) {
        stats.deduped += 1;
        return false;
      }
      // 全局最小间隔（防瞬间连弹）
      if (t - lastAny < minIntervalMs) {
        stats.throttled += 1;
        return false;
      }
      // 每分钟上限
      pruneRecent(t);
      if (recent.length >= maxPerMinute) {
        stats.throttled += 1;
        return false;
      }
    }

    lastSent.set(k, t);
    lastAny = t;
    recent.push(t);
    pruneRecent(t);

    // 已经有两个在发 → 丢弃，避免 powershell 进程堆积
    if (inflight >= MAX_INFLIGHT) {
      stats.throttled += 1;
      return false;
    }

    stats.sent += 1;
    inflight += 1;

    const payload = { key: k, title, body, appId, force };

    if (onSend) {
      // 测试模式：同步回调，便于断言
      try {
        onSend(payload);
      } catch {
        /* ignore */
      }
      inflight -= 1;
      return true;
    }

    sendToast(payload)
      .then((ok) => {
        if (!ok) stats.failed += 1;
      })
      .catch(() => {
        stats.failed += 1;
      })
      .finally(() => {
        inflight -= 1;
      });

    return true;
  }

  /** 真正调用 powershell。返回 Promise<boolean> */
  function sendToast(payload) {
    return new Promise((resolve) => {
      const script = buildScript(payload);
      // -EncodedCommand 吃 UTF-16LE base64 —— 这是中文不乱的唯一可靠方式
      const b64 = Buffer.from(script, 'utf16le').toString('base64');
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        resolve(ok);
      };
      try {
        const child = execFile(
          findPowershell(),
          ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', b64],
          { timeout: 15_000, windowsHide: true },
          (err, stdout) => {
            if (err) {
              log(`通知发送失败: ${err.message}`);
              finish(false);
              return;
            }
            if (String(stdout).includes('FAIL')) {
              log(`通知被系统拒绝: ${String(stdout).trim()}`);
              finish(false);
              return;
            }
            finish(true);
          },
        );
        // 进程起不来也别卡住
        child.on('error', (e) => {
          log(`通知进程启动失败: ${e.message}`);
          finish(false);
        });
        // 兜底：即使回调没来，也别让 inflight 永远占着
        setTimeout(() => finish(false), 20_000).unref?.();
      } catch (e) {
        log(`通知异常: ${e.message}`);
        finish(false);
      }
    });
  }

  /** 诊断信息（/__status 用） */
  function snapshot() {
    return {
      enabled,
      ...stats,
      inflight,
      recentCount: recent.length,
      dedupeKeys: lastSent.size,
    };
  }

  /** 清空状态（测试用） */
  function reset() {
    lastSent.clear();
    recent = [];
    lastAny = 0;
    inflight = 0;
    for (const k of Object.keys(stats)) stats[k] = 0;
  }

  return { notify, snapshot, reset, buildScript };
}
