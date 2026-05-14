import { v4 as uuidv4 } from 'uuid';
import type { ProtocolModule } from '@/features/registry/types';
import type { HttpRequest, Response as ApiResponse } from '@/types';
import { executeRequest } from './lib/requestExecutor';
import { useSettingsStore } from '@/store/useSettingsStore';

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

export const httpProtocol: ProtocolModule = {
  id: 'http',
  label: 'HTTP',
  tabType: 'http',
  defaultRequest: createDefaultHttpRequest,
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
    const result = await executeRequest({
      request,
      envVars: { ...variables },
      globalSettings,
      resolveVariables: (text) => defaultResolveVariables(text, variables),
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
