import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #911 × #896: `mcp:conformance` applies the connection's auth exactly like
 * `mcp:connect` — a SecretRef handle is resolved in main and reaches the REAL
 * server as `Authorization`, never the renderer — and fails closed (no
 * anonymous probe) when the auth can't be applied. Only `electron` and the
 * keychain-backed handle store are mocked.
 */

const mockHandle = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  ipcMain: { handle: mockHandle, removeHandler: vi.fn() },
}));
vi.mock('../security/secret-handle-store', () => ({
  describeSecretHandle: vi.fn(),
  resolveSecretHandle: vi.fn(),
  unwrapSecretValueMain: (v: unknown): string | undefined => {
    if (typeof v === 'string') return v;
    const ref = v as { kind?: string; value?: string; id?: string } | undefined;
    if (ref?.kind === 'inline') return ref.value;
    if (ref?.kind === 'handle') return ref.id === 'h-mcp' ? 'keychain-mcp-token' : undefined;
    return undefined;
  },
}));

import type { McpConformanceReport } from '@shared/protocol/mcp-conformance';
import { type MockMcpServerHandle, startMockMcpServer } from '../../../e2e/mocks/mcpServer';
import {
  CONFORMANCE_OAUTH_UNSUPPORTED,
  registerMcpConformanceIPC,
  stopMcpConformanceCleanup,
} from '../handlers/mcp-conformance-handler';
import { setExecutionPolicy } from '../security/execution-policy';

type IpcHandler = (event: unknown, payload: unknown) => Promise<Record<string, unknown>>;

const trustedEvent = {
  sender: { id: 8, isDestroyed: () => false, once: vi.fn() },
  senderFrame: { url: 'file:///app/dist/web/index.html' },
};

const registered = new Map<string, IpcHandler>();
async function run(payload: Record<string, unknown>) {
  const handler = registered.get('mcp:conformance');
  if (!handler) throw new Error('mcp:conformance not registered');
  return handler(trustedEvent, payload);
}

describe('mcp:conformance auth (main-side resolution, real server)', () => {
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
    registerMcpConformanceIPC();
    for (const [channel, handler] of mockHandle.mock.calls) {
      registered.set(channel as string, handler as IpcHandler);
    }
  });

  beforeEach(() => server.reset());

  afterAll(async () => {
    stopMcpConformanceCleanup();
    await server.close();
  });

  it('resolves a handle bearer in main and probes authenticated', async () => {
    const res = await run({
      url: server.url,
      transport: 'streamable-http',
      eras: ['legacy'],
      auth: { type: 'bearer', bearer: { token: { kind: 'handle', id: 'h-mcp' } } },
    });
    expect(res.success).toBe(true);
    const report = res.report as McpConformanceReport;
    expect(report.eras.find((e) => e.era === 'legacy')?.status).toBe('ok');
    expect(server.authorizationsReceived().length).toBeGreaterThan(0);
    expect(new Set(server.authorizationsReceived())).toEqual(
      new Set(['Bearer keychain-mcp-token'])
    );
    // The resolved plaintext never crosses back to the renderer.
    expect(JSON.stringify(res)).not.toContain('keychain-mcp-token');
  });

  it('fails closed without contacting the server when the handle no longer resolves', async () => {
    const res = await run({
      url: server.url,
      transport: 'streamable-http',
      eras: ['legacy'],
      auth: { type: 'bearer', bearer: { token: { kind: 'handle', id: 'revoked' } } },
    });
    expect(res).toEqual({
      success: false,
      error: 'MCP auth setup failed: Auth credential is unavailable on this device',
    });
    expect(server.authorizationsReceived()).toEqual([]);
  });

  it('refuses the interactive OAuth flow instead of probing anonymously', async () => {
    const res = await run({
      url: server.url,
      transport: 'streamable-http',
      auth: { type: 'oauth2', oauth2: { accessToken: '', grantType: 'authorization_code' } },
    });
    expect(res).toEqual({ success: false, error: CONFORMANCE_OAUTH_UNSUPPORTED });
    expect(server.authorizationsReceived()).toEqual([]);
  });
});
