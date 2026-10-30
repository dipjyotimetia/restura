import { describe, expect, it, vi } from 'vitest';

/**
 * Desktop keychain handle conversion (`convertCollectionSecretsToHandles`) on
 * WebSocket / Socket.IO items (#1209). The items carry no `auth: AuthConfig`
 * (Socket.IO's handshake payload is `handshakeAuth`, deliberately not `auth`),
 * so the generic `'auth' in request` walk must leave them intact, while a
 * Postman bag-only WebSocket auth in `_postman` is still converted.
 */
describe('convertCollectionSecretsToHandles on WebSocket / Socket.IO items', () => {
  it('converts the bag-only Postman auth and leaves the typed items untouched', async () => {
    vi.resetModules();
    let n = 0;
    const store = vi.fn(async () => ({ ok: true as const, id: `h-${++n}` }));
    vi.doMock('@/lib/shared/platform', () => ({
      isElectron: () => true,
      getElectronAPI: () => ({ secrets: { store } }),
    }));
    const { convertCollectionSecretsToHandles } = await import('@/lib/shared/secretRef-migrations');
    const ws = {
      id: 'ws',
      name: 'Feed',
      type: 'websocket',
      url: 'wss://x',
      protocols: [],
      headers: [],
      message: { body: '', format: 'text' },
      templates: [],
    };
    const sio = {
      id: 'sio',
      name: 'Chat',
      type: 'socketio',
      url: 'https://x',
      namespace: '/',
      path: '/socket.io',
      handshakeAuth: [{ id: 'a', key: 'token', value: 'keep-shape', enabled: true }],
      query: [],
      headers: [],
      transports: ['websocket', 'polling'],
      subscribedEvents: [],
      emit: { eventName: 'message', args: '', ack: false },
      templates: [],
    };
    const collection = {
      id: 'c',
      name: 'Col',
      items: [
        {
          id: 'i1',
          type: 'request' as const,
          name: 'Feed',
          request: ws,
          _postman: {
            auth: { type: 'bearer', bearer: [{ key: 'token', value: 'WS-PLAIN' }] },
            authBagOnly: true,
          },
        },
        { id: 'i2', type: 'request' as const, name: 'Chat', request: sio },
      ],
    };
    const out = await convertCollectionSecretsToHandles(collection as never);
    expect(JSON.stringify(out)).not.toContain('WS-PLAIN');
    expect(store).toHaveBeenCalled();
    expect(out.items[0]?.request).toEqual(ws);
    expect(out.items[1]?.request).toEqual(sio);
    vi.doUnmock('@/lib/shared/platform');
  });
});
