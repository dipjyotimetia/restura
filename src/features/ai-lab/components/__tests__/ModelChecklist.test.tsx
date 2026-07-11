import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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
});
