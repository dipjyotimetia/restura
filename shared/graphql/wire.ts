/**
 * GraphQL-over-HTTP wire shaping — runtime-neutral, shared by the renderer
 * (interactive Send + saved-request runs, via
 * `src/features/graphql/lib/graphqlHttp.ts`) and the CLI runner, so every
 * harness puts the same bytes on the wire.
 *
 * - Accept: `application/graphql-response+json, application/json;q=0.9`
 *   (GraphQL-over-HTTP spec) unless the user set their own Accept header.
 *   Documents using `@defer` / `@stream` also advertise `multipart/mixed`
 *   (incremental delivery, deferSpec=20220824).
 * - Method: POST (JSON envelope) or GET (query / variables / operationName /
 *   extensions URL-encoded as query params). GET is refused for mutations and
 *   subscriptions — the spec forbids mutations over GET (they are not safe).
 */

import type { HttpRequest, KeyValue } from '../types';
import {
  buildGraphQLRequestBody,
  listGraphQLOperations,
  selectGraphQLOperation,
} from './operations';

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

/**
 * The document text that runs for the selected operation: the operation
 * itself plus every non-operation definition (fragments it may spread),
 * with the other operations cut out. Uses the shared AST operation list
 * (#1107; lexer fallback while the document doesn't parse).
 */
function selectedOperationSource(query: string, operationName?: string | null): string {
  const { operations } = listGraphQLOperations(query);
  const selected = selectGraphQLOperation(operations, operationName);
  if (!selected) return query;
  let out = '';
  let cursor = 0;
  for (const op of [...operations].sort((a, b) => a.start - b.start)) {
    if (op === selected) continue;
    out += query.slice(cursor, op.start);
    cursor = Math.max(cursor, op.end);
  }
  return out + query.slice(cursor);
}

/**
 * True when the selected operation (or a fragment it could spread) uses
 * `@defer` or `@stream`; comments are ignored. A `@defer` in another
 * operation of the same document doesn't count.
 */
export function hasIncrementalDirective(query: string, operationName?: string | null): boolean {
  return /@(?:defer|stream)\b/.test(
    selectedOperationSource(query, operationName).replace(/#[^\n\r]*/g, '')
  );
}

/**
 * Why GET cannot carry this document, or null when it can. Judged on the
 * operation that will actually run — the selected one (`operationName`, as
 * sent), else the first — via the shared AST operation list, so leading
 * comments or fragments can't hide a mutation. Shorthand `{ … }` is a query.
 */
export function getRefusalReason(query: string, operationName?: string | null): string | null {
  const type = selectGraphQLOperation(listGraphQLOperations(query).operations, operationName)?.type;
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
 * Turn a saved GraphQL body (`type: 'graphql'`, `raw` = query document or an
 * envelope, `graphqlVariables` = variables JSON) into the envelope the wire
 * builder sends. A plain document goes through `buildGraphQLRequestBody`, the
 * same builder interactive Send uses, so every path puts the same bytes on the
 * wire (including the derived `operationName`). Variable substitution is the
 * caller's job and must happen before this call.
 */
export function graphqlEnvelopeFromBody(body: HttpRequest['body']): GraphQLEnvelope {
  const storedVariables = (() => {
    if (body.graphqlVariables === undefined) return undefined;
    try {
      const parsed = JSON.parse(body.graphqlVariables ?? '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  })();
  const raw = body.raw ?? '';
  let envelope: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.query === 'string') envelope = parsed;
  } catch {
    // Not JSON: a plain query document.
  }
  return (
    envelope
      ? { ...envelope, ...(storedVariables === undefined ? {} : { variables: storedVariables }) }
      : buildGraphQLRequestBody(raw, storedVariables ?? {}, body.graphqlOperationName)
  ) as GraphQLEnvelope;
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
      value: hasIncrementalDirective(envelope.query, envelope.operationName)
        ? GRAPHQL_INCREMENTAL_ACCEPT
        : GRAPHQL_ACCEPT,
      enabled: true,
    });
  }

  if (method === 'GET') {
    const refusal = getRefusalReason(envelope.query, envelope.operationName);
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
      request: {
        ...request,
        method,
        headers,
        params,
        body: { type: 'none' },
        // The query document goes in the URL: always percent-encode it, even
        // when the request opted out of URL encoding (raw `{`, `#`, `&` and
        // spaces would truncate or corrupt the query string).
        settings: { ...request.settings, encodeUrlAutomatically: true },
      },
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
