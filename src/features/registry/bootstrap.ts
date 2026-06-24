/**
 * Registers built-in protocol modules with the singleton ProtocolRegistry.
 *
 * Imported once for side effects from the app entry (`src/main.tsx`). Other
 * modules consume the populated registry via `protocolRegistry` from
 * `./registry` (e.g. the collection and workflow runners dispatch through it).
 * Keep this file's import graph minimal — anything pulled in here lands in the
 * initial bundle, before React mounts.
 */
import { protocolRegistry } from './registry';
import { graphqlProtocol } from '@/features/graphql/protocol';
import { grpcProtocol } from '@/features/grpc/protocol';
import { httpProtocol } from '@/features/http/protocol';
import { kafkaProtocol } from '@/features/kafka/protocol';
import { mcpProtocol } from '@/features/mcp/protocol';
import { mqttProtocol } from '@/features/mqtt/protocol';
import { socketioProtocol } from '@/features/socketio/protocol';
import { sseProtocol } from '@/features/sse/protocol';
import { websocketProtocol } from '@/features/websocket/protocol';

protocolRegistry.register(httpProtocol);
protocolRegistry.register(grpcProtocol);
protocolRegistry.register(graphqlProtocol);
protocolRegistry.register(mcpProtocol);
protocolRegistry.register(sseProtocol);
protocolRegistry.register(websocketProtocol);
protocolRegistry.register(kafkaProtocol);
protocolRegistry.register(mqttProtocol);
protocolRegistry.register(socketioProtocol);
