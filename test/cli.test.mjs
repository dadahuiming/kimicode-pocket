/**
 * 进程级测试：命令行入口的对外契约。
 *
 * 这些行为（--help/--version/错误码/启动即出配对链接）是用户第一眼
 * 看到的东西，比任何内部函数都值得钉死。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROXY = join(REPO, 'src', 'proxy.mjs');

/** 干净的 env：不让开发机上真实的环境变量影响判定 */
function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('POCKET_')) delete env[k];
  return { ...env, ...extra };
}

function run(args, extraEnv) {
  return spawnSync(process.execPath, [PROXY, ...args], {
    env: cleanEnv(extraEnv),
    encoding: 'utf8',
    timeout: 20_000,
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

test('--help 退出码 0，并说明公网入口与选项', () => {
  const r = run(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /用法:/);
  assert.match(r.stdout, /--pair-only/);
  assert.match(r.stdout, /--base/);
  assert.match(r.stdout, /POCKET_PUBLIC_URL/);
});

test('--version 打印版本号', () => {
  const r = run(['--version']);
  assert.equal(r.status, 0);
  assert.match(r.stdout.trim(), /^kimicode-pocket \d+\.\d+\.\d+$/);
});

test('未知参数退出码 2，不静默忽略', () => {
  const r = run(['--definitely-not-an-option']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /未知参数/);
});

test('--pair-count 越界在解析阶段就被拦下', () => {
  const r = run(['--pair-only', '--pair-count', '0']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--pair-count/);
});

test('--pair-only 缺公网入口时明确报错', () => {
  const r = run(['--pair-only']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /需要公网入口/);
});

test('--base 用回环地址被拒绝（手机扫了打不开）', () => {
  const r = run(['--pair-only', '--base', 'http://127.0.0.1:50980']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /回环/);
});

test('--pair-only 在代理没运行时给出可执行提示', () => {
  // 一个几乎不可能有人监听的端口
  const r = run(['--pair-only', '--base', 'https://pocket.example.com', '--port', '1']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /代理没在运行/);
});

test('带 --base 启动时立刻打印配对链接与终端二维码', async () => {
  const port = await freePort();
  const proc = spawn(
    process.execPath,
    [PROXY, '--port', String(port), '--base', 'https://pocket.example.com'],
    { env: cleanEnv({ POCKET_ACCESS_LOG: '0' }), stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let out = '';
  proc.stdout.on('data', (c) => {
    out += c;
  });

  try {
    // 等到「失效时刻」那一行出现再断言：它在链接和二维码之后输出，
    // 出现即代表前面几段都已经写完了。
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !/链接于 \d{2}:\d{2}:\d{2} 失效/.test(out)) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.match(out, /公网入口\s+https:\/\/pocket\.example\.com/);
    const m = out.match(/https:\/\/pocket\.example\.com\/__pair\?code=\d{6}/);
    assert.ok(m, `应打印配对链接，实际输出：\n${out}`);
    // 二维码（半块字符）也要出现
    assert.match(out, /[█▀▄]/);
    // 非 TTY 下要给出"几点失效"，而不是刷一屏倒计时
    assert.match(out, /链接于 \d{2}:\d{2}:\d{2} 失效/);
  } finally {
    proc.kill();
  }
});

test('--pair-only 在非 TTY 下打印链接与失效时刻，并立刻退出（不阻塞管道）', async () => {
  const port = await freePort();
  const server = spawn(
    process.execPath,
    [PROXY, '--port', String(port), '--base', 'https://pocket.example.com'],
    { env: cleanEnv({ POCKET_ACCESS_LOG: '0' }), stdio: ['ignore', 'pipe', 'pipe'] },
  );

  try {
    // 等代理起来
    const up = Date.now() + 15_000;
    for (;;) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/__status`);
        if (r.ok) break;
      } catch {
        /* 还没起来 */
      }
      if (Date.now() > up) throw new Error('代理未在 15 秒内启动');
      await new Promise((r) => setTimeout(r, 100));
    }

    const started = Date.now();
    const r = spawnSync(
      process.execPath,
      [PROXY, '--pair-only', '--port', String(port), '--base', 'https://pocket.example.com'],
      { env: cleanEnv(), encoding: 'utf8', timeout: 15_000 },
    );
    const elapsed = Date.now() - started;

    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /__pair\?code=\d{6}/);
    assert.match(r.stdout, /链接于 \d{2}:\d{2}:\d{2} 失效/);
    assert.ok(elapsed < 10_000, `非 TTY 不应等待倒计时，实际 ${elapsed}ms`);
  } finally {
    server.kill();
  }
});
