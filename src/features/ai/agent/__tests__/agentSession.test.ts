import { describe, expect, it } from 'vitest';
import {
  AGENT_MAX_STEPS,
  isAgentActive,
  isAgentTerminal,
  onAgentApplied,
  onAgentError,
  onAgentStopped,
  onAgentTurnComplete,
  startAgentSession,
} from '../agentSession';

describe('agentSession state machine', () => {
  it('starts running with zero steps', () => {
    const s = startAgentSession('make it pass');
    expect(s.status).toBe('running');
    expect(s.stepCount).toBe(0);
    expect(s.maxSteps).toBe(AGENT_MAX_STEPS);
    expect(isAgentActive(s)).toBe(true);
  });

  it('awaits apply when a turn proposes a tool call', () => {
    let s = startAgentSession('goal');
    s = onAgentTurnComplete(s, true);
    expect(s.status).toBe('awaiting-apply');
    expect(isAgentActive(s)).toBe(true);
  });

  it('completes when a turn proposes no tool call', () => {
    let s = startAgentSession('goal');
    s = onAgentTurnComplete(s, false);
    expect(s.status).toBe('done');
    expect(isAgentTerminal(s)).toBe(true);
    expect(isAgentActive(s)).toBe(false);
  });

  it('returns to running after an apply below the cap', () => {
    let s = startAgentSession('goal', 3);
    s = onAgentTurnComplete(s, true);
    s = onAgentApplied(s);
    expect(s.status).toBe('running');
    expect(s.stepCount).toBe(1);
  });

  it('hard-stops at the step cap', () => {
    let s = startAgentSession('goal', 2);
    // step 1
    s = onAgentTurnComplete(s, true);
    s = onAgentApplied(s);
    expect(s.status).toBe('running');
    // step 2 reaches the cap
    s = onAgentTurnComplete(s, true);
    s = onAgentApplied(s);
    expect(s.status).toBe('max-steps');
    expect(s.stepCount).toBe(2);
    expect(isAgentTerminal(s)).toBe(true);
  });

  it('ignores apply when not awaiting one', () => {
    const s = startAgentSession('goal');
    expect(onAgentApplied(s)).toEqual(s); // still running, no pending step
  });

  it('stop and error are terminal and ignore late events', () => {
    let s = startAgentSession('goal');
    s = onAgentStopped(s);
    expect(s.status).toBe('stopped');
    // a late turn-complete must not revive it
    expect(onAgentTurnComplete(s, true).status).toBe('stopped');
    expect(onAgentError(s).status).toBe('stopped'); // already terminal
  });

  it('error transition from an active state', () => {
    let s = startAgentSession('goal');
    s = onAgentError(s);
    expect(s.status).toBe('error');
    expect(isAgentTerminal(s)).toBe(true);
  });
});
