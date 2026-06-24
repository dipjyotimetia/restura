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
import { resolveInheritedAuthFor } from '@/features/auth/lib/resolveInheritedAuthFor';
import { executeRequest } from '@/features/http/lib/requestExecutor';
import { useConsoleStore, createProtocolConsoleEntry } from '@/store/useConsoleStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
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

function buildExecutorOptions(request: HttpRequest) {
  // Apply folder/collection auth inheritance — the same rule the collection,
  // workflow, and interactive Send paths use. `executeRequest` does NOT resolve
  // inheritance itself; without this, a load test of a request that inherits
  // ancestor auth would fire every iteration unauthenticated (mismatching a
  // real send, which this runner's contract promises to match).
  const inherited = resolveInheritedAuthFor(request);
  const effectiveRequest = withEffectiveAuth(request, inherited?.auth);
  const envStore = useEnvironmentStore.getState();
  const activeEnv = envStore.getActiveEnvironment();
  const envVars: Record<string, string> = {};
  activeEnv?.variables
    .filter((v) => v.enabled)
    .forEach((v) => {
      envVars[v.key] = v.value;
    });
  return {
    request: effectiveRequest,
    envVars,
    globalSettings: useSettingsStore.getState().settings,
    resolveVariables: (text: string) => envStore.resolveVariables(text),
  };
}

export async function runLoadTest(
  request: HttpRequest,
  options: LoadTestOptions,
  onProgress: (progress: LoadProgress) => void,
  signal: AbortSignal
): Promise<LoadProgress> {
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
        const { response } = await executeRequest(buildExecutorOptions(request));
        samples.push({
          timeMs: response.time,
          status: response.status,
          ok: response.status >= 200 && response.status < 400,
        });
      } catch {
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
  const times = final.samples
    .map((s) => s.timeMs)
    .filter((t) => t > 0)
    .sort((a, b) => a - b);
  const pct = (p: number) => times[Math.min(times.length - 1, Math.floor(times.length * p))] ?? 0;
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
      times.length > 0
        ? { min: times[0], p50: pct(0.5), p95: pct(0.95), max: times[times.length - 1] }
        : null,
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
