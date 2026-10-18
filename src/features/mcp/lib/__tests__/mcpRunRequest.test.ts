import { describe, expect, it, vi } from 'vitest';
import type { McpRequest, Request } from '@/types';
import type { McpClient } from '../mcpClient';
import {
  disposeMcpClientPool,
  injectMcpVariables,
  type McpRunJsonRpc,
  runMcpRequest,
} from '../mcpRunRequest';

const req = (extra: Partial<McpRequest> = {}): McpRequest => ({
  id: 'm',
  name: 'M',
  type: 'mcp',
  url: 'https://{{h}}/mcp',
  transport: 'streamable-http',
  headers: [
    { id: '1', key: 'X-{{k}}', value: '{{v}}', enabled: true },
    { id: '2', key: 'X-Off', value: 'x', enabled: false },
  ],
  auth: { type: 'none' },
  defaultMethod: '{{method}}',
  defaultParams: '{"name":"{{tool}}"}',
  ...extra,
});

const ctx = (extra: Record<string, unknown> = {}) => ({
  signal: new AbortController().signal,
  variables: { h: 'host', k: 'Key', v: 'val', method: 'tools/call', tool: 'echo' },
  ...extra,
});

describe('injectMcpVariables', () => {
  it('resolves url, headers, method and params; leaves other request types alone', () => {
    const out = injectMcpVariables(req(), ctx().variables) as McpRequest;
    expect(out.url).toBe('https://host/mcp');
    expect(out.headers[0]).toMatchObject({ key: 'X-Key', value: 'val' });
    expect(out.defaultMethod).toBe('tools/call');
    expect(out.defaultParams).toBe('{"name":"echo"}');
    const http = { type: 'http' } as Request;
    expect(injectMcpVariables(http, {})).toBe(http);
  });
});

describe('runMcpRequest', () => {
  it('runs without a pool (no cacheKey) and reports script results', async () => {
    const runJsonRpc = vi.fn<McpRunJsonRpc>().mockResolvedValue({ ok: true, result: { a: 1 } });
    const onScriptResult = vi.fn();
    const response = await runMcpRequest(
      req({
        testScript: "rs.test('ok', () => rs.expect(rs.response.json().result.a).to.equal(1));",
      }),
      { ...ctx(), onScriptResult },
      runJsonRpc
    );
    const [sent, , opts] = runJsonRpc.mock.calls[0]!;
    expect((sent as McpRequest).url).toBe('https://host/mcp');
    expect(opts).toEqual({ method: 'tools/call', params: { name: 'echo' } });
    expect(response).toMatchObject({ status: 200, mcpOutcome: 'result' });
    expect(onScriptResult.mock.calls[0]![0].test.tests).toEqual([
      expect.objectContaining({ name: 'ok', passed: true }),
    ]);
  });

  it('keys pooled sessions by resolved url + transport + enabled headers', async () => {
    const runJsonRpc = vi.fn<McpRunJsonRpc>().mockResolvedValue({ ok: true, result: {} });
    const pool = new Map<string, Promise<McpClient>>();
    await runMcpRequest(req(), ctx({ protocolOptions: { mcpClientPool: pool } }), runJsonRpc);
    const opts = runJsonRpc.mock.calls[0]![2];
    expect(opts.clientPool).toBe(pool);
    expect(opts.cacheKey).toContain('https://host/mcp');
    expect(opts.cacheKey).toContain('x-key');
    expect(opts.cacheKey).not.toContain('x-off');
  });

  it('rejects non-MCP requests and already-aborted runs', async () => {
    const runJsonRpc = vi.fn<McpRunJsonRpc>();
    await expect(runMcpRequest({ type: 'http' } as Request, ctx(), runJsonRpc)).rejects.toThrow(
      /cannot run http/
    );
    const aborted = new AbortController();
    aborted.abort();
    await expect(runMcpRequest(req(), ctx({ signal: aborted.signal }), runJsonRpc)).rejects.toThrow(
      /aborted/i
    );
    expect(runJsonRpc).not.toHaveBeenCalled();
  });

  it('throws on a transport failure and still reports the pre-request script', async () => {
    const runJsonRpc = vi.fn<McpRunJsonRpc>().mockResolvedValue({ ok: false, error: 'refused' });
    const onScriptResult = vi.fn();
    await expect(
      runMcpRequest(
        req({ preRequestScript: "rs.variables.set('tool', 'add');" }),
        { ...ctx(), onScriptResult },
        runJsonRpc
      )
    ).rejects.toThrow('refused');
    expect(runJsonRpc.mock.calls[0]![2].params).toEqual({ name: 'add' });
    expect(onScriptResult.mock.calls[0]![0].preRequest).toBeDefined();
  });
});

describe('disposeMcpClientPool', () => {
  it('disconnects every resolved client, tolerates failed inits, and clears the pool', async () => {
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const failed = Promise.reject(new Error('init failed'));
    failed.catch(() => undefined);
    const pool = new Map<string, Promise<McpClient>>([
      ['a', Promise.resolve({ disconnect } as unknown as McpClient)],
      ['b', failed],
    ]);
    await disposeMcpClientPool(pool);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(pool.size).toBe(0);
  });
});
