import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '@/components/shared/ErrorBoundary';
import { LazyDialogFallback, lazyComponent } from './lazyComponent';

vi.mock('@/lib/shared/telemetry', () => ({ reportError: vi.fn() }));

function Hello() {
  return <div>loaded</div>;
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('lazyComponent', () => {
  it('retries a failed chunk import before surfacing the error', async () => {
    const importFn = vi
      .fn<() => Promise<{ default: typeof Hello }>>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch dynamically imported module'))
      .mockResolvedValue({ default: Hello });
    const Lazy = lazyComponent(importFn, null, { retryDelayMs: 1 });

    render(<Lazy />);
    expect(await screen.findByText('loaded')).toBeInTheDocument();
    expect(importFn).toHaveBeenCalledTimes(2);
  });

  it('lets the error boundary "Try again" re-import after every retry failed', async () => {
    const user = userEvent.setup();
    let fail = true;
    const importFn = vi.fn(() =>
      fail ? Promise.reject(new TypeError('chunk failed')) : Promise.resolve({ default: Hello })
    );
    const Lazy = lazyComponent(importFn, null, { retries: 1, retryDelayMs: 1 });

    render(
      <ErrorBoundary>
        <Lazy />
      </ErrorBoundary>
    );
    expect(await screen.findByText(/something went wrong/i)).toBeInTheDocument();
    const callsBefore = importFn.mock.calls.length;

    fail = false;
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('loaded')).toBeInTheDocument();
    expect(importFn.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it('exposes a small loading fallback for lazily loaded dialogs', () => {
    render(<LazyDialogFallback />);
    expect(screen.getByRole('status')).toHaveTextContent(/loading/i);
  });
});
