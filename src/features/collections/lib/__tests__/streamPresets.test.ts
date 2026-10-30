import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSocketIOStore } from '@/features/socketio/store/useSocketIOStore';
import { useWebSocketStore } from '@/features/websocket/store/useWebSocketStore';
import { PROTOCOL_LABELS } from '@/lib/shared/constants';
import {
  getSocketIoComposerDraft,
  getWebSocketComposerDraft,
  setSocketIoComposerDraft,
  setWebSocketComposerDraft,
} from '@/lib/shared/streaming/composerDrafts';
import { collectionSchema } from '@/lib/shared/validations';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useRequestStore } from '@/store/useRequestStore';
import type { Collection, CollectionItem, SocketIoRequest, WebSocketRequest } from '@/types';
import { exportBrunoCollection } from '../bruno-exporter';
import { saveToCollectionBlockedReason } from '../collectable';
import { buildDocModel } from '../docGenerator';
import { exportToInsomnia, exportToPostmanV21, getCollectionExportWarnings } from '../exporters';
import { flattenRunnables, skippedConnectionPresets } from '../flattenRunnables';
import { validateImportedCollection } from '../importers';
import { openCollectionItem } from '../openCollectionItem';
import { isConnectionPresetTab, saveTabBackToCollection } from '../saveBack';
import { snapshotStreamTab } from '../streamPresets';

/** WebSocket / Socket.IO connections as collection items (#1209). */

const toastError = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { error: toastError, warning: vi.fn() } }));

const kv = (key: string, value: string) => ({ id: `kv-${key}`, key, value, enabled: true });

const WS: WebSocketRequest = {
  id: 'ws-req',
  name: 'Feed',
  type: 'websocket',
  url: 'wss://{{host}}/feed',
  protocols: ['json'],
  headers: [kv('X-Trace', '{{trace}}')],
  message: { body: '{"sub":"{{topic}}"}', format: 'json' },
  templates: [{ name: 'Ping', body: 'ping', format: 'text' }],
  options: { autoReconnect: false, maxReconnectAttempts: 2, reconnectDelay: 900 },
  frameAssertion: { enabled: true, script: 'rs.test("x", () => {})' },
};

const SIO: SocketIoRequest = {
  id: 'sio-req',
  name: 'Chat',
  type: 'socketio',
  url: 'https://chat.example.com',
  namespace: '/rooms',
  path: '/io',
  handshakeAuth: [kv('token', '{{token}}')],
  query: [kv('v', '2')],
  headers: [kv('X-Client', 'r')],
  transports: ['websocket'],
  subscribedEvents: ['message'],
  emit: { eventName: 'say', args: '"{{greeting}}"', ack: true },
  templates: [{ name: 'Join', eventName: 'join', args: '"lobby"', ack: false }],
  options: { timeout: 5000, forceNew: true },
};

const item = (request: WebSocketRequest | SocketIoRequest, id = `item-${request.id}`) =>
  ({ id, name: request.name, type: 'request', request }) as CollectionItem;

beforeEach(() => {
  toastError.mockClear();
  useRequestStore.setState({ tabs: [], activeTabId: null, isLoading: false });
  useWebSocketStore.setState({ connections: {}, activeConnectionId: null, connectionByTabId: {} });
  useSocketIOStore.setState({ connections: {}, activeConnectionId: null, connectionByTabId: {} });
  useCollectionStore.setState({ collections: [] });
});

describe('opening a saved WebSocket / Socket.IO item', () => {
  it('seeds a linked WebSocket tab (modeOverride) with the saved connection and draft', () => {
    expect(openCollectionItem(item(WS))).toBe(true);
    const tab = useRequestStore.getState().tabs[0]!;
    expect(tab).toMatchObject({ modeOverride: 'websocket', savedRequestId: 'item-ws-req' });
    expect(tab.request.name).toBe('Feed');
    const connectionId = useWebSocketStore.getState().connectionByTabId[tab.id]!;
    const conn = useWebSocketStore.getState().connections[connectionId]!;
    expect(conn).toMatchObject({
      url: 'wss://{{host}}/feed',
      protocols: ['json'],
      autoReconnect: false,
      maxReconnectAttempts: 2,
      reconnectDelay: 900,
      frameAssertion: { enabled: true },
    });
    expect(conn.headers.map((h) => [h.key, h.value])).toEqual([['X-Trace', '{{trace}}']]);
    expect(conn.templates.map((t) => t.name)).toEqual(['Ping']);
    expect(getWebSocketComposerDraft(connectionId)).toEqual(WS.message);
    // A second open focuses the linked tab instead of opening another.
    expect(openCollectionItem(item(WS))).toBe(true);
    expect(useRequestStore.getState().tabs).toHaveLength(1);
  });

  it('seeds a linked Socket.IO tab, mapping handshakeAuth / headers onto the store fields', () => {
    openCollectionItem(item(SIO));
    const tab = useRequestStore.getState().tabs[0]!;
    expect(tab.modeOverride).toBe('socketio');
    const connectionId = useSocketIOStore.getState().connectionByTabId[tab.id]!;
    const conn = useSocketIOStore.getState().connections[connectionId]!;
    expect(conn).toMatchObject({
      url: 'https://chat.example.com',
      namespace: '/rooms',
      path: '/io',
      transports: ['websocket'],
      subscribedEvents: ['message'],
      timeout: 5000,
      forceNew: true,
    });
    expect(conn.auth.map((r) => r.key)).toEqual(['token']);
    expect(conn.extraHeaders.map((r) => r.key)).toEqual(['X-Client']);
    expect(getSocketIoComposerDraft(connectionId)).toEqual(SIO.emit);
  });
});

describe('saving a WebSocket / Socket.IO tab to a collection', () => {
  it('is no longer blocked and snapshots the live connection + draft (unresolved)', () => {
    expect(saveToCollectionBlockedReason({ modeOverride: 'websocket' })).toBeNull();
    expect(saveToCollectionBlockedReason({ modeOverride: 'socketio' })).toBeNull();
    const tabId = useRequestStore.getState().openTabWithMode('websocket');
    expect(snapshotStreamTab({ id: tabId, modeOverride: 'websocket' }, 'W')).toBeNull();
    const connectionId = useWebSocketStore
      .getState()
      .ensureConnectionForTab(tabId, 'wss://x/{{p}}');
    setWebSocketComposerDraft(connectionId, { body: 'hi {{name}}', format: 'text' });
    const snap = snapshotStreamTab({ id: tabId, modeOverride: 'websocket' }, 'W', 'fixed-id')!;
    expect(snap).toMatchObject({
      id: 'fixed-id',
      name: 'W',
      type: 'websocket',
      url: 'wss://x/{{p}}',
      message: { body: 'hi {{name}}', format: 'text' },
    });
    expect(collectionSchema.safeParse({ id: 'c', name: 'C', items: [item(snap)] }).success).toBe(
      true
    );

    const sioTab = useRequestStore.getState().openTabWithMode('socketio');
    const sioConn = useSocketIOStore.getState().ensureConnectionForTab(sioTab);
    setSocketIoComposerDraft(sioConn, { eventName: 'e', args: '[1]', ack: false });
    const sio = snapshotStreamTab({ id: sioTab, modeOverride: 'socketio' }, 'S')!;
    expect(sio).toMatchObject({ type: 'socketio', emit: { eventName: 'e', args: '[1]' } });
  });

  it('save-back re-snapshots a linked tab and refuses a placeholder overwrite', () => {
    useCollectionStore.getState().addCollection({ id: 'c', name: 'C', items: [item(WS, 'i')] });
    openCollectionItem(useCollectionStore.getState().collections[0]!.items[0]!);
    const tab = useRequestStore.getState().tabs[0]!;
    expect(isConnectionPresetTab(tab)).toBe(true);
    const connectionId = useWebSocketStore.getState().connectionByTabId[tab.id]!;
    useWebSocketStore.getState().updateConnectionUrl(connectionId, 'wss://new/{{x}}');

    // Without the tab (or from another mode) the HTTP placeholder never overwrites it.
    expect(saveTabBackToCollection({ ...tab.request, name: 'Feed' }, 'i')).toBe(false);
    expect(toastError).toHaveBeenCalled();

    expect(saveTabBackToCollection({ ...tab.request, name: 'Feed 2' }, 'i', tab)).toBe(true);
    const saved = useCollectionStore.getState().collections[0]!.items[0]!;
    expect(saved.name).toBe('Feed 2');
    expect(saved.request).toMatchObject({
      id: 'ws-req',
      type: 'websocket',
      url: 'wss://new/{{x}}',
    });
  });
});

describe('runner, docs, validation and exporters', () => {
  const collection: Collection = {
    id: 'c',
    name: 'Live',
    items: [
      item(WS),
      { id: 'f', name: 'F', type: 'folder', items: [item(SIO)] },
      {
        id: 'h',
        name: 'Health',
        type: 'request',
        request: {
          id: 'h',
          name: 'Health',
          type: 'http',
          method: 'GET',
          url: 'https://x',
          headers: [],
          params: [],
          body: { type: 'none' },
          auth: { type: 'none' },
        },
      },
    ],
  };

  it('the runner skips them with a reported reason (never silently)', () => {
    expect(flattenRunnables(collection.items).map((r) => r.name)).toEqual(['Health']);
    expect(skippedConnectionPresets(collection.items)).toEqual(['Feed', 'Chat']);
    expect(skippedConnectionPresets(collection.items, 'f')).toEqual(['Chat']);
  });

  it('validates on import; docs leave them out', () => {
    expect(validateImportedCollection(collection)).toEqual({ ok: true });
    const bad = { ...collection, items: [item({ ...WS, templates: 'x' } as never)] };
    expect(validateImportedCollection(bad).ok).toBe(false);
    expect(buildDocModel(collection).operations).toHaveLength(1);
  });

  it('v2.1 drops them with a report; Insomnia / Bruno emit named stubs and warn', async () => {
    const postman = exportToPostmanV21(collection);
    expect(
      postman.report.entries
        .filter((e) => e.construct === 'non-http-request')
        .map((e) => e.itemName)
    ).toEqual(['Feed', 'Chat']);
    expect(JSON.stringify(exportToInsomnia(collection))).toContain(
      'Feed [WEBSOCKET — not supported in Insomnia]'
    );
    expect(getCollectionExportWarnings(collection, 'insomnia')).toEqual(
      expect.arrayContaining([
        'WEBSOCKET requests are exported as non-runnable stubs',
        'SOCKETIO requests are exported as non-runnable stubs',
      ])
    );
    const bruno = await exportBrunoCollection(collection);
    expect(bruno.warnings.map((w) => w.kind)).toEqual(['non-http-request', 'non-http-request']);
  });

  it('the sidebar has a badge label for both kinds', () => {
    expect(PROTOCOL_LABELS.websocket).toBe('WS');
    expect(PROTOCOL_LABELS.socketio).toBe('SIO');
  });
});
