import type { StreamListener } from './streamSession';

/** The slice of a preload protocol bridge a connection's listeners go through. */
export interface EventBridge {
  on: (channel: string, callback: (...args: unknown[]) => void) => void;
  removeAllListeners: (channel: string) => void;
}

export interface ChannelBinderOptions<K extends string> {
  /** The protocol's bridge, resolved per call; nullish when the API is unavailable. */
  bridge: () => EventBridge | null | undefined;
  /** Every channel this binder owns for a connection, declared once. */
  channels: (connectionId: string) => Record<K, string>;
  /** Runs before every detach so buffered inbound items reach the store first. */
  drain?: ((connectionId: string) => void) | undefined;
}

export interface ChannelBinder<K extends string> {
  /** Detach whatever an earlier attempt left on this id, then attach `handlers`. Never double-binds. */
  bind: (connectionId: string, handlers: Partial<Record<K, StreamListener>>) => void;
  /** Drain, then remove every declared channel (including kinds never bound). */
  unbind: (connectionId: string) => void;
}

/**
 * Per-connection listener lifecycle over a protocol's event channels. The
 * channel set is declared once; bind and unbind are the only places in a
 * manager that touch `on` / `removeAllListeners`.
 */
export function createChannelBinder<K extends string>({
  bridge,
  channels,
  drain,
}: ChannelBinderOptions<K>): ChannelBinder<K> {
  const unbind = (connectionId: string): void => {
    drain?.(connectionId);
    const b = bridge();
    if (!b) return;
    for (const channel of Object.values<string>(channels(connectionId))) {
      b.removeAllListeners(channel);
    }
  };
  return {
    unbind,
    bind(connectionId, handlers) {
      unbind(connectionId);
      const b = bridge();
      if (!b) return;
      const names = channels(connectionId);
      for (const kind of Object.keys(handlers) as K[]) {
        const handler = handlers[kind];
        if (handler) b.on(names[kind], handler as (...args: unknown[]) => void);
      }
    },
  };
}
