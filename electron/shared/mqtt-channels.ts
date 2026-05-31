/**
 * MQTT IPC channel prefixes. Kept as a thin compatibility shim over the
 * unified registry in `./channels.ts` (the single source of truth) so the
 * `MQTT_CHANNEL` / `mqttChannel` call sites — in `mqtt-handler.ts` and the
 * renderer's `mqttManager.ts` — read like the Kafka equivalents.
 *
 * Each prefix is suffixed at runtime with the connection id, e.g.
 * `mqtt:message:<connectionId>`.
 */
import { EVENT_PREFIX, eventChannel } from './channels';

export const MQTT_CHANNEL = {
  /** CONNACK received — the broker accepted the connection. */
  CONNECTED: EVENT_PREFIX.mqtt.connected,
  /** A PUBLISH arrived on a subscribed topic. */
  MESSAGE: EVENT_PREFIX.mqtt.message,
  /** Client-level error (with `{ message }` payload). */
  ERROR: EVENT_PREFIX.mqtt.error,
  /** A SUBSCRIBE was granted (with `{ topicFilter, grantedQos }`). */
  SUBSCRIBED: EVENT_PREFIX.mqtt.subscribed,
  /** An UNSUBSCRIBE was acknowledged (with `{ topicFilter }`). */
  UNSUBSCRIBED: EVENT_PREFIX.mqtt.unsubscribed,
  /** The connection closed (disconnect, broker close, or teardown). */
  CLOSE: EVENT_PREFIX.mqtt.close,
} as const;

export type MqttChannelPrefix = (typeof MQTT_CHANNEL)[keyof typeof MQTT_CHANNEL];

export function mqttChannel(prefix: MqttChannelPrefix, connectionId: string): string {
  return eventChannel(prefix, connectionId);
}
