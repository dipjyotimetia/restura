import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Response as ApiResponse, HttpRequest } from '@/types';
import { useHistoryStore } from '../useHistoryStore';
import { useSettingsStore } from '../useSettingsStore';

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

describe('useHistoryStore — addHistoryItem', () => {
  // Capture default settings once so each test can fully restore them, even if
  // a previous run mutated the persisted store.
  const defaultSettings = { ...useSettingsStore.getState().settings };

  beforeEach(() => {
    useHistoryStore.setState({
      history: [],
      favorites: [],
      pageSize: 20,
    });
    useSettingsStore.setState({ settings: { ...defaultSettings } });
  });

  afterEach(() => {
    // Prevent test pollution: any test that mutates settings must not leak into
    // siblings (or other store test files run in the same worker).
    useSettingsStore.setState({ settings: { ...defaultSettings } });
  });

  it('adds a history item with default settings', () => {
    const req = makeHttp();
    useHistoryStore.getState().addHistoryItem(req, makeResponse(req.id));
    expect(useHistoryStore.getState().history).toHaveLength(1);
  });

  it('respects settings.maxHistoryItems when capping', () => {
    useSettingsStore.setState({
      settings: { ...defaultSettings, maxHistoryItems: 3 },
    });

    for (let i = 0; i < 5; i++) {
      const req = makeHttp({ name: `req-${i}` });
      useHistoryStore.getState().addHistoryItem(req);
    }

    const { history } = useHistoryStore.getState();
    expect(history).toHaveLength(3);
    // Newest first
    expect(history[0]?.request.name).toBe('req-4');
    expect(history[2]?.request.name).toBe('req-2');
  });

  it('skips when settings.autoSaveHistory is false', () => {
    useSettingsStore.setState({
      settings: { ...defaultSettings, autoSaveHistory: false },
    });

    useHistoryStore.getState().addHistoryItem(makeHttp());
    useHistoryStore.getState().addHistoryItem(makeHttp());

    expect(useHistoryStore.getState().history).toHaveLength(0);
  });

  it('treats missing maxHistoryItems as the 100 default', () => {
    useSettingsStore.setState({
      // Cast: simulate older persisted state where the field was absent.
      settings: {
        ...defaultSettings,
        maxHistoryItems: undefined,
      } as unknown as typeof defaultSettings,
    });

    for (let i = 0; i < 105; i++) {
      useHistoryStore.getState().addHistoryItem(makeHttp({ name: `r-${i}` }));
    }

    expect(useHistoryStore.getState().history).toHaveLength(100);
  });

  it('treats missing autoSaveHistory as enabled (default true)', () => {
    useSettingsStore.setState({
      settings: {
        ...defaultSettings,
        autoSaveHistory: undefined,
      } as unknown as typeof defaultSettings,
    });

    useHistoryStore.getState().addHistoryItem(makeHttp());
    expect(useHistoryStore.getState().history).toHaveLength(1);
  });

  it('clamps maxHistoryItems to a minimum of 1', () => {
    useSettingsStore.setState({
      settings: { ...defaultSettings, maxHistoryItems: 0 },
    });

    useHistoryStore.getState().addHistoryItem(makeHttp({ name: 'a' }));
    useHistoryStore.getState().addHistoryItem(makeHttp({ name: 'b' }));

    const { history } = useHistoryStore.getState();
    expect(history).toHaveLength(1);
    expect(history[0]?.request.name).toBe('b');
  });
});
