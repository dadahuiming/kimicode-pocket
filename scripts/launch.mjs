#!/usr/bin/env node
/**
 * 跨平台启动器：`npm run tunnel|watchdog|stop`
 *
 * 之前的 package.json 里这三个脚本只是 console.log 出「你应该敲什么命令」，
 * 看着像执行了其实什么都没做——很容易误导人。这里改成真的拉起对应平台的脚本。
 */

import { spawn, spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const TASKS = {
  tunnel: { ps1: 'start-tunnel.ps1', sh: 'start-tunnel.sh' },
  'tunnel-service': { ps1: 'tunnel-service.ps1', sh: 'tunnel-service.sh' },
  watchdog: { ps1: 'watchdog.ps1', sh: 'watchdog.sh' },
  stop: { ps1: 'stop.ps1', sh: 'stop.sh' },
};

const task = process.argv[2];
// 透传子命令，例如 npm run tunnel-service -- status
const extra = process.argv.slice(3);
if (!task || !TASKS[task]) {
  process.stderr.write(
    `用法: node scripts/launch.mjs <${Object.keys(TASKS).join('|')}> [参数...]\n`,
  );
  process.exit(2);
}

const isWindows = process.platform === 'win32';

if (isWindows) {
  const file = join(SCRIPTS_DIR, TASKS[task].ps1);
  // 优先 PowerShell 7+，退回系统自带的 5.1
  const hasPwsh = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore' }).status === 0;
  const exe = hasPwsh ? 'pwsh' : 'powershell.exe';
  const child = spawn(exe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, ...extra], {
    stdio: 'inherit',
  });
  child.on('exit', (code) => process.exit(code ?? 0));
} else {
  const file = join(SCRIPTS_DIR, TASKS[task].sh);
  const child = spawn('bash', [file, ...extra], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
}
