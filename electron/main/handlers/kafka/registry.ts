// Confluent Schema Registry client for the Kafka handler (#922, #926, #982).
//
// One client per live Kafka connection. Every registry request — the
// @kafkajs/confluent-schema-registry encode/decode/resolve calls AND the
// read-only browse calls below — goes through a single Node agent that:
//   - carries the execution policy's host-selected TLS material (custom CA,
//     mTLS client cert, verify toggle) for https registries, and
//   - resolves the registry hostname through the SSRF DNS guard on every new
//     socket, refusing any other hostname (no redirect / rebind escape).
// Auth is HTTP Basic (unchanged) or Bearer, whose token is a SecretValue that
// is only ever resolved here in main (ADR-0007).

import * as http from 'node:http';
import * as https from 'node:https';
import type * as SchemaRegistryLib from '@kafkajs/confluent-schema-registry';
import { isProtocolExternalSecret } from '@shared/protocol/secret-value-schema';
import type { ProtocolSecretValue } from '@shared/protocol/types';
import type { KafkaRegistryConfig } from '../../ipc/ipc-validators';
import { resolveSchemaRegistryExecutionPolicy } from '../../security/broker-execution-policy';
import { assertHostnameSafe } from '../../security/dns-guard';
import { desktopExternalSecretResolver } from '../../security/external-secret-providers';
import type { BrokerSecurityPolicy } from '../../security/mqtt-broker-guard';
import { resolveSafeAddress } from '../../security/safe-connect';
import { unwrapSecretValueMain } from '../../security/secret-handle-store';

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
const REGISTRY_ACCEPT = 'application/vnd.schemaregistry.v1+json, application/json';

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | { address: string; family: number }[],
  family?: number
) => void;

/**
 * Socket `lookup` hook that only resolves the configured registry host and
 * validates every DNS record against the same allowLocalhost/allowPrivateIPs
 * policy as the Kafka brokers (cloud metadata is always refused). Runs per new
 * connection, so a TTL=0 rebind after the pre-flight check is still caught.
 */
export function createGuardedLookup(
  host: string,
  policy: BrokerSecurityPolicy
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
    assertHostnameSafe(hostname, policy).then(
      (records) => {
        const first = records[0];
        if (!first) callback(new Error(`DNS returned no records for ${hostname}`), '');
        else if (all)
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
  policy: BrokerSecurityPolicy
): https.AgentOptions & { timeout: number } {
  const url = new URL(registryUrl);
  const { timeout, tls } = resolveSchemaRegistryExecutionPolicy(registryUrl);
  return {
    keepAlive: true,
    maxSockets: 8,
    timeout,
    lookup: createGuardedLookup(url.hostname, policy) as https.AgentOptions['lookup'],
    ...(tls ?? {}),
  };
}

async function resolveBearerToken(token: ProtocolSecretValue): Promise<string> {
  let value: string | undefined;
  if (isProtocolExternalSecret(token)) {
    value = await desktopExternalSecretResolver.resolve(token);
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
  return `Basic ${Buffer.from(`${auth.username}:${auth.password ?? ''}`).toString('base64')}`;
}

function headerMiddleware(headers: Record<string, string>, timeout: number): RegistryMiddleware {
  return () => ({
    prepareRequest: (next) => next().then((request) => request.enhance({ headers, timeout })),
  });
}

function registryError(status: number, body: string): Error {
  let detail = body.slice(0, 300);
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    if (typeof parsed.message === 'string') detail = parsed.message;
  } catch {
    /* non-JSON error body */
  }
  return new Error(`Schema Registry responded ${status}${detail ? `: ${detail}` : ''}`);
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
  policy: BrokerSecurityPolicy
): Promise<KafkaRegistryClient> {
  const baseUrl = new URL(cfg.url);
  const agentOptions = buildRegistryAgentOptions(cfg.url, policy);
  await resolveSafeAddress(cfg.url, policy);
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
      ? { auth: { username: cfg.auth.username, password: cfg.auth.password ?? '' } }
      : {}),
    middlewares: [
      headerMiddleware(
        cfg.auth?.type === 'bearer' && authorization ? { Authorization: authorization } : {},
        timeout
      ),
    ],
  });

  const prefix = cfg.url.replace(/\/+$/, '');
  const getJson = (path: string): Promise<unknown> =>
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
      request.setTimeout(timeout, () =>
        request.destroy(new Error(`Schema Registry request timed out after ${timeout}ms`))
      );
      request.on('error', reject);
      request.end();
    });

  const subjectPath = (subject: string) => `/subjects/${encodeURIComponent(subject)}`;
  const idRefs = new Map<number, Promise<RegistrySchemaRef>>();
  const pinnedIds = new Map<string, number>();

  return {
    encode: (registryId, payload) => lib.encode(registryId, payload),
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
      if (cached) return cached;
      const lookup = getJson(`/schemas/ids/${id}/versions`).then(
        (raw): RegistrySchemaRef => {
          const first = Array.isArray(raw) ? (raw[0] as Record<string, unknown>) : undefined;
          return first && typeof first.subject === 'string' && typeof first.version === 'number'
            ? { id, subject: first.subject, version: first.version }
            : { id };
        },
        // Older registries lack this endpoint; cache the miss so decode stays cheap.
        (): RegistrySchemaRef => ({ id })
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
