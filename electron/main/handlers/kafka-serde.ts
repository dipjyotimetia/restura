// Kafka serde helpers — the encode (produce) / decode (consume) edge of the
// Confluent Schema Registry integration (@kafkajs/confluent-schema-registry).
// Kept electron-free so both sides can be unit-tested without importing the IPC
// handler's `electron` deps.

import { isUtf8 } from 'node:buffer';

export type KafkaPayloadEncoding = 'utf8' | 'base64';

export interface KafkaDisplayField {
  value: string;
  encoding: KafkaPayloadEncoding;
}

/**
 * Decode a renderer-provided payload at the wire boundary. Base64 is deliberately
 * strict and canonical: Node's Buffer decoder is permissive (it silently ignores
 * whitespace and malformed input), which would otherwise publish different bytes
 * from the payload the user reviewed.
 */
export function decodeWirePayload(
  raw: string,
  encoding: KafkaPayloadEncoding,
  field: 'key' | 'value'
): { value: string | Buffer } | { error: string } {
  if (encoding === 'utf8') return { value: raw };

  const canonicalBase64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
  if (!canonicalBase64.test(raw) || Buffer.from(raw, 'base64').toString('base64') !== raw) {
    return { error: `Binary ${field} must be canonical Base64.` };
  }
  return { value: Buffer.from(raw, 'base64') };
}

/**
 * DECODE: coerce a consumed message key/value into the string the renderer
 * displays. A plain value passes through unchanged; a registry-decoded
 * Avro/Protobuf/JSON value arrives as a parsed object and is JSON-serialized; a
 * raw Buffer is read as UTF-8. Dispatches on the runtime type so it stays correct
 * across the plain (string/Buffer) and registry-decoded (object) paths.
 */
export function valueToString(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (v instanceof Uint8Array) return Buffer.from(v).toString();
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export type ParsedSchemaJson = { value: unknown } | { error: string };

/**
 * Parse a schema-encoded field's raw string into the value the registry encoder
 * expects — Avro/Protobuf/JSON encoders take a parsed value, not a raw string.
 * Reused for both the key and value produce paths; `field` only shapes the error.
 */
export function parseSchemaJson(raw: string, field: 'key' | 'value' = 'value'): ParsedSchemaJson {
  try {
    return { value: JSON.parse(raw) };
  } catch {
    return { error: `Schema-encoded ${field} must be valid JSON.` };
  }
}

/**
 * True when a consumed key/value Buffer carries the Confluent wire framing
 * (magic byte 0x00 + 4-byte big-endian schema id), i.e. it should be decoded via
 * the Schema Registry rather than read as UTF-8. Plain (non-registry) payloads
 * fail the check and pass through as text.
 */
export function isConfluentEncoded(buf: Uint8Array): boolean {
  return buf.length >= 5 && buf[0] === 0x00;
}

// Structural slices of @kafkajs/confluent-schema-registry's SchemaRegistry, so
// this module stays electron-free and lib-import-free (and unit-testable with a
// tiny fake registry).
export interface SchemaEncoder {
  encode(registryId: number, payload: unknown): Promise<Buffer>;
}
export interface SchemaDecoder {
  decode(buffer: Buffer): Promise<unknown>;
}

/**
 * ENCODE one produce field (key or value) with a registry schema: parse the raw
 * string as JSON, then Confluent-encode it. Returns the wire Buffer, or an error
 * (invalid JSON, or the registry encode threw). `field` shapes the error text.
 */
export async function encodeSchemaField(
  registry: SchemaEncoder,
  schemaId: number,
  raw: string,
  field: 'key' | 'value'
): Promise<{ value: Buffer } | { error: string }> {
  const parsed = parseSchemaJson(raw, field);
  if ('error' in parsed) return parsed;
  try {
    return { value: await registry.encode(schemaId, parsed.value) };
  } catch (err) {
    const label = field === 'key' ? 'Key' : 'Value';
    return {
      error: `${label} schema encode failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * DECODE a consumed key/value Buffer to its display string: registry-decode when
 * it carries the Confluent wire framing (and a registry is configured), else read
 * as UTF-8. Falls back to raw text if decode throws (schema missing / not actually
 * registry-encoded).
 */
export async function decodeField(
  registry: SchemaDecoder | undefined,
  buf: Buffer
): Promise<string> {
  if (registry && isConfluentEncoded(buf)) {
    try {
      return valueToString(await registry.decode(buf));
    } catch {
      /* fall through to text */
    }
  }
  return valueToString(buf);
}

/**
 * Decode a consumed field for display without treating arbitrary bytes as UTF-8.
 * Registry-decoded values are textual JSON; raw invalid UTF-8 is emitted as
 * canonical Base64 so a user can inspect and republish the exact byte sequence.
 */
export async function decodeDisplayField(
  registry: SchemaDecoder | undefined,
  buf: Buffer
): Promise<KafkaDisplayField> {
  if (registry && isConfluentEncoded(buf)) {
    try {
      return { value: valueToString(await registry.decode(buf)), encoding: 'utf8' };
    } catch {
      /* fall through to raw bytes */
    }
  }
  return isUtf8(buf)
    ? { value: buf.toString('utf8'), encoding: 'utf8' }
    : { value: buf.toString('base64'), encoding: 'base64' };
}

// ---------------------------------------------------------------------------
// Admin / observability serde (issue #257). The @platformatic/kafka Admin API
// returns bigint offsets and nested Maps that don't survive IPC structured-clone
// usefully. These pure helpers flatten them to plain serializable arrays with
// offset-scale bigints rendered as numeric strings (avoids 2^53 precision loss).
// Kept electron-free and lib-import-free via the structural input slices below,
// so they unit-test without importing the IPC handler's deps.
// ---------------------------------------------------------------------------

// --- Topic watermarks (admin.listOffsets EARLIEST/LATEST) ---

/** One partition of an admin.listOffsets() result (only the fields we read). */
export interface ListedOffsetsPartitionLike {
  partitionIndex: number;
  offset: bigint;
}

export interface PartitionWatermark {
  partition: number;
  low: string;
  high: string;
  count: string;
}

/**
 * Pair per-partition earliest (low) and latest (high) watermarks from two
 * admin.listOffsets calls into a serializable table. `count = high - low` (the
 * approximate retained-message count). Partitions are matched by index, a
 * missing low defaults to 0, a negative count clamps to 0, and the result is
 * sorted by partition. Offsets cross IPC as numeric strings.
 */
export function topicWatermarks(
  earliest: ListedOffsetsPartitionLike[],
  latest: ListedOffsetsPartitionLike[]
): PartitionWatermark[] {
  const lows = new Map(earliest.map((p) => [p.partitionIndex, p.offset]));
  return latest
    .map((p) => {
      const low = lows.get(p.partitionIndex) ?? 0n;
      const high = p.offset;
      const count = high > low ? high - low : 0n;
      return {
        partition: p.partitionIndex,
        low: low.toString(),
        high: high.toString(),
        count: count.toString(),
      };
    })
    .sort((a, b) => a.partition - b.partition);
}

// --- Topic config (admin.describeConfigs) ---

/** One config entry of an admin.describeConfigs() result (fields we read). */
export interface ConfigEntryLike {
  name: string;
  value: string | null | undefined;
  configSource: number;
  isSensitive: boolean;
  readOnly: boolean;
}

/** One resource's config description (describeConfigs returns one per resource). */
export interface ConfigDescriptionLike {
  configs: ConfigEntryLike[];
}

export interface FlatConfigEntry {
  name: string;
  value: string | null;
  source: string;
  isDefault: boolean;
  isSensitive: boolean;
  readOnly: boolean;
}

// Kafka ConfigSources enum (DescribeConfigs). DEFAULT_CONFIG=5 marks a value the
// broker is applying by default rather than one explicitly set on the topic.
const CONFIG_SOURCE_DEFAULT = 5;
const CONFIG_SOURCE_LABELS: Record<number, string> = {
  0: 'unknown',
  1: 'topic',
  2: 'dynamic-broker',
  3: 'dynamic-default-broker',
  4: 'static-broker',
  5: 'default',
  6: 'dynamic-broker-logger',
  7: 'client-metrics',
  8: 'group',
};

/**
 * Flatten admin.describeConfigs() output (one ConfigDescription per resource;
 * the topic inspector passes a single topic) into a sorted, serializable config
 * table. `isDefault` flags broker-default values so the UI can de-emphasize them.
 */
export function flattenConfigDescriptions(
  descriptions: ConfigDescriptionLike[]
): FlatConfigEntry[] {
  return descriptions
    .flatMap((d) => d.configs)
    .map((c) => ({
      name: c.name,
      // Never let a sensitive value cross the IPC boundary — the UI only ever
      // masks it, but the plaintext would still reach renderer memory / devtools.
      value: c.isSensitive ? null : (c.value ?? null),
      source: CONFIG_SOURCE_LABELS[c.configSource] ?? String(c.configSource),
      isDefault: c.configSource === CONFIG_SOURCE_DEFAULT,
      isSensitive: c.isSensitive,
      readOnly: c.readOnly,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// --- Consumer group describe (admin.describeGroups → nested Maps) ---

export interface GroupAssignmentLike {
  topic: string;
  partitions: number[];
}

/** One member of an admin.describeGroups() Group (fields we read). */
export interface GroupMemberLike {
  id: string;
  clientId: string;
  clientHost: string;
  assignments?: Map<string, GroupAssignmentLike>;
}

/** One admin.describeGroups() Group (its `members` is a Map). */
export interface GroupLike {
  id: string;
  state: string;
  protocol?: string;
  protocolType: string;
  members: Map<string, GroupMemberLike>;
}

export interface FlatGroupMember {
  memberId: string;
  clientId: string;
  clientHost: string;
  assignments: GroupAssignmentLike[];
}

export interface FlatGroup {
  id: string;
  state: string;
  protocol: string;
  protocolType: string;
  members: FlatGroupMember[];
}

/**
 * Flatten one describeGroups() entry — a Group whose `members` is a Map and each
 * member's `assignments` is itself a Map — into nested plain arrays for IPC
 * (Maps don't structured-clone usefully, so both levels are recursed).
 */
export function flattenGroup(group: GroupLike): FlatGroup {
  return {
    id: group.id,
    state: String(group.state),
    protocol: group.protocol ?? '',
    protocolType: group.protocolType,
    members: Array.from(group.members.values()).map((m) => ({
      memberId: m.id,
      clientId: m.clientId,
      clientHost: m.clientHost,
      assignments: m.assignments ? Array.from(m.assignments.values()) : [],
    })),
  };
}

// --- Consumer group lag (admin.listConsumerGroupOffsets vs admin.listOffsets) ---

/** One partition of an admin.listConsumerGroupOffsets() result (fields we read). */
export interface CommittedPartitionLike {
  partitionIndex: number;
  committedOffset: bigint;
}

export interface CommittedTopicLike {
  name: string;
  partitions: CommittedPartitionLike[];
}

/** One topic of an admin.listOffsets() result (fields we read). */
export interface ListedOffsetsTopicLike {
  name: string;
  partitions: ListedOffsetsPartitionLike[];
}

export interface PartitionLag {
  topic: string;
  partition: number;
  /** Committed offset, or null when the group has not committed this partition. */
  committed: string | null;
  logEnd: string;
  lag: string;
}

/**
 * Compute per-partition consumer lag = topic log-end (latest watermark) − the
 * group's committed offset, walking the group's committed partitions. The
 * subtraction is done in bigint then stringified (avoids 2^53 loss). A committed
 * offset of -1 (no commit) is reported as committed=null with lag = full log-end;
 * a negative result (data deleted under the committed offset) clamps to 0; a
 * missing latest watermark is treated as log-end 0.
 */
export function computeGroupLag(
  committed: CommittedTopicLike[],
  latest: ListedOffsetsTopicLike[]
): PartitionLag[] {
  const logEnds = new Map<string, bigint>();
  for (const t of latest) {
    for (const p of t.partitions) logEnds.set(`${t.name}/${p.partitionIndex}`, p.offset);
  }
  const rows: PartitionLag[] = [];
  for (const t of committed) {
    for (const p of t.partitions) {
      const high = logEnds.get(`${t.name}/${p.partitionIndex}`) ?? 0n;
      const hasCommit = p.committedOffset >= 0n;
      const lag = hasCommit ? (high > p.committedOffset ? high - p.committedOffset : 0n) : high;
      rows.push({
        topic: t.name,
        partition: p.partitionIndex,
        committed: hasCommit ? p.committedOffset.toString() : null,
        logEnd: high.toString(),
        lag: lag.toString(),
      });
    }
  }
  return rows.sort((a, b) => a.topic.localeCompare(b.topic) || a.partition - b.partition);
}
