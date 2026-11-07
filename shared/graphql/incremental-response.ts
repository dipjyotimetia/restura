/**
 * Fold a buffered `multipart/mixed` incremental GraphQL response (`@defer` /
 * `@stream`, deferSpec=20220824) into one ordinary JSON result — runtime-
 * neutral, shared by the renderer (`normalizeGraphQLResponse`) and the CLI
 * runner, so `pm.response.json()` sees the same merged result everywhere.
 */

import { base64ToBytes } from '../protocol/crypto-utils';
import { mergeMultipartGraphQLBody } from '../protocol/graphql-incremental';
import { isMultipartMixed } from '../protocol/multipart-mixed-parser';

export type GraphQLResponseHeaders = Record<string, string | string[]>;

/** The response fields the merge reads; any extra fields pass through. */
export interface IncrementalResponseLike {
  headers: GraphQLResponseHeaders;
  body: string;
  bodyEncoding?: 'base64';
  bodyNotice?: string;
}

function bodyText(response: Pick<IncrementalResponseLike, 'body' | 'bodyEncoding'>): string {
  if (response.bodyEncoding !== 'base64') return response.body;
  try {
    return new TextDecoder().decode(base64ToBytes(response.body));
  } catch {
    return '';
  }
}

/** The Content-Type header value, case-insensitively (first value of a list). */
export function contentTypeOf(headers: GraphQLResponseHeaders): string {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'content-type') return Array.isArray(v) ? (v[0] ?? '') : String(v);
  }
  return '';
}

/**
 * The merged body is JSON, so say so: downstream text/binary classification
 * (collection-run evidence, test scripts, the viewer) keys off Content-Type,
 * and `multipart/mixed` reads as binary. The notice records the original. The
 * multipart Content-Length is dropped: it measured the replaced body.
 */
export function withJsonContentType<T extends GraphQLResponseHeaders>(headers: T): T {
  const out: Record<string, string | string[]> = {};
  let replaced = false;
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    // The multipart body's length no longer describes the merged JSON body.
    if (lower === 'content-length') continue;
    if (lower === 'content-type') {
      out[k] = 'application/json; charset=utf-8';
      replaced = true;
    } else {
      out[k] = v;
    }
  }
  if (!replaced) out['content-type'] = 'application/json; charset=utf-8';
  return out as T;
}

/**
 * `done` = the server signalled `hasNext: false`. `streamEnded` = the body is
 * fully buffered: a stream that ended while `hasNext` was still true is
 * incomplete (deferred/streamed parts never arrived), not "more on the way".
 */
export function incrementalPartsNotice(parts: number, done: boolean, streamEnded = false): string {
  const noun = parts === 1 ? 'part' : 'parts';
  if (done) {
    return `Incremental delivery: merged ${parts} multipart/mixed ${noun} (@defer / @stream) into one JSON result.`;
  }
  return streamEnded
    ? `Incremental delivery incomplete: the response ended after ${parts} multipart/mixed ${noun} while the server still signalled more (hasNext) — deferred/streamed parts are missing from this result.`
    : `Incremental delivery: ${parts} ${noun} received so far — more on the way…`;
}

/**
 * Fold a buffered `multipart/mixed` incremental GraphQL response into one
 * ordinary JSON result (JSON Content-Type, `bodyEncoding` dropped, a notice
 * naming the merge). Any other response is returned untouched.
 */
export function mergeIncrementalGraphQLResponse<T extends IncrementalResponseLike>(response: T): T {
  const contentType = contentTypeOf(response.headers);
  if (!isMultipartMixed(contentType)) return response;
  try {
    const merged = mergeMultipartGraphQLBody(bodyText(response), contentType);
    if (!merged) return response;
    const { bodyEncoding: _drop, ...rest } = response;
    return {
      ...rest,
      headers: withJsonContentType(response.headers),
      body: JSON.stringify(merged.result, null, 2),
      bodyNotice: incrementalPartsNotice(merged.parts, !merged.hasNext, true),
    } as T;
  } catch {
    // A pathological body (e.g. nesting too deep to serialise): keep it raw.
    return response;
  }
}
