import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  Request,
  Response,
  RequestTab,
  HttpRequest,
  GrpcRequest,
  SseRequest,
  McpRequest,
  ScriptResult,
  RequestType,
} from '@/types';
import { v4 as uuidv4 } from 'uuid';
import { toast } from 'sonner';
import { validateRequestUpdate } from '@/lib/shared/store-validators';
import { dexieStorageAdapters } from '@/lib/shared/dexie-storage';
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

  // Per-active-tab actions (names preserved for consumer compatibility)
  updateRequest: (updates: Partial<Request>) => void;
  setCurrentResponse: (response: Response | null) => void;
  setScriptResult: (result: ScriptResults | null) => void;
  setLoading: (loading: boolean) => void;
  setDirty: (dirty: boolean) => void;

  // Convenience
  createNewRequest: (type: RequestType) => string;

  // Selectors
  getActiveTab: () => RequestTab | null;
}

const createDefaultHttpRequest = (): HttpRequest => ({
  id: uuidv4(),
  name: 'New Request',
  type: 'http',
  method: 'GET',
  url: '',
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
  url: '',
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
    case 'http': return createDefaultHttpRequest();
    case 'grpc': return createDefaultGrpcRequest();
    case 'sse': return createDefaultSseRequest();
    case 'mcp': return createDefaultMcpRequest();
  }
}

function patchActiveTab(
  state: { tabs: RequestTab[]; activeTabId: string | null },
  patch: (tab: RequestTab) => RequestTab
): RequestTab[] {
  if (!state.activeTabId) return state.tabs;
  return state.tabs.map((t) => (t.id === state.activeTabId ? patch(t) : t));
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
          set({ tabs: newTabs, activeTabId: nextActive });
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
          const clonedRequest: Request = {
            ...(JSON.parse(JSON.stringify(source.request)) as Request),
            id: uuidv4(),
          };
          const tab = createTabFromRequest(clonedRequest);
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
          set({ tabs: [keep], activeTabId: keep.id });
        },

        closeAllTabs: () => set({ tabs: [], activeTabId: null }),

        updateRequest: (updates) => {
          const state = get();
          if (!state.activeTabId) return;
          const active = state.tabs.find((t) => t.id === state.activeTabId);
          if (!active) return;
          let next: Request;
          try {
            next = validateRequestUpdate(active.request, updates);
          } catch (error) {
            const msg = error instanceof Error ? error.message : 'Invalid request update';
            console.warn('Request update rejected:', msg, updates);
            toast.error('Invalid input', { description: msg });
            return; // do NOT apply
          }
          set((s) => ({
            tabs: patchActiveTab(s, (t) => ({ ...t, request: next, isDirty: true })),
          }));
        },

        setCurrentResponse: (response) => {
          set((s) => ({
            tabs: patchActiveTab(s, (t) => ({ ...t, response })),
          }));
        },

        setScriptResult: (result) => {
          set((s) => ({
            tabs: patchActiveTab(s, (t) => ({ ...t, scriptResult: result })),
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

        getActiveTab: () => {
          const state = get();
          if (!state.activeTabId) return null;
          return state.tabs.find((t) => t.id === state.activeTabId) ?? null;
        },
      };
    },
    {
      name: 'request-storage',
      version: 3,
      storage: dexieStorageAdapters.requestTabs(),
      partialize: (state) => ({
        tabs: state.tabs,
        activeTabId: state.activeTabId,
      }),
      migrate: (persistedState: unknown, version) => {
        // v0/v1: pre-Dexie shape lived in localStorage
        // v2:    Dexie-backed but still per-protocol slots
        // v3:    tabs[] + activeTabId
        if (version < 3 && persistedState && typeof persistedState === 'object') {
          const legacy = persistedState as {
            currentRequest?: Request | null;
            httpRequest?: Request | null;
            grpcRequest?: Request | null;
            sseRequest?: Request | null;
            mcpRequest?: Request | null;
            currentResponse?: Response | null;
          };
          const migrated = migrateLegacyStateToTabs({
            currentRequest: legacy.currentRequest ?? null,
            httpRequest: legacy.httpRequest ?? null,
            grpcRequest: legacy.grpcRequest ?? null,
            sseRequest: legacy.sseRequest ?? null,
            mcpRequest: legacy.mcpRequest ?? null,
            currentResponse: legacy.currentResponse ?? null,
          });
          return migrated as unknown as RequestState;
        }
        return persistedState as RequestState;
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
