import { test, expect } from './fixtures/servers';

/**
 * Realistic MCP scenarios beyond `tools/call`: resources (list + read),
 * prompts (list + get), and tool error responses (`isError: true` rather
 * than a JSON-RPC error envelope — clients must treat them differently).
 */
async function callMcp(request: { post: (url: string, opts: { data: unknown }) => Promise<unknown> }, servers: { mcp: { url: string } }, jsonRpc: { id: number; method: string; params?: unknown }) {
  return request.post('http://localhost:5173/api/mcp', {
    data: {
      url: servers.mcp.url,
      transport: 'streamable-http',
      jsonRpc,
      timeout: 10_000,
    },
  });
}

test.describe('MCP — resources', () => {
  test('resources/list returns the registered resources', async ({ request, servers }) => {
    const res = (await callMcp(request, servers, { id: 10, method: 'resources/list' })) as {
      ok: () => boolean;
      json: () => Promise<{ jsonRpc: { result: { resources: Array<{ uri: string; name: string }> } } }>;
    };
    expect(res.ok()).toBe(true);
    const json = await res.json();
    const uris = json.jsonRpc.result.resources.map((r) => r.uri).sort();
    expect(uris).toEqual(['restura://config.json', 'restura://readme']);
  });

  test('resources/read returns the body of a markdown resource', async ({ request, servers }) => {
    const res = (await callMcp(request, servers, {
      id: 11,
      method: 'resources/read',
      params: { uri: 'restura://readme' },
    })) as { json: () => Promise<{ jsonRpc: { result: { contents: Array<{ text: string; mimeType: string }> } } }> };
    const json = await res.json();
    expect(json.jsonRpc.result.contents[0]?.mimeType).toBe('text/markdown');
    expect(json.jsonRpc.result.contents[0]?.text).toContain('# restura mock');
  });

  test('resources/read returns the body of a JSON resource', async ({ request, servers }) => {
    const res = (await callMcp(request, servers, {
      id: 12,
      method: 'resources/read',
      params: { uri: 'restura://config.json' },
    })) as { json: () => Promise<{ jsonRpc: { result: { contents: Array<{ text: string; mimeType: string }> } } }> };
    const json = await res.json();
    expect(json.jsonRpc.result.contents[0]?.mimeType).toBe('application/json');
    const parsed = JSON.parse(json.jsonRpc.result.contents[0]!.text);
    expect(parsed).toEqual({ feature: 'mcp', enabled: true });
  });
});

test.describe('MCP — prompts', () => {
  test('prompts/list surfaces the greet prompt', async ({ request, servers }) => {
    const res = (await callMcp(request, servers, { id: 20, method: 'prompts/list' })) as {
      json: () => Promise<{ jsonRpc: { result: { prompts: Array<{ name: string; description?: string }> } } }>;
    };
    const json = await res.json();
    const names = json.jsonRpc.result.prompts.map((p) => p.name);
    expect(names).toContain('greet');
  });

  test('prompts/get fills the template with arguments', async ({ request, servers }) => {
    const res = (await callMcp(request, servers, {
      id: 21,
      method: 'prompts/get',
      params: { name: 'greet', arguments: { name: 'Ada' } },
    })) as {
      json: () => Promise<{
        jsonRpc: { result: { messages: Array<{ role: string; content: { text: string } }> } };
      }>;
    };
    const json = await res.json();
    const text = json.jsonRpc.result.messages[0]?.content.text ?? '';
    expect(text).toContain('Ada');
  });
});

test.describe('MCP — tool error semantics', () => {
  test('fail tool returns isError:true (NOT a JSON-RPC error)', async ({ request, servers }) => {
    const res = (await callMcp(request, servers, {
      id: 30,
      method: 'tools/call',
      params: { name: 'fail', arguments: { reason: 'expected' } },
    })) as {
      json: () => Promise<{
        jsonRpc: {
          result?: { isError?: boolean; content?: Array<{ text: string }> };
          error?: unknown;
        };
      }>;
    };
    const json = await res.json();
    expect(json.jsonRpc.result?.isError).toBe(true);
    expect(json.jsonRpc.error).toBeUndefined();
    expect(json.jsonRpc.result?.content?.[0]?.text).toContain('failed: expected');
  });

  test('tools/call with bad arguments produces a JSON-RPC error envelope', async ({ request, servers }) => {
    const res = (await callMcp(request, servers, {
      id: 31,
      method: 'tools/call',
      params: { name: 'add', arguments: { a: 'not-a-number', b: 5 } },
    })) as {
      json: () => Promise<{
        jsonRpc: {
          result?: { isError?: boolean };
          error?: { code: number; message: string };
        };
      }>;
    };
    const json = await res.json();
    // Schema validation surfaces as either a JSON-RPC error or isError:true
    // depending on SDK version. Either is a legitimate failure signal.
    const surfaced =
      typeof json.jsonRpc.error?.code === 'number' || json.jsonRpc.result?.isError === true;
    expect(surfaced).toBe(true);
  });
});
