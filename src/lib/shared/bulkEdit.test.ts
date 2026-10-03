import { describe, expect, it } from 'vitest';
import type { KeyValue } from '@/types';
import { fromBulkText, toBulkText } from './bulkEdit';

const rows: KeyValue[] = [
  { id: 'a', key: 'Accept', value: 'application/json', enabled: true, description: 'fmt' },
  { id: 'b', key: 'X-Debug', value: '1', enabled: false },
  { id: 'c', key: '', value: '', enabled: true },
];

let n = 0;
const makeId = () => `new-${++n}`;

describe('bulk edit', () => {
  it('serializes rows, marking disabled ones and skipping blanks', () => {
    expect(toBulkText(rows)).toBe('Accept: application/json\n//X-Debug: 1');
  });

  it('parses lines, keeping ids and descriptions of rows with the same key', () => {
    const out = fromBulkText(
      'Accept: text/html\n// X-Debug: 2\nAuthorization: Bearer {{token}}:x\n\n  : nokey\nFlag',
      rows,
      makeId
    );
    expect(out).toEqual([
      { id: 'a', key: 'Accept', value: 'text/html', enabled: true, description: 'fmt' },
      { id: 'b', key: 'X-Debug', value: '2', enabled: false },
      { id: 'new-1', key: 'Authorization', value: 'Bearer {{token}}:x', enabled: true },
      { id: 'new-2', key: 'Flag', value: '', enabled: true },
    ]);
  });

  it('round-trips', () => {
    const kept = rows.slice(0, 2);
    expect(fromBulkText(toBulkText(kept), kept, makeId)).toEqual(kept);
  });
});
