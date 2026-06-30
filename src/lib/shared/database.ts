/**
 * Dexie IndexedDB database for offline-first, privacy-focused storage.
 * Records are stored as `encryptedData` strings; whether they are actually
 * AES-GCM-encrypted depends on the active KeyProvider (encrypted on desktop
 * via the OS keychain, plaintext on the web default — see keyProvider.ts).
 */

import Dexie, { type Table } from 'dexie';
import type {
  Collection,
  Environment,
  Request,
  Response,
  AppSettings,
  Workflow,
  WorkflowExecution,
} from '@/types';

// Database record types with encryption support
export interface CollectionRecord {
  id: string;
  name: string;
  updatedAt: number;
  // Encrypted JSON string containing: items, auth, variables, description
  encryptedData: string;
}

export interface EnvironmentRecord {
  id: string;
  name: string;
  updatedAt: number;
  // Encrypted JSON string containing: variables
  encryptedData: string;
}

export interface HistoryRecord {
  id: string;
  timestamp: number;
  method: string;
  url: string;
  // Encrypted JSON string containing: request, response
  encryptedData: string;
}

export interface SettingsRecord {
  id: string;
  updatedAt: number;
  // Encrypted JSON string containing: all settings
  encryptedData: string;
}

export interface CookieRecord {
  id: string;
  domain: string;
  path: string;
  updatedAt: number;
  // Encrypted JSON string containing: key, value, expires, secure, httpOnly
  encryptedData: string;
}

export interface WorkflowRecord {
  id: string;
  name: string;
  updatedAt: number;
  // Encrypted JSON string containing: requests, variables, config
  encryptedData: string;
}

export interface WorkflowExecutionRecord {
  id: string;
  workflowId: string;
  timestamp: number;
  status: 'pending' | 'running' | 'completed' | 'failed';
  // Encrypted JSON string containing: results, variables, errors
  encryptedData: string;
}

export interface FileCollectionRecord {
  id: string;
  name: string;
  directoryPath: string;
  lastSynced: number;
  // Encrypted JSON string containing: files metadata
  encryptedData: string;
}

export interface RequestTabsRecord {
  id: string;
  name: string;
  updatedAt: number;
  // Encrypted JSON string containing: tabs, activeTabId
  encryptedData: string;
}

export interface NamedEncryptedRecord {
  id: string;
  name: string;
  updatedAt: number;
  encryptedData: string;
}

export type WebSocketConnectionsRecord = NamedEncryptedRecord;
export type SseConnectionsRecord = NamedEncryptedRecord;
export type McpConnectionsRecord = NamedEncryptedRecord;
export type KafkaConnectionsRecord = NamedEncryptedRecord;
export type MqttConnectionsRecord = NamedEncryptedRecord;
export type SocketIoConnectionsRecord = NamedEncryptedRecord;
export type ConsoleRecord = NamedEncryptedRecord;
export type GraphqlSchemaRecord = NamedEncryptedRecord;
export type ProtoFileRecord = NamedEncryptedRecord;

// Metadata table for app state
export interface MetadataRecord {
  key: string;
  value: string;
}

/** Restura IndexedDB database — offline-first, privacy-focused storage. */
export class ResturaDB extends Dexie {
  // Declare tables
  collections!: Table<CollectionRecord, string>;
  environments!: Table<EnvironmentRecord, string>;
  history!: Table<HistoryRecord, string>;
  settings!: Table<SettingsRecord, string>;
  cookies!: Table<CookieRecord, string>;
  workflows!: Table<WorkflowRecord, string>;
  workflowExecutions!: Table<WorkflowExecutionRecord, string>;
  fileCollections!: Table<FileCollectionRecord, string>;
  requestTabs!: Table<RequestTabsRecord, string>;
  websocketConnections!: Table<WebSocketConnectionsRecord, string>;
  sseConnections!: Table<SseConnectionsRecord, string>;
  mcpConnections!: Table<McpConnectionsRecord, string>;
  kafkaConnections!: Table<KafkaConnectionsRecord, string>;
  mqttConnections!: Table<MqttConnectionsRecord, string>;
  socketioConnections!: Table<SocketIoConnectionsRecord, string>;
  console!: Table<ConsoleRecord, string>;
  graphqlSchemas!: Table<GraphqlSchemaRecord, string>;
  protoFiles!: Table<ProtoFileRecord, string>;
  aiChat!: Table<NamedEncryptedRecord, string>;
  globals!: Table<NamedEncryptedRecord, string>;
  aiLab!: Table<NamedEncryptedRecord, string>;
  evalRuns!: Table<NamedEncryptedRecord, string>;
  arenaRuns!: Table<NamedEncryptedRecord, string>;
  collectionRuns!: Table<NamedEncryptedRecord, string>;
  metadata!: Table<MetadataRecord, string>;

  constructor() {
    super('restura-db');

    // Schema version 1 - Initial setup
    this.version(1).stores({
      // Collections - searchable by name, sorted by update time
      collections: 'id, name, updatedAt',

      // Environments - searchable by name
      environments: 'id, name, updatedAt',

      // History - sorted by timestamp, searchable by method/url
      history: 'id, timestamp, method, url, [method+url]',

      // Settings - single record
      settings: 'id, updatedAt',

      // Cookies - searchable by domain and path
      cookies: 'id, domain, path, [domain+path], updatedAt',

      // Workflows - searchable by name
      workflows: 'id, name, updatedAt',

      // Workflow executions - linked to workflow, sorted by time
      workflowExecutions: 'id, workflowId, timestamp, status',

      // File collections - directory-based collections
      fileCollections: 'id, name, directoryPath, lastSynced',

      // Metadata - key-value store for app state
      metadata: 'key',
    });

    this.version(2).stores({
      // Schema v2 — add requestTabs table for multi-tab persistence
      requestTabs: 'id, name, updatedAt',
    });

    this.version(3).stores({
      websocketConnections: 'id, name, updatedAt',
      sseConnections: 'id, name, updatedAt',
      mcpConnections: 'id, name, updatedAt',
    });

    this.version(4).stores({
      kafkaConnections: 'id, name, updatedAt',
    });

    this.version(5).stores({
      socketioConnections: 'id, name, updatedAt',
    });

    this.version(6).stores({
      // Console store (UI prefs + a window of network entries) lives here so
      // we don't piggyback on settings/metadata, and the encryption pipeline
      // mirrors every other persisted store.
      console: 'id, name, updatedAt',
    });

    this.version(7).stores({
      // Gap #6 migration: hoist useGraphQLSchemaStore + useProtoRegistryStore
      // off raw localStorage onto the encrypted Dexie pipeline. Same shape as
      // every other NamedEncryptedRecord table.
      graphqlSchemas: 'id, name, updatedAt',
      protoFiles: 'id, name, updatedAt',
    });

    this.version(8).stores({
      // AI chat conversations + provider configs (encrypted, same shape as other single-store tables)
      aiChat: 'id, name, updatedAt',
    });

    this.version(9).stores({
      // pm.globals scope — flat key-value store separate from environments.
      // Postman-compatible: workspace-wide vars survive environment switches.
      globals: 'id, name, updatedAt',
    });

    this.version(10).stores({
      // MQTT connections — same encrypted NamedEncryptedRecord shape as the
      // other connection-based protocols (Kafka, WebSocket, Socket.IO).
      mqttConnections: 'id, name, updatedAt',
    });

    this.version(11).stores({
      // AI Lab (Electron-only): providers/prompts/datasets/eval-configs in
      // `aiLab`, eval run history+results in `evalRuns`. Same encrypted
      // NamedEncryptedRecord shape as aiChat.
      aiLab: 'id, name, updatedAt',
      evalRuns: 'id, name, updatedAt',
    });

    this.version(12).stores({
      // Collection/folder runner history (Runs panel) — previously in-memory
      // only and lost on reload. Results carry statuses/timings/assertions,
      // not response bodies, so the table stays small. Additive only.
      collectionRuns: 'id, name, updatedAt',
    });

    this.version(13).stores({
      // AI Lab Arena (Electron-only): pairwise model-vs-model leaderboard runs.
      // Same encrypted NamedEncryptedRecord shape as evalRuns. Additive only.
      arenaRuns: 'id, name, updatedAt',
    });
  }

  /**
   * The internal key-value table. Excluded from user-facing data operations
   * (export/import/stats) because it holds app state + migration quarantine
   * rows, not user records.
   */
  private static readonly INTERNAL_TABLE = 'metadata';

  /**
   * Every persisted table EXCEPT the internal metadata KV table. Derived from
   * Dexie's live `tables` array so that adding a `this.version(N).stores(...)`
   * table is automatically covered by clear/export/import/stats — these methods
   * previously hand-listed tables and silently drifted out of sync (export and
   * stats were missing every table added after v5, so "Export all data" lost
   * console/graphql/proto/aiChat/globals/aiLab/eval/arena/collectionRuns data).
   */
  private get dataTables(): Table<NamedEncryptedRecord, string>[] {
    return this.tables.filter((t) => t.name !== ResturaDB.INTERNAL_TABLE) as Table<
      NamedEncryptedRecord,
      string
    >[];
  }

  /**
   * Clear all data (for logout/reset). Includes the metadata table so a reset
   * also drops migration-quarantine and health-check rows.
   */
  async clearAllData(): Promise<void> {
    await this.transaction('rw', this.tables, () =>
      Promise.all(this.tables.map((table) => table.clear()))
    );
  }

  /**
   * Get database size statistics
   */
  async getStorageStats(): Promise<{
    totalRecords: number;
    tables: Record<string, number>;
    estimatedSize: number;
  }> {
    // Count tables concurrently — the per-table counts are independent.
    const counts = await Promise.all(
      this.dataTables.map(async (table) => [table.name, await table.count()] as const)
    );
    const tables: Record<string, number> = Object.fromEntries(counts);
    const totalRecords = counts.reduce((sum, [, n]) => sum + n, 0);

    // Estimate size using IndexedDB storage estimation
    let estimatedSize = 0;
    if ('storage' in navigator && 'estimate' in navigator.storage) {
      const estimate = await navigator.storage.estimate();
      estimatedSize = estimate.usage ?? 0;
    }

    return { totalRecords, tables, estimatedSize };
  }

  /**
   * Export all data for backup (returns the still-encrypted records). The
   * payload is keyed by table name and covers every data table, so a backup is
   * a complete snapshot. `importAllData` reads the same keying.
   */
  async exportAllData(): Promise<{
    version: number;
    exportedAt: number;
    data: Record<string, NamedEncryptedRecord[]>;
  }> {
    // Read tables concurrently — the per-table reads are independent (this
    // already wasn't a single consistent snapshot, since each toArray opens its
    // own transaction).
    const entries = await Promise.all(
      this.dataTables.map(async (table) => [table.name, await table.toArray()] as const)
    );
    const data: Record<string, NamedEncryptedRecord[]> = Object.fromEntries(entries);
    return {
      // Bumped from 5 → 6: the export now covers every data table (previously
      // it stopped at the v5 table set). Import remains backward-compatible with
      // older, smaller backups because it merges per-table by key.
      version: 6,
      exportedAt: Date.now(),
      data,
    };
  }

  /**
   * Import data from backup. Records are merged per table by primary key
   * (`bulkPut`), so importing restores everything the backup contains and
   * leaves tables absent from the backup untouched. Backward-compatible with
   * pre-v6 backups that only carried a subset of tables.
   */
  async importAllData(backup: {
    version: number;
    data: Record<string, NamedEncryptedRecord[] | undefined>;
  }): Promise<void> {
    const data = backup?.data ?? {};
    await this.transaction('rw', this.tables, async () => {
      for (const table of this.dataTables) {
        const rows = data[table.name];
        if (Array.isArray(rows) && rows.length > 0) {
          await table.bulkPut(rows);
        }
      }
    });
  }
}

// Singleton database instance
export const db = new ResturaDB();

// Re-export types for convenience
export type {
  Collection,
  Environment,
  Request,
  Response,
  AppSettings,
  Workflow,
  WorkflowExecution,
};
