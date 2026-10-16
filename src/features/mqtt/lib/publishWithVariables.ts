/**
 * MQTT publish with `{{var}}` resolution (#974).
 *
 * Topic, payload and the optional MQTT 5 string properties are resolved
 * through the shared streaming resolver (same scopes as HTTP) at publish time.
 * Unresolved tokens are warned about in the message log and secret values are
 * masked in the logged copy; templates themselves are never rewritten.
 */

import { mqttManager } from '@/features/mqtt/lib/mqttManager';
import { useMqttStore } from '@/features/mqtt/store/useMqttStore';
import type { MqttPublishTemplate } from '@/lib/shared/streaming/messageTemplates';
import {
  formatUnresolvedWarning,
  getActiveStreamingVariableScope,
  resolveStreamingText,
  type StreamingVariableScope,
} from '@/lib/shared/streaming/messageVariables';

export type PublishInput = Omit<MqttPublishTemplate, 'id' | 'name'>;

export async function publishWithVariables(
  connectionId: string,
  input: PublishInput,
  scope: StreamingVariableScope = getActiveStreamingVariableScope()
): Promise<{ ok: true } | { ok: false; error: string }> {
  const topic = resolveStreamingText(input.topic, scope);
  const payload = resolveStreamingText(input.payload, scope);
  const contentType =
    input.contentType !== undefined ? resolveStreamingText(input.contentType, scope) : undefined;
  const responseTopic =
    input.responseTopic !== undefined
      ? resolveStreamingText(input.responseTopic, scope)
      : undefined;

  const unresolved = [
    ...new Set(
      [topic, payload, contentType, responseTopic].flatMap((r) => (r ? r.unresolved : []))
    ),
  ];
  if (unresolved.length > 0) {
    useMqttStore.getState().addMessage(connectionId, {
      direction: 'system',
      topic: topic.display,
      payload: formatUnresolvedWarning(unresolved),
      qos: input.qos,
      retain: input.retain,
    });
  }

  return mqttManager.publish({
    connectionId,
    topic: topic.wire,
    payload: payload.wire,
    qos: input.qos,
    retain: input.retain,
    ...(contentType?.wire ? { contentType: contentType.wire } : {}),
    ...(responseTopic?.wire ? { responseTopic: responseTopic.wire } : {}),
    ...(input.userProperties ? { userProperties: input.userProperties } : {}),
    ...(topic.usedSecret || payload.usedSecret
      ? { display: { topic: topic.display, payload: payload.display } }
      : {}),
  });
}
