/**
 * KimiCode Pocket — 配对状态回显
 *
 * 背景：第一版只做倒计时，时间一到就无条件打「已失效」。但配对码被消费
 * 的那一刻是发生在服务端的，终端根本没有渠道知道——于是经常出现
 * "手机上已经进 Kimi Code 了，电脑上还在说链接失效"。
 *
 * 这里补上这条回路：一边倒计时，一边问本机代理"这几个码现在什么状态"，
 * 一旦全部被兑换就立刻收尾并报成功。
 *
 * 为什么状态在服务端而不是靠"手机上回连电脑"：
 *   手机在公网，回连需要另一条入站通道；而配对码的消费本来就在服务端
 *   内存里，直接暴露一个仅本机可读的状态端点最省事、也最不容易出错。
 */

export const CLEAR_LINE = '\r\x1b[2K';
export const PAIR_EXPIRED_TEXT = '当前链接、二维码已失效，请重新生成！';
// 措辞刻意保守：服务端能确认的是"那个一次性码被兑换了"，也就是配对页
// 真的被打开、凭证已经随页面下发；它无法确认手机浏览器已经执行完 JS。
// 说"配对页已打开"是准确的，说"登录成功"就过头了。
export const PAIR_SUCCESS_TEXT = '配对页已打开';

/** 本地时间 HH:MM:SS */
export function clockOf(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 盯住配对链接：倒计时 + 真实配对状态。
 *
 * - TTY：同一条状态行原地刷新，配对页一打开就收尾（不再干等剩下的几十秒）
 * - 非 TTY（管道 / CI / 定时任务）：只打一行"几点失效"就返回，不阻塞管道
 *
 * @param {string[]} codes 本次发出的配对码
 * @param {number} deadline 截止时刻（毫秒时间戳）
 * @param {object} [opts]
 * @param {NodeJS.WriteStream} [opts.out] 输出流，测试可注入
 * @param {boolean} [opts.isTTY] 是否按终端动画处理，测试可注入
 * @param {(codes: string[]) => Promise<{total?: number, redeemed?: number}>} [opts.poll]
 *        状态查询函数；不传则退化为纯倒计时
 * @param {() => number} [opts.now] 时钟，测试可注入
 * @param {(ts: number) => string} [opts.clock] 时间格式化，测试可注入
 * @param {number} [opts.tickMs] 倒计时刷新间隔
 * @param {number} [opts.pollMs] 状态轮询间隔
 * @returns {Promise<{ok: boolean, redeemed: number, total: number, skipped?: boolean}>}
 */
export function watchPairProgress(codes, deadline, opts = {}) {
  const {
    out = process.stdout,
    isTTY = Boolean(process.stdout.isTTY),
    poll = null,
    now = Date.now,
    clock = clockOf,
    tickMs = 250,
    pollMs = 1000,
  } = opts;

  const list = Array.isArray(codes) ? codes : [];
  const total = list.length;
  const leftSec = () => Math.max(0, Math.ceil((deadline - now()) / 1000));

  // 管道里不该被一段动画卡住：给一行结论就退出
  if (!isTTY) {
    out.write(`\n  链接于 ${clock(deadline)} 失效。\n`);
    return Promise.resolve({ ok: false, redeemed: 0, total, skipped: true });
  }

  return new Promise((resolve) => {
    let lastSec = -1;
    let redeemed = 0;
    let finished = false;
    let timer = null;
    let poller = null;

    const render = (force = false) => {
      const sec = leftSec();
      if (!force && sec === lastSec) return; // 秒数没变就别重写，省得刷屏
      lastSec = sec;
      out.write(
        `${CLEAR_LINE}  \x1b[33m⏳ 剩余 ${String(sec).padStart(2, ' ')} 秒\x1b[0m` +
          `（${clock(deadline)} 失效，一次性）` +
          (total > 1 ? `　已配对 ${redeemed}/${total}` : ''),
      );
    };

    const finish = (ok) => {
      if (finished) return;
      finished = true;
      if (timer) clearInterval(timer);
      if (poller) clearInterval(poller);
      if (ok) {
        out.write(
          `${CLEAR_LINE}  \x1b[32m✔ ${PAIR_SUCCESS_TEXT}（${clock(now())}），` +
            `手机上应已进入 Kimi Code，可以关掉这个窗口。\x1b[0m\n`,
        );
      } else if (redeemed > 0 && redeemed < total) {
        // 多设备只成功了一部分：主体结论不该是"全失效"，
        // 那会把"已经配好的那台"也说成失败
        out.write(
          `${CLEAR_LINE}  \x1b[33m⚠ 已配对 ${redeemed}/${total}，` +
            `其余链接已失效（${clock(deadline)}）。需要再配一台请重新生成。\x1b[0m\n`,
        );
      } else {
        out.write(`${CLEAR_LINE}  \x1b[31m✖ ${PAIR_EXPIRED_TEXT}\x1b[0m\n`);
      }
      resolve({ ok, redeemed, total });
    };

    const doPoll = async () => {
      if (finished || typeof poll !== 'function') return;
      try {
        const body = await poll(list);
        if (finished) return;
        const n = Number(body?.redeemed);
        if (Number.isInteger(n) && n >= 0 && n !== redeemed) {
          redeemed = n;
          render(true); // 多设备时"已配对 N/M"要立刻可见
        }
        if (total > 0 && redeemed >= total) finish(true);
      } catch {
        // 代理重启 / 短暂不可达：不影响本地倒计时，下一秒再问
      }
    };

    out.write('\n');
    render();
    let closing = false;
    timer = setInterval(() => {
      if (leftSec() > 0) {
        render();
        return;
      }
      if (closing) return;
      closing = true;
      // 到点前再问最后一次：否则"刚好在最后一秒扫上"会被报成失效
      doPoll().finally(() => {
        if (!finished) finish(false);
      });
    }, tickMs);
    if (typeof poll === 'function') {
      poller = setInterval(doPoll, pollMs);
      doPoll(); // 立刻问一次，别让第一秒空着
    }
  });
}
