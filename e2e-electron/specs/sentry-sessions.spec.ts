import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { _electron, type ElectronApplication, expect, type Page, test } from '@playwright/test';

/**
 * Release Health through the real SDK and the real quit path, against a local
 * capture server (ADR-0040). Unit tests mock the SDK, so they can't see the two
 * things that matter here: what actually goes on the wire, and whether the app's
 * own will-quit handling lets the SDK end the session.
 */

const ROOT = path.resolve(__dirname, '../..');
const MAIN_JS = path.join(ROOT, 'dist/electron/electron/main/main.js');
const SETTLE_MS = 2_500;

interface SessionPayload {
  did?: string;
  init?: boolean;
  status?: string;
  attrs?: { ip_address?: string };
}

let server: Server;
let port: number;
let profile: string;
let sessions: SessionPayload[] = [];
let envelopeCount = 0;

function recordEnvelope(body: Buffer): void {
  envelopeCount += 1;
  const lines = body.toString('utf8').split('\n');
  for (const [index, line] of lines.entries()) {
    try {
      if ((JSON.parse(line) as { type?: string }).type === 'session') {
        sessions.push(JSON.parse(lines[index + 1] ?? '') as SessionPayload);
      }
    } catch {
      // Not JSON: binary attachment data or the envelope's trailing newline.
    }
  }
}

function installId(): string | undefined {
  const file = path.join(profile, 'telemetry-install-id.json');
  if (!existsSync(file)) return undefined;
  return (JSON.parse(readFileSync(file, 'utf8')) as { id: string }).id;
}

function cacheContains(value: string): boolean {
  const cache = path.join(profile, 'sentry');
  if (!existsSync(cache)) return false;
  return readdirSync(cache, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .some((entry) => readFileSync(path.join(entry.parentPath, entry.name)).includes(value));
}

async function dismissOnboarding(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Skip Tour' }).click();
  await page.getByRole('button', { name: 'Get Started' }).click();
}

async function launch(): Promise<{ electronApp: ElectronApplication; page: Page }> {
  const xdgConfigHome = path.join(profile, 'xdg-config');
  mkdirSync(xdgConfigHome, { recursive: true });
  const electronApp = await _electron.launch({
    args: [MAIN_JS],
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      RESTURA_DISABLE_AUTO_UPDATE: 'true',
      RESTURA_USER_DATA_DIR: profile,
      XDG_CONFIG_HOME: xdgConfigHome,
      SENTRY_DSN: `http://publickey@127.0.0.1:${port}/1`,
    },
  });
  const page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { electronApp, page };
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  profile = mkdtempSync(path.join(process.platform === 'win32' ? tmpdir() : '/tmp', 'restura-rh-'));
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      recordEnvelope(req.headers['content-encoding'] === 'gzip' ? gunzipSync(body) : body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

test.afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(profile, { recursive: true, force: true });
});

test.beforeEach(() => {
  sessions = [];
  envelopeCount = 0;
});

test('first launch sends no session and creates no id, even when an error is reported', async () => {
  const { electronApp, page } = await launch();
  // Before the user can reach the opt-out in onboarding.
  await electronApp.evaluate(() => {
    void Promise.reject(new Error('sentry-sessions-probe'));
  });
  await expect.poll(() => envelopeCount).toBeGreaterThan(0);
  await dismissOnboarding(page);
  await page.waitForTimeout(SETTLE_MS);
  await electronApp.close();
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

  expect(sessions).toEqual([]);
  expect(installId()).toBeUndefined();
});

test('the next launch reports at launch with an id, and a clean quit is not abnormal', async () => {
  const { electronApp } = await launch();

  await expect.poll(() => sessions.some((s) => s.init === true && Boolean(s.did))).toBe(true);
  const id = installId();
  expect(id).toBeTruthy();
  expect(sessions.every((s) => s.did === id && s.attrs?.ip_address === undefined)).toBe(true);
  await electronApp.close();

  await expect.poll(() => sessions.some((s) => s.did === id && s.status === 'exited')).toBe(true);
  expect(sessions.filter((s) => s.status === 'abnormal' || s.status === 'crashed')).toEqual([]);
});

test('later launches keep the id, and opting out removes every copy and stops the session', async () => {
  const id = installId() as string;
  const { electronApp, page } = await launch();
  await expect.poll(() => sessions.some((s) => s.did === id && s.init === true)).toBe(true);
  // Let the renderer finish its own startup consent push first.
  await page.waitForTimeout(SETTLE_MS);

  await page.evaluate(() => window.electron?.telemetry?.setConsent(false));
  await expect.poll(() => installId()).toBeUndefined();

  const sentBeforeQuit = sessions.length;
  // Long enough for the SDK's buffered scope write to land.
  await page.waitForTimeout(SETTLE_MS);
  expect(cacheContains(id)).toBe(false);
  await electronApp.close();
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  expect(sessions).toHaveLength(sentBeforeQuit);
  expect(cacheContains(id)).toBe(false);
});

test('opting out in onboarding persists, and a relaunch sends nothing at all', async () => {
  rmSync(profile, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });

  const first = await launch();
  await first.page.getByRole('button', { name: 'Skip Tour' }).click();
  await first.page.getByRole('switch', { name: 'Send crash and error reports' }).click();
  await first.page.getByRole('button', { name: 'Get Started' }).click();
  await first.page.waitForTimeout(SETTLE_MS);
  await first.electronApp.close();
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  expect(sessions).toEqual([]);

  envelopeCount = 0;
  const second = await launch();
  // Long enough for the settings store to hydrate and push consent to main.
  await second.page.waitForTimeout(SETTLE_MS * 2);
  await second.electronApp.close();
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

  expect(envelopeCount).toBe(0);
  expect(installId()).toBeUndefined();
});
