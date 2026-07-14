import { mkdtempSync, writeFileSync } from 'node:fs';
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
      const parsed = JSON.parse(lastBody) as { id: unknown };
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
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
});
