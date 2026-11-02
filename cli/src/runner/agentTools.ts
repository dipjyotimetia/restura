import {
  A2aClient,
  type A2aTransport,
  type AgentTool,
  type ContentBlock,
  createA2aTool,
  createMcpTools,
  type ResolvedAgentTools,
  type ToolSource,
} from '@shared/agent-lab';
import { readBoundedText } from '@shared/protocol/ai/bounded-read';
import type { HttpRequest } from '@shared/types';
import type { AgentRuntimeManifest } from '../commands/agentRuntime.js';
import { connectCliMcpClient } from './agentMcpClient.js';
import { AgentPreflightError } from './agentPreflightError.js';
import type { LoadedRequest } from './collectionLoader.js';
import type { ExecuteOptions, ExecuteOutcome } from './executors/types.js';
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
  // Tool names are sanitized and cut to 64 chars, so distinct saved requests or
  // MCP tools can collapse to one name. Fail naming both rather than let the
  // runner reject an anonymous duplicate (or, worse, misroute a call).
  const claimedNames = new Map<string, string>();
  const claimName = (name: string, origin: string): string => {
    const existing = claimedNames.get(name);
    if (existing !== undefined) {
      throw new AgentPreflightError(
        `agent tool name collision: ${existing} and ${origin} both map to "${name}"`
      );
    }
    claimedNames.set(name, origin);
    return name;
  };
  const mcpSources = sources.filter(
    (source): source is Extract<ToolSource, { kind: 'mcp' }> => source.kind === 'mcp'
  );
  // The pinned transport deliberately rejects process-wide proxy settings: a
  // normal CONNECT proxy resolves the final host itself and would defeat the
  // DNS-pinning invariant. Do not create it for suites with no network tools.
  const a2aSources = sources.filter(
    (source): source is Extract<ToolSource, { kind: 'a2a' }> => source.kind === 'a2a'
  );
  const pinnedHttpSession =
    requestedIds.size > 0 || mcpSources.length > 0 || a2aSources.length > 0
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
      if (item.blocked) {
        throw new Error(`agent request tool ${requestId} ${item.blocked}`);
      }
      const request = item.request as HttpRequest;
      const method = request.method.toUpperCase();
      if (!READ_ONLY_HTTP_METHODS.has(method)) {
        throw new Error(`agent request tool must use GET, HEAD, or OPTIONS: ${requestId}`);
      }

      // Desktop classes a scripted request as a mutation and runs its scripts;
      // the CLI never runs them, so the two harnesses would diverge silently.
      if (request.preRequestScript?.trim() || request.testScript?.trim()) {
        throw new AgentPreflightError(
          `agent request tool ${requestId} has pre-request or test scripts (own or inherited); ` +
            'the CLI does not run scripts for agent tools, so use an unscripted request'
        );
      }

      tools.push({
        definition: {
          name: claimName(
            `request_${requestId.replace(/[^a-zA-Z0-9_-]/g, '_')}`.slice(0, 64),
            `request ${requestId}`
          ),
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
      if (runtimeSource?.kind !== 'mcp' || runtimeSource.readOnly !== true) {
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
      // Annotations are never trusted to *grant* access, but a server that
      // flags a tool destructive or explicitly not read-only is a strong signal
      // the operator's readOnly assertion is wrong. Refuse rather than run it
      // unattended in CI. (Unannotated tools pass on the manifest's assertion.)
      const mcpTools = await createMcpTools({ ...source, allowedTools }, client, options.signal, {
        nameForTool: (name) =>
          claimName(cliMcpToolName(runtimeSource.id, name), `MCP tool ${runtimeSource.id}/${name}`),
        inspectDescriptors: (descriptors) => {
          const refused = descriptors.filter(
            (tool) =>
              tool.annotations?.destructiveHint === true || tool.annotations?.readOnlyHint === false
          );
          if (refused.length > 0) {
            throw new AgentPreflightError(
              `MCP source ${runtimeSource.id} lists tools the server marks destructiveHint: true ` +
                `or readOnlyHint: false; remove them from allowedTools: ${refused.map((tool) => tool.name).join(', ')}`
            );
          }
        },
      });
      tools.push(...mcpTools.map((tool) => ({ ...tool, permissionClass: 'read' as const })));
    }
    for (const source of a2aSources) {
      const runtimeSource = runtime.sources.find(
        (candidate) => candidate.kind === 'a2a' && candidate.endpoint === source.endpoint
      );
      if (runtimeSource?.kind !== 'a2a' || runtimeSource.readOnly !== true) {
        throw new Error(`A2A tool source is not a read-only runtime binding: ${source.endpoint}`);
      }
      const client = new A2aClient(
        source.endpoint,
        pinnedA2aTransport(pinnedHttpSession!.fetch, options.timeoutMs),
        {
          headers: environmentHeaders(runtimeSource.headers, options.environment, runtimeSource.id),
        }
      );
      // Like MCP, the manifest's readOnly: true is the operator's authorization to run unattended.
      const tool = await createA2aTool(client, 'read', options.signal);
      tools.push({
        ...tool,
        definition: {
          ...tool.definition,
          name: claimName(tool.definition.name, `A2A agent ${runtimeSource.id}`),
        },
      });
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

/** A2A over the DNS-pinned session: redirects refused, bodies capped while streaming. */
function pinnedA2aTransport(fetch: typeof globalThis.fetch, timeoutMs: number): A2aTransport {
  return async (request, signal) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      ...(request.body !== undefined ? { body: request.body } : {}),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const body = await readBoundedText({
      status: response.status,
      statusText: response.statusText,
      headers: {},
      contentLengthHeader: response.headers.get('content-length'),
      text: () => response.text(),
      body: response.body,
    });
    return { status: response.status, body };
  };
}

function environmentHeaders(
  headers: Array<{ name: string; env: string }>,
  environment: Readonly<Record<string, string | undefined>>,
  sourceId: string
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const header of headers) {
    const value = environment[header.env];
    if (value === undefined || value === '') {
      throw new AgentPreflightError(
        `A2A source ${sourceId} header ${header.name} needs environment variable ${header.env}`
      );
    }
    resolved[header.name] = value;
  }
  return resolved;
}
