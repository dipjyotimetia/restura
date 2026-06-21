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
import type { ProtocolModule, ProtocolStreamHandle } from '@/features/registry/types';

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
