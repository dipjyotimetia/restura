import type { LoadedRequest } from './collectionLoader.js';
import type { ExecuteOutcome } from './executors/types.js';
import ScriptExecutor from '@/features/scripts/lib/scriptExecutor';
import type { ScriptResult } from '@/features/scripts/lib/scriptExecutor';
import type { HttpRequest } from '@/types';

export interface RunScriptResult {
  /** All `pm.test(...)` outcomes; empty if the script defined no tests. */
  assertions: Array<{ name: string; passed: boolean; error?: string }>;
  /** Logs from `console.log/warn/error/info`. */
  logs: ScriptResult['logs'];
  /** Errors captured from the QuickJS evaluator (uncaught throws). */
  errors: string[];
  /** Final variable map after any `pm.environment.set` / `pm.variables.set` calls. */
  variables: Record<string, string>;
  /** `pm.execution` flow-control sentinel (setNextRequest), when the script set it. */
  execution?: ScriptResult['execution'];
}

/**
 * Run a pre-request script in QuickJS. The current `vars` are exposed via
 * `pm.environment.get` / `pm.variables.get` inside the script; any
 * `pm.environment.set(k, v)` calls are returned in `variables` and the runner
 * merges them back into the per-request var map.
 */
export async function runPreRequestScript(
  script: string,
  item: LoadedRequest,
  vars: Record<string, string>
): Promise<RunScriptResult> {
  const executor = new ScriptExecutor({ envVars: { ...vars } });
  const ctx = buildRequestContext(item, vars);
  const result = await executor.executeScript(script, { request: ctx });
  return toRunScriptResult(result, vars);
}

/**
 * Run a post-response (test) script in QuickJS. Both `request` and `response`
 * are bound on `pm.request` / `pm.response`. `pm.test(...)` outcomes are
 * captured in `assertions` — the runner uses these to drive the request's
 * pass/fail when the script defined any tests.
 */
export async function runTestScript(
  script: string,
  item: LoadedRequest,
  outcome: ExecuteOutcome,
  vars: Record<string, string>
): Promise<RunScriptResult> {
  const executor = new ScriptExecutor({ envVars: { ...vars } });
  const requestCtx = buildRequestContext(item, vars);
  const responseCtx = {
    status: outcome.status,
    statusText: '',
    headers: outcome.responseHeaders ?? {},
    body: tryParseJson(outcome.responseBody ?? ''),
    time: outcome.durationMs,
    size: outcome.bodyBytes,
  };
  const result = await executor.executeScript(script, {
    request: requestCtx,
    response: responseCtx,
  });
  return toRunScriptResult(result, vars);
}

function buildRequestContext(
  item: LoadedRequest,
  vars: Record<string, string>
): NonNullable<Parameters<InstanceType<typeof ScriptExecutor>['executeScript']>[1]['request']> {
  if (item.type === 'http') {
    const req = item.request as HttpRequest;
    const headers: Record<string, string> = {};
    for (const h of req.headers) {
      if (h.enabled && h.key) headers[h.key] = resolveVars(h.value, vars);
    }
    return {
      url: resolveVars(req.url, vars),
      method: req.method,
      headers,
      body: req.body.raw,
    };
  }
  // Non-HTTP protocols still expose URL + method so scripts can introspect.
  const anyReq = item.request as { url?: string };
  return {
    url: anyReq.url ?? '',
    method: item.type.toUpperCase(),
    headers: {},
  };
}

function resolveVars(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*([A-Za-z0-9_$.]+)\s*\}\}/g, (_match, key: string) => {
    return vars[key] ?? `{{${key}}}`;
  });
}

function toRunScriptResult(
  result: ScriptResult,
  originalVars: Record<string, string>
): RunScriptResult {
  // The executor returns only the variables it touched; layer them over the
  // originals so callers get the full, merge-ready map (script changes win).
  return {
    assertions: result.tests ?? [],
    logs: result.logs,
    errors: result.errors,
    variables: { ...originalVars, ...result.variables },
    ...(result.execution ? { execution: result.execution } : {}),
  };
}

function tryParseJson(text: string): unknown {
  if (!text) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
