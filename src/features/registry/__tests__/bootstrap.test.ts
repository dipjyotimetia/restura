import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('protocol bootstrap', () => {
  beforeEach(() => vi.resetModules());

  it('registers http and grpc on import', async () => {
    await import('../bootstrap');
    const { protocolRegistry } = await import('../registry');
    expect(protocolRegistry.get('http')).toBeDefined();
    expect(protocolRegistry.get('grpc')).toBeDefined();
  });

  it('registers every wire protocol Restura supports', async () => {
    await import('../bootstrap');
    const { protocolRegistry } = await import('../registry');
    const ids = protocolRegistry.list().map((p) => p.id).sort();
    expect(ids).toEqual(['graphql', 'grpc', 'http', 'kafka', 'mcp', 'socketio', 'sse', 'websocket']);
  });

  it('every registered protocol has the required fields', async () => {
    await import('../bootstrap');
    const { protocolRegistry } = await import('../registry');
    for (const proto of protocolRegistry.list()) {
      expect(typeof proto.id).toBe('string');
      expect(typeof proto.label).toBe('string');
      expect(typeof proto.tabType).toBe('string');
      expect(typeof proto.defaultRequest).toBe('function');
      expect(typeof proto.runRequest).toBe('function');
    }
  });

  it('http defaultRequest produces a valid HTTP request shape', async () => {
    await import('../bootstrap');
    const { protocolRegistry } = await import('../registry');
    const http = protocolRegistry.get('http');
    expect(http).toBeDefined();
    const req = http!.defaultRequest();
    expect(req.type).toBe('http');
    expect(typeof req.id).toBe('string');
    expect(req.id.length).toBeGreaterThan(0);
    if (req.type === 'http') {
      expect(req.method).toBe('GET');
      expect(Array.isArray(req.headers)).toBe(true);
      expect(Array.isArray(req.params)).toBe(true);
      expect(req.body.type).toBe('none');
      expect(req.auth.type).toBe('none');
    }
  });

  it('grpc defaultRequest produces a valid gRPC request shape', async () => {
    await import('../bootstrap');
    const { protocolRegistry } = await import('../registry');
    const grpc = protocolRegistry.get('grpc');
    expect(grpc).toBeDefined();
    const req = grpc!.defaultRequest();
    expect(req.type).toBe('grpc');
    expect(typeof req.id).toBe('string');
    expect(req.id.length).toBeGreaterThan(0);
    if (req.type === 'grpc') {
      expect(req.methodType).toBe('unary');
      expect(Array.isArray(req.metadata)).toBe(true);
      expect(req.auth.type).toBe('none');
    }
  });

  it('http runRequest rejects requests of the wrong type', async () => {
    await import('../bootstrap');
    const { protocolRegistry } = await import('../registry');
    const http = protocolRegistry.get('http');
    const grpcReq = protocolRegistry.get('grpc')!.defaultRequest();
    const ctx = { signal: new AbortController().signal, variables: {} };
    await expect(http!.runRequest(grpcReq, ctx)).rejects.toThrow(/HTTP protocol/);
  });

  it('grpc runRequest rejects requests of the wrong type', async () => {
    await import('../bootstrap');
    const { protocolRegistry } = await import('../registry');
    const grpc = protocolRegistry.get('grpc');
    const httpReq = protocolRegistry.get('http')!.defaultRequest();
    const ctx = { signal: new AbortController().signal, variables: {} };
    await expect(grpc!.runRequest(httpReq, ctx)).rejects.toThrow(/gRPC protocol/);
  });
});
