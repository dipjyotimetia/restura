import ResizableLayout from '@/components/shared/ResizableLayout';
import ResponseViewer from '@/components/shared/ResponseViewer';
import RequestBuilder from '@/features/http/components/RequestBuilder';
import { lazyComponent } from '@/lib/shared/lazyComponent';
import type { RequestMode } from '@/types';

// HTTP is the default mode and remains eager. Each alternate protocol stays
// behind its own dynamic import so its client and transitive dependencies load
// only after a user selects that workspace mode.
const GrpcRequestBuilder = lazyComponent(
  () => import('@/features/grpc/components/GrpcRequestBuilder')
);
const GrpcResponsePanel = lazyComponent(
  () => import('@/features/grpc/components/GrpcResponsePanel')
);
const GraphQLRequestBuilder = lazyComponent(
  () => import('@/features/graphql/components/GraphQLRequestBuilder')
);
const WebSocketClient = lazyComponent(
  () => import('@/features/websocket/components/WebSocketClient')
);
const SocketIOClient = lazyComponent(() => import('@/features/socketio/components/SocketIOClient'));
const SseClient = lazyComponent(() => import('@/features/sse/components/SseClient'));
const McpRequestBuilder = lazyComponent(
  () => import('@/features/mcp/components/McpRequestBuilder')
);
const McpResultPanel = lazyComponent(() => import('@/features/mcp/components/McpResultPanel'));
const KafkaClient = lazyComponent(() => import('@/features/kafka/components/KafkaClient'));
const MqttClient = lazyComponent(() => import('@/features/mqtt/components/MqttClient'));

interface RequestWorkspaceProps {
  mode: RequestMode;
  orientation: 'horizontal' | 'vertical';
  split: number;
  onSplitChange: (split: number) => void;
}

export function RequestWorkspace({
  mode,
  orientation,
  split,
  onSplitChange,
}: RequestWorkspaceProps) {
  const splitProps = { orientation, split, onSplitChange };

  switch (mode) {
    case 'http':
      return (
        <ResizableLayout {...splitProps}>
          <RequestBuilder />
          <ResponseViewer />
        </ResizableLayout>
      );
    case 'grpc':
      return (
        <ResizableLayout {...splitProps}>
          <GrpcRequestBuilder />
          <GrpcResponsePanel />
        </ResizableLayout>
      );
    case 'graphql':
      return (
        <ResizableLayout {...splitProps}>
          <GraphQLRequestBuilder />
          <ResponseViewer />
        </ResizableLayout>
      );
    case 'websocket':
      return <WebSocketClient />;
    case 'socketio':
      return <SocketIOClient />;
    case 'sse':
      return <SseClient />;
    case 'mcp':
      return (
        <ResizableLayout {...splitProps}>
          <McpRequestBuilder />
          <McpResultPanel />
        </ResizableLayout>
      );
    case 'kafka':
      return <KafkaClient />;
    case 'mqtt':
      return <MqttClient />;
    default:
      return null;
  }
}
