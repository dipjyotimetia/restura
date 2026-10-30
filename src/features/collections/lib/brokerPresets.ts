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
  type KafkaPresetSecrets,
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
import { secureStorage } from '@/lib/shared/secure-storage';
import { useRequestStore } from '@/store/useRequestStore';
import type { BrokerRequest, CollectionItem, KafkaRequest, MqttRequest, RequestTab } from '@/types';
import { isBrokerRequest } from '@/types';

/**
 * Stored credentials are bound to the broker address they were saved for: a
 * collection item whose brokers were repointed (import, hand edit, sync) must
 * not silently receive the original broker's password. The binding is a
 * fingerprint kept next to the secrets. The key contains "credential" so
 * `secureStorage` routes it to the encrypted store, never plaintext storage.
 */
const bindingKey = (type: BrokerRequest['type'], presetId: string) =>
  `preset-credential-binding:${type}:${presetId}`;

const normalizeAddress = (value: string) => value.trim().toLowerCase().replace(/\/+$/, '');

/** Normalised, order-independent identity of the endpoints a preset's credentials unlock. */
export function brokerPresetFingerprint(preset: BrokerRequest): string {
  if (preset.type === 'kafka') {
    const c = (preset as KafkaRequest).connection;
    return JSON.stringify({
      brokers: c.bootstrapBrokers.map(normalizeAddress).sort(),
      registry: c.registry ? normalizeAddress(c.registry.url) : null,
    });
  }
  return JSON.stringify({ broker: normalizeAddress((preset as MqttRequest).connection.brokerUrl) });
}

/** Record which endpoints `preset`'s stored credentials belong to. */
export function bindBrokerPresetCredentials(preset: BrokerRequest): void {
  secureStorage.set(bindingKey(preset.type, preset.id), brokerPresetFingerprint(preset));
}

async function credentialsMatchPreset(preset: BrokerRequest): Promise<boolean> {
  const bound = await secureStorage.getAsync(bindingKey(preset.type, preset.id));
  return bound === brokerPresetFingerprint(preset);
}

/**
 * Open a saved preset in a new Kafka / MQTT tab linked to `itemId`, seeded with
 * the preset's connection, drafts and stored credentials. Credentials are read
 * BEFORE the tab opens, so the panel never shows a Connect button for a
 * connection whose credentials are still being restored. Returns the tab id.
 */
export async function openBrokerPreset(itemId: string, preset: BrokerRequest): Promise<string> {
  const desktop = isElectron();
  // Kafka: presence flags (values stay in main-process handles). MQTT: its
  // own preset secret map.
  let secrets: Record<string, string | true> = {};
  if (desktop) {
    try {
      secrets =
        preset.type === 'kafka'
          ? await readKafkaPresetSecrets(preset.id)
          : await readMqttPresetSecrets(preset.id);
      // Credentials saved before bindings existed have no fingerprint and are
      // treated like a mismatch: re-entering once re-saves them with a binding.
      if (Object.keys(secrets).length > 0 && !(await credentialsMatchPreset(preset))) {
        secrets = {};
        toast.warning(
          'Saved credentials were not applied because the broker address changed — re-enter them before connecting'
        );
      }
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
    if (Object.keys(secrets).length > 0) {
      try {
        // Handle copy preset → connection happens in main (SEC-K3).
        await applyKafkaPresetSecrets(preset.id, connectionId, secrets as KafkaPresetSecrets);
      } catch {
        toast.error('Could not read the saved credentials — re-enter them before connecting');
      }
    }
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
      persistSecrets: async () => {
        await storeKafkaPresetSecrets(conn, request.id);
        bindBrokerPresetCredentials(request);
      },
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
      persistSecrets: async () => {
        await storeMqttPresetSecrets(conn, request.id);
        bindBrokerPresetCredentials(request);
      },
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
  walkPresets(items, (preset) => {
    secureStorage.remove(bindingKey(preset.type, preset.id));
    // Fire-and-forget: deleting the item must not wait on (or fail with) the keychain.
    if (preset.type === 'kafka') void reapKafkaPresetSecrets(preset.id).catch(() => undefined);
    else reapMqttPresetSecrets(preset.id);
  });
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
  let failed = 0;
  for (const [i, original] of from.entries()) {
    const copy = to[i];
    if (!copy || copy.type !== original.type || copy.id === original.id) continue;
    try {
      if (original.type === 'kafka') await copyKafkaPresetSecrets(original.id, copy.id);
      else await copyMqttPresetSecrets(original.id, copy.id);
      // The clone keeps the original's endpoints, so it inherits the binding.
      const bound = await secureStorage.getAsync(bindingKey(original.type, original.id));
      if (bound) secureStorage.set(bindingKey(copy.type, copy.id), bound);
    } catch {
      // Keep copying the remaining presets; report once at the end.
      failed++;
    }
  }
  if (failed > 0) throw new Error(`Could not copy credentials for ${failed} preset(s)`);
}

export const DUPLICATE_CREDENTIALS_FAILED =
  'Duplicated without some credentials — re-enter them after opening the copy';

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
