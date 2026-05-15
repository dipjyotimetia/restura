import { test, expect } from './fixtures/servers';
import { switchMode } from './utils/selectors';
import { io as ioClient } from 'socket.io-client';

/**
 * Real Socket.IO server with three namespaces:
 *   /        — echoes each event back as `<event>:echo` with the same args
 *               (and replies via ack callback if the client passes one).
 *   /chat    — broadcasts events to peers in the namespace.
 *   /admin   — rejects connections without `auth.token === 'admin-token'`.
 *
 * The browser path uses the bundled `socket.io-client` directly. Custom
 * `extraHeaders` are ignored on the WebSocket transport in browsers, so the
 * header-related checks rely on auth/query (which DO flow through).
 */
test.describe('Real Socket.IO server', () => {
  test('UI connects to default namespace, emits, sees the echoed event', async ({ app: page, servers }) => {
    await switchMode(page, 'socketio');

    const urlField = page.getByRole('textbox', { name: 'Socket.IO server URL' });
    await urlField.fill(servers.socketio.url);

    // Default namespace ("/") is already set. Connect.
    await page.getByRole('button', { name: 'Connect', exact: true }).click();

    // Once connected the status line flips to "connected".
    await expect(page.getByTestId('socketio-status')).toHaveText(/connected/i, { timeout: 15_000 });

    // Emit a `message` event with the default args `"hello"`.
    await page.getByRole('button', { name: /^Emit$/ }).click();

    // The echo arrives as `message:echo`.
    await expect.poll(
      () => servers.socketio.receivedEvents().some((e) => e.eventName === 'message' && e.namespace === '/'),
      { timeout: 10_000 }
    ).toBe(true);

    // The received row appears in the UI.
    await expect(page.getByText('message:echo').first()).toBeVisible({ timeout: 10_000 });

    expect(servers.socketio.connectionCount()).toBeGreaterThanOrEqual(1);

    await page.getByRole('button', { name: /Disconnect/i }).first().click().catch(() => {});
  });

  test('Wire: socket.io-client round-trips through default namespace', async ({ servers }) => {
    const socket = ioClient(servers.socketio.url, { transports: ['websocket'], reconnection: false });
    try {
      const echoed = await new Promise<string>((resolve, reject) => {
        socket.on('greet:echo', (msg: string) => resolve(msg));
        socket.on('connect_error', reject);
        socket.on('connect', () => socket.emit('greet', 'hi-from-test'));
      });
      expect(echoed).toBe('hi-from-test');
      expect(
        servers.socketio.receivedEvents().some(
          (e) => e.namespace === '/' && e.eventName === 'greet' && e.args[0] === 'hi-from-test'
        )
      ).toBe(true);
    } finally {
      socket.disconnect();
    }
  });

  test('Wire: ack callback round-trips through the default namespace', async ({ servers }) => {
    const socket = ioClient(servers.socketio.url, { transports: ['websocket'], reconnection: false });
    try {
      const ack = await new Promise<unknown>((resolve, reject) => {
        socket.on('connect_error', reject);
        socket.on('connect', () => {
          socket.emit('rpc', { method: 'add', params: [1, 2] }, (reply: unknown) => resolve(reply));
        });
      });
      expect(ack).toEqual({ ack: true, original: { method: 'add', params: [1, 2] } });
    } finally {
      socket.disconnect();
    }
  });

  test('Wire: /chat namespace broadcasts events to peers', async ({ servers }) => {
    const peerA = ioClient(`${servers.socketio.url}/chat`, { transports: ['websocket'], reconnection: false });
    const peerB = ioClient(`${servers.socketio.url}/chat`, { transports: ['websocket'], reconnection: false });
    try {
      await Promise.all([
        new Promise<void>((res, rej) => { peerA.on('connect', () => res()); peerA.on('connect_error', rej); }),
        new Promise<void>((res, rej) => { peerB.on('connect', () => res()); peerB.on('connect_error', rej); }),
      ]);

      const seenByB = new Promise<string>((resolve) => peerB.once('chat', (msg: string) => resolve(msg)));
      peerA.emit('chat', 'hello-peers');

      await expect(seenByB).resolves.toBe('hello-peers');
      expect(
        servers.socketio.receivedEvents().some(
          (e) => e.namespace === '/chat' && e.eventName === 'chat' && e.args[0] === 'hello-peers'
        )
      ).toBe(true);
    } finally {
      peerA.disconnect();
      peerB.disconnect();
    }
  });

  test('Wire: /admin namespace rejects connections without the right auth token', async ({ servers }) => {
    const bad = ioClient(`${servers.socketio.url}/admin`, {
      transports: ['websocket'],
      reconnection: false,
      auth: { token: 'wrong-token' },
    });
    try {
      const err = await new Promise<Error>((resolve) => {
        bad.on('connect_error', (e: Error) => resolve(e));
        bad.on('connect', () => resolve(new Error('unexpectedly connected')));
      });
      expect(err.message).toMatch(/forbidden/i);
    } finally {
      bad.disconnect();
    }

    // Now connect with the correct token and verify the admin namespace responds.
    const good = ioClient(`${servers.socketio.url}/admin`, {
      transports: ['websocket'],
      reconnection: false,
      auth: { token: 'admin-token' },
    });
    try {
      const reply = await new Promise<string>((resolve, reject) => {
        good.on('connect_error', reject);
        good.on('connect', () => good.emit('ping', 'hello-admin'));
        good.on('ping:admin-ack', (msg: string) => resolve(msg));
      });
      expect(reply).toBe('hello-admin');
      expect(servers.socketio.lastAuth()).toEqual({ token: 'admin-token' });
    } finally {
      good.disconnect();
    }
  });

  test('UI: auth payload from the Auth tab reaches the server handshake', async ({ app: page, servers }) => {
    await switchMode(page, 'socketio');

    await page.getByRole('textbox', { name: 'Socket.IO server URL' }).fill(servers.socketio.url);

    // Open Configuration → Auth and add a key/value.
    await page.getByRole('tab', { name: 'Configuration' }).click();
    await page.getByRole('tab', { name: 'Auth' }).click();
    await page.getByRole('button', { name: /Add auth param|Add/i }).first().click();

    // KeyValueEditor renders two inputs (key and value) per row. Fill the latest pair.
    const keyInputs = page.getByRole('textbox', { name: /auth param key/i });
    const valueInputs = page.getByRole('textbox', { name: /auth param value/i });
    await keyInputs.last().fill('userId');
    await valueInputs.last().fill('e2e-user');

    // Connect and emit a probe event.
    await page.getByRole('tab', { name: 'Events' }).click();
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.getByTestId('socketio-status')).toHaveText(/connected/i, { timeout: 15_000 });

    await page.getByRole('button', { name: /^Emit$/ }).click();

    await expect.poll(
      () => {
        const auth = servers.socketio.lastAuth();
        return auth?.['userId'];
      },
      { timeout: 10_000 }
    ).toBe('e2e-user');

    await page.getByRole('button', { name: /Disconnect/i }).first().click().catch(() => {});
  });
});
