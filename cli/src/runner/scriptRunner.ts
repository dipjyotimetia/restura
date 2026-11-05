import { randomUUID } from 'node:crypto';
import { STATUS_CODES } from 'node:http';
import {
  applyScriptMetadata,
  findScriptWrittenToken,
  grpcMetadataForScript,
} from '@shared/scripts/grpc-script-metadata';
import type { ScriptResult } from '@shared/scripts/script-executor';
import { applyScriptHeaderEdits } from '@shared/scripts/script-executor-request';
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
  /**
   * The variable map for the rest of THIS request, folded exactly as the app
   * folds it (`runScriptPhase` absorb): the script's writes, its unsets
   * removed, and its `pm.collectionVariables` writes applied, so the request a
   * pre-request script precedes is sent with them.
   */
  variables: Record<string, string>;
  /**
   * The executor's map as the script left it (an `unset` key is absent). Fold
   * this into the run scope, so later requests see the unset.
   */
  scriptVariables: Record<string, string>;
  /** `pm.execution` flow-control sentinel (setNextRequest), when the script set it. */
  execution?: ScriptResult['execution'];
  /** `pm.collectionVariables.set/unset` mutations, when the script touched them. */
  collectionMutations?: Record<string, string | null>;
  /** gRPC: the pre-request script's edited `rs.request.metadata`, when it changed it. */
  requestMetadata?: Record<string, string>;
  /** HTTP: the pre-request script's edited `rs.request.headers`, when it changed them. */
  requestHeaders?: Record<string, string>;
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
 * cookie jar, keychain or sub-request path, so `pm.sendRequest` and `pm.vault`
 * reject with a clear error and `pm.cookies` reads empty; and no globals scope.
 * `absorb` folds the script's writes into `into` the way every app host does.
 */
function phaseScopes(
  item: LoadedRequest,
  vars: Record<string, string>,
  runCtx: ScriptRunContext,
  into: Record<string, string>
) {
  return {
    envVars: { ...vars },
    absorb: { into, variables: 'always' as const },
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
  const into = { ...vars };
  const phase = await runScriptPhase({
    phase: 'prerequest',
    script,
    request: buildRequestContext(item, vars, 'prerequest'),
    ...phaseScopes(item, vars, runCtx, into),
  });
  return toRunScriptResult(phase.result, vars, into);
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
  // Same shape the app gives a test script: the raw body text (rs.response.json()
  // and the jsonBody/json assertions parse it) and a status text. The outcome
  // carries no reason phrase, so the standard one stands in (gRPC: none yet).
  const responseCtx = {
    status: outcome.status,
    statusText: item.type === 'grpc' ? '' : (STATUS_CODES[outcome.status] ?? ''),
    headers: outcome.responseHeaders ?? {},
    ...(outcome.responseTrailers ? { trailers: outcome.responseTrailers } : {}),
    ...(outcome.setCookies ? { setCookies: outcome.setCookies } : {}),
    body: outcome.responseBody ?? '',
    time: outcome.durationMs,
    size: outcome.bodyBytes,
  };
  const into = { ...vars };
  const phase = await runScriptPhase({
    phase: 'test',
    script,
    request: buildRequestContext(item, vars, 'test'),
    response: responseCtx,
    ...phaseScopes(item, vars, runCtx, into),
  });
  return toRunScriptResult(phase.result, vars, into);
}

/**
 * The header map an HTTP pre-request script sees: the saved rows' templates,
 * unresolved, as in the app (`requestExecutor` hands `rs.request.headers` the
 * row values). Edits are folded back against this same map, so an untouched
 * `{{var}}` row stays a template and one script yields the same wire headers
 * on both hosts.
 */
function httpPreRequestHeaders(req: HttpRequest): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const h of req.headers) {
    if (h.enabled && h.key) headers[h.key] = h.value;
  }
  return headers;
}

function buildRequestContext(
  item: LoadedRequest,
  vars: Record<string, string>,
  phase: 'prerequest' | 'test'
): ScriptContext['request'] {
  if (item.type === 'http') {
    const req = item.request as HttpRequest;
    let headers = httpPreRequestHeaders(req);
    if (phase === 'test') {
      headers = Object.fromEntries(
        Object.entries(headers).map(([k, v]) => [k, resolveVars(v, vars)])
      );
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
  originalVars: Record<string, string>,
  absorbed: Record<string, string>
): RunScriptResult {
  // The executor returns the full map as the script left it (an `unset` key is
  // absent): the run scope folds that in so the unset reaches later requests.
  // This request uses `absorbed`, the map `runScriptPhase` folded for it.
  const scriptVariables = result.variables ? { ...result.variables } : { ...originalVars };
  return {
    assertions: result.tests ?? [],
    logs: result.logs,
    errors: result.errors,
    variables: absorbed,
    scriptVariables,
    ...(result.execution ? { execution: result.execution } : {}),
    ...(result.collectionMutations ? { collectionMutations: result.collectionMutations } : {}),
    ...(result.requestMetadata ? { requestMetadata: result.requestMetadata } : {}),
    ...(result.requestHeaders ? { requestHeaders: result.requestHeaders } : {}),
  };
}

/**
 * Fold a pre-request script's request edits into the item that is about to be
 * sent: gRPC `rs.request.metadata` (#910) and HTTP `rs.request.headers`.
 * Identity for other protocols / no edits. `vars` must be the map the script
 * saw (the pre-script variables).
 *
 * As in the app, a script cannot put a secret-variable token into a header or
 * metadata entry that was not already saved there (a script string can be a
 * server value): the item comes back `blocked`, so the executor preflight
 * refuses it before any I/O.
 */
export function applyPreRequestMetadata(
  item: LoadedRequest,
  pre: Pick<RunScriptResult, 'requestMetadata' | 'requestHeaders'> | undefined,
  vars: Record<string, string>
): LoadedRequest {
  const isSecret = (name: string) => item.secretVariableNames?.includes(name) === true;
  if (item.type === 'http' && pre?.requestHeaders) {
    const req = item.request as HttpRequest;
    const written = findScriptWrittenToken(req.headers, pre.requestHeaders, isSecret);
    if (written) return { ...item, blocked: scriptSecretRefusal('rs.request.headers', written) };
    const before = httpPreRequestHeaders(req);
    const headers = applyScriptHeaderEdits(req.headers, before, pre.requestHeaders, randomUUID);
    return { ...item, request: { ...req, headers } };
  }
  if (item.type !== 'grpc' || !pre?.requestMetadata) return item;
  const req = item.request as GrpcRequest;
  const written = findScriptWrittenToken(req.metadata ?? [], pre.requestMetadata, isSecret);
  if (written) return { ...item, blocked: scriptSecretRefusal('rs.request.metadata', written) };
  const metadata = applyScriptMetadata(req.metadata ?? [], pre.requestMetadata, (v) =>
    resolveVars(v, vars)
  );
  return { ...item, request: { ...req, metadata } };
}

function scriptSecretRefusal(field: string, written: { key: string; name: string }): string {
  return (
    `not sent: the pre-request script put secret variable "${written.name}" into ` +
    `${field} "${written.key}"; a script cannot add a secret variable to a request field.`
  );
}
