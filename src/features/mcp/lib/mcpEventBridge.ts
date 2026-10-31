import { getElectronAPI, isElectron } from '@/lib/shared/platform';
import { EVENT_PREFIX, eventChannel } from '../../../../electron/shared/channels';

export interface McpServerEventHandlers {
  onNotification: (notification: unknown) => void;
  onError: (message: string) => void;
  onClose: (reason: string) => void;
}

/** Whether this harness has a server→client MCP channel (desktop IPC only). */
export function supportsMcpServerEvents(): boolean {
  return isElectron() && Boolean(getElectronAPI()?.mcp?.on);
}

function messageOf(payload: unknown, key: 'message' | 'reason', fallback: string): string {
  const value = (payload as Record<string, unknown> | null | undefined)?.[key];
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/**
 * Subscribe to the desktop main process's per-connection MCP event channels
 * (`mcp:notification:<id>`, `mcp:error:<id>`, `mcp:close:<id>`). Call this
 * BEFORE `connect` — the main process can emit during the handshake.
 *
 * Returns an idempotent unsubscribe that removes exactly the listeners it
 * added (the preload bridge keys wrappers by callback identity, so passing
 * the same function references back is what makes removal work).
 *
 * Web has no server→client channel: this is a no-op there.
 */
export function subscribeMcpEvents(
  connectionId: string,
  handlers: McpServerEventHandlers
): () => void {
  const api = isElectron() ? getElectronAPI()?.mcp : undefined;
  if (!api?.on) return () => {};

  const channels = {
    notification: eventChannel(EVENT_PREFIX.mcp.notification, connectionId),
    error: eventChannel(EVENT_PREFIX.mcp.error, connectionId),
    close: eventChannel(EVENT_PREFIX.mcp.close, connectionId),
  };
  const onNotification = (payload: unknown) => handlers.onNotification(payload);
  const onError = (payload: unknown) =>
    handlers.onError(messageOf(payload, 'message', 'Unknown MCP error'));
  const onClose = (payload: unknown) =>
    handlers.onClose(messageOf(payload, 'reason', 'connection closed'));

  api.on(channels.notification, onNotification as (...args: unknown[]) => void);
  api.on(channels.error, onError as (...args: unknown[]) => void);
  api.on(channels.close, onClose as (...args: unknown[]) => void);

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    api.removeListener(channels.notification, onNotification as (...args: unknown[]) => void);
    api.removeListener(channels.error, onError as (...args: unknown[]) => void);
    api.removeListener(channels.close, onClose as (...args: unknown[]) => void);
  };
}
