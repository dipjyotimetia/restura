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
import { escapeRegExp } from '@/lib/shared/escapeRegExp';
import type { ProtocolModule } from '@/features/registry/types';
import type { HttpRequest, Request, Response as ApiResponse } from '@/types';
import { executeRequest } from '@/features/http/lib/requestExecutor';
import { useSettingsStore } from '@/store/useSettingsStore';
import { injectString } from '@/features/workflows/lib/variableHelpers';

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

function defaultResolveVariables(text: string, vars: Record<string, string>): string {
  let result = text;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`{{${escapeRegExp(key)}}}`, 'g'), () => value);
  }
  return result;
}

/**
 * GraphQL requests ride on an HTTP envelope: `body.raw` is the JSON
 * `{query, variables, operationName}` payload. Substitute into the
 * envelope by JSON-parsing it, walking the `variables` map for
 * `{{var}}` references, and re-serialising. If the envelope isn't
 * parseable (the user is still typing), fall back to plain string
 * substitution so partial input still resolves the obvious cases.
 */
function injectGraphQLVariables(request: Request, variables: Record<string, string>): Request {
  if (request.type !== 'http') return request;
  const http = request as HttpRequest;
  const inject = (text: string) => injectString(text, variables);

  let body = http.body;
  if (body.raw !== undefined) {
    let nextRaw = body.raw;
    try {
      const parsed: unknown = JSON.parse(body.raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const envelope = parsed as {
          query?: unknown;
          variables?: unknown;
          operationName?: unknown;
        };
        const out: Record<string, unknown> = { ...envelope };
        if (typeof envelope.query === 'string') {
          out.query = inject(envelope.query);
        }
        if (envelope.variables && typeof envelope.variables === 'object') {
          out.variables = injectInJson(envelope.variables, inject);
        }
        if (typeof envelope.operationName === 'string') {
          out.operationName = inject(envelope.operationName);
        }
        nextRaw = JSON.stringify(out);
      } else {
        nextRaw = inject(body.raw);
      }
    } catch {
      nextRaw = inject(body.raw);
    }
    body = { ...body, raw: nextRaw };
  }

  return {
    ...http,
    url: inject(http.url),
    headers: http.headers.map((h) => ({
      ...h,
      key: inject(h.key),
      value: inject(h.value),
    })),
    params: http.params.map((p) => ({
      ...p,
      key: inject(p.key),
      value: inject(p.value),
    })),
    body,
  };
}

function injectInJson(value: unknown, inject: (s: string) => string): unknown {
  if (typeof value === 'string') return inject(value);
  if (Array.isArray(value)) return value.map((v) => injectInJson(v, inject));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = injectInJson(v, inject);
    }
    return out;
  }
  return value;
}

export const graphqlProtocol: ProtocolModule = {
  id: 'graphql',
  label: 'GraphQL',
  tabType: 'graphql',
  defaultRequest: createDefaultGraphQLRequest,
  injectVariables: injectGraphQLVariables,
  // Builder is intentionally undefined — Builder lives at
  // `src/features/graphql/components/GraphQLRequestBuilder.tsx` and drives
  // this protocol via `useRequestRunner` rather than being mounted by the
  // registry directly. Future Task 4.x can register the React component.
  runRequest: async (request, ctx): Promise<ApiResponse> => {
    if (request.type !== 'http') {
      throw new Error(`GraphQL protocol expects an HTTP request shape, got ${request.type}`);
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
