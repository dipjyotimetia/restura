import type { McpConformanceDeps, McpEra } from '@shared/protocol/mcp-conformance';
import { runMcpConformance } from '@shared/protocol/mcp-conformance';
import { createLogger } from '@shared/runtime/logger';
import { ipcMain } from 'electron';
import { IPC } from '../../shared/channels';
import { rateLimited } from '../ipc/ipc-rate-limiter';
import { errorMessage } from '../ipc/ipc-utils';
import { createValidatedEventHandler, McpConformanceSchema } from '../ipc/ipc-validators';
import { getExecutionPolicy } from '../security/execution-policy';
import {
  assertPinnedFetchCanHonorPolicy,
  createPolicyPinnedFetch,
} from '../security/policy-transport';
import { resolveSafeAddress } from '../security/safe-connect';
import { mcpRateLimiter, resolveMcpExecutionPolicy } from './mcp-handler';
import { connectMcpSdkClient } from './mcp-sdk-client';

const log = createLogger('mcp-conformance');

const REQUEST_TIMEOUT_MS = 30_000;
/** One run at a time per renderer: each run opens up to two real connections. */
const activeRuns = new Set<number>();

/**
 * Desktop conformance runner (#911). Opens one ephemeral SDK client per era
 * (`legacy` = plain initialize handshake, `modern` = pinned 2026-07-28
 * server/discover) behind the same SSRF-guarded, policy-pinned fetch as
 * interactive connections, hands them to the shared engine, and returns the
 * JSON-safe report. Nothing outlives the call.
 */
export function registerMcpConformanceIPC(): void {
  ipcMain.handle(
    IPC.mcp.conformance,
    rateLimited(
      mcpRateLimiter,
      createValidatedEventHandler(
        IPC.mcp.conformance,
        McpConformanceSchema,
        async (config, event) => {
          const owner = event.sender.id;
          if (activeRuns.has(owner)) {
            return { success: false as const, error: 'A conformance run is already in progress.' };
          }
          activeRuns.add(owner);
          try {
            const policyConfig = resolveMcpExecutionPolicy(config);
            assertPinnedFetchCanHonorPolicy(policyConfig);
            const pinned = await resolveSafeAddress(policyConfig.url, {
              ...getExecutionPolicy().security,
            });
            const pinnedFetch = createPolicyPinnedFetch(policyConfig, pinned);
            const transportOptions = {
              fetch: pinnedFetch as (url: string | URL, init?: RequestInit) => Promise<Response>,
              requestInit: { headers: config.headers ?? {} },
            };

            const deps: McpConformanceDeps = {
              async open(era: McpEra) {
                if (era === 'modern' && config.transport === 'http-sse') {
                  throw new Error('The modern era is only available over streamable-http');
                }
                const client = await connectMcpSdkClient({
                  url: new URL(policyConfig.url),
                  transport: config.transport,
                  transportOptions,
                  era,
                });
                return {
                  protocolVersion: client.getProtocolVersion(),
                  serverCapabilities: client.getServerCapabilities(),
                  serverInfo: client.getServerVersion(),
                  request: (method, params) => client.request(method, params, REQUEST_TIMEOUT_MS),
                  close: () => client.close(),
                };
              },
            };

            const report = await runMcpConformance(deps, {
              eras: config.eras,
              sampleCalls: config.sampleCalls,
              approvedTools: config.approvedTools,
              target: policyConfig.url,
            });
            return { success: true as const, report };
          } catch (err) {
            const message = errorMessage(err);
            log.warn('conformance run failed', { error: message });
            return { success: false as const, error: message };
          } finally {
            activeRuns.delete(owner);
          }
        }
      )
    )
  );
}

export function stopMcpConformanceCleanup(): void {
  activeRuns.clear();
}
