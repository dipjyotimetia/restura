import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { HttpRequest } from '@shared/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LoadedRequest } from '../collectionLoader';
import { executeHttp } from '../executors/http';
import type { ExecuteOptions } from '../executors/types';

interface Seen {
  method: string;
  url: URL;
  headers: IncomingMessage['headers'];
  body: string;
}

let server: Server;
let baseUrl: string;
const seen: Seen[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({
        method: req.method ?? '',
        url: new URL(req.url ?? '/', 'http://127.0.0.1'),
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf-8'),
      });
      res.setHeader('content-type', 'application/json');
      res.end('{"data":{"ok":true}}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
});

beforeEach(() => {
  seen.length = 0;
});

const opts: ExecuteOptions = { vars: { NAME: 'Ada' }, timeoutMs: 5000, allowLocalhost: true };

function graphqlItem(method: 'GET' | 'POST', extra: Partial<HttpRequest> = {}): LoadedRequest {
  const request: HttpRequest = {
    id: 'q1',
    name: 'Query',
    type: 'http',
    method,
    url: `${baseUrl}/graphql`,
    headers: [],
    params: [],
    body: {
      type: 'graphql',
      raw: 'query Hello($name: String) { hello(name: $name) }',
      graphqlVariables: '{"name":"{{NAME}}"}',
    },
    auth: { type: 'none' },
    ...extra,
  };
  return { relativePath: 'q.graphql', folderPath: [], type: 'http', request };
}

const SPEC_ACCEPT = 'application/graphql-response+json, application/json;q=0.9';

describe('CLI GraphQL wire shaping (#1109)', () => {
  it('GET puts query, variables and operationName in the URL with the spec Accept', async () => {
    const outcome = await executeHttp(graphqlItem('GET'), opts);
    expect(outcome.passed).toBe(true);
    expect(seen).toHaveLength(1);
    const req = seen[0]!;
    expect(req.method).toBe('GET');
    expect(req.url.searchParams.get('query')).toBe(
      'query Hello($name: String) { hello(name: $name) }'
    );
    expect(JSON.parse(req.url.searchParams.get('variables') ?? 'null')).toEqual({ name: 'Ada' });
    expect(req.url.searchParams.get('operationName')).toBe('Hello');
    expect(req.headers.accept).toBe(SPEC_ACCEPT);
    expect(req.body).toBe('');
  });

  it('GET refuses a mutation without sending anything', async () => {
    const outcome = await executeHttp(
      graphqlItem('GET', { body: { type: 'graphql', raw: 'mutation { add }' } }),
      opts
    );
    expect(outcome.passed).toBe(false);
    expect(outcome.errorMessage).toMatch(/GET can only send query operations/);
    expect(seen).toHaveLength(0);
  });

  it('POST still sends the JSON envelope, now with the spec Accept header', async () => {
    const outcome = await executeHttp(graphqlItem('POST'), opts);
    expect(outcome.passed).toBe(true);
    const req = seen[0]!;
    expect(req.method).toBe('POST');
    expect(req.url.search).toBe('');
    expect(req.headers['content-type']).toMatch(/^application\/json/);
    expect(req.headers.accept).toBe(SPEC_ACCEPT);
    expect(JSON.parse(req.body)).toEqual({
      query: 'query Hello($name: String) { hello(name: $name) }',
      variables: { name: 'Ada' },
      operationName: 'Hello',
    });
  });

  it('POST with a stored JSON envelope sends it unchanged', async () => {
    const envelope = { query: '{ a }', variables: { x: '{{NAME}}' } };
    await executeHttp(
      graphqlItem('POST', { body: { type: 'graphql', raw: JSON.stringify(envelope) } }),
      opts
    );
    expect(JSON.parse(seen[0]!.body)).toEqual({ query: '{ a }', variables: { x: 'Ada' } });
  });

  it('a user-set Accept header wins', async () => {
    await executeHttp(
      graphqlItem('POST', {
        headers: [{ id: 'h', key: 'Accept', value: 'application/json', enabled: true }],
      }),
      opts
    );
    expect(seen[0]!.headers.accept).toBe('application/json');
  });
});
