import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import {
  countCollectionInlineSecrets,
  redactCollectionSecrets,
} from '../../secrets/collection-redaction';
import type { Collection, CollectionItem, SocketIoRequest, WebSocketRequest } from '../../types';
import { exportPostmanV3, exportPostmanV3Tree } from './export-v3';
import { importPostmanCollection } from './index';
import { upgradeStreamPlaceholders } from './parse-v3-streaming';
import { attachPostmanSidecar, getPostmanSidecar } from './sidecar';
import { readPostmanV3Container } from './v3-container';

/** Postman v3 WebSocket / Socket.IO items ⇄ native Restura items (#1209). */

const schema = JSON.parse(
  readFileSync(resolve(process.cwd(), 'vendor/postman/v3.0.0/schema.json'), 'utf8')
) as object;
const validate = new Ajv({ strict: false, allErrors: true }).compile(schema);

const v3 = (items: unknown[]) => ({ $kind: 'collection', name: 'C', items });
const constructs = (ws: ReadonlyArray<{ kind: string; construct?: string }>) =>
  ws.map((w) => w.construct ?? w.kind);

const WS_ITEM = {
  $kind: 'websocket-request',
  name: 'Feed',
  description: 'Live feed',
  url: 'wss://{{host}}/feed?room=1',
  headers: [
    { key: 'X-Trace', value: '{{trace}}' },
    { key: 'Authorization', value: 'Bearer live-token' },
  ],
  queryParams: [
    { key: 'room', value: '1' },
    { key: 'debug', value: 'yes', disabled: true },
  ],
  auth: { type: 'bearer', credentials: [{ key: 'token', value: 'ws-secret' }] },
  settings: { retryCount: 3, retryDelay: 500, handshakeTimeout: 1000, strictSSL: false },
  messages: [
    { $kind: 'websocket-message', name: 'Hello', content: '{"a":1}', contentType: 'json' },
    { $kind: 'websocket-message', name: 'Doc', content: '<a/>', contentType: 'xml' },
  ],
};

const SIO_ITEM = {
  $kind: 'socket.io-request',
  name: 'Chat',
  url: 'https://chat.example.com',
  headers: [{ key: 'X-Client', value: 'r' }],
  queryParams: [{ key: 'token', value: 'q-secret' }],
  events: [{ name: 'message' }, { name: 'typing', subscribeOnConnect: false }],
  settings: { version: '4', path: '/io', handshakeTimeout: 5000, retryCount: 0 },
  messages: [
    {
      $kind: 'socket.io-message',
      name: 'Say',
      eventName: 'say',
      acknowledgement: true,
      args: [
        { content: 'hi', contentType: 'text' },
        { content: '{"to":"bob"}', contentType: 'json' },
      ],
    },
    {
      $kind: 'socket.io-message',
      name: 'List',
      eventName: 'list',
      args: [{ content: '[1,2]', contentType: 'json' }],
    },
  ],
};

function importOne(item: unknown) {
  const { collection, report } = importPostmanCollection(v3([item]));
  return { item: collection.items[0] as CollectionItem, collection, report };
}

describe('Postman v3 websocket-request import (#1209)', () => {
  const { item, report } = importOne(WS_ITEM);
  const r = item.request as WebSocketRequest;

  it('becomes a native WebSocket item, not a placeholder folder', () => {
    expect(item).toMatchObject({ type: 'request', name: 'Feed' });
    expect(getPostmanSidecar(item)?.item).toBeUndefined();
    expect(r).toMatchObject({
      type: 'websocket',
      description: 'Live feed',
      url: 'wss://{{host}}/feed?room=1',
      protocols: [],
      message: { body: '{"a":1}', format: 'json' },
      templates: [
        { name: 'Hello', body: '{"a":1}', format: 'json' },
        { name: 'Doc', body: '<a/>', format: 'text' },
      ],
      options: { autoReconnect: true, maxReconnectAttempts: 3, reconnectDelay: 500 },
    });
    expect(r.headers.map((h) => [h.key, h.value])).toEqual([
      ['X-Trace', '{{trace}}'],
      ['Authorization', 'Bearer live-token'],
    ]);
  });

  it('keeps auth bag-only and reports leftovers, unsupported auth and strictSSL', () => {
    const sidecar = getPostmanSidecar(item);
    expect(sidecar?.authBagOnly).toBe(true);
    expect(sidecar?.leftovers).toMatchObject({
      queryParams: [{ key: 'debug', value: 'yes', disabled: true }],
      payloadEncodings: [{ message: 'Doc', contentType: 'xml' }],
      settings: { handshakeTimeout: 1000, strictSSL: false },
    });
    expect(constructs(report.warnings)).toEqual(
      expect.arrayContaining(['unsupported-auth', 'connection-leftovers', 'security-downgrade'])
    );
    expect(constructs(report.warnings)).not.toContain('unsupported-item-kind');
  });

  it('exports back to a schema-valid websocket-request with the leftovers restored', () => {
    const { collection } = importOne(WS_ITEM);
    const { tree } = exportPostmanV3Tree(collection);
    expect(validate(tree) ? [] : validate.errors?.slice(0, 3)).toEqual([]);
    const out = (tree.items as Record<string, unknown>[])[0];
    expect(out).toMatchObject({
      $kind: 'websocket-request',
      name: 'Feed',
      description: 'Live feed',
      url: 'wss://{{host}}/feed?room=1',
      queryParams: [{ key: 'debug', value: 'yes', disabled: true }],
      auth: { type: 'bearer', credentials: [{ key: 'token', value: 'ws-secret' }] },
      settings: { handshakeTimeout: 1000, strictSSL: false, retryCount: 3, retryDelay: 500 },
      messages: [
        { $kind: 'websocket-message', name: 'Hello', content: '{"a":1}', contentType: 'json' },
        { $kind: 'websocket-message', name: 'Doc', content: '<a/>', contentType: 'xml' },
      ],
    });
  });

  it('round-trips import → export → import unchanged', () => {
    const { collection } = importOne(WS_ITEM);
    const { tree } = exportPostmanV3(collection);
    const again = importPostmanCollection(tree).collection;
    const strip = (c: Collection) =>
      JSON.parse(JSON.stringify(c, (k, v) => (k === 'id' ? undefined : v)));
    expect(strip(again).items).toEqual(strip(collection).items);
  });
});

describe('Postman v3 socket.io-request import (#1209)', () => {
  const { item } = importOne(SIO_ITEM);
  const r = item.request as SocketIoRequest;

  it('becomes a native Socket.IO item with args as composer JSON text', () => {
    expect(item.type).toBe('request');
    expect(r).toMatchObject({
      type: 'socketio',
      url: 'https://chat.example.com',
      namespace: '/',
      path: '/io',
      handshakeAuth: [],
      subscribedEvents: ['message', 'typing'],
      emit: { eventName: 'say', args: '["hi", {"to":"bob"}]', ack: true },
      templates: [
        { name: 'Say', eventName: 'say', args: '["hi", {"to":"bob"}]', ack: true },
        // A single array argument stays ONE argument.
        { name: 'List', eventName: 'list', args: '[[1,2]]', ack: false },
      ],
      options: { autoReconnect: false, reconnectionAttempts: 0, timeout: 5000 },
    });
    expect(r.query.map((q) => [q.key, q.value])).toEqual([['token', 'q-secret']]);
  });

  it('exports a schema-valid socket.io-request and round-trips', () => {
    const { collection } = importOne(SIO_ITEM);
    const { tree, files } = exportPostmanV3(collection);
    expect(validate(tree) ? [] : validate.errors?.slice(0, 3)).toEqual([]);
    expect(validate(readPostmanV3Container(files).tree)).toBe(true);
    const out = (tree.items as Record<string, unknown>[])[0];
    expect(out).toMatchObject({
      $kind: 'socket.io-request',
      events: [{ name: 'message' }, { name: 'typing', subscribeOnConnect: false }],
      settings: { version: '4', path: '/io', handshakeTimeout: 5000, retryCount: 0 },
      messages: [
        {
          eventName: 'say',
          acknowledgement: true,
          args: [
            { content: 'hi', contentType: 'text' },
            { content: '{"to":"bob"}', contentType: 'json' },
          ],
        },
        { eventName: 'list', args: [{ content: '[1,2]', contentType: 'json' }] },
      ],
    });
    const again = importPostmanCollection(tree).collection;
    expect((again.items[0]?.request as SocketIoRequest).templates).toEqual(r.templates);
  });

  it('reports Restura-only Socket.IO options as not exported', () => {
    const native: Collection = {
      id: 'c',
      name: 'C',
      items: [
        {
          id: 'i',
          name: 'S',
          type: 'request',
          request: {
            ...r,
            namespace: '/admin',
            handshakeAuth: [{ id: 'a', key: 'token', value: 'x', enabled: true }],
          },
        },
      ],
    };
    const { report } = exportPostmanV3(native);
    expect(report.entries.find((e) => e.construct === 'socketio-extras')?.detail).toMatch(
      /namespace, handshake auth/
    );
  });
});

describe('export redaction (#1209)', () => {
  it('blanks credential-named WS headers, SIO query rows, handshake auth and URL userinfo', () => {
    const { collection } = importPostmanCollection(v3([WS_ITEM, SIO_ITEM]));
    const sio = collection.items[1]!;
    (sio.request as SocketIoRequest).handshakeAuth = [
      { id: 'a', key: 'room', value: 'lobby', enabled: true },
      { id: 'b', key: 'token', value: '{{token}}', enabled: true },
    ];
    (sio.request as SocketIoRequest).url = 'https://user:pw@chat.example.com';
    expect(countCollectionInlineSecrets(collection)).toBeGreaterThanOrEqual(5);
    const redacted = redactCollectionSecrets(collection);
    const json = JSON.stringify(redacted);
    for (const secret of ['live-token', 'ws-secret', 'q-secret', 'lobby', 'user:pw']) {
      expect(json).not.toContain(secret);
    }
    // A pure {{var}} reference is not a secret.
    expect((redacted.items[1]?.request as SocketIoRequest).handshakeAuth[1]?.value).toBe(
      '{{token}}'
    );
    const { tree } = exportPostmanV3(redacted);
    expect(JSON.stringify(tree)).not.toContain('ws-secret');
  });
});

describe('pre-#1209 placeholder folders upgrade to native items', () => {
  it('rebuilds the item from the sidecar and keeps the bag-only auth', () => {
    const placeholder = attachPostmanSidecar<CollectionItem>(
      { id: 'p', name: 'Feed (WebSocket)', type: 'folder', items: [] },
      {
        item: { ...WS_ITEM, auth: undefined },
        auth: { type: 'bearer', bearer: [{ key: 'token', value: '' }] },
        authBagOnly: true,
      }
    );
    const sioPlaceholder = attachPostmanSidecar<CollectionItem>(
      { id: 's', name: 'Chat (Socket.IO)', type: 'folder', items: [] },
      { item: SIO_ITEM }
    );
    const other: CollectionItem = { id: 'f', name: 'Plain', type: 'folder', items: [] };
    const nested: CollectionItem = { id: 'n', name: 'N', type: 'folder', items: [sioPlaceholder] };
    const out = upgradeStreamPlaceholders([placeholder, other, nested]);
    expect(out[0]).toMatchObject({ id: 'p', name: 'Feed', type: 'request' });
    expect((out[0]?.request as WebSocketRequest).url).toBe('wss://{{host}}/feed?room=1');
    expect(getPostmanSidecar(out[0]!)).toMatchObject({ authBagOnly: true });
    expect(getPostmanSidecar(out[0]!)?.item).toBeUndefined();
    expect(out[1]).toBe(other);
    expect(out[2]?.items?.[0]).toMatchObject({ name: 'Chat', type: 'request' });
    expect(upgradeStreamPlaceholders(out)).toBe(out);
  });
});
