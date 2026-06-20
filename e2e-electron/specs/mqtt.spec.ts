import { test, expect, dockerAvailable } from '../fixtures/brokers';
import { switchMode } from '../../e2e/utils/selectors';

// Requires the Dockerised EMQX broker; skip (don't fail) when Docker is absent.
const describeOrSkip = dockerAvailable() ? test.describe : test.describe.skip;

/**
 * Desktop MQTT round-trip against a REAL broker (EMQX via Docker) — renderer →
 * IPC → mqtt-handler (mqtt.js over raw TCP) → broker → back. The web suite only
 * exercises a mocked loopback bridge; this drives the live wire end-to-end:
 * connect, subscribe, publish, and receive the broker's redelivery. The default
 * broker URL (mqtt://localhost:1883) matches the Dockerised EMQX listener.
 */
describeOrSkip('Desktop MQTT (live EMQX broker)', () => {
  test('connect → subscribe → publish round-trips via the broker', async ({
    app: page,
    brokers,
  }) => {
    expect(brokers.mqtt).toBe('mqtt://localhost:1883');
    await switchMode(page, 'mqtt');

    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.getByText('Connected').first()).toBeVisible({ timeout: 15_000 });

    // Subscribe BEFORE publishing — MQTT only delivers live messages to existing
    // subscriptions (no replay).
    await page.getByRole('tab', { name: /Subscribe/ }).click();
    const subPanel = page.getByRole('tabpanel');
    await subPanel.getByPlaceholder(/sensors\/#/).fill('restura/#');
    await subPanel.getByRole('button', { name: 'Subscribe', exact: true }).click();
    await expect(subPanel.getByText('subscribed')).toBeVisible({ timeout: 10_000 });

    await page.getByRole('tab', { name: /Publish/ }).click();
    const pubPanel = page.getByRole('tabpanel');
    await pubPanel.getByPlaceholder('restura/test').fill('restura/test');
    await pubPanel.locator('textarea').fill('hello-mqtt-live');
    await pubPanel.getByRole('button', { name: 'Publish', exact: true }).click();

    // Messages tab: the publish logs a 'sent' row, and the broker redelivers it
    // to our matching subscription as a 'received' row — two rows carry the
    // payload, proving the real publish + subscribe round-trip (fail-when-broken:
    // a transport regression yields fewer than two).
    await page.getByRole('tab', { name: /Messages/ }).click();
    await expect(page.getByText('hello-mqtt-live').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('hello-mqtt-live')).toHaveCount(2, { timeout: 15_000 });

    await page
      .getByRole('button', { name: /Disconnect/ })
      .first()
      .click()
      .catch(() => {});
  });
});
