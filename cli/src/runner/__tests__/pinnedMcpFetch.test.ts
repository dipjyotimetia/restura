import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

const lookup = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({ lookup }));

import { createPinnedMcpFetch, resolvePinnedMcpAddress } from '../pinnedMcpFetch.js';

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
        createPinnedMcpFetch(true)(`http://127.0.0.1:${address.port}/mcp`)
      ).rejects.toThrow('redirects are not permitted');
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });
});
