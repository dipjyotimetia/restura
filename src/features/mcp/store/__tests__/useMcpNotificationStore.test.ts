import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_MCP_NOTIFICATIONS,
  useMcpNotificationStore,
  useMcpNotifications,
  useMcpSubscribedUris,
} from '../useMcpNotificationStore';

beforeEach(() => {
  useMcpNotificationStore.setState({ entries: {}, subscriptions: {} });
});

const store = () => useMcpNotificationStore.getState();

describe('useMcpNotificationStore', () => {
  it('keeps newest first and bounds the buffer', () => {
    for (let i = 0; i < MAX_MCP_NOTIFICATIONS + 5; i++) {
      store().push('c1', { kind: 'other', method: `m${i}`, summary: `m${i}` });
    }
    const entries = store().entries.c1!;
    expect(entries).toHaveLength(MAX_MCP_NOTIFICATIONS);
    expect(entries[0]!.method).toBe(`m${MAX_MCP_NOTIFICATIONS + 4}`);
    expect(new Set(entries.map((e) => e.id)).size).toBe(MAX_MCP_NOTIFICATIONS);
  });

  it('coalesces progress updates of one call into a single moving bar', () => {
    store().push('c1', {
      kind: 'progress',
      method: 'notifications/progress',
      summary: 'a',
      progress: { key: 'tools/call#1', value: 1, total: 3 },
    });
    store().push('c1', { kind: 'log', method: 'notifications/message', summary: 'log' });
    store().push('c1', {
      kind: 'progress',
      method: 'notifications/progress',
      summary: 'a',
      progress: { key: 'tools/call#1', value: 2, total: 3 },
    });
    store().push('c1', {
      kind: 'progress',
      method: 'notifications/progress',
      summary: 'b',
      progress: { key: 'tools/call#2', value: 1 },
    });

    const entries = store().entries.c1!;
    expect(entries.map((e) => e.progress?.key ?? e.kind)).toEqual([
      'tools/call#2',
      'tools/call#1',
      'log',
    ]);
    expect(entries[1]!.progress?.value).toBe(2);
  });

  it('clears one connection without touching another', () => {
    store().push('c1', { kind: 'other', method: 'a', summary: 'a' });
    store().push('c2', { kind: 'other', method: 'b', summary: 'b' });
    store().clear('c1');
    expect(store().entries.c1).toEqual([]);
    expect(store().entries.c2).toHaveLength(1);
  });

  it('tracks subscribed resources per connection', () => {
    store().setSubscribed('c1', 'a://1', true);
    store().setSubscribed('c1', 'a://1', true);
    store().setSubscribed('c1', 'a://2', true);
    expect(store().subscriptions.c1).toEqual(['a://1', 'a://2']);

    const before = store().subscriptions;
    store().setSubscribed('c1', 'a://3', false); // no-op keeps identity
    expect(store().subscriptions).toBe(before);

    store().setSubscribed('c1', 'a://1', false);
    expect(store().subscriptions.c1).toEqual(['a://2']);

    store().resetSubscriptions('c1');
    expect(store().subscriptions.c1).toEqual([]);
    const afterReset = store().subscriptions;
    store().resetSubscriptions('c1');
    store().resetSubscriptions('never');
    expect(store().subscriptions).toBe(afterReset);
  });

  it('selector hooks return stable empties for unknown or missing connections', () => {
    const { result: none } = renderHook(() => useMcpNotifications(undefined));
    const { result: missing } = renderHook(() => useMcpNotifications('nope'));
    expect(none.current).toEqual([]);
    expect(missing.current).toBe(none.current);

    store().setSubscribed('c1', 'a://1', true);
    const { result: uris } = renderHook(() => useMcpSubscribedUris('c1'));
    const { result: noUris } = renderHook(() => useMcpSubscribedUris(undefined));
    expect(uris.current).toEqual(['a://1']);
    expect(noUris.current).toEqual([]);

    store().push('c1', { kind: 'other', method: 'x', summary: 'x' });
    const { result: some } = renderHook(() => useMcpNotifications('c1'));
    expect(some.current).toHaveLength(1);
  });
});
