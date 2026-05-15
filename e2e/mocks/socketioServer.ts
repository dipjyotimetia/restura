import { createServer, type Server as HttpServer } from 'node:http';
import { Server as SocketIOServer, type Socket } from 'socket.io';
import { bindLocalhost, closeServer } from '../utils/serverHelpers';

export interface SocketIOReceivedEvent {
  /** Socket.IO namespace path the event arrived on (e.g. '/', '/chat'). */
  namespace: string;
  /** The event name as emitted by the client. */
  eventName: string;
  /** Raw args array passed by the client. */
  args: unknown[];
  /** Connection handshake auth payload (snapshot at receive time). */
  auth: Record<string, unknown>;
  /** Connection query-string parameters. */
  query: Record<string, string | string[]>;
}

export interface MockSocketIOServerHandle {
  port: number;
  /** Base HTTP URL — clients connect to `${url}` (default namespace) or `${url}/chat`, etc. */
  url: string;
  connectionCount: () => number;
  receivedEvents: () => SocketIOReceivedEvent[];
  /** Snapshot of the most recent handshake auth payload, for assertions. */
  lastAuth: () => Record<string, unknown> | null;
  reset: () => void;
  close: () => Promise<void>;
}

/**
 * Mock Socket.IO server for e2e testing. Exposes three namespaces:
 *
 *   /        (default) — echoes every event back as `<event>:echo` with the same args.
 *                         If the client supplies an ack callback, the same args are returned.
 *   /chat              — broadcasts each received event to every other peer in the namespace.
 *   /admin             — refuses connections unless `auth.token === 'admin-token'`.
 *
 * Why a Node fixture instead of extending `echo/` — Socket.IO requires a stateful
 * server with handshake/polling/upgrade lifecycle, which Cloudflare Workers can't host
 * natively (no Node http.Server, no long-lived per-client state outside of Durable
 * Objects). The wsServer / grpcServer / mcpServer mocks follow the same pattern.
 */
export async function startMockSocketIOServer(): Promise<MockSocketIOServerHandle> {
  let connectionCount = 0;
  const received: SocketIOReceivedEvent[] = [];
  let lastAuthSnapshot: Record<string, unknown> | null = null;

  const httpServer: HttpServer = createServer((_req, res) => {
    // Bare GET should at least return something — useful for liveness checks.
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('socket.io mock');
  });

  const io = new SocketIOServer(httpServer, {
    cors: { origin: '*' },
    pingInterval: 5_000,
    pingTimeout: 5_000,
  });

  const captureHandshake = (socket: Socket): { auth: Record<string, unknown>; query: Record<string, string | string[]> } => {
    const auth = (socket.handshake.auth ?? {}) as Record<string, unknown>;
    lastAuthSnapshot = auth;
    return { auth, query: socket.handshake.query as Record<string, string | string[]> };
  };

  // Default namespace: echo back every event.
  io.on('connection', (socket) => {
    connectionCount += 1;
    const { auth, query } = captureHandshake(socket);

    socket.onAny((eventName: string, ...args: unknown[]) => {
      received.push({ namespace: '/', eventName, args, auth, query });

      // The last arg may be an ack callback the client passed. Socket.IO doesn't
      // expose this directly via onAny — clients invoke it through `emit(event, ..., cb)`,
      // and the server-side `cb` is appended to args. Detect a function tail.
      const tail = args[args.length - 1];
      if (typeof tail === 'function') {
        const userArgs = args.slice(0, -1);
        (tail as (...replyArgs: unknown[]) => void)(...userArgs.map((a) => ({ ack: true, original: a })));
        return;
      }

      socket.emit(`${eventName}:echo`, ...args);
    });
  });

  // /chat namespace: broadcast events to peers.
  const chatNs = io.of('/chat');
  chatNs.on('connection', (socket) => {
    connectionCount += 1;
    const { auth, query } = captureHandshake(socket);

    socket.onAny((eventName: string, ...args: unknown[]) => {
      // Strip any ack callback — broadcasting can't honour it.
      const userArgs = typeof args[args.length - 1] === 'function' ? args.slice(0, -1) : args;
      received.push({ namespace: '/chat', eventName, args: userArgs, auth, query });
      socket.broadcast.emit(eventName, ...userArgs);
    });
  });

  // /admin namespace: requires auth.token to match.
  const adminNs = io.of('/admin');
  adminNs.use((socket, next) => {
    const auth = (socket.handshake.auth ?? {}) as { token?: string };
    if (auth.token === 'admin-token') return next();
    next(new Error('forbidden: invalid admin token'));
  });
  adminNs.on('connection', (socket) => {
    connectionCount += 1;
    const { auth, query } = captureHandshake(socket);
    socket.onAny((eventName: string, ...args: unknown[]) => {
      const userArgs = typeof args[args.length - 1] === 'function' ? args.slice(0, -1) : args;
      received.push({ namespace: '/admin', eventName, args: userArgs, auth, query });
      socket.emit(`${eventName}:admin-ack`, ...userArgs);
    });
  });

  const port = await bindLocalhost(httpServer);

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    connectionCount: () => connectionCount,
    receivedEvents: () => received.slice(),
    lastAuth: () => lastAuthSnapshot,
    reset: () => {
      connectionCount = 0;
      received.splice(0, received.length);
      lastAuthSnapshot = null;
    },
    close: async () => {
      await new Promise<void>((resolve) => io.close(() => resolve()));
      await closeServer(httpServer);
    },
  };
}
