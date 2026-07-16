import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

const lookup = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({ lookup }));

import { createPinnedMcpFetchSession, resolvePinnedMcpAddress } from '../pinnedMcpFetch.js';

describe('pinned MCP fetch', () => {
  afterEach(() => {
    lookup.mockReset();
  });

  it('rejects a DNS rebinding result before opening a connection', async () => {
    lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);

    await expect(resolvePinnedMcpAddress('https://rebind.example.test/mcp', false)).rejects.toThrow(
      /loopback|private/i
    );
  });

  it('refuses redirects instead of following a potentially unsafe destination', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' });
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('test server did not expose a port');

    try {
      await expect(
        createPinnedMcpFetchSession(true).fetch(`http://127.0.0.1:${address.port}/mcp`)
      ).rejects.toThrow('redirects are not permitted');
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it('keeps the dispatcher alive until a streaming response body is consumed', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: first\n\n');
      setTimeout(() => response.end('data: final\n\n'), 40);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('test server did not expose a port');
    const session = createPinnedMcpFetchSession(true);

    try {
      const response = await Promise.race([
        session.fetch(`http://127.0.0.1:${address.port}/mcp`),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('headers timed out')), 1_000)
        ),
      ]);
      await expect(response.text()).resolves.toContain('data: final');
    } finally {
      await session.dispose();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it('uses the same pinned session for shared HTTP executor fetches', async () => {
    const server = createServer((_request, response) => response.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('test server did not expose a port');
    const session = createPinnedMcpFetchSession(true);

    try {
      const response = await session.fetcher({
        url: `http://127.0.0.1:${address.port}/saved-request`,
        method: 'GET',
        headers: {},
      });
      await expect(response.text()).resolves.toBe('ok');
    } finally {
      await session.dispose();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it('refuses a fetch whose DNS resolution finishes after session disposal', async () => {
    let resolveLookup!: (value: Array<{ address: string; family: number }>) => void;
    lookup.mockImplementation(
      () =>
        new Promise<Array<{ address: string; family: number }>>(
          (resolve) => (resolveLookup = resolve)
        )
    );
    const session = createPinnedMcpFetchSession(false);
    const pending = session.fetch('https://public.example.test/mcp');

    await session.dispose();
    resolveLookup([{ address: '93.184.216.34', family: 4 }]);
    await expect(pending).rejects.toThrow(/disposed/i);
  });

  it('rejects proxy configuration rather than silently bypassing it', () => {
    const previous = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = 'http://proxy.example.test:8080';
    try {
      expect(() => createPinnedMcpFetchSession(false)).toThrow(/cannot run with HTTPS_PROXY/i);
    } finally {
      if (previous === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = previous;
    }
  });
});
