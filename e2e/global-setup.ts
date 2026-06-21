import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..');
const DEV_VARS_PATH = join(REPO_ROOT, '.dev.vars');
const REQUIRED_DEV_VARS: Record<string, string> = {
  // Bypasses Worker auth + lets the proxy reach localhost upstream targets.
  // Both vars are required as of plan Task 1.4: ENVIRONMENT alone no longer
  // bypasses auth or relaxes allowLocalhost — DEV_BYPASS_AUTH must be set
  // explicitly (or Miniflare auto-detected, which it would be under
  // `npm run dev` but writing it explicitly makes the contract obvious).
  ENVIRONMENT: 'development',
  DEV_BYPASS_AUTH: 'true',
};

/**
 * Bootstraps everything Playwright needs before tests run. Split into two
 * phases so each runs at the right point in the test-runner lifecycle:
 *
 *   `bootstrapPrereqs()` – called from `playwright.config.ts` at module load,
 *                          BEFORE `webServer` starts. This is the only point
 *                          where we can write `.dev.vars` early enough that
 *                          miniflare picks it up on the first dev-server boot.
 *
 *   `default export`     – Playwright `globalSetup`, runs after webServer.
 *                          Used for things that don't gate the dev server,
 *                          like cert pre-generation and Chromium install.
 */
export function bootstrapPrereqs(): void {
  ensureDevVars();
}

export default async function globalSetup(): Promise<void> {
  ensureTlsCert();
  ensureChromium();
}

function ensureDevVars(): void {
  const existing = parseDevVars(
    existsSync(DEV_VARS_PATH) ? readFileSync(DEV_VARS_PATH, 'utf8') : ''
  );
  let changed = false;
  for (const [key, value] of Object.entries(REQUIRED_DEV_VARS)) {
    if (existing[key] !== value) {
      existing[key] = value;
      changed = true;
    }
  }
  if (!changed) return;

  mkdirSync(dirname(DEV_VARS_PATH), { recursive: true });
  const next =
    Object.entries(existing)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n') + '\n';
  writeFileSync(DEV_VARS_PATH, next, 'utf8');

  console.log(
    `[e2e:setup] wrote ${DEV_VARS_PATH} with ${Object.keys(REQUIRED_DEV_VARS).join(', ')}`
  );
}

function parseDevVars(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const rawValue = trimmed.slice(eq + 1).trim();
    out[key] = rawValue.replace(/^"(.*)"$/, '$1');
  }
  return out;
}

function ensureTlsCert(): void {
  // Lazy import: keeps `bootstrapPrereqs` cheap (no node:crypto / openssl exec
  // before the dev server is even up).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getSelfSignedCert } = require('./mocks/cert') as typeof import('./mocks/cert');
  try {
    getSelfSignedCert();
  } catch (err) {
    throw new Error(
      `[e2e:setup] failed to generate self-signed TLS cert: ${(err as Error).message}\n` +
        `Install openssl (macOS: \`brew install openssl\`, Debian: \`apt-get install openssl\`).`
    );
  }
}

function ensureChromium(): void {
  const cacheRoot =
    process.env.PLAYWRIGHT_BROWSERS_PATH ||
    join(process.env.HOME ?? '', 'Library/Caches/ms-playwright');
  if (existsSync(cacheRoot)) return;

  console.log('[e2e:setup] installing Playwright Chromium (one-time)...');
  try {
    execFileSync('npx', ['playwright', 'install', 'chromium'], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
  } catch (err) {
    throw new Error(
      `[e2e:setup] \`playwright install chromium\` failed: ${(err as Error).message}\n` +
        `Run it manually: \`npx playwright install chromium\`.`
    );
  }
}
