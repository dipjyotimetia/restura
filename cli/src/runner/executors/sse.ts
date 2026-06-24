import { SseParser } from '@shared/protocol/sse-parser';
import { validateURL } from '@shared/protocol/url-validation';
import { request as undiciRequest } from 'undici';
import type { LoadedRequest } from '../collectionLoader';
import { resolveVarsDeep } from '../varResolver';
import { applyAuthHeaders, resolveOAuth2Token } from './auth';
import type { ExecuteOptions, ExecuteOutcome, StreamEvent } from './types';
import type { SseRequest } from '@/types';

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
    return {
      status: 0,
      passed: false,
      durationMs: 0,
      bodyBytes: 0,
      errorMessage: `SSE executor received non-sse request: ${item.type}`,
    };
  }
  const req = item.request as SseRequest;
  const url = resolveVarsDeep(req.url, opts.vars);
  const validation = validateURL(url, {
    allowPrivateIPs: false,
    allowLocalhost: opts.allowLocalhost,
  });
  if (!validation.valid) {
    return {
      status: 400,
      passed: false,
      durationMs: 0,
      bodyBytes: 0,
      errorMessage: `Invalid URL: ${validation.error ?? 'unknown'}`,
    };
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

  const timer = setTimeout(() => controller.abort(), durationMs);

  try {
    // Header-based auth (Bearer / Basic / API-key / OAuth2). Applied here so an
    // unresolvable secret-handle ref surfaces as an errored outcome below.
    const resolvedAuth = await resolveOAuth2Token(req.auth, opts.vars, {
      allowLocalhost: opts.allowLocalhost,
    });
    applyAuthHeaders(resolvedAuth, headers, params);
    const finalUrl = appendQuery(url, params);
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
        if (eventFilter && ev.event && !eventFilter.has(ev.event)) continue;
        events.push({
          ...(ev.event !== undefined ? { event: ev.event } : {}),
          data: ev.data,
          timestamp: Date.now(),
        });
        if (maxEvents !== undefined && events.length >= maxEvents) {
          controller.abort();
          break;
        }
      }
      if (maxEvents !== undefined && events.length >= maxEvents) break;
    }
    for (const ev of parser.flush()) {
      if (eventFilter && ev.event && !eventFilter.has(ev.event)) continue;
      events.push({
        ...(ev.event !== undefined ? { event: ev.event } : {}),
        data: ev.data,
        timestamp: Date.now(),
      });
    }
  } catch (err) {
    // AbortError from our duration timer is expected — not a failure.
    if (!(err instanceof Error && err.name === 'AbortError')) {
      errorMessage = err instanceof Error ? err.message : String(err);
    }
  } finally {
    clearTimeout(timer);
  }

  const outcome: ExecuteOutcome = {
    status: status || 200,
    passed: errorMessage === undefined,
    durationMs: Date.now() - start,
    bodyBytes,
    streamEvents: events,
  };
  if (responseHeaders) outcome.responseHeaders = responseHeaders;
  if (errorMessage) outcome.errorMessage = errorMessage;
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
