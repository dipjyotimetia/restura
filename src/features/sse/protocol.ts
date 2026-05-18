/**
 * SSE (Server-Sent Events) protocol module.
 *
 * Two surfaces:
 *
 *  1. `runRequest` — still throws. SSE is server-push; the interactive
 *     SseClient drives sseManager directly because the renderer wants
 *     events to land in the SSE store for the UI to consume.
 *
 *  2. `startStream` — opens a fetch + SseParser pipeline and returns an
 *     async-iterable handle. Used by the DAG executor's `sseSubscribe`
 *     node. Does NOT touch useSseStore — the executor owns event
 *     accumulation and the in-canvas Run Monitor renders the live
 *     state independently.
 *
 * The two paths intentionally don't share infrastructure with
 * sseManager (which is heavily store-coupled). Both end up wrapping the
 * same shared parser, so behaviour stays consistent across the app.
 */
import { v4 as uuidv4 } from 'uuid';
import type {
  ProtocolModule,
  ProtocolStreamHandle,
} from '@/features/registry/types';
import type { Request, SseRequest } from '@/types';
import { SseParser, type ParsedSseEvent } from './lib/sseParser';

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

function flattenHeaders(req: SseRequest): Record<string, string> {
  const out: Record<string, string> = { Accept: 'text/event-stream' };
  for (const h of req.headers) {
    if (h.enabled !== false && h.key) out[h.key] = h.value;
  }
  return out;
}

function buildUrlWithParams(req: SseRequest): string {
  if (!req.params.length) return req.url;
  try {
    const u = new URL(req.url);
    for (const p of req.params) {
      if (p.enabled !== false && p.key) u.searchParams.set(p.key, p.value);
    }
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
  request: Request,
  ctx: { signal: AbortSignal }
): Promise<ProtocolStreamHandle> {
  if (request.type !== 'sse') {
    throw new Error(`SSE startStream cannot run ${request.type} request`);
  }
  const sseReq = request as SseRequest;
  if (!sseReq.url.trim()) {
    throw new Error('SSE request has no URL');
  }

  // Each call gets its own AbortController. The caller's signal feeds
  // ours; `close()` aborts ours too. Either fully terminates the
  // fetch reader.
  const ourCtrl = new AbortController();
  const linkAbort = () => ourCtrl.abort();
  if (ctx.signal.aborted) ourCtrl.abort();
  else ctx.signal.addEventListener('abort', linkAbort, { once: true });

  const url = buildUrlWithParams(sseReq);
  const headers = flattenHeaders(sseReq);

  const response = await fetch(url, {
    method: 'GET',
    headers,
    signal: ourCtrl.signal,
  });

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
  let closed = false;

  // A tiny event queue + waiter so we can hand out async-iterable
  // semantics without buffering the entire stream.
  const queue: ParsedSseEvent[] = [];
  let resolveWaiter: (() => void) | null = null;
  const wakeup = () => {
    if (resolveWaiter) {
      const r = resolveWaiter;
      resolveWaiter = null;
      r();
    }
  };

  const onEvent = (e: ParsedSseEvent) => {
    queue.push(e);
    wakeup();
  };

  // Drain the reader in the background — fills `queue` as events arrive.
  // Errors / EOF / abort each set `closed` and wake any pending waiter.
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
      closed = true;
      wakeup();
    }
  })();

  async function* iterate(): AsyncGenerator<unknown, void, unknown> {
    try {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (closed) return;
        await new Promise<void>((res) => {
          resolveWaiter = res;
        });
      }
    } finally {
      // The consumer broke out of the loop (executor's completion policy
      // matched, ctx.signal fired, etc.). Make sure the reader is gone.
      if (!closed) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        ourCtrl.abort();
      }
    }
  }

  return {
    events: iterate(),
    close: async () => {
      if (closed) return;
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

export const sseProtocol: ProtocolModule = {
  id: 'sse',
  label: 'SSE',
  tabType: 'sse',
  defaultRequest: createDefaultSseRequest,
  runRequest: async () => {
    // The interactive SseClient still owns its store-coupled lifecycle.
    // Graph workflows use sseSubscribe nodes which call startStream.
    throw new Error(
      'SSE is a long-lived stream; use SseClient + sseManager, not the registry runner.'
    );
  },
  startStream: sseStartStream,
};
