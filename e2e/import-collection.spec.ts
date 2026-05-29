/**
 * Import Collection — e2e coverage for the redesigned dialog
 * (`src/components/shared/ImportDialog.tsx`).
 *
 * Each importer (Postman / Insomnia / OpenAPI / OpenCollection / Hoppscotch
 * / Bruno) gets a happy-path test that uploads a real fixture file and
 * asserts the resulting collection + request name appear in the sidebar.
 *
 * Fixtures live under `e2e/fixtures/import/` and are intentionally minimal
 * (1 collection / 1 request each) so the spec can target a precise text
 * label per format and CI stays fast. OpenCollection reuses the existing
 * `tests/fixtures/opencollection/simple-http.yaml`.
 *
 * Format cards have `aria-pressed`; the drop zone's hidden input has id
 * `file-upload-<format>`. The dialog's accessible name is
 * "Import collection".
 */
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { resolve } from 'node:path';
import { resetPersistedState } from './utils/reset-state';

const FIXTURES_DIR = resolve(process.cwd(), 'e2e/fixtures/import');
const OPENCOLLECTION_FIXTURE = resolve(
  process.cwd(),
  'tests/fixtures/opencollection/simple-http.yaml'
);

function dialog(page: Page) {
  return page.getByRole('dialog', { name: 'Import collection' });
}

async function openImport(page: Page) {
  await page.getByRole('button', { name: 'Import collection' }).click();
  await expect(dialog(page)).toBeVisible();
}

/**
 * Drive the format selector grid to the target card. Each card is a
 * `<button aria-pressed>` whose accessible name combines the format name
 * + its tagline (e.g. "Postman v2.1 collections & environments"), so we
 * disambiguate with a regex anchored to the start of the name.
 */
async function selectFormat(page: Page, name: string) {
  await dialog(page)
    .getByRole('button')
    .filter({ has: page.getByText(name, { exact: true }) })
    .first()
    .click();
}

/**
 * Type the file into the hidden `<input id="file-upload-<format>">`. The
 * visible "Choose file" button just forwards the click; setInputFiles is
 * the official Playwright entry point.
 */
async function uploadFile(page: Page, format: string, filePath: string) {
  await page.locator(`#file-upload-${format}`).setInputFiles(filePath);
}

async function uploadBuffer(
  page: Page,
  format: string,
  name: string,
  mimeType: string,
  buffer: Buffer
) {
  await page.locator(`#file-upload-${format}`).setInputFiles({ name, mimeType, buffer });
}

test.describe('Import Collection', () => {
  test.beforeEach(async ({ app: page }) => {
    await resetPersistedState(page);
  });

  test('format grid renders all six with branded badges; Postman is default', async ({
    app: page,
  }) => {
    await openImport(page);

    const grid = dialog(page);
    for (const name of [
      'Postman',
      'Insomnia',
      'OpenAPI',
      'OpenCollection',
      'Hoppscotch',
      'Bruno',
    ]) {
      // Each format name appears in a card's bold title.
      await expect(grid.getByText(name, { exact: true })).toBeVisible();
    }

    // Postman is the default selection (aria-pressed=true).
    const postmanCard = grid
      .getByRole('button')
      .filter({ has: page.getByText('Postman', { exact: true }) })
      .first();
    await expect(postmanCard).toHaveAttribute('aria-pressed', 'true');
  });

  test('switching format updates drop-zone copy + features list', async ({ app: page }) => {
    await openImport(page);

    await selectFormat(page, 'Bruno');
    await expect(dialog(page).getByText(/Drop your Bruno file here/)).toBeVisible();
    await expect(dialog(page).locator('code').filter({ hasText: '.bru' })).toBeVisible();
    await expect(dialog(page).getByText(/Bruno legacy \.bru files/)).toBeVisible();
  });

  test('imports a Postman v2.1 collection', async ({ app: page }) => {
    await openImport(page);
    await uploadFile(page, 'postman', `${FIXTURES_DIR}/postman.json`);

    await expect(page.getByText('Postman Sample').first()).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('Get Postman Ping').first()).toBeVisible({ timeout: 8_000 });
  });

  test('imports an Insomnia export', async ({ app: page }) => {
    await openImport(page);
    await selectFormat(page, 'Insomnia');
    await uploadFile(page, 'insomnia', `${FIXTURES_DIR}/insomnia.json`);

    await expect(page.getByText('Insomnia Sample').first()).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('Get Insomnia Ping').first()).toBeVisible({ timeout: 8_000 });
  });

  test('imports an Insomnia v5 (YAML) export', async ({ app: page }) => {
    await openImport(page);
    await selectFormat(page, 'Insomnia');
    await uploadFile(page, 'insomnia', `${FIXTURES_DIR}/insomnia-v5.yaml`);

    await expect(page.getByText('Insomnia v5 Sample').first()).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('Get Insomnia v5 Ping').first()).toBeVisible({ timeout: 8_000 });
  });

  test('imports an OpenAPI 3.0 spec', async ({ app: page }) => {
    await openImport(page);
    await selectFormat(page, 'OpenAPI');
    await uploadFile(page, 'openapi', `${FIXTURES_DIR}/openapi-3.json`);

    await expect(page.getByText('OpenAPI 3 Sample').first()).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText(/Get OpenAPI3 Ping|getOpenapi3Ping/).first()).toBeVisible({
      timeout: 8_000,
    });
  });

  test('imports a Swagger 2.0 spec', async ({ app: page }) => {
    await openImport(page);
    await selectFormat(page, 'OpenAPI');
    await uploadFile(page, 'openapi', `${FIXTURES_DIR}/openapi-2.json`);

    await expect(page.getByText('Swagger 2 Sample').first()).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText(/Get Swagger2 Ping|getSwagger2Ping/).first()).toBeVisible({
      timeout: 8_000,
    });
  });

  test('imports an OpenCollection bundle', async ({ app: page }) => {
    await openImport(page);
    await selectFormat(page, 'OpenCollection');
    await uploadFile(page, 'opencollection', OPENCOLLECTION_FIXTURE);

    await expect(page.getByText('Simple HTTP Demo').first()).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('Get JSON Placeholder Post').first()).toBeVisible({
      timeout: 8_000,
    });
  });

  test('imports a Hoppscotch collection', async ({ app: page }) => {
    await openImport(page);
    await selectFormat(page, 'Hoppscotch');
    await uploadFile(page, 'hoppscotch', `${FIXTURES_DIR}/hoppscotch.json`);

    await expect(page.getByText('Hoppscotch Sample').first()).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('Get Hoppscotch Ping').first()).toBeVisible({ timeout: 8_000 });
  });

  test('imports a Bruno .bru file', async ({ app: page }) => {
    await openImport(page);
    await selectFormat(page, 'Bruno');
    await uploadFile(page, 'bruno', `${FIXTURES_DIR}/bruno.bru`);

    await expect(page.getByText('Get Bruno Ping').first()).toBeVisible({ timeout: 8_000 });
  });

  test('auto-detects a Postman environment file', async ({ app: page }) => {
    await openImport(page);
    // Default tab is Postman. The detector kicks in inside processImportFile.
    await uploadFile(page, 'postman', `${FIXTURES_DIR}/postman-env.json`);

    await expect(dialog(page).getByText(/Imported environment: Postman Env Sample/)).toBeVisible({
      timeout: 8_000,
    });
  });

  test('auto-detects a Hoppscotch environment file', async ({ app: page }) => {
    await openImport(page);
    await selectFormat(page, 'Hoppscotch');
    await uploadFile(page, 'hoppscotch', `${FIXTURES_DIR}/hoppscotch-env.json`);

    await expect(dialog(page).getByText(/Imported environment: Hoppscotch Env Sample/)).toBeVisible(
      { timeout: 8_000 }
    );
  });

  test('shows a rose error banner when the file is malformed', async ({ app: page }) => {
    await openImport(page);
    await selectFormat(page, 'OpenCollection');
    await uploadBuffer(
      page,
      'opencollection',
      'bad.yaml',
      'application/x-yaml',
      Buffer.from('opencollection: "1.0.0"\ninfo:\n  bogus: 1\n', 'utf8')
    );

    await expect(dialog(page).getByText(/Import failed/i)).toBeVisible({ timeout: 5_000 });
    // Dialog stays open so the user can read the error.
    await expect(dialog(page)).toBeVisible();
  });

  test('shows an amber warnings banner with manual dismiss', async ({ app: page }) => {
    await openImport(page);
    await selectFormat(page, 'Bruno');
    await uploadFile(page, 'bruno', `${FIXTURES_DIR}/bruno-with-warning.bru`);

    const banner = dialog(page).getByText(/Imported with \d+ warning/);
    await expect(banner).toBeVisible({ timeout: 8_000 });
    // Warnings path requires a deliberate dismiss — the dialog must stay open.
    await expect(dialog(page)).toBeVisible();

    await dialog(page).getByRole('button', { name: 'Dismiss' }).click();
    await expect(dialog(page)).not.toBeVisible();
  });
});
