import { ipcMain, webContents } from 'electron';
import { createRateLimiter } from './ipc-rate-limiter';
import {
  SseConnectSchema,
  SseDisconnectSchema,
  validateIpcInput,
  createValidatedHandler,
} from './ipc-validators';
import { SseParser, type ParsedSseEvent } from './lib/sse-parser';

const sseRateLimiter = createRateLimiter(20, 60_000);
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

function emitTo(webContentsId: number, channel: string, ...args: unknown[]): void {
  const wc = webContents.fromId(webContentsId);
  if (wc && !wc.isDestroyed()) {
    wc.send(channel, ...args);
  }
}

async function readStream(entry: ActiveSse, response: globalThis.Response): Promise<void> {
  if (!response.body) {
    emitTo(entry.webContentsId, `sse:error:${entry.connectionId}`, { message: 'No response body' });
    emitTo(entry.webContentsId, `sse:close:${entry.connectionId}`, { reason: 'no body' });
    activeConnections.delete(entry.connectionId);
    return;
  }

  const decoder = new TextDecoder();
  const parser = new SseParser();
  const reader = response.body.getReader();

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

    if (!sseRateLimiter()) {
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

    try {
      const response = await fetch(config.url, {
        method: 'GET',
        headers: { Accept: 'text/event-stream', ...(config.headers ?? {}) },
        signal: abortController.signal,
        redirect: 'follow',
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        emitTo(webContentsId, `sse:error:${connectionId}`, {
          message: `HTTP ${response.status} ${response.statusText}`,
        });
        emitTo(webContentsId, `sse:close:${connectionId}`, { reason: `HTTP ${response.status}` });
        activeConnections.delete(connectionId);
        return { success: false, error: `HTTP ${response.status} ${response.statusText}` };
      }

      emitTo(webContentsId, `sse:open:${connectionId}`);
      // Drain the stream in the background — we already returned success.
      void readStream(entry, response);
      return { success: true };
    } catch (err) {
      clearTimeout(timeoutId);
      activeConnections.delete(connectionId);
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
