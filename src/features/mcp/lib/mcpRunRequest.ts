/**
 * `mcpProtocol.runRequest` (#901): run a saved MCP request — ONE JSON-RPC
 * operation (`defaultMethod` + `defaultParams`) — through the registry runner
 * so collection runs (desktop + web) can execute it with pre-request / test
 * scripts, exactly like HTTP and gRPC.
 *
 * The call itself goes through `runJsonRpc` (injected to avoid an import cycle
 * with `protocol.ts`), which owns the McpClient connect + initialize handshake.
 * A collection run passes a client pool in `ctx.protocolOptions.mcpClientPool`
 * so every request to the same server reuses ONE initialized session; the
 * runner disconnects pooled clients when the run ends.
 *
 * Response contract (shared with `restura run` via `@shared/protocol/mcp-run`):
 * the body is the JSON-RPC envelope `{ jsonrpc, result }` or
 * `{ jsonrpc, error }`, `mcpOutcome` classifies it, and transport failures
 * throw.
 */
import {
  buildMcpRunReply,
  mcpMissingMethodMessage,
  mcpSessionKey,
  parseMcpRunParams,
} from '@shared/protocol/mcp-run';
import { v4 as uuidv4 } from 'uuid';
import type { RunContext } from '@/features/registry/types';
import type { PmRunContextOptions } from '@/features/scripts/lib/pmRunContextOptions';
import { readPmRunContextOptions } from '@/features/scripts/lib/pmRunContextOptions';
import type { ScriptResult } from '@/features/scripts/lib/scriptExecutor';
import ScriptExecutor from '@/features/scripts/lib/scriptExecutor';
import { injectString } from '@/features/workflows/lib/variableHelpers';
import { applyVarMutations } from '@/lib/shared/collectionVarMutations';
import { useGlobalsStore } from '@/store/useGlobalsStore';
import type { Response as ApiResponse, McpRequest, Request } from '@/types';
import type { McpClient } from './mcpClient';

/** Pool shape accepted by `runJsonRpc` (a `Map<string, Promise<McpClient>>` fits). */
export interface McpRunClientPool {
  get(key: string): Promise<McpClient> | undefined;
  set(key: string, client: Promise<McpClient>): void;
  delete(key: string): void;
}

export type McpRunJsonRpc = (
  request: Request,
  ctx: { signal: AbortSignal },
  opts: { method: string; params?: unknown; clientPool?: McpRunClientPool; cacheKey?: string }
) => Promise<{
  ok: boolean;
  result?: unknown;
  error?: string;
  jsonRpcError?: { code: number; message: string; data?: unknown };
}>;

/** `protocolOptions` key the collection runner uses to hand over its pool. */
export const MCP_CLIENT_POOL_OPTION = 'mcpClientPool';

function isPool(value: unknown): value is McpRunClientPool {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as McpRunClientPool).get === 'function' &&
    typeof (value as McpRunClientPool).set === 'function' &&
    typeof (value as McpRunClientPool).delete === 'function'
  );
}

/** Disconnect every pooled client (run end). Never throws. */
/** How long run-end teardown waits on a stuck connect / disconnect. */
export const MCP_POOL_DISPOSE_TIMEOUT_MS = 5000;

/** Resolve after `ms` without keeping anything alive past the race. */
function timeout(ms: number): { promise: Promise<void>; clear: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return { promise, clear: () => clearTimeout(timer) };
}

/**
 * Disconnect every pooled client (run end). Never throws, and never hangs the
 * run on a connect / disconnect that does not settle (bounded by `timeoutMs`).
 */
export async function disposeMcpClientPool(
  pool: Map<string, Promise<McpClient>>,
  timeoutMs = MCP_POOL_DISPOSE_TIMEOUT_MS
): Promise<void> {
  const entries = [...pool.values()];
  pool.clear();
  const done = Promise.allSettled(
    entries.map(async (pending) => {
      const client = await pending;
      await client.disconnect();
    })
  );
  const limit = timeout(timeoutMs);
  await Promise.race([done, limit.promise]);
  limit.clear();
}

/** Reject with an AbortError as soon as `signal` aborts (pooled calls ignore it). */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException('Request aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Request aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      }
    );
  });
}

/** Substitute `{{var}}` in every stringy MCP field. Pure. */
export function injectMcpVariables(request: Request, variables: Record<string, string>): Request {
  if (request.type !== 'mcp') return request;
  const mcp = request as McpRequest;
  const inject = (text: string) => injectString(text, variables);
  return {
    ...mcp,
    url: inject(mcp.url),
    headers: mcp.headers.map((h) => ({ ...h, key: inject(h.key), value: inject(h.value) })),
    ...(mcp.defaultMethod !== undefined ? { defaultMethod: inject(mcp.defaultMethod) } : {}),
    ...(mcp.defaultParams !== undefined ? { defaultParams: inject(mcp.defaultParams) } : {}),
  };
}

function enabledHeaders(request: McpRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of request.headers ?? []) {
    if (h.enabled !== false && h.key) out[h.key] = h.value;
  }
  return out;
}

type ScriptInfo = NonNullable<PmRunContextOptions['info']> & {
  requestName: string;
  requestId: string;
};

function makeExecutor(
  envVars: Record<string, string>,
  opts: PmRunContextOptions,
  info: ScriptInfo & { eventName: 'prerequest' | 'test' }
): ScriptExecutor {
  return new ScriptExecutor({
    envVars,
    globalVars: useGlobalsStore.getState().vars,
    collectionVars: { ...(opts.collectionVars ?? {}) },
    iterationData: { ...(opts.iterationData ?? {}) },
    info,
    ...(opts.location ? { location: opts.location } : {}),
  });
}

/** `rs.request` view: the JSON-RPC method and its params text. */
function scriptRequestContext(request: McpRequest) {
  return {
    url: request.url,
    method: request.defaultMethod ?? '',
    headers: enabledHeaders(request),
    body: request.defaultParams ?? '',
  };
}

function absorbScriptMutations(result: ScriptResult, vars: Record<string, string>): void {
  if (result.variables) Object.assign(vars, result.variables);
  if (result.collectionMutations) applyVarMutations(vars, result.collectionMutations);
  if (result.globalsMutations) useGlobalsStore.getState().applyMutations(result.globalsMutations);
}

export async function runMcpRequest(
  rawRequest: Request,
  ctx: RunContext,
  runJsonRpc: McpRunJsonRpc
): Promise<ApiResponse> {
  if (rawRequest.type !== 'mcp') {
    throw new Error(`MCP protocol cannot run ${rawRequest.type} request`);
  }
  if (ctx.signal.aborted) throw new DOMException('Request aborted', 'AbortError');

  const opts = readPmRunContextOptions(ctx.protocolOptions);
  const pool = ctx.protocolOptions?.[MCP_CLIENT_POOL_OPTION];
  const scriptEnvVars: Record<string, string> = { ...(ctx.variables ?? {}) };
  const scriptInfo: ScriptInfo = {
    requestName: rawRequest.name,
    requestId: rawRequest.id,
    ...opts.info,
  };

  let preRequestResult: ScriptResult | undefined;
  let testResult: ScriptResult | undefined;
  const report = () => {
    if (!ctx.onScriptResult || (!preRequestResult && !testResult)) return;
    ctx.onScriptResult({
      ...(preRequestResult ? { preRequest: preRequestResult } : {}),
      ...(testResult ? { test: testResult } : {}),
    });
  };

  if (rawRequest.preRequestScript?.trim()) {
    preRequestResult = await makeExecutor(scriptEnvVars, opts, {
      ...scriptInfo,
      eventName: 'prerequest',
    }).executeScript(rawRequest.preRequestScript, {
      request: scriptRequestContext(injectMcpVariables(rawRequest, scriptEnvVars) as McpRequest),
    });
    absorbScriptMutations(preRequestResult, scriptEnvVars);
  }

  // Resolve with the post-pre-request variables so a script can set the
  // tool name / arguments / token for this call.
  const request = injectMcpVariables(rawRequest, scriptEnvVars) as McpRequest;
  const method = request.defaultMethod?.trim() ?? '';
  if (!method) {
    report();
    throw new Error(mcpMissingMethodMessage(request.name));
  }
  const params = parseMcpRunParams(request.defaultParams);
  if (!params.ok) {
    report();
    throw new Error(params.error);
  }

  const started = Date.now();
  // A pooled client is shared, so runJsonRpc does not tear it down on abort;
  // race the call so Stop still ends this item promptly.
  const call = await raceAbort(
    runJsonRpc(request, ctx, {
      method,
      ...(params.params !== undefined ? { params: params.params } : {}),
      ...(isPool(pool)
        ? {
            clientPool: pool,
            // Session identity = resolved url + transport + headers. If MCP
            // `auth` is ever applied here it MUST become part of this key, or
            // items with different credentials would share one session.
            cacheKey: mcpSessionKey(request.url, request.transport, enabledHeaders(request)),
          }
        : {}),
    }),
    ctx.signal
  );
  const time = Date.now() - started;

  if (!call.ok && !call.jsonRpcError) {
    report();
    throw new Error(call.error ?? 'MCP request failed');
  }
  const reply = buildMcpRunReply(
    call.ok
      ? { result: call.result }
      : { error: call.jsonRpcError as NonNullable<typeof call.jsonRpcError> }
  );
  const response: ApiResponse = {
    id: uuidv4(),
    requestId: request.id,
    status: 200,
    statusText: reply.statusText,
    headers: {},
    body: reply.body,
    size: new TextEncoder().encode(reply.body).length,
    time,
    timestamp: Date.now(),
    mcpOutcome: reply.outcome,
  };

  if (request.testScript?.trim()) {
    testResult = await makeExecutor(scriptEnvVars, opts, {
      ...scriptInfo,
      eventName: 'test',
    }).executeScript(request.testScript, {
      request: scriptRequestContext(request),
      response: {
        status: response.status,
        statusText: response.statusText,
        headers: {},
        body: response.body,
        time: response.time,
        size: response.size,
      },
    });
    if (testResult.globalsMutations) {
      useGlobalsStore.getState().applyMutations(testResult.globalsMutations);
    }
  }

  report();
  return response;
}
