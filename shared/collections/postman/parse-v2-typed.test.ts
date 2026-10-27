import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CollectionItem, HttpRequest } from '../../types';
import { importPostmanCollection } from './index';
import { getPostmanSidecar } from './sidecar';

const FIXTURES = resolve(process.cwd(), 'shared/collections/postman/__fixtures__/v21');
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(resolve(FIXTURES, name), 'utf8')) as unknown;

const V21 = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

function req(item: CollectionItem | undefined): HttpRequest {
  return item?.request as HttpRequest;
}

describe('parsePostmanV2 — secret variables (G2, #1228)', () => {
  const { collection, report } = importPostmanCollection(fixture('secret-variables.json'));
  const folder = collection.items[0]!;
  const request = folder.items![0]!;

  it('collection-level secret variables import value-less and flagged secret', () => {
    expect(collection.variables?.map((v) => [v.key, v.value, v.secret === true])).toEqual([
      ['baseUrl', 'https://api.example.com', false],
      ['apiToken', '', true],
    ]);
  });

  it('folder- and request-level secret variables keep no value in the sidecar', () => {
    expect(getPostmanSidecar(folder)?.variable).toEqual([
      { key: 'folderPlain', value: 'visible', type: 'string' },
      { key: 'folderSecret', type: 'secret' },
    ]);
    expect(getPostmanSidecar(request)?.variable).toEqual([{ key: 'reqSecret', type: 'secret' }]);
  });

  it('no secret plaintext survives anywhere in the imported collection', () => {
    const json = JSON.stringify(collection);
    expect(json).not.toContain('COLLECTION-SECRET-PLAINTEXT');
    expect(json).not.toContain('FOLDER-SECRET-PLAINTEXT');
    expect(json).not.toContain('REQUEST-SECRET-PLAINTEXT');
  });

  it('reports one secret-variable warning per secret, as the v3 path does', () => {
    const secrets = report.warnings.filter(
      (w) => w.kind === 'unmodelled-construct' && w.construct === 'secret-variable'
    );
    expect(secrets.map((w) => w.kind === 'unmodelled-construct' && w.requestName)).toEqual([
      'Secrets',
      'Folder',
      'Request',
    ]);
    expect(secrets[0]).toMatchObject({ detail: expect.stringContaining('apiToken') });
    expect(secrets[1]).toMatchObject({ detail: expect.stringContaining('folderSecret') });
    // Item variables are still reported as unmodelled.
    expect(
      report.warnings.filter(
        (w) => w.kind === 'unmodelled-construct' && w.construct === 'item-variables'
      )
    ).toHaveLength(2);
  });

  it('a disabled secret variable stays disabled and value-less', () => {
    const { collection: c } = importPostmanCollection({
      info: { name: 'C', schema: V21 },
      item: [],
      variable: [{ key: 's', value: 'x', type: 'secret', disabled: true }],
    });
    expect(c.variables).toEqual([
      expect.objectContaining({ key: 's', value: '', enabled: false, secret: true }),
    ]);
  });
});

describe('parsePostmanV2 — off-schema / unsupported auth degrades to none (#1228)', () => {
  const { collection, report } = importPostmanCollection(fixture('off-schema-auth.json'));
  const byName = (name: string) => collection.items.find((i) => i.name === name);

  it.each([
    ['jwt', { type: 'jwt', jwt: expect.any(Array) }],
    ['asap', { type: 'asap', asap: expect.any(Array) }],
    ['akamai', { type: 'akamai', akamai: expect.any(Array) }],
    ['hawk', { type: 'hawk', hawk: [{ key: 'authKey', value: 'HAWK-KEY' }] }],
    ['edgegrid', { type: 'edgegrid', edgegrid: [{ key: 'clientToken', value: 'EG-TOKEN' }] }],
  ])('%s → none + unsupported-auth + raw block in the sidecar', (type, sidecarAuth) => {
    const item = byName(type);
    expect(req(item).auth).toEqual({ type: 'none' });
    expect(getPostmanSidecar(item!)?.auth).toEqual(sidecarAuth);
    expect(report.warnings).toContainEqual({
      kind: 'unsupported-auth',
      authType: type,
      requestName: type,
    });
  });

  it('keeps every jwt / asap / akamai parameter verbatim for reference', () => {
    expect((getPostmanSidecar(byName('jwt')!)?.auth as { jwt: unknown }).jwt).toEqual([
      { key: 'secret', value: 'JWT-SECRET', type: 'string' },
      { key: 'algorithm', value: 'HS256', type: 'string' },
      { key: 'payload', value: '{"sub":"1"}', type: 'string' },
    ]);
    expect((getPostmanSidecar(byName('asap')!)?.auth as { asap: unknown[] }).asap).toHaveLength(3);
    expect(
      (getPostmanSidecar(byName('akamai')!)?.auth as { akamai: unknown[] }).akamai
    ).toHaveLength(2);
  });

  it('sibling auth blocks next to an unsupported type are dropped', () => {
    expect(JSON.stringify(getPostmanSidecar(byName('edgegrid')!))).not.toContain('SIBLING');
  });

  it('an unsupported folder auth cuts inheritance: the child gets none, never a parent credential', () => {
    const folder = byName('jwt-folder')!;
    expect(folder.auth).toBeUndefined();
    expect(getPostmanSidecar(folder)?.auth).toEqual({
      type: 'jwt',
      jwt: [{ key: 'secret', value: 'FOLDER-JWT' }],
    });
    expect(req(folder.items![0]).auth).toEqual({ type: 'none' });
    expect(report.warnings).toContainEqual({
      kind: 'unsupported-auth',
      authType: 'jwt',
      requestName: 'inherits-jwt',
    });
  });
});

describe('parsePostmanV2 — lenient narrowing of off-schema input (#1228)', () => {
  it('tolerates non-schema shapes without throwing', () => {
    const { collection } = importPostmanCollection({
      info: { name: 'C', schema: V21 },
      auth: null,
      variable: [
        'not-an-object',
        { key: 'n', value: 42 },
        { key: 'b', value: true },
        { key: 'o', value: { nested: 1 } },
        { id: 'fromId', value: 'x' },
      ],
      event: 'not-an-array',
      item: [
        null,
        {
          name: 'R',
          event: [{ listen: 'test', script: { exec: ['a()', 7, null] } }],
          request: {
            method: 7,
            url: { host: ['api', 'example', 'com'], path: ['v1', { value: 'x' }], query: 'bad' },
            header: [{ key: 'X', value: 1 }, 'bad'],
            auth: { type: 42 },
            body: { mode: 'raw', raw: 5, options: 'bad' },
          },
        },
      ],
    });
    expect(collection.variables?.map((v) => [v.key, v.value])).toEqual([
      ['n', '42'],
      ['b', 'true'],
      ['o', ''],
      ['fromId', 'x'],
    ]);
    const r = req(collection.items[0]);
    expect(r.method).toBe('GET');
    expect(r.url).toBe('api.example.com/v1/x');
    expect(r.headers.map((h) => [h.key, h.value])).toEqual([['X', '1']]);
    expect(r.auth).toEqual({ type: 'none' });
    expect(r.body).toEqual({ type: 'text', raw: '5' });
    expect(r.testScript).toBe('a()\n7\n');
  });
});
