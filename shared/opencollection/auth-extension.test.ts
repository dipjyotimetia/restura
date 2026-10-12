import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import type { AuthConfig, Collection, CollectionItem, Request } from '../types';
import { AUTH_EXTENSION_KEY } from './auth-extension';
import { internalToOC } from './from-internal';
import { parseOpenCollectionYAML, serializeOpenCollectionYAML } from './serializer';
import { ocToInternal } from './to-internal';

/**
 * The VS Code extension validates root `opencollection.yml` against the
 * vendored strict OC JSON schema (extension/vscode/package.json
 * `yamlValidation`). Its OAuth1/NTLM/WSSE objects are `additionalProperties:
 * false`, so Restura-only knobs must travel in `x-restura-auth`, never inline.
 */
const SCHEMA = JSON.parse(
  readFileSync(
    resolve(process.cwd(), 'extension/vscode/schemas/opencollection-v1.0.0.json'),
    'utf8'
  )
) as object;
const validate = new Ajv({ strict: false, allErrors: true }).compile(SCHEMA);

const OAUTH1: AuthConfig = {
  type: 'oauth1',
  oauth1: {
    consumerKey: 'ck',
    consumerSecret: 'cs',
    signatureMethod: 'HMAC-SHA256',
    addParamsToBody: true,
  },
};
const NTLM: AuthConfig = {
  type: 'ntlm',
  ntlm: { username: 'alice', password: 'pw', domain: 'CORP', workstation: 'WS01' },
};
const WSSE: AuthConfig = {
  type: 'wsse',
  wsse: { username: 'bob', password: 'pw', passwordType: 'PasswordText' },
};

const http = (name: string, auth: AuthConfig): Request => ({
  id: `h-${name}`,
  name,
  type: 'http',
  method: 'GET',
  url: 'https://api.example.test/x',
  headers: [],
  params: [],
  body: { type: 'none' },
  auth,
});

const item = (r: Request): CollectionItem => ({
  id: `i-${r.id}`,
  name: r.name,
  type: 'request',
  request: r,
});

function fixture({ withGrpc = true } = {}): Collection {
  return {
    id: 'c',
    name: 'Auth extras',
    auth: NTLM,
    items: [
      item(http('Root oauth1', OAUTH1)),
      {
        id: 'f',
        name: 'Secure',
        type: 'folder',
        auth: WSSE,
        items: [item(http('Nested ntlm', NTLM)), ...(withGrpc ? [grpcItem()] : [])],
      },
    ],
  };
}

function grpcItem(): CollectionItem {
  return item({
    id: 'g',
    name: 'Nested grpc',
    type: 'grpc',
    methodType: 'unary',
    url: 'grpc://localhost:50051',
    service: 's.v1.S',
    method: 'M',
    metadata: [],
    message: '{}',
    auth: WSSE,
  });
}

const roundTrip = (c: Collection) =>
  ocToInternal(parseOpenCollectionYAML(serializeOpenCollectionYAML(internalToOC(c))));

describe('x-restura-auth sidecar', () => {
  it('exports with OAuth1/NTLM/WSSE extras validate against the vendored OC JSON schema', () => {
    // gRPC items are left out: the gRPC item mapping itself (e.g. its separate
    // `service` key) predates this sidecar and is not yet schema-strict.
    const oc = parseOpenCollectionYAML(
      serializeOpenCollectionYAML(internalToOC(fixture({ withGrpc: false })))
    );
    const ok = validate(oc);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it('keeps the extras out of the auth objects and in the extension', () => {
    const oc = internalToOC(fixture());
    const yaml = serializeOpenCollectionYAML(oc);
    const authBlocks = yaml
      .split('\n')
      .filter((l) => /^\s+(addParamsToBody|workstation|passwordType):/.test(l));
    // Every occurrence lives under extensions.x-restura-auth.
    expect(authBlocks.length).toBe(5);
    expect(yaml.indexOf('x-restura-auth')).toBeLessThan(yaml.indexOf('addParamsToBody'));
    expect((oc.extensions as Record<string, unknown>)[AUTH_EXTENSION_KEY]).toEqual({
      entries: [
        { target: 'collection', path: [], type: 'ntlm', workstation: 'WS01' },
        { target: 'folder', path: ['Secure'], type: 'wsse', passwordType: 'PasswordText' },
        { target: 'request', path: ['Root oauth1'], type: 'oauth1', addParamsToBody: true },
        {
          target: 'request',
          path: ['Secure', 'Nested grpc'],
          type: 'wsse',
          passwordType: 'PasswordText',
        },
        { target: 'request', path: ['Secure', 'Nested ntlm'], type: 'ntlm', workstation: 'WS01' },
      ],
    });
  });

  it('round-trips the extras on collection, folder and nested requests', () => {
    const back = roundTrip(fixture());
    expect(back.auth).toEqual(NTLM);
    const folder = back.items.find((i) => i.name === 'Secure');
    expect(folder?.auth).toEqual(WSSE);
    expect(back.items.find((i) => i.name === 'Root oauth1')?.request?.auth).toEqual(OAUTH1);
    const nested = folder?.items ?? [];
    expect(nested.find((i) => i.name === 'Nested ntlm')?.request?.auth).toEqual(NTLM);
    expect(nested.find((i) => i.name === 'Nested grpc')?.request?.auth).toEqual(WSSE);
  });

  it('an unchanged import re-exports byte-identically', () => {
    const yaml = serializeOpenCollectionYAML(internalToOC(fixture()));
    const imported = ocToInternal(parseOpenCollectionYAML(yaml));
    expect(serializeOpenCollectionYAML(internalToOC(imported))).toBe(yaml);
  });

  it('an extras-only edit on the collection auth reaches the re-export', () => {
    const imported = ocToInternal(
      parseOpenCollectionYAML(serializeOpenCollectionYAML(internalToOC(fixture())))
    );
    // Edit only the schema-less knob; the OC auth block itself is unchanged.
    imported.auth = { type: 'ntlm', ntlm: { ...NTLM.ntlm!, workstation: 'WS99' } };
    const back = roundTrip(imported);
    expect(back.auth?.ntlm?.workstation).toBe('WS99');
  });

  it('ignores entries whose auth type no longer matches the node', () => {
    const back = ocToInternal(
      parseOpenCollectionYAML(`opencollection: 1.0.0
info:
  name: Stale
request:
  auth:
    type: basic
    username: u
    password: p
items: []
extensions:
  x-restura-auth:
    entries:
      - target: collection
        path: []
        type: ntlm
        workstation: WS01
`)
    );
    expect(back.auth).toEqual({ type: 'basic', basic: { username: 'u', password: 'p' } });
  });
});
