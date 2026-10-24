import type { McpConformanceDeps, McpEra } from '@shared/protocol/mcp-conformance';
import { runMcpConformance } from '@shared/protocol/mcp-conformance';
import { createLogger } from '@shared/runtime/logger';
import { ipcMain } from 'electron';
import { IPC } from '../../shared/channels';
import { bindRendererCleanup } from '../ipc/connection-cleanup';
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
import { connectMcpSdkClient, type McpSdkClient } from './mcp-sdk-client';

const log = createLogger('mcp-conformance');

const REQUEST_TIMEOUT_MS = 30_000;
/** Whole run (both eras, every request) is bounded regardless of server behaviour. */
export const CONFORMANCE_TOTAL_DEADLINE_MS = 120_000;

interface ConformanceRun {
  controller: AbortController;
  /** Live SDK clients; closed on abort, renderer teardown and app cleanup. */
  clients: Set<McpSdkClient>;
}

/** One run at a time per renderer (webContents id): each opens up to two real connections. */
const runs = new Map<number, ConformanceRun>();

function teardownRun(run: ConformanceRun): void {
  run.controller.abort();
  for (const client of run.clients) void client.close().catch(() => undefined);
  run.clients.clear();
}

/** Reject if `work` doesn't settle in `ms` or the run aborts; closes whatever it built. */
async function bounded<T>(
  work: Promise<T>,
  ms: number,
  signal: AbortSignal,
  onLate: (value: T) => void
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const limit = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Connection timeout after ${ms}ms`)), ms);
    onAbort = () => reject(new Error('Conformance run aborted'));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([work, limit]);
  } catch (err) {
    // If the connect completes after we gave up, close it instead of leaking it.
    work.then(onLate, () => undefined);
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Desktop conformance runner (#911). Opens one ephemeral SDK client per era
 * (`legacy` = plain initialize handshake, `modern` = pinned 2026-07-28
 * server/discover) behind the same SSRF-guarded, policy-pinned fetch as
 * interactive connections, hands them to the shared engine, and returns the
 * JSON-safe report. Nothing outlives the call: every connect is bounded by the
 * execution-policy timeout, the whole run by a total deadline, and live clients
 * are closed on completion, renderer destruction and app teardown.
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
          if (runs.has(owner)) {
            return { success: false as const, error: 'A conformance run is already in progress.' };
          }
          const run: ConformanceRun = { controller: new AbortController(), clients: new Set() };
          runs.set(owner, run);
          bindRendererCleanup(runs, event.sender, (deadId) => {
            const dead = runs.get(deadId);
            if (dead) teardownRun(dead);
            runs.delete(deadId);
          });
          const deadline = setTimeout(() => run.controller.abort(), CONFORMANCE_TOTAL_DEADLINE_MS);
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
                let created: McpSdkClient | undefined;
                const connecting = connectMcpSdkClient({
                  url: new URL(policyConfig.url),
                  transport: config.transport,
                  transportOptions,
                  era,
                  onClientCreated: (c) => {
                    created = c;
                    run.clients.add(c);
                  },
                });
                let client: McpSdkClient;
                try {
                  client = await bounded(
                    connecting,
                    policyConfig.timeout,
                    run.controller.signal,
                    (late) => void late.close().catch(() => undefined)
                  );
                } catch (err) {
                  if (created) {
                    run.clients.delete(created);
                    void created.close().catch(() => undefined);
                  }
                  throw err;
                }
                return {
                  protocolVersion: client.getProtocolVersion(),
                  serverCapabilities: client.getServerCapabilities(),
                  serverInfo: client.getServerVersion(),
                  request: (method, params) => client.request(method, params, REQUEST_TIMEOUT_MS),
                  close: async () => {
                    run.clients.delete(client);
                    await client.close();
                  },
                };
              },
            };

            const report = await runMcpConformance(deps, {
              eras: config.eras,
              sampleCalls: config.sampleCalls,
              approvedTools: config.approvedTools,
              target: policyConfig.url,
              secrets: Object.values(config.headers ?? {}),
              signal: run.controller.signal,
            });
            return { success: true as const, report };
          } catch (err) {
            const message = errorMessage(err);
            log.warn('conformance run failed', { error: message });
            return { success: false as const, error: message };
          } finally {
            clearTimeout(deadline);
            teardownRun(run);
            if (runs.get(owner) === run) runs.delete(owner);
          }
        }
      )
    )
  );
}

export function stopMcpConformanceCleanup(): void {
  for (const run of runs.values()) teardownRun(run);
  runs.clear();
}
