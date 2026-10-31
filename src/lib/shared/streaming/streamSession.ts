/**
 * Opening a Protocol stream in the renderer: listener registration and
 * disposal, abort-before-open, and events as an async sequence.
 *
 * Transports plug in through {@link StreamAdapter}; `desktopStreamAdapter.ts`
 * is the Desktop IPC adapter. There is deliberately no Web adapter: the web
 * paths have no separate connect step or per-kind channels (a fetch reader, a
 * native `WebSocket`), so they only share {@link createStreamSequence}.
 *
 * Reconnect is out of scope: WebSocket backoff and SSE `retry:` semantics
 * differ on purpose and stay in their managers, above this module.
 */

export type StreamListener = (payload: unknown) => void;

export interface StreamConnectResult {
  success: boolean;
  error?: string | undefined;
}

/** The transport behind a session. `K` names the stream's event kinds. */
export interface StreamAdapter<K extends string> {
  addListener: (kind: K, listener: StreamListener) => void;
  /** Remove every listener of this stream, including kinds nobody subscribed to. */
  removeListeners: () => void;
  connect: () => Promise<StreamConnectResult>;
  disconnect: () => Promise<unknown>;
}

export interface StreamSessionOptions<K extends string> {
  /** Attached immediately, in declaration order, so nothing emitted during connect is missed. */
  listeners: Partial<Record<K, StreamListener>>;
  /** Aborting sends a disconnect; a session already aborted never connects. */
  signal?: AbortSignal | undefined;
  /** Runs when the signal fires (or at once if already aborted), before the disconnect. */
  onAbort?: (() => void) | undefined;
}

export interface StreamSession {
  /** Start the stream. Rejects with an `AbortError`, without connecting, once aborted. */
  connect: () => Promise<StreamConnectResult>;
  /** Tell the transport to stop, at most once. A failure to do so is ignored. */
  disconnect: () => void;
  /** Remove the listeners and the abort link, leaving the connection alone. */
  dispose: () => void;
  /** {@link StreamSession.disconnect} then {@link StreamSession.dispose}. */
  close: () => void;
}

export function openStreamSession<K extends string>(
  adapter: StreamAdapter<K>,
  { listeners, signal, onAbort }: StreamSessionOptions<K>
): StreamSession {
  for (const kind of Object.keys(listeners) as K[]) {
    const listener = listeners[kind];
    if (listener) adapter.addListener(kind, listener);
  }

  let disconnected = false;
  const disconnect = (): void => {
    if (disconnected) return;
    disconnected = true;
    adapter.disconnect().catch(() => undefined);
  };

  const handleAbort = (): void => {
    onAbort?.();
    disconnect();
  };
  if (signal?.aborted) handleAbort();
  else signal?.addEventListener('abort', handleAbort, { once: true });

  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    adapter.removeListeners();
    signal?.removeEventListener('abort', handleAbort);
  };

  return {
    connect: () =>
      signal?.aborted
        ? Promise.reject(new DOMException('Aborted', 'AbortError'))
        : adapter.connect(),
    disconnect,
    dispose,
    close: () => {
      disconnect();
      dispose();
    },
  };
}

export interface StreamSequence<T> {
  /** Queue an item, waking a waiting consumer. Items pushed after `end` still drain. */
  push: (item: T) => void;
  /** Record the failure to throw once the sequence has ended and drained. Latest wins. */
  fail: (error: Error) => void;
  /** No more items are expected: consumers finish after draining the queue. */
  end: () => void;
  readonly ended: boolean;
  /** The events as a sequence for one consumer. `onFinish` runs however iteration stops. */
  iterate: (onFinish?: () => void | Promise<void>) => AsyncGenerator<T, void, unknown>;
}

/** A queue and a single waiter: async-iterable events without buffering the whole stream. */
export function createStreamSequence<T>(): StreamSequence<T> {
  const queue: T[] = [];
  let resolveWaiter: (() => void) | null = null;
  let ended = false;
  let failure: Error | null = null;

  const wakeup = (): void => {
    if (resolveWaiter) {
      const resolve = resolveWaiter;
      resolveWaiter = null;
      resolve();
    }
  };

  return {
    push(item) {
      queue.push(item);
      wakeup();
    },
    fail(error) {
      failure = error;
    },
    end() {
      ended = true;
      wakeup();
    },
    get ended() {
      return ended;
    },
    async *iterate(onFinish) {
      try {
        while (true) {
          if (queue.length > 0) {
            yield queue.shift() as T;
            continue;
          }
          if (ended) {
            if (failure) throw failure;
            return;
          }
          await new Promise<void>((resolve) => {
            resolveWaiter = resolve;
          });
        }
      } finally {
        await onFinish?.();
      }
    },
  };
}
