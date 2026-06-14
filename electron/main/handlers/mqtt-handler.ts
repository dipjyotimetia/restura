import { ipcMain, webContents } from 'electron';
import type { WebContents } from 'electron';
import type { IClientOptions, MqttClient, IConnackPacket, IPublishPacket } from 'mqtt';
import type * as MqttLib from 'mqtt';
import { createKeyedRateLimiter } from '../ipc/ipc-rate-limiter';
import { bindRendererCleanup, disposeByOwner } from '../ipc/connection-cleanup';
import { emitTo, errorMessage } from '../ipc/ipc-utils';
import { MQTT_CHANNEL, mqttChannel } from '../../shared/mqtt-channels';
import { IPC } from '../../shared/channels';
import { assertMqttBrokerSafe } from '../security/mqtt-broker-guard';
import type { LogEntry } from '../lifecycle/request-logger';
import {
  MqttConnectSchema,
  MqttPublishSchema,
  MqttSubscribeSchema,
  MqttUnsubscribeSchema,
  MqttDisconnectSchema,
  validateIpcInput,
  createValidatedHandler,
  assertTrustedSender,
  type MqttConnectConfig,
} from '../ipc/ipc-validators';

// `mqtt` is moderately heavy and most sessions never open a connection. Load it
// lazily on first use rather than at module load (which runs before
// app.whenReady via main.ts, delaying window creation). The named types
// imported above are erased at compile time, so importing them type-only costs
// nothing.
let _mqtt: typeof MqttLib | undefined;
const getMqtt = (): typeof MqttLib => (_mqtt ??= require('mqtt'));

export const mqttRateLimiter = createKeyedRateLimiter(20, 60_000);

const MAX_CONCURRENT_MQTT_CONNECTIONS = 20;

interface ActiveMqtt {
  client: MqttClient;
  connectionId: string;
  webContentsId: number;
  /** Cached at connect — avoids a `webContents.fromId()` lookup per message. */
  wc?: WebContents;
  subscriptions: Set<string>;
  brokerUrl: string;
  createdAt: number;
}

const activeConnections = new Map<string, ActiveMqtt>();

function emitToEntry(entry: ActiveMqtt, channel: string, ...args: unknown[]): void {
  if (entry.wc && !entry.wc.isDestroyed()) {
    entry.wc.send(channel, ...args);
    return;
  }
  emitTo(entry.webContentsId, channel, ...args);
}

// MQTT.js forwards unknown options through to the underlying tls.connect, but
// its typed `IClientOptions` omits `passphrase`. Widen locally so we can set it.
type MqttClientOptions = IClientOptions & { passphrase?: string };

function buildClientOptions(cfg: MqttConnectConfig): MqttClientOptions {
  const opts: MqttClientOptions = {
    protocolVersion: cfg.protocolVersion,
    clientId: cfg.clientId,
    keepalive: cfg.keepalive,
    clean: cfg.cleanStart,
    connectTimeout: cfg.connectTimeout,
    // 0 disables auto-reconnect; otherwise retry every second.
    reconnectPeriod: cfg.autoReconnect ? 1000 : 0,
  };

  if (cfg.username !== undefined) opts.username = cfg.username;
  if (cfg.password !== undefined) opts.password = cfg.password;

  const isTls = new URL(cfg.brokerUrl).protocol === 'mqtts:';
  if (isTls && cfg.tls) {
    if (cfg.tls.ca) opts.ca = cfg.tls.ca;
    if (cfg.tls.cert) opts.cert = cfg.tls.cert;
    if (cfg.tls.key) opts.key = cfg.tls.key;
    if (cfg.tls.passphrase) opts.passphrase = cfg.tls.passphrase;
    if (cfg.tls.rejectUnauthorized !== undefined) {
      opts.rejectUnauthorized = cfg.tls.rejectUnauthorized;
    }
  }

  if (cfg.lwt) {
    opts.will = {
      topic: cfg.lwt.topic,
      payload: Buffer.from(cfg.lwt.payload),
      qos: cfg.lwt.qos,
      retain: cfg.lwt.retain,
    };
  }

  // MQTT 5.0 CONNECT properties.
  if (cfg.protocolVersion === 5 && cfg.sessionExpiryInterval !== undefined) {
    opts.properties = { sessionExpiryInterval: cfg.sessionExpiryInterval };
  }

  return opts;
}

function bindClientListeners(entry: ActiveMqtt): void {
  const { client } = entry;

  client.on('connect', (connack: IConnackPacket) => {
    emitToEntry(entry, mqttChannel(MQTT_CHANNEL.CONNECTED, entry.connectionId), {
      timestamp: Date.now(),
      sessionPresent: connack.sessionPresent ?? false,
      ...(connack.reasonCode !== undefined ? { reasonCode: connack.reasonCode } : {}),
    });
  });

  client.on('message', (topic: string, payload: Buffer, packet: IPublishPacket) => {
    const props = packet.properties ?? {};
    emitToEntry(entry, mqttChannel(MQTT_CHANNEL.MESSAGE, entry.connectionId), {
      topic,
      payload: payload.toString(),
      qos: packet.qos,
      retain: packet.retain ?? false,
      dup: packet.dup ?? false,
      timestamp: Date.now(),
      ...(props.userProperties ? { userProperties: props.userProperties } : {}),
      ...(props.messageExpiryInterval !== undefined
        ? { messageExpiryInterval: props.messageExpiryInterval }
        : {}),
      ...(props.contentType ? { contentType: props.contentType } : {}),
      ...(props.responseTopic ? { responseTopic: props.responseTopic } : {}),
      // MQTT 5 request/response correlation — Buffer on the wire, surfaced as text.
      ...(props.correlationData
        ? { correlationData: Buffer.from(props.correlationData).toString() }
        : {}),
      // Which subscription matched (MQTT 5 subscription identifier).
      ...(props.subscriptionIdentifier !== undefined
        ? { subscriptionIdentifier: props.subscriptionIdentifier }
        : {}),
    });
  });

  client.on('error', (err: Error) => {
    const code = (err as NodeJS.ErrnoException).code;
    emitToEntry(entry, mqttChannel(MQTT_CHANNEL.ERROR, entry.connectionId), {
      message: err.message,
      ...(code ? { code } : {}),
    });
  });

  client.on('close', () => {
    emitToEntry(entry, mqttChannel(MQTT_CHANNEL.CLOSE, entry.connectionId), {});
  });
}

function endClient(entry: ActiveMqtt, force = true): Promise<void> {
  return new Promise<void>((resolve) => {
    try {
      entry.client.removeAllListeners();
      entry.client.end(force, undefined, () => resolve());
    } catch {
      resolve();
    }
  });
}

export function registerMqttHandlerIPC(onComplete?: (entry: LogEntry) => void): void {
  ipcMain.handle(IPC.mqtt.connect, async (event, rawConfig: unknown) => {
    assertTrustedSender(IPC.mqtt.connect, event);
    const cfg = validateIpcInput(MqttConnectSchema, rawConfig, IPC.mqtt.connect);
    const { connectionId } = cfg;
    const webContentsId = event.sender.id;
    const startTime = Date.now();
    // Connect attempts are logged as metadata only — never message payloads —
    // to keep the .jsonl bounded for high-throughput MQTT topics.
    const logEntry = (status: number, error?: string): void => {
      if (!onComplete) return;
      onComplete({
        ts: startTime,
        method: 'CONNECT',
        url: cfg.brokerUrl,
        status,
        durationMs: Date.now() - startTime,
        protocol: 'mqtt',
        requestId: connectionId,
        ...(error !== undefined ? { error } : {}),
      });
    };

    if (!mqttRateLimiter.check(webContentsId)) {
      logEntry(429, 'Rate limit exceeded');
      return { success: false, error: 'Rate limit exceeded. Please wait before connecting.' };
    }

    if (activeConnections.size >= MAX_CONCURRENT_MQTT_CONNECTIONS) {
      logEntry(503, 'Too many open connections');
      return { success: false, error: 'Too many open MQTT connections.' };
    }

    const existing = activeConnections.get(connectionId);
    if (existing) {
      // Renderer reconnected with the same connectionId — tear down the old
      // client first. Emit a CLOSE log entry so the audit trail records the
      // implicit disconnect (matches the explicit mqtt:disconnect path).
      if (onComplete) {
        onComplete({
          ts: Date.now(),
          method: 'CLOSE',
          url: existing.brokerUrl,
          status: 0,
          durationMs: Date.now() - existing.createdAt,
          protocol: 'mqtt',
          requestId: connectionId,
        });
      }
      await endClient(existing);
      activeConnections.delete(connectionId);
    }

    try {
      assertMqttBrokerSafe(cfg.brokerUrl);
    } catch (err) {
      const msg = errorMessage(err);
      logEntry(400, msg);
      return { success: false, error: msg };
    }

    try {
      const mqtt = getMqtt();
      const client = mqtt.connect(cfg.brokerUrl, buildClientOptions(cfg));
      const wc = webContents.fromId(webContentsId) ?? undefined;
      const entry: ActiveMqtt = {
        client,
        connectionId,
        webContentsId,
        ...(wc ? { wc } : {}),
        subscriptions: new Set<string>(),
        brokerUrl: cfg.brokerUrl,
        createdAt: Date.now(),
      };
      activeConnections.set(connectionId, entry);
      bindClientListeners(entry);

      // Tear the connection down if the renderer dies without disconnecting,
      // otherwise the broker socket leaks until the Electron process exits — a
      // real leak under hot-reload. Shared helper dedupes the destroyed
      // listener across reconnects and centralises the owner→dispose walk used
      // by every streaming handler (ADR-0006).
      bindRendererCleanup(activeConnections, event.sender, (deadId) => {
        disposeByOwner(activeConnections, deadId, (e) => {
          void endClient(e);
        });
      });

      // CONNACK arrives asynchronously via the 'connect' event → CONNECTED
      // channel; we only confirm the client was constructed here.
      logEntry(0);
      return { success: true };
    } catch (err) {
      const msg = errorMessage(err);
      logEntry(500, msg);
      return { success: false, error: msg };
    }
  });

  ipcMain.handle(
    IPC.mqtt.publish,
    createValidatedHandler(IPC.mqtt.publish, MqttPublishSchema, async (cfg) => {
      const entry = activeConnections.get(cfg.connectionId);
      if (!entry) return { success: false, error: 'Not connected' };

      const properties: NonNullable<Parameters<MqttClient['publish']>[2]>['properties'] = {};
      if (cfg.userProperties) properties.userProperties = cfg.userProperties;
      if (cfg.messageExpiryInterval !== undefined) {
        properties.messageExpiryInterval = cfg.messageExpiryInterval;
      }
      if (cfg.contentType) properties.contentType = cfg.contentType;
      if (cfg.responseTopic) properties.responseTopic = cfg.responseTopic;
      if (cfg.correlationData) properties.correlationData = Buffer.from(cfg.correlationData);

      return new Promise<{
        success: boolean;
        ack?: {
          topic: string;
          qos: 0 | 1 | 2;
          packetId?: number;
          reasonCode?: number;
          timestamp: number;
        };
        error?: string;
      }>((resolve) => {
        entry.client.publish(
          cfg.topic,
          cfg.payload,
          {
            qos: cfg.qos,
            retain: cfg.retain,
            ...(Object.keys(properties).length > 0 ? { properties } : {}),
          },
          (err, packet) => {
            if (err) {
              resolve({ success: false, error: errorMessage(err) });
              return;
            }
            // `packet` is the PUBACK/PUBCOMP for QoS 1/2; undefined for QoS 0.
            const ackPacket = packet as { messageId?: number; reasonCode?: number } | undefined;
            resolve({
              success: true,
              ack: {
                topic: cfg.topic,
                qos: cfg.qos,
                ...(ackPacket?.messageId !== undefined ? { packetId: ackPacket.messageId } : {}),
                ...(ackPacket?.reasonCode !== undefined
                  ? { reasonCode: ackPacket.reasonCode }
                  : {}),
                timestamp: Date.now(),
              },
            });
          }
        );
      });
    })
  );

  ipcMain.handle(
    IPC.mqtt.subscribe,
    createValidatedHandler(IPC.mqtt.subscribe, MqttSubscribeSchema, async (cfg) => {
      const entry = activeConnections.get(cfg.connectionId);
      if (!entry) return { success: false, error: 'Not connected' };

      return new Promise<{ success: boolean; error?: string }>((resolve) => {
        entry.client.subscribe(cfg.topicFilter, { qos: cfg.qos }, (err, granted) => {
          if (err) {
            resolve({ success: false, error: errorMessage(err) });
            return;
          }
          const first = granted?.[0];
          // Granted QoS of 128 (0x80) signals the broker rejected the filter.
          if (first && first.qos >= 128) {
            resolve({ success: false, error: `Subscription rejected (reason code ${first.qos})` });
            return;
          }
          entry.subscriptions.add(cfg.topicFilter);
          emitToEntry(entry, mqttChannel(MQTT_CHANNEL.SUBSCRIBED, cfg.connectionId), {
            topicFilter: cfg.topicFilter,
            grantedQos: first?.qos ?? cfg.qos,
          });
          resolve({ success: true });
        });
      });
    })
  );

  ipcMain.handle(
    IPC.mqtt.unsubscribe,
    createValidatedHandler(IPC.mqtt.unsubscribe, MqttUnsubscribeSchema, async (cfg) => {
      const entry = activeConnections.get(cfg.connectionId);
      if (!entry) return { success: false, error: 'Not connected' };

      return new Promise<{ success: boolean; error?: string }>((resolve) => {
        entry.client.unsubscribe(cfg.topicFilter, (err) => {
          if (err) {
            resolve({ success: false, error: errorMessage(err) });
            return;
          }
          entry.subscriptions.delete(cfg.topicFilter);
          emitToEntry(entry, mqttChannel(MQTT_CHANNEL.UNSUBSCRIBED, cfg.connectionId), {
            topicFilter: cfg.topicFilter,
          });
          resolve({ success: true });
        });
      });
    })
  );

  ipcMain.handle(
    IPC.mqtt.disconnect,
    createValidatedHandler(IPC.mqtt.disconnect, MqttDisconnectSchema, async (cfg) => {
      const entry = activeConnections.get(cfg.connectionId);
      if (entry) {
        await endClient(entry, false);
        activeConnections.delete(cfg.connectionId);
        emitTo(entry.webContentsId, mqttChannel(MQTT_CHANNEL.CLOSE, cfg.connectionId), {});
      }
      return { success: true };
    })
  );
}

export async function stopMqttCleanup(): Promise<void> {
  for (const [, entry] of activeConnections) {
    await endClient(entry);
  }
  activeConnections.clear();
}
