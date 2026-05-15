/**
 * GraphQL protocol module.
 *
 * GraphQL is HTTP under the hood — a POST to the endpoint with a JSON body
 * of shape `{ query, variables, operationName? }`. The protocol module here
 * exists so the registry has a `graphql` entry (for code-gen, mode picker,
 * future analytics) while delegating the actual transport to the HTTP
 * executor. The Builder is responsible for shaping `body.raw` to the JSON
 * envelope before calling `useRequestRunner().run(request, 'graphql')` —
 * that keeps `runRequest` here free of GraphQL-specific schema concerns
 * (variables JSON parsing, operation type detection live in the Builder).
 *
 * Subscriptions remain on the bespoke WebSocket-backed
 * `GraphQLSubscriptionClient` because they're not request/response and the
 * runner doesn't model long-lived streams yet (see Task 4.5 follow-up note).
 */
import { v4 as uuidv4 } from 'uuid';
import type { ProtocolModule } from '@/features/registry/types';
import type { HttpRequest, Response as ApiResponse } from '@/types';
import { executeRequest } from '@/features/http/lib/requestExecutor';
import { useSettingsStore } from '@/store/useSettingsStore';

function createDefaultGraphQLRequest(): HttpRequest {
  return {
    id: uuidv4(),
    name: 'New GraphQL Request',
    type: 'http',
    method: 'POST',
    url: '',
    headers: [],
    params: [],
    body: { type: 'json', raw: '' },
    auth: { type: 'none' },
  };
}

function defaultResolveVariables(
  text: string,
  vars: Record<string, string>
): string {
  let result = text;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`{{${key}}}`, 'g'), value);
  }
  return result;
}

export const graphqlProtocol: ProtocolModule = {
  id: 'graphql',
  label: 'GraphQL',
  tabType: 'graphql',
  defaultRequest: createDefaultGraphQLRequest,
  // Builder is intentionally undefined — Builder lives at
  // `src/features/graphql/components/GraphQLRequestBuilder.tsx` and drives
  // this protocol via `useRequestRunner` rather than being mounted by the
  // registry directly. Future Task 4.x can register the React component.
  runRequest: async (request, ctx): Promise<ApiResponse> => {
    if (request.type !== 'http') {
      throw new Error(
        `GraphQL protocol expects an HTTP request shape, got ${request.type}`
      );
    }
    if (ctx.signal.aborted) {
      throw new DOMException('Request aborted', 'AbortError');
    }
    const globalSettings = useSettingsStore.getState().settings;
    const variables = ctx.variables ?? {};
    const result = await executeRequest({
      request,
      envVars: { ...variables },
      globalSettings,
      resolveVariables: (text) => defaultResolveVariables(text, variables),
    });
    if (ctx.onScriptResult && result.scriptResult) {
      ctx.onScriptResult(result.scriptResult);
    }
    return result.response;
  },
};
