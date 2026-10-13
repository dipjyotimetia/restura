// @vitest-environment node
// Per-request HTTP version control (#864) through the REAL Electron undici
// fetcher against real node:http2 upstreams — ALPN negotiation and h2c prior
// knowledge are wire behaviours, so nothing here is mocked below the fetcher.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  session: { defaultSession: { resolveProxy: vi.fn() } },
}));

import { executeHttpProxy } from '@shared/protocol/http-proxy';
import type { HttpVersionPreference } from '@shared/types';
import { type MockHttp2ServerHandle, startMockHttp2Server } from '../../../e2e/mocks/http2Server';
import { type MockHttpServerHandle, startMockHttpsServer } from '../../../e2e/mocks/httpServer';
import { type MockProxyServerHandle, startMockProxyServer } from '../../../e2e/mocks/proxyServer';
import {
  type MockSocksProxyHandle,
  startMockSocksProxyServer,
} from '../../../e2e/mocks/socksProxyServer';
import {
  buildElectronFetcher,
  type ElectronProxyConfig,
  type HttpRequestConfig,
} from '../handlers/http-handler';

let h2Tls: MockHttp2ServerHandle;
let h2c: MockHttp2ServerHandle;
let h1Tls: MockHttpServerHandle;
let httpProxy: MockProxyServerHandle;
let socks: MockSocksProxyHandle;

beforeAll(async () => {
  [h2Tls, h2c, h1Tls, httpProxy, socks] = await Promise.all([
    startMockHttp2Server({ secure: true }),
    startMockHttp2Server(),
    startMockHttpsServer(),
    startMockProxyServer(),
    startMockSocksProxyServer(),
  ]);
});
afterAll(async () => {
  await Promise.all([h2Tls.close(), h2c.close(), h1Tls.close(), httpProxy.close(), socks.close()]);
});

async function send(url: string, httpVersion?: HttpVersionPreference, proxy?: ElectronProxyConfig) {
  const config = {
    method: 'GET',
    url,
    verifySsl: false,
    ...(httpVersion ? { httpVersion } : {}),
    ...(proxy ? { proxy } : {}),
  } as HttpRequestConfig;
  const fetcher = buildElectronFetcher(config);
  return executeHttpProxy({ method: 'GET', url }, fetcher, { allowLocalhost: true });
}

function echoed(body: string): { httpVersion: string; alpnProtocol: string | null } {
  return JSON.parse(body) as { httpVersion: string; alpnProtocol: string | null };
}

describe('Electron fetcher — httpVersion', () => {
  it('auto negotiates h2 via ALPN against an h2-capable TLS server', async () => {
    const result = await send(`${h2Tls.url}/v`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.response.negotiatedAlpn).toBe('h2');
    expect(echoed(result.response.body).httpVersion).toBe('2.0');
  });

  it('http1.1 forces ALPN http/1.1 against an h2-capable TLS server', async () => {
    const result = await send(`${h2Tls.url}/v`, 'http1.1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.response.negotiatedAlpn).toBe('h1.1');
    expect(echoed(result.response.body)).toMatchObject({
      httpVersion: '1.1',
      alpnProtocol: 'http/1.1',
    });
  });

  it('http2 negotiates h2 against an h2-capable TLS server', async () => {
    const result = await send(`${h2Tls.url}/v`, 'http2');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.response.negotiatedAlpn).toBe('h2');
    expect(echoed(result.response.body).httpVersion).toBe('2.0');
  });

  it('http2 fails clearly when the TLS server cannot speak h2', async () => {
    const result = await send(`${h1Tls.url}/json`, 'http2');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.payload.error).toMatch(/HTTP\/2/);
  });

  it('h2c-prior-knowledge speaks cleartext HTTP/2 to an h2c server', async () => {
    const result = await send(`${h2c.url}/v`, 'h2c-prior-knowledge');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.response.status).toBe(200);
    expect(result.response.negotiatedAlpn).toBe('h2');
    expect(echoed(result.response.body).httpVersion).toBe('2.0');
  });

  it('http2 on a cleartext URL uses prior knowledge (no h2c Upgrade exists in undici)', async () => {
    const result = await send(`${h2c.url}/v`, 'http2');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(echoed(result.response.body).httpVersion).toBe('2.0');
  });

  describe('through proxies', () => {
    const viaHttp = (): ElectronProxyConfig => ({
      enabled: true,
      type: 'http',
      host: '127.0.0.1',
      port: httpProxy.port,
    });
    const viaSocks = (): ElectronProxyConfig => ({
      enabled: true,
      type: 'socks5',
      host: '127.0.0.1',
      port: socks.port,
    });

    it('http1.1 is honoured through an HTTP CONNECT proxy', async () => {
      const result = await send(`${h2Tls.url}/v`, 'http1.1', viaHttp());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(echoed(result.response.body).httpVersion).toBe('1.1');
    });

    it('http2 is accepted through an HTTP CONNECT proxy when the upstream negotiates h2', async () => {
      // The ALPN snapshot for ProxyAgent paths comes from undici's diagnostics
      // channel, whose connectParams.port is the URL's *string* port ('' for
      // the scheme default) — it must still match the upstream we dialled.
      const result = await send(`${h2Tls.url}/v`, 'http2', viaHttp());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.response.negotiatedAlpn).toBe('h2');
      expect(echoed(result.response.body).httpVersion).toBe('2.0');
    });

    it('h2c prior knowledge is rejected through an HTTP proxy instead of downgrading', async () => {
      const result = await send(`${h2c.url}/v`, 'h2c-prior-knowledge', viaHttp());
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.payload.error).toMatch(/h2c/);
    });

    it('http1.1 is honoured through a SOCKS5 proxy', async () => {
      const result = await send(`${h2Tls.url}/v`, 'http1.1', viaSocks());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.response.negotiatedAlpn).toBe('h1.1');
      expect(echoed(result.response.body).httpVersion).toBe('1.1');
    });

    it('h2c prior knowledge works through a SOCKS5 proxy', async () => {
      const result = await send(`${h2c.url}/v`, 'h2c-prior-knowledge', viaSocks());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.response.negotiatedAlpn).toBe('h2');
      expect(echoed(result.response.body).httpVersion).toBe('2.0');
    });
  });
});
