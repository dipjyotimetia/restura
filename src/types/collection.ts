import type { AuthConfig } from './auth';
import type { KeyValue } from './common';
import type { Response } from './http';
import type { Request } from './request';

// Environment
export interface Environment {
  id: string;
  name: string;
  variables: KeyValue[];
}

// Collection Item
export interface CollectionItem {
  id: string;
  name: string;
  type: 'folder' | 'request';
  request?: Request;
  items?: CollectionItem[];
  /**
   * Folder-level default auth (only meaningful when type === 'folder').
   * Descendant requests whose own auth is 'none' inherit the nearest
   * ancestor folder's auth, falling back to the collection-level auth —
   * mirroring Postman's folder-auth semantics.
   */
  auth?: AuthConfig;
  /**
   * Optional contract spec attached at folder scope (only meaningful when
   * type === 'folder'). Overrides the collection-level spec for any
   * descendant requests.
   */
  contractSpec?: ContractSpecSource;
  /**
   * Folder-level pre-request / test scripts (only meaningful when
   * type === 'folder'). In a collection run they execute for every descendant
   * request, after the collection-level script and before the request's own,
   * mirroring Postman's parent-to-child execution order. Stored in the native
   * `rs.*` namespace (Postman `pm.*` is migrated on import).
   */
  preRequestScript?: string;
  testScript?: string;
}

/**
 * Source location for an OpenAPI / Swagger contract spec attached to a
 * collection or folder. The spec text itself isn't persisted in the
 * Zustand store (parsed specs can be large) — only the source pointer.
 * The contracts feature loads + parses on demand and caches in memory.
 */
export interface ContractSpecSource {
  /** OpenAPI 3.0/3.1 (default) or AsyncAPI 2.x/3.x (future). */
  kind?: 'openapi' | 'asyncapi';
  source: 'url' | 'inline' | 'file';
  /** Present when source === 'url'. */
  url?: string;
  /** Present when source === 'inline'. YAML or JSON. */
  inline?: string;
  /** Present when source === 'file' (desktop only). Absolute path. */
  filePath?: string;
}

// Collection
export interface Collection {
  id: string;
  name: string;
  description?: string;
  items: CollectionItem[];
  auth?: AuthConfig;
  variables?: KeyValue[];
  /**
   * Optional OpenAPI spec attached at collection scope. Requests with a
   * `contractRef` are validated against this spec at execution time.
   * Folders can override via their own `contractSpec` on `CollectionItem`.
   */
  contractSpec?: ContractSpecSource;
  /**
   * Collection-level pre-request / test scripts. In a collection run they
   * execute for every request: first in the parent-to-child chain
   * (collection -> folder -> request). Stored in the native `rs.*` namespace
   * (Postman `pm.*` is migrated on import).
   */
  preRequestScript?: string;
  testScript?: string;
}

// History Item
export interface HistoryItem {
  id: string;
  request: Request;
  response?: Response;
  timestamp: number;
  /**
   * The request URL with `{{variables}}` substituted, i.e. what actually went
   * out on the wire. Display-only — `request.url` keeps the original
   * (possibly templated) value so reopening/replaying this entry still
   * targets whichever environment is active, rather than the one active when
   * the request was originally sent. Absent for non-HTTP request types.
   */
  resolvedUrl?: string;
}

/**
 * A single route served by the desktop mock server (record-and-replay). Built
 * from a collection + history by `buildMockRoutes`, then sent over IPC to
 * `electron/main/handlers/mock-server-handler.ts`. Mock is desktop-only (see
 * capabilities `mock.localServer`) — web can't bind a local listener.
 */
export type { MockRoute, MockServerStatus } from '@shared/mock-types';
