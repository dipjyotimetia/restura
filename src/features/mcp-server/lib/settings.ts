/**
 * Read/write the persisted MCP control-server settings
 * (`useSettingsStore().settings.mcpServer`), defaulting to
 * DEFAULT_MCP_SERVER_SETTINGS (off, everything hidden) when absent.
 *
 * Every app window has its own in-memory settings store, and stores do not
 * sync across windows. The window that runs the server must still honour a
 * change made in another window (revoking access, turning the server off),
 * and a window must never write its stale copy over a newer one. So:
 *
 *  - policy decisions use {@link getFreshMcpServerSettings}: when the
 *    persisted copy is newer (by `updatedAt`), this window re-reads the whole
 *    persisted settings through the store's own `persist.rehydrate()` — which
 *    adopts them without writing anything back, so no other setting another
 *    window changed is clobbered;
 *  - user edits go through {@link updateMcpServerSettingsFresh}, which
 *    refreshes first and then applies the change on top of the newest copy.
 */

import type { McpServerConsent } from '@shared/mcp-server/consent';
import {
  DEFAULT_MCP_SERVER_SETTINGS,
  type McpServerSettings,
  McpServerSettingsCatchSchema,
} from '@shared/mcp-server/settings';
import { useSettingsStore } from '@/store/useSettingsStore';

export function getMcpServerSettings(): McpServerSettings {
  return useSettingsStore.getState().settings.mcpServer ?? DEFAULT_MCP_SERVER_SETTINGS;
}

export function useMcpServerSettings(): McpServerSettings {
  return useSettingsStore((s) => s.settings.mcpServer ?? DEFAULT_MCP_SERVER_SETTINGS);
}

/**
 * Apply a change to this window's copy and persist it, stamped newest. Used
 * by agent tools (right after the runtime read fresh settings); user edits
 * use {@link updateMcpServerSettingsFresh}.
 */
export function updateMcpServerSettings(patch: Partial<McpServerSettings>): void {
  const current = getMcpServerSettings();
  useSettingsStore
    .getState()
    .updateSettings({ mcpServer: { ...current, ...patch, updatedAt: Date.now() } });
}

export function updateMcpConsent(update: (consent: McpServerConsent) => McpServerConsent): void {
  const current = getMcpServerSettings();
  updateMcpServerSettings({ consent: update(current.consent) });
}

/** A user edit: refresh from other windows first, then apply on top of the newest copy. */
export async function updateMcpServerSettingsFresh(
  patch: Partial<McpServerSettings>
): Promise<void> {
  await getFreshMcpServerSettings();
  updateMcpServerSettings(patch);
}

export async function updateMcpConsentFresh(
  update: (consent: McpServerConsent) => McpServerConsent
): Promise<void> {
  await getFreshMcpServerSettings();
  updateMcpConsent(update);
}

interface SettingsPersistApi {
  getOptions: () => {
    name?: string;
    storage?: { getItem: (name: string) => unknown | Promise<unknown> };
  };
  rehydrate: () => Promise<void> | void;
}

const persistApi = (): SettingsPersistApi | undefined =>
  (useSettingsStore as unknown as { persist?: SettingsPersistApi }).persist;

/**
 * The persisted MCP settings, read through the settings store's own persist
 * name and storage (never a copy of them), or null.
 */
export async function readPersistedMcpServerSettings(): Promise<McpServerSettings | null> {
  try {
    const options = persistApi()?.getOptions();
    if (!options?.name || !options.storage) return null;
    const stored = (await options.storage.getItem(options.name)) as {
      state?: { settings?: { mcpServer?: unknown } };
    } | null;
    const raw = stored?.state?.settings?.mcpServer;
    if (raw === undefined || raw === null) return null;
    return McpServerSettingsCatchSchema.parse(raw) as McpServerSettings;
  } catch {
    return null;
  }
}

/**
 * The newest MCP settings across windows. When the persisted copy is newer
 * than this window's, the window adopts the whole persisted settings (see the
 * module comment) and the adopted copy is returned.
 */
export async function getFreshMcpServerSettings(): Promise<McpServerSettings> {
  const persisted = await readPersistedMcpServerSettings();
  // Compare against this window's copy as it is NOW: a local change may have
  // landed while storage was being read.
  const local = getMcpServerSettings();
  if (!persisted || (persisted.updatedAt ?? 0) <= (local.updatedAt ?? 0)) return local;
  try {
    await persistApi()?.rehydrate();
  } catch {
    // Storage unavailable: keep the local copy rather than fail the call.
    return getMcpServerSettings();
  }
  const adopted = getMcpServerSettings();
  // If rehydrate could not deliver the newer copy, never fall back to the
  // older one silently: the persisted read is the newest known state.
  return (adopted.updatedAt ?? 0) >= (persisted.updatedAt ?? 0) ? adopted : persisted;
}
