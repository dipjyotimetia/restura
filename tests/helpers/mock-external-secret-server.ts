import { createServer, type Server } from 'node:http';

export interface MockExternalSecretServer {
  url: string;
  rotate(value: string): void;
  deny(): void;
  delay(ms: number): void;
  close(): Promise<void>;
}

/**
 * Deterministic provider-shaped test server. It deliberately returns only a
 * JSON `{ value }` envelope so tests can model rotation, denial, latency, and
 * cancellation without provider credentials or internet access.
 */
export async function startMockExternalSecretServer(): Promise<MockExternalSecretServer> {
  let value = 'initial-secret';
  let deny = false;
  let delayMs = 0;
  const server: Server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/v1/secret') {
      response.writeHead(404).end();
      return;
    }
    const respond = () => {
      if (deny) {
        response.writeHead(403, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: `denied: ${value}` }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ value }));
    };
    if (delayMs > 0) setTimeout(respond, delayMs);
    else respond();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock provider did not bind TCP');

  return {
    url: `http://127.0.0.1:${address.port}`,
    rotate(next) {
      value = next;
    },
    deny() {
      deny = true;
    },
    delay(ms) {
      delayMs = ms;
    },
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
