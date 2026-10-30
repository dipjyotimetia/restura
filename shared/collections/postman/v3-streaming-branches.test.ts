import { describe, expect, it } from 'vitest';
import type { Collection, CollectionItem, SocketIoRequest, WebSocketRequest } from '../../types';
import { exportPostmanV3Tree } from './export-v3';
import { importPostmanCollection } from './index';
import { upgradeStreamPlaceholder } from './parse-v3-streaming';
import { attachPostmanSidecar, getPostmanSidecar } from './sidecar';

/** Branch coverage for the Postman v3 WebSocket / Socket.IO mapping (#1209). */

const importOne = (item: Record<string, unknown>) => {
  const r = importPostmanCollection({ $kind: 'collection', name: 'C', items: [item] });
  return { item: r.collection.items[0] as CollectionItem, report: r.report };
};

const exportOne = (request: WebSocketRequest | SocketIoRequest, sidecar?: object) => {
  const item: CollectionItem = { id: 'i', name: request.name, type: 'request', request };
  if (sidecar) attachPostmanSidecar(item, sidecar);
  const collection: Collection = { id: 'c', name: 'C', items: [item] };
  const { tree, report } = exportPostmanV3Tree(collection);
  return { out: (tree.items as Record<string, unknown>[])[0]!, report };
};

const WS: WebSocketRequest = {
  id: 'w',
  name: 'W',
  type: 'websocket',
  url: 'wss://x',
  protocols: [],
  headers: [],
  message: { body: '', format: 'text' },
  templates: [],
};

const SIO: SocketIoRequest = {
  id: 's',
  name: 'S',
  type: 'socketio',
  url: 'https://x',
  namespace: '/',
  path: '/socket.io',
  handshakeAuth: [],
  query: [],
  headers: [],
  transports: ['websocket', 'polling'],
  subscribedEvents: [],
  emit: { eventName: 'message', args: '', ack: false },
  templates: [],
};

describe('websocket-request import edges', () => {
  it('merges enabled query rows into the URL without duplicating existing keys', () => {
    const q = [
      { key: 'a', value: '1' },
      { key: 'b', value: '2' },
      { key: '', value: 'skip' },
    ];
    const url = (u: string) =>
      (
        importOne({ $kind: 'websocket-request', name: 'W', url: u, queryParams: q }).item
          .request as WebSocketRequest
      ).url;
    expect(url('wss://x')).toBe('wss://x?a=1&b=2');
    expect(url('wss://x?')).toBe('wss://x?a=1&b=2');
    expect(url('wss://x?a=0')).toBe('wss://x?a=0&b=2');
    expect(url('wss://x?a=1&b=2')).toBe('wss://x?a=1&b=2');
  });

  it('defaults names / formats and maps retryCount 0 to no auto-reconnect', () => {
    const { item, report } = importOne({
      $kind: 'websocket-request',
      name: '',
      messages: [{ content: 'x' }, { name: 'B64', content: 'eA==', contentType: 'base64' }],
      settings: { retryCount: 0 },
      auth: { type: 'noauth' },
    });
    const r = item.request as WebSocketRequest;
    expect(item.name).toBe('Unnamed Request');
    expect(r.url).toBe('');
    expect(r.templates).toEqual([
      { name: 'Message 1', body: 'x', format: 'text' },
      { name: 'B64', body: 'eA==', format: 'text' },
    ]);
    expect(r.options).toEqual({ autoReconnect: false, maxReconnectAttempts: 0 });
    expect(report.warnings.map((w) => w.kind)).not.toContain('unsupported-auth');
    expect(importOne({ $kind: 'websocket-request', name: 'N' }).item.request).not.toHaveProperty(
      'options'
    );
  });
});

describe('socket.io-request import edges', () => {
  it('maps args, defaults the emit draft and keeps event notes', () => {
    const { item } = importOne({
      $kind: 'socket.io-request',
      name: 'S',
      events: [{ name: '' }, { name: 'e', subscribeOnConnect: false }],
      settings: { retryDelay: 10.9, handshakeTimeout: -1 },
      messages: [
        { eventName: 'empty', args: [] },
        { eventName: 'hex', args: [{ content: 'ff', contentType: 'hex' }] },
        { eventName: 'num', args: [{ content: '5', contentType: 'json' }] },
        { eventName: 'nocontent', args: [{}] },
      ],
    });
    const r = item.request as SocketIoRequest;
    expect(r.templates.map((t) => [t.name, t.args])).toEqual([
      ['Emit 1', ''],
      ['Emit 2', '"ff"'],
      ['Emit 3', '5'],
      ['Emit 4', '""'],
    ]);
    expect(r.subscribedEvents).toEqual(['e']);
    expect(r.options).toEqual({ reconnectionDelay: 10 });
    expect(getPostmanSidecar(item)?.leftovers).toMatchObject({
      payloadEncodings: [{ message: 'Emit 2', arg: 0, contentType: 'hex' }],
    });
    const bare = importOne({ $kind: 'socket.io-request', name: 'B' }).item.request;
    expect(bare).toMatchObject({ emit: { eventName: 'message', args: '', ack: false } });
    expect(bare).not.toHaveProperty('options');
  });
});

describe('websocket-request export edges', () => {
  it('reports every Restura-only option and writes a lone draft as one message', () => {
    const { out, report } = exportOne({
      ...WS,
      protocols: ['p'],
      message: { body: 'draft', format: 'json' },
      options: { heartbeatInterval: 5, perMessageDeflate: false, autoReconnect: false },
      frameAssertion: { enabled: true, script: '' },
    });
    expect(report.entries.find((e) => e.construct === 'websocket-extras')?.detail).toMatch(
      /subprotocols, heartbeat, permessage-deflate off, frame assertion/
    );
    expect(out).toMatchObject({
      messages: [{ name: 'Message', content: 'draft', contentType: 'json' }],
      settings: { retryCount: 0 },
    });
  });

  it('reports a draft that is not one of the saved messages; empty items stay minimal', () => {
    const { report } = exportOne({
      ...WS,
      message: { body: 'unsaved', format: 'text' },
      templates: [{ name: '', body: 'saved', format: 'hex' }],
    });
    expect(report.entries.find((e) => e.construct === 'websocket-extras')?.detail).toMatch(
      /composer draft/
    );
    expect(exportOne(WS).out).toEqual({ name: 'W', $kind: 'websocket-request', url: 'wss://x' });
  });

  it('restores examples from the saved-response bag, tolerating blanked or odd entries', () => {
    const { out } = exportOne(WS, {
      response: [
        { name: '', originalRequest: { url: '', header: [{ value: 'no-key' }] }, body: '' },
        {
          name: 'E',
          originalRequest: { url: 'wss://x', header: [{ key: 'K' }] },
          body: '[1]',
        },
        'junk',
      ],
    });
    expect(out.examples).toEqual([
      { name: 'Example 1', $kind: 'websocket-example', response: {} },
      {
        name: 'E',
        $kind: 'websocket-example',
        request: { url: 'wss://x', headers: [{ key: 'K', value: '' }] },
        response: {},
      },
    ]);
  });
});

describe('socket.io-request export edges', () => {
  it('converts args text back to v3 args and reports Restura-only options', () => {
    const { out, report } = exportOne({
      ...SIO,
      transports: ['polling'],
      path: '/io',
      options: { forceNew: true, reconnectionAttempts: 3 },
      emit: { eventName: 'draft', args: '{{payload}}', ack: false },
      templates: [
        { name: '', eventName: 'a', args: '', ack: false },
        { name: 'N', eventName: 'b', args: '[1, "two", {"x":1}]', ack: true },
        { name: 'V', eventName: 'c', args: '{{raw}}', ack: false },
      ],
      subscribedEvents: ['x'],
    });
    expect(report.entries.find((e) => e.construct === 'socketio-extras')?.detail).toMatch(
      /transports, forceNew/
    );
    expect(out).toMatchObject({
      events: [{ name: 'x' }],
      settings: { path: '/io', retryCount: 3 },
      messages: [
        { name: 'Emit', eventName: 'a', args: [{ content: '', contentType: 'text' }] },
        {
          name: 'N',
          acknowledgement: true,
          args: [
            { content: '1', contentType: 'json' },
            { content: 'two', contentType: 'text' },
            { content: '{"x":1}', contentType: 'json' },
          ],
        },
        { name: 'V', args: [{ content: '{{raw}}', contentType: 'json' }] },
      ],
    });
  });

  it('writes the emit draft as one message only when it has an event and args', () => {
    expect(exportOne(SIO).out).not.toHaveProperty('messages');
    expect(
      exportOne({ ...SIO, emit: { eventName: 'e', args: '"hi"', ack: false } }).out.messages
    ).toEqual([
      {
        name: 'Emit',
        $kind: 'socket.io-message',
        eventName: 'e',
        args: [{ content: 'hi', contentType: 'text' }],
      },
    ]);
  });
});

describe('upgradeStreamPlaceholder guards', () => {
  const folder = (sidecar: object, extra: Partial<CollectionItem> = {}) =>
    attachPostmanSidecar<CollectionItem>(
      { id: 'f', name: 'Chat (Socket.IO)', type: 'folder', items: [], ...extra },
      sidecar
    );

  it('returns every non-placeholder node unchanged', () => {
    const req: CollectionItem = { id: 'r', name: 'R', type: 'request' };
    expect(upgradeStreamPlaceholder(req)).toBe(req);
    const full = folder({ item: { $kind: 'socket.io-request' } }, { items: [req] });
    expect(upgradeStreamPlaceholder(full)).toBe(full);
    const noBag: CollectionItem = { id: 'n', name: 'N', type: 'folder', items: [] };
    expect(upgradeStreamPlaceholder(noBag)).toBe(noBag);
    const llm = folder({ item: { $kind: 'llm-request' } });
    expect(upgradeStreamPlaceholder(llm)).toBe(llm);
  });

  it('recovers the name from the label suffix and keeps the noauth marker', () => {
    const out = upgradeStreamPlaceholder(
      folder({ item: { $kind: 'socket.io-request', url: 'https://x' }, noauth: true })
    );
    expect(out).toMatchObject({ name: 'Chat', type: 'request', request: { type: 'socketio' } });
    expect(getPostmanSidecar(out)).toEqual({ noauth: true });
    const odd = upgradeStreamPlaceholder(
      attachPostmanSidecar<CollectionItem>(
        { id: 'o', name: 'Odd', type: 'folder', items: [] },
        { item: { $kind: 'websocket-request' } }
      )
    );
    expect(odd.name).toBe('Odd');
  });

  it('never produces an empty name (the item schema requires one)', () => {
    const blank = (kind: string, name: string) =>
      upgradeStreamPlaceholder(
        attachPostmanSidecar<CollectionItem>(
          { id: 'b', name, type: 'folder', items: [] },
          { item: { $kind: kind, name: '' } }
        )
      ).name;
    expect(blank('websocket-request', ' (WebSocket)')).toBe('Untitled WebSocket');
    expect(blank('socket.io-request', '')).toBe('Untitled Socket.IO');
  });
});
