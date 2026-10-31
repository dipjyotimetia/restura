import type { StreamAdapter, StreamConnectResult, StreamListener } from '../streamSession';

/**
 * The second adapter behind `openStreamSession` (Desktop IPC is the first): a
 * stream with no transport, driven directly by the test. Records every call in
 * order so listener ordering and teardown are asserted through the interface.
 */
export function createInMemoryStreamAdapter<K extends string>(
  connectResult: () => Promise<StreamConnectResult> = async () => ({ success: true })
) {
  const listeners = new Map<K, StreamListener>();
  const calls: string[] = [];
  const adapter: StreamAdapter<K> = {
    addListener(kind, listener) {
      calls.push(`listen:${kind}`);
      listeners.set(kind, listener);
    },
    removeListeners() {
      calls.push('removeListeners');
      listeners.clear();
    },
    connect() {
      calls.push('connect');
      return connectResult();
    },
    async disconnect() {
      calls.push('disconnect');
    },
  };
  return {
    adapter,
    calls,
    emit: (kind: K, payload?: unknown) => listeners.get(kind)?.(payload),
    hasListeners: () => listeners.size > 0,
  };
}
