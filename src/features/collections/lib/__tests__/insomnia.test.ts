import { describe, it, expect } from 'vitest';
import { importInsomniaCollection, getInsomniaVersion } from '../importers/insomnia';
import type { InsomniaCollection, InsomniaV5Document } from '@/types';

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

  it('places the base environment in Collection.variables and surfaces sub-environments', () => {
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

    // Base env -> collection.variables (back-compat)
    const baseVars = result.collection.variables ?? [];
    expect(baseVars.map((v) => v.key).sort()).toEqual(['apiVersion', 'baseUrl']);
    const baseUrlVar = baseVars.find((v) => v.key === 'baseUrl');
    expect(baseUrlVar?.value).toBe('https://api.example.com');

    // Sub-environments -> standalone Environment records
    expect(result.environments).toHaveLength(2);
    const names = result.environments!.map((e) => e.name).sort();
    expect(names).toEqual(['Development', 'Production']);
    const dev = result.environments!.find((e) => e.name === 'Development');
    expect(dev?.variables[0]?.key).toBe('baseUrl');
    expect(dev?.variables[0]?.value).toBe('https://dev.example.com');
  });

  it('returns environments=undefined when only the base environment exists', () => {
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
    expect(result.collection.variables?.[0]?.key).toBe('foo');
    expect(result.environments).toBeUndefined();
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

    const auths = result.collection.items.map((i) => i.request!.auth);
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

    expect(result.collection.items[0]?.request?.auth.type).toBe('none');
    expect(result.warnings).toEqual([
      { kind: 'unsupported-auth', authType: 'ntlm', requestName: 'NTLM call' },
    ]);
  });

  it('throws a clear error on an unrecognized export shape', () => {
    expect(() => importInsomniaCollection({ foo: 'bar' })).toThrow(/Unrecognized Insomnia export/);
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
    expect(rootReq?.request?.url).toBe('https://example.com/root');

    expect(folderA?.type).toBe('folder');
    expect(folderA?.items).toHaveLength(2);
    const nested = folderA?.items?.[0]?.request;
    if (nested?.type !== 'http') throw new Error('expected http request');
    expect(nested.method).toBe('POST');

    const folderB = folderA?.items?.[1];
    expect(folderB?.type).toBe('folder');
    expect(folderB?.items?.[0]?.request?.name).toBe('Deep Request');
  });

  it('maps base environment to collection variables and subEnvironments to standalone envs', () => {
    const result = importInsomniaCollection(
      makeV5([{ name: 'R', method: 'GET', url: 'https://x' }], {
        name: 'Base',
        data: { base_url: 'https://api.example.com', token: 'abc' },
        subEnvironments: [{ name: 'Staging', data: { base_url: 'https://staging.example.com' } }],
      })
    );

    expect(result.collection.variables).toEqual([
      { id: expect.any(String), key: 'base_url', value: 'https://api.example.com', enabled: true },
      { id: expect.any(String), key: 'token', value: 'abc', enabled: true },
    ]);
    expect(result.environments).toHaveLength(1);
    expect(result.environments?.[0]?.name).toBe('Staging');
    expect(result.environments?.[0]?.variables[0]?.value).toBe('https://staging.example.com');
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
    expect(result.collection.items[0]?.request?.auth.type).toBe('none');
    expect(result.warnings).toEqual([
      { kind: 'unsupported-auth', authType: 'awsv4', requestName: 'AWS call' },
    ]);
  });
});
