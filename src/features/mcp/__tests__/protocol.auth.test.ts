import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mcpProtocol } from '@/features/mcp/protocol';
import type { AuthConfig, McpRequest } from '@/types';

/** #896: the workflow/flow `runJsonRpc` path applies McpRequest.auth like the builder. */

function request(auth: AuthConfig): McpRequest {
  return {
    id: 'flow-mcp',
    name: 'Flow MCP',
    type: 'mcp',
    url: 'https://mcp.example.com/mcp',
    transport: 'streamable-http',
    headers: [{ id: 'h', key: 'X-Tenant', value: 'acme', enabled: true }],
    auth,
  };
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { jsonRpc: { id: number } };
    return new Response(JSON.stringify({ ok: true, jsonRpc: { id: body.jsonRpc.id, result: {} } }));
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('mcpProtocol.runJsonRpc auth (#896)', () => {
  it('sends the applied credential on every call (initialize + initialized + method)', async () => {
    const result = await mcpProtocol.runJsonRpc(
      request({ type: 'api-key', apiKey: { key: 'X-API-Key', value: 'k-9', in: 'header' } }),
      { signal: new AbortController().signal },
      { method: 'tools/list' }
    );
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [, init] of fetchMock.mock.calls) {
      const body = JSON.parse(String(init?.body)) as { headers: Record<string, string> };
      expect(body.headers).toEqual({ 'X-Tenant': 'acme', 'X-API-Key': 'k-9' });
    }
  });

  it('fails closed without any request when the credential cannot be applied', async () => {
    const result = await mcpProtocol.runJsonRpc(
      request({ type: 'bearer', bearer: { token: { kind: 'handle', id: 'h' } } }),
      { signal: new AbortController().signal },
      { method: 'tools/list' }
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/desktop app/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
