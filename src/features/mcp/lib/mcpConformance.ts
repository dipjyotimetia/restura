import {
  type McpConformanceReport,
  type McpSampleCallMode,
  runMcpConformance,
} from '@shared/protocol/mcp-conformance';
import { McpClient } from '@/features/mcp/lib/mcpClient';
import { getElectronAPI, isElectron } from '@/lib/shared/platform';
import type { McpTransportType } from '@/types';

export interface McpConformanceRunInput {
  url: string;
  transport: Exclude<McpTransportType, 'stdio'>;
  /** Variable-resolved headers. */
  headers: Record<string, string>;
  sampleCalls: McpSampleCallMode;
  approvedTools: string[];
}

export type McpConformanceRunResult =
  | { ok: true; report: McpConformanceReport }
  | { ok: false; error: string };

class McpRpcError extends Error {
  constructor(
    message: string,
    readonly code?: number
  ) {
    super(message);
  }
}

/**
 * Web path: only the legacy era is reachable. `/api/mcp` is a stateless
 * request/response proxy over plain JSON-RPC POSTs with no era negotiation (no
 * `server/discover`, no pinned protocol version), so the modern era can only be
 * exercised from the desktop app or the CLI.
 */
async function runViaWorker(input: McpConformanceRunInput): Promise<McpConformanceRunResult> {
  if (input.transport === 'http-sse') {
    return {
      ok: false,
      error:
        'http-sse transport is not supported in web mode (use streamable-http or the desktop app)',
    };
  }
  const report = await runMcpConformance(
    {
      async open() {
        const client = new McpClient({
          url: input.url,
          transport: input.transport,
          headers: input.headers,
          connectionId: `conformance-${Date.now()}`,
        });
        const init = await client.request<{
          protocolVersion?: string;
          capabilities?: unknown;
          serverInfo?: unknown;
        }>('initialize', {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'restura', version: '1.0.0' },
        });
        if (!init.ok) throw new McpRpcError(init.error, init.jsonRpcError?.code);
        return {
          protocolVersion: init.result?.protocolVersion ?? '',
          serverCapabilities: init.result?.capabilities,
          serverInfo: init.result?.serverInfo,
          async request(method: string, params?: unknown) {
            const res = await client.request(method, params);
            if (!res.ok) throw new McpRpcError(res.error, res.jsonRpcError?.code);
            return res.result;
          },
          close: async () => {},
        };
      },
    },
    {
      eras: ['legacy'],
      sampleCalls: input.sampleCalls,
      approvedTools: input.approvedTools,
      target: input.url,
      secrets: Object.values(input.headers),
    }
  );
  return { ok: true, report };
}

/** Run the era/conformance report on whichever harness this renderer is on. */
export async function runMcpConformanceReport(
  input: McpConformanceRunInput
): Promise<McpConformanceRunResult> {
  try {
    if (!isElectron()) return await runViaWorker(input);
    const api = getElectronAPI();
    if (!api?.mcp?.conformance) {
      return { ok: false, error: 'Electron MCP conformance API not available' };
    }
    const res = await api.mcp.conformance({
      url: input.url,
      transport: input.transport,
      headers: input.headers,
      sampleCalls: input.sampleCalls,
      approvedTools: input.approvedTools,
    });
    return res.success ? { ok: true, report: res.report } : { ok: false, error: res.error };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Conformance run failed' };
  }
}
