import { MQTT_CHANNEL, mqttChannel } from '../../../../electron/shared/mqtt-channels';
import type { MqttConnectIpc } from '../../../../electron/types/electron-api';
import { useMqttStore, MQTT_SECRET_SENTINEL } from '@/features/mqtt/store/useMqttStore';
import type { MqttConnection, MqttMessage, MqttQoS } from '@/features/mqtt/store/useMqttStore';
import { isElectron, getElectronAPI } from '@/lib/shared/platform';
import { secureStorage } from '@/lib/shared/secure-storage';

/**
 * Inbound PUBLISH messages are buffered and flushed to the store on this
 * interval rather than per-message. MQTT topics (sensor/IoT streams) can push
 * hundreds of messages/sec; coalescing keeps the store update + console-frame
 * write + message-list re-render to ~10 Hz regardless of message rate.
 */
const FLUSH_INTERVAL_MS = 100;

type ReceivedInput = Omit<MqttMessage, 'id' | 'timestamp'> & { timestamp?: number };

export type MqttSecretField = 'password' | 'tls-passphrase';

export function mqttSecretKey(connectionId: string, field: MqttSecretField): string {
  // Both field names match a secureStorage sensitive-key pattern
  // (`password`/`passphrase`) so the value routes to electron-store +
  // safeStorage in the desktop build rather than plaintext localStorage.
  return `mqtt:${connectionId}:${field}`;
}

function readSecret(
  connectionId: string,
  field: 'password' | 'tls-passphrase'
): Promise<string | null> {
  return secureStorage.getAsync(mqttSecretKey(connectionId, field));
}

/**
 * Resolve the persisted MqttConnection (sentinels for secrets, file paths for
 * TLS material) into the wire-format expected by the Electron IPC handler
 * (plaintext + file contents). Returns null when required material is missing.
 */
async function resolveConnect(connection: MqttConnection): Promise<MqttConnectIpc | null> {
  const ipc: MqttConnectIpc = {
    connectionId: connection.id,
    brokerUrl: connection.brokerUrl,
    protocolVersion: connection.protocolVersion,
    clientId: connection.clientId,
    keepalive: connection.keepalive,
    cleanStart: connection.cleanStart,
    connectTimeout: connection.connectTimeout,
    autoReconnect: connection.autoReconnect,
  };

  if (connection.username) ipc.username = connection.username;

  if (connection.password) {
    const real = await (connection.password === MQTT_SECRET_SENTINEL
      ? readSecret(connection.id, 'password')
      : Promise.resolve(connection.password));
    if (!real) return null;
    ipc.password = real;
  }

  if (connection.sessionExpiryInterval !== undefined) {
    ipc.sessionExpiryInterval = connection.sessionExpiryInterval;
  }

  if (connection.lwt) {
    ipc.lwt = {
      topic: connection.lwt.topic,
      payload: connection.lwt.payload,
      qos: connection.lwt.qos,
      retain: connection.lwt.retain,
    };
  }

  // TLS only applies to mqtts:// brokers.
  if (connection.brokerUrl.startsWith('mqtts://') && connection.tls) {
    const tls: NonNullable<MqttConnectIpc['tls']> = {};
    if (connection.tls.rejectUnauthorized !== undefined) {
      tls.rejectUnauthorized = connection.tls.rejectUnauthorized;
    }
    const api = getElectronAPI();
    if (api) {
      const readPath = (p?: string): Promise<{ success: boolean; content?: string } | null> =>
        p ? api.fs.readFile(p) : Promise.resolve(null);
      const [caResult, certResult, keyResult] = await Promise.all([
        readPath(connection.tls.caPath),
        readPath(connection.tls.certPath),
        readPath(connection.tls.keyPath),
      ]);
      if (connection.tls.caPath) {
        if (!caResult?.success || !caResult.content) return null;
        tls.ca = caResult.content;
      }
      if (connection.tls.certPath) {
        if (!certResult?.success || !certResult.content) return null;
        tls.cert = certResult.content;
      }
      if (connection.tls.keyPath) {
        if (!keyResult?.success || !keyResult.content) return null;
        tls.key = keyResult.content;
      }
    }
    if (connection.tls.passphrase === MQTT_SECRET_SENTINEL) {
      const real = await readSecret(connection.id, 'tls-passphrase');
      if (real) tls.passphrase = real;
    } else if (connection.tls.passphrase) {
      tls.passphrase = connection.tls.passphrase;
    }
    ipc.tls = tls;
  }

  return ipc;
}

class MqttManager {
  /** Per-connection buffer of inbound messages awaiting the next flush. */
  private buffers = new Map<string, ReceivedInput[]>();
  private flushTimers = new Map<string, ReturnType<typeof setTimeout>>();

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

    // Always start from a clean listener set — a previous failed/closed attempt
    // on this connectionId may have left handlers bound, and binding again
    // would double-handle every subsequent event.
    this.unbindListeners(connection.id);
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
      this.unbindListeners(connection.id);
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
      this.unbindListeners(connection.id);
      return { ok: false, error: msg };
    }

    // Status flips to 'connected' when the CONNACK arrives via the CONNECTED
    // channel. Leave it at 'connecting' here.
    return { ok: true };
  }

  async publish(params: {
    connectionId: string;
    topic: string;
    payload: string;
    qos: MqttQoS;
    retain: boolean;
    userProperties?: Record<string, string | string[]>;
    messageExpiryInterval?: number;
    contentType?: string;
    responseTopic?: string;
    correlationData?: string;
  }): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!isElectron()) return { ok: false, error: 'MQTT is desktop-only.' };
    const api = getElectronAPI();
    if (!api) return { ok: false, error: 'Electron API unavailable.' };

    const store = useMqttStore.getState();
    const result = await api.mqtt.publish({
      connectionId: params.connectionId,
      topic: params.topic,
      payload: params.payload,
      qos: params.qos,
      retain: params.retain,
      ...(params.userProperties ? { userProperties: params.userProperties } : {}),
      ...(params.messageExpiryInterval !== undefined
        ? { messageExpiryInterval: params.messageExpiryInterval }
        : {}),
      ...(params.contentType ? { contentType: params.contentType } : {}),
      ...(params.responseTopic ? { responseTopic: params.responseTopic } : {}),
      ...(params.correlationData ? { correlationData: params.correlationData } : {}),
    });

    if (!result.success) {
      const msg = result.error ?? 'Publish failed';
      store.addMessage(params.connectionId, {
        direction: 'system',
        topic: params.topic,
        payload: msg,
        qos: params.qos,
        retain: params.retain,
        error: msg,
      });
      return { ok: false, error: msg };
    }

    store.addMessage(params.connectionId, {
      direction: 'sent',
      topic: params.topic,
      payload: params.payload,
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
  }): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!isElectron()) return { ok: false, error: 'MQTT is desktop-only.' };
    const api = getElectronAPI();
    if (!api) return { ok: false, error: 'Electron API unavailable.' };

    const store = useMqttStore.getState();
    store.upsertSubscription(params.connectionId, {
      topicFilter: params.topicFilter,
      requestedQos: params.qos,
      status: 'subscribing',
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
    this.unbindListeners(connectionId);
    const store = useMqttStore.getState();
    store.updateStatus(connectionId, 'disconnected');
  }

  private bindListeners(connectionId: string): void {
    const api = getElectronAPI();
    if (!api?.mqtt) return;

    api.mqtt.on(mqttChannel(MQTT_CHANNEL.CONNECTED, connectionId), (payload: unknown) => {
      const p = payload as { sessionPresent?: boolean };
      const store = useMqttStore.getState();
      store.updateStatus(connectionId, 'connected');
      store.addMessage(connectionId, {
        direction: 'system',
        topic: '',
        payload: `Connected${p.sessionPresent ? ' (session present)' : ''}`,
        qos: 0,
        retain: false,
      });
    });

    api.mqtt.on(mqttChannel(MQTT_CHANNEL.MESSAGE, connectionId), (payload: unknown) => {
      const msg = payload as {
        topic: string;
        payload: string;
        qos: MqttQoS;
        retain: boolean;
        dup?: boolean;
        userProperties?: Record<string, string | string[]>;
        messageExpiryInterval?: number;
        contentType?: string;
        responseTopic?: string;
        correlationData?: string;
        subscriptionIdentifier?: number | number[];
        timestamp: number;
      };
      this.enqueueReceived(connectionId, {
        direction: 'received',
        topic: msg.topic,
        payload: msg.payload,
        qos: msg.qos,
        retain: msg.retain,
        ...(msg.dup !== undefined ? { dup: msg.dup } : {}),
        ...(msg.userProperties ? { userProperties: msg.userProperties } : {}),
        ...(msg.messageExpiryInterval !== undefined
          ? { messageExpiryInterval: msg.messageExpiryInterval }
          : {}),
        ...(msg.contentType ? { contentType: msg.contentType } : {}),
        ...(msg.responseTopic ? { responseTopic: msg.responseTopic } : {}),
        ...(msg.correlationData ? { correlationData: msg.correlationData } : {}),
        ...(msg.subscriptionIdentifier !== undefined
          ? { subscriptionIdentifier: msg.subscriptionIdentifier }
          : {}),
        timestamp: msg.timestamp,
      });
    });

    api.mqtt.on(mqttChannel(MQTT_CHANNEL.SUBSCRIBED, connectionId), (payload: unknown) => {
      const p = payload as { topicFilter: string; grantedQos?: MqttQoS };
      const store = useMqttStore.getState();
      store.patchSubscription(connectionId, p.topicFilter, {
        status: 'subscribed',
        ...(p.grantedQos !== undefined ? { grantedQos: p.grantedQos } : {}),
      });
      store.addMessage(connectionId, {
        direction: 'system',
        topic: p.topicFilter,
        payload: `Subscribed to ${p.topicFilter} (QoS ${p.grantedQos ?? '?'})`,
        qos: 0,
        retain: false,
      });
    });

    api.mqtt.on(mqttChannel(MQTT_CHANNEL.UNSUBSCRIBED, connectionId), (payload: unknown) => {
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
    });

    api.mqtt.on(mqttChannel(MQTT_CHANNEL.ERROR, connectionId), (payload: unknown) => {
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
    });

    api.mqtt.on(mqttChannel(MQTT_CHANNEL.CLOSE, connectionId), () => {
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
    });
  }

  /** Buffer an inbound message and arm the flush timer if it isn't already. */
  private enqueueReceived(connectionId: string, msg: ReceivedInput): void {
    const buf = this.buffers.get(connectionId);
    if (buf) {
      buf.push(msg);
    } else {
      this.buffers.set(connectionId, [msg]);
    }
    if (!this.flushTimers.has(connectionId)) {
      this.flushTimers.set(
        connectionId,
        setTimeout(() => this.flushBuffer(connectionId), FLUSH_INTERVAL_MS)
      );
    }
  }

  /** Drain the buffer for a connection into the store in a single update. */
  private flushBuffer(connectionId: string): void {
    const timer = this.flushTimers.get(connectionId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.flushTimers.delete(connectionId);
    }
    const buf = this.buffers.get(connectionId);
    if (!buf || buf.length === 0) return;
    this.buffers.delete(connectionId);
    useMqttStore.getState().addMessages(connectionId, buf);
  }

  private unbindListeners(connectionId: string): void {
    // Drain anything still buffered before detaching — otherwise the last
    // ~100ms of inbound messages would be silently dropped on disconnect.
    this.flushBuffer(connectionId);
    const api = getElectronAPI();
    if (!api?.mqtt) return;
    api.mqtt.removeAllListeners(mqttChannel(MQTT_CHANNEL.CONNECTED, connectionId));
    api.mqtt.removeAllListeners(mqttChannel(MQTT_CHANNEL.MESSAGE, connectionId));
    api.mqtt.removeAllListeners(mqttChannel(MQTT_CHANNEL.SUBSCRIBED, connectionId));
    api.mqtt.removeAllListeners(mqttChannel(MQTT_CHANNEL.UNSUBSCRIBED, connectionId));
    api.mqtt.removeAllListeners(mqttChannel(MQTT_CHANNEL.ERROR, connectionId));
    api.mqtt.removeAllListeners(mqttChannel(MQTT_CHANNEL.CLOSE, connectionId));
  }
}

export const mqttManager = new MqttManager();
