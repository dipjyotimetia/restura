/**
 * Consent model for the MCP server.
 *
 * When an MCP client (Claude Code, Claude Desktop, Codex, Cursor) connects to
 * Restura, the user controls which surfaces the agent may see and change. We
 * gate four independent dimensions:
 *
 *   1. Collections — per-collection level:
 *        hidden    → the agent cannot discover it exists
 *        read-only → list/inspect its requests (redacted)
 *        edit      → also create/update/move/delete items in it
 *        full      → also *send* its requests (collection runner pipeline)
 *   2. Environments — per-environment level (hidden / read-only / edit). The
 *      environment surface holds prod URLs, region/service identifiers
 *      and secret-flagged variables, so it gets its own switch.
 *   3. Execution environments — a per-environment "agents may send requests
 *      using this environment" flag, independent of read/edit. Sending with an
 *      environment uses its credentials against its hosts, so it is opted in
 *      one environment at a time.
 *   4. History — a single global switch (hidden / read-only) for the
 *      request-history log. History entries leak past prod traffic
 *      (URLs, status codes, timing) even after secret-field redaction.
 *
 * Every dimension defaults to 'hidden' / off — agents see nothing until the
 * user opts in. The cost of accidentally exposing a prod-credentialed
 * collection / environment to an agent is much higher than the cost of
 * one extra opt-in click.
 *
 * Consent is persisted in `useSettingsStore` (`settings.mcpServer.consent`)
 * so it survives reloads. No MCP tool can read or change it (ADR 0041).
 */

import { z } from 'zod';

export const CollectionConsentLevelSchema = z.enum(['hidden', 'read-only', 'edit', 'full']);
export type CollectionConsentLevel = z.infer<typeof CollectionConsentLevelSchema>;

/**
 * History has no meaningful write level — agents never modify it — so the
 * binary hidden/read-only distinction is all that's exposed.
 */
export const SurfaceConsentLevelSchema = z.enum(['hidden', 'read-only']);
export type SurfaceConsentLevel = z.infer<typeof SurfaceConsentLevelSchema>;

/** Environments can additionally be opened for edits (variables, rename). */
export const EnvironmentConsentLevelSchema = z.enum(['hidden', 'read-only', 'edit']);
export type EnvironmentConsentLevel = z.infer<typeof EnvironmentConsentLevelSchema>;

export const McpServerConsentSchema = z.object({
  /** Default level for collections without an explicit setting. */
  defaultLevel: CollectionConsentLevelSchema,
  /** Per-collection overrides, keyed by Collection id. */
  perCollection: z.record(z.string(), CollectionConsentLevelSchema),
  /** Default level for environments without an explicit setting. */
  environmentsDefaultLevel: EnvironmentConsentLevelSchema.optional(),
  /** Per-environment overrides, keyed by Environment id. */
  perEnvironment: z.record(z.string(), EnvironmentConsentLevelSchema).optional(),
  /**
   * Environments an agent may *send requests with*, keyed by Environment id.
   * Absent / false = not allowed. There is deliberately no default-level for
   * this dimension: every environment is opted in individually.
   */
  executableEnvironments: z.record(z.string(), z.boolean()).optional(),
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
  executableEnvironments: {},
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
 * inspect its requests).
 */
export function canRead(consent: McpServerConsent, collectionId: string): boolean {
  return getConsentLevel(consent, collectionId) !== 'hidden';
}

/** Returns true iff the agent may create/update/move/delete items in a collection. */
export function canEdit(consent: McpServerConsent, collectionId: string): boolean {
  const level = getConsentLevel(consent, collectionId);
  return level === 'edit' || level === 'full';
}

/** Returns true iff the agent is allowed to *send* requests saved in a collection. */
export function canExecute(consent: McpServerConsent, collectionId: string): boolean {
  return getConsentLevel(consent, collectionId) === 'full';
}

/**
 * Creating a brand-new collection has no per-collection level to consult yet:
 * it is allowed when the *default* level would grant edit, or when the user has
 * granted edit on at least one collection (a deliberate write opt-in). The new
 * collection is then given an explicit `edit` override by the host so the agent
 * can keep working in what it created — and nothing else.
 */
export function canCreateCollection(consent: McpServerConsent): boolean {
  if (consent.defaultLevel === 'edit' || consent.defaultLevel === 'full') return true;
  return Object.values(consent.perCollection).some((l) => l === 'edit' || l === 'full');
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
): EnvironmentConsentLevel {
  return consent.perEnvironment?.[environmentId] ?? consent.environmentsDefaultLevel ?? 'hidden';
}

/** Returns true iff the agent may see this environment's (redacted) variables. */
export function canReadEnvironment(consent: McpServerConsent, environmentId: string): boolean {
  return getEnvironmentConsentLevel(consent, environmentId) !== 'hidden';
}

/** Returns true iff the agent may add/update/remove this environment's variables. */
export function canEditEnvironment(consent: McpServerConsent, environmentId: string): boolean {
  return getEnvironmentConsentLevel(consent, environmentId) === 'edit';
}

/** Same rule as {@link canCreateCollection}, for environments. */
export function canCreateEnvironment(consent: McpServerConsent): boolean {
  if (consent.environmentsDefaultLevel === 'edit') return true;
  return Object.values(consent.perEnvironment ?? {}).some((l) => l === 'edit');
}

/**
 * Returns true iff the agent may send requests using this environment's
 * variables. `null` (no environment) is always allowed — the request then only
 * sees globals and collection variables, which the collection's `full` level
 * already covers.
 */
export function canExecuteWithEnvironment(
  consent: McpServerConsent,
  environmentId: string | null
): boolean {
  if (environmentId === null) return true;
  return consent.executableEnvironments?.[environmentId] === true;
}

export function setEnvironmentExecutable(
  consent: McpServerConsent,
  environmentId: string,
  executable: boolean
): McpServerConsent {
  const { [environmentId]: _old, ...rest } = consent.executableEnvironments ?? {};
  void _old;
  return {
    ...consent,
    executableEnvironments: executable ? { ...rest, [environmentId]: true } : rest,
  };
}

export function setEnvironmentConsent(
  consent: McpServerConsent,
  environmentId: string,
  level: EnvironmentConsentLevel
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
