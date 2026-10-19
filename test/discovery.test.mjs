import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  validPort,
  sortByHeartbeat,
  pidAlive,
  readInstances,
  createDiscovery,
} from '../src/lib/discovery.mjs';

test('validPort 只接受 1..65535 的整数', () => {
  assert.equal(validPort(50980), true);
  assert.equal(validPort(1), true);
  assert.equal(validPort(65535), true);
  assert.equal(validPort(0), false);
  assert.equal(validPort(65536), false);
  assert.equal(validPort('50980'), false);
  assert.equal(validPort(1.5), false);
  assert.equal(validPort(null), false);
});

test('sortByHeartbeat 最新的排最前，缺失 heartbeat 的排最后', () => {
  const list = [
    { port: 1, heartbeat_at: 100 },
    { port: 2 },
    { port: 3, heartbeat_at: 300 },
    { port: 4, heartbeat_at: 200 },
  ];
  assert.deepEqual(
    sortByHeartbeat(list).map((x) => x.port),
    [3, 4, 1, 2],
  );
  // 不改动入参
  assert.equal(list[0].port, 1);
});

test('pidAlive：ESRCH 才算死，EPERM 算活', () => {
  assert.equal(pidAlive(1234, () => {}), true);

  const esrch = () => {
    const e = new Error('no such process');
    e.code = 'ESRCH';
    throw e;
  };
  assert.equal(pidAlive(1234, esrch), false);

  const eperm = () => {
    const e = new Error('operation not permitted');
    e.code = 'EPERM';
    throw e;
  };
  assert.equal(pidAlive(1234, eperm), true);

  // 没有 pid 信息时不应作为否决条件
  assert.equal(pidAlive(undefined, esrch), true);
});

test('readInstances 忽略坏文件、非 json 与无端口条目', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-disc-'));
  try {
    writeFileSync(join(dir, 'a.json'), JSON.stringify({ port: 5001, pid: 1, heartbeat_at: 10 }));
    writeFileSync(join(dir, 'b.json'), '{ not json');
    writeFileSync(join(dir, 'c.json'), JSON.stringify({ pid: 2 })); // 无 port
    writeFileSync(join(dir, 'd.txt'), 'ignore me');
    const got = readInstances(dir);
    assert.equal(got.length, 1);
    assert.equal(got[0].port, 5001);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readInstances 目录不存在时返回空数组而不是抛错', () => {
  assert.deepEqual(readInstances(join(tmpdir(), 'definitely-not-exists-pocket')), []);
});

test('discover：按 heartbeat 顺序挑第一个「pid 活 + 真探活通」的实例', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-disc-'));
  try {
    // pid 用当前进程，保证在任意平台上都被判定为存活
    writeFileSync(join(dir, 'new.json'), JSON.stringify({ port: 5003, pid: process.pid, heartbeat_at: 300 }));
    writeFileSync(join(dir, 'mid.json'), JSON.stringify({ port: 5002, pid: process.pid, heartbeat_at: 200 }));
    writeFileSync(join(dir, 'old.json'), JSON.stringify({ port: 5001, pid: process.pid, heartbeat_at: 100 }));

    const probed = [];
    const d = createDiscovery({
      instancesDir: dir,
      healthPath: '/api/v1/healthz',
      // 5003 探活失败，5002 成功
      fetchImpl: async (url) => {
        probed.push(url);
        return { ok: url.includes(':5002/') };
      },
      now: () => 1000,
    });

    const port = await d.discover();
    assert.equal(port, 5002);
    assert.equal(probed.length, 2);
    assert.match(probed[0], /:5003\//);
    assert.match(probed[1], /:5002\//);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('discover：TTL 内命中缓存，force 绕过缓存', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-disc-'));
  try {
    writeFileSync(join(dir, 'a.json'), JSON.stringify({ port: 5001, pid: process.pid, heartbeat_at: 10 }));
    let calls = 0;
    let clock = 1000;
    const d = createDiscovery({
      instancesDir: dir,
      healthPath: '/h',
      ttlMs: 2000,
      fetchImpl: async () => {
        calls++;
        return { ok: true };
      },
      now: () => clock,
    });

    assert.equal(await d.discover(), 5001);
    assert.equal(calls, 1);

    clock += 1000; // TTL 内
    assert.equal(await d.discover(), 5001);
    assert.equal(calls, 1);

    clock += 2000; // 过期
    assert.equal(await d.discover(), 5001);
    assert.equal(calls, 2);

    await d.discover({ force: true });
    assert.equal(calls, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('discover：全部不健康时返回 null 并清空缓存', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-disc-'));
  try {
    writeFileSync(join(dir, 'a.json'), JSON.stringify({ port: 5001, pid: process.pid, heartbeat_at: 10 }));
    const d = createDiscovery({
      instancesDir: dir,
      healthPath: '/h',
      fetchImpl: async () => ({ ok: false }),
      now: () => 1,
    });
    assert.equal(await d.discover(), null);
    assert.equal(d.cached, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('discover：探活抛异常视为不健康，不冒泡', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-disc-'));
  try {
    writeFileSync(join(dir, 'a.json'), JSON.stringify({ port: 5001, pid: process.pid, heartbeat_at: 10 }));
    const d = createDiscovery({
      instancesDir: dir,
      healthPath: '/h',
      fetchImpl: async () => {
        throw new Error('boom');
      },
      now: () => 1,
    });
    assert.equal(await d.discover(), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
