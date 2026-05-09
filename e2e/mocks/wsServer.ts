import { createServer, type Server as HttpServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { useServer as useGraphqlWsServer } from 'graphql-ws/use/ws';
import { schema as graphqlSchema } from './graphqlSchema';
import { bindLocalhost, closeServer } from '../utils/serverHelpers';

export interface MockWsServerHandle {
  port: number;
  url: string;
  connectionCount: () => number;
  receivedMessages: () => Array<{ kind: 'text' | 'binary'; payload: string }>;
  graphqlSubscribePayloads: () => Array<Record<string, unknown>>;
  reset: () => void;
  close: () => Promise<void>;
}

/**
 * Multi-purpose mock WebSocket server. Three behaviors keyed by URL path:
 *
 *   /echo     — echoes every text/binary message back unchanged.
 *   /chat     — broadcasts each text frame to all peers.
 *   /graphql  — graphql-transport-ws via the SDK's `useServer` adapter,
 *               backed by the same schema as the HTTP `/graphql` endpoint.
 */
export async function startMockWsServer(): Promise<MockWsServerHandle> {
  let connectionCount = 0;
  const received: Array<{ kind: 'text' | 'binary'; payload: string }> = [];
  const graphqlSubscribePayloads: Array<Record<string, unknown>> = [];
  const chatPeers = new Set<WebSocket>();

  const httpServer: HttpServer = createServer((_req, res) => {
    res.writeHead(426, { 'content-type': 'text/plain' });
    res.end('upgrade required');
  });

  // graphql-ws's `useServer` registers its own message handlers, so its
  // upgrades need a dedicated WebSocketServer; mixing them with our manual
  // `connection` listener confuses both sides.
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const wssGraphql = new WebSocketServer({ noServer: true, perMessageDeflate: false });

  // Negotiate the first subprotocol the client offers from a known list, so
  // tests can verify Sec-WebSocket-Protocol round-trips through the upgrade.
  const SUPPORTED_SUBPROTOCOLS = ['restura.echo.v1', 'restura.echo.v2', 'graphql-transport-ws'];

  httpServer.on('upgrade', (req, socket, head) => {
    const url = req.url ?? '/';
    const target = url.startsWith('/graphql') ? wssGraphql : wss;
    const offered = (req.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const chosen = offered.find((p) => SUPPORTED_SUBPROTOCOLS.includes(p));
    if (target === wss && offered.length > 0 && !chosen) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    target.handleUpgrade(req, socket, head, (ws) => target.emit('connection', ws, req));
  });

  useGraphqlWsServer(
    {
      schema: graphqlSchema,
      onSubscribe: (_ctx, _id, payload) => {
        graphqlSubscribePayloads.push(payload as unknown as Record<string, unknown>);
      },
    },
    wssGraphql
  );

  wss.on('connection', (ws, req) => {
    connectionCount += 1;
    const url = req.url ?? '/';

    if (url.startsWith('/echo')) {
      ws.on('message', (data, isBinary) => {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        if (isBinary) {
          received.push({ kind: 'binary', payload: buf.toString('hex') });
          ws.send(buf, { binary: true });
        } else {
          const text = buf.toString('utf8');
          received.push({ kind: 'text', payload: text });
          ws.send(`echo:${text}`);
        }
      });
      return;
    }

    if (url.startsWith('/chat')) {
      chatPeers.add(ws);
      ws.once('close', () => chatPeers.delete(ws));
      ws.on('message', (data) => {
        const text = data.toString();
        received.push({ kind: 'text', payload: text });
        for (const peer of chatPeers) {
          if (peer.readyState === peer.OPEN) peer.send(text);
        }
      });
      return;
    }

    // Ping/pong path: server pings the client and tracks pong replies.
    // Cap the buffer so a misbehaving test can't grow it without bound.
    if (url.startsWith('/ping')) {
      const pongs: Buffer[] = [];
      const PONG_CAP = 32;
      ws.on('pong', (data) => {
        if (pongs.length >= PONG_CAP) return;
        pongs.push(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
      });
      ws.on('message', (data, isBinary) => {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        if (!isBinary && buf.toString('utf8') === 'PING_ME') {
          ws.ping('mock-ping');
          return;
        }
        if (!isBinary && buf.toString('utf8') === 'REPORT') {
          ws.send(JSON.stringify({ pongs: pongs.map((p) => p.toString('utf8')) }));
          pongs.length = 0;
        }
      });
      return;
    }

    // Close-code path: closes with the code embedded in the path query.
    // /close?code=4001&reason=bye
    if (url.startsWith('/close')) {
      const params = new URL(url, 'http://localhost').searchParams;
      const code = Math.min(Math.max(Number(params.get('code') ?? '1000'), 1000), 4999);
      const reason = params.get('reason') ?? 'normal';
      ws.send('about-to-close');
      setTimeout(() => ws.close(code, reason), 5);
      return;
    }

    ws.close(1008, 'unknown path');
  });

  // Track graphql-ws connections for the connectionCount metric.
  wssGraphql.on('connection', () => { connectionCount += 1; });

  const port = await bindLocalhost(httpServer);

  return {
    port,
    url: `ws://127.0.0.1:${port}`,
    connectionCount: () => connectionCount,
    receivedMessages: () => received.slice(),
    graphqlSubscribePayloads: () => graphqlSubscribePayloads.slice(),
    reset: () => {
      connectionCount = 0;
      received.splice(0, received.length);
      graphqlSubscribePayloads.splice(0, graphqlSubscribePayloads.length);
      chatPeers.clear();
    },
    close: async () => {
      for (const ws of [...wss.clients, ...wssGraphql.clients]) {
        try { ws.terminate(); } catch { /* already gone */ }
      }
      chatPeers.clear();
      await Promise.all([
        new Promise<void>((resolve) => wss.close(() => resolve())),
        new Promise<void>((resolve) => wssGraphql.close(() => resolve())),
      ]);
      await closeServer(httpServer);
    },
  };
}
