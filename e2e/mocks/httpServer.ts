import { createServer as createHttpServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { URL } from 'node:url';
import { execute, parse, validate, type DocumentNode } from 'graphql';
import { createSession, type Session } from 'better-sse';
import { getSelfSignedCert } from './cert';
import { schema as graphqlSchema } from './graphqlSchema';
import { applyCors, bindLocalhost, closeServer, handlePreflight, readBody } from '../utils/serverHelpers';

export interface MockHttpServerHandle {
  port: number;
  url: string;
  close: () => Promise<void>;
  requestCount: () => number;
  requests: () => RecordedRequest[];
  reset: () => void;
}

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  secure: boolean;
}

interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  body: string;
  match: RegExpExecArray | null;
}

interface Route {
  method: string;
  test: string | RegExp;
  handle: (ctx: RouteContext) => void | Promise<void>;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const routes: Route[] = [
  {
    method: 'GET',
    test: '/json',
    handle: ({ res, req }) =>
      json(res, 200, { hello: 'world', secure: (req.socket as { encrypted?: boolean }).encrypted === true }),
  },
  {
    method: 'GET',
    test: '/html',
    handle: ({ res }) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<h1>Hello</h1>');
    },
  },
  {
    method: 'GET',
    test: /^\/status\/(\d{3})$/,
    handle: ({ res, match }) => {
      const code = Number(match![1]);
      json(res, code, { status: code });
    },
  },
  {
    method: 'GET',
    test: '/headers',
    handle: ({ res, req }) => json(res, 200, { headers: req.headers }),
  },
  {
    method: 'GET',
    test: '/query',
    handle: ({ res, url }) => {
      const params: Record<string, string> = {};
      url.searchParams.forEach((v, k) => { params[k] = v; });
      json(res, 200, { params });
    },
  },
  {
    method: '*',
    test: '/echo',
    handle: ({ res, req, url, body }) =>
      json(res, 200, { method: req.method, path: url.pathname + url.search, headers: req.headers, body }),
  },
  {
    method: 'GET',
    test: '/slow',
    handle: ({ res, req, url }) => {
      const ms = Math.min(Number(url.searchParams.get('ms') ?? '500'), 5000);
      const timer = setTimeout(() => json(res, 200, { slept: ms }), ms);
      req.on('close', () => clearTimeout(timer));
    },
  },
  {
    method: 'GET',
    test: /^\/redirect\/(\d+)$/,
    handle: ({ res, match }) => {
      const n = Number(match![1]);
      if (n <= 0) {
        json(res, 200, { done: true });
        return;
      }
      res.writeHead(302, { location: `/redirect/${n - 1}` });
      res.end();
    },
  },
  {
    method: 'GET',
    test: '/stream/sse',
    handle: async ({ req, res }) => {
      const session = await createSession(req, res);
      await pushSseEvents(req, session, undefined);
      res.end();
    },
  },
  {
    method: 'GET',
    test: '/stream/sse-named',
    handle: async ({ req, res }) => {
      const session = await createSession(req, res);
      await pushSseEvents(req, session, 'tick');
      res.end();
    },
  },
  {
    method: 'GET',
    test: '/stream/ndjson',
    handle: ({ req, res }) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      let i = 0;
      const interval = setInterval(() => {
        i += 1;
        res.write(JSON.stringify({ n: i }) + '\n');
        if (i >= 3) {
          clearInterval(interval);
          res.end();
        }
      }, 50);
      req.on('close', () => clearInterval(interval));
    },
  },
  {
    method: 'POST',
    test: '/graphql',
    handle: async ({ res, body }) => {
      const result = await handleGraphQL(body);
      json(res, result.status, result.body);
    },
  },
];

function matchRoute(req: IncomingMessage, path: string): { route: Route; match: RegExpExecArray | null } | null {
  for (const r of routes) {
    if (r.method !== '*' && r.method !== req.method) continue;
    if (typeof r.test === 'string') {
      if (r.test === path) return { route: r, match: null };
    } else {
      const m = r.test.exec(path);
      if (m) return { route: r, match: m };
    }
  }
  return null;
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  recorder: RecordedRequest[]
): Promise<void> {
  applyCors(res);
  if (handlePreflight(req, res)) return;

  const body = req.method === 'OPTIONS' ? '' : await readBody(req);
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;
  const secure = (req.socket as { encrypted?: boolean }).encrypted === true;

  recorder.push({ method: req.method ?? 'GET', path: path + url.search, headers: req.headers, body, secure });

  const matched = matchRoute(req, path);
  if (!matched) {
    json(res, 404, { error: 'not_found', path });
    return;
  }
  await matched.route.handle({ req, res, url, body, match: matched.match });
}

interface SsePushable {
  isConnected: boolean;
  push: (data: unknown, eventName?: string, eventId?: string) => unknown;
}

// One-tick yield before each push lets better-sse complete its connection
// handshake; otherwise the SDK rejects with "Cannot push data to a non-active
// session". Re-checking `isConnected` each loop drops the stream cleanly when
// the client hangs up mid-stream.
async function pushSseEvents(
  req: IncomingMessage,
  session: Session<unknown>,
  eventName: string | undefined
): Promise<void> {
  let aborted = false;
  req.on('close', () => { aborted = true; });
  for (let i = 1; i <= 3; i += 1) {
    await new Promise((r) => setTimeout(r, 10));
    if (aborted || !session.isConnected) return;
    (session as unknown as SsePushable).push({ n: i }, eventName, String(i));
  }
}

interface GraphQLBody {
  query?: string;
  variables?: Record<string, unknown>;
  operationName?: string | null;
}

async function handleGraphQL(rawBody: string): Promise<{
  status: number;
  body: { data?: unknown; errors?: Array<{ message: string }> };
}> {
  let parsed: GraphQLBody;
  try {
    parsed = JSON.parse(rawBody) as GraphQLBody;
  } catch {
    return { status: 400, body: { errors: [{ message: 'invalid JSON' }] } };
  }
  if (!parsed.query) {
    return { status: 400, body: { errors: [{ message: 'missing `query`' }] } };
  }

  let document: DocumentNode;
  try {
    document = parse(parsed.query);
  } catch (err) {
    return { status: 400, body: { errors: [{ message: (err as Error).message }] } };
  }

  const validationErrors = validate(graphqlSchema, document);
  if (validationErrors.length > 0) {
    return { status: 200, body: { errors: validationErrors.map((e) => ({ message: e.message })) } };
  }

  const result = await execute({
    schema: graphqlSchema,
    document,
    variableValues: parsed.variables,
    operationName: parsed.operationName ?? undefined,
  });

  return {
    status: 200,
    body: {
      ...(result.data !== undefined ? { data: result.data } : {}),
      ...(result.errors ? { errors: result.errors.map((e) => ({ message: e.message })) } : {}),
    },
  };
}

async function startServer(server: HttpServer | HttpsServer, scheme: 'http' | 'https'): Promise<MockHttpServerHandle> {
  const recorder: RecordedRequest[] = [];
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    handle(req, res, recorder).catch((err) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    });
  });
  const port = await bindLocalhost(server);
  return {
    port,
    url: `${scheme}://127.0.0.1:${port}`,
    close: () => closeServer(server),
    requestCount: () => recorder.length,
    requests: () => recorder.slice(),
    reset: () => recorder.splice(0, recorder.length),
  };
}

export function startMockHttpServer(): Promise<MockHttpServerHandle> {
  return startServer(createHttpServer(), 'http');
}

export function startMockHttpsServer(): Promise<MockHttpServerHandle> {
  const { key, cert } = getSelfSignedCert();
  return startServer(createHttpsServer({ key, cert }), 'https');
}
