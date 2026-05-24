import { type Page, expect } from '@playwright/test';

/**
 * Configures Restura's HTTP proxy via the Settings dialog. Clears the default
 * localhost bypass list (since our mock servers run on 127.0.0.1) and points
 * the proxy at the given host/port.
 */
export async function configureProxy(page: Page, host: string, port: number): Promise<void> {
  // Open Settings → Proxy.
  await page.getByRole('button', { name: 'Open settings' }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await page.getByRole('button', { name: /^Proxy$/ }).click();

  // Enable proxy switch.
  const enable = page.getByRole('switch', { name: /Enable Proxy/i });
  if (!(await enable.isChecked())) {
    await enable.click();
  }

  // Host & port.
  await page.getByPlaceholder('proxy.example.com').fill(host);
  const portInput = page
    .getByRole('dialog', { name: 'Settings' })
    .locator('input[type="number"]')
    .first();
  await portInput.fill(String(port));

  // Close settings (Escape).
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Settings' })).not.toBeVisible();
}
