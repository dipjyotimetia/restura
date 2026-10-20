import { describe, expect, it } from 'vitest';
import { sanitizeRequestHeaders } from './header-policy';
import { validateMcpSpec } from './mcp-proxy';
import { McpRequestBodySchema } from './mcp-schema';
import { McpTerminateBodySchema, validateMcpTerminateSpec } from './mcp-session';

/**
 * MCP Streamable HTTP lifecycle in the shared proxy core (#862, #865, #888):
 * the negotiated `MCP-Protocol-Version` header, notifications without an id,
 * and DELETE session termination through the same SSRF validation path.
 */

const base = { url: 'https://mcp.example.com/mcp', transport: 'streamable-http' as const };

function headerValue(headers: Record<string, string>, name: string): string[] {
  return Object.entries(headers)
    .filter(([k]) => k.toLowerCase() === name.toLowerCase())
    .map(([, v]) => v);
}

describe('MCP-Protocol-Version header (#865)', () => {
  it('is present on every post-initialize request', () => {
    for (const method of ['tools/list', 'tools/call', 'resources/read', 'ping']) {
      const r = validateMcpSpec(
        { ...base, protocolVersion: '2025-06-18', jsonRpc: { method, id: 1 } },
        false
      );
      if (!r.ok) throw new Error(r.error);
      expect(headerValue(r.headers, 'mcp-protocol-version')).toEqual(['2025-06-18']);
    }
  });

  it('is present on notifications (e.g. notifications/initialized)', () => {
    const r = validateMcpSpec(
      {
        ...base,
        protocolVersion: '2025-11-25',
        jsonRpc: { method: 'notifications/initialized' },
      },
      false
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.headers['MCP-Protocol-Version']).toBe('2025-11-25');
  });

  it('is NOT sent on the initialize request itself', () => {
    const r = validateMcpSpec(
      { ...base, protocolVersion: '2025-06-18', jsonRpc: { method: 'initialize', id: 1 } },
      false
    );
    if (!r.ok) throw new Error(r.error);
    expect(headerValue(r.headers, 'mcp-protocol-version')).toEqual([]);
  });

  it('is absent when no version has been negotiated (back-compat)', () => {
    const r = validateMcpSpec({ ...base, jsonRpc: { method: 'tools/list', id: 1 } }, false);
    if (!r.ok) throw new Error(r.error);
    expect(headerValue(r.headers, 'mcp-protocol-version')).toEqual([]);
  });

  it('replaces a case-variant user header instead of duplicating it', () => {
    const r = validateMcpSpec(
      {
        ...base,
        protocolVersion: '2025-06-18',
        sessionId: 'sess-real',
        headers: { 'mcp-protocol-version': '1999-01-01', 'mcp-session-id': 'spoofed' },
        jsonRpc: { method: 'tools/list', id: 1 },
      },
      false
    );
    if (!r.ok) throw new Error(r.error);
    expect(headerValue(r.headers, 'mcp-protocol-version')).toEqual(['2025-06-18']);
    expect(headerValue(r.headers, 'mcp-session-id')).toEqual(['sess-real']);
  });

  it('rejects a header-unsafe protocolVersion', () => {
    const r = validateMcpSpec(
      { ...base, protocolVersion: '2025\r\nX-Evil: 1', jsonRpc: { method: 'tools/list', id: 1 } },
      false
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it('header policy does not strip MCP-Protocol-Version or Mcp-Session-Id', () => {
    const out = sanitizeRequestHeaders(
      { 'MCP-Protocol-Version': '2025-06-18', 'Mcp-Session-Id': 's' },
      'mcp'
    );
    expect(out).toEqual({ 'MCP-Protocol-Version': '2025-06-18', 'Mcp-Session-Id': 's' });
  });
});

describe('JSON-RPC notifications (#862)', () => {
  it('builds an id-less envelope for notifications/*', () => {
    const r = validateMcpSpec({ ...base, jsonRpc: { method: 'notifications/initialized' } }, false);
    if (!r.ok) throw new Error(r.error);
    expect(r.isNotification).toBe(true);
    expect(JSON.parse(r.body)).toEqual({ jsonrpc: '2.0', method: 'notifications/initialized' });
  });

  it('still requires an id for requests', () => {
    const r = validateMcpSpec({ ...base, jsonRpc: { method: 'tools/list' } }, false);
    expect(r.ok).toBe(false);
  });

  it('requests are not flagged as notifications', () => {
    const r = validateMcpSpec({ ...base, jsonRpc: { method: 'tools/list', id: 7 } }, false);
    if (!r.ok) throw new Error(r.error);
    expect(r.isNotification).toBe(false);
    expect(JSON.parse(r.body).id).toBe(7);
  });

  it('body schema accepts id-less notifications and protocolVersion, rejects id-less requests', () => {
    expect(
      McpRequestBodySchema.safeParse({
        ...base,
        protocolVersion: '2025-06-18',
        jsonRpc: { method: 'notifications/initialized' },
      }).success
    ).toBe(true);
    expect(
      McpRequestBodySchema.safeParse({ ...base, jsonRpc: { method: 'tools/list' } }).success
    ).toBe(false);
  });
});

describe('URL userinfo', () => {
  it('rejects credentials embedded in the MCP URL', () => {
    const r = validateMcpSpec(
      { ...base, url: 'https://u:p@mcp.example.com/mcp', jsonRpc: { method: 'tools/list', id: 1 } },
      false
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });
});

describe('validateMcpTerminateSpec (#888)', () => {
  it('targets the MCP endpoint with session + version headers and no Content-Type', () => {
    const r = validateMcpTerminateSpec(
      { ...base, sessionId: 'sess-1', protocolVersion: '2025-06-18', headers: { 'X-Api': 'k' } },
      { allowLocalhost: false }
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.targetUrl).toBe(base.url);
    expect(r.headers['Mcp-Session-Id']).toBe('sess-1');
    expect(r.headers['MCP-Protocol-Version']).toBe('2025-06-18');
    expect(r.headers['X-Api']).toBe('k');
    expect(headerValue(r.headers, 'content-type')).toEqual([]);
    expect(r.timeoutMs).toBeLessThanOrEqual(10_000);
  });

  it('runs the shared SSRF guard (private / metadata / localhost rejected)', () => {
    for (const url of [
      'http://169.254.169.254/latest/meta-data',
      'http://10.0.0.5/mcp',
      'http://127.0.0.1:3000/mcp',
    ]) {
      const r = validateMcpTerminateSpec(
        { url, transport: 'streamable-http', sessionId: 's' },
        { allowLocalhost: false }
      );
      expect(r.ok).toBe(false);
    }
  });

  it('honours the same localhost opt-in as /api/mcp', () => {
    const r = validateMcpTerminateSpec(
      { url: 'http://127.0.0.1:3000/mcp', transport: 'streamable-http', sessionId: 's' },
      { allowLocalhost: true }
    );
    expect(r.ok).toBe(true);
  });

  it('requires streamable-http and a session id', () => {
    expect(
      validateMcpTerminateSpec(
        { url: base.url, transport: 'http-sse', postEndpoint: base.url, sessionId: 's' },
        { allowLocalhost: false }
      ).ok
    ).toBe(false);
    expect(validateMcpTerminateSpec({ ...base, sessionId: '' }, { allowLocalhost: false }).ok).toBe(
      false
    );
  });

  it('propagates protocolVersion validation errors', () => {
    const r = validateMcpTerminateSpec(
      { ...base, sessionId: 's', protocolVersion: 'bad version' },
      { allowLocalhost: false }
    );
    expect(r.ok).toBe(false);
  });

  it('body schema requires sessionId', () => {
    expect(McpTerminateBodySchema.safeParse({ ...base }).success).toBe(false);
    expect(McpTerminateBodySchema.safeParse({ ...base, sessionId: 's' }).success).toBe(true);
  });
});
