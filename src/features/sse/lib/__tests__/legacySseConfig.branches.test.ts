import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRequestStore } from '@/store/useRequestStore';
import type { RequestTab } from '@/types';
import {
  applyLegacySseConfig,
  extractLegacySseConfig,
  migrateLegacySseConfig,
} from '../legacySseConfig';

const blankTab = (id: string): RequestTab => ({
  id,
  isDirty: false,
  request: {
    id: `r-${id}`,
    name: 'SSE',
    type: 'sse',
    url: '',
    headers: [],
    params: [],
    auth: { type: 'none' },
  },
});

describe('legacy SSE config branches', () => {
  beforeEach(() => {
    useRequestStore.setState({ tabs: [], activeTabId: null });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ignores states with missing or malformed connections', () => {
    expect(extractLegacySseConfig(null)).toBeNull();
    expect(extractLegacySseConfig('str')).toBeNull();
    expect(extractLegacySseConfig({})).toBeNull();
    expect(extractLegacySseConfig({ connections: 'nope' })).toBeNull();
    expect(extractLegacySseConfig({ connections: {} })).toBeNull();
    expect(extractLegacySseConfig({ connections: { a: { url: '   ' } } })).toBeNull();
    expect(extractLegacySseConfig({ connections: { a: { url: 5 } } })).toBeNull();
  });

  it('filters malformed legacy headers and copies the valid ones', () => {
    const good = { id: 'h', key: 'K', value: 'V', enabled: true };
    const out = extractLegacySseConfig({
      activeConnectionId: 7,
      connections: {
        a: {
          url: 'https://a.test',
          headers: [good, null, 'x', { key: 1, value: 'v' }, { key: 'k' }],
        },
      },
    });
    expect(out?.headers).toEqual([good]);
    expect(out?.headers[0]).not.toBe(good);
    expect(
      extractLegacySseConfig({ connections: { a: { url: 'https://a.test', headers: 'bad' } } })
        ?.headers
    ).toEqual([]);
  });

  it('leaves non-SSE tabs alone and returns the same array when nothing changes', () => {
    const http = {
      id: 'h',
      isDirty: false,
      request: {
        id: 'r',
        name: 'n',
        type: 'http',
        method: 'GET',
        url: '',
        headers: [],
        params: [],
      },
    } as unknown as RequestTab;
    const tabs = [http];
    expect(applyLegacySseConfig(tabs, { url: 'https://x.test', headers: [] })).toBe(tabs);
  });

  it('tolerates states without connections when shedding', () => {
    expect(() => migrateLegacySseConfig(undefined)).not.toThrow();
    expect(() => migrateLegacySseConfig({})).not.toThrow();
  });

  it('applies immediately when the request store has no persist API', () => {
    useRequestStore.setState({ tabs: [blankTab('t')], activeTabId: 't' });
    const original = useRequestStore.persist;
    (useRequestStore as unknown as { persist: unknown }).persist = undefined;
    try {
      migrateLegacySseConfig({ connections: { c: { url: 'https://legacy.test' } } });
    } finally {
      (useRequestStore as unknown as { persist: unknown }).persist = original;
    }
    expect(useRequestStore.getState().tabs[0]?.request.url).toBe('https://legacy.test');
  });

  it('does not touch the store when no tab needs the url', () => {
    const tab = {
      ...blankTab('t'),
      request: { ...blankTab('t').request, url: 'https://mine.test' },
    };
    useRequestStore.setState({ tabs: [tab], activeTabId: 't' });
    const before = useRequestStore.getState().tabs;
    migrateLegacySseConfig({ connections: { c: { url: 'https://legacy.test' } } });
    expect(useRequestStore.getState().tabs).toBe(before);
  });

  it('waits for the request store to finish hydrating before patching', () => {
    useRequestStore.setState({ tabs: [blankTab('t')], activeTabId: 't' });
    vi.spyOn(useRequestStore.persist, 'hasHydrated').mockReturnValue(false);
    let finish: (() => void) | undefined;
    const unsubscribe = vi.fn();
    vi.spyOn(useRequestStore.persist, 'onFinishHydration').mockImplementation((cb) => {
      finish = () => cb(useRequestStore.getState());
      return unsubscribe;
    });

    migrateLegacySseConfig({ connections: { c: { url: 'https://legacy.test' } } });
    expect(useRequestStore.getState().tabs[0]?.request.url).toBe('');

    finish?.();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(useRequestStore.getState().tabs[0]?.request.url).toBe('https://legacy.test');
  });
});
