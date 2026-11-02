/**
 * The script phase runner: run ONE pre-request or test script and fold what it
 * did back into the caller's scope.
 *
 * Every Protocol (HTTP, gRPC, MCP) and the CLI run scripts the same way: build a
 * sandbox with the right scopes and host, execute, then apply the variable,
 * collection and globals writes and read the flow control (`skipRequest`,
 * `setNextRequest`). That is this module. What differs is the host the sandbox
 * gets, which is the explicit {@link ScriptPhaseHost}: the renderer's (sub-requests,
 * cookie jar, vault, judge, the app's globals) or none (the CLI).
 *
 * The phase result is the shape the Collection run fold reads
 * (`shared/collection-run/verdict.ts`).
 */

import type { PhaseOutcome } from '../collection-run/verdict';
import { applyVarMutations } from '../collections/variable-mutations';
import ScriptExecutor from './script-executor';
import type {
  PmExecutionLocation,
  PmRequestInfo,
  ScriptContext,
  ScriptHostBridges,
  ScriptResult,
} from './script-executor-types';

export type ScriptPhaseName = 'prerequest' | 'test';

/** What a host gives a script: bridges to the outside world, and its globals scope. */
export interface ScriptPhaseHost {
  /** `rs.sendRequest`, `rs.cookies`, `rs.vault`, `rs.judge`. Absent: scripts that call them fail with a clear error. */
  bridges?: ScriptHostBridges | undefined;
  /** The `pm.globals` map to start from. Absent: the host has no globals. */
  globals?: (() => Record<string, string>) | undefined;
  /** Apply `pm.globals` writes. Absent: they are dropped. */
  applyGlobalsMutations?: ((mutations: Record<string, string | null>) => void) | undefined;
}

/** The CLI's host: no bridges (no cookie jar, keychain or sub-request path) and no globals. */
export const NO_SCRIPT_HOST: ScriptPhaseHost = {};

export interface ScriptPhaseInput {
  phase: ScriptPhaseName;
  script: string;
  /** What `rs.request` / `rs.response` expose. */
  request?: ScriptContext['request'];
  response?: ScriptContext['response'];
  /** The variables the script starts with (`pm.variables` / `pm.environment`). */
  envVars: Record<string, string>;
  collectionVars?: Record<string, string> | undefined;
  iterationData?: Record<string, string> | undefined;
  /** `eventName` is set from `phase`. */
  info?: Omit<PmRequestInfo, 'eventName'> | undefined;
  location?: PmExecutionLocation | undefined;
  host: ScriptPhaseHost;
  /**
   * Fold the script's writes into `into` once it finishes: its variables
   * (`on-success` skips a script that failed, `always` keeps partial writes) and
   * its `pm.collectionVariables` writes, so the rest of this request sees them.
   */
  absorb?: { into: Record<string, string>; variables: 'on-success' | 'always' } | undefined;
  /** Runs right after the script, before anything is applied; throw to abandon it (cancellation). */
  afterRun?: (() => void) | undefined;
}

export interface ScriptPhaseResult {
  /** The executor's full result (logs, visualization, request metadata, ...). */
  result: ScriptResult;
  /** The result in the shape the run fold reads. */
  outcome: PhaseOutcome;
  /** `pm.execution.skipRequest()` was called. Whether it is honoured is the caller's call. */
  skipRequested: boolean;
}

export async function runScriptPhase(input: ScriptPhaseInput): Promise<ScriptPhaseResult> {
  const { host } = input;
  const globalVars = host.globals?.();
  const executor = new ScriptExecutor({
    envVars: input.envVars,
    ...(globalVars ? { globalVars } : {}),
    collectionVars: { ...(input.collectionVars ?? {}) },
    iterationData: { ...(input.iterationData ?? {}) },
    info: { ...input.info, eventName: input.phase },
    ...(input.location ? { location: input.location } : {}),
    ...(host.bridges ? { host: host.bridges } : {}),
  });
  const result = await executor.executeScript(input.script, {
    ...(input.request ? { request: input.request } : {}),
    ...(input.response ? { response: input.response } : {}),
  });
  input.afterRun?.();

  const { absorb } = input;
  if (absorb && (result.success || absorb.variables === 'always') && result.variables) {
    Object.assign(absorb.into, result.variables);
  }
  if (result.globalsMutations) host.applyGlobalsMutations?.(result.globalsMutations);
  // The request is built after the pre-request phase, so collection writes must
  // take part in substitution for it as well as for later requests.
  if (absorb && result.collectionMutations)
    applyVarMutations(absorb.into, result.collectionMutations);

  return {
    result,
    outcome: {
      assertions: result.tests ?? [],
      errors: result.errors,
      execution: result.execution,
    },
    skipRequested: result.execution?.skipRequested === true,
  };
}
