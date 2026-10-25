import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AuthConfig, SseRequest } from '@shared/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { executeSse } from '../sse';

let server: Server;
let baseUrl: string;
const received: Array<{ url: string; headers: IncomingHttpHeaders }> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    received.push({ url: req.url ?? '', headers: req.headers });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: hi\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  received.length = 0;
});

async function run(auth: AuthConfig, vars: Record<string, string>) {
  const request = {
    id: 's',
    name: 's',
    type: 'sse',
    url: `${baseUrl}/events`,
    headers: [],
    params: [],
    auth,
  } as unknown as SseRequest;
  return executeSse(
    { relativePath: 's', folderPath: [], type: 'sse', request },
    { vars, timeoutMs: 2000, allowLocalhost: true, sseDurationMs: 1000, sseMaxEvents: 1 }
  );
}

describe('executeSse — auth {{vars}}', () => {
  it('resolves a bearer token template', async () => {
    await run({ type: 'bearer', bearer: { token: '{{tok}}' } }, { tok: 'x' });
    expect(received[0]?.headers.authorization).toBe('Bearer x');
  });

  it('resolves basic credentials and an api-key query value', async () => {
    await run(
      { type: 'basic', basic: { username: '{{u}}', password: '{{p}}' } },
      { u: 'alice', p: 'pw' }
    );
    expect(received[0]?.headers.authorization).toBe(
      `Basic ${Buffer.from('alice:pw').toString('base64')}`
    );
    await run(
      { type: 'api-key', apiKey: { key: 'k', value: '{{tok}}', in: 'query' } },
      { tok: 'x' }
    );
    expect(received[1]?.url).toContain('k=x');
  });
});
