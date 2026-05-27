import { ipcMain } from 'electron';
import { createKeyedRateLimiter } from './ipc-rate-limiter';
import { emitTo } from './ipc-utils';
import { bindRendererCleanup, disposeByOwner } from './connection-cleanup';
import { assertUrlHostnameSafe } from './dns-guard';
import {
  SseConnectSchema,
  SseDisconnectSchema,
  validateIpcInput,
  createValidatedHandler,
} from './ipc-validators';
import { SseParser, type ParsedSseEvent } from './lib/sse-parser';
import { executeHttpProxyStreaming } from '@shared/protocol/http-proxy';
import { RedirectPolicyError } from '@shared/protocol/redirect-follower';
import { makeFetchFetcher } from './fetch-fetcher';

export const sseRateLimiter = createKeyedRateLimiter(20, 60_000);
const MAX_CONCURRENT_SSE_CONNECTIONS = 50;
const CONNECTION_TIMEOUT_MS = 30_000;

interface ActiveSse {
  connectionId: string;
  url: string;
  abortController: AbortController;
  webContentsId: number;
  createdAt: number;
  /** Set to true when the renderer explicitly disconnects, to suppress the "stream closed" event */
  explicitlyClosed: boolean;
}

const activeConnections = new Map<string, ActiveSse>();

async function readStream(
  entry: ActiveSse,
  body: ReadableStream<Uint8Array> | null
): Promise<void> {
  if (!body) {
    emitTo(entry.webContentsId, `sse:error:${entry.connectionId}`, { message: 'No response body' });
    emitTo(entry.webContentsId, `sse:close:${entry.connectionId}`, { reason: 'no body' });
    activeConnections.delete(entry.connectionId);
    return;
  }

  const decoder = new TextDecoder();
  const parser = new SseParser();
  const reader = body.getReader();

  const onEvent = (e: ParsedSseEvent) => {
    emitTo(entry.webContentsId, `sse:event:${entry.connectionId}`, e);
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.feed(decoder.decode(value, { stream: true }), onEvent);
    }
    parser.feed(decoder.decode(), onEvent);
  } catch (err) {
    if (!entry.explicitlyClosed) {
      emitTo(entry.webContentsId, `sse:error:${entry.connectionId}`, {
        message: err instanceof Error ? err.message : 'Stream read error',
      });
    }
  } finally {
    // Releasing the reader lets the underlying socket be closed promptly instead
    // of waiting for GC — important under the per-connection cap.
    try { await reader.cancel(); } catch { /* already done */ }
    activeConnections.delete(entry.connectionId);
    if (!entry.explicitlyClosed) {
      emitTo(entry.webContentsId, `sse:close:${entry.connectionId}`, { reason: 'stream ended' });
    }
  }
}

export function registerSseHandlerIPC(): void {
  // sse:connect is registered manually so we can capture event.sender.id for targeted IPC.
  ipcMain.handle('sse:connect', async (event, rawConfig: unknown) => {
    const config = validateIpcInput(SseConnectSchema, rawConfig, 'sse:connect');
    const { connectionId } = config;
    const webContentsId = event.sender.id;

    if (!sseRateLimiter.check(webContentsId)) {
      return { success: false, error: 'Rate limit exceeded. Please wait before connecting.' };
    }
    if (activeConnections.size >= MAX_CONCURRENT_SSE_CONNECTIONS) {
      return { success: false, error: 'Too many open connections.' };
    }

    // Close existing connection with same id
    const existing = activeConnections.get(connectionId);
    if (existing) {
      existing.explicitlyClosed = true;
      existing.abortController.abort();
      activeConnections.delete(connectionId);
    }

    try {
      await assertUrlHostnameSafe(config.url, { allowLocalhost: true });
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'URL rejected by SSRF policy' };
    }

    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), CONNECTION_TIMEOUT_MS);

    const entry: ActiveSse = {
      connectionId,
      url: config.url,
      abortController,
      webContentsId,
      createdAt: Date.now(),
      explicitlyClosed: false,
    };
    activeConnections.set(connectionId, entry);

    bindRendererCleanup(activeConnections, event.sender, (deadId) => {
      disposeByOwner(activeConnections, deadId, (e) => {
        e.explicitlyClosed = true;
        try { e.abortController.abort(); } catch { /* ignore */ }
      });
    });

    // `redirect: 'manual'` so followRedirects can validate every hop (matches
    // the Worker proxy's policy — Location pointing at metadata IPs etc. is
    // rejected before we connect). Shared adapter; see fetch-fetcher.ts.
    const sseFetcher = makeFetchFetcher({ redirect: 'manual' });

    try {
      // Same orchestrator as the HTTP handler so SSE inherits the SSRF /
      // header / redirect / auth pipeline. assertUrlHostnameSafe above
      // is the pre-flight DNS guard (covers rebind windows the URL
      // parse can't).
      const result = await executeHttpProxyStreaming(
        {
          method: 'GET',
          url: config.url,
          headers: { Accept: 'text/event-stream', ...(config.headers ?? {}) },
        },
        sseFetcher,
        // SSE handler is desktop-only; mirror http-handler's permissive localhost
        // policy (Electron users routinely target local dev servers).
        { allowLocalhost: true }
      );
      clearTimeout(timeoutId);

      if (!result.ok) {
        emitTo(webContentsId, `sse:error:${connectionId}`, { message: result.payload.error });
        emitTo(webContentsId, `sse:close:${connectionId}`, { reason: result.payload.error });
        activeConnections.delete(connectionId);
        return { success: false, error: result.payload.error };
      }

      const response = result.response;
      if (response.status < 200 || response.status >= 300) {
        emitTo(webContentsId, `sse:error:${connectionId}`, {
          message: `HTTP ${response.status} ${response.statusText}`,
        });
        emitTo(webContentsId, `sse:close:${connectionId}`, { reason: `HTTP ${response.status}` });
        activeConnections.delete(connectionId);
        return { success: false, error: `HTTP ${response.status} ${response.statusText}` };
      }

      emitTo(webContentsId, `sse:open:${connectionId}`);
      // Drain the stream in the background — we already returned success.
      void readStream(entry, response.body ?? null);
      return { success: true };
    } catch (err) {
      clearTimeout(timeoutId);
      activeConnections.delete(connectionId);
      if (err instanceof RedirectPolicyError) {
        return { success: false, error: err.message };
      }
      const message = err instanceof Error ? err.message : 'Connection failed';
      return { success: false, error: message };
    }
  });

  ipcMain.handle(
    'sse:disconnect',
    createValidatedHandler('sse:disconnect', SseDisconnectSchema, async (config) => {
      const entry = activeConnections.get(config.connectionId);
      if (entry) {
        entry.explicitlyClosed = true;
        entry.abortController.abort();
        activeConnections.delete(config.connectionId);
      }
      return { success: true };
    })
  );
}

export function stopSseCleanup(): void {
  for (const entry of activeConnections.values()) {
    try {
      entry.explicitlyClosed = true;
      entry.abortController.abort();
    } catch {
      /* ignore */
    }
  }
  activeConnections.clear();
}
