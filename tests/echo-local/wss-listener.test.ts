import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { getSelfSignedCert } from '../../e2e/mocks/cert';
import { type MockWsServerHandle, startMockWsServer } from '../../e2e/mocks/wsServer';

// Proves the wss:// listener echo-local adds actually serves WebSocket over TLS.
// The packaged desktop CSP allows wss: but not ws:, so this is the only WS the
// packaged app can dial — it has to work.

let handle: MockWsServerHandle | undefined;

afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

describe('startMockWsServer over TLS (wss://)', () => {
  it('echoes a message back over a TLS WebSocket handshake', async () => {
    const { key, cert } = getSelfSignedCert();
    handle = await startMockWsServer({ port: 0, tls: { key, cert } });
    expect(handle.url.startsWith('wss://')).toBe(true);

    const echoed = await new Promise<string>((resolve, reject) => {
      // Validate against the self-signed leaf as its own CA — the cert's SAN
      // covers IP:127.0.0.1, so the handshake verifies without disabling checks.
      const ws = new WebSocket(`${handle!.url}/echo`, { ca: cert });
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('timed out waiting for echo'));
      }, 5000);
      ws.on('open', () => ws.send('hi'));
      ws.on('message', (data: Buffer) => {
        clearTimeout(timer);
        ws.close();
        resolve(data.toString('utf8'));
      });
      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    expect(echoed).toBe('echo:hi');
  });
});
