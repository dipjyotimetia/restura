/**
 * MCP dispatch-context loader (headless mode).
 *
 * The renderer's Zustand stores (collections, environments, history, MCP
 * consent settings) are persisted to IndexedDB via the dexie-storage
 * adapter. IndexedDB lives in the renderer process — the main process can't
 * read it directly.
 *
 * For v1 of the headless `restura --mcp-server` mode we return an empty
 * context with default (hidden) consent. This means every tool call refuses
 * with a "hidden from MCP agents" error until the user explicitly opts in
 * via a UI flow that we'll add in a follow-up. That's deliberately
 * fail-closed: a misconfigured MCP client connecting before opt-in cannot
 * read any user data.
 *
 * Follow-up work (tracked in ADR-0011):
 *   1. Add a renderer→main state-sync IPC that mirrors the relevant Zustand
 *      slices into a main-process snapshot keyed by user-id.
 *   2. Persist that snapshot under `userData/mcp-context.json` so the
 *      headless subprocess can read it at boot without the renderer running.
 *   3. Replace the empty defaults below with `JSON.parse(snapshotFile)`.
 */

import { DEFAULT_CONSENT } from '@shared/mcp-server/consent';
import type { McpDispatchContext } from '@shared/mcp-server/dispatch';

/**
 * Load (or synthesize) the dispatch context. The headless MCP server calls
 * this on every tool invocation, so any future implementation can read fresh
 * state off disk without restarting.
 */
export function loadMcpDispatchContext(): McpDispatchContext {
  return {
    collections: [],
    environments: [],
    history: [],
    consent: DEFAULT_CONSENT,
  };
}
