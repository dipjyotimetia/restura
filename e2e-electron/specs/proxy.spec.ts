import { test, expect } from '../fixtures/proxy';
import type { Page } from '@playwright/test';
import { switchMode, setUrl, sendButton } from '../../e2e/utils/selectors';

/**
 * Desktop HTTP proxy: renderer → IPC → http-handler → undici ProxyAgent → mock
 * proxy → upstream. Desktop-only with NO web backstop (browser fetch can't honour
 * an outbound proxy). The mock proxy records every forward/CONNECT that tunnels
 * through it, so a non-zero count proves the desktop transport actually routed
 * via the proxy — if the proxy config were dropped the request would go direct
 * and the count would stay 0 (fail-when-broken). The upstream is addressed via a
 * `*.localhost` host so it isn't on the proxy's loopback bypass list.
 */
async function configureProxy(
  page: Page,
  opts: { enabled: boolean; host?: string; port?: number; type?: string }
): Promise<void> {
  await page.getByRole('button', { name: 'Open settings' }).click();
  const drawer = page.getByRole('dialog', { name: 'Settings' });
  await drawer.getByRole('button', { name: 'Proxy', exact: true }).click();
  const toggle = drawer.getByRole('switch', { name: 'Enable proxy' });
  const isOn = (await toggle.getAttribute('aria-checked')) === 'true';
  if (isOn !== opts.enabled) await toggle.click();
  if (opts.enabled) {
    if (opts.type) await drawer.getByRole('radio', { name: opts.type, exact: true }).click();
    if (opts.host !== undefined) await drawer.getByPlaceholder('proxy.example.com').fill(opts.host);
    if (opts.port !== undefined) await drawer.getByRole('spinbutton').fill(String(opts.port));
  }
  await page.getByRole('button', { name: 'Close settings' }).click();
}

test.describe('Desktop HTTP proxy', () => {
  test('an HTTP request routes through the outbound proxy', async ({ app: page, proxyStack }) => {
    await configureProxy(page, { enabled: true, host: '127.0.0.1', port: proxyStack.proxy.port });
    try {
      await switchMode(page, 'http');
      await setUrl(page, `${proxyStack.upstreamUrl}/json`);
      await sendButton(page).click();

      // End-to-end success AND proof the hop went through the proxy.
      await expect(page.getByText('200', { exact: true }).first()).toBeVisible({ timeout: 15_000 });
      expect(
        proxyStack.proxy.connectCount() + proxyStack.proxy.forwardCount(),
        'the request tunnelled/forwarded through the mock proxy'
      ).toBeGreaterThanOrEqual(1);
    } finally {
      // Persisted setting — clear it so later specs in the shared window go direct.
      await configureProxy(page, { enabled: false });
    }
  });

  test('an HTTP request routes through a SOCKS5 proxy', async ({ app: page, proxyStack }) => {
    await configureProxy(page, {
      enabled: true,
      type: 'SOCKS5',
      host: '127.0.0.1',
      port: proxyStack.socks.port,
    });
    try {
      await switchMode(page, 'http');
      await setUrl(page, `${proxyStack.upstreamUrl}/json`);
      await sendButton(page).click();

      await expect(page.getByText('200', { exact: true }).first()).toBeVisible({ timeout: 15_000 });
      expect(
        proxyStack.socks.connectCount(),
        'the request tunnelled through the SOCKS5 proxy'
      ).toBeGreaterThanOrEqual(1);
    } finally {
      await configureProxy(page, { enabled: false, type: 'HTTP' });
    }
  });
});
