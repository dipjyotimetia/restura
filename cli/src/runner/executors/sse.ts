import { resolveAuthVariables } from '@shared/auth/resolve-variables';
import { signAtWireAuthLabel } from '@shared/protocol/sign-at-wire-auth';
import { SseParser } from '@shared/protocol/sse-parser';
import { validateURL } from '@shared/protocol/url-validation';
import type { SseRequest } from '@shared/types';
import { request as undiciRequest } from 'undici';
import type { LoadedRequest } from '../collectionLoader';
import { resolveVarsDeep } from '../varResolver';
import { applyAuthHeaders, oauth2TokenOptions, resolveOAuth2Token } from './auth';
import { materializeExternalSecretsInAuth } from './external-secret-materializer';
import { thrownOutcome } from './failure';
import type { ExecuteOptions, ExecuteOutcome, StreamEvent } from './types';
import { preflightRefusal, refusedOutcome } from './variable-guard';

const DEFAULT_DURATION_MS = 5000;

/**
 * Server-Sent Events executor. Connects to the SSE endpoint, captures events
 * for up to `sseDurationMs` (default 5s) or until `sseMaxEvents` is reached,
 * then closes the stream. Returns the captured events for the test script.
 *
 * Implementation uses undici directly (rather than the shared http-proxy)
 * because we need access to the streaming body. SSRF guard is applied here
 * via `validateURL` mirroring the shared http-proxy's policy.
 */
export async function executeSse(
  item: LoadedRequest,
  opts: ExecuteOptions
): Promise<ExecuteOutcome> {
  if (item.type !== 'sse') {
    return refusedOutcome(`SSE executor received non-sse request: ${item.type}`);
  }
  const refused = preflightRefusal(item, opts.vars);
  if (refused) return refused;
  const req = item.request as SseRequest;
  const url = resolveVarsDeep(req.url, opts.vars);
  const validation = validateURL(url, {
    allowPrivateIPs: false,
    allowLocalhost: opts.allowLocalhost,
  });
  if (!validation.valid) {
    return { ...refusedOutcome(`Invalid URL: ${validation.error ?? 'unknown'}`), status: 400 };
  }

  const headers: Record<string, string> = { Accept: 'text/event-stream' };
  for (const h of req.headers ?? []) {
    if (h.enabled && h.key) headers[h.key] = resolveVarsDeep(h.value, opts.vars);
  }

  const params: Record<string, string> = {};
  for (const p of req.params ?? []) {
    if (p.enabled && p.key) params[p.key] = resolveVarsDeep(p.value, opts.vars);
  }

  const durationMs = opts.sseDurationMs ?? DEFAULT_DURATION_MS;
  const maxEvents = opts.sseMaxEvents;
  const eventFilter = req.eventFilter ? new Set(req.eventFilter) : null;

  const controller = new AbortController();
  const start = Date.now();
  const events: StreamEvent[] = [];
  let bodyBytes = 0;
  let status = 0;
  let errorMessage: string | undefined;
  let responseHeaders: Record<string, string> | undefined;
  // True once the request is on the wire: an error before that is the auth
  // step's (a refusal or a token failure), after it with no status a transport one.
  let sent = false;

  // An event with no `event:` field is a "message" event (the SSE spec, and
  // the app's filter in `useSseStore.getFilteredLog`). Returns whether kept.
  const recordEvent = (ev: { event?: string; data: string }): boolean => {
    const name = ev.event || 'message';
    if (eventFilter && !eventFilter.has(name)) return false;
    events.push({ event: name, data: ev.data, timestamp: Date.now() });
    return true;
  };

  // Started once auth is ready: slow secret or token fetches are not stream time.
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    // Header-based auth (Bearer / Basic / API-key / OAuth2). Applied here so an
    // unresolvable secret-handle ref surfaces as a refused outcome below.
    // `{{vars}}` in every auth field resolve first (shared field map, same as
    // the HTTP executor and the app).
    const varResolvedAuth = req.auth
      ? resolveAuthVariables(req.auth, (text) => resolveVarsDeep(text, opts.vars))
      : req.auth;
    const externalMaterializedAuth = await materializeExternalSecretsInAuth(
      varResolvedAuth,
      opts.externalSecretResolver
    );
    const resolvedAuth = await resolveOAuth2Token(
      externalMaterializedAuth,
      opts.vars,
      oauth2TokenOptions(opts)
    );
    // Wire-signed and challenge auth has no SSE transport here: refuse rather
    // than stream unauthenticated and pass against a permissive endpoint.
    const unsupported = signAtWireAuthLabel(resolvedAuth?.type);
    if (unsupported) {
      return refusedOutcome(
        `${unsupported} auth can't be applied to SSE connections; the stream was not opened. Use Bearer, Basic, API key or OAuth 2.0 auth instead.`
      );
    }
    applyAuthHeaders(resolvedAuth, headers, params);
    const finalUrl = appendQuery(url, params);
    timer = setTimeout(() => controller.abort(), durationMs);
    sent = true;
    const response = await undiciRequest(finalUrl, {
      method: 'GET',
      headers,
      signal: controller.signal,
      ...(opts.dispatcher ? { dispatcher: opts.dispatcher } : {}),
    });
    status = response.statusCode;
    responseHeaders = flattenHeaders(response.headers);

    if (status < 200 || status >= 300) {
      const text = await response.body.text();
      return {
        status,
        passed: false,
        durationMs: Date.now() - start,
        bodyBytes: text.length,
        responseHeaders,
        responseBody: text,
        errorMessage: `SSE upstream returned ${status}`,
      };
    }

    const parser = new SseParser();
    for await (const chunk of response.body) {
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      bodyBytes += bytes.byteLength;
      const parsed = parser.feed(bytes);
      for (const ev of parsed) {
        if (!recordEvent(ev)) continue;
        if (maxEvents !== undefined && events.length >= maxEvents) {
          controller.abort();
          break;
        }
      }
      if (maxEvents !== undefined && events.length >= maxEvents) break;
    }
    for (const ev of parser.flush()) recordEvent(ev);
  } catch (err) {
    if (!sent) return thrownOutcome(err, Date.now() - start);
    // AbortError from our duration timer is expected — not a failure.
    // Only once the stream opened: an abort before any response headers means
    // the server never answered, which is a failure, not an empty 200 stream.
    if (!(err instanceof Error && err.name === 'AbortError')) {
      errorMessage = err instanceof Error ? err.message : String(err);
    } else if (status === 0) {
      errorMessage = `SSE upstream sent no response within ${durationMs}ms`;
    }
  } finally {
    clearTimeout(timer);
  }

  const outcome: ExecuteOutcome = {
    status,
    passed: errorMessage === undefined,
    durationMs: Date.now() - start,
    bodyBytes,
    streamEvents: events,
  };
  if (responseHeaders) outcome.responseHeaders = responseHeaders;
  if (errorMessage) outcome.errorMessage = errorMessage;
  // No status: the upstream never answered (connect failure, no headers in time).
  if (errorMessage && status === 0) outcome.transportError = true;
  return outcome;
}

function appendQuery(url: string, params: Record<string, string>): string {
  const keys = Object.keys(params);
  if (keys.length === 0) return url;
  const u = new URL(url);
  for (const k of keys) u.searchParams.append(k, params[k]!);
  return u.toString();
}

function flattenHeaders(
  headers: Record<string, string | string[] | undefined>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}
