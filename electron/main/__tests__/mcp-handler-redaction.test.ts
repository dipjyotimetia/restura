import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as IpcUtils from '../ipc/ipc-utils';

/**
 * #896 security review (M2/M3, L1): once main resolves a SecretRef credential
 * for an MCP connection, nothing server-controlled that flows back to the
 * renderer — tool results, JSON-RPC error data, notifications, error events —
 * may carry the plaintext; and a URL the SSRF guard blocks must never trigger
 * a keychain / vault lookup.
 */

const SECRET = 'keychain-mcp-token';

const mockHandle = vi.hoisted(() => vi.fn());
const mockEmitTo = vi.hoisted(() => vi.fn());
const mockResolveSafeAddress = vi.hoisted(() =>
  vi.fn(async () => ({ host: 'mcp.example.com', ip: '93.184.216.34', port: 443, family: 4 }))
);
const mockUnwrap = vi.hoisted(() =>
  vi.fn((v: unknown): string | undefined => {
    const ref = v as { kind?: string; id?: string } | undefined;
    return ref?.kind === 'handle' && ref.id === 'h-mcp' ? 'keychain-mcp-token' : undefined;
  })
);
const sdk = vi.hoisted(() => ({
  events: undefined as
    | { onNotification: (n: unknown) => Promise<void>; onError: (e: Error) => void }
    | undefined,
  authorization: '',
}));

vi.mock('electron', () => ({
  ipcMain: { handle: mockHandle, removeHandler: vi.fn() },
}));
vi.mock('../ipc/ipc-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof IpcUtils>();
  return { ...actual, emitTo: mockEmitTo };
});
vi.mock('../security/safe-connect', () => ({ resolveSafeAddress: mockResolveSafeAddress }));
vi.mock('../security/policy-transport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../security/policy-transport')>();
  return { ...actual, createPolicyPinnedFetch: vi.fn(() => vi.fn()) };
});
vi.mock('../security/secret-handle-store', () => ({ unwrapSecretValueMain: mockUnwrap }));
vi.mock('../handlers/mcp-sdk-client', () => ({
  connectMcpSdkClient: vi.fn(
    async (opts: {
      transportOptions: { requestInit: { headers: Record<string, string> } };
      events: NonNullable<typeof sdk.events>;
    }) => {
      // A hostile / careless server: it sees the resolved credential and echoes it.
      sdk.authorization = opts.transportOptions.requestInit.headers.Authorization ?? '';
      sdk.events = opts.events;
      const echo = sdk.authorization;
      return {
        close: vi.fn(async () => undefined),
        terminateSession: vi.fn(async () => undefined),
        notification: vi.fn(async () => undefined),
        getProtocolVersion: () => '2025-06-18',
        getServerCapabilities: () => ({ experimental: { seen: echo } }),
        getServerVersion: () => ({ name: `server ${echo}`, version: '1' }),
        request: vi.fn(async (method: string) => {
          if (method === 'fail') {
            throw { code: -32000, message: `denied for ${echo}`, data: { header: echo } };
          }
          return { content: [{ type: 'text', text: `you sent ${echo}` }], [echo]: true };
        }),
      };
    }
  ),
}));

import { registerMcpHandlerIPC, stopMcpCleanup } from '../handlers/mcp-handler';
import { setExecutionPolicy } from '../security/execution-policy';

type IpcHandler = (event: unknown, payload: unknown) => Promise<Record<string, unknown>>;
const registered = new Map<string, IpcHandler>();
const handlerFor = (channel: string): IpcHandler => {
  const handler = registered.get(channel);
  if (!handler) throw new Error(`No handler for ${channel}`);
  return handler;
};
const trustedEvent = {
  sender: { id: 11, isDestroyed: () => false, once: vi.fn() },
  senderFrame: { url: 'file:///app/dist/web/index.html' },
};
const connectPayload = (connectionId: string) => ({
  connectionId,
  url: 'https://mcp.example.com/mcp',
  transport: 'streamable-http',
  auth: { type: 'bearer', bearer: { token: { kind: 'handle', id: 'h-mcp' } } },
});

describe('mcp-handler: resolved credentials never flow back to the renderer', () => {
  beforeAll(() => {
    setExecutionPolicy({
      security: { allowLocalhost: false, allowPrivateIPs: false },
      proxy: { enabled: false, type: 'http', host: '', port: 8080, bypassList: [] },
      timeout: 30_000,
      tls: { verifySsl: true, serverCipherOrder: false },
      certificates: { clientCertificates: [], caCertificates: [] },
    });
    registerMcpHandlerIPC();
    for (const [channel, handler] of mockHandle.mock.calls) {
      registered.set(channel as string, handler as IpcHandler);
    }
  });

  beforeEach(() => {
    stopMcpCleanup();
    sdk.events = undefined;
    sdk.authorization = '';
  });

  it('scrubs tool results, initialize info, error data, notifications and error events', async () => {
    expect(await handlerFor('mcp:connect')(trustedEvent, connectPayload('r-1'))).toEqual({
      success: true,
    });
    expect(sdk.authorization).toBe(`Bearer ${SECRET}`);

    const result = await handlerFor('mcp:request')(trustedEvent, {
      connectionId: 'r-1',
      method: 'tools/call',
      params: { name: 'echo' },
    });
    const init = await handlerFor('mcp:request')(trustedEvent, {
      connectionId: 'r-1',
      method: 'initialize',
    });
    const failed = await handlerFor('mcp:request')(trustedEvent, {
      connectionId: 'r-1',
      method: 'fail',
    });
    await sdk.events?.onNotification({ method: 'notifications/message', params: { data: SECRET } });
    sdk.events?.onError(new Error(`stream broke for Bearer ${SECRET}`));

    const toRenderer = JSON.stringify([result, init, failed, mockEmitTo.mock.calls]);
    expect(toRenderer).not.toContain(SECRET);
    expect(toRenderer).toContain('[redacted]');
    expect(result.success).toBe(true);
    expect(failed.success).toBe(false);
  });

  it('runs the SSRF guard before resolving any credential (blocked URL → no keychain lookup)', async () => {
    mockUnwrap.mockClear();
    mockResolveSafeAddress.mockRejectedValueOnce(new Error('Blocked private address'));
    const res = await handlerFor('mcp:connect')(trustedEvent, connectPayload('r-2'));
    expect(res).toEqual({ success: false, error: 'Blocked private address' });
    expect(mockUnwrap).not.toHaveBeenCalled();
  });
});
