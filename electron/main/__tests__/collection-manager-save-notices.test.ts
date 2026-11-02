// @vitest-environment node
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ home: '/tmp/restura-no-such-dir', handle: vi.fn() }));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => h.home) },
  dialog: {},
  ipcMain: { handle: h.handle },
  shell: {},
}));

import { IPC } from '../../shared/channels';
import {
  describeSaveRedactions,
  type FileCollection,
  registerCollectionManagerIPC,
} from '../storage/collection-manager';

const SECRET = 'PLAIN-value';

function save(items: unknown[], extra: Record<string, unknown> = {}): FileCollection {
  return { id: 'c', name: 'c', items, ...extra } as unknown as FileCollection;
}

const requestItem = (name: string, request: Record<string, unknown>) => ({
  id: name,
  name,
  type: 'request',
  request: { id: name, name, ...request },
});

describe('describeSaveRedactions', () => {
  it('names a request whose URL held a credential', () => {
    const notices = describeSaveRedactions(
      save([requestItem('with-url', { type: 'http', url: `https://u:${SECRET}@h.test` })])
    );
    expect(notices.credentialsRemovedFrom).toEqual(['with-url']);
    expect(notices.addressesBlankedIn).toEqual([]);
  });

  it('names a preset whose address is saved blank, separately', () => {
    const notices = describeSaveRedactions(
      save([
        requestItem('with-blank', {
          type: 'mqtt',
          connection: { brokerUrl: `mqtt://u:pa/${SECRET}@h:1883` },
          publish: {},
          templates: [],
        }),
        requestItem('with-broker', {
          type: 'kafka',
          connection: {
            bootstrapBrokers: [`u:${SECRET}@b1:9092`],
            registry: { url: `https://u:pa/${SECRET}@r.test` },
          },
          produce: { headers: [] },
        }),
      ])
    );
    expect(notices.credentialsRemovedFrom).toEqual(['with-blank', 'with-broker']);
    expect(notices.addressesBlankedIn).toEqual(['with-blank', 'with-broker']);
  });

  it('still reports collection and folder auth, and a passthrough-only credential', () => {
    const auth = { type: 'bearer', bearer: { token: SECRET } };
    expect(
      describeSaveRedactions(
        save([{ id: 'f', name: 'f', type: 'folder', items: [], auth }], { auth })
      ).credentialsRemovedFrom
    ).toEqual(['<collection>', 'f']);
    expect(
      describeSaveRedactions(
        save([
          {
            id: 'p',
            name: 'p',
            type: 'folder',
            items: [],
            _oc: { info: { type: 'future' }, url: `https://u:${SECRET}@h.test` },
          },
        ])
      ).credentialsRemovedFrom
    ).toEqual(['<collection>']);
  });

  it('names the scope of a variable that held a credential', () => {
    const variables = [
      { id: 'a', key: 'API_TOKEN', value: SECRET, enabled: true },
      { id: 'b', key: 'BASE_URL', value: `https://u:${SECRET}@h.test`, enabled: true },
    ];
    const notices = describeSaveRedactions(
      save([{ id: 'f', name: 'folder', type: 'folder', items: [], variables }], { variables })
    );
    expect(notices.credentialsRemovedFrom).toEqual(['<collection>', 'folder']);
    expect(JSON.stringify(notices)).not.toContain(SECRET);
  });

  it('reports nothing for a clean save, for references, and carries no value', () => {
    const notices = describeSaveRedactions(
      save([
        requestItem('clean', { type: 'http', url: 'https://{{u}}:{{p}}@h.test?token={{t}}' }),
        requestItem('mqtt', {
          type: 'mqtt',
          connection: { brokerUrl: 'mqtt://{{u}}:{{p}}@h:1883' },
          publish: {},
          templates: [],
        }),
      ])
    );
    expect(notices).toEqual({ credentialsRemovedFrom: [], addressesBlankedIn: [] });
    const withSecret = describeSaveRedactions(
      save([requestItem('r', { type: 'http', url: `https://u:${SECRET}@h.test` })])
    );
    expect(JSON.stringify(withSecret)).not.toContain(SECRET);
  });

  it('a request it cannot read never blocks the save', () => {
    const notices = describeSaveRedactions(
      save([requestItem('odd', { type: 'http', url: { raw: 'x' } })])
    );
    expect(notices.credentialsRemovedFrom).toEqual(['odd']);
  });
});

describe('save collection IPC result', () => {
  const trustedEvent = { senderFrame: { url: 'file:///app/dist/web/index.html', parent: null } };

  beforeEach(async () => {
    h.home = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'save-notices-')));
    h.handle.mockClear();
    registerCollectionManagerIPC(() => null);
  });

  afterEach(async () => {
    await fsp.rm(h.home, { recursive: true, force: true });
  });

  function saveHandler() {
    const call = h.handle.mock.calls.find(([channel]) => channel === IPC.collection.saveDirectory);
    return call?.[1] as (event: unknown, payload: unknown) => Promise<Record<string, unknown>>;
  }

  const http = (name: string, url: string) => ({
    id: name,
    name,
    type: 'request',
    request: {
      id: name,
      name,
      type: 'http',
      method: 'GET',
      url,
      headers: [],
      params: [],
      body: { type: 'none' },
      auth: { type: 'none' },
    },
  });

  it('names what was removed and blanked, with no value', async () => {
    const dir = path.join(h.home, 'with-credentials');
    const result = await saveHandler()(trustedEvent, [
      save([
        http('with-url', `https://u:${SECRET}@h.test`),
        requestItem('with-blank', {
          type: 'mqtt',
          connection: {
            brokerUrl: `mqtt://u:pa/${SECRET}@h:1883`,
            protocolVersion: 5,
            clientId: 'c',
            keepalive: 60,
            cleanStart: true,
            connectTimeout: 1000,
            autoReconnect: false,
          },
          publish: { topic: 't', payload: '', qos: 0, retain: false },
          subscribe: { topicFilter: '#', qos: 0 },
          templates: [],
        }),
      ]),
      dir,
    ]);
    expect(result).toEqual({
      success: true,
      redactions: {
        credentialsRemovedFrom: ['with-url', 'with-blank'],
        addressesBlankedIn: ['with-blank'],
      },
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('a clean save keeps the original result shape', async () => {
    const result = await saveHandler()(trustedEvent, [
      save([http('clean', 'https://{{u}}:{{p}}@h.test')]),
      path.join(h.home, 'clean'),
    ]);
    expect(result).toEqual({ success: true });
  });
});
