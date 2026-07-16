import type { AgentTool, AgentToolSourceAdapter, ToolSource } from '@shared/agent-lab';
import {
  findInheritedAuthWithSource,
  resolveEffectiveAuth,
} from '@/features/auth/lib/authInheritance';
import { executeRequest } from '@/features/http/lib/requestExecutor';
import { buildValueMap } from '@/lib/shared/variableScopes';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useGlobalsStore } from '@/store/useGlobalsStore';
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
    // A malformed/templated URL has no trustworthy authority/query boundary.
    // Omitting it entirely is safer than regex-redacting only the substrings we
    // happened to recognise (whitespace and malformed userinfo can evade that).
    return '[REDACTED INVALID URL]';
  }
}

export function createResturaRequestTool(
  request: HttpRequest,
  execute: ExecuteHttp,
  hasExecutableScripts = false
): AgentTool {
  const readOnly =
    request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS';
  return {
    definition: {
      name: `restura_request_${request.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`.slice(0, 64),
      description: `${request.method} ${request.name}: ${redactToolUrl(request.url)}`,
      inputSchema: { type: 'object', additionalProperties: false },
    },
    // A GET is not read-only when a request or inherited script can send
    // follow-up traffic or mutate variables. The runner asks for approval
    // before executing every scripted request.
    permissionClass: readOnly && !hasExecutableScripts ? 'read' : 'mutation',
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

function itemHasScripts(items: CollectionItem[], requestId: string, inherited = false): boolean {
  for (const item of items) {
    const scripted = inherited || Boolean(item.preRequestScript?.trim() || item.testScript?.trim());
    if ((item.id === requestId || item.request?.id === requestId) && item.request) {
      return (
        scripted ||
        Boolean(item.request.preRequestScript?.trim() || item.request.testScript?.trim())
      );
    }
    if (item.items && itemHasScripts(item.items, requestId, scripted)) return true;
  }
  return false;
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
    const hasExecutableScripts = Boolean(
      collection?.preRequestScript?.trim() ||
        collection?.testScript?.trim() ||
        itemHasScripts(collection?.items ?? [], item.request.id)
    );
    tools.push(
      createResturaRequestTool(
        item.request,
        async (request, signal) => {
          signal?.throwIfAborted();
          const collectionVars = buildValueMap({ collection: collection?.variables });
          const envVars = buildValueMap({
            globals: useGlobalsStore.getState().vars,
            env: useEnvironmentStore.getState().getActiveEnvironment()?.variables,
            collection: collection?.variables,
          });
          const inherited = collection
            ? findInheritedAuthWithSource(collection, request.id)
            : undefined;
          const effectiveAuth = resolveEffectiveAuth(request.auth, inherited?.auth);
          const requestForExec =
            effectiveAuth === request.auth ? request : { ...request, auth: effectiveAuth };
          const result = await executeRequest({
            request: requestForExec,
            envVars,
            globalSettings: useSettingsStore.getState().settings,
            resolveVariables: (value) => useEnvironmentStore.getState().resolveVariables(value),
            collectionVars,
            ...(signal ? { signal } : {}),
          });
          signal?.throwIfAborted();
          if (
            hasExecutableScripts &&
            collection &&
            result.transportOk &&
            result.collectionVarsMutations
          ) {
            useCollectionStore
              .getState()
              .applyCollectionVarMutations(collection.id, result.collectionVarsMutations);
          }
          return result.response;
        },
        hasExecutableScripts
      )
    );
  }
  return tools;
}

export function createResturaRequestToolSourceAdapter(): AgentToolSourceAdapter {
  return {
    kind: 'restura-request',
    async resolve(source) {
      if (source.kind !== 'restura-request') {
        throw new Error(`Restura request adapter cannot resolve ${source.kind} tools`);
      }
      return resolveResturaAgentTools([source]);
    },
  };
}
