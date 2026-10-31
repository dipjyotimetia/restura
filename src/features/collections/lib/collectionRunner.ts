import {
  buildResponseEvidence,
  type ResponseEvidence,
  type ResponseRetentionMode,
} from '@shared/collection-run/evidence';
import {
  type IterationHost,
  pickNextRequest,
  resolveIterationRows,
  type StepOutcome,
  sequenceCollectionRun,
} from '@shared/collection-run/sequencer';
import { v4 as uuidv4 } from 'uuid';
import { withEffectiveAuth } from '@/features/auth/lib/authInheritance';
import { grpcRunOptionsFromRequest } from '@/features/grpc/lib/grpcSchemaSnapshot';
import type { McpClient } from '@/features/mcp/lib/mcpClient';
import { disposeMcpClientPool, MCP_CLIENT_POOL_OPTION } from '@/features/mcp/lib/mcpRunRequest';
import { protocolRegistry } from '@/features/registry/registry';
import type { ProtocolScriptResult } from '@/features/registry/types';
import { applyVarMutations } from '@/lib/shared/collectionVarMutations';
import { isElectron } from '@/lib/shared/platform';
import { buildValueMap } from '@/lib/shared/variableScopes';
import { useCollectionStore } from '@/store/useCollectionStore';
import type { Response as ApiResponse, Collection, GrpcRequest, Request } from '@/types';
import type { IterationRow } from './dataLoader';
import type { RunnableRequest } from './flattenRunnables';

/**
 * Postman-style collection / folder runner. Shares its sequencing with the CLI
 * (`cli/src/runner/runner.ts`) through `shared/collection-run/sequencer.ts` but
 * dispatches through the in-app protocol registry instead of the CLI's
 * executor, so HTTP/gRPC run through the exact same wire path (and SSRF/secret
 * resolution) as a normal send.
 *
 * Dispatch is imperative — `protocol.injectVariables` then `runRequest(ctx)` —
 * the same pattern the DAG executor uses. The React `useRequestRunner` hook is
 * deliberately NOT used: it writes history and pushes script results to the
 * active tab's Console, neither of which a batch run should do.
 *
 * Protocols whose `runRequest` throws (SSE/WebSocket/Socket.IO/Kafka) are
 * skipped with a reason rather than invoked. gRPC streams run to completion
 * (client / bidi on desktop only). MCP items run their saved operation over
 * one pooled session per server, closed when the run ends (#901).
 */

export interface RunnerAssertion {
  name: string;
  passed: boolean;
  error?: string;
}

export interface CollectionRequestResult {
  itemId: string;
  itemName: string;
  protocol: string;
  /** 0-based iteration index (data row or repeat). */
  iteration: number;
  status: 'success' | 'failed' | 'skipped';
  /** HTTP status or gRPC code, when the request ran. */
  httpStatus?: number;
  durationMs?: number;
  sizeBytes?: number;
  assertions: RunnerAssertion[];
  error?: string;
  skippedReason?: string;
  /** Sanitized bounded response evidence, never a raw response body. */
  evidence?: ResponseEvidence;
}

/** Safe replay/configuration summary. Resolved variables and data rows are intentionally excluded. */
export interface CollectionRunConfiguration {
  runnableIds: string[];
  environmentId?: string;
  environmentName?: string;
  iterations: number;
  delayMs: number;
  stopOnFailure: boolean;
  usedDataFile: boolean;
  retention: ResponseRetentionMode;
}

export interface CollectionRunResult {
  id: string;
  collectionId: string;
  collectionName: string;
  /** Collection or folder name — what the user chose to run. */
  scopeName: string;
  startedAt: number;
  durationMs: number;
  iterations: number;
  dataRows: number;
  /** Absent only on migrated pre-evidence history entries. */
  configuration?: CollectionRunConfiguration;
  outcome: 'completed' | 'aborted' | 'failed';
  requests: CollectionRequestResult[];
  summary: { total: number; passed: number; failed: number; skipped: number };
}

export interface CollectionRunOptions {
  collection: Collection;
  scopeName: string;
  runnables: RunnableRequest[];
  /** env (enabled) then collection.variables already merged in by the caller. */
  baseVars: Record<string, string>;
  /** Optional separated scopes used to preserve precedence as scripts mutate them. */
  globalVars?: Record<string, string>;
  environmentVars?: Record<string, string>;
  /** Repeat count when no data file; ignored when dataRows is non-empty. */
  iterations: number;
  /** Data-file rows; when non-empty drives one iteration per row (Postman semantics). */
  dataRows: IterationRow[];
  delayMs: number;
  stopOnFailure: boolean;
  /** Metadata is the privacy-preserving default. */
  retention?: ResponseRetentionMode;
  /** Identity only; resolved environment values are never persisted in the run report. */
  environmentId?: string;
  environmentName?: string;
}

export interface RunProgress {
  completed: number;
  total: number;
  current?: { itemName: string; iteration: number };
  results: CollectionRequestResult[];
  done: boolean;
}

/** Protocols that have no usable single-shot `runRequest` (their impl throws). */
const STREAMING_PROTOCOLS = new Set(['sse', 'websocket', 'socketio', 'kafka']);

/** Protocols that stop before sending when a pre-request script calls `skipRequest()`. */
const HONORS_SKIP_REQUEST = new Set(['http', 'grpc', 'mcp']);

/**
 * Fired after each executed request so callers can mirror the request into the
 * Console (tagged by run). Carries the resolved request and — when the request
 * actually ran — the response and captured script results.
 */
export interface RequestCompleteInfo {
  result: CollectionRequestResult;
  request: Request;
  response?: ApiResponse;
  scripts?: ProtocolScriptResult;
  runId: string;
  scopeName: string;
}
export type OnRequestComplete = (info: RequestCompleteInfo) => void;

function isProtocolOk(response: ApiResponse): boolean {
  // MCP: the envelope is always 200; a JSON-RPC error or a tool result with
  // `isError: true` fails unless the test script's assertions decide.
  if (response.mcpOutcome) return response.mcpOutcome === 'result';
  // gRPC carries a status code separate from the (always-200) HTTP envelope.
  const grpcStatus = (response as { grpcStatus?: number }).grpcStatus;
  if (typeof grpcStatus === 'number') return grpcStatus === 0;
  return response.status >= 200 && response.status < 300;
}

export async function runCollection(
  options: CollectionRunOptions,
  onProgress: (p: RunProgress) => void,
  signal: AbortSignal,
  onRequestComplete?: OnRequestComplete
): Promise<CollectionRunResult> {
  // One MCP session per server for the whole run: initialize once, reuse for
  // every MCP item, disconnect when the run ends — however it ends (#901).
  const mcpClientPool = new Map<string, Promise<McpClient>>();
  try {
    return await runCollectionWithPool(
      options,
      onProgress,
      signal,
      onRequestComplete,
      mcpClientPool
    );
  } finally {
    await disposeMcpClientPool(mcpClientPool);
  }
}

async function runCollectionWithPool(
  options: CollectionRunOptions,
  onProgress: (p: RunProgress) => void,
  signal: AbortSignal,
  onRequestComplete: OnRequestComplete | undefined,
  mcpClientPool: Map<string, Promise<McpClient>>
): Promise<CollectionRunResult> {
  const {
    collection,
    scopeName,
    runnables,
    baseVars,
    iterations,
    dataRows,
    delayMs,
    stopOnFailure,
    retention = 'metadata',
  } = options;

  const runId = uuidv4();
  const startedAt = Date.now();
  const results: CollectionRequestResult[] = [];

  const rows = resolveIterationRows({ dataRows, repeat: iterations });
  const total = rows.length * runnables.length;

  const emit = (done: boolean, current?: { itemName: string; iteration: number }) =>
    onProgress({
      completed: results.length,
      total,
      ...(current ? { current } : {}),
      results: [...results],
      done,
    });

  // `pm.collectionVariables` backing map — separate from `allVars` (which
  // folds env/globals/collection/data together for `{{var}}` substitution
  // and `pm.variables`). Mutations persist to `useCollectionStore` as they
  // happen, so later requests in the SAME run (and future runs) see them,
  // matching Postman's collection-runner semantics.
  const collectionVars = buildValueMap({ collection: collection.variables });
  const runGlobals = { ...(options.globalVars ?? {}) };
  const runEnvironment = {
    ...(options.globalVars || options.environmentVars ? options.environmentVars : baseVars),
  };
  // Persist at most once per request (merging both script phases, test wins
  // on conflict) rather than once per phase — `applyCollectionVarMutations`
  // rewrites the entire persisted (encrypted, IndexedDB-backed) collections
  // tree, so halving the call count halves that cost on every request that
  // touches `pm.collectionVariables` in both its pre-request and test script.
  const persistCollectionMutations = (
    mutations: Record<string, string | null>,
    effectiveVars: Record<string, string>,
    iterationData: IterationRow,
    environmentOverrides: Record<string, string>
  ) => {
    if (Object.keys(mutations).length === 0) return;
    applyVarMutations(collectionVars, mutations);
    for (const [key, value] of Object.entries(mutations)) {
      if (key in iterationData || key in environmentOverrides) continue;
      if (value === null) delete effectiveVars[key];
      else effectiveVars[key] = value;
    }
    useCollectionStore.getState().applyCollectionVarMutations(collection.id, mutations);
  };

  const beginIteration = (iter: number, row: IterationRow): IterationHost<RunnableRequest> => {
    const environmentOverrides: Record<string, string> = {};
    // Scope precedence: globals < environment < collection < data < script-local.
    const allVars: Record<string, string> = {
      ...runGlobals,
      ...runEnvironment,
      ...collectionVars,
      ...row,
    };

    const step = async (runnable: RunnableRequest): Promise<StepOutcome> => {
      const protocolId = runnable.request.type;
      const protocol = protocolRegistry.get(protocolId);

      // Never sent, ignores delay and `setNextRequest`. Fails the run only when
      // asked to (a blocked request under stopOnFailure, like the CLI's --bail),
      // and the row then says so: run lists read summary.failed.
      const skip = (reason: string, failed = false): StepOutcome => {
        results.push({
          itemId: runnable.itemId,
          itemName: runnable.name,
          protocol: protocolId,
          iteration: iter,
          status: failed ? 'failed' : 'skipped',
          assertions: [],
          ...(failed ? { error: reason } : { skippedReason: reason }),
        });
        emit(false);
        return { failed, sent: false };
      };

      // Postman send guard (#1232): never sent, for every protocol. The CLI
      // reports the same reason as a failed "not sent" result, so it counts as a
      // failure under stopOnFailure here too. Otherwise the row is just skipped.
      if (runnable.blocked) return skip(runnable.blocked, stopOnFailure);

      // Skip protocols without a usable single-shot runner.
      if (!protocol || STREAMING_PROTOCOLS.has(protocolId)) {
        return skip(
          protocol
            ? `${protocolId} is not supported in the runner`
            : `Unknown protocol: ${protocolId}`
        );
      }
      // gRPC streams run through the protocol runner (#917): server streams on
      // every platform; client / bidi send the request's message(s) and
      // half-close, which needs a duplex transport — desktop only.
      const grpcMethodType = (runnable.request as { methodType?: string }).methodType;
      if (
        protocolId === 'grpc' &&
        (grpcMethodType === 'client-streaming' || grpcMethodType === 'bidirectional-streaming') &&
        !isElectron()
      ) {
        return skip(`gRPC ${grpcMethodType} runs in the desktop app only`);
      }

      // Auth inheritance: nearest ancestor folder's auth (threaded by
      // flattenRunnables), falling back to collection-level auth.
      const authed = withEffectiveAuth(runnable.request, runnable.inheritedAuth ?? collection.auth);
      const requestVars = {
        ...allVars,
        ...buildValueMap({ folders: runnable.folderVariables }),
        ...row,
        ...environmentOverrides,
      };

      let scripts: ProtocolScriptResult | undefined;
      const ctx = {
        signal,
        variables: requestVars,
        onScriptResult: (r: ProtocolScriptResult) => {
          scripts = r;
        },
        protocolOptions: {
          collectionVars: { ...collectionVars },
          iterationData: { ...row },
          info: { iteration: iter, iterationCount: rows.length },
          ...(HONORS_SKIP_REQUEST.has(protocolId) ? { honorSkipRequest: true } : {}),
          location: {
            currentRequestName: runnable.name,
            folderPath: runnable.folderPath ?? [],
            collectionName: collection.name,
          },
          // gRPC: hand the persisted schema snapshot (reflection descriptors or
          // uploaded proto) + per-request timeout to the protocol module — the
          // desktop transport cannot call without a schema (#871). With no
          // snapshot the module falls back to server reflection.
          ...(protocolId === 'grpc'
            ? grpcRunOptionsFromRequest(runnable.request as GrpcRequest)
            : {}),
          ...(protocolId === 'mcp' ? { [MCP_CLIENT_POOL_OPTION]: mcpClientPool } : {}),
        },
      };

      const startedReq = Date.now();
      const result: CollectionRequestResult = {
        itemId: runnable.itemId,
        itemName: runnable.name,
        protocol: protocolId,
        iteration: iter,
        status: 'failed',
        assertions: [],
      };

      let response: ApiResponse | undefined;
      try {
        const requestStartVars = { ...requestVars };
        response = await protocol.runRequest(authed, ctx);
        result.durationMs = Date.now() - startedReq;
        result.httpStatus = response.status;
        result.sizeBytes = response.size;

        // Aggregate pm.test() assertions from both script phases.
        const assertions: RunnerAssertion[] = [];
        const collectionMutations: Record<string, string | null> = {};
        for (const phase of [scripts?.preRequest, scripts?.test]) {
          if (phase?.tests) {
            for (const t of phase.tests) {
              assertions.push({
                name: t.name,
                passed: t.passed,
                ...(t.error ? { error: t.error } : {}),
              });
            }
          }
          // Carry-forward pm.variables.set() mutations into the iteration map.
          if (phase?.variables) {
            for (const [key, value] of Object.entries(phase.variables)) {
              if (requestStartVars[key] !== value) environmentOverrides[key] = value;
            }
          }
          // Merge pm.collectionVariables.set/unset mutations from both phases
          // (test wins on conflict) — persisted once below, not per phase.
          if (phase?.collectionMutations)
            Object.assign(collectionMutations, phase.collectionMutations);
          if (phase?.globalsMutations) applyVarMutations(runGlobals, phase.globalsMutations);
        }
        // Collection mutations are surfaced in `variables` by the protocol
        // executor too; keep them in their real scope instead of accidentally
        // promoting them above iteration data.
        for (const key of Object.keys(collectionMutations)) delete environmentOverrides[key];
        Object.assign(runEnvironment, environmentOverrides);
        Object.keys(allVars).forEach((key) => delete allVars[key]);
        Object.assign(
          allVars,
          runGlobals,
          runEnvironment,
          collectionVars,
          row,
          environmentOverrides
        );
        result.assertions = assertions;
        // Persist merged pm.collectionVariables mutations — later requests
        // in this run (and future runs) see the updated value.
        persistCollectionMutations(collectionMutations, allVars, row, environmentOverrides);

        const scriptError = [scripts?.preRequest, scripts?.test]
          .flatMap((p) => p?.errors ?? [])
          .filter(Boolean);

        // `pm.execution.skipRequest()`: nothing was sent and no test script ran.
        // A skipped row passes unless its pre-request script failed or asserted
        // false; a bad jump from it is silent (the CLI's `badJump: 'ignore'`).
        const preExecution = scripts?.preRequest?.execution;
        if (HONORS_SKIP_REQUEST.has(protocolId) && preExecution?.skipRequested) {
          const failed = scriptError.length > 0 || assertions.some((a) => !a.passed);
          results.push({
            itemId: runnable.itemId,
            itemName: runnable.name,
            protocol: protocolId,
            iteration: iter,
            status: failed ? 'failed' : 'skipped',
            assertions,
            skippedReason: 'Skipped by pm.execution.skipRequest()',
            ...(scriptError.length > 0 ? { error: scriptError.join('; ') } : {}),
          });
          emit(false);
          return {
            failed,
            sent: false,
            next: preExecution.nextRequest,
            badJump: 'ignore',
          };
        }

        let passed = isProtocolOk(response);
        // Without assertions, say why an MCP item failed (JSON-RPC error / isError).
        if (!passed && assertions.length === 0 && response.mcpOutcome) {
          result.error = response.statusText;
        }
        if (assertions.length > 0) passed = assertions.every((a) => a.passed);
        if (scriptError.length > 0) {
          passed = false;
          result.error = scriptError.join('; ');
        }
        result.status = passed ? 'success' : 'failed';
        result.evidence = await buildResponseEvidence(
          response,
          retention === 'all' || result.status === 'failed' ? retention : 'metadata'
        );
      } catch (err) {
        result.durationMs = Date.now() - startedReq;
        result.status = 'failed';
        result.error = err instanceof Error ? err.message : String(err);
      }

      results.push(result);
      onRequestComplete?.({
        result,
        request: authed,
        ...(response ? { response } : {}),
        ...(scripts ? { scripts } : {}),
        runId,
        scopeName,
      });
      emit(false);

      return {
        failed: result.status === 'failed',
        sent: true,
        next: pickNextRequest(scripts?.test?.execution, scripts?.preRequest?.execution),
      };
    };

    return {
      onStart: (runnable) => emit(false, { itemName: runnable.name, iteration: iter }),
      step,
      onFlowError: (runnable, error) => {
        results.push({
          itemId: runnable.itemId,
          itemName: runnable.name,
          protocol: runnable.request.type,
          iteration: iter,
          status: 'failed',
          assertions: [],
          error,
        });
      },
    };
  };

  const { bailed } = await sequenceCollectionRun(
    {
      items: runnables,
      nameOf: (runnable) => runnable.name,
      rows,
      stopOnFailure,
      delayMs,
      delayPlacement: 'after-sent',
      signal,
    },
    beginIteration
  );

  const summary = {
    total: results.length,
    passed: results.filter((r) => r.status === 'success').length,
    failed: results.filter((r) => r.status === 'failed').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
  };

  const final: CollectionRunResult = {
    id: runId,
    collectionId: collection.id,
    collectionName: collection.name,
    scopeName,
    startedAt,
    durationMs: Date.now() - startedAt,
    iterations: rows.length,
    dataRows: dataRows.length,
    configuration: {
      runnableIds: runnables.map((runnable) => runnable.itemId),
      ...(options.environmentId ? { environmentId: options.environmentId } : {}),
      ...(options.environmentName ? { environmentName: options.environmentName } : {}),
      iterations: rows.length,
      delayMs,
      stopOnFailure,
      usedDataFile: dataRows.length > 0,
      retention,
    },
    outcome: signal.aborted ? 'aborted' : bailed ? 'failed' : 'completed',
    requests: results,
    summary,
  };

  emit(true);
  return final;
}
