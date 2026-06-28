/**
 * Collection Runner — end-to-end coverage for actually *running* a collection.
 *
 * `import-collection.spec.ts` proves a collection can be imported; this spec
 * proves the runner executes one. It drives the full chain in the real built
 * web app:
 *
 *   CollectionRunnerDialog → useCollectionRun → runCollection → protocol
 *   registry → executeRequest → /api/proxy Worker → real local HTTP server →
 *   results render → useCollectionRunStore persistence (Runs panel)
 *
 * Seeding: rather than depend on a static fixture file (whose URL can't carry
 * the dynamic mock-server port), the spec builds a Postman v2.1 collection at
 * test time pointing at `${servers.http.url}` and imports it through the
 * proven import dialog. Test scripts are written in native `rs.*` syntax (the
 * `pm.*`→`rs.*` import migration is namespace-only and leaves `rs.*` intact),
 * so the assertion path is exercised for real.
 *
 * Requests hit `http://127.0.0.1:<port>` for real — no Playwright route
 * mocking — exactly like `real-http.spec.ts`, so a green run means bytes went
 * over a real socket through the same wire path as a normal send.
 */
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/servers';
import { resetPersistedState } from './utils/reset-state';

/** A Postman v2.1 collection with two HTTP requests carrying `rs.*` test scripts. */
function buildPostmanCollection(baseUrl: string): Buffer {
  const collection = {
    info: {
      name: 'Runner E2E',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: [
      {
        name: 'Passing request',
        event: [
          {
            listen: 'test',
            script: {
              exec: ["rs.test('status is 200', () => rs.response.to.have.status(200));"],
            },
          },
        ],
        request: { method: 'GET', url: `${baseUrl}/json` },
      },
      {
        name: 'Failing request',
        event: [
          {
            listen: 'test',
            script: {
              // Deliberately wrong: /json returns 200, so this assertion fails
              // and the runner must mark the request failed.
              exec: ["rs.test('status is 500', () => rs.response.to.have.status(500));"],
            },
          },
        ],
        request: { method: 'GET', url: `${baseUrl}/json` },
      },
    ],
  };
  return Buffer.from(JSON.stringify(collection), 'utf8');
}

/**
 * A collection whose FIRST request fails outright (HTTP 500 → not 2xx) followed
 * by a request that should never run when stop-on-failure is enabled.
 */
function buildStopOnFailureCollection(baseUrl: string): Buffer {
  const collection = {
    info: {
      name: 'Runner E2E',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: [
      { name: 'First (500)', request: { method: 'GET', url: `${baseUrl}/status/500` } },
      { name: 'Second (never runs)', request: { method: 'GET', url: `${baseUrl}/json` } },
    ],
  };
  return Buffer.from(JSON.stringify(collection), 'utf8');
}

function importDialog(page: Page) {
  return page.getByRole('dialog', { name: 'Import collection' });
}

/** Import the built collection through the import dialog (default format: Postman). */
async function importCollection(page: Page, buffer: Buffer): Promise<void> {
  await page.getByRole('button', { name: 'Import collection' }).click();
  await expect(importDialog(page)).toBeVisible();
  await page
    .locator('#file-upload-postman')
    .setInputFiles({ name: 'runner-e2e.json', mimeType: 'application/json', buffer });
  // On a clean happy-path import the dialog closes and the collection appears.
  await expect(importDialog(page)).not.toBeVisible({ timeout: 8_000 });
  await expect(page.getByText('Runner E2E').first()).toBeVisible({ timeout: 8_000 });
}

function runnerDialog(page: Page) {
  return page.getByRole('dialog', { name: /Run collection/ });
}

/** Open the runner for the imported collection via its context menu. */
async function openRunner(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Collection options' }).first().click();
  await page.getByRole('menuitem', { name: 'Run collection' }).click();
  await expect(runnerDialog(page)).toBeVisible();
}

test.describe('Collection Runner', () => {
  test.beforeEach(async ({ app: page }) => {
    await resetPersistedState(page);
  });

  test('runs an imported collection against the real server, scoring assertions', async ({
    app: page,
    servers,
  }) => {
    await importCollection(page, buildPostmanCollection(servers.http.url));
    await openRunner(page);

    const dialog = runnerDialog(page);
    // The Run button is labelled with the selected count ("Run 2 requests").
    await dialog.getByRole('button', { name: /Run \d+ request/ }).click();

    // The run finishes and the summary reflects one passing + one failing
    // assertion (RunSummary only renders once progress.done is true).
    await expect(dialog.getByText('1 passed')).toBeVisible({ timeout: 15_000 });
    await expect(dialog.getByText('1 failed')).toBeVisible();

    // Both requests rendered in the results list.
    await expect(dialog.getByText('Passing request')).toBeVisible();
    await expect(dialog.getByText('Failing request')).toBeVisible();

    // Both requests actually went over the wire to the local server.
    expect(servers.http.requestCount()).toBeGreaterThanOrEqual(2);
    const paths = servers.http.requests().map((r) => r.path);
    expect(paths.filter((p) => p === '/json').length).toBeGreaterThanOrEqual(2);
  });

  test('persists the run to the Runs panel', async ({ app: page, servers }) => {
    await importCollection(page, buildPostmanCollection(servers.http.url));
    await openRunner(page);

    const dialog = runnerDialog(page);
    await dialog.getByRole('button', { name: /Run \d+ request/ }).click();
    await expect(dialog.getByText('1 passed')).toBeVisible({ timeout: 15_000 });

    // Close the dialog (allowed once the run is no longer in-flight).
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();

    // The run is recorded under the collection name in the Runs sidebar tab.
    await page.getByRole('tab', { name: 'Runs' }).click();
    const runCard = page.getByRole('button').filter({ hasText: 'Runner E2E' });
    await expect(runCard.first()).toBeVisible({ timeout: 8_000 });
    await expect(runCard.getByText('1 ✓').first()).toBeVisible();
    await expect(runCard.getByText('1 ✗').first()).toBeVisible();
  });

  test('stop-on-failure halts before the second request', async ({ app: page, servers }) => {
    await importCollection(page, buildStopOnFailureCollection(servers.http.url));
    await openRunner(page);

    const dialog = runnerDialog(page);
    await dialog.getByLabel('Stop on failure').check();
    await dialog.getByRole('button', { name: /Run \d+ request/ }).click();

    // First request fails (500), so the run halts: 0 passed, 1 failed, and the
    // second request never reaches the wire.
    await expect(dialog.getByText('1 failed')).toBeVisible({ timeout: 15_000 });
    await expect(dialog.getByText('First (500)')).toBeVisible();
    await expect(dialog.getByText('Second (never runs)')).not.toBeVisible();
    expect(servers.http.requestCount()).toBe(1);
  });
});
