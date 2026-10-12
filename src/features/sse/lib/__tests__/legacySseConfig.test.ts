import { beforeEach, describe, expect, it } from 'vitest';
import { useRequestStore } from '@/store/useRequestStore';
import type { RequestTab, SseRequest } from '@/types';
import {
  applyLegacySseConfig,
  extractLegacySseConfig,
  migrateLegacySseConfig,
} from '../legacySseConfig';

const header = { id: 'h1', key: 'X-Token', value: 'abc', enabled: true };

const legacyState = () => ({
  activeConnectionId: 'c2',
  connections: {
    c1: { id: 'c1', url: 'https://other.test/events', headers: [] },
    c2: {
      id: 'c2',
      url: 'https://legacy.test/stream',
      headers: [header],
      auth: { type: 'none' },
      eventNameFilter: 'all',
      reconnectOnResume: true,
      status: 'disconnected',
      log: [],
    },
  },
});

const sseTab = (id: string, patch: Partial<SseRequest> = {}): RequestTab => ({
  id,
  isDirty: false,
  request: {
    id: `r-${id}`,
    name: 'New SSE Request',
    type: 'sse',
    url: '',
    headers: [],
    params: [],
    auth: { type: 'none' },
    ...patch,
  },
});

describe('legacy SSE config carry-over (#873)', () => {
  beforeEach(() => {
    useRequestStore.setState({ tabs: [], activeTabId: null });
  });

  it('reads url/headers from the active legacy connection', () => {
    expect(extractLegacySseConfig(legacyState())).toEqual({
      url: 'https://legacy.test/stream',
      headers: [header],
    });
  });

  it('falls back to the first connection and ignores blank / post-#873 blobs', () => {
    const s = legacyState();
    expect(extractLegacySseConfig({ ...s, activeConnectionId: 'gone' })?.url).toBe(
      'https://other.test/events'
    );
    expect(
      extractLegacySseConfig({ connections: { c: { id: 'c', status: 'disconnected' } } })
    ).toBe(null);
    expect(extractLegacySseConfig(undefined)).toBe(null);
  });

  it('fills only SSE tabs with a blank url; headers only when the tab has none', () => {
    const legacy = { url: 'https://legacy.test/stream', headers: [header] };
    const keepHeaders = [{ id: 'k', key: 'A', value: 'b', enabled: true }];
    const tabs = [
      sseTab('blank'),
      sseTab('blank-with-headers', { headers: keepHeaders }),
      sseTab('set', { url: 'https://mine.test' }),
    ];
    const out = applyLegacySseConfig(tabs, legacy);
    expect(out[0]?.request).toMatchObject({ url: legacy.url, headers: [header] });
    expect(out[1]?.request).toMatchObject({ url: legacy.url, headers: keepHeaders });
    expect(out[2]).toBe(tabs[2]);
    // Idempotent: nothing left to fill.
    expect(applyLegacySseConfig(out, legacy)).toBe(out);
  });

  it('patches the hydrated request store and sheds the legacy fields', () => {
    useRequestStore.setState({ tabs: [sseTab('t1')], activeTabId: 't1' });
    const state = legacyState();
    migrateLegacySseConfig(state);
    expect(useRequestStore.getState().tabs[0]?.request).toMatchObject({
      url: 'https://legacy.test/stream',
      headers: [header],
    });
    expect(state.connections.c2).not.toHaveProperty('url');
    expect(state.connections.c2).not.toHaveProperty('headers');
    expect(state.connections.c2).toHaveProperty('status', 'disconnected');
  });
});
