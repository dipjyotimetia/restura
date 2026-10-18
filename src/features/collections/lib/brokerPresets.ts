/**
 * Collection-side glue for Kafka / MQTT connection presets (#984): opening a
 * saved preset into a connection-mode tab, snapshotting a Kafka / MQTT tab
 * into a preset (new item or save-back), and the preset credential lifecycle
 * (reap on delete, copy on duplicate).
 *
 * Kafka and MQTT are desktop-only. On the web build an opened preset still
 * gets its tab (which renders the "Desktop only" panel) but no connection is
 * created and no secure storage is touched.
 */

import { hasUrlUserinfo, stripUrlUserinfo } from '@shared/secrets/broker-preset-redaction';
import { toast } from 'sonner';
import {
  applyKafkaPreset,
  applyKafkaPresetSecrets,
  copyKafkaPresetSecrets,
  kafkaPresetFromConnection,
  readKafkaPresetSecrets,
  reapKafkaPresetSecrets,
  storeKafkaPresetSecrets,
} from '@/features/kafka/lib/kafkaPreset';
import { useKafkaStore } from '@/features/kafka/store/useKafkaStore';
import {
  applyMqttPreset,
  applyMqttPresetSecrets,
  copyMqttPresetSecrets,
  mqttPresetFromConnection,
  readMqttPresetSecrets,
  reapMqttPresetSecrets,
  storeMqttPresetSecrets,
} from '@/features/mqtt/lib/mqttPreset';
import { useMqttStore } from '@/features/mqtt/store/useMqttStore';
import { isElectron } from '@/lib/shared/platform';
import { useRequestStore } from '@/store/useRequestStore';
import type { BrokerRequest, CollectionItem, KafkaRequest, MqttRequest, RequestTab } from '@/types';
import { isBrokerRequest } from '@/types';

/**
 * Open a saved preset in a new Kafka / MQTT tab linked to `itemId`, seeded with
 * the preset's connection, drafts and stored credentials. Credentials are read
 * BEFORE the tab opens, so the panel never shows a Connect button for a
 * connection whose credentials are still being restored. Returns the tab id.
 */
export async function openBrokerPreset(itemId: string, preset: BrokerRequest): Promise<string> {
  const desktop = isElectron();
  let secrets = {};
  if (desktop) {
    try {
      secrets =
        preset.type === 'kafka'
          ? await readKafkaPresetSecrets(preset.id)
          : await readMqttPresetSecrets(preset.id);
    } catch {
      // Keychain unavailable: still open the preset, without credentials.
      toast.error('Could not read the saved credentials — re-enter them before connecting');
    }
  }

  const requests = useRequestStore.getState();
  const tabId = requests.openTabWithMode(preset.type);
  requests.renameTab(tabId, preset.name);
  requests.linkTabToSavedRequest(tabId, itemId);
  if (!desktop) return tabId;

  if (preset.type === 'kafka') {
    const connectionId = useKafkaStore.getState().ensureConnectionForTab(tabId);
    applyKafkaPreset(connectionId, preset);
    applyKafkaPresetSecrets(connectionId, secrets);
  } else {
    const connectionId = useMqttStore.getState().ensureConnectionForTab(tabId);
    applyMqttPreset(connectionId, preset);
    applyMqttPresetSecrets(connectionId, secrets);
  }
  return tabId;
}

export interface BrokerPresetSnapshot {
  request: BrokerRequest;
  /** Credentials typed into a broker / registry URL that were stripped. */
  strippedUserinfo: boolean;
  /** Copy the tab connection's credentials into the preset's own scope. */
  persistSecrets: () => Promise<void>;
}

/** Remove literal `user:pw@` from preset addresses; credentials belong in the secure store. */
function withoutUserinfo<T extends BrokerRequest>(request: T): { request: T; stripped: boolean } {
  if (request.type === 'kafka') {
    const r = request as KafkaRequest;
    const c = r.connection;
    const stripped =
      c.bootstrapBrokers.some(hasUrlUserinfo) || (!!c.registry && hasUrlUserinfo(c.registry.url));
    if (!stripped) return { request, stripped };
    return {
      stripped,
      request: {
        ...r,
        connection: {
          ...c,
          bootstrapBrokers: c.bootstrapBrokers.map(stripUrlUserinfo),
          ...(c.registry
            ? { registry: { ...c.registry, url: stripUrlUserinfo(c.registry.url) } }
            : {}),
        },
      } as T,
    };
  }
  const r = request as MqttRequest;
  const stripped = hasUrlUserinfo(r.connection.brokerUrl);
  if (!stripped) return { request, stripped };
  return {
    stripped,
    request: {
      ...r,
      connection: { ...r.connection, brokerUrl: stripUrlUserinfo(r.connection.brokerUrl) },
    } as T,
  };
}

/**
 * Snapshot a Kafka / MQTT tab into a preset named `name` (reusing `id` for a
 * save-back), or null when the tab is not a broker tab or has no connection
 * yet (web build, or the panel never mounted).
 */
export function snapshotBrokerTab(
  tab: Pick<RequestTab, 'id' | 'modeOverride'>,
  name: string,
  id?: string
): BrokerPresetSnapshot | null {
  if (tab.modeOverride === 'kafka') {
    const state = useKafkaStore.getState();
    const conn = state.connections[state.connectionByTabId[tab.id] ?? ''];
    if (!conn) return null;
    const { request, stripped } = withoutUserinfo(kafkaPresetFromConnection(conn, name, id));
    return {
      request,
      strippedUserinfo: stripped,
      persistSecrets: () => storeKafkaPresetSecrets(conn, request.id),
    };
  }
  if (tab.modeOverride === 'mqtt') {
    const state = useMqttStore.getState();
    const conn = state.connections[state.connectionByTabId[tab.id] ?? ''];
    if (!conn) return null;
    const { request, stripped } = withoutUserinfo(mqttPresetFromConnection(conn, name, id));
    return {
      request,
      strippedUserinfo: stripped,
      persistSecrets: () => storeMqttPresetSecrets(conn, request.id),
    };
  }
  return null;
}

export const USERINFO_STRIPPED_WARNING =
  'Credentials in the broker / registry address were not saved — use the password fields instead';

function walkPresets(items: CollectionItem[], visit: (preset: BrokerRequest) => void): void {
  for (const item of items) {
    if (item.request && isBrokerRequest(item.request)) visit(item.request);
    if (item.items) walkPresets(item.items, visit);
  }
}

/** Delete the stored credentials of every preset in `items` (deleted items/folders/collections). */
export function reapBrokerPresetSecrets(items: CollectionItem[]): void {
  walkPresets(items, (preset) =>
    preset.type === 'kafka' ? reapKafkaPresetSecrets(preset.id) : reapMqttPresetSecrets(preset.id)
  );
}

/**
 * Copy stored preset credentials from `source` to its structural clone
 * (duplicated item or collection — same shape, fresh request ids).
 */
export async function copyBrokerPresetSecrets(
  source: CollectionItem[],
  clone: CollectionItem[]
): Promise<void> {
  const from: BrokerRequest[] = [];
  const to: BrokerRequest[] = [];
  walkPresets(source, (p) => from.push(p));
  walkPresets(clone, (p) => to.push(p));
  for (const [i, original] of from.entries()) {
    const copy = to[i];
    if (!copy || copy.type !== original.type || copy.id === original.id) continue;
    if (original.type === 'kafka') await copyKafkaPresetSecrets(original.id, copy.id);
    else await copyMqttPresetSecrets(original.id, copy.id);
  }
}

function findItemById(items: CollectionItem[], id: string): CollectionItem | undefined {
  for (const item of items) {
    if (item.id === id) return item;
    const nested = item.items ? findItemById(item.items, id) : undefined;
    if (nested) return nested;
  }
  return undefined;
}

/** Reap the stored credentials of item `itemId` (and, for a folder, everything below it). */
export function reapBrokerPresetSecretsForItem(items: CollectionItem[], itemId: string): void {
  const item = findItemById(items, itemId);
  if (item) reapBrokerPresetSecrets([item]);
}
