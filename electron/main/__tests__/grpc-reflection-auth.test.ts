// @vitest-environment node
/**
 * #887 — desktop reflection carries the request's metadata and resolves
 * SecretRef-handle auth main-side (the renderer never sees the plaintext).
 */
import './setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockExecuteConnectReflection = vi.hoisted(() => vi.fn());
const mockResolveGrpcDialAddress = vi.hoisted(() => vi.fn());
const mockMaterialize = vi.hoisted(() => vi.fn());

vi.mock('../handlers/grpc-connect', () => ({
  executeConnectReflection: mockExecuteConnectReflection,
  resolveGrpcDialAddress: mockResolveGrpcDialAddress,
  // grpc-handler (imported for mergeMainSideAuth) pulls these too.
  executeConnectServerStreamCollect: vi.fn(),
  executeConnectUnary: vi.fn(),
  runConnectStream: vi.fn(),
}));

vi.mock('../handlers/grpc-credentials', () => ({
  resolveGrpcExecutionPolicy: (config: unknown) => config,
  resolveGrpcReflectionExecutionPolicy: (config: Record<string, unknown>) => ({
    ...config,
    timeout: config.timeout ?? 1000,
    verifySsl: true,
  }),
}));

vi.mock('../security/external-secret-materializer', async (orig) => {
  const actual = await orig<typeof import('../security/external-secret-materializer')>();
  mockMaterialize.mockImplementation(actual.materializeExternalProtocolAuth);
  return { ...actual, materializeExternalProtocolAuth: mockMaterialize };
});

vi.mock('../security/secret-handle-store', () => ({
  unwrapSecretValueMain: (v: unknown) =>
    v && typeof v === 'object' && (v as { kind?: string }).kind === 'handle'
      ? 'resolved-secret'
      : typeof v === 'object' && v !== null
        ? (v as { value?: string }).value
        : v,
}));

import { ipcMain } from 'electron';
import { IPC } from '../../shared/channels';
import { registerGrpcReflectionIPC } from '../handlers/grpc-reflection-handler';
import { ReflectionIpcConfigSchema } from '../ipc/ipc-validators';

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

function reflectHandler(): Handler {
  const call = vi.mocked(ipcMain.handle).mock.calls.find(([ch]) => ch === IPC.grpc.reflect);
  if (!call) throw new Error('reflect handler not registered');
  return call[1] as Handler;
}

const trustedEvent = {
  sender: { id: 1, isDestroyed: () => false, once: () => undefined, send: vi.fn() },
  senderFrame: { url: 'file:///app/dist/web/index.html', parent: null },
};

const base = {
  url: 'grpc://grpc.example.com:50051',
  reflectionService: 'grpc.reflection.v1.ServerReflection',
  request: { listServices: '' },
};

describe('desktop reflection metadata / auth (#887)', () => {
  beforeEach(() => {
    vi.mocked(ipcMain.handle).mockClear();
    mockExecuteConnectReflection.mockReset().mockResolvedValue({
      listServicesResponse: { service: [{ name: 'echo.v1.EchoService' }] },
    });
    mockResolveGrpcDialAddress.mockReset().mockResolvedValue({
      ip: '203.0.113.10',
      port: 50051,
      family: 4,
    });
    registerGrpcReflectionIPC();
  });

  it('forwards request metadata to the reflection call', async () => {
    await reflectHandler()(trustedEvent, {
      ...base,
      metadata: { authorization: 'Bearer inline', 'x-tenant': 'acme' },
    });
    const args = mockExecuteConnectReflection.mock.calls[0]?.[0];
    expect(args.metadata).toEqual({ authorization: 'Bearer inline', 'x-tenant': 'acme' });
  });

  it('resolves a SecretRef-handle bearer main-side into the metadata', async () => {
    await reflectHandler()(trustedEvent, {
      ...base,
      auth: { type: 'bearer', bearer: { token: { kind: 'handle', id: 'h-1' } } },
    });
    const args = mockExecuteConnectReflection.mock.calls[0]?.[0];
    expect(args.metadata.authorization).toBe('Bearer resolved-secret');
  });

  it('drops hop-by-hop / proxy headers from reflection metadata', async () => {
    await reflectHandler()(trustedEvent, {
      ...base,
      metadata: { 'proxy-authorization': 'Basic x', connection: 'close', 'x-ok': '1' },
    });
    const args = mockExecuteConnectReflection.mock.calls[0]?.[0];
    expect(args.metadata).toEqual({ 'x-ok': '1' });
  });

  it('runs the SSRF pre-flight before resolving secrets', async () => {
    mockResolveGrpcDialAddress.mockRejectedValueOnce(new Error('blocked'));
    await expect(
      reflectHandler()(trustedEvent, {
        ...base,
        auth: { type: 'bearer', bearer: { token: { kind: 'handle', id: 'h-1' } } },
      })
    ).rejects.toThrow();
    expect(mockExecuteConnectReflection).not.toHaveBeenCalled();
    expect(mockMaterialize).not.toHaveBeenCalled();
  });

  it('drops connect-* / grpc-* metadata keys', async () => {
    await reflectHandler()(trustedEvent, {
      ...base,
      metadata: { 'Grpc-Timeout': '1n', 'connect-timeout-ms': '1', 'x-ok': '1' },
    });
    const args = mockExecuteConnectReflection.mock.calls[0]?.[0];
    expect(args.metadata).toEqual({ 'x-ok': '1' });
  });

  it('sanitizes errors propagated from the reflection call', async () => {
    mockExecuteConnectReflection.mockRejectedValueOnce(
      new Error('boom at /Users/me/app/secret.ts\n    at foo (/x/y.js:1:1)')
    );
    const err = await reflectHandler()(trustedEvent, base).catch((e: Error) => e);
    expect((err as Error).message).not.toContain('/Users/me');
    expect((err as Error).message).not.toContain('at foo');
  });

  it('sanitizes the auth setup failure message', async () => {
    mockMaterialize.mockRejectedValueOnce(new Error('keychain failed in /opt/app/store.ts'));
    const res = (await reflectHandler()(trustedEvent, {
      ...base,
      auth: { type: 'bearer', bearer: { token: { kind: 'handle', id: 'h-1' } } },
    })) as { errorResponse: { errorMessage: string } };
    expect(res.errorResponse.errorMessage).toContain('auth setup failed');
    expect(res.errorResponse.errorMessage).not.toContain('/opt/app');
  });
});

describe('ReflectionIpcConfigSchema metadata policy (#887)', () => {
  it('accepts metadata and handle auth', () => {
    expect(
      ReflectionIpcConfigSchema.safeParse({
        ...base,
        metadata: { authorization: 'Bearer x' },
        auth: { type: 'bearer', bearer: { token: { kind: 'handle', id: 'h' } } },
      }).success
    ).toBe(true);
  });

  it('rejects CR/LF in metadata values', () => {
    expect(
      ReflectionIpcConfigSchema.safeParse({ ...base, metadata: { 'x-a': 'a\r\nb: c' } }).success
    ).toBe(false);
  });

  it('rejects an invalid metadata key', () => {
    expect(
      ReflectionIpcConfigSchema.safeParse({ ...base, metadata: { 'bad key': 'v' } }).success
    ).toBe(false);
  });

  it('accepts a multi-KB bearer token, like the call path (#895)', () => {
    expect(
      ReflectionIpcConfigSchema.safeParse({
        ...base,
        metadata: { authorization: `Bearer ${'a'.repeat(2048)}` },
      }).success
    ).toBe(true);
  });

  it('rejects metadata over the 16 KiB aggregate', () => {
    expect(
      ReflectionIpcConfigSchema.safeParse({
        ...base,
        metadata: { authorization: 'a'.repeat(16 * 1024) },
      }).success
    ).toBe(false);
  });
});
