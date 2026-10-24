/**
 * `{{var}}` resolution for the MQTT broker URL (at connect) and subscribe
 * topic filters (#984, XC-8). Publishes resolve in `publishWithVariables`.
 * Stored values stay unresolved; unresolved tokens are sent literally and
 * flagged on the connection's transcript.
 */

import { useMqttStore } from '@/features/mqtt/store/useMqttStore';
import {
  formatUnresolvedWarning,
  getActiveStreamingVariableScope,
  resolveStreamingText,
  type StreamingVariableScope,
} from '@/lib/shared/streaming/messageVariables';

export function resolveMqttText(
  connectionId: string,
  text: string,
  scope: StreamingVariableScope = getActiveStreamingVariableScope()
): string {
  const resolved = resolveStreamingText(text, scope);
  if (resolved.unresolved.length > 0) {
    useMqttStore.getState().addMessage(connectionId, {
      direction: 'system',
      topic: '',
      payload: formatUnresolvedWarning(resolved.unresolved),
      qos: 0,
      retain: false,
    });
  }
  return resolved.wire;
}
