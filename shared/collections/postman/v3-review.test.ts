import { describe, expect, it } from 'vitest';
import type {
  CollectionItem,
  HttpRequest,
  KafkaRequest,
  McpRequest,
  MqttRequest,
} from '../../types';
import { importPostmanCollection } from './index';
import { getPostmanSidecar } from './sidecar';
import { readPostmanV3Container } from './v3-container';
import { collectPostmanFolderFiles } from './v3-folder';

/** Review round for #1200: correctness + parity behaviours. */

const v3 = (items: unknown[], extra: Record<string, unknown> = {}) => ({
  $kind: 'collection',
  name: 'C',
  items,
  ...extra,
});
const one = (item: Record<string, unknown>) => importPostmanCollection(v3([item]));
const first = (r: { collection: { items: CollectionItem[] } }) => r.collection.items[0]!;
const kinds = (ws: ReadonlyArray<{ kind: string; construct?: string }>) =>
  ws.map((w) => w.construct ?? w.kind);

describe('S3 security downgrades are reported', () => {
  it('HTTP strictSSL:false, followAuthorizationHeader:true, cipher selection', () => {
    const r = one({
      $kind: 'http-request',
      name: 'R',
      settings: { strictSSL: false, followAuthorizationHeader: true, tlsCipherSelection: ['NULL'] },
    });
    const downgrades = r.report.warnings.filter((w) => w.kind === 'security-downgrade');
    expect(downgrades.map((w) => 'setting' in w && w.setting).sort()).toEqual([
      'followAuthorizationHeader',
      'strictSSL',
      'tlsCipherSelection',
    ]);
    // strictSSL:true is not a downgrade.
    const ok = one({ $kind: 'http-request', name: 'R', settings: { strictSSL: true } });
    expect(ok.report.warnings.filter((w) => w.kind === 'security-downgrade')).toEqual([]);
  });

  it('GraphQL applies mapped settings with the same warnings (C3)', () => {
    const r = one({ $kind: 'graphql-request', name: 'G', settings: { strictSSL: false } });
    expect((first(r).request as HttpRequest).settings).toEqual({ verifySsl: false });
    expect(kinds(r.report.warnings)).toContain('security-downgrade');
  });

  it('Kafka strictSSL:false is reported', () => {
    const r = one({
      $kind: 'kafka-request',
      name: 'K',
      mode: 'producer',
      settings: { strictSSL: false },
    });
    expect(kinds(r.report.warnings)).toContain('security-downgrade');
  });
});

describe('S4 prototype keys in YAML', () => {
  it('a __proto__ key cannot smuggle fields onto a request', () => {
    const { tree } = readPostmanV3Container({
      'r.request.yaml': [
        '$kind: http-request',
        'name: R',
        '__proto__:',
        '  $kind: mcp-request',
        '  transport: stdio',
        '  command: evil --x',
      ].join('\n'),
    });
    const [item] = tree.items as Array<Record<string, unknown>>;
    expect(item?.transport).toBeUndefined();
    expect(Object.getPrototypeOf(item)).toBe(Object.prototype);
    const { collection } = importPostmanCollection(tree);
    expect((collection.items[0]?.request as HttpRequest).type).toBe('http');
  });
});

describe('S6 / S7 sidecar scrub and stdio warning', () => {
  it('settings / scripts / uses kept in the bag are scrubbed', () => {
    const r = importPostmanCollection(
      v3(
        [
          {
            $kind: 'http-request',
            name: 'R',
            settings: { clientCertificatePassphrase: 'PASSPHRASE', maxHeaderSize: 1 },
          },
        ],
        {
          uses: { environment: ['e'], apiKey: 'USES_KEY' },
          scripts: [{ type: 'grpc:beforeInvoke', code: 'x', token: 'SCRIPT_TOKEN' }],
        }
      )
    );
    const text = JSON.stringify(r.collection);
    for (const s of ['PASSPHRASE', 'USES_KEY', 'SCRIPT_TOKEN']) expect(text).not.toContain(s);
  });

  it('stdio warning JSON-quotes argv, lists env names and flags loader variables', () => {
    const r = one({
      $kind: 'mcp-request',
      name: 'S',
      transport: 'stdio',
      command: 'node "a b.js"',
      env: [
        { key: 'NODE_OPTIONS', value: '--require x' },
        { key: 'DYLD_INSERT_LIBRARIES', value: 'y' },
        { key: 'PLAIN', value: 'z' },
      ],
    });
    const w = r.report.warnings.find((x) => 'construct' in x && x.construct === 'mcp-stdio');
    const detail = w && 'detail' in w ? w.detail : '';
    expect(detail).toContain('["node","a b.js"]');
    expect(detail).toContain('desktop-only');
    expect(detail).toMatch(/NODE_OPTIONS.*DYLD_INSERT_LIBRARIES.*PLAIN/);
    expect(detail).toMatch(/loader|preload/i);
    expect(detail).not.toContain('--require x');
  });
});

describe('C1 / C2 / C4 / C5 / C6 / C9 mappings', () => {
  it('folder variables are imported; folder description is kept', () => {
    const r = one({
      $kind: 'collection',
      name: 'F',
      description: 'about F',
      variables: [{ key: 'fv', value: '1' }],
      items: [],
    });
    expect(first(r).variables).toMatchObject([{ key: 'fv', value: '1' }]);
    expect(getPostmanSidecar(first(r))?.description).toBe('about F');
  });

  it('MCP request scripts are mapped', () => {
    const r = one({
      $kind: 'mcp-request',
      name: 'M',
      transport: 'sse',
      scripts: [
        { type: 'beforeRequest', code: 'a' },
        { type: 'afterResponse', code: 'b' },
      ],
    });
    expect(first(r).request as McpRequest).toMatchObject({
      preRequestScript: 'a',
      testScript: 'b',
      transport: 'http-sse',
    });
  });

  it('Kafka scripts are reported and kept, never silently dropped', () => {
    const r = one({
      $kind: 'kafka-request',
      name: 'K',
      mode: 'producer',
      scripts: [{ type: 'beforeProduce', code: 'p' }],
    });
    expect(getPostmanSidecar(first(r))?.scripts).toHaveLength(1);
    expect(kinds(r.report.warnings)).toContain('protocol-scripts');
    expect((first(r).request as KafkaRequest).type).toBe('kafka');
  });

  it('MQTT extra subscription topics and unmapped settings are reported + kept', () => {
    const r = one({
      $kind: 'mqtt-request',
      name: 'M',
      topics: [{ name: 'a' }, { name: 'b' }],
      settings: { strictSSL: false },
    });
    expect((first(r).request as MqttRequest).subscribe.topicFilter).toBe('a');
    expect(getPostmanSidecar(first(r))?.leftovers).toMatchObject({
      topics: [{ name: 'b' }],
      settings: { strictSSL: false },
    });
    expect(kinds(r.report.warnings)).toContain('broker-leftovers');
  });

  it('a collection-wide HTTP script that will also run for other protocols is reported', () => {
    const r = importPostmanCollection(
      v3([{ $kind: 'grpc-request', name: 'G' }], {
        scripts: [{ type: 'http:beforeRequest', code: 'x' }],
      })
    );
    expect(kinds(r.report.warnings)).toContain('collection-script-scope');
    const httpOnly = importPostmanCollection(
      v3([{ $kind: 'http-request', name: 'H' }], {
        scripts: [{ type: 'http:beforeRequest', code: 'x' }],
      })
    );
    expect(kinds(httpOnly.report.warnings)).not.toContain('collection-script-scope');
  });

  it('form-data file rows arrive empty, named after the file, body kept (base4 parity)', () => {
    const r = one({
      $kind: 'http-request',
      name: 'F',
      body: { type: 'formdata', content: [{ type: 'file', key: 'f', src: '/tmp/a.png' }] },
    });
    const row = (first(r).request as HttpRequest).body.formData?.[0];
    expect(row).toMatchObject({ value: '', type: 'file', fileName: 'a.png' });
    expect(getPostmanSidecar(first(r))?.body).toBeDefined();
    expect(kinds(r.report.warnings)).toContain('form-file');
  });
});

describe('C7 / C8 container layout', () => {
  it('non-YAML files under .resources are reported as unread', () => {
    const r = importPostmanCollection(
      readPostmanV3Container({
        'r.request.yaml': '$kind: http-request\nname: R\n',
        '.resources/r.resources/scripts/pre.js': '',
      }).tree
    );
    // The container's own warnings travel through the file-map entry point.
    expect(r.collection.items).toHaveLength(1);
    const files = importPostmanCollection({
      'r.request.yaml': '$kind: http-request\nname: R\n',
      '.resources/r.resources/scripts/pre.js': '',
    });
    expect(kinds(files.report.warnings)).toContain('unread-file');
  });

  it('a lone top-level folder without a root definition is kept as a folder', () => {
    const { tree } = readPostmanV3Container({
      'Users/.resources/definition.yaml': '$kind: collection\norder: 1\n',
      'Users/List.request.yaml': '$kind: http-request\n',
    });
    expect((tree.items as Array<{ name: string }>).map((i) => i.name)).toEqual(['Users']);
  });

  it('a wrapper whose definition names the collection is stripped', () => {
    const { tree } = readPostmanV3Container({
      'Wrap/.resources/definition.yaml': '$kind: collection\nname: Real\n',
      'Wrap/List.request.yaml': '$kind: http-request\n',
    });
    expect(tree.name).toBe('Real');
    expect((tree.items as Array<{ name: string }>).map((i) => i.name)).toEqual(['List']);
  });

  it('a picked folder root is always stripped', () => {
    const { tree } = readPostmanV3Container(
      { 'Picked/Users/List.request.yaml': '$kind: http-request\n' },
      { pickedRoot: true }
    );
    expect(tree.name).toBe('Picked');
    expect((tree.items as Array<{ name: string }>).map((i) => i.name)).toEqual(['Users']);
  });
});

describe('P1 shared folder walk', () => {
  const entry = (path: string, text: string, size = text.length) => ({
    path,
    size,
    read: async () => text,
  });

  it('reads YAML / JSON, records unread .resources files, skips the rest', async () => {
    const files = await collectPostmanFolderFiles([
      entry('C/r.request.yaml', 'x'),
      entry('C/.resources/r.resources/scripts/a.js', 'js'),
      entry('C/logo.png', 'png'),
    ]);
    expect(files).toEqual({ 'C/r.request.yaml': 'x', 'C/.resources/r.resources/scripts/a.js': '' });
  });

  it('applies the caps before reading', async () => {
    await expect(
      collectPostmanFolderFiles([entry('C/r.request.yaml', 'x', 11 * 1024 * 1024)])
    ).rejects.toThrow(/too large/);
    await expect(
      collectPostmanFolderFiles([entry('a.yaml', 'x'), entry('b.yaml', 'y')], { maxFiles: 1 })
    ).rejects.toThrow(/too many files/);
  });
});
