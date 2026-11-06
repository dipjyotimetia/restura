import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { SseRequest } from '@shared/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { executeSse } from '../sse';

/**
 * The CLI SSE executor goes through the shared `executeHttpProxyStreaming`
 * pipeline (B12), like the desktop SSE handler: the shared request-header
 * policy applies and redirects are followed by the shared follower.
 */

let server: Server;
let baseUrl: string;
const seen: Array<{ url: string; headers: IncomingHttpHeaders }> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ url: req.url ?? '', headers: req.headers });
    if (req.url === '/moved') {
      res.writeHead(302, { location: '/events' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: one\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  seen.length = 0;
});

function run(overrides: Partial<SseRequest>) {
  const request = {
    id: 's',
    name: 's',
    type: 'sse',
    url: `${baseUrl}/events`,
    headers: [],
    params: [],
    auth: { type: 'none' },
    ...overrides,
  } as unknown as SseRequest;
  return executeSse(
    { relativePath: 's', folderPath: [], type: 'sse', request },
    { vars: {}, timeoutMs: 2000, allowLocalhost: true, sseDurationMs: 1000 }
  );
}

describe('executeSse — shared streaming pipeline', () => {
  it('drops request headers the shared header policy forbids', async () => {
    const outcome = await run({
      headers: [
        { id: 'a', key: 'Proxy-Authorization', value: 'Basic LEAK', enabled: true },
        { id: 'b', key: 'X-Kept', value: 'yes', enabled: true },
      ],
    });
    expect(outcome.passed).toBe(true);
    expect(seen[0]?.headers['proxy-authorization']).toBeUndefined();
    expect(seen[0]?.headers['x-kept']).toBe('yes');
    expect(seen[0]?.headers.accept).toBe('text/event-stream');
  });

  it('follows a redirect to the event stream, as the desktop handler does', async () => {
    const outcome = await run({ url: `${baseUrl}/moved` });
    expect(seen.map((s) => s.url)).toEqual(['/moved', '/events']);
    expect(outcome.status).toBe(200);
    expect(outcome.passed).toBe(true);
    expect(outcome.streamEvents?.map((e) => e.data)).toEqual(['one']);
  });
});
