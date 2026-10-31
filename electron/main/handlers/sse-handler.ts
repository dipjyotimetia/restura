import { executeHttpProxyStreaming } from '@shared/protocol/http-proxy';
import { RedirectPolicyError } from '@shared/protocol/redirect-follower';
import { isReconnectableSseResponse } from '@shared/protocol/sse-parser';
import { createLogger } from '@shared/runtime/logger';
import { ipcMain } from 'electron';
import { EVENT_PREFIX, IPC } from '../../shared/channels';
import type { SseClosePayload } from '../../types/api/protocols';
import { createKeyedRateLimiter } from '../ipc/ipc-rate-limiter';
import {
  assertTrustedSender,
  createValidatedEventHandler,
  SseConnectSchema,
  SseDisconnectSchema,
  validateIpcInput,
} from '../ipc/ipc-validators';
import { StreamRegistry } from '../ipc/stream-registry';
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

/** Apply acknowledged desktop defaults before establishing an SSE stream. */
export function resolveSseExecutionPolicy<T extends PolicyTransportConfig>(config: T) {
  return resolvePolicyTransport(config);
}

interface ActiveSse {
  connectionId: string;
  url: string;
  /**
   * Aborts the upstream request for the stream's whole lifetime (chained into
   * the shared proxy's controller) — disconnect / renderer destroy / teardown.
   */
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
interface SseClaimFields {
  /**
   * Present only for connects resolving opaque credentials main-side
   * (graphql-sse, #878/#882): aborted when the claim is cancelled
   * (sse:disconnect, renderer destroyed, teardown).
   */
  abort?: AbortController;
}

const connections = new StreamRegistry<ActiveSse, SseClaimFields>({
  prefixes: EVENT_PREFIX.sse,
  dispose: (e) => {
    e.explicitlyClosed = true;
    e.abortController.abort();
  },
  disposeClaim: (claim) => claim.abort?.abort(),
});

function redactSseEvent(e: ParsedSseEvent, redact: SecretRedactor): ParsedSseEvent {
  // Every string field (data, event, lastEventId, …) — not a fixed list, so a
  // parser field added later can't become an unredacted side channel.
  const out = { ...e } as ParsedSseEvent & Record<string, unknown>;
  for (const [key, value] of Object.entries(out)) {
    if (typeof value === 'string') out[key] = redact(value);
  }
  return out;
}

/** Release an unread upstream body (non-2xx / stale-claim early returns). */
function discardBody(body: ReadableStream<Uint8Array> | null | undefined): void {
  body?.cancel().catch(() => {});
}

async function readStream(
  entry: ActiveSse,
  body: ReadableStream<Uint8Array> | null,
  reconnectable: boolean
): Promise<void> {
  const { connectionId, webContentsId } = entry;
  if (!body) {
    if (connections.get(connectionId, webContentsId) === entry) {
      connections.emit(connectionId, webContentsId, 'error', { message: 'No response body' });
      connections.emitAndRemove(connectionId, webContentsId, 'close', {
        reason: 'no body',
        ...(reconnectable ? {} : { fatal: true }),
      } satisfies SseClosePayload);
    }
    return;
  }

  const decoder = new TextDecoder();
  const parser = new SseParser();
  const reader = body.getReader();

  const onEvent = (e: ParsedSseEvent) => {
    if (connections.get(connectionId, webContentsId) !== entry) return;
    // A server reflecting a main-resolved credential back (graphql-sse, #882)
    // must not hand it to the renderer. Identity for plain SSE.
    connections.emit(connectionId, webContentsId, 'event', redactSseEvent(e, entry.redact));
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
      const lastEventId = parser.getLastEventId();
      const retry = parser.getReconnectionTime();
      connections.emitAndRemove(connectionId, webContentsId, 'close', {
        reason: 'stream ended',
        ...(reconnectable ? {} : { fatal: true }),
        ...(lastEventId !== undefined ? { lastEventId: entry.redact(lastEventId) } : {}),
        ...(retry !== undefined ? { retry } : {}),
      } satisfies SseClosePayload);
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
    if (connections.size() + connections.pendingCount() >= MAX_CONCURRENT_SSE_CONNECTIONS) {
      return { success: false, error: 'Too many open connections.' };
    }

    // Reserve this renderer's id synchronously before DNS or transport
    // construction. Another renderer may independently use the same external id.
    const claim = connections.reserveClaim(
      connectionId,
      event.sender,
      materialize ? { abort: new AbortController() } : {}
    );
    if (!claim) return { success: false, error: 'Not connected' };

    let claimedEntry: ActiveSse | undefined;
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
          if (!connections.isClaimLive(claim)) {
            return { success: false, error: 'Not connected' };
          }
          // Materializer errors are plaintext-free by construction.
          return {
            success: false,
            error: `SSE auth setup failed: ${err instanceof Error ? err.message : 'unknown error'}`,
          };
        }
        if (!connections.isClaimLive(claim)) return { success: false, error: 'Not connected' };
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
      if (!connections.isClaimLive(claim)) {
        return { success: false, error: 'Not connected' };
      }

      // The connect/headers phase is bounded by the proxy's own `spec.timeout`.
      const abortController = new AbortController();

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
      if (!connections.commitClaim(claim, event.sender, entry)) {
        entry.explicitlyClosed = true;
        abortController.abort();
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
        // `signal` lets disconnect / renderer destroy / teardown abort the
        // upstream request and its read loop, not just our bookkeeping.
        { ...getExecutionPolicy().security, signal: abortController.signal }
      );

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
        discardBody(response.body);
        const message = redact(`HTTP ${response.status} ${response.statusText}`);
        if (connections.get(connectionId, webContentsId) === entry) {
          connections.emit(connectionId, webContentsId, 'error', { message });
          connections.emitAndRemove(connectionId, webContentsId, 'close', {
            reason: `HTTP ${response.status}`,
            fatal: true,
          } satisfies SseClosePayload);
        }
        return { success: false, error: message };
      }

      if (connections.get(connectionId, webContentsId) !== entry) {
        discardBody(response.body);
        abortController.abort();
        return { success: false, error: 'Not connected' };
      }
      connections.emit(connectionId, webContentsId, 'open');
      // Drain the stream in the background — we already returned success.
      // 204 / non-event-stream Content-Type: still streamed, but closes fatal.
      const contentType = Object.entries(response.headers ?? {}).find(
        ([k]) => k.toLowerCase() === 'content-type'
      )?.[1];
      void readStream(
        entry,
        response.body ?? null,
        isReconnectableSseResponse(response.status, contentType ?? null)
      );
      return { success: true };
    } catch (err) {
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
      connections.releaseClaim(claim);
    }
  });

  ipcMain.handle(
    IPC.sse.disconnect,
    createValidatedEventHandler(IPC.sse.disconnect, SseDisconnectSchema, async (config, event) => {
      // A graphql-sse connect still resolving main-side credentials is
      // cancelled outright (plain connects keep their existing semantics).
      if (connections.claimFor(config.connectionId, event.sender.id)?.abort) {
        connections.cancelClaim(config.connectionId, event.sender.id);
      }
      // Missing and wrong-owner ids are deliberately indistinguishable.
      connections.cancelForOwner(config.connectionId, event.sender.id);
      return { success: true };
    })
  );
}

export function stopSseCleanup(): void {
  connections.disposeAllClaims();
  connections.disposeAll();
}
