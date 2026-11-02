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
import { runScriptPhase } from '@shared/scripts/script-phase';
import { v4 as uuidv4 } from 'uuid';
import { resolveAuthVariables } from '@/features/auth/lib/resolveAuthVariables';
import {
  postmanSendBlockedReason,
  resolveInheritedAuthFor,
} from '@/features/auth/lib/resolveInheritedAuthFor';
import type { RunContext } from '@/features/registry/types';
import type { PmRunContextOptions } from '@/features/scripts/lib/pmRunContextOptions';
import {
  readPmRunContextOptions,
  skippedPlaceholderResponse,
} from '@/features/scripts/lib/pmRunContextOptions';
import type { ScriptResult } from '@/features/scripts/lib/scriptExecutor';
import { makeRendererScriptHost } from '@/features/scripts/lib/scriptPhaseHost.renderer';
import { injectString } from '@/features/workflows/lib/variableHelpers';
import { isElectron } from '@/lib/shared/platform';
import type { Response as ApiResponse, McpRequest, Request } from '@/types';
import { buildMcpConnectAuth, type McpConnectAuth } from './mcpAuth';
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

/**
 * `protocolOptions` key overriding the rate-limit retry backoff (ms before
 * each retry; the array length is the retry count). Tests pass tiny delays.
 */
export const MCP_RATE_LIMIT_RETRY_DELAYS_OPTION = 'mcpRateLimitRetryDelaysMs';

/** Default backoff before each retry of a rate-limited call (2 retries = 3 tries). */
export const MCP_RATE_LIMIT_RETRY_DELAYS_MS: readonly number[] = [1000, 2000];

/** Refusal for stdio requests — the runner never launches local processes. */
export const MCP_RUNNER_STDIO_MESSAGE =
  "stdio MCP servers aren't supported in the collection runner yet — run it from the request tab.";

/**
 * True for the desktop IPC rate limiter's rejection (`Rate limit exceeded`,
 * thrown by `rateLimited` or returned by the handler). It is transient: the
 * pooled session is still healthy, so it must not be evicted.
 */
export function isMcpRateLimitError(message: string | undefined): boolean {
  return typeof message === 'string' && /rate limit exceeded/i.test(message);
}

function retryDelays(value: unknown): readonly number[] {
  if (Array.isArray(value) && value.every((v) => typeof v === 'number' && v >= 0)) {
    return (value as number[]).slice(0, 5);
  }
  return MCP_RATE_LIMIT_RETRY_DELAYS_MS;
}

/** Wait `ms`, rejecting with an AbortError as soon as `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException('Request aborted', 'AbortError'));
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Request aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

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

/**
 * Resolve `{{var}}` in the request's (already inheritance-resolved) auth.
 * Handle / external SecretRefs stay opaque for Electron main (ADR-0007).
 */
export function resolveMcpRunAuth(
  request: McpRequest,
  variables: Record<string, string>
): McpRequest {
  if (!request.auth || request.auth.type === 'none') return request;
  return {
    ...request,
    auth: resolveAuthVariables(request.auth, (text) => injectString(text, variables)),
  };
}

function enabledHeaders(request: McpRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of request.headers ?? []) {
    if (h.enabled !== false && h.key) out[h.key] = h.value;
  }
  return out;
}

/**
 * Connect-time credentials for a single-call MCP run (collection runner,
 * workflows) — the same `buildMcpConnectAuth` policy as the interactive
 * builder, so there is ONE auth path. `mcp` must already have its `{{vars}}`
 * resolved (headers via `injectMcpVariables`, auth via `resolveMcpRunAuth`),
 * hence the identity resolver. Web gets the credential as a header (handles
 * fail closed); desktop gets a `mainSideAuth` descriptor that Electron main
 * resolves, handles included.
 */
export function buildMcpRunConnectAuth(mcp: McpRequest): McpConnectAuth {
  // Postman send guard (#1232): refuse, never connect with `none` instead.
  const blocked = postmanSendBlockedReason({ id: mcp.id, auth: mcp.auth ?? { type: 'none' } });
  if (blocked) return { ok: false, error: blocked };
  return buildMcpConnectAuth({
    auth: mcp.auth,
    inherited: resolveInheritedAuthFor({ id: mcp.id, auth: mcp.auth ?? { type: 'none' } }),
    headers: enabledHeaders(mcp),
    resolve: (text) => text,
    desktop: isElectron(),
  });
}

type ScriptInfo = NonNullable<PmRunContextOptions['info']> & {
  requestName: string;
  requestId: string;
};

/** `rs.request` view: the JSON-RPC method and its params text. */
function scriptRequestContext(request: McpRequest) {
  return {
    url: request.url,
    method: request.defaultMethod ?? '',
    headers: enabledHeaders(request),
    body: request.defaultParams ?? '',
  };
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
  // The runner never launches local processes (same rule as `restura run`).
  if ((rawRequest as McpRequest).transport === 'stdio') throw new Error(MCP_RUNNER_STDIO_MESSAGE);

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
    const pre = await runScriptPhase({
      phase: 'prerequest',
      script: rawRequest.preRequestScript,
      request: scriptRequestContext(injectMcpVariables(rawRequest, scriptEnvVars) as McpRequest),
      envVars: scriptEnvVars,
      collectionVars: opts.collectionVars,
      iterationData: opts.iterationData,
      info: scriptInfo,
      location: opts.location,
      // The same script host as gRPC: sub-requests, cookie jar and vault.
      host: makeRendererScriptHost({
        variables: scriptEnvVars,
        inheritedHeaders: {},
        signal: ctx.signal,
      }),
      absorb: { into: scriptEnvVars, variables: 'always' },
    });
    preRequestResult = pre.result;
    // `pm.execution.skipRequest()` in a Collection run: nothing is sent and no
    // test script runs.
    if (opts.honorSkipRequest && pre.skipRequested) {
      report();
      return skippedPlaceholderResponse(rawRequest.id);
    }
  }

  // Resolve with the post-pre-request variables so a script can set the
  // tool name / arguments / token for this call.
  const injected = injectMcpVariables(rawRequest, scriptEnvVars) as McpRequest;
  const request = resolveMcpRunAuth(injected, scriptEnvVars);
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

  // Validate the credential up front (fails closed with the shared message,
  // e.g. a keychain handle on web) and key the pooled session by it.
  const connectAuth = buildMcpRunConnectAuth(request);
  if (!connectAuth.ok) {
    report();
    throw new Error(connectAuth.error);
  }

  const started = Date.now();
  // A pooled client is shared, so runJsonRpc does not tear it down on abort;
  // race the call so Stop still ends this item promptly.
  const clientPool = isPool(pool) ? pool : undefined;
  // Session identity = resolved url + transport + effective headers (the web
  // credential included) + the desktop main-side auth descriptor, so differing
  // credentials never share one session.
  const cacheKey = clientPool
    ? mcpSessionKey(request.url, request.transport, connectAuth.headers) +
      (connectAuth.mainSideAuth ? `|${JSON.stringify(connectAuth.mainSideAuth)}` : '')
    : undefined;
  const delays = retryDelays(ctx.protocolOptions?.[MCP_RATE_LIMIT_RETRY_DELAYS_OPTION]);
  let call: Awaited<ReturnType<McpRunJsonRpc>>;
  for (let attempt = 0; ; attempt++) {
    const work = runJsonRpc(request, ctx, {
      method,
      ...(params.params !== undefined ? { params: params.params } : {}),
      ...(clientPool && cacheKey ? { clientPool, cacheKey } : {}),
    });
    // Captured before awaiting so eviction never removes a replacement entry.
    const pending = clientPool && cacheKey ? clientPool.get(cacheKey) : undefined;
    const evict = () => {
      if (!clientPool || !cacheKey || !pending || clientPool.get(cacheKey) !== pending) return;
      clientPool.delete(cacheKey);
      void pending.then((client) => client.disconnect()).catch(() => undefined);
    };
    try {
      call = await raceAbort(work, ctx.signal);
    } catch (error) {
      evict();
      throw error;
    }
    if (call.ok || call.jsonRpcError) break;
    if (isMcpRateLimitError(call.error)) {
      // Transient: the session is healthy. Evicting would force a reconnect
      // that burns more of the same budget — back off and retry instead.
      const delay = delays[attempt];
      if (delay === undefined) {
        report();
        throw new Error(
          `MCP rate limit exceeded — gave up after ${attempt + 1} attempts. Slow the run down (add a delay between requests) and try again.`
        );
      }
      await sleep(delay, ctx.signal);
      continue;
    }
    evict();
    report();
    throw new Error(call.error ?? 'MCP request failed');
  }
  const time = Date.now() - started;
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
    const test = await runScriptPhase({
      phase: 'test',
      script: request.testScript,
      request: scriptRequestContext(request),
      response: {
        status: response.status,
        statusText: response.statusText,
        headers: {},
        body: response.body,
        time: response.time,
        size: response.size,
      },
      envVars: scriptEnvVars,
      collectionVars: opts.collectionVars,
      iterationData: opts.iterationData,
      info: scriptInfo,
      location: opts.location,
      // rs.judge is wired on the test phase only: a response exists to judge.
      host: makeRendererScriptHost({
        variables: scriptEnvVars,
        inheritedHeaders: {},
        signal: ctx.signal,
        judge: true,
      }),
    });
    testResult = test.result;
  }

  report();
  return response;
}
