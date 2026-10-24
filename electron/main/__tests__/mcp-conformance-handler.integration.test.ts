import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Integration test (#911): the `mcp:conformance` IPC handler against the REAL
 * dual-era v2 mock and the legacy-only SDK mock. Only `electron` is mocked;
 * DNS guard, pinned fetch and both SDK negotiation modes run for real.
 */

const mockHandle = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  ipcMain: { handle: mockHandle, removeHandler: vi.fn() },
}));

import type { McpConformanceReport } from '@shared/protocol/mcp-conformance';
import { type MockMcpServerHandle, startMockMcpServer } from '../../../e2e/mocks/mcpServer';
import { type MockMcpV2ServerHandle, startMockMcpV2Server } from '../../../e2e/mocks/mcpV2Server';
import {
  registerMcpConformanceIPC,
  stopMcpConformanceCleanup,
} from '../handlers/mcp-conformance-handler';
import { setExecutionPolicy } from '../security/execution-policy';

type IpcHandler = (event: unknown, payload: unknown) => Promise<Record<string, unknown>>;

const trustedEvent = {
  sender: { id: 7, isDestroyed: () => false, once: vi.fn() },
  senderFrame: { url: 'file:///app/dist/web/index.html' },
};

const registered = new Map<string, IpcHandler>();

async function run(payload: Record<string, unknown>) {
  const handler = registered.get('mcp:conformance');
  if (!handler) throw new Error('mcp:conformance not registered');
  return handler(trustedEvent, payload);
}

describe('mcp-conformance-handler integration', () => {
  let v2: MockMcpV2ServerHandle;
  let legacyOnly: MockMcpServerHandle;

  beforeAll(async () => {
    setExecutionPolicy({
      security: { allowLocalhost: true, allowPrivateIPs: false },
      proxy: { enabled: false, type: 'http', host: '', port: 8080, bypassList: [] },
      timeout: 30_000,
      tls: { verifySsl: true, serverCipherOrder: false },
      certificates: { clientCertificates: [], caCertificates: [] },
    });
    v2 = await startMockMcpV2Server();
    legacyOnly = await startMockMcpServer();
    registerMcpConformanceIPC();
    for (const [channel, handler] of mockHandle.mock.calls) {
      registered.set(channel as string, handler as IpcHandler);
    }
  });

  afterAll(async () => {
    stopMcpConformanceCleanup();
    await v2.close();
    await legacyOnly.close();
  });

  it('runs both eras against a dual-era server and diffs them', async () => {
    const res = await run({ url: v2.url, transport: 'streamable-http' });
    expect(res.success).toBe(true);
    const report = res.report as McpConformanceReport;
    const byEra = Object.fromEntries(report.eras.map((e) => [e.era, e]));
    expect(byEra.legacy?.status).toBe('ok');
    expect(byEra.modern?.status).toBe('ok');
    expect((byEra.modern?.protocolVersion ?? '') >= '2026-07-28').toBe(true);
    expect((byEra.legacy?.protocolVersion ?? '9') < '2026-07-28').toBe(true);
    expect(byEra.legacy?.listing.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['add', 'confirm-deploy', 'echo', 'fail', 'header-echo'])
    );
    expect(report.diff).not.toBeNull();
    expect(report.target).toBe(v2.url);
    // Sample calls were off: nothing invoked.
    expect(report.eras.every((e) => e.samples.every((s) => s.status === 'skipped'))).toBe(true);
  });

  it('only invokes explicitly approved tools in selected mode', async () => {
    const res = await run({
      url: v2.url,
      transport: 'streamable-http',
      sampleCalls: 'selected',
      approvedTools: ['echo'],
    });
    const report = res.report as McpConformanceReport;
    for (const era of report.eras) {
      const called = era.samples.filter((s) => s.status !== 'skipped').map((s) => s.tool);
      expect(called).toEqual(['echo']);
    }
  });

  it('reports the modern era as unsupported on a legacy-only server', async () => {
    const res = await run({ url: legacyOnly.url, transport: 'streamable-http' });
    expect(res.success).toBe(true);
    const report = res.report as McpConformanceReport;
    expect(report.eras.find((e) => e.era === 'legacy')?.status).toBe('ok');
    expect(report.eras.find((e) => e.era === 'modern')?.status).toBe('unsupported');
    expect(report.diff).toBeNull();
  });

  it('rejects invalid payloads at the IPC boundary', async () => {
    await expect(run({ url: 'ftp://nope', transport: 'streamable-http' })).rejects.toThrow(
      /Invalid IPC payload/
    );
    await expect(
      run({ url: v2.url, transport: 'streamable-http', sampleCalls: 'everything' })
    ).rejects.toThrow(/Invalid IPC payload/);
  });
});
