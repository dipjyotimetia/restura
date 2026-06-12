import { test, expect } from '../fixtures/electronApp';

/**
 * Desktop-only surfaces that the web e2e suite can never verify: protocols
 * gated behind isElectron() must be present in the real desktop build.
 * Kafka/MQTT need live brokers, so this asserts presence, not round-trips.
 */
test.describe('Desktop-only protocol surfaces', () => {
  test('MQTT and Kafka modes are offered in the new-request menu', async ({ app: page }) => {
    await page.getByRole('button', { name: 'new request', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: 'MQTT client', exact: true })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /Kafka/i })).toBeVisible();
    await page.keyboard.press('Escape');
  });
});
