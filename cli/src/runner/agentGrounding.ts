import {
  buildContextPackets,
  type ContextPacket,
  type GroundingSelection,
} from '@shared/agent-lab';
import type { HttpRequest } from '@shared/types';
import type { LoadedCollection } from './collectionLoader.js';
import type { AgentRuntimeManifest } from '../commands/agentRuntime.js';
import { connectCliMcpClient } from './agentMcpClient.js';

export interface CliGroundingDependencies {
  loadCollection(path: string): Promise<LoadedCollection>;
}

export interface CliGroundingOptions {
  environment: Readonly<Record<string, string | undefined>>;
  allowLocalhost: boolean;
  timeoutMs: number;
  signal?: AbortSignal;
}

function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, 'REDACTED');
    return url.toString();
  } catch {
    return '[REDACTED URL]';
  }
}

function collectionSummary(collection: LoadedCollection): string {
  return [
    `Collection: ${collection.meta.name}`,
    ...collection.requests.map((item) => {
      if (item.type !== 'http') return `${item.relativePath}: ${item.type.toUpperCase()} request`;
      const request = item.request as HttpRequest;
      return `${item.relativePath}: ${request.method} ${redactUrl(request.url)}`;
    }),
  ].join('\n');
}

/** Resolve only runtime-manifest sources named by the suite grounding selection. */
export async function resolveCliGrounding(
  selection: GroundingSelection,
  runtime: AgentRuntimeManifest,
  options: CliGroundingOptions,
  dependencies: CliGroundingDependencies
): Promise<ContextPacket[]> {
  const sources = [] as Array<{
    id: string;
    kind: 'collection' | 'mcp-catalog';
    label: string;
    version: string;
    content: string;
  }>;
  for (const sourceId of selection.sourceIds) {
    const source = runtime.sources.find((candidate) => candidate.id === sourceId);
    if (!source)
      throw new Error(`grounding source is not listed in the runtime manifest: ${sourceId}`);
    if (source.kind === 'collection') {
      const collection = await dependencies.loadCollection(source.path);
      sources.push({
        id: source.id,
        kind: 'collection',
        label: collection.meta.name,
        version: 'current',
        content: collectionSummary(collection),
      });
      continue;
    }
    if (source.readOnly !== true)
      throw new Error(`MCP grounding source is not read-only: ${source.id}`);
    const client = await connectCliMcpClient(source, options);
    try {
      const tools = await client.listTools(options.signal);
      sources.push({
        id: source.id,
        kind: 'mcp-catalog',
        label: `MCP: ${redactUrl(source.url)}`,
        version: 'current',
        content: [
          `MCP catalog: ${redactUrl(source.url)}`,
          ...tools.map((tool) => `${tool.name}${tool.description ? `: ${tool.description}` : ''}`),
        ].join('\n'),
      });
    } finally {
      await client.dispose();
    }
  }
  return buildContextPackets(sources, selection);
}
