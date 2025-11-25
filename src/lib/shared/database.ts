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
  }

  /**
   * Clear all data (for logout/reset)
   */
  async clearAllData(): Promise<void> {
    await this.transaction('rw', [
      this.collections,
      this.environments,
      this.history,
      this.settings,
      this.cookies,
      this.workflows,
      this.workflowExecutions,
      this.fileCollections,
      this.metadata,
    ], async () => {
      await this.collections.clear();
      await this.environments.clear();
      await this.history.clear();
      await this.settings.clear();
      await this.cookies.clear();
      await this.workflows.clear();
      await this.workflowExecutions.clear();
      await this.fileCollections.clear();
      await this.metadata.clear();
    });
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
    };
  }> {
    return {
      version: 1,
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
    };
  }): Promise<void> {
    await this.transaction('rw', [
      this.collections,
      this.environments,
      this.history,
      this.settings,
      this.cookies,
      this.workflows,
      this.workflowExecutions,
      this.fileCollections,
    ], async () => {
      if (backup.data.collections) {
        await this.collections.bulkPut(backup.data.collections);
      }
      if (backup.data.environments) {
        await this.environments.bulkPut(backup.data.environments);
      }
      if (backup.data.history) {
        await this.history.bulkPut(backup.data.history);
      }
      if (backup.data.settings) {
        await this.settings.bulkPut(backup.data.settings);
      }
      if (backup.data.cookies) {
        await this.cookies.bulkPut(backup.data.cookies);
      }
      if (backup.data.workflows) {
        await this.workflows.bulkPut(backup.data.workflows);
      }
      if (backup.data.workflowExecutions) {
        await this.workflowExecutions.bulkPut(backup.data.workflowExecutions);
      }
      if (backup.data.fileCollections) {
        await this.fileCollections.bulkPut(backup.data.fileCollections);
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
