import { describe, expect, it } from 'vitest';
import { jsonLosesPrecision, reformatJsonLossless } from './lossless-json';

describe('reformatJsonLossless', () => {
  it('re-prints JSON keeping integer literals beyond 2^53', () => {
    expect(
      reformatJsonLossless('{ "id": 9007199254740993, "n": [-18446744073709551615, 1.5] }')
    ).toBe('{"id":9007199254740993,"n":[-18446744073709551615,1.5]}');
    expect(reformatJsonLossless('{"id":9007199254740993}', 2)).toBe(
      '{\n  "id": 9007199254740993\n}'
    );
    expect(reformatJsonLossless('{"s":"9007199254740993 in a string","d":1e21}')).toBe(
      '{"s":"9007199254740993 in a string","d":1e+21}'
    );
    expect(reformatJsonLossless('[1, 2]', 0)).toBe('[1,2]');
    expect(() => reformatJsonLossless('{nope')).toThrow();
  });

  it('detects when a plain parse would round', () => {
    expect(jsonLosesPrecision('{"id":9007199254740993}')).toBe(true);
    expect(jsonLosesPrecision('{"id":9007199254740991}')).toBe(false);
    expect(jsonLosesPrecision('{"id":"9007199254740993"}')).toBe(false);
    expect(jsonLosesPrecision('{"d":1e21}')).toBe(false);
    expect(jsonLosesPrecision('nope 9007199254740993')).toBe(false);
  });
});
