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

import type { ControlToolResult } from '@shared/mcp-server/control-bridge';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { getElectronAPI, isElectron } from '@/lib/shared/platform';
import { useSettingsStore } from '@/store/useSettingsStore';
import {
  boundedError,
  cancelAllControlToolCalls,
  cancelControlToolCall,
  runControlTool,
} from '../lib/runtime';
import {
  getFreshMcpServerSettings,
  getMcpServerSettings,
  useMcpServerSettings,
} from '../lib/settings';
import { useMcpServerRuntimeStore } from '../store/useMcpServerRuntimeStore';
import { McpApprovalDialog } from './McpApprovalDialog';
import { McpSecretPromptDialog } from './McpSecretPromptDialog';

const STATUS_POLL_MS = 5_000;

interface PersistApi {
  hasHydrated: () => boolean;
  onFinishHydration: (fn: () => void) => () => void;
}

/** Zustand persist API of the settings store (module-stable). */
const settingsPersist = (useSettingsStore as unknown as { persist?: PersistApi }).persist;

/** True once the persisted settings are loaded, so a default `enabled: false` never stops a server. */
function useSettingsHydrated(): boolean {
  const [hydrated, setHydrated] = useState(() => settingsPersist?.hasHydrated() ?? true);
  useEffect(() => {
    if (hydrated || !settingsPersist) return;
    if (settingsPersist.hasHydrated()) {
      setHydrated(true);
      return;
    }
    return settingsPersist.onFinishHydration(() => setHydrated(true));
  }, [hydrated]);
  return hydrated;
}

function reportIpcError(action: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  useMcpServerRuntimeStore.getState().setLastError(`${action}: ${message}`);
}

/** Refresh status, token and the launch command from main. Never throws. */
export async function refreshMcpControlStatus(): Promise<void> {
  const api = getElectronAPI()?.mcpControl;
  if (!api) return;
  try {
    const res = await api.status();
    const store = useMcpServerRuntimeStore.getState();
    store.setStatus(res.status, res.status.running ? (res.token ?? null) : null);
    store.setLaunch(res.launch);
  } catch (err) {
    reportIpcError('Could not read the MCP server status', err);
  }
}

/** Start / stop the main-process server. Exported for the Settings screen. */
export async function startMcpControlServer(options: { rotateToken?: boolean } = {}) {
  const api = getElectronAPI()?.mcpControl;
  if (!api) return;
  const { preferredPort } = getMcpServerSettings();
  const store = useMcpServerRuntimeStore.getState();
  try {
    const res = await api.start({
      ...(preferredPort !== undefined ? { preferredPort } : {}),
      ...(options.rotateToken ? { rotateToken: true } : {}),
    });
    if (res.ok) {
      store.setStatus(res.status, res.token);
      store.setLaunch(res.launch);
      store.setLastError(null);
    } else {
      store.setLastError(res.error);
      toast.error('Could not start the MCP server', { description: res.error });
    }
  } catch (err) {
    reportIpcError('Could not start the MCP server', err);
  }
}

/**
 * Adopt a server that is already running (another window, or this one before
 * a reload) instead of restarting it — a restart would move ownership and
 * cancel in-flight calls. Start one only when none is running AND the newest
 * settings (possibly written by another window) still say enabled.
 */
async function ensureMcpControlServer() {
  const api = getElectronAPI()?.mcpControl;
  if (!api) return;
  try {
    const current = await api.status();
    if (current.status.running) {
      const store = useMcpServerRuntimeStore.getState();
      store.setStatus(current.status, current.token ?? null);
      store.setLaunch(current.launch);
      return;
    }
  } catch (err) {
    reportIpcError('Could not read the MCP server status', err);
    return;
  }
  // Another window may have turned the server off: never restart it from a
  // stale in-memory copy of the setting.
  const fresh = await getFreshMcpServerSettings();
  if (fresh.enabled) await startMcpControlServer();
}

export async function stopMcpControlServer() {
  const api = getElectronAPI()?.mcpControl;
  if (!api) return;
  cancelAllControlToolCalls();
  try {
    const res = await api.stop();
    useMcpServerRuntimeStore.getState().setStatus(res.status, null);
  } catch (err) {
    reportIpcError('Could not stop the MCP server', err);
  }
}

/** Answer one call; if main rejects the answer, still release the agent with a short error. */
async function answer(
  api: NonNullable<ReturnType<typeof getElectronAPI>>['mcpControl'],
  callId: string,
  result: ControlToolResult
): Promise<void> {
  try {
    await api.sendToolResult({ callId, result });
  } catch {
    await api
      .sendToolResult({
        callId,
        result: { ok: false, error: 'Restura could not return this result. Try a narrower call.' },
      })
      .catch(() => undefined);
  }
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
        .catch((err: unknown) => ({ ok: false as const, error: boundedError(err) }))
        .then((result) => answer(api, call.callId, result));
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
    if (settings.enabled && !running) void ensureMcpControlServer();
    if (!settings.enabled && running) void stopMcpControlServer();
  }, [settings.enabled, hydrated, running]);

  // Launch command for the Settings snippets (even while the server is off).
  useEffect(() => {
    if (isElectron()) void refreshMcpControlStatus();
  }, []);

  // While running: status (port, in-flight, last call), and the newest
  // settings, so a change made in another window shows up and takes effect.
  useEffect(() => {
    if (!isElectron() || !running) return;
    const id = setInterval(() => {
      void refreshMcpControlStatus();
      void getFreshMcpServerSettings();
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
