import {
  createServer as createHttpServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { gzipSync } from 'node:zlib';
import { URL } from 'node:url';
import { execute, parse, validate, type DocumentNode } from 'graphql';
import { createSession, type Session } from 'better-sse';
import { getSelfSignedCert } from './cert';
import { schema as graphqlSchema } from './graphqlSchema';
import {
  applyCors,
  bindLocalhost,
  closeServer,
  handlePreflight,
  isSecure,
  readBody,
  writeJson as json,
} from '../utils/serverHelpers';
import { authRoutes, resetAuthState } from './authRoutes';

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

const routes: Route[] = [
  {
    method: 'GET',
    test: '/json',
    handle: ({ res, req }) => json(res, 200, { hello: 'world', secure: isSecure(req) }),
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
    test: '/csv',
    handle: ({ res }) => {
      res.writeHead(200, { 'content-type': 'text/csv' });
      res.end('name,age,city\nAlice,30,NYC\nBob,25,LA\nCarol,41,SF\n');
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
      url.searchParams.forEach((v, k) => {
        params[k] = v;
      });
      json(res, 200, { params });
    },
  },
  {
    method: '*',
    test: '/echo',
    handle: ({ res, req, url, body }) =>
      json(res, 200, {
        method: req.method,
        path: url.pathname + url.search,
        headers: req.headers,
        body,
      }),
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
  // Resume: clients reconnect with `Last-Event-ID` and the server starts
  // streaming from the next id. Mirrors the EventSource resume protocol.
  {
    method: 'GET',
    test: '/stream/sse-resume',
    handle: async ({ req, res }) => {
      const startId = Number(req.headers['last-event-id'] ?? '0') || 0;
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      let aborted = false;
      req.on('close', () => {
        aborted = true;
      });
      // Suggest 50ms reconnect delay via the SSE retry directive.
      res.write('retry: 50\n\n');
      for (let i = startId + 1; i <= startId + 3; i += 1) {
        await new Promise((r) => setTimeout(r, 10));
        if (aborted) return;
        res.write(`id: ${i}\ndata: ${JSON.stringify({ n: i })}\n\n`);
      }
      res.end();
    },
  },
  // SSE comments + multi-line data values + retry directive.
  {
    method: 'GET',
    test: '/stream/sse-comments',
    handle: async ({ req, res }) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      let aborted = false;
      req.on('close', () => {
        aborted = true;
      });
      res.write(': heartbeat\n\n');
      res.write('retry: 5000\n\n');
      // Multi-line data field — EventSource concatenates with `\n`.
      res.write('id: 1\ndata: line one\ndata: line two\ndata: line three\n\n');
      await new Promise((r) => setTimeout(r, 20));
      if (!aborted) res.write('id: 2\ndata: final\n\n');
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

  // -- Cookies ---------------------------------------------------------------
  {
    method: 'GET',
    test: '/cookies/set',
    handle: ({ res, url }) => {
      const cookies: string[] = [];
      url.searchParams.forEach((v, k) => {
        cookies.push(`${k}=${encodeURIComponent(v)}; Path=/; SameSite=Lax`);
      });
      if (cookies.length === 0) cookies.push('session=abc123; Path=/; HttpOnly');
      res.writeHead(200, {
        'set-cookie': cookies,
        'content-type': 'application/json',
      });
      res.end(JSON.stringify({ set: cookies.length }));
    },
  },
  {
    method: 'GET',
    test: '/cookies',
    handle: ({ res, req }) => {
      const cookies: Record<string, string> = {};
      const raw = req.headers.cookie ?? '';
      for (const pair of raw.split(';')) {
        const trimmed = pair.trim();
        if (!trimmed) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        cookies[trimmed.slice(0, eq)] = decodeURIComponent(trimmed.slice(eq + 1));
      }
      json(res, 200, { cookies });
    },
  },

  // -- Auth ------------------------------------------------------------------
  {
    method: 'GET',
    test: /^\/basic-auth\/([^/]+)\/([^/]+)$/,
    handle: ({ res, req, match }) => {
      const expected = `Basic ${Buffer.from(`${decodeURIComponent(match![1]!)}:${decodeURIComponent(match![2]!)}`).toString('base64')}`;
      const provided = req.headers.authorization ?? '';
      if (provided === expected) {
        json(res, 200, { authenticated: true, user: decodeURIComponent(match![1]!) });
        return;
      }
      res.writeHead(401, {
        'content-type': 'application/json',
        'www-authenticate': 'Basic realm="restura-mock"',
      });
      res.end(JSON.stringify({ authenticated: false }));
    },
  },
  {
    method: 'GET',
    test: '/bearer',
    handle: ({ res, req }) => {
      const auth = req.headers.authorization ?? '';
      const m = /^Bearer\s+(.+)$/.exec(auth);
      if (!m) {
        res.writeHead(401, {
          'content-type': 'application/json',
          'www-authenticate': 'Bearer realm="restura-mock"',
        });
        res.end(JSON.stringify({ authenticated: false }));
        return;
      }
      json(res, 200, { authenticated: true, token: m[1] });
    },
  },
  // mTLS introspection: reports the client certificate the TLS layer accepted.
  // On a plain HTTP/HTTPS server (no `requestCert`) the peer cert is empty, so
  // this returns `mtls:false` + 401 — which is exactly how you tell a real
  // mutual-TLS handshake from an ordinary one.
  {
    method: 'GET',
    test: '/mtls/whoami',
    handle: ({ res, req }) => {
      const sock = req.socket as {
        getPeerCertificate?: (detailed?: boolean) => {
          subject?: Record<string, string>;
          issuer?: Record<string, string>;
          fingerprint?: string;
          valid_to?: string;
        };
      };
      const cert = sock.getPeerCertificate?.();
      const hasCert = !!cert && Object.keys(cert).length > 0;
      json(res, hasCert ? 200 : 401, {
        mtls: hasCert,
        subject: hasCert ? cert!.subject : null,
        issuer: hasCert ? cert!.issuer : null,
        fingerprint: hasCert ? cert!.fingerprint : null,
      });
    },
  },

  // -- Encoding / large body / chunked ---------------------------------------
  {
    method: 'GET',
    test: '/gzip',
    handle: ({ res }) => {
      const payload = Buffer.from(JSON.stringify({ gzipped: true, size: 'small' }));
      const compressed = gzipSync(payload);
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'content-length': String(compressed.length),
      });
      res.end(compressed);
    },
  },
  {
    method: 'GET',
    test: /^\/bytes\/(\d+)$/,
    handle: ({ res, match }) => {
      const n = Math.min(Number(match![1]), 5 * 1024 * 1024);
      const buf = Buffer.alloc(n, 0x61);
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(n),
      });
      res.end(buf);
    },
  },
  {
    method: 'GET',
    test: '/chunked',
    handle: ({ req, res }) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'transfer-encoding': 'chunked' });
      res.write('chunk-1\n');
      const t1 = setTimeout(() => res.write('chunk-2\n'), 30);
      const t2 = setTimeout(() => res.write('chunk-3\n'), 60);
      const t3 = setTimeout(() => res.end(), 90);
      req.on('close', () => {
        clearTimeout(t1);
        clearTimeout(t2);
        clearTimeout(t3);
      });
    },
  },

  // -- Redirects -------------------------------------------------------------
  {
    method: 'GET',
    test: '/redirect-to',
    handle: ({ res, url }) => {
      const target = url.searchParams.get('url');
      if (!target) {
        json(res, 400, { error: 'missing `url` query param' });
        return;
      }
      res.writeHead(302, { location: target });
      res.end();
    },
  },

  // -- Rate limit / 429 with Retry-After -------------------------------------
  {
    method: 'GET',
    test: '/rate-limit',
    handle: ({ res }) => {
      res.writeHead(429, {
        'content-type': 'application/json',
        'retry-after': '2',
      });
      res.end(JSON.stringify({ error: 'rate_limited' }));
    },
  },

  ...authRoutes,

  // -- Multipart upload echo -------------------------------------------------
  {
    method: 'POST',
    test: '/upload',
    handle: ({ res, req, body }) => {
      const ct = req.headers['content-type'] ?? '';
      const isMultipart = typeof ct === 'string' && ct.startsWith('multipart/form-data');
      const boundaryMatch = typeof ct === 'string' ? /boundary=("?)([^";]+)\1/.exec(ct) : null;
      if (!isMultipart || !boundaryMatch) {
        json(res, 400, { error: 'expected multipart/form-data' });
        return;
      }
      const boundary = `--${boundaryMatch[2]}`;
      const parts = body.split(boundary).filter((p) => p && !p.startsWith('--'));
      const fields: Array<{ name: string; filename?: string; size: number; preview: string }> = [];
      for (const part of parts) {
        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd === -1) continue;
        const headerBlock = part.slice(0, headerEnd);
        const value = part.slice(headerEnd + 4).replace(/\r\n$/, '');
        const nameMatch = /name="([^"]+)"/.exec(headerBlock);
        const filenameMatch = /filename="([^"]+)"/.exec(headerBlock);
        if (!nameMatch) continue;
        fields.push({
          name: nameMatch[1]!,
          ...(filenameMatch ? { filename: filenameMatch[1]! } : {}),
          size: value.length,
          preview: value.slice(0, 120),
        });
      }
      json(res, 200, { fields });
    },
  },
];

function matchRoute(
  req: IncomingMessage,
  path: string
): { route: Route; match: RegExpExecArray | null } | null {
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
  recorder.push({
    method: req.method ?? 'GET',
    path: path + url.search,
    headers: req.headers,
    body,
    secure: isSecure(req),
  });

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
  req.on('close', () => {
    aborted = true;
  });
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

interface GraphQLPayload {
  data?: unknown;
  errors?: Array<{
    message: string;
    path?: ReadonlyArray<string | number>;
    extensions?: Record<string, unknown>;
  }>;
}

async function executeOne(op: GraphQLBody): Promise<GraphQLPayload> {
  if (!op.query) {
    return { errors: [{ message: 'missing `query`' }] };
  }
  let document: DocumentNode;
  try {
    document = parse(op.query);
  } catch (err) {
    return { errors: [{ message: (err as Error).message }] };
  }
  const validationErrors = validate(graphqlSchema, document);
  if (validationErrors.length > 0) {
    return { errors: validationErrors.map((e) => ({ message: e.message })) };
  }
  const result = await execute({
    schema: graphqlSchema,
    document,
    variableValues: op.variables,
    operationName: op.operationName ?? undefined,
  });
  return {
    ...(result.data !== undefined ? { data: result.data } : {}),
    ...(result.errors
      ? {
          errors: result.errors.map((e) => ({
            message: e.message,
            ...(e.path ? { path: e.path } : {}),
            ...(e.extensions ? { extensions: e.extensions } : {}),
          })),
        }
      : {}),
  };
}

async function handleGraphQL(rawBody: string): Promise<{ status: number; body: unknown }> {
  let parsed: GraphQLBody | GraphQLBody[];
  try {
    parsed = JSON.parse(rawBody) as GraphQLBody | GraphQLBody[];
  } catch {
    return { status: 400, body: { errors: [{ message: 'invalid JSON' }] } };
  }

  if (Array.isArray(parsed)) {
    const results = await Promise.all(parsed.map(executeOne));
    return { status: 200, body: results };
  }

  const result = await executeOne(parsed);
  return {
    status: parsed.query ? 200 : 400,
    body: result,
  };
}

/** Optional overrides. `port` lets a standalone launcher pin a stable port; the
 * default `0` preserves the ephemeral-port behavior the e2e fixtures rely on. */
export interface StartHttpOptions {
  port?: number;
}

export interface StartHttpsOptions extends StartHttpOptions {
  /** Override the default self-signed leaf — e.g. a CA-signed server cert. */
  tls?: { key: string | Buffer; cert: string | Buffer; ca?: string | Buffer };
  /** Demand (and require) a client certificate — turns this into an mTLS server. */
  requestCert?: boolean;
}

async function startServer(
  server: HttpServer | HttpsServer,
  scheme: 'http' | 'https',
  port?: number
): Promise<MockHttpServerHandle> {
  const recorder: RecordedRequest[] = [];
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    handle(req, res, recorder).catch((err) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    });
  });
  const boundPort = await bindLocalhost(server, port);
  return {
    port: boundPort,
    url: `${scheme}://127.0.0.1:${boundPort}`,
    close: () => closeServer(server),
    requestCount: () => recorder.length,
    requests: () => recorder.slice(),
    reset: () => {
      recorder.splice(0, recorder.length);
      resetAuthState();
    },
  };
}

export function startMockHttpServer(opts: StartHttpOptions = {}): Promise<MockHttpServerHandle> {
  return startServer(createHttpServer(), 'http', opts.port);
}

export function startMockHttpsServer(opts: StartHttpsOptions = {}): Promise<MockHttpServerHandle> {
  const tls = opts.tls ?? getSelfSignedCert();
  const serverOpts: Parameters<typeof createHttpsServer>[0] = { key: tls.key, cert: tls.cert };
  if (opts.tls?.ca) serverOpts.ca = opts.tls.ca;
  if (opts.requestCert) {
    serverOpts.requestCert = true;
    serverOpts.rejectUnauthorized = true;
  }
  return startServer(createHttpsServer(serverOpts), 'https', opts.port);
}
