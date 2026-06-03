import { test, expect } from './fixtures/servers';
import { switchMode } from './utils/selectors';

/**
 * Real MCP server speaking the streamable-http transport (single endpoint
 * accepting JSON-RPC POSTs). The Worker `/api/mcp` proxies the renderer's
 * POSTs to the upstream URL. Coverage:
 *
 *   - Wire: Worker correctly proxies `initialize`, `tools/list`, `tools/call`
 *   - UI:   Connect populates the Tools tab with the server's tool list
 *
 * Requires the Worker in dev mode (`.dev.vars` ENVIRONMENT=development).
 */
test.describe('Real MCP server', () => {
  test('Wire: Worker /api/mcp proxies initialize and surfaces sessionId', async ({
    request,
    servers,
  }) => {
    const res = await request.post('http://localhost:5173/api/mcp', {
      data: {
        url: servers.mcp.url,
        transport: 'streamable-http',
        jsonRpc: {
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'restura-e2e', version: '0.0.1' },
          },
        },
        timeout: 10_000,
      },
    });

    expect(res.ok(), `Worker rejected MCP initialize: ${res.status()} ${await res.text()}`).toBe(
      true
    );
    const json = (await res.json()) as {
      ok: boolean;
      jsonRpc: {
        result?: { serverInfo?: { name: string }; protocolVersion?: string };
        error?: unknown;
      };
      sessionId?: string;
    };
    expect(json.ok).toBe(true);
    // The SDK reports its serverInfo from the McpServer constructor args.
    expect(json.jsonRpc.result?.serverInfo?.name).toBe('restura-mock-mcp');
    expect(typeof json.jsonRpc.result?.protocolVersion).toBe('string');
    // The mock advertises a synthetic session id via Mcp-Session-Id; the worker forwards it.
    expect(json.sessionId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(servers.mcp.initializeCount()).toBeGreaterThanOrEqual(1);
  });

  test('Wire: tools/list returns the echo and add tools', async ({ request, servers }) => {
    const res = await request.post('http://localhost:5173/api/mcp', {
      data: {
        url: servers.mcp.url,
        transport: 'streamable-http',
        jsonRpc: { id: 2, method: 'tools/list' },
        timeout: 10_000,
      },
    });

    const json = (await res.json()) as { jsonRpc: { result: { tools: Array<{ name: string }> } } };
    const names = json.jsonRpc.result.tools.map((t) => t.name).sort();
    expect(names).toEqual(['add', 'echo', 'fail']);
  });

  test('Wire: tools/call echo returns the input prefixed with "echo:"', async ({
    request,
    servers,
  }) => {
    const res = await request.post('http://localhost:5173/api/mcp', {
      data: {
        url: servers.mcp.url,
        transport: 'streamable-http',
        jsonRpc: {
          id: 3,
          method: 'tools/call',
          params: { name: 'echo', arguments: { text: 'hi' } },
        },
        timeout: 10_000,
      },
    });

    const json = (await res.json()) as {
      jsonRpc: { result: { content: Array<{ text: string }> } };
    };
    expect(json.jsonRpc.result.content[0]?.text).toBe('echo:hi');
    expect(servers.mcp.toolCallCount()).toBeGreaterThanOrEqual(1);
  });

  test('Wire: tools/call add returns the sum', async ({ request, servers }) => {
    const res = await request.post('http://localhost:5173/api/mcp', {
      data: {
        url: servers.mcp.url,
        transport: 'streamable-http',
        jsonRpc: {
          id: 4,
          method: 'tools/call',
          params: { name: 'add', arguments: { a: 17, b: 25 } },
        },
        timeout: 10_000,
      },
    });

    const json = (await res.json()) as {
      jsonRpc: { result: { content: Array<{ text: string }> } };
    };
    expect(json.jsonRpc.result.content[0]?.text).toBe('42');
  });

  test('Wire: unknown tool returns a JSON-RPC error', async ({ request, servers }) => {
    const res = await request.post('http://localhost:5173/api/mcp', {
      data: {
        url: servers.mcp.url,
        transport: 'streamable-http',
        jsonRpc: {
          id: 5,
          method: 'tools/call',
          params: { name: 'nope', arguments: {} },
        },
        timeout: 10_000,
      },
    });

    const json = (await res.json()) as {
      jsonRpc: {
        error?: { code: number; message: string };
        result?: { isError?: boolean; content?: unknown };
      };
    };
    // The SDK reports unknown tools either via JSON-RPC `error` (old behavior)
    // or via a result with `isError: true` (newer SDKs). Either is valid.
    const surfaced =
      typeof json.jsonRpc.error?.code === 'number' || json.jsonRpc.result?.isError === true;
    expect(surfaced, `expected error or isError result, got ${JSON.stringify(json.jsonRpc)}`).toBe(
      true
    );
  });

  test('UI: Connect populates the Tools tab with discovered tools', async ({
    app: page,
    servers,
  }) => {
    await switchMode(page, 'mcp');

    await page.getByPlaceholder('https://mcp.example.com/v1/server').fill(servers.mcp.url);
    await page.getByRole('button', { name: /Connect/i }).click();

    // The catalog (tools/resources/prompts) is hidden by default; reveal it via
    // the connection-bar "Tools" toggle so the discovered tools are listed.
    await page.getByRole('button', { name: 'Tools', exact: true }).click();

    // Tools tab badge increases as the client discovers them.
    await expect(page.getByRole('tab', { name: /Tools\s+3/ })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('echo', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('add', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('fail', { exact: true }).first()).toBeVisible();

    // After connect we expect at least initialize + tools/list to have hit the server.
    expect(servers.mcp.methodsReceived()).toEqual(
      expect.arrayContaining(['initialize', 'tools/list'])
    );
  });
});
