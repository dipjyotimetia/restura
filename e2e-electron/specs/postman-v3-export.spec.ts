import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures/electronApp';

/**
 * #1201: desktop Postman v3 export writes `<picked>/<name>/` through the
 * hardened directory-export IPC. A second export into the same directory
 * asks before replacing (stale request files are removed, other files kept),
 * and the written folder re-imports.
 */
const FIXTURE = resolve(process.cwd(), 'shared/collections/postman/__fixtures__/v3/kitchen-sink');

async function importFolder(page: Page, folder: string) {
  await page.getByRole('button', { name: 'Import collection' }).click();
  const dialog = page.getByRole('dialog', { name: 'Import collection' });
  await dialog.getByRole('button').filter({ hasText: 'Postman' }).first().click();
  await dialog.getByTestId('postman-folder-input').setInputFiles(folder);
  const preview = dialog.getByRole('region', { name: 'Import preview' });
  await expect(preview).toContainText('Detected format: Postman v3');
  await preview.getByRole('button', { name: 'Confirm import' }).click();
  await expect(dialog.getByText(/Auth "hawk" not supported/)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
}

async function exportV3(page: Page) {
  // Collections accumulate in the shared desktop window — target this one's row.
  const row = page
    .getByText('Kitchen Sink', { exact: true })
    .first()
    .locator('xpath=ancestor::*[.//button[@aria-label="Collection options"]][1]');
  await row.hover();
  await row.getByRole('button', { name: 'Collection options' }).click();
  await page.getByRole('menuitem', { name: 'Export' }).hover();
  await page.getByRole('menuitem', { name: 'Postman v3 (folder / zip)' }).hover();
  await page.getByRole('menuitem', { name: 'Postman v3 (folder / zip)' }).click();
  await page.getByRole('button', { name: 'Export redacted' }).click();
}

test.describe('Desktop Postman v3 export', () => {
  test('exports a folder, confirms Replace on re-export, and re-imports it', async ({
    app: page,
    _electronApp,
  }) => {
    const parent = mkdtempSync(join(tmpdir(), 'restura-pm3-export-'));
    const source = join(parent, 'Kitchen Sink');
    cpSync(FIXTURE, source, { recursive: true });
    // Under userData: an allowed export root for the main-process path policy.
    const out = join(_electronApp.userDataDir, 'pm3-exports');
    mkdirSync(out, { recursive: true });
    await _electronApp.electronApp.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as never;
    }, out);
    try {
      await importFolder(page, source);

      await exportV3(page);
      const written = join(out, 'Kitchen Sink');
      await expect
        .poll(() => existsSync(join(written, 'Users', 'List users.request.yaml')))
        .toBe(true);
      expect(readFileSync(join(written, '.resources', 'definition.yaml'), 'utf8')).toMatch(
        /^\$kind: collection\nname: Kitchen Sink\n/
      );
      expect(
        readFileSync(join(written, 'Users', '.resources', 'definition.yaml'), 'utf8')
      ).not.toMatch(/password: p\b/);

      // Second export: the folder is non-empty → confirm Replace.
      writeFileSync(join(written, 'Stale.request.yaml'), '$kind: http-request\n');
      writeFileSync(join(written, 'README.md'), 'keep me');
      let confirmed = '';
      page.once('dialog', (d) => {
        confirmed = d.message();
        void d.accept();
      });
      await exportV3(page);
      await expect.poll(() => confirmed).toMatch(/"Kitchen Sink" already exists/);
      await expect.poll(() => existsSync(join(written, 'Stale.request.yaml'))).toBe(false);
      expect(readFileSync(join(written, 'README.md'), 'utf8')).toBe('keep me');
      expect(existsSync(join(written, 'Users', 'List users.request.yaml'))).toBe(true);

      rmSync(join(written, 'README.md'));
      await importFolder(page, written);
      await expect(page.getByText('Kitchen Sink', { exact: true })).toHaveCount(2);
    } finally {
      rmSync(parent, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  });
});
