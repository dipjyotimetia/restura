// @vitest-environment node
// NTLM (#1069) end-to-end through the real desktop `http:request` IPC path:
// renderer payload → Zod validation → main-side handle resolution
// (ntlmFetchAuthFor) → pinned Electron fetcher → the echo mock's independent
// NTLMv2 verifier (e2e/mocks/ntlmRoute.ts), which rejects a type 3 that
// arrives on a socket other than the challenged one.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const mockHandle = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  ipcMain: { handle: mockHandle, removeHandler: vi.fn() },
  session: { defaultSession: { resolveProxy: vi.fn() } },
}));
vi.mock('../security/env-proxy', () => ({ resolveEnvProxy: () => undefined }));
vi.mock('../security/secret-handle-store', () => ({
  unwrapSecretValueMain: (v: unknown): string | undefined => {
    if (typeof v === 'string') return v;
    const ref = v as { kind?: string; value?: string; id?: string } | undefined;
    if (ref?.kind === 'inline') return ref.value;
    if (ref?.kind === 'handle') return ref.id === 'h-ntlm' ? 'wonderland' : undefined;
    return undefined;
  },
}));

import { type MockHttpServerHandle, startMockHttpServer } from '../../../e2e/mocks/httpServer';
import { NTLM_FIXTURE } from '../../../e2e/mocks/ntlmRoute';
import { IPC } from '../../shared/channels';
import { registerHttpHandlerIPC } from '../handlers/http-handler';
import { setExecutionPolicy } from '../security/execution-policy';

type IpcHandler = (e: unknown, p: unknown) => Promise<unknown>;

let server: MockHttpServerHandle;
let handler: IpcHandler;
let counter = 0;
const event = {
  sender: { id: 5151, isDestroyed: () => false, once: vi.fn() },
  senderFrame: { url: 'file:///app/dist/web/index.html', parent: null },
};

beforeAll(async () => {
  server = await startMockHttpServer({ port: 0 });
  setExecutionPolicy({
    security: { allowLocalhost: true, allowPrivateIPs: false },
    proxy: { enabled: false, type: 'http', host: '', port: 8080, bypassList: [] },
    timeout: 30_000,
    tls: { verifySsl: true, serverCipherOrder: false },
    certificates: { clientCertificates: [], caCertificates: [] },
  });
  registerHttpHandlerIPC();
  handler = mockHandle.mock.calls.find((c) => c[0] === IPC.http.request)?.[1] as IpcHandler;
});
afterAll(async () => {
  await server.close();
});

function request(ntlm: Record<string, unknown>) {
  counter += 1;
  return handler(event, {
    requestId: `55555555-5555-4555-8555-${String(counter).padStart(12, '0')}`,
    method: 'GET',
    url: `${server.url}/ntlm/protected`,
    auth: { type: 'ntlm', ntlm },
  }) as Promise<{ status: number; data: { authenticated: boolean; reason?: string } }>;
}

describe('http:request — NTLM (desktop)', () => {
  it('authenticates with a keychain handle password', async () => {
    const reply = await request({
      username: NTLM_FIXTURE.username,
      password: { kind: 'handle', id: 'h-ntlm' },
      domain: NTLM_FIXTURE.domain,
      workstation: 'DESKTOP',
    });
    expect(reply.status).toBe(200);
    expect(reply.data.authenticated).toBe(true);
  });

  it('authenticates with DOMAIN\\user and no separate domain', async () => {
    const reply = await request({
      username: `${NTLM_FIXTURE.domain}\\${NTLM_FIXTURE.username}`,
      password: NTLM_FIXTURE.password,
    });
    expect(reply.status).toBe(200);
  });

  it('is rejected by the server with a wrong password', async () => {
    const reply = await request({ username: NTLM_FIXTURE.username, password: 'nope' });
    expect(reply.status).toBe(401);
    expect(reply.data.reason).toBe('NTLMv2 proof mismatch');
  });
});
