import { useCallback, useEffect, useRef } from 'react';
import { subscribeMcpEvents } from '@/features/mcp/lib/mcpEventBridge';
import {
  classifyMcpNotification,
  closeEntry,
  errorEntry,
  type McpListKind,
} from '@/features/mcp/lib/mcpNotifications';
import { useMcpNotificationStore } from '@/features/mcp/store/useMcpNotificationStore';

/** Coalesce a burst of list_changed notifications into one re-discovery. */
export const LIST_CHANGED_DEBOUNCE_MS = 250;

export interface McpServerEventCallbacks {
  /** A `*\/list_changed` arrived (debounced): re-run discovery. */
  onListChanged: (kinds: McpListKind[]) => void;
  /** The upstream connection ended (close event). `error` is the last error seen, if any. */
  onUpstreamClosed: (connectionId: string, reason: string, error?: string) => void;
}

/**
 * Owns the renderer's subscription to one live MCP connection's server events
 * (#858). `attach` must be called BEFORE connect; `detach` on disconnect, on
 * session change, and (automatically) on unmount, so listeners never leak.
 * `isCurrent` lets the caller drop events from a superseded session.
 */
export function useMcpServerEvents(callbacks: McpServerEventCallbacks) {
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const debounceRef = useRef<{ timer: ReturnType<typeof setTimeout>; kinds: Set<McpListKind> }>(
    null
  );

  const detach = useCallback(() => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    if (debounceRef.current) {
      clearTimeout(debounceRef.current.timer);
      debounceRef.current = null;
    }
  }, []);

  useEffect(() => detach, [detach]);

  const attach = useCallback(
    (connectionId: string, isCurrent: () => boolean) => {
      detach();
      const store = useMcpNotificationStore.getState();
      let lastError: string | undefined;

      const scheduleRediscovery = (kind: McpListKind) => {
        if (debounceRef.current) {
          debounceRef.current.kinds.add(kind);
          return;
        }
        const kinds = new Set<McpListKind>([kind]);
        const timer = setTimeout(() => {
          debounceRef.current = null;
          if (isCurrent()) callbacksRef.current.onListChanged([...kinds]);
        }, LIST_CHANGED_DEBOUNCE_MS);
        debounceRef.current = { timer, kinds };
      };

      unsubscribeRef.current = subscribeMcpEvents(connectionId, {
        onNotification: (raw) => {
          if (!isCurrent()) return;
          const draft = classifyMcpNotification(raw);
          if (!draft) return;
          store.push(connectionId, draft);
          if (draft.kind === 'list_changed' && draft.listKind) {
            scheduleRediscovery(draft.listKind);
          } else if (draft.kind === 'subscription_closed' && draft.uri) {
            store.setSubscribed(connectionId, draft.uri, false);
          }
        },
        onError: (message) => {
          if (!isCurrent()) return;
          lastError = message;
          store.push(connectionId, errorEntry(message));
        },
        onClose: (reason) => {
          if (!isCurrent()) return;
          store.push(connectionId, closeEntry(reason));
          store.resetSubscriptions(connectionId);
          detach();
          callbacksRef.current.onUpstreamClosed(connectionId, reason, lastError);
        },
      });
    },
    [detach]
  );

  return { attach, detach };
}
