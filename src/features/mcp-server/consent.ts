/**
 * Consent model for the MCP server.
 *
 * When an MCP client (Claude Desktop, Cursor, Windsurf) connects to
 * Restura, the user controls which surfaces the agent may see. We gate
 * three independent dimensions:
 *
 *   1. Collections — per-collection level (hidden / read-only / full).
 *   2. Environments — per-environment level (hidden / read-only). The
 *      environment surface holds prod URLs, region/service identifiers
 *      and secret-flagged variables, so it gets its own switch.
 *   3. History — a single global switch (hidden / read-only) for the
 *      request-history log. History entries leak past prod traffic
 *      (URLs, status codes, timing) even after secret-field redaction.
 *
 * Every dimension defaults to 'hidden' — agents see nothing until the
 * user opts in. The cost of accidentally exposing a prod-credentialed
 * collection / environment to an agent is much higher than the cost of
 * one extra opt-in click.
 *
 * Consent is persisted in `useSettingsStore` so it survives reloads.
 */

import { z } from 'zod';

export const CollectionConsentLevelSchema = z.enum(['hidden', 'read-only', 'full']);
export type CollectionConsentLevel = z.infer<typeof CollectionConsentLevelSchema>;

/**
 * Environments and history don't have a meaningful 'full' level — the v1
 * MCP server can't *execute* against an environment or *modify* history,
 * so the binary hidden/read-only distinction is all that's exposed.
 */
export const SurfaceConsentLevelSchema = z.enum(['hidden', 'read-only']);
export type SurfaceConsentLevel = z.infer<typeof SurfaceConsentLevelSchema>;

export const McpServerConsentSchema = z.object({
  /** Default level for collections without an explicit setting. */
  defaultLevel: CollectionConsentLevelSchema,
  /** Per-collection overrides, keyed by Collection id. */
  perCollection: z.record(z.string(), CollectionConsentLevelSchema),
  /** Default level for environments without an explicit setting. */
  environmentsDefaultLevel: SurfaceConsentLevelSchema.optional(),
  /** Per-environment overrides, keyed by Environment id. */
  perEnvironment: z.record(z.string(), SurfaceConsentLevelSchema).optional(),
  /** Global gate on the request-history surface. */
  historyLevel: SurfaceConsentLevelSchema.optional(),
});
export type McpServerConsent = z.infer<typeof McpServerConsentSchema>;

/** Default consent: nothing exposed until the user opts in per surface. */
export const DEFAULT_CONSENT: McpServerConsent = {
  defaultLevel: 'hidden',
  perCollection: {},
  environmentsDefaultLevel: 'hidden',
  perEnvironment: {},
  historyLevel: 'hidden',
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

// ---------------------------------------------------------------------------
// Environment consent
// ---------------------------------------------------------------------------

export function getEnvironmentConsentLevel(
  consent: McpServerConsent,
  environmentId: string
): SurfaceConsentLevel {
  return consent.perEnvironment?.[environmentId] ?? consent.environmentsDefaultLevel ?? 'hidden';
}

/** Returns true iff the agent may see this environment's variables. */
export function canReadEnvironment(consent: McpServerConsent, environmentId: string): boolean {
  return getEnvironmentConsentLevel(consent, environmentId) === 'read-only';
}

export function setEnvironmentConsent(
  consent: McpServerConsent,
  environmentId: string,
  level: SurfaceConsentLevel
): McpServerConsent {
  return {
    ...consent,
    perEnvironment: { ...(consent.perEnvironment ?? {}), [environmentId]: level },
  };
}

export function clearEnvironmentConsent(
  consent: McpServerConsent,
  environmentId: string
): McpServerConsent {
  const { [environmentId]: _removed, ...rest } = consent.perEnvironment ?? {};
  void _removed;
  return { ...consent, perEnvironment: rest };
}

// ---------------------------------------------------------------------------
// History consent (single global switch)
// ---------------------------------------------------------------------------

export function canReadHistory(consent: McpServerConsent): boolean {
  return (consent.historyLevel ?? 'hidden') === 'read-only';
}

export function setHistoryConsent(
  consent: McpServerConsent,
  level: SurfaceConsentLevel
): McpServerConsent {
  return { ...consent, historyLevel: level };
}
