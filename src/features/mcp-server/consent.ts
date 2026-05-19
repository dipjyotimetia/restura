/**
 * Per-collection consent model for the MCP server.
 *
 * When an MCP client (Claude Desktop, Cursor, Windsurf) connects to
 * Restura, the user controls which collections the agent may operate on
 * and at what level:
 *
 *   - 'hidden'    — the collection doesn't appear in `list_collections`
 *   - 'read-only' — appears, request shapes readable, but `execute_request`
 *                   refuses for any request in this collection
 *   - 'full'      — listable + executable (a future tool that lands once
 *                   the renderer/main architecture is sorted)
 *
 * The default for a newly imported / created collection is 'hidden' —
 * agents see nothing until the user opts in. This is intentional. The
 * cost of accidentally exposing a prod-credentialed collection to an
 * agent is much higher than the cost of one extra opt-in click.
 *
 * Consent is persisted in `useSettingsStore` so it survives reloads.
 */

import { z } from 'zod';

export const CollectionConsentLevelSchema = z.enum(['hidden', 'read-only', 'full']);
export type CollectionConsentLevel = z.infer<typeof CollectionConsentLevelSchema>;

export const McpServerConsentSchema = z.object({
  /** Default level for collections without an explicit setting. */
  defaultLevel: CollectionConsentLevelSchema,
  /** Per-collection overrides, keyed by Collection id. */
  perCollection: z.record(z.string(), CollectionConsentLevelSchema),
});
export type McpServerConsent = z.infer<typeof McpServerConsentSchema>;

/** Default consent: nothing exposed until the user opts in per collection. */
export const DEFAULT_CONSENT: McpServerConsent = {
  defaultLevel: 'hidden',
  perCollection: {},
};

export function getConsentLevel(
  consent: McpServerConsent,
  collectionId: string
): CollectionConsentLevel {
  return consent.perCollection[collectionId] ?? consent.defaultLevel;
}

/**
 * Returns true iff the agent is allowed to *see* a collection (list it,
 * inspect its requests, read its env vars).
 */
export function canRead(consent: McpServerConsent, collectionId: string): boolean {
  const level = getConsentLevel(consent, collectionId);
  return level === 'read-only' || level === 'full';
}

/**
 * Returns true iff the agent is allowed to *execute* requests in a
 * collection. v1 always returns false (execute lands in a follow-up) — this
 * helper is wired up so the gate is enforced once execute_request lands.
 */
export function canExecute(consent: McpServerConsent, collectionId: string): boolean {
  return getConsentLevel(consent, collectionId) === 'full';
}

/** Set the consent level for a specific collection. */
export function setCollectionConsent(
  consent: McpServerConsent,
  collectionId: string,
  level: CollectionConsentLevel
): McpServerConsent {
  return {
    ...consent,
    perCollection: { ...consent.perCollection, [collectionId]: level },
  };
}

/** Remove a per-collection override, falling back to defaultLevel. */
export function clearCollectionConsent(
  consent: McpServerConsent,
  collectionId: string
): McpServerConsent {
  const { [collectionId]: _removed, ...rest } = consent.perCollection;
  void _removed;
  return { ...consent, perCollection: rest };
}
