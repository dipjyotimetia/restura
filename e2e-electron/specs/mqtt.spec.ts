import type { Page } from '@playwright/test';
import { startMockSocksProxyServer } from '../../e2e/mocks/socksProxyServer';
import { switchMode } from '../../e2e/utils/selectors';
import { dockerAvailable, expect, test } from '../fixtures/brokers';

// Requires the Dockerised EMQX broker; skip (don't fail) when Docker is absent.
const describeOrSkip = dockerAvailable() ? test.describe : test.describe.skip;

async function configureSocksProxy(page: Page, port: number, enabled: boolean): Promise<void> {
  await page.getByRole('button', { name: 'Open settings' }).click();
  const drawer = page.getByRole('dialog', { name: 'Settings' });
  await drawer.getByRole('button', { name: 'Proxy', exact: true }).click();
  const toggle = drawer.getByRole('switch', { name: 'Enable proxy' });
  const isOn = (await toggle.getAttribute('aria-checked')) === 'true';
  if (isOn !== enabled) await toggle.click();
  if (enabled) {
    await drawer.getByRole('radio', { name: 'SOCKS5', exact: true }).click();
    await drawer.getByPlaceholder('proxy.example.com').fill('127.0.0.1');
    await drawer.getByRole('spinbutton').fill(String(port));
  }
  await page.getByRole('button', { name: 'Close settings' }).click();
}

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

  test('uses the global SOCKS5 proxy for the raw MQTT broker connection', async ({
    app: page,
    brokers,
  }) => {
    const socks = await startMockSocksProxyServer();
    try {
      expect(brokers.mqtt).toBe('mqtt://localhost:1883');
      await configureSocksProxy(page, socks.port, true);
      // Settings delivery is an asynchronous IPC round trip. Wait for that
      // renderer→main update to settle before constructing the outbound client.
      await page.waitForTimeout(250);
      await switchMode(page, 'mqtt');
      await page.getByRole('tab', { name: 'Connection', exact: true }).click();
      // The default bypass list covers localhost but not broker.localhost;
      // the proxy maps this deterministic loopback name back to 127.0.0.1.
      await page.getByPlaceholder('mqtt://localhost:1883').fill('mqtt://broker.localhost:1883');
      await page.getByRole('button', { name: 'Connect', exact: true }).click();

      await expect(page.getByText('Connected').first()).toBeVisible({ timeout: 15_000 });
      expect(socks.connectCount(), 'MQTT CONNECT tunnelled through SOCKS5').toBeGreaterThanOrEqual(
        1
      );
    } finally {
      await page
        .getByRole('button', { name: /Disconnect/ })
        .first()
        .click()
        .catch(() => {});
      await configureSocksProxy(page, socks.port, false).catch(() => {});
      await socks.close();
    }
  });
});
