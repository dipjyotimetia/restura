import { describe, expect, it } from 'vitest';
import type { CollectionItem, HttpRequest } from '../../types';
import { importPostmanCollection } from './index';
import { getPostmanSidecar } from './sidecar';

const V21 = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

function req(item: CollectionItem | undefined): HttpRequest {
  return item?.request as HttpRequest;
}

function one(request: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    info: { name: 'C', schema: V21 },
    item: [
      {
        name: 'R',
        request: { method: 'GET', url: 'https://api.example.com/x', ...request },
        ...extra,
      },
    ],
  };
}

function constructs(warnings: ReadonlyArray<{ kind: string; construct?: string }>): string[] {
  return warnings.map((w) => w.construct ?? w.kind).sort();
}

describe('importPostmanCollection (shared, SDK-free)', () => {
  it('maps OAuth1 auth to the Restura oauth1 block', () => {
    const { collection, report } = importPostmanCollection(
      one({
        auth: {
          type: 'oauth1',
          oauth1: [
            { key: 'consumerKey', value: 'ck' },
            { key: 'consumerSecret', value: 'cs' },
            { key: 'token', value: 'at' },
            { key: 'tokenSecret', value: 'ats' },
            { key: 'signatureMethod', value: 'HMAC-SHA256' },
            { key: 'realm', value: 'r' },
          ],
        },
      })
    );
    expect(req(collection.items[0]).auth).toEqual({
      type: 'oauth1',
      oauth1: {
        consumerKey: 'ck',
        consumerSecret: 'cs',
        accessToken: 'at',
        accessTokenSecret: 'ats',
        signatureMethod: 'HMAC-SHA256',
        realm: 'r',
      },
    });
    expect(report.warnings).toEqual([]);
  });

  it('OAuth1 with an unsupported signature method is reported and kept raw', () => {
    const auth = {
      type: 'oauth1',
      oauth1: [
        { key: 'consumerKey', value: 'ck' },
        { key: 'signatureMethod', value: 'RSA-SHA1' },
      ],
    };
    const { collection, report } = importPostmanCollection(one({ auth }));
    expect(req(collection.items[0]).auth?.oauth1?.signatureMethod).toBeUndefined();
    // Mapped keys (consumerKey) are not duplicated into the sidecar (ADR-0007).
    expect(getPostmanSidecar(collection.items[0]!)?.auth).toEqual({
      type: 'oauth1',
      oauth1: [{ key: 'signatureMethod', value: 'RSA-SHA1' }],
    });
    expect(constructs(report.warnings)).toEqual(['oauth1-options']);
  });

  it('maps NTLM auth to the Restura ntlm block', () => {
    const { collection } = importPostmanCollection(
      one({
        auth: {
          type: 'ntlm',
          ntlm: [
            { key: 'username', value: 'u' },
            { key: 'password', value: 'p' },
            { key: 'domain', value: 'CORP' },
            { key: 'workstation', value: 'WS1' },
          ],
        },
      })
    );
    expect(req(collection.items[0]).auth).toEqual({
      type: 'ntlm',
      ntlm: { username: 'u', password: 'p', domain: 'CORP', workstation: 'WS1' },
    });
  });

  it('accepts v2.0 object-map auth params and string URLs with a query', () => {
    const { collection, report } = importPostmanCollection({
      info: {
        name: 'C',
        schema: 'https://schema.getpostman.com/json/collection/v2.0.0/collection.json',
      },
      item: [
        {
          name: 'R',
          request: {
            method: 'get',
            url: 'https://a.example.com/?q=1',
            auth: { type: 'basic', basic: { username: 'u', password: 'p' } },
          },
        },
      ],
    });
    const r = req(collection.items[0]);
    expect(r.method).toBe('GET');
    expect(r.url).toBe('https://a.example.com/');
    expect(r.params.map((p) => [p.key, p.value])).toEqual([['q', '1']]);
    expect(r.auth).toEqual({ type: 'basic', basic: { username: 'u', password: 'p' } });
    expect(report.sourceVersion).toBe('2.0');
  });

  it('builds the URL from structured parts when raw is absent', () => {
    const { collection } = importPostmanCollection(
      one({
        url: {
          protocol: 'https',
          host: ['api', 'example', 'com'],
          port: '8443',
          path: ['v1', ':id'],
          query: [{ key: 'a', value: 'b', disabled: true }],
        },
      })
    );
    const r = req(collection.items[0]);
    expect(r.url).toBe('https://api.example.com:8443/v1/:id');
    expect(r.params).toEqual([expect.objectContaining({ key: 'a', value: 'b', enabled: false })]);
  });

  it('unsupported auth (hawk) → none + warning + raw auth kept in the _postman sidecar', () => {
    const hawk = {
      type: 'hawk',
      hawk: [
        { key: 'authId', value: 'id-1' },
        { key: 'authKey', value: 'hawk-secret' },
      ],
    };
    const { collection, report } = importPostmanCollection(one({ auth: hawk }));
    const item = collection.items[0]!;
    expect(req(item).auth).toEqual({ type: 'none' });
    expect(report.warnings).toEqual([
      { kind: 'unsupported-auth', authType: 'hawk', requestName: 'R' },
    ]);
    expect(getPostmanSidecar(item)?.auth).toEqual(hawk);
  });

  it('unsupported folder auth is kept on the folder sidecar', () => {
    const edgegrid = { type: 'edgegrid', edgegrid: [{ key: 'clientSecret', value: 's' }] };
    const { collection, report } = importPostmanCollection({
      info: { name: 'C', schema: V21 },
      item: [{ name: 'F', auth: edgegrid, item: [] }],
    });
    expect(getPostmanSidecar(collection.items[0]!)?.auth).toEqual(edgegrid);
    expect(collection.items[0]!.auth).toBeUndefined();
    expect(report.warnings).toEqual([
      { kind: 'unsupported-auth', authType: 'edgegrid', requestName: 'F' },
    ]);
  });

  it('saved responses → warning + kept in the sidecar', () => {
    const response = [{ name: 'ok', code: 200, header: [], body: '{"a":1}' }];
    const { collection, report } = importPostmanCollection(one({}, { response }));
    const item = collection.items[0]!;
    expect(getPostmanSidecar(item)?.response).toEqual(response);
    expect(report.warnings).toEqual([
      expect.objectContaining({
        kind: 'unmodelled-construct',
        construct: 'saved-responses',
        requestName: 'R',
      }),
    ]);
  });

  it('protocolProfileBehavior, item variables, extra events and file body are reported + kept', () => {
    const { collection, report } = importPostmanCollection(
      one(
        { body: { mode: 'file', file: { src: '/tmp/a.bin' } } },
        {
          protocolProfileBehavior: { followRedirects: false },
          variable: [{ key: 'v', value: '1' }],
          event: [
            { listen: 'test', script: { exec: ['pm.test("a")'] } },
            { listen: 'test', script: { exec: ['pm.test("b")'] } },
          ],
        }
      )
    );
    const item = collection.items[0]!;
    const sidecar = getPostmanSidecar(item);
    expect(sidecar?.protocolProfileBehavior).toEqual({ followRedirects: false });
    expect(sidecar?.variable).toEqual([{ key: 'v', value: '1' }]);
    expect(sidecar?.event).toEqual([{ listen: 'test', script: { exec: ['pm.test("a")'] } }]);
    expect(sidecar?.body).toEqual({ mode: 'file', file: { src: '/tmp/a.bin' } });
    // Last same-kind event still wins (pre-existing behaviour).
    expect(req(item).testScript).toBe('rs.test("b")');
    expect(req(item).body).toEqual({ type: 'binary' });
    expect(constructs(report.warnings)).toEqual([
      'extra-events',
      'file-body',
      'item-variables',
      'protocol-profile-behavior',
    ]);
  });

  it('collection-level protocolProfileBehavior lands on the root sidecar', () => {
    const { collection, report } = importPostmanCollection({
      info: { name: 'C', schema: V21 },
      item: [],
      protocolProfileBehavior: { strictSSL: false },
    });
    expect(getPostmanSidecar(collection)?.protocolProfileBehavior).toEqual({ strictSSL: false });
    expect(constructs(report.warnings)).toEqual(['protocol-profile-behavior']);
  });

  it('oauth2 PKCE is reported + raw auth kept', () => {
    const auth = {
      type: 'oauth2',
      oauth2: [
        { key: 'grant_type', value: 'authorization_code_with_pkce' },
        { key: 'challengeAlgorithm', value: 'S256' },
      ],
    };
    const { collection, report } = importPostmanCollection(one({ auth }));
    expect(req(collection.items[0]).auth?.oauth2?.grantType).toBe('authorization_code');
    expect(getPostmanSidecar(collection.items[0]!)?.auth).toEqual(auth);
    expect(constructs(report.warnings)).toEqual(['oauth2-grant']);
  });

  it('oauth2 implicit is reported + raw auth kept', () => {
    const auth = { type: 'oauth2', oauth2: [{ key: 'grant_type', value: 'implicit' }] };
    const { collection, report } = importPostmanCollection(one({ auth }));
    expect(req(collection.items[0]).auth?.oauth2?.grantType).toBeUndefined();
    expect(getPostmanSidecar(collection.items[0]!)?.auth).toEqual(auth);
    expect(constructs(report.warnings)).toEqual(['oauth2-grant']);
  });

  it('applies the injected script transform and records the source version', () => {
    const { collection, report } = importPostmanCollection(
      one({}, { event: [{ listen: 'prerequest', script: { exec: ['pm.x()'] } }] }),
      { transformScript: (s) => s.replace('pm.', 'rs.') }
    );
    expect(req(collection.items[0]).preRequestScript).toBe('rs.x()');
    expect(report.sourceVersion).toBe('2.1');
  });

  it('a clean collection carries no sidecar', () => {
    const { collection } = importPostmanCollection(one({}));
    expect(getPostmanSidecar(collection.items[0]!)).toBeUndefined();
    expect('_postman' in collection).toBe(false);
    expect('_postman' in collection.items[0]!).toBe(false);
  });

  it('defaults to the pm.* → rs.* script migration', () => {
    const { collection } = importPostmanCollection(
      one({}, { event: [{ listen: 'test', script: { exec: ['pm.expect(1)'] } }] })
    );
    expect(req(collection.items[0]).testScript).toBe('rs.expect(1)');
  });
});

describe('URL path variables and fragments (SDK parity)', () => {
  it('substitutes :name path segments from url.variable like the former SDK', () => {
    const { collection, report } = importPostmanCollection(
      one({
        url: {
          raw: '{{base}}/users/:id/posts/:postId?x=1',
          variable: [
            { key: 'id', value: '42' },
            { key: 'postId', value: 7 },
          ],
          query: [{ key: 'x', value: '1' }],
        },
      })
    );
    expect(req(collection.items[0]).url).toBe('{{base}}/users/42/posts/7');
    expect(report.warnings).toEqual([]);
    expect(getPostmanSidecar(collection.items[0]!)).toBeUndefined();
  });

  it('never touches ports, {{vars}} or partial segments', () => {
    const { collection } = importPostmanCollection(
      one({
        url: {
          raw: 'http://localhost:8080/{{v}}/a:id/:id',
          variable: [
            { key: '8080', value: 'X' },
            { key: 'id', value: '1' },
          ],
        },
      })
    );
    expect(req(collection.items[0]).url).toBe('http://localhost:8080/{{v}}/a:id/1');
  });

  it('unresolvable or described path variables are reported and kept', () => {
    const variable = [
      { key: 'id', value: '' },
      { key: 'org', value: 'acme', description: 'Organisation slug' },
    ];
    const { collection, report } = importPostmanCollection(
      one({ url: { raw: 'https://x.example.com/:org/:id', variable } })
    );
    expect(req(collection.items[0]).url).toBe('https://x.example.com/acme/:id');
    expect(getPostmanSidecar(collection.items[0]!)?.urlVariable).toEqual(variable);
    expect(constructs(report.warnings)).toEqual(['path-variables']);
  });

  it('keeps the fragment whether or not there is a query', () => {
    const url = (u: string) => req(importPostmanCollection(one({ url: u })).collection.items[0]);
    expect(url('https://x.example.com/p#frag').url).toBe('https://x.example.com/p#frag');
    const withQuery = url('https://x.example.com/p?a=1#frag');
    expect(withQuery.url).toBe('https://x.example.com/p#frag');
    expect(withQuery.params.map((p) => [p.key, p.value])).toEqual([['a', '1']]);
  });
});
