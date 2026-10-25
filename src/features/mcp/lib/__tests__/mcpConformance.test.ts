import { beforeEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({
  electron: false,
  api: undefined as unknown,
}));
vi.mock('@/lib/shared/platform', () => ({
  isElectron: () => platform.electron,
  getElectronAPI: () => platform.api,
}));

const requests = vi.hoisted(() => ({
  handler: undefined as undefined | ((method: string, params?: unknown) => unknown),
}));
vi.mock('@/features/mcp/lib/mcpClient', () => ({
  McpClient: class {
    async request(method: string, params?: unknown) {
      return requests.handler?.(method, params);
    }
  },
}));

import { runMcpConformanceReport } from '@/features/mcp/lib/mcpConformance';

const input = {
  url: 'https://h.example/mcp?token=secret',
  transport: 'streamable-http' as const,
  headers: {},
  sampleCalls: 'off' as const,
  approvedTools: [],
};

beforeEach(() => {
  platform.electron = false;
  platform.api = undefined;
});

describe('runMcpConformanceReport', () => {
  it('desktop: delegates to the mcp:conformance bridge', async () => {
    const report = { schemaVersion: 1 };
    const conformance = vi.fn().mockResolvedValue({ success: true, report });
    platform.electron = true;
    platform.api = { mcp: { conformance } };
    await expect(runMcpConformanceReport(input)).resolves.toEqual({ ok: true, report });
    expect(conformance).toHaveBeenCalledWith(
      expect.objectContaining({ url: input.url, sampleCalls: 'off', approvedTools: [] })
    );
  });

  it('desktop: forwards the main-side auth descriptor untouched', async () => {
    const conformance = vi.fn().mockResolvedValue({ success: true, report: {} });
    platform.electron = true;
    platform.api = { mcp: { conformance } };
    const auth = {
      type: 'bearer' as const,
      bearer: { token: { kind: 'handle' as const, id: 'h' } },
    };
    await runMcpConformanceReport({ ...input, auth });
    expect(conformance).toHaveBeenCalledWith(expect.objectContaining({ auth }));
  });

  it('desktop: surfaces bridge errors and a missing bridge', async () => {
    platform.electron = true;
    platform.api = {
      mcp: { conformance: vi.fn().mockResolvedValue({ success: false, error: 'nope' }) },
    };
    await expect(runMcpConformanceReport(input)).resolves.toEqual({ ok: false, error: 'nope' });
    platform.api = { mcp: {} };
    const res = await runMcpConformanceReport(input);
    expect(res.ok).toBe(false);
    platform.api = {
      mcp: {
        conformance: vi.fn().mockRejectedValue(new Error('ipc down')),
      },
    };
    await expect(runMcpConformanceReport(input)).resolves.toEqual({
      ok: false,
      error: 'ipc down',
    });
  });

  it('web: runs the legacy era only through the Worker client, redacting the target', async () => {
    requests.handler = (method) => {
      if (method === 'initialize') {
        return {
          ok: true,
          result: {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 's', version: '1' },
          },
        };
      }
      if (method === 'tools/list') return { ok: true, result: { tools: [] } };
      return { ok: false, error: 'Method not found', jsonRpcError: { code: -32601, message: 'x' } };
    };
    const res = await runMcpConformanceReport(input);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.report.eras.map((e) => e.era)).toEqual(['legacy']);
    expect(res.report.eras[0]?.status).toBe('ok');
    expect(res.report.target).toBe('https://h.example/mcp');
    expect(res.report.summary.errors).toBe(0);
  });

  it('web: a failed initialize is a legacy-era error finding, and http-sse is refused', async () => {
    requests.handler = () => ({ ok: false, error: 'HTTP 502' });
    const res = await runMcpConformanceReport(input);
    expect(res.ok && res.report.eras[0]?.status).toBe('failed');
    const sse = await runMcpConformanceReport({ ...input, transport: 'http-sse' });
    expect(sse.ok).toBe(false);
  });

  it('web: tolerates an initialize with no result, and non-Error rejections on desktop', async () => {
    requests.handler = (method) =>
      method === 'initialize' ? { ok: true, result: undefined } : { ok: false, error: 'nf' };
    const res = await runMcpConformanceReport(input);
    expect(res.ok && res.report.eras[0]?.protocolVersion).toBe('');
    platform.electron = true;
    platform.api = { mcp: { conformance: vi.fn().mockRejectedValue('weird') } };
    await expect(runMcpConformanceReport(input)).resolves.toEqual({
      ok: false,
      error: 'Conformance run failed',
    });
  });
});
