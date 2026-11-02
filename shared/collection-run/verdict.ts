/**
 * The Collection run script-phase fold and the verdict: what the pre-request and
 * test phases of one step add up to, and whether the step passed.
 *
 * Hosts send the Request and record the row; this decides the outcome. The two
 * hosts word a failed step differently, which is the explicit `errorStyle`.
 */
import type { NextRequest } from './sequencer';

export interface PhaseAssertion {
  name: string;
  passed: boolean;
  error?: string;
}

/** What one script phase reports, in the shape both hosts normalise to. */
export interface PhaseOutcome {
  /** `pm.test(...)` results. */
  assertions?: readonly PhaseAssertion[] | undefined;
  /** Uncaught script errors. */
  errors?: readonly string[] | undefined;
  /** `pm.execution` flow control. */
  execution?: { nextRequest?: NextRequest; skipRequested?: boolean } | undefined;
}

/** One phase of a step: its outcome, or the error it threw instead of returning one. */
export interface PhaseSlot {
  /** Prefix for this phase's errors when {@link FoldOptions.labelErrors} is set. */
  label: string;
  outcome?: PhaseOutcome | undefined;
  /** The phase threw: it has no outcome, only this message. */
  thrown?: string | undefined;
}

export interface FoldOptions {
  /** Prefix each phase's errors with its label (`pre-request: ...`). */
  labelErrors: boolean;
}

export interface ScriptFold {
  /** Assertions from every phase, in phase order. */
  assertions: PhaseAssertion[];
  /** One entry per phase that failed, or one per error when not labelled. */
  errors: string[];
  /** The errors as one message, or undefined when there are none. */
  errorText: string | undefined;
}

/** Add the phases of one step up: assertions in order, errors collected. */
export function foldScriptPhases(slots: readonly PhaseSlot[], options: FoldOptions): ScriptFold {
  const assertions: PhaseAssertion[] = [];
  const errors: string[] = [];
  for (const slot of slots) {
    if (slot.thrown !== undefined) {
      errors.push(options.labelErrors ? `${slot.label}: ${slot.thrown}` : slot.thrown);
      continue;
    }
    const outcome = slot.outcome;
    if (!outcome) continue;
    assertions.push(...(outcome.assertions ?? []));
    const phaseErrors = (outcome.errors ?? []).filter(Boolean);
    if (phaseErrors.length === 0) continue;
    if (options.labelErrors) errors.push(`${slot.label}: ${phaseErrors.join('; ')}`);
    else errors.push(...phaseErrors);
  }
  return { assertions, errors, errorText: errors.length > 0 ? errors.join('; ') : undefined };
}

/**
 * `pm.execution.skipRequest()`: a skipped step passes unless a script failed or
 * an assertion did. Whether the Protocol honours it is the host's call.
 */
export function skipVerdict(fold: ScriptFold): { passed: boolean } {
  return { passed: fold.errors.length === 0 && fold.assertions.every((a) => a.passed) };
}

export interface VerdictInput {
  /** The Protocol's own success (2xx, gRPC OK, MCP result). */
  protocolPassed: boolean;
  /** A transport-level failure; never a pass, whatever the scripts asserted. */
  transportError?: string | undefined;
  /** Why the Protocol failed when it says so (MCP JSON-RPC error, tool isError). */
  protocolError?: string | undefined;
  fold: ScriptFold;
  /**
   * How a script error and a failure reason combine in the message: `append`
   * keeps both (`reason; script`), `script-wins` shows only the script errors.
   */
  errorStyle: 'append' | 'script-wins';
}

export interface Verdict {
  passed: boolean;
  error?: string;
}

/**
 * Assertions override the Protocol's own verdict; a script error or a transport
 * failure always fails the step. A Protocol failure reason is shown only when
 * nothing was asserted.
 */
export function settleVerdict(input: VerdictInput): Verdict {
  const { fold } = input;
  let passed = input.protocolPassed;
  if (fold.assertions.length > 0) passed = fold.assertions.every((a) => a.passed);
  if (fold.errorText !== undefined) passed = false;
  if (input.transportError !== undefined) passed = false;
  const reason =
    input.transportError ??
    (fold.assertions.length === 0 && !passed ? input.protocolError : undefined);
  let error: string | undefined;
  if (reason === undefined) error = fold.errorText;
  else if (fold.errorText === undefined) error = reason;
  else error = input.errorStyle === 'append' ? `${reason}; ${fold.errorText}` : fold.errorText;
  return { passed, ...(error !== undefined ? { error } : {}) };
}
