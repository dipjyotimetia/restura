import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  electron: false,
  api: undefined as unknown,
  post: vi.fn(),
}));

vi.mock('../platform', () => ({
  isElectron: () => state.electron,
  getElectronAPI: () => state.api,
  workerAuthHeaders: () => ({ 'X-Auth': 't' }),
  workerBaseUrl: () => 'https://worker.test',
}));
vi.mock('axios', () => ({ default: { post: state.post } }));

import {
  executeProxiedRequest,
  executeProxiedStreamingRequest,
  ProxyTransportError,
  restoreUpstreamStatus,
} from '../transport';

const spec = { method: 'GET', url: 'https://example.com/' } as const;

beforeEach(() => {
  state.electron = false;
  state.api = undefined;
  state.post.mockReset();
  vi.unstubAllGlobals();
});

describe('executeProxiedRequest (web)', () => {
  it('posts to the Worker proxy with auth headers and the signal', async () => {
    state.post.mockResolvedValue({
      data: { status: 200, statusText: 'OK', headers: {}, data: 'x' },
    });
    const ctrl = new AbortController();
    const out = await executeProxiedRequest(spec, { signal: ctrl.signal });
    expect(out.status).toBe(200);
    const [url, body, cfg] = state.post.mock.calls[0] as [string, unknown, Record<string, unknown>];
    expect(url).toBe('https://worker.test/api/proxy');
    expect(body).toEqual(spec);
    expect(cfg.signal).toBe(ctrl.signal);
    expect(cfg.headers).toMatchObject({ 'X-Auth': 't' });
  });

  it('omits the signal when none is given', async () => {
    state.post.mockResolvedValue({ data: {} });
    await executeProxiedRequest(spec);
    expect(state.post.mock.calls[0]?.[2]).not.toHaveProperty('signal');
  });

  it('maps a Worker error payload to a ProxyTransportError with status', async () => {
    state.post.mockRejectedValue({
      response: { status: 403, data: { error: 'blocked' } },
      message: 'm',
    });
    await expect(executeProxiedRequest(spec)).rejects.toMatchObject({
      name: 'ProxyTransportError',
      message: 'blocked',
      status: 403,
    });
  });

  it('falls back to the axios message, then a default, for payloads without an error', async () => {
    state.post.mockRejectedValueOnce({ response: { status: 500, data: 'plain' }, message: 'boom' });
    await expect(executeProxiedRequest(spec)).rejects.toMatchObject({
      message: 'boom',
      status: 500,
    });
    state.post.mockRejectedValueOnce({ response: { status: 500, data: null }, message: '' });
    await expect(executeProxiedRequest(spec)).rejects.toMatchObject({
      message: 'Proxy request failed',
    });
  });

  it('maps network errors with and without a message', async () => {
    state.post.mockRejectedValueOnce(new Error('offline'));
    await expect(executeProxiedRequest(spec)).rejects.toMatchObject({ message: 'offline' });
    state.post.mockRejectedValueOnce('weird');
    const err = await executeProxiedRequest(spec).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProxyTransportError);
    expect((err as ProxyTransportError).message).toBe('Proxy request failed');
    expect((err as ProxyTransportError).status).toBeUndefined();
  });
});

describe('executeProxiedRequest (Electron IPC)', () => {
  function install(result: Record<string, unknown> = {}) {
    const request = vi.fn(async () => ({
      status: 200,
      statusText: 'OK',
      headers: {},
      data: 'body',
      ...result,
    }));
    const cancel = vi.fn(async () => undefined);
    state.electron = true;
    state.api = { http: { request, cancel } };
    return { request, cancel };
  }

  it('throws when the http bridge is missing', async () => {
    state.electron = true;
    state.api = {};
    await expect(executeProxiedRequest(spec)).rejects.toThrow(/not available/);
  });

  it('maps every optional spec and desktop field into the flat IPC config', async () => {
    const { request } = install({
      setCookies: ['a=b'],
      size: 4,
      bodyEncoding: 'base64',
      negotiatedAlpn: 'h2',
      bodyNotice: 'n',
      timings: { total: 1 },
    });
    const out = await executeProxiedRequest(
      {
        ...spec,
        headers: { A: 'b' },
        params: { q: '1' },
        data: 'd',
        bodyType: 'raw',
        formData: [],
        timeout: 5,
        auth: { type: 'none' },
        redirectPolicy: {
          maxRedirects: 2,
          followOriginalMethod: true,
          followAuthHeader: false,
          stripReferer: true,
          stripOnOriginChange: ['X-Unusual'],
        },
        encodeUrl: false,
      } as never,
      {},
      {
        proxy: {
          enabled: true,
          type: 'http',
          host: 'h',
          port: 1,
          auth: { username: 'u', password: 'p' },
        },
        verifySsl: false,
        clientCert: { cert: 'c' } as never,
        caCert: { cert: 'ca' } as never,
        serverCipherOrder: true,
        minTlsVersion: 'TLSv1.2',
        cipherSuites: 'X',
        httpVersion: 'http2',
        secretVariables: { a: 'b' },
      }
    );
    const cfg = (request.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(cfg).toMatchObject({
      headers: { A: 'b' },
      params: { q: '1' },
      data: 'd',
      bodyType: 'raw',
      formData: [],
      timeout: 5,
      auth: { type: 'none' },
      maxRedirects: 2,
      followOriginalMethod: true,
      followAuthHeader: false,
      stripReferer: true,
      stripOnOriginChange: ['X-Unusual'],
      encodeUrlAutomatically: false,
      proxy: {
        enabled: true,
        type: 'http',
        host: 'h',
        port: 1,
        auth: { username: 'u', password: 'p' },
      },
      verifySsl: false,
      serverCipherOrder: true,
      minTlsVersion: 'TLSv1.2',
      cipherSuites: 'X',
      httpVersion: 'http2',
      secretVariables: { a: 'b' },
    });
    expect(out).toMatchObject({
      setCookies: ['a=b'],
      size: 4,
      bodyEncoding: 'base64',
      negotiatedAlpn: 'h2',
      bodyNotice: 'n',
      timings: { total: 1 },
    });
  });

  it('does not forward a disabled or "none" proxy', async () => {
    const { request } = install();
    await executeProxiedRequest(
      spec,
      {},
      { proxy: { enabled: false, type: 'http', host: 'h', port: 1 } }
    );
    await executeProxiedRequest(
      spec,
      {},
      { proxy: { enabled: true, type: 'none', host: 'h', port: 1 } }
    );
    for (const call of request.mock.calls as unknown as Array<[Record<string, unknown>]>) {
      expect(call[0]).not.toHaveProperty('proxy');
    }
  });

  it('forwards a proxy without credentials', async () => {
    const { request } = install();
    await executeProxiedRequest(
      spec,
      {},
      { proxy: { enabled: true, type: 'http', host: 'h', port: 1 } }
    );
    const cfg = (request.mock.calls[0] as unknown as [{ proxy: Record<string, unknown> }])[0];
    expect(cfg.proxy).not.toHaveProperty('auth');
  });

  it('rejects immediately for an already-aborted signal', async () => {
    const { request } = install();
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(executeProxiedRequest(spec, { signal: ctrl.signal })).rejects.toBeDefined();
    expect(request).not.toHaveBeenCalled();
  });

  it('cancels the IPC request on abort and surfaces the abort', async () => {
    const { request, cancel } = install();
    const ctrl = new AbortController();
    request.mockImplementation(async () => {
      ctrl.abort();
      return { status: 200, statusText: 'OK', headers: {}, data: '' };
    });
    await expect(executeProxiedRequest(spec, { signal: ctrl.signal })).rejects.toBeDefined();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('ignores a failing cancel', async () => {
    const { request, cancel } = install();
    cancel.mockRejectedValue(new Error('gone'));
    const ctrl = new AbortController();
    request.mockImplementation(async () => {
      ctrl.abort();
      return { status: 200, statusText: 'OK', headers: {}, data: '' };
    });
    await expect(executeProxiedRequest(spec, { signal: ctrl.signal })).rejects.toBeDefined();
  });

  it('removes the abort listener after a normal completion', async () => {
    const { request } = install();
    const ctrl = new AbortController();
    const remove = vi.spyOn(ctrl.signal, 'removeEventListener');
    await executeProxiedRequest(spec, { signal: ctrl.signal });
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(request).toHaveBeenCalledOnce();
  });
});

describe('executeProxiedStreamingRequest', () => {
  it('is unsupported under Electron', async () => {
    state.electron = true;
    await expect(executeProxiedStreamingRequest(spec)).rejects.toThrow(/not yet supported/);
  });

  it('POSTs the spec with manual redirects and the signal', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('x', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const ctrl = new AbortController();
    const res = await executeProxiedStreamingRequest(spec, { signal: ctrl.signal });
    expect(res.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://worker.test/api/proxy');
    expect(init.redirect).toBe('manual');
    expect(init.signal).toBe(ctrl.signal);
  });

  it('omits the signal and rejects an opaque redirect', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ type: 'opaqueredirect' });
    vi.stubGlobal('fetch', fetchMock);
    await expect(executeProxiedStreamingRequest(spec)).rejects.toThrow(/unexpected redirect/);
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty('signal');
  });
});

describe('restoreUpstreamStatus', () => {
  const H = {
    status: 'x-restura-upstream-status',
    text: 'x-restura-upstream-status-text',
    headers: 'x-restura-upstream-headers',
  };

  it('returns replies without the side channel untouched', () => {
    const r = new Response('x');
    expect(restoreUpstreamStatus(r)).toBe(r);
  });

  it('restores status, decoded reason phrase and withheld headers', () => {
    const r = new Response('body', {
      status: 200,
      headers: {
        [H.status]: '404',
        [H.text]: encodeURIComponent('Not Found'),
        [H.headers]: JSON.stringify({ 'x-up': '1', bad: 2 }),
      },
    });
    const out = restoreUpstreamStatus(r);
    expect(out.status).toBe(404);
    expect(out.statusText).toBe('Not Found');
    expect(out.headers.get('x-up')).toBe('1');
    expect(out.headers.has('bad')).toBe(false);
    expect(out.headers.has(H.status)).toBe(false);
  });

  it('tolerates a malformed or non-object withheld-headers value', () => {
    const bad = restoreUpstreamStatus(
      new Response('b', { headers: { [H.status]: '200', [H.headers]: '{not json' } })
    );
    expect(bad.status).toBe(200);
    const scalar = restoreUpstreamStatus(
      new Response('b', { headers: { [H.status]: '200', [H.headers]: '5' } })
    );
    expect(scalar.status).toBe(200);
  });

  it('keeps the raw reason phrase when it is not URI-decodable', () => {
    const out = restoreUpstreamStatus(
      new Response('b', { headers: { [H.status]: '201', [H.text]: 'Bad%' } })
    );
    expect(out.statusText).toBe('Bad%');
  });

  it('uses the wrapper status for an out-of-range upstream status', () => {
    const out = restoreUpstreamStatus(new Response('b', { headers: { [H.status]: '99' } }));
    expect(out.status).toBe(200);
  });

  it.each([204, 205, 304])('drops the body for a %i upstream status', (status) => {
    const out = restoreUpstreamStatus(
      new Response('b', { headers: { [H.status]: String(status) } })
    );
    expect(out.status).toBe(status);
    expect(out.body).toBeNull();
  });

  it('falls back when the reason phrase is rejected by the Response constructor', () => {
    const out = restoreUpstreamStatus(
      new Response('b', { headers: { [H.status]: '200', [H.text]: encodeURIComponent('Ünï\n') } })
    );
    expect(out.status).toBe(200);
  });
});
