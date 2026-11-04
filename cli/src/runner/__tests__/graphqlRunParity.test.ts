/**
 * CLI ↔ app parity for saved GraphQL requests: JSON-safe variable
 * substitution, an explicit failure on invalid variables JSON (never a silent
 * `variables: {}`), and `multipart/mixed` incremental (@defer / @stream)
 * responses folded into one JSON result like the app does.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { HttpRequest } from '@shared/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LoadedRequest } from '../collectionLoader';
import { executeHttp } from '../executors/http';
import type { ExecuteOptions } from '../executors/types';

const part = (json: string) =>
  `\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${
    new TextEncoder().encode(json).byteLength
  }\r\n\r\n${json}\r\n---`;
const INCREMENTAL_BODY =
  '\r\n---' +
  part('{"data":{"hello":"world","list":["a"]},"hasNext":true}') +
  part('{"incremental":[{"items":["b"],"path":["list",1]}],"hasNext":true}') +
  part('{"incremental":[{"data":{"slowField":"done"},"path":[],"label":"slow"}],"hasNext":true}') +
  part('{"hasNext":false}') +
  '--\r\n';

let server: Server;
let baseUrl: string;
const bodies: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      bodies.push(Buffer.concat(chunks).toString('utf-8'));
      if (req.url?.startsWith('/incremental')) {
        res.setHeader('content-type', 'multipart/mixed; boundary="-"');
        res.end(INCREMENTAL_BODY);
        return;
      }
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
  bodies.length = 0;
});

function item(body: HttpRequest['body'], path = '/graphql'): LoadedRequest {
  const request: HttpRequest = {
    id: 'q',
    name: 'Q',
    type: 'http',
    method: 'POST',
    url: `${baseUrl}${path}`,
    headers: [],
    params: [],
    body,
    auth: { type: 'none' },
  };
  return { relativePath: 'q.graphql', folderPath: [], type: 'http', request };
}

const QUERY = 'query Q($name: String) { hi(name: $name) }';

describe('CLI GraphQL saved variables', () => {
  it('substitutes a value holding quotes and backslashes without breaking the JSON', async () => {
    const opts: ExecuteOptions = {
      vars: { NAME: 'O"Brien \\ x' },
      timeoutMs: 5000,
      allowLocalhost: true,
    };
    const outcome = await executeHttp(
      item({ type: 'graphql', raw: QUERY, graphqlVariables: '{"name":"{{NAME}}"}' }),
      opts
    );
    expect(outcome.passed).toBe(true);
    expect(JSON.parse(bodies[0]!).variables).toEqual({ name: 'O"Brien \\ x' });
  });

  it('fails the request on invalid variables JSON instead of sending {}', async () => {
    const outcome = await executeHttp(
      item({ type: 'graphql', raw: QUERY, graphqlVariables: '{"name": ' }),
      { vars: {}, timeoutMs: 5000, allowLocalhost: true }
    );
    expect(outcome.passed).toBe(false);
    expect(outcome.errorMessage).toMatch(/Invalid JSON in GraphQL variables/);
    expect(bodies).toHaveLength(0);
  });

  it("blank variables text keeps a stored envelope's own variables", async () => {
    const raw = JSON.stringify({ query: QUERY, variables: { name: 'kept' } });
    await executeHttp(item({ type: 'graphql', raw, graphqlVariables: '' }), {
      vars: {},
      timeoutMs: 5000,
      allowLocalhost: true,
    });
    expect(JSON.parse(bodies[0]!).variables).toEqual({ name: 'kept' });
  });
});

describe('CLI GraphQL incremental delivery (@defer / @stream)', () => {
  it('merges a multipart/mixed response into one JSON result', async () => {
    const outcome = await executeHttp(
      item(
        { type: 'graphql', raw: 'query { hello ... @defer(label: "slow") { slowField } list }' },
        '/incremental'
      ),
      { vars: {}, timeoutMs: 5000, allowLocalhost: true }
    );
    expect(outcome.passed).toBe(true);
    expect(outcome.responseHeaders?.['content-type']).toBe('application/json; charset=utf-8');
    expect(JSON.parse(outcome.responseBody ?? 'null')).toEqual({
      data: { hello: 'world', list: ['a', 'b'], slowField: 'done' },
    });
  });
});
