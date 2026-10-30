import { describe, expect, it } from 'vitest';
import { requestOf } from '../../tests/helpers/requestOf';
import type { AuthConfig, Collection, CollectionItem, McpRequest, SseRequest } from '../types';
import { applyAuthExtension, buildAuthExtension } from './auth-extension';
import { authFromInternal, unwrapAuthForCompare } from './auth-from-internal';
import { internalToOC } from './from-internal';
import { authToInternal, ocToInternal } from './to-internal';

/**
 * Edge cases for the OpenCollection fidelity paths (#863 #866 #869) that the
 * happy-path round-trip harness (`fidelity-roundtrip.test.ts`) does not reach:
 * malformed sidecar entries, sparse auth blocks, external secret references and
 * minimal / hand-written SSE + MCP extension entries.
 */

type WithOC<T> = T & { _oc?: unknown };

const http = (name: string, auth: AuthConfig): CollectionItem => ({
  id: `i-${name}`,
  name,
  type: 'request',
  request: {
    id: `r-${name}`,
    name,
    type: 'http',
    method: 'GET',
    url: 'https://api.example.test/x',
    headers: [],
    params: [],
    body: { type: 'none' },
    auth,
  },
});

const folder = (name: string, items: CollectionItem[], auth?: AuthConfig): CollectionItem => ({
  id: `f-${name}`,
  name,
  type: 'folder',
  items,
  ...(auth ? { auth } : {}),
});

const WSSE_DIGEST: AuthConfig = {
  type: 'wsse',
  wsse: { username: 'u', password: 'p', passwordType: 'PasswordDigest' },
};
const NTLM_WS: AuthConfig = {
  type: 'ntlm',
  ntlm: { username: 'u', password: 'p', workstation: 'WS01' },
};

describe('buildAuthExtension ordering', () => {
  it('sorts entries by (target, path) and keeps duplicate names in document order', () => {
    const ext = buildAuthExtension({
      items: [
        folder('B', [], WSSE_DIGEST),
        folder('A', [], WSSE_DIGEST),
        // Two siblings with the same name share a sort key — stable order wins.
        http('Dup', NTLM_WS),
        http('Dup', { type: 'ntlm', ntlm: { username: 'u', password: 'p', workstation: 'WS02' } }),
      ],
    });
    expect(ext?.entries.map((e) => [e.target, e.path.join('/')])).toEqual([
      ['folder', 'A'],
      ['folder', 'B'],
      ['request', 'Dup'],
      ['request', 'Dup'],
    ]);
    const dups = ext?.entries.filter((e) => e.target === 'request');
    expect(dups?.map((e) => e.workstation)).toEqual(['WS01', 'WS02']);
  });

  it('returns undefined when no node carries a schema-less knob', () => {
    expect(buildAuthExtension({ items: [http('Plain', { type: 'none' })] })).toBeUndefined();
  });
});

describe('applyAuthExtension tolerates malformed sidecars', () => {
  const target = (): Pick<Collection, 'auth' | 'items'> => ({
    auth: { type: 'wsse', wsse: { username: 'u', password: 'p' } },
    items: [],
  });

  it.each([
    ['null', null],
    ['a string', 'x-restura-auth'],
    ['entries not an array', { entries: 'nope' }],
    ['only non-object entries', { entries: [null, 'str', 42] }],
    ['only invalid entries', { entries: [{ target: 'nowhere', path: [], type: 'wsse' }] }],
  ])('ignores %s', (_label, raw) => {
    const c = target();
    applyAuthExtension(c, raw);
    expect(c.auth).toEqual({ type: 'wsse', wsse: { username: 'u', password: 'p' } });
  });

  it('ignores knobs whose value has the wrong shape for the auth type', () => {
    const c: Pick<Collection, 'auth' | 'items'> = {
      auth: { type: 'wsse', wsse: { username: 'u', password: 'p' } },
      items: [
        http('O', { type: 'oauth1', oauth1: { consumerKey: 'k', consumerSecret: 's' } }),
        http('N', { type: 'ntlm', ntlm: { username: 'u', password: 'p' } }),
      ],
    };
    applyAuthExtension(c, {
      entries: [
        { target: 'collection', path: [], type: 'wsse', passwordType: 'Bogus' },
        { target: 'request', path: ['O'], type: 'oauth1', addParamsToBody: 'yes' },
        { target: 'request', path: ['N'], type: 'ntlm', workstation: 7 },
      ],
    });
    expect(c.auth?.wsse?.passwordType).toBeUndefined();
    expect(requestOf(c.items[0]).auth.oauth1?.addParamsToBody).toBeUndefined();
    expect(requestOf(c.items[1]).auth.ntlm?.workstation).toBeUndefined();
  });
});

describe('authFromInternal sparse + external values', () => {
  it('renders external secret references as placeholders, with and without selector', () => {
    const base = {
      kind: 'external' as const,
      provider: 'aws-secrets-manager' as const,
      profileId: 'prod',
      secretId: 'api/token',
    };
    expect(authFromInternal({ type: 'bearer', bearer: { token: base } })).toEqual({
      type: 'bearer',
      token: '{{external:aws-secrets-manager:prod:api/token}}',
    });
    expect(
      authFromInternal({ type: 'bearer', bearer: { token: { ...base, selector: 'key' } } })
    ).toEqual({ type: 'bearer', token: '{{external:aws-secrets-manager:prod:api/token:key}}' });
  });

  it('emits schema defaults for OAuth1 / NTLM / WSSE configs missing their block', () => {
    expect(authFromInternal({ type: 'oauth1' })).toEqual({
      type: 'oauth1',
      consumerKey: '',
      consumerSecret: '',
    });
    expect(authFromInternal({ type: 'ntlm' })).toEqual({
      type: 'ntlm',
      username: '',
      password: '',
    });
    expect(authFromInternal({ type: 'wsse' })).toEqual({
      type: 'wsse',
      username: '',
      password: '',
    });
  });

  it('omits NTLM domain when unset and keeps it when set', () => {
    expect(authFromInternal({ type: 'ntlm', ntlm: { username: 'u', password: 'p' } })).toEqual({
      type: 'ntlm',
      username: 'u',
      password: 'p',
    });
    expect(
      authFromInternal({ type: 'ntlm', ntlm: { username: 'u', password: 'p', domain: 'D' } })
    ).toMatchObject({ domain: 'D' });
  });

  it('unwrapAuthForCompare flattens SecretRefs to their export form', () => {
    expect(
      unwrapAuthForCompare({
        type: 'wsse',
        wsse: { username: 'u', password: { kind: 'inline', value: 'p' } },
      }).wsse?.password
    ).toBe('p');
  });
});

describe('authToInternal sparse OAuth1 / NTLM / WSSE blocks', () => {
  it('defaults non-string credentials to empty and omits absent optionals', () => {
    expect(authToInternal({ type: 'ntlm', username: 5 })).toEqual({
      type: 'ntlm',
      ntlm: { username: '', password: '' },
    });
    expect(authToInternal({ type: 'wsse' })).toEqual({
      type: 'wsse',
      wsse: { username: '', password: '' },
    });
    expect(authToInternal({ type: 'oauth1', signatureMethod: 'RSA-SHA256' })).toEqual({
      type: 'oauth1',
      oauth1: { consumerKey: '', consumerSecret: '' },
    });
  });
});

describe('SSE / MCP extension entries — minimal and hand-written', () => {
  const importExt = (ext: Record<string, unknown>, items: unknown[] = []) =>
    ocToInternal({
      opencollection: '1.0.0',
      info: { name: 'Ext' },
      items,
      extensions: ext,
    } as never);

  it('fills defaults for bare SSE / MCP entries', () => {
    const c = importExt({ 'x-restura-sse': [null], 'x-restura-mcp': [{}] });
    const [sse, mcp] = c.items.map((i) => i.request);
    expect(sse).toMatchObject({ type: 'sse', name: 'SSE', url: '', headers: [], params: [] });
    expect(mcp).toMatchObject({
      type: 'mcp',
      name: 'MCP',
      url: '',
      transport: 'streamable-http',
      headers: [],
    });
    expect((mcp as McpRequest).defaultParams).toBeUndefined();
  });

  it('accepts a hand-written YAML mapping for MCP defaultParams and ignores null', () => {
    const c = importExt({
      'x-restura-mcp': [
        {
          info: { name: 'Map' },
          mcp: { defaultMethod: 'tools/call', defaultParams: { name: 't' } },
        },
        { info: { name: 'Null' }, mcp: { defaultParams: null } },
      ],
    });
    expect((c.items[0]?.request as McpRequest).defaultParams).toBe('{"name":"t"}');
    expect((c.items[1]?.request as McpRequest).defaultParams).toBeUndefined();
  });

  it('places entries at the root when folderPath is missing, empty, non-string or unresolvable', () => {
    const c = importExt(
      {
        'x-restura-sse': [
          { info: { name: 'NoPath' } },
          { info: { name: 'Empty' }, folderPath: [] },
          { info: { name: 'BadSeg' }, folderPath: [1] },
          { info: { name: 'Missing' }, folderPath: ['Nope'] },
          // A WebSocket item (a request since #1209) is not a folder — it must
          // never adopt an entry.
          { info: { name: 'IntoWs' }, folderPath: ['Live'] },
          { info: { name: 'Nested' }, folderPath: ['Real'] },
        ],
      },
      [
        { info: { type: 'websocket', name: 'Live' }, websocket: { url: 'wss://x' } },
        { info: { name: 'Real' }, items: [] },
      ]
    );
    const rootNames = c.items.map((i) => i.name);
    expect(rootNames).toEqual(
      expect.arrayContaining(['NoPath', 'Empty', 'BadSeg', 'Missing', 'IntoWs'])
    );
    const real = c.items.find((i) => i.name === 'Real');
    expect(real?.items?.map((i) => i.name)).toEqual(['Nested']);
    const ws = c.items.find((i) => i.name === 'Live');
    expect(ws?.type).toBe('request');
    expect(ws?.request?.type).toBe('websocket');
    expect(ws?.items).toBeUndefined();
  });

  it('re-exports SSE nested two folders deep under a verbatim (unchanged) parent folder', () => {
    const sse: SseRequest = {
      id: 's',
      name: 'Deep',
      type: 'sse',
      url: 'https://e.test/sse',
      headers: [],
      params: [],
      auth: { type: 'none' },
    };
    const inner: WithOC<CollectionItem> = {
      id: 'inner',
      name: 'Inner',
      type: 'folder',
      items: [{ id: 'si', name: 'Deep', type: 'request', request: sse }],
      _oc: { info: { name: 'Inner' }, items: [] },
    };
    // A folder whose `items` was never initialised must not break the walk.
    const empty: WithOC<CollectionItem> = {
      id: 'e',
      name: 'Empty',
      type: 'folder',
      _oc: { info: { name: 'Empty' }, items: [] },
    } as WithOC<CollectionItem>;
    const outer: WithOC<CollectionItem> = {
      id: 'outer',
      name: 'Outer',
      type: 'folder',
      items: [inner, empty],
      _oc: { info: { name: 'Outer' }, items: [{ info: { name: 'Inner' }, items: [] }] },
    };
    const oc = internalToOC({ id: 'c', name: 'C', items: [outer] });
    const sseList = (oc.extensions as Record<string, unknown>)['x-restura-sse'] as Array<
      Record<string, unknown>
    >;
    expect(sseList).toHaveLength(1);
    expect(sseList[0]?.folderPath).toEqual(['Outer', 'Inner']);
  });
});
