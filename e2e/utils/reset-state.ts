import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * Wipe everything Restura persists in the browser and bounce back to a clean
 * `/` so the spec starts from a deterministic state.
 *
 * Why this exists:
 *   `playwright.config.ts` runs e2e with `workers: 1, fullyParallel: false`
 *   (shared dev-server state), so collections/environments/history created
 *   by one test leak into the next. Both `useCollectionStore` and
 *   `useEnvironmentStore` persist through Zustand → Dexie (IndexedDB), and
 *   the request store still touches localStorage for tab state. We drop
 *   both, then reload.
 *
 * The onboarding flag is re-seeded automatically: the `app` fixture in
 * `fixtures/app.ts` uses `page.addInitScript`, which fires on every
 * navigation (including the `reload()` here) before any page script runs.
 */
export async function resetPersistedState(page: Page): Promise<void> {
  await page.evaluate(async () => {
    // Best-effort. Browsers without `databases()` (Firefox) would need a
    // hardcoded name list, but Playwright runs Chromium here.
    const dbs = (await indexedDB.databases?.()) ?? [];
    await Promise.all(
      dbs.map(
        (d) =>
          new Promise<void>((resolve) => {
            if (!d.name) {
              resolve();
              return;
            }
            const req = indexedDB.deleteDatabase(d.name);
            req.onsuccess = () => resolve();
            req.onerror = () => resolve();
            req.onblocked = () => resolve();
          })
      )
    );
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.reload();
  // Re-establish the post-onboarding workspace so the spec can interact
  // immediately without each test having to wait again.
  await expect(page.getByRole('main', { name: 'Request workspace' })).toBeVisible();
}
