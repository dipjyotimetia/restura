// Rich gRPC error details (the `google.rpc.Status.details` model).
//
// A gRPC server can attach typed detail messages to an error — `BadRequest`
// field violations, `ErrorInfo`, `RetryInfo`, `QuotaFailure`, … — packed as
// `google.protobuf.Any`. They reach Restura three ways:
//  - native gRPC: the `grpc-status-details-bin` trailer (a binary
//    `google.rpc.Status`), which connect-node already unpacks into
//    `ConnectError.details` on desktop;
//  - Connect protocol: the error JSON's `details[]` (`{ type, value, debug }`,
//    `value` = base64 proto bytes) that the Worker / self-host proxy reads;
//  - connect-web in the renderer: `ConnectError.details` again.
//
// Every path funnels into `decodeStatusDetail`, so the decoded shape is the
// same on every harness. The well-known `google.rpc.*` types from
// google/rpc/error_details.proto are decoded with a small table-driven wire
// reader (no generated code, no `.proto` parse at runtime — it has to load in
// the Worker too). Anything else is decoded through the caller's runtime
// registry when it knows the type, else returned as type + base64 `raw`.
import { create, type DescMessage, fromBinary, type Registry, toJson } from '@bufbuild/protobuf';
import { BinaryReader, base64Decode, base64Encode, WireType } from '@bufbuild/protobuf/wire';

/** One decoded `google.protobuf.Any` from an error's status details. */
export interface GrpcStatusDetail {
  /** Fully-qualified message name, e.g. `google.rpc.BadRequest`. */
  type: string;
  /** proto3-JSON rendering when the type could be decoded. */
  value?: unknown;
  /** Base64 of the packed bytes when the type is unknown or failed to decode. */
  raw?: string;
  /** Connect's optional JSON `debug` rendering, passed through verbatim. */
  debug?: unknown;
}

/** Upper bound on details kept per error — a hostile peer can't balloon the UI. */
export const MAX_STATUS_DETAILS = 32;

// ---------------------------------------------------------------------------
// Table-driven decoder for google/rpc/error_details.proto
// ---------------------------------------------------------------------------

type Kind = 'string' | 'int64' | 'duration' | 'message' | 'stringMap';
interface FieldSpec {
  no: number;
  json: string;
  kind: Kind;
  repeated?: true;
  message?: FieldSpec[];
}

const LOCALIZED_MESSAGE: FieldSpec[] = [
  { no: 1, json: 'locale', kind: 'string' },
  { no: 2, json: 'message', kind: 'string' },
];

const WELL_KNOWN: Record<string, FieldSpec[]> = {
  'google.rpc.ErrorInfo': [
    { no: 1, json: 'reason', kind: 'string' },
    { no: 2, json: 'domain', kind: 'string' },
    { no: 3, json: 'metadata', kind: 'stringMap' },
  ],
  'google.rpc.RetryInfo': [{ no: 1, json: 'retryDelay', kind: 'duration' }],
  'google.rpc.DebugInfo': [
    { no: 1, json: 'stackEntries', kind: 'string', repeated: true },
    { no: 2, json: 'detail', kind: 'string' },
  ],
  'google.rpc.QuotaFailure': [
    {
      no: 1,
      json: 'violations',
      kind: 'message',
      repeated: true,
      message: [
        { no: 1, json: 'subject', kind: 'string' },
        { no: 2, json: 'description', kind: 'string' },
        { no: 3, json: 'apiService', kind: 'string' },
        { no: 4, json: 'quotaMetric', kind: 'string' },
        { no: 5, json: 'quotaId', kind: 'string' },
        { no: 6, json: 'quotaDimensions', kind: 'stringMap' },
        { no: 7, json: 'quotaValue', kind: 'int64' },
        { no: 8, json: 'futureQuotaValue', kind: 'int64' },
      ],
    },
  ],
  'google.rpc.PreconditionFailure': [
    {
      no: 1,
      json: 'violations',
      kind: 'message',
      repeated: true,
      message: [
        { no: 1, json: 'type', kind: 'string' },
        { no: 2, json: 'subject', kind: 'string' },
        { no: 3, json: 'description', kind: 'string' },
      ],
    },
  ],
  'google.rpc.BadRequest': [
    {
      no: 1,
      json: 'fieldViolations',
      kind: 'message',
      repeated: true,
      message: [
        { no: 1, json: 'field', kind: 'string' },
        { no: 2, json: 'description', kind: 'string' },
        { no: 3, json: 'reason', kind: 'string' },
        { no: 4, json: 'localizedMessage', kind: 'message', message: LOCALIZED_MESSAGE },
      ],
    },
  ],
  'google.rpc.RequestInfo': [
    { no: 1, json: 'requestId', kind: 'string' },
    { no: 2, json: 'servingData', kind: 'string' },
  ],
  'google.rpc.ResourceInfo': [
    { no: 1, json: 'resourceType', kind: 'string' },
    { no: 2, json: 'resourceName', kind: 'string' },
    { no: 3, json: 'owner', kind: 'string' },
    { no: 4, json: 'description', kind: 'string' },
  ],
  'google.rpc.Help': [
    {
      no: 1,
      json: 'links',
      kind: 'message',
      repeated: true,
      message: [
        { no: 1, json: 'description', kind: 'string' },
        { no: 2, json: 'url', kind: 'string' },
      ],
    },
  ],
  'google.rpc.LocalizedMessage': LOCALIZED_MESSAGE,
};

/** proto3 JSON for google.protobuf.Duration: "1s", "1.500s", "0.000000001s". */
function formatDuration(seconds: bigint, nanos: number): string {
  if (nanos === 0) return `${seconds}s`;
  const negative = seconds < 0n || nanos < 0;
  const absSeconds = seconds < 0n ? -seconds : seconds;
  let frac = String(Math.abs(nanos)).padStart(9, '0');
  if (frac.endsWith('000000')) frac = frac.slice(0, 3);
  else if (frac.endsWith('000')) frac = frac.slice(0, 6);
  return `${negative ? '-' : ''}${absSeconds}.${frac}s`;
}

function expectWire(actual: WireType, expected: WireType): void {
  if (actual !== expected) throw new Error(`unexpected wire type ${actual}`);
}

function readStringPair(bytes: Uint8Array): [string, string] {
  const r = new BinaryReader(bytes);
  let key = '';
  let value = '';
  while (r.pos < r.len) {
    const [no, wt] = r.tag();
    if (no === 1 && wt === WireType.LengthDelimited) key = r.string();
    else if (no === 2 && wt === WireType.LengthDelimited) value = r.string();
    else r.skip(wt, no);
  }
  return [key, value];
}

function readDuration(bytes: Uint8Array): string {
  const r = new BinaryReader(bytes);
  let seconds = 0n;
  let nanos = 0;
  while (r.pos < r.len) {
    const [no, wt] = r.tag();
    if (no === 1 && wt === WireType.Varint) seconds = BigInt(r.int64());
    else if (no === 2 && wt === WireType.Varint) nanos = r.int32();
    else r.skip(wt, no);
  }
  return formatDuration(seconds, nanos);
}

function decodeTable(bytes: Uint8Array, fields: FieldSpec[]): Record<string, unknown> {
  const r = new BinaryReader(bytes);
  const out: Record<string, unknown> = {};
  while (r.pos < r.len) {
    const [no, wt] = r.tag();
    const f = fields.find((x) => x.no === no);
    if (!f) {
      r.skip(wt, no); // newer schema field — ignore, like any proto reader
      continue;
    }
    let value: unknown;
    switch (f.kind) {
      case 'string':
        expectWire(wt, WireType.LengthDelimited);
        value = r.string();
        break;
      case 'int64':
        expectWire(wt, WireType.Varint);
        value = String(r.int64()); // proto3 JSON renders 64-bit ints as strings
        break;
      case 'duration':
        expectWire(wt, WireType.LengthDelimited);
        value = readDuration(r.bytes());
        break;
      case 'message':
        expectWire(wt, WireType.LengthDelimited);
        value = decodeTable(r.bytes(), f.message ?? []);
        break;
      case 'stringMap': {
        expectWire(wt, WireType.LengthDelimited);
        const [k, v] = readStringPair(r.bytes());
        const map = (out[f.json] as Record<string, string> | undefined) ?? {};
        map[k] = v;
        out[f.json] = map;
        continue;
      }
    }
    if (f.repeated) {
      const list = (out[f.json] as unknown[] | undefined) ?? [];
      list.push(value);
      out[f.json] = list;
    } else {
      out[f.json] = value;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public decoding API
// ---------------------------------------------------------------------------

/** `type.googleapis.com/google.rpc.BadRequest` → `google.rpc.BadRequest`. */
export function typeNameFromUrl(typeUrl: string): string {
  const slash = typeUrl.lastIndexOf('/');
  return slash >= 0 ? typeUrl.slice(slash + 1) : typeUrl;
}

export interface DecodeStatusDetailOptions {
  /** Runtime registry (the call's schema) for decoding non-google.rpc types. */
  registry?: Registry | undefined;
  debug?: unknown;
}

/**
 * Decode one packed detail. Never throws: an unknown type or malformed bytes
 * fall back to `{ type, raw }` so the UI can still show something.
 */
export function decodeStatusDetail(
  typeUrlOrName: string,
  bytes: Uint8Array,
  opts: DecodeStatusDetailOptions = {}
): GrpcStatusDetail {
  const type = typeNameFromUrl(typeUrlOrName);
  const base: GrpcStatusDetail = { type };
  if (opts.debug !== undefined) base.debug = opts.debug;
  try {
    const table = WELL_KNOWN[type];
    if (table) return { ...base, value: decodeTable(bytes, table) };
    const desc = opts.registry?.getMessage(type);
    if (desc) {
      return {
        ...base,
        value: toJson(desc, fromBinary(desc, bytes), { registry: opts.registry }),
      };
    }
  } catch {
    // fall through to the raw rendering
  }
  return { ...base, raw: base64Encode(bytes) };
}

/**
 * Details from a Connect error JSON body (`{ code, message, details: [...] }`),
 * as read by the Worker / self-host proxy and the CLI. Each entry is
 * `{ type, value, debug? }` with `value` = base64 (std or url alphabet, padding
 * optional — base64Decode accepts all of them).
 */
export function statusDetailsFromConnectJson(
  details: unknown,
  registry?: Registry
): GrpcStatusDetail[] {
  if (!Array.isArray(details)) return [];
  const out: GrpcStatusDetail[] = [];
  for (const d of details.slice(0, MAX_STATUS_DETAILS)) {
    if (!d || typeof d !== 'object') continue;
    const { type, value, debug } = d as { type?: unknown; value?: unknown; debug?: unknown };
    if (typeof type !== 'string' || !type) continue;
    let bytes: Uint8Array;
    try {
      bytes = typeof value === 'string' ? base64Decode(value) : new Uint8Array();
    } catch {
      out.push({ type: typeNameFromUrl(type), raw: String(value), ...(debug ? { debug } : {}) });
      continue;
    }
    out.push(decodeStatusDetail(type, bytes, { registry, debug }));
  }
  return out;
}

/**
 * Re-decode details the schema-less Worker / self-host proxy could only return
 * as `{ type, raw }`, using the renderer's loaded registry. Entries that are
 * already decoded, or whose type the registry doesn't define, pass through.
 */
export function redecodeRawStatusDetails(
  details: GrpcStatusDetail[],
  registry: Registry
): GrpcStatusDetail[] {
  return details.map((d) => {
    if (d.raw === undefined || d.value !== undefined || !registry.getMessage(d.type)) return d;
    try {
      const out = decodeStatusDetail(d.type, base64Decode(d.raw), {
        registry,
        debug: d.debug,
      });
      return out.raw === undefined ? out : d;
    } catch {
      return d;
    }
  });
}

/** Structural view of `ConnectError.details` (incoming or outgoing entries). */
type ConnectDetailLike =
  | { type: string; value: Uint8Array; debug?: unknown }
  | { desc: DescMessage; value: unknown };

/**
 * Details carried by a ConnectError (connect-node on desktop, connect-web in
 * the renderer). connect-node already unpacked `grpc-status-details-bin` or the
 * Connect JSON into these entries, so this only decodes each `Any`. Returns
 * `undefined` when the error carries none, so callers can spread it as-is.
 */
export function connectErrorDetails(
  err: { details: ReadonlyArray<unknown> },
  registry?: Registry
): GrpcStatusDetail[] | undefined {
  const out: GrpcStatusDetail[] = [];
  for (const raw of err.details.slice(0, MAX_STATUS_DETAILS)) {
    const d = raw as ConnectDetailLike;
    if ('desc' in d) {
      try {
        const msg = create(d.desc, d.value as never);
        out.push({ type: d.desc.typeName, value: toJson(d.desc, msg, { registry }) });
      } catch {
        out.push({ type: d.desc.typeName });
      }
      continue;
    }
    if (typeof d.type !== 'string' || !(d.value instanceof Uint8Array)) continue;
    out.push(decodeStatusDetail(d.type, d.value, { registry, debug: d.debug }));
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Decode a `grpc-status-details-bin` trailer value (base64 binary
 * `google.rpc.Status`) into its details. Returns [] when the value is absent or
 * malformed — the plain grpc-status / grpc-message still describe the error.
 */
export function statusDetailsFromStatusBin(
  base64Value: string | undefined,
  registry?: Registry
): GrpcStatusDetail[] {
  if (!base64Value) return [];
  try {
    const r = new BinaryReader(base64Decode(base64Value));
    const out: GrpcStatusDetail[] = [];
    while (r.pos < r.len) {
      const [no, wt] = r.tag();
      if (no !== 3 || wt !== WireType.LengthDelimited) {
        r.skip(wt, no);
        continue;
      }
      const any = new BinaryReader(r.bytes());
      let typeUrl = '';
      let value: Uint8Array = new Uint8Array();
      while (any.pos < any.len) {
        const [ano, awt] = any.tag();
        if (ano === 1 && awt === WireType.LengthDelimited) typeUrl = any.string();
        else if (ano === 2 && awt === WireType.LengthDelimited) value = any.bytes();
        else any.skip(awt, ano);
      }
      if (typeUrl && out.length < MAX_STATUS_DETAILS) {
        out.push(decodeStatusDetail(typeUrl, value, { registry }));
      }
    }
    return out;
  } catch {
    return [];
  }
}
