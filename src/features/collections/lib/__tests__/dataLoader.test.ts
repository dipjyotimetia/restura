import { describe, expect, it } from 'vitest';
import { parseDataFile } from '../dataLoader';

describe('parseDataFile', () => {
  it('parses a CSV with a header row into string rows', () => {
    const rows = parseDataFile('name,age\nAda,36\nGrace,40');
    expect(rows).toEqual([
      { name: 'Ada', age: '36' },
      { name: 'Grace', age: '40' },
    ]);
  });

  it('parses a JSON array of objects, coercing values to strings', () => {
    const rows = parseDataFile('[{"id":1,"active":true},{"id":2,"active":false}]');
    expect(rows).toEqual([
      { id: '1', active: 'true' },
      { id: '2', active: 'false' },
    ]);
  });

  it('stringifies nested objects in JSON rows', () => {
    const rows = parseDataFile('[{"meta":{"k":"v"}}]');
    expect(rows[0]!.meta).toBe('{"k":"v"}');
  });

  it('auto-detects JSON vs CSV from the leading character', () => {
    expect(parseDataFile('[{"a":"1"}]')).toEqual([{ a: '1' }]);
    expect(parseDataFile('a\n1')).toEqual([{ a: '1' }]);
  });

  it('returns [] for empty input', () => {
    expect(parseDataFile('   ')).toEqual([]);
  });

  it('throws on non-array JSON', () => {
    expect(() => parseDataFile('{"a":1}', 'json')).toThrow(/array of objects/);
  });
});
