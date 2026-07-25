import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ModelOption } from '../../lib/modelOptions';
import type { EvalDraft } from '../../store/useAiLabUiStore';
import type { ModelRef, ScorerConfig, ScorerKind } from '../../types';
import { EvalDraftEditor } from '../EvalDraftEditor';
import { EvalRunControls } from '../EvalRunControls';
import { ScorerEditor } from '../ScorerEditor';

vi.mock('@/components/ui/select', async () => {
  const React = await import('react');
  const SelectContext = React.createContext<(value: string) => void>(() => {});

  return {
    Select: ({
      children,
      onValueChange,
    }: {
      children: React.ReactNode;
      onValueChange: (value: string) => void;
    }) => React.createElement(SelectContext.Provider, { value: onValueChange }, children),
    SelectContent: ({ children }: { children: React.ReactNode }) =>
      React.createElement('div', null, children),
    SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => {
      const onValueChange = React.useContext(SelectContext);
      return React.createElement(
        'button',
        { type: 'button', role: 'option', onClick: () => onValueChange(value) },
        children
      );
    },
    SelectTrigger: ({ children, ...props }: React.ComponentProps<'button'>) =>
      React.createElement('button', { type: 'button', role: 'combobox', ...props }, children),
    SelectValue: ({ placeholder }: { placeholder?: string }) =>
      React.createElement('span', null, placeholder),
  };
});

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

const FIRST_MODEL: ModelRef = { providerConfigId: 'provider-1', model: 'reasoning:model' };
const MODEL_OPTIONS = [
  {
    key: 'provider-1:reasoning:model',
    label: 'Test provider · Reasoning model',
    model: 'reasoning:model',
    shortLabel: 'Reasoning model',
  },
] as ModelOption[];

const SCORER_OPTION_LABELS: Record<ScorerKind, string> = {
  contains: 'Contains text',
  regex: 'Regex match',
  'exact-match': 'Exact match',
  'json-valid': 'Valid JSON',
  'json-schema': 'JSON schema',
  latency: 'Latency under (ms)',
  cost: 'Cost under (USD)',
  script: 'Script (pm.test)',
  judge: 'LLM-as-judge',
  'tool-call': 'Tool call',
  pairwise: 'Pairwise (vs reference)',
};

function addScorer(kind: ScorerKind) {
  fireEvent.click(screen.getByRole('combobox'));
  fireEvent.click(screen.getByRole('option', { name: SCORER_OPTION_LABELS[kind] }));
}

function StatefulScorerEditor({
  initialScorers,
  onChange,
}: {
  initialScorers: ScorerConfig[];
  onChange: (scorers: ScorerConfig[]) => void;
}) {
  const [scorers, setScorers] = useState(initialScorers);
  return (
    <ScorerEditor
      scorers={scorers}
      modelOptions={MODEL_OPTIONS}
      firstModelRef={FIRST_MODEL}
      onChange={(next) => {
        setScorers(next);
        onChange(next);
      }}
    />
  );
}

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

  it.each([
    ['contains', { needle: '' }],
    ['regex', { pattern: '' }],
    ['exact-match', { expectedFrom: 'expected' }],
    ['json-valid', {}],
    ['json-schema', { schema: '{\n  "type": "object"\n}' }],
    ['latency', { maxMs: 5000 }],
    ['cost', { maxUSD: 0.01 }],
    ['script', { code: expect.stringContaining('pm.response.text()') }],
    [
      'judge',
      {
        judgeModel: FIRST_MODEL,
        criteria: [
          { name: 'correctness', rubric: 'Is the answer correct and complete?', weight: 1 },
        ],
        passThreshold: 0.7,
        samples: 1,
      },
    ],
    ['tool-call', { expectedTool: '', argsSchema: '' }],
    [
      'pairwise',
      { judgeModel: FIRST_MODEL, baseline: 'reference', passThreshold: 0.5, swapPositions: true },
    ],
  ] as Array<
    [ScorerKind, Record<string, unknown>]
  >)('adds a %s scorer with its runnable defaults', (kind, defaults) => {
    const onChange = vi.fn();
    render(
      <ScorerEditor
        scorers={[]}
        modelOptions={MODEL_OPTIONS}
        firstModelRef={FIRST_MODEL}
        onChange={onChange}
      />
    );

    addScorer(kind);

    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ id: expect.any(String), kind, ...defaults }),
    ]);
  });

  it.each([
    'judge',
    'pairwise',
  ] as const)('uses an empty model reference when adding %s without selected models', (kind) => {
    const onChange = vi.fn();
    render(
      <ScorerEditor scorers={[]} modelOptions={[]} firstModelRef={undefined} onChange={onChange} />
    );

    addScorer(kind);

    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({
        kind,
        judgeModel: { providerConfigId: '', model: '' },
      }),
    ]);
  });

  it('updates every non-judge scorer input with the user-entered configuration', () => {
    const onChange = vi.fn();
    render(
      <StatefulScorerEditor
        onChange={onChange}
        initialScorers={[
          { id: 'regex', kind: 'regex', pattern: 'old' },
          { id: 'exact', kind: 'exact-match', expectedFrom: 'expected' },
          { id: 'schema', kind: 'json-schema', schema: '{}' },
          { id: 'latency', kind: 'latency', maxMs: 100 },
          { id: 'cost', kind: 'cost', maxUSD: 1 },
          { id: 'script', kind: 'script', code: 'old script' },
          { id: 'tool', kind: 'tool-call' },
          {
            id: 'pairwise',
            kind: 'pairwise',
            judgeModel: FIRST_MODEL,
            baseline: 'reference',
            passThreshold: 0.5,
          },
        ]}
      />
    );

    fireEvent.change(screen.getByPlaceholderText('pattern'), { target: { value: 'answer\\d+' } });
    fireEvent.click(screen.getByRole('option', { name: 'vs case.reference' }));
    fireEvent.change(screen.getByDisplayValue('{}'), { target: { value: '{"type":"string"}' } });
    fireEvent.change(screen.getByDisplayValue('100'), { target: { value: '0' } });
    fireEvent.change(screen.getByDisplayValue('1'), { target: { value: '0.25' } });
    fireEvent.change(screen.getByDisplayValue('old script'), {
      target: { value: 'pm.test("ok", () => {})' },
    });
    fireEvent.change(screen.getByPlaceholderText(/expected tool name/i), {
      target: { value: 'search' },
    });
    fireEvent.change(screen.getByPlaceholderText(/args JSON schema/i), {
      target: { value: '{"type":"object"}' },
    });
    fireEvent.click(screen.getByRole('option', { name: 'Test provider · Reasoning model' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /swap positions/i }));

    expect(onChange).toHaveBeenLastCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ id: 'regex', pattern: 'answer\\d+' }),
        expect.objectContaining({ id: 'exact', expectedFrom: 'reference' }),
        expect.objectContaining({ id: 'schema', schema: '{"type":"string"}' }),
        expect.objectContaining({ id: 'latency', maxMs: 0 }),
        expect.objectContaining({ id: 'cost', maxUSD: 0.25 }),
        expect.objectContaining({ id: 'script', code: 'pm.test("ok", () => {})' }),
        expect.objectContaining({
          id: 'tool',
          expectedTool: 'search',
          argsSchema: '{"type":"object"}',
        }),
        expect.objectContaining({ id: 'pairwise', judgeModel: FIRST_MODEL, swapPositions: true }),
      ])
    );
  });

  it('edits judge criteria and constrains self-consistency samples to supported bounds', () => {
    const onChange = vi.fn();
    render(
      <StatefulScorerEditor
        onChange={onChange}
        initialScorers={[
          {
            id: 'judge',
            kind: 'judge',
            judgeModel: FIRST_MODEL,
            criteria: [{ name: 'accuracy', rubric: 'Is it right?', weight: 1 }],
            passThreshold: 0.7,
          },
        ]}
      />
    );

    fireEvent.change(screen.getByPlaceholderText('criterion name'), {
      target: { value: 'safety' },
    });
    fireEvent.change(screen.getByPlaceholderText('rubric for this criterion'), {
      target: { value: 'Does not cause harm?' },
    });
    fireEvent.change(screen.getByTitle('weight in the aggregate score'), {
      target: { value: '0' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /gate/i }));
    fireEvent.click(screen.getByRole('button', { name: /add criterion/i }));
    expect(screen.getAllByPlaceholderText('criterion name')).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove criterion' })[1]!);
    fireEvent.change(screen.getByLabelText(/pass ≥/i), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('samples'), { target: { value: '7' } });
    expect(screen.getByText('×5 judge calls per cell (self-consistency).')).toBeVisible();
    fireEvent.change(screen.getByLabelText('samples'), { target: { value: '0' } });

    expect(onChange).toHaveBeenLastCalledWith([
      expect.objectContaining({
        id: 'judge',
        passThreshold: 0,
        samples: 1,
        criteria: [{ name: 'safety', rubric: 'Does not cause harm?', weight: 1, gate: true }],
      }),
    ]);
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
