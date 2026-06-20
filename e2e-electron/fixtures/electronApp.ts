import {
  test as base,
  expect,
  _electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const MAIN_JS = path.join(ROOT, 'dist/electron/electron/main/main.js');

interface ElectronFixtures {
  app: Page;
}

interface ElectronWorkerFixtures {
  _electronApp: { electronApp: ElectronApplication; page: Page };
}

/**
 * Worker-scoped Electron launch. One app instance per Playwright worker:
 * launching Electron is expensive (~2-4s) and the renderer is a multi-tab
 * workspace, so tests share the window and open fresh request tabs.
 *
 * - `RESTURA_USER_DATA_DIR` points at a fresh temp dir: isolated storage and
 *   an isolated single-instance lock (a developer's running Restura won't
 *   kill the test launch).
 * - `NODE_ENV=production` so window-manager loads dist/web/index.html rather
 *   than the Vite dev server.
 */
export const test = base.extend<ElectronFixtures, ElectronWorkerFixtures>({
  _electronApp: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const userDataDir = mkdtempSync(path.join(tmpdir(), 'restura-e2e-'));
      const electronApp = await _electron.launch({
        // `--ignore-certificate-errors` is a test-only Chromium switch (not a
        // source change). It affects ONLY renderer-initiated TLS (the OAuth2
        // token fetch is the sole renderer-direct network path), letting that
        // test hit the local https mock's self-/private-CA cert. The undici-based
        // transports (customCa/mTLS/etc. run in the main process) are unaffected,
        // so their cert-verification assertions still hold.
        args: [MAIN_JS, '--ignore-certificate-errors'],
        cwd: ROOT,
        env: {
          ...process.env,
          NODE_ENV: 'production',
          RESTURA_DISABLE_AUTO_UPDATE: 'true',
          RESTURA_USER_DATA_DIR: userDataDir,
        },
      });

      const page = await electronApp.firstWindow();
      await page.waitForLoadState('domcontentloaded');

      // Fresh userData ⇒ the welcome onboarding shows. Dismiss it via its own
      // UI (addInitScript can't reach the already-loading first window).
      const skipTour = page.getByRole('button', { name: 'Skip Tour' });
      try {
        await skipTour.click({ timeout: 5_000 });
      } catch {
        // Onboarding not shown (already dismissed or feature changed) — fine.
      }
      await expect(page.getByRole('main', { name: 'Request workspace' })).toBeVisible({
        timeout: 15_000,
      });

      await use({ electronApp, page });

      await electronApp.close();
      rmSync(userDataDir, { recursive: true, force: true });
    },
    { scope: 'worker' },
  ],

  app: async ({ _electronApp }, use) => {
    await use(_electronApp.page);
  },
});

export { expect };
