import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { GrpcDeadlineField } from '../GrpcDeadlineField';

describe('GrpcDeadlineField', () => {
  it('hides the "No deadline" opt-out for unary methods', () => {
    render(<GrpcDeadlineField request={{ methodType: 'unary', timeout: 0 }} onChange={vi.fn()} />);
    expect(screen.queryByLabelText('No deadline')).toBeNull();
    // A unary call never runs without a deadline — 0 shows the default.
    expect(screen.getByLabelText('gRPC request timeout in milliseconds')).toHaveValue(30000);
  });

  it('lets a streaming method opt out of the deadline', () => {
    const onChange = vi.fn();
    render(
      <GrpcDeadlineField
        request={{ methodType: 'server-streaming', timeout: 5000 }}
        onChange={onChange}
      />
    );
    fireEvent.click(screen.getByLabelText('No deadline'));
    expect(onChange).toHaveBeenCalledWith(0);
  });

  it('disables the timeout input while "No deadline" is on, and restores a default when cleared', () => {
    const onChange = vi.fn();
    render(
      <GrpcDeadlineField
        request={{ methodType: 'bidirectional-streaming', timeout: 0 }}
        onChange={onChange}
      />
    );
    expect(screen.getByLabelText('gRPC request timeout in milliseconds')).toBeDisabled();
    expect(screen.getByLabelText('No deadline')).toBeChecked();
    fireEvent.click(screen.getByLabelText('No deadline'));
    expect(onChange).toHaveBeenCalledWith(30000);
  });

  it('lets the user type a multi-digit deadline and only commits (clamped) on blur', () => {
    const onChange = vi.fn();
    render(
      <GrpcDeadlineField request={{ methodType: 'unary', timeout: 30000 }} onChange={onChange} />
    );
    const input = screen.getByLabelText('gRPC request timeout in milliseconds');
    fireEvent.change(input, { target: { value: '' } });
    expect(input).toHaveValue(null);
    fireEvent.change(input, { target: { value: '5' } });
    expect(input).toHaveValue(5);
    fireEvent.change(input, { target: { value: '5000' } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith(5000);
  });

  it('clamps a too-small draft and restores the default for an empty draft on commit', () => {
    const onChange = vi.fn();
    render(
      <GrpcDeadlineField request={{ methodType: 'unary', timeout: 30000 }} onChange={onChange} />
    );
    const input = screen.getByLabelText('gRPC request timeout in milliseconds');
    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith(1000);
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith(30000);
    // Blur without an edit commits nothing.
    onChange.mockClear();
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
  });
});
