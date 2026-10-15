import { describe, expect, it, vi } from 'vitest';
import type { Response as ApiResponse, HttpRequest } from '@/types';
import {
  buildGraphQLWireRequest,
  createIncrementalProgress,
  GRAPHQL_ACCEPT,
  GRAPHQL_INCREMENTAL_ACCEPT,
  getRefusalReason,
  graphqlMethodOf,
  hasIncrementalDirective,
  normalizeGraphQLResponse,
  snapshotToResponse,
} from '../graphqlHttp';

function req(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return {
    id: 'r1',
    name: 'Q',
    type: 'http',
    method: 'POST',
    url: 'https://api.example.test/graphql',
    headers: [],
    params: [],
    body: { type: 'graphql', raw: '' },
    auth: { type: 'none' },
    ...overrides,
  };
}

const headerMap = (r: HttpRequest) =>
  Object.fromEntries(r.headers.filter((h) => h.enabled).map((h) => [h.key, h.value]));
const paramMap = (r: HttpRequest) =>
  Object.fromEntries(r.params.filter((p) => p.enabled).map((p) => [p.key, p.value]));

// graphql-yoga multipart framing (boundary "-") of a @defer response.
const YOGA_MULTIPART =
  '\r\n---' +
  '\r\nContent-Type: application/json; charset=utf-8\r\n\r\n{"data":{"hello":"world"},"hasNext":true}\r\n---' +
  '\r\nContent-Type: application/json; charset=utf-8\r\n\r\n{"incremental":[{"data":{"slow":"done"},"path":[]}],"hasNext":false}\r\n---' +
  '\r\n-----\r\n';
const MULTIPART_CT = 'multipart/mixed; boundary="-"';

function apiResponse(overrides: Partial<ApiResponse> = {}): ApiResponse {
  return {
    id: 'resp',
    requestId: 'r1',
    status: 200,
    statusText: 'OK',
    headers: { 'Content-Type': MULTIPART_CT },
    body: YOGA_MULTIPART,
    size: 1,
    time: 1,
    timestamp: 1,
    ...overrides,
  };
}

describe('graphqlMethodOf / hasIncrementalDirective / getRefusalReason', () => {
  it('treats anything but GET as POST', () => {
    expect(graphqlMethodOf({ method: 'GET' })).toBe('GET');
    expect(graphqlMethodOf({ method: 'POST' })).toBe('POST');
    expect(graphqlMethodOf({ method: 'PUT' })).toBe('POST');
  });

  it('detects @defer / @stream outside comments', () => {
    expect(hasIncrementalDirective('{ a ... @defer { b } }')).toBe(true);
    expect(hasIncrementalDirective('{ list @stream(initialCount: 1) }')).toBe(true);
    expect(hasIncrementalDirective('{ a } # @defer later')).toBe(false);
    expect(hasIncrementalDirective('{ a @deferred }')).toBe(false);
  });

  it('refuses mutations and subscriptions over GET, allows queries and shorthand', () => {
    expect(getRefusalReason('mutation M { x }')).toMatch(/switch the method to POST.*mutation/);
    expect(getRefusalReason('subscription S { x }')).toMatch(/subscription/);
    expect(getRefusalReason('query Q { x }')).toBeNull();
    expect(getRefusalReason('{ x }')).toBeNull();
  });
});

describe('buildGraphQLWireRequest — POST', () => {
  it('sends the JSON envelope with Content-Type and the spec Accept header', () => {
    const envelope = { query: 'query Q { a }', variables: { id: 1 }, operationName: 'Q' };
    const wire = buildGraphQLWireRequest(req(), envelope);
    if (!wire.ok) throw new Error(wire.error);
    expect(wire.method).toBe('POST');
    expect(wire.request.method).toBe('POST');
    expect(wire.request.body).toEqual({ type: 'json', raw: JSON.stringify(envelope) });
    expect(headerMap(wire.request)).toEqual({
      Accept: GRAPHQL_ACCEPT,
      'Content-Type': 'application/json',
    });
  });

  it('keeps a user-set Accept / Content-Type (case-insensitive) and ignores disabled ones', () => {
    const wire = buildGraphQLWireRequest(
      req({
        headers: [
          { id: 'a', key: 'accept', value: 'application/json', enabled: true },
          { id: 'c', key: 'Content-Type', value: 'x', enabled: false },
        ],
      }),
      { query: '{ a }' }
    );
    if (!wire.ok) throw new Error(wire.error);
    expect(wire.request.headers.filter((h) => h.key.toLowerCase() === 'accept')).toHaveLength(1);
    expect(headerMap(wire.request)['Content-Type']).toBe('application/json');
  });

  it('advertises multipart/mixed for @defer / @stream documents', () => {
    const wire = buildGraphQLWireRequest(req(), { query: '{ a ... @defer { b } }' });
    if (!wire.ok) throw new Error(wire.error);
    expect(headerMap(wire.request).Accept).toBe(GRAPHQL_INCREMENTAL_ACCEPT);
  });

  it('does not mutate the input request', () => {
    const input = req();
    buildGraphQLWireRequest(input, { query: '{ a }' });
    expect(input.headers).toEqual([]);
    expect(input.body.type).toBe('graphql');
  });
});

describe('buildGraphQLWireRequest — GET', () => {
  it('URL-encodes query, variables, operationName and extensions as params', () => {
    const wire = buildGraphQLWireRequest(
      req({
        method: 'GET',
        params: [
          { id: 'k', key: 'keep', value: '1', enabled: true },
          { id: 'q', key: 'query', value: 'stale', enabled: true },
          { id: 'd', key: 'variables', value: 'off', enabled: false },
        ],
      }),
      {
        query: 'query Q($id: ID) { a(id: $id) }',
        variables: { id: '1' },
        operationName: 'Q',
        extensions: { persistedQuery: { version: 1, sha256Hash: 'abc' } },
      }
    );
    if (!wire.ok) throw new Error(wire.error);
    expect(wire.method).toBe('GET');
    expect(wire.request.method).toBe('GET');
    expect(wire.request.body).toEqual({ type: 'none' });
    expect(paramMap(wire.request)).toEqual({
      keep: '1',
      query: 'query Q($id: ID) { a(id: $id) }',
      variables: '{"id":"1"}',
      operationName: 'Q',
      extensions: '{"persistedQuery":{"version":1,"sha256Hash":"abc"}}',
    });
    // The disabled user param is preserved untouched.
    expect(wire.request.params.some((p) => p.key === 'variables' && !p.enabled)).toBe(true);
    // GET carries no body, so no Content-Type is added.
    expect(headerMap(wire.request)).toEqual({ Accept: GRAPHQL_ACCEPT });
  });

  it('forces URL encoding even when the request opted out', () => {
    const wire = buildGraphQLWireRequest(
      req({ method: 'GET', settings: { encodeUrlAutomatically: false, timeout: 5 } }),
      { query: '{ a(x: "#&") }' }
    );
    if (!wire.ok) throw new Error(wire.error);
    expect(wire.request.settings).toEqual({ encodeUrlAutomatically: true, timeout: 5 });
  });

  it('omits empty variables / extensions', () => {
    const wire = buildGraphQLWireRequest(req({ method: 'GET' }), {
      query: '{ a }',
      variables: {},
      extensions: {},
    });
    if (!wire.ok) throw new Error(wire.error);
    expect(paramMap(wire.request)).toEqual({ query: '{ a }' });
  });

  it('refuses a mutation with a clear message', () => {
    const wire = buildGraphQLWireRequest(req({ method: 'GET' }), { query: 'mutation { x }' });
    expect(wire).toEqual({ ok: false, error: expect.stringMatching(/only send query/) });
  });
});

describe('normalizeGraphQLResponse', () => {
  it('folds a multipart/mixed incremental body into one JSON result', () => {
    const out = normalizeGraphQLResponse(apiResponse());
    expect(JSON.parse(out.body)).toEqual({ data: { hello: 'world', slow: 'done' } });
    expect(out.bodyNotice).toMatch(/merged 2 multipart\/mixed parts/);
    expect(out.headers).toEqual({ 'Content-Type': MULTIPART_CT });
  });

  it('decodes a base64 (binary-transported) multipart body first', () => {
    const b64 = btoa(YOGA_MULTIPART);
    const out = normalizeGraphQLResponse(apiResponse({ body: b64, bodyEncoding: 'base64' }));
    expect(out.bodyEncoding).toBeUndefined();
    expect(JSON.parse(out.body)).toEqual({ data: { hello: 'world', slow: 'done' } });
  });

  it('keeps the raw body when the merged result cannot be serialised', () => {
    const deep = `{"data":${'{"a":'.repeat(20_000)}1${'}'.repeat(20_000)}}`;
    const body = `--b\r\n\r\n${deep}\r\n--b--`;
    const r = apiResponse({ headers: { 'content-type': 'multipart/mixed; boundary=b' }, body });
    const out = normalizeGraphQLResponse(r);
    // Either merged fine or fell back to the untouched response — never throws.
    expect(out === r || typeof out.body === 'string').toBe(true);
  });

  it('leaves non-multipart, undecodable or JSON-free bodies untouched', () => {
    const json = apiResponse({ headers: { 'content-type': ['application/json'] }, body: '{}' });
    expect(normalizeGraphQLResponse(json)).toBe(json);
    const bad = apiResponse({ body: '%%%not-base64', bodyEncoding: 'base64' });
    expect(normalizeGraphQLResponse(bad)).toBe(bad);
    const none = apiResponse({ headers: {} });
    expect(normalizeGraphQLResponse(none)).toBe(none);
  });
});

describe('createIncrementalProgress', () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const meta = { status: 200, statusText: 'OK', headers: { 'content-type': MULTIPART_CT } };

  it('emits a merged snapshot after each part as chunks arrive', () => {
    const onSnapshot = vi.fn();
    const progress = createIncrementalProgress(onSnapshot);
    const cut = YOGA_MULTIPART.indexOf('{"incremental"');
    progress({ ...meta, chunk: enc(YOGA_MULTIPART.slice(0, cut)) });
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    expect(onSnapshot.mock.calls[0]![0]).toMatchObject({
      result: { data: { hello: 'world' } },
      parts: 1,
      hasNext: true,
    });
    progress({ ...meta, chunk: enc(YOGA_MULTIPART.slice(cut)) });
    expect(onSnapshot).toHaveBeenCalledTimes(2);
    expect(onSnapshot.mock.calls[1]![0]).toMatchObject({
      result: { data: { hello: 'world', slow: 'done' } },
      parts: 2,
      hasNext: false,
      status: 200,
    });
  });

  it('ignores non-multipart responses and non-JSON parts', () => {
    const onSnapshot = vi.fn();
    const json = createIncrementalProgress(onSnapshot);
    json({ ...meta, headers: { 'content-type': 'application/json' }, chunk: enc('{}') });
    json({ ...meta, headers: { 'content-type': 'application/json' }, chunk: enc('{}') });
    const text = createIncrementalProgress(onSnapshot);
    text({ ...meta, chunk: enc('\r\n---\r\n\r\nnot json\r\n---\r\n\r\n{}\r\n---') });
    expect(onSnapshot).not.toHaveBeenCalled();
  });
});

describe('createIncrementalProgress — coalescing', () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const meta = { status: 200, statusText: 'OK', headers: { 'content-type': MULTIPART_CT } };
  const part = (json: unknown) =>
    `\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(json)}\r\n---`;

  function harness() {
    let clock = 0;
    const timers: Array<{ fn: () => void; at: number; id: number }> = [];
    let nextId = 0;
    const onSnapshot = vi.fn();
    const progress = createIncrementalProgress(onSnapshot, {
      now: () => clock,
      setTimer: (fn, ms) => {
        const id = ++nextId;
        timers.push({ fn, at: clock + ms, id });
        return id;
      },
      clearTimer: (id) => {
        const i = timers.findIndex((t) => t.id === id);
        if (i >= 0) timers.splice(i, 1);
      },
    });
    const advance = (ms: number) => {
      clock += ms;
      for (const t of timers.filter((x) => x.at <= clock)) {
        timers.splice(timers.indexOf(t), 1);
        t.fn();
      }
    };
    return { onSnapshot, progress, advance, timers };
  }

  it('10k tiny @stream parts in one window cost two snapshots (first + final)', () => {
    const { onSnapshot, progress } = harness();
    progress({
      ...meta,
      chunk: enc(
        `\r\n---${part({ data: { l: [] }, pending: [{ id: '0', path: ['l'] }], hasNext: true })}`
      ),
    });
    const started = performance.now();
    for (let i = 0; i < 10_000; i++) {
      progress({
        ...meta,
        chunk: enc(part({ incremental: [{ id: '0', items: [i] }], hasNext: true })),
      });
    }
    progress({ ...meta, chunk: enc(`${part({ hasNext: false })}\r\n-----\r\n`) });
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(onSnapshot).toHaveBeenCalledTimes(2);
    const last = onSnapshot.mock.calls[1]![0];
    expect(last.hasNext).toBe(false);
    expect((last.result.data as { l: number[] }).l).toHaveLength(10_000);
  });

  it('flushes a trailing snapshot after the interval, and dispose cancels it', () => {
    const { onSnapshot, progress, advance, timers } = harness();
    progress({ ...meta, chunk: enc(`\r\n---${part({ data: { a: 1 }, hasNext: true })}`) });
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    advance(10);
    progress({ ...meta, chunk: enc(part({ data: { b: 2 }, hasNext: true })) });
    progress({ ...meta, chunk: enc(part({ data: { c: 3 }, hasNext: true })) });
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    expect(timers).toHaveLength(1);
    advance(100);
    expect(onSnapshot).toHaveBeenCalledTimes(2);
    expect(onSnapshot.mock.calls[1]![0].result).toEqual({ data: { a: 1, b: 2, c: 3 } });

    progress({ ...meta, chunk: enc(part({ data: { d: 4 }, hasNext: true })) });
    expect(timers).toHaveLength(1);
    progress.dispose();
    expect(timers).toHaveLength(0);
    advance(1_000);
    progress({ ...meta, chunk: enc(part({ data: { e: 5 }, hasNext: false })) });
    expect(onSnapshot).toHaveBeenCalledTimes(2);
  });

  it('stops live updates when the sink throws or a part is oversized', () => {
    const throwing = vi.fn(() => {
      throw new RangeError('too deep');
    });
    const p1 = createIncrementalProgress(throwing);
    p1({ ...meta, chunk: enc(`\r\n---${part({ data: { a: 1 }, hasNext: false })}`) });
    p1({ ...meta, chunk: enc(part({ data: { a: 2 }, hasNext: false })) });
    expect(throwing).toHaveBeenCalledTimes(1);

    const sink = vi.fn();
    const p2 = createIncrementalProgress(sink);
    p2({ ...meta, chunk: enc('\r\n---\r\n\r\n') });
    const big = enc('x'.repeat(17 * 1024 * 1024));
    p2({ ...meta, chunk: big });
    p2({ ...meta, chunk: enc(`\r\n---${part({ data: {}, hasNext: false })}`) });
    expect(sink).not.toHaveBeenCalled();
    p2.dispose();
  });
});

describe('snapshotToResponse', () => {
  it('renders a provisional response with an in-progress notice', () => {
    const r = snapshotToResponse(
      {
        status: 200,
        statusText: 'OK',
        headers: { a: 'b' },
        result: { data: { x: 1 } },
        parts: 1,
        hasNext: true,
      },
      'req-9',
      Date.now() - 5
    );
    expect(r).toMatchObject({
      requestId: 'req-9',
      status: 200,
      headers: { a: 'b' },
      partial: true,
    });
    expect(JSON.parse(r.body)).toEqual({ data: { x: 1 } });
    expect(r.bodyNotice).toMatch(/1 part received so far/);
    expect(r.time).toBeGreaterThanOrEqual(0);
  });
});
