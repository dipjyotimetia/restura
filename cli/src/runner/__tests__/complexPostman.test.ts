import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Reporter, RequestRunResult, RunResult } from '../../reporters/types';
import { runCollection } from '../runner';

// The shared complex Postman fixtures (`shared/collections/postman/__fixtures__`)
// run end to end through the CLI against a local server: auth inheritance at
// the wire, bodies, query/header toggles, explicit-noauth / unsupported-auth
// refusals, scripts at three levels, and v3 HTTP + GraphQL items.

const FIXTURES = resolve(__dirname, '../../../../shared/collections/postman/__fixtures__');

interface Hit {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: string;
}

let server: Server;
let baseUrl: string;
const hits: Hit[] = [];

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (c: Buffer) => {
      body += c.toString('utf8');
    });
    req.on('end', () => {
      hits.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body });
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
});

class NoopReporter implements Reporter {
  onEnd(): void {}
}

const OPTS = { envVars: {}, bail: false, timeoutMs: 5000, allowLocalhost: true } as const;

function result(run: RunResult, name: string): RequestRunResult {
  const r = run.requests.find((x) => x.request.request.name === name);
  if (!r) throw new Error(`no result for ${name}`);
  return r;
}

function hit(pathPrefix: string): Hit {
  const h = hits.find((x) => x.path.startsWith(pathPrefix));
  if (!h) throw new Error(`no request to ${pathPrefix}: ${hits.map((x) => x.path).join(', ')}`);
  return h;
}

const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;

// Every request runs the collection-level scripts in a fresh sandbox, so a
// run of the fixture takes several seconds.
const RUN_TIMEOUT = 60_000;

describe('complex v2.1 collection through the CLI', () => {
  let r: RunResult;
  beforeAll(async () => {
    hits.length = 0;
    r = await runCollection(
      resolve(FIXTURES, 'v21/complex.postman_collection.json'),
      {
        ...OPTS,
        envVars: { userId: '7', name: 'Ada' },
        overrideVars: { baseUrl },
        filter: {
          include: [
            'Health',
            'Get user',
            'Create user',
            'Avatar upload',
            'Legacy login',
            'XML',
            'GraphQL templated',
            'Purge',
            'Raw header block',
            'API key query',
            'Under hawk',
          ],
        },
      },
      new NoopReporter()
    );
  }, RUN_TIMEOUT);

  it('sends every request with the right method, url, headers, body and inherited auth', () => {
    const health = hit('/health');
    expect(health.method).toBe('HEAD');
    expect(health.headers.authorization).toBe('Bearer root-token');

    // Folder basic auth; path variable baked in; disabled query + header not sent.
    const getUser = hit('/users/42');
    expect(getUser.method).toBe('GET');
    expect(getUser.path).toBe('/users/42?expand=roles');
    expect(getUser.headers.authorization).toBe(basic('admin', 'admin-pw'));
    expect(getUser.headers.accept).toBe('application/json');
    expect(getUser.headers['x-off']).toBeUndefined();

    const create = hits.find((h) => h.path === '/users' && h.method === 'POST')!;
    expect(JSON.parse(create.body)).toEqual({ name: 'Ada' });
    expect(create.headers.authorization).toBe(basic('admin', 'admin-pw'));

    // Form-data with a file row whose file is unavailable: the text part is sent.
    const avatar = hit('/users/42/avatar');
    expect(avatar.headers['content-type']).toMatch(/^multipart\/form-data/);
    expect(avatar.body).toContain('name="meta"');
    expect(avatar.body).not.toContain('name="skip"');

    expect(hit('/xml').body).toBe('<a/>');
    const gql = JSON.parse(hit('/graphql').body) as { query: string; variables: unknown };
    expect(gql.variables).toEqual({ id: 7 }); // the `{{userId}}` template survived import
    expect(hit('/cache').method).toBe('PURGE');
    expect(hit('/headers').headers['x-two']).toBe('two');
    expect(hit('/k?').path).toBe('/k?api_key=K');

    expect(result(r, 'Get user').passed).toBe(true);
  });

  it('runs collection → folder → request scripts in separate scopes; disabled events never run', () => {
    const getUser = result(r, 'Get user');
    expect(getUser.errorMessage).toBeUndefined();
    const names = (getUser.assertions ?? []).map((a) => [a.name, a.passed]);
    expect(names).toContainEqual(['status 200', true]);
    expect(names).toContainEqual(['collection: has a status', true]);
    expect(names.map(([n]) => n)).not.toContain('disabled test must not run');
  });

  it('refuses explicit-noauth and unsupported-auth requests instead of leaking a parent credential', () => {
    expect(result(r, 'Legacy login')).toMatchObject({ notSent: true, passed: false });
    expect(result(r, 'Under hawk')).toMatchObject({ notSent: true, passed: false });
    expect(hits.some((h) => h.path === '/login' || h.path === '/under-hawk')).toBe(false);
    expect(r.summary).toMatchObject({ total: 11, notSent: 2 });
  });
});

describe('complex v3 folder through the CLI', () => {
  it(
    'runs HTTP and GraphQL items with folder auth, explicit noauth and secret variables',
    async () => {
      hits.length = 0;
      const r = await runCollection(
        resolve(FIXTURES, 'v3/complex'),
        {
          ...OPTS,
          envVars: { apiToken: 'env-token', sku: 'SKU-1', userId: '9' },
          overrideVars: { baseUrl },
          filter: {
            include: [
              'Health',
              'Create order',
              'Login form',
              'Public',
              'Viewer',
              'Body mode',
              'Events',
            ],
          },
        },
        new NoopReporter()
      );

      // The vault (secret) variable is value-less in the import, so --env fills it.
      expect(hit('/health').headers.authorization).toBe('Bearer env-token');
      const create = hit('/orders');
      expect(create.headers['x-api-key']).toBe('folder-key'); // REST folder api-key
      expect(JSON.parse(create.body)).toEqual({ sku: 'SKU-1', qty: 2 });
      const login = hit('/login');
      expect(login.headers.authorization).toBe(basic('ada', 'pw'));
      expect(new URLSearchParams(login.body).toString()).toBe('user=ada&password=pw');

      const viewer = hits.find((h) => h.path === '/graphql' && h.body.includes('Viewer'))!;
      const body = JSON.parse(viewer.body) as { variables: unknown; operationName?: string };
      expect(body).toMatchObject({ variables: { id: 9 }, operationName: 'Viewer' });
      expect(viewer.headers.authorization).toBe('Bearer env-token');

      expect(result(r, 'Public')).toMatchObject({ notSent: true });
      // Events inherits OAuth2 client credentials two folders up; the token
      // endpoint is not reachable here, so it fails — but never as "not sent".
      expect(result(r, 'Events').notSent).toBeUndefined();
      expect(r.summary.notSent).toBe(1);
    },
    RUN_TIMEOUT
  );
});
