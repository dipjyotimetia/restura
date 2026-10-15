/**
 * GraphQL-over-HTTP wire shaping, shared by interactive Send
 * (`GraphQLRequestBuilder`) and saved-request runs (`graphqlProtocol`), so both
 * put the same bytes on the wire.
 *
 * - Accept: `application/graphql-response+json, application/json;q=0.9`
 *   (GraphQL-over-HTTP spec) unless the user set their own Accept header.
 *   Documents using `@defer` / `@stream` also advertise `multipart/mixed`
 *   (incremental delivery, deferSpec=20220824).
 * - Method: POST (JSON envelope) or GET (query / variables / operationName /
 *   extensions URL-encoded as query params). GET is refused for mutations and
 *   subscriptions — the spec forbids mutations over GET (they are not safe).
 */
import {
  GraphQLIncrementalMerger,
  mergeMultipartGraphQLBody,
  parseIncrementalPart,
} from '@shared/protocol/graphql-incremental';
import {
  isMultipartMixed,
  MultipartMixedParser,
  parseMultipartBoundary,
} from '@shared/protocol/multipart-mixed-parser';
import { extractOperationType } from '@/features/graphql/lib/queryParser';
import type { ResponseProgress } from '@/features/http/lib/progressTransport';
import { base64ToBytes } from '@/lib/shared/binaryBody';
import type { Response as ApiResponse, HttpRequest, KeyValue } from '@/types';

export const GRAPHQL_ACCEPT = 'application/graphql-response+json, application/json;q=0.9';
export const GRAPHQL_INCREMENTAL_ACCEPT =
  'multipart/mixed;deferSpec=20220824, application/graphql-response+json;q=0.9, application/json;q=0.8';

export type GraphQLHttpMethod = 'GET' | 'POST';

export interface GraphQLEnvelope {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
  extensions?: Record<string, unknown>;
}

export type GraphQLWireResult =
  | { ok: true; request: HttpRequest; method: GraphQLHttpMethod }
  | { ok: false; error: string };

/** The method a GraphQL request is sent with — anything but GET means POST. */
export function graphqlMethodOf(request: Pick<HttpRequest, 'method'>): GraphQLHttpMethod {
  return request.method === 'GET' ? 'GET' : 'POST';
}

/** True when the document uses `@defer` or `@stream` (comments ignored). */
export function hasIncrementalDirective(query: string): boolean {
  return /@(?:defer|stream)\b/.test(query.replace(/#[^\n\r]*/g, ''));
}

/**
 * Why GET cannot carry this document, or null when it can. Anonymous
 * shorthand (`{ ... }`) and unparseable text count as queries.
 */
export function getRefusalReason(query: string): string | null {
  const type = extractOperationType(query);
  if (type === 'mutation' || type === 'subscription') {
    return `GET can only send query operations — switch the method to POST to send this ${type}.`;
  }
  return null;
}

const GET_PARAM_KEYS = new Set(['query', 'variables', 'operationName', 'extensions']);

function param(key: string, value: string): KeyValue {
  return { id: `graphql-get-${key}`, key, value, enabled: true };
}

function hasEnabledHeader(headers: KeyValue[], name: string): boolean {
  return headers.some((h) => h.enabled && h.key.trim().toLowerCase() === name);
}

/**
 * Shape a GraphQL request for the HTTP executor: method, body or URL params,
 * Content-Type (POST) and Accept. Pure — the input request is not mutated.
 */
export function buildGraphQLWireRequest(
  request: HttpRequest,
  envelope: GraphQLEnvelope
): GraphQLWireResult {
  const method = graphqlMethodOf(request);
  const headers = request.headers.slice();
  if (!hasEnabledHeader(headers, 'accept')) {
    headers.push({
      id: 'graphql-accept',
      key: 'Accept',
      value: hasIncrementalDirective(envelope.query) ? GRAPHQL_INCREMENTAL_ACCEPT : GRAPHQL_ACCEPT,
      enabled: true,
    });
  }

  if (method === 'GET') {
    const refusal = getRefusalReason(envelope.query);
    if (refusal) return { ok: false, error: refusal };
    const params = request.params.filter((p) => !(p.enabled && GET_PARAM_KEYS.has(p.key)));
    params.push(param('query', envelope.query));
    if (envelope.variables && Object.keys(envelope.variables).length > 0) {
      params.push(param('variables', JSON.stringify(envelope.variables)));
    }
    if (envelope.operationName) params.push(param('operationName', envelope.operationName));
    if (envelope.extensions && Object.keys(envelope.extensions).length > 0) {
      params.push(param('extensions', JSON.stringify(envelope.extensions)));
    }
    return {
      ok: true,
      method,
      request: { ...request, method, headers, params, body: { type: 'none' } },
    };
  }

  if (!hasEnabledHeader(headers, 'content-type')) {
    headers.push({
      id: 'graphql-content-type',
      key: 'Content-Type',
      value: 'application/json',
      enabled: true,
    });
  }
  return {
    ok: true,
    method,
    request: {
      ...request,
      method,
      headers,
      body: { ...request.body, type: 'json', raw: JSON.stringify(envelope) },
    },
  };
}

function bodyText(response: Pick<ApiResponse, 'body' | 'bodyEncoding'>): string {
  if (response.bodyEncoding !== 'base64') return response.body;
  try {
    return new TextDecoder().decode(base64ToBytes(response.body));
  } catch {
    return '';
  }
}

function contentTypeOf(headers: ApiResponse['headers']): string {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'content-type') return Array.isArray(v) ? (v[0] ?? '') : String(v);
  }
  return '';
}

function partsNotice(parts: number, done: boolean): string {
  const noun = parts === 1 ? 'part' : 'parts';
  return done
    ? `Incremental delivery: merged ${parts} multipart/mixed ${noun} (@defer / @stream) into one result.`
    : `Incremental delivery: ${parts} ${noun} received so far — more on the way…`;
}

/**
 * Fold a buffered `multipart/mixed` incremental GraphQL response into one
 * ordinary JSON result. Any other response is returned untouched.
 */
export function normalizeGraphQLResponse(response: ApiResponse): ApiResponse {
  const contentType = contentTypeOf(response.headers);
  if (!isMultipartMixed(contentType)) return response;
  const merged = mergeMultipartGraphQLBody(bodyText(response), contentType);
  if (!merged) return response;
  const { bodyEncoding: _drop, ...rest } = response;
  return {
    ...rest,
    body: JSON.stringify(merged.result, null, 2),
    bodyNotice: partsNotice(merged.parts, true),
  };
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

/**
 * Build a progress handler that parses `multipart/mixed` chunks as they arrive
 * and reports the merged result after every part. Non-multipart responses are
 * ignored (the buffered result arrives when the request resolves).
 */
export function createIncrementalProgress(
  onSnapshot: (snapshot: IncrementalSnapshot) => void
): (progress: ResponseProgress) => void {
  let parser: MultipartMixedParser | null | undefined;
  const merger = new GraphQLIncrementalMerger();
  return (progress) => {
    if (parser === undefined) {
      const ct = contentTypeOf(progress.headers);
      const boundary = isMultipartMixed(ct) ? parseMultipartBoundary(ct) : null;
      parser = boundary ? new MultipartMixedParser(boundary) : null;
    }
    if (!parser) return;
    let changed = false;
    for (const part of parser.feed(progress.chunk)) {
      const payload = parseIncrementalPart(part.body);
      if (payload === undefined) continue;
      merger.apply(payload);
      changed = true;
    }
    if (!changed || merger.payloadCount === 0) return;
    onSnapshot({
      status: progress.status,
      statusText: progress.statusText,
      headers: progress.headers,
      result: merger.result,
      parts: merger.payloadCount,
      hasNext: merger.hasNext,
    });
  };
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
    headers: snapshot.headers,
    body,
    size: new Blob([body]).size,
    time: now - startedAt,
    timestamp: now,
    bodyNotice: partsNotice(snapshot.parts, !snapshot.hasNext),
    partial: true,
  };
}
