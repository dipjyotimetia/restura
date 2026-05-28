import { contextBridge, ipcRenderer } from 'electron';
import type { ChatStreamEvent } from '@shared/protocol/ai/types';
import type { ElectronAPI } from '../types/electron-api';
import {
  IPC,
  EVENT,
  EVENT_PREFIX,
  eventChannel,
  CHANNEL_PREFIXES,
  VALID_EVENT_CHANNELS,
} from '../shared/channels';

const validEventChannels: readonly string[] = VALID_EVENT_CHANNELS;

/**
 * Build the `{ on, removeListener, removeAllListeners }` trio every streaming
 * namespace exposes, guarded by a channel-name prefix allowlist. Factored out
 * so the prefix guard — a renderer-isolation boundary — is defined once
 * instead of copy-pasted per protocol. `prefix` comes from CHANNEL_PREFIXES.
 */
function channelEventBridge(prefix: string) {
  return {
    on: (channel: string, callback: (...args: unknown[]) => void) => {
      if (channel.startsWith(prefix)) {
        ipcRenderer.on(channel, (_event, ...args) => callback(...args));
      }
    },
    removeListener: (channel: string, callback: (...args: unknown[]) => void) => {
      if (channel.startsWith(prefix)) {
        ipcRenderer.removeListener(
          channel,
          callback as Parameters<typeof ipcRenderer.removeListener>[1]
        );
      }
    },
    removeAllListeners: (channel: string) => {
      if (channel.startsWith(prefix)) {
        ipcRenderer.removeAllListeners(channel);
      }
    },
  };
}

// Define the API that will be exposed to the renderer process
const electronAPI = {
  // Platform information
  platform: process.platform,
  isElectron: true,

  // Dialog operations
  dialog: {
    openFile: (options?: {
      title?: string;
      defaultPath?: string;
      filters?: Array<{ name: string; extensions: string[] }>;
      properties?: Array<'openFile' | 'openDirectory' | 'multiSelections'>;
    }) => ipcRenderer.invoke(IPC.dialog.openFile, options),

    saveFile: (options?: {
      title?: string;
      defaultPath?: string;
      filters?: Array<{ name: string; extensions: string[] }>;
    }) => ipcRenderer.invoke(IPC.dialog.saveFile, options),
  },

  // File system operations
  fs: {
    readFile: (filePath: string): Promise<{ success: boolean; content?: string; error?: string }> =>
      ipcRenderer.invoke(IPC.fs.readFile, filePath),

    writeFile: (filePath: string, content: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.fs.writeFile, filePath, content),
  },

  // App information
  app: {
    getPath: (name: string): Promise<string> => ipcRenderer.invoke(IPC.app.getPath, name),
    getVersion: (): Promise<string> => ipcRenderer.invoke(IPC.app.getVersion),
    checkForUpdates: (): Promise<{
      updateAvailable: boolean;
      version?: string;
      message?: string;
      error?: string;
    }> => ipcRenderer.invoke(IPC.app.checkForUpdates),
  },

  // Shell operations
  shell: {
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke(IPC.shell.openExternal, url),
  },

  // Window operations
  window: {
    minimize: () => ipcRenderer.send(IPC.window.minimize),
    maximize: () => ipcRenderer.send(IPC.window.maximize),
    close: () => ipcRenderer.send(IPC.window.close),
    openNew: () => ipcRenderer.invoke(IPC.window.new),
  },

  // HTTP operations with proxy support
  http: {
    request: (config: {
      method: string;
      url: string;
      headers?: Record<string, string>;
      params?: Record<string, string>;
      data?: string;
      timeout?: number;
      maxRedirects?: number;
      proxy?: {
        enabled: boolean;
        type: string;
        host: string;
        port: number;
        auth?: {
          username: string;
          password: string;
        };
      };
      verifySsl?: boolean;
      clientCert?: {
        format: 'pfx' | 'pem';
        pfx?: string;
        cert?: string;
        key?: string;
        passphrase?: string;
      };
      caCert?: {
        pem: string;
      };
    }): Promise<{
      status: number;
      statusText: string;
      headers: Record<string, string>;
      data: unknown;
    }> => ipcRenderer.invoke(IPC.http.request, config),
  },

  // gRPC operations
  grpc: {
    // Return types come from the ElectronAPI interface (GrpcIpcResult /
    // GrpcRawReflectionResponse) — leave these inferred as Promise<any> from
    // ipcRenderer.invoke so the `satisfies ElectronAPI` check supplies the
    // precise shape to renderer consumers without a redundant annotation here.
    request: (config: unknown) => ipcRenderer.invoke(IPC.grpc.request, config),
    reflect: (config: unknown) => ipcRenderer.invoke(IPC.grpc.reflect, config),
    startStream: (config: unknown) => ipcRenderer.send(IPC.grpc.startStream, config),
    sendMessage: (requestId: string, message: unknown) =>
      ipcRenderer.send(IPC.grpc.sendMessage, requestId, message),
    endStream: (requestId: string) => ipcRenderer.send(IPC.grpc.endStream, requestId),
    cancelStream: (requestId: string) => ipcRenderer.send(IPC.grpc.cancelStream, requestId),
    // gRPC exposes on/removeListener only (no removeAllListeners) — pick those
    // two off the shared bridge.
    on: channelEventBridge(CHANNEL_PREFIXES.grpc).on,
    removeListener: channelEventBridge(CHANNEL_PREFIXES.grpc).removeListener,
  },

  // WebSocket operations with custom header support
  websocket: {
    connect: (config: {
      connectionId: string;
      url: string;
      headers?: Record<string, string>;
      protocols?: string[];
    }): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke(IPC.ws.connect, config),

    send: (config: {
      connectionId: string;
      message: string;
      binary?: boolean;
    }): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke(IPC.ws.send, config),

    disconnect: (config: { connectionId: string }): Promise<{ success: boolean }> =>
      ipcRenderer.invoke(IPC.ws.disconnect, config),

    ...channelEventBridge(CHANNEL_PREFIXES.ws),
  },

  // Socket.IO (v4) operations
  socketio: {
    connect: (config: {
      connectionId: string;
      url: string;
      namespace?: string;
      path?: string;
      auth?: Record<string, string | number | boolean>;
      query?: Record<string, string>;
      extraHeaders?: Record<string, string>;
      transports?: Array<'websocket' | 'polling'>;
      reconnection?: boolean;
      reconnectionAttempts?: number;
      reconnectionDelay?: number;
      timeout?: number;
      forceNew?: boolean;
    }): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.socketio.connect, config),

    emit: (config: {
      connectionId: string;
      eventName: string;
      args: unknown[];
      ackId?: string;
      ackTimeoutMs?: number;
    }): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.socketio.emit, config),

    disconnect: (config: { connectionId: string }): Promise<{ success: boolean }> =>
      ipcRenderer.invoke(IPC.socketio.disconnect, config),

    ...channelEventBridge(CHANNEL_PREFIXES.socketio),
  },

  // SSE (Server-Sent Events) operations
  sse: {
    connect: (config: {
      connectionId: string;
      url: string;
      headers?: Record<string, string>;
    }): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.sse.connect, config),

    disconnect: (config: { connectionId: string }): Promise<{ success: boolean }> =>
      ipcRenderer.invoke(IPC.sse.disconnect, config),

    ...channelEventBridge(CHANNEL_PREFIXES.sse),
  },

  // MCP (Model Context Protocol) operations
  mcp: {
    connect: (config: {
      connectionId: string;
      url: string;
      transport: 'streamable-http' | 'http-sse';
      headers?: Record<string, string>;
    }): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.mcp.connect, config),

    request: (config: {
      connectionId: string;
      method: string;
      params?: unknown;
      requestId?: string | number;
      timeout?: number;
    }): Promise<{
      success: boolean;
      result?: unknown;
      error?: string;
      jsonRpcError?: { code: number; message: string; data?: unknown };
    }> => ipcRenderer.invoke(IPC.mcp.request, config),

    disconnect: (config: { connectionId: string }): Promise<{ success: boolean }> =>
      ipcRenderer.invoke(IPC.mcp.disconnect, config),

    ...channelEventBridge(CHANNEL_PREFIXES.mcp),
  },

  // Kafka producer/consumer operations
  kafka: {
    connect: (config: {
      connectionId: string;
      clientId: string;
      bootstrapBrokers: string[];
      auth:
        | { securityProtocol: 'PLAINTEXT' }
        | {
            securityProtocol: 'SASL_PLAINTEXT';
            sasl: {
              mechanism: 'PLAIN' | 'SCRAM-SHA-256' | 'SCRAM-SHA-512';
              username: string;
              password: string;
            };
          }
        | {
            securityProtocol: 'SASL_SSL';
            sasl: {
              mechanism: 'PLAIN' | 'SCRAM-SHA-256' | 'SCRAM-SHA-512';
              username: string;
              password: string;
            };
            tls?: {
              ca?: string;
              cert?: string;
              key?: string;
              passphrase?: string;
              rejectUnauthorized?: boolean;
            };
          }
        | {
            securityProtocol: 'SSL';
            tls: {
              ca?: string;
              cert?: string;
              key?: string;
              passphrase?: string;
              rejectUnauthorized?: boolean;
            };
          };
    }): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.kafka.connect, config),

    produce: (config: {
      connectionId: string;
      topic: string;
      key?: string;
      value: string;
      headers?: Record<string, string>;
      partition?: number;
      acks: 0 | 1 | -1;
      compression?: 'none' | 'gzip' | 'snappy' | 'lz4' | 'zstd';
    }): Promise<{
      success: boolean;
      ack?: { topic: string; partition: number; offset: string; timestamp: number };
      error?: string;
    }> => ipcRenderer.invoke(IPC.kafka.produce, config),

    subscribe: (config: {
      connectionId: string;
      groupId: string;
      topics: string[];
      fromBeginning: boolean;
    }): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.kafka.subscribe, config),

    unsubscribe: (config: {
      connectionId: string;
    }): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.kafka.unsubscribe, config),

    disconnect: (config: { connectionId: string }): Promise<{ success: boolean }> =>
      ipcRenderer.invoke(IPC.kafka.disconnect, config),

    ...channelEventBridge(CHANNEL_PREFIXES.kafka),
  },

  // Native notifications
  notification: {
    isSupported: (): Promise<boolean> => ipcRenderer.invoke(IPC.notification.isSupported),

    show: (options: {
      title: string;
      body: string;
      silent?: boolean;
      urgency?: 'normal' | 'critical' | 'low';
    }): Promise<{ success: boolean }> => ipcRenderer.invoke(IPC.notification.show, options),

    requestComplete: (data: {
      status: number;
      time: number;
      url: string;
    }): Promise<{ success: boolean }> => ipcRenderer.invoke(IPC.notification.requestComplete, data),

    updateAvailable: (version: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke(IPC.notification.updateAvailable, version),

    error: (message: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke(IPC.notification.error, message),
  },

  // Encrypted store operations
  store: {
    get: (key: string): Promise<string | undefined> => ipcRenderer.invoke(IPC.store.get, key),

    set: (key: string, value: string): Promise<void> =>
      ipcRenderer.invoke(IPC.store.set, key, value),

    delete: (key: string): Promise<void> => ipcRenderer.invoke(IPC.store.delete, key),

    clear: (): Promise<void> => ipcRenderer.invoke(IPC.store.clear),

    has: (key: string): Promise<boolean> => ipcRenderer.invoke(IPC.store.has, key),
  },

  // Git operations for file-backed collections. Read-only in v1 — write
  // operations (commit, branch switch, push/pull) land with the auth model.
  // All operations are gated by collection-manager's directory allowlist
  // so an attacker cannot point these at arbitrary directories.
  git: {
    status: (
      directoryPath: string
    ): Promise<
      | {
          ok: true;
          status: {
            files: Array<{ path: string; staged: string; unstaged: string }>;
            branch: string | null;
            ahead: number;
            behind: number;
            clean: boolean;
          };
        }
      | { ok: false; error: string }
    > => ipcRenderer.invoke(IPC.git.status, { directoryPath }),

    log: (
      directoryPath: string,
      limit?: number
    ): Promise<
      | {
          ok: true;
          commits: Array<{
            sha: string;
            abbreviatedSha: string;
            author: string;
            email: string;
            timestamp: number;
            subject: string;
          }>;
        }
      | { ok: false; error: string }
    > =>
      ipcRenderer.invoke(IPC.git.log, { directoryPath, ...(limit !== undefined ? { limit } : {}) }),

    diff: (
      directoryPath: string,
      filePath: string
    ): Promise<{ ok: true; diff: string } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC.git.diff, { directoryPath, filePath }),

    branchList: (
      directoryPath: string
    ): Promise<
      | {
          ok: true;
          branches: Array<{
            name: string;
            isCurrent: boolean;
            isRemote: boolean;
            upstream?: string;
          }>;
        }
      | { ok: false; error: string }
    > => ipcRenderer.invoke(IPC.git.branchList, { directoryPath }),

    add: (
      directoryPath: string,
      filePaths: string[]
    ): Promise<{ ok: true; staged: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC.git.add, { directoryPath, filePaths }),

    commit: (
      directoryPath: string,
      message: string,
      options?: { all?: boolean; paths?: string[] }
    ): Promise<
      { ok: true; commit: { sha: string; abbreviatedSha: string } } | { ok: false; error: string }
    > =>
      ipcRenderer.invoke(IPC.git.commit, {
        directoryPath,
        message,
        ...(options?.all !== undefined ? { all: options.all } : {}),
        ...(options?.paths !== undefined ? { paths: options.paths } : {}),
      }),

    createBranch: (
      directoryPath: string,
      name: string
    ): Promise<{ ok: true; branch: string } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC.git.createBranch, { directoryPath, name }),

    checkoutBranch: (
      directoryPath: string,
      name: string
    ): Promise<{ ok: true; branch: string } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC.git.checkoutBranch, { directoryPath, name }),
  },

  // Desktop mock server (record-and-replay). Routes are compiled by the
  // renderer and bound to 127.0.0.1 only by the main process.
  mock: {
    start: (config: {
      collectionId: string;
      port?: number;
      routes: Array<{
        method: string;
        path: string;
        status: number;
        headers: Record<string, string>;
        body: string;
        bodyEncoding?: 'base64';
        delayMs?: number;
      }>;
    }): Promise<
      | {
          ok: true;
          status: {
            running: boolean;
            port?: number;
            baseUrl?: string;
            collectionId?: string;
            routeCount?: number;
          };
        }
      | { ok: false; error: string }
    > => ipcRenderer.invoke(IPC.mock.start, config),

    stop: (): Promise<{ ok: true; status: { running: boolean } } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC.mock.stop),

    status: (): Promise<
      | {
          ok: true;
          status: {
            running: boolean;
            port?: number;
            baseUrl?: string;
            collectionId?: string;
            routeCount?: number;
          };
        }
      | { ok: false; error: string }
    > => ipcRenderer.invoke(IPC.mock.status),
  },

  // Secret handle store — keychain-backed secret references.
  //
  // SECURITY: there is intentionally NO `resolve` method here. Resolution is
  // a main-process-only operation invoked just before auth signing by IPC
  // handlers. Exposing resolution to the renderer would defeat the purpose
  // of the pattern (plaintext available to anyone with renderer access).
  secrets: {
    store: (args: {
      value: string;
      label?: string;
      scope?: string;
      id?: string;
    }): Promise<{ ok: true; id: string } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC.secret.store, args),

    delete: (id: string): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC.secret.delete, { id }),

    // describe: lookup-by-id; returns `handle: null` if the id is unknown.
    describe: (
      id: string
    ): Promise<
      | { ok: true; handle: { label?: string; scope?: string; createdAt: number } | null }
      | { ok: false; error: string }
    > => ipcRenderer.invoke(IPC.secret.describe, { id }),

    // list: enumerate every stored handle's metadata.
    list: (): Promise<
      | {
          ok: true;
          handles: Array<{ id: string; label?: string; scope?: string; createdAt: number }>;
        }
      | { ok: false; error: string }
    > => ipcRenderer.invoke(IPC.secret.list),
  },

  // pm.vault — user-named encrypted key-value secret store. Separate from
  // `secrets` above so user-chosen names can't collide with UUID handles
  // and the access surface stays simple. See electron/main/vault-handler.ts.
  vault: {
    get: (key: string): Promise<{ value: string | null }> =>
      ipcRenderer.invoke(IPC.vault.get, { key }),
    set: (key: string, value: string): Promise<{ ok: true }> =>
      ipcRenderer.invoke(IPC.vault.set, { key, value }),
    unset: (key: string): Promise<{ ok: true }> => ipcRenderer.invoke(IPC.vault.unset, { key }),
  },

  ai: {
    chat: (spec: {
      streamId: string;
      provider: 'openai' | 'anthropic' | 'openrouter';
      model: string;
      messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
      apiKeyHandleId: string;
      baseUrlOverride?: string;
      rawMode: boolean;
      maxOutputTokens?: number;
      tools?: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
    }): Promise<{ ok: true; streamId: string } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC.ai.chat, spec),

    cancel: (args: {
      streamId: string;
    }): Promise<{ ok: boolean; alreadyDone?: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.ai.chatCancel, args),

    onChunk: (streamId: string, cb: (event: ChatStreamEvent) => void): (() => void) => {
      const channel = eventChannel(EVENT_PREFIX.ai.chunk, streamId);
      const listener = (_event: unknown, payload: ChatStreamEvent) => cb(payload);
      ipcRenderer.on(channel, listener as Parameters<typeof ipcRenderer.on>[1]);
      return () =>
        ipcRenderer.removeListener(channel, listener as Parameters<typeof ipcRenderer.on>[1]);
    },

    onEnd: (
      streamId: string,
      cb: (payload: { reason: 'done' | 'cancelled' | 'error' }) => void
    ): (() => void) => {
      const channel = eventChannel(EVENT_PREFIX.ai.end, streamId);
      const listener = (_event: unknown, payload: { reason: 'done' | 'cancelled' | 'error' }) =>
        cb(payload);
      ipcRenderer.on(channel, listener as Parameters<typeof ipcRenderer.on>[1]);
      return () =>
        ipcRenderer.removeListener(channel, listener as Parameters<typeof ipcRenderer.on>[1]);
    },
  },

  // Request log operations
  log: {
    getHistory: (limit?: number) => ipcRenderer.invoke(IPC.log.getHistory, limit),
    clear: (): Promise<void> => ipcRenderer.invoke(IPC.log.clear),
  },

  // Keychain (safeStorage) status — surfaces whether secrets are protected by
  // the OS keychain or held in a plaintext fallback (Linux without libsecret).
  keychain: {
    status: (): Promise<{
      mode: 'safeStorage' | 'plaintext';
      reason?: 'no-keyring' | 'decrypt-failed';
      plaintextStores: string[];
      lastChecked: string;
    }> => ipcRenderer.invoke(IPC.keychain.status),
    rotate: (): Promise<{
      rotated: boolean;
      status: {
        mode: 'safeStorage' | 'plaintext';
        reason?: 'no-keyring' | 'decrypt-failed';
        plaintextStores: string[];
        lastChecked: string;
      };
      /**
       * Human-readable reason returned by the main process when `rotated: false`.
       * Renderer surfaces this verbatim so the user knows whether the keyring is
       * missing or the keyring is available but data-migration is unimplemented.
       */
      reason?: string;
    }> => ipcRenderer.invoke(IPC.keychain.rotate),
  },

  // Collection file operations (Git-native collections)
  collections: {
    loadFromDirectory: (
      directoryPath: string
    ): Promise<{
      success: boolean;
      collection?: unknown;
      error?: string;
    }> => ipcRenderer.invoke(IPC.collection.loadDirectory, directoryPath),

    saveToDirectory: (
      collection: unknown,
      directoryPath: string
    ): Promise<{
      success: boolean;
      error?: string;
    }> => ipcRenderer.invoke(IPC.collection.saveDirectory, collection, directoryPath),

    watchDirectory: (
      directoryPath: string
    ): Promise<{
      success: boolean;
      error?: string;
    }> => ipcRenderer.invoke(IPC.collection.watch, directoryPath),

    unwatchDirectory: (
      directoryPath: string
    ): Promise<{
      success: boolean;
    }> => ipcRenderer.invoke(IPC.collection.unwatch, directoryPath),

    selectDirectory: (): Promise<{
      canceled: boolean;
      filePaths?: string[];
    }> => ipcRenderer.invoke(IPC.collection.selectDirectory),

    openInExplorer: (
      directoryPath: string
    ): Promise<{
      success: boolean;
      error?: string;
    }> => ipcRenderer.invoke(IPC.collection.openInExplorer, directoryPath),

    getFileInfo: (
      filePath: string
    ): Promise<{
      exists: boolean;
      lastModified?: number;
      size?: number;
    }> => ipcRenderer.invoke(IPC.collection.getFileInfo, filePath),

    onFileChanged: (
      callback: (event: {
        type: 'modified' | 'added' | 'deleted';
        filePath: string;
        directoryPath: string;
        lastModified?: number;
      }) => void
    ) => {
      ipcRenderer.on(EVENT.collectionFileChanged, (_event, data) => callback(data));
    },

    removeFileChangedListener: () => {
      ipcRenderer.removeAllListeners(EVENT.collectionFileChanged);
    },
  },

  // Events
  on: (channel: string, callback: (...args: unknown[]) => void) => {
    if (validEventChannels.includes(channel)) {
      ipcRenderer.on(channel, (_event, ...args) => callback(...args));
    }
  },

  removeListener: (channel: string, callback: (...args: unknown[]) => void) => {
    if (validEventChannels.includes(channel)) {
      ipcRenderer.removeListener(channel, callback);
    }
  },
} satisfies ElectronAPI;

// Expose the API to the renderer process. `satisfies ElectronAPI` above is the
// drift gate: if this object stops matching the canonical interface in
// electron/types/electron-api.ts, `npm run electron:compile` (run in CI) fails.
contextBridge.exposeInMainWorld('electron', electronAPI);
