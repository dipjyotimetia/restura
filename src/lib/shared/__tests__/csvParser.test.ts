import { describe, expect, it } from 'vitest';
import { isCsvResponse, looksLikeCsv, parseCsv } from '../csvParser';

describe('looksLikeCsv', () => {
  it('detects consistent comma-delimited rows', () => {
    expect(looksLikeCsv('a,b,c\n1,2,3\n4,5,6')).toBe(true);
  });

  it('detects tab-delimited rows', () => {
    expect(looksLikeCsv('a\tb\n1\t2\n3\t4')).toBe(true);
  });

  it('rejects prose', () => {
    expect(looksLikeCsv('Hello there.\nThis is a paragraph of text.')).toBe(false);
  });

  it('rejects a single line', () => {
    expect(looksLikeCsv('a,b,c')).toBe(false);
  });
});

describe('isCsvResponse', () => {
  it('accepts explicit text/csv regardless of body shape', () => {
    expect(isCsvResponse('text/csv; charset=utf-8', 'whatever')).toBe(true);
  });

  it('sniffs text/plain bodies', () => {
    expect(isCsvResponse('text/plain', 'a,b\n1,2')).toBe(true);
    expect(isCsvResponse('text/plain', 'just words here')).toBe(false);
  });

  it('does not sniff JSON responses', () => {
    expect(isCsvResponse('application/json', 'a,b\n1,2')).toBe(false);
  });
});

describe('parseCsv', () => {
  it('splits headers and rows', () => {
    const out = parseCsv('name,age\nAlice,30\nBob,25');
    expect(out.headers).toEqual(['name', 'age']);
    expect(out.rows).toEqual([
      ['Alice', '30'],
      ['Bob', '25'],
    ]);
    expect(out.truncated).toBe(false);
    expect(out.totalRows).toBe(2);
  });

  it('handles quoted fields with embedded commas', () => {
    const out = parseCsv('a,b\n"x, y",z');
    expect(out.rows[0]).toEqual(['x, y', 'z']);
  });
});
