import { describe, expect, it } from 'vitest';
import { parseGrpcMessageJson } from './grpc-json';

describe('parseGrpcMessageJson', () => {
  it('keeps integers beyond Number.MAX_SAFE_INTEGER exact (as proto3 JSON strings)', () => {
    expect(parseGrpcMessageJson('{"big": 9007199254740993}')).toEqual({
      big: '9007199254740993',
    });
    expect(parseGrpcMessageJson('{"neg": -9223372036854775808}')).toEqual({
      neg: '-9223372036854775808',
    });
    expect(parseGrpcMessageJson('[18446744073709551615, 1]')).toEqual(['18446744073709551615', 1]);
  });

  it('leaves safe integers, floats and strings untouched', () => {
    expect(
      parseGrpcMessageJson(
        '{"n": 42, "max": 9007199254740991, "f": 1.5e300, "s": "9007199254740993", "esc": "a\\"99999999999999999999"}'
      )
    ).toEqual({
      n: 42,
      max: 9007199254740991,
      f: 1.5e300,
      s: '9007199254740993',
      esc: 'a"99999999999999999999',
    });
  });

  it('still throws on invalid JSON', () => {
    expect(() => parseGrpcMessageJson('{"a": }')).toThrow(SyntaxError);
  });
});
