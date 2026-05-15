/**
 * Registers built-in protocol modules with the singleton ProtocolRegistry.
 *
 * Imported once for side effects from the app entry (`src/main.tsx`). Other
 * modules consume the populated registry via `protocolRegistry` from
 * `./registry`. Keep this file's import graph minimal — anything pulled in
 * here lands in the initial bundle, before React mounts.
 *
 * Tasks 4.4/4.5 will start migrating builders/executors to read from the
 * registry. Until then the registry is populated but unused at runtime, so
 * this bootstrap is a no-op for end users.
 */
import { protocolRegistry } from './registry';
import { httpProtocol } from '@/features/http/protocol';
import { grpcProtocol } from '@/features/grpc/protocol';
import { graphqlProtocol } from '@/features/graphql/protocol';
import { mcpProtocol } from '@/features/mcp/protocol';
import { sseProtocol } from '@/features/sse/protocol';
import { websocketProtocol } from '@/features/websocket/protocol';
import { kafkaProtocol } from '@/features/kafka/protocol';

protocolRegistry.register(httpProtocol);
protocolRegistry.register(grpcProtocol);
protocolRegistry.register(graphqlProtocol);
protocolRegistry.register(mcpProtocol);
protocolRegistry.register(sseProtocol);
protocolRegistry.register(websocketProtocol);
protocolRegistry.register(kafkaProtocol);
