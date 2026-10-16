import { switchMode } from '../../e2e/utils/selectors';
import { expect, test } from '../fixtures/servers';

/** Desktop WebSocket: renderer → IPC → websocket-handler (`ws` library). */
test.describe('Desktop WebSocket', () => {
  test('connects, sends, receives the echo, disconnects', async ({ app: page, servers }) => {
    await switchMode(page, 'ws');

    await page.getByRole('textbox', { name: 'WebSocket URL' }).fill(`${servers.ws.url}/echo`);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();

    await page.getByRole('radio', { name: 'text' }).click();
    const sendInput = page.getByPlaceholder(/Enter message to send/i);
    await expect(sendInput).toBeEnabled({ timeout: 10_000 });

    await sendInput.fill('hello-from-desktop');
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    await expect(page.getByText(/echo:hello-from-desktop/).first()).toBeVisible({
      timeout: 10_000,
    });
    expect(servers.ws.receivedMessages().some((m) => m.payload === 'hello-from-desktop')).toBe(
      true
    );

    await page
      .getByRole('button', { name: /Disconnect/i })
      .first()
      .click()
      .catch(() => {});
  });

  // #897: binary frames cross IPC as base64 — bytes (incl. 0x00/0xFF) must
  // reach the server and come back byte-for-byte.
  test('sends and receives a binary frame byte-for-byte', async ({ app: page, servers }) => {
    await switchMode(page, 'ws');

    await page.getByRole('textbox', { name: 'WebSocket URL' }).fill(`${servers.ws.url}/echo`);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();

    await page.getByRole('radio', { name: 'binary' }).click();
    const sendInput = page.getByPlaceholder(/Enter hex bytes/i);
    await expect(sendInput).toBeEnabled({ timeout: 10_000 });

    await sendInput.fill('00 ff 48 69 80');
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    await expect
      .poll(() => servers.ws.receivedMessages().find((m) => m.kind === 'binary')?.payload, {
        timeout: 10_000,
      })
      .toBe('00ff486980');
    await expect(
      page
        .getByRole('button')
        .filter({ hasText: '← rx' })
        .filter({ hasText: '00 ff 48 69 80' })
        .first()
    ).toBeVisible({ timeout: 10_000 });

    await page
      .getByRole('button', { name: /Disconnect/i })
      .first()
      .click()
      .catch(() => {});
  });
});
