/**
 * In-memory composer drafts for the Kafka and MQTT panels, keyed by
 * connection id (#984).
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

import type { KafkaPresetPayloadMode, KeyValue, MqttPresetQoS } from '@/types';

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

const kafkaDrafts = new Map<string, KafkaProduceDraft>();
const mqttDrafts = new Map<string, MqttComposerDraft>();

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

/** Drop every draft and pending credential of a removed connection. */
export function clearComposerDrafts(connectionId: string): void {
  kafkaDrafts.delete(connectionId);
  mqttDrafts.delete(connectionId);
  for (const key of pendingSecrets.keys()) {
    if (key.includes(`:${connectionId}:`)) pendingSecrets.delete(key);
  }
}
