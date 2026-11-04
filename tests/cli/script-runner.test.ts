// @vitest-environment node
/**
 * Root-suite coverage of the CLI script runner (`cli/src/runner/scriptRunner.ts`):
 * what a pre-request / test script sees for each protocol, how its variable,
 * collection and flow-control effects come back, and how a pre-request
 * script's request edits are folded into the item that is sent — including the
 * refusal when a script writes a secret-variable token into a request field.
 */
import type { GrpcRequest, HttpRequest, McpRequest, SseRequest } from '@shared/types';
import { describe, expect, it } from 'vitest';
import type { LoadedRequest } from '../../cli/src/runner/collectionLoader';
import type { ExecuteOutcome } from '../../cli/src/runner/executors/types';
import {
  applyPreRequestMetadata,
  runPreRequestScript,
  runTestScript,
  type ScriptRunContext,
} from '../../cli/src/runner/scriptRunner';

const runCtx = (): ScriptRunContext => ({
  collectionVars: { shared: 'c1' },
  iterationData: { row: 'r1' },
  iteration: 1,
  iterationCount: 3,
});

const vars = { host: 'api.example.com', tenant: 'acme', tok: 's3cret' };

function httpItem(extra: Partial<LoadedRequest> = {}, req: Partial<HttpRequest> = {}) {
  const request: HttpRequest = {
    id: 'h1',
    name: 'Get user',
    type: 'http',
    method: 'POST',
    url: 'https://{{host}}/users',
    headers: [
      { id: 'a', key: 'X-Tenant', value: '{{tenant}}', enabled: true },
      { id: 'b', key: 'Authorization', value: 'Bearer {{tok}}', enabled: true },
      { id: 'c', key: 'X-Disabled', value: 'off', enabled: false },
      { id: 'd', key: '', value: 'no key', enabled: true },
    ],
    params: [],
    body: { type: 'json', raw: '{"name":"{{tenant}}"}' },
    auth: { type: 'none' },
    ...req,
  };
  return {
    relativePath: 'users/get.http',
    folderPath: ['users'],
    type: 'http',
    request,
    ...extra,
  } satisfies LoadedRequest;
}

function grpcItem(extra: Partial<LoadedRequest> = {}, req: Partial<GrpcRequest> = {}) {
  const request: GrpcRequest = {
    id: 'g1',
    name: 'Echo',
    type: 'grpc',
    methodType: 'unary',
    url: 'http://{{host}}:50051',
    service: 'echo.EchoService',
    method: 'Echo',
    metadata: [{ id: 'm', key: 'x-tenant', value: '{{tenant}}', enabled: true }],
    message: '{"msg":"hi"}',
    auth: { type: 'none' },
    ...req,
  };
  return {
    relativePath: 'echo.grpc',
    folderPath: [],
    type: 'grpc',
    request,
    ...extra,
  } satisfies LoadedRequest;
}

function mcpItem(req: Partial<McpRequest> = {}): LoadedRequest {
  const request: McpRequest = {
    id: 'mcp1',
    name: 'Tools',
    type: 'mcp',
    url: 'https://{{host}}/mcp',
    transport: 'streamable-http',
    headers: [
      { id: 'h', key: 'X-Tenant', value: '{{tenant}}', enabled: true },
      { id: 'x', key: 'X-Off', value: 'off', enabled: false },
    ],
    auth: { type: 'none' },
    defaultMethod: 'tools/{{verb}}',
    defaultParams: '{"t":"{{tenant}}"}',
    ...req,
  };
  return { relativePath: 'tools.mcp', folderPath: [], type: 'mcp', request };
}

function sseItem(): LoadedRequest {
  const request = {
    type: 'sse',
    url: 'https://{{host}}/events',
    headers: [],
    params: [],
    auth: { type: 'none' },
  } as unknown as SseRequest;
  return { relativePath: 'feeds/events.sse', folderPath: ['feeds'], type: 'sse', request };
}

const outcome = (extra: Partial<ExecuteOutcome> = {}): ExecuteOutcome => ({
  status: 201,
  passed: true,
  durationMs: 42,
  bodyBytes: 17,
  responseHeaders: { 'content-type': 'application/json' },
  responseBody: '{"id":7,"ok":true}',
  ...extra,
});

/** Run a pre-request script that copies values out through `rs.environment.set`. */
async function seenBy(item: LoadedRequest, expressions: Record<string, string>) {
  const script = Object.entries(expressions)
    .map(([k, expr]) => `rs.environment.set(${JSON.stringify(k)}, String(${expr}));`)
    .join('\n');
  const pre = await runPreRequestScript(script, item, vars, runCtx());
  expect(pre.errors).toEqual([]);
  return pre.variables;
}

describe('runPreRequestScript — the request a script sees', () => {
  it('HTTP: resolved URL, method, raw body and only enabled keyed header templates', async () => {
    const seen = await seenBy(httpItem(), {
      url: 'request.url',
      method: 'request.method',
      body: 'request.body',
      headerKeys: "Object.keys(request.headers).join(',')",
      tenant: "request.headers['X-Tenant']",
    });
    expect(seen).toMatchObject({
      url: 'https://api.example.com/users',
      method: 'POST',
      body: '{"name":"{{tenant}}"}',
      headerKeys: 'X-Tenant,Authorization',
      tenant: '{{tenant}}',
    });
  });

  it('gRPC: resolved metadata (also as headers), call type and message', async () => {
    const seen = await seenBy(grpcItem(), {
      url: 'request.url',
      method: 'request.method',
      body: 'request.body',
      meta: "request.metadata['x-tenant']",
      header: "request.headers['x-tenant']",
    });
    expect(seen).toMatchObject({
      url: 'http://api.example.com:50051',
      method: 'unary',
      body: '{"msg":"hi"}',
      meta: 'acme',
      header: 'acme',
    });
  });

  it('gRPC: a request without metadata or a call type defaults sensibly', async () => {
    const item = grpcItem({}, { metadata: undefined, methodType: undefined } as never);
    const seen = await seenBy(item, {
      method: 'request.method',
      count: 'Object.keys(request.metadata).length',
    });
    expect(seen).toMatchObject({ method: 'unary', count: '0' });
  });

  it('MCP: JSON-RPC method and params resolved, enabled headers resolved', async () => {
    const seen = await seenBy(mcpItem(), {
      url: 'request.url',
      method: 'request.method',
      body: 'request.body',
      tenant: "request.headers['X-Tenant']",
      off: "request.headers['X-Off'] === undefined",
    });
    expect(seen).toMatchObject({
      url: 'https://api.example.com/mcp',
      method: 'tools/{{verb}}',
      body: '{"t":"acme"}',
      tenant: 'acme',
      off: 'true',
    });
  });

  it('MCP: missing method, params and headers read as empty', async () => {
    const item = mcpItem({ defaultMethod: undefined, defaultParams: undefined });
    (item.request as { headers?: unknown }).headers = undefined;
    const seen = await seenBy(item, {
      method: 'JSON.stringify(request.method)',
      body: 'JSON.stringify(request.body)',
      count: 'Object.keys(request.headers).length',
    });
    expect(seen).toMatchObject({ method: '""', body: '""', count: '0' });
  });

  it('other protocols expose the raw URL and the protocol as method', async () => {
    const seen = await seenBy(sseItem(), {
      url: 'request.url',
      method: 'request.method',
      name: 'pm.info.requestName',
      id: 'pm.info.requestId',
    });
    // Not substituted for non-HTTP/gRPC/MCP items, and the relative path
    // stands in for a missing name / id.
    expect(seen).toMatchObject({
      url: 'https://{{host}}/events',
      method: 'SSE',
      name: 'feeds/events.sse',
      id: 'feeds/events.sse',
    });
  });

  it('a request without a URL exposes an empty one', async () => {
    const item = sseItem();
    (item.request as { url?: string }).url = undefined;
    expect(await seenBy(item, { url: 'JSON.stringify(request.url)' })).toMatchObject({
      url: '""',
    });
  });

  it('binds pm.info, iteration data and collection variables from the run context', async () => {
    const seen = await seenBy(httpItem(), {
      name: 'pm.info.requestName',
      id: 'pm.info.requestId',
      iteration: 'pm.info.iteration',
      count: 'pm.info.iterationCount',
      row: "pm.iterationData.get('row')",
      shared: "pm.collectionVariables.get('shared')",
      env: "pm.environment.get('tenant')",
    });
    expect(seen).toMatchObject({
      name: 'Get user',
      id: 'h1',
      iteration: '1',
      count: '3',
      row: 'r1',
      shared: 'c1',
      env: 'acme',
    });
  });
});

describe('runPreRequestScript — effects that flow back to the runner', () => {
  it('layers set variables over the starting map; an unset only leaves scriptVariables', async () => {
    const pre = await runPreRequestScript(
      `rs.environment.set('added', 'x'); rs.environment.unset('tenant');`,
      httpItem(),
      vars,
      runCtx()
    );
    expect(pre.variables).toMatchObject({ ...vars, added: 'x' });
    expect(pre.scriptVariables.added).toBe('x');
    expect(pre.scriptVariables).not.toHaveProperty('tenant');
  });

  it('returns no optional fields for a script with no effects', async () => {
    const pre = await runPreRequestScript(`console.log('hi');`, httpItem(), vars, runCtx());
    expect(pre.assertions).toEqual([]);
    expect(pre.errors).toEqual([]);
    expect(pre.logs.map((l) => l.message)).toEqual(['hi']);
    expect(pre.variables).toEqual(vars);
    expect(pre).not.toHaveProperty('execution');
    expect(pre).not.toHaveProperty('collectionMutations');
    expect(pre).not.toHaveProperty('requestHeaders');
    expect(pre).not.toHaveProperty('requestMetadata');
  });

  it('reports collection-variable mutations and flow control', async () => {
    const pre = await runPreRequestScript(
      `pm.collectionVariables.set('next', 'n'); pm.collectionVariables.unset('shared');
       pm.execution.setNextRequest('Cleanup');`,
      httpItem(),
      vars,
      runCtx()
    );
    expect(pre.collectionMutations).toEqual({ next: 'n', shared: null });
    expect(pre.execution).toMatchObject({ nextRequest: 'Cleanup' });
  });

  it('captures an uncaught throw as an error', async () => {
    const pre = await runPreRequestScript(`throw new Error('boom');`, httpItem(), vars, runCtx());
    expect(pre.errors.join('\n')).toContain('boom');
  });

  it('reports header edits for HTTP and metadata edits for gRPC', async () => {
    const http = await runPreRequestScript(
      `rs.request.headers['X-Extra'] = 'e';`,
      httpItem(),
      vars,
      runCtx()
    );
    expect(http.requestHeaders).toMatchObject({ 'X-Extra': 'e', 'X-Tenant': '{{tenant}}' });
    const grpc = await runPreRequestScript(
      `rs.request.metadata['x-extra'] = 'm';`,
      grpcItem(),
      vars,
      runCtx()
    );
    expect(grpc.requestMetadata).toMatchObject({ 'x-extra': 'm', 'x-tenant': 'acme' });
  });
});

describe('runTestScript — the response a test script sees', () => {
  it('HTTP: status, standard status text, raw body, headers, time and size', async () => {
    const result = await runTestScript(
      `
      rs.test('status', () => rs.expect(response.status).to.equal(201));
      rs.test('status text', () => rs.expect(response.statusText).to.equal('Created'));
      rs.test('raw body', () => rs.expect(response.body).to.equal('{"id":7,"ok":true}'));
      rs.test('json', () => rs.expect(JSON.parse(response.body).id).to.equal(7));
      rs.test('header', () => rs.expect(response.headers['content-type']).to.equal('application/json'));
      rs.test('time', () => rs.expect(response.time).to.equal(42));
      rs.test('size', () => rs.expect(response.size).to.equal(17));
      rs.test('resolved request header', () => rs.expect(request.headers['X-Tenant']).to.equal('acme'));
      `,
      httpItem(),
      outcome(),
      vars,
      runCtx()
    );
    expect(result.errors).toEqual([]);
    expect(result.assertions.filter((a) => !a.passed)).toEqual([]);
    expect(result.assertions).toHaveLength(8);
  });

  it('a non-standard status has an empty status text; a missing body and headers read empty', async () => {
    const result = await runTestScript(
      `
      rs.test('text', () => rs.expect(response.statusText).to.equal(''));
      rs.test('body', () => rs.expect(response.body).to.equal(''));
      rs.test('headers', () => rs.expect(Object.keys(response.headers)).to.have.length(0));
      rs.test('no trailers', () => rs.expect(response.trailers).to.equal(undefined));
      `,
      httpItem(),
      outcome({ status: 599, responseBody: undefined, responseHeaders: undefined }),
      vars,
      runCtx()
    );
    expect(result.assertions.filter((a) => !a.passed)).toEqual([]);
    expect(result.assertions).toHaveLength(4);
  });

  it('exposes every Set-Cookie field separately', async () => {
    const result = await runTestScript(
      `
      rs.test('two cookies', () => rs.expect(response.setCookies).to.have.length(2));
      rs.test('names', () => rs.expect(response.cookies.map((c) => c.name).join(',')).to.equal('a,b'));
      `,
      httpItem(),
      outcome({ setCookies: ['a=1; Path=/', 'b=2; HttpOnly'] }),
      vars,
      runCtx()
    );
    expect(result.assertions.filter((a) => !a.passed)).toEqual([]);
    expect(result.assertions).toHaveLength(2);
  });

  it('gRPC: no status text, and trailers are exposed', async () => {
    const result = await runTestScript(
      `
      rs.test('text', () => rs.expect(response.statusText).to.equal(''));
      rs.test('trailer', () => rs.expect(response.trailers['x-trailer']).to.equal('t1'));
      `,
      grpcItem(),
      outcome({ status: 200, responseTrailers: { 'x-trailer': 't1' } }),
      vars,
      runCtx()
    );
    expect(result.assertions.filter((a) => !a.passed)).toEqual([]);
    expect(result.assertions).toHaveLength(2);
  });

  it('reports a failing assertion with its message', async () => {
    const result = await runTestScript(
      `rs.test('wrong status', () => rs.expect(response.status).to.equal(200));`,
      httpItem(),
      outcome(),
      vars,
      runCtx()
    );
    expect(result.assertions).toHaveLength(1);
    expect(result.assertions[0]).toMatchObject({ name: 'wrong status', passed: false });
    expect(result.assertions[0]?.error).toMatch(/201/);
  });
});

describe('applyPreRequestMetadata — folding request edits back', () => {
  it('is the identity when the script made no edits', () => {
    const item = httpItem();
    expect(applyPreRequestMetadata(item, undefined, vars)).toBe(item);
    expect(applyPreRequestMetadata(item, {}, vars)).toBe(item);
    const grpc = grpcItem();
    expect(applyPreRequestMetadata(grpc, {}, vars)).toBe(grpc);
  });

  it('ignores header edits on a non-HTTP item and metadata edits on a non-gRPC item', () => {
    const mcp = mcpItem();
    expect(applyPreRequestMetadata(mcp, { requestHeaders: { A: 'b' } }, vars)).toBe(mcp);
    const http = httpItem();
    expect(applyPreRequestMetadata(http, { requestMetadata: { a: 'b' } }, vars)).toBe(http);
  });

  it('HTTP: edits a value, removes a row, adds a row, keeps disabled rows and templates', async () => {
    const item = httpItem();
    const pre = await runPreRequestScript(
      `rs.request.headers['X-Tenant'] = 'other';
       delete rs.request.headers['Authorization'];
       rs.request.headers['X-New'] = 'n';`,
      item,
      vars,
      runCtx()
    );
    const sent = applyPreRequestMetadata(item, pre, vars);
    expect(sent.blocked).toBeUndefined();
    const rows = (sent.request as HttpRequest).headers.map((h) => [h.key, h.value, h.enabled]);
    expect(rows).toContainEqual(['X-Tenant', 'other', true]);
    expect(rows).toContainEqual(['X-New', 'n', true]);
    expect(rows).toContainEqual(['X-Disabled', 'off', false]);
    expect(rows.find(([k, , enabled]) => k === 'Authorization' && enabled)).toBeUndefined();
    // The original item is not mutated.
    expect((item.request as HttpRequest).headers[0]?.value).toBe('{{tenant}}');
  });

  it('gRPC: folds metadata edits back', async () => {
    const item = grpcItem();
    const pre = await runPreRequestScript(
      `rs.request.metadata['x-extra'] = 'm';`,
      item,
      vars,
      runCtx()
    );
    const sent = applyPreRequestMetadata(item, pre, vars);
    const metadata = (sent.request as GrpcRequest).metadata ?? [];
    expect(metadata.map((m) => [m.key, m.value])).toEqual([
      ['x-tenant', '{{tenant}}'],
      ['x-extra', 'm'],
    ]);
  });

  it('gRPC: a request with no saved metadata gains the script-added entry', () => {
    const item = grpcItem({}, { metadata: undefined } as never);
    const sent = applyPreRequestMetadata(item, { requestMetadata: { 'x-new': 'v' } }, vars);
    expect(((sent.request as GrpcRequest).metadata ?? []).map((m) => [m.key, m.value])).toEqual([
      ['x-new', 'v'],
    ]);
  });

  describe('security: a script cannot add a secret variable to a request field', () => {
    it('blocks an HTTP header carrying a secret token the row did not already hold', () => {
      const item = httpItem({ secretVariableNames: ['tok'] });
      const sent = applyPreRequestMetadata(
        item,
        { requestHeaders: { 'X-Tenant': '{{tok}}', Authorization: 'Bearer {{tok}}' } },
        vars
      );
      expect(sent.blocked).toBe(
        'not sent: the pre-request script put secret variable "tok" into rs.request.headers ' +
          '"X-Tenant"; a script cannot add a secret variable to a request field.'
      );
      expect(sent.request).toBe(item.request);
    });

    it('allows the same token when the variable is not secret', () => {
      const item = httpItem();
      const sent = applyPreRequestMetadata(item, { requestHeaders: { 'X-Leak': '{{tok}}' } }, vars);
      expect(sent.blocked).toBeUndefined();
      expect((sent.request as HttpRequest).headers.map((h) => h.key)).toContain('X-Leak');
    });

    it('blocks a gRPC metadata entry carrying a new secret token', () => {
      const item = grpcItem({ secretVariableNames: ['tok'] });
      const sent = applyPreRequestMetadata(
        item,
        { requestMetadata: { 'x-tenant': '{{tenant}}', 'x-leak': 'Bearer {{tok}}' } },
        vars
      );
      expect(sent.blocked).toMatch(
        /secret variable "tok" into rs\.request\.metadata "x-leak"; a script cannot add/
      );
    });

    it('blocks a gRPC item with no saved metadata that gains a secret token', () => {
      const item = grpcItem({ secretVariableNames: ['tok'] }, { metadata: undefined } as never);
      const sent = applyPreRequestMetadata(
        item,
        { requestMetadata: { 'x-leak': '{{tok}}' } },
        vars
      );
      expect(sent.blocked).toMatch(/secret variable "tok"/);
    });
  });
});
