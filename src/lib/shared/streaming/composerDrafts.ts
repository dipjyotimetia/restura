/**
 * In-memory composer drafts for the Kafka, MQTT (#984), WebSocket and
 * Socket.IO (#1209) panels, keyed by connection id.
 *
 * The produce / publish / subscribe forms keep their text in component state.
 * Two flows need it outside the component:
 *
 *  - Save to collection: the tab bar dialog reads the live draft to capture
 *    the operation (topic, key, payload template, headers) in the preset.
 *  - Opening a preset: the item seeds the draft before the panel mounts, and
 *    the panel reads it when it initialises for that connection.
 *
 * Deliberately NOT persisted: drafts are working text, and anything that must
 * survive a restart is saved explicitly as a collection item. Values are
 * stored unresolved (`{{var}}` intact) — resolution happens at send time.
 */

import type {
  KafkaPresetPayloadMode,
  KeyValue,
  MqttPresetQoS,
  WebSocketPresetFormat,
} from '@/types';

export interface KafkaProduceDraft {
  key: string;
  keyEncoding: KafkaPresetPayloadMode;
  value: string;
  valueEncoding: KafkaPresetPayloadMode;
  headers: KeyValue[];
  /** Raw partition text as typed; empty = broker-assigned. */
  partition: string;
}

export interface MqttComposerDraft {
  pubTopic: string;
  pubPayload: string;
  pubQos: MqttPresetQoS;
  pubRetain: boolean;
  subTopic: string;
  subQos: MqttPresetQoS;
}

export interface WebSocketComposerDraft {
  body: string;
  format: WebSocketPresetFormat;
}

export interface SocketIoComposerDraft {
  eventName: string;
  /** Raw JSON args text as typed. */
  args: string;
  ack: boolean;
}

const kafkaDrafts = new Map<string, KafkaProduceDraft>();
const mqttDrafts = new Map<string, MqttComposerDraft>();
const webSocketDrafts = new Map<string, WebSocketComposerDraft>();
const socketIoDrafts = new Map<string, SocketIoComposerDraft>();

export function getWebSocketComposerDraft(
  connectionId: string | null
): WebSocketComposerDraft | undefined {
  return connectionId ? webSocketDrafts.get(connectionId) : undefined;
}

export function setWebSocketComposerDraft(connectionId: string, draft: WebSocketComposerDraft) {
  webSocketDrafts.set(connectionId, draft);
}

export function getSocketIoComposerDraft(
  connectionId: string | null
): SocketIoComposerDraft | undefined {
  return connectionId ? socketIoDrafts.get(connectionId) : undefined;
}

export function setSocketIoComposerDraft(connectionId: string, draft: SocketIoComposerDraft) {
  socketIoDrafts.set(connectionId, draft);
}

export function getKafkaProduceDraft(connectionId: string | null): KafkaProduceDraft | undefined {
  return connectionId ? kafkaDrafts.get(connectionId) : undefined;
}

export function setKafkaProduceDraft(connectionId: string, draft: KafkaProduceDraft): void {
  kafkaDrafts.set(connectionId, draft);
}

export function getMqttComposerDraft(connectionId: string | null): MqttComposerDraft | undefined {
  return connectionId ? mqttDrafts.get(connectionId) : undefined;
}

export function setMqttComposerDraft(connectionId: string, draft: MqttComposerDraft): void {
  mqttDrafts.set(connectionId, draft);
}

/**
 * Credentials typed into a connection form but not yet stored (they move to
 * secure storage on Connect). Kept in memory only — never persisted — so Save
 * to Collection before connecting can still hand them to the preset's secure
 * storage scope. Keyed by the protocol's secure-storage key for the field.
 */
const pendingSecrets = new Map<string, string>();

export function setPendingSecret(storageKey: string, value: string): void {
  if (value) pendingSecrets.set(storageKey, value);
  else pendingSecrets.delete(storageKey);
}

export function getPendingSecret(storageKey: string): string | undefined {
  return pendingSecrets.get(storageKey);
}

/**
 * Drop a connection's pending (typed, unconnected) credentials. Called when its
 * form stops showing them (switch / unmount), so a later save can never store a
 * credential the user no longer sees.
 */
export function clearPendingSecrets(connectionId: string): void {
  for (const key of pendingSecrets.keys()) {
    if (key.includes(`:${connectionId}:`)) pendingSecrets.delete(key);
  }
}

/** Drop every draft and pending credential of a removed connection. */
export function clearComposerDrafts(connectionId: string): void {
  kafkaDrafts.delete(connectionId);
  mqttDrafts.delete(connectionId);
  webSocketDrafts.delete(connectionId);
  socketIoDrafts.delete(connectionId);
  clearPendingSecrets(connectionId);
}
