import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpClient } from '../mcpClient';

/** Tool descriptor mapping for #880 on BOTH transports (web Worker proxy + desktop IPC). */

const rawTool = {
  name: 'delete_rows',
  title: 'Delete rows',
  description: 'Deletes',
  inputSchema: { type: 'object' },
  outputSchema: { type: 'object', properties: { count: { type: 'integer' } } },
  annotations: { destructiveHint: true, readOnlyHint: false, bogus: 1 },
  junk: 'dropped',
};
const expected = {
  name: 'delete_rows',
  title: 'Delete rows',
  description: 'Deletes',
  inputSchema: { type: 'object' },
  outputSchema: { type: 'object', properties: { count: { type: 'integer' } } },
  annotations: { destructiveHint: true, readOnlyHint: false },
};

function makeClient(): McpClient {
  return new McpClient({
    url: 'https://mcp.example.com',
    transport: 'streamable-http',
    headers: {},
    connectionId: 'desc-conn',
  });
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as unknown as { electron?: unknown }).electron;
});

describe('McpClient tool descriptor mapping (#880)', () => {
  it('web path: carries title/outputSchema/annotations from tools/list and drops malformed entries', async () => {
    fetchMock.mockImplementation((_url, init) => {
      const { method } = (
        JSON.parse(String((init as RequestInit).body)) as {
          jsonRpc: { method: string };
        }
      ).jsonRpc;
      const result =
        method === 'initialize'
          ? { capabilities: { tools: {} } }
          : { tools: [rawTool, { nope: true }] };
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, jsonRpc: { result } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    });
    const caps = await makeClient().discoverCapabilities();
    if ('error' in caps) throw new Error(caps.error);
    expect(caps.tools).toEqual([expected]);
  });

  it('desktop path: maps the SDK result identically', async () => {
    const request = vi.fn(async ({ method }: { method: string }) => ({
      success: true,
      result: method === 'initialize' ? { capabilities: { tools: {} } } : { tools: [rawTool] },
    }));
    (window as unknown as { electron: unknown }).electron = { isElectron: true, mcp: { request } };
    const caps = await makeClient().discoverCapabilities();
    if ('error' in caps) throw new Error(caps.error);
    expect(caps.tools).toEqual([expected]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
