/**
 * WebSocket protocol module.
 *
 * - `runRequest` still throws — the interactive WebSocketClient owns
 *   connection lifecycle via useWebSocketStore + websocketManager.
 * - `startStream` opens a native WebSocket from an inline `{ type:
 *   'websocket', url }` request and returns a handle whose events
 *   iterable yields incoming frames. The handle also carries a
 *   structural `.send(frame)` extension so the DAG executor's
 *   `wsExchange` node can push a frame after open.
 *
 * Browser WebSocket can't set custom HTTP upgrade headers and the
 * subprotocols field is unused in v1 — both are omitted from the
 * inline shape rather than silently dropped.
 */
import { v4 as uuidv4 } from 'uuid';
import { cleanupWebSocketElectronListeners } from './lib/websocketManager';
import type { ProtocolModule, ProtocolStreamHandle } from '@/features/registry/types';
import { isElectron, getElectronAPI } from '@/lib/shared/platform';

interface InlineWsRequestShape {
  type: 'websocket';
  url: string;
}

function isInlineWs(req: unknown): req is InlineWsRequestShape {
  return (
    typeof req === 'object' &&
    req !== null &&
    (req as { type?: unknown }).type === 'websocket' &&
    typeof (req as { url?: unknown }).url === 'string'
  );
}

async function websocketStartStream(
  request: unknown,
  ctx: { signal: AbortSignal }
): Promise<ProtocolStreamHandle & { send: (frame: string) => void }> {
  if (!isInlineWs(request)) {
    throw new Error('WebSocket startStream expects an inline-websocket request');
  }
  if (!request.url.trim()) throw new Error('WebSocket request has no URL');

  // Desktop: packaged-app CSP allows `wss:` but not `ws:` (a bare `new
  // WebSocket('ws://...')` would fail with an opaque CSP error), and even
  // `wss:` connecting directly from the renderer bypasses the main-process
  // DNS-pinned SSRF guard that `websocketManager.ts`'s interactive path
  // relies on (`connectViaElectron` / electron/main/handlers/websocket-handler.ts).
  // Route wsExchange nodes through the same IPC bridge for parity.
  if (isElectron()) {
    return websocketStartStreamElectron(request.url, ctx);
  }

  const socket = new WebSocket(request.url);

  // Event queue + waiter, mirroring sseProtocol's pattern.
  const queue: unknown[] = [];
  let resolveWaiter: (() => void) | null = null;
  let closed = false;
  let openError: Error | null = null;

  const wakeup = () => {
    if (resolveWaiter) {
      const r = resolveWaiter;
      resolveWaiter = null;
      r();
    }
  };

  socket.onmessage = (e) => {
    let parsed: unknown = e.data;
    if (typeof e.data === 'string') {
      try {
        parsed = JSON.parse(e.data);
      } catch {
        parsed = e.data;
      }
    }
    queue.push(parsed);
    wakeup();
  };

  socket.onerror = () => {
    if (socket.readyState !== WebSocket.OPEN) {
      openError = new Error('WebSocket connection failed');
    }
    closed = true;
    wakeup();
  };

  socket.onclose = () => {
    closed = true;
    wakeup();
  };

  const linkAbort = () => {
    try {
      socket.close(1000, 'aborted');
    } catch {
      /* ignore */
    }
    closed = true;
    wakeup();
  };
  if (ctx.signal.aborted) linkAbort();
  else ctx.signal.addEventListener('abort', linkAbort, { once: true });

  // Wait for open BEFORE returning — the caller's first `send()` would
  // otherwise throw because the socket isn't ready yet. The wait must
  // also reject on ctx.signal abort, otherwise an abort-before-open
  // leaves this promise pending forever.
  await new Promise<void>((resolve, reject) => {
    if (socket.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }
    const cleanup = () => {
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('error', onErr);
      ctx.signal.removeEventListener('abort', onAbort);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onErr = () => {
      cleanup();
      reject(openError ?? new Error('WebSocket connection failed'));
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    if (ctx.signal.aborted) {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    socket.addEventListener('open', onOpen);
    socket.addEventListener('error', onErr);
    ctx.signal.addEventListener('abort', onAbort, { once: true });
  });

  async function* iterate(): AsyncGenerator<unknown, void, unknown> {
    try {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (closed) return;
        await new Promise<void>((res) => {
          resolveWaiter = res;
        });
      }
    } finally {
      if (!closed) {
        try {
          socket.close(1000, 'iterator-done');
        } catch {
          /* ignore */
        }
      }
    }
  }

  const handle: ProtocolStreamHandle & { send: (frame: string) => void } = {
    events: iterate(),
    send: (frame: string) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(frame);
      }
    },
    close: async () => {
      if (closed) return;
      try {
        socket.close(1000, 'caller-close');
      } catch {
        /* ignore */
      }
      closed = true;
      ctx.signal.removeEventListener('abort', linkAbort);
      wakeup();
    },
  };
  return handle;
}

/**
 * Electron path for `websocketStartStream`. Mirrors the queue+waiter
 * async-iterable shape above, but sources frames from the `ws:connect`
 * IPC channel (electron/main/handlers/websocket-handler.ts) — the same
 * DNS-pinned, SSRF-guarded main-process socket the interactive WebSocket
 * client uses (`websocketManager.connectViaElectron`) — instead of a
 * renderer-side native `WebSocket`. Doesn't touch `useWebSocketStore`;
 * the DAG executor owns event accumulation for wsExchange nodes.
 */
async function websocketStartStreamElectron(
  url: string,
  ctx: { signal: AbortSignal }
): Promise<ProtocolStreamHandle & { send: (frame: string) => void }> {
  // Destructured up front rather than closing over `ctx` itself: the
  // executor's actual runtime `ctx` also carries `variables` (this
  // function's declared type just doesn't need it) — capturing only the
  // signal lets that map be GC'd once the caller's frame is done instead
  // of staying reachable for this stream's whole lifetime.
  const { signal } = ctx;

  const api = getElectronAPI();
  if (!api?.websocket) {
    throw new Error('Electron WebSocket API is not available in this context.');
  }
  const ws = api.websocket;
  const connectionId = `flow-ws-${uuidv4()}`;

  const queue: unknown[] = [];
  let resolveWaiter: (() => void) | null = null;
  let closed = false;
  let openError: string | null = null;
  const wakeup = () => {
    if (resolveWaiter) {
      const r = resolveWaiter;
      resolveWaiter = null;
      r();
    }
  };

  let disconnected = false;
  const disconnectOnce = () => {
    if (disconnected) return;
    disconnected = true;
    ws.disconnect({ connectionId }).catch(() => undefined);
  };

  // Settled by the "wait for open" promise below — also used by the
  // `ws:close` handler so a connection that closes/errors *before* ever
  // opening (e.g. handshake failure after the IPC `connect()` call itself
  // already resolved `success: true`) rejects the open-wait instead of
  // leaving it hanging forever.
  let openSettle: { resolve: () => void; reject: (err: Error) => void } | null = null;

  ws.on(`ws:open:${connectionId}`, () => {
    openSettle?.resolve();
    openSettle = null;
  });
  ws.on(`ws:message:${connectionId}`, (payload: unknown) => {
    const msg = payload as { type: 'text' | 'binary'; data: string };
    let parsed: unknown = msg.data;
    if (msg.type === 'text') {
      try {
        parsed = JSON.parse(msg.data);
      } catch {
        parsed = msg.data;
      }
    }
    queue.push(parsed);
    wakeup();
  });
  ws.on(`ws:error:${connectionId}`, (payload: unknown) => {
    const err = payload as { message?: string };
    openError = err?.message ?? 'WebSocket connection failed';
  });
  ws.on(`ws:close:${connectionId}`, () => {
    closed = true;
    openSettle?.reject(new Error(openError ?? 'WebSocket connection failed'));
    openSettle = null;
    wakeup();
  });

  const onAbort = () => {
    openSettle?.reject(new DOMException('Aborted', 'AbortError'));
    openSettle = null;
    disconnectOnce();
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });

  // Wait for open BEFORE returning — matches the web path so the
  // caller's first `send()` isn't racing a still-connecting socket.
  try {
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      openSettle = { resolve, reject };
      ws.connect({ connectionId, url }).then((result) => {
        if (!result.success && openSettle) {
          openSettle = null;
          reject(new Error(result.error || 'WebSocket connection failed'));
        }
      }, reject);
    });
  } catch (err) {
    cleanupWebSocketElectronListeners(connectionId, api);
    disconnectOnce();
    signal.removeEventListener('abort', onAbort);
    throw err;
  }

  async function* iterate(): AsyncGenerator<unknown, void, unknown> {
    try {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (closed) {
          if (openError) throw new Error(openError);
          return;
        }
        await new Promise<void>((res) => {
          resolveWaiter = res;
        });
      }
    } finally {
      disconnectOnce();
      cleanupWebSocketElectronListeners(connectionId, api);
      signal.removeEventListener('abort', onAbort);
    }
  }

  return {
    events: iterate(),
    send: (frame: string) => {
      ws.send({ connectionId, message: frame }).catch(() => undefined);
    },
    close: async () => {
      disconnectOnce();
      cleanupWebSocketElectronListeners(connectionId, api);
      signal.removeEventListener('abort', onAbort);
    },
  };
}

export const websocketProtocol: ProtocolModule = {
  id: 'websocket',
  label: 'WebSocket',
  tabType: 'websocket',
  defaultRequest: () => {
    throw new Error('WebSocket has no Request shape; create a connection via useWebSocketStore.');
  },
  runRequest: async () => {
    throw new Error(
      'WebSocket is full-duplex and stateful; use WebSocketClient + websocketManager, not the registry runner.'
    );
  },
  startStream: websocketStartStream,
};
