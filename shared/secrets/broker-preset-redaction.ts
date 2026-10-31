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
 *    `user:pw@broker:9092`) — stripped. Userinfo made only of `{{var}}`
 *    references is kept: a reference is not a secret.
 *  - Kafka record headers and MQTT 5 user properties with credential-looking
 *    names — values blanked, keys kept (same policy as HTTP headers).
 */

const USERINFO = /^([a-z][a-z0-9+.-]*:\/\/)?([^\s/@?#]*)@/i;

function isTemplateOnly(userinfo: string): boolean {
  return userinfo.replace(/\{\{[^{}]*\}\}/g, '').replace(/:/g, '') === '';
}

/** True when `address` carries literal (non-`{{var}}`) userinfo. */
export function hasUrlUserinfo(address: string): boolean {
  const m = USERINFO.exec(address);
  return !!m && !isTemplateOnly(m[2] ?? '');
}

/** Drop literal userinfo from a broker / registry address. */
export function stripUrlUserinfo(address: string): string {
  return hasUrlUserinfo(address) ? address.replace(USERINFO, '$1') : address;
}

function redactProperties(
  props: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!props) return props;
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
