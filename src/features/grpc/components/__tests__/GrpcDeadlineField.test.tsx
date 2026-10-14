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
});
