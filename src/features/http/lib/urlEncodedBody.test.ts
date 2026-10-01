import { describe, expect, it } from 'vitest';
import { parseUrlEncoded, serializeUrlEncoded } from './urlEncodedBody';

describe('urlencoded body', () => {
  it('parses pairs, decoding escapes and "+" as space', () => {
    expect(parseUrlEncoded('a=1&b=two+words&c=x%26y&flag&bad=%E0%A4%A')).toEqual([
      { key: 'a', value: '1' },
      { key: 'b', value: 'two words' },
      { key: 'c', value: 'x&y' },
      { key: 'flag', value: '' },
      { key: 'bad', value: '%E0%A4%A' },
    ]);
    expect(parseUrlEncoded('  ')).toEqual([]);
  });

  it('encodes special characters but leaves {{vars}} intact, dropping empty rows', () => {
    expect(
      serializeUrlEncoded([
        { key: 'q', value: 'a b&c' },
        { key: 'tok', value: 'Bearer {{token}}!' },
        { key: '', value: '' },
      ])
    ).toBe('q=a%20b%26c&tok=Bearer%20{{token}}!');
  });

  it('round-trips', () => {
    const fields = [
      { key: 'name', value: 'Ada Lovelace' },
      { key: 'id', value: '{{id}}' },
    ];
    expect(parseUrlEncoded(serializeUrlEncoded(fields))).toEqual(fields);
  });
});
