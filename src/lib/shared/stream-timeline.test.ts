import { describe, expect, it } from 'vitest';
import {
  appendToTimeline,
  buildTimelineJsonl,
  compileTimelineSearch,
  estimateEventBytes,
  filterTimeline,
  formatDelta,
  normalizeStreamEvent,
  type StreamEvent,
  type StreamEventInput,
  validateTimelineRegex,
} from './stream-timeline';

let seq = 0;
function ev(partial: Partial<StreamEventInput> = {}): StreamEvent {
  seq += 1;
  return normalizeStreamEvent(
    {
      protocol: 'websocket',
      connectionId: 'c1',
      direction: 'in',
      payload: 'hello',
      ts: 1_000 + seq,
      ...partial,
    },
    seq
  );
}

describe('normalizeStreamEvent', () => {
  it('fills defaults, drops undefined meta and truncates huge payloads', () => {
    const e = normalizeStreamEvent(
      {
        protocol: 'mqtt',
        connectionId: 'm',
        direction: 'system',
        payload: 'x'.repeat(70 * 1024),
        meta: { qos: 1, retain: false, skip: undefined },
      },
      7
    );
    expect(e.kind).toBe('system');
    expect(e.seq).toBe(7);
    expect(e.meta).toEqual({ qos: 1, retain: false });
    expect(e.truncated).toBe(true);
    expect(e.payload.length).toBeLessThan(70 * 1024);
    expect(e.size).toBe(70 * 1024);
    expect(typeof e.ts).toBe('number');
  });

  it('redacts credential-looking tokens in payload and label', () => {
    const e = normalizeStreamEvent(
      {
        protocol: 'websocket',
        connectionId: 'c',
        direction: 'out',
        label: 'sid=abc123',
        payload: '{"password":"hunter2","ok":true}',
      },
      1
    );
    expect(e.payload).not.toContain('hunter2');
    expect(e.label).not.toContain('abc123');
    expect(e.kind).toBe('message');
  });
});

describe('appendToTimeline', () => {
  it('evicts oldest events once the byte cap is exceeded', () => {
    const big = 'y'.repeat(1000);
    const events = Array.from({ length: 20 }, () => ev({ payload: big }));
    const perEvent = estimateEventBytes(events[0]!);
    const cap = perEvent * 5;
    const state = appendToTimeline({ events: [], totalBytes: 0, evicted: 0 }, events, {
      maxEvents: 1000,
      maxBytes: cap,
    });
    expect(state.events).toHaveLength(5);
    expect(state.totalBytes).toBeLessThanOrEqual(cap);
    expect(state.evicted).toBe(15);
    expect(state.events[0]!.seq).toBe(events[15]!.seq);
  });

  it('evicts by count too, across successive appends', () => {
    let state = { events: [] as StreamEvent[], totalBytes: 0, evicted: 0 };
    for (let i = 0; i < 4; i++) {
      state = appendToTimeline(state, [ev(), ev(), ev()], { maxEvents: 5, maxBytes: 1e9 });
    }
    expect(state.events).toHaveLength(5);
    expect(state.evicted).toBe(7);
    const sum = state.events.reduce((n, e) => n + estimateEventBytes(e), 0);
    expect(state.totalBytes).toBe(sum);
  });

  it('returns the same state for an empty batch', () => {
    const state = { events: [ev()], totalBytes: 10, evicted: 0 };
    expect(appendToTimeline(state, [], { maxEvents: 5, maxBytes: 100 })).toBe(state);
  });
});

describe('validateTimelineRegex', () => {
  it('accepts simple patterns', () => {
    expect(validateTimelineRegex('order-\\d+')).toBeNull();
    expect(validateTimelineRegex('(foo|bar)\\s')).toBeNull();
  });

  it('rejects nested quantifiers and quantified alternation (catastrophic backtracking)', () => {
    expect(validateTimelineRegex('(a+)+$')).toMatch(/nested/i);
    expect(validateTimelineRegex('(.*)*x')).toMatch(/nested/i);
    expect(validateTimelineRegex('(a|aa)+')).toMatch(/nested|alternation/i);
    expect(validateTimelineRegex('(\\w{2,})*')).toMatch(/nested/i);
  });

  it('rejects backreferences, overly long and syntactically invalid patterns', () => {
    expect(validateTimelineRegex('(a)\\1')).toMatch(/backreference/i);
    expect(validateTimelineRegex('a'.repeat(300))).toMatch(/long/i);
    expect(validateTimelineRegex('([')).toMatch(/invalid/i);
  });

  it('ignores quantifier characters inside classes but catches nested quantified groups', () => {
    expect(validateTimelineRegex('[(+*]+ok')).toBeNull();
    expect(validateTimelineRegex('((ab)+c)+')).toMatch(/nested/i);
    expect(validateTimelineRegex('((ab)c)+')).toBeNull();
  });
});

describe('compileTimelineSearch', () => {
  const ws = ev({ payload: '{"type":"order","id":42}', label: 'orders' });
  const mq = ev({ protocol: 'mqtt', payload: 'temp=21', label: 'sensors/1' });

  it('matches everything for an empty query', () => {
    const r = compileTimelineSearch('text', '  ');
    expect(r.ok && r.match(ws) && r.match(mq)).toBe(true);
  });

  it('text search is case-insensitive over payload, label and connection', () => {
    const r = compileTimelineSearch('text', 'SENSORS');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.match(mq)).toBe(true);
    expect(r.match(ws)).toBe(false);
  });

  it('regex search compiles safe patterns and reports unsafe ones', () => {
    const r = compileTimelineSearch('regex', '"id":\\d{2}');
    expect(r.ok && r.match(ws)).toBe(true);
    expect(r.ok && r.match(mq)).toBe(false);
    const bad = compileTimelineSearch('regex', '(a+)+');
    expect(bad.ok).toBe(false);
  });

  it('jsonpath search matches events whose JSON payload yields a result', () => {
    const r = compileTimelineSearch('jsonpath', '$[?(@.id > 40)]');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Filter expressions apply to children; wrap so a top-level object works.
    const byField = compileTimelineSearch('jsonpath', '$.type');
    expect(byField.ok && byField.match(ws)).toBe(true);
    expect(byField.ok && byField.match(mq)).toBe(false);
  });

  it('jsonpath rejects paths not rooted at $', () => {
    expect(compileTimelineSearch('jsonpath', 'type').ok).toBe(false);
  });

  it('jsonpath reports syntax errors and never matches non-JSON or truncated payloads', () => {
    const bad = compileTimelineSearch('jsonpath', '$[?(@.a ==)]');
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.error).toMatch(/Invalid JSONPath/);
    const r = compileTimelineSearch('jsonpath', '$.n');
    if (!r.ok) throw new Error('compile');
    expect(r.match(ev({ payload: '{"n":' }))).toBe(false); // malformed JSON
    expect(r.match(ev({ payload: 'null' }))).toBe(false);
    const json = ev({ payload: '{"n":1}' });
    expect(r.match(json)).toBe(true);
    expect(r.match(json)).toBe(true); // cached parse
    const truncated = { ...ev({ payload: '{"n":1}' }), truncated: true };
    expect(r.match(truncated)).toBe(false);
  });
});

describe('filterTimeline', () => {
  it('filters by protocol set, connection and search', () => {
    const a = ev({ protocol: 'websocket', connectionId: 'w1', payload: 'cmd start' });
    const b = ev({ protocol: 'mqtt', connectionId: 'm1', payload: 'started' });
    const c = ev({ protocol: 'kafka', connectionId: 'k1', payload: 'start-event' });
    const all = [a, b, c];
    const search = compileTimelineSearch('text', 'start');
    if (!search.ok) throw new Error('search');
    expect(
      filterTimeline(all, {
        protocols: new Set(['websocket', 'mqtt']),
        connectionId: 'all',
        match: search.match,
      })
    ).toEqual([a, b]);
    expect(
      filterTimeline(all, { protocols: null, connectionId: 'k1', match: search.match })
    ).toEqual([c]);
  });
});

describe('buildTimelineJsonl', () => {
  it('emits one JSON object per line with an ISO timestamp', () => {
    const a = ev({ protocol: 'sse', payload: 'p1', label: 'tick', meta: { lastEventId: '9' } });
    const b = ev({ protocol: 'kafka', payload: 'p2' });
    const out = buildTimelineJsonl([a, b]);
    const lines = out.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!);
    expect(first).toMatchObject({
      protocol: 'sse',
      connectionId: 'c1',
      direction: 'in',
      kind: 'message',
      label: 'tick',
      payload: 'p1',
      meta: { lastEventId: '9' },
    });
    expect(first.time).toBe(new Date(a.ts).toISOString());
    expect(first.id).toBeUndefined();
    expect(out.endsWith('\n')).toBe(true);
    expect(buildTimelineJsonl([])).toBe('');
    const big = ev({ payload: 'q'.repeat(70 * 1024) });
    expect(JSON.parse(buildTimelineJsonl([big]))).toMatchObject({ truncated: true });
  });
});

describe('formatDelta', () => {
  it('formats ms, seconds and minutes with a sign', () => {
    expect(formatDelta(12)).toBe('+12ms');
    expect(formatDelta(-1500)).toBe('-1.50s');
    expect(formatDelta(90_000)).toBe('+1.5m');
  });
});
