import { vi } from 'vitest';

type Listener = (...args: unknown[]) => void;

/**
 * Fake of the preload `window.electron.mcp` event bridge: a channel→listeners
 * map with `emit` so tests can drive `mcp:notification|error|close:<id>` and
 * assert there are no leftover listeners (the preload leak class).
 */
export function installFakeMcpBridge(overrides: Record<string, unknown> = {}) {
  const listeners = new Map<string, Set<Listener>>();
  const mcp = {
    connect: vi.fn(async (_config: unknown): Promise<unknown> => ({ success: true })),
    request: vi.fn(
      async (_config: { method: string; params?: unknown }): Promise<unknown> => ({
        success: true,
        result: {},
      })
    ),
    disconnect: vi.fn(async (_config: unknown): Promise<unknown> => ({ success: true })),
    on: vi.fn((channel: string, callback: Listener) => {
      let set = listeners.get(channel);
      if (!set) {
        set = new Set();
        listeners.set(channel, set);
      }
      set.add(callback);
    }),
    removeListener: vi.fn((channel: string, callback: Listener) => {
      const set = listeners.get(channel);
      set?.delete(callback);
      if (set?.size === 0) listeners.delete(channel);
    }),
    removeAllListeners: vi.fn((channel: string) => {
      listeners.delete(channel);
    }),
    ...overrides,
  };
  const previous = (window as unknown as { electron?: unknown }).electron;
  (window as unknown as { electron?: unknown }).electron = { isElectron: true, mcp };

  return {
    mcp,
    emit(channel: string, payload?: unknown) {
      for (const listener of [...(listeners.get(channel) ?? [])]) listener(payload);
    },
    /** Total registered listeners across every channel. */
    listenerCount(prefix = 'mcp:') {
      let count = 0;
      for (const [channel, set] of listeners) if (channel.startsWith(prefix)) count += set.size;
      return count;
    },
    channels() {
      return [...listeners.keys()].sort();
    },
    uninstall() {
      (window as unknown as { electron?: unknown }).electron = previous;
    },
  };
}

export type FakeMcpBridge = ReturnType<typeof installFakeMcpBridge>;
