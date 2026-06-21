# Multi-Tab Request Store + Storage Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reshape `useRequestStore` around a tab list so users can hold multiple requests open simultaneously, replace the per-protocol slot model (`httpRequest`/`grpcRequest`/`sseRequest`/`mcpRequest`), persist response per tab so restarts no longer lose the open response, and add Postman-name parity for built-in variables. Also delete the legacy localStorage-backed `storage.ts` adapter — every store already migrated to Dexie/electron-store except this one.

**Architecture:** A `RequestTab` is a tuple `{ id, request, response?, scriptResult?, isDirty, savedRequestId? }`. The store becomes `tabs: RequestTab[]` + `activeTabId: string | null`. Existing actions (`updateRequest`, `setCurrentResponse`, etc.) operate on the active tab. New actions: `openTab(request)`, `closeTab(id)`, `switchTab(id)`, `duplicateTab(id)`, `reorderTabs(ids)`. The page-level `requestMode` state is derived from `activeTab.request.type` instead of being independent local state.

**Tech Stack:** Zustand 5 (existing), Dexie/IndexedDB (existing), Monaco editor model API for editor-state preservation, no new runtime deps.

---

## File structure

**Created:**

- `src/store/lib/tabs.ts` — pure helpers (`createTabFromRequest`, `migrateLegacyStateToTabs`, `findTabIndex`)
- `src/store/lib/tabs.test.ts`
- `src/components/shared/TabBar.tsx` — visual tab list (open, close, switch, "+" new-tab dropdown)
- `src/components/shared/TabBar.test.tsx`
- `src/lib/shared/dynamicVariables.ts` — `applyDynamicVariables(text)` returning resolved string with `$randomUUID`/`$randomEmail`/etc. expanded
- `src/lib/shared/dynamicVariables.test.ts`
- `docs/adr/0002-multi-tab-store.md`

**Modified:**

- `src/types/index.ts` — add `RequestTab` interface
- `src/store/useRequestStore.ts` — full reshape; persist response per tab
- `src/store/__tests__/useRequestStore.test.ts` — rewrite around new shape
- `src/store/useEnvironmentStore.ts` — extract dynamic-variable expansion to `dynamicVariables.ts`, add Postman-name aliases
- `src/routes/index.tsx` — `requestMode` derives from active tab; render builder dispatch by tab type
- `src/components/shared/Header.tsx` — drop protocol-switching; "+ New" → opens dropdown
- `src/components/shared/TopBar.tsx` — same
- `src/components/shared/CommandPalette.tsx` — `createNewHttpRequest()` etc. now `openTab(...)`
- `src/features/collections/components/Sidebar.tsx` — clicking a saved request opens a tab (or focuses existing)
- `src/features/http/hooks/useHttpRequest.ts` — read from active tab
- `src/features/http/hooks/useHttpRequestPage.ts` — same
- `src/features/http/components/RequestBuilder/index.tsx` — same
- `src/features/grpc/components/GrpcRequestBuilder.tsx` — same
- `src/features/graphql/components/GraphQLRequestBuilder.tsx` — same
- `src/features/sse/components/SseClient.tsx` — same
- `src/features/websocket/components/WebSocketClient.tsx` — same
- `src/features/mcp/components/McpRequestBuilder.tsx` — same
- `src/features/grpc/components/GrpcReflectionPanel.tsx` — same
- `src/features/http/components/CodeGeneratorDialog.tsx` — same
- `src/lib/shared/index.ts` — drop the `storage` barrel re-export
- `docs/ARCHITECTURE.md` — add "Multi-tab request model" section

**Deleted:**

- `src/lib/shared/storage.ts` (after Task 13 verifies no consumers)

---

## Tasks

### Task 1: Define `RequestTab` type + tab helpers

**Files:**

- Modify: `src/types/index.ts` — add `RequestTab` interface
- Create: `src/store/lib/tabs.ts`
- Create: `src/store/lib/tabs.test.ts`

The helpers are pure (no Zustand) so they can be unit-tested in isolation.

- [ ] **Step 1: Write the failing tests**

Create `src/store/lib/tabs.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createTabFromRequest, migrateLegacyStateToTabs, findTabIndex } from './tabs';
import type { HttpRequest, GrpcRequest, RequestTab } from '@/types';

const httpReq: HttpRequest = {
  id: 'req-1',
  name: 'Get user',
  type: 'http',
  method: 'GET',
  url: 'https://api.example.com/u/1',
  headers: [],
  params: [],
  body: { type: 'none' },
  auth: { type: 'none' },
};

const grpcReq: GrpcRequest = {
  id: 'req-2',
  name: 'Lookup',
  type: 'grpc',
  methodType: 'unary',
  url: 'grpc.example.com',
  service: 'svc.Foo',
  method: 'Bar',
  metadata: [],
  message: '',
  auth: { type: 'none' },
};

describe('createTabFromRequest', () => {
  it('creates a tab with a unique id and the given request', () => {
    const tab = createTabFromRequest(httpReq);
    expect(tab.id).toMatch(/^tab_/);
    expect(tab.request).toEqual(httpReq);
    expect(tab.isDirty).toBe(false);
    expect(tab.response).toBeUndefined();
  });

  it('marks the tab as not-dirty initially even if request has unsaved changes', () => {
    const tab = createTabFromRequest(httpReq);
    expect(tab.isDirty).toBe(false);
  });
});

describe('findTabIndex', () => {
  it('returns the index of the tab with matching id', () => {
    const a = createTabFromRequest(httpReq);
    const b = createTabFromRequest(grpcReq);
    expect(findTabIndex([a, b], b.id)).toBe(1);
    expect(findTabIndex([a, b], a.id)).toBe(0);
  });
  it('returns -1 if no tab matches', () => {
    expect(findTabIndex([], 'nope')).toBe(-1);
  });
  it('returns -1 if id is null', () => {
    const a = createTabFromRequest(httpReq);
    expect(findTabIndex([a], null)).toBe(-1);
  });
});

describe('migrateLegacyStateToTabs', () => {
  it('seeds a single tab from legacy currentRequest when present', () => {
    const result = migrateLegacyStateToTabs({
      currentRequest: httpReq,
      httpRequest: httpReq,
      grpcRequest: grpcReq,
      sseRequest: null,
      mcpRequest: null,
      currentResponse: null,
    });
    expect(result.tabs).toHaveLength(1);
    expect(result.tabs[0]?.request.id).toBe('req-1');
    expect(result.activeTabId).toBe(result.tabs[0]?.id);
  });

  it('attaches the legacy currentResponse to the seeded tab when types align', () => {
    const response = {
      id: 'res-1',
      requestId: 'req-1',
      status: 200,
      statusText: 'OK',
      headers: {},
      body: '{}',
      size: 2,
      time: 50,
      timestamp: Date.now(),
    };
    const result = migrateLegacyStateToTabs({
      currentRequest: httpReq,
      httpRequest: httpReq,
      grpcRequest: null,
      sseRequest: null,
      mcpRequest: null,
      currentResponse: response,
    });
    expect(result.tabs[0]?.response).toEqual(response);
  });

  it('returns empty tabs and null activeTabId when no legacy request exists', () => {
    const result = migrateLegacyStateToTabs({
      currentRequest: null,
      httpRequest: null,
      grpcRequest: null,
      sseRequest: null,
      mcpRequest: null,
      currentResponse: null,
    });
    expect(result.tabs).toEqual([]);
    expect(result.activeTabId).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /Users/dipjyotimetia/Documents/working/ccviews/restura
npm run test:run -- src/store/lib/tabs 2>&1 | tail -10
```

Expected: FAIL — module missing.

- [ ] **Step 3: Add `RequestTab` to `src/types/index.ts`**

Find the `Request` union near line 290. After it, add:

```ts
export interface RequestTab {
  id: string;
  request: Request;
  /** Last response received in this tab; persists across reloads. */
  response?: Response | null;
  /** Last script results (pre-request + test) for this tab's request. */
  scriptResult?: { preRequest?: ScriptResult; test?: ScriptResult } | null;
  /** Whether the request has unsaved changes vs the saved version (savedRequestId). */
  isDirty: boolean;
  /** If this tab was opened from a saved request in a collection, the saved request's id. */
  savedRequestId?: string;
}
```

Read the existing file to find any existing imports needed (`ScriptResult` is already exported from `src/types/index.ts`).

- [ ] **Step 4: Implement the helpers**

Create `src/store/lib/tabs.ts`:

```ts
import type { Request, RequestTab, Response } from '@/types';
import { v4 as uuidv4 } from 'uuid';

export function createTabFromRequest(
  request: Request,
  options: { savedRequestId?: string } = {}
): RequestTab {
  const tab: RequestTab = {
    id: `tab_${uuidv4()}`,
    request,
    isDirty: false,
  };
  if (options.savedRequestId !== undefined) {
    tab.savedRequestId = options.savedRequestId;
  }
  return tab;
}

export function findTabIndex(tabs: RequestTab[], id: string | null): number {
  if (id === null) return -1;
  return tabs.findIndex((t) => t.id === id);
}

export interface LegacyRequestState {
  currentRequest: Request | null;
  httpRequest: Request | null;
  grpcRequest: Request | null;
  sseRequest: Request | null;
  mcpRequest: Request | null;
  currentResponse: Response | null;
}

export interface MigratedRequestState {
  tabs: RequestTab[];
  activeTabId: string | null;
}

export function migrateLegacyStateToTabs(legacy: LegacyRequestState): MigratedRequestState {
  if (!legacy.currentRequest) {
    return { tabs: [], activeTabId: null };
  }
  const tab = createTabFromRequest(legacy.currentRequest);
  if (legacy.currentResponse && legacy.currentResponse.requestId === legacy.currentRequest.id) {
    tab.response = legacy.currentResponse;
  }
  return { tabs: [tab], activeTabId: tab.id };
}
```

- [ ] **Step 5: Run tests to pass**

```bash
npm run test:run -- src/store/lib/tabs 2>&1 | tail -10
```

10 tests pass.

- [ ] **Step 6: Type-check**

```bash
npx tsc --noEmit 2>&1 | tail -3
```

Clean.

- [ ] **Step 7: Commit**

```bash
git add src/types/index.ts src/store/lib/tabs.ts src/store/lib/tabs.test.ts
git commit -m "feat(store): add RequestTab type + tab helpers"
```

---

### Task 2: Reshape `useRequestStore` around tabs

**Files:**

- Modify: `src/store/useRequestStore.ts`

This is the biggest single edit in the plan. The new store keeps the existing action _names_ where possible (`updateRequest`, `setCurrentResponse`, `setLoading`, `setScriptResult`, `clearRequest`) so consumers need minimal changes — those actions now operate on the active tab. New actions handle tab lifecycle.

The store also persists tabs to Dexie (not localStorage) — line up with the rest of the codebase. There's a one-time migration from the old shape via `migrateLegacyStateToTabs`.

- [ ] **Step 1: Replace `src/store/useRequestStore.ts` content**

```ts
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

  // Per-active-tab actions (keep old names for consumer compatibility)
  updateRequest: (updates: Partial<Request>) => void;
  setCurrentResponse: (response: Response | null) => void;
  setScriptResult: (result: ScriptResults | null) => void;
  setLoading: (loading: boolean) => void;
  setDirty: (dirty: boolean) => void;

  // Convenience: open a fresh blank request for a given protocol
  createNewRequest: (type: RequestType | 'http') => string;

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
  return state.tabs.map((t) => (t.id === state.activeTabId ? patch(t) : t));
}

export const useRequestStore = create<RequestState>()(
  persist(
    (set, get) => ({
      tabs: [createTabFromRequest(createDefaultHttpRequest())],
      activeTabId: null, // set after rehydration; fallback in onRehydrateStorage
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
          // Pick neighbour to the right, fallback to left
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
        // Deep-clone the request and assign a new id so collection ops don't conflate them
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
        const reordered = orderedIds.map((id) => byId.get(id)).filter(Boolean) as RequestTab[];
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
          console.error('Request update validation failed:', error);
          next = { ...active.request, ...updates } as Request;
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
    }),
    {
      name: 'request-storage',
      version: 3, // bump from existing v2 to trigger migration
      storage: dexieStorageAdapters.history(), // reuse existing 'history' table or add one — see Step 2
      partialize: (state) => ({
        tabs: state.tabs,
        activeTabId: state.activeTabId,
      }),
      migrate: (persistedState: unknown, version) => {
        // v0/v1: pre-Dexie shape lived in localStorage as { currentRequest, httpRequest, ... }
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
        // After hydration, ensure activeTabId points to a real tab
        if (!state) return;
        if (!state.activeTabId || !state.tabs.some((t) => t.id === state.activeTabId)) {
          const first = state.tabs[0];
          state.activeTabId = first ? first.id : null;
        }
        // Ensure at least one tab exists so the page never renders empty
        if (state.tabs.length === 0) {
          const blank = createTabFromRequest(createDefaultHttpRequest());
          state.tabs = [blank];
          state.activeTabId = blank.id;
        }
      },
    }
  )
);
```

Note on storage: `dexieStorageAdapters.history()` is wrong — that's for history records. We should either reuse `settings` (no — also wrong) or add a new `requestTabs` adapter. Easier path: add a new table.

- [ ] **Step 2: Add a `requestTabs` Dexie table**

Read `src/lib/shared/database.ts` (let me confirm path):

```bash
ls src/lib/shared/database.ts
```

Then read it. Find the table list — the existing tables are `collections | environments | history | settings | cookies | workflows | workflowExecutions | fileCollections`. Add `requestTabs`:

```ts
// In the schema definition
requestTabs: '&id, name, updatedAt',
```

And in `src/lib/shared/dexie-storage.ts`, add to the `StorageTableName` union and `dexieStorageAdapters`:

```ts
type StorageTableName =
  | 'collections'
  | 'environments'
  | 'history'
  | 'settings'
  | 'cookies'
  | 'workflows'
  | 'workflowExecutions'
  | 'fileCollections'
  | 'requestTabs';

// ... add to dexieStorageAdapters object:
requestTabs: () =>
  createDexieStorage({ tableName: 'requestTabs', encrypt: true }),
```

Bump the database `version()` number and add a migration block that creates the new table.

Then in `useRequestStore.ts`, switch to `dexieStorageAdapters.requestTabs()`.

- [ ] **Step 3: Run tests**

```bash
cd /Users/dipjyotimetia/Documents/working/ccviews/restura
npm run test:run -- src/store/__tests__/useRequestStore 2>&1 | tail -30
```

Expected: existing tests will FAIL because the shape changed. Task 3 rewrites them.

For now, just confirm `npx tsc --noEmit` is clean (the store should type-check even if its tests don't compile yet). If tests block tsc, comment out the test file body temporarily.

- [ ] **Step 4: Commit**

```bash
git add src/store/useRequestStore.ts src/lib/shared/database.ts src/lib/shared/dexie-storage.ts
git commit -m "feat(store): reshape useRequestStore around tabs[] + activeTabId

- Per-protocol slots replaced with tabs array + activeTabId
- Legacy shape migrated automatically (version bump 2 → 3)
- Response and scriptResult now persist per-tab
- New dexie table 'requestTabs' for persistence
- Existing action names preserved where possible (updateRequest,
  setCurrentResponse, setScriptResult, setLoading) — they now mutate
  the active tab"
```

---

### Task 3: Rewrite `useRequestStore` tests for the new shape

**Files:**

- Modify: `src/store/__tests__/useRequestStore.test.ts`

The existing tests are heavily tied to the old shape. Replace them.

- [ ] **Step 1: Replace test file content**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useRequestStore } from '../useRequestStore';
import type { HttpRequest, GrpcRequest, Response as ApiResponse } from '@/types';

const makeHttp = (overrides: Partial<HttpRequest> = {}): HttpRequest => ({
  id: 'r-' + Math.random().toString(36).slice(2),
  name: 'Test',
  type: 'http',
  method: 'GET',
  url: 'https://example.com/',
  headers: [],
  params: [],
  body: { type: 'none' },
  auth: { type: 'none' },
  ...overrides,
});

const makeGrpc = (overrides: Partial<GrpcRequest> = {}): GrpcRequest => ({
  id: 'r-' + Math.random().toString(36).slice(2),
  name: 'Test gRPC',
  type: 'grpc',
  methodType: 'unary',
  url: 'grpc.example.com',
  service: 'svc.Foo',
  method: 'Bar',
  metadata: [],
  message: '',
  auth: { type: 'none' },
  ...overrides,
});

const makeResponse = (requestId: string): ApiResponse => ({
  id: 'res-' + Math.random().toString(36).slice(2),
  requestId,
  status: 200,
  statusText: 'OK',
  headers: {},
  body: '{}',
  size: 2,
  time: 50,
  timestamp: Date.now(),
});

describe('useRequestStore — tabs', () => {
  beforeEach(() => {
    useRequestStore.setState({
      tabs: [],
      activeTabId: null,
      isLoading: false,
    });
  });

  describe('openTab / switchTab / closeTab', () => {
    it('opens a tab and sets it as active by default', () => {
      const id = useRequestStore.getState().openTab(makeHttp());
      const state = useRequestStore.getState();
      expect(state.tabs).toHaveLength(1);
      expect(state.activeTabId).toBe(id);
    });

    it('opens a tab without switching when switchTo: false', () => {
      const a = useRequestStore.getState().openTab(makeHttp());
      const _b = useRequestStore.getState().openTab(makeGrpc(), { switchTo: false });
      void _b;
      expect(useRequestStore.getState().activeTabId).toBe(a);
    });

    it('switches active tab', () => {
      const a = useRequestStore.getState().openTab(makeHttp());
      const b = useRequestStore.getState().openTab(makeGrpc());
      useRequestStore.getState().switchTab(a);
      expect(useRequestStore.getState().activeTabId).toBe(a);
      useRequestStore.getState().switchTab(b);
      expect(useRequestStore.getState().activeTabId).toBe(b);
    });

    it('switchTab is a no-op for unknown id', () => {
      const a = useRequestStore.getState().openTab(makeHttp());
      useRequestStore.getState().switchTab('nope');
      expect(useRequestStore.getState().activeTabId).toBe(a);
    });

    it('closing the active tab activates the right neighbour, then left', () => {
      const a = useRequestStore.getState().openTab(makeHttp());
      const b = useRequestStore.getState().openTab(makeGrpc());
      const c = useRequestStore.getState().openTab(makeHttp());
      // Active is c (last opened). Close b — active stays c.
      useRequestStore.getState().closeTab(b);
      expect(useRequestStore.getState().activeTabId).toBe(c);
      // Close c — active falls back to a (left neighbour, since no right).
      useRequestStore.getState().closeTab(c);
      expect(useRequestStore.getState().activeTabId).toBe(a);
    });

    it('closing a non-active tab keeps active', () => {
      const a = useRequestStore.getState().openTab(makeHttp());
      const b = useRequestStore.getState().openTab(makeGrpc());
      useRequestStore.getState().switchTab(a);
      useRequestStore.getState().closeTab(b);
      expect(useRequestStore.getState().activeTabId).toBe(a);
    });

    it('closing the last tab leaves activeTabId null', () => {
      const a = useRequestStore.getState().openTab(makeHttp());
      useRequestStore.getState().closeTab(a);
      expect(useRequestStore.getState().tabs).toHaveLength(0);
      expect(useRequestStore.getState().activeTabId).toBeNull();
    });
  });

  describe('updateRequest', () => {
    it('mutates the active tab and marks isDirty', () => {
      useRequestStore.getState().openTab(makeHttp({ url: 'https://a.com' }));
      useRequestStore.getState().updateRequest({ url: 'https://b.com' });
      const tab = useRequestStore.getState().getActiveTab()!;
      expect(tab.request.url).toBe('https://b.com');
      expect(tab.isDirty).toBe(true);
    });

    it('does not mutate other tabs', () => {
      const a = useRequestStore.getState().openTab(makeHttp({ url: 'https://a.com' }));
      const _b = useRequestStore.getState().openTab(makeHttp({ url: 'https://b.com' }));
      void _b;
      // _b is now active; mutate it
      useRequestStore.getState().updateRequest({ url: 'https://b-edited.com' });
      const tabA = useRequestStore.getState().tabs.find((t) => t.id === a)!;
      expect(tabA.request.url).toBe('https://a.com');
    });

    it('is a no-op when no active tab', () => {
      useRequestStore.getState().updateRequest({ url: 'https://x.com' });
      expect(useRequestStore.getState().tabs).toHaveLength(0);
    });
  });

  describe('setCurrentResponse / setScriptResult', () => {
    it('sets response on the active tab only', () => {
      const a = useRequestStore.getState().openTab(makeHttp());
      const b = useRequestStore.getState().openTab(makeGrpc());
      const responseB = makeResponse('whatever');
      useRequestStore.getState().setCurrentResponse(responseB);
      const tabA = useRequestStore.getState().tabs.find((t) => t.id === a)!;
      const tabB = useRequestStore.getState().tabs.find((t) => t.id === b)!;
      expect(tabA.response).toBeUndefined();
      expect(tabB.response).toBe(responseB);
    });
  });

  describe('duplicateTab', () => {
    it('creates a new tab with the same request data but a fresh request id', () => {
      const a = useRequestStore.getState().openTab(makeHttp({ id: 'orig', url: 'https://a.com' }));
      const dup = useRequestStore.getState().duplicateTab(a)!;
      expect(dup).not.toBe(a);
      const dupTab = useRequestStore.getState().tabs.find((t) => t.id === dup)!;
      expect(dupTab.request.url).toBe('https://a.com');
      expect(dupTab.request.id).not.toBe('orig');
    });
  });

  describe('reorderTabs', () => {
    it('reorders to match the supplied id list', () => {
      const a = useRequestStore.getState().openTab(makeHttp());
      const b = useRequestStore.getState().openTab(makeGrpc());
      const c = useRequestStore.getState().openTab(makeHttp());
      useRequestStore.getState().reorderTabs([c, a, b]);
      const ids = useRequestStore.getState().tabs.map((t) => t.id);
      expect(ids).toEqual([c, a, b]);
    });

    it('rejects orderedIds with wrong length', () => {
      useRequestStore.getState().openTab(makeHttp());
      useRequestStore.getState().openTab(makeGrpc());
      const before = useRequestStore.getState().tabs.map((t) => t.id);
      useRequestStore.getState().reorderTabs(['only-one']);
      const after = useRequestStore.getState().tabs.map((t) => t.id);
      expect(after).toEqual(before);
    });
  });

  describe('closeOtherTabs / closeAllTabs', () => {
    it('closeOtherTabs leaves only the named tab active', () => {
      useRequestStore.getState().openTab(makeHttp());
      const b = useRequestStore.getState().openTab(makeGrpc());
      useRequestStore.getState().openTab(makeHttp());
      useRequestStore.getState().closeOtherTabs(b);
      expect(useRequestStore.getState().tabs).toHaveLength(1);
      expect(useRequestStore.getState().activeTabId).toBe(b);
    });

    it('closeAllTabs clears everything', () => {
      useRequestStore.getState().openTab(makeHttp());
      useRequestStore.getState().openTab(makeGrpc());
      useRequestStore.getState().closeAllTabs();
      expect(useRequestStore.getState().tabs).toHaveLength(0);
      expect(useRequestStore.getState().activeTabId).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run tests**

```bash
npm run test:run -- src/store/__tests__/useRequestStore 2>&1 | tail -10
```

All tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/store/__tests__/useRequestStore.test.ts
git commit -m "test(store): rewrite useRequestStore tests for tab-based shape"
```

---

### Task 4: Update `useHttpRequest` and `useHttpRequestPage` hooks

**Files:**

- Modify: `src/features/http/hooks/useHttpRequest.ts`
- Modify: `src/features/http/hooks/useHttpRequestPage.ts`

These hooks are the primary consumers. They currently destructure `currentRequest` and `currentResponse` from the store. Replace with a `getActiveTab()` selector or a derived hook.

- [ ] **Step 1: Add a selector hook**

Read `src/store/selectors.ts`. Add:

```ts
import { useRequestStore } from './useRequestStore';
import type { HttpRequest, GrpcRequest, SseRequest, McpRequest, RequestType } from '@/types';

export function useActiveTab() {
  return useRequestStore((s) =>
    s.activeTabId ? (s.tabs.find((t) => t.id === s.activeTabId) ?? null) : null
  );
}

export function useActiveRequest<T extends RequestType>(type: T) {
  return useRequestStore((s) => {
    const tab = s.activeTabId ? s.tabs.find((t) => t.id === s.activeTabId) : null;
    if (!tab || tab.request.type !== type) return null;
    return tab.request as T extends 'http'
      ? HttpRequest
      : T extends 'grpc'
        ? GrpcRequest
        : T extends 'sse'
          ? SseRequest
          : T extends 'mcp'
            ? McpRequest
            : never;
  });
}

export function useActiveResponse() {
  return useRequestStore((s) => {
    const tab = s.activeTabId ? s.tabs.find((t) => t.id === s.activeTabId) : null;
    return tab?.response ?? null;
  });
}
```

- [ ] **Step 2: Refactor `useHttpRequest`**

Read the current file in full first. Replace `const { currentRequest, currentResponse, ... } = useRequestStore()` with calls to the new selectors:

```ts
import { useActiveRequest, useActiveResponse } from '@/store/selectors';
// ...
const httpRequest = useActiveRequest('http');
const currentResponse = useActiveResponse();
const {
  updateRequest: storeUpdateRequest,
  setLoading,
  setCurrentResponse,
  isLoading,
  setScriptResult,
} = useRequestStore();
// Drop the `useMemo(() => currentRequest?.type === 'http' ...)` — useActiveRequest('http') already returns null when type doesn't match
```

Keep all the inner helpers (`addParam`, `updateBody`, etc.) that were guarded with `if (!httpRequest) return;` — same pattern, just a different source.

- [ ] **Step 3: Same for `useHttpRequestPage`**

- [ ] **Step 4: Run hook-related tests**

```bash
npm run test:run -- src/features/http 2>&1 | tail -10
```

All pass. If any test mocks `useRequestStore` directly, update the mock to set `tabs[0]` and `activeTabId`.

- [ ] **Step 5: Commit**

```bash
git add src/store/selectors.ts src/features/http/hooks/
git commit -m "refactor(http): route useHttpRequest hooks through tab selectors"
```

---

### Task 5: Update HTTP `RequestBuilder` component

**Files:**

- Modify: `src/features/http/components/RequestBuilder/index.tsx`

If `useHttpRequest` returns `request: null`, render the empty state (this might already exist for the "no request" pre-tab era). Otherwise render the builder against `request`. Should be a near-zero-line diff once the hook is updated — the component reads from the hook, not the store directly.

- [ ] **Step 1: Read the component, identify any direct store reads**

```bash
rg -n "useRequestStore|currentRequest" src/features/http/components/RequestBuilder/
```

For each direct store read, switch to `useActiveTab()`/`useActiveRequest('http')` from `@/store/selectors`.

- [ ] **Step 2: Smoke test in browser**

```bash
npm run dev
```

Open http://localhost:5173. Verify: HTTP builder loads, can edit URL, can send request, response renders. No console errors.

- [ ] **Step 3: Commit**

```bash
git add src/features/http/components/RequestBuilder/
git commit -m "refactor(http): RequestBuilder reads from active tab"
```

---

### Task 6: Update other protocol builders (gRPC, GraphQL, SSE, WebSocket, MCP)

**Files:**

- Modify: `src/features/grpc/components/GrpcRequestBuilder.tsx`
- Modify: `src/features/grpc/components/GrpcReflectionPanel.tsx`
- Modify: `src/features/graphql/components/GraphQLRequestBuilder.tsx`
- Modify: `src/features/sse/components/SseClient.tsx`
- Modify: `src/features/websocket/components/WebSocketClient.tsx`
- Modify: `src/features/mcp/components/McpRequestBuilder.tsx`
- Modify: `src/features/http/components/CodeGeneratorDialog.tsx`

Same pattern as Task 5 — replace direct `useRequestStore()` reads of `currentRequest`/`currentResponse` with `useActiveRequest('<type>')` / `useActiveResponse()` selectors.

WebSocket is special: it has its own connection store (`useWebSocketStore`). The "current request" of a WS tab is just a saved connection config; verify the existing pattern still works.

- [ ] **Step 1: Find every consumer**

```bash
rg -n "currentRequest|currentResponse" src/features/ --type-add 'tsx:*.tsx' -t tsx -t ts
```

- [ ] **Step 2: Replace each in turn — read each file, edit, run its tests**

For each file, replace the destructure-from-store pattern. Don't modify behaviour beyond the rename. The hooks layer (`useActiveRequest`) returns the same `Request | null` shape consumers expect.

- [ ] **Step 3: Run feature tests**

```bash
npm run test:run -- src/features/ 2>&1 | tail -10
```

All pass.

- [ ] **Step 4: Smoke test each protocol**

```bash
npm run dev
```

In the browser: open a gRPC request, GraphQL, SSE, WS, MCP. Verify each loads, can edit, can send/connect.

- [ ] **Step 5: Commit**

```bash
git add src/features/
git commit -m "refactor: migrate protocol builders to active-tab selectors"
```

---

### Task 7: Update Sidebar — opening a saved request opens a tab

**Files:**

- Modify: `src/features/collections/components/Sidebar.tsx`

Currently `Sidebar.tsx:61` calls `setCurrentRequest`. Replace with `openTab(request, { savedRequestId: request.id })`. Behaviour change: clicking a saved request opens it in a NEW tab instead of replacing the current request. If a tab is already open with that `savedRequestId`, focus it instead of opening a duplicate.

- [ ] **Step 1: Read the Sidebar `setCurrentRequest` call site**

```bash
rg -n "setCurrentRequest" src/features/collections/components/Sidebar.tsx
```

- [ ] **Step 2: Replace with focus-or-open logic**

```tsx
const { openTab, switchTab, tabs } = useRequestStore();

const handleOpenSaved = (request: Request) => {
  const existing = tabs.find((t) => t.savedRequestId === request.id);
  if (existing) {
    switchTab(existing.id);
    return;
  }
  openTab(request, { savedRequestId: request.id });
};
```

- [ ] **Step 3: Smoke test**

In browser: save a request, then click it from the sidebar. Verify a tab opens. Click it again — verify focus instead of duplicate.

- [ ] **Step 4: Commit**

```bash
git add src/features/collections/components/Sidebar.tsx
git commit -m "refactor(collections): Sidebar opens saved requests in tabs (focus existing)"
```

---

### Task 8: Update `routes/index.tsx` — derive `requestMode` from active tab

**Files:**

- Modify: `src/routes/index.tsx`
- Modify: `src/components/shared/Header.tsx`
- Modify: `src/components/shared/TopBar.tsx`
- Modify: `src/components/shared/CommandPalette.tsx`

The page-level `requestMode` state (`useState<RequestMode>('http')`) is now redundant — it's derived from `getActiveTab()?.request.type`. The Header/TopBar protocol-switcher buttons should call `createNewRequest('grpc')` (which opens a new tab) instead of `switchToGrpc()` (which would switch the current request to gRPC, a now-meaningless concept).

- [ ] **Step 1: Replace `requestMode` state with derived value**

In `src/routes/index.tsx`:

```tsx
const activeTab = useRequestStore((s) =>
  s.activeTabId ? (s.tabs.find((t) => t.id === s.activeTabId) ?? null) : null
);
const requestMode: RequestMode = useMemo(() => {
  if (!activeTab) return 'http';
  // RequestType is 'http' | 'grpc' | 'sse' | 'mcp'.
  // RequestMode adds 'graphql' (still 'http' under the hood) and 'websocket'.
  // We keep the active tab's literal type — graphql/ws are surfaced via tab metadata if added later.
  return activeTab.request.type;
}, [activeTab]);
```

Remove the local `useState<RequestMode>` and the `setRequestMode` callbacks.

- [ ] **Step 2: Update Header.tsx and TopBar.tsx**

```bash
rg -n "switchToHttp|switchToGrpc|switchToSse|switchToMcp" src/components/shared/
```

Replace each call site with `createNewRequest('http' | 'grpc' | 'sse' | 'mcp')`. The behaviour is now "always open a new tab for the chosen protocol" — which is what users actually want.

- [ ] **Step 3: Update CommandPalette**

```bash
rg -n "createNewHttpRequest|createNewGrpcRequest|createNewSseRequest|createNewMcpRequest" src/components/shared/CommandPalette.tsx
```

Each `createNewXxxRequest` call becomes `createNewRequest('xxx')`. The `currentResponse` reference also needs an update — replace with `useActiveResponse()`.

- [ ] **Step 4: Smoke test**

In browser: use the TopBar protocol buttons to open HTTP, gRPC, SSE, MCP requests. Verify each opens a separate tab. Use Cmd-K to invoke command palette → verify "New HTTP Request" works.

- [ ] **Step 5: Commit**

```bash
git add src/routes/index.tsx src/components/shared/
git commit -m "refactor(ui): derive requestMode from active tab; protocol buttons open new tabs"
```

---

### Task 9: Build the `TabBar` component

**Files:**

- Create: `src/components/shared/TabBar.tsx`
- Create: `src/components/shared/TabBar.test.tsx`

A horizontal scroll-area containing tab pills. Each tab shows: small protocol-type icon, request name (editable on double-click), close (X) button on hover, and a dirty indicator (•) when `isDirty`. Right-click context menu: Close, Close Others, Close All, Duplicate.

Place the TabBar inside `routes/index.tsx`, above the active builder, below the TopBar.

- [ ] **Step 1: Write the test (component test using React Testing Library)**

Create `src/components/shared/TabBar.test.tsx`:

```tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TabBar } from './TabBar';
import { useRequestStore } from '@/store/useRequestStore';

describe('TabBar', () => {
  beforeEach(() => {
    useRequestStore.setState({ tabs: [], activeTabId: null, isLoading: false });
  });

  it('renders nothing when no tabs are open (render only the new-tab button)', () => {
    render(<TabBar />);
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(screen.getByRole('button', { name: /new request/i })).toBeInTheDocument();
  });

  it('renders one button per open tab with request name', () => {
    useRequestStore.getState().openTab({
      id: 'r1',
      name: 'Get user',
      type: 'http',
      method: 'GET',
      url: '',
      headers: [],
      params: [],
      body: { type: 'none' },
      auth: { type: 'none' },
    });
    render(<TabBar />);
    expect(screen.getByRole('tab', { name: /Get user/ })).toBeInTheDocument();
  });

  it('clicking a tab switches active', () => {
    const a = useRequestStore.getState().openTab({
      id: 'r1',
      name: 'A',
      type: 'http',
      method: 'GET',
      url: '',
      headers: [],
      params: [],
      body: { type: 'none' },
      auth: { type: 'none' },
    });
    const b = useRequestStore.getState().openTab({
      id: 'r2',
      name: 'B',
      type: 'http',
      method: 'GET',
      url: '',
      headers: [],
      params: [],
      body: { type: 'none' },
      auth: { type: 'none' },
    });
    void a;
    render(<TabBar />);
    fireEvent.click(screen.getByRole('tab', { name: /A/ }));
    expect(useRequestStore.getState().activeTabId).not.toBe(b);
  });

  it('clicking the close button on a tab closes it', () => {
    const a = useRequestStore.getState().openTab({
      id: 'r1',
      name: 'A',
      type: 'http',
      method: 'GET',
      url: '',
      headers: [],
      params: [],
      body: { type: 'none' },
      auth: { type: 'none' },
    });
    void a;
    render(<TabBar />);
    fireEvent.click(screen.getByRole('button', { name: /close A/i }));
    expect(useRequestStore.getState().tabs).toHaveLength(0);
  });

  it('shows a dirty indicator when isDirty', () => {
    useRequestStore.getState().openTab({
      id: 'r1',
      name: 'A',
      type: 'http',
      method: 'GET',
      url: '',
      headers: [],
      params: [],
      body: { type: 'none' },
      auth: { type: 'none' },
    });
    useRequestStore.getState().setDirty(true);
    render(<TabBar />);
    expect(screen.getByLabelText(/unsaved changes/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to fail**

```bash
npm run test:run -- src/components/shared/TabBar 2>&1 | tail -10
```

- [ ] **Step 3: Implement `TabBar.tsx`**

```tsx
import { useRequestStore } from '@/store/useRequestStore';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { Plus, X } from 'lucide-react';
import type { RequestType } from '@/types';

const PROTOCOL_LABEL: Record<RequestType, string> = {
  http: 'HTTP',
  grpc: 'gRPC',
  sse: 'SSE',
  mcp: 'MCP',
};

export function TabBar() {
  const tabs = useRequestStore((s) => s.tabs);
  const activeTabId = useRequestStore((s) => s.activeTabId);
  const switchTab = useRequestStore((s) => s.switchTab);
  const closeTab = useRequestStore((s) => s.closeTab);
  const closeOtherTabs = useRequestStore((s) => s.closeOtherTabs);
  const closeAllTabs = useRequestStore((s) => s.closeAllTabs);
  const duplicateTab = useRequestStore((s) => s.duplicateTab);
  const createNewRequest = useRequestStore((s) => s.createNewRequest);

  return (
    <div className="flex items-center gap-1 border-b bg-background px-2 py-1">
      <ScrollArea className="flex-1">
        <div className="flex items-center gap-1" role="tablist">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            return (
              <ContextMenu key={tab.id}>
                <ContextMenuTrigger asChild>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    aria-label={tab.request.name}
                    onClick={() => switchTab(tab.id)}
                    className={[
                      'group flex items-center gap-2 rounded-md px-3 py-1 text-sm',
                      isActive ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
                    ].join(' ')}
                  >
                    <span className="text-xs font-mono opacity-60">
                      {PROTOCOL_LABEL[tab.request.type]}
                    </span>
                    <span className="truncate max-w-[16ch]">{tab.request.name}</span>
                    {tab.isDirty && (
                      <span
                        aria-label="unsaved changes"
                        className="size-1.5 rounded-full bg-foreground/60"
                      />
                    )}
                    <button
                      type="button"
                      aria-label={`close ${tab.request.name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        closeTab(tab.id);
                      }}
                      className="opacity-0 group-hover:opacity-100 hover:bg-accent rounded p-0.5"
                    >
                      <X className="size-3" />
                    </button>
                  </button>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem onClick={() => duplicateTab(tab.id)}>Duplicate</ContextMenuItem>
                  <ContextMenuItem onClick={() => closeTab(tab.id)}>Close</ContextMenuItem>
                  <ContextMenuItem onClick={() => closeOtherTabs(tab.id)}>
                    Close Others
                  </ContextMenuItem>
                  <ContextMenuItem onClick={closeAllTabs}>Close All</ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
        </div>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="ghost" aria-label="new request" className="shrink-0">
            <Plus className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => createNewRequest('http')}>HTTP request</DropdownMenuItem>
          <DropdownMenuItem onClick={() => createNewRequest('grpc')}>gRPC request</DropdownMenuItem>
          <DropdownMenuItem onClick={() => createNewRequest('sse')}>SSE request</DropdownMenuItem>
          <DropdownMenuItem onClick={() => createNewRequest('mcp')}>MCP request</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to pass**

```bash
npm run test:run -- src/components/shared/TabBar 2>&1 | tail -10
```

- [ ] **Step 5: Place TabBar in `routes/index.tsx`**

Find where the builder gets rendered. Add `<TabBar />` immediately above. Smoke test: see tabs appear when you open multiple requests.

- [ ] **Step 6: Commit**

```bash
git add src/components/shared/TabBar.tsx src/components/shared/TabBar.test.tsx src/routes/index.tsx
git commit -m "feat(ui): add TabBar component with open/close/switch/duplicate"
```

---

### Task 10: Drag-reorder tabs (optional polish — can skip for MVP)

**Files:**

- Modify: `src/components/shared/TabBar.tsx`

Use HTML5 drag-and-drop natively (no extra dep). On `dragstart`, save the dragged tab id. On `dragover`, prevent default to allow drop. On `drop`, compute the new ordering and call `reorderTabs`.

- [ ] **Step 1: Add drag handlers to the tab button**

```tsx
const [draggingId, setDraggingId] = useState<string | null>(null);

// On the tab button:
draggable
onDragStart={() => setDraggingId(tab.id)}
onDragOver={(e) => e.preventDefault()}
onDrop={() => {
  if (!draggingId || draggingId === tab.id) return;
  const ids = tabs.map((t) => t.id);
  const fromIdx = ids.indexOf(draggingId);
  const toIdx = ids.indexOf(tab.id);
  if (fromIdx === -1 || toIdx === -1) return;
  ids.splice(fromIdx, 1);
  ids.splice(toIdx, 0, draggingId);
  reorderTabs(ids);
  setDraggingId(null);
}}
onDragEnd={() => setDraggingId(null)}
```

- [ ] **Step 2: Smoke test in browser**

Open 3 tabs, drag one to reorder. Verify the order persists after reload (the store is persisted).

- [ ] **Step 3: Commit**

```bash
git add src/components/shared/TabBar.tsx
git commit -m "feat(ui): drag-reorder tabs via native HTML5 DnD"
```

---

### Task 11: Per-tab Monaco editor model preservation

**Files:**

- Modify: `src/components/shared/CodeEditor.tsx`

Monaco's `editor.getModel()` is owned by the editor instance, not by React state. When the user types in tab A, switches to tab B, types there, and switches back to tab A — they expect to see what they typed in A. Currently, the body editor uses a single Monaco instance bound to `request.body.raw` via React state — that round-trip works for _value_ but loses _cursor position_, _undo stack_, and _fold state_.

The fix: hold a `Map<tabId, monaco.editor.ITextModel>` keyed by tab id. On tab switch, swap the editor's model. When a tab closes, dispose its model.

- [ ] **Step 1: Read CodeEditor.tsx**

```bash
cat src/components/shared/CodeEditor.tsx
```

Identify how it's currently configured. The hook `@monaco-editor/react`'s `<Editor>` accepts `path` — Monaco creates a separate model per `path`, with full state preservation per path automatically.

- [ ] **Step 2: Add `path` derived from active tab**

In any component that renders a `<Editor>` for the request body or response body, pass:

```tsx
<Editor
  path={`tab-${activeTabId}-body`}
  // ...existing props
/>
```

Monaco then handles the model bookkeeping. No need to manually manage `Map<tabId, ITextModel>`.

- [ ] **Step 3: Smoke test**

Open 2 HTTP tabs. In tab A, type `{"a":1}` in the body, scroll mid-document, place cursor mid-line. Switch to tab B, type something else. Switch back to tab A — cursor and scroll should be where you left them, undo should still go back through your tab-A history.

- [ ] **Step 4: Commit**

```bash
git add src/components/shared/CodeEditor.tsx src/features/
git commit -m "feat(ui): per-tab Monaco editor models via path prop"
```

---

### Task 12: Variable substitution helpers — Postman-name parity

**Files:**

- Create: `src/lib/shared/dynamicVariables.ts`
- Create: `src/lib/shared/dynamicVariables.test.ts`
- Modify: `src/store/useEnvironmentStore.ts`

Extract dynamic-variable expansion (`$timestamp`, `$guid`, etc.) from the inline `resolveVariables` body into a pure helper. Add Postman-name aliases.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/shared/dynamicVariables.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { applyDynamicVariables } from './dynamicVariables';

describe('applyDynamicVariables', () => {
  it('expands $timestamp', () => {
    const out = applyDynamicVariables('ts={{$timestamp}}');
    expect(out).toMatch(/^ts=\d{10,}$/);
  });

  it('expands $isoTimestamp', () => {
    const out = applyDynamicVariables('t={{$isoTimestamp}}');
    expect(out).toMatch(/^t=\d{4}-\d{2}-\d{2}T/);
  });

  it('expands $randomInt within default range', () => {
    const out = applyDynamicVariables('n={{$randomInt}}');
    const match = out.match(/^n=(\d+)$/);
    expect(match).not.toBeNull();
    const n = Number(match![1]);
    expect(n).toBeGreaterThanOrEqual(0);
    expect(n).toBeLessThan(1000);
  });

  it('expands $guid as a UUID v4', () => {
    const out = applyDynamicVariables('id={{$guid}}');
    expect(out).toMatch(/^id=[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('expands $randomUUID as a UUID v4 (Postman alias of $guid)', () => {
    const out = applyDynamicVariables('id={{$randomUUID}}');
    expect(out).toMatch(/^id=[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('expands $randomEmail to a syntactically valid email', () => {
    const out = applyDynamicVariables('email={{$randomEmail}}');
    expect(out).toMatch(/^email=[a-z0-9.]+@[a-z]+\.(com|io|net|dev)$/);
  });

  it('expands $randomAlphaNumeric', () => {
    const out = applyDynamicVariables('s={{$randomAlphaNumeric}}');
    expect(out).toMatch(/^s=[a-z0-9]+$/);
  });

  it('leaves unknown $-prefixed variables untouched', () => {
    const out = applyDynamicVariables('x={{$unknownThing}}');
    expect(out).toBe('x={{$unknownThing}}');
  });

  it('handles whitespace around the variable name', () => {
    const out = applyDynamicVariables('a={{ $timestamp }}');
    expect(out).toMatch(/^a=\d{10,}$/);
  });

  it('expands multiple instances in one string', () => {
    const out = applyDynamicVariables('{{$randomUUID}}-{{$randomUUID}}');
    const parts = out.split('-');
    // 5 segments per UUID × 2 UUIDs = 10 segments separated by '-'
    expect(parts).toHaveLength(10);
  });
});
```

- [ ] **Step 2: Implement `dynamicVariables.ts`**

```ts
import { v4 as uuidv4 } from 'uuid';

const FIRST_NAMES = ['alice', 'bob', 'carol', 'dave', 'eve', 'frank', 'grace', 'henry'];
const DOMAINS = ['example.com', 'test.io', 'sample.net', 'demo.dev'];

type Generator = () => string;

const HELPERS: Record<string, Generator> = {
  timestamp: () => String(Date.now()),
  isoTimestamp: () => new Date().toISOString(),
  randomInt: () => String(Math.floor(Math.random() * 1000)),
  guid: () => uuidv4(),
  randomUUID: () => uuidv4(),
  randomAlphaNumeric: () => Math.random().toString(36).slice(2, 10),
  randomEmail: () => {
    const name = FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)] ?? 'user';
    const domain = DOMAINS[Math.floor(Math.random() * DOMAINS.length)] ?? 'example.com';
    const suffix = Math.floor(Math.random() * 1000);
    return `${name}.${suffix}@${domain}`;
  },
};

const PATTERN = /\{\{\s*\$([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;

export function applyDynamicVariables(text: string): string {
  return text.replace(PATTERN, (match, name: string) => {
    const generator = HELPERS[name];
    return generator ? generator() : match;
  });
}
```

- [ ] **Step 3: Run to pass**

```bash
npm run test:run -- src/lib/shared/dynamicVariables 2>&1 | tail -10
```

- [ ] **Step 4: Wire it into `useEnvironmentStore`**

Replace the inline regex block (lines 105-114) with a single call:

```ts
import { applyDynamicVariables } from '@/lib/shared/dynamicVariables';
// ...
resolveVariables: (text: string) => {
  const activeEnv = get().getActiveEnvironment();
  let resolved = text;
  if (activeEnv) {
    activeEnv.variables.forEach((variable) => {
      if (variable.enabled) {
        const regex = new RegExp(`{{\\s*${variable.key}\\s*}}`, 'g');
        resolved = resolved.replace(regex, variable.value);
      }
    });
  }
  return applyDynamicVariables(resolved);
},
```

- [ ] **Step 5: Verify environment store tests**

```bash
npm run test:run -- src/store/__tests__/useEnvironmentStore 2>&1 | tail -10
```

Pre-existing tests for `$timestamp`/`$guid`/etc. should still pass because the helper preserves backward compatibility.

- [ ] **Step 6: Commit**

```bash
git add src/lib/shared/dynamicVariables.ts src/lib/shared/dynamicVariables.test.ts src/store/useEnvironmentStore.ts
git commit -m "feat(env): add Postman-name dynamic-variable helpers ({{\$randomUUID}}, {{\$randomEmail}})"
```

---

### Task 13: Delete legacy `src/lib/shared/storage.ts`

**Files:**

- Delete: `src/lib/shared/storage.ts`
- Modify: `src/lib/shared/index.ts`

Confirm no consumers remain after the store reshape (every store now uses Dexie).

- [ ] **Step 1: Find remaining importers**

```bash
cd /Users/dipjyotimetia/Documents/working/ccviews/restura
rg -n "from.*'@/lib/shared/storage'|from.*'@/lib/shared'" src/ -g '*.ts' -g '*.tsx' | grep -v dexie-storage
rg -n "createZustandStorage|webStorageAdapter|electronStorageAdapter|getStorageAdapter" src/ -g '*.ts' -g '*.tsx'
```

If anything still imports from `@/lib/shared/storage`, switch them to `@/lib/shared/dexie-storage` (use `dexieStorageAdapters.<table>()`).

- [ ] **Step 2: Update barrel export `src/lib/shared/index.ts`**

Remove the line that re-exports from `./storage`. Verify no other re-export depends on it.

- [ ] **Step 3: Delete the file**

```bash
git rm src/lib/shared/storage.ts
```

- [ ] **Step 4: Type-check + validate**

```bash
npx tsc --noEmit 2>&1 | tail -3
npm run validate 2>&1 | tail -10
```

All green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/shared/index.ts
git commit -m "chore(storage): delete legacy localStorage adapter; all stores on Dexie"
```

---

### Task 14: Documentation + ADR

**Files:**

- Modify: `docs/ARCHITECTURE.md`
- Create: `docs/adr/0002-multi-tab-store.md`

- [ ] **Step 1: Add a section to ARCHITECTURE.md**

After the existing "State management" section, add:

```markdown
### Multi-tab request model

The renderer holds open requests as tabs in `useRequestStore`:

- `tabs: RequestTab[]` — each tab has `{ id, request, response?, scriptResult?, isDirty, savedRequestId? }`
- `activeTabId: string | null` — currently focused tab

The page-level `requestMode` is derived from the active tab's `request.type` — there is no separate "current protocol" state. Tabs persist to Dexie (`requestTabs` table) so refresh/restart preserves the open set, including the last response per tab.

Saved requests opened from the sidebar focus an existing matching tab (by `savedRequestId`) before opening a new one. The TabBar component (`src/components/shared/TabBar.tsx`) renders the tab strip; tab actions go through `useRequestStore` (`openTab`, `closeTab`, `switchTab`, `duplicateTab`, `reorderTabs`, `closeOtherTabs`, `closeAllTabs`).

Editor state (cursor, undo, fold) is preserved per tab via Monaco's `path` prop — each tab's body editor uses `path={"tab-<id>-body"}`, so Monaco automatically maintains a separate `ITextModel` per path.
```

Also update the "Storage" section to note that `src/lib/shared/storage.ts` no longer exists; everything goes through `dexie-storage.ts` (web) or `createElectronStorage` (Electron).

- [ ] **Step 2: Create ADR**

```markdown
# ADR 0002: Multi-Tab Request Store

**Status:** Accepted, 2026-05-08

## Context

The pre-Plan-2 `useRequestStore` had four mutually-exclusive slots: `httpRequest`, `grpcRequest`, `sseRequest`, `mcpRequest`, plus a `currentRequest` pointer at one of them. This made it impossible to hold two requests of the same protocol open at once — switching protocols swapped the slot, and saving a request to the sidebar then opening another replaced the first.

Postman, Hoppscotch, Insomnia, and Bruno all support multi-tab. It is the #1 day-one ergonomic gap users hit. Adding it later requires reshaping every consumer of `currentRequest`, so this lands before public launch.

## Decision

Replace per-protocol slots with `tabs: RequestTab[]` + `activeTabId`. Existing action names (`updateRequest`, `setCurrentResponse`, `setScriptResult`, `setLoading`) are preserved but operate on the active tab. Tab lifecycle has its own action set (`openTab`/`closeTab`/`switchTab`/`duplicateTab`/`reorderTabs`).

Persist tabs (including their last response and dirty state) to a new Dexie table `requestTabs` so a refresh restores the entire workspace.

## Consequences

**Positive**

- Users can hold N requests open across any mix of protocols; opening a saved request from the sidebar focuses the existing tab if any.
- Editor state (cursor, undo, fold) preserves per tab via Monaco's `path` prop.
- Last response is preserved on restart — no more "where did my response go" after a refresh.
- Action surface compatible with most existing consumers — only the entry point changes (read from active tab via selectors).

**Negative**

- Larger persisted state (a full response per tab × N tabs). Bounded by the existing `MAX_RESPONSE_SIZE` cap, but power users with 20 tabs × 5 MB responses persist 100 MB to Dexie. Monitor and add per-tab response trimming if dogfooding shows this is a problem.
- Migration is one-way: opening a Plan-2 build downgrades persisted-state shape from v3 to a no-op for older builds. Acceptable for a single-developer pre-launch, would need a proper roll-out plan for multi-version production.

## Alternatives considered

- **Keep single-request, add a "recent requests" pin list:** Strictly worse than multi-tab — users want concurrent edit, not just history.
- **Tabs as separate stores:** Would scatter state and break the "switch tab → see editor state" expectation. Rejected.

## References

- Plan: `docs/superpowers/plans/2026-05-08-multi-tab-store.md`
- Roadmap: `docs/superpowers/plans/2026-05-08-roadmap.md`
- Architecture: `docs/ARCHITECTURE.md` § Multi-tab request model
```

- [ ] **Step 3: Commit**

```bash
git add docs/ARCHITECTURE.md docs/adr/0002-multi-tab-store.md
git commit -m "docs(multi-tab): document tab model + ADR-0002"
```

---

## Self-review checklist

After all tasks land, run:

```bash
cd /Users/dipjyotimetia/Documents/working/ccviews/restura
npm run validate
```

And manually verify:

- [ ] `rg -n "switchToHttp|switchToGrpc|switchToSse|switchToMcp" src/` returns no matches (deleted in Task 8)
- [ ] `rg -n "currentRequest|currentResponse" src/` only matches in legacy migration code or comments — not in active code paths
- [ ] `rg -n "from.*'@/lib/shared/storage'" src/` returns no matches
- [ ] `rg -n "createZustandStorage|getStorageAdapter" src/` returns no matches
- [ ] `ls src/lib/shared/storage.ts` returns ENOENT
- [ ] Open 5 tabs across HTTP/gRPC/SSE/MCP, refresh — all 5 reopen with their bodies and last responses intact
- [ ] Open a saved request from the sidebar twice — second click focuses the existing tab, doesn't duplicate
- [ ] Drag a tab to reorder — order persists across reload
- [ ] Type something in tab A's body, switch to tab B, switch back — cursor position and undo stack survive
- [ ] `{{$randomUUID}}` and `{{$randomEmail}}` resolve correctly in URL/header substitution
- [ ] All previous tests still pass; new tests added per task

---

## Out of scope (handled in later plans)

- **Auth-at-the-wire (move SigV4 signing close to the transport):** Plan 3.
- **Real keychain encryption (`safeStorage`):** Plan 3.
- **Streaming responses end-to-end:** Plan 4.
- **CLI runner consuming the same shared core:** Plan 5.
- **Web interceptor parity / plugin model:** Plan 6.

This plan does not change the shared protocol layer (Plan 1 deliverables). All store reshape is in `src/store/` and `src/features/`.
