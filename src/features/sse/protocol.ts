/**
 * SSE (Server-Sent Events) protocol module.
 *
 * Two surfaces:
 *
 *  1. `runRequest` — still throws. SSE is server-push; the interactive
 *     SseClient drives sseManager directly because the renderer wants
 *     events to land in the SSE store for the UI to consume.
 *
 *  2. `startStream` — opens a proxied stream + SseParser pipeline and
 *     returns an async-iterable handle. Used by the DAG executor's
 *     `sseSubscribe` node. Does NOT touch useSseStore — the executor
 *     owns event accumulation and the in-canvas Run Monitor renders
 *     the live state independently.
 *
 * The two paths intentionally don't share sseManager's store-coupled
 * connection bookkeeping (webConnections/electronConnections, reconnect,
 * useSseStore writes). They do share the desktop stream session
 * (`@/lib/shared/streaming/streamSession`), and both end up wrapping the same
 * shared parser and routing through `executeProxiedStreamingRequest` (web)
 * / the same `sse:connect` IPC channel (desktop) so the SSRF/header/auth
 * pipeline applies uniformly either way.
 */
import { authHeaderNames } from '@shared/protocol/request-spec';
import { v4 as uuidv4 } from 'uuid';
import { buildAuthCredential } from '@/features/auth/lib/buildAuthCredential';
import type { ProtocolModule, ProtocolStreamHandle } from '@/features/registry/types';
import { injectString } from '@/features/workflows/lib/variableHelpers';
import { getElectronAPI, isElectron } from '@/lib/shared/platform';
import { createSseDesktopAdapter } from '@/lib/shared/streaming/desktopStreamAdapter';
import {
  createStreamSequence,
  openStreamSession,
  type StreamConnectResult,
} from '@/lib/shared/streaming/streamSession';
import { executeProxiedStreamingRequest } from '@/lib/shared/transport';
import type { Request, SseRequest } from '@/types';
import { buildSseStreamSpec } from './lib/sseManager';
import { type ParsedSseEvent, SseParser } from './lib/sseParser';

function createDefaultSseRequest(): SseRequest {
  return {
    id: uuidv4(),
    name: 'New SSE Request',
    type: 'sse',
    url: '',
    headers: [],
    params: [],
    auth: { type: 'none' },
    reconnectOnResume: true,
  };
}

// Resolve {{var}} references in the SSE request shape before a workflow run —
// parity with injectHttpVariables/injectGraphQLVariables. Without this hook the
// DAG executor (sseSubscribe node) would stream the raw request with literal
// placeholders in url/headers/params. Auth credential values are resolved at the
// wire (the interactive client) but not here, matching HTTP's injectVariables
// (which also leaves auth untouched).
function injectSseVariables(
  request: Request,
  variables: Record<string, string>,
  secretNames?: readonly string[]
): Request {
  if (request.type !== 'sse') return request;
  const sse = request as SseRequest;
  const inject = (text: string) => injectString(text, variables, secretNames);
  return {
    ...sse,
    url: inject(sse.url),
    headers: sse.headers.map((h) => ({ ...h, key: inject(h.key), value: inject(h.value) })),
    params: sse.params.map((p) => ({ ...p, key: inject(p.key), value: inject(p.value) })),
  };
}

function flattenHeaders(
  req: SseRequest,
  authHeaders: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = { Accept: 'text/event-stream' };
  for (const h of req.headers) {
    if (h.enabled !== false && h.key) out[h.key] = h.value;
  }
  // Header-based auth (basic/bearer/api-key/oauth2). Sign-at-wire types no-op.
  Object.assign(out, authHeaders);
  return out;
}

function buildUrlWithParams(req: SseRequest, authParams: Record<string, string>): string {
  const hasAuthParams = Object.keys(authParams).length > 0;
  if (!req.params.length && !hasAuthParams) return req.url;
  try {
    const u = new URL(req.url);
    for (const p of req.params) {
      if (p.enabled !== false && p.key) u.searchParams.set(p.key, p.value);
    }
    for (const [k, v] of Object.entries(authParams)) u.searchParams.set(k, v);
    return u.toString();
  } catch {
    return req.url;
  }
}

/**
 * Open a streaming connection to the request's URL and return an
 * async-iterable handle. Honours `ctx.signal` — abort closes the
 * underlying stream and ends the iterator.
 *
 * The iterator's value shape is `ParsedSseEvent`; the executor narrows
 * via `event as ParsedSseEvent` since `ProtocolStreamHandle.events` is
 * typed as `AsyncIterable<unknown>` (protocols differ in event shape).
 */
async function sseStartStream(
  request: unknown,
  ctx: { signal: AbortSignal }
): Promise<ProtocolStreamHandle> {
  if (
    request === null ||
    typeof request !== 'object' ||
    (request as { type?: unknown }).type !== 'sse'
  ) {
    const t = (request as { type?: unknown })?.type;
    throw new Error(`SSE startStream cannot run ${typeof t === 'string' ? t : 'unknown'} request`);
  }
  const sseReq = request as SseRequest;
  if (!sseReq.url.trim()) {
    throw new Error('SSE request has no URL');
  }

  // Header-based auth (basic/bearer/api-key/oauth2); sign-at-wire types no-op.
  const credential = buildAuthCredential(sseReq.auth);
  const url = buildUrlWithParams(sseReq, credential.params);
  const headers = flattenHeaders(sseReq, credential.headers);
  const authHeaders = authHeaderNames(sseReq.auth);

  // Desktop: `executeProxiedStreamingRequest` deliberately throws for
  // Electron (streaming HTTP has no generic IPC channel — see its
  // doc-comment), so the `sseSubscribe` workflow node would fail on every
  // run in the packaged app. Route through the same `sse:connect` IPC
  // channel + SSRF-guarded main-process fetch the interactive SSE client
  // uses (`sseManager.connectViaElectron`), just without touching
  // `useSseStore` — the executor owns event accumulation here.
  if (isElectron()) {
    return sseStartStreamElectron(url, headers, authHeaders, ctx);
  }

  // Each call gets its own AbortController. The caller's signal feeds
  // ours; `close()` aborts ours too. Either fully terminates the
  // fetch reader.
  const ourCtrl = new AbortController();
  const linkAbort = () => ourCtrl.abort();
  if (ctx.signal.aborted) ourCtrl.abort();
  else ctx.signal.addEventListener('abort', linkAbort, { once: true });

  const response = await executeProxiedStreamingRequest(
    buildSseStreamSpec(url, headers, authHeaders),
    { signal: ourCtrl.signal }
  );

  if (!response.ok) {
    ourCtrl.abort();
    throw new Error(`SSE HTTP ${response.status} ${response.statusText}`);
  }
  if (!response.body) {
    ourCtrl.abort();
    throw new Error('SSE response has no body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  const sequence = createStreamSequence<ParsedSseEvent>();
  const onEvent = (e: ParsedSseEvent) => sequence.push(e);

  // Drain the reader in the background — fills the sequence as events arrive.
  // Errors / EOF / abort each end it, waking any pending waiter.
  const drain = (async () => {
    try {
      while (true) {
        if (ourCtrl.signal.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;
        parser.feed(decoder.decode(value, { stream: true }), onEvent);
      }
      parser.feed(decoder.decode(), onEvent);
    } catch {
      // swallow — closing is the only outcome we care about here
    } finally {
      sequence.end();
    }
  })();

  return {
    events: sequence.iterate(async () => {
      // The consumer broke out of the loop (executor's completion policy
      // matched, ctx.signal fired, etc.). Make sure the reader is gone.
      if (!sequence.ended) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        ourCtrl.abort();
      }
    }),
    close: async () => {
      if (sequence.ended) return;
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      ourCtrl.abort();
      ctx.signal.removeEventListener('abort', linkAbort);
      // Wait for the drain loop to settle so we don't leak the reader.
      await drain;
    },
  };
}

/**
 * Electron path for `sseStartStream`. Mirrors the queue+waiter
 * async-iterable shape of the web path above, but sources events from the
 * `sse:connect` IPC channel (electron/main/handlers/sse-handler.ts) —
 * the same SSRF-guarded, DNS-pinned main-process fetch the interactive
 * SSE client uses — instead of a renderer-side `fetch`. Each call mints
 * its own `connectionId` so concurrent sseSubscribe nodes (e.g. inside a
 * forEach) and any open interactive SSE tab never collide, and doesn't
 * touch `useSseStore`.
 */
async function sseStartStreamElectron(
  url: string,
  headers: Record<string, string>,
  authHeaders: string[],
  ctx: { signal: AbortSignal }
): Promise<ProtocolStreamHandle> {
  // Destructured up front rather than closing over `ctx` itself: the
  // executor's actual runtime `ctx` also carries `variables` (this
  // function's declared type just doesn't need it) — capturing only the
  // signal lets that map be GC'd once the caller's frame is done instead
  // of staying reachable for this stream's whole lifetime.
  const { signal } = ctx;

  const api = getElectronAPI();
  if (!api?.sse) {
    throw new Error('Electron SSE API is not available in this context.');
  }
  const connectionId = `flow-sse-${uuidv4()}`;

  const sequence = createStreamSequence<ParsedSseEvent>();
  const session = openStreamSession(
    createSseDesktopAdapter(api.sse, {
      connectionId,
      url,
      headers,
      ...(authHeaders.length > 0 ? { stripOnOriginChange: authHeaders } : {}),
    }),
    {
      signal,
      listeners: {
        event: (payload) => sequence.push(payload as ParsedSseEvent),
        error: (payload) => {
          const err = payload as { message?: string };
          sequence.fail(new Error(err?.message ?? 'SSE stream error'));
        },
        close: () => sequence.end(),
      },
    }
  );

  if (signal.aborted) {
    // Never opened: a handle whose events end at once. Connecting now would
    // leave a main-process stream nothing can close — the one disconnect has
    // already been sent.
    session.dispose();
    sequence.end();
  } else {
    let connectResult: StreamConnectResult;
    try {
      connectResult = await session.connect();
    } catch (err) {
      session.dispose();
      throw err;
    }
    if (!connectResult.success) {
      session.dispose();
      throw new Error(connectResult.error || 'SSE connect failed');
    }
  }

  return {
    events: sequence.iterate(session.close),
    close: async () => session.close(),
  };
}

export const sseProtocol: ProtocolModule = {
  id: 'sse',
  label: 'SSE',
  tabType: 'sse',
  defaultRequest: createDefaultSseRequest,
  injectVariables: injectSseVariables,
  runRequest: async () => {
    // The interactive SseClient still owns its store-coupled lifecycle.
    // Graph workflows use sseSubscribe nodes which call startStream.
    throw new Error(
      'SSE is a long-lived stream; use SseClient + sseManager, not the registry runner.'
    );
  },
  startStream: sseStartStream,
};
