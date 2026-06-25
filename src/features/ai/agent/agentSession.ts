/**
 * Pure state machine for Agent Mode — the multi-step, strict-propose-&-apply
 * loop. Kept free of React/IPC so the transition + step-cap logic is unit
 * testable in isolation. The ChatPanel wires the streaming + tool-apply events
 * to these transitions; this module owns ONLY the status/step bookkeeping.
 *
 * Lifecycle for one goal:
 *   start() -> 'running'
 *   (a turn completes)
 *     hadToolCall  -> 'awaiting-apply'   (user must Apply the proposed step)
 *     no tool call -> 'done'             (model signalled completion)
 *   user Applies the step:
 *     under the cap -> 'running'         (caller fires the next turn)
 *     at the cap    -> 'max-steps'       (caller stops; loop is bounded)
 *   user Stops / Dismisses -> 'stopped'
 *   stream error           -> 'error'
 */

/** Maximum number of applied steps before the loop hard-stops. */
export const AGENT_MAX_STEPS = 8;

export type AgentStatus = 'running' | 'awaiting-apply' | 'done' | 'stopped' | 'error' | 'max-steps';

export interface AgentSession {
  goal: string;
  status: AgentStatus;
  /** Number of steps the user has applied so far. */
  stepCount: number;
  maxSteps: number;
}

/** A session is "live" while it is running or waiting on an Apply. */
export function isAgentActive(s: AgentSession | null | undefined): s is AgentSession {
  return !!s && (s.status === 'running' || s.status === 'awaiting-apply');
}

/** Terminal states — the loop has stopped and won't continue on its own. */
export function isAgentTerminal(s: AgentSession | null | undefined): boolean {
  return (
    !!s &&
    (s.status === 'done' ||
      s.status === 'stopped' ||
      s.status === 'error' ||
      s.status === 'max-steps')
  );
}

export function startAgentSession(goal: string, maxSteps: number = AGENT_MAX_STEPS): AgentSession {
  return { goal, status: 'running', stepCount: 0, maxSteps };
}

/**
 * A model turn finished. If it proposed a tool call we wait for the user to
 * apply it; otherwise the model signalled completion.
 */
export function onAgentTurnComplete(s: AgentSession, hadToolCall: boolean): AgentSession {
  if (s.status !== 'running') return s; // ignore late events after stop/error
  return { ...s, status: hadToolCall ? 'awaiting-apply' : 'done' };
}

/**
 * The user applied the pending step. Increment the counter; stop at the cap,
 * otherwise return to 'running' so the caller fires the next turn.
 */
export function onAgentApplied(s: AgentSession): AgentSession {
  if (s.status !== 'awaiting-apply') return s;
  const stepCount = s.stepCount + 1;
  if (stepCount >= s.maxSteps) return { ...s, stepCount, status: 'max-steps' };
  return { ...s, stepCount, status: 'running' };
}

export function onAgentStopped(s: AgentSession): AgentSession {
  if (isAgentTerminal(s)) return s;
  return { ...s, status: 'stopped' };
}

export function onAgentError(s: AgentSession): AgentSession {
  if (isAgentTerminal(s)) return s;
  return { ...s, status: 'error' };
}
