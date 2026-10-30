/**
 * MQTT 5 request/response (§4.10, O-10 / MQTT-8) on an open connection.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { MqttClient } from 'mqtt';
import { errorMessage } from '../../ipc/ipc-utils';
import type { MqttRequestConfig } from '../../ipc/ipc-validators';
import { decodeBinary, publishProperties, type toMessageEvent } from './wire';

export interface PendingRequest {
  responseTopic: string;
  correlation: Buffer;
  /** Settle with the matching reply. */
  respond: (message: ReturnType<typeof toMessageEvent>) => void;
  /** Settle with a terminal (non-response) outcome — cancel / close. */
  abort: (result: { cancelled?: boolean; error: string }) => void;
}

const MAX_PENDING_REQUESTS = 32;

/** The slice of a live connection a request needs. */
export interface MqttRequestHost {
  client: MqttClient;
  protocolVersion: 4 | 5;
  clientId: string;
  subscriptions: Set<string>;
  pendingRequests: Map<string, PendingRequest>;
}

/** Subscribe and resolve once SUBACK arrives (granted QoS ≥ 0x80 = rejected). */
function subscribeOnce(
  client: MqttClient,
  topic: string,
  opts: Parameters<MqttClient['subscribe']>[1]
): Promise<void> {
  return new Promise((resolve, reject) => {
    client.subscribe(topic, opts, (err, granted) => {
      if (err) return reject(err);
      const code = granted?.[0]?.qos;
      if (code !== undefined && code >= 128) {
        return reject(new Error(`Subscription to response topic rejected (reason code ${code})`));
      }
      resolve();
    });
  });
}

export type MqttRequestOutcome = {
  success: boolean;
  error?: string;
  timedOut?: boolean;
  cancelled?: boolean;
  responseTopic?: string;
  correlationData?: string;
  response?: ReturnType<typeof toMessageEvent>;
  latencyMs?: number;
};

/**
 * MQTT 5 request/response (§4.10, O-10): subscribe to the response topic
 * (QoS 1, No Local), publish with Response Topic + Correlation Data, and settle
 * on the first reply on that topic whose correlation bytes match — or on
 * timeout / cancel / disconnect. The temporary subscription is removed unless
 * the user already holds the same filter.
 */
export async function runMqttRequest(
  entry: MqttRequestHost,
  cfg: MqttRequestConfig,
  isCurrent: () => boolean
): Promise<MqttRequestOutcome> {
  if (entry.protocolVersion !== 5) {
    return { success: false, error: 'Request/response requires an MQTT 5 connection' };
  }
  if (entry.pendingRequests.has(cfg.requestId)) {
    return { success: false, error: 'Request already in flight' };
  }
  // Each request holds a subscription + timer until it settles; bound them.
  if (entry.pendingRequests.size >= MAX_PENDING_REQUESTS) {
    return {
      success: false,
      error: `Too many requests in flight on this connection (max ${MAX_PENDING_REQUESTS})`,
    };
  }
  const responseTopic =
    cfg.responseTopic ?? `restura/resp/${entry.clientId || 'client'}/${randomUUID()}`;
  if (responseTopic.includes('+') || responseTopic.includes('#')) {
    return { success: false, error: 'Response topic must not contain wildcards' };
  }
  const correlation =
    cfg.correlationData !== undefined
      ? decodeBinary(cfg.correlationData, cfg.correlationDataEncoding)
      : randomBytes(16);
  const base = { responseTopic, correlationData: correlation.toString('base64') };
  const topicInUse = (): boolean =>
    [...entry.pendingRequests.values()].some((p) => p.responseTopic === responseTopic);
  // Another in-flight request on the same (explicit) response topic already
  // holds the temporary subscription; the last one to settle removes it.
  const ownsSubscription = !entry.subscriptions.has(responseTopic) && !topicInUse();
  const subscribedHere = !entry.subscriptions.has(responseTopic);

  let settle!: (outcome: MqttRequestOutcome) => void;
  const outcome = new Promise<MqttRequestOutcome>((resolve) => {
    settle = resolve;
  });
  let startedAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  const finish = (result: MqttRequestOutcome): void => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    entry.pendingRequests.delete(cfg.requestId);
    settle({ ...base, ...result });
  };
  entry.pendingRequests.set(cfg.requestId, {
    responseTopic,
    correlation,
    respond: (message) =>
      finish({ success: true, response: message, latencyMs: Date.now() - startedAt }),
    abort: ({ cancelled, error }) =>
      finish({ success: false, error, ...(cancelled ? { cancelled: true } : {}) }),
  });

  // The timeout covers the whole exchange, SUBACK included: a broker that never
  // acknowledges the subscription must not hold the slot past `timeoutMs`.
  startedAt = Date.now();
  timer = setTimeout(
    () =>
      finish({
        success: false,
        timedOut: true,
        error: `No response on ${responseTopic} within ${cfg.timeoutMs} ms`,
      }),
    cfg.timeoutMs
  );

  try {
    if (ownsSubscription) {
      await subscribeOnce(entry.client, responseTopic, { qos: 1, nl: true });
    }
    // Settled during SUBACK (timeout / cancel / close): skip the publish but
    // still fall through to the subscription cleanup below.
    if (!settled) {
      const properties = publishProperties({ ...cfg, topicAlias: undefined });
      properties.responseTopic = responseTopic;
      properties.correlationData = correlation;
      entry.client.publish(
        cfg.topic,
        decodeBinary(cfg.payload, cfg.payloadEncoding),
        { qos: cfg.qos, retain: cfg.retain, properties },
        (err) => {
          if (err) finish({ success: false, error: errorMessage(err) });
        }
      );
    }
  } catch (err) {
    finish({ success: false, error: errorMessage(err) });
  }

  const result = await outcome;
  if (subscribedHere && isCurrent() && !entry.subscriptions.has(responseTopic) && !topicInUse()) {
    entry.client.unsubscribe(responseTopic, () => {});
  }
  return result;
}
