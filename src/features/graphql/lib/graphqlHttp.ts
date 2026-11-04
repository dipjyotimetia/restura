/**
 * GraphQL-over-HTTP for the renderer. The pure wire shaping (method, Accept,
 * envelope or GET params) lives in `shared/graphql/wire.ts` so the CLI runner
 * sends the same bytes; it is re-exported here for existing renderer callers.
 * Renderer-only pieces — response normalisation, live incremental progress —
 * stay in this module.
 */

import {
  contentTypeOf,
  incrementalPartsNotice,
  mergeIncrementalGraphQLResponse,
  withJsonContentType,
} from '@shared/graphql/incremental-response';
import {
  GraphQLIncrementalMerger,
  parseIncrementalPart,
} from '@shared/protocol/graphql-incremental';
import {
  isMultipartMixed,
  MultipartMixedParser,
  parseMultipartBoundary,
} from '@shared/protocol/multipart-mixed-parser';
import type { ResponseProgress } from '@/features/http/lib/progressTransport';
import type { Response as ApiResponse } from '@/types';

export {
  buildGraphQLWireRequest,
  GRAPHQL_ACCEPT,
  GRAPHQL_INCREMENTAL_ACCEPT,
  type GraphQLEnvelope,
  type GraphQLHttpMethod,
  type GraphQLWireResult,
  getRefusalReason,
  graphqlEnvelopeFromBody,
  graphqlMethodOf,
  hasIncrementalDirective,
} from '@shared/graphql/wire';

/**
 * Fold a buffered `multipart/mixed` incremental GraphQL response into one
 * ordinary JSON result. Any other response is returned untouched. The merge
 * itself is shared with the CLI (`shared/graphql/incremental-response.ts`).
 */
export function normalizeGraphQLResponse(response: ApiResponse): ApiResponse {
  return mergeIncrementalGraphQLResponse(response);
}

export interface IncrementalSnapshot {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  /** The merged `{ data, errors?, extensions? }` result so far. */
  result: unknown;
  parts: number;
  hasNext: boolean;
}

/** Minimum gap between two live snapshots (each one re-serialises the result). */
export const SNAPSHOT_INTERVAL_MS = 100;

export interface IncrementalProgressHandler {
  (progress: ResponseProgress): void;
  /** Drop any pending trailing snapshot — call once the request settles. */
  dispose(): void;
}

export interface IncrementalProgressOptions {
  intervalMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Build a progress handler that parses `multipart/mixed` chunks as they arrive
 * and reports the merged result. Snapshots are coalesced — at most one per
 * `intervalMs`, with a trailing one for parts that land inside the window and
 * an immediate one when the server signals `hasNext: false` — so thousands of
 * tiny `@stream` parts cost a handful of re-renders, not one per part.
 * Non-multipart responses are ignored (the buffered result arrives when the
 * request resolves). Any failure (a pathological payload, a throwing sink)
 * stops live updates; the final buffered response is unaffected.
 */
export function createIncrementalProgress(
  onSnapshot: (snapshot: IncrementalSnapshot) => void,
  options: IncrementalProgressOptions = {}
): IncrementalProgressHandler {
  const intervalMs = options.intervalMs ?? SNAPSHOT_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer =
    options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let parser: MultipartMixedParser | null | undefined;
  const merger = new GraphQLIncrementalMerger();
  let meta: Omit<ResponseProgress, 'chunk'> | null = null;
  let lastEmit = Number.NEGATIVE_INFINITY;
  let timer: unknown;
  let stopped = false;

  const cancelTimer = () => {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
  };
  const emit = () => {
    cancelTimer();
    if (stopped || !meta) return;
    lastEmit = now();
    try {
      onSnapshot({
        status: meta.status,
        statusText: meta.statusText,
        headers: meta.headers,
        result: merger.result,
        parts: merger.payloadCount,
        hasNext: merger.hasNext,
      });
    } catch {
      stopped = true;
    }
  };

  const handler = ((progress: ResponseProgress) => {
    if (stopped) return;
    if (parser === undefined) {
      const ct = contentTypeOf(progress.headers);
      const boundary = isMultipartMixed(ct) ? parseMultipartBoundary(ct) : null;
      parser = boundary ? new MultipartMixedParser(boundary) : null;
    }
    if (!parser) return;
    meta = { status: progress.status, statusText: progress.statusText, headers: progress.headers };
    let changed = false;
    try {
      for (const part of parser.feed(progress.chunk)) {
        const payload = parseIncrementalPart(part.body);
        if (payload === undefined) continue;
        merger.apply(payload);
        changed = true;
      }
    } catch {
      stopped = true;
      cancelTimer();
      return;
    }
    if (!changed || merger.payloadCount === 0) return;
    const wait = lastEmit + intervalMs - now();
    if (!merger.hasNext || wait <= 0) {
      emit();
    } else if (timer === undefined) {
      timer = setTimer(emit, wait);
    }
  }) as IncrementalProgressHandler;
  handler.dispose = () => {
    stopped = true;
    cancelTimer();
  };
  return handler;
}

/** Render an in-flight snapshot as a provisional response for the viewer. */
export function snapshotToResponse(
  snapshot: IncrementalSnapshot,
  requestId: string,
  startedAt: number
): ApiResponse {
  const body = JSON.stringify(snapshot.result, null, 2);
  const now = Date.now();
  return {
    id: `graphql-incremental-${requestId}`,
    requestId,
    status: snapshot.status,
    statusText: snapshot.statusText,
    headers: withJsonContentType(snapshot.headers),
    body,
    size: new Blob([body]).size,
    time: now - startedAt,
    timestamp: now,
    bodyNotice: incrementalPartsNotice(snapshot.parts, !snapshot.hasNext),
    partial: true,
  };
}

/**
 * The last live snapshot, finalised after the request stopped early (the user
 * cancelled, or the transport failed mid-stream): no longer `partial` — the
 * viewer must stop treating it as in flight — and labelled as incomplete.
 */
export function stoppedSnapshotResponse(
  snapshot: ApiResponse,
  reason: 'cancelled' | 'failed'
): ApiResponse {
  return {
    ...snapshot,
    partial: false,
    bodyNotice: `Incremental delivery ${reason} — showing the partial result received before the request stopped.`,
  };
}
