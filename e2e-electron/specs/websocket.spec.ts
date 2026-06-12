import { test, expect } from '../fixtures/servers';
import { switchMode } from '../../e2e/utils/selectors';

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
});
