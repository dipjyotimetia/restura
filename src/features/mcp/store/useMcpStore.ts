import { v4 as uuidv4 } from 'uuid';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { dexieStorageAdapters } from '@/lib/shared/dexie-storage';
import { passthroughMigrate } from '@/lib/shared/persistMigrate';
import type { KeyValue, McpServerCapabilities, McpTransportType } from '@/types';

export type McpConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface McpInvocationLog {
  id: string;
  method: string;
  params?: unknown;
  result?: unknown;
  error?: string;
  jsonRpcError?: { code: number; message: string; data?: unknown };
  durationMs: number;
  timestamp: number;
}

export interface McpConnection {
  id: string;
  url: string;
  transport: McpTransportType;
  headers: KeyValue[];
  status: McpConnectionStatus;
  /** Capabilities surfaced after a successful initialize+list */
  capabilities: McpServerCapabilities | null;
  /** Recent calls for the result viewer & history */
  log: McpInvocationLog[];
  lastError?: string;
  createdAt: number;
}

interface McpState {
  connections: Record<string, McpConnection>;
  activeConnectionId: string | null;

  createConnection: (url?: string, transport?: McpTransportType) => string;
  removeConnection: (id: string) => void;
  setActiveConnection: (id: string | null) => void;

  setUrl: (id: string, url: string) => void;
  setTransport: (id: string, t: McpTransportType) => void;
  addHeader: (id: string) => void;
  updateHeader: (id: string, headerId: string, updates: Partial<KeyValue>) => void;
  removeHeader: (id: string, headerId: string) => void;

  setStatus: (id: string, status: McpConnectionStatus, error?: string) => void;
  setCapabilities: (id: string, caps: McpServerCapabilities | null) => void;
  appendLog: (id: string, entry: Omit<McpInvocationLog, 'id' | 'timestamp'>) => void;
  clearLog: (id: string) => void;

  getActive: () => McpConnection | null;
}

const MAX_LOG = 200;

export const useMcpStore = create<McpState>()(
  persist(
    (set, get) => ({
      connections: {},
      activeConnectionId: null,

      createConnection: (url = '', transport = 'streamable-http') => {
        const id = uuidv4();
        const conn: McpConnection = {
          id,
          url,
          transport,
          headers: [],
          status: 'disconnected',
          capabilities: null,
          log: [],
          createdAt: Date.now(),
        };
        set((s) => ({ connections: { ...s.connections, [id]: conn }, activeConnectionId: id }));
        return id;
      },

      removeConnection: (id) =>
        set((s) => {
          const { [id]: _, ...rest } = s.connections;
          return {
            connections: rest,
            activeConnectionId: s.activeConnectionId === id ? null : s.activeConnectionId,
          };
        }),

      setActiveConnection: (id) => set({ activeConnectionId: id }),

      setUrl: (id, url) =>
        set((s) => {
          const c = s.connections[id];
          if (!c) return s;
          return { connections: { ...s.connections, [id]: { ...c, url } } };
        }),

      setTransport: (id, t) =>
        set((s) => {
          const c = s.connections[id];
          if (!c) return s;
          return { connections: { ...s.connections, [id]: { ...c, transport: t } } };
        }),

      addHeader: (id) =>
        set((s) => {
          const c = s.connections[id];
          if (!c) return s;
          const h: KeyValue = { id: uuidv4(), key: '', value: '', enabled: true };
          return { connections: { ...s.connections, [id]: { ...c, headers: [...c.headers, h] } } };
        }),

      updateHeader: (id, headerId, updates) =>
        set((s) => {
          const c = s.connections[id];
          if (!c) return s;
          return {
            connections: {
              ...s.connections,
              [id]: {
                ...c,
                headers: c.headers.map((h) => (h.id === headerId ? { ...h, ...updates } : h)),
              },
            },
          };
        }),

      removeHeader: (id, headerId) =>
        set((s) => {
          const c = s.connections[id];
          if (!c) return s;
          return {
            connections: {
              ...s.connections,
              [id]: { ...c, headers: c.headers.filter((h) => h.id !== headerId) },
            },
          };
        }),

      setStatus: (id, status, error) =>
        set((s) => {
          const c = s.connections[id];
          if (!c) return s;
          return {
            connections: {
              ...s.connections,
              [id]: { ...c, status, ...(error !== undefined ? { lastError: error } : {}) },
            },
          };
        }),

      setCapabilities: (id, caps) =>
        set((s) => {
          const c = s.connections[id];
          if (!c) return s;
          return { connections: { ...s.connections, [id]: { ...c, capabilities: caps } } };
        }),

      appendLog: (id, entry) =>
        set((s) => {
          const c = s.connections[id];
          if (!c) return s;
          const next: McpInvocationLog = {
            id: uuidv4(),
            timestamp: Date.now(),
            method: entry.method,
            ...(entry.params !== undefined ? { params: entry.params } : {}),
            ...(entry.result !== undefined ? { result: entry.result } : {}),
            ...(entry.error !== undefined ? { error: entry.error } : {}),
            ...(entry.jsonRpcError !== undefined ? { jsonRpcError: entry.jsonRpcError } : {}),
            durationMs: entry.durationMs,
          };
          let log = [next, ...c.log];
          if (log.length > MAX_LOG) log = log.slice(0, MAX_LOG);
          return { connections: { ...s.connections, [id]: { ...c, log } } };
        }),

      clearLog: (id) =>
        set((s) => {
          const c = s.connections[id];
          if (!c) return s;
          return { connections: { ...s.connections, [id]: { ...c, log: [] } } };
        }),

      getActive: () => {
        const { connections, activeConnectionId } = get();
        return activeConnectionId ? (connections[activeConnectionId] ?? null) : null;
      },
    }),
    {
      name: 'mcp-storage',
      // v1: explicit versioning seam; no shape change from the unversioned blob.
      version: 1,
      migrate: (persisted) => passthroughMigrate<McpState>(persisted),
      storage: dexieStorageAdapters.mcpConnections(),
      partialize: (state) => ({
        connections: Object.fromEntries(
          Object.entries(state.connections).map(([id, c]) => [
            id,
            { ...c, status: 'disconnected' as const, capabilities: null, log: [] },
          ])
        ),
        activeConnectionId: state.activeConnectionId,
      }),
    }
  )
);
