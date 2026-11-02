import type {
  MqttConnection,
  MqttMessage,
  MqttQoS,
  MqttSubscriptionOptions,
} from '@/features/mqtt/store/useMqttStore';
import {
  DEFAULT_MQTT_CONNECT_TIMEOUT,
  MQTT_SECRET_SENTINEL,
  useMqttStore,
} from '@/features/mqtt/store/useMqttStore';
import { brokerSecretRef, ensureBrokerSecret } from '@/lib/shared/broker-secrets';
import { getElectronAPI, isElectron } from '@/lib/shared/platform';
import { createChannelBinder } from '@/lib/shared/streaming/channelBinding';
import { CoalescingBuffer } from '@/lib/shared/streaming/coalescingBuffer';
import { connectionChannels } from '@/lib/shared/streaming/desktopStreamAdapter';
import { EVENT_PREFIX } from '../../../../electron/shared/channels';
import type {
  MqttBinaryEncoding,
  MqttConnectedEvent,
  MqttConnectIpc,
  MqttMessageEvent,
  MqttRequestResult,
  MqttServerDisconnectEvent,
} from '../../../../electron/types/electron-api';
import { describeServerDisconnect } from './mqttReasonCodes';

/**
 * Inbound PUBLISH messages are buffered and flushed to the store on this
 * interval rather than per-message. MQTT topics (sensor/IoT streams) can push
 * hundreds of messages/sec; coalescing keeps the store update + console-frame
 * write + message-list re-render to ~10 Hz regardless of message rate.
 */
const FLUSH_INTERVAL_MS = 100;

type ReceivedInput = Omit<MqttMessage, 'id' | 'timestamp'> & { timestamp?: number };

import { type MqttSecretField, mqttSecretStorageKey } from '@shared/protocol/broker-secret-id';

export type { MqttSecretField };

export function mqttSecretKey(connectionId: string, field: MqttSecretField): string {
  // Storage key of the main-process secret handle (`broker-secrets.ts`); main
  // derives the same key to bind the handle to this connection + field. Older
  // builds used the same key in secureStorage, which `ensureBrokerSecret`
  // migrates on first use.
  return mqttSecretStorageKey(connectionId, field);
}

export const MQTT_SECRET_LABELS: Record<MqttSecretField, string> = {
  password: 'MQTT password',
  'tls-passphrase': 'MQTT TLS key passphrase',
  'auth-data': 'MQTT enhanced-auth data',
};

/**
 * The IPC form of a stored secret field: a handle reference for a
 * sentinel-marked value (migrating a legacy secureStorage copy first), the
 * inline string otherwise. `null` = marked as stored but nothing is stored.
 */
async function secretField(
  connectionId: string,
  field: MqttSecretField,
  value: string | undefined
): Promise<MqttConnectIpc['password'] | null | undefined> {
  if (!value) return undefined;
  if (value !== MQTT_SECRET_SENTINEL) return value;
  const key = mqttSecretKey(connectionId, field);
  return (await ensureBrokerSecret(key, MQTT_SECRET_LABELS[field])) ? brokerSecretRef(key) : null;
}

/**
 * Drop `undefined` keys only — `''` is a real value (an empty payload clears a
 * retained message), and form fields already map blank input to undefined.
 */
function defined<T extends Record<string, unknown>>(
  obj: T
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}

/**
 * Resolve the persisted MqttConnection into the wire format expected by the
 * Electron IPC handler. Secrets cross as SecretRef handles and TLS material as
 * file paths — main resolves both at wire time, so plaintext and key PEMs
 * never enter the renderer (ADR-0007, SEC-K3). Returns null when required
 * material is missing.
 */
export async function resolveConnect(connection: MqttConnection): Promise<MqttConnectIpc | null> {
  const v5 = connection.protocolVersion === 5;
  const ipc: MqttConnectIpc = {
    connectionId: connection.id,
    brokerUrl: connection.brokerUrl,
    protocolVersion: connection.protocolVersion,
    clientId: connection.clientId,
    keepalive: connection.keepalive,
    cleanStart: connection.cleanStart,
    autoReconnect: connection.autoReconnect,
  };

  // The stored 30s value is the legacy/default UI value, not a deliberate
  // per-connection override. Omitting it lets Electron apply the current
  // acknowledged global timeout; a user-selected non-default value still wins.
  if (connection.connectTimeout !== DEFAULT_MQTT_CONNECT_TIMEOUT) {
    ipc.connectTimeout = connection.connectTimeout;
  }

  if (connection.username) ipc.username = connection.username;

  const password = await secretField(connection.id, 'password', connection.password);
  if (password === null) return null;
  if (password !== undefined) ipc.password = password;

  if (v5 && connection.sessionExpiryInterval !== undefined) {
    ipc.sessionExpiryInterval = connection.sessionExpiryInterval;
  }

  if (v5 && connection.connectProperties) {
    const { authenticationData, ...rest } = connection.connectProperties;
    const properties: NonNullable<MqttConnectIpc['properties']> = defined({
      ...rest,
      ...(rest.userProperties && Object.keys(rest.userProperties).length === 0
        ? { userProperties: undefined }
        : {}),
    });
    if (rest.authenticationMethod) {
      // Auth data is often a credential: stored as a handle, resolved in main.
      const data = await secretField(connection.id, 'auth-data', authenticationData);
      if (data === null) return null;
      if (data !== undefined) {
        properties.authenticationData = data;
        properties.authenticationDataEncoding = 'utf8';
      }
    }
    if (Object.keys(properties).length > 0) ipc.properties = properties;
  }

  if (connection.lwt) {
    const { properties, ...lwt } = connection.lwt;
    ipc.lwt = { topic: lwt.topic, payload: lwt.payload, qos: lwt.qos, retain: lwt.retain };
    if (v5 && properties) {
      const will = defined({
        ...properties,
        ...(properties.userProperties && Object.keys(properties.userProperties).length === 0
          ? { userProperties: undefined }
          : {}),
      });
      if (will.correlationData) Object.assign(will, { correlationDataEncoding: 'utf8' });
      if (Object.keys(will).length > 0) ipc.lwt.properties = will;
    }
  }

  // TLS applies to mqtts:// and wss:// brokers.
  if (/^(mqtts|wss):\/\//i.test(connection.brokerUrl) && connection.tls) {
    const tls: NonNullable<MqttConnectIpc['tls']> = {};
    if (connection.tls.rejectUnauthorized !== undefined) {
      tls.rejectUnauthorized = connection.tls.rejectUnauthorized;
    }
    if (connection.tls.caPath) tls.caPath = connection.tls.caPath;
    if (connection.tls.certPath) tls.certPath = connection.tls.certPath;
    if (connection.tls.keyPath) tls.keyPath = connection.tls.keyPath;
    const passphrase = await secretField(
      connection.id,
      'tls-passphrase',
      connection.tls.passphrase
    );
    if (passphrase) tls.passphrase = passphrase;
    ipc.tls = tls;
  }

  return ipc;
}

/** MQTT 5 publish extras shared by publish and request. */
export interface MqttPublishExtras {
  payloadEncoding?: MqttBinaryEncoding;
  userProperties?: Record<string, string | string[]>;
  messageExpiryInterval?: number;
  contentType?: string;
  payloadFormatIndicator?: boolean;
  responseTopic?: string;
  correlationData?: string;
  correlationDataEncoding?: MqttBinaryEncoding;
}

/** Map an inbound MESSAGE event onto a store message. */
function receivedFromEvent(msg: MqttMessageEvent): ReceivedInput {
  return {
    direction: 'received',
    topic: msg.topic,
    payload: msg.payload,
    ...(msg.payloadEncoding === 'base64' ? { payloadEncoding: 'base64' as const } : {}),
    qos: msg.qos,
    retain: msg.retain,
    ...(msg.dup !== undefined ? { dup: msg.dup } : {}),
    ...(msg.userProperties ? { userProperties: msg.userProperties } : {}),
    ...(msg.messageExpiryInterval !== undefined
      ? { messageExpiryInterval: msg.messageExpiryInterval }
      : {}),
    ...(msg.contentType ? { contentType: msg.contentType } : {}),
    ...(msg.payloadFormatIndicator !== undefined
      ? { payloadFormatIndicator: msg.payloadFormatIndicator }
      : {}),
    ...(msg.responseTopic ? { responseTopic: msg.responseTopic } : {}),
    ...(msg.correlationData !== undefined ? { correlationData: msg.correlationData } : {}),
    ...(msg.correlationDataEncoding === 'base64'
      ? { correlationDataEncoding: 'base64' as const }
      : {}),
    ...(msg.subscriptionIdentifier !== undefined
      ? { subscriptionIdentifier: msg.subscriptionIdentifier }
      : {}),
    timestamp: msg.timestamp,
  };
}

function systemMessage(
  connectionId: string,
  payload: string,
  extra: { topic?: string; error?: boolean } = {}
): void {
  useMqttStore.getState().addMessage(connectionId, {
    direction: 'system',
    topic: extra.topic ?? '',
    payload,
    qos: 0,
    retain: false,
    ...(extra.error ? { error: payload } : {}),
  });
}

class MqttManager {
  /** Per-connection buffer of inbound messages awaiting the next flush. */
  private inbound = new CoalescingBuffer<ReceivedInput>(
    (connectionId, batch) => useMqttStore.getState().addMessages(connectionId, batch),
    { intervalMs: FLUSH_INTERVAL_MS }
  );
  private channels = createChannelBinder({
    bridge: () => getElectronAPI()?.mqtt,
    channels: (id) => connectionChannels(EVENT_PREFIX.mqtt, id),
    // Drain anything still buffered before detaching — otherwise the last
    // ~100ms of inbound messages would be silently dropped on disconnect.
    drain: (id) => this.flushBuffer(id),
  });

  async connect(connection: MqttConnection): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!isElectron()) {
      return { ok: false, error: 'MQTT is only available in the Restura desktop app.' };
    }
    const api = getElectronAPI();
    if (!api) return { ok: false, error: 'Electron API unavailable.' };

    const store = useMqttStore.getState();
    store.updateStatus(connection.id, 'connecting');

    let ipc: MqttConnectIpc | null;
    try {
      ipc = await resolveConnect(connection);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to resolve MQTT credentials';
      store.updateStatus(connection.id, 'disconnected');
      store.addMessage(connection.id, {
        direction: 'system',
        topic: '',
        payload: msg,
        qos: 0,
        retain: false,
        error: msg,
      });
      return { ok: false, error: msg };
    }
    if (!ipc) {
      store.updateStatus(connection.id, 'disconnected');
      const msg = 'Missing password or TLS material — re-enter credentials.';
      store.addMessage(connection.id, {
        direction: 'system',
        topic: '',
        payload: msg,
        qos: 0,
        retain: false,
        error: msg,
      });
      return { ok: false, error: msg };
    }

    // `bind` starts from a clean listener set — a previous failed/closed attempt
    // on this connectionId may have left handlers bound, and binding again
    // would double-handle every subsequent event.
    this.bindListeners(connection.id);

    let result: Awaited<ReturnType<typeof api.mqtt.connect>>;
    try {
      result = await api.mqtt.connect(ipc);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'MQTT connect failed';
      store.updateStatus(connection.id, 'disconnected');
      store.addMessage(connection.id, {
        direction: 'system',
        topic: '',
        payload: msg,
        qos: 0,
        retain: false,
        error: msg,
      });
      this.channels.unbind(connection.id);
      return { ok: false, error: msg };
    }
    if (!result.success) {
      store.updateStatus(connection.id, 'disconnected');
      const msg = result.error ?? 'MQTT connect failed';
      store.addMessage(connection.id, {
        direction: 'system',
        topic: '',
        payload: msg,
        qos: 0,
        retain: false,
        error: msg,
      });
      this.channels.unbind(connection.id);
      return { ok: false, error: msg };
    }

    // Status flips to 'connected' when the CONNACK arrives via the CONNECTED
    // channel. Leave it at 'connecting' here.
    return { ok: true };
  }

  async publish(
    params: {
      connectionId: string;
      topic: string;
      payload: string;
      qos: MqttQoS;
      retain: boolean;
      topicAlias?: number;
      /**
       * Transcript copy of topic/payload — keeps resolved secret `{{var}}`
       * values out of the message log (#974). Defaults to what was sent.
       */
      display?: { topic: string; payload: string };
    } & MqttPublishExtras
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!isElectron()) return { ok: false, error: 'MQTT is desktop-only.' };
    const api = getElectronAPI();
    if (!api) return { ok: false, error: 'Electron API unavailable.' };

    const store = useMqttStore.getState();
    const { display: _display, ...wire } = params;
    const result = await api.mqtt.publish(defined(wire) as typeof wire);

    if (!result.success) {
      const msg = result.error ?? 'Publish failed';
      store.addMessage(params.connectionId, {
        direction: 'system',
        topic: params.display?.topic ?? params.topic,
        payload: msg,
        qos: params.qos,
        retain: params.retain,
        error: msg,
      });
      return { ok: false, error: msg };
    }

    store.addMessage(params.connectionId, {
      direction: 'sent',
      topic: params.display?.topic ?? params.topic,
      payload: params.display?.payload ?? params.payload,
      ...(params.payloadEncoding === 'base64' ? { payloadEncoding: 'base64' as const } : {}),
      qos: params.qos,
      retain: params.retain,
      ...(result.ack?.packetId !== undefined ? { packetId: result.ack.packetId } : {}),
      ...(result.ack?.reasonCode !== undefined ? { reasonCode: result.ack.reasonCode } : {}),
      ...(params.userProperties ? { userProperties: params.userProperties } : {}),
    });
    return { ok: true };
  }

  async subscribe(params: {
    connectionId: string;
    topicFilter: string;
    qos: MqttQoS;
    options?: MqttSubscriptionOptions;
    subscriptionIdentifier?: number;
  }): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!isElectron()) return { ok: false, error: 'MQTT is desktop-only.' };
    const api = getElectronAPI();
    if (!api) return { ok: false, error: 'Electron API unavailable.' };

    const store = useMqttStore.getState();
    store.upsertSubscription(params.connectionId, {
      topicFilter: params.topicFilter,
      requestedQos: params.qos,
      status: 'subscribing',
      ...(params.options ? { options: params.options } : {}),
      ...(params.subscriptionIdentifier !== undefined
        ? { subscriptionIdentifier: params.subscriptionIdentifier }
        : {}),
    });

    const result = await api.mqtt.subscribe(params);
    if (!result.success) {
      store.patchSubscription(params.connectionId, params.topicFilter, { status: 'error' });
      const msg = result.error ?? 'Subscribe failed';
      store.addMessage(params.connectionId, {
        direction: 'system',
        topic: params.topicFilter,
        payload: msg,
        qos: params.qos,
        retain: false,
        error: msg,
      });
      return { ok: false, error: msg };
    }
    // SUBSCRIBED channel patches status → 'subscribed' with grantedQos.
    return { ok: true };
  }

  /**
   * MQTT 5 request/response (O-10): publish with a response topic + correlation
   * data and wait (in main) for the matching reply. The request and the matched
   * reply are logged; the reply carries the round-trip latency.
   */
  async request(
    params: {
      connectionId: string;
      requestId: string;
      topic: string;
      payload: string;
      qos: MqttQoS;
      retain: boolean;
      timeoutMs: number;
      display?: { topic: string; payload: string };
    } & MqttPublishExtras
  ): Promise<MqttRequestResult> {
    if (!isElectron()) return { success: false, error: 'MQTT is desktop-only.' };
    const api = getElectronAPI();
    if (!api) return { success: false, error: 'Electron API unavailable.' };

    const store = useMqttStore.getState();
    const { display, ...wire } = params;
    store.addMessage(params.connectionId, {
      direction: 'sent',
      topic: display?.topic ?? params.topic,
      payload: display?.payload ?? params.payload,
      ...(params.payloadEncoding === 'base64' ? { payloadEncoding: 'base64' as const } : {}),
      qos: params.qos,
      retain: params.retain,
      ...(params.responseTopic ? { responseTopic: params.responseTopic } : {}),
    });
    const result = await api.mqtt.request(defined(wire) as typeof wire);
    if (result.success && result.response) {
      // The reply is also delivered through the MESSAGE channel; flush first so
      // the log reads request → reply → summary.
      this.flushBuffer(params.connectionId);
      systemMessage(
        params.connectionId,
        `Response on ${result.responseTopic} in ${result.latencyMs} ms`,
        { topic: result.responseTopic ?? '' }
      );
    } else {
      systemMessage(params.connectionId, result.error ?? 'Request failed', {
        topic: result.responseTopic ?? params.topic,
        error: !result.cancelled,
      });
    }
    return result;
  }

  async cancelRequest(connectionId: string, requestId: string): Promise<void> {
    await getElectronAPI()?.mqtt.cancelRequest({ connectionId, requestId });
  }

  async unsubscribe(connectionId: string, topicFilter: string): Promise<void> {
    const api = getElectronAPI();
    if (!api) return;
    await api.mqtt.unsubscribe({ connectionId, topicFilter });
    // UNSUBSCRIBED channel removes the subscription from the store.
  }

  async disconnect(connectionId: string): Promise<void> {
    const api = getElectronAPI();
    if (!api) return;
    await api.mqtt.disconnect({ connectionId });
    this.channels.unbind(connectionId);
    const store = useMqttStore.getState();
    store.updateStatus(connectionId, 'disconnected');
  }

  private bindListeners(connectionId: string): void {
    // mqtt.js retry cycle: drive 'reconnecting' from main, logged once per drop.
    const markReconnecting = (): void => {
      this.flushBuffer(connectionId);
      const store = useMqttStore.getState();
      const conn = store.connections[connectionId];
      if (!conn || conn.status === 'reconnecting' || conn.status === 'disconnected') return;
      store.updateStatus(connectionId, 'reconnecting');
      systemMessage(connectionId, 'Connection lost — reconnecting…');
    };

    this.channels.bind(connectionId, {
      connected: (payload) => {
        const p = payload as MqttConnectedEvent;
        const store = useMqttStore.getState();
        store.updateStatus(connectionId, 'connected');
        // Runtime CONNACK facts — explicitly cleared when the broker omits them.
        store.updateConnection(connectionId, {
          assignedClientId: p.assignedClientIdentifier,
          serverTopicAliasMaximum: p.topicAliasMaximum,
        } as Partial<MqttConnection>);
        const notes = [
          p.sessionPresent ? 'session present' : '',
          p.assignedClientIdentifier ? `assigned client ID ${p.assignedClientIdentifier}` : '',
          p.topicAliasMaximum ? `topic alias max ${p.topicAliasMaximum}` : '',
          p.serverKeepAlive !== undefined ? `server keep-alive ${p.serverKeepAlive}s` : '',
        ].filter(Boolean);
        systemMessage(connectionId, `Connected${notes.length ? ` (${notes.join(', ')})` : ''}`);
      },

      // Broker-initiated MQTT 5 DISCONNECT — explain why before CLOSE arrives.
      disconnected: (payload) => {
        this.flushBuffer(connectionId);
        const p = payload as MqttServerDisconnectEvent;
        systemMessage(connectionId, describeServerDisconnect(p), { error: p.reasonCode >= 0x80 });
      },

      offline: () => {
        if (useMqttStore.getState().connections[connectionId]?.autoReconnect) markReconnecting();
      },
      reconnect: markReconnecting,

      message: (payload) => {
        this.inbound.push(connectionId, receivedFromEvent(payload as MqttMessageEvent));
      },

      subscribed: (payload) => {
        const p = payload as {
          topicFilter: string;
          grantedQos?: MqttQoS;
          subscriptionIdentifier?: number;
        };
        const store = useMqttStore.getState();
        store.patchSubscription(connectionId, p.topicFilter, {
          status: 'subscribed',
          ...(p.grantedQos !== undefined ? { grantedQos: p.grantedQos } : {}),
        });
        store.addMessage(connectionId, {
          direction: 'system',
          topic: p.topicFilter,
          payload: `Subscribed to ${p.topicFilter} (QoS ${p.grantedQos ?? '?'}${
            p.subscriptionIdentifier !== undefined ? `, id ${p.subscriptionIdentifier}` : ''
          })`,
          qos: 0,
          retain: false,
        });
      },

      unsubscribed: (payload) => {
        const p = payload as { topicFilter: string };
        const store = useMqttStore.getState();
        store.removeSubscription(connectionId, p.topicFilter);
        store.addMessage(connectionId, {
          direction: 'system',
          topic: p.topicFilter,
          payload: `Unsubscribed from ${p.topicFilter}`,
          qos: 0,
          retain: false,
        });
      },

      error: (payload) => {
        this.flushBuffer(connectionId);
        const store = useMqttStore.getState();
        // With auto-reconnect on, an unreachable broker emits an error every
        // retry cycle. Surface the first one, then stay quiet while reconnecting
        // so the log isn't flooded.
        if (store.connections[connectionId]?.status === 'reconnecting') return;
        const err = payload as { message?: string };
        const msg = err.message ?? 'MQTT error';
        store.addMessage(connectionId, {
          direction: 'system',
          topic: '',
          payload: msg,
          qos: 0,
          retain: false,
          error: msg,
        });
      },

      close: () => {
        this.flushBuffer(connectionId);
        const store = useMqttStore.getState();
        const conn = store.connections[connectionId];
        // A user-initiated disconnect unbinds these listeners before the CLOSE
        // event is delivered, so reaching here means the broker (or network)
        // dropped the connection.
        if (!conn) return;
        if (conn.autoReconnect) {
          // mqtt.js retries under the hood; reflect that as 'reconnecting' and
          // only log the transition once per drop.
          if (conn.status === 'reconnecting') return;
          store.updateStatus(connectionId, 'reconnecting');
          store.addMessage(connectionId, {
            direction: 'system',
            topic: '',
            payload: 'Connection lost — reconnecting…',
            qos: 0,
            retain: false,
          });
          return;
        }
        store.updateStatus(connectionId, 'disconnected');
        store.addMessage(connectionId, {
          direction: 'system',
          topic: '',
          payload: 'Connection closed',
          qos: 0,
          retain: false,
        });
      },
    });
  }

  /** Drain the buffer for a connection into the store in a single update. */
  flushBuffer(connectionId: string): void {
    this.inbound.flush(connectionId);
  }
}

export const mqttManager = new MqttManager();
