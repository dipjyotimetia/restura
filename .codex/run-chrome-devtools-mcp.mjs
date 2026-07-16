#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
}).trim();
const executable = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const child = spawn(executable, ['--yes', 'chrome-devtools-mcp@1.6.0', ...process.argv.slice(2)], {
  cwd: root,
  env: {
    ...process.env,
    NPM_CONFIG_CACHE: path.join(root, '.codex', 'cache', 'npm'),
  },
  stdio: 'inherit',
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}

child.on('error', (error) => {
  process.stderr.write(`Unable to start chrome-devtools-mcp: ${error.message}\n`);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
