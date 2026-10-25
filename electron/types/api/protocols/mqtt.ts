// MQTT — desktop-only pub/sub over mqtt:// (TCP) / mqtts:// (TLS).
export type MqttProtocolVersion = 4 | 5; // 4 = MQTT 3.1.1, 5 = MQTT 5.0
export type MqttQoS = 0 | 1 | 2;

export interface MqttTlsIpc {
  ca?: string;
  cert?: string;
  key?: string;
  passphrase?: string;
  rejectUnauthorized?: boolean;
}

export interface MqttLwtIpc {
  topic: string;
  payload: string;
  qos: MqttQoS;
  retain: boolean;
}

export interface MqttConnectIpc {
  connectionId: string;
  brokerUrl: string;
  protocolVersion: MqttProtocolVersion;
  clientId: string;
  keepalive: number;
  cleanStart: boolean;
  connectTimeout?: number;
  autoReconnect: boolean;
  username?: string;
  password?: string;
  tls?: MqttTlsIpc;
  lwt?: MqttLwtIpc;
  sessionExpiryInterval?: number;
}

export interface MqttPublishIpc {
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
}

export interface MqttPublishAck {
  topic: string;
  qos: MqttQoS;
  packetId?: number;
  reasonCode?: number;
  timestamp: number;
}

export interface ElectronMqttAPI {
  connect: (config: MqttConnectIpc) => Promise<{ success: boolean; error?: string }>;
  publish: (
    config: MqttPublishIpc
  ) => Promise<{ success: boolean; ack?: MqttPublishAck; error?: string }>;
  subscribe: (config: {
    connectionId: string;
    topicFilter: string;
    qos: MqttQoS;
  }) => Promise<{ success: boolean; error?: string }>;
  unsubscribe: (config: {
    connectionId: string;
    topicFilter: string;
  }) => Promise<{ success: boolean; error?: string }>;
  disconnect: (config: { connectionId: string }) => Promise<{ success: boolean }>;
  on: (channel: string, callback: (...args: unknown[]) => void) => void;
  removeListener: (channel: string, callback: (...args: unknown[]) => void) => void;
  removeAllListeners: (channel: string) => void;
}
