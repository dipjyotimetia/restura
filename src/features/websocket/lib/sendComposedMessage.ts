/**
 * Outbound WebSocket send with `{{var}}` resolution (#927).
 *
 * Resolution runs on the raw composer text — for hex/binary mode *before* the
 * hex is parsed — through the shared streaming resolver (same scopes as HTTP).
 * Unresolved tokens are warned about in the transcript and sent literally.
 * When a secret value was substituted, the transcript gets the masked copy.
 */

import { websocketManager } from '@/features/websocket/lib/websocketManager';
import { useWebSocketStore } from '@/features/websocket/store/useWebSocketStore';
import type { WebSocketTemplateFormat } from '@/lib/shared/streaming/messageTemplates';
import {
  formatUnresolvedWarning,
  getActiveStreamingVariableScope,
  resolveStreamingText,
  type StreamingVariableScope,
} from '@/lib/shared/streaming/messageVariables';

/** Composer send format. `binary` = space-separated hex bytes. */
export type WebSocketSendFormat = 'json' | 'text' | 'binary';

export function templateFormatToSendFormat(format: WebSocketTemplateFormat): WebSocketSendFormat {
  return format === 'hex' ? 'binary' : format;
}

export function sendFormatToTemplateFormat(format: WebSocketSendFormat): WebSocketTemplateFormat {
  return format === 'binary' ? 'hex' : format;
}

/** Returns true when the frame was handed to the socket. */
export function sendComposedWebSocketMessage(
  connectionId: string,
  text: string,
  format: WebSocketSendFormat,
  scope: StreamingVariableScope = getActiveStreamingVariableScope()
): boolean {
  if (!text.trim()) return false;
  const { addMessage } = useWebSocketStore.getState();
  const resolved = resolveStreamingText(text, scope, { json: format === 'json' });
  if (resolved.unresolved.length > 0) {
    addMessage(connectionId, 'system', formatUnresolvedWarning(resolved.unresolved));
  }
  const options = resolved.usedSecret ? { display: resolved.display } : {};

  if (format === 'binary') {
    let buffer: ArrayBuffer;
    try {
      // The strict parser rejects malformed and unresolved `{{var}}` tokens;
      // input that resolves to nothing is rejected too (no empty frame).
      if (!resolved.wire.trim()) throw new Error('empty');
      buffer = websocketManager.hexToArrayBuffer(resolved.wire);
    } catch {
      const shown = resolved.display;
      addMessage(
        connectionId,
        'system',
        `Invalid hex format: "${shown.substring(0, 50)}${shown.length > 50 ? '...' : ''}". Expected space-separated hex bytes (e.g., "48 65 6c 6c 6f")`
      );
      return false;
    }
    return websocketManager.send(connectionId, buffer, options);
  }
  return websocketManager.send(connectionId, resolved.wire, options);
}
