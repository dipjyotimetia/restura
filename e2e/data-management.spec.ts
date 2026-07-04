import { test, expect } from './fixtures/app';

test.describe('Collections', () => {
  test('creates a new collection from the sidebar', async ({ app: page }) => {
    // The Collections panel is open by default; click "New collection" to add one.
    // Creating a collection auto-starts inline rename, so the name is the
    // value of the rename textbox until committed (Enter).
    await page.getByRole('button', { name: 'New collection', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Rename collection' })).toHaveValue(
      'New Collection'
    );
    await page.keyboard.press('Enter');
    await expect(page.getByText('New Collection', { exact: true }).first()).toBeVisible();

    // Adding another should produce a uniquely-numbered name.
    await page.getByRole('button', { name: 'New collection', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Rename collection' })).toHaveValue(
      'New Collection 2'
    );
    await page.keyboard.press('Enter');
    await expect(page.getByText('New Collection 2').first()).toBeVisible();
  });

  test('search filters collections', async ({ app: page }) => {
    await page.getByRole('button', { name: 'New collection', exact: true }).click();
    // Commit the auto-started rename so the name renders as text.
    await page.keyboard.press('Enter');
    await expect(page.getByText('New Collection', { exact: true }).first()).toBeVisible();

    const search = page.getByPlaceholder('Search...');
    await search.fill('zzz-no-match');
    await expect(page.getByText('No collections found')).toBeVisible();

    await search.fill('');
    await expect(page.getByText('New Collection', { exact: true }).first()).toBeVisible();
  });

  test('switches between Collections, History, Workflows tabs', async ({ app: page }) => {
    await page.getByRole('tab', { name: 'History' }).click();
    await expect(page.getByRole('tabpanel', { name: 'History' })).toBeVisible();

    await page.getByRole('tab', { name: 'Workflows' }).click();
    await expect(page.getByRole('tabpanel', { name: 'Workflows' })).toBeVisible();

    await page.getByRole('tab', { name: 'Collections' }).click();
    await expect(page.getByRole('tabpanel', { name: 'Collections' })).toBeVisible();
  });
});

// Environments coverage has moved to `environment-manager.spec.ts`, which
// drives the redesigned dialog end-to-end (selection vs. active, scaffolds,
// rename/duplicate/delete, search). Keeping a redundant smoke here would
// duplicate setup cost without adding signal.

test.describe('Settings', () => {
  test('opens settings dialog', async ({ app: page }) => {
    await page.getByRole('button', { name: 'Open settings' }).click();

    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
    // Side nav inside the dialog.
    await expect(page.getByRole('button', { name: /^Proxy$/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Certificates$/ })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Settings' })).not.toBeVisible();
  });
});

test.describe('Theme toggle', () => {
  test('toggles between light and dark', async ({ app: page }) => {
    const html = page.locator('html');
    const initial = await html.getAttribute('class');

    await page.getByRole('button', { name: 'Open settings' }).click();
    await page.getByRole('radio', { name: initial?.includes('dark') ? 'Light' : 'Dark' }).click();

    await expect.poll(async () => await html.getAttribute('class')).not.toBe(initial);
  });
});

test.describe('Tabs (request tabs)', () => {
  test('opens a new tab from the new-tab dropdown', async ({ app: page }) => {
    // The "new request" button opens a dropdown menu of request types.
    await page.getByRole('button', { name: 'new request', exact: true }).click();
    await page.getByRole('menuitem', { name: /HTTP/ }).click();

    const tabs = await page
      .locator('[role="tab"]')
      .filter({ hasText: /New Request/i })
      .count();
    expect(tabs).toBeGreaterThanOrEqual(2);
  });
});

test.describe('Sidebar visibility', () => {
  test('sidebar Close panel hides the sidebar; icon rail still visible', async ({ app: page }) => {
    await expect(page.getByRole('button', { name: 'New collection', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Close panel' }).click();

    await expect(
      page.getByRole('button', { name: 'New collection', exact: true })
    ).not.toBeVisible();
    await expect(page.getByRole('banner', { name: 'Application chrome' })).toBeVisible();
  });
});
