import { ipcMain } from 'electron';
import { createKeyedRateLimiter } from '../ipc/ipc-rate-limiter';
import { StreamRegistry } from '../ipc/stream-registry';
import { resolveSafeAddress, createPinnedFetch } from '../security/safe-connect';
import {
  SseConnectSchema,
  SseDisconnectSchema,
  validateIpcInput,
  createValidatedHandler,
  assertTrustedSender,
} from '../ipc/ipc-validators';
import { SseParser, type ParsedSseEvent } from './sse-parser';
import { IPC, EVENT_PREFIX } from '../../shared/channels';
import { executeHttpProxyStreaming } from '@shared/protocol/http-proxy';
import { RedirectPolicyError } from '@shared/protocol/redirect-follower';
import { makeFetchFetcher } from './fetch-fetcher';
import { createLogger } from '../../../src/lib/shared/logger';

const log = createLogger('sse');

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

// Shared connection bookkeeping (map + same-id replace + renderer-destroyed
// cleanup + per-connection event emit + disposeAll). dispose() encapsulates the
// SSE-specific teardown: flag the connection as explicitly closed (so the read
// loop suppresses the trailing error/close events) and abort the fetch.
const connections = new StreamRegistry<ActiveSse>({
  prefixes: EVENT_PREFIX.sse,
  dispose: (e) => {
    e.explicitlyClosed = true;
    e.abortController.abort();
  },
});

async function readStream(
  entry: ActiveSse,
  body: ReadableStream<Uint8Array> | null
): Promise<void> {
  if (!body) {
    connections.emit(entry.connectionId, 'error', { message: 'No response body' });
    connections.emitAndRemove(entry.connectionId, 'close', { reason: 'no body' });
    return;
  }

  const decoder = new TextDecoder();
  const parser = new SseParser();
  const reader = body.getReader();

  const onEvent = (e: ParsedSseEvent) => {
    connections.emit(entry.connectionId, 'event', e);
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
      const message = err instanceof Error ? err.message : 'Stream read error';
      log.warn('stream read error', { connectionId: entry.connectionId, error: message });
      connections.emit(entry.connectionId, 'error', { message });
    }
  } finally {
    // Releasing the reader lets the underlying socket be closed promptly instead
    // of waiting for GC — important under the per-connection cap.
    try {
      await reader.cancel();
    } catch {
      /* already done */
    }
    if (!entry.explicitlyClosed) {
      connections.emitAndRemove(entry.connectionId, 'close', { reason: 'stream ended' });
    } else {
      connections.remove(entry.connectionId);
    }
  }
}

export function registerSseHandlerIPC(): void {
  // sse:connect is registered manually so we can capture event.sender.id for targeted IPC.
  ipcMain.handle(IPC.sse.connect, async (event, rawConfig: unknown) => {
    assertTrustedSender(IPC.sse.connect, event);
    const config = validateIpcInput(SseConnectSchema, rawConfig, IPC.sse.connect);
    const { connectionId } = config;
    const webContentsId = event.sender.id;

    if (!sseRateLimiter.check(webContentsId)) {
      return { success: false, error: 'Rate limit exceeded. Please wait before connecting.' };
    }
    if (connections.size() >= MAX_CONCURRENT_SSE_CONNECTIONS) {
      return { success: false, error: 'Too many open connections.' };
    }

    // Close an existing connection with the same id (dispose aborts it) before
    // we start a new one — frees the socket promptly.
    connections.cancel(connectionId);

    // Resolve + validate once, then PIN the connection to that IP (closes the
    // DNS-rebind window a pre-flight-only check leaves open). createPinnedFetch
    // keeps SNI + Host header on the original hostname for TLS correctness.
    let pinned: Awaited<ReturnType<typeof resolveSafeAddress>>;
    try {
      pinned = await resolveSafeAddress(config.url, { allowLocalhost: true });
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'URL rejected by SSRF policy',
      };
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
    // add() stores the entry and wires renderer-destroyed cleanup (dispose aborts).
    connections.add(connectionId, event.sender, entry);

    // `redirect: 'manual'` so followRedirects can validate every hop (matches
    // the Worker proxy's policy — Location pointing at metadata IPs etc. is
    // rejected before we connect). `fetchImpl` is DNS-pinned to the address we
    // just validated so the connect can't be rebound out from under us.
    const sseFetcher = makeFetchFetcher({
      redirect: 'manual',
      fetchImpl: createPinnedFetch(pinned.host, pinned.ip),
    });

    try {
      // Same orchestrator as the HTTP handler so SSE inherits the SSRF /
      // header / redirect / auth pipeline. resolveSafeAddress above validated
      // the address and the pinned fetcher dials it directly, so the rebind
      // window the URL parse can't cover is now closed.
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
        connections.emit(connectionId, 'error', { message: result.payload.error });
        connections.emitAndRemove(connectionId, 'close', { reason: result.payload.error });
        return { success: false, error: result.payload.error };
      }

      const response = result.response;
      if (response.status < 200 || response.status >= 300) {
        connections.emit(connectionId, 'error', {
          message: `HTTP ${response.status} ${response.statusText}`,
        });
        connections.emitAndRemove(connectionId, 'close', { reason: `HTTP ${response.status}` });
        return { success: false, error: `HTTP ${response.status} ${response.statusText}` };
      }

      connections.emit(connectionId, 'open');
      // Drain the stream in the background — we already returned success.
      void readStream(entry, response.body ?? null);
      return { success: true };
    } catch (err) {
      clearTimeout(timeoutId);
      connections.remove(connectionId);
      if (err instanceof RedirectPolicyError) {
        log.warn('connect rejected by redirect policy', { connectionId, error: err.message });
        return { success: false, error: err.message };
      }
      const message = err instanceof Error ? err.message : 'Connection failed';
      log.warn('connect failed', { connectionId, error: message });
      return { success: false, error: message };
    }
  });

  ipcMain.handle(
    IPC.sse.disconnect,
    createValidatedHandler(IPC.sse.disconnect, SseDisconnectSchema, async (config) => {
      // cancel() disposes (sets explicitlyClosed + aborts) and removes the entry.
      connections.cancel(config.connectionId);
      return { success: true };
    })
  );
}

export function stopSseCleanup(): void {
  connections.disposeAll();
}
