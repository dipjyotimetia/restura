/**
 * Capture desktop bridge. Binds a 127.0.0.1-only HTTP listener that the Restura
 * browser extension POSTs captured sessions to. On receipt it validates the
 * payload (auth token + loopback origin + Zod schema), converts the session to
 * an OpenCollection document via the shared capture core, and pushes it to the
 * renderer to import. Desktop-only — gated via capabilities `capture.desktopBridge`.
 *
 * Security: see `capture-bridge-protocol.ts` for the auth/origin checks. The
 * server binds loopback only, requires a freshly-generated per-pairing bearer
 * token (written to a handshake file under userData), and rejects any request
 * whose Origin is not the extension or loopback (DNS-rebind / CSRF defence).
 */
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { sessionToOpenCollection } from '@shared/capture/to-opencollection';
import { type BrowserWindow, ipcMain } from 'electron';
import { IPC, EVENT } from '../../shared/channels';
import { createKeyedRateLimiter, rateLimited } from '../ipc/ipc-rate-limiter';
import { assertTrustedSender } from '../ipc/ipc-validators';
import { bridgePayloadSchema, isAuthorized, isLoopbackRequest } from './capture-bridge-protocol';

/** Hard cap on the request body before we even parse it (matches the Zod bounds). */
const MAX_BODY_BYTES = 16 * 1024 * 1024;

export interface BridgeStatus {
  running: boolean;
  port?: number;
}

interface ActiveBridge {
  server: http.Server;
  port: number;
  token: string;
}

let active: ActiveBridge | null = null;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function startCaptureBridge(
  getMainWindow: () => BrowserWindow | null
): Promise<BridgeStatus> {
  await stopCaptureBridge();
  const token = randomBytes(32).toString('base64url');

  const server = http.createServer((req, res) => {
    void (async () => {
      const reply = (status: number, body: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };

      if (
        req.method !== 'POST' ||
        new URL(req.url ?? '/', 'http://127.0.0.1').pathname !== '/ingest'
      ) {
        reply(404, { error: 'not found' });
        return;
      }
      if (!isLoopbackRequest(req.headers)) {
        reply(403, { error: 'forbidden origin' });
        return;
      }
      if (!isAuthorized(req.headers, active?.token ?? '')) {
        reply(401, { error: 'unauthorized' });
        return;
      }
      let raw: string;
      try {
        raw = await readBody(req);
      } catch {
        reply(413, { error: 'payload too large' });
        return;
      }
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        reply(400, { error: 'invalid json' });
        return;
      }
      const parsed = bridgePayloadSchema.safeParse(json);
      if (!parsed.success) {
        reply(422, { error: 'invalid payload' });
        return;
      }
      const doc = sessionToOpenCollection(parsed.data.session, {
        name: parsed.data.name ?? 'Captured Session',
      });
      getMainWindow()?.webContents.send(EVENT.captureReceived, doc);
      reply(200, { ok: true, items: doc.items.length });
    })();
  });

  // Slow-loris guards for the inbound listener (loopback-bound, low impact, but
  // a token-holder shouldn't be able to hold the socket open indefinitely).
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;

  return new Promise<BridgeStatus>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      active = { server, port, token };
      // Pairing is via the renderer: `start` returns { port, token } over IPC and
      // the settings UI shows a `<port>:<token>` code the user pastes into the
      // extension. (No handshake file — a sandboxed extension can't read it.)
      resolve({ running: true, port });
    });
  });
}

export async function stopCaptureBridge(): Promise<BridgeStatus> {
  if (!active) return { running: false };
  const { server } = active;
  active = null;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return { running: false };
}

export function getCaptureBridgeStatus(): BridgeStatus {
  return active ? { running: true, port: active.port } : { running: false };
}

// Lifecycle IPC is low-frequency (start/stop/status from the trusted renderer);
// a modest per-webContents quota guards against a runaway caller.
const bridgeRateLimiter = createKeyedRateLimiter(30, 60_000);

export function registerCaptureBridgeIPC(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle(
    IPC.captureBridge.start,
    rateLimited(bridgeRateLimiter, async (event) => {
      assertTrustedSender(IPC.captureBridge.start, event);
      try {
        const status = await startCaptureBridge(getMainWindow);
        // The token is returned only to the trusted renderer so it can show the
        // pairing code; it is never exposed over the HTTP surface.
        return { ok: true, status, token: active?.token };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'failed to start bridge' };
      }
    })
  );

  ipcMain.handle(
    IPC.captureBridge.stop,
    rateLimited(bridgeRateLimiter, async (event) => {
      assertTrustedSender(IPC.captureBridge.stop, event);
      const status = await stopCaptureBridge();
      return { ok: true, status };
    })
  );

  ipcMain.handle(
    IPC.captureBridge.status,
    rateLimited(bridgeRateLimiter, (event) => {
      assertTrustedSender(IPC.captureBridge.status, event);
      return { ok: true, status: getCaptureBridgeStatus() };
    })
  );
}

export function unregisterCaptureBridgeIPC(): void {
  ipcMain.removeHandler(IPC.captureBridge.start);
  ipcMain.removeHandler(IPC.captureBridge.stop);
  ipcMain.removeHandler(IPC.captureBridge.status);
}
