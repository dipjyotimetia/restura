/**
 * Shared fixtures for the gRPC conformance suites (desktop, Worker relay, CLI,
 * renderer): one complex payload and one oracle, so every harness sends the
 * same request and is judged by the same expectation — bufbuild's canonical
 * JSON from the buf-generated schema, never Restura's own codec.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRegistry, fromJson, type JsonValue, toBinary, toJson } from '@bufbuild/protobuf';
import { FileDescriptorProtoSchema } from '@bufbuild/protobuf/wkt';
import { file_conformance, PayloadSchema } from './proto/gen/conformance_pb';

/** The `.proto` source as a user would upload it. */
export const CONFORMANCE_PROTO = readFileSync(
  resolve(__dirname, 'proto/conformance.proto'),
  'utf8'
);

/** The same schema as reflection would return it (base64 FileDescriptorProto). */
export const CONFORMANCE_DESCRIPTORS = [
  Buffer.from(toBinary(FileDescriptorProtoSchema, file_conformance.proto)).toString('base64'),
];

/** Type registry for the oracle (resolves the `Any` payloads). */
export const conformanceTypeRegistry = createRegistry(
  file_conformance,
  ...file_conformance.dependencies
);

/** Every proto3 shape, as a user would type it in the editor (proto3 JSON). */
export const COMPLEX_PAYLOAD = {
  fDouble: Math.PI,
  fFloat: 1.5,
  fInt64: '-9223372036854775808',
  fUint64: '18446744073709551615',
  fInt32: -2147483648,
  fFixed64: '1234567890123',
  fFixed32: 4294967295,
  fBool: true,
  fString: 'héllo — 世界 🚀',
  fBytes: 'AAEC/w==',
  fUint32: 4000000000,
  fSfixed32: -42,
  fSfixed64: '-9007199254740993',
  fSint32: -7,
  fSint64: '-123456789012',
  priority: 'PRIORITY_HIGH',
  contact: {
    name: 'Ada',
    address: { street: '1 Loop Rd', city: 'Cambridge', tags: ['home', 'primary'] },
    previous: [{ city: 'London' }, { street: '2 Old St', tags: [] }],
    priority: 'PRIORITY_LOW',
    phones: [{ number: '+44 20 0000', primary: true }],
  },
  contacts: [{ name: 'Bob' }, { name: 'Cy', priority: 'PRIORITY_HIGH' }],
  ids: ['1', '-2', '9007199254740993'],
  contactsById: { a1: { name: 'Ann' }, 'b/2': { name: 'Ben', address: { city: 'Paris' } } },
  labels: { '-5': 'neg', '9223372036854775807': 'max' },
  priorities: { p: 'PRIORITY_LOW', q: 'PRIORITY_HIGH' },
  postal: { street: 'PO Box 9', city: 'Oslo' },
  retryCount: 0,
  createdAt: '2026-11-03T10:15:30.123456789Z',
  ttl: '3600.5s',
  attributes: { tier: 'gold', limits: { rps: 100, burst: [1, 2, 3] }, beta: false, none: null },
  dynamic: [1, 'two', { three: 3 }],
  extension: {
    '@type': 'type.googleapis.com/conformance.v1.Address',
    street: 'Any St',
    city: 'Packed',
  },
  nickname: 'adi',
  quota: '42',
  updateMask: 'fString,contact.name',
  attachments: [
    { '@type': 'type.googleapis.com/conformance.v1.Contact', name: 'in-any' },
    { '@type': 'type.googleapis.com/google.protobuf.Duration', value: '1.5s' },
  ],
} as const;

/**
 * What a correct round trip must yield for `payload`: bufbuild's canonical
 * proto3 JSON. `implicit` mirrors the reader: Restura's viewer emits implicit
 * (zero) fields; a server's Connect JSON omits them.
 */
export function canonicalPayload(json: unknown, implicit = true): JsonValue {
  const msg = fromJson(PayloadSchema, json as JsonValue, { registry: conformanceTypeRegistry });
  return toJson(PayloadSchema, msg, {
    registry: conformanceTypeRegistry,
    alwaysEmitImplicit: implicit,
  });
}

export const TRACE_TEXT = 'trace ✓ 42';
