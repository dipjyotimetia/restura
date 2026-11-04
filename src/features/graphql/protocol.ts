/**
 * GraphQL protocol module.
 *
 * GraphQL is HTTP under the hood — a POST with a JSON body of shape
 * `{ query, variables, operationName? }`, or (queries only) a GET with those
 * fields URL-encoded; `lib/graphqlHttp.ts` shapes both. The protocol module here
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
import { injectGraphQLBody } from '@shared/graphql/inject';
import { v4 as uuidv4 } from 'uuid';
import { GRAPHQL_SENT_BODY_OPTION } from '@/features/graphql/lib/graphqlErrors';
import {
  buildGraphQLWireRequest,
  createIncrementalProgress,
  graphqlEnvelopeFromBody,
  normalizeGraphQLResponse,
} from '@/features/graphql/lib/graphqlHttp';
import { executeRequest } from '@/features/http/lib/requestExecutor';
import { reportTransportError } from '@/features/http/lib/transportOutcome';
import type { ProtocolModule } from '@/features/registry/types';
import { readPmRunContextOptions } from '@/features/scripts/lib/pmRunContextOptions';
import { injectString } from '@/features/workflows/lib/variableHelpers';
import { escapeRegExp } from '@/lib/shared/escapeRegExp';
import { withoutSecretNames } from '@/lib/shared/resolveRequestScope';
import { useSettingsStore } from '@/store/useSettingsStore';
import type { Response as ApiResponse, HttpRequest, Request } from '@/types';

function createDefaultGraphQLRequest(): HttpRequest {
  return {
    id: uuidv4(),
    name: 'New GraphQL Request',
    type: 'http',
    method: 'POST',
    url: '',
    headers: [],
    params: [],
    // Persist the protocol marker so saved GraphQL requests can be safely
    // selected by workflows without guessing from arbitrary JSON HTTP bodies.
    body: { type: 'graphql', raw: '' },
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
 * `{query, variables, operationName}` payload (or a saved query document) and
 * `body.graphqlVariables` the saved variables JSON. Substitution is JSON-safe
 * (shared `injectGraphQLBody`, same as the CLI): `{{var}}` resolves inside
 * string values, so a value holding `"` or `\` can't break the JSON. Text that
 * isn't JSON yet (the user is still typing) gets plain string substitution.
 */
function injectGraphQLVariables(
  request: Request,
  variables: Record<string, string>,
  secretNames?: readonly string[]
): Request {
  if (request.type !== 'http') return request;
  const http = request as HttpRequest;
  const inject = (text: string) => injectString(text, variables, secretNames);
  const body = injectGraphQLBody(http.body, inject);

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

/**
 * Saved GraphQL requests retain the query document as `body.raw` and a
 * `graphql` body marker; shape them for the wire (method, Accept, envelope or
 * GET params). Interactive Send arrives already shaped and passes through.
 */
function toExecutable(http: HttpRequest): HttpRequest {
  if (http.body.type !== 'graphql') return http;
  const wire = buildGraphQLWireRequest(http, graphqlEnvelopeFromBody(http.body));
  if (!wire.ok) throw new Error(wire.error);
  return wire.request;
}

export const graphqlProtocol: ProtocolModule = {
  id: 'graphql',
  label: 'GraphQL',
  tabType: 'graphql',
  defaultRequest: createDefaultGraphQLRequest,
  injectVariables: injectGraphQLVariables,
  runRequest: async (request, ctx): Promise<ApiResponse> => {
    if (request.type !== 'http') {
      throw new Error(`GraphQL protocol expects an HTTP request shape, got ${request.type}`);
    }
    if (ctx.signal.aborted) {
      throw new DOMException('Request aborted', 'AbortError');
    }
    const globalSettings = useSettingsStore.getState().settings;
    const variables = ctx.variables ?? {};
    const executable = toExecutable(request as HttpRequest);
    // Collection-run context (`pm.collectionVariables`, `pm.iterationData`,
    // `pm.info`, `pm.execution.location`, `skipRequest`), as the HTTP module does.
    const opts = readPmRunContextOptions(ctx.protocolOptions);
    const onMessage = ctx.stream?.onMessage;
    const progress = onMessage ? createIncrementalProgress(onMessage) : undefined;
    let result: Awaited<ReturnType<typeof executeRequest>>;
    try {
      result = await executeRequest({
        request: executable,
        envVars: { ...variables },
        globalSettings,
        signal: ctx.signal,
        // The second pass reads no secret: it could not tell a written token from
        // one a value brought in.
        resolveVariables: (text) =>
          defaultResolveVariables(text, withoutSecretNames(variables, ctx.secretNames ?? [])),
        ...(ctx.secretVariables ? { secretVariables: ctx.secretVariables } : {}),
        ...(ctx.secretNames ? { secretNames: ctx.secretNames } : {}),
        ...(opts.collectionVars ? { collectionVars: opts.collectionVars } : {}),
        ...(opts.iterationData ? { iterationData: opts.iterationData } : {}),
        ...(opts.info ? { info: opts.info } : {}),
        ...(opts.location ? { location: opts.location } : {}),
        ...(opts.honorSkipRequest ? { honorSkipRequest: true } : {}),
        // `multipart/mixed` incremental (@defer / @stream) responses are folded
        // into one result before test scripts and history see them; a live
        // caller additionally gets (coalesced) merged snapshots as parts arrive.
        transformResponse: normalizeGraphQLResponse,
        ...(progress ? { onResponseProgress: progress } : {}),
      });
    } finally {
      // A trailing snapshot must never land after the final response.
      progress?.dispose();
    }
    if (ctx.onScriptResult && result.scriptResult) {
      ctx.onScriptResult(result.scriptResult);
    }
    reportTransportError(result, ctx);
    // The Builder maps error locations against the substituted query text.
    // A GraphQL GET carries the query in the URL, not the body: report it in
    // the same `{ query }` envelope shape so location mapping works for both.
    const onSentBody = ctx.protocolOptions?.[GRAPHQL_SENT_BODY_OPTION];
    const sentGetQuery = executable.method === 'GET' ? result.sentParams?.query : undefined;
    const sentBody =
      result.sentBody ??
      (sentGetQuery !== undefined ? JSON.stringify({ query: sentGetQuery }) : undefined);
    if (typeof onSentBody === 'function' && sentBody !== undefined) {
      (onSentBody as (body: string) => void)(sentBody);
    }
    if (ctx.onAuthRefreshed && result.refreshedAuth) {
      ctx.onAuthRefreshed(result.refreshedAuth);
    }
    return result.response;
  },
};
