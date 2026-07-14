import { describe, expect, it } from 'vitest';
import {
  filterEntries,
  matchesQuery,
  parseQuery,
  sortEntries,
  statusClassCounts,
  statusMatchesClass,
} from '@/lib/shared/console-filter';
import type { ConsoleEntry } from '@/store/useConsoleStore';

const make = (overrides: Partial<ConsoleEntry> = {}): ConsoleEntry => ({
  id: overrides.id ?? 'e1',
  timestamp: 1,
  protocol: overrides.protocol ?? 'http',
  request: {
    method: 'GET',
    url: 'https://api.example.com/users/42',
    headers: { 'content-type': 'application/json', 'x-trace': 'abc' },
    ...(overrides.request ?? {}),
  },
  response: {
    id: 'r1',
    requestId: overrides.id ?? 'e1',
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/json' },
    body: '{"ok":true}',
    size: 11,
    time: 100,
    timestamp: 1,
    ...(overrides.response ?? {}),
  },
  ...(overrides.runId !== undefined && { runId: overrides.runId }),
  ...(overrides.runLabel !== undefined && { runLabel: overrides.runLabel }),
  ...(overrides.tests !== undefined && { tests: overrides.tests }),
  ...(overrides.scriptLogs !== undefined && { scriptLogs: overrides.scriptLogs }),
});

describe('parseQuery', () => {
  it('parses plain text', () => {
    expect(parseQuery('users')).toEqual([{ negated: false, value: 'users' }]);
  });

  it('parses key:value with known field', () => {
    expect(parseQuery('status:500')).toEqual([{ negated: false, field: 'status', value: '500' }]);
  });

  it('treats unknown keys as plain text', () => {
    // `weird:foo` has no known key — kept as free-text "weird:foo".
    expect(parseQuery('weird:foo')).toEqual([{ negated: false, value: 'weird:foo' }]);
  });

  it('respects quoted spans', () => {
    expect(parseQuery('"hello world" url:/api')).toEqual([
      { negated: false, value: 'hello world' },
      { negated: false, field: 'url', value: '/api' },
    ]);
  });

  it('negates with leading -', () => {
    const t = parseQuery('-url:health')[0]!;
    expect(t.negated).toBe(true);
    expect(t.field).toBe('url');
    expect(t.value).toBe('health');
  });

  it('compiles regex on value~prefix', () => {
    const t = parseQuery('url:~/users/\\d+')[0]!;
    expect(t.regex).toBeInstanceOf(RegExp);
    expect(t.regex!.test('/users/42')).toBe(true);
    expect(t.regex!.test('/users/x')).toBe(false);
  });

  it('falls back to literal when regex is malformed', () => {
    const t = parseQuery('url:~[')[0]!;
    expect(t.regex).toBeUndefined();
    expect(t.value).toBe('~[');
  });

  it('refuses to compile regex past the length cap (ReDoS guard)', () => {
    // 300 chars of `a` is a valid regex but past the 256-char cap. Refusing
    // to compile keeps a pathological pattern from freezing the renderer.
    const longPat = 'a'.repeat(300);
    const t = parseQuery(`url:~${longPat}`)[0]!;
    expect(t.regex).toBeUndefined();
    expect(t.field).toBe('url');
  });
});

describe('matchesQuery — field tokens', () => {
  const e = make();

  it('status:200 matches exact', () => expect(matchesQuery(e, 'status:200')).toBe(true));
  it('status:5 prefix-matches 5xx', () =>
    expect(matchesQuery(make({ response: { ...e.response, status: 503 } }), 'status:5')).toBe(
      true
    ));
  it('status:5xx matches via class', () =>
    expect(matchesQuery(make({ response: { ...e.response, status: 503 } }), 'status:5xx')).toBe(
      true
    ));
  it('status:errored matches status=0', () =>
    expect(matchesQuery(make({ response: { ...e.response, status: 0 } }), 'status:errored')).toBe(
      true
    ));

  it('method:POST is exact-ish (case-insensitive)', () => {
    const post = make({ request: { ...e.request, method: 'POST' } });
    expect(matchesQuery(post, 'method:POST')).toBe(true);
    expect(matchesQuery(post, 'method:get')).toBe(false);
  });

  it('url:substring matches', () => expect(matchesQuery(e, 'url:users')).toBe(true));
  it('url:~regex matches', () => expect(matchesQuery(e, 'url:~/users/\\d+')).toBe(true));

  it('host: matches the URL host', () => {
    expect(matchesQuery(e, 'host:example.com')).toBe(true);
    expect(matchesQuery(e, 'host:other.com')).toBe(false);
  });

  it('protocol: matches', () => {
    expect(matchesQuery(make({ protocol: 'graphql' }), 'protocol:graphql')).toBe(true);
    expect(matchesQuery(make({ protocol: 'graphql' }), 'protocol:http')).toBe(false);
  });

  it('has:body / has:test / has:script', () => {
    expect(matchesQuery(e, 'has:body')).toBe(true);
    expect(matchesQuery(make({ tests: [{ name: 't', passed: true }] }), 'has:test')).toBe(true);
    expect(
      matchesQuery(
        make({ scriptLogs: [{ type: 'log', message: 'x', timestamp: 1 }] }),
        'has:script'
      )
    ).toBe(true);
  });

  it('has:cookie matches either a request Cookie or a response Set-Cookie', () => {
    const reqCookie = make({
      request: { ...e.request, headers: { cookie: 'sid=abc' } },
    });
    const resCookie = make({
      response: { ...e.response, headers: { 'set-cookie': 'theme=dark; Path=/' } },
    });
    expect(matchesQuery(reqCookie, 'has:cookie')).toBe(true);
    expect(matchesQuery(resCookie, 'has:cookie')).toBe(true);
    expect(matchesQuery(e, 'has:cookie')).toBe(false);
  });

  it('run: matches by runLabel or runId (case-insensitive)', () => {
    const labelled = make({ runId: 'r1', runLabel: 'Smoke' });
    expect(matchesQuery(labelled, 'run:smoke')).toBe(true);
    expect(matchesQuery(labelled, 'run:r1')).toBe(true);
    expect(matchesQuery(labelled, 'run:other')).toBe(false);
  });

  it('partial typing of a field key (`status:`) is treated as a no-op', () => {
    // Mid-typing — the user just typed `status:` and hasn't entered a value
    // yet. The list should NOT empty as a result.
    expect(matchesQuery(e, 'status:')).toBe(true);
    expect(matchesQuery(e, 'method:')).toBe(true);
    expect(matchesQuery(e, 'url:')).toBe(true);
  });
});

describe('matchesQuery — composition', () => {
  const list = [
    make({
      id: 'a',
      request: { ...make().request, method: 'POST', url: 'https://api.example.com/login' },
      response: { ...make().response, status: 200 },
    }),
    make({
      id: 'b',
      request: { ...make().request, method: 'GET', url: 'https://api.example.com/health' },
      response: { ...make().response, status: 200 },
    }),
    make({
      id: 'c',
      request: { ...make().request, method: 'POST', url: 'https://api.example.com/users' },
      response: { ...make().response, status: 500 },
    }),
  ];

  it('ANDs multiple tokens', () => {
    expect(list.filter((e) => matchesQuery(e, 'status:5xx method:POST')).map((e) => e.id)).toEqual([
      'c',
    ]);
  });

  it('negation excludes', () => {
    expect(list.filter((e) => matchesQuery(e, '-url:health')).map((e) => e.id)).toEqual(['a', 'c']);
  });

  it('combines field tokens with free text', () => {
    expect(list.filter((e) => matchesQuery(e, 'POST login')).map((e) => e.id)).toEqual(['a']);
  });

  it('empty query matches everything', () => {
    expect(list.every((e) => matchesQuery(e, ''))).toBe(true);
    expect(list.every((e) => matchesQuery(e, '   '))).toBe(true);
  });
});

describe('filterEntries — multi-criteria', () => {
  const entries = [
    make({ id: 'a', response: { ...make().response, status: 200 } }),
    make({ id: 'b', protocol: 'graphql', response: { ...make().response, status: 500 } }),
    make({ id: 'c', runId: 'run-1', response: { ...make().response, status: 200 } }),
  ];

  it('combines text query + status filter + protocol + run', () => {
    expect(
      filterEntries(entries, {
        query: '',
        statusFilter: '5xx',
        protocolFilter: 'graphql',
        runFilter: 'all',
      }).map((e) => e.id)
    ).toEqual(['b']);
    expect(
      filterEntries(entries, {
        query: '',
        statusFilter: 'all',
        protocolFilter: 'all',
        runFilter: 'run-1',
      }).map((e) => e.id)
    ).toEqual(['c']);
  });
});

describe('statusClassCounts', () => {
  it('buckets entries by class; errored includes status=0 and 5xx', () => {
    const entries = [
      make({ id: 'a', response: { ...make().response, status: 200 } }),
      make({ id: 'b', response: { ...make().response, status: 301 } }),
      make({ id: 'c', response: { ...make().response, status: 404 } }),
      make({ id: 'd', response: { ...make().response, status: 502 } }),
      make({ id: 'e', response: { ...make().response, status: 0 } }),
    ];
    expect(statusClassCounts(entries)).toEqual({
      all: 5,
      '2xx': 1,
      '3xx': 1,
      '4xx': 1,
      '5xx': 1,
      errored: 2,
    });
  });
});

describe('gRPC status classification (issue #371)', () => {
  // gRPC stores its status code in response.status (OK === 0). Without protocol-aware
  // mapping, a successful gRPC call (0) collided with the HTTP "0 = no response" error
  // sentinel and was shown/counted as errored.
  const grpcOk = make({ id: 'ok', protocol: 'grpc', response: { ...make().response, status: 0 } });
  const grpcNotFound = make({
    id: 'nf',
    protocol: 'grpc',
    response: { ...make().response, status: 5 }, // NOT_FOUND → 404
  });
  const grpcInternal = make({
    id: 'int',
    protocol: 'grpc',
    response: { ...make().response, status: 13 }, // INTERNAL → 500
  });

  it('classifies a successful gRPC call (status 0) as 2xx, not errored', () => {
    expect(matchesQuery(grpcOk, 'status:2xx')).toBe(true);
    expect(matchesQuery(grpcOk, 'status:errored')).toBe(false);
    expect(matchesQuery(grpcOk, 'status:200')).toBe(true);
  });

  it('maps gRPC error codes onto their HTTP class', () => {
    expect(matchesQuery(grpcNotFound, 'status:4xx')).toBe(true);
    expect(matchesQuery(grpcNotFound, 'status:errored')).toBe(false);
    expect(matchesQuery(grpcInternal, 'status:5xx')).toBe(true);
    expect(matchesQuery(grpcInternal, 'status:errored')).toBe(true);
  });

  it('counts a successful gRPC call under 2xx, not errored', () => {
    expect(statusClassCounts([grpcOk, grpcNotFound, grpcInternal])).toEqual({
      all: 3,
      '2xx': 1,
      '3xx': 0,
      '4xx': 1,
      '5xx': 1,
      errored: 1,
    });
  });

  it('does not affect HTTP entries — genuine status 0 stays errored', () => {
    const httpFail = make({ response: { ...make().response, status: 0 } });
    expect(matchesQuery(httpFail, 'status:errored')).toBe(true);
  });

  it('free-text search matches the displayed (HTTP-mapped) status, not the raw gRPC code', () => {
    // The list now shows NOT_FOUND (code 5) as "404", so free text follows the
    // display: "404" matches, the raw "5" no longer does.
    expect(matchesQuery(grpcNotFound, '404')).toBe(true);
    expect(matchesQuery(grpcNotFound, '5')).toBe(false);
  });
});

describe('statusMatchesClass (re-exported)', () => {
  it('handles class strings the legacy callers rely on', () => {
    expect(statusMatchesClass(204, '2xx')).toBe(true);
    expect(statusMatchesClass(0, 'errored')).toBe(true);
    expect(statusMatchesClass(404, 'errored')).toBe(false);
    expect(statusMatchesClass(404, '4xx')).toBe(true);
  });
});

describe('sortEntries — pinned-first grouping', () => {
  const withResponse = (id: string, r: Partial<ConsoleEntry['response']>, pinned?: boolean) => ({
    ...make({ id, response: { ...make().response, ...r } }),
    ...(pinned !== undefined && { pinned }),
  });

  it("'recent' keeps arrival order but groups pinned entries first", () => {
    const entries = [
      withResponse('a', {}),
      withResponse('b', {}, true),
      withResponse('c', {}),
      withResponse('d', {}, true),
    ];
    expect(sortEntries(entries, 'recent').map((e) => e.id)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('pinned-first holds under a sort key — pins never scatter', () => {
    const entries = [
      withResponse('slow-unpinned', { time: 900 }),
      withResponse('fast-pinned', { time: 10 }, true),
      withResponse('mid-unpinned', { time: 500 }),
    ];
    // Even though 'time' sorts descending, the pinned entry stays on top.
    expect(sortEntries(entries, 'time').map((e) => e.id)).toEqual([
      'fast-pinned',
      'slow-unpinned',
      'mid-unpinned',
    ]);
  });

  it('sorts within each group by the chosen key', () => {
    const entries = [
      withResponse('p-small', { size: 5 }, true),
      withResponse('u-big', { size: 100 }),
      withResponse('p-big', { size: 50 }, true),
      withResponse('u-small', { size: 1 }),
    ];
    expect(sortEntries(entries, 'size').map((e) => e.id)).toEqual([
      'p-big',
      'p-small',
      'u-big',
      'u-small',
    ]);
  });

  it('does not mutate the input array', () => {
    const entries = [withResponse('a', {}), withResponse('b', {}, true)];
    const ids = entries.map((e) => e.id);
    sortEntries(entries, 'status');
    expect(entries.map((e) => e.id)).toEqual(ids);
  });
});
