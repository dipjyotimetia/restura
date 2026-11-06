import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCookieStore } from '@/features/http/store/useCookieStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import type { HttpRequest } from '@/types';
import type { HttpStreamEvent } from '../streamingResponseReader';

const executeProxiedStreamingRequestMock = vi.fn();

vi.mock('@/lib/shared/transport', () => ({
  executeProxiedRequest: vi.fn(),
  executeProxiedStreamingRequest: (...args: unknown[]) =>
    executeProxiedStreamingRequestMock(...args),
  ProxyTransportError: class ProxyTransportError extends Error {},
}));

vi.mock('@/lib/shared/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/shared/platform')>()),
  isElectron: () => false,
}));

import { executeStreamingRequest } from '../requestExecutor';
import { createStreamCapture } from '../streamingCapture';

const NDJSON = '{"a":1}\n{"a":2}\n';

function makeRequest(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return {
    id: 'req-1',
    name: 'Stream',
    type: 'http',
    method: 'GET',
    url: 'https://api.example.com/{{feed}}',
    headers: [{ id: 'h1', key: 'Accept', value: 'application/x-ndjson', enabled: true }],
    params: [],
    body: { type: 'none' },
    auth: { type: 'none' },
    ...overrides,
  };
}

function options(request: HttpRequest, envVars: Record<string, string> = {}) {
  return {
    request,
    envVars,
    globalSettings: useSettingsStore.getState().settings,
    resolveVariables: (text: string, vars?: Record<string, string>) =>
      text.replace(/\{\{(\w+)\}\}/g, (m, name: string) => vars?.[name] ?? envVars[name] ?? m),
  };
}

async function drain(events: AsyncIterable<HttpStreamEvent>): Promise<HttpStreamEvent[]> {
  const out: HttpStreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

beforeEach(() => {
  useCookieStore.setState({ cookies: [] });
  executeProxiedStreamingRequestMock.mockReset();
  executeProxiedStreamingRequestMock.mockImplementation(
    async () =>
      new Response(NDJSON, { status: 200, headers: { 'content-type': 'application/x-ndjson' } })
  );
});

describe('executeStreamingRequest — scripts', () => {
  it('runs the pre-request script first: a variable it sets is used in the streamed URL', async () => {
    const envVars: Record<string, string> = {};
    const result = await executeStreamingRequest(
      options(makeRequest({ preRequestScript: `pm.environment.set('feed', 'live');` }), envVars)
    );
    expect(executeProxiedStreamingRequestMock).toHaveBeenCalledTimes(1);
    const spec = executeProxiedStreamingRequestMock.mock.calls[0]?.[0] as { url: string };
    expect(spec.url).toBe('https://api.example.com/live');
    expect(result.scriptResult?.preRequest).toBeDefined();
    const done = await result.finish((await drain(result.events)).at(-1));
    expect(done.environmentMutations).toEqual({ feed: 'live' });
  });

  it('pre-request header edits apply to the streamed request', async () => {
    await executeStreamingRequest(
      options(
        makeRequest({
          url: 'https://api.example.com/x',
          preRequestScript: `pm.request.headers.upsert({ key: 'X-Run', value: '7' });`,
        })
      )
    );
    const spec = executeProxiedStreamingRequestMock.mock.calls[0]?.[0] as {
      headers: Record<string, string>;
    };
    expect(spec.headers['X-Run']).toBe('7');
  });

  it('pm.execution.skipRequest() prevents the stream', async () => {
    const result = await executeStreamingRequest(
      options(makeRequest({ preRequestScript: `pm.execution.skipRequest();` }), { feed: 'f' })
    );
    expect(result.skipped).toBe(true);
    expect(executeProxiedStreamingRequestMock).not.toHaveBeenCalled();
    expect(result.scriptResult?.preRequest?.execution?.skipRequested).toBe(true);
  });

  it('finish() runs the test script against the full streamed text', async () => {
    const result = await executeStreamingRequest(
      options(
        makeRequest({
          testScript: `pm.test('has events', () => pm.expect(pm.response.text()).to.include('"a":2'));
pm.test('status', () => pm.response.to.have.status(200));
pm.collectionVariables.set('seen', 'yes');`,
        }),
        { feed: 'f' }
      )
    );
    const events = await drain(result.events);
    expect(events.map((e) => e.type)).toEqual(['ndjson', 'ndjson', 'end']);
    const done = await result.finish(events.at(-1));
    expect(done.response.body).toBe(NDJSON);
    expect(done.response.status).toBe(200);
    expect(done.response.bodyNotice).toBeUndefined();
    expect(done.scriptResult.test?.tests).toEqual([
      expect.objectContaining({ name: 'has events', passed: true }),
      expect.objectContaining({ name: 'status', passed: true }),
    ]);
    expect(done.collectionVarsMutations).toEqual({ seen: 'yes' });
    expect(done.sentUrl).toBe('https://api.example.com/f');
  });

  it('finish() after a stream error notes it on the response', async () => {
    const result = await executeStreamingRequest(options(makeRequest(), { feed: 'f' }));
    await drain(result.events);
    const done = await result.finish({ type: 'error', error: 'boom', bytesRead: 3 });
    expect(done.response.bodyNotice).toContain('boom');
  });
});

describe('createStreamCapture', () => {
  it('bounds the captured text and reports the truncation', () => {
    const capture = createStreamCapture('application/x-ndjson', 5);
    capture.onBytes(new TextEncoder().encode('abc'));
    capture.onBytes(new TextEncoder().encode('defgh'));
    expect(capture.read()).toEqual({
      text: 'abcde',
      bytesReceived: 8,
      bytesKept: 5,
      truncated: true,
    });
  });
});
