import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest } from '@/types';

const manager = vi.hoisted(() => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  send: vi.fn(),
  hexToArrayBuffer: vi.fn(),
}));
vi.mock('@/features/websocket/lib/websocketManager', () => ({ websocketManager: manager }));

import WebSocketClient from '@/features/websocket/components/WebSocketClient';
import { useWebSocketStore } from '@/features/websocket/store/useWebSocketStore';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useGlobalsStore } from '@/store/useGlobalsStore';
import { useRequestStore } from '@/store/useRequestStore';

function openTabInCollection() {
  const request: HttpRequest = {
    id: 'req-1',
    name: 'WS',
    type: 'http',
    method: 'GET',
    url: 'https://x',
    headers: [],
    params: [],
    body: { type: 'none' },
    auth: { type: 'none' },
  };
  useCollectionStore.setState({
    collections: [
      {
        id: 'c1',
        name: 'Col',
        variables: [{ id: 'cv', key: 'host', value: 'col.example.com', enabled: true }],
        items: [
          {
            id: 'f1',
            name: 'F',
            type: 'folder',
            variables: [{ id: 'fv', key: 'folderTok', value: 'ft', enabled: true }],
            items: [{ id: 'req-1', name: 'WS', type: 'request', request }],
          },
        ],
      },
    ],
  });
  const tabId = useRequestStore.getState().openTab(request, { savedRequestId: 'req-1' });
  const connectionId = useWebSocketStore.getState().ensureConnectionForTab(tabId);
  return connectionId;
}

describe('WebSocketClient connect', () => {
  beforeEach(() => {
    manager.connect.mockReset();
    useEnvironmentStore.setState({ environments: [], activeEnvironmentId: null });
    useGlobalsStore.setState({ vars: {} });
    useCollectionStore.setState({ collections: [] });
    useRequestStore.setState({ tabs: [], activeTabId: null, isLoading: false });
  });

  it('resolves collection and folder variables in the url and handshake headers', async () => {
    const connectionId = openTabInCollection();
    useWebSocketStore.getState().updateConnectionUrl(connectionId, 'wss://{{host}}/ws');
    useWebSocketStore
      .getState()
      .setHeaders(connectionId, [{ id: 'h', key: 'X-Tok', value: '{{folderTok}}', enabled: true }]);
    render(<WebSocketClient />);
    await userEvent.click(await screen.findByRole('button', { name: 'Connect' }));
    expect(manager.connect).toHaveBeenCalledWith(
      connectionId,
      'wss://col.example.com/ws',
      undefined,
      { 'X-Tok': 'ft' }
    );
    // The stored template is untouched.
    expect(useWebSocketStore.getState().connections[connectionId]?.headers[0]?.value).toBe(
      '{{folderTok}}'
    );
  });

  it('refuses to connect when a variable cannot be resolved', async () => {
    const connectionId = openTabInCollection();
    useWebSocketStore.getState().updateConnectionUrl(connectionId, 'wss://{{host}}/ws');
    const original = useEnvironmentStore.getState().resolveVariables;
    useEnvironmentStore.setState({
      resolveVariables: () => {
        throw new Error('boom');
      },
    });
    try {
      render(<WebSocketClient />);
      await userEvent.click(await screen.findByRole('button', { name: 'Connect' }));
    } finally {
      useEnvironmentStore.setState({ resolveVariables: original });
    }
    expect(manager.connect).not.toHaveBeenCalled();
    expect(
      useWebSocketStore
        .getState()
        .connections[connectionId]?.messages.map((m) => m.content)
        .join()
    ).toContain('boom');
  });
});
