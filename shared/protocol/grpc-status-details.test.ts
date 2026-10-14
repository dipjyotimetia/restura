import { create, toBinary } from '@bufbuild/protobuf';
import { BinaryWriter, base64Encode } from '@bufbuild/protobuf/wire';
import { describe, expect, it } from 'vitest';
import { registryFromProtoText } from './grpc-registry';
import {
  connectErrorDetails,
  decodeStatusDetail,
  MAX_STATUS_DETAILS,
  statusDetailsFromConnectJson,
  statusDetailsFromStatusBin,
  typeNameFromUrl,
} from './grpc-status-details';

// A real schema for the google.rpc types, so fixtures are encoded by bufbuild
// (not by a hand-rolled writer that could share the decoder's mistakes).
const ERROR_DETAILS_PROTO = `
syntax = "proto3";
package google.rpc;
// map<string,string> is spelled as its wire-identical repeated entry message:
// registryFromProtoText can't build map fields today.
message ErrorInfo {
  message MetadataEntry { string key = 1; string value = 2; }
  string reason = 1; string domain = 2; repeated MetadataEntry metadata = 3;
}
message BadRequest {
  message FieldViolation {
    string field = 1; string description = 2; string reason = 3; LocalizedMessage localized_message = 4;
  }
  repeated FieldViolation field_violations = 1;
}
message LocalizedMessage { string locale = 1; string message = 2; }
message QuotaFailure {
  message Violation { string subject = 1; string description = 2; int64 quota_value = 7; }
  repeated Violation violations = 1;
}
message Help { message Link { string description = 1; string url = 2; } repeated Link links = 1; }
`;
const rpcRegistry = registryFromProtoText(ERROR_DETAILS_PROTO);

function encode(typeName: string, init: Record<string, unknown>): Uint8Array {
  const desc = rpcRegistry.getMessage(typeName);
  if (!desc) throw new Error(`fixture type ${typeName} missing`);
  return toBinary(desc, create(desc, init as never));
}

function badRequestBytes(): Uint8Array {
  return encode('google.rpc.BadRequest', {
    fieldViolations: [
      { field: 'user.email', description: 'must be a valid email', reason: 'INVALID_FORMAT' },
      {
        field: 'user.tags[1]',
        description: 'too long',
        localizedMessage: { locale: 'en-US', message: 'Too long' },
      },
    ],
  });
}

describe('decodeStatusDetail — well-known google.rpc types', () => {
  it('decodes BadRequest field violations (incl. nested LocalizedMessage)', () => {
    const d = decodeStatusDetail('type.googleapis.com/google.rpc.BadRequest', badRequestBytes());
    expect(d).toEqual({
      type: 'google.rpc.BadRequest',
      value: {
        fieldViolations: [
          { field: 'user.email', description: 'must be a valid email', reason: 'INVALID_FORMAT' },
          {
            field: 'user.tags[1]',
            description: 'too long',
            localizedMessage: { locale: 'en-US', message: 'Too long' },
          },
        ],
      },
    });
  });

  it('decodes ErrorInfo with its metadata map', () => {
    const bytes = encode('google.rpc.ErrorInfo', {
      reason: 'API_DISABLED',
      domain: 'googleapis.com',
      metadata: [
        { key: 'service', value: 'pubsub.googleapis.com' },
        { key: 'consumer', value: 'projects/123' },
      ],
    });
    expect(decodeStatusDetail('google.rpc.ErrorInfo', bytes).value).toEqual({
      reason: 'API_DISABLED',
      domain: 'googleapis.com',
      metadata: { service: 'pubsub.googleapis.com', consumer: 'projects/123' },
    });
  });

  it('decodes RetryInfo durations in proto3 JSON form', () => {
    const duration = (seconds: number, nanos: number) => {
      const inner = new BinaryWriter();
      if (seconds) inner.tag(1, 0).int64(seconds);
      if (nanos) inner.tag(2, 0).int32(nanos);
      return new BinaryWriter().tag(1, 2).bytes(inner.finish()).finish();
    };
    expect(decodeStatusDetail('google.rpc.RetryInfo', duration(2, 0)).value).toEqual({
      retryDelay: '2s',
    });
    expect(decodeStatusDetail('google.rpc.RetryInfo', duration(1, 500_000_000)).value).toEqual({
      retryDelay: '1.500s',
    });
    expect(decodeStatusDetail('google.rpc.RetryInfo', duration(0, 1)).value).toEqual({
      retryDelay: '0.000000001s',
    });
  });

  it('renders 64-bit ints as strings (QuotaFailure.quota_value) and repeated messages (Help)', () => {
    const quota = encode('google.rpc.QuotaFailure', {
      violations: [{ subject: 'project:1', description: 'daily limit', quotaValue: 100n }],
    });
    expect(decodeStatusDetail('google.rpc.QuotaFailure', quota).value).toEqual({
      violations: [{ subject: 'project:1', description: 'daily limit', quotaValue: '100' }],
    });
    const help = encode('google.rpc.Help', {
      links: [{ description: 'docs', url: 'https://example.com' }],
    });
    expect(decodeStatusDetail('google.rpc.Help', help).value).toEqual({
      links: [{ description: 'docs', url: 'https://example.com' }],
    });
  });

  it('falls back to raw base64 for an unknown Any', () => {
    const bytes = new Uint8Array([8, 1, 18, 2, 104, 105]);
    expect(decodeStatusDetail('type.googleapis.com/acme.v1.Custom', bytes)).toEqual({
      type: 'acme.v1.Custom',
      raw: base64Encode(bytes),
    });
  });

  it('decodes a non-google type through the caller registry', () => {
    const registry = registryFromProtoText(
      'syntax = "proto3"; package acme.v1; message Custom { int32 code = 1; string note = 2; }'
    );
    const bytes = new Uint8Array([8, 7, 18, 2, 104, 105]);
    expect(decodeStatusDetail('acme.v1.Custom', bytes, { registry }).value).toEqual({
      code: 7,
      note: 'hi',
    });
  });

  it('falls back to raw when well-known bytes are malformed (never throws)', () => {
    const garbage = new Uint8Array([0x0a, 0xff]); // LEN field claiming 255 bytes
    const d = decodeStatusDetail('google.rpc.BadRequest', garbage);
    expect(d.type).toBe('google.rpc.BadRequest');
    expect(d.value).toBeUndefined();
    expect(d.raw).toBe(base64Encode(garbage));
  });
});

describe('statusDetailsFromConnectJson', () => {
  it('decodes Connect error JSON details (unpadded base64) and keeps debug', () => {
    const value = base64Encode(badRequestBytes()).replace(/=+$/, '');
    const out = statusDetailsFromConnectJson([
      { type: 'google.rpc.BadRequest', value, debug: { note: 'server-side' } },
      { type: 'acme.v1.Unknown', value: 'AQI' },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]?.type).toBe('google.rpc.BadRequest');
    expect(out[0]?.debug).toEqual({ note: 'server-side' });
    expect((out[0]?.value as { fieldViolations: unknown[] }).fieldViolations).toHaveLength(2);
    expect(out[1]).toEqual({ type: 'acme.v1.Unknown', raw: 'AQI=' });
  });

  it('ignores non-arrays and malformed entries, and caps the list', () => {
    expect(statusDetailsFromConnectJson(undefined)).toEqual([]);
    expect(statusDetailsFromConnectJson({})).toEqual([]);
    expect(statusDetailsFromConnectJson([null, 1, { value: 'AA' }])).toEqual([]);
    const many = Array.from({ length: MAX_STATUS_DETAILS + 5 }, () => ({ type: 'x.Y', value: '' }));
    expect(statusDetailsFromConnectJson(many)).toHaveLength(MAX_STATUS_DETAILS);
  });
});

describe('connectErrorDetails', () => {
  it('decodes incoming details (connect-node / connect-web shape)', () => {
    const out = connectErrorDetails({
      details: [{ type: 'google.rpc.BadRequest', value: badRequestBytes(), debug: { a: 1 } }],
    });
    expect(out?.[0]?.type).toBe('google.rpc.BadRequest');
    expect(out?.[0]?.debug).toEqual({ a: 1 });
  });

  it('renders outgoing { desc, value } details directly', () => {
    const desc = rpcRegistry.getMessage('google.rpc.ErrorInfo');
    if (!desc) throw new Error('missing');
    const out = connectErrorDetails({ details: [{ desc, value: { reason: 'R' } }] });
    expect(out).toEqual([{ type: 'google.rpc.ErrorInfo', value: { reason: 'R' } }]);
  });

  it('returns undefined when the error has no details', () => {
    expect(connectErrorDetails({ details: [] })).toBeUndefined();
  });
});

describe('statusDetailsFromStatusBin (grpc-status-details-bin)', () => {
  it('unpacks google.rpc.Status → Any → decoded details', () => {
    const any = new BinaryWriter()
      .tag(1, 2)
      .string('type.googleapis.com/google.rpc.BadRequest')
      .tag(2, 2)
      .bytes(badRequestBytes())
      .finish();
    const status = new BinaryWriter()
      .tag(1, 0)
      .int32(3)
      .tag(2, 2)
      .string('bad')
      .tag(3, 2)
      .bytes(any)
      .finish();
    const out = statusDetailsFromStatusBin(base64Encode(status));
    expect(out).toHaveLength(1);
    expect(out[0]?.type).toBe('google.rpc.BadRequest');
  });

  it('returns [] for absent or malformed values', () => {
    expect(statusDetailsFromStatusBin(undefined)).toEqual([]);
    expect(statusDetailsFromStatusBin('Gv8=')).toEqual([]);
  });
});

describe('typeNameFromUrl', () => {
  it('strips any type-url prefix', () => {
    expect(typeNameFromUrl('type.googleapis.com/google.rpc.Help')).toBe('google.rpc.Help');
    expect(typeNameFromUrl('google.rpc.Help')).toBe('google.rpc.Help');
  });
});

describe('wire-level robustness of the well-known decoder', () => {
  const retry = (inner: Uint8Array) => new BinaryWriter().tag(1, 2).bytes(inner).finish();

  it('formats negative and microsecond-precision RetryInfo delays', () => {
    const negative = new BinaryWriter().tag(1, 0).int64(-1).tag(2, 0).int32(-500_000_000).finish();
    expect(decodeStatusDetail('google.rpc.RetryInfo', retry(negative)).value).toEqual({
      retryDelay: '-1.500s',
    });
    const micros = new BinaryWriter().tag(2, 0).int32(1_500).finish();
    expect(decodeStatusDetail('google.rpc.RetryInfo', retry(micros)).value).toEqual({
      retryDelay: '0.000001500s',
    });
    const fractional = new BinaryWriter().tag(2, 0).int32(250_000).finish();
    expect(decodeStatusDetail('google.rpc.RetryInfo', retry(fractional)).value).toEqual({
      retryDelay: '0.000250s',
    });
  });

  it('skips fields from newer schemas at every nesting level', () => {
    const duration = new BinaryWriter().tag(1, 0).int64(3).tag(9, 0).int32(1).finish();
    const withUnknown = new BinaryWriter()
      .tag(1, 2)
      .bytes(duration)
      .tag(15, 2)
      .string('future field')
      .finish();
    expect(decodeStatusDetail('google.rpc.RetryInfo', withUnknown).value).toEqual({
      retryDelay: '3s',
    });
    const entry = new BinaryWriter()
      .tag(1, 2)
      .string('k')
      .tag(3, 0)
      .int32(1)
      .tag(2, 2)
      .string('v')
      .finish();
    const errorInfo = new BinaryWriter().tag(3, 2).bytes(entry).finish();
    expect(decodeStatusDetail('google.rpc.ErrorInfo', errorInfo).value).toEqual({
      metadata: { k: 'v' },
    });
  });

  it('falls back to raw when a known field arrives with the wrong wire type', () => {
    const wrongWire = new BinaryWriter().tag(1, 0).int32(7).finish(); // reason as varint
    expect(decodeStatusDetail('google.rpc.ErrorInfo', wrongWire)).toEqual({
      type: 'google.rpc.ErrorInfo',
      raw: base64Encode(wrongWire),
    });
  });
});

describe('detail envelopes with missing or malformed parts', () => {
  it('treats a Connect JSON detail with no value as an empty message', () => {
    expect(statusDetailsFromConnectJson([{ type: 'google.rpc.ErrorInfo' }])).toEqual([
      { type: 'google.rpc.ErrorInfo', value: {} },
    ]);
  });

  it('keeps undecodable base64 as raw text, with debug when present', () => {
    expect(
      statusDetailsFromConnectJson([
        { type: 'type.googleapis.com/acme.v1.X', value: '%%%', debug: { trace: 1 } },
        { type: 'acme.v1.Y', value: '%%%' },
      ])
    ).toEqual([
      { type: 'acme.v1.X', raw: '%%%', debug: { trace: 1 } },
      { type: 'acme.v1.Y', raw: '%%%' },
    ]);
  });

  it('drops ConnectError entries that are neither packed nor descriptor-backed', () => {
    expect(
      connectErrorDetails({
        details: [
          { type: 42, value: new Uint8Array() },
          { type: 'google.rpc.Help', value: 'not-bytes' },
        ],
      })
    ).toBeUndefined();
  });

  it('skips unknown Status/Any fields, untyped Anys, and details past the cap', () => {
    const anyOf = (typeUrl: string) =>
      new BinaryWriter()
        .tag(1, 2)
        .string(typeUrl)
        .tag(4, 0)
        .int32(1)
        .tag(2, 2)
        .bytes(new Uint8Array())
        .finish();
    const status = new BinaryWriter();
    status.tag(3, 2).bytes(
      new BinaryWriter()
        .tag(2, 2)
        .bytes(new Uint8Array([1]))
        .finish()
    );
    for (let i = 0; i < MAX_STATUS_DETAILS + 2; i++) {
      status.tag(3, 2).bytes(anyOf('type.googleapis.com/google.rpc.Help'));
    }
    const out = statusDetailsFromStatusBin(base64Encode(status.finish()));
    expect(out).toHaveLength(MAX_STATUS_DETAILS);
    expect(out[0]).toEqual({ type: 'google.rpc.Help', value: {} });
  });
});
