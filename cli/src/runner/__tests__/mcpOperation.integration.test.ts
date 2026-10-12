import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { internalToOC } from '@shared/opencollection/from-internal';
import { serializeOpenCollectionYAML } from '@shared/opencollection/serializer';
import type { Collection, McpRequest } from '@shared/types';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type MockMcpV2ServerHandle,
  startMockMcpV2Server,
} from '../../../../e2e/mocks/mcpV2Server';
import { type LoadedRequest, loadCollection } from '../collectionLoader';
import { executeMcp } from '../executors/mcp';
import { runTestScript } from '../scriptRunner';

/**
 * #877 integration: a saved MCP operation (`tools/call` + name/arguments) is
 * executed verbatim against the real v2 MCP mock — not replaced by `ping` — and
 * the request's test script runs against the response.
 *
 * A thin recording forwarder sits in front of the mock so the test can assert
 * exactly which JSON-RPC envelope the server received.
 */

let mock: MockMcpV2ServerHandle | undefined;
let recorder: Server | undefined;
let tmp: string | undefined;

afterEach(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
  tmp = undefined;
  await mock?.close();
  mock = undefined;
  if (recorder) {
    const r = recorder;
    await new Promise<void>((resolve) => r.close(() => resolve()));
    recorder = undefined;
  }
});

async function startRecorder(
  target: string
): Promise<{ url: string; received: Array<Record<string, unknown>> }> {
  const received: Array<Record<string, unknown>> = [];
  recorder = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', async () => {
      const body = Buffer.concat(chunks).toString('utf-8');
      if (body) received.push(JSON.parse(body) as Record<string, unknown>);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string' && k !== 'host' && k !== 'content-length') headers[k] = v;
      }
      const upstream = await fetch(target, {
        method: req.method ?? 'POST',
        headers,
        ...(body ? { body } : {}),
      });
      const text = await upstream.text();
      const outHeaders: Record<string, string> = {};
      upstream.headers.forEach((v, k) => {
        if (k !== 'content-length' && k !== 'transfer-encoding') outHeaders[k] = v;
      });
      res.writeHead(upstream.status, outHeaders);
      res.end(text);
    });
  });
  const server = recorder;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/mcp`, received };
}

function loaded(request: McpRequest): LoadedRequest {
  return { relativePath: request.name, folderPath: [], type: 'mcp', request };
}

describe('CLI MCP operation vs the v2 MCP mock', () => {
  it('executes the configured tools/call with resolved params and runs the test script', async () => {
    mock = await startMockMcpV2Server();
    const { url, received } = await startRecorder(mock.url);

    const request: McpRequest = {
      id: 'mcp-1',
      name: 'Echo tool',
      type: 'mcp',
      url: '{{MCP_URL}}',
      transport: 'streamable-http',
      headers: [],
      auth: { type: 'none' },
      defaultMethod: 'tools/call',
      defaultParams: JSON.stringify({ name: 'echo', arguments: { text: '{{GREETING}}' } }),
      testScript: [
        "pm.test('echo tool replied', () => {",
        '  pm.response.to.have.status(200);',
        "  const b = typeof response.body === 'string' ? response.body : JSON.stringify(response.body);",
        "  pm.expect(b).to.include(':hello');",
        '});',
      ].join('\n'),
    };
    const vars = { MCP_URL: url, GREETING: 'hello' };

    const outcome = await executeMcp(loaded(request), {
      vars,
      timeoutMs: 5000,
      allowLocalhost: true,
    });

    expect(outcome.errorMessage).toBeUndefined();
    expect(outcome.status).toBe(200);
    expect(outcome.passed).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'echo', arguments: { text: 'hello' } },
    });
    expect(outcome.responseBody).toMatch(/:hello/);

    const test = await runTestScript(request.testScript ?? '', loaded(request), outcome, vars, {
      collectionVars: {},
      iterationData: {},
      iteration: 0,
      iterationCount: 1,
    });
    expect(test.errors).toEqual([]);
    expect(test.assertions).toEqual([
      expect.objectContaining({ name: 'echo tool replied', passed: true }),
    ]);
  });

  it('runs an MCP operation exported to OpenCollection YAML and loaded from disk', async () => {
    mock = await startMockMcpV2Server();
    const { url, received } = await startRecorder(mock.url);

    // Author in-app → export (internalToOC → YAML) → load the file exactly
    // the way `restura run <file>` does → execute. Nested in a folder so the
    // x-restura-mcp folderPath placement is exercised too.
    const saved: McpRequest = {
      id: 'mcp-oc',
      name: 'Echo via OC',
      type: 'mcp',
      url: '{{MCP_URL}}',
      transport: 'streamable-http',
      headers: [],
      auth: { type: 'none' },
      defaultMethod: 'tools/call',
      defaultParams: JSON.stringify({ name: 'echo', arguments: { text: 'from-yaml' } }),
    };
    const collection: Collection = {
      id: 'c',
      name: 'MCP export',
      items: [
        {
          id: 'f',
          name: 'Tools',
          type: 'folder',
          items: [{ id: 'i', name: saved.name, type: 'request', request: saved }],
        },
      ],
    };
    tmp = await mkdtemp(join(tmpdir(), 'restura-cli-mcp-'));
    const file = join(tmp, 'collection.yml');
    await writeFile(file, serializeOpenCollectionYAML(internalToOC(collection)), 'utf-8');

    const loadedCollection = await loadCollection(file);
    const item = loadedCollection.requests.find((r) => r.type === 'mcp');
    expect(item?.folderPath).toEqual(['Tools']);
    expect(item?.request).toMatchObject({
      defaultMethod: 'tools/call',
      defaultParams: saved.defaultParams,
    });
    if (!item) throw new Error('MCP request not loaded');

    const outcome = await executeMcp(item, {
      vars: { MCP_URL: url },
      timeoutMs: 5000,
      allowLocalhost: true,
    });

    expect(outcome.errorMessage).toBeUndefined();
    expect(outcome.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'echo', arguments: { text: 'from-yaml' } },
    });
    expect(outcome.responseBody).toMatch(/from-yaml/);
  });

  it('never contacts the server when the item has no method', async () => {
    mock = await startMockMcpV2Server();
    const { url, received } = await startRecorder(mock.url);

    const outcome = await executeMcp(
      loaded({
        id: 'mcp-2',
        name: 'No method',
        type: 'mcp',
        url,
        transport: 'streamable-http',
        headers: [],
        auth: { type: 'none' },
      }),
      { vars: {}, timeoutMs: 5000, allowLocalhost: true }
    );

    expect(outcome.passed).toBe(false);
    expect(outcome.status).toBe(0);
    expect(outcome.errorMessage).toMatch(/no MCP method configured/i);
    expect(received).toHaveLength(0);
  });
});
