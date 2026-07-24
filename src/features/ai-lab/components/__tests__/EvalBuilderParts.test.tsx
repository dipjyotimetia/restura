import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { EvalDraft } from '../../store/useAiLabUiStore';
import type { ScorerConfig } from '../../types';
import { EvalDraftEditor } from '../EvalDraftEditor';
import { EvalRunControls } from '../EvalRunControls';
import { ScorerEditor } from '../ScorerEditor';

const DRAFT: EvalDraft = {
  configId: 'eval-1',
  name: 'Live endpoint eval',
  system: 'Be concise.',
  user: 'Call {{endpoint}}.',
  datasetId: '',
  selected: [],
  scorers: [],
  concurrency: 4,
  targetMode: 'http',
};

describe('EvalBuilder parts', () => {
  it('keeps the HTTP-exec warning and forwards durable draft edits', () => {
    const onPatchDraft = vi.fn();
    const onOpenModels = vi.fn();
    render(
      <EvalDraftEditor
        draft={DRAFT}
        savedConfig={undefined}
        savedConfigs={[]}
        evalConfigs={{}}
        datasets={{}}
        checklistEntries={[]}
        selectedSet={new Set()}
        onPatchDraft={onPatchDraft}
        onLoadConfig={() => {}}
        onNew={() => {}}
        onDelete={() => {}}
        onToggleModel={() => {}}
        onChangeSelectedModels={() => {}}
        onOpenModels={onOpenModels}
      />
    );

    expect(screen.getByRole('alert')).toHaveTextContent(/same SSRF guard/i);
    fireEvent.change(screen.getByLabelText('Eval name'), { target: { value: 'Updated' } });
    expect(onPatchDraft).toHaveBeenCalledWith({ name: 'Updated' });
    fireEvent.click(screen.getByRole('button', { name: 'Open Models' }));
    expect(onOpenModels).toHaveBeenCalledOnce();
  });

  it('edits and removes scorer configs without owning the draft state', () => {
    const onChange = vi.fn();
    const scorers: ScorerConfig[] = [{ id: 'contains-1', kind: 'contains', needle: 'old' }];
    render(
      <ScorerEditor
        scorers={scorers}
        modelOptions={[]}
        firstModelRef={undefined}
        onChange={onChange}
      />
    );

    fireEvent.change(screen.getByPlaceholderText('text to find'), { target: { value: 'new' } });
    expect(onChange).toHaveBeenCalledWith([{ id: 'contains-1', kind: 'contains', needle: 'new' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove scorer' }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('renders persisted progress but only exposes Stop while the lifecycle is running', () => {
    const onRun = vi.fn();
    const onStop = vi.fn();
    const onRetrySave = vi.fn();
    const onOpenReport = vi.fn();
    const controls = (
      <EvalRunControls
        running={false}
        progress={{ completed: 2, total: 3, cells: [], done: true }}
        error={null}
        persistenceError="Report persistence failed"
        lastRunId="run-1"
        hasPendingReport
        passCount={1}
        runDisabledReason="Pick a dataset to run."
        onRun={onRun}
        onStop={onStop}
        onRetrySave={onRetrySave}
        onOpenReport={onOpenReport}
      />
    );
    const { rerender } = render(controls);

    expect(screen.getByRole('button', { name: 'Run eval' })).toBeDisabled();
    expect(screen.getByText('2/3')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Retry report save' }));
    fireEvent.click(screen.getByRole('button', { name: 'View report' }));
    expect(onRetrySave).toHaveBeenCalledOnce();
    expect(onOpenReport).toHaveBeenCalledWith('run-1');

    rerender(
      <EvalRunControls
        running
        progress={{ completed: 2, total: 3, cells: [], done: false }}
        error={null}
        persistenceError={null}
        lastRunId={null}
        hasPendingReport={false}
        passCount={1}
        runDisabledReason={null}
        onRun={onRun}
        onStop={onStop}
        onRetrySave={onRetrySave}
        onOpenReport={onOpenReport}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onStop).toHaveBeenCalledOnce();
    expect(onRun).not.toHaveBeenCalled();
  });
});
