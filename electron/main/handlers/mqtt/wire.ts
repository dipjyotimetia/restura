/**
 * MQTT wire mapping (main process): IPC config → mqtt.js options, binary-safe
 * payload encoding, and inbound PUBLISH → renderer event. Pure functions — the
 * connection lifecycle stays in `../mqtt-handler.ts`.
 */
import { isUtf8 } from 'node:buffer';
import * as net from 'node:net';
import type { IClientOptions, IClientPublishOptions, IPublishPacket } from 'mqtt';
import type { MqttConnectConfig, MqttPublishConfig } from '../../ipc/ipc-validators';
import type {
  BrokerTlsOptions,
  resolveMqttExecutionPolicy,
} from '../../security/broker-execution-policy';
import { createPinnedLookup, type SafeAddress } from '../../security/safe-connect';

// MQTT.js forwards unknown options through to the underlying tls.connect, but
// its typed `IClientOptions` omits `passphrase`. Widen locally so we can set it.
export type MqttClientOptions = IClientOptions & BrokerTlsOptions & { passphrase?: string };

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

export function buildClientOptions(
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
      // mqtt.js copies only ca/cert/key/pfx/passphrase/rejectUnauthorized into
      // wsOptions, so pass the whole policy TLS (minVersion, ciphers, …) here.
      opts.wsOptions = {
        ...(policyConfig.tls ?? {}),
        lookup: createPinnedLookup(pinned.host, pinned.ip),
      };
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

/** Shape an inbound PUBLISH for the renderer — binary-safe (MQTT-2). */
export function toMessageEvent(topic: string, payload: Buffer, packet: IPublishPacket) {
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

/** Map MQTT 5 publish extras onto mqtt.js publish options. */
export function publishProperties(
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
export function v5OnlyPublishFields(cfg: Partial<MqttPublishConfig>): string[] {
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
