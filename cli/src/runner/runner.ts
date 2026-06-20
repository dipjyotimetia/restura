import { loadCollection } from './collectionLoader.js';
import { executeRequest } from './executors/dispatch.js';
import { runPreRequestScript, runTestScript, type RunScriptResult } from './scriptRunner.js';
import { applyFilters, type FilterOptions } from './filter.js';
import { withRetry, DEFAULT_RETRY, type RetryOptions } from './retry.js';
import { buildTlsDispatcher, type TlsOptions } from './undiciFetcher.js';
import type { CliIterationRow } from './dataLoader.js';
import type { Reporter, RunResult, RequestRunResult, RunMeta } from '../reporters/types.js';

export interface RunOptions {
  envVars: Record<string, string>;
  bail: boolean;
  timeoutMs: number;
  allowLocalhost: boolean;
  /** Subset filters applied before execution. */
  filter?: FilterOptions;
  /** Data-driven iterations. Empty array (or undefined) = single iteration with no row vars. */
  iterations?: CliIterationRow[];
  /** Cap on iterations to run. */
  maxIterations?: number;
  /** Retry policy for individual requests. */
  retry?: Partial<RetryOptions>;
  /** SSE: stream open duration (ms). */
  sseDurationMs?: number;
  /** SSE: stop after this many events. */
  sseMaxEvents?: number;
  /** TLS options for outbound HTTPS (custom CA / client cert / insecure). */
  tls?: TlsOptions;
}

/**
 * Execute every request in a Restura collection (OpenCollection or legacy).
 *
 * High-level orchestration:
 *   1. Load collection → flatten to a request list → apply --folder/--include/--exclude.
 *   2. For each iteration (1 by default; one per row when `--data` is set):
 *      a. For each request: run pre-request script → execute (with retry) → test script.
 *      b. Pass/fail = (assertions all passed when scripts present) AND no script errors.
 *   3. Aggregate all results into a single RunResult; emit reporter callbacks.
 *
 * Variables are layered: env vars → collection vars → iteration-row vars
 * (row-level wins). Variables set inside scripts propagate within the
 * iteration AND back to the run-wide map for subsequent requests.
 */
export async function runCollection(
  collectionDir: string,
  options: RunOptions,
  reporter: Reporter
): Promise<RunResult> {
  const loaded = await loadCollection(collectionDir);

  // Merge: env vars first, then collection vars override.
  const baseVars: Record<string, string> = { ...options.envVars };
  for (const v of loaded.meta.variables ?? []) {
    if ((v as { enabled?: boolean }).enabled !== false) baseVars[v.key] = v.value;
  }

  const filtered = options.filter ? applyFilters(loaded.requests, options.filter) : loaded.requests;

  const meta: RunMeta = {
    collectionName: loaded.meta.name,
    collectionDir,
    startedAt: Date.now(),
  };
  await reporter.onStart?.(meta);

  const retry: RetryOptions = {
    ...DEFAULT_RETRY,
    ...(options.retry ?? {}),
  };

  // TLS dispatcher (custom CA / mTLS / insecure) built once and reused for
  // every request in the run.
  const dispatcher = buildTlsDispatcher(options.tls);

  // One iteration (with empty row vars) by default; multiple when --data is set.
  let iterations = options.iterations && options.iterations.length > 0 ? options.iterations : [{}];
  if (options.maxIterations !== undefined && options.maxIterations >= 0) {
    iterations = iterations.slice(0, options.maxIterations);
  }
  const isDataDriven = iterations.length > 1 || (options.iterations?.length ?? 0) > 0;

  const results: RequestRunResult[] = [];
  let bailed = false;

  // Build a name → index map so `pm.execution.setNextRequest('Login')` can jump
  // anywhere in the filtered list (Postman matches by name; first match wins).
  // Mirrors the desktop runner's `collectionRunner.ts`.
  const indexByName: Record<string, number> = {};
  for (let i = 0; i < filtered.length; i++) {
    const n = filtered[i]?.request.name;
    if (n && !(n in indexByName)) indexByName[n] = i;
  }
  // Cap per-iteration jumps so a buggy `setNextRequest` loop can't hang the run
  // (Newman errors at ~1000).
  const MAX_NEXT_REQUEST_JUMPS = 1000;

  iterationLoop: for (let iter = 0; iter < iterations.length; iter++) {
    const row = iterations[iter] ?? {};
    // Layer base + row vars; mutated across requests by scripts.
    const allVars: Record<string, string> = { ...baseVars, ...row };
    let jumps = 0;

    for (let idx = 0; idx < filtered.length; ) {
      if (bailed) break iterationLoop;
      const item = filtered[idx];
      if (!item) break;
      await reporter.onRequestStart?.(item);

      const preScript = item.request.preRequestScript;
      const testScript = item.request.testScript;
      let perRequestVars = { ...allVars };
      const allAssertions: Array<{ name: string; passed: boolean; error?: string }> = [];
      let scriptError: string | undefined;
      let preResult: RunScriptResult | undefined;
      let testResult: RunScriptResult | undefined;

      if (preScript) {
        try {
          const pre = await runPreRequestScript(preScript, item, perRequestVars);
          preResult = pre;
          perRequestVars = pre.variables;
          for (const k of Object.keys(pre.variables)) allVars[k] = pre.variables[k]!;
          if (pre.errors.length > 0) scriptError = `pre-request: ${pre.errors.join('; ')}`;
          if (pre.assertions.length > 0) allAssertions.push(...pre.assertions);
        } catch (err) {
          scriptError = `pre-request: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      const outcome = await withRetry(
        () =>
          executeRequest(item, {
            vars: perRequestVars,
            timeoutMs: options.timeoutMs,
            allowLocalhost: options.allowLocalhost,
            ...(options.sseDurationMs !== undefined
              ? { sseDurationMs: options.sseDurationMs }
              : {}),
            ...(options.sseMaxEvents !== undefined ? { sseMaxEvents: options.sseMaxEvents } : {}),
            ...(dispatcher ? { dispatcher } : {}),
          }),
        retry
      );

      if (testScript) {
        try {
          const test = await runTestScript(testScript, item, outcome, perRequestVars);
          testResult = test;
          for (const k of Object.keys(test.variables)) allVars[k] = test.variables[k]!;
          if (test.assertions.length > 0) allAssertions.push(...test.assertions);
          if (test.errors.length > 0) {
            const msg = `test: ${test.errors.join('; ')}`;
            scriptError = scriptError ? `${scriptError}; ${msg}` : msg;
          }
        } catch (err) {
          const msg = `test: ${err instanceof Error ? err.message : String(err)}`;
          scriptError = scriptError ? `${scriptError}; ${msg}` : msg;
        }
      }

      let passed = outcome.passed;
      if (allAssertions.length > 0) passed = allAssertions.every((a) => a.passed);
      if (scriptError) passed = false;
      // A transport-level failure can never be a pass, even if the test script
      // happens to contain a response-independent assertion that passed.
      if (outcome.errorMessage !== undefined) passed = false;

      const result: RequestRunResult = {
        request: item,
        status: outcome.status,
        passed,
        durationMs: outcome.durationMs,
        bodyBytes: outcome.bodyBytes,
        ...(outcome.responseHeaders ? { responseHeaders: outcome.responseHeaders } : {}),
        ...(outcome.errorMessage !== undefined
          ? {
              errorMessage: scriptError
                ? `${outcome.errorMessage}; ${scriptError}`
                : outcome.errorMessage,
            }
          : scriptError !== undefined
            ? { errorMessage: scriptError }
            : {}),
        ...(outcome.grpcStatus ? { grpcStatus: outcome.grpcStatus } : {}),
        ...(outcome.streamEvents ? { streamEvents: outcome.streamEvents } : {}),
        ...(allAssertions.length > 0 ? { assertions: allAssertions } : {}),
        ...(isDataDriven ? { iteration: iter } : {}),
      };

      results.push(result);
      await reporter.onRequestComplete?.(result);
      if (!result.passed && options.bail) {
        bailed = true;
        break iterationLoop;
      }

      // Flow control: `pm.execution.setNextRequest` from the test phase wins;
      // the pre-request phase is the fallback. A *present* nextRequest (even
      // explicit null) overrides the default linear advance — null ends the
      // iteration, a string jumps to that request by name.
      const testExec = testResult?.execution;
      const preExec = preResult?.execution;
      const execNext =
        testExec && 'nextRequest' in testExec
          ? testExec.nextRequest
          : preExec && 'nextRequest' in preExec
            ? preExec.nextRequest
            : undefined;
      if (execNext === null) break;
      if (typeof execNext === 'string') {
        const target = indexByName[execNext];
        if (target === undefined) {
          results.push({
            request: item,
            status: 0,
            passed: false,
            durationMs: 0,
            bodyBytes: 0,
            errorMessage: `pm.execution.setNextRequest("${execNext}"): no runnable with that name`,
            ...(isDataDriven ? { iteration: iter } : {}),
          });
          break;
        }
        if (++jumps > MAX_NEXT_REQUEST_JUMPS) {
          results.push({
            request: item,
            status: 0,
            passed: false,
            durationMs: 0,
            bodyBytes: 0,
            errorMessage: `pm.execution.setNextRequest jump limit (${MAX_NEXT_REQUEST_JUMPS}) exceeded`,
            ...(isDataDriven ? { iteration: iter } : {}),
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
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed && !r.errorMessage).length,
    errored: results.filter((r) => r.errorMessage !== undefined).length,
  };

  const final: RunResult = {
    meta: {
      ...meta,
      ...(isDataDriven ? { iteration: iterations.length } : {}),
    },
    durationMs: Date.now() - meta.startedAt,
    requests: results,
    summary,
  };
  await reporter.onEnd(final);
  return final;
}
