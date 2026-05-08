import { describe, it, expect } from 'vitest';
import { validateMcpSpec } from './mcp-proxy';

describe('validateMcpSpec', () => {
  it('rejects unknown transport', () => {
    const r = validateMcpSpec(
      {
        url: 'https://example.com',
        transport: 'invalid' as 'streamable-http',
        jsonRpc: { method: 'tools/list', id: 1 },
      },
      false
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it('rejects missing jsonRpc method', () => {
    const r = validateMcpSpec(
      {
        url: 'https://example.com',
        transport: 'streamable-http',
        jsonRpc: { id: 1 } as { method: string; id: number },
      },
      false
    );
    expect(r.ok).toBe(false);
  });

  it('rejects missing jsonRpc id', () => {
    const r = validateMcpSpec(
      {
        url: 'https://example.com',
        transport: 'streamable-http',
        jsonRpc: { method: 'foo' } as { method: string; id: number },
      },
      false
    );
    expect(r.ok).toBe(false);
  });

  it('rejects http-sse without postEndpoint', () => {
    const r = validateMcpSpec(
      {
        url: 'https://example.com',
        transport: 'http-sse',
        jsonRpc: { method: 'tools/list', id: 1 },
      },
      false
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/postEndpoint/);
  });

  it('rejects URL pointing to private IP', () => {
    const r = validateMcpSpec(
      {
        url: 'http://10.0.0.1',
        transport: 'streamable-http',
        jsonRpc: { method: 'tools/list', id: 1 },
      },
      false
    );
    expect(r.ok).toBe(false);
  });

  it('uses postEndpoint for http-sse transport', () => {
    const r = validateMcpSpec(
      {
        url: 'https://example.com/sse',
        transport: 'http-sse',
        postEndpoint: 'https://example.com/messages',
        jsonRpc: { method: 'tools/list', id: 1 },
      },
      false
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.targetUrl).toBe('https://example.com/messages');
  });

  it('uses url for streamable-http transport', () => {
    const r = validateMcpSpec(
      {
        url: 'https://example.com/mcp',
        transport: 'streamable-http',
        jsonRpc: { method: 'tools/list', id: 1 },
      },
      false
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.targetUrl).toBe('https://example.com/mcp');
  });

  it('strips Cookie under MCP policy', () => {
    const r = validateMcpSpec(
      {
        url: 'https://example.com',
        transport: 'streamable-http',
        headers: { Cookie: 'sess=1', 'X-Auth': 'token' },
        jsonRpc: { method: 'tools/list', id: 1 },
      },
      false
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.headers.Cookie).toBeUndefined();
      expect(r.headers['X-Auth']).toBe('token');
    }
  });

  it('builds JSON-RPC envelope with params', () => {
    const r = validateMcpSpec(
      {
        url: 'https://example.com',
        transport: 'streamable-http',
        jsonRpc: { method: 'tools/call', params: { tool: 'x' }, id: 'abc' },
      },
      false
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const parsed = JSON.parse(r.body);
      expect(parsed).toEqual({
        jsonrpc: '2.0',
        id: 'abc',
        method: 'tools/call',
        params: { tool: 'x' },
      });
    }
  });

  it('builds JSON-RPC envelope omitting params when undefined', () => {
    const r = validateMcpSpec(
      {
        url: 'https://example.com',
        transport: 'streamable-http',
        jsonRpc: { method: 'tools/list', id: 1 },
      },
      false
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const parsed = JSON.parse(r.body);
      expect(parsed).toEqual({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      expect('params' in parsed).toBe(false);
    }
  });

  it('forwards Mcp-Session-Id when sessionId provided', () => {
    const r = validateMcpSpec(
      {
        url: 'https://example.com',
        transport: 'streamable-http',
        sessionId: 'sess-123',
        jsonRpc: { method: 'tools/list', id: 1 },
      },
      false
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.headers['Mcp-Session-Id']).toBe('sess-123');
    }
  });

  it('caps timeout at 120 seconds', () => {
    const r = validateMcpSpec(
      {
        url: 'https://example.com',
        transport: 'streamable-http',
        timeout: 999_999,
        jsonRpc: { method: 'tools/list', id: 1 },
      },
      false
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.timeoutMs).toBe(120_000);
  });

  it('uses default 60 second timeout when none specified', () => {
    const r = validateMcpSpec(
      {
        url: 'https://example.com',
        transport: 'streamable-http',
        jsonRpc: { method: 'tools/list', id: 1 },
      },
      false
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.timeoutMs).toBe(60_000);
  });

  it('always sets Content-Type and Accept headers', () => {
    const r = validateMcpSpec(
      {
        url: 'https://example.com',
        transport: 'streamable-http',
        jsonRpc: { method: 'tools/list', id: 1 },
      },
      false
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.headers['Content-Type']).toBe('application/json');
      expect(r.headers.Accept).toBe('application/json, text/event-stream');
    }
  });

  it('localhost rejected when allowLocalhost=false', () => {
    const r = validateMcpSpec(
      {
        url: 'http://localhost:3000',
        transport: 'streamable-http',
        jsonRpc: { method: 'tools/list', id: 1 },
      },
      false
    );
    expect(r.ok).toBe(false);
  });

  it('localhost allowed when allowLocalhost=true', () => {
    const r = validateMcpSpec(
      {
        url: 'http://localhost:3000',
        transport: 'streamable-http',
        jsonRpc: { method: 'tools/list', id: 1 },
      },
      true
    );
    expect(r.ok).toBe(true);
  });
});
