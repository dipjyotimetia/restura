import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ModelChecklist, type ModelChecklistEntry } from '../ModelChecklist';

const MODELS: ModelChecklistEntry[] = Array.from({ length: 12 }, (_, i) => ({
  key: `p1:model-${i}`,
  label: `Model ${i}`,
  group: i < 6 ? 'Local Ollama' : 'OpenRouter',
  id: `model-${i}`,
}));

describe('ModelChecklist', () => {
  it('renders the empty text when there are no models', () => {
    render(
      <ModelChecklist models={[]} selected={new Set()} onToggle={() => {}} emptyText="Nothing" />
    );
    expect(screen.getByText('Nothing')).toBeInTheDocument();
  });

  it('renders an actionable empty state when setup can resolve it', () => {
    render(
      <ModelChecklist
        models={[]}
        selected={new Set()}
        onToggle={() => {}}
        emptyText="No models"
        emptyAction={<button>Open Models</button>}
      />
    );
    expect(screen.getByRole('button', { name: 'Open Models' })).toBeVisible();
  });

  it('groups entries under provider headers', () => {
    render(
      <ModelChecklist models={MODELS} selected={new Set()} onToggle={() => {}} emptyText="" />
    );
    expect(screen.getByText('Local Ollama')).toBeInTheDocument();
    expect(screen.getByText('OpenRouter')).toBeInTheDocument();
  });

  it('filters by label/id and select-all applies to the filtered subset', () => {
    const onChangeSelected = vi.fn();
    render(
      <ModelChecklist
        models={MODELS}
        selected={new Set()}
        onToggle={() => {}}
        onChangeSelected={onChangeSelected}
        emptyText=""
      />
    );
    fireEvent.change(screen.getByLabelText('Filter models'), { target: { value: 'Model 1' } });
    // "Model 1", "Model 10", "Model 11" match.
    expect(screen.queryByText('Model 2')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Select matching'));
    const next = onChangeSelected.mock.calls[0]![0] as Set<string>;
    expect([...next].sort()).toEqual(['p1:model-1', 'p1:model-10', 'p1:model-11']);
  });

  it('shows the selection count', () => {
    render(
      <ModelChecklist
        models={MODELS}
        selected={new Set(['p1:model-3'])}
        onToggle={() => {}}
        emptyText=""
      />
    );
    expect(screen.getByText('1 of 12 selected')).toBeInTheDocument();
  });

  it('renders all discovery metadata formats and tolerates invalid values', () => {
    const models: ModelChecklistEntry[] = [
      {
        key: 'rich',
        label: 'Rich model',
        id: 'provider/rich-model',
        detail: {
          parameterSize: '3.2B',
          quantizationLevel: 'Q4_K_M',
          contextLength: 1_500_000,
          modality: 'text+image→text',
          vendor: 'vendor',
          createdAt: '2026-07-13T00:00:00Z',
        },
      },
      { key: 'million', label: 'Million', detail: { contextLength: 2_000_000 } },
      { key: 'thousand', label: 'Thousand', detail: { contextLength: 32_000 } },
      { key: 'small', label: 'Small', detail: { contextLength: 512 } },
      {
        key: 'invalid',
        label: 'Invalid',
        id: 'provider/invalid',
        detail: { contextLength: Number.NaN, createdAt: 'not-a-date' },
      },
    ];

    render(
      <ModelChecklist models={models} selected={new Set()} onToggle={() => {}} emptyText="" />
    );

    for (const text of [
      '3.2B',
      'Q4_K_M',
      '1.5M ctx',
      'text+image→text',
      'vendor',
      '2026-07-13',
      '2M ctx',
      '32K ctx',
      '512 ctx',
    ]) {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
  });

  it('shows no-match state, clears selections, and finds group/id matches', () => {
    const onChangeSelected = vi.fn();
    render(
      <ModelChecklist
        models={MODELS}
        selected={new Set(['p1:model-1'])}
        onToggle={() => {}}
        onChangeSelected={onChangeSelected}
        emptyText=""
      />
    );

    fireEvent.change(screen.getByLabelText('Filter models'), { target: { value: 'missing' } });
    expect(screen.getByText('No models match “missing”.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Filter models'), { target: { value: 'openrouter' } });
    expect(screen.getByText('Model 11')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onChangeSelected).toHaveBeenLastCalledWith(new Set());
  });

  it('toggles an ungrouped compact entry and safely no-ops bulk selection without a handler', () => {
    const onToggle = vi.fn();
    const compact = Array.from({ length: 9 }, (_, index) => ({
      key: `m-${index}`,
      label: index === 0 ? 'same-id' : `Model ${index}`,
      id: index === 0 ? 'same-id' : `provider/model-${index}`,
    }));
    render(
      <ModelChecklist models={compact} selected={new Set()} onToggle={onToggle} emptyText="" />
    );

    fireEvent.click(screen.getAllByRole('checkbox')[0]!);
    expect(onToggle).toHaveBeenCalledWith('m-0');
    expect(screen.queryByText('__ungrouped')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Select all' })).not.toBeInTheDocument();
  });
});
