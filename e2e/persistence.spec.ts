import { test, expect } from './fixtures/app';
import { setUrl } from './utils/selectors';

// Persistence regression: global state must come back from the encrypted Dexie
// store after a full page reload (not just from in-memory zustand state). This
// guards the renderer → dexie-storage adapter → IndexedDB → rehydrate pipeline
// end-to-end in a real browser. Each test runs in a fresh browser context, so
// IndexedDB starts empty; `page.reload()` keeps the same context (same storage).
test.describe('Persistence across reload', () => {
  test('a created collection survives a full page reload', async ({ app: page }) => {
    await page.getByRole('button', { name: 'New collection', exact: true }).click();
    const rename = page.getByRole('textbox', { name: 'Rename collection' });
    await rename.fill('Persisted Collection');
    await page.keyboard.press('Enter');
    await expect(page.getByText('Persisted Collection', { exact: true }).first()).toBeVisible();

    // Let the persisted (Dexie/IndexedDB) write flush before reloading —
    // the store's setItem() isn't awaited synchronously with the state
    // change, so an immediate reload can race the write under load (see
    // layout-split.spec.ts for the same pattern).
    await page.waitForTimeout(500);
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByRole('main', { name: 'Request workspace' })).toBeVisible();

    // Rehydrated from Dexie — the collection is back without re-creating it.
    await expect(page.getByText('Persisted Collection', { exact: true }).first()).toBeVisible();
  });

  test('an opened request tab and its edited URL survive a reload', async ({ app: page }) => {
    // Open a second request tab and give it a uniquely identifiable URL so the
    // assertion proves THIS persisted tab came back — not just that some default
    // tab is present.
    await page.getByRole('button', { name: 'new request', exact: true }).click();
    await page.getByRole('menuitem', { name: /HTTP/ }).click();

    const marker = 'https://example.com/persisted-tab-marker';
    await setUrl(page, marker);
    await expect(page.getByRole('textbox', { name: 'Request URL' })).toHaveValue(marker);

    // Scoped to the request tab strip (not text-matched) — once the URL above
    // diverges from the default echo URL, this tab's label switches from
    // "New Request" to its host+path.
    const requestTabs = page.getByRole('tablist', { name: 'Request tabs' }).getByRole('tab');
    const tabsBefore = await requestTabs.count();
    expect(tabsBefore).toBeGreaterThanOrEqual(2);

    // Let the persisted (Dexie/IndexedDB) write flush before reloading — see
    // the note in the previous test.
    await page.waitForTimeout(500);
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByRole('main', { name: 'Request workspace' })).toBeVisible();

    // Exact tab count is preserved (not merely >= 2)...
    const tabsAfter = await requestTabs.count();
    expect(tabsAfter).toBe(tabsBefore);
    // ...and the active tab's edited URL was rehydrated from Dexie.
    await expect(page.getByRole('textbox', { name: 'Request URL' })).toHaveValue(marker);
  });
});
