/**
 * SSE (Server-Sent Events) protocol module — metadata-only registration.
 *
 * SSE is a long-lived, server-pushed stream — it doesn't fit the runner's
 * current `Request -> Promise<Response>` contract. The renderer drives
 * connections through `sseManager` (singleton, three dispatch paths:
 * native EventSource, fetch+ReadableStream with custom headers, and
 * Electron IPC) and stores incoming events in `useSseStore`, keyed by
 * connection id. None of that fits a single-shot Promise.
 *
 * This module exists so the registry catalog includes SSE — the mode
 * picker, code generators, and future analytics need a stable handle for
 * the protocol. `runRequest` throws to direct callers at the proper API
 * (the SseClient component + sseManager).
 */
import { v4 as uuidv4 } from 'uuid';
import type { ProtocolModule } from '@/features/registry/types';
import type { SseRequest } from '@/types';

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

export const sseProtocol: ProtocolModule = {
  id: 'sse',
  label: 'SSE',
  tabType: 'sse',
  defaultRequest: createDefaultSseRequest,
  // TODO(registry-streaming): SSE is a server-push stream and doesn't fit
  // the runner's single-shot Promise<Response> contract. SseClient drives
  // sseManager directly today. Once RunContext exposes a streaming sink
  // (likely an AsyncIterable of SseEvent) this stub can wrap the manager
  // and return the stream, mirroring how the HTTP streaming branch handles
  // SSE-Accept responses today.
  runRequest: async () => {
    throw new Error(
      'SSE is a long-lived stream; use SseClient + sseManager, not the registry runner.'
    );
  },
};
