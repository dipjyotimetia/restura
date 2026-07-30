import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron, expect, test } from '@playwright/test';

const ROOT = path.resolve(__dirname, '../..');
const MAIN_JS = path.join(ROOT, 'dist/electron/electron/main/main.js');

test('cold-start restura settings deep link opens the reviewed settings section', async () => {
  const userDataDir = mkdtempSync(
    path.join(process.platform === 'win32' ? tmpdir() : '/tmp', 'restura-deep-link-')
  );
  const app = await _electron.launch({
    args: [MAIN_JS, 'restura://settings?section=security'],
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      RESTURA_DISABLE_AUTO_UPDATE: 'true',
      RESTURA_USER_DATA_DIR: userDataDir,
    },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    const skip = page.getByRole('button', { name: 'Skip Tour' });
    try {
      await skip.click({ timeout: 5_000 });
    } catch {
      /* onboarding already dismissed */
    }
    await expect(page.getByLabel('Settings')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Security', { exact: true }).last()).toBeVisible();
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
