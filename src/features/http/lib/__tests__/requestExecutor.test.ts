import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest, RequestSettings } from '@/types';
import { useCookieStore } from '@/features/http/store/useCookieStore';
import { useSettingsStore } from '@/store/useSettingsStore';

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
