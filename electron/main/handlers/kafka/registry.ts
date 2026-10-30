// Confluent Schema Registry client for the Kafka handler (#922, #926, #982).
//
// One client per live Kafka connection. Every registry request — the
// @kafkajs/confluent-schema-registry encode/decode/resolve calls AND the
// read-only browse calls below — goes through a single Node agent that:
//   - carries the execution policy's host-selected TLS material (custom CA,
//     mTLS client cert, verify toggle) for https registries, and
//   - resolves the registry hostname on every new socket and refuses
//     cloud-metadata answers (and loopback when localhost is disabled),
//     plus any other hostname (no redirect / rebind escape). Private
//     addresses stay reachable, matching the broker posture.
// Auth is HTTP Basic (unchanged) or Bearer, whose token is a SecretValue that
// is only ever resolved here in main (ADR-0007). Credentials are never sent
// over plain HTTP to a public address.

import type { LookupAddress } from 'node:dns';
import * as dns from 'node:dns/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import type * as SchemaRegistryLib from '@kafkajs/confluent-schema-registry';
import { isProtocolExternalSecret } from '@shared/protocol/secret-value-schema';
import type { ProtocolSecretValue } from '@shared/protocol/types';
import {
  assertResolvedAddressAllowed,
  isLoopbackAddress,
  isPrivateAddress,
} from '@shared/protocol/url-validation';
import type { KafkaRegistryConfig } from '../../ipc/ipc-validators';
import { resolveSchemaRegistryExecutionPolicy } from '../../security/broker-execution-policy';
import { desktopExternalSecretResolver } from '../../security/external-secret-providers';
import { assertRegistryUrlSafe } from '../../security/kafka-broker-guard';
import type { BrokerSecurityPolicy } from '../../security/mqtt-broker-guard';
import { describeSecretHandle, unwrapSecretValueMain } from '../../security/secret-handle-store';
import { KAFKA_SECRET_SCOPE, plaintextKafkaSecret } from './sasl';

export { KAFKA_SECRET_SCOPE };

/** Resolves every address for a hostname (injectable for tests). */
export type AddressResolver = (hostname: string) => Promise<LookupAddress[]>;
const systemResolver: AddressResolver = (hostname) => dns.lookup(hostname, { all: true });

type SchemaRegistry = SchemaRegistryLib.SchemaRegistry;
type RegistryClientArgs = ConstructorParameters<typeof SchemaRegistryLib.SchemaRegistry>[0];
type RegistryMiddleware = NonNullable<RegistryClientArgs['middlewares']>[number];

let _lib: typeof SchemaRegistryLib | undefined;
const getLib = (): typeof SchemaRegistryLib =>
  (_lib ??= require('@kafkajs/confluent-schema-registry'));

export type RegistrySchemaType = 'AVRO' | 'JSON' | 'PROTOBUF';

export interface RegistrySchemaInfo {
  id: number;
  subject: string;
  version: number;
  schemaType: RegistrySchemaType;
  schema: string;
  references: { name: string; subject: string; version: number }[];
}

/** Where a schema id lives — attached to decoded records for display. */
export interface RegistrySchemaRef {
  id: number;
  subject?: string;
  version?: number;
}

export type SchemaFieldRef = { schemaId: number } | { subject: string; version: number | 'latest' };

export interface KafkaRegistryClient {
  encode(registryId: number, payload: unknown): Promise<Buffer>;
  decode(buffer: Buffer): Promise<unknown>;
  resolveSchemaId(ref: SchemaFieldRef): Promise<number>;
  describeSchemaId(id: number): Promise<RegistrySchemaRef>;
  listSubjects(): Promise<string[]>;
  listVersions(subject: string): Promise<number[]>;
  getSchema(subject: string, version: number | 'latest'): Promise<RegistrySchemaInfo>;
  close(): void;
}

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_LIST_ENTRIES = 10_000;
const MAX_CACHE_ENTRIES = 512;
/** Budget for the id → subject/version label lookup on the consume path. */
export const SCHEMA_LABEL_TIMEOUT_MS = 2_000;
/** How long a transient label failure is cached before the id is retried. */
export const SCHEMA_LABEL_RETRY_MS = 30_000;
const REGISTRY_ACCEPT = 'application/vnd.schemaregistry.v1+json, application/json';

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | { address: string; family: number }[],
  family?: number
) => void;

/**
 * Resolve a registry hostname with the broker-aligned DNS posture: every
 * answer is checked, cloud-metadata addresses (incl. IPv4-mapped / embedded
 * IPv6 forms) are always refused, loopback only when localhost is disabled.
 * Private / VPC answers are allowed — registries live next to their brokers,
 * which the Kafka client resolves without a private-IP check either.
 */
export async function resolveRegistryAddresses(
  hostname: string,
  policy: BrokerSecurityPolicy,
  resolve: AddressResolver = systemResolver,
  requirePrivate = false
): Promise<LookupAddress[]> {
  let records: LookupAddress[];
  try {
    records = await resolve(hostname);
  } catch (err) {
    throw new Error(
      `DNS lookup failed for ${hostname}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (records.length === 0) throw new Error(`DNS returned no records for ${hostname}`);
  for (const record of records) {
    assertResolvedAddressAllowed(hostname, record.address, {
      allowLocalhost: policy.allowLocalhost,
      allowPrivateLiteralHost: true,
      loopbackNeedsLocalhost: true,
    });
    // Credentials over plain HTTP: every socket must land on a private /
    // loopback address, so a later DNS change can't expose them in clear.
    if (requirePrivate && !isPrivateAddress(record.address) && !isLoopbackAddress(record.address)) {
      throw new Error(
        `Schema Registry credentials require HTTPS: ${hostname} resolved to public address ${record.address}`
      );
    }
  }
  return records;
}

function isLocalhostName(host: string): boolean {
  const lower = host.toLowerCase();
  return lower === 'localhost' || lower.endsWith('.localhost');
}

/**
 * Socket `lookup` hook that only resolves the configured registry host,
 * applying {@link resolveRegistryAddresses} on every new connection so a
 * TTL=0 rebind to a metadata / loopback address after pre-flight is caught.
 */
export function createGuardedLookup(
  host: string,
  policy: BrokerSecurityPolicy,
  resolve: AddressResolver = systemResolver,
  requirePrivate = false
): (hostname: string, options: unknown, callback?: unknown) => void {
  return (hostname, optsOrCb, maybeCb) => {
    const callback = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as
      | LookupCallback
      | undefined;
    if (!callback) return;
    const all =
      typeof optsOrCb === 'object' && optsOrCb !== null && (optsOrCb as { all?: unknown }).all;
    if (hostname !== host) {
      callback(new Error(`Schema Registry lookup refused unexpected host "${hostname}"`), '');
      return;
    }
    resolveRegistryAddresses(hostname, policy, resolve, requirePrivate).then(
      (records) => {
        const first = records[0] as LookupAddress;
        if (all)
          callback(
            null,
            records.map((r) => ({ address: r.address, family: r.family }))
          );
        else callback(null, first.address, first.family);
      },
      (err: unknown) => callback(err instanceof Error ? err : new Error(String(err)), '')
    );
  };
}

/** Agent options for the registry URL: policy TLS material + guarded lookup. */
export function buildRegistryAgentOptions(
  registryUrl: string,
  policy: BrokerSecurityPolicy,
  resolve: AddressResolver = systemResolver,
  requirePrivate = false
): https.AgentOptions & { timeout: number } {
  const url = new URL(registryUrl);
  const { timeout, tls } = resolveSchemaRegistryExecutionPolicy(registryUrl);
  return {
    keepAlive: true,
    maxSockets: 8,
    timeout,
    lookup: createGuardedLookup(
      url.hostname,
      policy,
      resolve,
      requirePrivate
    ) as https.AgentOptions['lookup'],
    ...(tls ?? {}),
  };
}

async function resolveBearerToken(token: ProtocolSecretValue): Promise<string> {
  let value: string | undefined;
  if (isProtocolExternalSecret(token)) {
    value = await desktopExternalSecretResolver.resolve(token);
  } else if (typeof token === 'object' && token.kind === 'handle') {
    // Only handles created for Kafka credentials may be sent to a registry.
    if (describeSecretHandle(token.id)?.scope !== KAFKA_SECRET_SCOPE) {
      throw new Error('Schema Registry bearer token handle is not scoped for Kafka.');
    }
    value = unwrapSecretValueMain(token);
  } else {
    value = unwrapSecretValueMain(token);
  }
  if (!value) throw new Error('Schema Registry bearer token could not be resolved.');
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('Schema Registry bearer token contains invalid characters.');
  }
  return value;
}

/** The Authorization header value for the registry auth config, if any. */
export async function registryAuthorization(
  auth: KafkaRegistryConfig['auth']
): Promise<string | undefined> {
  if (!auth) return undefined;
  if (auth.type === 'bearer') {
    return `Bearer ${await resolveBearerToken(auth.token as ProtocolSecretValue)}`;
  }
  if (!auth.username) return undefined;
  const password = auth.password !== undefined ? plaintextKafkaSecret(auth.password) : '';
  return `Basic ${Buffer.from(`${auth.username}:${password}`).toString('base64')}`;
}

function headerMiddleware(headers: Record<string, string>, timeout: number): RegistryMiddleware {
  return () => ({
    prepareRequest: (next) => next().then((request) => request.enhance({ headers, timeout })),
  });
}

/** A registry HTTP error that keeps the status for cache decisions. */
export class RegistryHttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'RegistryHttpError';
  }
}

function hostOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '');
}

/**
 * Credentials may only cross plain HTTP to a loopback or private-network
 * registry (literal address or every DNS answer private); anything else must
 * use HTTPS so a token or password is never sent in clear over the internet.
 */
export function assertCredentialsTransportAllowed(
  url: URL,
  hasCredentials: boolean,
  resolvedAddresses: readonly string[] = []
): void {
  if (!hasCredentials || url.protocol !== 'http:') return;
  const host = hostOf(url).toLowerCase();
  const local = host === 'localhost' || host.endsWith('.localhost');
  const privateLiteral = net.isIP(host) !== 0 && isPrivateAddress(host);
  const privateResolved =
    resolvedAddresses.length > 0 &&
    resolvedAddresses.every((a) => isPrivateAddress(a) || isLoopbackAddress(a));
  if (local || privateLiteral || privateResolved) return;
  throw new Error(
    'Schema Registry credentials require HTTPS: plain HTTP is only allowed for loopback or private-network registries.'
  );
}

function registryError(status: number, body: string): Error {
  let detail = body.slice(0, 300);
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    if (typeof parsed.message === 'string') detail = parsed.message;
  } catch {
    /* non-JSON error body */
  }
  return new RegistryHttpError(
    status,
    `Schema Registry responded ${status}${detail ? `: ${detail}` : ''}`
  );
}

function isSchemaType(value: unknown): value is RegistrySchemaType {
  return value === 'AVRO' || value === 'JSON' || value === 'PROTOBUF';
}

function parseSchemaInfo(raw: unknown): RegistrySchemaInfo {
  const body = (raw ?? {}) as Record<string, unknown>;
  if (
    typeof body.id !== 'number' ||
    typeof body.subject !== 'string' ||
    typeof body.version !== 'number' ||
    typeof body.schema !== 'string'
  ) {
    throw new Error('Schema Registry returned an unexpected schema response.');
  }
  const references = Array.isArray(body.references)
    ? (body.references as Record<string, unknown>[]).flatMap((r) =>
        typeof r.name === 'string' && typeof r.subject === 'string' && typeof r.version === 'number'
          ? [{ name: r.name, subject: r.subject, version: r.version }]
          : []
      )
    : [];
  return {
    id: body.id,
    subject: body.subject,
    version: body.version,
    // The registry omits schemaType for Avro (its default).
    schemaType: isSchemaType(body.schemaType) ? body.schemaType : 'AVRO',
    schema: body.schema,
    references,
  };
}

/**
 * Bound every response read through the agent — including the library's
 * mappersmith path, which buffers bodies without a limit — so a hostile
 * registry cannot exhaust main-process memory. Counters reset when a
 * keep-alive socket returns to the pool.
 */
export function capResponseBytes<A extends http.Agent>(agent: A, maxBytes = MAX_RESPONSE_BYTES): A {
  const received = new WeakMap<object, number>();
  const target = agent as unknown as {
    createConnection: (...args: unknown[]) => import('node:net').Socket;
  };
  const create = target.createConnection.bind(agent);
  target.createConnection = (...args: unknown[]) => {
    const socket = create(...args);
    socket.on('data', (chunk: Buffer) => {
      const total = (received.get(socket) ?? 0) + chunk.length;
      received.set(socket, total);
      if (total > maxBytes) {
        socket.destroy(new Error('Schema Registry response exceeded the size limit.'));
      }
    });
    return socket;
  };
  agent.on('free', (socket: object) => received.set(socket, 0));
  return agent;
}

interface AvscTypeLike {
  typeName: string;
  fields?: { name: string; type: AvscTypeLike }[];
  itemsType?: AvscTypeLike;
  valuesType?: AvscTypeLike;
  types?: AvscTypeLike[];
  underlyingType?: AvscTypeLike;
  isValid?: (value: unknown) => boolean;
}

function isAvscType(value: unknown): value is AvscTypeLike {
  return !!value && typeof (value as { typeName?: unknown }).typeName === 'string';
}

function coerceAvroValue(type: AvscTypeLike, value: unknown, depth: number): unknown {
  if (depth > 64) return value;
  const name = type.typeName;
  if (name === 'bytes' || name === 'fixed') {
    // Avro JSON encoding: bytes/fixed are strings of code points 0-255.
    return typeof value === 'string' ? Buffer.from(value, 'latin1') : value;
  }
  if ((name === 'record' || name === 'error') && value && typeof value === 'object') {
    const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    for (const field of type.fields ?? []) {
      if (field.name in out)
        out[field.name] = coerceAvroValue(field.type, out[field.name], depth + 1);
    }
    return out;
  }
  if (name === 'array' && Array.isArray(value) && type.itemsType) {
    const items = type.itemsType;
    return value.map((item) => coerceAvroValue(items, item, depth + 1));
  }
  if (name === 'map' && value && typeof value === 'object' && type.valuesType) {
    const values = type.valuesType;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        coerceAvroValue(values, v, depth + 1),
      ])
    );
  }
  if (name.startsWith('union') && type.types) {
    for (const branch of type.types) {
      const coerced = coerceAvroValue(branch, value, depth + 1);
      if (branch.isValid?.(coerced)) return coerced;
    }
    return value;
  }
  if (name.startsWith('logical:') && type.underlyingType) {
    return coerceAvroValue(type.underlyingType, value, depth + 1);
  }
  return value;
}

/**
 * JSON payloads cannot carry Buffers, so Avro `bytes` / `fixed` values are
 * accepted as strings (Avro JSON-encoding convention: code points 0-255) and
 * converted before the registry encoder sees them. Non-Avro schemas pass through.
 */
export function coerceAvroPayload(schema: unknown, payload: unknown): unknown {
  return isAvscType(schema) ? coerceAvroValue(schema, payload, 0) : payload;
}

function boundedSet<K, V>(map: Map<K, V>, key: K, value: V): void {
  if (map.size >= MAX_CACHE_ENTRIES) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
  map.set(key, value);
}

/**
 * Build the registry client for a connection. Throws when the URL fails the
 * SSRF pre-flight (literal IP or DNS-resolved), when an active proxy applies,
 * or when a bearer handle cannot be resolved.
 */
export async function createKafkaRegistryClient(
  cfg: KafkaRegistryConfig,
  policy: BrokerSecurityPolicy,
  deps: { resolve?: AddressResolver } = {}
): Promise<KafkaRegistryClient> {
  const resolveAddresses = deps.resolve ?? systemResolver;
  const baseUrl = new URL(cfg.url);
  const hasCredentials =
    cfg.auth?.type === 'bearer' || Boolean(cfg.auth?.type === 'basic' && cfg.auth.username);
  const requirePrivate =
    baseUrl.protocol === 'http:' && hasCredentials && !isLocalhostName(hostOf(baseUrl));
  const agentOptions = buildRegistryAgentOptions(cfg.url, policy, resolveAddresses, requirePrivate);
  // String-level policy (same as brokers: literal private IPs follow the
  // network policy, metadata always refused), then a DNS pre-flight for
  // hostnames with the broker-aligned answer checks.
  assertRegistryUrlSafe(cfg.url, policy);
  const host = hostOf(baseUrl);
  const resolved =
    net.isIP(host) === 0
      ? (await resolveRegistryAddresses(host, policy, resolveAddresses)).map((r) => r.address)
      : [host];
  assertCredentialsTransportAllowed(baseUrl, hasCredentials, resolved);
  const authorization = await registryAuthorization(cfg.auth);
  const agent = capResponseBytes(
    baseUrl.protocol === 'https:' ? new https.Agent(agentOptions) : new http.Agent(agentOptions)
  );
  const timeout = agentOptions.timeout;

  const lib: SchemaRegistry = new (getLib().SchemaRegistry)({
    host: cfg.url,
    agent,
    // Basic keeps the library's own auth path (unchanged behaviour); bearer
    // and the policy timeout go in via middleware.
    ...(cfg.auth?.type === 'basic' && cfg.auth.username
      ? {
          auth: {
            username: cfg.auth.username,
            password:
              cfg.auth.password !== undefined ? plaintextKafkaSecret(cfg.auth.password) : '',
          },
        }
      : {}),
    middlewares: [
      headerMiddleware(
        cfg.auth?.type === 'bearer' && authorization ? { Authorization: authorization } : {},
        timeout
      ),
    ],
  });

  const prefix = cfg.url.replace(/\/+$/, '');
  const getJson = (path: string, requestTimeout = timeout): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const transport = baseUrl.protocol === 'https:' ? https : http;
      const request = transport.request(
        `${prefix}${path}`,
        {
          method: 'GET',
          agent,
          headers: {
            Accept: REGISTRY_ACCEPT,
            ...(authorization ? { Authorization: authorization } : {}),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) {
              request.destroy(new Error('Schema Registry response exceeded the size limit.'));
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            const status = response.statusCode ?? 0;
            if (status < 200 || status >= 300) {
              reject(registryError(status, body));
              return;
            }
            try {
              resolve(JSON.parse(body));
            } catch {
              reject(new Error('Schema Registry returned invalid JSON.'));
            }
          });
          response.on('error', reject);
        }
      );
      request.setTimeout(requestTimeout, () =>
        request.destroy(new Error(`Schema Registry request timed out after ${requestTimeout}ms`))
      );
      request.on('error', reject);
      request.end();
    });

  const subjectPath = (subject: string) => `/subjects/${encodeURIComponent(subject)}`;
  const idRefs = new Map<number, Promise<RegistrySchemaRef>>();
  // Transient label failures are remembered briefly so a hung registry costs
  // one bounded wait per id per cooldown, not one per consumed record.
  const retryLabelAt = new Map<number, number>();
  const pinnedIds = new Map<string, number>();

  return {
    async encode(registryId, payload) {
      // Avro bytes/fixed have no JSON form; accept strings for them (see coerceAvroPayload).
      const schema = await lib.getSchema(registryId);
      return lib.encode(registryId, coerceAvroPayload(schema, payload));
    },
    decode: (buffer) => lib.decode(buffer),

    async resolveSchemaId(ref) {
      if ('schemaId' in ref) return ref.schemaId;
      const key = `${ref.subject}\u0000${ref.version}`;
      const pinned = pinnedIds.get(key);
      if (pinned !== undefined) return pinned;
      try {
        const id =
          ref.version === 'latest'
            ? await lib.getLatestSchemaId(ref.subject)
            : await lib.getRegistryId(ref.subject, ref.version);
        // Numbered versions are immutable; 'latest' is re-resolved every time.
        if (ref.version !== 'latest') boundedSet(pinnedIds, key, id);
        return id;
      } catch (err) {
        throw new Error(
          `Schema subject "${ref.subject}" (version ${ref.version}) could not be resolved: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    },

    describeSchemaId(id) {
      const cached = idRefs.get(id);
      const retryAt = retryLabelAt.get(id);
      if (cached && (retryAt === undefined || Date.now() < retryAt)) return cached;
      retryLabelAt.delete(id);
      const lookup = getJson(`/schemas/ids/${id}/versions`, SCHEMA_LABEL_TIMEOUT_MS).then(
        (raw): RegistrySchemaRef => {
          const first = Array.isArray(raw) ? (raw[0] as Record<string, unknown>) : undefined;
          return first && typeof first.subject === 'string' && typeof first.version === 'number'
            ? { id, subject: first.subject, version: first.version }
            : { id };
        },
        (err: unknown): RegistrySchemaRef => {
          // Older registries lack this endpoint (404/405): cache the miss for
          // good. Transient failures and timeouts are cached for a cooldown,
          // then retried.
          const permanent =
            err instanceof RegistryHttpError && (err.status === 404 || err.status === 405);
          if (!permanent && idRefs.get(id) === lookup) {
            boundedSet(retryLabelAt, id, Date.now() + SCHEMA_LABEL_RETRY_MS);
          }
          return { id };
        }
      );
      boundedSet(idRefs, id, lookup);
      return lookup;
    },

    async listSubjects() {
      const raw = await getJson('/subjects');
      if (!Array.isArray(raw))
        throw new Error('Schema Registry returned an unexpected subjects list.');
      return raw
        .filter((s): s is string => typeof s === 'string')
        .slice(0, MAX_LIST_ENTRIES)
        .sort((a, b) => a.localeCompare(b));
    },

    async listVersions(subject) {
      const raw = await getJson(`${subjectPath(subject)}/versions`);
      if (!Array.isArray(raw))
        throw new Error('Schema Registry returned an unexpected versions list.');
      return raw
        .filter((v): v is number => Number.isSafeInteger(v))
        .slice(0, MAX_LIST_ENTRIES)
        .sort((a, b) => a - b);
    },

    async getSchema(subject, version) {
      const info = parseSchemaInfo(await getJson(`${subjectPath(subject)}/versions/${version}`));
      boundedSet(
        idRefs,
        info.id,
        Promise.resolve({ id: info.id, subject: info.subject, version: info.version })
      );
      return info;
    },

    close() {
      agent.destroy();
    },
  };
}

/** Resolve a produce field's schema reference, as an error result on failure. */
export async function resolveFieldSchemaId(
  registry: Pick<KafkaRegistryClient, 'resolveSchemaId'>,
  field: { schemaId?: number; subject?: string; version?: number | 'latest' }
): Promise<{ schemaId: number } | { error: string }> {
  try {
    if (field.schemaId !== undefined) return { schemaId: field.schemaId };
    if (field.subject === undefined || field.version === undefined) {
      return { error: 'A schema field requires schemaId or subject + version.' };
    }
    return {
      schemaId: await registry.resolveSchemaId({ subject: field.subject, version: field.version }),
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
