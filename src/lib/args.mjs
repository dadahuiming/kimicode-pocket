/**
 * KimiCode Pocket — 命令行参数解析
 *
 * 单独放一个模块的原因很实际：`proxy.mjs` 一被 import 就会读配置、起服务，
 * 没法在测试里 import 它的纯函数。参数解析是这里唯一值得单测的部分。
 */

export const MAX_PAIR_COUNT = 20;

/**
 * @param {string[]} argv 不含 node 与脚本路径
 * @returns {{help:boolean, version:boolean, pairOnly:boolean,
 *            port:string|null, pin:string|null, base:string|null,
 *            pairCount:number, errors:string[]}}
 */
export function parseArgs(argv) {
  const out = {
    help: false,
    version: false,
    pairOnly: false,
    port: null,
    pin: null,
    base: null,
    pairCount: 1,
    errors: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const take = () => {
      // 只 peek 不前进：缺值时若把下一个选项当成取值吞掉，会导致
      // `--port --pin abc` 里的 --pin 被跳过，错误信息也跟着错位。
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('-')) {
        out.errors.push(`${a} 缺少取值`);
        return null;
      }
      i += 1;
      return v;
    };

    if (a === '-h' || a === '--help') out.help = true;
    else if (a === '-v' || a === '--version') out.version = true;
    else if (a === '--pair-only') out.pairOnly = true;
    else if (a === '--port') out.port = take();
    else if (a === '--pin') out.pin = take();
    else if (a === '--base') out.base = take();
    else if (a === '--pair-count') out.pairCount = take();
    else out.errors.push(`未知参数: ${a}`);
  }

  return out;
}

/** 校验 --pair-count，返回整数或抛错（错误信息直接给用户看） */
export function parsePairCount(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_PAIR_COUNT) {
    throw new Error(`--pair-count 必须是 1~${MAX_PAIR_COUNT} 的整数，收到: ${raw}`);
  }
  return n;
}
