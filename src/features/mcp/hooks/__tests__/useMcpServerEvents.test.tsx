import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type FakeMcpBridge,
  installFakeMcpBridge,
} from '../../../../../tests/helpers/fakeMcpBridge';
import { useMcpNotificationStore } from '../../store/useMcpNotificationStore';
import { LIST_CHANGED_DEBOUNCE_MS, useMcpServerEvents } from '../useMcpServerEvents';

let bridge: FakeMcpBridge;

beforeEach(() => {
  vi.useFakeTimers();
  bridge = installFakeMcpBridge();
  useMcpNotificationStore.setState({ entries: {}, subscriptions: {} });
});

afterEach(() => {
  bridge.uninstall();
  vi.useRealTimers();
});

function setup(isCurrent: () => boolean = () => true) {
  const callbacks = { onListChanged: vi.fn(), onUpstreamClosed: vi.fn() };
  const hook = renderHook(() => useMcpServerEvents(callbacks));
  act(() => hook.result.current.attach('c1', isCurrent));
  return { ...hook, callbacks };
}

const entries = () => useMcpNotificationStore.getState().entries.c1 ?? [];

describe('useMcpServerEvents (#858)', () => {
  it('records every server event type in the notifications store', () => {
    setup();

    act(() => {
      bridge.emit('mcp:notification:c1', {
        method: 'notifications/progress',
        params: { progress: 1, total: 2, progressKey: 'k' },
      });
      bridge.emit('mcp:notification:c1', {
        method: 'notifications/message',
        params: { level: 'info', data: 'hello' },
      });
      bridge.emit('mcp:notification:c1', {
        method: 'notifications/resources/updated',
        params: { uri: 'a://1' },
      });
      bridge.emit('mcp:notification:c1', { method: 'notifications/tools/list_changed' });
      bridge.emit('mcp:notification:c1', 'not-a-notification');
      bridge.emit('mcp:error:c1', { message: 'transient' });
    });

    expect(entries().map((e) => e.kind)).toEqual([
      'error',
      'list_changed',
      'resource_updated',
      'log',
      'progress',
    ]);
  });

  it('debounces list_changed bursts into one re-discovery with the changed kinds', () => {
    const { callbacks } = setup();

    act(() => {
      bridge.emit('mcp:notification:c1', { method: 'notifications/tools/list_changed' });
      bridge.emit('mcp:notification:c1', { method: 'notifications/prompts/list_changed' });
      bridge.emit('mcp:notification:c1', { method: 'notifications/tools/list_changed' });
    });
    expect(callbacks.onListChanged).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(LIST_CHANGED_DEBOUNCE_MS));

    expect(callbacks.onListChanged).toHaveBeenCalledOnce();
    expect(callbacks.onListChanged).toHaveBeenCalledWith(['tools', 'prompts']);
  });

  it('transitions on upstream close with the last error as the reason and detaches', () => {
    useMcpNotificationStore.getState().setSubscribed('c1', 'a://1', true);
    const { callbacks } = setup();

    act(() => {
      bridge.emit('mcp:error:c1', { message: 'ECONNRESET' });
      bridge.emit('mcp:close:c1', { reason: 'stream ended' });
    });

    expect(callbacks.onUpstreamClosed).toHaveBeenCalledWith('c1', 'stream ended', 'ECONNRESET');
    expect(entries()[0]).toMatchObject({ kind: 'close' });
    expect(useMcpNotificationStore.getState().subscriptions.c1).toEqual([]);
    expect(bridge.listenerCount()).toBe(0);
  });

  it('reports a clean upstream close without an error', () => {
    const { callbacks } = setup();
    act(() => bridge.emit('mcp:close:c1', { reason: 'stream ended' }));
    expect(callbacks.onUpstreamClosed).toHaveBeenCalledWith('c1', 'stream ended', undefined);
  });

  it('clears the subscribed flag when the server ends a resource stream', () => {
    useMcpNotificationStore.getState().setSubscribed('c1', 'a://1', true);
    setup();
    act(() =>
      bridge.emit('mcp:notification:c1', {
        method: 'restura/subscriptionClosed',
        params: { scope: 'resource', uri: 'a://1', reason: 'remote' },
      })
    );
    expect(useMcpNotificationStore.getState().subscriptions.c1).toEqual([]);
  });

  it('drops events from a superseded session', () => {
    let current = true;
    const { callbacks } = setup(() => current);
    current = false;
    act(() => {
      bridge.emit('mcp:notification:c1', { method: 'notifications/tools/list_changed' });
      bridge.emit('mcp:error:c1', { message: 'x' });
      bridge.emit('mcp:close:c1', { reason: 'x' });
      vi.advanceTimersByTime(LIST_CHANGED_DEBOUNCE_MS);
    });
    expect(entries()).toEqual([]);
    expect(callbacks.onUpstreamClosed).not.toHaveBeenCalled();
  });

  it('skips a pending re-discovery if the session went stale before the debounce fired', () => {
    let current = true;
    const { callbacks } = setup(() => current);
    act(() => bridge.emit('mcp:notification:c1', { method: 'notifications/tools/list_changed' }));
    current = false;
    act(() => vi.advanceTimersByTime(LIST_CHANGED_DEBOUNCE_MS));
    expect(callbacks.onListChanged).not.toHaveBeenCalled();
  });

  it('re-attaching replaces the previous listeners instead of stacking them', () => {
    const { result } = setup();
    act(() => result.current.attach('c1', () => true));
    act(() => result.current.attach('c2', () => true));
    expect(bridge.listenerCount()).toBe(3);
    expect(bridge.channels()).toEqual(['mcp:close:c2', 'mcp:error:c2', 'mcp:notification:c2']);
  });

  it('detach removes listeners and cancels a pending re-discovery', () => {
    const { result, callbacks } = setup();
    act(() => bridge.emit('mcp:notification:c1', { method: 'notifications/tools/list_changed' }));
    act(() => result.current.detach());
    act(() => vi.advanceTimersByTime(LIST_CHANGED_DEBOUNCE_MS));
    expect(bridge.listenerCount()).toBe(0);
    expect(callbacks.onListChanged).not.toHaveBeenCalled();
  });

  it('removes every listener on unmount (no leak)', () => {
    const { unmount } = setup();
    expect(bridge.listenerCount()).toBe(3);
    unmount();
    expect(bridge.listenerCount()).toBe(0);
  });
});
