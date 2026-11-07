import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Segmented } from './Segmented';

const options = [
  { value: 'a', label: 'A' },
  { value: 'b', label: 'B', title: 'Bee' },
] as const;

describe('Segmented', () => {
  it('changes value on click and arrow keys', () => {
    const onChange = vi.fn();
    render(<Segmented options={options} value="a" onChange={onChange} ariaLabel="Pick" />);
    fireEvent.click(screen.getByRole('radio', { name: 'B' }));
    fireEvent.keyDown(screen.getByRole('radio', { name: 'A' }), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('radio', { name: 'B' })).toHaveAttribute('title', 'Bee');
  });

  it('disabled: radios are disabled, unfocusable and never change', () => {
    const onChange = vi.fn();
    render(<Segmented options={options} value="a" onChange={onChange} ariaLabel="Pick" disabled />);
    expect(screen.getByRole('radiogroup')).toHaveAttribute('aria-disabled', 'true');
    for (const radio of screen.getAllByRole('radio')) {
      expect(radio).toBeDisabled();
      expect(radio).toHaveAttribute('tabindex', '-1');
    }
    fireEvent.click(screen.getByRole('radio', { name: 'B' }));
    fireEvent.keyDown(screen.getByRole('radio', { name: 'A' }), { key: 'ArrowRight' });
    expect(onChange).not.toHaveBeenCalled();
  });
});
