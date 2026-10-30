/**
 * MQTT publish with `{{var}}` resolution (#974).
 *
 * Topic, payload and the optional MQTT 5 string properties are resolved
 * through the shared streaming resolver (same scopes as HTTP) at publish time.
 * Unresolved tokens are warned about in the message log and secret values are
 * masked in the logged copy; templates themselves are never rewritten.
 */

import { type MqttPublishExtras, mqttManager } from '@/features/mqtt/lib/mqttManager';
import { encodeMqttPayload, type MqttPayloadFormat } from '@/features/mqtt/lib/mqttPayload';
import { useMqttStore } from '@/features/mqtt/store/useMqttStore';
import type { MqttPublishTemplate } from '@/lib/shared/streaming/messageTemplates';
import {
  formatUnresolvedWarning,
  getActiveStreamingVariableScope,
  resolveStreamingText,
  type StreamingVariableScope,
} from '@/lib/shared/streaming/messageVariables';

export type PublishInput = Omit<MqttPublishTemplate, 'id' | 'name'>;

/** Composer-only publish options (not part of saved templates). */
export interface PublishOptions {
  /** How the payload text is written (default Text). */
  format?: MqttPayloadFormat;
  messageExpiryInterval?: number;
  payloadFormatIndicator?: boolean;
  topicAlias?: number;
  /** UTF-8 correlation token (publish) — request mode generates one when empty. */
  correlationData?: string;
  /** MQTT 5 request/response: wait for the correlated reply. */
  request?: { requestId: string; timeoutMs: number };
}

function logError(connectionId: string, topic: string, input: PublishInput, msg: string): void {
  useMqttStore.getState().addMessage(connectionId, {
    direction: 'system',
    topic,
    payload: msg,
    qos: input.qos,
    retain: input.retain,
    error: msg,
  });
}

export async function publishWithVariables(
  connectionId: string,
  input: PublishInput,
  scope: StreamingVariableScope = getActiveStreamingVariableScope(),
  options: PublishOptions = {}
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

  let encoded: ReturnType<typeof encodeMqttPayload>;
  try {
    encoded = encodeMqttPayload(payload.wire, options.format ?? 'text');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError(connectionId, topic.display, input, msg);
    return { ok: false, error: msg };
  }

  const extras: MqttPublishExtras = {
    ...(encoded.payloadEncoding === 'base64' ? { payloadEncoding: 'base64' as const } : {}),
    ...(contentType?.wire ? { contentType: contentType.wire } : {}),
    ...(responseTopic?.wire ? { responseTopic: responseTopic.wire } : {}),
    ...(input.userProperties ? { userProperties: input.userProperties } : {}),
    ...(options.messageExpiryInterval !== undefined
      ? { messageExpiryInterval: options.messageExpiryInterval }
      : {}),
    ...(options.payloadFormatIndicator !== undefined
      ? { payloadFormatIndicator: options.payloadFormatIndicator }
      : {}),
    ...(options.correlationData
      ? { correlationData: options.correlationData, correlationDataEncoding: 'utf8' as const }
      : {}),
  };
  const display =
    topic.usedSecret || payload.usedSecret
      ? { display: { topic: topic.display, payload: payload.display } }
      : {};

  if (options.request) {
    const result = await mqttManager.request({
      connectionId,
      requestId: options.request.requestId,
      timeoutMs: options.request.timeoutMs,
      topic: topic.wire,
      payload: encoded.payload,
      qos: input.qos,
      retain: input.retain,
      ...extras,
      ...display,
    });
    return result.success ? { ok: true } : { ok: false, error: result.error ?? 'Request failed' };
  }

  return mqttManager.publish({
    connectionId,
    topic: topic.wire,
    payload: encoded.payload,
    qos: input.qos,
    retain: input.retain,
    ...(options.topicAlias !== undefined ? { topicAlias: options.topicAlias } : {}),
    ...extras,
    ...display,
  });
}
