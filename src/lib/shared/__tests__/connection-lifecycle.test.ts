import { describe, expect, it, vi } from 'vitest';
import { cleanupConnectionLifecycle } from '../connection-lifecycle';

describe('cleanupConnectionLifecycle', () => {
  it('disconnects the runtime before removing the persisted connection', () => {
    const calls: string[] = [];

    cleanupConnectionLifecycle('tab-1', {
      connectionIdForTab: () => 'connection-1',
      disconnect: (connectionId) => {
        calls.push(`disconnect:${connectionId}`);
      },
      removeConnectionForTab: (tabId) => {
        calls.push(`remove:${tabId}`);
      },
    });

    expect(calls).toEqual(['disconnect:connection-1', 'remove:tab-1']);
  });

  it('does nothing when the tab has no connection', () => {
    const disconnect = vi.fn();
    const removeConnectionForTab = vi.fn();

    cleanupConnectionLifecycle('missing', {
      connectionIdForTab: () => undefined,
      disconnect,
      removeConnectionForTab,
    });

    expect(disconnect).not.toHaveBeenCalled();
    expect(removeConnectionForTab).not.toHaveBeenCalled();
  });

  it('still removes state when a best-effort disconnect throws', () => {
    const removeConnectionForTab = vi.fn();

    cleanupConnectionLifecycle('tab-1', {
      connectionIdForTab: () => 'connection-1',
      disconnect: () => {
        throw new Error('already closed');
      },
      removeConnectionForTab,
    });

    expect(removeConnectionForTab).toHaveBeenCalledWith('tab-1');
  });
});
