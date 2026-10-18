/**
 * `{{var}}` resolution for Kafka sends (#984, XC-8).
 *
 * Brokers (at connect), consume topics / group id (at subscribe) and the
 * produced record — topic, key, value and header names/values — resolve
 * through the shared streaming resolver (same scopes as HTTP) at send time.
 * Presets and drafts are stored unresolved; nothing is written back. Values of
 * secret variables are masked in the transcript copy, and unresolved tokens
 * are flagged as a system message (they are sent literally, like MQTT/WS).
 */

import { kafkaManager } from '@/features/kafka/lib/kafkaManager';
import { useKafkaStore } from '@/features/kafka/store/useKafkaStore';
import {
  formatUnresolvedWarning,
  getActiveStreamingVariableScope,
  type ResolvedStreamingText,
  resolveStreamingText,
  type StreamingVariableScope,
} from '@/lib/shared/streaming/messageVariables';

export interface ResolvedList {
  values: string[];
  unresolved: string[];
}

function collectUnresolved(results: ReadonlyArray<ResolvedStreamingText | undefined>): string[] {
  return [...new Set(results.flatMap((r) => (r ? r.unresolved : [])))];
}

/** Resolve every entry of a string list (brokers, topics). */
export function resolveKafkaList(
  values: readonly string[],
  scope: StreamingVariableScope = getActiveStreamingVariableScope()
): ResolvedList {
  const resolved = values.map((v) => resolveStreamingText(v, scope));
  return { values: resolved.map((r) => r.wire), unresolved: collectUnresolved(resolved) };
}

/** Flag unresolved tokens on a connection's transcript (no-op when none). */
export function warnUnresolved(connectionId: string, topic: string, names: string[]): void {
  if (names.length === 0) return;
  const value = formatUnresolvedWarning(names);
  useKafkaStore.getState().addMessage(connectionId, { direction: 'system', topic, value });
}

export type KafkaProduceInput = Parameters<typeof kafkaManager.produce>[0];

/**
 * Produce with `{{var}}` resolution. `json` substitutes JSON-aware inside the
 * value (a value containing quotes stays one string literal).
 */
export function produceWithVariables(
  input: KafkaProduceInput,
  options: { json?: boolean } = {},
  scope: StreamingVariableScope = getActiveStreamingVariableScope()
): ReturnType<typeof kafkaManager.produce> {
  const topic = resolveStreamingText(input.topic, scope);
  const key = input.key !== undefined ? resolveStreamingText(input.key, scope) : undefined;
  const value =
    input.value !== null
      ? resolveStreamingText(input.value, scope, { json: options.json === true })
      : undefined;
  const headers = Object.entries(input.headers ?? {}).map(([k, v]) => ({
    key: resolveStreamingText(k, scope),
    value: resolveStreamingText(v, scope),
  }));

  warnUnresolved(
    input.connectionId,
    topic.display,
    collectUnresolved([topic, key, value, ...headers.flatMap((h) => [h.key, h.value])])
  );

  const usedSecret = [topic, key, value, ...headers.flatMap((h) => [h.key, h.value])].some(
    (r) => r?.usedSecret
  );
  const toRecord = (pick: 'wire' | 'display') =>
    Object.fromEntries(headers.map((h) => [h.key[pick], h.value[pick]]));

  return kafkaManager.produce({
    ...input,
    topic: topic.wire,
    ...(key ? { key: key.wire } : {}),
    value: value ? value.wire : null,
    ...(input.headers ? { headers: toRecord('wire') } : {}),
    ...(usedSecret
      ? {
          display: {
            ...(key ? { key: key.display } : {}),
            ...(value ? { value: value.display } : {}),
            ...(input.headers ? { headers: toRecord('display') } : {}),
          },
        }
      : {}),
  });
}
