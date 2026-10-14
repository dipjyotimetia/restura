/**
 * #887 — reflection carries the request's metadata and auth on both
 * transports: web posts it to /api/grpc/reflection, desktop threads it (and
 * any SecretRef-handle auth descriptor) over IPC for main-side resolution.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthConfig, GrpcRequest } from '@/types';
import { GrpcReflectionClient, reflectionCredentialsFor } from '../reflectionClient';

const resolve = (s: string) => s.replace('{{token}}', 'resolved-token');

function grpcRequest(overrides: Partial<GrpcRequest> = {}): GrpcRequest {
  return {
    id: 'r1',
    name: 'r',
    type: 'grpc',
    methodType: 'unary',
    url: 'https://grpc.example.com',
    service: '',
    method: '',
    metadata: [
      { id: 'm1', key: 'X-Tenant', value: '{{token}}', enabled: true },
      { id: 'm2', key: 'x-off', value: 'nope', enabled: false },
    ],
    message: '{ not json yet',
    auth: { type: 'bearer', bearer: { token: 'inline-token' } } as AuthConfig,
    ...overrides,
  };
}

const handleAuth = {
  type: 'bearer',
  bearer: { token: { kind: 'handle', id: 'h-1' } },
} as unknown as AuthConfig;

describe('reflectionCredentialsFor', () => {
  it('resolves enabled metadata ({{vars}}) + inline auth and tolerates an unfinished message', () => {
    const creds = reflectionCredentialsFor(grpcRequest(), resolve);
    expect(creds.metadata['x-tenant']).toBe('resolved-token');
    expect(creds.metadata['x-off']).toBeUndefined();
    expect(creds.metadata.authorization).toBe('Bearer inline-token');
    expect(creds.auth).toBeUndefined();
  });

  it('passes a SecretRef-handle auth descriptor through (never plaintext)', () => {
    const creds = reflectionCredentialsFor(grpcRequest({ auth: handleAuth }), resolve);
    expect(creds.auth).toBe(handleAuth);
    expect(creds.metadata.authorization).toBeUndefined();
  });
});

describe('GrpcReflectionClient credentials — web', () => {
  const mockFetch = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('posts metadata to /api/grpc/reflection', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ listServicesResponse: { service: [] } }),
    });
    const client = new GrpcReflectionClient('https://grpc.example.com', 1000, {
      metadata: { authorization: 'Bearer t' },
    });
    const result = await client.discoverServices();
    expect(result.success).toBe(true);
    const body = JSON.parse(mockFetch.mock.calls[0]?.[1].body as string);
    expect(body.metadata).toEqual({ authorization: 'Bearer t' });
  });

  it('fails fast for handle-backed auth (desktop-only) without calling the proxy', async () => {
    const client = new GrpcReflectionClient('https://grpc.example.com', 1000, {
      metadata: {},
      auth: handleAuth,
    });
    const result = await client.discoverServices();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/desktop app/);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('GrpcReflectionClient credentials — desktop IPC', () => {
  const reflect = vi.fn();
  beforeEach(() => {
    reflect.mockReset().mockResolvedValue({ listServicesResponse: { service: [] } });
    (window as unknown as { electron: unknown }).electron = {
      isElectron: true,
      grpc: { reflect },
    };
  });
  afterEach(() => {
    delete (window as unknown as { electron?: unknown }).electron;
  });

  it('threads metadata and the handle auth descriptor over IPC', async () => {
    const client = new GrpcReflectionClient('grpc://localhost:50051', 1000, {
      metadata: { 'x-tenant': 'acme' },
      auth: handleAuth,
    });
    await client.discoverServices();
    expect(reflect).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { 'x-tenant': 'acme' }, auth: handleAuth })
    );
  });
});
