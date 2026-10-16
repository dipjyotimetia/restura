import { expect, test } from './fixtures/servers';
import { switchMode } from './utils/selectors';

/**
 * Web WebSocket control frames (browser `WebSocket`): custom close code/reason
 * reaches the server (#915), ping is disabled with an explanatory tooltip
 * (#919), and the negotiated subprotocol/extensions are surfaced (#923).
 */
test.describe('Real WebSocket control frames (web)', () => {
  test('custom close code + reason reach the server; ping is desktop-only', async ({
    app: page,
    servers,
  }) => {
    servers.ws.reset();
    await switchMode(page, 'ws');
    await page.getByRole('textbox', { name: 'WebSocket URL' }).fill(`${servers.ws.url}/echo`);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.getByTestId('websocket-status')).toHaveText(/CONNECTED/, {
      timeout: 10_000,
    });

    const ping = page.getByRole('button', { name: 'Send ping (desktop only)' });
    await expect(ping).toBeDisabled();
    await expect(page.getByTestId('ws-ping-web')).toHaveAttribute('title', /browser WebSocket API/);

    await page.getByRole('button', { name: 'Disconnect with close code' }).click();
    await page.getByLabel('Code (1000 or 3000-4999)').fill('4002');
    await page.getByLabel('Reason (optional)').fill('bye-web');
    await page.getByRole('button', { name: 'Close with code' }).click();

    await expect
      .poll(() => servers.ws.clientCloses(), { timeout: 10_000 })
      .toContainEqual({ code: 4002, reason: 'bye-web' });
    await expect(page.getByText('Closing (code: 4002, reason: bye-web)').first()).toBeVisible();
  });

  test('shows the negotiated subprotocol and permessage-deflate extension', async ({
    app: page,
    servers,
  }) => {
    await switchMode(page, 'ws');
    await page
      .getByRole('textbox', { name: 'WebSocket URL' })
      .fill(`${servers.ws.url}/echo-deflate`);
    await page.getByRole('button', { name: /Options/ }).click();
    await page.getByLabel('WebSocket subprotocols').fill('restura.echo.v1');
    await page.getByRole('button', { name: 'Connect', exact: true }).click();

    await expect(
      page
        .getByText(
          /Connected to .*\(subprotocol: restura\.echo\.v1; extensions: permessage-deflate/
        )
        .first()
    ).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  });
});
