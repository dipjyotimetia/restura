import { describe, expect, it } from 'vitest';
import { evaluateMergeGate, REQUIRED_JOBS } from '../scripts/ci/assert-merge-gate.mjs';

const requiredJobs = [
  'validate',
  'self-host-smoke',
  'electron-smoke',
  'e2e',
  'e2e-extension',
  'e2e-electron',
  'vscode-extension-e2e',
  'docs',
];

const successNeeds = Object.fromEntries(requiredJobs.map((name) => [name, { result: 'success' }]));

describe('CI merge-gate evaluation', () => {
  it('includes the self-hosted Node shipping surface', () => {
    expect(REQUIRED_JOBS).toContain('self-host-smoke');
  });

  it('passes only when every required job succeeds', () => {
    expect(evaluateMergeGate(successNeeds, new Set())).toEqual({ ok: true, errors: [] });
  });

  it.each(['failure', 'cancelled', 'timed_out'])('rejects a %s required job', (result) => {
    const evaluation = evaluateMergeGate({ ...successNeeds, e2e: { result } }, new Set());

    expect(evaluation.ok).toBe(false);
    expect(evaluation.errors).toContain(`e2e: ${result}`);
  });

  it('allows only an explicitly approved skipped job', () => {
    expect(
      evaluateMergeGate(
        { ...successNeeds, 'electron-smoke': { result: 'skipped' } },
        new Set(['electron-smoke'])
      )
    ).toEqual({ ok: true, errors: [] });
    expect(
      evaluateMergeGate({ ...successNeeds, 'electron-smoke': { result: 'skipped' } }, new Set()).ok
    ).toBe(false);
  });

  it('rejects missing required jobs', () => {
    const evaluation = evaluateMergeGate({ validate: { result: 'success' } }, new Set());

    expect(evaluation.ok).toBe(false);
    expect(evaluation.errors).toContain('docs: missing');
  });
});
