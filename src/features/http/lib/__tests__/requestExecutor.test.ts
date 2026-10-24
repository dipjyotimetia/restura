import {
  encodeSetCookieSideChannel,
  SET_COOKIE_SIDE_CHANNEL_HEADER,
} from '@shared/protocol/set-cookie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCookieStore } from '@/features/http/store/useCookieStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import type { HttpRequest, RequestSettings } from '@/types';

const executeProxiedRequestMock = vi.fn();
const executeProxiedStreamingRequestMock = vi.fn();
const makeRendererSendRequestMock = vi.fn((_options: unknown) => vi.fn());

vi.mock('@/lib/shared/transport', () => ({
  executeProxiedRequest: (...args: unknown[]) => executeProxiedRequestMock(...args),
  executeProxiedStreamingRequest: (...args: unknown[]) =>
    executeProxiedStreamingRequestMock(...args),
  ProxyTransportError: class ProxyTransportError extends Error {},
}));

const platform = vi.hoisted(() => ({ electron: false }));
vi.mock('@/lib/shared/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/shared/platform')>()),
  isElectron: () => platform.electron,
}));

const fetchRefreshTokenMock = vi.fn();
vi.mock('@/features/auth/lib/oauth2', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/auth/lib/oauth2')>()),
  fetchRefreshToken: (...args: unknown[]) => fetchRefreshTokenMock(...args),
}));

vi.mock('@/features/scripts/lib/pmSendRequestHost', () => ({
  makeRendererSendRequest: (options: unknown) => makeRendererSendRequestMock(options),
}));

import { executeRequest, executeStreamingRequest, isStreamingAccept } from '../requestExecutor';

function makeRequest(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return {
    id: 'request-id',
    name: 'Cookie settings regression',
    type: 'http',
    method: 'GET',
    url: 'https://api.example.com/resource',
    headers: [],
    params: [],
    body: { type: 'none' },
    auth: { type: 'none' },
    ...overrides,
  };
}

describe('executeRequest — cookie settings inheritance', () => {
  const originalSettings = useSettingsStore.getState().settings;

  beforeEach(() => {
    useCookieStore.setState({ cookies: [] });
    executeProxiedRequestMock.mockReset();
    makeRendererSendRequestMock.mockClear();
    executeProxiedRequestMock.mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: { 'set-cookie': 'session=secret; Path=/; HttpOnly' },
      data: '',
      size: 0,
    });
  });

  afterEach(() => {
    useCookieStore.setState({ cookies: [] });
    useSettingsStore.setState({ settings: originalSettings });
  });

  it('does not persist Set-Cookie when a partial request override inherits a disabled global jar', async () => {
    const globalSettings = { ...originalSettings, disableCookieJar: true };
    useSettingsStore.setState({ settings: globalSettings });

    await executeRequest({
      request: makeRequest({ settings: { timeout: 1_000 } as RequestSettings }),
      envVars: {},
      globalSettings,
      resolveVariables: (text) => text,
    });

    expect(useCookieStore.getState().cookies).toEqual([]);
  });

  it('stores every cookie from a multi-Set-Cookie response and keeps the list on the response (#855)', async () => {
    const setCookies = [
      'session=abc; Path=/; HttpOnly',
      'csrf=xyz; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/',
      'pref=dark; Path=/',
    ];
    executeProxiedRequestMock.mockResolvedValueOnce({
      status: 200,
      statusText: 'OK',
      // A flat header map can only hold one value — the list is authoritative.
      headers: { 'set-cookie': 'pref=dark; Path=/' },
      setCookies,
      data: '',
      size: 0,
    });

    const result = await executeRequest({
      request: makeRequest(),
      envVars: {},
      globalSettings: originalSettings,
      resolveVariables: (text) => text,
    });

    const stored = useCookieStore.getState().cookies.map((c) => [c.key, c.value]);
    expect(stored).toEqual([
      ['session', 'abc'],
      ['csrf', 'xyz'],
      ['pref', 'dark'],
    ]);
    expect(result.response.setCookies).toEqual(setCookies);
  });

  it('hands the test script every cookie and a deterministic joined set-cookie header (#855)', async () => {
    const setCookies = ['session=abc; Path=/', 'pref=dark; Path=/'];
    executeProxiedRequestMock.mockResolvedValueOnce({
      status: 200,
      statusText: 'OK',
      headers: { 'set-cookie': 'pref=dark; Path=/' },
      setCookies,
      data: '',
      size: 0,
    });

    const result = await executeRequest({
      request: makeRequest({
        testScript: [
          "pm.test('joined', () => pm.expect(response.headers['set-cookie']).to.equal('session=abc; Path=/, pref=dark; Path=/'));",
          "pm.test('parsed', () => pm.expect(pm.response.cookies.get('session')).to.equal('abc'));",
        ].join('\n'),
      }),
      envVars: {},
      globalSettings: originalSettings,
      resolveVariables: (text) => text,
    });

    expect(result.scriptResult?.test?.tests?.map((t) => [t.name, t.passed])).toEqual([
      ['joined', true],
      ['parsed', true],
    ]);
  });

  it('forwards the caller AbortSignal to the buffered proxy transport', async () => {
    const controller = new AbortController();

    await executeRequest({
      request: makeRequest(),
      envVars: {},
      globalSettings: originalSettings,
      resolveVariables: (text) => text,
      signal: controller.signal,
    });

    expect(executeProxiedRequestMock).toHaveBeenCalledWith(
      expect.anything(),
      { signal: controller.signal },
      expect.anything()
    );
  });

  it('rejects an already-cancelled request before opening the transport', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      executeRequest({
        request: makeRequest(),
        envVars: {},
        globalSettings: originalSettings,
        resolveVariables: (text) => text,
        signal: controller.signal,
      })
    ).rejects.toThrow(/abort/i);

    expect(executeProxiedRequestMock).not.toHaveBeenCalled();
  });

  it('reports whether the parent transport completed successfully', async () => {
    const success = await executeRequest({
      request: makeRequest(),
      envVars: {},
      globalSettings: originalSettings,
      resolveVariables: (text) => text,
    });
    expect(success.transportOk).toBe(true);

    executeProxiedRequestMock.mockRejectedValueOnce(new Error('network down'));
    const failure = await executeRequest({
      request: makeRequest(),
      envVars: {},
      globalSettings: originalSettings,
      resolveVariables: (text) => text,
    });
    expect(failure.transportOk).toBe(false);
    expect(failure.response.status).toBe(0);
  });

  it('passes the parent signal to pre-request and test-script subrequest hosts', async () => {
    const controller = new AbortController();

    await executeRequest({
      request: makeRequest({
        preRequestScript: 'console.log("pre")',
        testScript: 'console.log("test")',
      }),
      envVars: {},
      globalSettings: originalSettings,
      resolveVariables: (text) => text,
      signal: controller.signal,
    });

    expect(makeRendererSendRequestMock).toHaveBeenCalledTimes(2);
    expect(makeRendererSendRequestMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ signal: controller.signal })
    );
    expect(makeRendererSendRequestMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ signal: controller.signal })
    );
  });
});

describe('executeRequest — body variables', () => {
  const settings = useSettingsStore.getState().settings;
  beforeEach(() => {
    executeProxiedRequestMock.mockReset();
    executeProxiedRequestMock.mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: {},
      data: '',
      size: 0,
    });
  });
  const sentSpec = () =>
    executeProxiedRequestMock.mock.calls[0]?.[0] as {
      data?: string;
      formData?: Array<{ name: string; value: string }>;
    };
  const send = (body: HttpRequest['body']) =>
    executeRequest({
      request: makeRequest({ method: 'POST', body }),
      envVars: { host: 'api.dev', id: '42' },
      globalSettings: settings,
      resolveVariables: (text) => text,
    });

  it('resolves {{vars}} in a raw body', async () => {
    const result = await send({ type: 'json', raw: '{"h":"{{host}}","id":{{id}}}' });
    expect(sentSpec().data).toBe('{"h":"api.dev","id":42}');
    // The substituted body is reported back so callers can map server
    // coordinates (GraphQL error locations) onto the unsubstituted text.
    expect(result.sentBody).toBe('{"h":"api.dev","id":42}');
  });

  it('reports the substituted query params as sent (GraphQL GET location mapping)', async () => {
    const result = await executeRequest({
      request: makeRequest({
        params: [{ id: 'q', key: 'query', value: '{ item(id: "{{id}}") }', enabled: true }],
      }),
      envVars: { id: '42' },
      globalSettings: settings,
      resolveVariables: (text) => text,
    });
    expect(result.sentParams).toEqual({ query: '{ item(id: "42") }' });
    expect(result.sentBody).toBeUndefined();
  });

  it('resolves {{vars}} in form-data text fields but never in file content', async () => {
    await send({
      type: 'form-data',
      formData: [
        { id: '1', key: 'who', value: '{{host}}', enabled: true, type: 'text' },
        { id: '2', key: 'f', value: 'e3tob3N0fX0=', enabled: true, type: 'file', fileName: 'a' },
      ],
    });
    expect(sentSpec().formData?.map((f) => f.value)).toEqual(['api.dev', 'e3tob3N0fX0=']);
  });

  it('keeps desktop secret-handle references opaque in the body', async () => {
    await executeRequest({
      request: makeRequest({
        method: 'POST',
        body: { type: 'text', raw: 'k={{apiKey}}&h={{host}}' },
      }),
      // Handle-backed variables are absent from envVars; the store-level
      // resolver would otherwise substitute its masked placeholder.
      envVars: { host: 'api.dev' },
      secretVariables: { apiKey: { kind: 'handle', id: 'h1' } },
      globalSettings: settings,
      resolveVariables: (text) => text.replaceAll('{{apiKey}}', '••••••••'),
    });
    expect(sentSpec().data).toBe('k={{apiKey}}&h=api.dev');
  });

  it('leaves a binary body untouched', async () => {
    await send({ type: 'binary', raw: 'e3tob3N0fX0=' });
    expect(sentSpec().data).toBe('e3tob3N0fX0=');
  });
});

describe('executeRequest — XML body', () => {
  const settings = useSettingsStore.getState().settings;
  beforeEach(() => {
    executeProxiedRequestMock.mockReset();
    executeProxiedRequestMock.mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: {},
      data: '',
      size: 0,
    });
  });

  const sentHeaders = () =>
    (executeProxiedRequestMock.mock.calls[0]?.[0] as { headers: Record<string, string> }).headers;

  it('defaults Content-Type to application/xml', async () => {
    await executeRequest({
      request: makeRequest({ method: 'POST', body: { type: 'xml', raw: '<a/>' } }),
      envVars: {},
      globalSettings: settings,
      resolveVariables: (text) => text,
    });
    expect(sentHeaders()['Content-Type']).toBe('application/xml');
  });

  it('keeps a Content-Type the user set', async () => {
    await executeRequest({
      request: makeRequest({
        method: 'POST',
        body: { type: 'xml', raw: '<a/>' },
        headers: [{ id: 'h', key: 'content-type', value: 'text/xml', enabled: true }],
      }),
      envVars: {},
      globalSettings: settings,
      resolveVariables: (text) => text,
    });
    expect(sentHeaders()['content-type']).toBe('text/xml');
    expect(sentHeaders()['Content-Type']).toBeUndefined();
  });
});

describe('executeRequest — urlencoded fields', () => {
  const settings = useSettingsStore.getState().settings;
  beforeEach(() => {
    executeProxiedRequestMock.mockReset();
    executeProxiedRequestMock.mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: {},
      data: '',
      size: 0,
    });
  });
  const sentSpec = () =>
    executeProxiedRequestMock.mock.calls[0]?.[0] as {
      bodyType: string;
      data?: string;
      formData?: Array<{ name: string; value: string }>;
    };
  const send = (body: HttpRequest['body']) =>
    executeRequest({
      request: makeRequest({ method: 'POST', body }),
      envVars: {},
      globalSettings: settings,
      resolveVariables: (text) => text,
    });

  it('sends enabled text fields from imported collections', async () => {
    await send({
      type: 'x-www-form-urlencoded',
      formData: [
        { id: '1', key: 'a', value: '1', enabled: true, type: 'text' },
        { id: '2', key: 'off', value: 'x', enabled: false, type: 'text' },
      ],
    });
    expect(sentSpec().bodyType).toBe('form-urlencoded');
    expect(sentSpec().formData).toEqual([{ name: 'a', value: '1' }]);
    expect(sentSpec().data).toBeUndefined();
  });

  it('resolves {{vars}} in urlencoded fields', async () => {
    await executeRequest({
      request: makeRequest({
        method: 'POST',
        body: {
          type: 'x-www-form-urlencoded',
          formData: [{ id: '1', key: 'h', value: '{{host}}', enabled: true, type: 'text' }],
        },
      }),
      envVars: { host: 'api.dev' },
      globalSettings: settings,
      resolveVariables: (text) => text,
    });
    expect(sentSpec().formData).toEqual([{ name: 'h', value: 'api.dev' }]);
  });

  it('resolves {{vars}} in a raw urlencoded fallback', async () => {
    await executeRequest({
      request: makeRequest({
        method: 'POST',
        body: { type: 'x-www-form-urlencoded', raw: 'h={{host}}' },
      }),
      envVars: { host: 'api.dev' },
      globalSettings: settings,
      resolveVariables: (text) => text,
    });
    expect(sentSpec().data).toBe('h=api.dev');
  });

  it('falls back to the raw string when there are no fields', async () => {
    await send({ type: 'x-www-form-urlencoded', raw: 'a=1&b=2', formData: [] });
    expect(sentSpec().data).toBe('a=1&b=2');
    expect(sentSpec().formData).toBeUndefined();
  });
});

describe('isStreamingAccept', () => {
  it('detects text/event-stream', () => {
    expect(isStreamingAccept({ Accept: 'text/event-stream' })).toBe(true);
  });

  it('detects application/x-ndjson', () => {
    expect(isStreamingAccept({ Accept: 'application/x-ndjson' })).toBe(true);
  });

  it('detects application/jsonl', () => {
    expect(isStreamingAccept({ Accept: 'application/jsonl' })).toBe(true);
  });

  it('is case-insensitive on the value', () => {
    expect(isStreamingAccept({ Accept: 'TEXT/EVENT-STREAM' })).toBe(true);
    expect(isStreamingAccept({ Accept: 'Application/X-NDJson' })).toBe(true);
  });

  it('honours lowercase header keys', () => {
    expect(isStreamingAccept({ accept: 'application/x-ndjson' })).toBe(true);
  });

  it('matches when the streaming type is one element of a compound Accept', () => {
    expect(isStreamingAccept({ Accept: 'text/event-stream, application/json' })).toBe(true);
    expect(isStreamingAccept({ Accept: 'application/json, application/x-ndjson' })).toBe(true);
  });

  it('returns false for non-streaming Accept values', () => {
    expect(isStreamingAccept({ Accept: 'application/json' })).toBe(false);
    expect(isStreamingAccept({ Accept: 'text/html' })).toBe(false);
    expect(isStreamingAccept({ Accept: '*/*' })).toBe(false);
  });

  it('returns false when no Accept header is present', () => {
    expect(isStreamingAccept({})).toBe(false);
  });

  it('returns false for empty Accept header value', () => {
    expect(isStreamingAccept({ Accept: '' })).toBe(false);
  });

  it('does not match similarly-named non-streaming types', () => {
    // text/event-streamy isn't a real type; we use includes() so this DOES
    // technically match. Lock the current behaviour so a future tightening
    // is intentional.
    expect(isStreamingAccept({ Accept: 'text/event-stream-alt' })).toBe(true);
    // But "application/event-json" should not match any streaming type
    expect(isStreamingAccept({ Accept: 'application/event-json' })).toBe(false);
  });
});

describe('executeStreamingRequest — Set-Cookie side channel (#855)', () => {
  const originalSettings = useSettingsStore.getState().settings;
  const cookies = ['session=abc; Path=/; HttpOnly', 'csrf=xyz; Path=/'];

  function streamResponse(): Response {
    return new Response('data: a\n\n', {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        [SET_COOKIE_SIDE_CHANNEL_HEADER]: encodeSetCookieSideChannel(cookies),
      },
    });
  }

  beforeEach(() => {
    useCookieStore.setState({ cookies: [] });
    executeProxiedStreamingRequestMock.mockReset();
  });

  afterEach(() => {
    useCookieStore.setState({ cookies: [] });
  });

  it('surfaces every cookie on the response meta and stores each in the jar', async () => {
    executeProxiedStreamingRequestMock.mockResolvedValueOnce(streamResponse());

    const { responseMeta } = await executeStreamingRequest({
      request: makeRequest({
        headers: [{ id: 'h1', key: 'Accept', value: 'text/event-stream', enabled: true }],
      }),
      envVars: {},
      globalSettings: originalSettings,
      resolveVariables: (text) => text,
    });

    expect(responseMeta.setCookies).toEqual(cookies);
    expect(responseMeta.headers[SET_COOKIE_SIDE_CHANNEL_HEADER]).toBeUndefined();
    expect(responseMeta.headers['content-type']).toBe('text/event-stream');
    expect(useCookieStore.getState().cookies.map((c) => [c.key, c.value, c.domain])).toEqual([
      ['session', 'abc', 'api.example.com'],
      ['csrf', 'xyz', 'api.example.com'],
    ]);
  });

  it('keeps the omitted-cookies notice visible in the response headers', async () => {
    executeProxiedStreamingRequestMock.mockResolvedValueOnce(
      new Response('data: a\n\n', {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          [SET_COOKIE_SIDE_CHANNEL_HEADER]: encodeSetCookieSideChannel(cookies),
          'x-restura-set-cookies-omitted': '7',
        },
      })
    );
    const { responseMeta } = await executeStreamingRequest({
      request: makeRequest({
        headers: [{ id: 'h1', key: 'Accept', value: 'text/event-stream', enabled: true }],
      }),
      envVars: {},
      globalSettings: originalSettings,
      resolveVariables: (text) => text,
    });
    expect(responseMeta.headers['x-restura-set-cookies-omitted']).toBe('7');
  });

  it('honours a disabled cookie jar', async () => {
    executeProxiedStreamingRequestMock.mockResolvedValueOnce(streamResponse());

    const { responseMeta } = await executeStreamingRequest({
      request: makeRequest(),
      envVars: {},
      globalSettings: { ...originalSettings, disableCookieJar: true },
      resolveVariables: (text) => text,
    });

    expect(responseMeta.setCookies).toEqual(cookies);
    expect(useCookieStore.getState().cookies).toEqual([]);
  });

  it('omits setCookies when the upstream set none', async () => {
    executeProxiedStreamingRequestMock.mockResolvedValueOnce(
      new Response('data: a\n\n', { headers: { 'content-type': 'text/event-stream' } })
    );

    const { responseMeta } = await executeStreamingRequest({
      request: makeRequest(),
      envVars: {},
      globalSettings: originalSettings,
      resolveVariables: (text) => text,
    });

    expect(responseMeta.setCookies).toBeUndefined();
    expect(useCookieStore.getState().cookies).toEqual([]);
  });
});

describe('executeRequest — auth {{vars}} resolution', () => {
  const settings = useSettingsStore.getState().settings;
  beforeEach(() => {
    executeProxiedRequestMock.mockReset();
    fetchRefreshTokenMock.mockReset();
    executeProxiedRequestMock.mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: {},
      data: '',
      size: 0,
    });
  });
  type SentSpec = {
    headers: Record<string, string>;
    params?: Record<string, string>;
    auth?: HttpRequest['auth'];
  };
  const sentSpec = () => executeProxiedRequestMock.mock.calls[0]?.[0] as SentSpec;
  const sentDesktop = () =>
    executeProxiedRequestMock.mock.calls[0]?.[2] as { secretVariables?: unknown } | undefined;
  const envVars = { tok: 'x', user: 'alice', pw: 's3cret', k: 'X-Key', region: 'ap-southeast-2' };
  const send = (auth: HttpRequest['auth'], extra: Record<string, unknown> = {}) =>
    executeRequest({
      request: makeRequest({ auth }),
      envVars: { ...envVars },
      globalSettings: settings,
      resolveVariables: (text) => text,
      ...extra,
    });

  it('resolves a bearer token template into the Authorization header', async () => {
    const result = await send({ type: 'bearer', bearer: { token: '{{tok}}' } });
    expect(sentSpec().headers['Authorization']).toBe('Bearer x');
    expect(result.sentHeaders['Authorization']).toBe('Bearer x');
    // Variable resolution alone must never be reported as a refresh to persist.
    expect(result.refreshedAuth).toBeUndefined();
  });

  it('resolves basic username/password before encoding', async () => {
    await send({ type: 'basic', basic: { username: '{{user}}', password: '{{pw}}' } });
    expect(sentSpec().headers['Authorization']).toBe(`Basic ${btoa('alice:s3cret')}`);
  });

  it('resolves api-key key and value in a header and in the query', async () => {
    await send({ type: 'api-key', apiKey: { key: '{{k}}', value: '{{tok}}', in: 'header' } });
    expect(sentSpec().headers['X-Key']).toBe('x');
    executeProxiedRequestMock.mockClear();
    await send({ type: 'api-key', apiKey: { key: 'api_key', value: '{{tok}}', in: 'query' } });
    expect(sentSpec().params?.['api_key']).toBe('x');
  });

  it('carries resolved digest credentials in spec.auth for the wire-side challenge retry', async () => {
    await send({ type: 'digest', digest: { username: '{{user}}', password: '{{pw}}' } });
    expect(sentSpec().auth).toEqual({
      type: 'digest',
      digest: { username: 'alice', password: 's3cret' },
    });
  });

  it('resolves sign-at-wire descriptors (aws, oauth1, wsse) in spec.auth', async () => {
    await send({
      type: 'aws-signature',
      awsSignature: {
        accessKey: '{{user}}',
        secretKey: '{{pw}}',
        region: '{{region}}',
        service: 's3',
      },
    });
    expect(sentSpec().auth?.awsSignature).toEqual({
      accessKey: 'alice',
      secretKey: 's3cret',
      region: 'ap-southeast-2',
      service: 's3',
    });
    executeProxiedRequestMock.mockClear();
    await send({
      type: 'oauth1',
      oauth1: { consumerKey: '{{user}}', consumerSecret: { kind: 'inline', value: '{{pw}}' } },
    });
    expect(sentSpec().auth?.oauth1).toEqual({
      consumerKey: 'alice',
      consumerSecret: { kind: 'inline', value: 's3cret' },
    });
    executeProxiedRequestMock.mockClear();
    await send({ type: 'wsse', wsse: { username: '{{user}}', password: '{{pw}}' } });
    expect(sentSpec().auth?.wsse).toEqual({ username: 'alice', password: 's3cret' });
  });

  it('leaves handle-backed SecretRefs and secret-variable tokens opaque for Electron main', async () => {
    const handle = { kind: 'handle', id: 'h-1' } as const;
    const secretOpts = {
      secretVariables: { apiKey: { kind: 'handle', id: 'h2' } },
      resolveVariables: (text: string) => text.replaceAll('{{apiKey}}', '••••••••'),
    };
    await send({ type: 'digest', digest: { username: '{{user}}', password: handle } }, secretOpts);
    expect(sentSpec().auth?.digest?.password).toBe(handle);
    executeProxiedRequestMock.mockClear();
    await send(
      { type: 'wsse', wsse: { username: '{{user}}', password: '{{apiKey}}' } },
      secretOpts
    );
    expect(sentSpec().auth?.wsse).toEqual({ username: 'alice', password: '{{apiKey}}' });
    expect(sentDesktop()?.secretVariables).toEqual({ apiKey: { kind: 'handle', id: 'h2' } });
  });

  it('refreshes OAuth2 with resolved config but reports the template back for persistence', async () => {
    fetchRefreshTokenMock.mockResolvedValue({ access_token: 'fresh', expires_in: 3600 });
    const result = await send({
      type: 'oauth2',
      oauth2: {
        accessToken: 'stale',
        refreshToken: '{{pw}}',
        clientId: '{{user}}',
        tokenUrl: 'https://auth.example.com/token',
        tokenType: 'Bearer',
        expiresAt: Date.now() - 1_000,
      },
    });
    expect(fetchRefreshTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: 'alice', refreshToken: 's3cret' }),
      undefined
    );
    expect(sentSpec().headers['Authorization']).toBe('Bearer fresh');
    // Persisted auth keeps the {{var}} templates; only the new token lands.
    expect(result.refreshedAuth?.oauth2).toMatchObject({
      accessToken: 'fresh',
      refreshToken: '{{pw}}',
      clientId: '{{user}}',
      tokenType: 'Bearer',
    });
    expect(result.refreshedAuth?.oauth2?.expiresAt).toBeGreaterThan(Date.now());
  });

  it('persists a rotated refresh token and server token_type from the refresh response', async () => {
    fetchRefreshTokenMock.mockResolvedValue({
      access_token: 'fresh',
      refresh_token: 'rotated',
      token_type: 'DPoP',
    });
    const result = await send({
      type: 'oauth2',
      oauth2: {
        accessToken: '{{tok}}',
        refreshToken: '{{pw}}',
        clientId: 'c',
        tokenUrl: 'https://auth.example.com/token',
        tokenType: '{{tt}}',
        expiresAt: Date.now() - 1_000,
      },
    });
    expect(result.refreshedAuth?.oauth2).toMatchObject({
      accessToken: 'fresh',
      refreshToken: 'rotated',
      tokenType: 'DPoP',
    });
  });

  describe('Basic auth referencing a desktop secret variable', () => {
    const secretOpts = {
      secretVariables: { pw: { kind: 'handle' as const, id: 'h2' } },
      resolveVariables: (text: string) => text.replaceAll('{{pw}}', '••••••••'),
    };
    afterEach(() => {
      platform.electron = false;
    });

    it('defers the Authorization header to Electron main instead of encoding the token', async () => {
      platform.electron = true;
      const result = await executeRequest({
        request: makeRequest({
          auth: { type: 'basic', basic: { username: '{{user}}', password: '{{pw}}' } },
        }),
        envVars: { user: 'alice' },
        globalSettings: settings,
        ...secretOpts,
      });
      const spec = sentSpec();
      expect(spec.headers['Authorization']).toBeUndefined();
      expect(result.sentHeaders['Authorization']).toBeUndefined();
      // Main materializes {{pw}} into spec.auth, then builds the header.
      expect(spec.auth).toEqual({
        type: 'basic',
        basic: { username: 'alice', password: '{{pw}}' },
      });
      expect(sentDesktop()?.secretVariables).toEqual(secretOpts.secretVariables);
    });

    it('fails fast on web, where secret variables cannot be materialized', async () => {
      await expect(
        executeRequest({
          request: makeRequest({
            auth: { type: 'basic', basic: { username: 'alice', password: '{{pw}}' } },
          }),
          envVars: {},
          globalSettings: settings,
          ...secretOpts,
        })
      ).rejects.toThrow(/desktop app/);
      expect(executeProxiedRequestMock).not.toHaveBeenCalled();
    });

    it('still encodes in the renderer when no secret variable is referenced', async () => {
      platform.electron = true;
      await executeRequest({
        request: makeRequest({
          auth: { type: 'basic', basic: { username: '{{user}}', password: 'plain' } },
        }),
        envVars: { user: 'alice' },
        globalSettings: settings,
        ...secretOpts,
      });
      expect(sentSpec().headers['Authorization']).toBe(`Basic ${btoa('alice:plain')}`);
    });

    it('detects a whitespace-padded {{ pw }} token the same way main does', async () => {
      platform.electron = true;
      await executeRequest({
        request: makeRequest({
          auth: { type: 'basic', basic: { username: 'alice', password: '{{ pw }}' } },
        }),
        envVars: {},
        globalSettings: settings,
        secretVariables: secretOpts.secretVariables,
        // A store resolver that tolerates whitespace would otherwise consume it.
        resolveVariables: (text: string) => text.replace(/\{\{\s*pw\s*\}\}/g, '••••••••'),
      });
      expect(sentSpec().headers['Authorization']).toBeUndefined();
      expect(sentSpec().auth?.basic?.password).toBe('{{ pw }}');
    });

    it('does not throw on a basic block missing username/password (hand-edited import)', async () => {
      platform.electron = true;
      const basic = {} as unknown as NonNullable<HttpRequest['auth']['basic']>;
      await expect(
        executeRequest({
          request: makeRequest({ auth: { type: 'basic', basic } }),
          envVars: {},
          globalSettings: settings,
          ...secretOpts,
        })
      ).resolves.toBeDefined();
    });
  });

  it('keeps a whitespace-padded secret-variable token opaque in the body', async () => {
    await executeRequest({
      request: makeRequest({ method: 'POST', body: { type: 'text', raw: 'k={{ apiKey }}' } }),
      envVars: {},
      secretVariables: { apiKey: { kind: 'handle', id: 'h1' } },
      globalSettings: settings,
      resolveVariables: (text) => text.replace(/\{\{\s*apiKey\s*\}\}/g, '••••••••'),
    });
    expect((executeProxiedRequestMock.mock.calls[0]?.[0] as { data?: string }).data).toBe(
      'k={{ apiKey }}'
    );
  });

  it('does not report refreshedAuth when only variables were resolved', async () => {
    const result = await send({
      type: 'oauth2',
      oauth2: { accessToken: '{{tok}}', tokenType: 'Bearer' },
    });
    expect(sentSpec().headers['Authorization']).toBe('Bearer x');
    expect(result.refreshedAuth).toBeUndefined();
  });
});
