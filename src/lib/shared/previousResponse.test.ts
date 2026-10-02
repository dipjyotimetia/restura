import { describe, expect, it } from 'vitest';
import type { HistoryItem, HttpRequest, Response } from '@/types';
import { prettyForDiff, previousHistoryItem, toCompareEntry } from './previousResponse';

const request = (id: string): HttpRequest => ({
  id,
  name: 'r',
  type: 'http',
  method: 'POST',
  url: 'https://{{host}}/x',
  headers: [
    { id: 'h', key: 'X-A', value: '1', enabled: true },
    { id: 'h2', key: 'X-Off', value: '2', enabled: false },
  ],
  params: [{ id: 'p', key: 'q', value: '1', enabled: true }],
  body: { type: 'json', raw: '{"a":1}' },
  auth: { type: 'none' },
});
const response = (id: string, timestamp: number): Response => ({
  id,
  requestId: 'r1',
  status: 200,
  statusText: 'OK',
  headers: {},
  body: id,
  size: 2,
  time: 5,
  timestamp,
});
const item = (reqId: string, res?: Response): HistoryItem => ({
  id: `h-${res?.id ?? 'none'}-${reqId}`,
  request: request(reqId),
  ...(res ? { response: res } : {}),
  timestamp: res?.timestamp ?? 0,
});

describe('previousHistoryItem', () => {
  // newest first, as the history store keeps it
  const history = [
    item('r1', response('c', 300)),
    item('other', response('o', 250)),
    item('r1'),
    item('r1', response('b', 200)),
    item('r1', response('a', 100)),
  ];

  it('finds the response before the current one for the same request', () => {
    expect(previousHistoryItem(history, 'r1', { id: 'c', timestamp: 300 })?.response?.id).toBe('b');
    expect(previousHistoryItem(history, 'r1', { id: 'b', timestamp: 200 })?.response?.id).toBe('a');
  });

  it('returns undefined with nothing earlier for that request', () => {
    expect(previousHistoryItem(history, 'r1', { id: 'a', timestamp: 100 })).toBeUndefined();
    expect(previousHistoryItem(history, 'missing', { id: 'x', timestamp: 999 })).toBeUndefined();
  });
});

describe('toCompareEntry', () => {
  it('maps the request (enabled headers, raw body) and response', () => {
    const res = response('c', 300);
    const entry = toCompareEntry(
      { id: 'e', request: request('r1'), timestamp: 300, resolvedUrl: 'https://api.dev/x' },
      res
    );
    expect(entry).toEqual({
      id: 'e',
      timestamp: 300,
      protocol: 'http',
      request: {
        method: 'POST',
        url: 'https://api.dev/x?q=1',
        headers: { 'X-A': '1' },
        body: '{"a":1}',
      },
      response: res,
    });
  });

  it('pretty-prints JSON bodies for a line diff and passes others through', () => {
    expect(prettyForDiff('{"a":1,"b":[2]}')).toBe('{\n  "a": 1,\n  "b": [\n    2\n  ]\n}');
    expect(prettyForDiff('  [1]')).toBe('[\n  1\n]');
    expect(prettyForDiff('plain text')).toBe('plain text');
    expect(prettyForDiff('{broken')).toBe('{broken');
    const huge = `[${'1,'.repeat(600_000)}1]`;
    expect(prettyForDiff(huge)).toBe(huge);
  });
});
