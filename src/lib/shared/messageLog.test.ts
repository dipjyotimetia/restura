import { describe, expect, it } from 'vitest';
import {
  exportLog,
  filteredEmptyText,
  filterLog,
  type LogEntry,
  splitAtCutoff,
} from './messageLog';

const entries: LogEntry[] = [
  { id: '1', timestamp: 0, direction: 'out', label: 'chat', body: '{"msg":"hello"}' },
  { id: '2', timestamp: 1000, direction: 'in', label: 'chat', body: 'plain HELLO' },
  { id: '3', timestamp: 2000, direction: 'system', body: 'Connected' },
];

describe('filterLog', () => {
  it('filters by direction and searches label and body case-insensitively', () => {
    expect(filterLog(entries, { query: '', direction: 'in' }).map((e) => e.id)).toEqual(['2']);
    expect(filterLog(entries, { query: 'hello', direction: 'all' }).map((e) => e.id)).toEqual([
      '1',
      '2',
    ]);
    expect(filterLog(entries, { query: 'CHAT', direction: 'out' }).map((e) => e.id)).toEqual(['1']);
    expect(filterLog(entries, { query: '  ', direction: 'all' })).toHaveLength(3);
  });
});

describe('exportLog', () => {
  it('writes NDJSON with JSON payloads embedded as values', () => {
    const lines = exportLog(entries, 'ndjson')
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines[0]).toEqual({
      timestamp: '1970-01-01T00:00:00.000Z',
      direction: 'out',
      label: 'chat',
      payload: { msg: 'hello' },
    });
    expect(lines[2]).toEqual({
      timestamp: '1970-01-01T00:00:02.000Z',
      direction: 'system',
      payload: 'Connected',
    });
  });

  it('writes a JSON document with metadata and a count, keeping invalid JSON as text', () => {
    const doc = JSON.parse(
      exportLog([{ id: 'x', timestamp: 0, direction: 'in', body: '{oops' }], 'json', {
        url: 'wss://x',
      })
    );
    expect(doc).toMatchObject({ url: 'wss://x', count: 1, messages: [{ payload: '{oops' }] });
    expect(typeof doc.exportedAt).toBe('string');
  });
});

describe('splitAtCutoff', () => {
  it('shows entries up to the cutoff and counts the rest; null is live', () => {
    const at1000 = splitAtCutoff(entries, 1000);
    expect(at1000.visible.map((e) => e.id)).toEqual(['1', '2']);
    expect(at1000.newCount).toBe(1);
    expect(splitAtCutoff(entries, null)).toEqual({ visible: entries, newCount: 0 });
  });
});

describe('filteredEmptyText', () => {
  it('blames the freeze, not the filter, when matches arrived after it', () => {
    expect(filteredEmptyText('message', 0)).toBe('No messages match the current filter.');
    expect(filteredEmptyText('event', 1)).toBe('Frozen — 1 new event since. Resume to show it.');
    expect(filteredEmptyText('message', 3)).toBe(
      'Frozen — 3 new messages since. Resume to show them.'
    );
  });
});
