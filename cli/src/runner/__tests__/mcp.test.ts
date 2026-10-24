import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Reporter } from '../../reporters/types';
import { runCollection } from '../runner';

let server: Server;
let baseUrl: string;
let lastBody = '';

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      lastBody = Buffer.concat(chunks).toString('utf-8');
      const parsed = JSON.parse(lastBody) as {
        id: unknown;
        method?: string;
        params?: { name?: string };
      };
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      if (parsed.method === 'tools/call' && parsed.params?.name === 'fail') {
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: parsed.id,
            result: { isError: true, content: [{ type: 'text', text: 'disk full' }] },
          })
        );
        return;
      }
      res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { pong: true } }));
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

class NoopReporter implements Reporter {
  onEnd(): void {}
}

function mcpCollection(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'restura-mcp-'));
  writeFileSync(
    join(dir, '_collection.yaml'),
    `name: McpTests\nvariables:\n  - { key: BASE, value: ${baseUrl}, enabled: true }\n`,
    'utf-8'
  );
  writeFileSync(join(dir, 'a.mcp.yaml'), yaml, 'utf-8');
  return dir;
}

describe('MCP executor', () => {
  it('refuses the desktop-only stdio transport without launching anything (#854)', async () => {
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
    const result = await runCollection(
      dir,
      { envVars: {}, bail: false, timeoutMs: 5000, allowLocalhost: true },
      new NoopReporter()
    );
    expect(result.requests[0]?.passed).toBe(false);
    expect(result.requests[0]?.errorMessage).toMatch(/stdio transport is desktop-only/);
    expect(existsSync(marker)).toBe(false);
  });

  it('http-sse transport reaches the upstream instead of failing validation', async () => {
    // Regression: validateMcpSpec rejects http-sse without a postEndpoint, so a
    // CLI run previously 400'd before any I/O. The executor now supplies the url
    // as the one-shot POST endpoint.
    const dir = mcpCollection(
      `name: Ping\nurl: '{{BASE}}/mcp'\ntransport: http-sse\ndefaultMethod: ping\n`
    );
    const result = await runCollection(
      dir,
      { envVars: {}, bail: false, timeoutMs: 5000, allowLocalhost: true },
      new NoopReporter()
    );
    expect(result.requests[0]?.passed).toBe(true);
    expect(result.requests[0]?.status).toBe(200);
    expect(JSON.parse(lastBody).method).toBe('ping');
  });

  it('fails the item with an actionable error when no defaultMethod is configured', async () => {
    // Regression (#877): the executor used to silently fall back to `ping`, so
    // every saved MCP request "passed" without exercising its operation.
    lastBody = '';
    const dir = mcpCollection(`name: NoOp\nurl: '{{BASE}}/mcp'\ntransport: streamable-http\n`);
    const completed: Array<{ passed: boolean; errorMessage?: string }> = [];
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
    expect(lastBody).toBe('');
    expect(result.requests[0]?.passed).toBe(false);
    expect(result.requests[0]?.errorMessage).toMatch(/no MCP method configured/i);
    expect(result.requests[0]?.errorMessage).toMatch(/tools\/call/);
    expect(completed[0]?.passed).toBe(false);
    expect(completed[0]?.errorMessage).toMatch(/no MCP method configured/i);
  });

  it('fails the item for a tool error (result.isError: true) with a distinct message (#868)', async () => {
    const dir = mcpCollection(
      `name: Fail\nurl: '{{BASE}}/mcp'\ntransport: streamable-http\ndefaultMethod: tools/call\ndefaultParams: '{"name":"fail","arguments":{}}'\n`
    );
    const result = await runCollection(
      dir,
      { envVars: {}, bail: false, timeoutMs: 5000, allowLocalhost: true },
      new NoopReporter()
    );
    const r = result.requests[0];
    expect(r?.status).toBe(200);
    expect(r?.passed).toBe(false);
    expect(r?.errorMessage).toContain('MCP tool error');
    expect(r?.errorMessage).toContain('disk full');
    expect(r?.errorMessage).not.toContain('JSON-RPC error');
  });

  it('fails when defaultMethod resolves to a blank string', async () => {
    lastBody = '';
    const dir = mcpCollection(
      `name: Blank\nurl: '{{BASE}}/mcp'\ntransport: streamable-http\ndefaultMethod: '{{METHOD}}'\n`
    );
    const result = await runCollection(
      dir,
      { envVars: { METHOD: '  ' }, bail: false, timeoutMs: 5000, allowLocalhost: true },
      new NoopReporter()
    );
    expect(lastBody).toBe('');
    expect(result.requests[0]?.passed).toBe(false);
    expect(result.requests[0]?.errorMessage).toMatch(/no MCP method configured/i);
  });

  it('sends the configured method with {{var}}-resolved params', async () => {
    const dir = mcpCollection(
      [
        'name: Call',
        "url: '{{BASE}}/mcp'",
        'transport: streamable-http',
        'defaultMethod: tools/call',
        `defaultParams: '{"name":"{{TOOL}}","arguments":{"text":"hi"}}'`,
        '',
      ].join('\n')
    );
    const result = await runCollection(
      dir,
      { envVars: { TOOL: 'echo' }, bail: false, timeoutMs: 5000, allowLocalhost: true },
      new NoopReporter()
    );
    expect(result.requests[0]?.passed).toBe(true);
    const sent = JSON.parse(lastBody) as { method: string; params: unknown };
    expect(sent.method).toBe('tools/call');
    expect(sent.params).toEqual({ name: 'echo', arguments: { text: 'hi' } });
  });
});
