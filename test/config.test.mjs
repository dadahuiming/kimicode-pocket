import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadConfig,
  ConfigError,
  isLoopbackHost,
  normalizePublicUrl,
  defaultStateDir,
} from '../src/lib/config.mjs';

test('默认值：只绑回环、不开口令、压缩与访问日志默认开', () => {
  const c = loadConfig({});
  assert.equal(c.port, 50980);
  assert.equal(c.bind, '127.0.0.1');
  assert.equal(c.pinEnabled, false);
  assert.equal(c.compress, true);
  assert.equal(c.accessLog, true);
  assert.equal(c.rateLimitPerMin, 600);
  assert.equal(c.upstreamTimeoutMs, 120000);
  assert.equal(c.pairTtlMs, 180000, '配对码默认给 180 秒');
  assert.equal(c.healthPath, '/api/v1/healthz');
  assert.match(c.instancesDir.replace(/\\/g, '/'), /\.kimi-code\/server\/instances$/);
  assert.match(c.tokenFile.replace(/\\/g, '/'), /\.kimi-code\/server\.token$/);
});

test('POCKET_APP_HOME 会同时移动 instances 目录与 token 文件', () => {
  const c = loadConfig({ POCKET_APP_HOME: '/opt/kimi-home' });
  assert.equal(c.instancesDir.replace(/\\/g, '/'), '/opt/kimi-home/server/instances');
  assert.equal(c.tokenFile.replace(/\\/g, '/'), '/opt/kimi-home/server.token');
});

test('非法端口被拒绝', () => {
  assert.throws(() => loadConfig({ POCKET_PORT: 'abc' }), ConfigError);
  assert.throws(() => loadConfig({ POCKET_PORT: '70000' }), ConfigError);
  assert.throws(() => loadConfig({ POCKET_PORT: '0' }), ConfigError);
});

test('布尔变量只接受常见写法', () => {
  assert.equal(loadConfig({ POCKET_COMPRESS: '0' }).compress, false);
  assert.equal(loadConfig({ POCKET_COMPRESS: 'off' }).compress, false);
  assert.equal(loadConfig({ POCKET_ACCESS_LOG: 'no' }).accessLog, false);
  assert.throws(() => loadConfig({ POCKET_COMPRESS: 'maybe' }), ConfigError);
});

test('口令短于 6 位被拒绝', () => {
  assert.throws(() => loadConfig({ POCKET_PIN: '12345' }), ConfigError);
  assert.equal(loadConfig({ POCKET_PIN: '123456' }).pinEnabled, true);
});

test('配对口令有效期：可调，但太短太长的都拒绝', () => {
  assert.equal(loadConfig({ POCKET_PAIR_TTL_SEC: '30' }).pairTtlMs, 30_000);
  assert.equal(loadConfig({ POCKET_PAIR_TTL_SEC: '300' }).pairTtlMs, 300_000);
  assert.throws(() => loadConfig({ POCKET_PAIR_TTL_SEC: '29' }), ConfigError);
  assert.throws(() => loadConfig({ POCKET_PAIR_TTL_SEC: '3601' }), ConfigError);
});

test('安全闸门：绑非回环地址却不开口令 → 拒绝启动', () => {
  assert.throws(() => loadConfig({ POCKET_BIND: '0.0.0.0' }), /拒绝启动/);
  assert.throws(() => loadConfig({ POCKET_BIND: '203.0.113.10' }), ConfigError);
  // 开了口令就允许
  const c = loadConfig({ POCKET_BIND: '0.0.0.0', POCKET_PIN: 'longenough' });
  assert.equal(c.bind, '0.0.0.0');
  assert.equal(c.pinEnabled, true);
});

test('isLoopbackHost 覆盖常见回环写法', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('0.0.0.0'), false);
  assert.equal(isLoopbackHost('203.0.113.2'), false); // TEST-NET-3，文档专用地址
});

test('配置对象被冻结，运行期不可被篡改', () => {
  const c = loadConfig({});
  assert.equal(Object.isFrozen(c), true);
});

test('POCKET_PUBLIC_URL：规范化去尾斜杠，默认留空', () => {
  assert.equal(loadConfig({}).publicUrl, '');
  assert.equal(
    loadConfig({ POCKET_PUBLIC_URL: 'https://pocket.example.com/' }).publicUrl,
    'https://pocket.example.com',
  );
  assert.equal(
    normalizePublicUrl('  https://a.example.com/base/  '),
    'https://a.example.com/base',
  );
});

test('POCKET_PUBLIC_URL：回环地址被拒绝（手机扫了打不开）', () => {
  assert.throws(() => loadConfig({ POCKET_PUBLIC_URL: 'http://127.0.0.1:50980' }), /回环/);
  assert.throws(() => loadConfig({ POCKET_PUBLIC_URL: 'http://localhost:50980' }), /回环/);
  assert.throws(() => loadConfig({ POCKET_PUBLIC_URL: 'https://[::1]:50980' }), /回环/);
});

test('POCKET_PUBLIC_URL：非 http(s) 与乱写的直接报错', () => {
  assert.throws(() => loadConfig({ POCKET_PUBLIC_URL: 'ftp://a.example.com' }), ConfigError);
  assert.throws(() => loadConfig({ POCKET_PUBLIC_URL: 'not a url' }), ConfigError);
});

test('日志默认落在平台状态目录，不写进仓库', () => {
  const c = loadConfig({});
  assert.match(c.logDir.replace(/\\/g, '/'), /kimicode-pocket\/logs$/);
  // 显式指定时完全尊重用户
  assert.equal(loadConfig({ POCKET_LOG_DIR: '/tmp/pocket-logs' }).logDir, '/tmp/pocket-logs');
});

test('defaultStateDir 三平台各自落位', () => {
  const norm = (p) => p.replace(/\\/g, '/');
  assert.equal(
    norm(defaultStateDir({ LOCALAPPDATA: 'C:/appdata' }, 'win32')),
    'C:/appdata/kimicode-pocket',
  );
  assert.equal(
    norm(defaultStateDir({ XDG_STATE_HOME: '/var/state' }, 'linux')),
    '/var/state/kimicode-pocket',
  );
  assert.match(
    norm(defaultStateDir({}, 'darwin')),
    /Library\/Application Support\/kimicode-pocket$/,
  );
});
