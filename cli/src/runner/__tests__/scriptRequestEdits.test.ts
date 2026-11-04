/**
 * Pre-request script request edits, CLI side of the app rules in
 * `requestExecutor` / gRPC `protocol.ts`: the script sees header templates,
 * and cannot add a secret-variable token to a header or metadata entry.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GrpcRequest, HttpRequest } from '@shared/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Reporter } from '../../reporters/types';
import type { LoadedRequest } from '../collectionLoader';
import { executeHttp } from '../executors/http';
import { runCollection } from '../runner';
import { applyPreRequestMetadata, runPreRequestScript } from '../scriptRunner';

const runCtx = { collectionVars: {}, iterationData: {}, iteration: 0, iterationCount: 1 };

function httpItem(extra: Partial<LoadedRequest> = {}): LoadedRequest {
  const request: HttpRequest = {
    id: 'h1',
    name: 'Echo',
    type: 'http',
    method: 'GET',
    url: 'https://api.example.com/x',
    headers: [
      { id: 'a', key: 'X-Tenant', value: '{{tenant}}', enabled: true },
      { id: 'b', key: 'Authorization', value: 'Bearer {{tok}}', enabled: true },
    ],
    params: [],
    body: { type: 'none' },
    auth: { type: 'none' },
  };
  return { relativePath: 'a.http', folderPath: [], type: 'http', request, ...extra };
}

function grpcItem(extra: Partial<LoadedRequest> = {}): LoadedRequest {
  const request: GrpcRequest = {
    id: 'g1',
    name: 'Call',
    type: 'grpc',
    methodType: 'unary',
    url: 'http://127.0.0.1:1/',
    service: 'echo.EchoService',
    method: 'Echo',
    metadata: [{ id: 'm', key: 'x-tenant', value: '{{tenant}}', enabled: true }],
    message: '{}',
    auth: { type: 'none' },
  };
  return { relativePath: 'a.grpc', folderPath: [], type: 'grpc', request, ...extra };
}

const vars = { tenant: 'acme', tok: 's3cret' };

describe('CLI pre-request header view', () => {
  it('shows a pre-request script the header templates, as the app does', async () => {
    const pre = await runPreRequestScript(
      `rs.environment.set('seen', rs.request.headers['X-Tenant']);`,
      httpItem(),
      vars,
      runCtx
    );
    expect(pre.variables.seen).toBe('{{tenant}}');
  });

  it('keeps untouched template rows as templates when folding header edits back', async () => {
    const pre = await runPreRequestScript(
      `rs.request.headers['X-Extra'] = 'e';`,
      httpItem(),
      vars,
      runCtx
    );
    const sent = applyPreRequestMetadata(httpItem(), pre, vars);
    const headers = (sent.request as HttpRequest).headers;
    expect(headers.map((h) => [h.key, h.value])).toEqual([
      ['X-Tenant', '{{tenant}}'],
      ['Authorization', 'Bearer {{tok}}'],
      ['X-Extra', 'e'],
    ]);
  });
});

describe('CLI refuses a script-written secret token', () => {
  it('blocks an HTTP item whose script adds a secret variable to a header', async () => {
    const item = httpItem({ secretVariableNames: ['tok'] });
    const pre = await runPreRequestScript(
      `rs.request.headers['X-Leak'] = '{{tok}}';`,
      item,
      vars,
      runCtx
    );
    const sent = applyPreRequestMetadata(item, pre, vars);
    expect(sent.blocked).toMatch(/secret variable "tok".*rs\.request\.headers "X-Leak"/);
    const outcome = await executeHttp(sent, { vars, timeoutMs: 1000, allowLocalhost: true });
    expect(outcome).toMatchObject({ status: 0, passed: false, refused: true });
    expect(outcome.errorMessage).toContain('secret variable "tok"');
  });

  it('allows a secret token already saved in the same header', async () => {
    const item = httpItem({ secretVariableNames: ['tok'] });
    const pre = await runPreRequestScript(
      `rs.request.headers['Authorization'] = 'Bearer {{tok}} x';`,
      item,
      vars,
      runCtx
    );
    expect(applyPreRequestMetadata(item, pre, vars).blocked).toBeUndefined();
  });

  it('blocks a gRPC item whose script adds a secret variable to metadata', async () => {
    const item = grpcItem({ secretVariableNames: ['tok'] });
    const pre = await runPreRequestScript(
      `rs.request.metadata['x-leak'] = '{{tok}}';`,
      item,
      vars,
      runCtx
    );
    expect(applyPreRequestMetadata(item, pre, vars).blocked).toMatch(
      /secret variable "tok".*rs\.request\.metadata "x-leak"/
    );
  });
});

describe('security: a hostile upstream cannot get a secret forwarded via a script header', () => {
  let server: Server;
  let baseUrl: string;
  const seen: Array<{ url: string | undefined; csrf: string | undefined }> = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push({ url: req.url, csrf: req.headers['x-csrf'] as string | undefined });
      res.writeHead(200, { 'content-type': 'application/json' });
      // The upstream answers with a template naming the CI secret.
      res.end(JSON.stringify({ csrf: '{{CI_DEPLOY_TOKEN}}' }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('refuses the request instead of expanding {{CI_DEPLOY_TOKEN}} into X-CSRF', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'restura-csrf-forward-'));
    const file = join(dir, 'collection.yaml');
    writeFileSync(
      file,
      `opencollection: "1.0.0"
info:
  name: CsrfForward
bundled: true
items:
  - info:
      name: api
      seq: 1
    request:
      variables:
        - name: CI_DEPLOY_TOKEN
          secret: true
    items:
      - info: { type: http, name: Login, seq: 1 }
        http:
          method: GET
          url: "${baseUrl}/login"
        runtime:
          scripts:
            - type: tests
              code: |
                rs.environment.set('csrf', rs.response.json().csrf);
      - info: { type: http, name: Act, seq: 2 }
        http:
          method: GET
          url: "${baseUrl}/act"
        runtime:
          scripts:
            - type: before-request
              code: |
                rs.request.headers['X-CSRF'] = rs.environment.get('csrf');
`
    );
    const quiet: Reporter = { onEnd() {} };
    const result = await runCollection(
      file,
      {
        envVars: { CI_DEPLOY_TOKEN: 'deploy-secret' },
        bail: false,
        timeoutMs: 5000,
        allowLocalhost: true,
      },
      quiet
    );
    expect(seen.some((s) => s.csrf?.includes('deploy-secret'))).toBe(false);
    expect(seen.map((s) => s.url)).toEqual(['/login']);
    const act = result.requests.find((r) => r.request.request.name === 'Act');
    expect(act).toMatchObject({ passed: false });
    expect(act?.errorMessage).toContain('secret variable "CI_DEPLOY_TOKEN"');
  });
});
