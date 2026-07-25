import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EnvironmentUsageHints } from '../EnvironmentUsageHints';

describe('EnvironmentUsageHints', () => {
  it('switches syntax guidance while preserving tab semantics', () => {
    render(<EnvironmentUsageHints />);

    expect(screen.getByRole('tab', { name: '{{variable}}' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(screen.getByText(/missing variables surface as inline warnings/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: '{{$dynamic}}' }));

    expect(screen.getByRole('tab', { name: '{{$dynamic}}' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(screen.getByText(/Built-in helpers expand at send time/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Secrets' }));

    expect(screen.getByRole('tab', { name: 'Secrets' })).toHaveAttribute('aria-selected', 'true');
    expect(
      screen.getByText(/value is masked in the UI and in collection exports/i)
    ).toBeInTheDocument();
  });
});
