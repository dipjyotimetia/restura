/**
 * In-app load test runner. Fires a chosen HTTP request `iterations` times with
 * a bounded `concurrency`, reusing the normal `executeRequest` path so auth,
 * variable resolution, and the proxy round-trip all match a real send. Collects
 * per-request latency + outcome for `computeLoadStats`.
 *
 * Note: on web the browser caps concurrent connections per origin (~6), so
 * effective concurrency is lower there than on desktop.
 */
import { executeRequest } from '@/features/http/lib/requestExecutor';
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
  const envStore = useEnvironmentStore.getState();
  const activeEnv = envStore.getActiveEnvironment();
  const envVars: Record<string, string> = {};
  activeEnv?.variables
    .filter((v) => v.enabled)
    .forEach((v) => {
      envVars[v.key] = v.value;
    });
  return {
    request,
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
  return final;
}
