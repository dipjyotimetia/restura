import { describe, expect, it } from 'vitest';
import { liveTabIds } from '@/features/registry/liveConnections';
import { protocolRegistry } from '@/features/registry/registry';
import type { ProtocolModule } from '@/features/registry/types';

const live = new Set<string>(['tab-live']);

protocolRegistry.register({
  id: 'fake-live-protocol',
  connectionLifecycle: {
    connectionIdForTab: () => undefined,
    disconnect: () => undefined,
    removeConnectionForTab: () => undefined,
    isLive: (tabId: string) => live.has(tabId),
  },
} as unknown as ProtocolModule);

protocolRegistry.register({
  id: 'fake-throwing-protocol',
  connectionLifecycle: {
    connectionIdForTab: () => undefined,
    disconnect: () => undefined,
    removeConnectionForTab: () => undefined,
    isLive: () => {
      throw new Error('boom');
    },
  },
} as unknown as ProtocolModule);

describe('liveTabIds', () => {
  it('returns only tabs a registered lifecycle reports as live', () => {
    expect(liveTabIds(['tab-idle', 'tab-live', 'tab-other'])).toEqual(['tab-live']);
  });

  it('returns an empty list when nothing is live', () => {
    expect(liveTabIds(['tab-idle'])).toEqual([]);
    expect(liveTabIds([])).toEqual([]);
  });
});
