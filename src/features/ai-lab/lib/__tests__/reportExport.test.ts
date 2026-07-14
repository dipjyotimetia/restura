import { describe, expect, it } from 'vitest';
import type { EvalRun } from '../../types';
import { runToCsv, runToJson, runToMarkdown } from '../reportExport';

const RUN: EvalRun = {
  id: 'run',
  evalConfigId: 'config',
  configName: 'Export suite',
  startedAt: 1,
  finishedAt: 2,
  status: 'done',
  totalCells: 3,
  cells: [
    {
      caseId: 'a',
      modelRef: { providerConfigId: 'p', model: 'alpha' },
      output: 'ok',
      ok: true,
      latencyMs: 10.6,
      cost: 0.01,
      scores: [
        { scorerId: 'exact', kind: 'exact-match', passed: true, score: 0.987 },
        { scorerId: 'contains', kind: 'contains', passed: false },
      ],
      passed: true,
    },
    {
      caseId: 'b',
      modelRef: { providerConfigId: 'p', model: 'alpha' },
      output: '',
      error: 'offline',
      ok: false,
      latencyMs: 20.2,
      cost: null,
      scores: [],
      passed: false,
    },
    {
      caseId: 'c',
      modelRef: { providerConfigId: 'p', model: 'beta' },
      output: 'raw',
      ok: true,
      latencyMs: 5,
      cost: 0,
      scores: [],
      passed: false,
      notEvaluated: true,
    },
  ],
};

describe('AI Lab report exports', () => {
  it('emits complete CSV rows for pass, failure, and unevaluated cells', () => {
    const csv = runToCsv(RUN);

    expect(csv).toContain('caseId,model,passed,notEvaluated,latencyMs,cost,scores,error');
    expect(csv).toContain('exact-match:pass(0.99) contains:fail');
    expect(csv).toContain('offline');
    expect(csv).toContain('c,beta,false,true,5,0');
  });

  it('pretty prints the complete run as JSON', () => {
    expect(JSON.parse(runToJson(RUN))).toEqual(RUN);
    expect(runToJson(RUN)).toContain('\n  "id": "run"');
  });

  it('summarizes only evaluated cells in Markdown and marks every verdict state', () => {
    const markdown = runToMarkdown(RUN);

    expect(markdown).toContain('| alpha | 50% (1/2) |');
    expect(markdown).not.toContain('| beta | 0% (0/0) |');
    expect(markdown).toContain('| a | alpha | ✓ | 11ms | exact-match:✓ contains:✗ |');
    expect(markdown).toContain('| b | alpha | ✗ | 20ms |  |');
    expect(markdown).toContain('| c | beta | — | 5ms |  |');
  });
});
