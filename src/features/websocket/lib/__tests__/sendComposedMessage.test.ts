import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWebSocketStore } from '@/features/websocket/store/useWebSocketStore';
import type { StreamingVariableScope } from '@/lib/shared/streaming/messageVariables';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useRequestStore } from '@/store/useRequestStore';
import {
  sendComposedWebSocketMessage,
  sendFormatToTemplateFormat,
  templateFormatToSendFormat,
} from '../sendComposedMessage';
import { websocketManager } from '../websocketManager';

const scope: StreamingVariableScope = {
  values: { userId: '42', token: 'top-secret', hi: '48 69' },
  secretNames: new Set(['token']),
  handleNames: new Set(),
};

describe('sendComposedWebSocketMessage', () => {
  let connectionId: string;
  let send: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    connectionId = useWebSocketStore.getState().createConnection();
    send = vi.spyOn(websocketManager, 'send').mockReturnValue(true);
  });

  afterEach(() => {
    useWebSocketStore.getState().removeConnection(connectionId);
    vi.restoreAllMocks();
  });

  const systemMessages = () =>
    (useWebSocketStore.getState().connections[connectionId]?.messages ?? [])
      .filter((m) => m.type === 'system')
      .map((m) => m.content);

  it('ignores blank input', () => {
    expect(sendComposedWebSocketMessage(connectionId, '   ', 'text', scope)).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('resolves text variables before sending, without a display override', () => {
    expect(sendComposedWebSocketMessage(connectionId, '{"id":"{{userId}}"}', 'json', scope)).toBe(
      true
    );
    expect(send).toHaveBeenCalledWith(connectionId, '{"id":"42"}', {});
    expect(systemMessages()).toEqual([]);
  });

  it('masks secret values in the transcript copy', () => {
    sendComposedWebSocketMessage(connectionId, 'auth {{token}}', 'text', scope);
    expect(send).toHaveBeenCalledWith(connectionId, 'auth top-secret', { display: 'auth ••••••' });
  });

  it('warns about unresolved variables and still sends them literally', () => {
    sendComposedWebSocketMessage(connectionId, 'x {{nope}}', 'text', scope);
    expect(send).toHaveBeenCalledWith(connectionId, 'x {{nope}}', {});
    expect(systemMessages()).toEqual(['Unresolved variables sent literally: {{nope}}']);
  });

  it('resolves hex mode before parsing the bytes', () => {
    sendComposedWebSocketMessage(connectionId, '{{hi}} 21', 'binary', scope);
    const [, buffer] = send.mock.calls[0] as [string, ArrayBuffer];
    expect([...new Uint8Array(buffer)]).toEqual([0x48, 0x69, 0x21]);
  });

  it('reports invalid hex without sending', () => {
    vi.spyOn(websocketManager, 'hexToArrayBuffer').mockImplementation(() => {
      throw new Error('bad');
    });
    expect(sendComposedWebSocketMessage(connectionId, 'zz {{token}}', 'binary', scope)).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(systemMessages()[0]).toContain('Invalid hex format: "zz ••••••"');
  });
});

describe('websocketManager.send display override', () => {
  it('logs the display copy while sending the wire text', () => {
    const connectionId = useWebSocketStore.getState().createConnection();
    const wsSend = vi.fn();
    const sockets = (websocketManager as unknown as { connections: Map<string, unknown> })
      .connections;
    sockets.set(connectionId, { readyState: WebSocket.OPEN, send: wsSend });
    try {
      websocketManager.send(connectionId, 'secret-wire', { display: 'masked' });
      expect(wsSend).toHaveBeenCalledWith('secret-wire');
      const messages = useWebSocketStore.getState().connections[connectionId]?.messages ?? [];
      expect(messages.at(-1)?.content).toBe('masked');
    } finally {
      sockets.delete(connectionId);
      useWebSocketStore.getState().removeConnection(connectionId);
    }
  });
});

describe('format mapping', () => {
  it('maps hex <-> binary and passes the rest through', () => {
    expect(templateFormatToSendFormat('hex')).toBe('binary');
    expect(templateFormatToSendFormat('json')).toBe('json');
    expect(sendFormatToTemplateFormat('binary')).toBe('hex');
    expect(sendFormatToTemplateFormat('text')).toBe('text');
  });
});

describe('sendComposedWebSocketMessage with the live variable scopes', () => {
  afterEach(() => {
    useEnvironmentStore.setState({ environments: [], activeEnvironmentId: null });
    useCollectionStore.setState({ collections: [] });
    useRequestStore.setState({ tabs: [], activeTabId: null });
    vi.restoreAllMocks();
  });

  it('resolves environment and collection variables like the HTTP send path', () => {
    useEnvironmentStore.setState({
      environments: [
        {
          id: 'env',
          name: 'E',
          variables: [
            { id: '1', key: 'room', value: 'lobby', enabled: true },
            { id: '2', key: 'apiKey', value: 'k-123', enabled: true, secret: true },
          ],
        },
      ],
      activeEnvironmentId: 'env',
    });
    useCollectionStore.setState({
      collections: [
        {
          id: 'c1',
          name: 'C',
          items: [
            {
              id: 'item-1',
              name: 'R',
              type: 'request',
              request: {
                id: 'req',
                name: 'R',
                type: 'http',
                method: 'GET',
                url: '',
                headers: [],
                params: [],
                body: { type: 'none' },
                auth: { type: 'none' },
              },
            },
          ],
          variables: [{ id: 'cv', key: 'user', value: 'ann', enabled: true }],
        },
      ],
    });
    useRequestStore.getState().openTab(
      {
        id: 'req',
        name: 'R',
        type: 'http',
        method: 'GET',
        url: '',
        headers: [],
        params: [],
        body: { type: 'none' },
        auth: { type: 'none' },
      },
      { savedRequestId: 'item-1' }
    );
    const connectionId = useWebSocketStore.getState().createConnection();
    const send = vi.spyOn(websocketManager, 'send').mockReturnValue(true);

    sendComposedWebSocketMessage(connectionId, '{{room}}:{{user}}:{{apiKey}}', 'text');

    expect(send).toHaveBeenCalledWith(connectionId, 'lobby:ann:k-123', {
      display: 'lobby:ann:••••••',
    });
    useWebSocketStore.getState().removeConnection(connectionId);
  });
});
