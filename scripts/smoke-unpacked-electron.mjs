// Launch the compiled, unpackaged desktop app and require it to reach a loaded
// window. Same contract as scripts/smoke-packaged-electron.mjs (RESTURA_SMOKE=1
// prints `restura-smoke-ready` and exits 0) without electron-builder, so the
// desktop verify skill can run it locally.
//
// Prerequisite: `npm run electron:compile` and `npm run electron:build:web`.
// Usage: node scripts/smoke-unpacked-electron.mjs

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TIMEOUT_MS = 60_000;
const root = process.cwd();

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

const mainJs = path.join(root, 'dist', 'electron', 'electron', 'main', 'main.js');
const renderer = path.join(root, 'dist', 'web', 'index.html');
if (!existsSync(mainJs)) {
  fail('compiled main is missing. Run npm run electron:compile first.');
}
if (!existsSync(renderer)) {
  fail('Electron renderer is missing. Run npm run electron:build:web first.');
}

// A unit-test stub (ELECTRON_OVERRIDE_DIST_PATH) must not hide the real binary.
delete process.env.ELECTRON_OVERRIDE_DIST_PATH;
const electronBinary = createRequire(import.meta.url)('electron');
if (typeof electronBinary !== 'string' || !existsSync(electronBinary)) {
  fail(
    `electron binary is not installed (${String(electronBinary)}). The package downloads it on first launch; check network access.`
  );
}

const linuxHeadless = process.platform === 'linux' && !process.env.DISPLAY;
const command = linuxHeadless ? 'xvfb-run' : electronBinary;
// --no-sandbox: containers and GitHub's Linux runners reject Chromium's sandbox.
const appArgs = [root, '--disable-gpu', ...(process.platform === 'linux' ? ['--no-sandbox'] : [])];
const args = linuxHeadless ? ['-a', electronBinary, ...appArgs] : appArgs;
const userData = mkdtempSync(path.join(tmpdir(), 'restura-unpacked-smoke-'));

const child = spawn(command, args, {
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: 'production',
    RESTURA_SMOKE: '1',
    RESTURA_USER_DATA_DIR: userData,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
const collect = (chunk) => {
  output += chunk.toString();
  if (output.length > 200_000) output = output.slice(-200_000);
};
child.stdout.on('data', collect);
child.stderr.on('data', collect);

const timer = setTimeout(() => {
  child.kill('SIGKILL');
  fail(`unpackaged app did not become ready within ${TIMEOUT_MS}ms\n${output}`);
}, TIMEOUT_MS);

child.on('exit', (code) => {
  clearTimeout(timer);
  // An optional native (Kafka, MQTT, MCP control) may log "Cannot find module"
  // and the window still opens (#1353). A required feature that fails to load
  // prints `restura-smoke-failed` and exits 1, as does an uncaught exception.
  const uncaught = /uncaughtException|Uncaught Exception/i.test(output);
  if (
    code === 0 &&
    output.includes('restura-smoke-ready') &&
    !output.includes('restura-smoke-failed') &&
    !uncaught
  ) {
    console.log(`OK: unpackaged app reached a window (${electronBinary})`);
    return;
  }
  fail(`unpackaged app failed smoke (exit ${code ?? 'null'})\n${output || '(no output)'}`);
});

child.on('error', (err) => {
  clearTimeout(timer);
  fail(
    `failed to launch unpackaged app (${command}). ${err.message}. On Linux without a display, xvfb-run must be installed.`
  );
});
