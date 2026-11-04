/**
 * In-app load test runner. Fires a chosen HTTP request `iterations` times with
 * a bounded `concurrency`, reusing the normal `executeRequest` path so auth,
 * variable resolution, and the proxy round-trip all match a real send. Collects
 * per-request latency + outcome for `computeLoadStats`.
 *
 * Note: on web the browser caps concurrent connections per origin (~6), so
 * effective concurrency is lower there than on desktop.
 */
import { v4 as uuidv4 } from 'uuid';
import { withEffectiveAuth } from '@/features/auth/lib/authInheritance';
import { resolveInheritedAuthForSend } from '@/features/auth/lib/resolveInheritedAuthFor';
import { executeRequest } from '@/features/http/lib/requestExecutor';
import { buildActiveRequestVariableResolution } from '@/lib/shared/activeRequestScopes';
import { computeLoadStats } from '@/lib/shared/loadStats';
import { buildValueMap } from '@/lib/shared/variableScopes';
import { useCollectionStore } from '@/store/useCollectionStore';
import { createProtocolConsoleEntry, useConsoleStore } from '@/store/useConsoleStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useRequestStore } from '@/store/useRequestStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import type { HttpRequest } from '@/types';

export interface LoadTestOptions {
  iterations: number;
  concurrency: number;
}

export interface LoadSample {
  timeMs: number;
  status: number;
  ok: boolean;
}

export interface LoadProgress {
  samples: LoadSample[];
  completed: number;
  total: number;
  elapsedMs: number;
  done: boolean;
}

/**
 * Snapshot everything a send needs, resolved exactly as the interactive Send
 * (`useHttpRequestPage.sendRequest`) does: every variable scope of the active
 * request (globals, the parent/sub environment chain, collection and folder
 * variables, SecretRef handles and the names that must stay secret), the
 * owning collection's `pm.collectionVariables`, and folder/collection auth
 * inheritance. Taken once per run so a tab switch mid-run cannot change what
 * later iterations send.
 *
 * Throws for a Postman-guard-blocked request (#1232); see runLoadTest.
 */
function buildExecutorOptions(request: HttpRequest, signal: AbortSignal) {
  // `executeRequest` does NOT resolve inheritance itself; without this, a load
  // test of a request that inherits ancestor auth would fire unauthenticated.
  const inherited = resolveInheritedAuthForSend(request);
  const effectiveRequest = withEffectiveAuth(request, inherited?.auth);
  const { values, secretVariables, sendSecretNames } = buildActiveRequestVariableResolution();
  const savedRequestId = useRequestStore.getState().getActiveTab()?.savedRequestId;
  const collection = savedRequestId
    ? useCollectionStore.getState().getCollectionByItemId(savedRequestId)
    : undefined;
  const collectionVars = buildValueMap({ collection: collection?.variables });
  const envStore = useEnvironmentStore.getState();
  const globalSettings = useSettingsStore.getState().settings;
  // Fresh maps per iteration: the executor mutates `envVars` (and the
  // collection map) with pre-request script writes.
  return () => ({
    request: effectiveRequest,
    envVars: { ...values },
    secretVariables,
    secretNames: sendSecretNames,
    globalSettings,
    resolveVariables: (text: string) => envStore.resolveVariables(text),
    collectionVars: { ...collectionVars },
    // Stop must cancel requests already on the wire, not just stop launching.
    signal,
  });
}

export async function runLoadTest(
  request: HttpRequest,
  options: LoadTestOptions,
  onProgress: (progress: LoadProgress) => void,
  signal: AbortSignal
): Promise<LoadProgress> {
  // Fail fast: a Postman-guard-blocked request (#1232) throws here, before any
  // iteration, instead of being swallowed per-iteration as status-0 samples.
  const executorOptions = buildExecutorOptions(request, signal);
  const samples: LoadSample[] = [];
  const total = Math.max(1, options.iterations);
  const concurrency = Math.max(1, options.concurrency);
  const start = performance.now();
  let launched = 0;

  const emit = (done: boolean) =>
    onProgress({
      samples,
      completed: samples.length,
      total,
      elapsedMs: performance.now() - start,
      done,
    });

  const worker = async () => {
    // Single-threaded JS: the read + increment happen before any await, so two
    // workers never claim the same slot.
    while (launched < total && !signal.aborted) {
      launched++;
      try {
        const { response } = await executeRequest(executorOptions());
        samples.push({
          timeMs: response.time,
          status: response.status,
          ok: response.status >= 200 && response.status < 400,
        });
      } catch {
        // A request cancelled by Stop is not a failure sample.
        if (signal.aborted) break;
        samples.push({ timeMs: 0, status: 0, ok: false });
      }
      emit(false);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));
  const final: LoadProgress = {
    samples,
    completed: samples.length,
    total,
    elapsedMs: performance.now() - start,
    done: true,
  };
  onProgress(final);
  pushSummaryToConsole(request, options, final);
  return final;
}

/**
 * Mirror ONE summary entry per load-test run into the unified console.
 * Per-request capture is deliberately not done — at load-test rates it would
 * instantly evict the whole console window (MAX_ENTRIES) with near-identical
 * rows; the aggregate is what's useful after the fact.
 */
function pushSummaryToConsole(
  request: HttpRequest,
  options: LoadTestOptions,
  final: LoadProgress
): void {
  const ok = final.samples.filter((s) => s.ok).length;
  const failed = final.samples.length - ok;
  // Same samples and percentile math as the dialog's stats.
  const stats = computeLoadStats(
    final.samples.filter((s) => s.ok).map((s) => s.timeMs),
    final.elapsedMs,
    failed
  );
  const summary = {
    url: request.url,
    method: request.method,
    iterations: options.iterations,
    concurrency: options.concurrency,
    completed: final.completed,
    ok,
    failed,
    elapsedMs: Math.round(final.elapsedMs),
    latencyMs:
      stats.count > 0 ? { min: stats.min, p50: stats.p50, p95: stats.p95, max: stats.max } : null,
  };
  const body = JSON.stringify(summary, null, 2);
  useConsoleStore.getState().addEntry(
    createProtocolConsoleEntry({
      protocol: 'http',
      method: `LOAD ${request.method}`,
      url: request.url,
      body,
      response: {
        id: uuidv4(),
        requestId: request.id,
        status: failed === 0 ? 200 : 0,
        statusText: `${ok}/${final.samples.length} ok`,
        headers: {},
        body,
        size: new TextEncoder().encode(body).length,
        time: Math.round(final.elapsedMs),
        timestamp: Date.now(),
      },
      extra: { runLabel: `Load test: ${request.name || request.url}` },
    })
  );
}
