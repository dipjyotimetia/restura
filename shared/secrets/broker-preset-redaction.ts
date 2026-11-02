import {
  isReferenceOnlyUserinfo,
  redactUrlCredentialsForStorage,
} from '../collections/postman/text-redaction';
import type { CollectionRequest, KafkaRequest, MqttPresetPublish, MqttRequest } from '../types';
import {
  countSecretKeyValues,
  isSecretFieldName,
  redactSecretKeyValues,
} from './key-value-redaction';
import { blankSecretSlots, countSecretSlots, type SecretSlot, slotsForKind } from './secret-slot';

/**
 * Export-time redaction for Kafka / MQTT connection presets (#984).
 *
 * Presets have no credential fields (those live in the desktop secure store),
 * but free-text fields can still carry one:
 *  - URL userinfo in a broker / registry address (`mqtt://user:pw@host`,
 *    `user:pw@broker:9092`) — stripped, up to the last `@` of the authority.
 *    Userinfo made only of `{{var}}` references is kept: a reference is not a
 *    secret. An address whose `@` has no safe reading is blanked whole (see
 *    {@link redactAddress}).
 *  - Kafka record headers, MQTT 5 user properties (publish, templates, will,
 *    CONNECT) and SASL/OAUTHBEARER extensions with credential-looking names —
 *    values blanked, keys kept (same policy as HTTP headers). Other extension
 *    values are routing data the connection needs (`logicalCluster`,
 *    `identityPoolId`), so they are kept.
 */

const USERINFO = /^([a-z][a-z0-9+.-]*:\/\/)?([^/?#]*)@/i;
const AUTHORITY = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i;
const IPV6_LITERAL = /^\[[^\]]*\]/;

function parses(address: string): boolean {
  try {
    new URL(address);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when `address` (userinfo already removed) can keep any `@` it still has.
 * Broker and registry addresses fail closed: an `@` is only accepted where the
 * parser and this check agree it cannot be part of a userinfo.
 */
function canKeepAtSign(address: string): boolean {
  if (!address.includes('@')) return true;
  const authority = AUTHORITY.exec(address)?.[1];
  if (!authority || authority.includes('{{') || !parses(address)) return false;
  return !authority.replace(IPV6_LITERAL, '').includes(':');
}

/**
 * `address` without literal userinfo; `''` when no part of it can be trusted to
 * be free of credentials. A blanked address saves as an empty field, which every
 * connect path rejects with a validation error (it never falls back to a
 * default), so the user re-enters it. Idempotent.
 */
function withoutAddressUserinfo(address: string): string {
  if (!address.includes('@')) return address;
  const match = USERINFO.exec(address);
  const rest = match ? `${match[1] ?? ''}${address.slice(match[0].length)}` : address;
  if (!canKeepAtSign(rest)) return '';
  return match && isReferenceOnlyUserinfo(match[2] ?? '') ? address : rest;
}

/** {@link withoutAddressUserinfo}, with credential-named query values blanked too. */
function redactAddress(address: string): string {
  return redactUrlCredentialsForStorage(withoutAddressUserinfo(address));
}

/** True when {@link stripUrlUserinfo} would change `address`. */
export function hasUrlUserinfo(address: string): boolean {
  return redactAddress(address) !== address;
}

/** Drop literal userinfo from a broker / registry address. */
export function stripUrlUserinfo(address: string): string {
  return redactAddress(address);
}

/** How many of this preset's addresses a redaction saves empty. */
export function countBlankedAddresses(request: CollectionRequest): number {
  const addresses =
    request.type === 'kafka'
      ? [...request.connection.bootstrapBrokers, request.connection.registry?.url ?? '']
      : request.type === 'mqtt'
        ? [request.connection.brokerUrl]
        : [];
  return addresses.filter((a) => a !== '' && redactAddress(a) === '').length;
}

function redactProperties(props: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(props).map(([k, v]) => [k, isSecretFieldName(k) ? '' : v])
  );
}

function countProperties(props: Record<string, string> | undefined): number {
  return Object.entries(props ?? {}).filter(([k, v]) => v !== '' && isSecretFieldName(k)).length;
}

function redactPublish<T extends Omit<MqttPresetPublish, 'name'>>(p: T): T {
  return p.userProperties ? { ...p, userProperties: redactProperties(p.userProperties) } : p;
}

export const BROKER_PRESET_SLOTS: readonly SecretSlot[] = [
  ...slotsForKind('kafka', [
    {
      name: 'bootstrapBrokers',
      blank: (r: KafkaRequest) => ({
        ...r,
        connection: {
          ...r.connection,
          bootstrapBrokers: r.connection.bootstrapBrokers.map(stripUrlUserinfo),
        },
      }),
      count: (r: KafkaRequest) => r.connection.bootstrapBrokers.filter(hasUrlUserinfo).length,
    },
    {
      name: 'registry',
      blank(r: KafkaRequest) {
        const registry = r.connection.registry;
        if (!registry) return r;
        return {
          ...r,
          connection: {
            ...r.connection,
            registry: { ...registry, url: stripUrlUserinfo(registry.url) },
          },
        };
      },
      count: (r: KafkaRequest) =>
        r.connection.registry && hasUrlUserinfo(r.connection.registry.url) ? 1 : 0,
    },
    {
      name: 'produceHeaders',
      blank: (r: KafkaRequest) => ({
        ...r,
        produce: { ...r.produce, headers: redactSecretKeyValues(r.produce.headers) ?? [] },
      }),
      count: (r: KafkaRequest) => countSecretKeyValues(r.produce.headers),
    },
    {
      name: 'saslExtensions',
      blank(r: KafkaRequest) {
        const sasl = r.connection.sasl;
        if (!sasl?.extensions) return r;
        return {
          ...r,
          connection: {
            ...r.connection,
            sasl: { ...sasl, extensions: redactProperties(sasl.extensions) },
          },
        };
      },
      count: (r: KafkaRequest) => countProperties(r.connection.sasl?.extensions),
    },
  ]),
  ...slotsForKind('mqtt', [
    {
      name: 'brokerUrl',
      blank: (r: MqttRequest) => ({
        ...r,
        connection: { ...r.connection, brokerUrl: stripUrlUserinfo(r.connection.brokerUrl) },
      }),
      count: (r: MqttRequest) => (hasUrlUserinfo(r.connection.brokerUrl) ? 1 : 0),
    },
    {
      name: 'lwtUserProperties',
      blank(r: MqttRequest) {
        const lwt = r.connection.lwt;
        if (!lwt?.properties?.userProperties) return r;
        const properties = {
          ...lwt.properties,
          userProperties: redactProperties(lwt.properties.userProperties),
        };
        return { ...r, connection: { ...r.connection, lwt: { ...lwt, properties } } };
      },
      count: (r: MqttRequest) => countProperties(r.connection.lwt?.properties?.userProperties),
    },
    {
      name: 'connectUserProperties',
      blank(r: MqttRequest) {
        const connectProperties = r.connection.connectProperties;
        if (!connectProperties?.userProperties) return r;
        return {
          ...r,
          connection: {
            ...r.connection,
            connectProperties: {
              ...connectProperties,
              userProperties: redactProperties(connectProperties.userProperties),
            },
          },
        };
      },
      count: (r: MqttRequest) => countProperties(r.connection.connectProperties?.userProperties),
    },
    {
      name: 'publish',
      blank: (r: MqttRequest) => ({ ...r, publish: redactPublish(r.publish) }),
      count: (r: MqttRequest) => countProperties(r.publish.userProperties),
    },
    {
      name: 'templates',
      blank: (r: MqttRequest) => ({ ...r, templates: r.templates.map(redactPublish) }),
      count: (r: MqttRequest) =>
        r.templates.reduce((n, t) => n + countProperties(t.userProperties), 0),
    },
  ]),
];

/** Copy of a Kafka / MQTT preset with free-text credentials removed; other kinds unchanged. */
export function redactBrokerPreset<T extends CollectionRequest>(request: T): T {
  return blankSecretSlots(BROKER_PRESET_SLOTS, request);
}

/** Plaintext credentials {@link redactBrokerPreset} would remove. */
export function countBrokerPresetSecrets(request: CollectionRequest): number {
  return countSecretSlots(BROKER_PRESET_SLOTS, request);
}
