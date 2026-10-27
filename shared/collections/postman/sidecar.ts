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
  /** Original request method when it was unsendable and imported as GET. */
  method?: unknown;
  /** Request `url.variable[]` when some entries could not be applied losslessly. */
  urlVariable?: unknown[];
  /** Raw `file` body, or a form-data body with file rows (paths are not resolvable at import). */
  body?: unknown;
  // ── v3 (#1200). Credential-bearing v3 data is stored in the v2 shapes above
  // (auth as `{ type, [type]: [{ key, value }] }`, examples as `response[]`)
  // so the redactor walks it; the raw fields below are scrubbed at import.
  /** v3 request `settings` with no Restura equivalent. */
  settings?: unknown;
  /** v3 collection scripts for protocols other than HTTP. */
  scripts?: unknown[];
  /** v3 linked schema (`schema`). */
  schema?: unknown;
  /** v3 root `uses` (linked environments). */
  uses?: unknown;
  /**
   * The `auth` block was not mapped onto any typed model (v3 broker presets,
   * placeholder items): every credential in it is bag-only.
   */
  authBagOnly?: true;
  /**
   * The Postman auth on this collection / folder / request was an explicit
   * `noauth` (#1232). Restura's `{ type: 'none' }` means *inherit*, so this
   * marker is what keeps "deliberately unauthenticated" distinct: it cuts
   * auth inheritance on import, blocks sending (no ancestor credential may be
   * substituted), and makes Postman export write `noauth` explicitly.
   */
  noauth?: true;
  /** v3 broker options with no preset equivalent (extra topics / messages, stopAfter). */
  leftovers?: unknown;
  /** v3 folder description (Restura folders have none). */
  description?: string;
  /** v3 multi-entry auth: shape of every credential set (keys only, never values). */
  authSets?: unknown[];
  /** Raw v3 item with no Restura equivalent (credentials scrubbed). */
  item?: unknown;
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

/** Remove the sidecar from `node` in place (staleness paths); returns `node`. */
export function clearPostmanSidecar<T extends object>(node: T): T {
  delete (node as { _postman?: unknown })._postman;
  return node;
}
