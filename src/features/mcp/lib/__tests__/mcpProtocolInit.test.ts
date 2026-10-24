/**
 * #901 L1: a failed connect / initialize in `runJsonRpc` must not leak the
 * half-open client (a desktop IPC session) — it is disconnected before the
 * init error surfaces, pooled or not.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpRequest } from '@/types';

const wire = vi.hoisted(() => ({
  connect: { ok: true } as { ok: true } | { ok: false; error: string },
  initialize: { ok: true, result: {}, durationMs: 0 } as unknown,
  disconnects: 0,
}));

vi.mock('../mcpClient', () => ({
  McpClient: class {
    async connect() {
      return wire.connect;
    }
    async request() {
      return wire.initialize;
    }
    async disconnect() {
      wire.disconnects++;
    }
  },
}));

import { mcpProtocol } from '../../protocol';
import type { McpClient } from '../mcpClient';

const request: McpRequest = {
  id: 'm',
  name: 'M',
  type: 'mcp',
  url: 'https://mcp.example.test/mcp',
  transport: 'streamable-http',
  headers: [],
  auth: { type: 'none' },
};
const ctx = { signal: new AbortController().signal };

beforeEach(() => {
  wire.connect = { ok: true };
  wire.initialize = { ok: true, result: {}, durationMs: 0 };
  wire.disconnects = 0;
});

describe('runJsonRpc init failure cleanup', () => {
  it('disconnects when connect fails', async () => {
    wire.connect = { ok: false, error: 'refused' };
    const res = await mcpProtocol.runJsonRpc(request, ctx, { method: 'tools/list' });
    expect(res).toMatchObject({ ok: false, error: 'refused' });
    expect(wire.disconnects).toBe(1);
  });

  it('disconnects when initialize fails, and evicts the pooled entry', async () => {
    wire.initialize = {
      ok: false,
      error: 'bad',
      jsonRpcError: { code: -32600, message: 'bad' },
      durationMs: 0,
    };
    const pool = new Map<string, Promise<McpClient>>();
    const res = await mcpProtocol.runJsonRpc(request, ctx, {
      method: 'tools/list',
      clientPool: pool,
      cacheKey: 'k',
    });
    expect(res).toMatchObject({ ok: false, jsonRpcError: { code: -32600 } });
    expect(wire.disconnects).toBe(1);
    expect(pool.has('k')).toBe(false);
  });

  it('disconnects when an explicit initialize call cannot connect', async () => {
    wire.connect = { ok: false, error: 'down' };
    await mcpProtocol.runJsonRpc(request, ctx, { method: 'initialize' });
    expect(wire.disconnects).toBe(1);
  });
});
