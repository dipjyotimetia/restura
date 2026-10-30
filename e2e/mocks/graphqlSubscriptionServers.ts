import { createServer, type IncomingMessage } from 'node:http';
import { type ExecutionResult, parse, subscribe } from 'graphql';
import { WebSocketServer } from 'ws';
import { bindLocalhost, closeServer } from '../utils/serverHelpers';
import { schema } from './graphqlSchema';

/**
 * In-process fixture servers for the two non-default GraphQL subscription
 * protocols (#889), backed by the same graphql-js schema as the other mocks
 * (`Subscription.tick(count)`):
 *
 * - `startLegacyGraphqlWsServer` — Apollo `subscriptions-transport-ws`
 *   (subprotocol `graphql-ws` ONLY; any other offer fails the handshake).
 * - `startGraphqlSseServer` — graphql-sse "distinct connections mode":
 *   `POST` JSON → `text/event-stream` of `next` events + a data-less `complete`.
 *
 * Both record what they received so tests can assert operationName/params.
 */

type OperationBody = {
  query?: string;
  variables?: Record<string, unknown>;
  operationName?: string;
};

async function* execute(op: OperationBody): AsyncGenerator<ExecutionResult> {
  let document: ReturnType<typeof parse>;
  try {
    document = parse(op.query ?? '');
  } catch (err) {
    yield { errors: [{ message: (err as Error).message }] } as unknown as ExecutionResult;
    return;
  }
  const result = await subscribe({
    schema,
    document,
    ...(op.variables ? { variableValues: op.variables } : {}),
    ...(op.operationName ? { operationName: op.operationName } : {}),
  });
  if (Symbol.asyncIterator in (result as object)) {
    for await (const r of result as AsyncIterable<ExecutionResult>) yield r;
    return;
  }
  yield result as ExecutionResult;
}

export interface LegacyGraphqlWsServerHandle {
  url: string;
  /** Every parsed client message, in order. */
  received: () => Array<Record<string, unknown>>;
  /** Subprotocol the last connection negotiated. */
  lastProtocol: () => string | undefined;
  close: () => Promise<void>;
}

export async function startLegacyGraphqlWsServer(
  opts: {
    /** Bind a fixed port (echo-local); default 0 = ephemeral. */
    port?: number;
    rejectInit?: boolean;
    /**
     * Mimic the real `subscriptions-transport-ws` server: no `handleProtocols`,
     * so `ws` accepts the FIRST offered subprotocol, then the server closes
     * with 1002 unless that subprotocol is `graphql-ws`.
     */
    acceptFirstOffered?: boolean;
  } = {}
): Promise<LegacyGraphqlWsServerHandle> {
  const received: Array<Record<string, unknown>> = [];
  let lastProtocol: string | undefined;
  const http = createServer((_req, res) => {
    res.writeHead(426).end();
  });
  const wss = new WebSocketServer({
    server: http,
    perMessageDeflate: false,
    // Only the legacy subprotocol — a modern-only offer fails the handshake.
    ...(opts.acceptFirstOffered
      ? {}
      : {
          handleProtocols: (protocols: Set<string>) =>
            protocols.has('graphql-ws') ? 'graphql-ws' : false,
        }),
  });

  wss.on('connection', (ws) => {
    lastProtocol = ws.protocol;
    if (ws.protocol !== 'graphql-ws') {
      ws.close(1002, 'Unsupported subprotocol');
      return;
    }
    const ops = new Map<string, AsyncGenerator<ExecutionResult>>();
    const send = (msg: Record<string, unknown>): void => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    };
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as {
        type: string;
        id?: string;
        payload?: OperationBody;
      };
      received.push(msg as unknown as Record<string, unknown>);
      switch (msg.type) {
        case 'connection_init':
          if (opts.rejectInit) {
            send({ type: 'connection_error', payload: { message: 'Forbidden' } });
            return;
          }
          send({ type: 'connection_ack' });
          send({ type: 'ka' });
          return;
        case 'start': {
          const id = msg.id ?? '';
          const it = execute(msg.payload ?? {});
          ops.set(id, it);
          void (async () => {
            for await (const r of it) {
              if (r.errors && !r.data) {
                send({ id, type: 'error', payload: r.errors });
                ops.delete(id);
                return;
              }
              send({ id, type: 'data', payload: r });
              send({ type: 'ka' });
            }
            if (ops.delete(id)) send({ id, type: 'complete' });
          })();
          return;
        }
        case 'stop':
          void ops.get(msg.id ?? '')?.return(undefined);
          ops.delete(msg.id ?? '');
          return;
        case 'connection_terminate':
          ws.close();
          return;
      }
    });
  });

  const port = await bindLocalhost(http, opts.port);
  return {
    url: `ws://127.0.0.1:${port}/graphql`,
    received: () => received.slice(),
    lastProtocol: () => lastProtocol,
    close: async () => {
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
      await closeServer(http);
    },
  };
}

export interface GraphqlSseServerHandle {
  url: string;
  requests: () => Array<{
    method: string;
    headers: IncomingMessage['headers'];
    body: OperationBody;
  }>;
  close: () => Promise<void>;
}

export async function startGraphqlSseServer(
  opts: { port?: number } = {}
): Promise<GraphqlSseServerHandle> {
  const requests: Array<{
    method: string;
    headers: IncomingMessage['headers'];
    body: OperationBody;
  }> = [];
  const http = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => {
      raw += c.toString();
    });
    req.on('end', () => {
      const body = (raw ? JSON.parse(raw) : {}) as OperationBody;
      requests.push({ method: req.method ?? '', headers: req.headers, body });
      if (req.method !== 'POST' || !req.url?.startsWith('/graphql/stream')) {
        res.writeHead(405, { 'content-type': 'text/plain' }).end('method not allowed');
        return;
      }
      if (!String(req.headers.accept ?? '').includes('text/event-stream')) {
        res.writeHead(406).end();
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      // A leading comment line, as real servers send to flush headers.
      res.write(':\n\n');
      void (async () => {
        for await (const r of execute(body)) {
          res.write(`event: next\ndata: ${JSON.stringify(r)}\n\n`);
        }
        res.end('event: complete\n\n');
      })();
    });
  });
  const port = await bindLocalhost(http, opts.port);
  return {
    url: `http://127.0.0.1:${port}/graphql/stream`,
    requests: () => requests.slice(),
    close: () => closeServer(http),
  };
}
