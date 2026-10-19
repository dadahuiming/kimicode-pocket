import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shouldTrim, trimJsonBuffer } from '../src/lib/trim.mjs';
import { loadConfig } from '../src/lib/config.mjs';

// 默认裁剪配置（与线上默认值一致）
const trimCfg = loadConfig({}).trim;

/** 造一个「像 transcript」的响应头 */
function jsonHeaders(len) {
  return { 'content-type': 'application/json; charset=utf-8', 'content-length': String(len) };
}

/** 造一条带 frames 的 transcript（模拟 Desktop 的真实形状） */
function makeTranscript({ turns = 1, stepsPerTurn = 2, outputChars = 50000 } = {}) {
  const items = [];
  for (let t = 0; t < turns; t += 1) {
    const steps = [];
    for (let s = 0; s < stepsPerTurn; s += 1) {
      steps.push({
        kind: 'step',
        stepId: `t${t}.${s}`,
        turnId: `t${t}`,
        ordinal: s,
        state: 'done',
        startedAt: 1,
        endedAt: 2,
        usage: { input: 1, output: 2 },
        finishReason: 'stop',
        llmTiming: { ttftMs: 10 },
        frames: [
          { kind: 'thinking', frameId: `t${t}.${s}.f0`, text: '想一下' },
          {
            kind: 'tool',
            frameId: `t${t}.${s}.f1`,
            toolCallId: `call-${t}-${s}`,
            name: 'Read',
            state: 'done',
            input: { path: '/tmp/x' },
            inputText: '{"path":"/tmp/x"}',
            output: 'X'.repeat(outputChars),
          },
        ],
      });
    }
    items.push({
      kind: 'turn',
      turnId: `t${t}`,
      triggerPromptId: `p${t}`,
      ordinal: t,
      state: 'done',
      origin: { kind: 'user' },
      prompt: { text: '你好' },
      startedAt: 1,
      steps,
    });
  }
  return { code: 0, msg: 'success', data: { agent_id: 'main', items, has_more: false } };
}

const req = (url, method = 'GET') => ({ url, method });
const ok = { statusCode: 200 };

// ---- shouldTrim：该不该处理 ------------------------------------------------

test('shouldTrim：巨大的 transcript 响应被选中', () => {
  const len = 5 * 1024 * 1024;
  assert.equal(shouldTrim(req('/api/v1/sessions/s1/transcript?agent_id=main'), { headers: jsonHeaders(len) }, trimCfg), true);
});

test('shouldTrim：messages 也在生效路径内', () => {
  const len = 5 * 1024 * 1024;
  assert.equal(shouldTrim(req('/api/v1/sessions/s1/messages?page_size=50'), { headers: jsonHeaders(len) }, trimCfg), true);
});

test('shouldTrim：小响应放过，不值得为几 KB 花 CPU', () => {
  const len = 8 * 1024; // 8KB < minBytes(256KB)
  assert.equal(shouldTrim(req('/api/v1/sessions/s1/transcript'), { headers: jsonHeaders(len) }, trimCfg), false);
});

test('shouldTrim：非 JSON（SSE / 静态资源）一律放过', () => {
  const len = 5 * 1024 * 1024;
  const sse = { headers: { 'content-type': 'text/event-stream', 'content-length': String(len) } };
  assert.equal(shouldTrim(req('/api/v1/sessions/s1/transcript'), sse, trimCfg), false);

  const js = { headers: { 'content-type': 'text/javascript', 'content-length': String(len) } };
  assert.equal(shouldTrim(req('/assets/main.js'), js, trimCfg), false);
});

test('shouldTrim：已压缩的上游响应不碰（无法在压缩流上做 JSON 处理）', () => {
  const h = { ...jsonHeaders(5 * 1024 * 1024), 'content-encoding': 'br' };
  assert.equal(shouldTrim(req('/api/v1/sessions/s1/transcript'), { headers: h }, trimCfg), false);
});

test('shouldTrim：路径不匹配（会话列表、status）不处理', () => {
  const len = 5 * 1024 * 1024;
  for (const p of ['/api/v2/sessions?page_size=10', '/api/v1/sessions/s1/status', '/api/v1/models']) {
    assert.equal(shouldTrim(req(p), { headers: jsonHeaders(len) }, trimCfg), false, p);
  }
});

test('shouldTrim：没有 content-length 视为流式，不缓冲', () => {
  const h = { 'content-type': 'application/json' };
  assert.equal(shouldTrim(req('/api/v1/sessions/s1/transcript'), { headers: h }, trimCfg), false);
});

test('shouldTrim：超过缓冲上限的放行（保护进程内存）', () => {
  const huge = trimCfg.maxBufferBytes + 1;
  assert.equal(shouldTrim(req('/api/v1/sessions/s1/transcript'), { headers: jsonHeaders(huge) }, trimCfg), false);
});

test('shouldTrim：HEAD 请求不处理', () => {
  const len = 5 * 1024 * 1024;
  assert.equal(shouldTrim(req('/api/v1/sessions/s1/transcript', 'HEAD'), { headers: jsonHeaders(len) }, trimCfg), false);
});

test('shouldTrim：开关关掉后一律不处理', () => {
  const off = { ...trimCfg, enabled: false };
  const len = 5 * 1024 * 1024;
  assert.equal(shouldTrim(req('/api/v1/sessions/s1/transcript'), { headers: jsonHeaders(len) }, off), false);
});

// ---- trimJsonBuffer：结构与内容 -------------------------------------------

test('trimJsonBuffer：结构完全不变，只有超长字符串被截断', () => {
  const raw = makeTranscript({ turns: 1, stepsPerTurn: 2, outputChars: 200000 });
  const buf = Buffer.from(JSON.stringify(raw), 'utf8');
  const r = trimJsonBuffer(buf, trimCfg);
  assert.ok(r, '应返回结果');

  const out = JSON.parse(r.buffer.toString('utf8'));

  // 顶层结构
  assert.deepEqual(Object.keys(out), Object.keys(raw));
  assert.deepEqual(Object.keys(out.data), Object.keys(raw.data));
  // items / steps / frames 数量一个不少
  assert.equal(out.data.items.length, raw.data.items.length);
  assert.equal(out.data.items[0].steps.length, raw.data.items[0].steps.length);
  assert.equal(out.data.items[0].steps[0].frames.length, raw.data.items[0].steps[0].frames.length);
  // 字段名逐个一致
  assert.deepEqual(Object.keys(out.data.items[0]), Object.keys(raw.data.items[0]));
  assert.deepEqual(Object.keys(out.data.items[0].steps[0]), Object.keys(raw.data.items[0].steps[0]));
  // 类型保持不变（前端按原类型读取，改类型会直接白屏）
  assert.equal(typeof out.data.items[0].steps[0].frames, 'object');
  assert.equal(Array.isArray(out.data.items[0].steps[0].frames), true);
  assert.equal(typeof out.data.items[0].steps[0].frames[1].output, 'string');
});

test('trimJsonBuffer：超长 output 被截断且带省略标记', () => {
  const raw = makeTranscript({ turns: 1, stepsPerTurn: 1, outputChars: 200000 });
  const buf = Buffer.from(JSON.stringify(raw), 'utf8');
  const out = JSON.parse(trimJsonBuffer(buf, trimCfg).buffer.toString('utf8'));
  const output = out.data.items[0].steps[0].frames[1].output;

  assert.ok(output.length < 200000, '应被截短');
  assert.match(output, /已省略/, '应带可读的省略标记');
  assert.match(output, /完整内容请在电脑上查看/, '应提示去哪里看全文');
});

test('trimJsonBuffer：保留首尾 —— 头部与尾部内容都能看到', () => {
  const head = 'HEAD_MARKER_';
  const tail = '_TAIL_MARKER';
  const middle = 'M'.repeat(200000);
  const raw = { data: { items: [{ steps: [{ frames: [{ kind: 'tool', output: head + middle + tail }] }] }] } };
  const out = JSON.parse(trimJsonBuffer(Buffer.from(JSON.stringify(raw), 'utf8'), trimCfg).buffer.toString('utf8'));
  const output = out.data.items[0].steps[0].frames[0].output;

  assert.ok(output.startsWith(head), '开头必须保留');
  assert.ok(output.endsWith(tail), '结尾必须保留（结论通常在尾部）');
});

test('trimJsonBuffer：短字符串原样不动', () => {
  const raw = makeTranscript({ turns: 1, stepsPerTurn: 1, outputChars: 10 });
  const buf = Buffer.from(JSON.stringify(raw), 'utf8');
  const out = JSON.parse(trimJsonBuffer(buf, trimCfg).buffer.toString('utf8'));
  assert.deepEqual(out.data.items[0].steps[0].frames[1].output, raw.data.items[0].steps[0].frames[1].output);
});

test('trimJsonBuffer：数字 / 布尔 / null 不被误伤', () => {
  const raw = { code: 0, ok: true, data: null, n: 12345, arr: [1, 'short', false, null] };
  const out = JSON.parse(trimJsonBuffer(Buffer.from(JSON.stringify(raw), 'utf8'), trimCfg).buffer.toString('utf8'));
  assert.deepEqual(out, raw);
});

test('trimJsonBuffer：预算超了就逐级对折，最终落在总预算内', () => {
  // 造一个远超 totalBytes 的响应
  const raw = makeTranscript({ turns: 4, stepsPerTurn: 6, outputChars: 300000 });
  const buf = Buffer.from(JSON.stringify(raw), 'utf8');
  assert.ok(buf.length > trimCfg.totalBytes, '前提：原始响应应超过总预算');

  const r = trimJsonBuffer(buf, trimCfg);
  assert.ok(r.buffer.length <= trimCfg.totalBytes, `裁剪后应在预算内，实际 ${r.buffer.length}`);
  // 注：不强制断言 attempts > 1 —— 首轮就可能靠 maxChars 直接达标，
  // 对折只是兜底。这里只验证「最终一定落在预算内」这个契约。
  assert.ok(r.stats.attempts >= 1);
  // 即便对折，结构仍然完整
  const out = JSON.parse(r.buffer.toString('utf8'));
  assert.equal(out.data.items.length, raw.data.items.length);
});

test('trimJsonBuffer：非 JSON 返回 null，由调用方原样放过', () => {
  assert.equal(trimJsonBuffer(Buffer.from('<html>not json</html>'), trimCfg), null);
  assert.equal(trimJsonBuffer(Buffer.from(''), trimCfg), null);
});

test('trimJsonBuffer：对折分支可达，且尽量逼近预算', () => {
  // 场景：元素多、单字段中等（每个 8KB < maxChars 32KB，首轮砍不动）。
  // 这条保证「对折重试」不是死代码。
  const items = Array.from({ length: 400 }, (_, i) => ({ i, text: 'A'.repeat(8000) }));
  const buf = Buffer.from(JSON.stringify({ data: { items } }), 'utf8');
  assert.ok(buf.length > trimCfg.totalBytes, '前提：整体超预算');

  const r = trimJsonBuffer(buf, trimCfg);
  assert.ok(r.stats.attempts > 1, `应触发对折，实际 attempts=${r.stats.attempts}`);
  assert.ok(r.buffer.length <= trimCfg.totalBytes, '最终应落在预算内');
  assert.equal(JSON.parse(r.buffer.toString('utf8')).data.items.length, items.length, '元素数量不变');
});

test('trimJsonBuffer：结构本身超预算时有下限，不会无限压缩', () => {
  // 极端：3 万个元素，光 JSON 骨架就接近 1MB。此时压缩有物理下限，
  // 契约退化为「尽量小 + 结构完整」，不能保证落在预算内。
  const items = Array.from({ length: 30000 }, (_, i) => ({ i, text: 'A'.repeat(900) }));
  const buf = Buffer.from(JSON.stringify({ data: { items } }), 'utf8');

  const r = trimJsonBuffer(buf, trimCfg);
  // 仍必须是合法 JSON、元素一个不少（宁可超预算，也不能让前端崩）
  const out = JSON.parse(r.buffer.toString('utf8'));
  assert.equal(out.data.items.length, items.length);
  assert.ok(r.buffer.length < buf.length / 3, '仍应有显著压缩');
  assert.equal(typeof r.stats.overBudget, 'boolean', '应显式标记是否未能达预算');
});

test('trimJsonBuffer：返回值统计可信（原始/裁剪后/省略字符）', () => {
  const raw = makeTranscript({ turns: 2, stepsPerTurn: 3, outputChars: 100000 });
  const buf = Buffer.from(JSON.stringify(raw), 'utf8');
  const r = trimJsonBuffer(buf, trimCfg);

  assert.equal(r.stats.originalBytes, buf.length);
  assert.equal(r.stats.trimmedBytes, r.buffer.length);
  assert.ok(r.stats.trimmedBytes < r.stats.originalBytes, '裁剪后必须更小');
  assert.ok(r.stats.omittedChars > 0, '应记录省略的字符数');
  assert.ok(r.stats.fields > 0, '应记录被截断的字段数');
});

test('trimJsonBuffer：真实体量的 transcript 降幅显著', () => {
  // 模拟实测场景：单 turn 多 step，每个 step 带 ~1.7MB 工具输出
  const raw = makeTranscript({ turns: 1, stepsPerTurn: 8, outputChars: 1_700_000 });
  const buf = Buffer.from(JSON.stringify(raw), 'utf8');
  const r = trimJsonBuffer(buf, trimCfg);

  const ratio = 1 - r.buffer.length / buf.length;
  assert.ok(buf.length > 10 * 1024 * 1024, `原始应 >10MB，实际 ${(buf.length / 1048576).toFixed(1)}MB`);
  assert.ok(ratio > 0.95, `降幅应 >95%，实际 ${(ratio * 100).toFixed(1)}%`);
});

test('trimJsonBuffer：深层嵌套不会爆栈（超过 MAX_DEPTH 原样返回）', () => {
  let deep = { leaf: 'Y'.repeat(100000) };
  for (let i = 0; i < 40; i += 1) deep = { child: deep };
  const r = trimJsonBuffer(Buffer.from(JSON.stringify({ data: deep }), 'utf8'), trimCfg);
  assert.ok(r, '不应抛异常');
  assert.equal(typeof JSON.parse(r.buffer.toString('utf8')), 'object');
});

test('trimJsonBuffer：超长数组元素逐个处理，数量不变', () => {
  const raw = { data: { items: Array.from({ length: 50 }, (_, i) => ({ i, text: 'Z'.repeat(50000) })) } };
  const out = JSON.parse(trimJsonBuffer(Buffer.from(JSON.stringify(raw), 'utf8'), trimCfg).buffer.toString('utf8'));
  assert.equal(out.data.items.length, 50);
  assert.ok(out.data.items.every((x) => x.text.length < 50000));
});
