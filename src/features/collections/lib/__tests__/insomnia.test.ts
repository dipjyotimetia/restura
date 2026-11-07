import { describe, expect, it } from 'vitest';
import type { HttpRequest, InsomniaCollection, InsomniaV5Document } from '@/types';
import { requestOf } from '../../../../../tests/helpers/requestOf';
import { getInsomniaVersion, importInsomniaCollection } from '../importers/insomnia';
import { validateImportedCollection } from '../importers/validateImported';

/**
 * Hand-authored Insomnia v4 fixtures inline. JSON-on-disk fixtures land in a
 * later task — keeping these self-contained makes the test resilient to the
 * fixture directory churn Task 35 will introduce.
 */
function makeFixture(resources: InsomniaCollection['resources']): InsomniaCollection {
  return {
    _type: 'export',
    __export_format: 4,
    __export_source: 'insomnia.desktop.app',
    resources,
  };
}

describe('importInsomniaCollection', () => {
  it('returns a unified ImportResult with empty warnings on a clean fixture', () => {
    const result = importInsomniaCollection(
      makeFixture([
        { _id: 'wrk_1', _type: 'workspace', name: 'My Workspace' },
        {
          _id: 'req_1',
          _type: 'request',
          name: 'Hello',
          method: 'GET',
          url: 'https://example.com',
          parentId: 'wrk_1',
        },
      ])
    );

    expect(result.collection.name).toBe('My Workspace');
    expect(result.collection.items).toHaveLength(1);
    expect(result.environments).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  it('preserves Insomnia 8+ pre-request and after-response scripts', () => {
    const result = importInsomniaCollection(
      makeFixture([
        { _id: 'wrk_1', _type: 'workspace', name: 'WS' },
        {
          _id: 'req_1',
          _type: 'request',
          name: 'Scripted',
          method: 'POST',
          url: 'https://example.com/login',
          parentId: 'wrk_1',
          preRequestScript: 'pm.environment.set("nonce", Date.now())',
          afterResponseScript: 'pm.test("ok", () => pm.response.to.have.status(200))',
        },
      ])
    );

    const item = result.collection.items[0]!;
    expect(item.type).toBe('request');
    const req = item.request!;
    expect(req.type).toBe('http');
    if (req.type !== 'http') throw new Error('expected http');
    // Insomnia uses pm.*; Restura normalizes to its native rs.* namespace on import.
    expect(req.preRequestScript).toBe('rs.environment.set("nonce", Date.now())');
    expect(req.testScript).toBe('rs.test("ok", () => rs.response.to.have.status(200))');
  });

  it('omits script fields when the source string is empty or whitespace-only', () => {
    const result = importInsomniaCollection(
      makeFixture([
        { _id: 'wrk_1', _type: 'workspace', name: 'WS' },
        {
          _id: 'req_1',
          _type: 'request',
          name: 'NoScripts',
          method: 'GET',
          url: 'https://example.com',
          parentId: 'wrk_1',
          preRequestScript: '',
          afterResponseScript: '   \n  ',
        },
      ])
    );

    const req = result.collection.items[0]!.request!;
    if (req.type !== 'http') throw new Error('expected http');
    expect(req.preRequestScript).toBeUndefined();
    expect(req.testScript).toBeUndefined();
  });

  it('preserves the base environment and its sub-environments', () => {
    const result = importInsomniaCollection(
      makeFixture([
        { _id: 'wrk_1', _type: 'workspace', name: 'WS' },
        {
          _id: 'env_base',
          _type: 'environment',
          name: 'Base Env',
          parentId: 'wrk_1',
          data: { baseUrl: 'https://api.example.com', apiVersion: 'v1' },
        },
        {
          _id: 'env_dev',
          _type: 'environment',
          name: 'Development',
          parentId: 'env_base',
          data: { baseUrl: 'https://dev.example.com' },
        },
        {
          _id: 'env_prod',
          _type: 'environment',
          name: 'Production',
          parentId: 'env_base',
          data: { baseUrl: 'https://prod.example.com' },
        },
      ])
    );

    // Base and children keep their Insomnia inheritance instead of flattening.
    const base = result.environments?.find((environment) => environment.name === 'Base Env');
    const baseVars = base?.variables ?? [];
    expect(baseVars.map((v) => v.key).sort()).toEqual(['apiVersion', 'baseUrl']);
    const baseUrlVar = baseVars.find((v) => v.key === 'baseUrl');
    expect(baseUrlVar?.value).toBe('https://api.example.com');

    expect(result.environments).toHaveLength(3);
    const names = result.environments!.map((e) => e.name).sort();
    expect(names).toEqual(['Base Env', 'Development', 'Production']);
    const dev = result.environments!.find((e) => e.name === 'Development');
    expect(dev?.variables[0]?.key).toBe('baseUrl');
    expect(dev?.variables[0]?.value).toBe('https://dev.example.com');
    expect(dev?.parentId).toBe(base?.id);
  });

  it('preserves an Insomnia base environment even when it has no children', () => {
    const result = importInsomniaCollection(
      makeFixture([
        { _id: 'wrk_1', _type: 'workspace', name: 'WS' },
        {
          _id: 'env_base',
          _type: 'environment',
          name: 'Base',
          parentId: 'wrk_1',
          data: { foo: 'bar' },
        },
      ])
    );
    expect(result.collection.variables).toBeUndefined();
    expect(result.environments).toEqual([
      expect.objectContaining({
        name: 'Base',
        variables: [expect.objectContaining({ key: 'foo' })],
      }),
    ]);
  });

  it('preserves every OAuth2 flow field (clientId, secret, tokenUrl, etc.)', () => {
    const result = importInsomniaCollection(
      makeFixture([
        { _id: 'wrk_1', _type: 'workspace', name: 'WS' },
        {
          _id: 'req_1',
          _type: 'request',
          name: 'OAuthed',
          method: 'GET',
          url: 'https://api.example.com/me',
          parentId: 'wrk_1',
          authentication: {
            type: 'oauth2',
            grantType: 'client_credentials',
            clientId: 'client-abc',
            clientSecret: 'secret-xyz',
            accessTokenUrl: 'https://auth.example.com/token',
            authorizationUrl: 'https://auth.example.com/authorize',
            scope: 'read write',
            redirectUri: 'https://app.example.com/cb',
            accessToken: 'cached-token',
          },
        },
      ])
    );

    const req = result.collection.items[0]!.request!;
    if (req.type !== 'http') throw new Error('expected http');
    expect(req.auth.type).toBe('oauth2');
    const oauth2 = req.auth.oauth2!;
    expect(oauth2.grantType).toBe('client_credentials');
    expect(oauth2.clientId).toBe('client-abc');
    expect(oauth2.clientSecret).toBe('secret-xyz');
    expect(oauth2.tokenUrl).toBe('https://auth.example.com/token');
    expect(oauth2.authorizationUrl).toBe('https://auth.example.com/authorize');
    expect(oauth2.scope).toBe('read write');
    expect(oauth2.redirectUri).toBe('https://app.example.com/cb');
    expect(oauth2.accessToken).toBe('cached-token');
  });

  it('preserves OAuth2 password-grant username and password fields', () => {
    const result = importInsomniaCollection(
      makeFixture([
        { _id: 'wrk_1', _type: 'workspace', name: 'WS' },
        {
          _id: 'req_1',
          _type: 'request',
          name: 'PwGrant',
          method: 'POST',
          url: 'https://api.example.com/op',
          parentId: 'wrk_1',
          authentication: {
            type: 'oauth2',
            grantType: 'password',
            clientId: 'cid',
            accessTokenUrl: 'https://auth.example.com/token',
            username: 'alice',
            password: 'p4ssw0rd',
          },
        },
      ])
    );

    const req = result.collection.items[0]!.request!;
    if (req.type !== 'http') throw new Error('expected http');
    const oauth2 = req.auth.oauth2!;
    expect(oauth2.grantType).toBe('password');
    expect(oauth2.username).toBe('alice');
    expect(oauth2.password).toBe('p4ssw0rd');
  });

  it('still imports basic, bearer, api-key, and digest auth types correctly', () => {
    const result = importInsomniaCollection(
      makeFixture([
        { _id: 'wrk_1', _type: 'workspace', name: 'WS' },
        {
          _id: 'req_basic',
          _type: 'request',
          name: 'Basic',
          method: 'GET',
          url: 'https://example.com',
          parentId: 'wrk_1',
          authentication: { type: 'basic', username: 'u', password: 'p' },
        },
        {
          _id: 'req_bearer',
          _type: 'request',
          name: 'Bearer',
          method: 'GET',
          url: 'https://example.com',
          parentId: 'wrk_1',
          authentication: { type: 'bearer', token: 'tkn' },
        },
        {
          _id: 'req_apikey',
          _type: 'request',
          name: 'ApiKey',
          method: 'GET',
          url: 'https://example.com',
          parentId: 'wrk_1',
          authentication: { type: 'apikey', key: 'X-API', value: 'v', addTo: 'queryParams' },
        },
        {
          _id: 'req_digest',
          _type: 'request',
          name: 'Digest',
          method: 'GET',
          url: 'https://example.com',
          parentId: 'wrk_1',
          authentication: { type: 'digest', username: 'u', password: 'p' },
        },
      ])
    );

    const auths = result.collection.items.map((i) => requestOf(i).auth);
    expect(auths[0]?.type).toBe('basic');
    expect(auths[0]?.basic?.username).toBe('u');
    expect(auths[1]?.type).toBe('bearer');
    expect(auths[1]?.bearer?.token).toBe('tkn');
    expect(auths[2]?.type).toBe('api-key');
    expect(auths[2]?.apiKey?.in).toBe('query');
    expect(auths[3]?.type).toBe('digest');
  });

  it('warns on unsupported auth types instead of silently dropping them', () => {
    const result = importInsomniaCollection(
      makeFixture([
        { _id: 'wrk_1', _type: 'workspace', name: 'WS' },
        {
          _id: 'req_ntlm',
          _type: 'request',
          name: 'NTLM call',
          method: 'GET',
          url: 'https://example.com',
          parentId: 'wrk_1',
          authentication: { type: 'ntlm', username: 'u', password: 'p' },
        },
      ])
    );

    expect(requestOf(result.collection.items[0]).auth.type).toBe('none');
    expect(result.warnings).toEqual([
      { kind: 'unsupported-auth', authType: 'ntlm', requestName: 'NTLM call' },
    ]);
  });

  it('throws a clear error on an unrecognized export shape', () => {
    expect(() => importInsomniaCollection({ foo: 'bar' })).toThrow(/Unrecognized Insomnia export/);
  });
});

describe('importInsomniaCollection — v4 item identity', () => {
  const allIds = (items: Array<{ id: string; items?: unknown[] }>): string[] =>
    items.flatMap((it) => [
      it.id,
      ...allIds((it.items ?? []) as Array<{ id: string; items?: unknown[] }>),
    ]);

  const fixture = () =>
    makeFixture([
      { _id: 'wrk_1', _type: 'workspace', name: 'WS' },
      { _id: 'fld_1', _type: 'request_group', name: 'Folder', parentId: 'wrk_1' },
      {
        _id: 'req_1',
        _type: 'request',
        name: 'Nested',
        method: 'GET',
        url: 'https://example.com',
        parentId: 'fld_1',
      },
    ]);

  it('generates fresh item ids so importing twice never collides', () => {
    const first = importInsomniaCollection(fixture());
    const second = importInsomniaCollection(fixture());
    const a = allIds(first.collection.items);
    const b = allIds(second.collection.items);
    expect(a).toHaveLength(2);
    expect(a).not.toContain('fld_1');
    expect(a).not.toContain('req_1');
    expect(a.filter((id) => b.includes(id))).toEqual([]);
    // Parent linking still uses the source ids.
    const folder = first.collection.items[0]!;
    expect(folder.type).toBe('folder');
    expect(folder.items?.map((i) => i.name)).toEqual(['Nested']);
  });

  it('attaches a self-parented folder to the root instead of nesting it into itself', () => {
    const result = importInsomniaCollection(
      makeFixture([
        { _id: 'wrk_1', _type: 'workspace', name: 'WS' },
        { _id: 'fld_self', _type: 'request_group', name: 'Self', parentId: 'fld_self' },
      ])
    );
    expect(result.collection.items).toHaveLength(1);
    expect(result.collection.items[0]!.name).toBe('Self');
    expect(result.collection.items[0]!.items).toEqual([]);
  });

  it('breaks a parentId cycle by attaching to the root', () => {
    const result = importInsomniaCollection(
      makeFixture([
        { _id: 'wrk_1', _type: 'workspace', name: 'WS' },
        { _id: 'fld_a', _type: 'request_group', name: 'A', parentId: 'fld_b' },
        { _id: 'fld_b', _type: 'request_group', name: 'B', parentId: 'fld_a' },
      ])
    );
    // Every folder is reachable from the root, and the tree is finite.
    const names = (items: typeof result.collection.items): string[] =>
      items.flatMap((i) => [i.name, ...names(i.items ?? [])]);
    expect(names(result.collection.items).sort()).toEqual(['A', 'B']);
    expect(() => JSON.stringify(result.collection)).not.toThrow();
  });
});

describe('getInsomniaVersion', () => {
  it('detects v4 by __export_format', () => {
    expect(getInsomniaVersion({ _type: 'export', __export_format: 4, resources: [] })).toBe(4);
  });
  it('detects v5 by the collection.insomnia.rest/5 type', () => {
    expect(getInsomniaVersion({ type: 'collection.insomnia.rest/5.0', collection: [] })).toBe(5);
  });
  it('returns null for anything else', () => {
    expect(getInsomniaVersion({ foo: 'bar' })).toBeNull();
    expect(getInsomniaVersion(null)).toBeNull();
    expect(getInsomniaVersion('string')).toBeNull();
  });
});

describe('importInsomniaCollection — v5', () => {
  function makeV5(
    collection: InsomniaV5Document['collection'],
    environments?: InsomniaV5Document['environments']
  ): InsomniaV5Document {
    return {
      type: 'collection.insomnia.rest/5.0',
      name: 'My v5 Collection',
      ...(environments ? { environments } : {}),
      collection,
    };
  }

  it('maps nested folders (children) and requests into the internal tree', () => {
    const result = importInsomniaCollection(
      makeV5([
        { name: 'Root Request', method: 'GET', url: 'https://example.com/root' },
        {
          name: 'Folder A',
          children: [
            { name: 'Nested Request', method: 'POST', url: 'https://example.com/nested' },
            {
              name: 'Folder B',
              children: [{ name: 'Deep Request', method: 'GET', url: 'https://example.com/deep' }],
            },
          ],
        },
      ])
    );

    expect(result.collection.name).toBe('My v5 Collection');
    expect(result.collection.items).toHaveLength(2);

    const [rootReq, folderA] = result.collection.items;
    expect(rootReq?.type).toBe('request');
    expect(requestOf(rootReq).url).toBe('https://example.com/root');

    expect(folderA?.type).toBe('folder');
    expect(folderA?.items).toHaveLength(2);
    const nested = folderA?.items?.[0]?.request;
    if (nested?.type !== 'http') throw new Error('expected http request');
    expect(nested.method).toBe('POST');

    const folderB = folderA?.items?.[1];
    expect(folderB?.type).toBe('folder');
    expect(folderB?.items?.[0]?.request?.name).toBe('Deep Request');
  });

  it('maps base and subEnvironments to one collection-owned hierarchy', () => {
    const result = importInsomniaCollection(
      makeV5([{ name: 'R', method: 'GET', url: 'https://x' }], {
        name: 'Base',
        data: { base_url: 'https://api.example.com', token: 'abc' },
        subEnvironments: [{ name: 'Staging', data: { base_url: 'https://staging.example.com' } }],
      })
    );

    expect(result.collection.variables).toBeUndefined();
    const base = result.environments?.find((environment) => environment.name === 'Base');
    expect(base?.variables).toEqual([
      { id: expect.any(String), key: 'base_url', value: 'https://api.example.com', enabled: true },
      { id: expect.any(String), key: 'token', value: 'abc', enabled: true },
    ]);
    expect(result.environments).toHaveLength(2);
    const staging = result.environments?.find((environment) => environment.name === 'Staging');
    expect(staging?.parentId).toBe(base?.id);
    expect(staging?.variables[0]?.value).toBe('https://staging.example.com');
  });

  it('maps v5 request fields: headers, params, json body, auth, and scripts', () => {
    const result = importInsomniaCollection(
      makeV5([
        {
          name: 'Full Request',
          method: 'POST',
          url: 'https://example.com/api',
          headers: [{ name: 'Content-Type', value: 'application/json' }],
          parameters: [{ name: 'q', value: 'search' }],
          body: { mimeType: 'application/json', text: '{"a":1}' },
          authentication: { type: 'bearer', token: 'tok-123' },
          scripts: {
            preRequest: 'pm.environment.set("x", 1)',
            afterResponse: 'pm.test("ok", ()=>{})',
          },
        },
      ])
    );

    const req = result.collection.items[0]?.request;
    if (req?.type !== 'http') throw new Error('expected http request');
    expect(req.method).toBe('POST');
    expect(req.headers[0]).toMatchObject({ key: 'Content-Type', value: 'application/json' });
    expect(req.params[0]).toMatchObject({ key: 'q', value: 'search' });
    expect(req.body.type).toBe('json');
    expect(req.body.raw).toBe('{"a":1}');
    expect(req.auth.type).toBe('bearer');
    expect(req.auth.bearer?.token).toBe('tok-123');
    // pm.* migrated to rs.*
    expect(req.preRequestScript).toContain('rs.');
    expect(req.testScript).toContain('rs.');
  });

  it('warns on unsupported v5 auth', () => {
    const result = importInsomniaCollection(
      makeV5([
        {
          name: 'AWS call',
          method: 'GET',
          url: 'https://example.com',
          authentication: { type: 'awsv4', accessKeyId: 'k' },
        },
      ])
    );
    expect(requestOf(result.collection.items[0]).auth.type).toBe('none');
    expect(result.warnings).toEqual([
      { kind: 'unsupported-auth', authType: 'awsv4', requestName: 'AWS call' },
    ]);
  });

  it('maps a known OAuth2 grant type', () => {
    const result = importInsomniaCollection(
      makeV5([
        {
          name: 'CC',
          method: 'GET',
          url: 'https://example.com',
          authentication: { type: 'oauth2', grantType: 'client_credentials', accessToken: 't' },
        },
      ])
    );
    const auth = requestOf(result.collection.items[0]).auth;
    expect(auth?.type).toBe('oauth2');
    expect(auth?.oauth2?.grantType).toBe('client_credentials');
  });

  it('does not fail validation on an unmodeled OAuth2 grant type (implicit)', () => {
    const result = importInsomniaCollection(
      makeV5([
        {
          name: 'Implicit',
          method: 'GET',
          url: 'https://example.com',
          authentication: { type: 'oauth2', grantType: 'implicit', accessToken: 't' },
        },
      ])
    );
    const auth = requestOf(result.collection.items[0]).auth;
    expect(auth?.type).toBe('oauth2');
    // implicit is not in our enum; it must be omitted (not passed through raw),
    // otherwise collectionSchema.safeParse rejects and the whole import is lost.
    expect(auth?.oauth2?.grantType).toBeUndefined();
    expect(validateImportedCollection(result.collection)).toEqual({ ok: true });
  });
});

describe('importInsomniaCollection — Nunjucks templates', () => {
  const makeV5 = (collection: InsomniaV5Document['collection']): InsomniaV5Document => ({
    type: 'collection.insomnia.rest/5.0',
    name: 'V5',
    collection,
  });

  it('translates {{ _.var }} forms to {{var}} across url, params, headers, body and auth', () => {
    const result = importInsomniaCollection(
      makeFixture([
        { _id: 'wrk_1', _type: 'workspace', name: 'W' },
        {
          _id: 'env_1',
          _type: 'environment',
          name: 'Base',
          parentId: 'wrk_1',
          data: {
            base_url: 'https://api.dev',
            nested: { token: 'abc' },
            ref: '{{ _.base_url }}/v1',
          },
        },
        {
          _id: 'req_1',
          _type: 'request',
          name: 'Templated',
          method: 'POST',
          url: '{{ _.base_url }}/users/{{_.id}}',
          parentId: 'wrk_1',
          parameters: [{ name: 'q', value: "{{ _['search term'] }}" }],
          headers: [{ name: 'X-Key', value: '{{ _["api-key"] }}' }],
          body: { mimeType: 'application/json', text: '{"name":"{{ _.name }}"}' },
          authentication: { type: 'bearer', token: '{{ _.nested.token }}' },
        },
      ])
    );
    const request = requestOf(result.collection.items[0]) as HttpRequest;
    expect(request.url).toBe('{{base_url}}/users/{{id}}');
    expect(request.params[0]?.value).toBe('{{search term}}');
    expect(request.headers[0]?.value).toBe('{{api-key}}');
    expect(request.body.raw).toBe('{"name":"{{name}}"}');
    expect(request.auth.bearer?.token).toBe('{{nested.token}}');
    expect(result.environments?.[0]?.variables.map((v) => [v.key, v.value])).toEqual([
      ['base_url', 'https://api.dev'],
      ['nested.token', 'abc'],
      ['ref', '{{base_url}}/v1'],
    ]);
    expect(result.warnings).toEqual([]);
  });

  it('keeps unsupported template tags verbatim and warns', () => {
    const result = importInsomniaCollection(
      makeV5([
        {
          name: 'Tagged',
          method: 'GET',
          url: "{{ _.host }}/{% uuid 'v4' %}",
          headers: [{ name: 'X-Up', value: '{{ _.name | upper }}' }],
        },
      ])
    );
    const request = requestOf(result.collection.items[0]) as HttpRequest;
    expect(request.url).toBe("{{host}}/{% uuid 'v4' %}");
    expect(request.headers[0]?.value).toBe('{{ _.name | upper }}');
    expect(result.warnings).toEqual([
      expect.objectContaining({ kind: 'unmodelled-construct', requestName: 'Tagged' }),
    ]);
  });

  it('imports a GraphQL body envelope as query + variables', () => {
    const result = importInsomniaCollection(
      makeV5([
        {
          name: 'GQL',
          method: 'POST',
          url: 'https://g.dev',
          body: {
            mimeType: 'application/graphql',
            text: JSON.stringify({
              query: 'query Q($id: ID) { node(id: $id) { id } }',
              variables: { id: '{{ _.id }}' },
              operationName: 'Q',
            }),
          },
        },
      ])
    );
    expect((requestOf(result.collection.items[0]) as HttpRequest).body).toEqual({
      type: 'graphql',
      raw: 'query Q($id: ID) { node(id: $id) { id } }',
      graphqlVariables: JSON.stringify({ id: '{{id}}' }, null, 2),
      graphqlOperationName: 'Q',
    });
  });
});

describe('importInsomniaCollection — defaults and sparse exports', () => {
  it('rejects a v4 export without a resources array', () => {
    expect(() =>
      importInsomniaCollection({ _type: 'export', __export_format: 4 } as unknown)
    ).toThrow(/missing "resources" array/);
  });

  it('names unnamed v4 resources and nests folders and environments by parent', () => {
    const result = importInsomniaCollection(
      makeFixture([
        { _id: 'wrk', _type: 'workspace' },
        { _id: 'env_base', _type: 'environment', parentId: 'wrk', data: { host: 'h' } },
        { _id: 'env_sub', _type: 'environment', parentId: 'env_base' },
        { _id: 'env_orphan', _type: 'environment', parentId: 'missing', data: { n: null } },
        { _id: 'fld_outer', _type: 'request_group' },
        { _id: 'fld_inner', _type: 'request_group', parentId: 'fld_outer' },
        { _id: 'req_1', _type: 'request', parentId: 'fld_inner' },
        { _id: 'req_2', _type: 'request', parentId: 'nowhere', method: 'GET', url: 'https://x' },
      ] as InsomniaCollection['resources'])
    );
    expect(result.collection.name).toBe('Imported Collection');
    // Loose requests are placed before top-level folders.
    const [loose, outer] = result.collection.items;
    expect(loose).toMatchObject({ name: 'Unnamed Request', type: 'request' });
    expect(outer).toMatchObject({ name: 'Unnamed Folder', type: 'folder' });
    const inner = outer?.items?.[0];
    expect(inner).toMatchObject({ name: 'Unnamed Folder', type: 'folder' });
    expect(inner?.items?.[0]).toMatchObject({ name: 'Unnamed Request' });
    const unnested = requestOf(inner?.items?.[0]) as HttpRequest;
    expect(unnested).toMatchObject({ url: '', headers: [], params: [], body: { type: 'none' } });

    const envs = result.environments ?? [];
    expect(envs.map((e) => e.name)).toEqual([
      'Imported Environment',
      'Imported Environment',
      'Imported Environment',
    ]);
    const [base, sub, orphan] = envs;
    expect(base?.parentId).toBeUndefined();
    expect(sub?.parentId).toBe(base?.id);
    expect(orphan?.parentId).toBeUndefined();
    expect(sub?.variables).toEqual([]);
    expect(orphan?.variables.map((v) => [v.key, v.value])).toEqual([['n', '']]);
  });

  it('a v4 export without environments yields none', () => {
    const result = importInsomniaCollection(
      makeFixture([{ _id: 'req', _type: 'request', name: 'R', method: 'GET', url: 'u' }] as never)
    );
    expect(result.environments).toBeUndefined();
  });

  it('defaults v5 names, flattens nested environment data and keeps arrays as JSON', () => {
    const doc = {
      type: 'collection.insomnia.rest/5.0',
      collection: [{ children: [{ method: 'GET', url: 'https://x' }] }],
      environments: {
        data: { api: { host: 'h', port: 1 }, list: [1, 2], none: null },
        subEnvironments: [{ data: 'not an object' }, { name: 'Prod', data: { a: 'b' } }],
      },
    } as unknown as InsomniaV5Document;
    const result = importInsomniaCollection(doc);
    expect(result.collection.name).toBe('Imported Collection');
    expect(result.collection.items[0]).toMatchObject({ name: 'Unnamed Folder', type: 'folder' });
    expect(result.collection.items[0]?.items?.[0]).toMatchObject({ name: 'Unnamed Request' });
    const [base, sub1, sub2] = result.environments ?? [];
    expect(base?.name).toBe('Base environment');
    expect(base?.variables.map((v) => [v.key, v.value])).toEqual([
      ['api.host', 'h'],
      ['api.port', '1'],
      ['list', '[1,2]'],
      ['none', ''],
    ]);
    expect(sub1).toMatchObject({ name: 'Imported Environment', parentId: base?.id, variables: [] });
    expect(sub2).toMatchObject({ name: 'Prod', parentId: base?.id });
  });

  it('a v5 export with no collection or environments is empty', () => {
    const result = importInsomniaCollection({ type: 'collection.insomnia.rest/5.0' });
    expect(result.collection.items).toEqual([]);
    expect(result.environments).toBeUndefined();
  });
});

describe('importInsomniaCollection — request bodies and auth details', () => {
  const importRequest = (fields: Record<string, unknown>) => {
    const result = importInsomniaCollection(
      makeFixture([
        { _id: 'req', _type: 'request', name: 'R', method: 'POST', url: 'u', ...fields },
      ] as never)
    );
    return {
      request: requestOf(result.collection.items[0]) as HttpRequest,
      warnings: result.warnings,
    };
  };

  it('an unknown or missing mime type is a text body', () => {
    expect(
      importRequest({ body: { mimeType: 'application/x-custom', text: 't' } }).request.body
    ).toEqual({
      type: 'text',
      raw: 't',
    });
    expect(importRequest({ body: { text: 't' } }).request.body).toEqual({ type: 'text', raw: 't' });
  });

  it('a form body without params keeps its raw text', () => {
    expect(
      importRequest({ body: { mimeType: 'application/x-www-form-urlencoded', text: 'a=1' } })
        .request.body
    ).toEqual({ type: 'x-www-form-urlencoded', raw: 'a=1' });
  });

  it('a urlencoded file param stays text; a multipart file param without a name has no fileName', () => {
    const url = importRequest({
      body: {
        mimeType: 'application/x-www-form-urlencoded',
        params: [{ name: 'f', value: 'v', type: 'file', disabled: true }],
      },
    }).request.body;
    expect(url.formData).toEqual([
      expect.objectContaining({ key: 'f', value: 'v', type: 'text', enabled: false }),
    ]);
    const multi = importRequest({
      body: {
        mimeType: 'multipart/form-data',
        params: [{ name: 'f', value: '/tmp/x', type: 'file' }],
      },
    }).request.body;
    expect(multi.formData?.[0]).toMatchObject({ type: 'file', value: '' });
    expect(multi.formData?.[0]).not.toHaveProperty('fileName');
  });

  it.each([
    ['not JSON', 'query { a }', { type: 'graphql', raw: 'query { a }' }],
    ['a JSON array', '[1]', { type: 'graphql', raw: '[1]' }],
    ['JSON null', 'null', { type: 'graphql', raw: 'null' }],
    ['missing', undefined, { type: 'graphql', raw: '' }],
    [
      'no query, null variables',
      '{"variables":null,"operationName":""}',
      { type: 'graphql', raw: '' },
    ],
    [
      'string variables',
      '{"query":"q","variables":"{\\"a\\":1}"}',
      { type: 'graphql', raw: 'q', graphqlVariables: '{"a":1}' },
    ],
  ])('a GraphQL body that is %s', (_label, text, body) => {
    expect(importRequest({ body: { mimeType: 'application/graphql', text } }).request.body).toEqual(
      body
    );
  });

  it('explicit "none" auth and empty auth fields import without warnings', () => {
    expect(importRequest({ authentication: { type: 'none' } })).toMatchObject({
      request: { auth: { type: 'none' } },
      warnings: [],
    });
    expect(importRequest({ authentication: { type: 'basic', username: 3 } }).request.auth).toEqual({
      type: 'basic',
      basic: { username: '', password: '' },
    });
    expect(importRequest({ authentication: { type: 'bearer' } }).request.auth).toEqual({
      type: 'bearer',
      bearer: { token: '' },
    });
    expect(
      importRequest({ authentication: { type: 'apikey', key: 'k', value: 'v' } }).request.auth
    ).toEqual({
      type: 'api-key',
      apiKey: { key: 'k', value: 'v', in: 'header' },
    });
  });

  it('OAuth2: maps each supported grant, tokenUrl / redirectUrl aliases, and drops unknown grants', () => {
    const oauth2 = (fields: Record<string, unknown>) =>
      importRequest({ authentication: { type: 'oauth2', ...fields } }).request.auth.oauth2;
    expect(oauth2({ grantType: 'authorization_code', tokenUrl: 't', redirectUrl: 'r' })).toEqual({
      accessToken: '',
      grantType: 'authorization_code',
      tokenUrl: 't',
      redirectUri: 'r',
    });
    expect(oauth2({ grantType: 'client_credentials' })?.grantType).toBe('client_credentials');
    expect(oauth2({ grantType: 'implicit' })).toEqual({ accessToken: '' });
  });

  it('v4 scripts are migrated to rs.*; blank scripts are not attached', () => {
    const { request } = importRequest({
      preRequestScript: "pm.environment.set('a', '1');",
      afterResponseScript: '   ',
    });
    expect(request.preRequestScript).toContain("rs.environment.set('a', '1')");
    expect(request.testScript).toBeUndefined();
  });
});
