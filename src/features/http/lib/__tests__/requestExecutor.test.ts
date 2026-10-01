import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCookieStore } from '@/features/http/store/useCookieStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import type { HttpRequest, RequestSettings } from '@/types';

const executeProxiedRequestMock = vi.fn();
const makeRendererSendRequestMock = vi.fn((_options: unknown) => vi.fn());

vi.mock('@/lib/shared/transport', () => ({
  executeProxiedRequest: (...args: unknown[]) => executeProxiedRequestMock(...args),
  executeProxiedStreamingRequest: vi.fn(),
  ProxyTransportError: class ProxyTransportError extends Error {},
}));

vi.mock('@/features/scripts/lib/pmSendRequestHost', () => ({
  makeRendererSendRequest: (options: unknown) => makeRendererSendRequestMock(options),
}));

import { executeRequest, isStreamingAccept } from '../requestExecutor';

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
    await send({ type: 'json', raw: '{"h":"{{host}}","id":{{id}}}' });
    expect(sentSpec().data).toBe('{"h":"api.dev","id":42}');
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
