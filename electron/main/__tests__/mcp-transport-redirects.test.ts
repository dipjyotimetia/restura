// @vitest-environment node
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPinnedFetch, rejectTransportRedirects } from '../security/safe-connect';

function listen(handler: http.RequestListener): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}
const port = (server: http.Server) => (server.address() as AddressInfo).port;

describe('MCP transport redirects', () => {
  let target: http.Server;
  let redirector: http.Server;
  let hits = 0;

  beforeAll(async () => {
    target = await listen((_req, res) => {
      hits += 1;
      res.end('internal');
    });
    redirector = await listen((req, res) => {
      if (req.url === '/ok') {
        res.setHeader('content-type', 'application/json');
        res.end('{}');
        return;
      }
      res.writeHead(307, { location: `http://127.0.0.1:${port(target)}/secret` });
      res.end();
    });
  });
  afterAll(() => {
    target.close();
    redirector.close();
  });

  const pinned = () => rejectTransportRedirects(createPinnedFetch('mcp.example.test', '127.0.0.1'));

  it('refuses a redirect to an IP literal without dialling it', async () => {
    const url = `http://mcp.example.test:${port(redirector)}/mcp`;
    await expect(pinned()(url, { method: 'POST', body: '{}' })).rejects.toThrow(
      'MCP transport redirects are not permitted'
    );
    expect(hits).toBe(0);
  });

  it('refuses even when a caller asks to follow', async () => {
    const url = `http://mcp.example.test:${port(redirector)}/mcp`;
    await expect(pinned()(url, { redirect: 'follow' })).rejects.toThrow(/not permitted/);
    expect(hits).toBe(0);
  });

  it('passes an ordinary response through', async () => {
    const res = await pinned()(`http://mcp.example.test:${port(redirector)}/ok`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{}');
  });
});
