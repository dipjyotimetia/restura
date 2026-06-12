import { test, expect } from '../fixtures/servers';
import { switchMode } from '../../e2e/utils/selectors';

/** Desktop Socket.IO: renderer → IPC → socketio-handler (socket.io-client). */
test.describe('Desktop Socket.IO', () => {
  test('connects, emits, and receives the echoed event', async ({ app: page, servers }) => {
    await switchMode(page, 'socketio');

    await page.getByRole('textbox', { name: 'Socket.IO server URL' }).fill(servers.socketio.url);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();

    await expect(page.getByTestId('socketio-status')).toHaveText(/connected/i, {
      timeout: 15_000,
    });

    await page.getByRole('button', { name: /^Emit$/ }).click();

    await expect
      .poll(
        () =>
          servers.socketio
            .receivedEvents()
            .some((e) => e.eventName === 'message' && e.namespace === '/'),
        { timeout: 10_000 }
      )
      .toBe(true);
    await expect(page.getByText('message:echo').first()).toBeVisible({ timeout: 10_000 });

    await page
      .getByRole('button', { name: /Disconnect/i })
      .first()
      .click()
      .catch(() => {});
  });
});
