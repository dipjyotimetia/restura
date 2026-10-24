import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpConnection } from '@/features/mcp/store/useMcpStore';
import {
  type FakeMcpBridge,
  installFakeMcpBridge,
} from '../../../../../tests/helpers/fakeMcpBridge';

/**
 * #858 / #872 end-to-end through the real builder + real McpClient (Electron
 * branch) against a fake preload bridge: listeners attach before connect,
 * upstream close flips status with a reason, list_changed re-discovers,
 * subscriptions toggle over IPC, and nothing leaks on disconnect/unmount.
 */

vi.mock('@/features/mcp/components/McpConnectionPanel', () => ({
  McpConnectionPanel: ({
    connection,
    onConnect,
    onDisconnect,
    onToggleCatalog,
    onRefresh,
  }: {
    connection: McpConnection;
    onConnect: () => Promise<void>;
    onDisconnect: () => Promise<void>;
    onToggleCatalog: () => void;
    onRefresh: () => Promise<void>;
  }) => (
    <div>
      <output aria-label="status">{connection.status}</output>
      <output aria-label="last error">{connection.lastError ?? ''}</output>
      <button type="button" onClick={() => void onConnect()}>
        Connect
      </button>
      <button type="button" onClick={() => void onDisconnect()}>
        Disconnect
      </button>
      <button type="button" onClick={() => void onRefresh()}>
        Refresh
      </button>
      <button type="button" onClick={onToggleCatalog}>
        Browse
      </button>
    </div>
  ),
}));

import McpRequestBuilder from '@/features/mcp/components/McpRequestBuilder';
import { useMcpNotificationStore } from '@/features/mcp/store/useMcpNotificationStore';
import { useMcpStore } from '@/features/mcp/store/useMcpStore';
import { useRequestStore } from '@/store/useRequestStore';

let bridge: FakeMcpBridge;
let toolNames: string[];
let listenersAtConnect: number;

// Only the #858/#872 server-event channels; other hooks (client requests, #860) add their own.
const SERVER_EVENT_PREFIXES = ['mcp:close:', 'mcp:error:', 'mcp:notification:'];
function serverEventListenerCount() {
  return SERVER_EVENT_PREFIXES.reduce((n, prefix) => n + bridge.listenerCount(prefix), 0);
}

function serverRequest(config: { method: string; params?: unknown }) {
  switch (config.method) {
    case 'initialize':
      return {
        success: true,
        result: {
          protocolVersion: '2025-11-25',
          capabilities: { tools: { listChanged: true }, resources: { subscribe: true } },
          serverInfo: { name: 'fake', version: '1' },
        },
      };
    case 'tools/list':
      return { success: true, result: { tools: toolNames.map((name) => ({ name })) } };
    case 'resources/list':
      return { success: true, result: { resources: [{ uri: 'a://1', name: 'one' }] } };
    case 'resources/subscribe':
    case 'resources/unsubscribe':
      return { success: true, result: {} };
    default:
      return { success: true, result: {} };
  }
}

function connectionId(): string {
  const id = useMcpStore.getState().activeConnectionId;
  if (!id) throw new Error('no active connection');
  return id;
}

async function connect() {
  const view = render(<McpRequestBuilder />);
  fireEvent.click(await screen.findByRole('button', { name: 'Connect' }));
  await waitFor(() => expect(screen.getByLabelText('status')).toHaveTextContent('connected'));
  fireEvent.click(screen.getByRole('button', { name: 'Browse' }));
  return view;
}

beforeEach(() => {
  toolNames = ['first'];
  listenersAtConnect = -1;
  bridge = installFakeMcpBridge();
  bridge.mcp.connect.mockImplementation(async () => {
    listenersAtConnect = serverEventListenerCount();
    return { success: true };
  });
  bridge.mcp.request.mockImplementation(async (config: { method: string }) =>
    serverRequest(config)
  );
  useMcpStore.setState({ connections: {}, activeConnectionId: null });
  useMcpNotificationStore.setState({ entries: {}, subscriptions: {} });
  useRequestStore.setState({ tabs: [], activeTabId: null, isLoading: false });
  useRequestStore.getState().createNewRequest('mcp');
  useRequestStore.getState().updateRequest({ url: 'https://mcp.example.com/mcp' });
});

afterEach(() => {
  bridge.uninstall();
});

describe('McpRequestBuilder server events (desktop)', () => {
  it('subscribes to the event channels before connect', async () => {
    await connect();
    expect(listenersAtConnect).toBe(3);
    expect(
      bridge.channels().filter((c) => SERVER_EVENT_PREFIXES.some((p) => c.startsWith(p)))
    ).toEqual([
      `mcp:close:${connectionId()}`,
      `mcp:error:${connectionId()}`,
      `mcp:notification:${connectionId()}`,
    ]);
  });

  it('shows notifications in the Events tab', async () => {
    await connect();
    act(() =>
      bridge.emit(`mcp:notification:${connectionId()}`, {
        method: 'notifications/message',
        params: { level: 'info', data: 'server says hi' },
      })
    );
    fireEvent.click(screen.getByRole('tab', { name: /events/i }));
    expect(await screen.findByText('server says hi')).toBeInTheDocument();
  });

  it('re-discovers when the server reports tools/list_changed', async () => {
    await connect();
    expect(useMcpStore.getState().connections[connectionId()]?.capabilities?.tools).toEqual([
      { name: 'first' },
    ]);

    toolNames = ['first', 'second'];
    act(() =>
      bridge.emit(`mcp:notification:${connectionId()}`, {
        method: 'notifications/tools/list_changed',
      })
    );

    await waitFor(() =>
      expect(useMcpStore.getState().connections[connectionId()]?.capabilities?.tools).toEqual([
        { name: 'first' },
        { name: 'second' },
      ])
    );
    expect(screen.getByLabelText('status')).toHaveTextContent('connected');
  });

  it('flips status to error with the reason on upstream close and drops listeners', async () => {
    await connect();
    act(() => {
      bridge.emit(`mcp:error:${connectionId()}`, { message: 'socket hang up' });
      bridge.emit(`mcp:close:${connectionId()}`, { reason: 'stream ended' });
    });

    expect(screen.getByLabelText('status')).toHaveTextContent('error');
    expect(screen.getByLabelText('last error')).toHaveTextContent(
      'Connection closed: socket hang up'
    );
    expect(bridge.listenerCount()).toBe(0);
  });

  it('keeps delivering server events after a manual Refresh', async () => {
    await connect();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.getByLabelText('status')).toHaveTextContent('connected'));
    act(() => bridge.emit(`mcp:close:${connectionId()}`, { reason: 'stream ended' }));
    expect(screen.getByLabelText('status')).toHaveTextContent('error');
  });

  it('reports a clean server close as the reason', async () => {
    await connect();
    act(() => bridge.emit(`mcp:close:${connectionId()}`, { reason: 'stream ended' }));
    expect(screen.getByLabelText('last error')).toHaveTextContent(
      'Server closed the connection (stream ended)'
    );
  });

  it('subscribes and unsubscribes a resource over IPC', async () => {
    await connect();
    fireEvent.click(screen.getByRole('tab', { name: /resources/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Subscribe to a://1' }));

    await waitFor(() =>
      expect(useMcpNotificationStore.getState().subscriptions[connectionId()]).toEqual(['a://1'])
    );
    expect(bridge.mcp.request).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'resources/subscribe', params: { uri: 'a://1' } })
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Unsubscribe from a://1' }));
    await waitFor(() =>
      expect(useMcpNotificationStore.getState().subscriptions[connectionId()]).toEqual([])
    );
  });

  it('records a failed subscribe in the Events tab and leaves the toggle off', async () => {
    await connect();
    bridge.mcp.request.mockImplementation(async (config: { method: string }) =>
      config.method === 'resources/subscribe'
        ? { success: false, error: 'Server declined the subscription to a://1' }
        : serverRequest(config)
    );
    fireEvent.click(screen.getByRole('tab', { name: /resources/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Subscribe to a://1' }));

    await waitFor(() =>
      expect(useMcpNotificationStore.getState().entries[connectionId()]?.[0]?.summary).toBe(
        'Subscribe failed: Server declined the subscription to a://1'
      )
    );
    expect(useMcpNotificationStore.getState().subscriptions[connectionId()] ?? []).toEqual([]);
  });

  it('removes listeners and subscriptions on disconnect', async () => {
    await connect();
    useMcpNotificationStore.getState().setSubscribed(connectionId(), 'a://1', true);
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(bridge.mcp.disconnect).toHaveBeenCalled());
    expect(bridge.listenerCount()).toBe(0);
    expect(useMcpNotificationStore.getState().subscriptions[connectionId()]).toEqual([]);
  });

  it('removes listeners on unmount (no leak)', async () => {
    const view = await connect();
    const id = connectionId();
    useMcpNotificationStore.getState().setSubscribed(id, 'a://1', true);
    expect(serverEventListenerCount()).toBe(3);

    view.unmount();

    expect(bridge.listenerCount()).toBe(0);
    expect(useMcpNotificationStore.getState().subscriptions[id]).toEqual([]);
  });

  it('removes listeners when the active connection switches away', async () => {
    await connect();
    act(() => {
      useMcpStore.getState().setActiveConnection(null);
    });
    expect(bridge.listenerCount()).toBe(0);
  });

  it('removes listeners when a failed connect aborts', async () => {
    bridge.mcp.connect.mockImplementation(async () => ({ success: false, error: 'refused' }));
    render(<McpRequestBuilder />);
    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(screen.getByLabelText('status')).toHaveTextContent('error'));
    expect(bridge.listenerCount()).toBe(0);
  });
});
