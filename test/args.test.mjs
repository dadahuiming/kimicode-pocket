import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseArgs, parsePairCount, MAX_PAIR_COUNT } from '../src/lib/args.mjs';

test('默认值：不配对、不指定端口、pairCount=1', () => {
  const a = parseArgs([]);
  assert.deepEqual(a, {
    help: false,
    version: false,
    pairOnly: false,
    port: null,
    pin: null,
    base: null,
    pairCount: 1,
    errors: [],
  });
});

test('长选项与短选项都能识别', () => {
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-h']).help, true);
  assert.equal(parseArgs(['--version']).version, true);
  assert.equal(parseArgs(['-v']).version, true);
  assert.equal(parseArgs(['--pair-only']).pairOnly, true);
});

test('取值型选项按顺序取值，且互不干扰', () => {
  const a = parseArgs([
    '--port', '50990',
    '--pin', 'secret1',
    '--base', 'https://pocket.example.com',
    '--pair-count', '3',
  ]);
  assert.equal(a.port, '50990');
  assert.equal(a.pin, 'secret1');
  assert.equal(a.base, 'https://pocket.example.com');
  assert.equal(a.pairCount, '3');
  assert.deepEqual(a.errors, []);
});

test('缺值报错，而不是把下一个选项吞掉当取值', () => {
  const a = parseArgs(['--port', '--pin', 'abc']);
  assert.equal(a.port, null);
  assert.equal(a.pin, 'abc');
  assert.match(a.errors[0], /--port 缺少取值/);

  const b = parseArgs(['--base']);
  assert.equal(b.base, null);
  assert.match(b.errors[0], /缺少取值/);
});

test('未知参数进 errors，不抛异常', () => {
  const a = parseArgs(['--nope', '-x']);
  assert.equal(a.errors.length, 2);
  assert.match(a.errors[0], /未知参数: --nope/);
});

test('parsePairCount 只接受 1..MAX 的整数', () => {
  assert.equal(parsePairCount(1), 1);
  assert.equal(parsePairCount('5'), 5);
  assert.equal(parsePairCount(String(MAX_PAIR_COUNT)), MAX_PAIR_COUNT);
  for (const bad of ['0', '0.5', 'abc', MAX_PAIR_COUNT + 1, '-1', undefined]) {
    assert.throws(() => parsePairCount(bad), /--pair-count/);
  }
});
