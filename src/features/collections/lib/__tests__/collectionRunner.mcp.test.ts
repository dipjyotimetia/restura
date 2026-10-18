/**
 * #901: MCP items run in the collection runner (desktop + web share this
 * path). Drives the REAL runner → REAL mcpProtocol → REAL runJsonRpc; only the
 * McpClient transport (IPC / Worker fetch) is faked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Collection, McpRequest } from '@/types';
import type { RunnableRequest } from '../flattenRunnables';

type Reply =
  | { ok: true; result: unknown; durationMs: number }
  | {
      ok: false;
      error: string;
      jsonRpcError?: { code: number; message: string; data?: unknown };
      durationMs: number;
    };

const wire = vi.hoisted(() => ({
  instances: [] as Array<{ opts: { url: string; headers: Record<string, string> } }>,
  calls: [] as Array<{ method: string; params: unknown }>,
  disconnects: 0,
  connectError: undefined as string | undefined,
  reply: (_method: string, _params: unknown): unknown => ({ content: [] }),
}));

vi.mock('@/features/mcp/lib/mcpClient', () => ({
  McpClient: class {
    constructor(public opts: { url: string; headers: Record<string, string> }) {
      wire.instances.push(this);
    }
    async connect() {
      return wire.connectError ? { ok: false, error: wire.connectError } : { ok: true };
    }
    async disconnect() {
      wire.disconnects++;
    }
    async request(method: string, params?: unknown): Promise<Reply> {
      wire.calls.push({ method, params });
      if (method === 'initialize')
        return { ok: true, result: { protocolVersion: 'x' }, durationMs: 1 };
      return wire.reply(method, params) as Reply;
    }
  },
}));

vi.mock('@/features/registry/registry', async () => {
  const { mcpProtocol } = await import('@/features/mcp/protocol');
  return { protocolRegistry: { get: (id: string) => (id === 'mcp' ? mcpProtocol : undefined) } };
});

import { useCollectionStore } from '@/store/useCollectionStore';
import { runCollection } from '../collectionRunner';

const collection: Collection = { id: 'c', name: 'C', items: [] };

function mcpReq(extra: Partial<McpRequest> = {}): McpRequest {
  return {
    id: 'm1',
    name: 'Echo',
    type: 'mcp',
    url: 'https://{{host}}/mcp',
    transport: 'streamable-http',
    headers: [{ id: 'h1', key: 'Authorization', value: 'Bearer {{token}}', enabled: true }],
    auth: { type: 'none' },
    defaultMethod: 'tools/call',
    defaultParams: '{"name":"echo","arguments":{"text":"{{greeting}}"}}',
    ...extra,
  };
}

async function run(requests: McpRequest[]) {
  const runnables: RunnableRequest[] = requests.map((request, i) => ({
    itemId: `i${i}`,
    name: request.name,
    request,
  }));
  return runCollection(
    {
      collection,
      scopeName: 'C',
      runnables,
      baseVars: { host: 'mcp.example.test', token: 't0k', greeting: 'hello' },
      iterations: 1,
      dataRows: [],
      delayMs: 0,
      stopOnFailure: false,
    },
    () => {},
    new AbortController().signal
  );
}

beforeEach(() => {
  wire.instances.length = 0;
  wire.calls.length = 0;
  wire.disconnects = 0;
  wire.connectError = undefined;
  wire.reply = (_method, params) => ({
    ok: true,
    result: { content: [{ type: 'text', text: JSON.stringify(params) }] },
    durationMs: 1,
  });
  useCollectionStore.setState({ collections: [collection], activeCollectionId: null });
});

describe('collection runner — MCP (#901)', () => {
  it('runs the saved operation with {{vars}} resolved and passes on a plain result', async () => {
    const result = await run([mcpReq()]);
    expect(result.requests[0]).toMatchObject({
      status: 'success',
      protocol: 'mcp',
      httpStatus: 200,
    });
    expect(wire.instances[0]?.opts.url).toBe('https://mcp.example.test/mcp');
    expect(wire.instances[0]?.opts.headers).toEqual({ Authorization: 'Bearer t0k' });
    expect(wire.calls.map((c) => c.method)).toEqual(['initialize', 'tools/call']);
    expect(wire.calls[1]?.params).toEqual({ name: 'echo', arguments: { text: 'hello' } });
  });

  it('pools one session per server: initialize once, disconnect once at run end', async () => {
    const result = await run([
      mcpReq({ id: 'a', name: 'A' }),
      mcpReq({ id: 'b', name: 'B', defaultMethod: 'tools/list', defaultParams: '' }),
      mcpReq({ id: 'c', name: 'Other server', url: 'https://other.test/mcp' }),
    ]);
    expect(result.summary).toMatchObject({ total: 3, passed: 3 });
    expect(wire.instances).toHaveLength(2);
    expect(wire.calls.map((c) => c.method)).toEqual([
      'initialize',
      'tools/call',
      'tools/list',
      'initialize',
      'tools/call',
    ]);
    expect(wire.calls[2]?.params).toBeUndefined();
    expect(wire.disconnects).toBe(2);
  });

  it('test scripts assert on the JSON-RPC result, including isError', async () => {
    wire.reply = () => ({
      ok: true,
      result: { isError: true, content: [{ type: 'text', text: 'boom' }] },
      durationMs: 1,
    });
    const asserted = mcpReq({
      testScript: [
        "rs.test('tool reported an error', () => {",
        '  const body = rs.response.json();',
        '  rs.expect(body.result.isError).to.equal(true);',
        "  rs.expect(body.result.content[0].text).to.equal('boom');",
        '  rs.expect(body.error).to.equal(undefined);',
        '});',
      ].join('\n'),
    });
    const unasserted = mcpReq({ id: 'm2', name: 'No tests' });
    const result = await run([asserted, unasserted]);

    expect(result.requests[0]).toMatchObject({ status: 'success' });
    expect(result.requests[0]?.assertions).toEqual([
      { name: 'tool reported an error', passed: true },
    ]);
    // Without assertions a tool error fails the item by default, with a reason.
    expect(result.requests[1]).toMatchObject({ status: 'failed' });
    expect(result.requests[1]?.error).toMatch(/isError/);
  });

  it('a JSON-RPC error is distinguishable from a result and assertable', async () => {
    wire.reply = () => ({
      ok: false,
      error: 'JSON-RPC error -32602: Unknown tool',
      jsonRpcError: { code: -32602, message: 'Unknown tool' },
      durationMs: 1,
    });
    const asserted = mcpReq({
      testScript: [
        "rs.test('unknown tool is rejected', () => {",
        '  const body = rs.response.json();',
        '  rs.expect(body.error.code).to.equal(-32602);',
        '  rs.expect(body.result).to.equal(undefined);',
        '});',
      ].join('\n'),
    });
    const result = await run([asserted, mcpReq({ id: 'm2', name: 'No tests' })]);
    expect(result.requests[0]).toMatchObject({ status: 'success' });
    expect(result.requests[1]).toMatchObject({ status: 'failed' });
    expect(result.requests[1]?.error).toMatch(/-32602/);
  });

  it('a transport failure fails the item with the connect error', async () => {
    wire.connectError = 'connection refused';
    const result = await run([mcpReq()]);
    expect(result.requests[0]).toMatchObject({ status: 'failed' });
    expect(result.requests[0]?.error).toMatch(/connection refused/);
  });

  it('a pre-request script can set variables used by the operation', async () => {
    const result = await run([
      mcpReq({ preRequestScript: "rs.variables.set('greeting', 'from-script');" }),
    ]);
    expect(result.requests[0]?.status).toBe('success');
    expect(wire.calls[1]?.params).toEqual({ name: 'echo', arguments: { text: 'from-script' } });
  });

  it('fails an item with no saved method without contacting the server', async () => {
    const result = await run([mcpReq({ defaultMethod: undefined, defaultParams: undefined })]);
    expect(result.requests[0]).toMatchObject({ status: 'failed' });
    expect(result.requests[0]?.error).toMatch(/no MCP method configured/i);
    expect(wire.instances).toHaveLength(0);
  });

  it('fails an item whose params are not valid JSON', async () => {
    const result = await run([mcpReq({ defaultParams: '{oops' })]);
    expect(result.requests[0]?.error).toMatch(/not valid JSON/);
    expect(wire.instances).toHaveLength(0);
  });

  const opts = (requests: McpRequest[]) => ({
    collection,
    scopeName: 'C',
    runnables: requests.map((request, i) => ({ itemId: `i${i}`, name: request.name, request })),
    baseVars: { host: 'mcp.example.test', token: 't0k', greeting: 'hello' },
    iterations: 1,
    dataRows: [],
    delayMs: 0,
    stopOnFailure: false,
  });

  it('disposes pooled sessions when the run throws', async () => {
    await expect(
      runCollection(
        opts([mcpReq()]),
        () => {},
        new AbortController().signal,
        () => {
          throw new Error('listener blew up');
        }
      )
    ).rejects.toThrow('listener blew up');
    expect(wire.instances).toHaveLength(1);
    expect(wire.disconnects).toBe(1);
  });

  it('Stop aborts a pending pooled call and still disposes the session', async () => {
    const controller = new AbortController();
    wire.reply = () => {
      controller.abort();
      return new Promise(() => {});
    };
    const result = await runCollection(
      opts([mcpReq(), mcpReq({ id: 'b' })]),
      () => {},
      controller.signal
    );
    expect(result.outcome).toBe('aborted');
    expect(result.requests[0]).toMatchObject({ status: 'failed' });
    expect(result.requests[0]?.error).toMatch(/abort/i);
    expect(wire.disconnects).toBe(1);
  });
});
