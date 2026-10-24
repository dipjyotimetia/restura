/**
 * #901 follow-up: `mcpProtocol.runRequest` (collection runner) must send the
 * SAME resolved credential as `restura run` and the interactive builder.
 *
 * Unlike `mcpRunRequest.test.ts`, nothing below the protocol module is mocked
 * except the wire (fetch on web, `window.electron.mcp` on desktop), so the
 * real `runJsonRpc` → `createAndInitClient` → `buildMcpConnectAuth` path runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withEffectiveAuth } from '@/features/auth/lib/authInheritance';
import { mcpProtocol } from '@/features/mcp/protocol';
import type { AuthConfig, McpRequest } from '@/types';
import type { McpClient } from '../lib/mcpClient';

function request(auth: AuthConfig, extra: Partial<McpRequest> = {}): McpRequest {
  return {
    id: 'runner-mcp',
    name: 'Runner MCP',
    type: 'mcp',
    url: 'https://mcp.example.com/mcp',
    transport: 'streamable-http',
    headers: [{ id: 'h', key: 'X-Tenant', value: 'acme', enabled: true }],
    auth,
    defaultMethod: 'tools/list',
    ...extra,
  };
}

const variables = { token: 'abc', user: 'alice', pass: 's3cret', keyName: 'X-API-Key' };
const ctx = (extra: Record<string, unknown> = {}) => ({
  signal: new AbortController().signal,
  variables,
  ...extra,
});

const BEARER: AuthConfig = { type: 'bearer', bearer: { token: '{{token}}' } };
const BASIC: AuthConfig = { type: 'basic', basic: { username: '{{user}}', password: '{{pass}}' } };
const API_KEY: AuthConfig = {
  type: 'api-key',
  apiKey: { key: '{{keyName}}', value: '{{token}}', in: 'header' },
};

describe('mcpProtocol.runRequest auth — web', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { jsonRpc: { id: number } };
      return new Response(
        JSON.stringify({ ok: true, jsonRpc: { id: body.jsonRpc.id, result: {} } })
      );
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const sentHeaders = () =>
    fetchMock.mock.calls.map(
      ([, init]) => (JSON.parse(String(init?.body)) as { headers: Record<string, string> }).headers
    );

  it.each([
    ['Bearer', BEARER, { Authorization: 'Bearer abc' }],
    ['Basic', BASIC, { Authorization: `Basic ${btoa('alice:s3cret')}` }],
    ['API key', API_KEY, { 'X-API-Key': 'abc' }],
  ])('resolves {{vars}} in %s auth on every call', async (_label, auth, expected) => {
    const response = await mcpProtocol.runRequest(request(auth), ctx());
    expect(response.mcpOutcome).toBe('result');
    expect(fetchMock).toHaveBeenCalled();
    for (const headers of sentHeaders()) {
      expect(headers).toEqual({ 'X-Tenant': 'acme', ...expected });
      expect(JSON.stringify(headers)).not.toContain('{{');
    }
  });

  it('applies inherited (collection/folder) auth the runner threads onto the request', async () => {
    // Exactly what collectionRunner does: the request's own auth is `none`,
    // withEffectiveAuth swaps the folder/collection auth in.
    const authed = withEffectiveAuth(request({ type: 'none' }), BEARER);
    const response = await mcpProtocol.runRequest(authed, ctx());
    expect(response.status).toBe(200);
    for (const headers of sentHeaders()) expect(headers.Authorization).toBe('Bearer abc');
  });

  it('uses variables set by the pre-request script', async () => {
    await mcpProtocol.runRequest(
      request(BEARER, { preRequestScript: "rs.variables.set('token', 'from-script');" }),
      ctx()
    );
    for (const headers of sentHeaders()) expect(headers.Authorization).toBe('Bearer from-script');
  });

  it('keys pooled sessions by the resolved credential', async () => {
    const pool = new Map<string, Promise<McpClient>>();
    await mcpProtocol.runRequest(
      request(BEARER),
      ctx({ protocolOptions: { mcpClientPool: pool } })
    );
    await mcpProtocol.runRequest(
      request(BEARER),
      ctx({
        variables: { ...variables, token: 'other' },
        protocolOptions: { mcpClientPool: pool },
      })
    );
    expect(pool.size).toBe(2);
  });

  it('fails closed with the shared desktop-only message for a handle-backed credential', async () => {
    await expect(
      mcpProtocol.runRequest(
        request({ type: 'bearer', bearer: { token: { kind: 'handle', id: 'h1' } } }),
        ctx()
      )
    ).rejects.toThrow(/desktop app/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses stdio requests up front with a clear message', async () => {
    await expect(
      mcpProtocol.runRequest(request({ type: 'none' }, { transport: 'stdio' }), ctx())
    ).rejects.toThrow(/stdio MCP servers aren't supported in the collection runner yet/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('mcpProtocol.runRequest auth — desktop', () => {
  const connect = vi.fn();
  const mcpRequest = vi.fn();
  const disconnect = vi.fn();

  beforeEach(() => {
    connect.mockReset().mockResolvedValue({ success: true });
    mcpRequest.mockReset().mockResolvedValue({ success: true, result: {} });
    disconnect.mockReset().mockResolvedValue(undefined);
    (window as unknown as { electron: unknown }).electron = {
      isElectron: true,
      mcp: { connect, request: mcpRequest, disconnect, cancel: vi.fn() },
    };
  });

  afterEach(() => {
    delete (window as unknown as { electron?: unknown }).electron;
  });

  it('sends the variable-resolved auth descriptor to main (never the literal)', async () => {
    await mcpProtocol.runRequest(request(BEARER), ctx());
    expect(connect).toHaveBeenCalledTimes(1);
    const spec = connect.mock.calls[0]![0] as {
      headers: Record<string, string>;
      auth: AuthConfig;
    };
    expect(spec.auth).toEqual({ type: 'bearer', bearer: { token: 'abc' } });
    expect(spec.headers).toEqual({ 'X-Tenant': 'acme' });
    expect(JSON.stringify(spec)).not.toContain('{{');
  });

  it('allows handle-backed auth (resolved by Electron main)', async () => {
    const response = await mcpProtocol.runRequest(
      request({ type: 'bearer', bearer: { token: { kind: 'handle', id: 'h1' } } }),
      ctx()
    );
    expect(response.mcpOutcome).toBe('result');
    const spec = connect.mock.calls[0]![0] as { auth: AuthConfig };
    expect(spec.auth).toEqual({ type: 'bearer', bearer: { token: { kind: 'handle', id: 'h1' } } });
  });

  it('refuses stdio requests without spawning', async () => {
    await expect(
      mcpProtocol.runRequest(request({ type: 'none' }, { transport: 'stdio' }), ctx())
    ).rejects.toThrow(/run it from the request tab/);
    expect(connect).not.toHaveBeenCalled();
  });

  it('treats an IPC rate-limit rejection as transient: keeps the pooled session and retries', async () => {
    const pool = new Map<string, Promise<McpClient>>();
    // First item: connect + initialize + call succeed.
    await mcpProtocol.runRequest(
      request(BEARER),
      ctx({ protocolOptions: { mcpClientPool: pool } })
    );
    expect(connect).toHaveBeenCalledTimes(1);
    mcpRequest.mockRejectedValueOnce(
      new Error("Error invoking remote method 'mcp:request': Error: Rate limit exceeded")
    );
    const response = await mcpProtocol.runRequest(
      request(BEARER),
      ctx({ protocolOptions: { mcpClientPool: pool, mcpRateLimitRetryDelaysMs: [1, 1] } })
    );
    expect(response.mcpOutcome).toBe('result');
    expect(connect).toHaveBeenCalledTimes(1);
    expect(disconnect).not.toHaveBeenCalled();
    expect(pool.size).toBe(1);
  });

  it('fails the item cleanly after bounded rate-limit retries, without evicting', async () => {
    const pool = new Map<string, Promise<McpClient>>();
    await mcpProtocol.runRequest(
      request(BEARER),
      ctx({ protocolOptions: { mcpClientPool: pool } })
    );
    mcpRequest.mockResolvedValue({ success: false, error: 'Rate limit exceeded.' });
    const callsBefore = mcpRequest.mock.calls.length;
    await expect(
      mcpProtocol.runRequest(
        request(BEARER),
        ctx({ protocolOptions: { mcpClientPool: pool, mcpRateLimitRetryDelaysMs: [1, 1] } })
      )
    ).rejects.toThrow(/rate limit/i);
    expect(mcpRequest.mock.calls.length - callsBefore).toBe(3);
    expect(disconnect).not.toHaveBeenCalled();
    expect(pool.size).toBe(1);
  });
});
