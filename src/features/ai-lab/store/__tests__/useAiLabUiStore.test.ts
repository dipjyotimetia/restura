import { beforeEach, describe, expect, it } from 'vitest';
import { useAiLabUiStore } from '../useAiLabUiStore';

describe('useAiLabUiStore', () => {
  beforeEach(() => {
    // Reset the singleton between tests (module store, no persist).
    useAiLabUiStore.setState({
      tab: 'playground',
      reportRunId: null,
      reportDrillCaseId: null,
      datasetId: null,
      arenaRunId: null,
    });
    useAiLabUiStore.getState().newEvalDraft();
  });

  it('patches drafts without losing unrelated fields', () => {
    useAiLabUiStore.getState().patchPlaygroundDraft({ system: 'S' });
    useAiLabUiStore.getState().patchPlaygroundDraft({ selected: ['p:m'] });
    const d = useAiLabUiStore.getState().playgroundDraft;
    expect(d.system).toBe('S');
    expect(d.selected).toEqual(['p:m']);
  });

  it('openReport selects the run, clears the drill-down, and switches tabs', () => {
    useAiLabUiStore.getState().setReportDrillCaseId('case-1');
    useAiLabUiStore.getState().openReport('run-1');
    const s = useAiLabUiStore.getState();
    expect(s.tab).toBe('reports');
    expect(s.reportRunId).toBe('run-1');
    expect(s.reportDrillCaseId).toBeNull();
  });

  it('changing the report run always clears the drill-down', () => {
    useAiLabUiStore.getState().setReportDrillCaseId('case-1');
    useAiLabUiStore.getState().setReportRunId('run-2');
    expect(useAiLabUiStore.getState().reportDrillCaseId).toBeNull();
  });

  it('openDataset selects the dataset and switches tabs', () => {
    useAiLabUiStore.getState().openDataset('ds-1');
    const s = useAiLabUiStore.getState();
    expect(s.tab).toBe('datasets');
    expect(s.datasetId).toBe('ds-1');
  });

  it('newEvalDraft mints a fresh config id and resets fields', () => {
    useAiLabUiStore.getState().patchEvalDraft({ name: 'Changed' });
    const before = useAiLabUiStore.getState().evalDraft.configId;
    useAiLabUiStore.getState().newEvalDraft();
    const after = useAiLabUiStore.getState().evalDraft;
    expect(after.configId).not.toBe(before);
    expect(after.name).toBe('My eval');
    expect(after.scorers).toEqual([]);
  });
});
