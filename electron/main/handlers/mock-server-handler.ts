/**
 * Desktop mock server. Binds a local HTTP listener (127.0.0.1 only) that
 * replays mock routes compiled by the renderer (`buildMockRoutes`). Lets users
 * point a frontend at http://127.0.0.1:PORT and get recorded/stub responses
 * without a live backend. Desktop-only — the web build can't bind a listener
 * (gated via capabilities `mock.localServer`).
 */
import http from 'node:http';
import { ipcMain } from 'electron';
import { z } from 'zod';
import { IPC } from '../../shared/channels';
import { assertTrustedSender } from '../ipc/ipc-validators';

export interface MockRoute {
  method: string;
  path: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  /** When 'base64', `body` is base64 of binary bytes and is served decoded. */
  bodyEncoding?: 'base64';
  delayMs?: number;
}

export interface MockServerStatus {
  running: boolean;
  port?: number;
  baseUrl?: string;
  collectionId?: string;
  routeCount?: number;
}

const RouteSchema: z.ZodType<MockRoute> = z.object({
  method: z.string().min(1).max(16),
  path: z.string().min(1).max(2048),
  status: z.number().int().min(100).max(599),
  headers: z.record(z.string(), z.string()),
  body: z.string().max(7 * 1024 * 1024), // headroom: base64 inflates bytes ~4/3
  bodyEncoding: z.literal('base64').optional(),
  delayMs: z.number().int().min(0).max(60_000).optional(),
});

const StartSchema = z.object({
  collectionId: z.string().min(1).max(256),
  // Port 0 lets the OS assign a free port (returned to the renderer).
  port: z.number().int().min(0).max(65535).optional(),
  routes: z.array(RouteSchema).max(2000),
});

// ---------------------------------------------------------------------------
// Pure matching / templating (exported for tests)
// ---------------------------------------------------------------------------

/** Build a RegExp for a route path: `:p`/`{p}` → one segment, trailing `*` → rest. */
function pathToRegExp(pattern: string): RegExp {
  const segments = pattern.split('/').map((seg) => {
    if (seg === '*') return '.*';
    if (/^[:{]/.test(seg)) return '[^/]+';
    return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  });
  return new RegExp(`^${segments.join('/')}/?$`);
}

/** First route whose method (or '*') and path pattern match. Exact paths win. */
export function matchRoute(
  routes: MockRoute[],
  method: string,
  pathname: string
): MockRoute | null {
  const candidates = routes.filter(
    (r) => r.method === '*' || r.method.toUpperCase() === method.toUpperCase()
  );
  // Prefer an exact path match before falling back to pattern matching.
  const exact = candidates.find((r) => r.path === pathname);
  if (exact) return exact;
  for (const r of candidates) {
    if (/[:{*]/.test(r.path) && pathToRegExp(r.path).test(pathname)) return r;
  }
  return null;
}

/** Expand a small set of dynamic tokens so mock bodies can vary per request. */
export function expandTemplate(body: string): string {
  return body
    .replace(/\{\{\$randomUUID\}\}/g, () => crypto.randomUUID())
    .replace(/\{\{\$timestamp\}\}/g, () => String(Math.floor(Date.now() / 1000)))
    .replace(/\{\{\$isoTimestamp\}\}/g, () => new Date().toISOString())
    .replace(/\{\{\$randomInt\}\}/g, () => String(Math.floor(Math.random() * 1000)));
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

interface ActiveServer {
  server: http.Server;
  port: number;
  collectionId: string;
  routes: MockRoute[];
}

let active: ActiveServer | null = null;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function startMockServer(opts: {
  collectionId: string;
  port?: number;
  routes: MockRoute[];
}): Promise<MockServerStatus> {
  await stopMockServer();

  const routes = opts.routes;
  const server = http.createServer((req, res) => {
    void (async () => {
      const method = req.method ?? 'GET';
      const pathname = (() => {
        try {
          return new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
        } catch {
          return req.url ?? '/';
        }
      })();

      const route = matchRoute(routes, method, pathname);
      if (!route) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'No matching mock route', method, path: pathname }));
        return;
      }
      if (route.delayMs && route.delayMs > 0) await delay(route.delayMs);
      const headers = { ...route.headers, 'x-restura-mock': 'true' };
      res.writeHead(route.status, headers);
      // Base64 routes carry binary bytes — decode and send raw, never templated.
      if (route.bodyEncoding === 'base64') {
        res.end(Buffer.from(route.body, 'base64'));
      } else {
        res.end(expandTemplate(route.body));
      }
    })();
  });

  return new Promise<MockServerStatus>((resolve, reject) => {
    server.once('error', (err) => reject(err));
    // 127.0.0.1 only — never expose the mock on a routable interface.
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : (opts.port ?? 0);
      active = { server, port, collectionId: opts.collectionId, routes };
      resolve({
        running: true,
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        collectionId: opts.collectionId,
        routeCount: routes.length,
      });
    });
  });
}

export async function stopMockServer(): Promise<MockServerStatus> {
  if (!active) return { running: false };
  const { server } = active;
  active = null;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return { running: false };
}

export function getMockStatus(): MockServerStatus {
  if (!active) return { running: false };
  return {
    running: true,
    port: active.port,
    baseUrl: `http://127.0.0.1:${active.port}`,
    collectionId: active.collectionId,
    routeCount: active.routes.length,
  };
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

export function registerMockServerIPC(): void {
  ipcMain.handle(IPC.mock.start, async (event, payload) => {
    assertTrustedSender(IPC.mock.start, event);
    const parsed = StartSchema.safeParse(payload);
    if (!parsed.success) return { ok: false, error: parsed.error.message };
    try {
      const status = await startMockServer(parsed.data);
      return { ok: true, status };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Failed to start mock server',
      };
    }
  });

  ipcMain.handle(IPC.mock.stop, async (event) => {
    assertTrustedSender(IPC.mock.stop, event);
    try {
      const status = await stopMockServer();
      return { ok: true, status };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Failed to stop mock server',
      };
    }
  });

  ipcMain.handle(IPC.mock.status, (event) => {
    assertTrustedSender(IPC.mock.status, event);
    return { ok: true, status: getMockStatus() };
  });
}

export function unregisterMockServerIPC(): void {
  ipcMain.removeHandler(IPC.mock.start);
  ipcMain.removeHandler(IPC.mock.stop);
  ipcMain.removeHandler(IPC.mock.status);
}
