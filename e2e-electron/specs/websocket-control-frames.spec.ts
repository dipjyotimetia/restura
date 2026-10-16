import type { Page } from '@playwright/test';
import { switchMode } from '../../e2e/utils/selectors';
import { expect, test } from '../fixtures/servers';

/**
 * Desktop WebSocket control frames against the local mock (real `ws` server):
 * custom close code/reason (#915), ping/pong with RTT (#919), negotiated
 * extensions + the permessage-deflate toggle (#923).
 */
async function connect(page: Page, url: string) {
  await switchMode(page, 'ws');
  await page.getByRole('textbox', { name: 'WebSocket URL' }).fill(url);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByTestId('websocket-status')).toHaveText(/CONNECTED/, { timeout: 10_000 });
}

test.describe('Desktop WebSocket control frames', () => {
  test('ping shows pong RTT; custom close code reaches the server', async ({
    app: page,
    servers,
  }) => {
    servers.ws.reset();
    await connect(page, `${servers.ws.url}/echo`);

    await page.getByRole('button', { name: 'Ping with payload' }).click();
    await page.getByLabel('Ping payload (optional)').fill('rtt-probe');
    await page.getByRole('button', { name: 'Send ping' }).click();
    await expect(
      page.getByText(/Pong received · RTT \d+ ms \(payload: rtt-probe\)/).first()
    ).toBeVisible({ timeout: 10_000 });

    await page.getByRole('button', { name: 'Disconnect with close code' }).click();
    const code = page.getByLabel('Code (1000 or 3000-4999)');
    await code.fill('4001');
    await page.getByLabel('Reason (optional)').fill('bye-desktop');
    await page.getByRole('button', { name: 'Close with code' }).click();

    await expect
      .poll(() => servers.ws.clientCloses(), { timeout: 10_000 })
      .toContainEqual({ code: 4001, reason: 'bye-desktop' });
  });

  test('server-initiated pings are logged', async ({ app: page, servers }) => {
    await connect(page, `${servers.ws.url}/ping`);
    await page.getByRole('radio', { name: 'text' }).click();
    await page.getByPlaceholder(/Enter message to send/i).fill('PING_ME');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(
      page.getByText(/Ping received from server \(auto-replied with pong\)/).first()
    ).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  });

  test('negotiated permessage-deflate is shown and the toggle disables it', async ({
    app: page,
    servers,
  }) => {
    await connect(page, `${servers.ws.url}/echo-deflate`);
    await expect(page.getByText(/extensions: permessage-deflate/).first()).toBeVisible();
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();

    await page.getByRole('button', { name: 'Clear messages' }).click();
    await page.getByRole('button', { name: /Options/ }).click();
    await page.getByRole('switch', { name: 'Offer permessage-deflate compression' }).click();
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.getByTestId('websocket-status')).toHaveText(/CONNECTED/, {
      timeout: 10_000,
    });
    await expect(page.getByText(/^Connected to .*echo-deflate$/).first()).toBeVisible();
    await expect(page.getByText(/extensions: permessage-deflate/)).toHaveCount(0);
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  });
});
