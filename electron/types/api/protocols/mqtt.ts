// MQTT — desktop-only pub/sub over mqtt:// (TCP), mqtts:// (TLS) and MQTT over
// WebSocket (ws:// / wss://).
import type { SecretValue } from '@shared/secrets/secret-ref';

export type MqttProtocolVersion = 4 | 5; // 4 = MQTT 3.1.1, 5 = MQTT 5.0
export type MqttQoS = 0 | 1 | 2;
/** How a binary field crosses IPC: UTF-8 text, or base64 for arbitrary bytes. */
export type MqttBinaryEncoding = 'utf8' | 'base64';
export type MqttUserProperties = Record<string, string | string[]>;

export interface MqttTlsIpc {
  /** Inline PEM (programmatic callers). The renderer sends paths instead. */
  ca?: string;
  cert?: string;
  key?: string;
  /** TLS files are read in main (never in the renderer). */
  caPath?: string;
  certPath?: string;
  keyPath?: string;
  /** `{ kind: 'handle', id }` — resolved in main (ADR-0007). */
  passphrase?: SecretValue;
  rejectUnauthorized?: boolean;
}

/** MQTT 5.0 Will Properties (§3.1.3.2). Ignored on 3.1.1. */
export interface MqttWillPropertiesIpc {
  willDelayInterval?: number;
  payloadFormatIndicator?: boolean;
  messageExpiryInterval?: number;
  contentType?: string;
  responseTopic?: string;
  correlationData?: string;
  correlationDataEncoding?: MqttBinaryEncoding;
  userProperties?: MqttUserProperties;
}

export interface MqttLwtIpc {
  topic: string;
  payload: string;
  payloadEncoding?: MqttBinaryEncoding;
  qos: MqttQoS;
  retain: boolean;
  properties?: MqttWillPropertiesIpc;
}

/** MQTT 5.0 CONNECT Properties (§3.1.2.11). */
export interface MqttConnectPropertiesIpc {
  receiveMaximum?: number;
  maximumPacketSize?: number;
  topicAliasMaximum?: number;
  requestResponseInformation?: boolean;
  requestProblemInformation?: boolean;
  userProperties?: MqttUserProperties;
  authenticationMethod?: string;
  /** Inline text/base64, or a `{ kind: 'handle', id }` resolved in main. */
  authenticationData?: SecretValue;
  authenticationDataEncoding?: MqttBinaryEncoding;
}

export interface MqttConnectIpc {
  connectionId: string;
  brokerUrl: string;
  protocolVersion: MqttProtocolVersion;
  /** Empty on v5 + Clean Start → the broker assigns one (see CONNECTED event). */
  clientId: string;
  keepalive: number;
  cleanStart: boolean;
  connectTimeout?: number;
  autoReconnect: boolean;
  username?: string;
  /** `{ kind: 'handle', id }` — resolved in main (ADR-0007). */
  password?: SecretValue;
  tls?: MqttTlsIpc;
  lwt?: MqttLwtIpc;
  sessionExpiryInterval?: number;
  properties?: MqttConnectPropertiesIpc;
}

/** Payload of the CONNECTED event (CONNACK). */
export interface MqttConnectedEvent {
  timestamp: number;
  sessionPresent: boolean;
  reasonCode?: number;
  /** MQTT 5 — the client id the broker assigned to an empty CONNECT client id. */
  assignedClientIdentifier?: string;
  /** MQTT 5 — highest Topic Alias the broker accepts (0/absent = none). */
  topicAliasMaximum?: number;
  serverKeepAlive?: number;
  receiveMaximum?: number;
  maximumQoS?: number;
  retainAvailable?: boolean;
  responseInformation?: string;
  reasonString?: string;
}

/** Payload of the DISCONNECTED event — a broker-initiated MQTT 5 DISCONNECT. */
export interface MqttServerDisconnectEvent {
  timestamp: number;
  reasonCode: number;
  reasonString?: string;
  serverReference?: string;
}

/** Payload of the MESSAGE event — an inbound PUBLISH. */
export interface MqttMessageEvent {
  topic: string;
  payload: string;
  payloadEncoding: MqttBinaryEncoding;
  qos: MqttQoS;
  retain: boolean;
  dup: boolean;
  timestamp: number;
  userProperties?: MqttUserProperties;
  messageExpiryInterval?: number;
  contentType?: string;
  payloadFormatIndicator?: boolean;
  responseTopic?: string;
  correlationData?: string;
  correlationDataEncoding?: MqttBinaryEncoding;
  subscriptionIdentifier?: number | number[];
}

export interface MqttPublishIpc {
  connectionId: string;
  topic: string;
  payload: string;
  payloadEncoding?: MqttBinaryEncoding;
  qos: MqttQoS;
  retain: boolean;
  userProperties?: MqttUserProperties;
  messageExpiryInterval?: number;
  contentType?: string;
  payloadFormatIndicator?: boolean;
  topicAlias?: number;
  responseTopic?: string;
  correlationData?: string;
  correlationDataEncoding?: MqttBinaryEncoding;
}

export interface MqttPublishAck {
  topic: string;
  qos: MqttQoS;
  packetId?: number;
  reasonCode?: number;
  timestamp: number;
}

export interface MqttSubscribeIpc {
  connectionId: string;
  topicFilter: string;
  qos: MqttQoS;
  /** MQTT 5 Subscription Options (§3.8.3.1). */
  options?: { noLocal?: boolean; retainAsPublished?: boolean; retainHandling?: 0 | 1 | 2 };
  /** MQTT 5 Subscription Identifier (1..268435455). */
  subscriptionIdentifier?: number;
}

/** MQTT 5 request/response (§4.10). */
export interface MqttRequestIpc
  extends Omit<MqttPublishIpc, 'topicAlias' | 'responseTopic' | 'correlationData'> {
  requestId: string;
  /** Generated as `restura/resp/<clientId>/<uuid>` when omitted. */
  responseTopic?: string;
  /** 16 random bytes when omitted. */
  correlationData?: string;
  timeoutMs: number;
}

export interface MqttRequestResult {
  success: boolean;
  error?: string;
  /** True when no matching reply arrived within `timeoutMs`. */
  timedOut?: boolean;
  /** True when the request was cancelled or the connection closed. */
  cancelled?: boolean;
  responseTopic?: string;
  /** Correlation bytes actually sent (base64). */
  correlationData?: string;
  response?: MqttMessageEvent;
  latencyMs?: number;
}

export interface ElectronMqttAPI {
  connect: (config: MqttConnectIpc) => Promise<{ success: boolean; error?: string }>;
  publish: (
    config: MqttPublishIpc
  ) => Promise<{ success: boolean; ack?: MqttPublishAck; error?: string }>;
  subscribe: (config: MqttSubscribeIpc) => Promise<{ success: boolean; error?: string }>;
  unsubscribe: (config: {
    connectionId: string;
    topicFilter: string;
  }) => Promise<{ success: boolean; error?: string }>;
  disconnect: (config: { connectionId: string }) => Promise<{ success: boolean }>;
  request: (config: MqttRequestIpc) => Promise<MqttRequestResult>;
  cancelRequest: (config: {
    connectionId: string;
    requestId: string;
  }) => Promise<{ success: boolean }>;
  on: (channel: string, callback: (...args: unknown[]) => void) => void;
  removeListener: (channel: string, callback: (...args: unknown[]) => void) => void;
  removeAllListeners: (channel: string) => void;
}
