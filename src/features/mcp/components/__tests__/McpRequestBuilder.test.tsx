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
    readResource: ReturnType<typeof vi.fn>;
    getPrompt: ReturnType<typeof vi.fn>;
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
    readResource = vi.fn(() => Promise.resolve({ ok: true, result: {}, durationMs: 1 }));
    getPrompt = vi.fn(() => Promise.resolve({ ok: true, result: {}, durationMs: 1 }));

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
    onUrlChange,
    onTransportChange,
    onAddHeader,
    onUpdateHeader,
    onRemoveHeader,
  }: {
    connection: McpConnection;
    onConnect: () => Promise<void>;
    onDisconnect: () => Promise<void>;
    onRefresh: () => Promise<void>;
    onToggleCatalog: () => void;
    onUrlChange: (value: string) => void;
    onTransportChange: (value: McpConnection['transport']) => void;
    onAddHeader: () => void;
    onUpdateHeader: (id: string, updates: { key?: string; value?: string }) => void;
    onRemoveHeader: (id: string) => void;
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
      <button type="button" onClick={() => onUrlChange('https://changed.example/mcp')}>
        Change URL
      </button>
      <button type="button" onClick={() => onTransportChange('http-sse')}>
        Change transport
      </button>
      <button type="button" onClick={onAddHeader}>
        Add header
      </button>
      <button type="button" onClick={() => onUpdateHeader('header-1', { value: 'changed' })}>
        Update header
      </button>
      <button type="button" onClick={() => onRemoveHeader('header-1')}>
        Remove header
      </button>
    </div>
  ),
}));

vi.mock('@/features/mcp/components/McpDiscoveryPanel', () => ({
  McpDiscoveryPanel: ({
    tools,
    onToolSelect,
    prompts,
    onPromptSelect,
    onReadResource,
    onClearLog,
    onHide,
    onTabChange,
  }: {
    tools: McpToolDescriptor[];
    onToolSelect: (name: string) => void;
    prompts: Array<{ name: string }>;
    onPromptSelect: (name: string) => void;
    onReadResource: (uri: string) => Promise<void>;
    onClearLog: () => void;
    onHide: () => void;
    onTabChange: (tab: 'tools' | 'resources' | 'prompts' | 'log') => void;
  }) => (
    <div>
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
      <button
        type="button"
        disabled={!prompts[0]}
        onClick={() => prompts[0] && onPromptSelect(prompts[0].name)}
      >
        Choose first prompt
      </button>
      <button type="button" onClick={() => void onReadResource('resource://first')}>
        Read resource
      </button>
      <button type="button" onClick={onClearLog}>
        Clear log
      </button>
      <button type="button" onClick={onHide}>
        Hide catalog
      </button>
      <button type="button" onClick={() => onTabChange('prompts')}>
        Show prompts
      </button>
    </div>
  ),
}));

vi.mock('@/features/mcp/components/McpInvokeForm', () => ({
  McpInvokeForm: ({
    tool,
    onCall,
    prompt,
    onGet,
  }: {
    tool: McpToolDescriptor | null;
    onCall: (tool: McpToolDescriptor, args: Record<string, unknown>) => Promise<void>;
    prompt: { name: string } | null;
    onGet: (prompt: { name: string }, args: Record<string, unknown>) => Promise<void>;
  }) => (
    <div>
      <button
        type="button"
        disabled={!tool}
        onClick={() => {
          if (tool) void onCall(tool, {});
        }}
      >
        Invoke current tool
      </button>
      <button type="button" disabled={!prompt} onClick={() => prompt && void onGet(prompt, {})}>
        Get current prompt
      </button>
    </div>
  ),
}));

import McpRequestBuilder from '@/features/mcp/components/McpRequestBuilder';
import { useMcpStore } from '@/features/mcp/store/useMcpStore';

const FIRST_CAPABILITIES: McpServerCapabilities = {
  tools: [{ name: 'first-tool' }],
  resources: [{ uri: 'resource://first', name: 'First resource' }],
  prompts: [{ name: 'first-prompt' }],
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

  it('disconnects a pending client on switch and ignores its late connect completion', async () => {
    const lateConnect = deferred<{ ok: true }>();
    clientMocks.connectResults.push(lateConnect.promise);
    render(<McpRequestBuilder />);

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => {
      expect(clientMocks.instances[0]?.connect).toHaveBeenCalledTimes(1);
      expect(useMcpStore.getState().connections.first?.status).toBe('connecting');
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
      lateConnect.resolve({ ok: true });
      await lateConnect.promise;
    });

    expect(useMcpStore.getState().connections.first).toMatchObject({
      status: 'disconnected',
      capabilities: null,
    });
    expect(clientMocks.instances[0]?.discoverCapabilities).not.toHaveBeenCalled();
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
    await waitFor(() => {
      expect(clientMocks.instances[0]?.callTool).toHaveBeenCalledTimes(1);
      expect(useMcpStore.getState().connections.first?.log).toHaveLength(1);
    });

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

    await waitFor(() => {
      expect(clientMocks.instances[0]?.callTool).toHaveBeenCalledTimes(1);
      expect(clientMocks.instances[1]?.connectionId).toBe('first');
      expect(clientMocks.instances[1]?.callTool).toHaveBeenCalledTimes(1);
      expect(useMcpStore.getState().connections.first?.log).toHaveLength(1);
    });
  });

  it('records connect/discovery failures and does not refresh without a live session', async () => {
    clientMocks.connectResults.push(Promise.resolve({ ok: false, error: 'connection refused' }));
    render(<McpRequestBuilder />);

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(clientMocks.instances).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => {
      expect(useMcpStore.getState().connections.first).toMatchObject({
        status: 'error',
        lastError: 'connection refused',
      });
    });

    clientMocks.discoveryResults.push(Promise.resolve({ error: 'capability discovery failed' }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => {
      expect(useMcpStore.getState().connections.first).toMatchObject({
        status: 'error',
        lastError: 'capability discovery failed',
      });
    });
  });

  it('refreshes a current session and sends tools, prompts, and resources to its log', async () => {
    clientMocks.discoveryResults.push(
      Promise.resolve(FIRST_CAPABILITIES),
      Promise.resolve(FIRST_CAPABILITIES)
    );
    render(<McpRequestBuilder />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(useMcpStore.getState().connections.first?.status).toBe('connected'));

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() =>
      expect(clientMocks.instances[0]?.discoverCapabilities).toHaveBeenCalledTimes(2)
    );

    fireEvent.click(screen.getByRole('button', { name: 'Browse tools' }));
    fireEvent.click(screen.getByRole('button', { name: 'Choose first tool' }));
    fireEvent.click(screen.getByRole('button', { name: 'Choose first prompt' }));
    fireEvent.click(screen.getByRole('button', { name: 'Invoke current tool' }));
    fireEvent.click(screen.getByRole('button', { name: 'Get current prompt' }));
    fireEvent.click(screen.getByRole('button', { name: 'Read resource' }));
    await waitFor(() => expect(useMcpStore.getState().connections.first?.log).toHaveLength(3));
    expect(clientMocks.instances[0]?.callTool).toHaveBeenCalledWith('first-tool', {});
    expect(clientMocks.instances[0]?.getPrompt).toHaveBeenCalledWith('first-prompt', {});
    expect(clientMocks.instances[0]?.readResource).toHaveBeenCalledWith('resource://first');

    fireEvent.click(screen.getByRole('button', { name: 'Clear log' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hide catalog' }));
    expect(useMcpStore.getState().connections.first?.log).toEqual([]);
    expect(screen.queryByRole('button', { name: 'Choose first tool' })).toBeNull();
  });

  it('updates connection settings through the panel callbacks before connecting', () => {
    render(<McpRequestBuilder />);
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Change URL' }));
      fireEvent.click(screen.getByRole('button', { name: 'Change transport' }));
      fireEvent.click(screen.getByRole('button', { name: 'Add header' }));
    });
    const headerId = useMcpStore.getState().connections.first?.headers[0]?.id;
    expect(headerId).toBeDefined();
    if (!headerId) throw new Error('Expected header');
    act(() => {
      useMcpStore.getState().updateHeader('first', headerId, { key: 'x-token' });
      fireEvent.click(screen.getByRole('button', { name: 'Remove header' }));
    });

    expect(useMcpStore.getState().connections.first).toMatchObject({
      url: 'https://changed.example/mcp',
      transport: 'http-sse',
      headers: [{ id: headerId, key: 'x-token' }],
    });
  });
});
