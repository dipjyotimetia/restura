import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as IpcUtils from '../ipc/ipc-utils';

/**
 * #896: MCP connection auth resolved in Electron main, on the wire. The
 * renderer sends a SecretRef handle over `mcp:connect`; main resolves it at
 * connect time and the REAL MCP server (SDK McpServer over StreamableHTTP)
 * sees `Authorization: Bearer <plaintext>` on every request. Only `electron`,
 * the IPC emit surface and the keychain-backed handle store are mocked.
 */

const mockHandle = vi.hoisted(() => vi.fn());
const mockEmitTo = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  ipcMain: { handle: mockHandle, removeHandler: vi.fn() },
}));
vi.mock('../ipc/ipc-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof IpcUtils>();
  return { ...actual, emitTo: mockEmitTo };
});
vi.mock('../security/secret-handle-store', () => ({
  unwrapSecretValueMain: (v: unknown): string | undefined => {
    if (typeof v === 'string') return v;
    const ref = v as { kind?: string; value?: string; id?: string } | undefined;
    if (ref?.kind === 'inline') return ref.value;
    if (ref?.kind === 'handle') return ref.id === 'h-mcp' ? 'keychain-mcp-token' : undefined;
    return undefined;
  },
}));

import { type MockMcpServerHandle, startMockMcpServer } from '../../../e2e/mocks/mcpServer';
import { registerMcpHandlerIPC, stopMcpCleanup } from '../handlers/mcp-handler';
import { setExecutionPolicy } from '../security/execution-policy';

type IpcHandler = (event: unknown, payload: unknown) => Promise<Record<string, unknown>>;

const trustedEvent = {
  sender: { id: 7, isDestroyed: () => false, once: vi.fn() },
  senderFrame: { url: 'file:///app/dist/web/index.html' },
};

const registered = new Map<string, IpcHandler>();
function handlerFor(channel: string): IpcHandler {
  const handler = registered.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}`);
  return handler;
}

describe('mcp:connect auth (main-side SecretRef resolution, real server)', () => {
  let server: MockMcpServerHandle;

  beforeAll(async () => {
    setExecutionPolicy({
      security: { allowLocalhost: true, allowPrivateIPs: false },
      proxy: { enabled: false, type: 'http', host: '', port: 8080, bypassList: [] },
      timeout: 30_000,
      tls: { verifySsl: true, serverCipherOrder: false },
      certificates: { clientCertificates: [], caCertificates: [] },
    });
    server = await startMockMcpServer({ requireAuthorization: 'Bearer keychain-mcp-token' });
    registerMcpHandlerIPC();
    for (const [channel, handler] of mockHandle.mock.calls) {
      registered.set(channel as string, handler as IpcHandler);
    }
  });

  beforeEach(() => server.reset());

  afterAll(async () => {
    stopMcpCleanup();
    await server.close();
  });

  it('resolves a handle bearer in main and sends it on every MCP request', async () => {
    const res = await handlerFor('mcp:connect')(trustedEvent, {
      connectionId: 'auth-1',
      url: server.url,
      transport: 'streamable-http',
      headers: { 'X-Tenant': 'acme' },
      auth: { type: 'bearer', bearer: { token: { kind: 'handle', id: 'h-mcp' } } },
    });
    expect(res).toEqual({ success: true });
    const call = await handlerFor('mcp:request')(trustedEvent, {
      connectionId: 'auth-1',
      method: 'tools/call',
      params: { name: 'echo', arguments: { text: 'hi' } },
    });
    expect(call.success).toBe(true);
    const seen = server.authorizationsReceived();
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set(['Bearer keychain-mcp-token']));
    await handlerFor('mcp:disconnect')(trustedEvent, { connectionId: 'auth-1' });
  });

  it('without auth the server rejects the connect (proves the header is what authenticates)', async () => {
    const res = await handlerFor('mcp:connect')(trustedEvent, {
      connectionId: 'auth-2',
      url: server.url,
      transport: 'streamable-http',
    });
    expect(res.success).toBe(false);
    expect(server.authorizationsReceived()).toContain('');
  });

  it('fails closed before any request when the handle no longer resolves', async () => {
    const res = await handlerFor('mcp:connect')(trustedEvent, {
      connectionId: 'auth-3',
      url: server.url,
      transport: 'streamable-http',
      auth: { type: 'bearer', bearer: { token: { kind: 'handle', id: 'revoked' } } },
    });
    expect(res).toEqual({
      success: false,
      error: 'MCP auth setup failed: Auth credential is unavailable on this device',
    });
    expect(server.authorizationsReceived()).toEqual([]);
  });

  it('rejects a query-string API key without contacting the server', async () => {
    const res = await handlerFor('mcp:connect')(trustedEvent, {
      connectionId: 'auth-4',
      url: server.url,
      transport: 'streamable-http',
      auth: { type: 'api-key', apiKey: { key: 'k', value: 'v', in: 'query' } },
    });
    expect(res.success).toBe(false);
    expect(String(res.error)).toMatch(/query string/);
    expect(server.authorizationsReceived()).toEqual([]);
  });
});
