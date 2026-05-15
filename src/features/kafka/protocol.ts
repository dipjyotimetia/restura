/**
 * Kafka protocol module — metadata-only registration.
 *
 * Kafka is connection-based (long-lived producer + optional consumer over a
 * binary TCP wire). There is no `Request` shape for it in the type system —
 * connections live in `useKafkaStore` and message flow goes through
 * `kafkaManager` over Electron IPC. Web builds disable the mode at the UI
 * layer (Cloudflare Workers can't run `@platformatic/kafka`).
 *
 * Both `defaultRequest` and `runRequest` throw to point callers at the
 * proper API (`KafkaClient` + `kafkaManager`). Mirrors the websocket stub.
 */
import type { ProtocolModule } from '@/features/registry/types';

export const kafkaProtocol: ProtocolModule = {
  id: 'kafka',
  label: 'Kafka',
  tabType: 'kafka',
  defaultRequest: () => {
    throw new Error(
      'Kafka has no Request shape; create a connection via useKafkaStore.'
    );
  },
  runRequest: async () => {
    throw new Error(
      'Kafka is connection-based; use KafkaClient + kafkaManager, not the registry runner.'
    );
  },
};
