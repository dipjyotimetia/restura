import { describe, it, expect } from 'vitest';
import {
  importHoppscotchCollection,
  importHoppscotchEnvironment,
  isHoppscotchCollection,
  isHoppscotchEnvironment,
} from '../importers/hoppscotch';
import type { HttpRequest } from '@/types';

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
    expect(httpReq.testScript).toBe("pm.test('status', () => pm.response.to.have.status(200));");

    // Root-level request — its parent IS the root collection, so collection-level
    // scripts are inherited as a header comment.
    const rootReq = result.collection.items[1];
    const rootHttp = rootReq?.request as HttpRequest;
    expect(rootHttp.preRequestScript).toContain('inherited from collection');
    expect(rootHttp.preRequestScript).toContain("console.log('collection pre');");
    expect(rootHttp.testScript).toContain('inherited from collection');
    expect(rootHttp.testScript).toContain("pm.test('collection test'");

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

    const result = importHoppscotchEnvironment(env);
    expect(result.name).toBe('Production');
    expect(result.variables).toHaveLength(2);
    const apiHost = result.variables.find((v) => v.key === 'API_HOST');
    expect(apiHost?.value).toBe('https://api.example.com');
    expect(apiHost?.secret).toBeUndefined();
    const token = result.variables.find((v) => v.key === 'TOKEN');
    expect(token?.value).toBe('secret-token-value');
    expect(token?.secret).toBe(true);
  });

  it('rejects garbage input with a readable error', () => {
    expect(() => importHoppscotchCollection({ totally: 'wrong' })).toThrow(
      /Invalid Hoppscotch collection/,
    );
    expect(() => importHoppscotchCollection(null)).toThrow(/Invalid Hoppscotch collection/);
    expect(() => importHoppscotchCollection({ name: 42 })).toThrow(
      /Invalid Hoppscotch collection/,
    );
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
      }),
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
      }),
    ).toBe(true);
  });

  it('rejects non-environment input', () => {
    expect(isHoppscotchEnvironment({ name: 1 })).toBe(false);
  });
});
