/**
 * End-to-end coverage for the Restura capture extension, exercising the REAL
 * built MV3 bundle in a real Chromium persistent context:
 *
 *   chrome.storage.session (a captured session) → background worker `capture:get`
 *   → side-panel React UI renders the request list → "Export OpenCollection"
 *   → shared `sessionToOpenCollection` → downloaded file is schema-shaped and
 *   carries NO plaintext secret.
 *
 * We inject the session via `chrome.storage.session` rather than driving
 * `chrome.debugger` live: Playwright is itself a CDP client, and a second
 * `chrome.debugger` attach on the same target conflicts ("Another debugger is
 * already attached"). The CDP-normalization path is covered by unit tests with
 * recorded CDP-event fixtures (`shared/capture/__tests__`).
 *
 * This spec manages its own browser context, so it is isolated from the shared
 * dev-server project — it neither needs nor uses `baseURL`.
 */
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BrowserContext, chromium, expect, test } from '@playwright/test';

const EXT_DIR = join(__dirname, '..', 'extension');
const DIST_DIR = join(EXT_DIR, 'dist');

const SYNTHETIC_SESSION = {
  id: 'cap_e2e',
  createdAt: 0,
  exchanges: [
    {
      id: '1',
      protocol: 'rest',
      method: 'POST',
      url: 'https://api.example.com/users',
      startedAt: 0,
      request: {
        headers: [
          { name: 'content-type', value: 'application/json' },
          { name: 'Authorization', value: '{{authorization}}' },
        ],
        body: { text: '{"name":"ada"}' },
      },
      response: { status: 201, headers: [] },
    },
    {
      id: '2',
      protocol: 'websocket',
      method: 'GET',
      url: 'wss://api.example.com/socket',
      startedAt: 0,
      request: { headers: [] },
      frames: [{ direction: 'received', payload: { text: '{"type":"pong"}' }, at: 0 }],
    },
  ],
};

let context: BrowserContext;
let extensionId: string;

test.beforeAll(async () => {
  // Build the unpacked extension if it isn't already present.
  if (!existsSync(join(DIST_DIR, 'manifest.json'))) {
    execSync('npm run build', { cwd: EXT_DIR, stdio: 'inherit' });
  }
  const userDataDir = await mkdtemp(join(tmpdir(), 'restura-ext-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    // `channel: 'chromium'` selects the new headless shell, which (unlike the
    // legacy headless mode) loads MV3 extensions and runs their service workers.
    channel: 'chromium',
    args: [`--disable-extensions-except=${DIST_DIR}`, `--load-extension=${DIST_DIR}`],
  });
  // The MV3 service worker registers on load; its URL carries the extension id.
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  extensionId = new URL(sw.url()).host;
});

test.afterAll(async () => {
  await context?.close();
});

test('side panel renders an injected capture and exports a secret-free OpenCollection', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);

  // Seed a captured session into the shared extension storage the worker reads.
  await page.evaluate((session) => {
    return chrome.storage.session.set({ 'restura:capture:session': session });
  }, SYNTHETIC_SESSION);

  // The panel polls the worker once a second; both rows should appear.
  await expect(page.getByText('/users')).toBeVisible({ timeout: 5000 });
  await expect(page.getByText('/socket')).toBeVisible();

  // Protocol filter narrows the list — proves classification survived the round-trip.
  await page.locator('select').selectOption('websocket');
  await expect(page.getByText('/users')).toBeHidden();
  await expect(page.getByText('/socket')).toBeVisible();
  await page.locator('select').selectOption('all');

  // Export downloads an OpenCollection with the request and no plaintext secret.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export OpenCollection' }).click(),
  ]);
  const path = await download.path();
  const doc = JSON.parse(await readFile(path, 'utf8'));
  expect(doc.opencollection).toBe('1.0.0');
  expect(doc.items).toHaveLength(2);
  expect(JSON.stringify(doc)).not.toContain('Bearer ');
});

test('options page persists a desktop pairing code', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await page.getByPlaceholder('3000:abcdef…').fill('7321:abcdefghijklmnopqrstuvwxyz0123');
  await page.getByRole('button', { name: 'Save pairing' }).click();
  await expect(page.getByText('Paired with 127.0.0.1:7321')).toBeVisible();
});
