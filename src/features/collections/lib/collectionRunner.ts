import { v4 as uuidv4 } from 'uuid';
import type { IterationRow } from './dataLoader';
import type { RunnableRequest } from './flattenRunnables';
import { withEffectiveAuth } from '@/features/auth/lib/authInheritance';
import { protocolRegistry } from '@/features/registry/registry';
import type { ProtocolScriptResult } from '@/features/registry/types';
import { applyVarMutations } from '@/lib/shared/collectionVarMutations';
import { buildValueMap } from '@/lib/shared/variableScopes';
import { useCollectionStore } from '@/store/useCollectionStore';
import type { Collection, Request, Response as ApiResponse } from '@/types';

/**
 * Postman-style collection / folder runner. Mirrors the CLI's orchestration
 * (`cli/src/runner/runner.ts`) but dispatches through the in-app protocol
 * registry instead of the CLI's executor, so HTTP/gRPC-unary run through the
 * exact same wire path (and SSRF/secret resolution) as a normal send.
 *
 * Dispatch is imperative — `protocol.injectVariables` then `runRequest(ctx)` —
 * the same pattern the DAG executor uses. The React `useRequestRunner` hook is
 * deliberately NOT used: it writes history and pushes script results to the
 * active tab's Console, neither of which a batch run should do.
 *
 * Protocols whose `runRequest` throws (SSE/MCP/WebSocket/streaming-gRPC) are
 * skipped with a reason rather than invoked.
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
  requests: CollectionRequestResult[];
  summary: { total: number; passed: number; failed: number; skipped: number };
}

export interface CollectionRunOptions {
  collection: Collection;
  scopeName: string;
  runnables: RunnableRequest[];
  /** env (enabled) then collection.variables already merged in by the caller. */
  baseVars: Record<string, string>;
  /** Repeat count when no data file; ignored when dataRows is non-empty. */
  iterations: number;
  /** Data-file rows; when non-empty drives one iteration per row (Postman semantics). */
  dataRows: IterationRow[];
  delayMs: number;
  stopOnFailure: boolean;
}

export interface RunProgress {
  completed: number;
  total: number;
  current?: { itemName: string; iteration: number };
  results: CollectionRequestResult[];
  done: boolean;
}

/** Protocols that have no usable single-shot `runRequest` (their impl throws). */
const STREAMING_PROTOCOLS = new Set(['sse', 'mcp', 'websocket', 'socketio', 'kafka']);

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
  // gRPC carries a status code separate from the (always-200) HTTP envelope.
  const grpcStatus = (response as { grpcStatus?: number }).grpcStatus;
  if (typeof grpcStatus === 'number') return grpcStatus === 0;
  return response.status >= 200 && response.status < 300;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal.aborted) return resolve();
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function runCollection(
  options: CollectionRunOptions,
  onProgress: (p: RunProgress) => void,
  signal: AbortSignal,
  onRequestComplete?: OnRequestComplete
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
  } = options;

  const runId = uuidv4();
  const startedAt = Date.now();
  const results: CollectionRequestResult[] = [];

  // Data-driven: one iteration per row. Otherwise N empty-row iterations.
  // Guard against a non-finite count (NaN/Infinity) silently producing zero
  // iterations — a malformed caller should still run at least once.
  const iterCount = Number.isFinite(iterations) ? Math.max(1, Math.floor(iterations)) : 1;
  const rows: IterationRow[] =
    dataRows.length > 0 ? dataRows : Array.from({ length: iterCount }, () => ({}));
  const total = rows.length * runnables.length;

  const emit = (done: boolean, current?: { itemName: string; iteration: number }) =>
    onProgress({
      completed: results.length,
      total,
      ...(current ? { current } : {}),
      results: [...results],
      done,
    });

  let bailed = false;

  // Build a name → index map so `pm.execution.setNextRequest('Login')`
  // can jump anywhere in the runnable list. Postman matches by name; first
  // match wins (later duplicates are unreachable). The map is iteration-
  // stable since the runnable order doesn't change inside a run.
  const indexByName: Record<string, number> = {};
  for (let i = 0; i < runnables.length; i++) {
    const n = runnables[i]?.name;
    if (n && !(n in indexByName)) indexByName[n] = i;
  }
  // Guard against `setNextRequest` infinite loops by capping per-iteration
  // jumps; the user's script is buggy if it triggers this. Matches Newman's
  // behaviour (Newman emits an error at ~1000).
  const MAX_NEXT_REQUEST_JUMPS = 1000;

  // `pm.collectionVariables` backing map — separate from `allVars` (which
  // folds env/globals/collection/data together for `{{var}}` substitution
  // and `pm.variables`). Mutations persist to `useCollectionStore` as they
  // happen, so later requests in the SAME run (and future runs) see them,
  // matching Postman's collection-runner semantics.
  const collectionVars = buildValueMap({ collection: collection.variables });
  // Persist at most once per request (merging both script phases, test wins
  // on conflict) rather than once per phase — `applyCollectionVarMutations`
  // rewrites the entire persisted (encrypted, IndexedDB-backed) collections
  // tree, so halving the call count halves that cost on every request that
  // touches `pm.collectionVariables` in both its pre-request and test script.
  const persistCollectionMutations = (mutations: Record<string, string | null>) => {
    if (Object.keys(mutations).length === 0) return;
    applyVarMutations(collectionVars, mutations);
    useCollectionStore.getState().applyCollectionVarMutations(collection.id, mutations);
  };

  outer: for (let iter = 0; iter < rows.length; iter++) {
    // Carry-forward map for this iteration: base + row, mutated by scripts as we go.
    const allVars: Record<string, string> = { ...baseVars, ...rows[iter] };
    let jumps = 0;

    for (let idx = 0; idx < runnables.length; ) {
      const runnable = runnables[idx];
      if (!runnable) break;
      if (signal.aborted || bailed) break outer;

      emit(false, { itemName: runnable.name, iteration: iter });

      const protocolId = runnable.request.type;
      const protocol = protocolRegistry.get(protocolId);

      // Skip protocols without a usable single-shot runner.
      if (!protocol || STREAMING_PROTOCOLS.has(protocolId)) {
        results.push({
          itemId: runnable.itemId,
          itemName: runnable.name,
          protocol: protocolId,
          iteration: iter,
          status: 'skipped',
          assertions: [],
          skippedReason: protocol
            ? `${protocolId} is not supported in the runner`
            : `Unknown protocol: ${protocolId}`,
        });
        emit(false);
        idx++;
        continue;
      }
      if (
        protocolId === 'grpc' &&
        (runnable.request as { methodType?: string }).methodType !== 'unary'
      ) {
        results.push({
          itemId: runnable.itemId,
          itemName: runnable.name,
          protocol: protocolId,
          iteration: iter,
          status: 'skipped',
          assertions: [],
          skippedReason: 'Only unary gRPC is supported in the runner',
        });
        emit(false);
        idx++;
        continue;
      }

      // Auth inheritance: nearest ancestor folder's auth (threaded by
      // flattenRunnables), falling back to collection-level auth.
      const authed = withEffectiveAuth(runnable.request, runnable.inheritedAuth ?? collection.auth);
      const injected = protocol.injectVariables?.(authed, allVars) ?? authed;

      let scripts: ProtocolScriptResult | undefined;
      const ctx = {
        signal,
        variables: { ...allVars },
        onScriptResult: (r: ProtocolScriptResult) => {
          scripts = r;
        },
        protocolOptions: {
          collectionVars: { ...collectionVars },
          iterationData: { ...rows[iter] },
          info: { iteration: iter, iterationCount: rows.length },
          location: {
            currentRequestName: runnable.name,
            // flattenRunnables() doesn't retain per-runnable folder ancestry
            // today, so pm.execution.location.folderPath is always empty —
            // collectionName/currentRequestName are still accurate.
            folderPath: [],
            collectionName: collection.name,
          },
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
        response = await protocol.runRequest(injected, ctx);
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
          if (phase?.variables) Object.assign(allVars, phase.variables);
          // Merge pm.collectionVariables.set/unset mutations from both phases
          // (test wins on conflict) — persisted once below, not per phase.
          if (phase?.collectionMutations)
            Object.assign(collectionMutations, phase.collectionMutations);
        }
        result.assertions = assertions;
        // Persist merged pm.collectionVariables mutations — later requests
        // in this run (and future runs) see the updated value.
        persistCollectionMutations(collectionMutations);

        const scriptError = [scripts?.preRequest, scripts?.test]
          .flatMap((p) => p?.errors ?? [])
          .filter(Boolean);

        let passed = isProtocolOk(response);
        if (assertions.length > 0) passed = assertions.every((a) => a.passed);
        if (scriptError.length > 0) {
          passed = false;
          result.error = scriptError.join('; ');
        }
        result.status = passed ? 'success' : 'failed';
      } catch (err) {
        result.durationMs = Date.now() - startedReq;
        result.status = 'failed';
        result.error = err instanceof Error ? err.message : String(err);
      }

      results.push(result);
      onRequestComplete?.({
        result,
        request: injected,
        ...(response ? { response } : {}),
        ...(scripts ? { scripts } : {}),
        runId,
        scopeName,
      });
      emit(false);

      if (result.status === 'failed' && stopOnFailure) {
        bailed = true;
        break outer;
      }

      if (delayMs > 0) await delay(delayMs, signal);

      // pm.execution.setNextRequest from EITHER phase wins; the test phase
      // has the last word when both set a value. Use the test phase if its
      // `nextRequest` is *present* (even when explicitly null — null ends
      // the iteration), else the preRequest phase, else undefined for the
      // default linear advance. `??` would mask `null` as nullish, so check
      // with `nextRequest in execution` semantics via Reflect-style detection.
      const testExec = scripts?.test?.execution;
      const preExec = scripts?.preRequest?.execution;
      const execNext =
        testExec && 'nextRequest' in testExec
          ? testExec.nextRequest
          : preExec && 'nextRequest' in preExec
            ? preExec.nextRequest
            : undefined;
      if (execNext === null) {
        break;
      }
      if (typeof execNext === 'string') {
        const target = indexByName[execNext];
        if (target === undefined) {
          // Unknown target name — surface as a script error and stop the iteration.
          results.push({
            itemId: runnable.itemId,
            itemName: runnable.name,
            protocol: protocolId,
            iteration: iter,
            status: 'failed',
            assertions: [],
            error: `pm.execution.setNextRequest("${execNext}"): no runnable with that name`,
          });
          break;
        }
        if (++jumps > MAX_NEXT_REQUEST_JUMPS) {
          results.push({
            itemId: runnable.itemId,
            itemName: runnable.name,
            protocol: protocolId,
            iteration: iter,
            status: 'failed',
            assertions: [],
            error: `pm.execution.setNextRequest jump limit (${MAX_NEXT_REQUEST_JUMPS}) exceeded`,
          });
          break;
        }
        idx = target;
        continue;
      }
      idx++;
    }
  }

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
    requests: results,
    summary,
  };

  emit(true);
  return final;
}
