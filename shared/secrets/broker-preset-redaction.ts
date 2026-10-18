import type { CollectionRequest, KafkaRequest, MqttPresetPublish, MqttRequest } from '../types';
import {
  countSecretKeyValues,
  isSecretFieldName,
  redactSecretKeyValues,
} from './key-value-redaction';

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

/** Copy of a Kafka / MQTT preset with free-text credentials removed; other kinds unchanged. */
export function redactBrokerPreset<T extends CollectionRequest>(request: T): T {
  if (request.type === 'kafka') {
    const r = request as KafkaRequest;
    const registry = r.connection.registry;
    return {
      ...r,
      connection: {
        ...r.connection,
        bootstrapBrokers: r.connection.bootstrapBrokers.map(stripUrlUserinfo),
        ...(registry ? { registry: { ...registry, url: stripUrlUserinfo(registry.url) } } : {}),
      },
      produce: { ...r.produce, headers: redactSecretKeyValues(r.produce.headers) ?? [] },
    } as T;
  }
  if (request.type === 'mqtt') {
    const r = request as MqttRequest;
    return {
      ...r,
      connection: { ...r.connection, brokerUrl: stripUrlUserinfo(r.connection.brokerUrl) },
      publish: redactPublish(r.publish),
      templates: r.templates.map(redactPublish),
    } as T;
  }
  return request;
}

/** Plaintext credentials {@link redactBrokerPreset} would remove. */
export function countBrokerPresetSecrets(request: CollectionRequest): number {
  if (request.type === 'kafka') {
    const c = request.connection;
    return (
      c.bootstrapBrokers.filter(hasUrlUserinfo).length +
      (c.registry && hasUrlUserinfo(c.registry.url) ? 1 : 0) +
      countSecretKeyValues(request.produce.headers)
    );
  }
  if (request.type === 'mqtt') {
    return (
      (hasUrlUserinfo(request.connection.brokerUrl) ? 1 : 0) +
      countProperties(request.publish.userProperties) +
      request.templates.reduce((n, t) => n + countProperties(t.userProperties), 0)
    );
  }
  return 0;
}
