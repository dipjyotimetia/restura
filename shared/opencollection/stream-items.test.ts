import { describe, expect, it } from 'vitest';
import type { CollectionItem, SocketIoRequest, WebSocketRequest } from '../types';
import {
  applyWebSocketExtension,
  buildWebSocketExtension,
  materializeLegacySocketIo,
  SOCKETIO_EXTENSION_KEY,
  socketIoEntryToInternal,
  socketIoToOC,
  webSocketFromOC,
  webSocketToOC,
} from './stream-items';

/** Edge cases of the OpenCollection WebSocket / Socket.IO mapping (#1209). */

const ws = (over: Partial<WebSocketRequest> = {}): WebSocketRequest => ({
  id: 'w',
  name: 'W',
  type: 'websocket',
  url: 'wss://x',
  protocols: [],
  headers: [],
  message: { body: '', format: 'text' },
  templates: [],
  ...over,
});

const wsItem = (name: string, r: WebSocketRequest): CollectionItem => ({
  id: `i-${name}-${Math.random()}`,
  name,
  type: 'request',
  request: r,
});

describe('webSocketToOC / webSocketFromOC', () => {
  it('omits the message for an empty draft and writes a lone draft as a single message', () => {
    expect(webSocketToOC('W', ws())).toEqual({
      info: { type: 'websocket', name: 'W' },
      websocket: { url: 'wss://x' },
    });
    expect(
      webSocketToOC('W', ws({ message: { body: 'ab', format: 'hex' }, description: 'd' }))
    ).toEqual({
      info: { type: 'websocket', name: 'W', description: 'd' },
      websocket: { url: 'wss://x', message: { type: 'binary', data: 'ab' } },
    });
  });

  it('imports variants (selected → draft), single messages and defaults', () => {
    const r = webSocketFromOC({
      info: { type: 'websocket', description: { content: 'doc', type: 'text/markdown' } },
      websocket: {
        message: [
          { message: { type: 'xml', data: '<a/>' } },
          { title: 'B', selected: true, message: { type: 'binary', data: '00' } },
        ],
      },
    });
    expect(r).toMatchObject({
      name: 'WebSocket',
      url: '',
      description: 'doc',
      message: { body: '00', format: 'hex' },
      templates: [
        { name: 'Message 1', body: '<a/>', format: 'text' },
        { name: 'B', body: '00', format: 'hex' },
      ],
    });
    const single = webSocketFromOC({
      info: { name: 'S' },
      websocket: { url: 'wss://s', message: { type: 'json', data: '{}' } },
    });
    expect(single.message).toEqual({ body: '{}', format: 'json' });
    expect(single.description).toBeUndefined();
    expect(webSocketFromOC({}).templates).toEqual([]);
  });
});

describe('x-restura-websocket', () => {
  it('is undefined when no WebSocket item carries Restura-only fields', () => {
    expect(buildWebSocketExtension(undefined)).toBeUndefined();
    expect(buildWebSocketExtension([wsItem('W', ws())])).toBeUndefined();
  });

  it('indexes same-path duplicates and re-applies them positionally', () => {
    const a = ws({ protocols: ['a'] });
    const b = ws({
      protocols: ['b'],
      options: { heartbeatInterval: 5 },
      templates: [{ name: 'T', body: 't', format: 'text' }],
      message: { body: 'draft', format: 'json' },
      frameAssertion: { enabled: false, script: 's' },
    });
    const items: CollectionItem[] = [
      { id: 'f', name: 'F', type: 'folder', items: [wsItem('Dup', a), wsItem('Dup', b)] },
    ];
    const ext = buildWebSocketExtension(items);
    expect(ext?.requests).toEqual([
      { path: ['F', 'Dup'], protocols: ['a'] },
      {
        path: ['F', 'Dup'],
        index: 1,
        protocols: ['b'],
        message: { body: 'draft', format: 'json' },
        options: { heartbeatInterval: 5 },
        frameAssertion: { enabled: false, script: 's' },
      },
    ]);
    const fresh = [ws(), ws()];
    const target: CollectionItem[] = [
      {
        id: 'f',
        name: 'F',
        type: 'folder',
        items: fresh.map((r) => wsItem('Dup', r)),
      },
    ];
    applyWebSocketExtension(target, ext);
    expect(fresh[0]?.protocols).toEqual(['a']);
    expect(fresh[1]).toMatchObject({
      protocols: ['b'],
      message: { body: 'draft', format: 'json' },
      options: { heartbeatInterval: 5 },
      frameAssertion: { enabled: false, script: 's' },
    });
  });

  it('ignores malformed entries and values', () => {
    const r = ws();
    const items = [wsItem('W', r)];
    applyWebSocketExtension(items, undefined);
    applyWebSocketExtension(items, { requests: 'nope' });
    applyWebSocketExtension(items, {
      requests: [
        null,
        { path: 'W' },
        { path: [1] },
        { path: ['Missing'] },
        {
          path: ['W'],
          protocols: [1, 'p'],
          message: { body: 3, format: 'weird' },
          options: { heartbeatInterval: -1, maxReconnectAttempts: 'x', autoReconnect: 'y' },
          frameAssertion: { enabled: 'yes' },
        },
        { path: ['W'], protocols: ['claimed-twice'] },
      ],
    });
    expect(r.protocols).toEqual(['p']);
    expect(r.message).toEqual({ body: '', format: 'text' });
    expect(r.options).toBeUndefined();
    expect(r.frameAssertion).toBeUndefined();
  });
});

describe('x-restura-socketio entries', () => {
  it('fills defaults for a bare entry and drops invalid values', () => {
    const r = socketIoEntryToInternal({
      socketio: {
        namespace: '',
        path: '',
        transports: ['carrier-pigeon'],
        auth: { token: 'a', n: 1, b: true, nested: { x: 1 } },
        query: 'nope',
        templates: [{ eventName: 'e', args: '1', ack: 'yes' }],
        options: { timeout: -5, forceNew: 'no', reconnectionDelay: 2.7 },
      },
    });
    expect(r).toMatchObject({
      name: 'Socket.IO',
      url: '',
      namespace: '/',
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      query: [],
      subscribedEvents: [],
      emit: { eventName: '', args: '', ack: false },
      templates: [{ name: 'Emit', eventName: 'e', args: '1', ack: false }],
      options: { reconnectionDelay: 2 },
    });
    expect(r.handshakeAuth.map((a) => [a.key, a.value])).toEqual([
      ['token', 'a'],
      ['n', '1'],
      ['b', 'true'],
    ]);
    expect(socketIoEntryToInternal({}).options).toBeUndefined();
  });

  it('writes only the populated lists', () => {
    const r: SocketIoRequest = {
      id: 's',
      name: 'S',
      type: 'socketio',
      url: 'https://x',
      namespace: '/',
      path: '/socket.io',
      handshakeAuth: [],
      query: [],
      headers: [],
      transports: ['polling'],
      subscribedEvents: [],
      emit: { eventName: 'm', args: '', ack: false },
      templates: [],
    };
    expect(socketIoToOC('S', r)).toEqual({
      info: { type: 'socketio', name: 'S' },
      socketio: {
        url: 'https://x',
        namespace: '/',
        path: '/socket.io',
        transports: ['polling'],
        emit: { eventName: 'm', args: '', ack: false },
      },
    });
    expect(socketIoToOC('S', { ...r, options: {} })).not.toHaveProperty('socketio.options');
  });
});

describe('materializeLegacySocketIo', () => {
  it('leaves a collection without the legacy list untouched', () => {
    const c = { items: [] as CollectionItem[] };
    expect(materializeLegacySocketIo(c)).toBe(c);
    const withOc = { items: [] as CollectionItem[], _oc: { extensions: { 'x-a': 1 } } };
    expect(materializeLegacySocketIo(withOc)).toBe(withOc);
  });

  it('places entries by folderPath (unresolvable → root) without mutating the input', () => {
    const items: CollectionItem[] = [{ id: 'f', name: 'F', type: 'folder' }];
    const c = {
      items,
      _oc: {
        extensions: {
          [SOCKETIO_EXTENSION_KEY]: [
            { info: { name: 'In' }, folderPath: ['F'] },
            { info: { name: 'Lost' }, folderPath: ['F', 'Nope'] },
            'garbage',
          ],
        },
      },
    };
    const out = materializeLegacySocketIo(c);
    expect(out.items[0]?.items?.map((i) => i.name)).toEqual(['In']);
    expect(out.items.slice(1).map((i) => i.name)).toEqual(['Lost', 'Socket.IO']);
    expect(items[0]?.items).toBeUndefined();
    expect((out as { _oc: { extensions: object } })._oc.extensions).toEqual({});
  });
});
