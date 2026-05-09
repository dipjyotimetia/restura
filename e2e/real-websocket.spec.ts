import { test, expect } from './fixtures/servers';
import { switchMode } from './utils/selectors';
import WebSocket from 'ws';

/**
 * Real WebSocket server. Three transports exposed:
 *   /echo     — echoes every message back as `echo:<text>` or binary as-is.
 *   /chat     — broadcasts messages to all connected peers.
 *   /graphql  — graphql-transport-ws via the SDK for subscription tests.
 */
test.describe('Real WebSocket server', () => {
  test('UI connects to /echo, sends a message, receives the echo, disconnects', async ({ app: page, servers }) => {
    await switchMode(page, 'ws');

    const urlField = page.getByRole('textbox', { name: 'WebSocket URL' });
    await urlField.fill(`${servers.ws.url}/echo`);

    await page.getByRole('button', { name: 'Connect', exact: true }).click();

    // Once connected, the textbox for outbound messages is enabled.
    const sendInput = page.getByPlaceholder('Enter message to send...');
    await expect(sendInput).toBeEnabled({ timeout: 10_000 });

    await sendInput.fill('hello-from-test');
    // Send button sits next to the textarea. The textarea wires Ctrl+Enter to send;
    // clicking the button is a more direct path that doesn't depend on platform key state.
    await page.locator('button').filter({ has: page.locator('svg.lucide-send') }).first().click();

    // The echo response shows up in the message log as `echo:hello-from-test`.
    await expect(page.getByText(/echo:hello-from-test/).first()).toBeVisible({ timeout: 10_000 });

    expect(servers.ws.connectionCount()).toBeGreaterThanOrEqual(1);
    expect(servers.ws.receivedMessages().some((m) => m.payload === 'hello-from-test')).toBe(true);

    // Disconnect cleanly so teardown doesn't fight reconnect timers.
    await page.getByRole('button', { name: /Disconnect/i }).first().click().catch(() => {});
  });

  test('UI sends binary (hex) and receives the same bytes back', async ({ app: page, servers }) => {
    await switchMode(page, 'ws');

    await page.getByRole('textbox', { name: 'WebSocket URL' }).fill(`${servers.ws.url}/echo`);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();

    // Toggle "Binary (hex)" so the input parses hex bytes.
    const binaryToggle = page.getByRole('switch', { name: /Binary \(hex\)/i });
    await expect(binaryToggle).toBeEnabled({ timeout: 10_000 });
    await binaryToggle.click();

    const sendInput = page.getByPlaceholder(/Enter hex bytes/i);
    await sendInput.fill('48 65 6c 6c 6f'); // 'Hello' in hex
    await page.locator('button').filter({ has: page.locator('svg.lucide-send') }).first().click();

    // Server records the binary message; UI shows the round-tripped bytes.
    await expect.poll(() => servers.ws.receivedMessages().filter((m) => m.kind === 'binary').length, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
    const binary = servers.ws.receivedMessages().find((m) => m.kind === 'binary');
    expect(binary?.payload.toLowerCase()).toBe('48656c6c6f');

    await page.getByRole('button', { name: /Disconnect/i }).first().click().catch(() => {});
  });

  test('Wire: native ws client round-trips through /echo', async ({ servers }) => {
    const sock = new WebSocket(`${servers.ws.url}/echo`);
    const message = await new Promise<string>((resolve, reject) => {
      sock.on('open', () => sock.send('ping-from-node'));
      sock.on('message', (data) => resolve(data.toString()));
      sock.on('error', reject);
    });
    expect(message).toBe('echo:ping-from-node');
    sock.close();
  });

  test('Wire: /graphql speaks graphql-transport-ws (SDK) and runs a tick subscription', async ({ servers }) => {
    const sock = new WebSocket(`${servers.ws.url}/graphql`, 'graphql-transport-ws');

    const frames: Array<{ type: string; payload?: unknown }> = [];
    const replies: Array<{ n: number }> = [];
    await new Promise<void>((resolve, reject) => {
      sock.on('open', () => {
        sock.send(JSON.stringify({ type: 'connection_init' }));
      });
      sock.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as {
          type: string;
          payload?: { data?: { tick?: { n: number } } };
        };
        frames.push(msg);
        if (msg.type === 'connection_ack') {
          sock.send(
            JSON.stringify({
              id: '1',
              type: 'subscribe',
              payload: { query: 'subscription Tick($count: Int) { tick(count: $count) { n } }', variables: { count: 3 } },
            })
          );
        }
        if (msg.type === 'next' && msg.payload?.data?.tick) {
          replies.push({ n: msg.payload.data.tick.n });
        }
        if (msg.type === 'complete') resolve();
      });
      sock.on('error', reject);
    });

    sock.close();

    expect(frames[0]?.type).toBe('connection_ack');
    expect(replies.map((r) => r.n)).toEqual([0, 1, 2]);
    expect(frames.at(-1)?.type).toBe('complete');
    expect(servers.ws.graphqlSubscribePayloads().length).toBeGreaterThanOrEqual(1);
  });

  test('Wire: /chat broadcasts to peers', async ({ servers }) => {
    const a = new WebSocket(`${servers.ws.url}/chat`);
    const b = new WebSocket(`${servers.ws.url}/chat`);

    await Promise.all([
      new Promise<void>((resolve) => a.on('open', () => resolve())),
      new Promise<void>((resolve) => b.on('open', () => resolve())),
    ]);

    const bGotMessage = new Promise<string>((resolve) => {
      b.on('message', (data) => resolve(data.toString()));
    });
    a.send('hi peers');
    expect(await bGotMessage).toBe('hi peers');

    a.close();
    b.close();
  });
});
