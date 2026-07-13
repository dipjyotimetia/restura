import type { AgentTool, ToolSource } from '@shared/agent-lab';
import { executeRequest } from '@/features/http/lib/requestExecutor';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import type { CollectionItem, HttpRequest, Response } from '@/types';

type ExecuteHttp = (request: HttpRequest) => Promise<Response>;

export function createResturaRequestTool(request: HttpRequest, execute: ExecuteHttp): AgentTool {
  const readOnly =
    request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS';
  return {
    definition: {
      name: `restura_request_${request.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`.slice(0, 64),
      description: `${request.method} ${request.name}: ${request.url}`,
      inputSchema: { type: 'object', additionalProperties: false },
    },
    permissionClass: readOnly ? 'read' : 'mutation',
    async execute() {
      const response = await execute(request);
      return [
        {
          type: 'json',
          value: {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
            body: response.body,
            timeMs: response.time,
            sizeBytes: response.size,
          },
        },
      ];
    },
  };
}

function findItem(items: CollectionItem[], id: string): CollectionItem | undefined {
  for (const item of items) {
    if (item.id === id || item.request?.id === id) return item;
    const nested = item.items ? findItem(item.items, id) : undefined;
    if (nested) return nested;
  }
  return undefined;
}

export async function resolveResturaAgentTools(sources: ToolSource[]): Promise<AgentTool[]> {
  const tools: AgentTool[] = [];
  for (const source of sources) {
    if (source.kind !== 'restura-request') {
      throw new Error(`${source.kind} tool sources need their runtime adapter configured`);
    }
    const collections = useCollectionStore.getState().collections;
    const item = collections
      .map((collection) => findItem(collection.items ?? [], source.requestId))
      .find((candidate) => candidate !== undefined);
    if (!item?.request || item.request.type !== 'http') {
      throw new Error(`HTTP request tool not found: ${source.requestId}`);
    }
    tools.push(
      createResturaRequestTool(item.request, async (request) => {
        const result = await executeRequest({
          request,
          envVars: {},
          globalSettings: useSettingsStore.getState().settings,
          resolveVariables: (value) => value,
        });
        return result.response;
      })
    );
  }
  return tools;
}
