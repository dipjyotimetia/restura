import { describe, expect, it } from 'vitest';
import type { CollectionItem, HttpRequest } from '@/types';
import type { BrunoSource } from '../importers';
import { importBrunoCollection } from '../importers';

function asHttpRequest(r: unknown): HttpRequest {
  return r as HttpRequest;
}

function findRequest(items: CollectionItem[], name: string): CollectionItem | undefined {
  for (const it of items) {
    if (it.type === 'request' && it.name === name) return it;
    if (it.type === 'folder' && it.items) {
      const nested = findRequest(it.items, name);
      if (nested) return nested;
    }
  }
  return undefined;
}

describe('importBrunoCollection', () => {
  describe('single-file mode', () => {
    it('parses a request with all major blocks', async () => {
      const bru = `meta {
  name: Get User
  type: http
  seq: 1
}

get {
  url: {{API_HOST}}/users/1
  body: json
  auth: bearer
}

headers {
  Accept: application/json
  ~Disabled: x
}

params:query {
  page: 1
  size: 10
}

auth:bearer {
  token: {{TOKEN}}
}

body:json {
  {"id": 1}
}

vars:pre-request {
  myVar: hello
}

script:pre-request {
  bru.setVar('foo', 'bar');
}

script:post-response {
  console.log('done');
}

tests {
  test('returns user', function() {
    expect(res.body.id).to.equal(1);
  });
}
`;
      const result = await importBrunoCollection({ kind: 'single', content: bru });
      expect(result.collection.name).toBe('Bruno Import');
      expect(result.collection.items).toHaveLength(1);
      const item = result.collection.items[0]!;
      expect(item.name).toBe('Get User');
      expect(item.type).toBe('request');
      const req = asHttpRequest(item.request);
      expect(req.method).toBe('GET');
      expect(req.url).toBe('{{API_HOST}}/users/1');

      // Headers (disabled flag preserved)
      expect(req.headers).toHaveLength(2);
      expect(req.headers[0]).toMatchObject({
        key: 'Accept',
        value: 'application/json',
        enabled: true,
      });
      expect(req.headers[1]).toMatchObject({ key: 'Disabled', value: 'x', enabled: false });

      // Query params
      expect(req.params).toHaveLength(2);
      expect(req.params[0]).toMatchObject({ key: 'page', value: '1', enabled: true });
      expect(req.params[1]).toMatchObject({ key: 'size', value: '10', enabled: true });

      // Body
      expect(req.body.type).toBe('json');
      expect(req.body.raw).toBe('{"id": 1}');

      // Auth
      expect(req.auth.type).toBe('bearer');
      expect(req.auth.bearer?.token).toBe('{{TOKEN}}');

      // Scripts — pre-request and post-response/tests merged
      expect(req.preRequestScript).toContain("bru.setVar('foo', 'bar')");
      expect(req.testScript).toContain("console.log('done')");
      expect(req.testScript).toContain("test('returns user'");
    });

    it('parses bearer auth from a minimal request', async () => {
      const bru = `meta {
  name: Tiny
  type: http
}

get {
  url: https://example.com
  auth: bearer
}

auth:bearer {
  token: abc
}
`;
      const result = await importBrunoCollection({ kind: 'single', content: bru });
      const req = asHttpRequest(result.collection.items[0]!.request);
      expect(req.auth.type).toBe('bearer');
      expect(req.auth.bearer?.token).toBe('abc');
    });
  });

  describe('directory mode', () => {
    it('handles bruno.json + collection.bru + environments + nested folders', async () => {
      const source: BrunoSource = {
        kind: 'directory',
        entries: [
          {
            relativePath: 'bruno.json',
            content: JSON.stringify({ version: '1', name: 'My Workspace', type: 'collection' }),
          },
          {
            relativePath: 'collection.bru',
            content: `headers {
  X-Default: yes
}

vars:pre-request {
  GLOBAL: gval
}
`,
          },
          {
            relativePath: 'environments/dev.bru',
            content: `vars {
  HOST: https://dev.example.com
  ~OFF: nope
}

vars:secret [
  SECRET_TOKEN
]
`,
          },
          {
            relativePath: 'environments/prod.bru',
            content: `vars {
  HOST: https://prod.example.com
}
`,
          },
          {
            relativePath: 'users/get-user.bru',
            content: `meta {
  name: Get User
  type: http
}

get {
  url: {{HOST}}/users/1
}
`,
          },
          {
            relativePath: 'users/create-user.bru',
            content: `meta {
  name: Create User
  type: http
}

post {
  url: {{HOST}}/users
  body: json
}

body:json {
  {"name": "alice"}
}
`,
          },
          {
            relativePath: 'auth/login.bru',
            content: `meta {
  name: Login
  type: http
}

post {
  url: {{HOST}}/login
}
`,
          },
        ],
      };

      const result = await importBrunoCollection(source);
      expect(result.collection.name).toBe('My Workspace');
      expect(result.collection.variables).toEqual([
        expect.objectContaining({ key: 'GLOBAL', value: 'gval', enabled: true }),
      ]);

      // Folders preserved
      const userFolder = result.collection.items.find(
        (i) => i.type === 'folder' && i.name === 'users'
      );
      const authFolder = result.collection.items.find(
        (i) => i.type === 'folder' && i.name === 'auth'
      );
      expect(userFolder).toBeDefined();
      expect(authFolder).toBeDefined();
      expect(userFolder!.items).toHaveLength(2);
      expect(authFolder!.items).toHaveLength(1);

      // Requests resolvable from any folder depth
      const getUser = findRequest(result.collection.items, 'Get User');
      expect(getUser).toBeDefined();
      expect(asHttpRequest(getUser!.request).url).toBe('{{HOST}}/users/1');

      const createUser = findRequest(result.collection.items, 'Create User');
      expect(createUser).toBeDefined();
      const createReq = asHttpRequest(createUser!.request);
      expect(createReq.method).toBe('POST');
      expect(createReq.body.type).toBe('json');
      expect(createReq.body.raw).toBe('{"name": "alice"}');

      // Environments — both files become standalone Environment records
      expect(result.environments).toHaveLength(2);
      const dev = result.environments!.find((e) => e.name === 'dev');
      const prod = result.environments!.find((e) => e.name === 'prod');
      expect(dev).toBeDefined();
      expect(prod).toBeDefined();
      // Disabled var preserved with enabled=false
      expect(dev!.variables).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: 'HOST', value: 'https://dev.example.com', enabled: true }),
          expect.objectContaining({ key: 'OFF', value: 'nope', enabled: false }),
          expect.objectContaining({ key: 'SECRET_TOKEN', secret: true }),
        ])
      );
      expect(prod!.variables).toEqual([
        expect.objectContaining({ key: 'HOST', value: 'https://prod.example.com' }),
      ]);
    });

    it('falls back to default name when bruno.json is missing', async () => {
      const result = await importBrunoCollection({
        kind: 'directory',
        entries: [
          {
            relativePath: 'one.bru',
            content: `meta {
  name: Alone
  type: http
}

get {
  url: https://example.com
}
`,
          },
        ],
      });
      expect(result.collection.name).toBe('Bruno Collection');
      expect(result.collection.items).toHaveLength(1);
    });
  });

  describe('Bruno-specific syntax warnings', () => {
    it('warns on {{process.env.X}} and {{$res.body.id}}', async () => {
      const bru = `meta {
  name: Chained
  type: http
}

post {
  url: https://example.com/things/{{$res.body.id}}
}

headers {
  X-Token: {{process.env.TOKEN}}
}
`;
      const result = await importBrunoCollection({ kind: 'single', content: bru });
      const labels = result.warnings
        .filter((w) => w.kind === 'bruno-syntax')
        .map((w) => (w.kind === 'bruno-syntax' ? w.pattern : ''));
      expect(labels).toContain('process.env reference');
      expect(labels).toContain('response-chain reference');
    });

    it('warns on {{$randomInt(...)}}', async () => {
      const bru = `meta {
  name: Random
  type: http
}

get {
  url: https://example.com/?n={{$randomInt(1, 100)}}
}
`;
      const result = await importBrunoCollection({ kind: 'single', content: bru });
      expect(
        result.warnings.some(
          (w) => w.kind === 'bruno-syntax' && w.pattern === 'randomInt with range'
        )
      ).toBe(true);
    });
  });

  describe('auth mappings', () => {
    it('maps oauth1 with all the fields Bruno emits', async () => {
      const bru = `meta {
  name: O1
  type: http
}

get {
  url: https://example.com
  auth: oauth1
}

auth:oauth1 {
  consumer_key: ck
  consumer_secret: cs
  access_token: at
  token_secret: ats
  signature_method: HMAC-SHA256
  realm: my-realm
  callback_url: https://cb
  placement: header
}
`;
      const result = await importBrunoCollection({ kind: 'single', content: bru });
      const req = asHttpRequest(result.collection.items[0]!.request);
      expect(req.auth.type).toBe('oauth1');
      expect(req.auth.oauth1).toMatchObject({
        consumerKey: 'ck',
        consumerSecret: 'cs',
        accessToken: 'at',
        accessTokenSecret: 'ats',
        signatureMethod: 'HMAC-SHA256',
        realm: 'my-realm',
      });
    });

    it('maps ntlm with optional domain/workstation', async () => {
      const bru = `meta {
  name: NT
  type: http
}

get {
  url: https://example.com
  auth: ntlm
}

auth:ntlm {
  username: alice
  password: secret
  domain: CORP
}
`;
      const result = await importBrunoCollection({ kind: 'single', content: bru });
      const req = asHttpRequest(result.collection.items[0]!.request);
      expect(req.auth.type).toBe('ntlm');
      expect(req.auth.ntlm).toMatchObject({
        username: 'alice',
        password: 'secret',
        domain: 'CORP',
      });
    });

    it('maps wsse', async () => {
      const bru = `meta {
  name: W
  type: http
}

get {
  url: https://example.com
  auth: wsse
}

auth:wsse {
  username: u
  password: p
}
`;
      const result = await importBrunoCollection({ kind: 'single', content: bru });
      const req = asHttpRequest(result.collection.items[0]!.request);
      expect(req.auth.type).toBe('wsse');
      expect(req.auth.wsse).toMatchObject({ username: 'u', password: 'p' });
    });

    it('maps basic, apikey (header & query), awsv4, digest, oauth2', async () => {
      const cases: Array<{ name: string; bru: string; assert: (req: HttpRequest) => void }> = [
        {
          name: 'basic',
          bru: `meta { name: B
  type: http
}
get {
  url: https://example.com
  auth: basic
}
auth:basic {
  username: u
  password: p
}
`,
          assert: (req) => {
            expect(req.auth.type).toBe('basic');
            expect(req.auth.basic).toMatchObject({ username: 'u', password: 'p' });
          },
        },
        {
          name: 'apikey-query',
          bru: `meta { name: AK
  type: http
}
get {
  url: https://example.com
  auth: apikey
}
auth:apikey {
  key: api_key
  value: abc
  placement: queryparams
}
`,
          assert: (req) => {
            expect(req.auth.type).toBe('api-key');
            expect(req.auth.apiKey).toMatchObject({ key: 'api_key', value: 'abc', in: 'query' });
          },
        },
        {
          name: 'awsv4',
          bru: `meta { name: AWS
  type: http
}
get {
  url: https://example.com
  auth: awsv4
}
auth:awsv4 {
  accessKeyId: AKIA
  secretAccessKey: secret
  service: s3
  region: us-west-2
}
`,
          assert: (req) => {
            expect(req.auth.type).toBe('aws-signature');
            expect(req.auth.awsSignature).toMatchObject({
              accessKey: 'AKIA',
              secretKey: 'secret',
              service: 's3',
              region: 'us-west-2',
            });
          },
        },
        {
          name: 'digest',
          bru: `meta { name: D
  type: http
}
get {
  url: https://example.com
  auth: digest
}
auth:digest {
  username: u
  password: p
}
`,
          assert: (req) => {
            expect(req.auth.type).toBe('digest');
            expect(req.auth.digest).toMatchObject({ username: 'u', password: 'p' });
          },
        },
        {
          name: 'oauth2',
          bru: `meta { name: O2
  type: http
}
post {
  url: https://example.com
  auth: oauth2
}
auth:oauth2 {
  grant_type: authorization_code
  callback_url: https://cb
  authorization_url: https://auth
  access_token_url: https://token
  client_id: cid
  client_secret: csec
  scope: read
}
`,
          assert: (req) => {
            expect(req.auth.type).toBe('oauth2');
            expect(req.auth.oauth2).toMatchObject({
              grantType: 'authorization_code',
              clientId: 'cid',
              clientSecret: 'csec',
              authorizationUrl: 'https://auth',
              tokenUrl: 'https://token',
              redirectUri: 'https://cb',
              scope: 'read',
            });
          },
        },
      ];

      for (const c of cases) {
        const result = await importBrunoCollection({ kind: 'single', content: c.bru });
        const req = asHttpRequest(result.collection.items[0]!.request);
        c.assert(req);
      }
    });
  });

  describe('body shapes', () => {
    it('maps graphql body to a JSON envelope', async () => {
      const bru = `meta {
  name: GQ
  type: http
}

post {
  url: https://example.com/graphql
  body: graphql
}

body:graphql {
  query Foo { user { id } }
}

body:graphql:vars {
  {"id": 1}
}
`;
      const result = await importBrunoCollection({ kind: 'single', content: bru });
      const req = asHttpRequest(result.collection.items[0]!.request);
      expect(req.body.type).toBe('graphql');
      expect(req.body.raw).toBeDefined();
      const parsed = JSON.parse(req.body.raw!);
      expect(parsed.query).toContain('user { id }');
      // The .bru parser preserves variables verbatim — assert it's present.
      expect(parsed).toHaveProperty('variables');
    });

    it('maps multipart-form with file entries', async () => {
      const bru = `meta {
  name: M
  type: http
}

post {
  url: https://example.com/upload
  body: multipartForm
}

body:multipart-form {
  user: alice
  file: @file(/tmp/a.txt)
}
`;
      const result = await importBrunoCollection({ kind: 'single', content: bru });
      const req = asHttpRequest(result.collection.items[0]!.request);
      expect(req.body.type).toBe('form-data');
      expect(req.body.formData).toHaveLength(2);
      expect(req.body.formData![0]).toMatchObject({ key: 'user', value: 'alice', type: 'text' });
      expect(req.body.formData![1]).toMatchObject({ key: 'file', type: 'file' });
    });

    it('maps form-urlencoded', async () => {
      const bru = `meta {
  name: F
  type: http
}

post {
  url: https://example.com
  body: formUrlEncoded
}

body:form-urlencoded {
  k1: v1
  k2: v2
}
`;
      const result = await importBrunoCollection({ kind: 'single', content: bru });
      const req = asHttpRequest(result.collection.items[0]!.request);
      expect(req.body.type).toBe('x-www-form-urlencoded');
      expect(req.body.formData).toEqual([
        expect.objectContaining({ key: 'k1', value: 'v1' }),
        expect.objectContaining({ key: 'k2', value: 'v2' }),
      ]);
    });
  });
});
