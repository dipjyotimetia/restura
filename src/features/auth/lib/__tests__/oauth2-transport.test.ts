import { beforeEach, describe, expect, it, vi } from 'vitest';

const executeProxiedRequestMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/shared/transport', () => ({
  executeProxiedRequest: (...args: unknown[]) => executeProxiedRequestMock(...args),
}));

import { fetchClientCredentialsToken } from '../oauth2';
import { proxiedTokenFetch } from '../oauth2-transport';

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
});
