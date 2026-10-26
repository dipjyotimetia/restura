/**
 * Import passthrough bags cached on collections / items:
 *  - `_oc` — OpenCollection's verbatim imported node (byte-stable round-trips);
 *  - `_postman` — raw Postman constructs Restura cannot model (ADR 0034).
 *
 * Any path that makes a cached bag stale (an edit, a move, a duplicate with
 * fresh identity) must drop ALL of them; iterate this list rather than naming
 * one bag so a new importer's bag cannot be forgotten.
 */
export const PASSTHROUGH_BAG_KEYS = ['_oc', '_postman'] as const;

export type PassthroughBagKey = (typeof PASSTHROUGH_BAG_KEYS)[number];

/** Delete every passthrough bag from `node` in place; returns `node`. */
export function deletePassthroughBags<T extends object>(node: T): T {
  for (const key of PASSTHROUGH_BAG_KEYS) delete (node as Record<string, unknown>)[key];
  return node;
}

export function hasPassthroughBag(node: object): boolean {
  return PASSTHROUGH_BAG_KEYS.some((key) => key in node);
}
