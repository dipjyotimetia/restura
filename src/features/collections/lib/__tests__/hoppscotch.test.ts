import { findInheritedAuth } from '@shared/auth/inheritance';
import { describe, expect, it } from 'vitest';
import type { CollectionItem, HttpRequest } from '@/types';
import {
  importHoppscotchCollection,
  importHoppscotchEnvironment,
  importHoppscotchEnvironmentDetailed,
  isHoppscotchCollection,
  isHoppscotchEnvironment,
} from '../importers/hoppscotch';

describe('importHoppscotchCollection', () => {
  it('imports a v12 collection with nested folders and inherits collection-level scripts', () => {
    const fixture = {
      v: 12,
      name: 'My APIs',
      preRequestScript: "console.log('collection pre');",
      testScript: "pm.test('collection test', () => {});",
      folders: [
        {
          v: 12,
          name: 'Users',
          preRequestScript: '',
          testScript: '',
          folders: [
            {
              v: 12,
              name: 'Admin',
              preRequestScript: '',
              testScript: '',
              folders: [],
              requests: [
                {
                  v: '17',
                  name: 'List admins',
                  method: 'GET',
                  endpoint: '{{API_HOST}}/admins',
                  headers: [],
                  params: [],
                  body: { contentType: null, body: null },
                  auth: { authType: 'none', authActive: true },
                  preRequestScript: '',
                  testScript: '',
                  description: '',
                  requestVariables: [],
                },
              ],
            },
          ],
          requests: [
            {
              v: '17',
              name: 'Get user',
              method: 'GET',
              endpoint: '{{API_HOST}}/users/{{id}}',
              headers: [{ key: 'Accept', value: 'application/json', active: true }],
              params: [{ key: 'verbose', value: 'true', active: true }],
              body: { contentType: 'application/json', body: '{"foo":1}' },
              auth: { authType: 'bearer', authActive: true, token: '{{TOKEN}}' },
              preRequestScript: "console.log('req pre');",
              testScript: "pm.test('status', () => pm.response.to.have.status(200));",
              description: 'Fetch a user',
              requestVariables: [],
            },
          ],
        },
      ],
      requests: [
        {
          v: '17',
          name: 'Health',
          method: 'GET',
          endpoint: '{{API_HOST}}/health',
          headers: [],
          params: [],
          preRequestScript: '',
          testScript: '',
        },
      ],
    };

    const result = importHoppscotchCollection(fixture);
    expect(result.collection.name).toBe('My APIs');
    expect(result.collection.items).toHaveLength(2); // 1 folder + 1 root request

    const folder = result.collection.items[0];
    expect(folder?.type).toBe('folder');
    expect(folder?.name).toBe('Users');
    expect(folder?.items).toHaveLength(2); // 1 nested folder + 1 request

    const nestedFolder = folder?.items?.[0];
    expect(nestedFolder?.type).toBe('folder');
    expect(nestedFolder?.name).toBe('Admin');
    expect(nestedFolder?.items).toHaveLength(1);

    // The "Get user" request should have collection-level scripts inherited as a header.
    const userRequest = folder?.items?.[1];
    expect(userRequest?.type).toBe('request');
    const httpReq = userRequest?.request as HttpRequest;
    expect(httpReq.method).toBe('GET');
    expect(httpReq.url).toBe('{{API_HOST}}/users/{{id}}');
    expect(httpReq.headers).toHaveLength(1);
    expect(httpReq.headers[0]?.key).toBe('Accept');
    expect(httpReq.params).toHaveLength(1);
    expect(httpReq.body.type).toBe('json');
    expect(httpReq.body.raw).toBe('{"foo":1}');
    expect(httpReq.auth.type).toBe('bearer');
    expect(httpReq.auth.bearer?.token).toBe('{{TOKEN}}');

    // The "Get user" request is inside the Users folder (which has empty scripts),
    // so only the request's own scripts come through — folder is the immediate parent.
    expect(httpReq.preRequestScript).toBe("console.log('req pre');");
    // Hoppscotch uses pm.*; Restura normalizes to its native rs.* namespace on import.
    expect(httpReq.testScript).toBe("rs.test('status', () => rs.response.to.have.status(200));");

    // Root-level request — its parent IS the root collection, so collection-level
    // scripts are inherited as a header comment.
    const rootReq = result.collection.items[1];
    const rootHttp = rootReq?.request as HttpRequest;
    expect(rootHttp.preRequestScript).toContain('inherited from collection');
    expect(rootHttp.preRequestScript).toContain("console.log('collection pre');");
    expect(rootHttp.testScript).toContain('inherited from collection');
    expect(rootHttp.testScript).toContain("rs.test('collection test'");

    expect(result.warnings).toEqual([]);
  });

  it('imports a v2 environment with secret variable and prefers currentValue', () => {
    const env = {
      v: 2,
      name: 'Production',
      variables: [
        {
          key: 'API_HOST',
          initialValue: 'https://api.example.com',
          currentValue: 'https://api.example.com',
          secret: false,
        },
        {
          key: 'TOKEN',
          initialValue: '',
          currentValue: 'secret-token-value',
          secret: true,
        },
      ],
    };

    const result = importHoppscotchEnvironment(env, { keepSecretValues: true });
    expect(result.name).toBe('Production');
    expect(result.variables).toHaveLength(2);
    const apiHost = result.variables.find((v) => v.key === 'API_HOST');
    expect(apiHost?.value).toBe('https://api.example.com');
    expect(apiHost?.secret).toBeUndefined();
    const token = result.variables.find((v) => v.key === 'TOKEN');
    expect(token?.value).toBe('secret-token-value');
    expect(token?.secret).toBe(true);
  });

  it('drops secret values by default and warns with the keys only (#1231)', () => {
    const result = importHoppscotchEnvironmentDetailed({
      v: 2,
      name: 'Production',
      variables: [
        { key: 'API_HOST', initialValue: 'https://api.example.com', secret: false },
        {
          key: 'TOKEN',
          initialValue: 'init-tok',
          currentValue: 'secret-token-value',
          secret: true,
        },
      ],
    });
    expect(result.environment.variables.map((v) => [v.key, v.value, v.secret])).toEqual([
      ['API_HOST', 'https://api.example.com', undefined],
      ['TOKEN', '', true],
    ]);
    expect(result.droppedSecretKeys).toEqual(['TOKEN']);
    expect(result.warnings).toMatchInlineSnapshot(`
      [
        {
          "construct": "secret-variable",
          "detail": "Secret variable imported without a value; re-enter it: TOKEN",
          "kind": "unmodelled-construct",
          "requestName": "Production",
        },
      ]
    `);
    expect(JSON.stringify(result)).not.toMatch(/secret-token-value|init-tok/);
  });

  it('rejects garbage input with a readable error', () => {
    expect(() => importHoppscotchCollection({ totally: 'wrong' })).toThrow(
      /Invalid Hoppscotch collection/
    );
    expect(() => importHoppscotchCollection(null)).toThrow(/Invalid Hoppscotch collection/);
    expect(() => importHoppscotchCollection({ name: 42 })).toThrow(/Invalid Hoppscotch collection/);
  });

  it('maps OAuth2 auth correctly', () => {
    const fixture = {
      v: 12,
      name: 'OAuth Test',
      preRequestScript: '',
      testScript: '',
      folders: [],
      requests: [
        {
          v: '17',
          name: 'OAuth call',
          method: 'POST',
          endpoint: 'https://api.example.com/secure',
          headers: [],
          params: [],
          auth: {
            authType: 'oauth-2',
            authActive: true,
            token: 'access-xyz',
            grantType: 'CLIENT_CREDENTIALS',
            clientID: 'client-123',
            clientSecret: 'secret-456',
            authURL: 'https://auth.example.com/authorize',
            accessTokenURL: 'https://auth.example.com/token',
            scope: 'read write',
          },
          preRequestScript: '',
          testScript: '',
        },
      ],
    };

    const result = importHoppscotchCollection(fixture);
    const req = result.collection.items[0]?.request as HttpRequest;
    expect(req.auth.type).toBe('oauth2');
    expect(req.auth.oauth2?.accessToken).toBe('access-xyz');
    expect(req.auth.oauth2?.grantType).toBe('client_credentials');
    expect(req.auth.oauth2?.clientId).toBe('client-123');
    expect(req.auth.oauth2?.clientSecret).toBe('secret-456');
    expect(req.auth.oauth2?.authorizationUrl).toBe('https://auth.example.com/authorize');
    expect(req.auth.oauth2?.tokenUrl).toBe('https://auth.example.com/token');
    expect(req.auth.oauth2?.scope).toBe('read write');
  });

  it('maps API key auth in header and query', () => {
    const fixture = {
      v: 12,
      name: 'API Key',
      preRequestScript: '',
      testScript: '',
      folders: [],
      requests: [
        {
          v: '17',
          name: 'header key',
          method: 'GET',
          endpoint: 'https://example.com',
          headers: [],
          params: [],
          auth: { authType: 'api-key', authActive: true, key: 'X-API-Key', value: 'abc' },
          preRequestScript: '',
          testScript: '',
        },
        {
          v: '17',
          name: 'query key',
          method: 'GET',
          endpoint: 'https://example.com',
          headers: [],
          params: [],
          auth: {
            authType: 'api-key',
            authActive: true,
            key: 'apikey',
            value: 'xyz',
            addTo: 'QUERY_PARAMS',
          },
          preRequestScript: '',
          testScript: '',
        },
      ],
    };

    const result = importHoppscotchCollection(fixture);
    const headerReq = result.collection.items[0]?.request as HttpRequest;
    expect(headerReq.auth.type).toBe('api-key');
    expect(headerReq.auth.apiKey?.in).toBe('header');
    const queryReq = result.collection.items[1]?.request as HttpRequest;
    expect(queryReq.auth.apiKey?.in).toBe('query');
  });

  it('warns on unsupported auth types', () => {
    const fixture = {
      v: 12,
      name: 'Unsupported',
      preRequestScript: '',
      testScript: '',
      folders: [],
      requests: [
        {
          v: '17',
          name: 'odd auth',
          method: 'GET',
          endpoint: 'https://example.com',
          headers: [],
          params: [],
          auth: { authType: 'magic-token', authActive: true },
          preRequestScript: '',
          testScript: '',
        },
      ],
    };

    const result = importHoppscotchCollection(fixture);
    const req = result.collection.items[0]?.request as HttpRequest;
    expect(req.auth.type).toBe('none');
    expect(result.warnings).toContainEqual({
      kind: 'unsupported-auth',
      authType: 'magic-token',
      requestName: 'odd auth',
    });
  });
});

describe('isHoppscotchCollection / isHoppscotchEnvironment', () => {
  it('detects a valid collection', () => {
    expect(
      isHoppscotchCollection({
        v: 12,
        name: 'Test',
        folders: [],
        requests: [],
      })
    ).toBe(true);
  });

  it('rejects non-collection input', () => {
    expect(isHoppscotchCollection({ random: 'thing' })).toBe(false);
    expect(isHoppscotchCollection(null)).toBe(false);
    expect(isHoppscotchCollection(undefined)).toBe(false);
  });

  it('detects a valid environment', () => {
    expect(
      isHoppscotchEnvironment({
        v: 2,
        name: 'env',
        variables: [],
      })
    ).toBe(true);
  });

  it('rejects non-environment input', () => {
    expect(isHoppscotchEnvironment({ name: 1 })).toBe(false);
  });
});

describe('Hoppscotch round-2 regressions', () => {
  // Shape of a real Hoppscotch "Export all collections" file: a top-level
  // array, `<<var>>` templating, collection/folder auth + headers, requests
  // that inherit, and OAuth 2 settings nested under `grantTypeInfo`.
  const exportAll = [
    {
      v: 2,
      name: 'Petstore',
      folders: [
        {
          v: 2,
          name: 'Admin',
          folders: [],
          requests: [
            {
              v: '6',
              endpoint: '<<baseUrl>>/admin/stats',
              name: 'Stats',
              params: [],
              headers: [],
              method: 'GET',
              auth: { authType: 'inherit', authActive: true },
              preRequestScript: '',
              testScript: '',
              body: { contentType: null, body: null },
              requestVariables: [],
            },
            {
              v: '6',
              endpoint: '<<baseUrl>>/admin/public',
              name: 'Public',
              params: [],
              headers: [],
              method: 'GET',
              auth: { authType: 'none', authActive: true },
              preRequestScript: '',
              testScript: '',
              body: { contentType: null, body: null },
              requestVariables: [],
            },
          ],
          auth: { authType: 'basic', authActive: true, username: '<<adminUser>>', password: 'pw' },
          headers: [{ key: 'X-Scope', value: 'admin', active: true }],
        },
      ],
      requests: [
        {
          v: '6',
          endpoint: '<<baseUrl>>/pets/<<petId>>',
          name: 'Get pet',
          params: [{ key: 'limit', value: '<<limit>>', active: true }],
          headers: [
            { key: 'X-Trace', value: '<<trace>>', active: true },
            { key: 'X-Client', value: 'override', active: true },
          ],
          method: 'GET',
          auth: { authType: 'inherit', authActive: true },
          preRequestScript: 'const flags = 1 << 2;',
          testScript: '',
          body: { contentType: 'application/json', body: '{"owner":"<<owner>>"}' },
          requestVariables: [],
        },
        {
          v: '6',
          endpoint: '<<authBase>>/token-check',
          name: 'OAuth nested',
          params: [],
          headers: [],
          method: 'POST',
          auth: {
            authType: 'oauth-2',
            authActive: true,
            addTo: 'HEADERS',
            grantTypeInfo: {
              grantType: 'AUTHORIZATION_CODE',
              authEndpoint: '<<authBase>>/authorize',
              tokenEndpoint: '<<authBase>>/token',
              clientID: '<<clientId>>',
              clientSecret: 'shh',
              scopes: 'read write',
              isPKCE: true,
              codeVerifierMethod: 'S256',
              token: 'tok-1',
            },
          },
          preRequestScript: '',
          testScript: '',
          body: { contentType: null, body: null },
          requestVariables: [],
        },
        {
          v: '6',
          endpoint: 'https://api.example.com/cc',
          name: 'Client credentials',
          params: [],
          headers: [],
          method: 'POST',
          auth: {
            authType: 'oauth-2',
            authActive: true,
            addTo: 'HEADERS',
            grantTypeInfo: {
              grantType: 'CLIENT_CREDENTIALS',
              authEndpoint: 'https://auth.example.com/oauth/token',
              clientID: 'svc',
              clientSecret: 'svc-secret',
              scopes: 'jobs',
              token: '',
            },
          },
          preRequestScript: '',
          testScript: '',
          body: { contentType: null, body: null },
          requestVariables: [],
        },
      ],
      auth: { authType: 'bearer', authActive: true, token: '<<token>>' },
      headers: [{ key: 'X-Client', value: 'restura', active: true }],
    },
    {
      v: 2,
      name: 'Billing',
      folders: [],
      requests: [
        {
          v: '6',
          endpoint: '<<billingUrl>>/invoices',
          name: 'Invoices',
          params: [],
          headers: [],
          method: 'GET',
          auth: { authType: 'inherit', authActive: true },
          preRequestScript: '',
          testScript: '',
          body: { contentType: null, body: null },
          requestVariables: [],
        },
      ],
      auth: { authType: 'inherit', authActive: true },
      headers: [],
    },
  ];

  function itemNamed(items: CollectionItem[] | undefined, name: string): CollectionItem {
    const item = items?.find((i) => i.name === name);
    if (!item) throw new Error(`no item named ${name}`);
    return item;
  }

  function requestOf(item: CollectionItem): HttpRequest {
    if (item.request?.type !== 'http') throw new Error(`${item.name} is not an HTTP request`);
    return item.request;
  }

  it('detects and imports a top-level array export, one folder per collection (I6)', () => {
    expect(isHoppscotchCollection(exportAll)).toBe(true);
    const { collection } = importHoppscotchCollection(exportAll);
    expect(collection.items.map((i) => [i.type, i.name])).toEqual([
      ['folder', 'Petstore'],
      ['folder', 'Billing'],
    ]);
    const invoices = requestOf(itemNamed(itemNamed(collection.items, 'Billing').items, 'Invoices'));
    expect(invoices.url).toBe('{{billingUrl}}/invoices');
  });

  it('imports a single-element array as that collection', () => {
    const { collection } = importHoppscotchCollection([exportAll[0]]);
    expect(collection.name).toBe('Petstore');
    expect(collection.auth).toEqual({ type: 'bearer', bearer: { token: '{{token}}' } });
  });

  it('maps collection/folder auth, inherit and headers onto Restura scopes (I5)', () => {
    const { collection, warnings } = importHoppscotchCollection(exportAll[0]);
    expect(collection.auth).toEqual({ type: 'bearer', bearer: { token: '{{token}}' } });

    const admin = itemNamed(collection.items, 'Admin');
    expect(admin.auth).toEqual({
      type: 'basic',
      basic: { username: '{{adminUser}}', password: 'pw' },
    });

    // `inherit` becomes Restura's inherit (auth 'none' resolves to the nearest
    // configured ancestor) without an unsupported-auth warning.
    const stats = requestOf(itemNamed(admin.items, 'Stats'));
    expect(stats.auth.type).toBe('none');
    expect(findInheritedAuth(collection, stats.id)?.type).toBe('basic');
    expect(warnings.filter((w) => w.kind === 'unsupported-auth')).toEqual([]);

    // Collection + folder headers reach every descendant; the closer scope wins.
    expect(stats.headers.map((h) => [h.key, h.value])).toEqual([
      ['X-Client', 'restura'],
      ['X-Scope', 'admin'],
    ]);
    const getPet = requestOf(itemNamed(collection.items, 'Get pet'));
    expect(getPet.headers.map((h) => [h.key, h.value])).toEqual([
      ['X-Trace', '{{trace}}'],
      ['X-Client', 'override'],
    ]);

    // An explicit "None" under an authenticated parent cannot be modelled
    // (Restura would inherit the parent's credentials) — say so.
    expect(warnings).toContainEqual(
      expect.objectContaining({ kind: 'unmodelled-construct', requestName: 'Public' })
    );
  });

  it('rewrites <<var>> to {{var}} in every templated field, not in scripts (I6)', () => {
    const { collection } = importHoppscotchCollection(exportAll[0]);
    const getPet = requestOf(itemNamed(collection.items, 'Get pet'));
    expect(getPet.url).toBe('{{baseUrl}}/pets/{{petId}}');
    expect(getPet.params[0]?.value).toBe('{{limit}}');
    expect(getPet.body.raw).toBe('{"owner":"{{owner}}"}');
    expect(getPet.preRequestScript).toBe('const flags = 1 << 2;');
    expect(JSON.stringify(collection)).not.toMatch(/<<\w+>>/);
  });

  it('reads OAuth 2 settings nested under grantTypeInfo (I6)', () => {
    const { collection } = importHoppscotchCollection(exportAll[0]);
    const authCode = requestOf(itemNamed(collection.items, 'OAuth nested'));
    expect(authCode.auth).toEqual({
      type: 'oauth2',
      oauth2: {
        accessToken: 'tok-1',
        grantType: 'authorization_code',
        clientId: '{{clientId}}',
        clientSecret: 'shh',
        authorizationUrl: '{{authBase}}/authorize',
        tokenUrl: '{{authBase}}/token',
        scope: 'read write',
      },
    });
    // Hoppscotch names the client-credentials token endpoint `authEndpoint`.
    const cc = requestOf(itemNamed(collection.items, 'Client credentials'));
    expect(cc.auth.oauth2).toMatchObject({
      grantType: 'client_credentials',
      clientId: 'svc',
      tokenUrl: 'https://auth.example.com/oauth/token',
      scope: 'jobs',
    });
    expect(cc.auth.oauth2?.authorizationUrl).toBeUndefined();
  });

  it('never writes untrusted keys onto prototypes while rewriting', () => {
    const hostile = JSON.parse(
      '{"v":2,"name":"P","folders":[],"requests":[],"__proto__":{"polluted":"<<x>>"}}'
    );
    importHoppscotchCollection(hostile);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
