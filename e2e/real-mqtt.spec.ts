import { test as webTest, expect as webExpect } from './fixtures/app';
import { test, expect, openMqttTab } from './fixtures/mqtt';

/**
 * MQTT is a desktop-only protocol (raw TCP/TLS over the Electron IPC bridge).
 *
 * Two layers of coverage:
 *   1. Web-build gating — on the Cloudflare Pages / web build there is no
 *      `window.electron`, so the MQTT entry points must NOT leak into the UI.
 *   2. Full renderer flow — with a mocked loopback-broker Electron bridge
 *      injected, the real MqttClient drives connect → subscribe → publish →
 *      round-trip → disconnect end-to-end (see fixtures/mqtt.ts).
 */

webTest.describe('MQTT — web build gating', () => {
  webTest('is not offered in the web new-request menu', async ({ app: page }) => {
    await page.getByRole('button', { name: 'new request', exact: true }).click();
    await webExpect(page.getByRole('menuitem', { name: 'MQTT client', exact: true })).toHaveCount(
      0
    );
    // Kafka (the other desktop-only protocol) is likewise absent — sanity that
    // the gate isn't simply hiding everything.
    await webExpect(
      page.getByRole('menuitem', { name: 'HTTP request', exact: true })
    ).toBeVisible();
    await page.keyboard.press('Escape');
  });

  webTest('is not offered in the web command palette', async ({ app: page }) => {
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
    await page.getByPlaceholder('Search requests, actions, settings...').fill('MQTT');
    await webExpect(page.getByText('New MQTT client')).toHaveCount(0);
    await page.keyboard.press('Escape');
  });
});

test.describe('MQTT — full flow (mocked Electron bridge)', () => {
  test.beforeEach(async ({ app: page }) => {
    await openMqttTab(page);
  });

  test('renders the full client UI, not the desktop-only panel', async ({ app: page }) => {
    await expect(page.getByText('MQTT is a desktop-only feature')).toHaveCount(0);
    await expect(page.getByRole('tab', { name: /Messages/ })).toBeVisible();
    await expect(page.getByRole('tab', { name: /Publish/ })).toBeVisible();
    await expect(page.getByRole('tab', { name: /Subscribe/ })).toBeVisible();
    await expect(page.getByRole('tab', { name: /Connection/ })).toBeVisible();
    // Default broker URL surfaced in the connection bar.
    await expect(page.getByText('mqtt://localhost:1883')).toBeVisible();
  });

  test('connect → subscribe → publish round-trips into the message log', async ({ app: page }) => {
    // Connect (default broker URL); the mock emits a CONNACK. Non-exact match:
    // the status badge text node also contains an aria-hidden bullet, and
    // "Connected" is not a substring of "Disconnected"/"Reconnecting".
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.getByText('Connected').first()).toBeVisible({ timeout: 10_000 });

    // Subscribe to a wildcard filter.
    await page.getByRole('tab', { name: /Subscribe/ }).click();
    const subPanel = page.getByRole('tabpanel');
    await subPanel.getByPlaceholder(/sensors\/#/).fill('restura/#');
    await subPanel.getByRole('button', { name: 'Subscribe', exact: true }).click();
    await expect(subPanel.getByText('restura/#')).toBeVisible();
    await expect(subPanel.getByText('subscribed')).toBeVisible({ timeout: 10_000 });

    // Publish to a topic the subscription matches — the mock echoes it back.
    await page.getByRole('tab', { name: /Publish/ }).click();
    const pubPanel = page.getByRole('tabpanel');
    await pubPanel.getByPlaceholder('restura/test').fill('restura/test');
    await pubPanel.locator('textarea').fill('hello-mqtt-e2e');
    await pubPanel.getByRole('button', { name: 'Publish', exact: true }).click();

    // Messages log: the published message is logged as 'sent' and the loopback
    // echo arrives as 'received' — two rows carry the payload, proving the full
    // publish + subscribe round-trip.
    await page.getByRole('tab', { name: /Messages/ }).click();
    await expect(page.getByText('hello-mqtt-e2e').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('hello-mqtt-e2e')).toHaveCount(2, { timeout: 10_000 });
  });

  test('disconnect returns the client to a disconnected state', async ({ app: page }) => {
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.getByText('Connected').first()).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: /Disconnect/ }).click();
    await expect(page.getByText('Disconnected').first()).toBeVisible({ timeout: 10_000 });
    // Connect is offered again once fully disconnected.
    await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeVisible();
  });
});
