import { fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const recordRuntimeError = vi.fn();
const reportError = vi.fn();
vi.mock('@/lib/shared/bug-report', () => ({
  recordRuntimeError: (...args: unknown[]) => recordRuntimeError(...args),
}));
vi.mock('@/lib/shared/telemetry', () => ({
  reportError: (...args: unknown[]) => reportError(...args),
}));

import { RouteErrorBoundary } from '../RouteErrorBoundary';

let shouldThrow = true;
function Flaky() {
  if (shouldThrow) throw new Error('render exploded');
  return <p>recovered</p>;
}

describe('RouteErrorBoundary', () => {
  beforeEach(() => {
    shouldThrow = true;
    recordRuntimeError.mockClear();
    reportError.mockClear();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('shows an error UI (not the 404 page), reports the crash and can reset', async () => {
    const router = createMemoryRouter([
      { path: '/', element: <Flaky />, errorElement: <RouteErrorBoundary /> },
    ]);
    render(<RouterProvider router={router} />);

    expect(await screen.findByText('Something went wrong')).toBeTruthy();
    expect(screen.queryByText('404')).toBeNull();
    expect(recordRuntimeError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'render exploded' })
    );
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'render exploded' })
    );

    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('recovered')).toBeTruthy();
  });

  it('still renders the not-found page for a 404 route response', async () => {
    const router = createMemoryRouter(
      [{ path: '/', element: <p>home</p>, errorElement: <RouteErrorBoundary /> }],
      {
        initialEntries: ['/missing'],
      }
    );
    render(<RouterProvider router={router} />);

    expect(await screen.findByText('404')).toBeTruthy();
    expect(recordRuntimeError).not.toHaveBeenCalled();
  });
});
