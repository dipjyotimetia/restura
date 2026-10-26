/**
 * The `_postman` sidecar: raw Postman JSON for constructs Restura cannot
 * model, held on the imported collection / folder / request item (ADR 0034).
 *
 * Modelled on OpenCollection's `_oc` passthrough bag:
 *  - attached at import only, and only when non-empty;
 *  - stripped along the mutation path by `useCollectionStore` (a stale bag must
 *    never describe a request the user has since edited);
 *  - sanitised / counted by `shared/secrets/collection-redaction.ts` — it can
 *    carry credentials (hawk keys, edgegrid tokens, jwt secrets, oauth
 *    secrets, saved-response headers and bodies);
 *  - never written into Postman v3 files (their schema is
 *    `additionalProperties: false`). Never log its contents.
 *
 * Keys mirror the Postman field names so the redactor can walk the bag in
 * Postman terms.
 */

export const POSTMAN_SIDECAR_KEY = '_postman';

export interface PostmanSidecar {
  /** Raw Postman auth block when it was unsupported or approximated. */
  auth?: unknown;
  /** Saved responses / examples (`item.response[]`). */
  response?: unknown[];
  protocolProfileBehavior?: unknown;
  /** Item-level variables (`item.variable[]`). */
  variable?: unknown[];
  /** Same-kind events that lost to the last one (only the last one is imported). */
  event?: unknown[];
  /** Raw `file` body (the source path is not resolvable at import). */
  body?: unknown;
}

export type WithPostmanSidecar<T> = T & { _postman?: PostmanSidecar };

export function getPostmanSidecar(node: object): PostmanSidecar | undefined {
  return (node as { _postman?: PostmanSidecar })._postman;
}

/** Attach `sidecar` to `node` when it holds anything; returns `node`. */
export function attachPostmanSidecar<T extends object>(
  node: T,
  sidecar: PostmanSidecar
): WithPostmanSidecar<T> {
  const entries = Object.entries(sidecar).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return node;
  return Object.assign(node, { [POSTMAN_SIDECAR_KEY]: Object.fromEntries(entries) });
}
