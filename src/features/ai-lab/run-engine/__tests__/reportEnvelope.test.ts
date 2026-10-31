import { describe, expect, it } from 'vitest';
import { evalPassOutcome } from '../../lib/evalPassThreshold';
import type { ArenaMatch, ArenaRun, EvalCellResult, EvalRun } from '../../types';
import {
  AiLabReportEnvelopeSchema,
  adaptArenaRunReport,
  adaptEvalRunReport,
  reportChipState,
} from '../reportEnvelope';

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

const cell = (passed: boolean, extra: Partial<EvalCellResult> = {}): EvalCellResult => ({
  caseId: 'c',
  modelRef: { providerConfigId: 'p', model: 'm' },
  output: '',
  ok: true,
  latencyMs: 1,
  cost: null,
  scores: [{ scorerId: 's', kind: 'contains', passed }],
  passed,
  ...extra,
});
const skipped = () => cell(false, { scores: [], notEvaluated: true });
const errored = () => cell(false, { ok: false, error: 'boom', scores: [] });

describe('report status chip state (#1040)', () => {
  it('shows an eval run restored after an app close as interrupted, not cancelled', () => {
    const interrupted = adaptEvalRunReport({
      ...LEGACY_RUN,
      status: 'cancelled',
      interrupted: true,
    });
    expect(reportChipState(interrupted)).toBe('interrupted');
    expect(reportChipState(adaptEvalRunReport({ ...LEGACY_RUN, status: 'cancelled' }))).toBe(
      'cancelled'
    );
    expect(reportChipState(adaptEvalRunReport(LEGACY_RUN))).toBe('passed');
  });
});

describe('eval pass threshold (#1024)', () => {
  it('fails a 0% run instead of reporting passed', () => {
    const run: EvalRun = { ...LEGACY_RUN, passThreshold: 1, cells: [cell(false), cell(false)] };
    expect(adaptEvalRunReport(run).status).toBe('failed');
  });

  it('defaults to 100% of scored cells for new runs', () => {
    const run: EvalRun = { ...LEGACY_RUN, passThreshold: 1, cells: [cell(true), cell(false)] };
    expect(adaptEvalRunReport(run).status).toBe('failed');
    expect(adaptEvalRunReport({ ...run, cells: [cell(true), cell(true)] }).status).toBe('passed');
  });

  it('honours a lower configured threshold', () => {
    const run: EvalRun = { ...LEGACY_RUN, passThreshold: 0.5, cells: [cell(true), cell(false)] };
    expect(adaptEvalRunReport(run).status).toBe('passed');
  });

  it('keeps the stored status of legacy runs that predate the threshold', () => {
    expect(adaptEvalRunReport({ ...LEGACY_RUN, cells: [cell(false)] }).status).toBe('passed');
  });

  it('reports nothing scored as error with a reason', () => {
    const envelope = adaptEvalRunReport({ ...LEGACY_RUN, passThreshold: 1, cells: [skipped()] });
    expect(envelope.status).toBe('error');
    expect(envelope.statusReason).toBe('nothing scored');
  });

  it('does not touch cancelled runs', () => {
    const run: EvalRun = { ...LEGACY_RUN, passThreshold: 1, status: 'cancelled', cells: [] };
    expect(adaptEvalRunReport(run).status).toBe('cancelled');
  });

  describe('evalPassOutcome', () => {
    it('counts errored cells as not passed and excludes skipped cells', () => {
      expect(evalPassOutcome([cell(true), errored(), skipped()], 1)).toEqual({
        status: 'failed',
        passed: 1,
        scored: 2,
      });
      expect(evalPassOutcome([cell(true), skipped()], 1)).toEqual({
        status: 'passed',
        passed: 1,
        scored: 1,
      });
    });

    it('treats an empty run as nothing scored', () => {
      expect(evalPassOutcome([], 1)).toEqual({
        status: 'error',
        reason: 'nothing scored',
        passed: 0,
        scored: 0,
      });
    });

    it('defaults the threshold to 100% and tolerates float rounding', () => {
      expect(evalPassOutcome([cell(true), cell(false)]).status).toBe('failed');
      expect(evalPassOutcome([cell(true), cell(true), cell(false)], 2 / 3).status).toBe('passed');
    });
  });
});

describe('arena report envelopes (#1046)', () => {
  const run = (status: ArenaRun['status'], winners: ArenaMatch['winner'][]): ArenaRun => ({
    id: 'arena-1',
    datasetId: 'ds',
    datasetName: 'Dataset',
    modelKeys: ['p:a', 'p:b'],
    modelLabels: {},
    matches: winners.map((winner) => ({ a: 'p:a', b: 'p:b', winner })),
    startedAt: 1,
    finishedAt: 2,
    status,
  });

  it('maps arena statuses onto the shared report statuses', () => {
    expect(adaptArenaRunReport(run('done', ['a'])).status).toBe('passed');
    expect(adaptArenaRunReport(run('error', ['error'])).status).toBe('error');
    expect(adaptArenaRunReport(run('cancelled', [])).status).toBe('cancelled');
    const partial = adaptArenaRunReport(run('partial', ['a', 'error']));
    expect(partial.status).toBe('failed');
    expect(partial.statusReason).toBe('1 of 2 matches failed');
  });

  it('round-trips through the persisted envelope schema', () => {
    const envelope = adaptArenaRunReport(run('done', ['a', 'tie']));
    expect(AiLabReportEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });

  it('labels an interrupted arena run as interrupted', () => {
    const envelope = adaptArenaRunReport({ ...run('cancelled', []), interrupted: true });
    expect(reportChipState(envelope)).toBe('interrupted');
  });
});
