import { describe, expect, it } from 'vitest';
import type { EvalRun } from '../../types';
import { adaptEvalRunReport } from '../reportEnvelope';

const LEGACY_RUN: EvalRun = {
  id: 'legacy',
  evalConfigId: 'eval-1',
  configName: 'Legacy eval',
  startedAt: 10,
  finishedAt: 20,
  status: 'done',
  cells: [],
  totalCells: 0,
};

describe('AI Lab report envelopes', () => {
  it('adapts a legacy eval run on read without changing the stored record', () => {
    const before = structuredClone(LEGACY_RUN);

    expect(adaptEvalRunReport(LEGACY_RUN)).toEqual({
      id: 'legacy',
      kind: 'eval',
      name: 'Legacy eval',
      startedAt: 10,
      finishedAt: 20,
      status: 'passed',
      payload: LEGACY_RUN,
    });
    expect(LEGACY_RUN).toEqual(before);
  });
});
