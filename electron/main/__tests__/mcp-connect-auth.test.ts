// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

// Handle store stand-in: handle ids resolve to plaintext only here, in "main".
const HANDLES: Record<string, string> = { 'h-token': 'keychain-token', 'h-key': 'keychain-key' };
vi.mock('../security/secret-handle-store', () => ({
  unwrapSecretValueMain: (v: unknown): string | undefined => {
    if (typeof v === 'string') return v;
    const ref = v as { kind?: string; value?: string; id?: string } | undefined;
    if (ref?.kind === 'inline') return ref.value;
    if (ref?.kind === 'handle') return ref.id ? HANDLES[ref.id] : undefined;
    return undefined;
  },
}));
vi.mock('../security/external-secret-providers', () => ({
  desktopExternalSecretResolver: {
    resolve: vi.fn(async (ref: { secretId: string }) => `vault:${ref.secretId}`),
  },
}));

import {
  MCP_REQUEST_TRANSPORT,
  materializeMcpConnectAuth,
  needsMcpConnectAuth,
} from '../security/mcp-connect-auth';

type Auth = Parameters<typeof materializeMcpConnectAuth>[0]['auth'];
const handle = (id: string) => ({ kind: 'handle' as const, id });
const URL_ = 'https://mcp.example.com/mcp';

describe('materializeMcpConnectAuth (#896)', () => {
  it('is a no-op without auth (or with none)', async () => {
    expect(needsMcpConnectAuth({ url: URL_ })).toBe(false);
    expect(needsMcpConnectAuth({ url: URL_, auth: { type: 'none' } })).toBe(false);
    const out = await materializeMcpConnectAuth({ url: URL_, headers: { 'X-A': '1' } });
    expect(out.headers).toEqual({ 'X-A': '1' });
    expect(out.redact('x')).toBe('x');
    expect((await materializeMcpConnectAuth({ url: URL_ })).headers).toEqual({});
  });

  it('resolves a keychain handle bearer into headers, replacing a same-named user header', async () => {
    const out = await materializeMcpConnectAuth({
      url: URL_,
      headers: { authorization: 'Bearer stale', 'X-Tenant': 'acme' },
      auth: { type: 'bearer', bearer: { token: handle('h-token') } } as Auth,
    });
    expect(out.headers).toEqual({ 'X-Tenant': 'acme', Authorization: 'Bearer keychain-token' });
    expect(out.redact('server said keychain-token is bad')).toBe('server said [redacted] is bad');
  });

  it('resolves a handle-backed API key header and an inline bearer', async () => {
    const key = await materializeMcpConnectAuth({
      url: URL_,
      auth: {
        type: 'api-key',
        apiKey: { key: 'X-API-Key', value: handle('h-key'), in: 'header' },
      } as Auth,
    });
    expect(key.headers).toEqual({ 'X-API-Key': 'keychain-key' });
    const inline = await materializeMcpConnectAuth({
      url: URL_,
      auth: { type: 'bearer', bearer: { token: { kind: 'inline', value: 'tok' } } } as Auth,
    });
    expect(inline.headers).toEqual({ Authorization: 'Bearer tok' });
  });

  it('resolves an external secret ref', async () => {
    const out = await materializeMcpConnectAuth({
      url: URL_,
      auth: {
        type: 'bearer',
        bearer: {
          token: {
            kind: 'external',
            provider: 'aws-secrets-manager',
            profileId: 'p',
            secretId: 's1',
          },
        },
      } as Auth,
    });
    expect(out.headers.Authorization).toBe('Bearer vault:s1');
  });

  it('fails closed when a handle no longer resolves (never an unauthenticated session)', async () => {
    await expect(
      materializeMcpConnectAuth({
        url: URL_,
        auth: { type: 'bearer', bearer: { token: handle('revoked') } } as Auth,
      })
    ).rejects.toThrow(/unavailable on this device/);
  });

  it('rejects query placement and sign-at-wire schemes before resolving anything', async () => {
    await expect(
      materializeMcpConnectAuth({
        url: URL_,
        auth: {
          type: 'api-key',
          apiKey: { key: 'k', value: handle('h-key'), in: 'query' },
        } as Auth,
      })
    ).rejects.toThrow(/query string/);
    await expect(
      materializeMcpConnectAuth({
        url: URL_,
        auth: {
          type: 'aws-signature',
          awsSignature: { accessKey: 'a', secretKey: 's', region: 'r', service: 's' },
        } as Auth,
      })
    ).rejects.toThrow(/isn't supported for MCP/);
  });

  it('refuses auth that would set a transport-owned or denied header', async () => {
    for (const key of ['Mcp-Session-Id', 'Host', 'Accept']) {
      await expect(
        materializeMcpConnectAuth({
          url: URL_,
          auth: { type: 'api-key', apiKey: { key, value: 'v', in: 'header' } } as Auth,
        })
      ).rejects.toThrow(/not allowed on an MCP request/);
    }
  });

  it('error messages never contain the resolved plaintext', async () => {
    const err = await materializeMcpConnectAuth({
      url: URL_,
      auth: {
        type: 'api-key',
        apiKey: { key: 'X-Key', value: { kind: 'inline', value: 'bad\r\nvalue' }, in: 'header' },
      } as Auth,
    }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain('bad');
  });

  it('exposes MCP transport rules (http/https only, MCP-owned headers denied)', () => {
    expect(MCP_REQUEST_TRANSPORT.allowedSchemes).toEqual(['http:', 'https:']);
    expect(MCP_REQUEST_TRANSPORT.isForbiddenHeader('mcp-protocol-version')).toBe(true);
    expect(MCP_REQUEST_TRANSPORT.isForbiddenHeader('proxy-authorization')).toBe(true);
    expect(MCP_REQUEST_TRANSPORT.isForbiddenHeader('Authorization')).toBe(false);
  });
});
