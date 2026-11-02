import type { EventBridge } from '../channelBinding';

/**
 * A preload bridge with no IPC behind it: records listeners per channel so
 * lifecycle tests assert attach/detach without per-protocol mock setup.
 */
export function createFakeEventBridge() {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  const calls: string[] = [];
  const bridge: EventBridge = {
    on(channel, callback) {
      calls.push(`on:${channel}`);
      listeners.set(channel, [...(listeners.get(channel) ?? []), callback]);
    },
    removeAllListeners(channel) {
      calls.push(`off:${channel}`);
      listeners.delete(channel);
    },
  };
  return {
    bridge,
    calls,
    emit: (channel: string, payload?: unknown) => {
      for (const cb of listeners.get(channel) ?? []) cb(payload);
    },
    listenerCount: (channel: string) => listeners.get(channel)?.length ?? 0,
    boundChannels: () => [...listeners.keys()].sort(),
  };
}
