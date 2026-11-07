import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useRequestStore } from '@/store/useRequestStore';
import type { RequestMode } from '@/types';

const { stub } = vi.hoisted(() => ({
  // Plain-text panes: sibling stubs share one parent, so tests match by regex.
  stub: (label: string) => ({ default: () => label }),
}));

vi.mock('@/components/shared/ResizableLayout', () => ({
  default: ({ children, orientation }: { children: ReactNode; orientation: string }) => (
    <div data-testid="split" data-orientation={orientation}>
      {children}
    </div>
  ),
}));
vi.mock('@/components/shared/ResponseViewer', () => ({
  default: ({ protocol }: { protocol?: string }) => (
    <div>{`response viewer ${protocol ?? 'http'}`}</div>
  ),
}));
vi.mock('@/features/http/components/RequestBuilder', () => stub('http builder'));
vi.mock('@/features/grpc/components/GrpcRequestBuilder', () => stub('grpc builder'));
vi.mock('@/features/grpc/components/GrpcResponsePanel', () => stub('grpc response'));
vi.mock('@/features/graphql/components/GraphQLRequestBuilder', () => stub('graphql builder'));
vi.mock('@/features/websocket/components/WebSocketClient', () => stub('websocket client'));
vi.mock('@/features/socketio/components/SocketIOClient', () => stub('socketio client'));
vi.mock('@/features/sse/components/SseClient', () => stub('sse client'));
vi.mock('@/features/mcp/components/McpRequestBuilder', () => stub('mcp builder'));
vi.mock('@/features/mcp/components/McpResultPanel', () => stub('mcp result'));
vi.mock('@/features/kafka/components/KafkaClient', () => stub('kafka client'));
vi.mock('@/features/mqtt/components/MqttClient', () => stub('mqtt client'));

import { RequestWorkspace } from '../RequestWorkspace';

function renderMode(mode: RequestMode) {
  return render(
    <RequestWorkspace mode={mode} orientation="vertical" split={40} onSplitChange={() => {}} />
  );
}

beforeEach(() => {
  // No active tab: the per-tab error boundary has no tab to offer closing.
  useRequestStore.setState((s) => ({ ...s, tabs: [], activeTabId: null }));
});

describe('RequestWorkspace mode routing', () => {
  it.each([
    ['http', ['http builder', 'response viewer http'], true],
    ['grpc', ['grpc builder', 'grpc response'], true],
    ['graphql', ['graphql builder', 'response viewer graphql'], true],
    ['mcp', ['mcp builder', 'mcp result'], true],
    ['websocket', ['websocket client'], false],
    ['socketio', ['socketio client'], false],
    ['sse', ['sse client'], false],
    ['kafka', ['kafka client'], false],
    ['mqtt', ['mqtt client'], false],
  ] as const)('renders the %s workspace', async (mode, panes, split) => {
    renderMode(mode);
    for (const pane of panes) expect(await screen.findByText(new RegExp(pane))).toBeInTheDocument();
    if (split) {
      expect(screen.getByTestId('split')).toHaveAttribute('data-orientation', 'vertical');
    } else {
      expect(screen.queryByTestId('split')).toBeNull();
    }
  });

  it('renders nothing for an unknown persisted mode', () => {
    const { container } = renderMode('carrier-pigeon' as RequestMode);
    expect(container).toBeEmptyDOMElement();
  });
});
