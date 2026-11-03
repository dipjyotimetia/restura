/**
 * Read/write the persisted MCP control-server settings
 * (`useSettingsStore().settings.mcpServer`), defaulting to
 * DEFAULT_MCP_SERVER_SETTINGS (off, everything hidden) when absent.
 */

import type { McpServerConsent } from '@shared/mcp-server/consent';
import { DEFAULT_MCP_SERVER_SETTINGS, type McpServerSettings } from '@shared/mcp-server/settings';
import { useSettingsStore } from '@/store/useSettingsStore';

export function getMcpServerSettings(): McpServerSettings {
  return useSettingsStore.getState().settings.mcpServer ?? DEFAULT_MCP_SERVER_SETTINGS;
}

export function useMcpServerSettings(): McpServerSettings {
  return useSettingsStore((s) => s.settings.mcpServer ?? DEFAULT_MCP_SERVER_SETTINGS);
}

export function updateMcpServerSettings(patch: Partial<McpServerSettings>): void {
  const current = getMcpServerSettings();
  useSettingsStore.getState().updateSettings({ mcpServer: { ...current, ...patch } });
}

export function updateMcpConsent(update: (consent: McpServerConsent) => McpServerConsent): void {
  const current = getMcpServerSettings();
  updateMcpServerSettings({ consent: update(current.consent) });
}
