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

describe('Segmented — per-option disabled', () => {
  const opts = [
    { value: 'a', label: 'A' },
    { value: 'b', label: 'B', disabled: true, title: 'Desktop only' },
    { value: 'c', label: 'C' },
  ] as const;

  it('marks the option aria-disabled, keeps its tooltip and ignores clicks', () => {
    const onChange = vi.fn();
    render(<Segmented options={opts} value="a" onChange={onChange} ariaLabel="Pick" />);
    const b = screen.getByRole('radio', { name: 'B' });
    expect(b).toHaveAttribute('aria-disabled', 'true');
    expect(b).toHaveAttribute('title', 'Desktop only');
    fireEvent.click(b);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('arrow keys skip the disabled option in both directions', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <Segmented options={opts} value="a" onChange={onChange} ariaLabel="Pick" />
    );
    fireEvent.keyDown(screen.getByRole('radio', { name: 'A' }), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('c');
    rerender(<Segmented options={opts} value="c" onChange={onChange} ariaLabel="Pick" />);
    fireEvent.keyDown(screen.getByRole('radio', { name: 'C' }), { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith('a');
  });
});
