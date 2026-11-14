// Launch the unpacked desktop app and require it to reach a loaded window
// without an uncaught main-process exception. RESTURA_SMOKE=1 makes the app
// print `restura-smoke-ready` and exit 0 after the main frame loads.
//
// Usage: node scripts/smoke-packaged-electron.mjs [path-to-binary]
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const TIMEOUT_MS = 60_000;

function findBinaries(dir, found) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'Restura.app') {
        const mac = path.join(full, 'Contents', 'MacOS', 'Restura');
        if (existsSync(mac)) found.push(mac);
        continue;
      }
      findBinaries(full, found);
      continue;
    }
    if (entry.name === 'restura' || entry.name === 'Restura.exe') found.push(full);
  }
}

function packagedBinary() {
  const explicit = process.argv[2];
  if (explicit) return path.resolve(explicit);
  const found = [];
  findBinaries(path.join(process.cwd(), 'dist', 'installers'), found);
  if (found.length === 0) {
    console.error('::error::no packaged Restura binary under dist/installers');
    process.exit(1);
  }
  return found[0];
}

const binary = packagedBinary();
const linuxHeadless = process.platform === 'linux' && !process.env.DISPLAY;
const command = linuxHeadless ? 'xvfb-run' : binary;
// --no-sandbox: GitHub's Linux runners and many containers reject Chromium's
// sandbox. This smoke checks that the app reaches a window, not the sandbox.
const appArgs = ['--disable-gpu', ...(process.platform === 'linux' ? ['--no-sandbox'] : [])];
const args = linuxHeadless ? ['-a', binary, ...appArgs] : appArgs;

const child = spawn(command, args, {
  env: { ...process.env, RESTURA_SMOKE: '1' },
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
  console.error(`::error::packaged app did not become ready within ${TIMEOUT_MS}ms\n${output}`);
  process.exit(1);
}, TIMEOUT_MS);

child.on('exit', (code) => {
  clearTimeout(timer);
  const crashed = /uncaughtException|Uncaught Exception|Cannot find module/i.test(output);
  if (code === 0 && output.includes('restura-smoke-ready') && !crashed) {
    console.log(`OK: packaged app reached a window (${binary})`);
    return;
  }
  console.error(
    `::error::packaged app failed smoke (exit ${code ?? 'null'})\n${output || '(no output)'}`
  );
  process.exit(1);
});

child.on('error', (err) => {
  clearTimeout(timer);
  console.error(
    `::error::failed to launch packaged app (${command}). ${err.message}. On Linux without a display, xvfb-run must be installed.`
  );
  process.exit(1);
});
