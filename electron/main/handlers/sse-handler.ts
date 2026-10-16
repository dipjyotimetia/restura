import { executeHttpProxyStreaming } from '@shared/protocol/http-proxy';
import { RedirectPolicyError } from '@shared/protocol/redirect-follower';
import { createLogger } from '@shared/runtime/logger';
import { ipcMain, type WebContents } from 'electron';
import { EVENT_PREFIX, IPC } from '../../shared/channels';
import { bindRendererCleanup, disposeByOwner } from '../ipc/connection-cleanup';
import { createKeyedRateLimiter } from '../ipc/ipc-rate-limiter';
import {
  assertTrustedSender,
  createValidatedEventHandler,
  SseConnectSchema,
  SseDisconnectSchema,
  validateIpcInput,
} from '../ipc/ipc-validators';
import { ownerScopedKey, StreamRegistry } from '../ipc/stream-registry';
import { getExecutionPolicy } from '../security/execution-policy';
import {
  assertPinnedFetchCanHonorPolicy,
  createPolicyPinnedFetch,
  type PolicyTransportConfig,
  resolvePolicyTransport,
} from '../security/policy-transport';
import { resolveSafeAddress } from '../security/safe-connect';
import {
  materializeStreamingAuth,
  needsWsHandshakeMaterialization,
  type SecretRedactor,
  SSE_REQUEST_TRANSPORT,
} from '../security/ws-handshake-auth';
import { makeFetchFetcher } from './fetch-fetcher';
import { type ParsedSseEvent, SseParser } from './sse-parser';

const log = createLogger('sse');

export const sseRateLimiter = createKeyedRateLimiter(20, 60_000);
const MAX_CONCURRENT_SSE_CONNECTIONS = 50;
const CONNECTION_TIMEOUT_MS = 30_000;

/** Apply acknowledged desktop defaults before establishing an SSE stream. */
export function resolveSseExecutionPolicy<T extends PolicyTransportConfig>(config: T) {
  return resolvePolicyTransport(config);
}

interface ActiveSse {
  connectionId: string;
  url: string;
  abortController: AbortController;
  webContentsId: number;
  createdAt: number;
  /** Set to true when the renderer explicitly disconnects, to suppress the "stream closed" event */
  explicitlyClosed: boolean;
  /** Scrubs main-resolved credentials (graphql-sse, #882) from events and logs. */
  redact: SecretRedactor;
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

interface PendingSseClaim {
  webContentsId: number;
  token: symbol;
  ownerEntry?: ActiveSse;
  /**
   * Present only for connects resolving opaque credentials main-side
   * (graphql-sse, #878/#882): aborted when the claim is cancelled
   * (sse:disconnect, renderer destroyed, teardown).
   */
  abort?: AbortController;
}

const pendingConnections = new Map<string, PendingSseClaim>();

function reserveSseClaim(
  connectionId: string,
  webContents: WebContents,
  cancellable = false
): PendingSseClaim | undefined {
  const key = ownerScopedKey(connectionId, webContents.id);
  if (pendingConnections.has(key)) return undefined;

  const ownerEntry = connections.getForOwner(connectionId, webContents.id);

  const claim: PendingSseClaim = {
    webContentsId: webContents.id,
    token: Symbol(connectionId),
    ownerEntry,
    ...(cancellable ? { abort: new AbortController() } : {}),
  };
  pendingConnections.set(key, claim);
  bindRendererCleanup(pendingConnections, webContents, (deadId) =>
    disposeByOwner(pendingConnections, deadId, (pending) => pending.abort?.abort())
  );
  return pendingConnections.get(key) === claim ? claim : undefined;
}

function isSseClaimLive(connectionId: string, claim: PendingSseClaim): boolean {
  return (
    pendingConnections.get(ownerScopedKey(connectionId, claim.webContentsId))?.token === claim.token
  );
}

function releaseSseClaim(connectionId: string, claim: PendingSseClaim): void {
  const key = ownerScopedKey(connectionId, claim.webContentsId);
  if (pendingConnections.get(key)?.token === claim.token) {
    pendingConnections.delete(key);
  }
}

async function readStream(
  entry: ActiveSse,
  body: ReadableStream<Uint8Array> | null
): Promise<void> {
  const { connectionId, webContentsId } = entry;
  if (!body) {
    if (connections.get(connectionId, webContentsId) === entry) {
      connections.emit(connectionId, webContentsId, 'error', { message: 'No response body' });
      connections.emitAndRemove(connectionId, webContentsId, 'close', { reason: 'no body' });
    }
    return;
  }

  const decoder = new TextDecoder();
  const parser = new SseParser();
  const reader = body.getReader();

  const onEvent = (e: ParsedSseEvent) => {
    if (connections.get(connectionId, webContentsId) !== entry) return;
    connections.emit(connectionId, webContentsId, 'event', e);
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
      const message = entry.redact(err instanceof Error ? err.message : 'Stream read error');
      log.warn('stream read error', { connectionId: entry.connectionId, error: message });
      connections.emit(connectionId, webContentsId, 'error', { message });
    }
  } finally {
    // Releasing the reader lets the underlying socket be closed promptly instead
    // of waiting for GC — important under the per-connection cap.
    try {
      await reader.cancel();
    } catch {
      /* already done */
    }
    if (connections.get(connectionId, webContentsId) !== entry) return;
    if (!entry.explicitlyClosed) {
      connections.emitAndRemove(connectionId, webContentsId, 'close', { reason: 'stream ended' });
    } else {
      connections.remove(connectionId, webContentsId);
    }
  }
}

export function registerSseHandlerIPC(): void {
  // sse:connect is registered manually so we can capture event.sender.id for targeted IPC.
  ipcMain.handle(IPC.sse.connect, async (event, rawConfig: unknown) => {
    assertTrustedSender(IPC.sse.connect, event);
    const validated = validateIpcInput(SseConnectSchema, rawConfig, IPC.sse.connect);
    const { connectionId } = validated;
    const webContentsId = event.sender.id;
    // graphql-sse (#878/#882) may carry SecretRef-handle auth / SecretRef-backed
    // {{vars}} that only main can resolve (ADR-0007).
    const materialize = needsWsHandshakeMaterialization(validated);
    let config = validated;

    let policyConfig: ReturnType<typeof resolveSseExecutionPolicy>;
    try {
      policyConfig = resolveSseExecutionPolicy(config);
      assertPinnedFetchCanHonorPolicy(policyConfig);
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Connection policy rejected',
      };
    }

    if (!sseRateLimiter.check(webContentsId)) {
      return { success: false, error: 'Rate limit exceeded. Please wait before connecting.' };
    }
    if (connections.size() + pendingConnections.size >= MAX_CONCURRENT_SSE_CONNECTIONS) {
      return { success: false, error: 'Too many open connections.' };
    }

    // Reserve this renderer's id synchronously before DNS or transport
    // construction. Another renderer may independently use the same external id.
    const claim = reserveSseClaim(connectionId, event.sender, materialize);
    if (!claim) return { success: false, error: 'Not connected' };

    let claimedEntry: ActiveSse | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    // Scrubs resolved plaintext from replies, events and logs for this connect.
    let redact: SecretRedactor = (text) => text;
    try {
      if (materialize) {
        // After the rate / capacity gates, before the SSRF check (which must
        // see the final URL); cancelled via the claim's signal.
        try {
          const materialized = await materializeStreamingAuth(
            {
              url: validated.url,
              headers: validated.headers,
              auth: validated.auth,
              secretVariables: validated.secretVariables,
            },
            SSE_REQUEST_TRANSPORT,
            claim.abort?.signal
          );
          config = { ...validated, url: materialized.url, headers: materialized.headers };
          redact = materialized.redact;
        } catch (err) {
          if (!isSseClaimLive(connectionId, claim)) {
            return { success: false, error: 'Not connected' };
          }
          // Materializer errors are plaintext-free by construction.
          return {
            success: false,
            error: `SSE auth setup failed: ${err instanceof Error ? err.message : 'unknown error'}`,
          };
        }
        if (!isSseClaimLive(connectionId, claim)) return { success: false, error: 'Not connected' };
        try {
          policyConfig = resolveSseExecutionPolicy(config);
          assertPinnedFetchCanHonorPolicy(policyConfig);
        } catch (err) {
          return {
            success: false,
            error: redact(err instanceof Error ? err.message : 'Connection policy rejected'),
          };
        }
      }

      // Resolve + validate once, then PIN the connection to that IP (closes the
      // DNS-rebind window a pre-flight-only check leaves open). createPinnedFetch
      // keeps SNI + Host header on the original hostname for TLS correctness.
      let pinned: Awaited<ReturnType<typeof resolveSafeAddress>>;
      try {
        pinned = await resolveSafeAddress(policyConfig.url, { ...getExecutionPolicy().security });
      } catch (err) {
        return {
          success: false,
          error: redact(err instanceof Error ? err.message : 'URL rejected by SSRF policy'),
        };
      }

      // Renderer destruction/module teardown may invalidate the reservation
      // while DNS is pending. Never construct a transport for a stale claim.
      const key = ownerScopedKey(connectionId, webContentsId);
      if (pendingConnections.get(key)?.token !== claim.token) {
        return { success: false, error: 'Not connected' };
      }

      const abortController = new AbortController();
      timeoutId = setTimeout(
        () => abortController.abort(),
        policyConfig.timeout ?? CONNECTION_TIMEOUT_MS
      );

      const entry: ActiveSse = {
        connectionId,
        url: config.url,
        abortController,
        webContentsId,
        createdAt: Date.now(),
        explicitlyClosed: false,
        redact,
      };

      // Commit only the exact live reservation. A reconnect may replace only
      // the same renderer's still-current entry.
      const claimed =
        pendingConnections.get(key)?.token === claim.token &&
        (claim.ownerEntry
          ? connections.get(connectionId, webContentsId) === claim.ownerEntry &&
            connections.replaceForOwner(connectionId, webContentsId, entry)
          : connections.tryAdd(connectionId, event.sender, entry));
      if (!claimed) {
        entry.explicitlyClosed = true;
        abortController.abort();
        if (timeoutId !== undefined) clearTimeout(timeoutId);
        return { success: false, error: 'Not connected' };
      }
      claimedEntry = entry;

      // `redirect: 'manual'` so followRedirects can validate every hop (matches
      // the Worker proxy's policy — Location pointing at metadata IPs etc. is
      // rejected before we connect). `fetchImpl` is DNS-pinned to the address we
      // just validated so the connect can't be rebound out from under us.
      const sseFetcher = makeFetchFetcher({
        redirect: 'manual',
        fetchImpl: createPolicyPinnedFetch(policyConfig, pinned),
      });

      // Same orchestrator as the HTTP handler so SSE inherits the SSRF /
      // header / redirect / auth pipeline. resolveSafeAddress above validated
      // the address and the pinned fetcher dials it directly, so the rebind
      // window the URL parse can't cover is now closed.
      const result = await executeHttpProxyStreaming(
        {
          // graphql-sse (#889) POSTs its operation; plain SSE stays a GET.
          method: config.jsonBody !== undefined ? 'POST' : 'GET',
          url: policyConfig.url,
          headers: { Accept: 'text/event-stream', ...(config.headers ?? {}) },
          ...(config.jsonBody !== undefined
            ? { bodyType: 'json' as const, data: config.jsonBody }
            : {}),
          timeout: policyConfig.timeout,
          // Never replay main-resolved credentials across a redirect (scheme
          // downgrade / path change): a 3xx is returned unfollowed → error.
          ...(materialize ? { redirectPolicy: { maxRedirects: 0 } } : {}),
        },
        sseFetcher,
        // Same outbound-network policy as every other desktop transport
        // (Settings → Security), so localhost/private-IP rules stay consistent.
        { ...getExecutionPolicy().security }
      );
      if (timeoutId !== undefined) clearTimeout(timeoutId);

      if (!result.ok) {
        const message = redact(result.payload.error);
        if (connections.get(connectionId, webContentsId) === entry) {
          connections.emit(connectionId, webContentsId, 'error', { message });
          connections.emitAndRemove(connectionId, webContentsId, 'close', { reason: message });
        }
        return { success: false, error: message };
      }

      const response = result.response;
      if (response.status < 200 || response.status >= 300) {
        if (connections.get(connectionId, webContentsId) === entry) {
          connections.emit(connectionId, webContentsId, 'error', {
            message: `HTTP ${response.status} ${response.statusText}`,
          });
          connections.emitAndRemove(connectionId, webContentsId, 'close', {
            reason: `HTTP ${response.status}`,
          });
        }
        return { success: false, error: `HTTP ${response.status} ${response.statusText}` };
      }

      if (connections.get(connectionId, webContentsId) !== entry) {
        return { success: false, error: 'Not connected' };
      }
      connections.emit(connectionId, webContentsId, 'open');
      // Drain the stream in the background — we already returned success.
      void readStream(entry, response.body ?? null);
      return { success: true };
    } catch (err) {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      if (claimedEntry && connections.get(connectionId, webContentsId) === claimedEntry) {
        connections.remove(connectionId, webContentsId);
      }
      if (err instanceof RedirectPolicyError) {
        const message = redact(err.message);
        log.warn('connect rejected by redirect policy', { connectionId, error: message });
        return { success: false, error: message };
      }
      const message = redact(err instanceof Error ? err.message : 'Connection failed');
      log.warn('connect failed', { connectionId, error: message });
      return { success: false, error: message };
    } finally {
      releaseSseClaim(connectionId, claim);
    }
  });

  ipcMain.handle(
    IPC.sse.disconnect,
    createValidatedEventHandler(IPC.sse.disconnect, SseDisconnectSchema, async (config, event) => {
      // A graphql-sse connect still resolving main-side credentials is
      // cancelled outright (plain connects keep their existing semantics).
      const pendingKey = ownerScopedKey(config.connectionId, event.sender.id);
      const pending = pendingConnections.get(pendingKey);
      if (pending?.abort) {
        pending.abort.abort();
        pendingConnections.delete(pendingKey);
      }
      // Missing and wrong-owner ids are deliberately indistinguishable.
      connections.cancelForOwner(config.connectionId, event.sender.id);
      return { success: true };
    })
  );
}

export function stopSseCleanup(): void {
  for (const pending of pendingConnections.values()) pending.abort?.abort();
  pendingConnections.clear();
  connections.disposeAll();
}
