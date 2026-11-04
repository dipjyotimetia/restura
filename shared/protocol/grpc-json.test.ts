import { describe, expect, it } from 'vitest';
import { parseGrpcMessageJson } from './grpc-json';
import { inputFromJson, outputToJson, registryFromProtoText, resolveMethod } from './grpc-registry';

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

describe('parseGrpcMessageJson with an input schema', () => {
  const registry = registryFromProtoText(`syntax = "proto3";
package t;
import "google/protobuf/struct.proto";
import "google/protobuf/wrappers.proto";
message Inner { int64 id = 1; double score = 2; }
message R {
  google.protobuf.Struct st = 1;
  google.protobuf.Value v = 2;
  double d = 3;
  int64 big = 4;
  repeated uint64 ids = 5;
  map<string, sint64> counts = 6;
  Inner inner = 7;
  repeated Inner inners = 8;
  google.protobuf.ListValue lv = 9;
  google.protobuf.Int64Value wrapped = 10;
  fixed64 snake_case_id = 11;
}
service S { rpc M(R) returns (R); }`);
  const { method } = resolveMethod(registry, 't.S', 'M');
  const roundTrip = (text: string) =>
    outputToJson(method, inputFromJson(method, parseGrpcMessageJson(text, method.input))) as Record<
      string,
      unknown
    >;

  it('keeps Struct / Value / ListValue / double numbers as numbers', () => {
    const out = roundTrip(
      '{"st":{"n":12345678901234567890},"v":9007199254740993,"lv":[9007199254740993],"d":12345678901234567890,"inner":{"score":9007199254740993}}'
    );
    expect(out.st).toEqual({ n: 12345678901234567890 });
    expect(out.v).toBe(9007199254740993);
    expect(out.lv).toEqual([9007199254740993]);
    expect(out.d).toBe(12345678901234567890);
    expect((out.inner as Record<string, unknown>).score).toBe(9007199254740993);
  });

  it('keeps every int64-family position exact', () => {
    const out = roundTrip(
      '{"big":9007199254740993,"ids":[18446744073709551615],"counts":{"a":-9223372036854775808},"inner":{"id":9007199254740993},"inners":[{"id":9007199254740995}],"wrapped":9007199254740993,"snake_case_id":18446744073709551615}'
    );
    expect(out.big).toBe('9007199254740993');
    expect(out.ids).toEqual(['18446744073709551615']);
    expect(out.counts).toEqual({ a: '-9223372036854775808' });
    expect(out.inner).toMatchObject({ id: '9007199254740993' });
    expect(out.inners).toEqual([expect.objectContaining({ id: '9007199254740995' })]);
    expect(out.wrapped).toBe('9007199254740993');
    expect(out.snakeCaseId).toBe('18446744073709551615');
  });

  it('applies the schema to each message of a top-level array (stream body)', () => {
    expect(
      parseGrpcMessageJson('[{"big":9007199254740993,"v":9007199254740993}]', method.input)
    ).toEqual([{ big: '9007199254740993', v: 9007199254740993 }]);
  });

  it('only consults a lazy schema getter when an unsafe integer is present', () => {
    let calls = 0;
    const getter = () => {
      calls++;
      return method.input;
    };
    expect(parseGrpcMessageJson('{"big":1}', getter)).toEqual({ big: 1 });
    expect(calls).toBe(0);
    expect(parseGrpcMessageJson('{"v":9007199254740993}', getter)).toEqual({
      v: 9007199254740993,
    });
    expect(calls).toBe(1);
  });

  it('keeps user-written strings and unknown keys untouched', () => {
    expect(
      parseGrpcMessageJson('{"st":{"s":"9007199254740993"},"nope":9007199254740993}', method.input)
    ).toEqual({ st: { s: '9007199254740993' }, nope: '9007199254740993' });
  });
});
