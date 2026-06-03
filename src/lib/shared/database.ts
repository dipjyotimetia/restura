/**
 * Dexie IndexedDB database for offline-first, privacy-focused storage
 * All data is encrypted at rest using AES-256-GCM
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

/**
 * Restura IndexedDB Database
 * Offline-first, privacy-focused storage with encryption
 */
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
  }

  /**
   * Clear all data (for logout/reset)
   */
  async clearAllData(): Promise<void> {
    await this.transaction(
      'rw',
      [
        this.collections,
        this.environments,
        this.history,
        this.settings,
        this.cookies,
        this.workflows,
        this.workflowExecutions,
        this.fileCollections,
        this.requestTabs,
        this.websocketConnections,
        this.sseConnections,
        this.mcpConnections,
        this.kafkaConnections,
        this.mqttConnections,
        this.socketioConnections,
        this.console,
        this.graphqlSchemas,
        this.protoFiles,
        this.aiChat,
        this.aiLab,
        this.evalRuns,
        this.metadata,
      ],
      () =>
        Promise.all([
          this.collections.clear(),
          this.environments.clear(),
          this.history.clear(),
          this.settings.clear(),
          this.cookies.clear(),
          this.workflows.clear(),
          this.workflowExecutions.clear(),
          this.fileCollections.clear(),
          this.requestTabs.clear(),
          this.websocketConnections.clear(),
          this.sseConnections.clear(),
          this.mcpConnections.clear(),
          this.kafkaConnections.clear(),
          this.mqttConnections.clear(),
          this.socketioConnections.clear(),
          this.console.clear(),
          this.graphqlSchemas.clear(),
          this.protoFiles.clear(),
          this.aiChat.clear(),
          this.aiLab.clear(),
          this.evalRuns.clear(),
          this.metadata.clear(),
        ])
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
    const tables: Record<string, number> = {
      collections: await this.collections.count(),
      environments: await this.environments.count(),
      history: await this.history.count(),
      settings: await this.settings.count(),
      cookies: await this.cookies.count(),
      workflows: await this.workflows.count(),
      workflowExecutions: await this.workflowExecutions.count(),
      fileCollections: await this.fileCollections.count(),
      requestTabs: await this.requestTabs.count(),
      websocketConnections: await this.websocketConnections.count(),
      sseConnections: await this.sseConnections.count(),
      mcpConnections: await this.mcpConnections.count(),
      kafkaConnections: await this.kafkaConnections.count(),
      mqttConnections: await this.mqttConnections.count(),
      socketioConnections: await this.socketioConnections.count(),
      console: await this.console.count(),
      graphqlSchemas: await this.graphqlSchemas.count(),
      protoFiles: await this.protoFiles.count(),
      aiChat: await this.aiChat.count(),
    };

    const totalRecords = Object.values(tables).reduce((a, b) => a + b, 0);

    // Estimate size using IndexedDB storage estimation
    let estimatedSize = 0;
    if ('storage' in navigator && 'estimate' in navigator.storage) {
      const estimate = await navigator.storage.estimate();
      estimatedSize = estimate.usage ?? 0;
    }

    return { totalRecords, tables, estimatedSize };
  }

  /**
   * Export all data for backup (returns encrypted data)
   */
  async exportAllData(): Promise<{
    version: number;
    exportedAt: number;
    data: {
      collections: CollectionRecord[];
      environments: EnvironmentRecord[];
      history: HistoryRecord[];
      settings: SettingsRecord[];
      cookies: CookieRecord[];
      workflows: WorkflowRecord[];
      workflowExecutions: WorkflowExecutionRecord[];
      fileCollections: FileCollectionRecord[];
      requestTabs?: RequestTabsRecord[];
      websocketConnections?: WebSocketConnectionsRecord[];
      sseConnections?: SseConnectionsRecord[];
      mcpConnections?: McpConnectionsRecord[];
      kafkaConnections?: KafkaConnectionsRecord[];
      mqttConnections?: MqttConnectionsRecord[];
      socketioConnections?: SocketIoConnectionsRecord[];
    };
  }> {
    return {
      version: 5,
      exportedAt: Date.now(),
      data: {
        collections: await this.collections.toArray(),
        environments: await this.environments.toArray(),
        history: await this.history.toArray(),
        settings: await this.settings.toArray(),
        cookies: await this.cookies.toArray(),
        workflows: await this.workflows.toArray(),
        workflowExecutions: await this.workflowExecutions.toArray(),
        fileCollections: await this.fileCollections.toArray(),
        requestTabs: await this.requestTabs.toArray(),
        websocketConnections: await this.websocketConnections.toArray(),
        sseConnections: await this.sseConnections.toArray(),
        mcpConnections: await this.mcpConnections.toArray(),
        kafkaConnections: await this.kafkaConnections.toArray(),
        mqttConnections: await this.mqttConnections.toArray(),
        socketioConnections: await this.socketioConnections.toArray(),
      },
    };
  }

  /**
   * Import data from backup
   */
  async importAllData(backup: {
    version: number;
    data: {
      collections?: CollectionRecord[];
      environments?: EnvironmentRecord[];
      history?: HistoryRecord[];
      settings?: SettingsRecord[];
      cookies?: CookieRecord[];
      workflows?: WorkflowRecord[];
      workflowExecutions?: WorkflowExecutionRecord[];
      fileCollections?: FileCollectionRecord[];
      requestTabs?: RequestTabsRecord[];
      websocketConnections?: WebSocketConnectionsRecord[];
      sseConnections?: SseConnectionsRecord[];
      mcpConnections?: McpConnectionsRecord[];
      kafkaConnections?: KafkaConnectionsRecord[];
      mqttConnections?: MqttConnectionsRecord[];
      socketioConnections?: SocketIoConnectionsRecord[];
    };
  }): Promise<void> {
    await this.transaction(
      'rw',
      [
        this.collections,
        this.environments,
        this.history,
        this.settings,
        this.cookies,
        this.workflows,
        this.workflowExecutions,
        this.fileCollections,
        this.requestTabs,
        this.websocketConnections,
        this.sseConnections,
        this.mcpConnections,
        this.kafkaConnections,
        this.mqttConnections,
        this.socketioConnections,
      ],
      async () => {
        if (backup.data.collections) await this.collections.bulkPut(backup.data.collections);
        if (backup.data.environments) await this.environments.bulkPut(backup.data.environments);
        if (backup.data.history) await this.history.bulkPut(backup.data.history);
        if (backup.data.settings) await this.settings.bulkPut(backup.data.settings);
        if (backup.data.cookies) await this.cookies.bulkPut(backup.data.cookies);
        if (backup.data.workflows) await this.workflows.bulkPut(backup.data.workflows);
        if (backup.data.workflowExecutions)
          await this.workflowExecutions.bulkPut(backup.data.workflowExecutions);
        if (backup.data.fileCollections)
          await this.fileCollections.bulkPut(backup.data.fileCollections);
        if (backup.data.requestTabs) await this.requestTabs.bulkPut(backup.data.requestTabs);
        if (backup.data.websocketConnections)
          await this.websocketConnections.bulkPut(backup.data.websocketConnections);
        if (backup.data.sseConnections)
          await this.sseConnections.bulkPut(backup.data.sseConnections);
        if (backup.data.mcpConnections)
          await this.mcpConnections.bulkPut(backup.data.mcpConnections);
        if (backup.data.kafkaConnections)
          await this.kafkaConnections.bulkPut(backup.data.kafkaConnections);
        if (backup.data.mqttConnections)
          await this.mqttConnections.bulkPut(backup.data.mqttConnections);
        if (backup.data.socketioConnections)
          await this.socketioConnections.bulkPut(backup.data.socketioConnections);
      }
    );
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
