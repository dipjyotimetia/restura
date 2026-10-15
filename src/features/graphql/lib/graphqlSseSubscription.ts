import { type ParsedSseEvent, SseStreamReader } from '@shared/protocol/sse-stream-reader';
import { getElectronAPI, isElectron } from '@/lib/shared/platform';
import { executeProxiedStreamingRequest } from '@/lib/shared/transport';
import {
  operationPayload,
  type SubscriptionOperation,
  type SubscriptionSink,
  toHttpUrl,
} from './subscriptionSocket';

/**
 * GraphQL over Server-Sent Events — "distinct connections mode" of
 * https://github.com/enisdenjo/graphql-sse/blob/master/PROTOCOL.md: one HTTP
 * request per operation, `POST` with the JSON operation, the server answers
 * `text/event-stream` with `next` events (ExecutionResult JSON) and a final
 * `complete` event, then closes.
 *
 * Transport mirrors the SSE feature: web streams through the Worker's
 * `/api/proxy` (SSRF/header policy), desktop through the `sse:connect` IPC
 * handler (renderer-direct http: is CSP-blocked). The shared SSE frame parser
 * handles the wire format on both. `complete` is a data-less event the parser
 * drops, so end-of-stream is also treated as completion.
 */

export const GRAPHQL_SSE_PROTOCOL = 'graphql-sse';

export interface GraphQLSseOptions extends SubscriptionOperation {
  url: string;
  headers: Record<string, string>;
}

/** Shared event dispatch for both transports. Returns true when the stream is complete. */
function handleEvent(e: ParsedSseEvent, sink: SubscriptionSink): 'continue' | 'complete' {
  if (e.event === 'complete') return 'complete';
  // `next` per spec; tolerate the default `message` some servers emit.
  if (e.event !== 'next' && e.event !== 'message') return 'continue';
  if (!e.data) return 'continue';
  try {
    sink.next(JSON.parse(e.data));
  } catch {
    sink.next(e.data);
  }
  return 'continue';
}

export function subscribeGraphQLSse(
  options: GraphQLSseOptions,
  sink: SubscriptionSink
): () => void {
  const url = toHttpUrl(options.url);
  const body = JSON.stringify(operationPayload(options));
  const headers = { ...options.headers, 'Content-Type': 'application/json' };
  return isElectron() ? viaElectron(url, headers, body, sink) : viaProxy(url, headers, body, sink);
}

function viaProxy(
  url: string,
  headers: Record<string, string>,
  body: string,
  sink: SubscriptionSink
): () => void {
  const controller = new AbortController();
  let done = false;
  const settle = (fn: () => void): void => {
    if (done) return;
    done = true;
    fn();
  };

  void (async () => {
    try {
      const response = await executeProxiedStreamingRequest(
        {
          method: 'POST',
          url,
          headers: { Accept: 'text/event-stream', ...headers },
          bodyType: 'json',
          data: body,
          streamingMode: true,
          timeout: 0,
        },
        { signal: controller.signal }
      );
      if (!response.ok) {
        settle(() => sink.error(new Error(`HTTP ${response.status} ${response.statusText}`)));
        return;
      }
      if (!response.body) {
        settle(() => sink.error(new Error('No response body')));
        return;
      }
      if (done) return;
      sink.connected(GRAPHQL_SSE_PROTOCOL);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseStreamReader();
      let complete = false;
      const onEvent = (e: ParsedSseEvent): void => {
        if (!done && !complete && handleEvent(e, sink) === 'complete') complete = true;
      };
      while (!complete) {
        const { done: eof, value } = await reader.read();
        if (eof) break;
        parser.feed(decoder.decode(value, { stream: true }), onEvent);
      }
      parser.feed(decoder.decode(), onEvent);
      if (complete) await reader.cancel().catch(() => {});
      settle(() => sink.complete());
    } catch (err) {
      if (controller.signal.aborted) return;
      settle(() => sink.error(err));
    }
  })();

  return () => {
    done = true;
    controller.abort();
  };
}

function viaElectron(
  url: string,
  headers: Record<string, string>,
  body: string,
  sink: SubscriptionSink
): () => void {
  const api = getElectronAPI()?.sse;
  if (!api) {
    queueMicrotask(() => sink.error(new Error('Electron SSE API unavailable')));
    return () => {};
  }
  const connectionId = `gql-sse-${crypto.randomUUID()}`;
  const channels = ['open', 'event', 'error', 'close'].map((k) => `sse:${k}:${connectionId}`);
  let done = false;
  let lastError: string | undefined;

  const cleanup = (): void => {
    for (const ch of channels) api.removeAllListeners(ch);
  };
  const settle = (fn: () => void): void => {
    if (done) return;
    done = true;
    cleanup();
    fn();
  };
  const stop = (): void => {
    void api.disconnect({ connectionId }).catch(() => {});
  };

  api.on(`sse:open:${connectionId}`, () => {
    if (!done) sink.connected(GRAPHQL_SSE_PROTOCOL);
  });
  api.on(`sse:event:${connectionId}`, (payload: unknown) => {
    if (done) return;
    if (handleEvent(payload as ParsedSseEvent, sink) === 'complete') {
      settle(() => sink.complete());
      stop();
    }
  });
  api.on(`sse:error:${connectionId}`, (payload: unknown) => {
    lastError = (payload as { message?: string } | undefined)?.message ?? 'SSE error';
  });
  api.on(`sse:close:${connectionId}`, () => {
    settle(() => (lastError ? sink.error(new Error(lastError)) : sink.complete()));
  });

  api
    .connect({ connectionId, url, headers, jsonBody: body })
    .then((res) => {
      if (!res.success) settle(() => sink.error(new Error(res.error ?? 'Connection failed')));
    })
    .catch((err: unknown) => settle(() => sink.error(err)));

  return () => {
    if (done) return;
    done = true;
    cleanup();
    stop();
  };
}
