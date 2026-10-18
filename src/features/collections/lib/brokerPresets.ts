/**
 * Collection-side glue for Kafka / MQTT connection presets (#984): opening a
 * saved preset into a connection-mode tab, and snapshotting a Kafka / MQTT tab
 * into a preset for Save to Collection.
 *
 * Kafka and MQTT are desktop-only. On the web build an opened preset still
 * gets its tab (which renders the "Desktop only" panel) but no connection is
 * created and no secure storage is touched.
 */

import {
  applyKafkaPreset,
  kafkaPresetFromConnection,
  restoreKafkaPresetSecrets,
  storeKafkaPresetSecrets,
} from '@/features/kafka/lib/kafkaPreset';
import { useKafkaStore } from '@/features/kafka/store/useKafkaStore';
import {
  applyMqttPreset,
  mqttPresetFromConnection,
  restoreMqttPresetSecrets,
  storeMqttPresetSecrets,
} from '@/features/mqtt/lib/mqttPreset';
import { useMqttStore } from '@/features/mqtt/store/useMqttStore';
import { isElectron } from '@/lib/shared/platform';
import { useRequestStore } from '@/store/useRequestStore';
import type { BrokerRequest, RequestTab } from '@/types';

/**
 * Open a saved preset in a new Kafka / MQTT tab linked to `itemId`, seeded with
 * the preset's connection and drafts. Resolves once stored credentials (if
 * any) have been copied onto the tab's connection. Returns the new tab id.
 */
export async function openBrokerPreset(itemId: string, preset: BrokerRequest): Promise<string> {
  const requests = useRequestStore.getState();
  const tabId = requests.openTabWithMode(preset.type);
  requests.renameTab(tabId, preset.name);
  requests.linkTabToSavedRequest(tabId, itemId);
  if (!isElectron()) return tabId;

  if (preset.type === 'kafka') {
    const connectionId = useKafkaStore.getState().ensureConnectionForTab(tabId);
    applyKafkaPreset(connectionId, preset);
    await restoreKafkaPresetSecrets(preset.id, connectionId);
  } else {
    const connectionId = useMqttStore.getState().ensureConnectionForTab(tabId);
    applyMqttPreset(connectionId, preset);
    await restoreMqttPresetSecrets(preset.id, connectionId);
  }
  return tabId;
}

export interface BrokerPresetSnapshot {
  request: BrokerRequest;
  /** Copy the tab connection's stored credentials into the preset's own scope. */
  persistSecrets: () => Promise<void>;
}

/**
 * Snapshot a Kafka / MQTT tab into a preset named `name`, or null when the tab
 * is not a broker tab or has no connection yet (web build, or the panel never
 * mounted).
 */
export function snapshotBrokerTab(
  tab: Pick<RequestTab, 'id' | 'modeOverride'>,
  name: string
): BrokerPresetSnapshot | null {
  if (tab.modeOverride === 'kafka') {
    const state = useKafkaStore.getState();
    const conn = state.connections[state.connectionByTabId[tab.id] ?? ''];
    if (!conn) return null;
    const request = kafkaPresetFromConnection(conn, name);
    return { request, persistSecrets: () => storeKafkaPresetSecrets(conn, request.id) };
  }
  if (tab.modeOverride === 'mqtt') {
    const state = useMqttStore.getState();
    const conn = state.connections[state.connectionByTabId[tab.id] ?? ''];
    if (!conn) return null;
    const request = mqttPresetFromConnection(conn, name);
    return { request, persistSecrets: () => storeMqttPresetSecrets(conn, request.id) };
  }
  return null;
}
