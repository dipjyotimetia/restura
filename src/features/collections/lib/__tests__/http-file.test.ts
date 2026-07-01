import { describe, it, expect } from 'vitest';
import { importHttpFile } from '../importers/http-file';
import type { CollectionItem, HttpRequest } from '@/types';

function asHttpRequest(r: unknown): HttpRequest {
  return r as HttpRequest;
}

function itemAt(items: CollectionItem[], index: number): CollectionItem {
  const item = items[index];
  if (!item) throw new Error(`No item at index ${index}`);
  return item;
}

describe('importHttpFile', () => {
  describe('VS Code REST Client dialect', () => {
    it('parses multiple ### blocks into separate requests', () => {
      const source = `### Get user
GET https://api.example.com/users/1
Accept: application/json

### Create user
POST https://api.example.com/users
Content-Type: application/json

{"name": "Ada"}
`;
      const result = importHttpFile(source);
      expect(result.collection.items).toHaveLength(2);

      const first = itemAt(result.collection.items, 0);
      expect(first.name).toBe('Get user');
      const firstReq = asHttpRequest(first.request);
      expect(firstReq.method).toBe('GET');
      expect(firstReq.url).toBe('https://api.example.com/users/1');
      expect(firstReq.headers).toContainEqual(
        expect.objectContaining({ key: 'Accept', value: 'application/json', enabled: true })
      );

      const second = itemAt(result.collection.items, 1);
      expect(second.name).toBe('Create user');
      const secondReq = asHttpRequest(second.request);
      expect(secondReq.method).toBe('POST');
      expect(secondReq.url).toBe('https://api.example.com/users');
      expect(secondReq.body.type).toBe('json');
      expect(secondReq.body.raw).toBe('{"name": "Ada"}');
    });

    it('prefers an explicit @name annotation over the ### trailing text', () => {
      const source = `### fallback name
// @name explicitName
GET https://api.example.com/ping
`;
      const result = importHttpFile(source);
      expect(itemAt(result.collection.items, 0).name).toBe('explicitName');
    });

    it('splits the query string into params and strips it from url', () => {
      const source = `### Search
GET https://api.example.com/search?q=restura&limit={{limit}}
`;
      const result = importHttpFile(source);
      const req = asHttpRequest(itemAt(result.collection.items, 0).request);
      expect(req.url).toBe('https://api.example.com/search');
      expect(req.params).toHaveLength(2);
      expect(req.params[0]).toMatchObject({ key: 'q', value: 'restura', enabled: true });
      expect(req.params[1]).toMatchObject({ key: 'limit', value: '{{limit}}', enabled: true });
    });

    it('downgrades an out-of-union method to GET with a warning', () => {
      const source = `### Weird
PURGE https://api.example.com/cache
`;
      const result = importHttpFile(source);
      const req = asHttpRequest(itemAt(result.collection.items, 0).request);
      expect(req.method).toBe('GET');
      expect(result.warnings).toContainEqual({
        kind: 'unsupported-method',
        method: 'PURGE',
        requestName: 'Weird',
      });
    });

    it('flags {{$dynamicVar}} system variables but preserves the literal token', () => {
      const source = `### With guid
GET https://api.example.com/items/{{$guid}}
`;
      const result = importHttpFile(source);
      const req = asHttpRequest(itemAt(result.collection.items, 0).request);
      expect(req.url).toBe('https://api.example.com/items/{{$guid}}');
      expect(result.warnings).toContainEqual({
        kind: 'unknown-dynamic-var',
        varName: 'guid',
        count: 1,
      });
    });

    it('synthesizes an Environment from file-level @var declarations', () => {
      const source = `@baseUrl = https://api.example.com
@token = abc123

### Ping
GET {{baseUrl}}/ping
Authorization: Bearer {{token}}
`;
      const result = importHttpFile(source, { fileName: 'sample.http' });
      expect(result.environments).toHaveLength(1);
      const env = result.environments![0]!;
      expect(env.variables).toContainEqual(
        expect.objectContaining({ key: 'baseUrl', value: 'https://api.example.com', enabled: true })
      );
      expect(env.variables).toContainEqual(
        expect.objectContaining({ key: 'token', value: 'abc123', enabled: true })
      );
    });

    it('omits environments when there are no file-level variables', () => {
      const source = `### Ping
GET https://api.example.com/ping
`;
      const result = importHttpFile(source);
      expect(result.environments).toBeUndefined();
    });

    it('uses the provided fileName for the collection name', () => {
      const source = `### Ping
GET https://api.example.com/ping
`;
      const result = importHttpFile(source, { fileName: 'my-service.http' });
      expect(result.collection.name).toBe('my-service');
    });

    it('falls back to a generic collection name when no fileName is given', () => {
      const source = `### Ping
GET https://api.example.com/ping
`;
      const result = importHttpFile(source);
      expect(result.collection.name).toBe('HTTP File Import');
    });
  });

  describe('JetBrains HTTP Client dialect', () => {
    it('stores pre-request and response-handler script blocks verbatim without executing them', () => {
      const source = `### Login
< {%
  client.global.set("authToken", "abc");
%}
POST https://api.example.com/login
Content-Type: application/json

{"user": "ada"}

> {%
  client.test("status is 200", function() {
    client.assert(response.status === 200);
  });
%}
`;
      const result = importHttpFile(source);
      const req = asHttpRequest(itemAt(result.collection.items, 0).request);
      expect(req.preRequestScript).toContain('client.global.set("authToken", "abc");');
      expect(req.testScript).toContain('client.test("status is 200"');

      const scriptWarnings = result.warnings.filter((w) => w.kind === 'unrecognized-script-type');
      expect(scriptWarnings).toHaveLength(2);
      for (const w of scriptWarnings) {
        expect(w).toMatchObject({
          kind: 'unrecognized-script-type',
          scriptType: 'jetbrains-http-client-script',
          requestName: 'Login',
        });
      }
    });

    it('does not treat a plain VS Code file as JetBrains dialect', () => {
      const source = `### Ping
GET https://api.example.com/ping
`;
      const result = importHttpFile(source);
      const req = asHttpRequest(itemAt(result.collection.items, 0).request);
      expect(req.preRequestScript).toBeUndefined();
      expect(req.testScript).toBeUndefined();
      expect(result.warnings.filter((w) => w.kind === 'unrecognized-script-type')).toHaveLength(0);
    });
  });
});
