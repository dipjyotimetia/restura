import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type {
  CollectionItem,
  GrpcRequest,
  HttpRequest,
  KafkaRequest,
  McpRequest,
  MqttRequest,
} from '../../types';
import { importPostmanCollection, importPostmanV3Files } from './index';
import { getPostmanSidecar } from './sidecar';
import { listZipEntryNames, unzipPostmanV3Archive } from './v3-archive';
import {
  isPostmanV3FileMap,
  normaliseEntryPath,
  readPostmanV3Container,
  utf8Length,
} from './v3-container';

/** Edge / defensive-input coverage for the v3 reader and parser (#1200). */

const v3 = (items: unknown[], extra: Record<string, unknown> = {}) => ({
  $kind: 'collection',
  name: 'C',
  items,
  ...extra,
});
const one = (item: Record<string, unknown>) => importPostmanCollection(v3([item]));
const first = (r: { collection: { items: CollectionItem[] } }) => r.collection.items[0]!;
const constructs = (ws: ReadonlyArray<{ kind: string; construct?: string }>) =>
  ws.map((w) => w.construct ?? w.kind);

describe('v3 HTTP edges', () => {
  it('maps every settings key and keeps the unmapped rest', () => {
    const r = one({
      $kind: 'http-request',
      name: 'S',
      url: 'https://x',
      settings: {
        followOriginalHttpMethod: true,
        followAuthorizationHeader: true,
        removeRefererHeaderOnRedirect: true,
        disableCookies: true,
        tlsPreferServerCiphers: true,
        tlsCipherSelection: ['A', 'B'],
        protocolVersion: 'http2',
        insecureHTTPParser: true,
      },
    });
    const req = first(r).request as HttpRequest;
    expect(req.settings).toEqual({
      followOriginalMethod: true,
      followAuthHeader: true,
      stripReferer: true,
      disableCookieJar: true,
      serverCipherOrder: true,
      cipherSuites: 'A:B',
      httpVersion: 'http2',
    });
    expect(getPostmanSidecar(first(r))?.settings).toEqual({ insecureHTTPParser: true });
    expect(constructs(r.report.warnings)).toContain('request-settings');
    const h1 = one({ $kind: 'http-request', name: 'S', settings: { protocolVersion: 'http1' } });
    expect((first(h1).request as HttpRequest).settings).toEqual({ httpVersion: 'http1.1' });
    const auto = one({ $kind: 'http-request', name: 'S', settings: { protocolVersion: 'auto' } });
    expect((first(auto).request as HttpRequest).settings).toBeUndefined();
  });

  it('maps raw html / javascript / text bodies, none, unknown and multi-file parts', () => {
    const body = (b: unknown) =>
      (first(one({ $kind: 'http-request', name: 'B', body: b })).request as HttpRequest).body;
    expect(body({ type: 'html', content: '<p/>' })).toEqual({ type: 'text', raw: '<p/>' });
    expect(body({ type: 'javascript', content: 'x' }).type).toBe('text');
    expect(body({ type: 'text', content: 'x' }).type).toBe('text');
    expect(body({ type: 'none' })).toEqual({ type: 'none' });
    expect(body({ type: 'weird' })).toEqual({ type: 'none' });
    expect(body('nope')).toEqual({ type: 'none' });
    expect(
      body({
        type: 'formdata',
        content: [{ type: 'file', key: 'f', src: ['/a', '/b'], disabled: true }, 'junk'],
      }).formData
    ).toMatchObject([{ key: 'f', value: '', fileName: 'a', enabled: false, type: 'file' }]);
    expect(body({ type: 'graphql', content: 'x' })).toEqual({ type: 'graphql', raw: '' });
  });

  it('shadowed and unknown request scripts go to the sidecar', () => {
    const r = one({
      $kind: 'http-request',
      name: 'Sc',
      scripts: [
        { type: 'beforeRequest', code: 'a' },
        { type: 'beforeRequest', code: 'b' },
        { type: 'afterResponse', code: 'c' },
        { type: 'afterResponse', code: 'd', requests: { r: { workspace: 'w' } } },
        { type: 'mystery', code: 'e' },
        { type: 'beforeRequest' },
        'junk',
      ],
    });
    const req = first(r).request as HttpRequest;
    expect([req.preRequestScript, req.testScript]).toEqual(['b', 'd']);
    expect(getPostmanSidecar(first(r))?.event).toHaveLength(2);
    expect(getPostmanSidecar(first(r))?.scripts).toHaveLength(1);
    expect(constructs(r.report.warnings)).toEqual(
      expect.arrayContaining(['script-packages', 'extra-events', 'protocol-scripts'])
    );
  });

  it('defaults names, keeps descriptions, and inherits collection auth', () => {
    const r = importPostmanCollection(
      v3(
        [
          { $kind: 'http-request', url: 'https://x', description: 'doc' },
          { $kind: 'collection', items: [{ $kind: 'http-request', name: 'N' }] },
          'junk',
        ],
        { name: '', auth: { type: 'bearer', credentials: [{ key: 'token', value: 't' }] } }
      )
    );
    expect(r.collection.name).toBe('Imported Collection');
    const req = first(r).request as HttpRequest;
    expect(req).toMatchObject({ name: 'Unnamed Request', description: 'doc' });
    expect(req.auth).toEqual({ type: 'bearer', bearer: { token: 't' } });
    expect(r.collection.items[1]?.name).toBe('Unnamed Folder');
  });

  it('a single rule-bound credential set is still reported as multi-auth', () => {
    const r = importPostmanCollection(
      v3([], {
        auth: [{ id: '1', name: 'a', type: 'noauth', rules: [{ key: 'url', value: 'x' }] }],
      })
    );
    expect(constructs(r.report.warnings)).toContain('multi-auth');
    expect(importPostmanCollection(v3([], { auth: [] })).collection.auth).toBeUndefined();
  });

  it('an approximated oauth2 grant keeps only the unmapped remainder', () => {
    const r = one({
      $kind: 'http-request',
      name: 'O',
      auth: {
        type: 'oauth2',
        credentials: [
          { key: 'grant_type', value: 'implicit' },
          { key: 'clientSecret', value: 'MAPPED' },
        ],
      },
    });
    expect(JSON.stringify(getPostmanSidecar(first(r)))).not.toContain('MAPPED');
    expect(constructs(r.report.warnings)).toContain('oauth2-grant');
  });

  it('collection uses / disabled variables / examples on non-HTTP kinds', () => {
    const r = importPostmanCollection(
      v3(
        [
          {
            $kind: 'graphql-request',
            name: 'G',
            schema: { type: 'url', url: 'https://s' },
            settings: { disabledSystemHeaders: ['accept'] },
            examples: [{ name: 'e', response: { statusCode: 200, body: 'raw' } }, 'junk'],
          },
        ],
        {
          uses: { environment: ['e1'] },
          variables: [{ key: 'v', value: 'x', disabled: true }, 'junk'],
        }
      )
    );
    expect(r.collection.variables).toMatchObject([{ key: 'v', enabled: false }]);
    expect(getPostmanSidecar(r.collection)?.uses).toEqual({ environment: ['e1'] });
    const bag = getPostmanSidecar(first(r));
    expect(bag?.schema).toBeDefined();
    expect(bag?.response).toHaveLength(2);
    expect(constructs(r.report.warnings)).toEqual(
      expect.arrayContaining(['collection-uses', 'schema-reference', 'saved-responses'])
    );
  });
});

describe('v3 non-HTTP edges', () => {
  it('grpc: method path without a service, settings kept', () => {
    const r = one({
      $kind: 'grpc-request',
      name: 'G',
      methodPath: 'Ping',
      settings: { connectionTimeout: 1 },
    });
    expect(first(r).request as GrpcRequest).toMatchObject({ service: '', method: 'Ping' });
    expect(getPostmanSidecar(first(r))?.settings).toEqual({ connectionTimeout: 1 });
  });

  it('mqtt: last will, no messages, broker auth goes to the bag', () => {
    const r = one({
      $kind: 'mqtt-request',
      name: 'M',
      url: 'mqtt://b',
      lastWill: { topic: 'bye', payload: 'x', qos: 1, retain: true },
      topics: [{ name: 'a', subscribe: false }],
      auth: { type: 'basic', credentials: [{ key: 'password', value: 'P' }] },
    });
    const req = first(r).request as MqttRequest;
    expect(req.connection.lwt).toEqual({ topic: 'bye', payload: 'x', qos: 1, retain: true });
    expect(req.subscribe.topicFilter).toBe('a');
    expect(getPostmanSidecar(first(r))?.auth).toBeDefined();
    expect(r.report.warnings.some((w) => w.kind === 'unsupported-auth')).toBe(true);
    const bare = one({ $kind: 'mqtt-request', name: 'M2' });
    expect((first(bare).request as MqttRequest).publish.topic).toBe('');
  });

  it('kafka: consumer from end / timestamp, stopAfter + extra messages kept', () => {
    const consume = (start: unknown) =>
      first(
        one({
          $kind: 'kafka-request',
          name: 'K',
          mode: 'consumer',
          topics: [{ name: 't' }],
          startPosition: start,
          stopAfter: { maxRecords: 1 },
          settings: { secureConnection: true, strictSSL: false },
        })
      );
    const end = consume({ type: 'end' });
    expect((end.request as KafkaRequest).consume.mode).toBe('latest');
    expect((end.request as KafkaRequest).connection).toMatchObject({
      securityProtocol: 'SSL',
      tls: { rejectUnauthorized: false },
    });
    expect(getPostmanSidecar(end)?.leftovers).toEqual({ stopAfter: { maxRecords: 1 } });
    expect(
      (consume({ type: 'timestamp', timestamp: 1 }).request as KafkaRequest).consume.mode
    ).toBe('timestamp');
    expect((consume(undefined).request as KafkaRequest).consume.mode).toBe('committed');
    const produce = first(
      one({
        $kind: 'kafka-request',
        name: 'P',
        mode: 'producer',
        messages: [
          { $kind: 'kafka-message', name: 'a', topic: 'x' },
          { $kind: 'kafka-message', name: 'b', topic: 'y' },
        ],
      })
    );
    expect((produce.request as KafkaRequest).produce.topic).toBe('x');
    expect(getPostmanSidecar(produce)?.leftovers).toMatchObject({ messages: [{ name: 'b' }] });
    const empty = first(one({ $kind: 'kafka-request', name: 'E', mode: 'producer' }));
    expect((empty.request as KafkaRequest).produce.topic).toBe('');
  });

  it('mcp: legacy transport, non-JSON message, quoted stdio args, settings kept', () => {
    const legacy = first(
      one({
        $kind: 'mcp-request',
        name: 'L',
        transport: 'sse',
        url: 'https://m',
        settings: { version: 'legacy', requestTimeout: 5 },
        message: 'not json',
      })
    );
    expect(legacy.request as McpRequest).toMatchObject({ transport: 'http-sse' });
    expect((legacy.request as McpRequest).defaultMethod).toBeUndefined();
    expect(getPostmanSidecar(legacy)?.settings).toEqual({ version: 'legacy', requestTimeout: 5 });
    const noParams = first(
      one({ $kind: 'mcp-request', name: 'N', transport: 'sse', message: '{"method":"ping"}' })
    );
    expect(noParams.request as McpRequest).toMatchObject({ defaultMethod: 'ping' });
    const stdio = first(
      one({
        $kind: 'mcp-request',
        name: 'S',
        transport: 'stdio',
        command: `node "my server.js" '' --flag`,
        env: [{ key: 'K', value: 'v', disabled: true }],
      })
    );
    // stdio imports disabled: a placeholder holding the launch shape only.
    expect(stdio.type).toBe('folder');
    expect(getPostmanSidecar(stdio)?.item).toMatchObject({
      argv: ['node', 'my server.js', '', '--flag'],
      env: [{ key: 'K', disabled: true }],
    });
    expect(JSON.stringify(stdio)).not.toContain('"v"');
    const blank = first(one({ $kind: 'mcp-request', name: 'B', transport: 'stdio' }));
    expect(blank).toMatchObject({ type: 'folder', name: 'B (MCP stdio, disabled)' });
    expect(getPostmanSidecar(blank)?.item).toMatchObject({ argv: [], env: [] });
  });

  it('unknown kinds become a placeholder; their auth goes to the bag', () => {
    const r = one({
      $kind: 'future-request',
      name: 'F',
      auth: { type: 'bearer', credentials: [{ key: 'token', value: 'T' }] },
    });
    expect(first(r).name).toBe('F (future-request)');
    expect(getPostmanSidecar(first(r))?.auth).toBeDefined();
    expect(first(one({ name: 'X' })).name).toBe('X (unknown kind)');
  });

  it('refuses folders nested past the cap', () => {
    let node: Record<string, unknown> = { $kind: 'http-request', name: 'leaf' };
    for (let i = 0; i < 70; i++) node = { $kind: 'collection', name: `f${i}`, items: [node] };
    expect(() => importPostmanCollection(v3([node]))).toThrowError(/nest/);
  });
});

describe('v3 container edges', () => {
  it('reads definition.yaml beside requests, .yml, string orders and inline example arrays', () => {
    const { tree } = readPostmanV3Container({
      'C/definition.yaml': '$kind: collection\nname: Root\n',
      'C/F/definition.yml': '$kind: collection\nname: Named folder\norder: b\n',
      'C/A.request.yml': '$kind: http-request\norder: a\nexamples: [{ name: e }]\n',
      'C/Z.request.yaml': '$kind: http-request\norder: 5\nheaders: { X-A: 1, X-B: null }\n',
      'C/Q.request.yaml': '$kind: http-request\nqueryParams: { q: { nested: true } }\n',
      'C/README.md': '# ignored',
      '__MACOSX/C/._A.request.yaml': 'junk',
      'C/.DS_Store': 'junk',
    });
    expect(tree.name).toBe('Root');
    const items = tree.items as Array<Record<string, unknown>>;
    expect(items.map((i) => i.name)).toEqual(['Z', 'A', 'Named folder', 'Q']);
    expect(items[0]?.headers).toEqual([
      { key: 'X-A', value: '1' },
      { key: 'X-B', value: '' },
    ]);
    expect(items[1]?.examples).toEqual([{ name: 'e' }]);
    expect(items[3]?.queryParams).toEqual([{ key: 'q', value: '{"nested":true}' }]);
  });

  it('resolves `..` inside an examples reference that stays in the root', () => {
    const { tree } = readPostmanV3Container({
      'F/R.request.yaml':
        '$kind: http-request\nexamples: ./sub/../.resources/R.resources/examples\n',
      'F/.resources/R.resources/examples/b.example.yaml': '$kind: http-example\norder: 2\n',
      'F/.resources/R.resources/examples/a.example.yaml': '$kind: http-example\norder: 1\n',
      'F/.resources/R.resources/examples/nested/x.example.yaml': '$kind: http-example\n',
    });
    // `F/` has no root definition naming the collection, so it stays a folder.
    const [folder] = tree.items as Array<{ items: Array<{ examples: Array<{ name: string }> }> }>;
    expect(folder?.items[0]?.examples.map((e) => e.name)).toEqual(['a', 'b']);
  });

  it('reports bad input clearly', () => {
    expect(() => readPostmanV3Container({ 'a.request.yaml': 'a: [' })).toThrowError(
      /not valid YAML/
    );
    expect(() => readPostmanV3Container({ 'notes.txt': 'x' })).toThrowError(/no \*\.request\.yaml/);
    expect(() => readPostmanV3Container(42)).toThrowError(/expected/);
    expect(() =>
      readPostmanV3Container({ 'a/./b/': 'x', 'r.request.yaml': '- list\n' })
    ).not.toThrow();
    expect(normaliseEntryPath('dir/')).toBeNull();
    expect(isPostmanV3FileMap({})).toBe(false);
    expect(isPostmanV3FileMap('x')).toBe(false);
  });

  it('counts UTF-8 bytes', () => {
    expect(utf8Length('aé€😀')).toBe(1 + 2 + 3 + 4);
  });

  it('imports a v3 file map end to end, with a request that names itself', () => {
    const r = importPostmanV3Files({ 'x.request.yaml': '$kind: http-request\nname: Own\n' });
    expect(r.collection.items[0]?.name).toBe('Own');
  });
});

describe('v3 archive edges', () => {
  it('lists entry names without inflating and rejects non-zips', () => {
    const zip = zipSync({ 'a/b.request.yaml': strToU8('x'), 'a/': new Uint8Array() });
    expect(listZipEntryNames(zip)).toContain('a/b.request.yaml');
    expect(() => listZipEntryNames(strToU8('not a zip'))).toThrowError(/not a readable zip/);
    expect(() => unzipPostmanV3Archive(strToU8('not a zip'))).toThrowError(/not a readable zip/);
  });

  it('caps per-file size and skips directory / metadata entries', () => {
    const zip = zipSync({
      'big.request.yaml': strToU8('a'.repeat(500)),
      '__MACOSX/x': strToU8('m'),
    });
    expect(() => unzipPostmanV3Archive(zip, { maxFileBytes: 100 })).toThrowError(/too large/);
    expect(Object.keys(unzipPostmanV3Archive(zip))).toEqual(['big.request.yaml']);
  });
});
