/**
 * MQTT protocol module — metadata-only registration.
 *
 * MQTT is connection-based (a long-lived pub/sub client over a raw TCP/TLS
 * socket). There is no `Request` shape for it in the type system — connections
 * live in `useMqttStore` and message flow goes through `mqttManager` over
 * Electron IPC. Web builds disable the mode at the UI layer (browsers cannot
 * open raw TCP sockets).
 *
 * Both `defaultRequest` and `runRequest` throw to point callers at the proper
 * API (`MqttClient` + `mqttManager`). Mirrors the kafka stub.
 */
import type { ProtocolModule } from '@/features/registry/types';

export const mqttProtocol: ProtocolModule = {
  id: 'mqtt',
  label: 'MQTT',
  tabType: 'mqtt',
  defaultRequest: () => {
    throw new Error('MQTT has no Request shape; create a connection via useMqttStore.');
  },
  runRequest: async () => {
    throw new Error(
      'MQTT is connection-based; use MqttClient + mqttManager, not the registry runner.'
    );
  },
};
