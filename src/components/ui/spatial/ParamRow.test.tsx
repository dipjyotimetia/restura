import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ParamRow, type ParamRowData } from './ParamRow';

vi.mock('@/hooks/useVariableStatus', () => ({ useVariableDetails: () => [] }));

const row: ParamRowData = { id: 'r1', enabled: true, key: 'q', value: 'v', description: 'd' };

describe('ParamRow', () => {
  it('edits key, value and description, toggles and removes', () => {
    const onChange = vi.fn();
    const onRemove = vi.fn();
    render(<ParamRow row={row} onChange={onChange} onRemove={onRemove} />);

    fireEvent.change(screen.getByPlaceholderText('key'), { target: { value: 'k2' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...row, key: 'k2' });
    fireEvent.change(screen.getByPlaceholderText('value'), { target: { value: 'v2' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...row, value: 'v2' });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'd2' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...row, description: 'd2' });
    fireEvent.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenLastCalledWith({ ...row, enabled: false });
    fireEvent.click(screen.getByRole('button', { name: 'Remove row' }));
    expect(onRemove).toHaveBeenCalledWith('r1');
  });

  it('overlays {{vars}} in the value with their resolution status', () => {
    const { container } = render(
      <ParamRow
        row={{ ...row, value: '{{known}}-{{gone}}' }}
        onChange={vi.fn()}
        showVariableHighlight
        getStatus={(name) => (name === 'known' ? 'resolved' : 'unresolved')}
      />
    );
    expect(container.querySelector('[data-var="known"]')).toHaveClass('sp-variable');
    expect(container.querySelector('[data-var="gone"]')).toHaveClass('sp-variable-unresolved');
  });

  it('switches the value to a suggestion combobox when suggestions exist for the key', () => {
    render(
      <ParamRow
        row={{ ...row, key: 'Content-Type', value: '' }}
        onChange={vi.fn()}
        keySuggestions={[{ value: 'Content-Type' }]}
        valueSuggestionsFor={(key) => (key === 'Content-Type' ? ['application/json'] : undefined)}
      />
    );
    expect(screen.getAllByRole('combobox').length).toBeGreaterThanOrEqual(1);
  });
});
