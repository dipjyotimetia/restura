import { describe, expect, it } from 'vitest';
import {
  McpCancelSchema,
  McpConnectSchema,
  McpDisconnectSchema,
  McpRequestSchema,
  SseConnectSchema,
  SseDisconnectSchema,
} from '../ipc/ipc-validators';

describe('SseConnectSchema', () => {
  it('accepts a well-formed http URL with no headers', () => {
    const result = SseConnectSchema.safeParse({
      connectionId: 'abc-123',
      url: 'https://example.com/events',
    });
    expect(result.success).toBe(true);
  });

  it('rejects non-http(s) protocols', () => {
    const result = SseConnectSchema.safeParse({
      connectionId: 'abc',
      url: 'ws://example.com/events',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid connection IDs', () => {
    const result = SseConnectSchema.safeParse({
      connectionId: 'has spaces!',
      url: 'https://example.com',
    });
    expect(result.success).toBe(false);
  });

  it('rejects denylisted headers (host)', () => {
    const result = SseConnectSchema.safeParse({
      connectionId: 'abc',
      url: 'https://example.com',
      headers: { Host: 'evil.com' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects denylisted headers (cookie)', () => {
    const result = SseConnectSchema.safeParse({
      connectionId: 'abc',
      url: 'https://example.com',
      headers: { cookie: 'session=xyz' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts a JSON body string (graphql-sse POST)', () => {
    const result = SseConnectSchema.safeParse({
      connectionId: 'abc',
      url: 'https://example.com/graphql/stream',
      jsonBody: '{"query":"subscription { a }"}',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a non-string or oversized jsonBody', () => {
    const base = { connectionId: 'abc', url: 'https://example.com' };
    expect(SseConnectSchema.safeParse({ ...base, jsonBody: { query: 'x' } }).success).toBe(false);
    expect(
      SseConnectSchema.safeParse({ ...base, jsonBody: 'x'.repeat(1024 * 1024 + 1) }).success
    ).toBe(false);
  });

  it('accepts safe custom headers', () => {
    const result = SseConnectSchema.safeParse({
      connectionId: 'abc',
      url: 'https://example.com',
      headers: { Authorization: 'Bearer token', 'X-Trace-Id': 'abc' },
    });
    expect(result.success).toBe(true);
  });
});

describe('SseDisconnectSchema', () => {
  it('accepts valid id', () => {
    expect(SseDisconnectSchema.safeParse({ connectionId: 'abc' }).success).toBe(true);
  });
  it('rejects empty id', () => {
    expect(SseDisconnectSchema.safeParse({ connectionId: '' }).success).toBe(false);
  });
});

describe('McpConnectSchema', () => {
  it('accepts streamable-http transport', () => {
    expect(
      McpConnectSchema.safeParse({
        connectionId: 'abc',
        url: 'https://mcp.example.com',
        transport: 'streamable-http',
      }).success
    ).toBe(true);
  });

  it('accepts http-sse transport', () => {
    expect(
      McpConnectSchema.safeParse({
        connectionId: 'abc',
        url: 'https://mcp.example.com',
        transport: 'http-sse',
      }).success
    ).toBe(true);
  });

  it('rejects unknown transports', () => {
    expect(
      McpConnectSchema.safeParse({
        connectionId: 'abc',
        url: 'https://mcp.example.com',
        transport: 'stdio',
      }).success
    ).toBe(false);
  });

  it('rejects denylisted headers', () => {
    expect(
      McpConnectSchema.safeParse({
        connectionId: 'abc',
        url: 'https://mcp.example.com',
        transport: 'streamable-http',
        headers: { Connection: 'keep-alive' },
      }).success
    ).toBe(false);
  });
});

describe('McpRequestSchema', () => {
  it('accepts a method-only request', () => {
    expect(
      McpRequestSchema.safeParse({
        connectionId: 'abc',
        method: 'tools/list',
      }).success
    ).toBe(true);
  });

  it('accepts numeric or string requestId', () => {
    expect(
      McpRequestSchema.safeParse({ connectionId: 'a', method: 'm', requestId: 1 }).success
    ).toBe(true);
    expect(
      McpRequestSchema.safeParse({ connectionId: 'a', method: 'm', requestId: 'r-1' }).success
    ).toBe(true);
  });

  it('rejects empty method names', () => {
    expect(McpRequestSchema.safeParse({ connectionId: 'abc', method: '' }).success).toBe(false);
  });

  it('rejects timeouts above the cap', () => {
    expect(
      McpRequestSchema.safeParse({
        connectionId: 'abc',
        method: 'tools/list',
        timeout: 999_999,
      }).success
    ).toBe(false);
  });
});

describe('McpRequestSchema requestId bounds', () => {
  it('rejects empty and oversized string request ids', () => {
    expect(
      McpRequestSchema.safeParse({ connectionId: 'a', method: 'm', requestId: '' }).success
    ).toBe(false);
    expect(
      McpRequestSchema.safeParse({ connectionId: 'a', method: 'm', requestId: 'x'.repeat(257) })
        .success
    ).toBe(false);
  });
});

describe('McpCancelSchema', () => {
  it('accepts a connection id with a string or numeric request id', () => {
    expect(McpCancelSchema.safeParse({ connectionId: 'a', requestId: 3 }).success).toBe(true);
    expect(McpCancelSchema.safeParse({ connectionId: 'a', requestId: 'r-1' }).success).toBe(true);
  });

  it('requires requestId and a valid connectionId', () => {
    expect(McpCancelSchema.safeParse({ connectionId: 'a' }).success).toBe(false);
    expect(McpCancelSchema.safeParse({ connectionId: '', requestId: 1 }).success).toBe(false);
    expect(McpCancelSchema.safeParse({ connectionId: 'a', requestId: '' }).success).toBe(false);
    expect(McpCancelSchema.safeParse({ connectionId: 'a', requestId: {} }).success).toBe(false);
  });
});

describe('McpDisconnectSchema', () => {
  it('accepts valid id', () => {
    expect(McpDisconnectSchema.safeParse({ connectionId: 'abc' }).success).toBe(true);
  });
});
