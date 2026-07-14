import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ComboboxInput } from '../ComboboxInput';

// Radix Popover uses @floating-ui which calls `new ResizeObserver(...)`. The
// shared tests/setup.ts mocks it via vi.fn().mockImplementation(() => ({...}))
// — that fails under `new` (arrow function is not a constructor). Override
// with a class locally so jsdom mounts Popover content without throwing.
beforeAll(() => {
  class LocalResizeObserver {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  }
  (globalThis as unknown as { ResizeObserver: typeof LocalResizeObserver }).ResizeObserver =
    LocalResizeObserver;
});

const SUGGESTIONS = [
  { value: 'Content-Type', description: 'Media type of the request body' },
  { value: 'Content-Length' },
  { value: 'Authorization', description: 'Authentication credentials' },
  { value: 'Cache-Control' },
];

describe('ComboboxInput', () => {
  it('opens a listbox on focus and shows the full suggestion list when empty', () => {
    render(<ComboboxInput value="" onChange={() => {}} suggestions={SUGGESTIONS} />);
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('option', { name: /Content-Type/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Authorization/i })).toBeInTheDocument();
  });

  it('filters options by case-insensitive substring of the current value', () => {
    const { rerender } = render(
      <ComboboxInput value="" onChange={() => {}} suggestions={SUGGESTIONS} />
    );
    fireEvent.focus(screen.getByRole('combobox'));
    rerender(<ComboboxInput value="cont" onChange={() => {}} suggestions={SUGGESTIONS} />);
    expect(screen.getByRole('option', { name: /Content-Type/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Content-Length/i })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Authorization/i })).not.toBeInTheDocument();
  });

  it('calls onChange + onSelectSuggestion when a suggestion is clicked', () => {
    const onChange = vi.fn();
    const onSelectSuggestion = vi.fn();
    render(
      <ComboboxInput
        value=""
        onChange={onChange}
        onSelectSuggestion={onSelectSuggestion}
        suggestions={SUGGESTIONS}
      />
    );
    fireEvent.focus(screen.getByRole('combobox'));
    const option = screen.getByRole('option', { name: /Content-Type/i });
    fireEvent.mouseDown(option);
    expect(onChange).toHaveBeenCalledWith('Content-Type');
    expect(onSelectSuggestion).toHaveBeenCalledWith(
      expect.objectContaining({ value: 'Content-Type' })
    );
  });

  it('accepts free-form values (typing a non-suggestion still calls onChange)', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ComboboxInput value="" onChange={onChange} suggestions={SUGGESTIONS} />);
    const input = screen.getByRole('combobox');
    await user.type(input, 'X-Custom');
    // Every keystroke calls onChange with the cumulative value the parent should set;
    // userEvent simulates one event per char.
    expect(onChange).toHaveBeenCalled();
    const lastCall = onChange.mock.calls.at(-1)?.[0];
    expect(lastCall).toBe('m'); // last character only — confirms uncontrolled-style passthrough
  });

  it('ArrowDown / Enter selects the highlighted item', () => {
    const onChange = vi.fn();
    render(<ComboboxInput value="" onChange={onChange} suggestions={SUGGESTIONS} />);
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    // After two ArrowDowns we land on the third entry (index 2 = Authorization);
    // initial activeIdx is 0 and first ArrowDown moves to 1, second to 2.
    expect(onChange).toHaveBeenCalledWith('Authorization');
  });

  it('Escape closes the popover', () => {
    render(<ComboboxInput value="" onChange={() => {}} suggestions={SUGGESTIONS} />);
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    expect(input).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input).toHaveAttribute('aria-expanded', 'false');
  });

  it('does not open when there are zero matching suggestions', () => {
    render(<ComboboxInput value="ZzzZzz" onChange={() => {}} suggestions={SUGGESTIONS} />);
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    expect(input).toHaveAttribute('aria-expanded', 'false');
  });
});
