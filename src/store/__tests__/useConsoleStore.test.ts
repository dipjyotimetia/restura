import { describe, it, expect, beforeEach } from 'vitest';
import {
  useConsoleStore,
  createConsoleEntry,
  createProtocolConsoleEntry,
  entryToCurl,
} from '../useConsoleStore';
import type { HttpRequest, Response as ApiResponse } from '@/types';

describe('useConsoleStore', () => {
  beforeEach(() => {
    // Reset store state before each test
    useConsoleStore.setState({
      entries: [],
      frames: [],
      selectedEntryId: null,
      isExpanded: true,
      panelHeight: 250,
      activeTab: 'network',
      searchFilter: '',
      statusFilter: 'all',
      protocolFilter: 'all',
      preserveOnSend: true,
      captureEnabled: true,
    });
  });

  describe('addEntry', () => {
    it('should add a new entry to the beginning of the list', () => {
      const { addEntry } = useConsoleStore.getState();

      const entry = {
        timestamp: Date.now(),
        request: {
          method: 'GET',
          url: 'https://api.example.com/users',
          headers: { 'Content-Type': 'application/json' },
        },
        response: {
          id: 'resp-1',
          requestId: 'req-1',
          status: 200,
          statusText: 'OK',
          headers: {},
          body: '{"data": []}',
          size: 100,
          time: 150,
          timestamp: Date.now(),
        },
      };

      addEntry(entry);

      const state = useConsoleStore.getState();
      expect(state.entries).toHaveLength(1);
      expect(state.entries[0]?.request.method).toBe('GET');
      expect(state.entries[0]?.request.url).toBe('https://api.example.com/users');
      expect(state.selectedEntryId).toBe(state.entries[0]?.id);
    });

    it('should limit entries to 100 and keep newest entries', () => {
      const { addEntry } = useConsoleStore.getState();

      // Add 105 entries
      for (let i = 0; i < 105; i++) {
        addEntry({
          timestamp: Date.now() + i, // Unique timestamp for each
          request: {
            method: 'GET',
            url: `https://api.example.com/users/${i}`,
            headers: {},
          },
          response: {
            id: `resp-${i}`,
            requestId: `req-${i}`,
            status: 200,
            statusText: 'OK',
            headers: {},
            body: '',
            size: 0,
            time: 100,
            timestamp: Date.now() + i,
          },
        });
      }

      const state = useConsoleStore.getState();
      expect(state.entries).toHaveLength(100);

      // Verify that the newest entries are kept (entries are added to beginning)
      // Entry 104 should be first (newest), entry 5 should be last (oldest kept)
      expect(state.entries[0]?.request.url).toBe('https://api.example.com/users/104');
      expect(state.entries[99]?.request.url).toBe('https://api.example.com/users/5');

      // Verify that entries 0-4 (oldest) were removed
      const urls = state.entries.map((e) => e.request.url);
      expect(urls).not.toContain('https://api.example.com/users/0');
      expect(urls).not.toContain('https://api.example.com/users/4');
    });

    it('keeps the previous selection when the new entry is evicted at insert (all slots pinned)', () => {
      const { addEntry, togglePin } = useConsoleStore.getState();

      // Fill the console and pin every entry — zero room for unpinned ones.
      for (let i = 0; i < 100; i++) {
        addEntry({
          timestamp: Date.now() + i,
          request: { method: 'GET', url: `https://api.example.com/p/${i}`, headers: {} },
          response: {
            id: `resp-${i}`,
            requestId: `req-${i}`,
            status: 200,
            statusText: 'OK',
            headers: {},
            body: '',
            size: 0,
            time: 100,
            timestamp: Date.now() + i,
          },
        });
      }
      for (const e of useConsoleStore.getState().entries) togglePin(e.id);
      const selectedBefore = useConsoleStore.getState().selectedEntryId;

      addEntry({
        timestamp: Date.now(),
        request: { method: 'GET', url: 'https://api.example.com/evicted', headers: {} },
        response: {
          id: 'resp-evicted',
          requestId: 'req-evicted',
          status: 200,
          statusText: 'OK',
          headers: {},
          body: '',
          size: 0,
          time: 100,
          timestamp: Date.now(),
        },
      });

      const state = useConsoleStore.getState();
      // The new entry was evicted immediately (no unpinned room)…
      expect(state.entries.map((e) => e.request.url)).not.toContain(
        'https://api.example.com/evicted'
      );
      // …so the selection must not dangle on its id.
      expect(state.selectedEntryId).toBe(selectedBefore);
      expect(state.entries.some((e) => e.id === state.selectedEntryId)).toBe(true);
    });
  });

  describe('clearEntries', () => {
    it('should clear all entries and reset selectedEntryId', () => {
      const { addEntry, clearEntries } = useConsoleStore.getState();

      addEntry({
        timestamp: Date.now(),
        request: { method: 'GET', url: 'https://api.example.com', headers: {} },
        response: {
          id: 'resp-1',
          requestId: 'req-1',
          status: 200,
          statusText: 'OK',
          headers: {},
          body: '',
          size: 0,
          time: 100,
          timestamp: Date.now(),
        },
      });

      clearEntries();

      const state = useConsoleStore.getState();
      expect(state.entries).toHaveLength(0);
      expect(state.selectedEntryId).toBeNull();
    });
  });

  describe('selectEntry', () => {
    it('should set selectedEntryId', () => {
      const { selectEntry } = useConsoleStore.getState();

      selectEntry('entry-123');

      const state = useConsoleStore.getState();
      expect(state.selectedEntryId).toBe('entry-123');
    });

    it('should allow setting to null', () => {
      const { selectEntry } = useConsoleStore.getState();

      selectEntry('entry-123');
      selectEntry(null);

      const state = useConsoleStore.getState();
      expect(state.selectedEntryId).toBeNull();
    });
  });

  describe('setExpanded', () => {
    it('should toggle expanded state', () => {
      const { setExpanded } = useConsoleStore.getState();

      setExpanded(false);
      expect(useConsoleStore.getState().isExpanded).toBe(false);

      setExpanded(true);
      expect(useConsoleStore.getState().isExpanded).toBe(true);
    });
  });

  describe('setPanelHeight', () => {
    it('should set panel height', () => {
      const { setPanelHeight } = useConsoleStore.getState();

      setPanelHeight(400);

      const state = useConsoleStore.getState();
      expect(state.panelHeight).toBe(400);
    });
  });

  describe('setActiveTab', () => {
    it('should set active tab', () => {
      const { setActiveTab } = useConsoleStore.getState();

      setActiveTab('scripts');
      expect(useConsoleStore.getState().activeTab).toBe('scripts');

      setActiveTab('network');
      expect(useConsoleStore.getState().activeTab).toBe('network');
    });
  });

  describe('preserveOnSend', () => {
    it('clears prior entries on the next addEntry when preserveOnSend is off', () => {
      const { addEntry, setPreserveOnSend } = useConsoleStore.getState();
      addEntry({
        timestamp: Date.now(),
        request: { method: 'GET', url: 'https://a.example.com', headers: {} },
        response: {
          id: 'r1',
          requestId: 'req-1',
          status: 200,
          statusText: 'OK',
          headers: {},
          body: '',
          size: 0,
          time: 10,
          timestamp: Date.now(),
        },
      });
      expect(useConsoleStore.getState().entries).toHaveLength(1);

      setPreserveOnSend(false);
      addEntry({
        timestamp: Date.now(),
        request: { method: 'GET', url: 'https://b.example.com', headers: {} },
        response: {
          id: 'r2',
          requestId: 'req-2',
          status: 200,
          statusText: 'OK',
          headers: {},
          body: '',
          size: 0,
          time: 10,
          timestamp: Date.now(),
        },
      });
      const state = useConsoleStore.getState();
      expect(state.entries).toHaveLength(1);
      expect(state.entries[0]?.request.url).toBe('https://b.example.com');
    });
  });

  describe('removeEntry', () => {
    it('removes a single entry and clears selection if it pointed at it', () => {
      const { addEntry, removeEntry, selectEntry } = useConsoleStore.getState();
      addEntry({
        timestamp: Date.now(),
        request: { method: 'GET', url: 'https://a.example.com', headers: {} },
        response: {
          id: 'r1',
          requestId: 'req-1',
          status: 200,
          statusText: 'OK',
          headers: {},
          body: '',
          size: 0,
          time: 10,
          timestamp: Date.now(),
        },
      });
      const id = useConsoleStore.getState().entries[0]?.id ?? '';
      selectEntry(id);
      removeEntry(id);
      const state = useConsoleStore.getState();
      expect(state.entries).toHaveLength(0);
      expect(state.selectedEntryId).toBeNull();
    });
  });

  describe('filters', () => {
    it('setStatusFilter and setProtocolFilter update store state', () => {
      const { setStatusFilter, setProtocolFilter } = useConsoleStore.getState();
      setStatusFilter('4xx');
      setProtocolFilter('grpc');
      const state = useConsoleStore.getState();
      expect(state.statusFilter).toBe('4xx');
      expect(state.protocolFilter).toBe('grpc');
    });
  });

  describe('captureEnabled (pause/resume)', () => {
    const sampleEntry = () => ({
      timestamp: Date.now(),
      request: { method: 'GET', url: 'https://x.test', headers: {} },
      response: {
        id: 'r',
        requestId: 'q',
        status: 200,
        statusText: 'OK',
        headers: {},
        body: '',
        size: 0,
        time: 1,
        timestamp: Date.now(),
      },
    });

    it('drops entries and frames while paused; resumes capture when re-enabled', () => {
      const store = useConsoleStore.getState();
      store.setCaptureEnabled(false);
      useConsoleStore.getState().addEntry(sampleEntry());
      useConsoleStore.getState().addFrame({
        timestamp: Date.now(),
        protocol: 'sse',
        direction: 'in',
        payload: 'hello',
      });
      useConsoleStore
        .getState()
        .addFrames([
          { timestamp: Date.now(), protocol: 'websocket', direction: 'out', payload: 'x' },
        ]);
      expect(useConsoleStore.getState().entries).toHaveLength(0);
      expect(useConsoleStore.getState().frames).toHaveLength(0);

      useConsoleStore.getState().setCaptureEnabled(true);
      useConsoleStore.getState().addEntry(sampleEntry());
      useConsoleStore.getState().addFrame({
        timestamp: Date.now(),
        protocol: 'sse',
        direction: 'in',
        payload: 'hello',
      });
      expect(useConsoleStore.getState().entries).toHaveLength(1);
      expect(useConsoleStore.getState().frames).toHaveLength(1);
    });

    it('clears still work while paused', () => {
      useConsoleStore.getState().addEntry(sampleEntry());
      useConsoleStore.getState().setCaptureEnabled(false);
      useConsoleStore.getState().clearEntries();
      expect(useConsoleStore.getState().entries).toHaveLength(0);
    });
  });

  describe('live body cap', () => {
    it('truncates oversized response bodies at capture and flags the entry', () => {
      const huge = 'x'.repeat(5 * 1024 * 1024 + 100);
      useConsoleStore.getState().addEntry({
        timestamp: Date.now(),
        request: { method: 'GET', url: 'https://x.test', headers: {} },
        response: {
          id: 'r',
          requestId: 'q',
          status: 200,
          statusText: 'OK',
          headers: {},
          body: huge,
          size: huge.length,
          time: 1,
          timestamp: Date.now(),
        },
      });
      const entry = useConsoleStore.getState().entries[0]!;
      expect(entry.bodyTruncated).toBe(true);
      expect(entry.response.body.length).toBeLessThan(huge.length);
      expect(entry.response.body).toContain('[truncated');
    });

    it('leaves normal-sized bodies untouched', () => {
      useConsoleStore.getState().addEntry({
        timestamp: Date.now(),
        request: { method: 'GET', url: 'https://x.test', headers: {} },
        response: {
          id: 'r',
          requestId: 'q',
          status: 200,
          statusText: 'OK',
          headers: {},
          body: '{"ok":true}',
          size: 11,
          time: 1,
          timestamp: Date.now(),
        },
      });
      const entry = useConsoleStore.getState().entries[0]!;
      expect(entry.bodyTruncated).toBeUndefined();
      expect(entry.response.body).toBe('{"ok":true}');
    });
  });

  describe('frame payload cap', () => {
    it('truncates oversized frame payloads at capture (addFrame)', () => {
      const huge = 'x'.repeat(64 * 1024 + 100);
      useConsoleStore.getState().addFrame({
        timestamp: Date.now(),
        protocol: 'sse',
        direction: 'in',
        payload: huge,
        bytes: huge.length,
      });
      const frame = useConsoleStore.getState().frames[0]!;
      expect(frame.payload.length).toBeLessThan(huge.length);
      expect(frame.payload).toContain('[truncated');
      // True size survives in `bytes` even though the preview is cut.
      expect(frame.bytes).toBe(huge.length);
    });

    it('truncates oversized payloads in batch appends (addFrames)', () => {
      const huge = 'y'.repeat(64 * 1024 + 1);
      useConsoleStore.getState().addFrames([
        { timestamp: Date.now(), protocol: 'websocket', direction: 'in', payload: huge },
        { timestamp: Date.now(), protocol: 'websocket', direction: 'in', payload: 'small' },
      ]);
      const frames = useConsoleStore.getState().frames;
      expect(frames[0]!.payload).toContain('[truncated');
      expect(frames[1]!.payload).toBe('small');
    });

    it('leaves normal-sized payloads untouched', () => {
      useConsoleStore.getState().addFrame({
        timestamp: Date.now(),
        protocol: 'sse',
        direction: 'in',
        payload: 'data: {"ok":true}',
      });
      expect(useConsoleStore.getState().frames[0]!.payload).toBe('data: {"ok":true}');
    });
  });

  describe('gRPC streaming frames', () => {
    it('captures gRPC stream messages with inbound/outbound/system directions', () => {
      const connectionId = 'grpc-abc12345';
      const label = 'echo.EchoService/StreamEcho';
      useConsoleStore.getState().addFrame({
        timestamp: Date.now(),
        protocol: 'grpc',
        direction: 'system',
        connectionId,
        label,
        payload: 'stream opened — bidi-stream',
      });
      useConsoleStore.getState().addFrame({
        timestamp: Date.now(),
        protocol: 'grpc',
        direction: 'out',
        connectionId,
        label,
        payload: '{"msg":"ping"}',
      });
      useConsoleStore.getState().addFrame({
        timestamp: Date.now(),
        protocol: 'grpc',
        direction: 'in',
        connectionId,
        label,
        payload: '{"msg":"pong"}',
      });

      const frames = useConsoleStore.getState().frames;
      expect(frames).toHaveLength(3);
      expect(frames.every((f) => f.protocol === 'grpc')).toBe(true);
      expect(frames.map((f) => f.direction)).toEqual(['system', 'out', 'in']);
      // All frames from one stream share a connection id so the Frames tab can
      // group them together.
      expect(frames.every((f) => f.connectionId === connectionId)).toBe(true);
    });
  });
});

describe('createProtocolConsoleEntry', () => {
  it('builds a console entry for non-HTTP protocols with provenance', () => {
    const response: ApiResponse = {
      id: 'r1',
      requestId: 'q1',
      status: 200,
      statusText: 'OK',
      headers: {},
      body: '{}',
      size: 2,
      time: 12,
      timestamp: Date.now(),
    };
    const entry = createProtocolConsoleEntry({
      protocol: 'grpc',
      method: 'pkg.Service/GetThing',
      url: 'grpc://localhost:50051',
      headers: { 'x-meta': '1' },
      body: '{"id":1}',
      response,
      tests: [{ name: 'status ok', passed: true }],
      extra: { runId: 'run-1', runLabel: 'Workflow: W' },
    });
    expect(entry.protocol).toBe('grpc');
    expect(entry.request.method).toBe('pkg.Service/GetThing');
    expect(entry.request.url).toBe('grpc://localhost:50051');
    expect(entry.request.body).toBe('{"id":1}');
    expect(entry.tests).toEqual([{ name: 'status ok', passed: true }]);
    expect(entry.runId).toBe('run-1');
    expect(entry.runLabel).toBe('Workflow: W');
    expect(entry.requestSize).toBeGreaterThan(0);
  });
});

describe('entryToCurl', () => {
  it('produces a valid curl command with method, URL, headers, body', () => {
    const curl = entryToCurl({
      id: 'e1',
      timestamp: Date.now(),
      protocol: 'http',
      request: {
        method: 'POST',
        url: 'https://api.example.com/users',
        headers: { 'Content-Type': 'application/json' },
        body: '{"name":"John"}',
      },
      response: {
        id: 'r',
        requestId: 'q',
        status: 201,
        statusText: 'Created',
        headers: {},
        body: '',
        size: 0,
        time: 10,
        timestamp: Date.now(),
      },
    });

    expect(curl).toContain(`curl -X POST 'https://api.example.com/users'`);
    expect(curl).toContain(`-H 'Content-Type: application/json'`);
    expect(curl).toContain(`-d '{"name":"John"}'`);
  });

  it('escapes single quotes in values', () => {
    const curl = entryToCurl({
      id: 'e1',
      timestamp: Date.now(),
      request: {
        method: 'GET',
        url: "https://example.com/?q=it's",
        headers: {},
      },
      response: {
        id: 'r',
        requestId: 'q',
        status: 200,
        statusText: 'OK',
        headers: {},
        body: '',
        size: 0,
        time: 10,
        timestamp: Date.now(),
      },
    });
    // Single quote replaced by '\''
    expect(curl).toContain(`'https://example.com/?q=it'\\''s'`);
  });
});

describe('createConsoleEntry', () => {
  it('should create a console entry from request and response', () => {
    const request: HttpRequest = {
      id: 'req-1',
      name: 'Test Request',
      type: 'http',
      method: 'POST',
      url: 'https://api.example.com/users',
      headers: [],
      params: [],
      body: {
        type: 'json',
        raw: '{"name": "John"}',
      },
      auth: { type: 'none' },
    };

    const response: ApiResponse = {
      id: 'resp-1',
      requestId: 'req-1',
      status: 201,
      statusText: 'Created',
      headers: { 'content-type': 'application/json' },
      body: '{"id": 1, "name": "John"}',
      size: 200,
      time: 250,
      timestamp: Date.now(),
    };

    const sentHeaders = {
      'Content-Type': 'application/json',
      Authorization: 'Bearer token123',
    };

    const entry = createConsoleEntry(request, response, sentHeaders);

    expect(entry.request.method).toBe('POST');
    expect(entry.request.url).toBe('https://api.example.com/users');
    expect(entry.request.headers).toEqual(sentHeaders);
    expect(entry.request.body).toBe('{"name": "John"}');
    expect(entry.response.status).toBe(201);
    expect(entry.timestamp).toBeDefined();
  });

  it('should not include body for requests with type none', () => {
    const request: HttpRequest = {
      id: 'req-1',
      name: 'Test Request',
      type: 'http',
      method: 'GET',
      url: 'https://api.example.com/users',
      headers: [],
      params: [],
      body: {
        type: 'none',
      },
      auth: { type: 'none' },
    };

    const response: ApiResponse = {
      id: 'resp-1',
      requestId: 'req-1',
      status: 200,
      statusText: 'OK',
      headers: {},
      body: '[]',
      size: 2,
      time: 100,
      timestamp: Date.now(),
    };

    const entry = createConsoleEntry(request, response, {});

    expect(entry.request.body).toBeUndefined();
  });

  describe('pins, size, and run metadata', () => {
    const baseEntry = (overrides: Record<string, unknown> = {}) => ({
      timestamp: Date.now(),
      request: { method: 'GET', url: 'https://x.test', headers: {} },
      response: {
        id: 'r',
        requestId: 'req',
        status: 200,
        statusText: 'OK',
        headers: {},
        body: '',
        size: 0,
        time: 1,
        timestamp: Date.now(),
      },
      ...overrides,
    });

    it('keeps pinned entries when clearing', () => {
      const { addEntry, togglePin, clearEntries } = useConsoleStore.getState();
      addEntry(baseEntry());
      const id = useConsoleStore.getState().entries[0]!.id;
      togglePin(id);
      addEntry(baseEntry());
      clearEntries();
      const entries = useConsoleStore.getState().entries;
      expect(entries).toHaveLength(1);
      expect(entries[0]!.id).toBe(id);
      expect(entries[0]!.pinned).toBe(true);
    });

    it('keeps pinned entries when over the cap', () => {
      const { addEntry, togglePin } = useConsoleStore.getState();
      addEntry(baseEntry());
      const pinnedId = useConsoleStore.getState().entries[0]!.id;
      togglePin(pinnedId);
      // Push well past MAX_ENTRIES (100).
      for (let i = 0; i < 120; i++) addEntry(baseEntry());
      const entries = useConsoleStore.getState().entries;
      expect(entries.length).toBeLessThanOrEqual(100);
      expect(entries.some((e) => e.id === pinnedId && e.pinned)).toBe(true);
    });

    it('preserve-off still keeps pinned entries', () => {
      const { addEntry, togglePin, setPreserveOnSend } = useConsoleStore.getState();
      addEntry(baseEntry());
      const pinnedId = useConsoleStore.getState().entries[0]!.id;
      togglePin(pinnedId);
      setPreserveOnSend(false);
      addEntry(baseEntry());
      const entries = useConsoleStore.getState().entries;
      expect(entries.some((e) => e.id === pinnedId)).toBe(true);
    });

    it('computes request size in createConsoleEntry', () => {
      const request: HttpRequest = {
        id: '1',
        name: 'req',
        type: 'http',
        method: 'POST',
        url: 'https://x.test',
        headers: [],
        params: [],
        body: { type: 'json', raw: '{"hello":"world"}' },
        auth: { type: 'none' },
      };
      const response: ApiResponse = {
        id: 'r',
        requestId: '1',
        status: 200,
        statusText: 'OK',
        headers: {},
        body: '',
        size: 0,
        time: 1,
        timestamp: Date.now(),
      };
      const entry = createConsoleEntry(request, response, { 'content-type': 'application/json' });
      expect(entry.requestSize).toBeGreaterThan(0);
    });

    it('carries run provenance onto the entry', () => {
      const { addEntry } = useConsoleStore.getState();
      addEntry(baseEntry({ runId: 'run-1', runLabel: 'My Collection', iteration: 2 }));
      const e = useConsoleStore.getState().entries[0]!;
      expect(e.runId).toBe('run-1');
      expect(e.runLabel).toBe('My Collection');
      expect(e.iteration).toBe(2);
    });
  });
});
