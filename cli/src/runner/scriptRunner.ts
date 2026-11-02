import { applyScriptMetadata, grpcMetadataForScript } from '@shared/scripts/grpc-script-metadata';
import type { ScriptResult } from '@shared/scripts/script-executor';
import type { ScriptContext } from '@shared/scripts/script-executor-types';
import { NO_SCRIPT_HOST, runScriptPhase } from '@shared/scripts/script-phase';
import type { GrpcRequest, HttpRequest, McpRequest } from '@shared/types';
import { substituteVariables } from '@shared/variables/resolver';
import type { LoadedRequest } from './collectionLoader.js';
import type { ExecuteOutcome } from './executors/types.js';

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
  /** `pm.collectionVariables.set/unset` mutations, when the script touched them. */
  collectionMutations?: Record<string, string | null>;
  /** gRPC: the pre-request script's edited `rs.request.metadata`, when it changed it. */
  requestMetadata?: Record<string, string>;
}

/** Run-scoped context threaded into `pm.collectionVariables` / `pm.iterationData` / `pm.info`. */
export interface ScriptRunContext {
  /** Collection-scoped variables — mutable across the run (caller carries mutations forward). */
  collectionVars: Record<string, string>;
  /** Current iteration's data-row, backing `pm.iterationData`. */
  iterationData: Record<string, string>;
  /** 0-based iteration index and total iteration count for `pm.info`. */
  iteration: number;
  iterationCount: number;
}

function requestName(item: LoadedRequest): string {
  const named = item.request as { name?: string };
  return named.name ?? item.relativePath;
}

function requestId(item: LoadedRequest): string {
  const withId = item.request as { id?: string };
  return withId.id ?? item.relativePath;
}

/**
 * The scopes a CLI script phase runs with. The CLI has no script host: no
 * cookie jar, keychain or sub-request path, so `pm.sendRequest`, `pm.cookies`
 * and `pm.vault` reject with a clear error; and no globals scope.
 */
function phaseScopes(item: LoadedRequest, vars: Record<string, string>, runCtx: ScriptRunContext) {
  return {
    envVars: { ...vars },
    collectionVars: runCtx.collectionVars,
    iterationData: runCtx.iterationData,
    info: {
      requestName: requestName(item),
      requestId: requestId(item),
      iteration: runCtx.iteration,
      iterationCount: runCtx.iterationCount,
    },
    location: {
      currentRequestName: requestName(item),
      folderPath: item.folderPath,
      collectionName: '',
    },
    host: NO_SCRIPT_HOST,
  };
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
  vars: Record<string, string>,
  runCtx: ScriptRunContext
): Promise<RunScriptResult> {
  const phase = await runScriptPhase({
    phase: 'prerequest',
    script,
    request: buildRequestContext(item, vars),
    ...phaseScopes(item, vars, runCtx),
  });
  return toRunScriptResult(phase.result, vars);
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
  vars: Record<string, string>,
  runCtx: ScriptRunContext
): Promise<RunScriptResult> {
  const responseCtx = {
    status: outcome.status,
    statusText: '',
    headers: outcome.responseHeaders ?? {},
    ...(outcome.responseTrailers ? { trailers: outcome.responseTrailers } : {}),
    ...(outcome.setCookies ? { setCookies: outcome.setCookies } : {}),
    body: tryParseJson(outcome.responseBody ?? ''),
    time: outcome.durationMs,
    size: outcome.bodyBytes,
  };
  const phase = await runScriptPhase({
    phase: 'test',
    script,
    request: buildRequestContext(item, vars),
    response: responseCtx,
    ...phaseScopes(item, vars, runCtx),
  });
  return toRunScriptResult(phase.result, vars);
}

function buildRequestContext(
  item: LoadedRequest,
  vars: Record<string, string>
): ScriptContext['request'] {
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
  if (item.type === 'grpc') {
    const req = item.request as GrpcRequest;
    // `rs.request.metadata` (aliased as `headers`) — editable in pre-request
    // scripts; edits are folded back by `applyPreRequestMetadata` (#910).
    const metadata = grpcMetadataForScript(req.metadata ?? [], (v) => resolveVars(v, vars));
    return {
      url: resolveVars(req.url, vars),
      method: req.methodType ?? 'unary',
      headers: metadata,
      metadata,
      body: req.message,
    };
  }
  if (item.type === 'mcp') {
    // `rs.request.method` is the JSON-RPC method; `body` the params JSON.
    const req = item.request as McpRequest;
    const headers: Record<string, string> = {};
    for (const h of req.headers ?? []) {
      if (h.enabled && h.key) headers[h.key] = resolveVars(h.value, vars);
    }
    return {
      url: resolveVars(req.url, vars),
      method: resolveVars(req.defaultMethod ?? '', vars),
      headers,
      body: resolveVars(req.defaultParams ?? '', vars),
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
  return substituteVariables(text, [vars]);
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
    ...(result.collectionMutations ? { collectionMutations: result.collectionMutations } : {}),
    ...(result.requestMetadata ? { requestMetadata: result.requestMetadata } : {}),
  };
}

/**
 * Fold a gRPC pre-request script's `rs.request.metadata` edits into the item
 * that is about to be sent (#910). Identity for other protocols / no edits.
 * `vars` must be the map the script saw (the pre-script variables).
 */
export function applyPreRequestMetadata(
  item: LoadedRequest,
  pre: Pick<RunScriptResult, 'requestMetadata'> | undefined,
  vars: Record<string, string>
): LoadedRequest {
  if (item.type !== 'grpc' || !pre?.requestMetadata) return item;
  const req = item.request as GrpcRequest;
  const metadata = applyScriptMetadata(req.metadata ?? [], pre.requestMetadata, (v) =>
    resolveVars(v, vars)
  );
  return { ...item, request: { ...req, metadata } };
}

function tryParseJson(text: string): unknown {
  if (!text) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
