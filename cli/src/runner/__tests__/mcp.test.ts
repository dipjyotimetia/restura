import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serializeOpenCollectionYAML } from '@shared/opencollection/serializer';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type MockMcpServerHandle, startMockMcpServer } from '../../../../e2e/mocks/mcpServer';
import { mcpItems } from '../../../../echo-local/collection';
import type { Reporter, RequestRunResult } from '../../reporters/types';
import { runCollection } from '../runner';

let mock: MockMcpServerHandle;

beforeAll(async () => {
  mock = await startMockMcpServer();
});

afterAll(async () => {
  await mock.close();
});

beforeEach(() => mock.reset());

class NoopReporter implements Reporter {
  onEnd(): void {}
}

/** Write a legacy-layout collection with one `<n>.mcp.yaml` per entry. */
function mcpCollection(...items: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'restura-mcp-'));
  writeFileSync(
    join(dir, '_collection.yaml'),
    `name: McpTests\nvariables:\n  - { key: MCP_URL, value: ${mock.url}, enabled: true }\n`,
    'utf-8'
  );
  items.forEach((yaml, i) => {
    writeFileSync(join(dir, `${String(i + 1).padStart(2, '0')}.mcp.yaml`), yaml, 'utf-8');
  });
  return dir;
}

const run = (dir: string, envVars: Record<string, string> = {}) =>
  runCollection(
    dir,
    { envVars, bail: false, timeoutMs: 5000, allowLocalhost: true },
    new NoopReporter()
  );

function item(name: string, method: string, params?: unknown, testScript?: string): string {
  return [
    `name: ${name}`,
    "url: '{{MCP_URL}}'",
    'transport: streamable-http',
    `defaultMethod: ${method}`,
    ...(params !== undefined ? [`defaultParams: '${JSON.stringify(params)}'`] : []),
    ...(testScript ? ['testScript: |', ...testScript.split('\n').map((l) => `  ${l}`)] : []),
    '',
  ].join('\n');
}

describe('MCP stdio refusal (#854)', () => {
  it('refuses the desktop-only stdio transport without launching anything', async () => {
    const markerDir = mkdtempSync(join(tmpdir(), 'restura-mcp-stdio-'));
    const marker = join(markerDir, 'spawned');
    const dir = mcpCollection(
      [
        'name: Local',
        "url: ''",
        'transport: stdio',
        'defaultMethod: tools/list',
        'stdio:',
        `  command: ${JSON.stringify(process.execPath)}`,
        '  args:',
        "    - '-e'",
        `    - ${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`)}`,
        '',
      ].join('\n')
    );
    const result = await run(dir);
    expect(result.requests[0]?.passed).toBe(false);
    expect(result.requests[0]?.errorMessage).toMatch(/stdio transport is desktop-only/);
    expect(existsSync(marker)).toBe(false);
  });
});

describe('MCP executor (restura run)', () => {
  it('fails the item with an actionable error when no defaultMethod is configured', async () => {
    // Regression (#877): the executor used to silently fall back to `ping`, so
    // every saved MCP request "passed" without exercising its operation.
    const dir = mcpCollection(`name: NoOp\nurl: '{{MCP_URL}}'\ntransport: streamable-http\n`);
    const completed: RequestRunResult[] = [];
    const result = await runCollection(
      dir,
      { envVars: {}, bail: false, timeoutMs: 5000, allowLocalhost: true },
      {
        onRequestComplete: (r) => {
          completed.push(r);
        },
        onEnd() {},
      }
    );
    expect(mock.methodsReceived()).toEqual([]);
    expect(result.requests[0]?.passed).toBe(false);
    expect(result.requests[0]?.errorMessage).toMatch(/no MCP method configured/i);
    expect(result.requests[0]?.errorMessage).toMatch(/tools\/call/);
    expect(completed[0]?.errorMessage).toMatch(/no MCP method configured/i);
  });

  it('fails when defaultMethod resolves to a blank string', async () => {
    const dir = mcpCollection(
      `name: Blank\nurl: '{{MCP_URL}}'\ntransport: streamable-http\ndefaultMethod: '{{METHOD}}'\n`
    );
    const result = await run(dir, { METHOD: '  ' });
    expect(mock.methodsReceived()).toEqual([]);
    expect(result.requests[0]?.passed).toBe(false);
    expect(result.requests[0]?.errorMessage).toMatch(/no MCP method configured/i);
  });

  it('fails when defaultParams is not JSON instead of sending a bare string', async () => {
    const dir = mcpCollection(
      `name: Bad\nurl: '{{MCP_URL}}'\ntransport: streamable-http\ndefaultMethod: tools/call\ndefaultParams: 'nope'\n`
    );
    const result = await run(dir);
    expect(mock.methodsReceived()).toEqual([]);
    expect(result.requests[0]?.errorMessage).toMatch(/not valid JSON/);
  });

  it('initializes once, then runs every saved operation over the pooled session', async () => {
    const dir = mcpCollection(
      item('Echo', 'tools/call', { name: 'echo', arguments: { text: '{{GREETING}}' } }),
      item('List', 'tools/list'),
      item('Read', 'resources/read', { uri: 'restura://readme' })
    );
    const result = await run(dir, { GREETING: 'hello' });

    expect(result.summary).toMatchObject({ total: 3, passed: 3 });
    expect(mock.initializeCount()).toBe(1);
    const ops = mock.methodsReceived().filter((m) => !m.startsWith('notifications/'));
    expect(ops.slice(ops.indexOf('initialize') + 1)).toEqual([
      'tools/call',
      'tools/list',
      'resources/read',
    ]);
    expect(result.requests[0]?.status).toBe(200);
  });

  it('test scripts assert on result and isError; an unasserted tool error fails with a reason', async () => {
    const dir = mcpCollection(
      item(
        'Echo',
        'tools/call',
        { name: 'echo', arguments: { text: 'hi' } },
        [
          "rs.test('echoes', () => {",
          '  const body = rs.response.json();',
          "  rs.expect(body.result.content[0].text).to.equal('echo:hi');",
          '  rs.expect(body.result.isError).to.not.equal(true);',
          "  rs.expect(rs.request.method).to.equal('tools/call');",
          '});',
        ].join('\n')
      ),
      item(
        'Fail asserted',
        'tools/call',
        { name: 'fail', arguments: { reason: 'nope' } },
        [
          "rs.test('tool reports isError', () => {",
          '  rs.expect(rs.response.json().result.isError).to.equal(true);',
          '});',
        ].join('\n')
      ),
      item('Fail unasserted', 'tools/call', { name: 'fail', arguments: { reason: 'nope' } })
    );
    const result = await run(dir);

    expect(result.requests[0]).toMatchObject({ passed: true });
    expect(result.requests[0]?.assertions).toEqual([
      expect.objectContaining({ name: 'echoes', passed: true }),
    ]);
    expect(result.requests[1]).toMatchObject({ passed: true });
    expect(result.requests[1]?.errorMessage).toBeUndefined();
    expect(result.requests[2]).toMatchObject({ passed: false });
    expect(result.requests[2]?.errorMessage).toMatch(/isError/);
  });

  it('a JSON-RPC error is distinguishable and assertable', async () => {
    const dir = mcpCollection(
      item(
        'Unknown method asserted',
        'does/not/exist',
        undefined,
        [
          "rs.test('method not found', () => {",
          '  const body = rs.response.json();',
          '  rs.expect(body.error.code).to.equal(-32601);',
          '  rs.expect(body.result).to.equal(undefined);',
          '});',
        ].join('\n')
      ),
      item('Unknown method unasserted', 'does/not/exist')
    );
    const result = await run(dir);
    expect(result.requests[0]).toMatchObject({ passed: true });
    expect(result.requests[1]).toMatchObject({ passed: false });
    expect(result.requests[1]?.errorMessage).toMatch(/-32601/);
  });

  it('a transport failure is an error, not an assertable outcome', async () => {
    const dir = mcpCollection(
      item('Down', 'tools/list', undefined, "rs.test('never', () => {});").replace(
        '{{MCP_URL}}',
        'http://127.0.0.1:1/mcp'
      )
    );
    const result = await run(dir);
    expect(result.requests[0]?.passed).toBe(false);
    expect(result.requests[0]?.status).toBe(0);
    expect(result.requests[0]?.errorMessage).toBeTruthy();
  });
});

describe('MCP executor — legacy http-sse transport', () => {
  let server: Server;
  let baseUrl: string;
  const posted: string[] = [];

  beforeAll(async () => {
    // Minimal legacy (2024-11-05) HTTP+SSE server: GET opens the stream and
    // announces the POST endpoint; replies travel back over the stream.
    let stream: ServerResponse | undefined;
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('event: endpoint\ndata: /messages\n\n');
        stream = res;
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        const msg = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as {
          id?: number;
          method: string;
        };
        posted.push(msg.method);
        res.writeHead(202).end();
        if (msg.id === undefined) return;
        const result =
          msg.method === 'initialize'
            ? {
                protocolVersion: '2024-11-05',
                capabilities: { tools: {} },
                serverInfo: { name: 'legacy', version: '1' },
              }
            : { pong: true };
        stream?.write(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n\n`
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('opens the SSE stream, initializes, and posts the operation to the announced endpoint', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'restura-mcp-sse-'));
    writeFileSync(join(dir, '_collection.yaml'), 'name: Legacy\n', 'utf-8');
    writeFileSync(
      join(dir, 'a.mcp.yaml'),
      `name: Ping\nurl: '${baseUrl}/sse'\ntransport: http-sse\ndefaultMethod: ping\n`,
      'utf-8'
    );
    const result = await run(dir);
    expect(result.requests[0]?.errorMessage).toBeUndefined();
    expect(result.requests[0]?.passed).toBe(true);
    // `server/discover` is the SDK's 2026-era probe; a legacy server falls back.
    expect(posted.filter((m) => m !== 'server/discover')).toEqual([
      'initialize',
      'notifications/initialized',
      'ping',
    ]);
  });
});

describe('echo-local example collection — MCP items (#901)', () => {
  it('every example MCP operation passes its own test script under `restura run`', async () => {
    const mcpMock = await startMockMcpServer();
    try {
      const dir = mkdtempSync(join(tmpdir(), 'restura-mcp-example-'));
      const file = join(dir, 'collection.yml');
      const doc = {
        opencollection: '1.0.0',
        info: { name: 'MCP examples', version: '1.0.0' },
        bundled: true,
        items: [],
        extensions: { 'x-restura-mcp': mcpItems(mcpMock.url) },
      };
      writeFileSync(file, serializeOpenCollectionYAML(doc as never), 'utf-8');

      const result = await run(file);
      const names = mcpItems(mcpMock.url).map((i) => (i.info as { name: string }).name);
      expect(
        result.requests.map((r) => [r.request.request.name, r.passed, r.errorMessage])
      ).toEqual(names.map((name) => [name, true, undefined]));
      expect(result.requests.every((r) => (r.assertions?.length ?? 0) > 0)).toBe(true);
      expect(mcpMock.initializeCount()).toBeLessThanOrEqual(1);
    } finally {
      await mcpMock.close();
    }
  });
});
