import type { AgentTool, ToolSource } from '@shared/agent-lab';
import { resolveEffectiveAuth } from '@/features/auth/lib/authInheritance';
import { resolveInheritedAuthFor } from '@/features/auth/lib/resolveInheritedAuthFor';
import { executeRequest } from '@/features/http/lib/requestExecutor';
import { buildActiveRequestValueMap } from '@/lib/shared/activeRequestScopes';
import { buildValueMap } from '@/lib/shared/variableScopes';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import type { Collection, CollectionItem, HttpRequest, Response } from '@/types';

type ExecuteHttp = (request: HttpRequest, signal?: AbortSignal) => Promise<Response>;

export function redactToolUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      url.searchParams.set(key, 'REDACTED');
    }
    return url.toString();
  } catch {
    return raw
      .replace(/#.*$/, '')
      .replace(/\/\/[^/@\s]+@/g, '//REDACTED@')
      .replace(/([?&][^=&#\s]+)=([^&#\s]*)/g, '$1=REDACTED');
  }
}

export function createResturaRequestTool(request: HttpRequest, execute: ExecuteHttp): AgentTool {
  const readOnly =
    request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS';
  return {
    definition: {
      name: `restura_request_${request.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`.slice(0, 64),
      description: `${request.method} ${request.name}: ${redactToolUrl(request.url)}`,
      inputSchema: { type: 'object', additionalProperties: false },
    },
    permissionClass: readOnly ? 'read' : 'mutation',
    async execute(_arguments, { signal }) {
      signal.throwIfAborted();
      const response = await execute(request, signal);
      signal.throwIfAborted();
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
    let owningCollection: Collection | undefined;
    let item: CollectionItem | undefined;
    for (const collection of collections) {
      const candidate = findItem(collection.items ?? [], source.requestId);
      if (candidate) {
        owningCollection = collection;
        item = candidate;
        break;
      }
    }
    if (!item?.request || item.request.type !== 'http') {
      throw new Error(`HTTP request tool not found: ${source.requestId}`);
    }
    const collection = owningCollection;
    tools.push(
      createResturaRequestTool(item.request, async (request, signal) => {
        signal?.throwIfAborted();
        const collectionVars = buildValueMap({ collection: collection?.variables });
        const inherited = resolveInheritedAuthFor(request);
        const effectiveAuth = resolveEffectiveAuth(request.auth, inherited?.auth);
        const requestForExec =
          effectiveAuth === request.auth ? request : { ...request, auth: effectiveAuth };
        const result = await executeRequest({
          request: requestForExec,
          envVars: { ...buildActiveRequestValueMap(), ...collectionVars },
          globalSettings: useSettingsStore.getState().settings,
          resolveVariables: (value) => useEnvironmentStore.getState().resolveVariables(value),
          collectionVars,
          ...(signal ? { signal } : {}),
        });
        signal?.throwIfAborted();
        if (collection && result.collectionVarsMutations) {
          useCollectionStore
            .getState()
            .applyCollectionVarMutations(collection.id, result.collectionVarsMutations);
        }
        return result.response;
      })
    );
  }
  return tools;
}
