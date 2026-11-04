import { beforeEach, describe, expect, it, vi } from 'vitest';

const executeProxiedRequestMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/shared/transport', () => ({
  executeProxiedRequest: (...args: unknown[]) => executeProxiedRequestMock(...args),
}));

import { fetchClientCredentialsToken } from '../oauth2';
import { createProxiedTokenFetch, proxiedTokenFetch } from '../oauth2-transport';

describe('proxiedTokenFetch', () => {
  beforeEach(() => executeProxiedRequestMock.mockReset());

  it('sends the token POST as a raw-body proxy request that does not follow redirects', async () => {
    executeProxiedRequestMock.mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' },
      data: { access_token: 'at', expires_in: 60 },
    });
    const token = await fetchClientCredentialsToken(
      {
        grantType: 'client_credentials',
        clientId: 'c',
        clientSecret: 's',
        tokenUrl: 'http://localhost:9000/token',
      },
      { fetch: proxiedTokenFetch }
    );
    expect(token).toEqual({ access_token: 'at', expires_in: 60 });
    expect(executeProxiedRequestMock).toHaveBeenCalledWith(
      {
        method: 'POST',
        url: 'http://localhost:9000/token',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        bodyType: 'raw',
        data: 'grant_type=client_credentials&client_id=c&client_secret=s',
        redirectPolicy: { maxRedirects: 0 },
      },
      {}
    );
  });

  it('sends the token request with the transport settings of the request it is for', async () => {
    executeProxiedRequestMock.mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: {},
      data: { access_token: 'at' },
    });
    const desktopFor = vi.fn(() => ({ verifySsl: false, caCert: { pem: 'CA' } }));
    await createProxiedTokenFetch(desktopFor)('https://idp.internal/token', {
      method: 'POST',
      body: 'grant_type=client_credentials',
    });
    expect(desktopFor).toHaveBeenCalledWith('https://idp.internal/token');
    expect(executeProxiedRequestMock.mock.calls[0]?.[2]).toEqual({
      verifySsl: false,
      caCert: { pem: 'CA' },
    });
  });

  it('rebuilds the upstream response: status, joined headers, string and base64 bodies', async () => {
    executeProxiedRequestMock.mockResolvedValueOnce({
      status: 401,
      statusText: 'Unauthorized',
      headers: { 'x-a': ['1', '2'] },
      data: '{"error":"invalid_client"}',
    });
    const text = await proxiedTokenFetch('https://idp/token', { method: 'POST', body: 'a=1' });
    expect(text.status).toBe(401);
    expect(text.headers.get('x-a')).toBe('1, 2');
    expect(await text.json()).toEqual({ error: 'invalid_client' });

    executeProxiedRequestMock.mockResolvedValueOnce({
      status: 200,
      statusText: 'OK',
      headers: {},
      data: btoa('{"access_token":"b"}'),
      bodyEncoding: 'base64',
    });
    const b64 = await proxiedTokenFetch('https://idp/token', { method: 'POST', body: 'a=1' });
    expect(await b64.json()).toEqual({ access_token: 'b' });
  });

  it('forwards the abort signal to the transport', async () => {
    executeProxiedRequestMock.mockResolvedValue({ status: 204, statusText: '', headers: {} });
    const controller = new AbortController();
    await proxiedTokenFetch('https://idp/token', { method: 'POST', signal: controller.signal });
    expect(executeProxiedRequestMock.mock.calls[0]?.[1]).toEqual({ signal: controller.signal });
  });

  it('accepts a URL object or a Request as input and defaults to GET with no body', async () => {
    executeProxiedRequestMock.mockResolvedValue({ status: 200, headers: {}, data: null });
    const res = await proxiedTokenFetch(new URL('https://idp/a'));
    expect(await res.text()).toBe('');
    expect(res.statusText).toBe('');
    expect(executeProxiedRequestMock.mock.calls[0]?.[0]).toEqual({
      method: 'GET',
      url: 'https://idp/a',
      headers: {},
      redirectPolicy: { maxRedirects: 0 },
    });
    await proxiedTokenFetch(new Request('https://idp/b'), { body: null });
    expect(executeProxiedRequestMock.mock.calls[1]?.[0]).toMatchObject({ url: 'https://idp/b' });
    expect(executeProxiedRequestMock.mock.calls[1]?.[0]).not.toHaveProperty('data');
  });

  it('refuses a non-string body rather than sending it mangled', async () => {
    await expect(
      proxiedTokenFetch('https://idp/token', { method: 'POST', body: new URLSearchParams('a=1') })
    ).rejects.toThrow(TypeError);
    expect(executeProxiedRequestMock).not.toHaveBeenCalled();
  });

  it('uses the app defaults when the request has no desktop transport settings', async () => {
    executeProxiedRequestMock.mockResolvedValue({ status: 200, headers: {}, data: 'ok' });
    await createProxiedTokenFetch(() => undefined)('https://idp/token');
    expect(executeProxiedRequestMock.mock.calls[0]).toHaveLength(2);
  });

  it('serialises an object body, skips headers Fetch refuses, maps a bogus status to 502', async () => {
    executeProxiedRequestMock.mockResolvedValue({
      status: 0,
      headers: { 'bad header name': 'x', 'x-ok': 'y' },
      data: { error: 'upstream' },
    });
    const res = await proxiedTokenFetch('https://idp/token');
    expect(res.status).toBe(502);
    expect(res.headers.get('x-ok')).toBe('y');
    expect(await res.json()).toEqual({ error: 'upstream' });
  });

  it('a response without headers carries only the Fetch default content type', async () => {
    executeProxiedRequestMock.mockResolvedValue({ status: 200, data: 'x' });
    const res = await proxiedTokenFetch('https://idp/token');
    expect([...res.headers.keys()]).toEqual(['content-type']);
    expect(await res.text()).toBe('x');
  });
});
