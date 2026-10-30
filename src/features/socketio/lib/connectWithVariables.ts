/**
 * Socket.IO connect with `{{var}}` resolution (SIO-2, SIO-4).
 *
 * The URL and — in JSON auth mode — the handshake auth payload are resolved
 * through the shared streaming resolver at connect time and handed to the
 * manager for this live connection only. Nothing resolved is written back to
 * the persisted store, so the `{{var}}` template survives and secrets never
 * land in IndexedDB / electron-store in plaintext.
 */

import { parseAuthJson, socketioManager } from '@/features/socketio/lib/socketioManager';
import { useSocketIOStore } from '@/features/socketio/store/useSocketIOStore';
import {
  formatUnresolvedWarning,
  getActiveStreamingVariableScope,
  resolveStreamingText,
  type StreamingVariableScope,
} from '@/lib/shared/streaming/messageVariables';

export function connectWithVariables(
  connectionId: string,
  scope: StreamingVariableScope = getActiveStreamingVariableScope()
): { ok: true } | { ok: false; error: string } {
  const store = useSocketIOStore.getState();
  const connection = store.connections[connectionId];
  if (!connection) return { ok: false, error: 'Unknown connection' };

  const url = resolveStreamingText(connection.url, scope);
  const unresolved = [...url.unresolved];

  let auth: Record<string, unknown> | undefined;
  if (connection.authMode === 'json') {
    // JSON-aware: a value inside a string literal is escaped, never injected as structure.
    const text = resolveStreamingText(connection.authJson ?? '', scope, { json: true });
    const parsed = parseAuthJson(text.wire);
    if (!parsed.ok) {
      // Parse errors quote the input — report the masked copy's error when a secret was used.
      const shown = text.usedSecret ? parseAuthJson(text.display) : parsed;
      const error = `Invalid auth JSON: ${shown.ok ? 'Invalid JSON' : shown.error}`;
      store.addEvent(connectionId, {
        direction: 'system',
        eventName: '<system>',
        args: [`Connection failed: ${error}`],
      });
      return { ok: false, error };
    }
    auth = parsed.auth;
    unresolved.push(...text.unresolved);
  }

  const unique = [...new Set(unresolved)];
  if (unique.length > 0) {
    store.addEvent(connectionId, {
      direction: 'system',
      eventName: '<system>',
      args: [formatUnresolvedWarning(unique)],
    });
  }

  socketioManager.connect(connectionId, { url: url.wire, ...(auth ? { auth } : {}) });
  return { ok: true };
}
