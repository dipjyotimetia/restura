import { ipcRenderer } from 'electron';

type BridgeCallback = (...args: unknown[]) => void;
type IpcListener = Parameters<typeof ipcRenderer.on>[1];

/**
 * Registry mapping a fully-qualified channel → (renderer callback → the wrapper
 * actually registered with ipcRenderer). `on` wraps the renderer callback to
 * strip the IpcRendererEvent arg, so `removeListener` must look the wrapper back
 * up to remove it — passing the bare callback to ipcRenderer.removeListener
 * never matched, so listeners could never be removed. That leaked listeners and,
 * for channels with a stable suffix (gRPC reuses a per-tab request.id, e.g.
 * `grpc:data:<id>`), re-subscribing on re-run stacked duplicates that fired the
 * handler N times.
 *
 * Module-level (not per-closure) because some namespaces call channelEventBridge
 * twice — `on: channelEventBridge(p).on, removeListener: channelEventBridge(p).removeListener`
 * — so a closure-local map would not be shared between the two. Channel strings
 * are globally unique (they carry the per-stream id), so a single map keyed by
 * channel cannot collide across protocols. contextBridge caches its proxy per
 * underlying value, so a renderer callback keeps a stable identity across the
 * on/removeListener pair.
 */
const ipcListenerWrappers = new Map<string, Map<BridgeCallback, IpcListener>>();

/**
 * Registry-backed ipcRenderer.on: registers one wrapper per (channel, callback)
 * so removeWrappedListener can always find and remove it. Re-subscribing the
 * same callback is a no-op. Shared by channelEventBridge and the preload's
 * generic `on`/`removeListener` (VALID_EVENT_CHANNELS) — the latter used to
 * pass the bare callback to ipcRenderer.removeListener, which never matched
 * the wrapper, so unsubscribe was a permanent no-op and listeners stacked.
 */
export function addWrappedListener(channel: string, callback: BridgeCallback): void {
  let perChannel = ipcListenerWrappers.get(channel);
  if (!perChannel) {
    perChannel = new Map();
    ipcListenerWrappers.set(channel, perChannel);
  }
  // One wrapper per (channel, callback) so the registry stays a faithful
  // mirror of what's registered with ipcRenderer and removeListener can
  // always find its wrapper. Re-subscribing the same callback is a no-op.
  if (perChannel.has(callback)) return;
  const wrapper: IpcListener = (_event, ...args) => callback(...args);
  perChannel.set(callback, wrapper);
  ipcRenderer.on(channel, wrapper);
}

export function removeWrappedListener(channel: string, callback: BridgeCallback): void {
  const perChannel = ipcListenerWrappers.get(channel);
  const wrapper = perChannel?.get(callback);
  if (!wrapper) return;
  ipcRenderer.removeListener(channel, wrapper);
  perChannel!.delete(callback);
  if (perChannel!.size === 0) ipcListenerWrappers.delete(channel);
}

/**
 * Build the `{ on, removeListener, removeAllListeners }` trio every streaming
 * namespace exposes, guarded by a channel-name prefix allowlist. Factored out
 * so the prefix guard — a renderer-isolation boundary — is defined once
 * instead of copy-pasted per protocol. `prefix` comes from CHANNEL_PREFIXES.
 */
export function channelEventBridge(prefix: string) {
  return {
    on: (channel: string, callback: BridgeCallback) => {
      if (!channel.startsWith(prefix)) return;
      addWrappedListener(channel, callback);
    },
    removeListener: (channel: string, callback: BridgeCallback) => {
      if (!channel.startsWith(prefix)) return;
      removeWrappedListener(channel, callback);
    },
    removeAllListeners: (channel: string) => {
      if (!channel.startsWith(prefix)) return;
      ipcRenderer.removeAllListeners(channel);
      ipcListenerWrappers.delete(channel);
    },
  };
}
