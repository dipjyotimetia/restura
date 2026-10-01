import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ResponseTestsPanel } from './ResponseTestsPanel';

const base = { success: true, logs: [], errors: [], variables: {} };

describe('ResponseTestsPanel', () => {
  it('shows a how-to empty state when no test script ran', () => {
    render(<ResponseTestsPanel result={undefined} />);
    expect(screen.getByText(/No tests ran/)).toBeInTheDocument();
  });

  it('lists pass/fail results with a summary and failure messages', () => {
    render(
      <ResponseTestsPanel
        result={{
          ...base,
          tests: [
            { name: 'status is 200', passed: true },
            { name: 'has id', passed: false, error: 'expected undefined to exist' },
          ],
        }}
      />
    );
    expect(screen.getByText('1 passed, 1 failed · 2 total')).toBeInTheDocument();
    expect(screen.getByLabelText('Passed')).toBeInTheDocument();
    expect(screen.getByLabelText('Failed')).toBeInTheDocument();
    expect(screen.getByText('expected undefined to exist')).toBeInTheDocument();
  });

  it('does not repeat failed assertions as script errors', () => {
    render(
      <ResponseTestsPanel
        result={{
          ...base,
          errors: ['✗ has id: nope'],
          tests: [{ name: 'has id', passed: false, error: 'nope' }],
        }}
      />
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('surfaces test-script errors even when no assertions were recorded', () => {
    render(<ResponseTestsPanel result={{ ...base, success: false, errors: ['boom'] }} />);
    expect(screen.getByRole('alert')).toHaveTextContent('boom');
  });
});
