import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { internalToOC } from '@shared/opencollection/from-internal';
import { loadCollectionFromDir } from '@shared/opencollection/node/fs-reader';
import { saveCollectionToDir } from '@shared/opencollection/node/fs-writer';
import { ocToInternal } from '@shared/opencollection/to-internal';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Collection, SocketIoRequest, WebSocketRequest } from '@/types';

/**
 * Git-native (directory-layout) collections with WebSocket / Socket.IO items
 * (#1209): WebSocket is a native OC item file (Restura-only fields in the root
 * `x-restura-websocket`), Socket.IO rides in the root `x-restura-socketio`.
 */
const WS: WebSocketRequest = {
  id: 'w',
  name: 'Feed',
  type: 'websocket',
  url: 'wss://{{host}}/feed',
  protocols: ['json'],
  headers: [{ id: 'h', key: 'X-Trace', value: '{{trace}}', enabled: true }],
  message: { body: '{}', format: 'json' },
  templates: [{ name: 'Ping', body: 'ping', format: 'text' }],
  options: { heartbeatInterval: 1000, heartbeatMessage: 'hb' },
};

const SIO: SocketIoRequest = {
  id: 's',
  name: 'Chat',
  type: 'socketio',
  url: 'https://chat.example.com',
  namespace: '/',
  path: '/socket.io',
  handshakeAuth: [],
  query: [],
  headers: [],
  transports: ['websocket', 'polling'],
  subscribedEvents: ['message'],
  emit: { eventName: 'message', args: '"hi"', ack: false },
  templates: [],
};

describe('git-native collections with WebSocket / Socket.IO items', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'oc-stream-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes them out and reloads them into their folders with every field', async () => {
    const collection: Collection = {
      id: 'c',
      name: 'Live',
      items: [
        { id: 'i-s', name: 'Chat', type: 'request', request: SIO },
        {
          id: 'f',
          name: 'Feeds',
          type: 'folder',
          items: [{ id: 'i-w', name: 'Feed', type: 'request', request: WS }],
        },
      ],
    };
    await saveCollectionToDir(internalToOC(collection), dir);

    const root = await readFile(join(dir, 'opencollection.yml'), 'utf8');
    expect(root).toContain('x-restura-socketio');
    expect(root).toContain('x-restura-websocket');
    expect((await readdir(join(dir, 'Feeds'))).length).toBeGreaterThan(0);

    const back = ocToInternal(await loadCollectionFromDir(dir));
    const chat = back.items.find((i) => i.name === 'Chat')?.request;
    const feed = back.items.find((i) => i.name === 'Feeds')?.items?.find((i) => i.name === 'Feed');
    expect(chat).toMatchObject({ type: 'socketio', subscribedEvents: ['message'] });
    expect(feed?.type).toBe('request');
    expect(feed?.request).toMatchObject({
      type: 'websocket',
      url: 'wss://{{host}}/feed',
      protocols: ['json'],
      message: { body: '{}', format: 'json' },
      templates: [{ name: 'Ping', body: 'ping', format: 'text' }],
      options: { heartbeatInterval: 1000, heartbeatMessage: 'hb' },
    });
  });
});
