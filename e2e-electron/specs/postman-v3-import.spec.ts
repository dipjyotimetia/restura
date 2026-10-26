import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '../fixtures/electronApp';

/**
 * #1200: Postman v3 folder import in the desktop renderer. The picked folder
 * contains hidden `.resources/` directories (collection / folder metadata);
 * they must reach the importer, otherwise the dialog would show the
 * "No .resources folders were included" warning and the collection would
 * lose its name, auth and scripts.
 */
const FIXTURE = resolve(process.cwd(), 'shared/collections/postman/__fixtures__/v3/kitchen-sink');

test.describe('Desktop Postman v3 folder import', () => {
  test('imports a v3 folder including its .resources metadata', async ({ app: page }) => {
    const parent = mkdtempSync(join(tmpdir(), 'restura-pm3-'));
    const folder = join(parent, 'Kitchen Sink');
    cpSync(FIXTURE, folder, { recursive: true });
    try {
      await page.getByRole('button', { name: 'Import collection' }).click();
      const dialog = page.getByRole('dialog', { name: 'Import collection' });
      await dialog.getByRole('button').filter({ hasText: 'Postman' }).first().click();
      await dialog.getByTestId('postman-folder-input').setInputFiles(folder);

      const preview = dialog.getByRole('region', { name: 'Import preview' });
      await expect(preview).toContainText('Detected format: Postman v3');
      // The name comes from `.resources/definition.yaml`, not the directory.
      await expect(preview).toContainText('Kitchen Sink · 3 top-level items');
      await preview.getByRole('button', { name: 'Confirm import' }).click();
      await expect(dialog.getByText(/No \.resources folders were included/)).toHaveCount(0);
      await expect(dialog.getByText(/Auth "hawk" not supported in "Hawk"/)).toBeVisible();

      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
