import { CLI_SCOPE_POLICY, RunScope } from '@shared/collection-run/scope';
import {
  type IterationHost,
  type IterationRow,
  pickNextRequest,
  resolveIterationRows,
  type StepOutcome,
  sequenceCollectionRun,
} from '@shared/collection-run/sequencer';
import { foldScriptPhases, settleVerdict, skipVerdict } from '@shared/collection-run/verdict';
import type { ExternalSecretResolver } from '@shared/secrets/external-secret-resolver';
import type { HttpRequest } from '@shared/types';
import { lookupVariable } from '@shared/variables/resolver';
import { scanVariableTokens } from '@shared/variables/tokens';
import type { Reporter, RequestRunResult, RunMeta, RunResult } from '../reporters/types.js';
import { type LoadedRequest, loadCollection } from './collectionLoader.js';
import type { CliIterationRow } from './dataLoader.js';
import { executeRequest } from './executors/dispatch.js';
import type { ExecuteOutcome } from './executors/types.js';
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
  const filtered = options.filter ? applyFilters(loaded.requests, options.filter) : loaded.requests;
  const versionWarning = httpVersionWarning(filtered);
  if (versionWarning) process.stderr.write(versionWarning);

  // One iteration (with empty row vars) by default; multiple when --data is set.
  const iterations = resolveIterationRows({
    dataRows: options.iterations,
    maxIterations: options.maxIterations,
  });
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

  // The run-wide variable scope (env, collection, `--env-var`, and the script
  // writes that outlive an iteration), as in Newman and the app's runner: a
  // token fetched in iteration 1 is still set in iteration 2.
  const scope = new RunScope({
    policy: CLI_SCOPE_POLICY,
    environment: options.envVars,
    collection: collectionVars,
    overrides: options.overrideVars,
  });

  const beginIteration = (iter: number, row: IterationRow): IterationHost<LoadedRequest> => {
    const iterScope = scope.beginIteration(row);

    const step = async (item: LoadedRequest): Promise<StepOutcome> => {
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
        return { failed: true, sent: false };
      }

      const preScript = item.request.preRequestScript;
      const testScript = item.request.testScript;
      // Precedence matches the app's runner except where `CLI_SCOPE_POLICY`
      // says otherwise: env + collection < folder vars < `--env-var` < earlier
      // iterations' script writes < iteration row < script writes this iteration.
      let perRequestVars = iterScope.requestVars(item.folderVariables);
      let preResult: RunScriptResult | undefined;
      let testResult: RunScriptResult | undefined;
      let preThrown: string | undefined;
      let testThrown: string | undefined;

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
          iterScope.absorb([
            {
              before: preVars,
              after: pre.variables,
              collectionMutations: pre.collectionMutations,
            },
          ]);
        } catch (err) {
          preResult = undefined;
          preThrown = err instanceof Error ? err.message : String(err);
        }
      }
      const preSlot = { label: 'pre-request', outcome: preResult, thrown: preThrown };

      if (preResult?.execution?.skipRequested) {
        // `pm.execution.skipRequest()`: Postman sends nothing and runs no test
        // script; the request is a pass unless the pre-request script failed.
        const fold = foldScriptPhases([preSlot], { labelErrors: true });
        const result: RequestRunResult = {
          request: item,
          status: 0,
          passed: skipVerdict(fold).passed,
          durationMs: 0,
          bodyBytes: 0,
          skipped: true,
          ...(fold.errorText !== undefined ? { errorMessage: fold.errorText } : {}),
          ...(fold.assertions.length > 0 ? { assertions: fold.assertions } : {}),
          ...(isDataDriven ? { iteration: iter } : {}),
        };
        results.push(result);
        await reporter.onRequestComplete?.(result);
        // Unlike the sent path below, a bad jump from a skipped request is
        // silent: an unknown name advances linearly.
        return {
          failed: !result.passed,
          sent: false,
          next: preResult.execution.nextRequest,
          badJump: 'ignore',
        };
      }

      // A refusal thrown while resolving a value written at run time fails this
      // item; the rest of the run and its report carry on.
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
      ).catch(
        (err: unknown): ExecuteOutcome => ({
          status: 0,
          passed: false,
          durationMs: 0,
          bodyBytes: 0,
          errorMessage: err instanceof Error ? err.message : String(err),
        })
      );

      if (testScript) {
        try {
          const test = await runTestScript(testScript, sendItem, outcome, perRequestVars, runCtx);
          testResult = test;
          iterScope.absorb([
            {
              before: perRequestVars,
              after: test.variables,
              collectionMutations: test.collectionMutations,
            },
          ]);
        } catch (err) {
          testResult = undefined;
          testThrown = err instanceof Error ? err.message : String(err);
        }
      }

      const fold = foldScriptPhases(
        [preSlot, { label: 'test', outcome: testResult, thrown: testThrown }],
        { labelErrors: true }
      );
      // Assertions override the protocol's verdict; a transport-level failure
      // can never be a pass, even if the test script has a response-independent
      // assertion that passed. A protocol-level failure (MCP JSON-RPC error /
      // tool isError) is the reason an unasserted item failed.
      const verdict = settleVerdict({
        protocolPassed: outcome.passed,
        transportError: outcome.errorMessage,
        protocolError: outcome.protocolError,
        fold,
        errorStyle: 'append',
      });
      const allAssertions = fold.assertions;

      const result: RequestRunResult = {
        request: item,
        status: outcome.status,
        passed: verdict.passed,
        durationMs: outcome.durationMs,
        bodyBytes: outcome.bodyBytes,
        ...(outcome.responseHeaders ? { responseHeaders: outcome.responseHeaders } : {}),
        ...(outcome.setCookies ? { setCookies: outcome.setCookies } : {}),
        ...(verdict.error !== undefined ? { errorMessage: verdict.error } : {}),
        ...(outcome.grpcStatus ? { grpcStatus: outcome.grpcStatus } : {}),
        ...(outcome.streamEvents ? { streamEvents: outcome.streamEvents } : {}),
        ...(allAssertions.length > 0 ? { assertions: allAssertions } : {}),
        ...(isDataDriven ? { iteration: iter } : {}),
      };

      results.push(result);
      await reporter.onRequestComplete?.(result);

      return {
        failed: !result.passed,
        sent: true,
        next: pickNextRequest(testResult?.execution, preResult?.execution),
      };
    };

    return {
      onStart: async (item) => {
        await reporter.onRequestStart?.(item);
      },
      step,
      onFlowError: (item, errorMessage) => {
        results.push({
          request: item,
          status: 0,
          passed: false,
          durationMs: 0,
          bodyBytes: 0,
          errorMessage,
          ...(isDataDriven ? { iteration: iter } : {}),
        });
      },
      onEnd: () => iterScope.end(),
    };
  };

  await sequenceCollectionRun(
    {
      items: filtered,
      nameOf: (item) => item.request.name,
      rows: iterations,
      stopOnFailure: options.bail,
      delayMs: options.delayRequestMs,
      delayPlacement: 'before-step-once-sent',
    },
    beginIteration
  );

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

/** Every string in a request, object keys included: a header map can hold a token as a key. */
function* stringLeaves(value: unknown): Generator<string> {
  if (typeof value === 'string') {
    yield value;
  } else if (Array.isArray(value)) {
    for (const entry of value) yield* stringLeaves(entry);
  } else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      yield key;
      yield* stringLeaves(entry);
    }
  }
}

/**
 * The run's only enforcement of the private-name refusal (executors do not pass
 * `resolveVarsDeep` its third argument), so it refuses before anything is sent. It
 * reads a request's own fields; a value a script writes at run time is not on disk
 * and fails that one item instead (see the `executeRequest` call above).
 */
function assertCliSecretsAvailable(
  requests: readonly { request: unknown }[],
  vars: Record<string, string>,
  privateNames: ReadonlySet<string>
): void {
  for (const { request } of requests) {
    for (const text of stringLeaves(request)) {
      if (!text.includes('{{')) continue;
      for (const { name } of scanVariableTokens(text)) {
        if (name.startsWith('$')) continue;
        if (name.startsWith('handle:')) {
          throw new Error(
            'SecretRef handles are unavailable in the CLI; provide the value with --env.'
          );
        }
        if (privateNames.has(name) && lookupVariable([vars], name) === undefined) {
          throw new Error(
            `Private variable "${name}" is unavailable in the CLI; provide it with --env.`
          );
        }
      }
    }
  }
}
