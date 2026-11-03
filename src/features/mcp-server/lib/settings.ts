/**
 * Read/write the persisted MCP control-server settings
 * (`useSettingsStore().settings.mcpServer`), defaulting to
 * DEFAULT_MCP_SERVER_SETTINGS (off, everything hidden) when absent.
 *
 * Every app window has its own in-memory settings store, and stores do not
 * sync across windows. The window that runs the server must still honour a
 * change made in another window (revoking access, turning the server off), so
 * policy decisions use {@link getFreshMcpServerSettings}: the newer of the
 * in-memory copy and the persisted one, by `updatedAt`.
 */

import type { McpServerConsent } from '@shared/mcp-server/consent';
import {
  DEFAULT_MCP_SERVER_SETTINGS,
  type McpServerSettings,
  McpServerSettingsCatchSchema,
} from '@shared/mcp-server/settings';
import { dexieStorageAdapters } from '@/lib/shared/dexie-storage';
import { useSettingsStore } from '@/store/useSettingsStore';

/** The settings store's persist name (useSettingsStore `persist({ name })`). */
const SETTINGS_STORAGE_NAME = 'app-settings-storage';

export function getMcpServerSettings(): McpServerSettings {
  return useSettingsStore.getState().settings.mcpServer ?? DEFAULT_MCP_SERVER_SETTINGS;
}

export function useMcpServerSettings(): McpServerSettings {
  return useSettingsStore((s) => s.settings.mcpServer ?? DEFAULT_MCP_SERVER_SETTINGS);
}

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

/** The persisted copy (another window may have written it), or null. */
export async function readPersistedMcpServerSettings(): Promise<McpServerSettings | null> {
  try {
    const stored = (await dexieStorageAdapters.settings().getItem(SETTINGS_STORAGE_NAME)) as {
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
 * The newest MCP settings across windows. When the persisted copy is newer,
 * it is also adopted into this window's store so the UI and later reads agree.
 */
export async function getFreshMcpServerSettings(): Promise<McpServerSettings> {
  const local = getMcpServerSettings();
  const persisted = await readPersistedMcpServerSettings();
  if (!persisted || (persisted.updatedAt ?? 0) <= (local.updatedAt ?? 0)) {
    // Re-read: a local change may have landed while we awaited storage.
    return getMcpServerSettings();
  }
  useSettingsStore.setState((state) => ({
    settings: { ...state.settings, mcpServer: persisted },
  }));
  return persisted;
}
