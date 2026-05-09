import { test, expect } from './fixtures/servers';
import WebSocket from 'ws';

/**
 * Advanced WebSocket scenarios: subprotocol negotiation, ping/pong frames,
 * and explicit close codes. These tend to expose framing bugs and reconnect
 * logic regressions.
 */
test.describe('WebSocket — subprotocol negotiation', () => {
  test('client offers a known protocol; server picks the first match', async ({ servers }) => {
    const sock = new WebSocket(`${servers.ws.url}/echo`, ['restura.echo.v1', 'restura.unknown']);
    await new Promise<void>((resolve, reject) => {
      sock.on('open', () => resolve());
      sock.on('error', reject);
    });
    expect(sock.protocol).toBe('restura.echo.v1');
    sock.close();
  });

  test('client offers only unknown protocols; server rejects upgrade', async ({ servers }) => {
    const error = await new Promise<unknown>((resolve) => {
      const sock = new WebSocket(`${servers.ws.url}/echo`, ['nope.v0']);
      sock.on('open', () => {
        sock.close();
        resolve(null);
      });
      sock.on('error', resolve);
    });
    expect(error).not.toBeNull();
  });
});

test.describe('WebSocket — ping/pong', () => {
  test('client triggers server ping, then reports the pong reply', async ({ servers }) => {
    const sock = new WebSocket(`${servers.ws.url}/ping`);
    const message = await new Promise<string>((resolve, reject) => {
      let report = '';
      sock.on('open', () => sock.send('PING_ME'));
      sock.on('message', (data) => {
        report = data.toString();
        resolve(report);
      });
      sock.on('error', reject);
      setTimeout(() => sock.send('REPORT'), 50);
    });
    sock.close();

    const json = JSON.parse(message) as { pongs: string[] };
    expect(json.pongs).toContain('mock-ping');
  });
});

test.describe('WebSocket — explicit close codes', () => {
  for (const [code, reason] of [
    ['1000', 'normal'],
    ['1011', 'server-error'],
    ['4001', 'app-specific'],
  ] as const) {
    test(`/close?code=${code} closes with code ${code} and reason "${reason}"`, async ({ servers }) => {
      const sock = new WebSocket(`${servers.ws.url}/close?code=${code}&reason=${encodeURIComponent(reason)}`);
      const closeFrame = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
        sock.on('close', (cc, rr) => resolve({ code: cc, reason: rr.toString('utf8') }));
        sock.on('error', reject);
      });
      expect(closeFrame.code).toBe(Number(code));
      expect(closeFrame.reason).toBe(reason);
    });
  }
});
