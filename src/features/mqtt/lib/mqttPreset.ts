/**
 * MQTT connection ⇄ collection preset (#984).
 *
 * Mirror of `src/features/kafka/lib/kafkaPreset.ts`: the preset captures the
 * connection, the composer drafts and the saved publish templates — never the
 * password or TLS passphrase. Those live in main-process secret handles and
 * are copied in main between the live connection's scope
 * (`mqtt:<connectionId>:<field>`) and the preset's
 * (`mqtt:preset-<requestId>:<field>`) — the renderer never reads them back.
 */

import { v4 as uuidv4 } from 'uuid';
import {
  MQTT_SECRET_LABELS,
  type MqttSecretField,
  mqttSecretKey,
} from '@/features/mqtt/lib/mqttManager';
import {
  MQTT_SECRET_SENTINEL,
  type MqttConnection,
  useMqttStore,
} from '@/features/mqtt/store/useMqttStore';
import {
  copyBrokerSecret,
  ensureBrokerSecret,
  putBrokerSecret,
  removeBrokerSecret,
} from '@/lib/shared/broker-secrets';
import {
  getMqttComposerDraft,
  getPendingSecret,
  type MqttComposerDraft,
  setMqttComposerDraft,
} from '@/lib/shared/streaming/composerDrafts';
import { newTemplateId } from '@/lib/shared/streaming/messageTemplates';
import type { MqttPresetConnection, MqttPresetPublish, MqttRequest } from '@/types';

const SECRET_FIELDS: readonly MqttSecretField[] = ['password', 'tls-passphrase', 'auth-data'];

export function mqttPresetSecretScope(requestId: string): string {
  return `preset-${requestId}`;
}

const EMPTY_DRAFT: MqttComposerDraft = {
  pubTopic: '',
  pubPayload: '',
  pubQos: 0,
  pubRetain: false,
  subTopic: '',
  subQos: 0,
};

function presetConnection(conn: MqttConnection): MqttPresetConnection {
  const out: MqttPresetConnection = {
    brokerUrl: conn.brokerUrl,
    protocolVersion: conn.protocolVersion,
    clientId: conn.clientId,
    keepalive: conn.keepalive,
    cleanStart: conn.cleanStart,
    connectTimeout: conn.connectTimeout,
    autoReconnect: conn.autoReconnect,
  };
  if (conn.username !== undefined) out.username = conn.username;
  if (conn.tls) {
    const { caPath, certPath, keyPath, rejectUnauthorized } = conn.tls;
    out.tls = {
      ...(caPath !== undefined ? { caPath } : {}),
      ...(certPath !== undefined ? { certPath } : {}),
      ...(keyPath !== undefined ? { keyPath } : {}),
      ...(rejectUnauthorized !== undefined ? { rejectUnauthorized } : {}),
    };
  }
  if (conn.lwt) out.lwt = { ...conn.lwt };
  if (conn.connectProperties) {
    // Auth data is a local secret (copied with the preset's credentials).
    const { authenticationData: _secret, ...connectProperties } = conn.connectProperties;
    if (Object.keys(connectProperties).length > 0) out.connectProperties = connectProperties;
  }
  if (conn.sessionExpiryInterval !== undefined) {
    out.sessionExpiryInterval = conn.sessionExpiryInterval;
  }
  return out;
}

function templateToPreset(t: MqttConnection['templates'][number]): MqttPresetPublish {
  return {
    name: t.name,
    topic: t.topic,
    payload: t.payload,
    qos: t.qos,
    retain: t.retain,
    ...(t.contentType !== undefined ? { contentType: t.contentType } : {}),
    ...(t.responseTopic !== undefined ? { responseTopic: t.responseTopic } : {}),
    ...(t.userProperties ? { userProperties: { ...t.userProperties } } : {}),
  };
}

/** Snapshot a live connection + its composer drafts into a secret-free preset. */
export function mqttPresetFromConnection(
  conn: MqttConnection,
  name: string,
  id: string = uuidv4()
): MqttRequest {
  const draft = getMqttComposerDraft(conn.id) ?? EMPTY_DRAFT;
  return {
    id,
    name,
    type: 'mqtt',
    connection: presetConnection(conn),
    publish: {
      topic: draft.pubTopic,
      payload: draft.pubPayload,
      qos: draft.pubQos,
      retain: draft.pubRetain,
    },
    subscribe: { topicFilter: draft.subTopic, qos: draft.subQos },
    templates: conn.templates.map(templateToPreset),
  };
}

/** Seed connection `connectionId` (a fresh tab connection) from a preset. */
export function applyMqttPreset(connectionId: string, preset: MqttRequest): void {
  const store = useMqttStore.getState();
  const c = preset.connection;
  store.updateConnection(connectionId, {
    name: preset.name,
    brokerUrl: c.brokerUrl,
    protocolVersion: c.protocolVersion,
    clientId: c.clientId || `restura-${connectionId.slice(0, 8)}`,
    keepalive: c.keepalive,
    cleanStart: c.cleanStart,
    connectTimeout: c.connectTimeout,
    autoReconnect: c.autoReconnect,
    username: c.username,
    password: undefined,
    sessionExpiryInterval: c.sessionExpiryInterval,
    connectProperties: c.connectProperties ? { ...c.connectProperties } : undefined,
    templates: preset.templates.map((t) => ({ ...t, id: newTemplateId() })),
  });
  store.updateTls(connectionId, c.tls ? { ...c.tls } : undefined);
  store.updateLwt(connectionId, c.lwt ? { ...c.lwt } : undefined);
  setMqttComposerDraft(connectionId, {
    pubTopic: preset.publish.topic,
    pubPayload: preset.publish.payload,
    pubQos: preset.publish.qos,
    pubRetain: preset.publish.retain,
    subTopic: preset.subscribe.topicFilter,
    subQos: preset.subscribe.qos,
  });
}

/** Which credentials a preset holds — presence only, never the values. */
export type MqttPresetSecrets = Partial<Record<MqttSecretField, true>>;

/**
 * Save side: copy the credentials the connection holds into the preset scope;
 * fields it does not hold are cleared so a re-save never keeps a stale secret.
 * A typed-but-not-yet-connected (pending) value is stored directly.
 */
export async function storeMqttPresetSecrets(
  conn: MqttConnection,
  requestId: string
): Promise<void> {
  const target = mqttPresetSecretScope(requestId);
  const fieldValue: Record<MqttSecretField, string | undefined> = {
    password: conn.password,
    'tls-passphrase': conn.tls?.passphrase,
    'auth-data': conn.connectProperties?.authenticationData,
  };
  for (const field of SECRET_FIELDS) {
    const from = mqttSecretKey(conn.id, field);
    const to = mqttSecretKey(target, field);
    const label = MQTT_SECRET_LABELS[field];
    const value = getPendingSecret(from) ?? fieldValue[field];
    if (value === MQTT_SECRET_SENTINEL) await copyBrokerSecret(from, to, label);
    else if (value) await putBrokerSecret(to, value, label);
    else await removeBrokerSecret(to);
  }
}

/** Which credentials are stored for a preset (absent fields omitted). */
export async function readMqttPresetSecrets(requestId: string): Promise<MqttPresetSecrets> {
  const scope = mqttPresetSecretScope(requestId);
  const out: MqttPresetSecrets = {};
  for (const field of SECRET_FIELDS) {
    if (await ensureBrokerSecret(mqttSecretKey(scope, field), MQTT_SECRET_LABELS[field])) {
      out[field] = true;
    }
  }
  return out;
}

/**
 * Copy the preset's stored credentials (those listed in `secrets`) onto a tab
 * connection, then sentinel-mark them.
 */
export async function applyMqttPresetSecrets(
  connectionId: string,
  requestId: string,
  secrets: MqttPresetSecrets
): Promise<void> {
  const scope = mqttPresetSecretScope(requestId);
  const copied: MqttPresetSecrets = {};
  for (const field of SECRET_FIELDS) {
    if (!secrets[field]) continue;
    const ok = await copyBrokerSecret(
      mqttSecretKey(scope, field),
      mqttSecretKey(connectionId, field),
      MQTT_SECRET_LABELS[field]
    );
    if (ok) copied[field] = true;
  }
  const store = useMqttStore.getState();
  const conn = store.connections[connectionId];
  if (!conn) return;
  if (copied.password) store.updateConnection(connectionId, { password: MQTT_SECRET_SENTINEL });
  if (copied['tls-passphrase'] && conn.tls) {
    store.updateTls(connectionId, { ...conn.tls, passphrase: MQTT_SECRET_SENTINEL });
  }
  if (copied['auth-data']) {
    store.updateConnection(connectionId, {
      connectProperties: {
        ...(conn.connectProperties ?? {}),
        authenticationData: MQTT_SECRET_SENTINEL,
      },
    });
  }
}

/** Open side: copy the preset's credentials onto the tab connection. */
export async function restoreMqttPresetSecrets(
  requestId: string,
  connectionId: string
): Promise<void> {
  await applyMqttPresetSecrets(connectionId, requestId, await readMqttPresetSecrets(requestId));
}

/** Delete every credential stored for a preset (preset deleted). */
export function reapMqttPresetSecrets(requestId: string): void {
  const scope = mqttPresetSecretScope(requestId);
  for (const field of SECRET_FIELDS) {
    void removeBrokerSecret(mqttSecretKey(scope, field)).catch(() => {});
  }
}

/** Copy a preset's credentials to another preset id (duplicate). */
export async function copyMqttPresetSecrets(fromId: string, toId: string): Promise<void> {
  const from = mqttPresetSecretScope(fromId);
  const to = mqttPresetSecretScope(toId);
  for (const field of SECRET_FIELDS) {
    await copyBrokerSecret(
      mqttSecretKey(from, field),
      mqttSecretKey(to, field),
      MQTT_SECRET_LABELS[field]
    );
  }
}
