/**
 * Mounted once at the app root (desktop only). Connects the main-process MCP
 * control server to the renderer tool runtime:
 *
 *  - keeps the server running exactly while `settings.mcpServer.enabled` is
 *    on (after settings have rehydrated — never on a default value);
 *  - answers every forwarded tool call with `runControlTool` and drops
 *    approval cards for calls main reports as cancelled;
 *  - renders the approval and secret-prompt dialogs.
 */

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { getElectronAPI, isElectron } from '@/lib/shared/platform';
import { useSettingsStore } from '@/store/useSettingsStore';
import { cancelAllControlToolCalls, cancelControlToolCall, runControlTool } from '../lib/runtime';
import { getMcpServerSettings, useMcpServerSettings } from '../lib/settings';
import { useMcpServerRuntimeStore } from '../store/useMcpServerRuntimeStore';
import { McpApprovalDialog } from './McpApprovalDialog';
import { McpSecretPromptDialog } from './McpSecretPromptDialog';

const STATUS_POLL_MS = 5_000;

interface PersistApi {
  hasHydrated: () => boolean;
  onFinishHydration: (fn: () => void) => () => void;
}

/** True once the persisted settings are loaded, so a default `enabled: false` never stops a server. */
function useSettingsHydrated(): boolean {
  const persistApi = (useSettingsStore as unknown as { persist?: PersistApi }).persist;
  const [hydrated, setHydrated] = useState(() => persistApi?.hasHydrated() ?? true);
  useEffect(() => {
    if (hydrated || !persistApi) return;
    if (persistApi.hasHydrated()) {
      setHydrated(true);
      return;
    }
    return persistApi.onFinishHydration(() => setHydrated(true));
  }, [hydrated, persistApi]);
  return hydrated;
}

/** Start / stop the main-process server. Exported for the Settings screen. */
export async function startMcpControlServer(options: { rotateToken?: boolean } = {}) {
  const api = getElectronAPI()?.mcpControl;
  if (!api) return;
  const { preferredPort } = getMcpServerSettings();
  const res = await api.start({
    ...(preferredPort !== undefined ? { preferredPort } : {}),
    ...(options.rotateToken ? { rotateToken: true } : {}),
  });
  const store = useMcpServerRuntimeStore.getState();
  if (res.ok) {
    store.setStatus(res.status, res.token);
    store.setLastError(null);
  } else {
    store.setLastError(res.error);
    toast.error('Could not start the MCP server', { description: res.error });
  }
}

export async function stopMcpControlServer() {
  const api = getElectronAPI()?.mcpControl;
  if (!api) return;
  cancelAllControlToolCalls();
  const res = await api.stop();
  useMcpServerRuntimeStore.getState().setStatus(res.status, null);
}

export function McpControlBridge() {
  const settings = useMcpServerSettings();
  const hydrated = useSettingsHydrated();
  const running = useMcpServerRuntimeStore((s) => s.status.running);

  // Tool calls from main → runtime → answer.
  useEffect(() => {
    if (!isElectron()) return;
    const api = getElectronAPI()?.mcpControl;
    if (!api) return;
    const offCall = api.onToolCall((call) => {
      void runControlTool(call)
        .catch((err: unknown) => ({
          ok: false as const,
          error: err instanceof Error ? err.message : String(err),
        }))
        .then((result) => api.sendToolResult({ callId: call.callId, result }))
        .catch(() => undefined);
    });
    const offCancel = api.onToolCancelled(({ callId }) => cancelControlToolCall(callId));
    return () => {
      if (typeof offCall === 'function') offCall();
      if (typeof offCancel === 'function') offCancel();
      cancelAllControlToolCalls();
    };
  }, []);

  // Keep the server in step with the setting.
  useEffect(() => {
    if (!isElectron() || !hydrated) return;
    if (settings.enabled && !running) void startMcpControlServer();
    if (!settings.enabled && running) void stopMcpControlServer();
  }, [settings.enabled, hydrated, running]);

  // Status (port, in-flight, last call) while running.
  useEffect(() => {
    if (!isElectron() || !running) return;
    const api = getElectronAPI()?.mcpControl;
    if (!api) return;
    const id = setInterval(() => {
      void api.status().then((res) => {
        if (res.ok) useMcpServerRuntimeStore.getState().setStatus(res.status);
      });
    }, STATUS_POLL_MS);
    return () => clearInterval(id);
  }, [running]);

  if (!isElectron()) return null;
  return (
    <>
      <McpApprovalDialog />
      <McpSecretPromptDialog />
    </>
  );
}
