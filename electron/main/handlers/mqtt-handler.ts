import { type MqttSecretField, mqttBoundSecretHandleId } from '@shared/protocol/broker-secret-id';
import { createLogger } from '@shared/runtime/logger';
import type { SecretValue } from '@shared/secrets/secret-ref';
import type { WebContents } from 'electron';
import { ipcMain, webContents } from 'electron';
import type * as MqttLib from 'mqtt';
import type { IConnackPacket, IDisconnectPacket, IPublishPacket, MqttClient } from 'mqtt';
import { IPC } from '../../shared/channels';
import { MQTT_CHANNEL, mqttChannel } from '../../shared/mqtt-channels';
import { createKeyedRateLimiter, rateLimited } from '../ipc/ipc-rate-limiter';
import { emitTo, errorMessage } from '../ipc/ipc-utils';
import {
  assertTrustedSender,
  createValidatedEventHandler,
  MqttConnectSchema,
  MqttDisconnectSchema,
  MqttPublishSchema,
  MqttRequestCancelSchema,
  MqttRequestSchema,
  MqttSubscribeSchema,
  MqttUnsubscribeSchema,
  validateIpcInput,
} from '../ipc/ipc-validators';
import { emitToEntry, StreamRegistry } from '../ipc/stream-registry';
import type { LogEntry } from '../lifecycle/request-logger';
import { resolveMqttBrokerAddress } from '../security/broker-dns-guard';
import {
  type BrokerTlsOptions,
  resolveMqttExecutionPolicy,
} from '../security/broker-execution-policy';
import { loadBrokerTlsFiles } from '../security/broker-tls-files';
import { getExecutionPolicy } from '../security/execution-policy';
import { assertMqttBrokerSafe } from '../security/mqtt-broker-guard';
import { describeSecretHandle, unwrapSecretValueMain } from '../security/secret-handle-store';
import { type PendingRequest, runMqttRequest } from './mqtt/request';
import {
  buildClientOptions,
  decodeBinary,
  type MqttResolvedConnect,
  publishProperties,
  toMessageEvent,
  v5OnlyPublishFields,
} from './mqtt/wire';

const log = createLogger('mqtt');

const MISSING_SECRET: Record<MqttSecretField, string> = {
  password: 'Stored MQTT password is missing — re-enter it.',
  'tls-passphrase': 'Stored TLS key passphrase is missing — re-enter it.',
  'auth-data': 'Stored MQTT authentication data is missing — re-enter it.',
};

/**
 * Resolve one MQTT credential (ADR-0007). A handle resolves only when it is
 * the one bound to THIS connection's field (deterministic id derived from the
 * connection id), so a crafted connect payload cannot send another feature's
 * stored secret to an arbitrary broker. Unresolvable → explicit error.
 */
function resolveMqttSecret(
  connectionId: string,
  field: MqttSecretField,
  value: SecretValue
): string {
  if (typeof value === 'object' && value.kind === 'handle') {
    if (value.id !== mqttBoundSecretHandleId(connectionId, field)) {
      throw new Error('This stored secret is not available to this MQTT connection.');
    }
    if (!describeSecretHandle(value.id)) throw new Error(MISSING_SECRET[field]);
  }
  const plaintext = unwrapSecretValueMain(value);
  if (plaintext === undefined) throw new Error(MISSING_SECRET[field]);
  return plaintext;
}

// `mqtt` is moderately heavy and most sessions never open a connection. Load it
// lazily on first use rather than at module load (which runs before
// app.whenReady via main.ts, delaying window creation). The named types
// imported above are erased at compile time, so importing them type-only costs
// nothing.
let _mqtt: typeof MqttLib | undefined;
const getMqtt = (): typeof MqttLib => (_mqtt ??= require('mqtt'));

/**
 * Test-only seam. The lazy bare `require('mqtt')` above is not interceptable
 * by vitest's ESM-level `vi.mock` (same constraint documented in
 * secret-handle-store's `__setSecretStoreForTests`), so tests inject a fake
 * lib here. Pass `undefined` to restore the real lazy load.
 */
export function __setMqttForTests(lib: typeof MqttLib | undefined): void {
  _mqtt = lib;
}

export const mqttRateLimiter = createKeyedRateLimiter(20, 60_000);
// Per-renderer budget for broker-touching calls after connect (publish,
// subscribe, request — each a broker round trip). Generous enough for
// templates fired in quick succession; bounds a runaway renderer.
export const mqttOpRateLimiter = createKeyedRateLimiter(1200, 60_000);

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
  protocolVersion: 4 | 5;
  /** Client id in use — the broker-assigned one once CONNACK carries it. */
  clientId: string;
  /** CONNACK Topic Alias Maximum (MQTT 5); 0 = the broker accepts none. */
  topicAliasMaximum: number;
  /** In-flight MQTT 5 request/response exchanges, keyed by requestId. */
  pendingRequests: Map<string, PendingRequest>;
}

// Shared connection bookkeeping (map + renderer-destroyed cleanup). Like Kafka,
// MQTT keeps its cached-WebContents emit (emitToEntry) and awaited async teardown
// (endClient) — so same-id replace, explicit disconnect, and stopMqttCleanup stay
// manual (awaited) loops. dispose() serves ONLY the renderer-destroyed path, where
// fire-and-forget endClient matches the previous `void endClient(e)`.
const activeConnections = new StreamRegistry<ActiveMqtt>({
  dispose: (e) => {
    void endClient(e);
  },
});

function bindClientListeners(entry: ActiveMqtt): void {
  const { client } = entry;
  const current = (): boolean =>
    activeConnections.get(entry.connectionId, entry.webContentsId) === entry;

  client.on('connect', (connack: IConnackPacket) => {
    if (!current()) return;
    const props = connack.properties ?? {};
    if (props.assignedClientIdentifier) entry.clientId = props.assignedClientIdentifier;
    entry.topicAliasMaximum = props.topicAliasMaximum ?? 0;
    emitToEntry(entry, mqttChannel(MQTT_CHANNEL.CONNECTED, entry.connectionId), {
      timestamp: Date.now(),
      sessionPresent: connack.sessionPresent ?? false,
      ...(connack.reasonCode !== undefined ? { reasonCode: connack.reasonCode } : {}),
      ...(props.assignedClientIdentifier
        ? { assignedClientIdentifier: props.assignedClientIdentifier }
        : {}),
      ...(props.topicAliasMaximum !== undefined
        ? { topicAliasMaximum: props.topicAliasMaximum }
        : {}),
      ...(props.serverKeepAlive !== undefined ? { serverKeepAlive: props.serverKeepAlive } : {}),
      ...(props.receiveMaximum !== undefined ? { receiveMaximum: props.receiveMaximum } : {}),
      ...(props.maximumQoS !== undefined ? { maximumQoS: props.maximumQoS } : {}),
      ...(props.retainAvailable !== undefined ? { retainAvailable: props.retainAvailable } : {}),
      ...(props.responseInformation ? { responseInformation: props.responseInformation } : {}),
      ...(props.reasonString ? { reasonString: props.reasonString } : {}),
    });
  });

  client.on('message', (topic: string, payload: Buffer, packet: IPublishPacket) => {
    if (!current()) return;
    const event = toMessageEvent(topic, payload, packet);
    emitToEntry(entry, mqttChannel(MQTT_CHANNEL.MESSAGE, entry.connectionId), event);
    // MQTT 5 request/response: settle the request whose correlation bytes match.
    const correlation = packet.properties?.correlationData;
    if (correlation && entry.pendingRequests.size > 0) {
      const bytes = Buffer.from(correlation);
      for (const pending of entry.pendingRequests.values()) {
        if (pending.responseTopic === topic && pending.correlation.equals(bytes)) {
          pending.respond(event);
          break;
        }
      }
    }
  });

  // Broker-initiated MQTT 5 DISCONNECT (§3.14) — surface the reason (MQTT-6).
  client.on('disconnect', (packet: IDisconnectPacket) => {
    if (!current()) return;
    emitToEntry(entry, mqttChannel(MQTT_CHANNEL.DISCONNECTED, entry.connectionId), {
      timestamp: Date.now(),
      reasonCode: packet.reasonCode ?? 0,
      ...(packet.properties?.reasonString ? { reasonString: packet.properties.reasonString } : {}),
      ...(packet.properties?.serverReference
        ? { serverReference: packet.properties.serverReference }
        : {}),
    });
  });

  client.on('reconnect', () => {
    if (!current()) return;
    emitToEntry(entry, mqttChannel(MQTT_CHANNEL.RECONNECT, entry.connectionId), {
      timestamp: Date.now(),
    });
  });

  client.on('offline', () => {
    if (!current()) return;
    emitToEntry(entry, mqttChannel(MQTT_CHANNEL.OFFLINE, entry.connectionId), {
      timestamp: Date.now(),
    });
  });

  client.on('error', (err: Error) => {
    if (!current()) return;
    const code = (err as NodeJS.ErrnoException).code;
    log.warn('client error', {
      connectionId: entry.connectionId,
      error: err.message,
      ...(code ? { code } : {}),
    });
    emitToEntry(entry, mqttChannel(MQTT_CHANNEL.ERROR, entry.connectionId), {
      message: err.message,
      ...(code ? { code } : {}),
    });
  });

  client.on('close', () => {
    if (!current()) return;
    emitToEntry(entry, mqttChannel(MQTT_CHANNEL.CLOSE, entry.connectionId), {});
  });
}

/** Fail every in-flight request on a connection that is going away. */
function abortPendingRequests(entry: ActiveMqtt, error: string): void {
  for (const pending of [...entry.pendingRequests.values()]) {
    pending.abort({ cancelled: true, error });
  }
}

function endClient(entry: ActiveMqtt, force = true): Promise<void> {
  abortPendingRequests(entry, 'Connection closed');
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
  // mqtt.js falls back to process.env.MQTTJS_SOCKS_PROXY whenever no SOCKS
  // proxy is configured — a proxy the acknowledged execution policy never
  // approved. Only Settings → Proxy may route MQTT traffic.
  delete process.env.MQTTJS_SOCKS_PROXY;
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

    if (
      activeConnections.size() + activeConnections.pendingCount() >=
      MAX_CONCURRENT_MQTT_CONNECTIONS
    ) {
      logEntry(503, 'Too many open connections');
      return { success: false, error: 'Too many open MQTT connections.' };
    }

    // Reserve synchronously before closing an owner reconnect, inspecting broker
    // credentials, running the guard, or constructing a client.
    const claim = activeConnections.reserveClaim(connectionId, event.sender);
    if (!claim) return { success: false, error: 'Not connected' };
    try {
      if (claim.ownerEntry) {
        const existing = claim.ownerEntry;
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
        if (
          !activeConnections.isClaimLive(claim) ||
          activeConnections.get(connectionId, webContentsId) !== existing
        ) {
          return { success: false, error: 'Not connected' };
        }
        activeConnections.remove(connectionId, webContentsId);
      }

      let policyConfig: ReturnType<typeof resolveMqttExecutionPolicy>;
      const resolved: MqttResolvedConnect = {};
      try {
        const security = getExecutionPolicy().security;
        assertMqttBrokerSafe(cfg.brokerUrl, security);
        // Secrets arrive as SecretRef handles and TLS material as file paths;
        // both resolve here, in main, at wire time (ADR-0007 / SEC-K3).
        if (cfg.password !== undefined) {
          resolved.password = resolveMqttSecret(connectionId, 'password', cfg.password);
        }
        const authData = cfg.properties?.authenticationData;
        if (cfg.protocolVersion === 5 && authData !== undefined) {
          resolved.authenticationData = resolveMqttSecret(connectionId, 'auth-data', authData);
        }
        let tls: BrokerTlsOptions | undefined;
        if (cfg.tls) {
          const { passphrase, ...files } = cfg.tls;
          tls = await loadBrokerTlsFiles(files);
          if (passphrase !== undefined) {
            tls.passphrase = resolveMqttSecret(connectionId, 'tls-passphrase', passphrase);
          }
        }
        policyConfig = resolveMqttExecutionPolicy({
          brokerUrl: cfg.brokerUrl,
          connectTimeout: cfg.connectTimeout,
          ...(tls ? { tls } : {}),
        });
        // DNS-time guard (SEC-K1): every A/AAAA record is checked against the
        // private-IP / localhost policy and the dial is pinned to it. Behind a
        // SOCKS proxy the proxy resolves the target, so there's nothing local
        // to check or pin.
        if (!policyConfig.socksProxy) {
          resolved.pinned = await resolveMqttBrokerAddress(cfg.brokerUrl, security);
        }
      } catch (err) {
        const msg = errorMessage(err);
        logEntry(400, msg);
        return { success: false, error: msg };
      }

      try {
        if (!activeConnections.isClaimLive(claim)) {
          return { success: false, error: 'Not connected' };
        }

        const mqtt = getMqtt();
        const client = mqtt.connect(cfg.brokerUrl, buildClientOptions(cfg, policyConfig, resolved));
        const wc = webContents.fromId(webContentsId) ?? undefined;
        const entry: ActiveMqtt = {
          client,
          connectionId,
          webContentsId,
          ...(wc ? { wc } : {}),
          subscriptions: new Set<string>(),
          brokerUrl: cfg.brokerUrl,
          createdAt: Date.now(),
          protocolVersion: cfg.protocolVersion,
          clientId: cfg.clientId,
          topicAliasMaximum: 0,
          pendingRequests: new Map(),
        };
        if (!activeConnections.tryAdd(connectionId, event.sender, entry)) {
          await endClient(entry);
          return { success: false, error: 'Not connected' };
        }
        bindClientListeners(entry);

        // CONNACK arrives asynchronously via the 'connect' event → CONNECTED
        // channel; we only confirm the client was constructed here.
        logEntry(0);
        return { success: true };
      } catch (err) {
        const msg = errorMessage(err);
        logEntry(500, msg);
        return { success: false, error: msg };
      }
    } finally {
      activeConnections.releaseClaim(claim);
    }
  });

  ipcMain.handle(
    IPC.mqtt.publish,
    rateLimited(
      mqttOpRateLimiter,
      createValidatedEventHandler(IPC.mqtt.publish, MqttPublishSchema, async (cfg, event) => {
        const entry = activeConnections.getForOwner(cfg.connectionId, event.sender.id);
        if (!entry) return { success: false, error: 'Not connected' };

        const v5Fields = entry.protocolVersion === 5 ? [] : v5OnlyPublishFields(cfg);
        if (v5Fields.length > 0) {
          return {
            success: false,
            error: `MQTT 5 properties (${v5Fields.join(', ')}) are not available on an MQTT 3.1.1 connection`,
          };
        }
        if (cfg.topicAlias !== undefined && cfg.topicAlias > entry.topicAliasMaximum) {
          return {
            success: false,
            error:
              entry.topicAliasMaximum === 0
                ? 'The broker does not accept topic aliases (Topic Alias Maximum is 0)'
                : `Topic alias ${cfg.topicAlias} exceeds the broker's Topic Alias Maximum (${entry.topicAliasMaximum})`,
          };
        }

        const properties = publishProperties(cfg);
        const payload = decodeBinary(cfg.payload, cfg.payloadEncoding);

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
            payload,
            {
              qos: cfg.qos,
              retain: cfg.retain,
              ...(Object.keys(properties).length > 0 ? { properties } : {}),
            },
            (err, packet) => {
              if (activeConnections.get(cfg.connectionId, entry.webContentsId) !== entry) {
                resolve({ success: false, error: 'Not connected' });
                return;
              }
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
    )
  );

  ipcMain.handle(
    IPC.mqtt.request,
    rateLimited(
      mqttOpRateLimiter,
      createValidatedEventHandler(IPC.mqtt.request, MqttRequestSchema, async (cfg, event) => {
        const entry = activeConnections.getForOwner(cfg.connectionId, event.sender.id);
        if (!entry) return { success: false, error: 'Not connected' };
        return runMqttRequest(
          entry,
          cfg,
          () => activeConnections.get(entry.connectionId, entry.webContentsId) === entry
        );
      })
    )
  );

  ipcMain.handle(
    IPC.mqtt.requestCancel,
    rateLimited(
      mqttOpRateLimiter,
      createValidatedEventHandler(
        IPC.mqtt.requestCancel,
        MqttRequestCancelSchema,
        async (cfg, event) => {
          const entry = activeConnections.getForOwner(cfg.connectionId, event.sender.id);
          const pending = entry?.pendingRequests.get(cfg.requestId);
          if (!pending) return { success: false };
          pending.abort({ cancelled: true, error: 'Request cancelled' });
          return { success: true };
        }
      )
    )
  );

  ipcMain.handle(
    IPC.mqtt.subscribe,
    rateLimited(
      mqttOpRateLimiter,
      createValidatedEventHandler(IPC.mqtt.subscribe, MqttSubscribeSchema, async (cfg, event) => {
        const entry = activeConnections.getForOwner(cfg.connectionId, event.sender.id);
        if (!entry) return { success: false, error: 'Not connected' };

        const v5Requested = cfg.options !== undefined || cfg.subscriptionIdentifier !== undefined;
        if (v5Requested && entry.protocolVersion !== 5) {
          return {
            success: false,
            error:
              'Subscription options and identifiers require an MQTT 5 connection (this one is MQTT 3.1.1)',
          };
        }
        const subscribeOpts: Parameters<MqttClient['subscribe']>[1] = { qos: cfg.qos };
        if (cfg.options?.noLocal !== undefined) subscribeOpts.nl = cfg.options.noLocal;
        if (cfg.options?.retainAsPublished !== undefined) {
          subscribeOpts.rap = cfg.options.retainAsPublished;
        }
        if (cfg.options?.retainHandling !== undefined)
          subscribeOpts.rh = cfg.options.retainHandling;
        if (cfg.subscriptionIdentifier !== undefined) {
          subscribeOpts.properties = { subscriptionIdentifier: cfg.subscriptionIdentifier };
        }

        return new Promise<{ success: boolean; error?: string }>((resolve) => {
          entry.client.subscribe(cfg.topicFilter, subscribeOpts, (err, granted) => {
            if (activeConnections.get(cfg.connectionId, entry.webContentsId) !== entry) {
              resolve({ success: false, error: 'Not connected' });
              return;
            }
            if (err) {
              resolve({ success: false, error: errorMessage(err) });
              return;
            }
            const first = granted?.[0];
            // Granted QoS of 128 (0x80) signals the broker rejected the filter.
            if (first && first.qos >= 128) {
              resolve({
                success: false,
                error: `Subscription rejected (reason code ${first.qos})`,
              });
              return;
            }
            entry.subscriptions.add(cfg.topicFilter);
            emitToEntry(entry, mqttChannel(MQTT_CHANNEL.SUBSCRIBED, cfg.connectionId), {
              topicFilter: cfg.topicFilter,
              grantedQos: first?.qos ?? cfg.qos,
              ...(cfg.subscriptionIdentifier !== undefined
                ? { subscriptionIdentifier: cfg.subscriptionIdentifier }
                : {}),
            });
            resolve({ success: true });
          });
        });
      })
    )
  );

  ipcMain.handle(
    IPC.mqtt.unsubscribe,
    rateLimited(
      mqttOpRateLimiter,
      createValidatedEventHandler(
        IPC.mqtt.unsubscribe,
        MqttUnsubscribeSchema,
        async (cfg, event) => {
          const entry = activeConnections.getForOwner(cfg.connectionId, event.sender.id);
          if (!entry) return { success: false, error: 'Not connected' };

          return new Promise<{ success: boolean; error?: string }>((resolve) => {
            entry.client.unsubscribe(cfg.topicFilter, (err) => {
              if (activeConnections.get(cfg.connectionId, entry.webContentsId) !== entry) {
                resolve({ success: false, error: 'Not connected' });
                return;
              }
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
        }
      )
    )
  );

  ipcMain.handle(
    IPC.mqtt.disconnect,
    createValidatedEventHandler(IPC.mqtt.disconnect, MqttDisconnectSchema, async (cfg, event) => {
      const entry = activeConnections.getForOwner(cfg.connectionId, event.sender.id);
      if (entry) {
        await endClient(entry, false);
        if (activeConnections.get(cfg.connectionId, entry.webContentsId) === entry) {
          activeConnections.remove(cfg.connectionId, entry.webContentsId);
          emitTo(entry.webContentsId, mqttChannel(MQTT_CHANNEL.CLOSE, cfg.connectionId), {});
        }
      }
      return { success: true };
    })
  );
}

export async function stopMqttCleanup(): Promise<void> {
  activeConnections.clearClaims();
  for (const entry of activeConnections.values()) {
    await endClient(entry);
  }
  activeConnections.clear();
}
