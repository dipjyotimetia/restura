import {
  createMcpTools,
  type AgentTool,
  type ContentBlock,
  type ResolvedAgentTools,
  type ToolSource,
} from '@shared/agent-lab';
import type { HttpRequest } from '@/types';
import type { LoadedRequest } from './collectionLoader.js';
import type { ExecuteOptions, ExecuteOutcome } from './executors/types.js';
import type { AgentRuntimeManifest } from '../commands/agentRuntime.js';
import { connectCliMcpClient } from './agentMcpClient.js';
import { createPinnedMcpFetchSession } from './pinnedMcpFetch.js';

export interface CliAgentToolDependencies {
  loadCollection(path: string): Promise<{ requests: LoadedRequest[] }>;
  executeHttp(item: LoadedRequest, options: ExecuteOptions): Promise<ExecuteOutcome>;
}

export interface CliAgentToolOptions {
  variables: Record<string, string>;
  environment: Readonly<Record<string, string | undefined>>;
  timeoutMs: number;
  allowLocalhost: boolean;
  signal?: AbortSignal;
}

const READ_ONLY_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Resolve only the request IDs explicitly named by the portable suite *and*
 * the CI runtime manifest. The resolver deliberately exposes no URL or
 * method arguments to the model: a tool invocation can execute exactly one
 * saved read-only request.
 */
export async function resolveCliAgentTools(
  sources: ToolSource[],
  runtime: AgentRuntimeManifest,
  options: CliAgentToolOptions,
  dependencies: CliAgentToolDependencies
): Promise<ResolvedAgentTools> {
  const requestedIds = new Set(
    sources
      .filter(
        (source): source is Extract<ToolSource, { kind: 'restura-request' }> =>
          source.kind === 'restura-request'
      )
      .map((source) => source.requestId)
  );
  const tools: AgentTool[] = [];
  const mcpSources = sources.filter(
    (source): source is Extract<ToolSource, { kind: 'mcp' }> => source.kind === 'mcp'
  );
  // The pinned transport deliberately rejects process-wide proxy settings: a
  // normal CONNECT proxy resolves the final host itself and would defeat the
  // DNS-pinning invariant. Do not create it for suites with no network tools.
  const pinnedHttpSession =
    requestedIds.size > 0 || mcpSources.length > 0
      ? createPinnedMcpFetchSession(options.allowLocalhost)
      : undefined;

  for (const source of runtime.sources) {
    if (source.kind !== 'collection') continue;
    const permitted = source.requestIds.filter((requestId) => requestedIds.has(requestId));
    if (permitted.length === 0) continue;

    const collection = await dependencies.loadCollection(source.path);
    for (const requestId of permitted) {
      const item = collection.requests.find((candidate) => candidate.request.id === requestId);
      if (!item) {
        throw new Error(`runtime manifest request was not found in collection: ${requestId}`);
      }
      if (item.type !== 'http') {
        throw new Error(`agent request tool must be HTTP: ${requestId}`);
      }
      const request = item.request as HttpRequest;
      const method = request.method.toUpperCase();
      if (!READ_ONLY_HTTP_METHODS.has(method)) {
        throw new Error(`agent request tool must use GET, HEAD, or OPTIONS: ${requestId}`);
      }

      tools.push({
        definition: {
          name: `request_${requestId.replace(/[^a-zA-Z0-9_-]/g, '_')}`.slice(0, 64),
          description: `Run saved read-only request: ${item.relativePath}`,
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {},
          },
        },
        permissionClass: 'read',
        async execute(_arguments, context): Promise<ContentBlock[]> {
          const outcome = await dependencies.executeHttp(item, {
            vars: options.variables,
            timeoutMs: options.timeoutMs,
            allowLocalhost: options.allowLocalhost,
            signal: context.signal,
            fetcher: pinnedHttpSession?.fetcher,
            oauthFetch: pinnedHttpSession?.fetch,
          });
          return outcomeToContent(requestId, outcome, context.signal.aborted);
        },
      });
    }
  }

  if (tools.length !== requestedIds.size) {
    throw new Error('not every requested agent tool could be resolved from the runtime manifest');
  }
  const clients = [] as Awaited<ReturnType<typeof connectCliMcpClient>>[];
  try {
    for (const source of mcpSources) {
      const runtimeSource = runtime.sources.find(
        (candidate) => candidate.kind === 'mcp' && candidate.id === source.connectionId
      );
      if (!runtimeSource || runtimeSource.kind !== 'mcp' || runtimeSource.readOnly !== true) {
        throw new Error(
          `MCP tool source is not a read-only runtime binding: ${source.connectionId}`
        );
      }
      const client = await connectCliMcpClient(runtimeSource, {
        environment: options.environment,
        allowLocalhost: options.allowLocalhost,
        timeoutMs: options.timeoutMs,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      clients.push(client);
      // The manifest's required `readOnly: true` is the CI operator's
      // explicit authorization. Without it, shared MCP tools remain
      // approval-required because server annotations are not trustworthy.
      const allowedTools = source.allowedTools
        ? source.allowedTools.filter((tool) => runtimeSource.allowedTools.includes(tool))
        : runtimeSource.allowedTools;
      const mcpTools = await createMcpTools({ ...source, allowedTools }, client, options.signal, {
        nameForTool: (name) => cliMcpToolName(runtimeSource.id, name),
      });
      tools.push(...mcpTools.map((tool) => ({ ...tool, permissionClass: 'read' as const })));
    }
  } catch (error) {
    await Promise.allSettled(clients.map((client) => client.dispose()));
    await pinnedHttpSession?.dispose();
    throw error;
  }
  return {
    tools,
    async dispose() {
      await Promise.allSettled(clients.map((client) => client.dispose()));
      await pinnedHttpSession?.dispose();
    },
  };
}

function cliMcpToolName(sourceId: string, remoteName: string): string {
  return `mcp_${sourceId}_${remoteName}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

function outcomeToContent(
  requestId: string,
  outcome: ExecuteOutcome,
  aborted: boolean
): ContentBlock[] {
  if (aborted) throw new DOMException('agent tool call cancelled', 'AbortError');
  const envelope = {
    requestId,
    status: outcome.status,
    passed: outcome.passed,
    durationMs: outcome.durationMs,
    headers: outcome.responseHeaders ?? {},
    ...(outcome.responseBody !== undefined ? { body: outcome.responseBody } : {}),
    ...(outcome.errorMessage ? { error: outcome.errorMessage } : {}),
  };
  return [{ type: 'json', value: envelope }];
}
