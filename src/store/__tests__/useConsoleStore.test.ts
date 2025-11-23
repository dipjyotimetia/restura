import { describe, it, expect, beforeEach } from 'vitest';
import { useConsoleStore, createConsoleEntry } from '../useConsoleStore';
import { HttpRequest, Response as ApiResponse } from '@/types';

describe('useConsoleStore', () => {
  beforeEach(() => {
    // Reset store state before each test
    useConsoleStore.setState({
      entries: [],
      selectedEntryId: null,
      isExpanded: true,
      panelHeight: 250,
      activeTab: 'network',
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
      const urls = state.entries.map(e => e.request.url);
      expect(urls).not.toContain('https://api.example.com/users/0');
      expect(urls).not.toContain('https://api.example.com/users/4');
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
      'Authorization': 'Bearer token123',
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
});
