import { v4 as uuidv4 } from 'uuid';
import { executeRequest } from './lib/requestExecutor';
import type { ProtocolModule } from '@/features/registry/types';
import { readPmRunContextOptions } from '@/features/scripts/lib/pmRunContextOptions';
import { injectString } from '@/features/workflows/lib/variableHelpers';
import { escapeRegExp } from '@/lib/shared/escapeRegExp';
import { useSettingsStore } from '@/store/useSettingsStore';
import type { HttpRequest, Request, Response as ApiResponse } from '@/types';

function createDefaultHttpRequest(): HttpRequest {
  return {
    id: uuidv4(),
    name: 'New Request',
    type: 'http',
    method: 'GET',
    url: '',
    headers: [],
    params: [],
    body: { type: 'none' },
    auth: { type: 'none' },
  };
}

/**
 * Default {{var}} resolver used when no caller-supplied resolver is provided.
 *
 * The legacy `executeRequest` API takes both an explicit `envVars` map *and*
 * a `resolveVariables(text, vars?)` callback. The two are intentionally
 * redundant: callers like `useHttpRequest` plug in a global resolver that
 * understands collection variables, environment variables, and dynamic
 * `$randomUuid`-style helpers. The registry contract only knows about a
 * flat variables map (`ctx.variables`), so we substitute a minimal resolver
 * here that walks the same map. Task 4.4+ will route registry calls through
 * the existing hooks, at which point this fallback gets exercised mainly by
 * synthetic / programmatic callers (e.g. tests, future scriptable runners).
 */
function defaultResolveVariables(text: string, vars: Record<string, string>): string {
  let result = text;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`{{${escapeRegExp(key)}}}`, 'g'), () => value);
  }
  return result;
}

function injectHttpVariables(request: Request, variables: Record<string, string>): Request {
  if (request.type !== 'http') return request;
  const http = request as HttpRequest;
  const inject = (text: string) => injectString(text, variables);
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
    body: {
      ...http.body,
      ...(http.body.raw !== undefined ? { raw: inject(http.body.raw) } : {}),
    },
  };
}

export const httpProtocol: ProtocolModule = {
  id: 'http',
  label: 'HTTP',
  tabType: 'http',
  defaultRequest: createDefaultHttpRequest,
  injectVariables: injectHttpVariables,
  // Builder is intentionally undefined — Tasks 4.4/4.5 wire RequestBuilder.
  runRequest: async (request, ctx): Promise<ApiResponse> => {
    if (request.type !== 'http') {
      throw new Error(`HTTP protocol cannot run ${request.type} request`);
    }
    // executeRequest doesn't accept an AbortSignal directly today; honor
    // pre-aborted ctx.signal so callers can short-circuit obviously-stale
    // requests. Mid-flight cancellation will be wired in a later task.
    if (ctx.signal.aborted) {
      throw new DOMException('Request aborted', 'AbortError');
    }
    const globalSettings = useSettingsStore.getState().settings;
    const variables = ctx.variables ?? {};
    const opts = readPmRunContextOptions(ctx.protocolOptions);
    const result = await executeRequest({
      request,
      // executeRequest mutates this exact map with pre-request script writes
      // before it resolves the wire request. Do not pass a detached copy while
      // the resolver closes over `variables`.
      envVars: variables,
      globalSettings,
      resolveVariables: (text) => defaultResolveVariables(text, variables),
      ...(opts.collectionVars ? { collectionVars: opts.collectionVars } : {}),
      ...(opts.iterationData ? { iterationData: opts.iterationData } : {}),
      // requestName/requestId default from `request` one layer down in
      // executeRequest's own `baseInfo` — no need to repeat that here.
      ...(opts.info ? { info: opts.info } : {}),
      ...(opts.location ? { location: opts.location } : {}),
    });
    // Forward script results (pre-request + test) to the runner so the
    // Console panel sees logs/tests. `executeRequest` runs both scripts
    // inline today; this is the registry-side seam that exposes them.
    if (ctx.onScriptResult && result.scriptResult) {
      ctx.onScriptResult(result.scriptResult);
    }
    return result.response;
  },
};
