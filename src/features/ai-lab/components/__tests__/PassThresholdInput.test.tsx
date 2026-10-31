import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { PassThresholdInput } from '../EvalDraftEditor';

function Harness({ onChange }: { onChange: (pct: number) => void }) {
  const [pct, setPct] = useState(100);
  return (
    <PassThresholdInput
      value={pct}
      onChange={(next) => {
        setPct(next);
        onChange(next);
      }}
    />
  );
}

const input = () => screen.getByTestId('eval-pass-threshold') as HTMLInputElement;

describe('PassThresholdInput', () => {
  it('lets the field be cleared and retyped without snapping back', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.change(input(), { target: { value: '' } });
    expect(input().value).toBe('');
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(input(), { target: { value: '70' } });
    expect(onChange).toHaveBeenLastCalledWith(70);
    expect(input().value).toBe('70');
  });

  it('clamps 0 and over-range values on blur', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.change(input(), { target: { value: '0' } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(input());
    expect(onChange).toHaveBeenLastCalledWith(1);
    expect(input().value).toBe('1');
    fireEvent.change(input(), { target: { value: '250' } });
    fireEvent.blur(input());
    expect(onChange).toHaveBeenLastCalledWith(100);
    expect(input().value).toBe('100');
  });

  it('restores the last valid value when blurred empty', () => {
    render(<Harness onChange={vi.fn()} />);
    fireEvent.change(input(), { target: { value: '' } });
    fireEvent.blur(input());
    expect(input().value).toBe('100');
  });
});
