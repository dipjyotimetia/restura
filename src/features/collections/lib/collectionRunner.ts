import {
  buildResponseEvidence,
  type ResponseEvidence,
  type ResponseRetentionMode,
} from '@shared/collection-run/evidence';
import { APP_SCOPE_POLICY, RunScope } from '@shared/collection-run/scope';
import {
  type IterationHost,
  pickNextRequest,
  resolveIterationRows,
  type StepOutcome,
  sequenceCollectionRun,
} from '@shared/collection-run/sequencer';
import {
  foldScriptPhases,
  type PhaseOutcome,
  settleVerdict,
  skipVerdict,
} from '@shared/collection-run/verdict';
import { v4 as uuidv4 } from 'uuid';
import { withEffectiveAuth } from '@/features/auth/lib/authInheritance';
import { grpcRunOptionsFromRequest } from '@/features/grpc/lib/grpcSchemaSnapshot';
import type { McpClient } from '@/features/mcp/lib/mcpClient';
import { disposeMcpClientPool, MCP_CLIENT_POOL_OPTION } from '@/features/mcp/lib/mcpRunRequest';
import { protocolRunTraits } from '@/features/registry/modes';
import { protocolRegistry } from '@/features/registry/registry';
import type { ProtocolScriptResult } from '@/features/registry/types';
import { isElectron } from '@/lib/shared/platform';
import { buildValueMap, secretVariableNames } from '@/lib/shared/variableScopes';
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
  /** Secret names from scopes the runner does not see (the environment chain). */
  secretNames?: readonly string[];
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

/** A script phase in the shape the shared fold reads (`tests` become assertions). */
function phaseOutcome(phase: ProtocolScriptResult['preRequest']): PhaseOutcome | undefined {
  if (!phase) return undefined;
  return {
    assertions: (phase.tests ?? []).map((t) => ({
      name: t.name,
      passed: t.passed,
      ...(t.error ? { error: t.error } : {}),
    })),
    errors: phase.errors,
    execution: phase.execution,
  };
}

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

  // `pm.collectionVariables` backing map — separate from the request variables
  // (`{{var}}` substitution and `pm.variables`). Mutations persist to
  // `useCollectionStore` as they happen, so later requests in the SAME run (and
  // future runs) see them, matching Postman's collection-runner semantics.
  const collectionVars = buildValueMap({ collection: collection.variables });
  const scope = new RunScope({
    policy: APP_SCOPE_POLICY,
    globals: { ...(options.globalVars ?? {}) },
    environment: options.globalVars || options.environmentVars ? options.environmentVars : baseVars,
    collection: collectionVars,
  });

  const beginIteration = (iter: number, row: IterationRow): IterationHost<RunnableRequest> => {
    const iterScope = scope.beginIteration(row);

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
      const traits = protocolRunTraits(protocolId);
      if (!protocol || !traits.runnable) {
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
      const requestVars = iterScope.requestVars(
        buildValueMap({ folders: runnable.folderVariables })
      );

      let scripts: ProtocolScriptResult | undefined;
      const ctx = {
        signal,
        variables: requestVars,
        secretNames: [
          ...(options.secretNames ?? []),
          ...secretVariableNames(collection.variables, ...(runnable.folderVariables ?? [])),
        ],
        onScriptResult: (r: ProtocolScriptResult) => {
          scripts = r;
        },
        protocolOptions: {
          collectionVars: { ...collectionVars },
          iterationData: { ...row },
          info: { iteration: iter, iterationCount: rows.length },
          ...(traits.honorsSkipRequest ? { honorSkipRequest: true } : {}),
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

        // Fold both script phases: assertions, errors, and the variable /
        // collection / globals writes. Collection writes persist once per
        // request (both phases merged, test wins on conflict) rather than once
        // per phase: persisting rewrites the whole encrypted collections tree.
        const phases = [scripts?.preRequest, scripts?.test];
        const fold = foldScriptPhases(
          [
            { label: 'pre-request', outcome: phaseOutcome(scripts?.preRequest) },
            { label: 'test', outcome: phaseOutcome(scripts?.test) },
          ],
          { labelErrors: false }
        );
        const assertions: RunnerAssertion[] = fold.assertions;
        const collectionMutations = iterScope.absorb(
          phases.flatMap((phase) =>
            phase
              ? [
                  {
                    before: requestStartVars,
                    after: phase.variables ?? {},
                    collectionMutations: phase.collectionMutations,
                    globalsMutations: phase.globalsMutations,
                  },
                ]
              : []
          )
        );
        result.assertions = assertions;
        if (Object.keys(collectionMutations).length > 0) {
          useCollectionStore
            .getState()
            .applyCollectionVarMutations(collection.id, collectionMutations);
        }

        // `pm.execution.skipRequest()`: nothing was sent and no test script ran.
        // A skipped row passes unless its pre-request script failed or asserted
        // false; a bad jump from it is silent (the CLI's `badJump: 'ignore'`).
        const preExecution = scripts?.preRequest?.execution;
        if (traits.honorsSkipRequest && preExecution?.skipRequested) {
          const failed = !skipVerdict(fold).passed;
          results.push({
            itemId: runnable.itemId,
            itemName: runnable.name,
            protocol: protocolId,
            iteration: iter,
            status: failed ? 'failed' : 'skipped',
            assertions,
            skippedReason: 'Skipped by pm.execution.skipRequest()',
            ...(fold.errorText !== undefined ? { error: fold.errorText } : {}),
          });
          emit(false);
          return {
            failed,
            sent: false,
            next: preExecution.nextRequest,
            badJump: 'ignore',
          };
        }

        const protocolPassed = isProtocolOk(response);
        // Without assertions, say why an MCP item failed (JSON-RPC error / isError).
        const verdict = settleVerdict({
          protocolPassed,
          protocolError: !protocolPassed && response.mcpOutcome ? response.statusText : undefined,
          fold,
          errorStyle: 'script-wins',
        });
        if (verdict.error !== undefined) result.error = verdict.error;
        result.status = verdict.passed ? 'success' : 'failed';
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
      onEnd: () => iterScope.end(),
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
