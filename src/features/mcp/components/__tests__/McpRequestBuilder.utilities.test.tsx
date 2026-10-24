import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpConnection } from '@/features/mcp/store/useMcpStore';
import type { McpServerCapabilities } from '@/types';

const mocks = vi.hoisted(() => ({
  caps: undefined as unknown,
  client: undefined as undefined | Record<string, ReturnType<typeof vi.fn>>,
}));

vi.mock('@/features/mcp/lib/mcpClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/mcp/lib/mcpClient')>();
  return {
    ...actual,
    McpClient: class {
      connect = vi.fn(() => Promise.resolve({ ok: true as const }));
      disconnect = vi.fn(() => Promise.resolve());
      discoverCapabilities = vi.fn(() => Promise.resolve(mocks.caps));
      readResource = vi.fn(() => Promise.resolve({ ok: true, result: {}, durationMs: 1 }));
      ping = vi.fn(() => Promise.resolve({ ok: true, result: {}, durationMs: 12 }));
      setLogLevel = vi.fn(() => Promise.resolve({ ok: true, result: {}, durationMs: 3 }));
      complete = vi.fn(() => Promise.resolve(['alpha']));
      constructor() {
        mocks.client = this as unknown as Record<string, ReturnType<typeof vi.fn>>;
      }
    },
  };
});

vi.mock('@/features/mcp/components/McpConnectionPanel', () => ({
  McpConnectionPanel: ({
    onConnect,
    onToggleCatalog,
  }: {
    onConnect: () => Promise<void>;
    onToggleCatalog: () => void;
  }) => (
    <div>
      <button type="button" onClick={() => void onConnect()}>
        Connect
      </button>
      <button type="button" onClick={onToggleCatalog}>
        Browse
      </button>
    </div>
  ),
}));

import McpRequestBuilder from '@/features/mcp/components/McpRequestBuilder';
import { useMcpStore } from '@/features/mcp/store/useMcpStore';
import { useRequestStore } from '@/store/useRequestStore';

const connection: McpConnection = {
  id: 'c1',
  url: 'https://c1.example.com/mcp',
  transport: 'streamable-http',
  headers: [],
  status: 'disconnected',
  capabilities: null,
  log: [],
  createdAt: 1,
};

function setup(caps: McpServerCapabilities) {
  mocks.caps = caps;
  mocks.client = undefined;
  useMcpStore.setState({ connections: { c1: connection }, activeConnectionId: 'c1' });
  useRequestStore.setState({ tabs: [], activeTabId: null, isLoading: false });
  const tabId = useRequestStore.getState().createNewRequest('mcp');
  useRequestStore.getState().updateRequestForTab(tabId, { url: connection.url });
  render(<McpRequestBuilder />);
}

async function connect() {
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
  await waitFor(() => expect(useMcpStore.getState().connections.c1?.status).toBe('connected'));
  fireEvent.click(screen.getByRole('button', { name: 'Browse' }));
}

describe('McpRequestBuilder utilities wiring', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads a template with substituted params and completes via ref/resource', async () => {
    setup({
      capabilities: { resources: {}, completions: {} },
      tools: [],
      resources: [],
      prompts: [],
      resourceTemplates: [{ uriTemplate: 'users://{id}', name: 'User' }],
    });
    await connect();
    fireEvent.click(screen.getByRole('tab', { name: /templates/i }));
    fireEvent.click(screen.getByText('User'));
    const input = screen.getByPlaceholderText('string');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'a b' } });
    await waitFor(() =>
      expect(mocks.client?.complete).toHaveBeenCalledWith(
        { type: 'ref/resource', uri: 'users://{id}' },
        { name: 'id', value: 'a b' },
        {}
      )
    );
    fireEvent.click(screen.getByRole('button', { name: /read/i }));
    await waitFor(() => expect(mocks.client?.readResource).toHaveBeenCalledWith('users://a%20b'));
  });

  it('hides the Templates tab and log picker when the server lacks the capabilities', async () => {
    setup({
      capabilities: { tools: {} },
      tools: [],
      resources: [],
      prompts: [],
    });
    await connect();
    expect(screen.queryByRole('tab', { name: /templates/i })).toBeNull();
    expect(screen.queryByLabelText('Log level')).toBeNull();
  });

  it('pings and sets the log level when logging is advertised', async () => {
    setup({
      capabilities: { logging: {} },
      tools: [],
      resources: [],
      prompts: [],
    });
    await connect();
    fireEvent.click(screen.getByRole('button', { name: /ping/i }));
    expect((await screen.findByRole('status')).textContent).toBe('12 ms');
    fireEvent.change(screen.getByLabelText('Log level'), { target: { value: 'error' } });
    await waitFor(() => expect(mocks.client?.setLogLevel).toHaveBeenCalledWith('error'));
    expect(
      useMcpStore
        .getState()
        .connections.c1?.log.map((l) => l.method)
        .sort()
    ).toEqual(['logging/setLevel', 'ping']);
  });
});
