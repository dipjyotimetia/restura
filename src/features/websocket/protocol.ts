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
import type { ProtocolModule, ProtocolStreamHandle } from '@/features/registry/types';
import { getElectronAPI, isElectron } from '@/lib/shared/platform';
import {
  connectionChannels,
  createIpcStreamAdapter,
} from '@/lib/shared/streaming/desktopStreamAdapter';
import { createStreamSequence, openStreamSession } from '@/lib/shared/streaming/streamSession';
import { EVENT_PREFIX } from '../../../electron/shared/channels';
import { websocketManager } from './lib/websocketManager';
import { useWebSocketStore } from './store/useWebSocketStore';

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

  const sequence = createStreamSequence<unknown>();
  let openError: Error | null = null;

  socket.onmessage = (e) => {
    let parsed: unknown = e.data;
    if (typeof e.data === 'string') {
      try {
        parsed = JSON.parse(e.data);
      } catch {
        parsed = e.data;
      }
    }
    sequence.push(parsed);
  };

  socket.onerror = () => {
    if (socket.readyState !== WebSocket.OPEN) {
      openError = new Error('WebSocket connection failed');
    }
    sequence.end();
  };

  socket.onclose = () => {
    sequence.end();
  };

  const linkAbort = () => {
    try {
      socket.close(1000, 'aborted');
    } catch {
      /* ignore */
    }
    sequence.end();
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

  const handle: ProtocolStreamHandle & { send: (frame: string) => void } = {
    events: sequence.iterate(() => {
      if (!sequence.ended) {
        try {
          socket.close(1000, 'iterator-done');
        } catch {
          /* ignore */
        }
      }
    }),
    send: (frame: string) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(frame);
      }
    },
    close: async () => {
      if (sequence.ended) return;
      try {
        socket.close(1000, 'caller-close');
      } catch {
        /* ignore */
      }
      ctx.signal.removeEventListener('abort', linkAbort);
      sequence.end();
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

  const sequence = createStreamSequence<unknown>();
  let openError: string | null = null;

  // Settled by the "wait for open" promise below — also used by the
  // `ws:close` handler so a connection that closes/errors *before* ever
  // opening (e.g. handshake failure after the IPC `connect()` call itself
  // already resolved `success: true`) rejects the open-wait instead of
  // leaving it hanging forever.
  let openSettle: { resolve: () => void; reject: (err: Error) => void } | null = null;

  const session = openStreamSession(
    // Every `ws:*` channel for this id, so disposal also covers the control frames.
    createIpcStreamAdapter(ws, connectionChannels(EVENT_PREFIX.ws, connectionId), {
      connect: () => ws.connect({ connectionId, url }),
      disconnect: () => ws.disconnect({ connectionId }),
    }),
    {
      signal,
      onAbort: () => {
        openSettle?.reject(new DOMException('Aborted', 'AbortError'));
        openSettle = null;
      },
      listeners: {
        open: () => {
          openSettle?.resolve();
          openSettle = null;
        },
        message: (payload) => {
          const msg = payload as { type: 'text' | 'binary'; data: string };
          let parsed: unknown = msg.data;
          if (msg.type === 'text') {
            try {
              parsed = JSON.parse(msg.data);
            } catch {
              parsed = msg.data;
            }
          }
          sequence.push(parsed);
        },
        error: (payload) => {
          const err = payload as { message?: string };
          openError = err?.message ?? 'WebSocket connection failed';
          sequence.fail(new Error(openError));
        },
        close: () => {
          sequence.end();
          openSettle?.reject(new Error(openError ?? 'WebSocket connection failed'));
          openSettle = null;
        },
      },
    }
  );

  // Wait for open BEFORE returning — matches the web path so the
  // caller's first `send()` isn't racing a still-connecting socket.
  try {
    await new Promise<void>((resolve, reject) => {
      openSettle = { resolve, reject };
      session.connect().then((result) => {
        if (!result.success && openSettle) {
          openSettle = null;
          reject(new Error(result.error || 'WebSocket connection failed'));
        }
      }, reject);
    });
  } catch (err) {
    session.close();
    throw err;
  }

  return {
    events: sequence.iterate(session.close),
    send: (frame: string) => {
      ws.send({ connectionId, message: frame }).catch(() => undefined);
    },
    close: async () => session.close(),
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
  connectionLifecycle: {
    connectionIdForTab: (tabId) => useWebSocketStore.getState().connectionByTabId[tabId],
    disconnect: (connectionId) => websocketManager.disconnect(connectionId, true),
    removeConnectionForTab: (tabId) => useWebSocketStore.getState().cleanupConnectionForTab(tabId),
  },
};
