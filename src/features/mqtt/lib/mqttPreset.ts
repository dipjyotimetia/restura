/**
 * MQTT connection ⇄ collection preset (#984).
 *
 * Mirror of `src/features/kafka/lib/kafkaPreset.ts`: the preset captures the
 * connection, the composer drafts and the saved publish templates — never the
 * password or TLS passphrase. Those are copied between the live connection's
 * secure-storage scope (`mqtt:<connectionId>:<field>`) and the preset's
 * (`mqtt:preset-<requestId>:<field>`).
 */

import { v4 as uuidv4 } from 'uuid';
import { type MqttSecretField, mqttSecretKey } from '@/features/mqtt/lib/mqttManager';
import {
  MQTT_SECRET_SENTINEL,
  type MqttConnection,
  useMqttStore,
} from '@/features/mqtt/store/useMqttStore';
import { secureStorage } from '@/lib/shared/secure-storage';
import {
  getMqttComposerDraft,
  type MqttComposerDraft,
  setMqttComposerDraft,
} from '@/lib/shared/streaming/composerDrafts';
import { newTemplateId } from '@/lib/shared/streaming/messageTemplates';
import type { MqttPresetConnection, MqttPresetPublish, MqttRequest } from '@/types';

const SECRET_FIELDS: readonly MqttSecretField[] = ['password', 'tls-passphrase'];

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

/** Save side: copy the connection's stored credentials into the preset scope. */
export async function storeMqttPresetSecrets(
  conn: MqttConnection,
  requestId: string
): Promise<void> {
  const target = mqttPresetSecretScope(requestId);
  const held: Record<MqttSecretField, boolean> = {
    password: conn.password === MQTT_SECRET_SENTINEL,
    'tls-passphrase': conn.tls?.passphrase === MQTT_SECRET_SENTINEL,
  };
  for (const field of SECRET_FIELDS) {
    const value = held[field] ? await secureStorage.getAsync(mqttSecretKey(conn.id, field)) : null;
    if (value) secureStorage.set(mqttSecretKey(target, field), value);
    else secureStorage.remove(mqttSecretKey(target, field));
  }
}

/** Open side: copy the preset's credentials onto the tab connection (sentinel-marked). */
export async function restoreMqttPresetSecrets(
  requestId: string,
  connectionId: string
): Promise<void> {
  const source = mqttPresetSecretScope(requestId);
  const copied = new Set<MqttSecretField>();
  for (const field of SECRET_FIELDS) {
    const value = await secureStorage.getAsync(mqttSecretKey(source, field));
    if (value) {
      secureStorage.set(mqttSecretKey(connectionId, field), value);
      copied.add(field);
    }
  }
  const store = useMqttStore.getState();
  const conn = store.connections[connectionId];
  if (!conn) return;
  if (copied.has('password'))
    store.updateConnection(connectionId, { password: MQTT_SECRET_SENTINEL });
  if (copied.has('tls-passphrase') && conn.tls) {
    store.updateTls(connectionId, { ...conn.tls, passphrase: MQTT_SECRET_SENTINEL });
  }
}
