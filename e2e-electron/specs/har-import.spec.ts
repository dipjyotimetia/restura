import { resolve } from 'node:path';
import { expect, test } from '../fixtures/electronApp';

const FIXTURE = resolve(process.cwd(), 'e2e/fixtures/import/captured.har');

test.describe('Desktop HAR import', () => {
  test('renders the same explicit HAR review before adding a collection', async ({ app: page }) => {
    await page.getByRole('button', { name: 'Import collection' }).click();
    const dialog = page.getByRole('dialog', { name: 'Import collection' });
    await dialog.getByRole('button').filter({ hasText: 'HAR' }).first().click();
    await dialog.locator('#file-upload-har').setInputFiles(FIXTURE);

    await expect(dialog.getByRole('heading', { name: 'Review HAR import' })).toBeVisible();
    await expect(dialog.getByText('Checkout', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Import selected requests' }).click();
    await expect(page.getByText('POST /orders', { exact: true }).first()).toBeVisible();
  });
});
