import { type Page, expect } from '@playwright/test';

/**
 * Configures Restura's HTTP proxy via the Settings dialog. Clears the default
 * localhost bypass list (since our mock servers run on 127.0.0.1) and points
 * the proxy at the given host/port.
 */
export async function configureProxy(page: Page, host: string, port: number): Promise<void> {
  // Open Settings → Proxy.
  await page.getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Settings' })
    .click();
  await expect(page.getByText('SETTINGS', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^Proxy$/ }).click();

  // Enable proxy switch.
  const enable = page.getByRole('switch', { name: /Enable Proxy/i });
  if (!(await enable.isChecked())) {
    await enable.click();
  }

  // Host & port.
  await page.locator('#proxy-host').fill(host);
  await page.locator('#proxy-port').fill(String(port));

  // Remove every entry from the bypass list so 127.0.0.1 isn't excluded.
  const removeButtons = page.locator('[aria-label^="Remove "][aria-label$=" from bypass list"]');
  // Loop because the list re-renders after each removal.
  for (let i = 0; i < 10; i += 1) {
    const count = await removeButtons.count();
    if (count === 0) break;
    await removeButtons.first().click();
  }

  // Close settings (Escape).
  await page.keyboard.press('Escape');
  await expect(page.getByText('SETTINGS', { exact: true })).not.toBeVisible();
}
