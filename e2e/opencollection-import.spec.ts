/**
 * OpenCollection import — end-to-end smoke test (web mode).
 *
 * Verifies the Phase 0 happy path: a bundled OpenCollection YAML file
 * dropped into the ImportDialog renders as a collection in the sidebar,
 * with the original request name visible.
 *
 * Deferred (Phase 1): the directory-layout import + git-diff roundtrip
 * Playwright spec described in the plan requires Electron Playwright
 * bootstrap (native directory dialog), which doesn't exist in this
 * project yet. The unit and integration tests under
 * `src/lib/opencollection/__tests__/` cover format correctness on the
 * directory side; this test is the UX smoke for the file-upload path.
 */

import { test, expect } from './fixtures/app';
import { resolve } from 'node:path';

// Playwright is invoked with the project root as cwd, so a relative path
// against process.cwd() points at the fixture deterministically. Avoids
// `import.meta.url` + `fileURLToPath`, which the Playwright loader treats
// as ESM-only and refuses to transpile in its default CJS-flavoured mode.
const FIXTURE = resolve(process.cwd(), 'tests/fixtures/opencollection/simple-http.yaml');

test.describe('OpenCollection import (web)', () => {
  test('imports a bundled YAML file and shows the request in the sidebar', async ({ app: page }) => {
    await page.getByRole('button', { name: 'Import collection' }).click();

    // ImportDialog should now be visible with an OpenCollection tab.
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('tab', { name: 'OpenCollection' }).click();

    // The drop zone has a hidden <input id="file-upload-opencollection">.
    const fileInput = page.locator('#file-upload-opencollection');
    await fileInput.setInputFiles(FIXTURE);

    // The dialog auto-closes on success after ~1.5s; meanwhile the imported
    // collection name and its request name should appear in the sidebar.
    await expect(page.getByText('Simple HTTP Demo').first()).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('Get JSON Placeholder Post').first()).toBeVisible({ timeout: 8_000 });
  });

  test('rejects an invalid OpenCollection document with a readable error', async ({ app: page }) => {
    await page.getByRole('button', { name: 'Import collection' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('tab', { name: 'OpenCollection' }).click();

    // Construct a bogus YAML buffer in-memory and feed it to the same input.
    const bogus = Buffer.from('opencollection: "1.0.0"\ninfo:\n  bogus: 1\n', 'utf8');
    await page.locator('#file-upload-opencollection').setInputFiles({
      name: 'bad.yaml',
      mimeType: 'application/x-yaml',
      buffer: bogus,
    });

    await expect(page.getByText(/Import failed/i)).toBeVisible({ timeout: 5_000 });
  });
});
