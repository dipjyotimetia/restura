import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response as ApiResponse, GrpcRequest, HttpRequest } from '@/types';
import { useRequestStore } from '../useRequestStore';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

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
      useRequestStore.getState().openTab(makeGrpc(), { switchTo: false });
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
      expect((tab.request as HttpRequest).url).toBe('https://b.com');
      expect(tab.isDirty).toBe(true);
    });

    it('does not mutate other tabs', () => {
      const a = useRequestStore.getState().openTab(makeHttp({ url: 'https://a.com' }));
      useRequestStore.getState().openTab(makeHttp({ url: 'https://b.com' }));
      // The newly opened tab is now active; mutate it
      useRequestStore.getState().updateRequest({ url: 'https://b-edited.com' });
      const tabA = useRequestStore.getState().tabs.find((t) => t.id === a)!;
      expect((tabA.request as HttpRequest).url).toBe('https://a.com');
    });

    it('is a no-op when no active tab', () => {
      useRequestStore.getState().updateRequest({ url: 'https://x.com' } as Partial<HttpRequest>);
      expect(useRequestStore.getState().tabs).toHaveLength(0);
    });

    it('rejects invalid updates and does not mutate the active tab', () => {
      // Toast is mocked via the test setup; we verify the store doesn't mutate.
      useRequestStore.getState().openTab(makeHttp({ url: 'https://a.com', method: 'GET' }));
      // The validator should reject a method value that isn't a valid HTTP method
      useRequestStore.getState().updateRequest({ method: 'NOTAVERB' as unknown as 'GET' });
      const tab = useRequestStore.getState().getActiveTab()!;
      expect((tab.request as HttpRequest).url).toBe('https://a.com');
      expect((tab.request as HttpRequest).method).toBe('GET'); // unchanged
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
      expect(tabB.response).toEqual(responseB);
    });

    it('clears the active tab response when set to null', () => {
      useRequestStore.getState().openTab(makeHttp());
      useRequestStore.getState().setCurrentResponse(makeResponse('x'));
      useRequestStore.getState().setCurrentResponse(null);
      expect(useRequestStore.getState().getActiveTab()!.response).toBeNull();
    });

    it('sets scriptResult on the active tab only', () => {
      const a = useRequestStore.getState().openTab(makeHttp());
      useRequestStore.getState().openTab(makeGrpc());
      useRequestStore.getState().setScriptResult({
        preRequest: { success: true, logs: [], errors: [], variables: {} },
      });
      const tabA = useRequestStore.getState().tabs.find((t) => t.id === a)!;
      expect(tabA.scriptResult).toBeUndefined();
      expect(useRequestStore.getState().getActiveTab()!.scriptResult).toBeDefined();
    });
  });

  describe('duplicateTab', () => {
    it('creates a new tab with the same request data but a fresh request id', () => {
      const a = useRequestStore.getState().openTab(makeHttp({ id: 'orig', url: 'https://a.com' }));
      const dup = useRequestStore.getState().duplicateTab(a)!;
      expect(dup).not.toBe(a);
      const dupTab = useRequestStore.getState().tabs.find((t) => t.id === dup)!;
      expect((dupTab.request as HttpRequest).url).toBe('https://a.com');
      expect(dupTab.request.id).not.toBe('orig');
    });

    it('returns null when source tab does not exist', () => {
      expect(useRequestStore.getState().duplicateTab('nonexistent')).toBeNull();
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

    it('rejects orderedIds containing unknown ids', () => {
      const a = useRequestStore.getState().openTab(makeHttp());
      const b = useRequestStore.getState().openTab(makeGrpc());
      const before = useRequestStore.getState().tabs.map((t) => t.id);
      useRequestStore.getState().reorderTabs([a, 'unknown']);
      void b;
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

    it('closeOtherTabs is a no-op for unknown id', () => {
      useRequestStore.getState().openTab(makeHttp());
      useRequestStore.getState().openTab(makeGrpc());
      useRequestStore.getState().closeOtherTabs('unknown');
      expect(useRequestStore.getState().tabs).toHaveLength(2);
    });

    it('closeAllTabs clears everything', () => {
      useRequestStore.getState().openTab(makeHttp());
      useRequestStore.getState().openTab(makeGrpc());
      useRequestStore.getState().closeAllTabs();
      expect(useRequestStore.getState().tabs).toHaveLength(0);
      expect(useRequestStore.getState().activeTabId).toBeNull();
    });
  });

  describe('createNewRequest', () => {
    it('opens a new HTTP tab with default values', () => {
      const id = useRequestStore.getState().createNewRequest('http');
      const tab = useRequestStore.getState().tabs.find((t) => t.id === id)!;
      expect(tab.request.type).toBe('http');
      expect(tab.request.name).toBe('New Request');
    });

    it('opens a new gRPC tab', () => {
      const id = useRequestStore.getState().createNewRequest('grpc');
      const tab = useRequestStore.getState().tabs.find((t) => t.id === id)!;
      expect(tab.request.type).toBe('grpc');
    });

    it('opens a new SSE tab', () => {
      const id = useRequestStore.getState().createNewRequest('sse');
      const tab = useRequestStore.getState().tabs.find((t) => t.id === id)!;
      expect(tab.request.type).toBe('sse');
    });

    it('opens a new MCP tab', () => {
      const id = useRequestStore.getState().createNewRequest('mcp');
      const tab = useRequestStore.getState().tabs.find((t) => t.id === id)!;
      expect(tab.request.type).toBe('mcp');
    });
  });

  describe('isLoading', () => {
    it('toggles the global loading flag', () => {
      useRequestStore.getState().setLoading(true);
      expect(useRequestStore.getState().isLoading).toBe(true);
      useRequestStore.getState().setLoading(false);
      expect(useRequestStore.getState().isLoading).toBe(false);
    });
  });

  describe('setDirty', () => {
    it('marks the active tab dirty', () => {
      useRequestStore.getState().openTab(makeHttp());
      useRequestStore.getState().setDirty(true);
      expect(useRequestStore.getState().getActiveTab()!.isDirty).toBe(true);
    });

    it('clears the active tab dirty flag', () => {
      useRequestStore.getState().openTab(makeHttp());
      useRequestStore.getState().updateRequest({ url: 'https://x' });
      expect(useRequestStore.getState().getActiveTab()!.isDirty).toBe(true);
      useRequestStore.getState().setDirty(false);
      expect(useRequestStore.getState().getActiveTab()!.isDirty).toBe(false);
    });
  });

  describe('setStreamingEvents / clearStreamingEvents', () => {
    async function* emptyEvents(): AsyncIterable<{ type: 'sse'; payload: { data: string } }> {
      yield { type: 'sse', payload: { data: 'a' } };
    }

    it('attaches the iterable to the active tab and clears the buffered response', () => {
      useRequestStore.getState().openTab(makeHttp());
      useRequestStore.getState().setCurrentResponse(makeResponse('whatever'));
      const events = emptyEvents();
      useRequestStore.getState().setStreamingEvents(events);
      const tab = useRequestStore.getState().getActiveTab()!;
      expect(tab.streamingEvents).toBe(events);
      // Buffered response is cleared so ResponseViewer dispatches unambiguously
      expect(tab.response).toBeNull();
    });

    it('only sets streamingEvents on the active tab', () => {
      const a = useRequestStore.getState().openTab(makeHttp());
      const b = useRequestStore.getState().openTab(makeGrpc());
      const events = emptyEvents();
      useRequestStore.getState().setStreamingEvents(events);
      const tabA = useRequestStore.getState().tabs.find((t) => t.id === a)!;
      const tabB = useRequestStore.getState().tabs.find((t) => t.id === b)!;
      expect(tabA.streamingEvents).toBeUndefined();
      expect(tabB.streamingEvents).toBe(events);
    });

    it('clearStreamingEvents removes the field from the active tab', () => {
      useRequestStore.getState().openTab(makeHttp());
      useRequestStore.getState().setStreamingEvents(emptyEvents());
      expect(useRequestStore.getState().getActiveTab()!.streamingEvents).toBeDefined();
      useRequestStore.getState().clearStreamingEvents();
      expect(useRequestStore.getState().getActiveTab()!.streamingEvents).toBeUndefined();
    });

    it('clearStreamingEvents is a no-op when no streaming is in flight', () => {
      useRequestStore.getState().openTab(makeHttp());
      const before = useRequestStore.getState().getActiveTab()!;
      useRequestStore.getState().clearStreamingEvents();
      const after = useRequestStore.getState().getActiveTab()!;
      // No structural change — the same tab object reference is preserved
      expect(after).toBe(before);
    });

    it('replacing streamingEvents on a subsequent call drops the prior iterable', () => {
      useRequestStore.getState().openTab(makeHttp());
      const first = emptyEvents();
      useRequestStore.getState().setStreamingEvents(first);
      const second = emptyEvents();
      useRequestStore.getState().setStreamingEvents(second);
      expect(useRequestStore.getState().getActiveTab()!.streamingEvents).toBe(second);
      expect(useRequestStore.getState().getActiveTab()!.streamingEvents).not.toBe(first);
    });

    it('streamingEvents is JSON-serializable safe via partialize-style stripping', () => {
      // Simulates the persist middleware's partialize stripping streamingEvents.
      // We verify that after stripping, the tabs array can be JSON-serialized
      // without losing any other state.
      useRequestStore.getState().openTab(makeHttp({ url: 'https://example.com' }));
      useRequestStore.getState().setStreamingEvents(emptyEvents());
      const stripped = useRequestStore
        .getState()
        .tabs.map(({ streamingEvents: _drop, ...rest }) => rest);
      const json = JSON.stringify(stripped);
      const parsed = JSON.parse(json) as Array<{ streamingEvents?: unknown; request: HttpRequest }>;
      expect(parsed[0]!.streamingEvents).toBeUndefined();
      expect(parsed[0]!.request.url).toBe('https://example.com');
    });
  });

  describe('persist.partialize', () => {
    it('strips tab.response from persisted state (kept in memory only)', () => {
      // Response bodies can be tens of MB; they already live in useHistoryStore.
      // Persisting them per tab makes every tab switch + write a hot-path cost.
      const opts = useRequestStore.persist.getOptions();
      const partialize = opts.partialize as (s: unknown) => unknown;
      const sample = {
        activeTabId: 't1',
        tabs: [
          {
            id: 't1',
            request: makeHttp({ id: 'r1', url: 'https://x' }),
            response: {
              id: 'res-1',
              requestId: 'r1',
              status: 200,
              statusText: 'OK',
              body: 'x'.repeat(5_000_000),
              size: 5_000_000,
              headers: {},
              time: 0,
              timestamp: Date.now(),
            },
            streamingEvents: undefined,
          },
        ],
      };
      const persisted = partialize(sample) as { tabs: Array<{ response: unknown }> };
      // Either response is omitted entirely OR set to null.
      expect(persisted.tabs[0]!.response == null).toBe(true);
    });

    it('preserves request and other tab fields in persisted state', () => {
      const opts = useRequestStore.persist.getOptions();
      const partialize = opts.partialize as (s: unknown) => unknown;
      const sample = {
        activeTabId: 't1',
        tabs: [
          {
            id: 't1',
            savedRequestId: 'saved-1',
            isDirty: true,
            request: makeHttp({ id: 'r1', url: 'https://example.com' }),
            response: { id: 'res', body: 'big' },
            streamingEvents: undefined,
          },
        ],
      };
      const persisted = partialize(sample) as {
        activeTabId: string;
        tabs: Array<{
          id: string;
          savedRequestId?: string;
          isDirty?: boolean;
          request: HttpRequest;
        }>;
      };
      expect(persisted.activeTabId).toBe('t1');
      expect(persisted.tabs[0]!.id).toBe('t1');
      expect(persisted.tabs[0]!.savedRequestId).toBe('saved-1');
      expect(persisted.tabs[0]!.isDirty).toBe(true);
      expect(persisted.tabs[0]!.request.url).toBe('https://example.com');
    });
  });

  describe('openTabWithMode (pseudo-mode tabs)', () => {
    it('creates an HTTP placeholder tab tagged with the chosen mode', () => {
      const id = useRequestStore.getState().openTabWithMode('websocket');
      const state = useRequestStore.getState();
      const tab = state.tabs.find((t) => t.id === id);
      expect(tab).toBeDefined();
      expect(tab!.modeOverride).toBe('websocket');
      expect(tab!.request.type).toBe('http');
      expect(state.activeTabId).toBe(id);
    });

    it('produces independent tabs for repeated invocations', () => {
      const a = useRequestStore.getState().openTabWithMode('socketio');
      const b = useRequestStore.getState().openTabWithMode('socketio');
      expect(a).not.toBe(b);
      expect(useRequestStore.getState().tabs).toHaveLength(2);
    });

    it('supports each pseudo-mode', () => {
      const modes = ['websocket', 'socketio', 'kafka', 'graphql'] as const;
      const ids = modes.map((m) => useRequestStore.getState().openTabWithMode(m));
      const tabs = useRequestStore.getState().tabs;
      for (let i = 0; i < modes.length; i++) {
        const tab = tabs.find((t) => t.id === ids[i]);
        expect(tab?.modeOverride).toBe(modes[i]);
      }
    });

    it('duplicateTab preserves modeOverride', () => {
      const id = useRequestStore.getState().openTabWithMode('kafka');
      const dupId = useRequestStore.getState().duplicateTab(id);
      expect(dupId).not.toBe(id);
      const dup = useRequestStore.getState().tabs.find((t) => t.id === dupId);
      expect(dup?.modeOverride).toBe('kafka');
    });

    it('closeTab on a pseudo-mode tab leaves the store consistent', () => {
      const a = useRequestStore.getState().openTabWithMode('websocket');
      const b = useRequestStore.getState().openTabWithMode('graphql');
      useRequestStore.getState().closeTab(a);
      const state = useRequestStore.getState();
      expect(state.tabs.map((t) => t.id)).toEqual([b]);
      expect(state.activeTabId).toBe(b);
    });
  });
});
