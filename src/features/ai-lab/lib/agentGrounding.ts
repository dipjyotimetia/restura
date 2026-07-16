import type { ContextPacket, GroundingSelection, GroundingSourceKind } from '@shared/agent-lab';
import { buildContextPackets } from '@shared/agent-lab';
import { redactToolUrl } from './agentTools';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useMcpStore } from '@/features/mcp/store/useMcpStore';
import type { Collection, CollectionItem } from '@/types';

interface SourceCandidate {
  id: string;
  kind: GroundingSourceKind;
  label: string;
  version: string;
  content: string;
}

function collectionContent(collection: Collection): string {
  const requests: string[] = [];
  const walk = (items: CollectionItem[], path: string[]): void => {
    for (const item of items) {
      if (item.type === 'folder') {
        walk(item.items ?? [], [...path, item.name]);
        continue;
      }
      const request = item.request;
      if (!request) continue;
      const location = [...path, item.name].join('/');
      if (request.type === 'http') {
        // Intentionally omit headers, bodies and auth: they can carry secrets.
        requests.push(`${location}: ${request.method} ${redactToolUrl(request.url)}`);
      } else {
        requests.push(`${location}: ${request.type.toUpperCase()} request`);
      }
    }
  };
  walk(collection.items ?? [], []);
  return [`Collection: ${collection.name}`, ...requests].join('\n');
}

/** Build sanitized, opt-in evidence packets from desktop-owned sources. */
export async function resolveDesktopGrounding(
  selection: GroundingSelection
): Promise<ContextPacket[]> {
  const collections = useCollectionStore.getState().collections;
  const connections = useMcpStore.getState().connections;
  const sources: SourceCandidate[] = [];

  for (const id of selection.sourceIds) {
    const collection = collections.find((candidate) => candidate.id === id);
    const connection = connections[id];
    if (collection && connection) throw new Error(`ambiguous grounding source: ${id}`);
    if (collection) {
      sources.push({
        id,
        kind: 'collection',
        label: collection.name,
        version: 'current',
        content: collectionContent(collection),
      });
      continue;
    }
    if (connection) {
      const tools = connection.capabilities?.tools ?? [];
      sources.push({
        id,
        kind: 'mcp-catalog',
        label: `MCP: ${connection.url}`,
        version: connection.capabilities?.serverVersion ?? 'current',
        content: [
          `MCP server: ${connection.capabilities?.serverName ?? connection.url}`,
          ...tools.map((tool) => `${tool.name}${tool.description ? `: ${tool.description}` : ''}`),
        ].join('\n'),
      });
      continue;
    }
    throw new Error(`unknown grounding source: ${id}`);
  }

  return buildContextPackets(sources, selection);
}
