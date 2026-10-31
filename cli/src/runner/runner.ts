import { applyVarMutations } from '@shared/collections/variable-mutations';
import type { ExternalSecretResolver } from '@shared/secrets/external-secret-resolver';
import type { HttpRequest } from '@shared/types';
import type { Reporter, RequestRunResult, RunMeta, RunResult } from '../reporters/types.js';
import { type LoadedRequest, loadCollection } from './collectionLoader.js';
import type { CliIterationRow } from './dataLoader.js';
import { executeRequest } from './executors/dispatch.js';
import { applyFilters, type FilterOptions } from './filter.js';
import { CliMcpSessionPool } from './mcpSession.js';
import { formatImportReport, importReportSize } from './postmanImport.js';
import { DEFAULT_RETRY, type RetryOptions, withRetry } from './retry.js';
import {
  applyPreRequestMetadata,
  type RunScriptResult,
  runPreRequestScript,
  runTestScript,
} from './scriptRunner.js';
import { buildDispatcher, type TlsOptions } from './undiciFetcher.js';

/**
 * The CLI does not apply the per-request HTTP version preference (#864, a
 * desktop-only setting): undici negotiates the protocol as usual. Returns the
 * one warning to print for a run, or undefined when no request forces one.
 */
export function httpVersionWarning(requests: readonly LoadedRequest[]): string | undefined {
  const forced = requests.filter((r) => {
    if (r.type !== 'http') return false;
    const v = (r.request as HttpRequest).settings?.httpVersion;
    return v !== undefined && v !== 'auto';
  }).length;
  if (forced === 0) return undefined;
  const noun = forced === 1 ? '1 request sets' : `${forced} requests set`;
  return (
    `[restura] WARNING: ${noun} an httpVersion preference that the CLI does not apply; ` +
    'the protocol is negotiated as usual. Use the desktop app to force HTTP/1.1, HTTP/2 or h2c.\n'
  );
}

export interface RunOptions {
  envVars: Record<string, string>;
  /**
   * `--env-var` values: above collection (and folder) variables, below the
   * iteration row and script writes — a CI override of a collection default.
   */
  overrideVars?: Record<string, string>;
  bail: boolean;
  timeoutMs: number;
  allowLocalhost: boolean;
  /** Subset filters applied before execution. */
  filter?: FilterOptions;
  /** Data-driven iterations. Empty array (or undefined) = single iteration with no row vars. */
  iterations?: CliIterationRow[];
  /** Cap on iterations to run. */
  maxIterations?: number;
  /** Pause between requests (ms), like Newman's `--delay-request`. */
  delayRequestMs?: number;
  /** Retry policy for individual requests. */
  retry?: Partial<RetryOptions>;
  /** SSE: stream open duration (ms). */
  sseDurationMs?: number;
  /** SSE: stop after this many events. */
  sseMaxEvents?: number;
  /** TLS options for outbound HTTPS (custom CA / client cert / insecure). */
  tls?: TlsOptions;
  /** Explicit HTTP(S) proxy URL. Overrides the HTTP_PROXY env var and composes with `tls`. */
  proxy?: string;
  externalSecretResolver?: ExternalSecretResolver;
  /**
   * Postman inputs: refuse to run (throw before any request) when the import
   * report has any entry — something was dropped, approximated or skipped.
   */
  strictImport?: boolean;
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
  // One MCP session per server for the whole run, closed however it ends (#901).
  const mcpSessions = new CliMcpSessionPool();
  try {
    return await runCollectionWithSessions(collectionDir, options, reporter, mcpSessions);
  } finally {
    await mcpSessions.dispose();
  }
}

async function runCollectionWithSessions(
  collectionDir: string,
  options: RunOptions,
  reporter: Reporter,
  mcpSessions: CliMcpSessionPool
): Promise<RunResult> {
  const loaded = await loadCollection(collectionDir);
  if (loaded.importReport && importReportSize(loaded.importReport) > 0) {
    // Human output: the grouped report goes to stderr (stdout stays the
    // reporter's); structured reporters get it on `RunResult.importReport`.
    process.stderr.write(formatImportReport(loaded.importReport));
    if (options.strictImport) {
      throw new Error(
        `--strict-import: the Postman import report has ${importReportSize(loaded.importReport)} ` +
          'entries (see above); refusing to run.'
      );
    }
  }

  // Merge: env vars first, then collection vars override.
  const baseVars: Record<string, string> = { ...options.envVars };
  // Run-scoped `pm.collectionVariables` backing map — separate from
  // `baseVars`/`allVars` (which fold everything together for `{{var}}`
  // substitution). Mutations carry forward within the run (Postman/Newman
  // semantics: transient, not written back to the collection file on disk).
  const collectionVars: Record<string, string> = {};
  for (const v of loaded.meta.variables ?? []) {
    if ((v as { enabled?: boolean }).enabled !== false) {
      baseVars[v.key] = v.value;
      collectionVars[v.key] = v.value;
    }
  }
  Object.assign(baseVars, options.overrideVars);
  assertCliSecretsAvailable(
    // A blocked request is never sent, so its variables can't abort the run.
    loaded.requests.filter((r) => !r.blocked),
    baseVars,
    new Set(loaded.meta.privateVariableNames ?? [])
  );
  const applyCollectionMutations = (mutations: Record<string, string | null> | undefined) =>
    applyVarMutations(collectionVars, mutations);

  const filtered = options.filter ? applyFilters(loaded.requests, options.filter) : loaded.requests;
  const versionWarning = httpVersionWarning(filtered);
  if (versionWarning) process.stderr.write(versionWarning);

  // One iteration (with empty row vars) by default; multiple when --data is set.
  let iterations = options.iterations && options.iterations.length > 0 ? options.iterations : [{}];
  if (options.maxIterations !== undefined && options.maxIterations >= 0) {
    iterations = iterations.slice(0, options.maxIterations);
  }
  const isDataDriven = iterations.length > 1 || (options.iterations?.length ?? 0) > 0;

  const meta: RunMeta = {
    collectionName: loaded.meta.name,
    collectionDir,
    startedAt: Date.now(),
    total: filtered.length * iterations.length,
  };
  await reporter.onStart?.(meta);

  const retry: RetryOptions = {
    ...DEFAULT_RETRY,
    ...(options.retry ?? {}),
  };

  // Dispatcher (TLS + explicit proxy) built once and reused for every request.
  const dispatcher = buildDispatcher(options.tls, options.proxy);

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

  // Run-wide variable map (env + collection), mutated by scripts. It outlives
  // each iteration, as in Newman and the app's runner: a token fetched in
  // iteration 1 is still set in iteration 2.
  const allVars: Record<string, string> = { ...baseVars };
  // Script writes from EARLIER iterations: above folder defaults (so they are
  // not undone), below the next iteration's data row.
  const carriedOverrides: Record<string, string> = {};
  let sentAny = false;

  iterationLoop: for (let iter = 0; iter < iterations.length; iter++) {
    const row = iterations[iter] ?? {};
    // Values a script changed this iteration. Layered on top of folder vars and
    // the row, as the app's runner does (`environmentOverrides`), so a script
    // write is not undone by a static folder default on the next request.
    const scriptOverrides: Record<string, string> = {};
    let jumps = 0;

    for (let idx = 0; idx < filtered.length; ) {
      if (bailed) break iterationLoop;
      const item = filtered[idx];
      if (!item) break;
      await reporter.onRequestStart?.(item);

      if (sentAny && options.delayRequestMs) await sleep(options.delayRequestMs);

      if (item.blocked) {
        // Never executed (no scripts, no network): e.g. a Postman auth type
        // the CLI cannot sign. Reported as a failed "not sent" result.
        const result: RequestRunResult = {
          request: item,
          status: 0,
          passed: false,
          durationMs: 0,
          bodyBytes: 0,
          errorMessage: item.blocked,
          notSent: true,
          ...(isDataDriven ? { iteration: iter } : {}),
        };
        results.push(result);
        await reporter.onRequestComplete?.(result);
        if (options.bail) {
          bailed = true;
          break iterationLoop;
        }
        idx++;
        continue;
      }

      const preScript = item.request.preRequestScript;
      const testScript = item.request.testScript;
      // Precedence matches the app's runner: env + collection < folder vars
      // (`buildValueMap({ folders })`) < iteration row < script-set values.
      const folderVars = item.folderVariables ?? {};
      let perRequestVars = {
        ...allVars,
        ...folderVars,
        ...options.overrideVars,
        ...carriedOverrides,
        ...row,
        ...scriptOverrides,
      };
      // Write script variables back to the run-wide map, except folder
      // variables a script left untouched (they must not leak to requests
      // outside the folder). A changed value also becomes a script override —
      // unless it was a pm.collectionVariables write, which stays in its own
      // (lower) scope, as in the app.
      const writeBack = (
        before: Record<string, string>,
        after: Record<string, string>,
        collectionMutations: Record<string, string | null> | undefined
      ) => {
        for (const k of Object.keys(after)) {
          const changed = after[k] !== before[k];
          // Untouched folder defaults and data-row values stay in their own
          // scope (a row value must not outlive its iteration).
          if ((k in folderVars || k in row) && !changed) continue;
          allVars[k] = after[k]!;
          if (changed && !(collectionMutations && k in collectionMutations)) {
            scriptOverrides[k] = after[k]!;
          }
        }
        for (const k of Object.keys(collectionMutations ?? {})) {
          delete scriptOverrides[k];
          delete carriedOverrides[k];
        }
      };
      const allAssertions: Array<{ name: string; passed: boolean; error?: string }> = [];
      let scriptError: string | undefined;
      let preResult: RunScriptResult | undefined;
      let testResult: RunScriptResult | undefined;

      const runCtx = {
        collectionVars,
        iterationData: row,
        iteration: iter,
        iterationCount: iterations.length,
      };

      // The item actually sent: a gRPC pre-request script may edit metadata.
      let sendItem = item;
      if (preScript) {
        try {
          const preVars = perRequestVars;
          const pre = await runPreRequestScript(preScript, item, perRequestVars, runCtx);
          preResult = pre;
          sendItem = applyPreRequestMetadata(item, pre, preVars);
          perRequestVars = pre.variables;
          writeBack(preVars, pre.variables, pre.collectionMutations);
          applyCollectionMutations(pre.collectionMutations);
          if (pre.errors.length > 0) scriptError = `pre-request: ${pre.errors.join('; ')}`;
          if (pre.assertions.length > 0) allAssertions.push(...pre.assertions);
        } catch (err) {
          scriptError = `pre-request: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      if (preResult?.execution?.skipRequested) {
        // `pm.execution.skipRequest()`: Postman sends nothing and runs no test
        // script; the request is a pass unless the pre-request script failed.
        const result: RequestRunResult = {
          request: item,
          status: 0,
          passed: scriptError === undefined && allAssertions.every((a) => a.passed),
          durationMs: 0,
          bodyBytes: 0,
          skipped: true,
          ...(scriptError !== undefined ? { errorMessage: scriptError } : {}),
          ...(allAssertions.length > 0 ? { assertions: allAssertions } : {}),
          ...(isDataDriven ? { iteration: iter } : {}),
        };
        results.push(result);
        await reporter.onRequestComplete?.(result);
        if (!result.passed && options.bail) {
          bailed = true;
          break iterationLoop;
        }
        const skipNext = preResult.execution.nextRequest;
        if (skipNext === null) break;
        if (typeof skipNext === 'string' && indexByName[skipNext] !== undefined) {
          if (++jumps > MAX_NEXT_REQUEST_JUMPS) break;
          idx = indexByName[skipNext]!;
          continue;
        }
        idx++;
        continue;
      }

      sentAny = true;
      const outcome = await withRetry(
        () =>
          executeRequest(sendItem, {
            vars: perRequestVars,
            timeoutMs: options.timeoutMs,
            allowLocalhost: options.allowLocalhost,
            ...(options.sseDurationMs !== undefined
              ? { sseDurationMs: options.sseDurationMs }
              : {}),
            ...(options.sseMaxEvents !== undefined ? { sseMaxEvents: options.sseMaxEvents } : {}),
            ...(dispatcher ? { dispatcher } : {}),
            ...(options.tls ? { tls: options.tls } : {}),
            ...(options.proxy ? { proxy: options.proxy } : {}),
            mcpSessions,
            ...(options.externalSecretResolver
              ? { externalSecretResolver: options.externalSecretResolver }
              : {}),
          }),
        retry
      );

      if (testScript) {
        try {
          const test = await runTestScript(testScript, sendItem, outcome, perRequestVars, runCtx);
          testResult = test;
          writeBack(perRequestVars, test.variables, test.collectionMutations);
          applyCollectionMutations(test.collectionMutations);
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
      // A protocol-level failure (MCP JSON-RPC error / tool isError) is the
      // reason an unasserted item failed; assertions override it.
      const failureReason =
        outcome.errorMessage ??
        (allAssertions.length === 0 && !passed ? outcome.protocolError : undefined);

      const result: RequestRunResult = {
        request: item,
        status: outcome.status,
        passed,
        durationMs: outcome.durationMs,
        bodyBytes: outcome.bodyBytes,
        ...(outcome.responseHeaders ? { responseHeaders: outcome.responseHeaders } : {}),
        ...(outcome.setCookies ? { setCookies: outcome.setCookies } : {}),
        ...(failureReason !== undefined
          ? {
              errorMessage: scriptError ? `${failureReason}; ${scriptError}` : failureReason,
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
    Object.assign(carriedOverrides, scriptOverrides);
  }

  const notSent = results.filter((r) => r.notSent).length;
  const skipped = results.filter((r) => r.skipped).length;
  const summary: RunResult['summary'] = {
    total: results.length,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed && !r.errorMessage).length,
    errored: results.filter((r) => r.errorMessage !== undefined).length,
    ...(notSent > 0 ? { notSent } : {}),
    ...(skipped > 0 ? { skipped } : {}),
  };

  const final: RunResult = {
    meta: {
      ...meta,
      ...(isDataDriven ? { iteration: iterations.length } : {}),
    },
    durationMs: Date.now() - meta.startedAt,
    requests: results,
    summary,
    ...(loaded.importReport ? { importReport: loaded.importReport } : {}),
  };
  await reporter.onEnd(final);
  return final;
}

function assertCliSecretsAvailable(
  requests: readonly { request: unknown }[],
  vars: Record<string, string>,
  privateNames: ReadonlySet<string>
): void {
  for (const { request } of requests) {
    const text = JSON.stringify(request);
    for (const match of text.matchAll(/\{\{\s*([^{}\s]+)\s*\}\}/g)) {
      const name = match[1];
      if (!name || name.startsWith('$')) continue;
      if (name.startsWith('handle:')) {
        throw new Error(
          'SecretRef handles are unavailable in the CLI; provide the value with --env.'
        );
      }
      if (privateNames.has(name) && vars[name] === undefined) {
        throw new Error(
          `Private variable "${name}" is unavailable in the CLI; provide it with --env.`
        );
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
