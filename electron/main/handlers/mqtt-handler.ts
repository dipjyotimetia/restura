import { isUtf8 } from 'node:buffer';
import { randomBytes, randomUUID } from 'node:crypto';
import * as net from 'node:net';
import { createLogger } from '@shared/runtime/logger';
import type { WebContents } from 'electron';
import { ipcMain, webContents } from 'electron';
import type * as MqttLib from 'mqtt';
import type {
  IClientOptions,
  IClientPublishOptions,
  IConnackPacket,
  IDisconnectPacket,
  IPublishPacket,
  MqttClient,
} from 'mqtt';
import { IPC } from '../../shared/channels';
import { MQTT_CHANNEL, mqttChannel } from '../../shared/mqtt-channels';
import { bindRendererCleanup, disposeByOwner } from '../ipc/connection-cleanup';
import { createKeyedRateLimiter } from '../ipc/ipc-rate-limiter';
import { emitTo, errorMessage } from '../ipc/ipc-utils';
import {
  assertTrustedSender,
  createValidatedEventHandler,
  type MqttConnectConfig,
  MqttConnectSchema,
  MqttDisconnectSchema,
  type MqttPublishConfig,
  MqttPublishSchema,
  MqttRequestCancelSchema,
  type MqttRequestConfig,
  MqttRequestSchema,
  MqttSubscribeSchema,
  MqttUnsubscribeSchema,
  validateIpcInput,
} from '../ipc/ipc-validators';
import { ownerScopedKey, StreamRegistry } from '../ipc/stream-registry';
import type { LogEntry } from '../lifecycle/request-logger';
import { resolveMqttBrokerAddress } from '../security/broker-dns-guard';
import {
  type BrokerTlsOptions,
  resolveMqttExecutionPolicy,
} from '../security/broker-execution-policy';
import { loadBrokerTlsFiles } from '../security/broker-tls-files';
import { getExecutionPolicy } from '../security/execution-policy';
import { assertMqttBrokerSafe } from '../security/mqtt-broker-guard';
import { createPinnedLookup, type SafeAddress } from '../security/safe-connect';
import { unwrapSecretValueMain } from '../security/secret-handle-store';

const log = createLogger('mqtt');

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

interface PendingRequest {
  responseTopic: string;
  correlation: Buffer;
  /** Settle with the matching reply. */
  respond: (message: ReturnType<typeof toMessageEvent>) => void;
  /** Settle with a terminal (non-response) outcome — cancel / close. */
  abort: (result: { cancelled?: boolean; error: string }) => void;
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

interface PendingMqttClaim {
  webContentsId: number;
  token: symbol;
  ownerEntry?: ActiveMqtt;
}

const pendingConnections = new Map<string, PendingMqttClaim>();

function reserveMqttClaim(connectionId: string, sender: WebContents): PendingMqttClaim | undefined {
  const key = ownerScopedKey(connectionId, sender.id);
  if (pendingConnections.has(key)) return undefined;

  const ownerEntry = activeConnections.getForOwner(connectionId, sender.id);

  const claim: PendingMqttClaim = {
    webContentsId: sender.id,
    token: Symbol(connectionId),
    ownerEntry,
  };
  pendingConnections.set(key, claim);
  bindRendererCleanup(pendingConnections, sender, (deadId) =>
    disposeByOwner(pendingConnections, deadId, () => {})
  );
  return pendingConnections.get(key) === claim ? claim : undefined;
}

function releaseMqttClaim(connectionId: string, claim: PendingMqttClaim): void {
  const key = ownerScopedKey(connectionId, claim.webContentsId);
  if (pendingConnections.get(key)?.token === claim.token) {
    pendingConnections.delete(key);
  }
}

function emitToEntry(entry: ActiveMqtt, channel: string, ...args: unknown[]): void {
  if (entry.wc && !entry.wc.isDestroyed()) {
    entry.wc.send(channel, ...args);
    return;
  }
  emitTo(entry.webContentsId, channel, ...args);
}

// MQTT.js forwards unknown options through to the underlying tls.connect, but
// its typed `IClientOptions` omits `passphrase`. Widen locally so we can set it.
type MqttClientOptions = IClientOptions & BrokerTlsOptions & { passphrase?: string };

/** Decode an IPC binary field (`utf8` text or `base64`) to the bytes it carries. */
export function decodeBinary(value: string, encoding: 'utf8' | 'base64' | undefined): Buffer {
  return Buffer.from(value, encoding === 'base64' ? 'base64' : 'utf8');
}

/**
 * Encode wire bytes for the renderer without losing any: valid UTF-8 travels as
 * text, anything else as base64 (MQTT-2 — protobuf/CBOR/images survive).
 */
export function encodeBinary(buf: Buffer | Uint8Array): {
  value: string;
  encoding: 'utf8' | 'base64';
} {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return isUtf8(b)
    ? { value: b.toString('utf8'), encoding: 'utf8' }
    : { value: b.toString('base64'), encoding: 'base64' };
}

/** Connect inputs that only exist in main: resolved secrets, TLS files, pinned address. */
export interface MqttResolvedConnect {
  password?: string;
  /** CONNECT Authentication Data, resolved from its SecretRef. */
  authenticationData?: string;
  pinned?: SafeAddress;
}

function buildClientOptions(
  cfg: MqttConnectConfig,
  policyConfig: ReturnType<typeof resolveMqttExecutionPolicy>,
  resolved: MqttResolvedConnect = {}
): MqttClientOptions {
  const v5 = cfg.protocolVersion === 5;
  const opts: MqttClientOptions = {
    protocolVersion: cfg.protocolVersion,
    clientId: cfg.clientId,
    keepalive: cfg.keepalive,
    clean: cfg.cleanStart,
    connectTimeout: policyConfig.connectTimeout,
    // 0 disables auto-reconnect; otherwise retry every second.
    reconnectPeriod: cfg.autoReconnect ? 1000 : 0,
  };

  if (cfg.username !== undefined) opts.username = cfg.username;
  if (resolved.password !== undefined) opts.password = resolved.password;

  if (policyConfig.tls) {
    Object.assign(opts, policyConfig.tls);
  }
  if (policyConfig.socksProxy) opts.socksProxy = policyConfig.socksProxy;

  // Pin the dial to the DNS-checked address (SEC-K1). A SOCKS proxy resolves
  // the target itself (socks5h/socks4a), so there is nothing local to pin.
  const pinned = resolved.pinned;
  if (pinned && !policyConfig.socksProxy) {
    const protocol = new URL(cfg.brokerUrl).protocol;
    if (protocol === 'ws:' || protocol === 'wss:') {
      // The ws URL keeps the hostname (Host header, SNI, certificate check);
      // the socket resolves it through the pinned lookup only.
      opts.wsOptions = { lookup: createPinnedLookup(pinned.host, pinned.ip) };
    } else {
      opts.host = pinned.ip;
      opts.hostname = pinned.ip;
      if (protocol === 'mqtts:' && net.isIP(pinned.host) === 0) {
        (opts as { servername?: string }).servername = pinned.host;
      }
    }
  }

  if (cfg.lwt) {
    const lwt = cfg.lwt;
    opts.will = {
      topic: lwt.topic,
      payload: decodeBinary(lwt.payload, lwt.payloadEncoding),
      qos: lwt.qos,
      retain: lwt.retain,
    };
    // MQTT 5.0 Will Properties — never sent on 3.1.1.
    const wp = lwt.properties;
    if (v5 && wp) {
      const properties: NonNullable<NonNullable<IClientOptions['will']>['properties']> = {};
      if (wp.willDelayInterval !== undefined) properties.willDelayInterval = wp.willDelayInterval;
      if (wp.payloadFormatIndicator !== undefined) {
        properties.payloadFormatIndicator = wp.payloadFormatIndicator;
      }
      if (wp.messageExpiryInterval !== undefined) {
        properties.messageExpiryInterval = wp.messageExpiryInterval;
      }
      if (wp.contentType) properties.contentType = wp.contentType;
      if (wp.responseTopic) properties.responseTopic = wp.responseTopic;
      if (wp.correlationData !== undefined) {
        properties.correlationData = decodeBinary(wp.correlationData, wp.correlationDataEncoding);
      }
      if (wp.userProperties) properties.userProperties = wp.userProperties;
      if (Object.keys(properties).length > 0) opts.will.properties = properties;
    }
  }

  // MQTT 5.0 CONNECT properties.
  if (v5) {
    const properties: NonNullable<IClientOptions['properties']> = {};
    if (cfg.sessionExpiryInterval !== undefined) {
      properties.sessionExpiryInterval = cfg.sessionExpiryInterval;
    }
    const p = cfg.properties;
    if (p) {
      if (p.receiveMaximum !== undefined) properties.receiveMaximum = p.receiveMaximum;
      if (p.maximumPacketSize !== undefined) properties.maximumPacketSize = p.maximumPacketSize;
      if (p.topicAliasMaximum !== undefined) properties.topicAliasMaximum = p.topicAliasMaximum;
      if (p.requestResponseInformation !== undefined) {
        properties.requestResponseInformation = p.requestResponseInformation;
      }
      if (p.requestProblemInformation !== undefined) {
        properties.requestProblemInformation = p.requestProblemInformation;
      }
      if (p.userProperties) properties.userProperties = p.userProperties;
      if (p.authenticationMethod) properties.authenticationMethod = p.authenticationMethod;
      if (resolved.authenticationData !== undefined) {
        properties.authenticationData = decodeBinary(
          resolved.authenticationData,
          p.authenticationDataEncoding
        );
      }
    }
    if (Object.keys(properties).length > 0) opts.properties = properties;
  }

  return opts;
}

/** Test-only export of the option builder. */
export const __buildClientOptionsForTests = buildClientOptions;

/** Shape an inbound PUBLISH for the renderer — binary-safe (MQTT-2). */
function toMessageEvent(topic: string, payload: Buffer, packet: IPublishPacket) {
  const props = packet.properties ?? {};
  const body = encodeBinary(payload);
  const correlation = props.correlationData ? encodeBinary(props.correlationData) : undefined;
  return {
    topic,
    payload: body.value,
    payloadEncoding: body.encoding,
    qos: packet.qos,
    retain: packet.retain ?? false,
    dup: packet.dup ?? false,
    timestamp: Date.now(),
    ...(props.userProperties ? { userProperties: props.userProperties } : {}),
    ...(props.messageExpiryInterval !== undefined
      ? { messageExpiryInterval: props.messageExpiryInterval }
      : {}),
    ...(props.contentType ? { contentType: props.contentType } : {}),
    ...(props.payloadFormatIndicator !== undefined
      ? { payloadFormatIndicator: props.payloadFormatIndicator }
      : {}),
    ...(props.responseTopic ? { responseTopic: props.responseTopic } : {}),
    // MQTT 5 request/response correlation — Binary Data, never UTF-8-mangled.
    ...(correlation
      ? { correlationData: correlation.value, correlationDataEncoding: correlation.encoding }
      : {}),
    // Which subscription matched (MQTT 5 subscription identifier).
    ...(props.subscriptionIdentifier !== undefined
      ? { subscriptionIdentifier: props.subscriptionIdentifier }
      : {}),
  };
}

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

/** Map MQTT 5 publish extras onto mqtt.js publish options. */
function publishProperties(
  cfg: Pick<
    MqttPublishConfig,
    | 'userProperties'
    | 'messageExpiryInterval'
    | 'contentType'
    | 'payloadFormatIndicator'
    | 'topicAlias'
    | 'responseTopic'
    | 'correlationData'
    | 'correlationDataEncoding'
  >
): NonNullable<IClientPublishOptions['properties']> {
  const properties: NonNullable<IClientPublishOptions['properties']> = {};
  if (cfg.userProperties) properties.userProperties = cfg.userProperties;
  if (cfg.messageExpiryInterval !== undefined) {
    properties.messageExpiryInterval = cfg.messageExpiryInterval;
  }
  if (cfg.contentType) properties.contentType = cfg.contentType;
  if (cfg.payloadFormatIndicator !== undefined) {
    properties.payloadFormatIndicator = cfg.payloadFormatIndicator;
  }
  if (cfg.topicAlias !== undefined) properties.topicAlias = cfg.topicAlias;
  if (cfg.responseTopic) properties.responseTopic = cfg.responseTopic;
  if (cfg.correlationData !== undefined) {
    properties.correlationData = decodeBinary(cfg.correlationData, cfg.correlationDataEncoding);
  }
  return properties;
}

/** Names of MQTT 5-only publish fields set on `cfg` (rejected on 3.1.1). */
function v5OnlyPublishFields(cfg: Partial<MqttPublishConfig>): string[] {
  const fields: Array<keyof MqttPublishConfig> = [
    'userProperties',
    'messageExpiryInterval',
    'contentType',
    'payloadFormatIndicator',
    'topicAlias',
    'responseTopic',
    'correlationData',
  ];
  return fields.filter((f) => cfg[f] !== undefined);
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

type MqttRequestOutcome = {
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
async function runMqttRequest(
  entry: ActiveMqtt,
  cfg: MqttRequestConfig
): Promise<MqttRequestOutcome> {
  if (entry.protocolVersion !== 5) {
    return { success: false, error: 'Request/response requires an MQTT 5 connection' };
  }
  if (entry.pendingRequests.has(cfg.requestId)) {
    return { success: false, error: 'Request already in flight' };
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
  const ownsSubscription = !entry.subscriptions.has(responseTopic);
  const isCurrent = (): boolean =>
    activeConnections.get(entry.connectionId, entry.webContentsId) === entry;

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

  try {
    if (ownsSubscription) {
      await subscribeOnce(entry.client, responseTopic, { qos: 1, nl: true });
    }
    if (settled) return outcome;
    const properties = publishProperties({ ...cfg, topicAlias: undefined });
    properties.responseTopic = responseTopic;
    properties.correlationData = correlation;
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
    entry.client.publish(
      cfg.topic,
      decodeBinary(cfg.payload, cfg.payloadEncoding),
      { qos: cfg.qos, retain: cfg.retain, properties },
      (err) => {
        if (err) finish({ success: false, error: errorMessage(err) });
      }
    );
  } catch (err) {
    finish({ success: false, error: errorMessage(err) });
  }

  const result = await outcome;
  if (ownsSubscription && isCurrent() && !entry.subscriptions.has(responseTopic)) {
    entry.client.unsubscribe(responseTopic, () => {});
  }
  return result;
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

    if (activeConnections.size() + pendingConnections.size >= MAX_CONCURRENT_MQTT_CONNECTIONS) {
      logEntry(503, 'Too many open connections');
      return { success: false, error: 'Too many open MQTT connections.' };
    }

    // Reserve synchronously before closing an owner reconnect, inspecting broker
    // credentials, running the guard, or constructing a client.
    const claim = reserveMqttClaim(connectionId, event.sender);
    if (!claim) return { success: false, error: 'Not connected' };
    const key = ownerScopedKey(connectionId, webContentsId);
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
          pendingConnections.get(key)?.token !== claim.token ||
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
          resolved.password = unwrapSecretValueMain(cfg.password);
          if (resolved.password === undefined) {
            throw new Error('Stored MQTT password is missing — re-enter it.');
          }
        }
        const authData = cfg.properties?.authenticationData;
        if (cfg.protocolVersion === 5 && authData !== undefined) {
          resolved.authenticationData = unwrapSecretValueMain(authData);
          if (resolved.authenticationData === undefined) {
            throw new Error('Stored MQTT authentication data is missing — re-enter it.');
          }
        }
        let tls: BrokerTlsOptions | undefined;
        if (cfg.tls) {
          const { passphrase, ...files } = cfg.tls;
          tls = await loadBrokerTlsFiles(files);
          if (passphrase !== undefined) {
            const value = unwrapSecretValueMain(passphrase);
            if (value === undefined) {
              throw new Error('Stored TLS key passphrase is missing — re-enter it.');
            }
            tls.passphrase = value;
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
        if (pendingConnections.get(key)?.token !== claim.token) {
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
      releaseMqttClaim(connectionId, claim);
    }
  });

  ipcMain.handle(
    IPC.mqtt.publish,
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
  );

  ipcMain.handle(
    IPC.mqtt.request,
    createValidatedEventHandler(IPC.mqtt.request, MqttRequestSchema, async (cfg, event) => {
      const entry = activeConnections.getForOwner(cfg.connectionId, event.sender.id);
      if (!entry) return { success: false, error: 'Not connected' };
      return runMqttRequest(entry, cfg);
    })
  );

  ipcMain.handle(
    IPC.mqtt.requestCancel,
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
  );

  ipcMain.handle(
    IPC.mqtt.subscribe,
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
      if (cfg.options?.retainHandling !== undefined) subscribeOpts.rh = cfg.options.retainHandling;
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
            resolve({ success: false, error: `Subscription rejected (reason code ${first.qos})` });
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
  );

  ipcMain.handle(
    IPC.mqtt.unsubscribe,
    createValidatedEventHandler(IPC.mqtt.unsubscribe, MqttUnsubscribeSchema, async (cfg, event) => {
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
    })
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
  pendingConnections.clear();
  for (const entry of activeConnections.values()) {
    await endClient(entry);
  }
  activeConnections.clear();
}
