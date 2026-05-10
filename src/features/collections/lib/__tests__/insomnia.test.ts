import { describe, it, expect } from 'vitest';
import { importInsomniaCollection } from '../importers/insomnia';
import type { InsomniaCollection } from '@/types';

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
      ]),
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
      ]),
    );

    const item = result.collection.items[0]!;
    expect(item.type).toBe('request');
    const req = item.request!;
    expect(req.type).toBe('http');
    if (req.type !== 'http') throw new Error('expected http');
    expect(req.preRequestScript).toBe('pm.environment.set("nonce", Date.now())');
    expect(req.testScript).toBe('pm.test("ok", () => pm.response.to.have.status(200))');
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
      ]),
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
      ]),
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
      ]),
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
      ]),
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
      ]),
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
      ]),
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
});
