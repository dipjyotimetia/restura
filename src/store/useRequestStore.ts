import { toast } from 'sonner';
import { v4 as uuidv4 } from 'uuid';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { cleanupKafkaConnectionForTab } from '@/features/kafka/lib/connectionLifecycle';
import { cleanupMqttConnectionForTab } from '@/features/mqtt/lib/connectionLifecycle';
import { cleanupSocketIOConnectionForTab } from '@/features/socketio/lib/connectionLifecycle';
import { cleanupWebSocketConnectionForTab } from '@/features/websocket/lib/connectionLifecycle';
import { dexieStorageAdapters } from '@/lib/shared/dexie-storage';
import { ECHO_URLS } from '@/lib/shared/echo-defaults';
import { disposeRetainedMonacoModelsForOwner } from '@/lib/shared/monacoModelLifecycle';
import { migrateAuthConfigToSecretRef } from '@/lib/shared/secretRef-migrations';
import { validateRequestUpdate } from '@/lib/shared/store-validators';
import type {
  GrpcRequest,
  HttpRequest,
  McpRequest,
  Request,
  RequestTab,
  RequestType,
  Response,
  ScriptResult,
  SseRequest,
  StreamEventLike,
  TabModeOverride,
} from '@/types';
import { createTabFromRequest, findTabIndex, migrateLegacyStateToTabs } from './lib/tabs';

interface ScriptResults {
  preRequest?: ScriptResult;
  test?: ScriptResult;
}

interface RequestState {
  tabs: RequestTab[];
  activeTabId: string | null;
  isLoading: boolean;

  // Tab lifecycle
  openTab: (request: Request, options?: { savedRequestId?: string; switchTo?: boolean }) => string;
  closeTab: (id: string) => void;
  switchTab: (id: string) => void;
  duplicateTab: (id: string) => string | null;
  reorderTabs: (orderedIds: string[]) => void;
  closeOtherTabs: (id: string) => void;
  closeAllTabs: () => void;
  closeTabsToRight: (id: string) => void;
  /**
   * Recently closed tabs, newest last. In-memory only (not persisted) and
   * capped, so a reload starts fresh. Feeds `reopenClosedTab`.
   */
  closedTabs: RequestTab[];
  reopenClosedTab: () => void;

  // Per-active-tab actions (names preserved for consumer compatibility)
  // Returns true when the update was validated and applied, false when it was
  // rejected (no active tab, or the merged request failed validation).
  updateRequest: (updates: Partial<Request>) => boolean;
  updateRequestForTab: (tabId: string, updates: Partial<Request>) => boolean;
  setCurrentResponse: (response: Response | null) => void;
  setCurrentResponseForTab: (tabId: string, response: Response | null) => void;
  setScriptResult: (result: ScriptResults | null) => void;
  setScriptResultForTab: (tabId: string, result: ScriptResults | null) => void;
  setLoading: (loading: boolean) => void;
  setDirty: (dirty: boolean) => void;
  /**
   * Attach an in-flight streaming response to the active tab. Replaces any
   * prior streaming events on that tab and clears the buffered response so
   * `ResponseViewer` dispatches to `StreamingResponseViewer`.
   */
  setStreamingEvents: (events: AsyncIterable<StreamEventLike>) => void;
  setStreamingEventsForTab: (tabId: string, events: AsyncIterable<StreamEventLike>) => void;
  /** Drop the streaming events from the active tab (no-op if none). */
  clearStreamingEvents: () => void;
  /** Drop streaming events from a specified extant tab (no-op if none). */
  clearStreamingEventsForTab: (tabId: string) => void;

  // Convenience
  createNewRequest: (type: RequestType) => string;
  /**
   * Opens a new placeholder HTTP tab tagged with a pseudo-mode (WS / Socket.IO
   * / Kafka / GraphQL). The actual connection state lives in the per-protocol
   * store; the tab is just the workspace shell.
   */
  openTabWithMode: (mode: TabModeOverride) => string;
  renameTab: (tabId: string, name: string) => void;
  linkTabToSavedRequest: (tabId: string, savedRequestId: string) => void;
  detachTabsFromSavedRequests: (savedRequestIds: ReadonlySet<string>) => void;
  clearTabDirty: (tabId: string) => void;

  // Selectors
  getActiveTab: () => RequestTab | null;
}

// Every default name assigned to a freshly created request — the four
// createDefault* factories below plus the feature protocol registries
// (src/features/*/protocol.ts, e.g. GraphQL). TabBar checks membership to
// decide when a tab still carries an auto-assigned name and can fall back to
// displaying the request's host+path. Keep in sync when adding a protocol.
export const DEFAULT_REQUEST_NAMES: ReadonlySet<string> = new Set([
  'New Request',
  'New GraphQL Request',
  'New gRPC Request',
  'New SSE Request',
  'New MCP Request',
]);

// The URL each createDefault* factory (or protocol registry) pre-fills for a
// given default name — used by TabBar to tell a still-pristine tab (URL
// untouched) from one the user has actually pointed somewhere, since several
// request types pre-fill a non-empty echo URL rather than starting blank.
export const DEFAULT_REQUEST_URLS: ReadonlyMap<string, string> = new Map([
  ['New Request', ECHO_URLS.http],
  ['New GraphQL Request', ''],
  ['New gRPC Request', ECHO_URLS.grpc],
  ['New SSE Request', ''],
  ['New MCP Request', ''],
]);

const createDefaultHttpRequest = (): HttpRequest => ({
  id: uuidv4(),
  name: 'New Request',
  type: 'http',
  method: 'GET',
  url: ECHO_URLS.http,
  headers: [],
  params: [],
  body: { type: 'none' },
  auth: { type: 'none' },
});

const createDefaultGrpcRequest = (): GrpcRequest => ({
  id: uuidv4(),
  name: 'New gRPC Request',
  type: 'grpc',
  methodType: 'unary',
  url: ECHO_URLS.grpc,
  service: '',
  method: '',
  metadata: [],
  message: '',
  auth: { type: 'none' },
});

const createDefaultSseRequest = (): SseRequest => ({
  id: uuidv4(),
  name: 'New SSE Request',
  type: 'sse',
  url: '',
  headers: [],
  params: [],
  auth: { type: 'none' },
  reconnectOnResume: true,
});

const createDefaultMcpRequest = (): McpRequest => ({
  id: uuidv4(),
  name: 'New MCP Request',
  type: 'mcp',
  url: '',
  transport: 'streamable-http',
  headers: [],
  auth: { type: 'none' },
});

function defaultRequestForType(type: RequestType): Request {
  switch (type) {
    case 'http':
      return createDefaultHttpRequest();
    case 'grpc':
      return createDefaultGrpcRequest();
    case 'sse':
      return createDefaultSseRequest();
    case 'mcp':
      return createDefaultMcpRequest();
  }
}

function patchActiveTab(
  state: { tabs: RequestTab[]; activeTabId: string | null },
  patch: (tab: RequestTab) => RequestTab
): RequestTab[] {
  if (!state.activeTabId) return state.tabs;
  return patchTab(state.tabs, state.activeTabId, patch);
}

function patchTab(
  tabs: RequestTab[],
  tabId: string,
  patch: (tab: RequestTab) => RequestTab
): RequestTab[] {
  if (!tabs.some((tab) => tab.id === tabId)) return tabs;
  return tabs.map((tab) => (tab.id === tabId ? patch(tab) : tab));
}

/**
 * Dispatches per-tab connection cleanup through explicit lifecycle
 * coordinators. Stores stay pure while managers retain runtime ownership.
 */
const MAX_CLOSED_TABS = 20;

/** Push closed tabs onto the reopen stack without live response/stream state. */
function rememberClosed(stack: RequestTab[], closed: RequestTab[]): RequestTab[] {
  const snapshots = closed.map(
    ({ streamingEvents: _streamingEvents, ...rest }) => ({ ...rest, response: null }) as RequestTab
  );
  return [...stack, ...snapshots].slice(-MAX_CLOSED_TABS);
}

function dispatchTabCleanup(closedTabIds: string[]): void {
  if (closedTabIds.length === 0) return;
  for (const id of closedTabIds) {
    disposeRetainedMonacoModelsForOwner(id);
    cleanupWebSocketConnectionForTab(id);
    cleanupSocketIOConnectionForTab(id);
    cleanupKafkaConnectionForTab(id);
    cleanupMqttConnectionForTab(id);
  }
}

export const useRequestStore = create<RequestState>()(
  persist(
    (set, get) => {
      // Seed initial state with one blank HTTP tab so the page never renders empty.
      const initialTab = createTabFromRequest(createDefaultHttpRequest());
      return {
        tabs: [initialTab],
        activeTabId: initialTab.id,
        isLoading: false,
        closedTabs: [],

        openTab: (request, options = {}) => {
          const tab = createTabFromRequest(
            request,
            options.savedRequestId !== undefined ? { savedRequestId: options.savedRequestId } : {}
          );
          const switchTo = options.switchTo ?? true;
          set((state) => ({
            tabs: [...state.tabs, tab],
            activeTabId: switchTo ? tab.id : state.activeTabId,
          }));
          return tab.id;
        },

        closeTab: (id) => {
          const state = get();
          const idx = findTabIndex(state.tabs, id);
          if (idx === -1) return;
          const newTabs = state.tabs.filter((t) => t.id !== id);
          let nextActive: string | null = state.activeTabId;
          if (state.activeTabId === id) {
            // Pick neighbour to the right (same idx after filter), fallback to left
            const fallback = newTabs[idx] ?? newTabs[idx - 1] ?? null;
            nextActive = fallback ? fallback.id : null;
          }
          set({
            tabs: newTabs,
            activeTabId: nextActive,
            closedTabs: rememberClosed(state.closedTabs, [state.tabs[idx] as RequestTab]),
          });
          dispatchTabCleanup([id]);
        },

        switchTab: (id) => {
          const state = get();
          if (findTabIndex(state.tabs, id) === -1) return;
          set({ activeTabId: id });
        },

        duplicateTab: (id) => {
          const state = get();
          const source = state.tabs.find((t) => t.id === id);
          if (!source) return null;
          const copy = JSON.parse(JSON.stringify(source.request)) as Request;
          // Distinguish a named duplicate; default-named tabs already fall back
          // to showing their URL, so leave those alone.
          const name = DEFAULT_REQUEST_NAMES.has(copy.name) ? copy.name : `${copy.name} (copy)`;
          const clonedRequest: Request = { ...copy, id: uuidv4(), name };
          const tab = createTabFromRequest(
            clonedRequest,
            source.modeOverride !== undefined ? { modeOverride: source.modeOverride } : {}
          );
          set((s) => ({
            tabs: [...s.tabs, tab],
            activeTabId: tab.id,
          }));
          return tab.id;
        },

        reorderTabs: (orderedIds) => {
          const state = get();
          if (orderedIds.length !== state.tabs.length) return;
          const byId = new Map(state.tabs.map((t) => [t.id, t]));
          const reordered = orderedIds
            .map((id) => byId.get(id))
            .filter((t): t is RequestTab => Boolean(t));
          if (reordered.length !== state.tabs.length) return;
          set({ tabs: reordered });
        },

        closeOtherTabs: (id) => {
          const state = get();
          const keep = state.tabs.find((t) => t.id === id);
          if (!keep) return;
          const removedTabs = state.tabs.filter((t) => t.id !== id);
          set({
            tabs: [keep],
            activeTabId: keep.id,
            closedTabs: rememberClosed(state.closedTabs, removedTabs),
          });
          dispatchTabCleanup(removedTabs.map((t) => t.id));
        },

        closeAllTabs: () => {
          const state = get();
          set({
            tabs: [],
            activeTabId: null,
            closedTabs: rememberClosed(state.closedTabs, state.tabs),
          });
          dispatchTabCleanup(state.tabs.map((t) => t.id));
        },

        closeTabsToRight: (id) => {
          const state = get();
          const idx = findTabIndex(state.tabs, id);
          if (idx === -1) return;
          const removedTabs = state.tabs.slice(idx + 1);
          if (removedTabs.length === 0) return;
          const kept = state.tabs.slice(0, idx + 1);
          const activeKept = kept.some((t) => t.id === state.activeTabId);
          set({
            tabs: kept,
            activeTabId: activeKept ? state.activeTabId : id,
            closedTabs: rememberClosed(state.closedTabs, removedTabs),
          });
          dispatchTabCleanup(removedTabs.map((t) => t.id));
        },

        reopenClosedTab: () => {
          const state = get();
          const last = state.closedTabs[state.closedTabs.length - 1];
          if (!last) return;
          // Fresh tab id: cleanup listeners already tore down the old one.
          const tab: RequestTab = { ...last, id: uuidv4() };
          set({
            tabs: [...state.tabs, tab],
            activeTabId: tab.id,
            closedTabs: state.closedTabs.slice(0, -1),
          });
        },

        updateRequest: (updates) => {
          const state = get();
          if (!state.activeTabId) return false;
          const active = state.tabs.find((t) => t.id === state.activeTabId);
          if (!active) return false;
          let next: Request;
          try {
            next = validateRequestUpdate(active.request, updates);
          } catch (error) {
            const msg = error instanceof Error ? error.message : 'Invalid request update';
            console.warn('Request update rejected:', msg, updates);
            toast.error('Invalid input', { description: msg });
            return false; // do NOT apply
          }
          set((s) => ({
            tabs: patchActiveTab(s, (t) => ({ ...t, request: next, isDirty: true })),
          }));
          return true;
        },

        updateRequestForTab: (tabId, updates) => {
          const tab = get().tabs.find((candidate) => candidate.id === tabId);
          if (!tab) return false;
          let next: Request;
          try {
            next = validateRequestUpdate(tab.request, updates);
          } catch (error) {
            const msg = error instanceof Error ? error.message : 'Invalid request update';
            console.warn('Request update rejected:', msg, updates);
            toast.error('Invalid input', { description: msg });
            return false;
          }
          set((s) => ({
            tabs: patchTab(s.tabs, tabId, (target) => ({
              ...target,
              request: next,
              isDirty: true,
            })),
          }));
          return true;
        },

        setCurrentResponse: (response) => {
          set((s) => ({
            tabs: patchActiveTab(s, (t) => ({ ...t, response })),
          }));
        },

        setCurrentResponseForTab: (tabId, response) => {
          set((s) => ({
            tabs: patchTab(s.tabs, tabId, (tab) => ({ ...tab, response })),
          }));
        },

        setStreamingEvents: (events) => {
          set((s) => ({
            tabs: patchActiveTab(s, (t) => ({
              ...t,
              streamingEvents: events,
              // Clear any prior buffered response so the viewer dispatches
              // unambiguously to the streaming view.
              response: null,
            })),
          }));
        },

        setStreamingEventsForTab: (tabId, events) => {
          set((s) => ({
            tabs: patchTab(s.tabs, tabId, (tab) => ({
              ...tab,
              streamingEvents: events,
              response: null,
            })),
          }));
        },

        clearStreamingEvents: () => {
          set((s) => ({
            tabs: patchActiveTab(s, (t) => {
              if (!t.streamingEvents) return t;
              const { streamingEvents: _drop, ...rest } = t;
              return rest;
            }),
          }));
        },

        clearStreamingEventsForTab: (tabId) => {
          set((s) => ({
            tabs: patchTab(s.tabs, tabId, (tab) => {
              if (!tab.streamingEvents) return tab;
              const { streamingEvents: _drop, ...rest } = tab;
              return rest;
            }),
          }));
        },

        setScriptResult: (result) => {
          set((s) => ({
            tabs: patchActiveTab(s, (t) => ({ ...t, scriptResult: result })),
          }));
        },

        setScriptResultForTab: (tabId, result) => {
          set((s) => ({
            tabs: patchTab(s.tabs, tabId, (tab) => ({ ...tab, scriptResult: result })),
          }));
        },

        setLoading: (loading) => set({ isLoading: loading }),

        setDirty: (dirty) => {
          set((s) => ({
            tabs: patchActiveTab(s, (t) => ({ ...t, isDirty: dirty })),
          }));
        },

        createNewRequest: (type) => {
          const request = defaultRequestForType(type);
          return get().openTab(request);
        },

        openTabWithMode: (mode) => {
          const request = createDefaultHttpRequest();
          const modeRequest =
            mode === 'graphql'
              ? {
                  ...request,
                  name: 'New GraphQL Request',
                  method: 'POST' as const,
                  body: { type: 'graphql' as const, raw: '' },
                }
              : request;
          const tab = createTabFromRequest(modeRequest, { modeOverride: mode });
          set((state) => ({
            tabs: [...state.tabs, tab],
            activeTabId: tab.id,
          }));
          return tab.id;
        },

        renameTab: (tabId, name) => {
          const existing = get().tabs.find((t) => t.id === tabId);
          if (!existing || existing.request.name === name) return;
          set((s) => ({
            tabs: s.tabs.map((t) =>
              t.id === tabId ? { ...t, request: { ...t.request, name }, isDirty: true } : t
            ),
          }));
        },

        linkTabToSavedRequest: (tabId, savedRequestId) => {
          const existing = get().tabs.find((t) => t.id === tabId);
          if (!existing || (existing.savedRequestId === savedRequestId && !existing.isDirty))
            return;
          set((s) => ({
            tabs: s.tabs.map((t) =>
              t.id === tabId ? { ...t, savedRequestId, isDirty: false } : t
            ),
          }));
        },

        detachTabsFromSavedRequests: (savedRequestIds) => {
          if (
            !get().tabs.some((tab) => tab.savedRequestId && savedRequestIds.has(tab.savedRequestId))
          )
            return;
          set((state) => ({
            tabs: state.tabs.map((tab) => {
              if (!tab.savedRequestId || !savedRequestIds.has(tab.savedRequestId)) return tab;
              const { savedRequestId: _savedRequestId, ...detached } = tab;
              return { ...detached, isDirty: true };
            }),
          }));
        },

        clearTabDirty: (tabId) => {
          const existing = get().tabs.find((t) => t.id === tabId);
          if (!existing?.isDirty) return;
          set((s) => ({
            tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, isDirty: false } : t)),
          }));
        },

        getActiveTab: () => {
          const state = get();
          if (!state.activeTabId) return null;
          return state.tabs.find((t) => t.id === state.activeTabId) ?? null;
        },
      };
    },
    {
      name: 'request-storage',
      version: 4,
      storage: dexieStorageAdapters.requestTabs(),
      partialize: (state) => ({
        // streamingEvents: AsyncIterables can't serialize, and active streams
        // are intentionally aborted on page reload.
        // response: bodies can be tens of MB and already live in useHistoryStore;
        // rehydrate with response: null so the tab is restorable but doesn't
        // carry stale data on the hot path of every tab switch / write.
        tabs: state.tabs.map(
          ({ streamingEvents: _streamingEvents, response: _response, ...rest }) => ({
            ...rest,
            response: null,
          })
        ),
        activeTabId: state.activeTabId,
      }),
      migrate: (persistedState: unknown, version) => {
        // v0/v1: pre-Dexie shape lived in localStorage
        // v2:    Dexie-backed but still per-protocol slots
        // v3:    tabs[] + activeTabId
        // v4:    AuthConfig sensitive fields widened to SecretValue (ADR-0007)
        let state: RequestState | null = null;
        if (version < 3 && persistedState && typeof persistedState === 'object') {
          const legacy = persistedState as {
            currentRequest?: Request | null;
            httpRequest?: Request | null;
            grpcRequest?: Request | null;
            sseRequest?: Request | null;
            mcpRequest?: Request | null;
            currentResponse?: Response | null;
          };
          state = migrateLegacyStateToTabs({
            currentRequest: legacy.currentRequest ?? null,
            httpRequest: legacy.httpRequest ?? null,
            grpcRequest: legacy.grpcRequest ?? null,
            sseRequest: legacy.sseRequest ?? null,
            mcpRequest: legacy.mcpRequest ?? null,
            currentResponse: legacy.currentResponse ?? null,
          }) as unknown as RequestState;
        } else {
          state = persistedState as RequestState;
        }
        if (version < 4 && state?.tabs) {
          state = {
            ...state,
            tabs: state.tabs.map((tab) => {
              const request = tab.request as { auth?: unknown } | undefined;
              if (!request || !('auth' in request)) return tab;
              const migrated = migrateAuthConfigToSecretRef(request.auth);
              if (!migrated) return tab;
              return { ...tab, request: { ...request, auth: migrated } as typeof tab.request };
            }),
          };
        }
        return state as RequestState;
      },
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        // Ensure activeTabId points to a real tab; fallback to first tab.
        if (!state.activeTabId || !state.tabs.some((t) => t.id === state.activeTabId)) {
          const first = state.tabs[0];
          state.activeTabId = first ? first.id : null;
        }
        // Ensure at least one tab exists so the page never renders empty.
        if (state.tabs.length === 0) {
          const blank = createTabFromRequest(createDefaultHttpRequest());
          state.tabs = [blank];
          state.activeTabId = blank.id;
        }
      },
    }
  )
);
