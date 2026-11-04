import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AuthConfig, SseRequest } from '@shared/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { executeSse } from '../sse';

let server: Server;
let baseUrl: string;
let hits = 0;

beforeAll(async () => {
  server = createServer((_req, res) => {
    hits++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: unnamed\n\nevent: tick\ndata: named\n\nevent: other\ndata: skip\n\ndata: tail');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  hits = 0;
});

async function run(overrides: Partial<SseRequest>) {
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

describe('executeSse — sign-at-wire auth', () => {
  it.each([
    ['aws-signature', { type: 'aws-signature', awsSignature: { accessKey: 'a' } }],
    ['oauth1', { type: 'oauth1', oauth1: { consumerKey: 'k' } }],
    ['wsse', { type: 'wsse', wsse: { username: 'u', password: 'p' } }],
    ['digest', { type: 'digest', digest: { username: 'u', password: 'p' } }],
    ['ntlm', { type: 'ntlm', ntlm: { username: 'u', password: 'p' } }],
  ])('fails a %s request instead of streaming it unauthenticated', async (_t, auth) => {
    const outcome = await run({ auth: auth as AuthConfig });
    expect(outcome.passed).toBe(false);
    expect(outcome.errorMessage).toMatch(/can't be applied to SSE/);
    expect(hits).toBe(0);
  });
});

describe('executeSse — event filter', () => {
  it('treats an unnamed event as "message", like the app', async () => {
    const filtered = await run({ eventFilter: ['tick'] } as Partial<SseRequest>);
    expect(filtered.streamEvents?.map((e) => e.data)).toEqual(['named']);

    const withMessage = await run({ eventFilter: ['message'] } as Partial<SseRequest>);
    // The trailing `data: tail` has no terminating blank line, so it is never
    // dispatched (WHATWG; the app's SseStreamReader drops it too).
    expect(withMessage.streamEvents?.map((e) => [e.event, e.data])).toEqual([
      ['message', 'unnamed'],
    ]);
  });
});
