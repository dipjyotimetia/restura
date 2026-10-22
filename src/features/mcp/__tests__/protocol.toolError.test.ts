import { beforeEach, describe, expect, it, vi } from 'vitest';

const request = vi.fn();
vi.mock('../lib/mcpClient', () => ({
  McpClient: class {
    connect = async () => ({ ok: true });
    disconnect = async () => undefined;
    request = request;
  },
}));

import { mcpProtocol } from '../protocol';

const mcp = {
  id: 'r',
  name: 'r',
  type: 'mcp' as const,
  url: 'https://mcp.example.test',
  transport: 'streamable-http' as const,
  headers: [],
  auth: { type: 'none' as const },
};

describe('mcpProtocol.runJsonRpc tool errors (#868)', () => {
  beforeEach(() => request.mockReset());

  it('flags toolError for a successful response with isError: true', async () => {
    request.mockResolvedValue({ ok: true, result: { isError: true, content: [] }, durationMs: 1 });
    const res = await mcpProtocol.runJsonRpc(
      mcp,
      { signal: new AbortController().signal },
      { method: 'ping' }
    );
    expect(res).toMatchObject({ ok: true, toolError: true });
  });

  it('does not flag toolError for a normal result', async () => {
    request.mockResolvedValue({ ok: true, result: { content: [] }, durationMs: 1 });
    const res = await mcpProtocol.runJsonRpc(
      mcp,
      { signal: new AbortController().signal },
      { method: 'ping' }
    );
    expect(res.ok).toBe(true);
    expect(res.toolError).toBeUndefined();
  });
});
