/**
 * Socket.IO connect with `{{var}}` resolution (SIO-2, SIO-4).
 *
 * The URL, Query-tab params, extra handshake headers and the handshake auth
 * payload (key-value or JSON mode) are resolved
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

/** Enabled key-value rows → record, with `{{var}}` resolved in keys and values. */
function resolvePairs(
  items: ReadonlyArray<{ key: string; value: string; enabled: boolean }>,
  scope: StreamingVariableScope,
  unresolved: string[]
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const it of items) {
    if (!it.enabled || !it.key.trim()) continue;
    const key = resolveStreamingText(it.key.trim(), scope);
    const value = resolveStreamingText(it.value, scope);
    unresolved.push(...key.unresolved, ...value.unresolved);
    out[key.wire] = value.wire;
  }
  return out;
}

export function connectWithVariables(
  connectionId: string,
  scope: StreamingVariableScope = getActiveStreamingVariableScope()
): { ok: true } | { ok: false; error: string } {
  const store = useSocketIOStore.getState();
  const connection = store.connections[connectionId];
  if (!connection) return { ok: false, error: 'Unknown connection' };

  const url = resolveStreamingText(connection.url, scope);
  const unresolved = [...url.unresolved];

  let auth: Record<string, unknown>;
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
  } else {
    auth = resolvePairs(connection.auth, scope, unresolved);
  }

  const query = resolvePairs(connection.query, scope, unresolved);
  const extraHeaders = resolvePairs(connection.extraHeaders, scope, unresolved);

  const unique = [...new Set(unresolved)];
  if (unique.length > 0) {
    store.addEvent(connectionId, {
      direction: 'system',
      eventName: '<system>',
      args: [formatUnresolvedWarning(unique)],
    });
  }

  socketioManager.connect(connectionId, { url: url.wire, auth, query, extraHeaders });
  return { ok: true };
}
