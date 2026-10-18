import { describe, expect, it } from 'vitest';
import {
  isMcpTransportHeader,
  MCP_EDITOR_AUTH_TYPES,
  mcpAuthLabel,
  mcpAuthUnsupportedReason,
  resolveMcpEffectiveAuth,
} from './mcp-auth';

describe('mcpAuthUnsupportedReason (#896)', () => {
  it.each(['none', 'bearer', 'basic', 'oauth2'])('accepts header-shaped %s auth', (type) => {
    expect(mcpAuthUnsupportedReason({ type })).toBeUndefined();
  });

  it('accepts no auth at all', () => {
    expect(mcpAuthUnsupportedReason(undefined)).toBeUndefined();
  });

  it('accepts an API key sent as a header (default placement too)', () => {
    expect(mcpAuthUnsupportedReason({ type: 'api-key', apiKey: { in: 'header' } })).toBeUndefined();
    expect(mcpAuthUnsupportedReason({ type: 'api-key' })).toBeUndefined();
  });

  it('rejects an API key in the query string', () => {
    expect(mcpAuthUnsupportedReason({ type: 'api-key', apiKey: { in: 'query' } })).toMatch(
      /query string/
    );
  });

  it.each(['digest', 'oauth1', 'aws-signature', 'ntlm', 'wsse'])(
    'rejects sign-at-wire %s auth',
    (type) => {
      expect(mcpAuthUnsupportedReason({ type })).toMatch(/isn't supported for MCP/);
    }
  );
});

describe('MCP auth policy helpers', () => {
  it('offers none / bearer / api-key in the editor (oauth2 is the #856 extension point)', () => {
    expect([...MCP_EDITOR_AUTH_TYPES]).toEqual(['none', 'bearer', 'api-key']);
  });

  it('labels auth types', () => {
    expect(mcpAuthLabel('aws-signature')).toBe('AWS Signature');
    expect(mcpAuthLabel('custom')).toBe('custom');
  });

  it.each([
    'Mcp-Session-Id',
    'mcp-protocol-version',
    'Accept',
    ' content-type ',
    'Host',
    'Last-Event-ID',
  ])('treats %s as transport-owned', (name) => {
    expect(isMcpTransportHeader(name)).toBe(true);
  });

  it('does not treat credential headers as transport-owned', () => {
    expect(isMcpTransportHeader('Authorization')).toBe(false);
    expect(isMcpTransportHeader('X-API-Key')).toBe(false);
  });
});

describe('resolveMcpEffectiveAuth', () => {
  const bearer = { type: 'bearer' };
  const aws = { type: 'aws-signature' };
  const none = { type: 'none' };

  it("keeps the request's own configured auth, even when unsupported (fails closed later)", () => {
    expect(resolveMcpEffectiveAuth(aws, bearer)).toEqual({ auth: aws });
  });

  it('inherits supported folder/collection auth when the request has none', () => {
    expect(resolveMcpEffectiveAuth(none, bearer)).toEqual({ auth: bearer });
    expect(resolveMcpEffectiveAuth(undefined, bearer)).toEqual({ auth: bearer });
  });

  it('skips an inherited scheme MCP cannot carry, with a reason', () => {
    const out = resolveMcpEffectiveAuth(none, aws);
    expect(out.auth).toBe(none);
    expect(out.skippedReason).toMatch(/AWS Signature/);
  });

  it('returns the own auth when nothing is inherited', () => {
    expect(resolveMcpEffectiveAuth(none, undefined)).toEqual({ auth: none });
    expect(resolveMcpEffectiveAuth(none, none)).toEqual({ auth: none });
  });
});
