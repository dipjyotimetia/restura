import { test, expect } from './fixtures/app';

test.describe('Collections', () => {
  test('creates a new collection from the sidebar', async ({ app: page }) => {
    // The Collections panel is open by default; click "New" to add one.
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await expect(page.getByText(/New Collection/).first()).toBeVisible();

    // Adding another should produce a uniquely-numbered name.
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await expect(page.getByText('New Collection 2').first()).toBeVisible();
  });

  test('search filters collections', async ({ app: page }) => {
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await expect(page.getByText('New Collection').first()).toBeVisible();

    const search = page.getByPlaceholder('Search...');
    await search.fill('zzz-no-match');
    await expect(page.getByText('No collections found')).toBeVisible();

    await search.fill('');
    await expect(page.getByText('New Collection').first()).toBeVisible();
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

test.describe('Environments', () => {
  test('opens environment manager and creates an environment', async ({ app: page }) => {
    await page.getByRole('button', { name: 'Manage Environments' }).click();

    await expect(page.getByRole('heading', { name: /ENVIRONMENTS/i })).toBeVisible();

    await page.getByRole('button', { name: /New Environment/i }).click();

    // The newly-created env appears in the left list. It is auto-named.
    await expect(page.getByText(/New Environment/).first()).toBeVisible();

    // Close via the Close button.
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.getByRole('heading', { name: /ENVIRONMENTS/i })).not.toBeVisible();
  });
});

test.describe('Settings', () => {
  test('opens settings dialog', async ({ app: page }) => {
    // The IconRail Settings button is in the main navigation aside.
    await page.getByRole('navigation', { name: 'Main navigation' })
      .getByRole('button', { name: 'Settings' })
      .click();

    await expect(page.getByText('SETTINGS', { exact: true })).toBeVisible();
    // Side nav inside the dialog.
    await expect(page.getByRole('button', { name: /^Proxy$/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Security$/ })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByText('SETTINGS', { exact: true })).not.toBeVisible();
  });
});

test.describe('Theme toggle', () => {
  test('toggles between light and dark', async ({ app: page }) => {
    const html = page.locator('html');
    const initial = await html.getAttribute('class');

    await page.getByRole('button', { name: 'Toggle theme' }).first().click();

    await expect
      .poll(async () => await html.getAttribute('class'))
      .not.toBe(initial);
  });
});

test.describe('Tabs (request tabs)', () => {
  test('opens a new tab from the new-tab dropdown', async ({ app: page }) => {
    // The "new request" button opens a dropdown menu of request types.
    await page.getByRole('button', { name: 'new request', exact: true }).click();
    await page.getByRole('menuitem', { name: /HTTP/ }).click();

    const tabs = await page.locator('[role="tab"]').filter({ hasText: /New Request/i }).count();
    expect(tabs).toBeGreaterThanOrEqual(2);
  });
});

test.describe('Sidebar visibility', () => {
  test('sidebar Close panel hides the sidebar; icon rail still visible', async ({ app: page }) => {
    await expect(page.getByRole('button', { name: 'New', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Close panel' }).click();

    await expect(page.getByRole('button', { name: 'New', exact: true })).not.toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  });
});
