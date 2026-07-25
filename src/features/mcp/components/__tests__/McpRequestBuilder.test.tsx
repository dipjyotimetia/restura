import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpConnection } from '@/features/mcp/store/useMcpStore';
import type { McpServerCapabilities, McpToolDescriptor } from '@/types';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return {
    promise,
    resolve: (value) => resolve?.(value),
  };
}

const clientMocks = vi.hoisted(() => ({
  connectResults: [] as Array<Promise<{ ok: true } | { ok: false; error: string }>>,
  discoveryResults: [] as Array<Promise<McpServerCapabilities | { error: string }>>,
  instances: [] as Array<{
    connectionId: string;
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    discoverCapabilities: ReturnType<typeof vi.fn>;
    callTool: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock('@/features/mcp/lib/mcpClient', () => ({
  McpClient: class {
    connectionId: string;
    connect = vi.fn(
      () => clientMocks.connectResults.shift() ?? Promise.resolve({ ok: true as const })
    );
    disconnect = vi.fn(() => Promise.resolve());
    discoverCapabilities = vi.fn(
      () =>
        clientMocks.discoveryResults.shift() ??
        Promise.resolve({ tools: [], resources: [], prompts: [] })
    );
    callTool = vi.fn(() => Promise.resolve({ ok: true, result: {}, durationMs: 1 }));

    constructor(options: { connectionId: string }) {
      this.connectionId = options.connectionId;
      clientMocks.instances.push(this);
    }
  },
}));

vi.mock('@/features/mcp/components/McpConnectionPanel', () => ({
  McpConnectionPanel: ({
    connection,
    onConnect,
    onDisconnect,
    onRefresh,
    onToggleCatalog,
  }: {
    connection: McpConnection;
    onConnect: () => Promise<void>;
    onDisconnect: () => Promise<void>;
    onRefresh: () => Promise<void>;
    onToggleCatalog: () => void;
  }) => (
    <div>
      <span>{`${connection.id}:${connection.status}`}</span>
      <button type="button" onClick={() => void onConnect()}>
        Connect
      </button>
      <button type="button" onClick={() => void onRefresh()}>
        Refresh
      </button>
      <button type="button" onClick={() => void onDisconnect()}>
        Disconnect
      </button>
      <button type="button" onClick={onToggleCatalog}>
        Browse tools
      </button>
    </div>
  ),
}));

vi.mock('@/features/mcp/components/McpDiscoveryPanel', () => ({
  McpDiscoveryPanel: ({
    tools,
    onToolSelect,
  }: {
    tools: McpToolDescriptor[];
    onToolSelect: (name: string) => void;
  }) => (
    <button
      type="button"
      disabled={!tools[0]}
      onClick={() => {
        const tool = tools[0];
        if (tool) onToolSelect(tool.name);
      }}
    >
      Choose first tool
    </button>
  ),
}));

vi.mock('@/features/mcp/components/McpInvokeForm', () => ({
  McpInvokeForm: ({
    tool,
    onCall,
  }: {
    tool: McpToolDescriptor | null;
    onCall: (tool: McpToolDescriptor, args: Record<string, unknown>) => Promise<void>;
  }) => (
    <button
      type="button"
      disabled={!tool}
      onClick={() => {
        if (tool) void onCall(tool, {});
      }}
    >
      Invoke current tool
    </button>
  ),
}));

import McpRequestBuilder from '@/features/mcp/components/McpRequestBuilder';
import { useMcpStore } from '@/features/mcp/store/useMcpStore';

const FIRST_CAPABILITIES: McpServerCapabilities = {
  tools: [{ name: 'first-tool' }],
  resources: [],
  prompts: [],
};

const REFRESHED_CAPABILITIES: McpServerCapabilities = {
  tools: [{ name: 'late-tool' }],
  resources: [],
  prompts: [],
};

function connection(id: string): McpConnection {
  return {
    id,
    url: `https://${id}.example.com/mcp`,
    transport: 'streamable-http',
    headers: [],
    status: 'disconnected',
    capabilities: null,
    log: [],
    createdAt: 1,
  };
}

describe('McpRequestBuilder client ownership', () => {
  beforeEach(() => {
    clientMocks.connectResults.length = 0;
    clientMocks.discoveryResults.length = 0;
    clientMocks.instances.length = 0;
    useMcpStore.setState({
      connections: {
        first: connection('first'),
        second: connection('second'),
      },
      activeConnectionId: 'first',
    });
  });

  it('clears a switched connection and ignores its late refresh completion', async () => {
    const lateRefresh = deferred<McpServerCapabilities>();
    clientMocks.discoveryResults.push(Promise.resolve(FIRST_CAPABILITIES), lateRefresh.promise);
    render(<McpRequestBuilder />);

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => {
      expect(useMcpStore.getState().connections.first).toMatchObject({
        status: 'connected',
        capabilities: FIRST_CAPABILITIES,
      });
    });

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => {
      expect(clientMocks.instances[0]?.discoverCapabilities).toHaveBeenCalledTimes(2);
    });

    act(() => {
      useMcpStore.getState().setActiveConnection('second');
    });

    expect(useMcpStore.getState().connections.first).toMatchObject({
      status: 'disconnected',
      capabilities: null,
    });
    expect(clientMocks.instances[0]?.disconnect).toHaveBeenCalledTimes(1);

    await act(async () => {
      lateRefresh.resolve(REFRESHED_CAPABILITIES);
      await lateRefresh.promise;
    });

    expect(useMcpStore.getState().connections.first).toMatchObject({
      status: 'disconnected',
      capabilities: null,
    });
  });

  it('requires the remounted connection to reconnect before invoking with a current client', async () => {
    clientMocks.discoveryResults.push(
      Promise.resolve(FIRST_CAPABILITIES),
      Promise.resolve(FIRST_CAPABILITIES)
    );
    const firstRender = render(<McpRequestBuilder />);

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => {
      expect(useMcpStore.getState().connections.first?.status).toBe('connected');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Browse tools' }));
    fireEvent.click(screen.getByRole('button', { name: 'Choose first tool' }));
    expect(screen.getByRole('button', { name: 'Invoke current tool' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Invoke current tool' }));
    expect(clientMocks.instances[0]?.callTool).toHaveBeenCalledTimes(1);

    firstRender.unmount();

    expect(useMcpStore.getState().connections.first).toMatchObject({
      status: 'disconnected',
      capabilities: null,
    });
    expect(clientMocks.instances[0]?.disconnect).toHaveBeenCalledTimes(1);

    render(<McpRequestBuilder />);
    fireEvent.click(screen.getByRole('button', { name: 'Browse tools' }));
    expect(screen.getByRole('button', { name: 'Choose first tool' })).toBeDisabled();
    const invoke = screen.getByRole('button', { name: 'Invoke current tool' });
    expect(invoke).toBeDisabled();
    fireEvent.click(invoke);
    expect(clientMocks.instances[0]?.callTool).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => {
      expect(useMcpStore.getState().connections.first?.status).toBe('connected');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Choose first tool' }));
    expect(screen.getByRole('button', { name: 'Invoke current tool' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Invoke current tool' }));

    expect(clientMocks.instances[0]?.callTool).toHaveBeenCalledTimes(1);
    expect(clientMocks.instances[1]?.connectionId).toBe('first');
    expect(clientMocks.instances[1]?.callTool).toHaveBeenCalledTimes(1);
  });
});
