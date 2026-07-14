import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/shared/telemetry', () => ({
  reportError: vi.fn(),
}));

vi.mock('@/lib/shared/platform', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, isElectron: vi.fn(() => false) };
});

vi.mock('@sentry/electron/renderer', () => ({
  captureException: vi.fn(),
  init: vi.fn(),
}));

import * as SentryRenderer from '@sentry/electron/renderer';
import { isElectron } from '@/lib/shared/platform';
import { reportError } from '@/lib/shared/telemetry';
import { ErrorBoundary } from '../ErrorBoundary';

function Bomb({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error('test render error');
  return <div>ok</div>;
}

let recoverableThrows = true;
function RecoverableBomb() {
  if (recoverableThrows) throw new Error('recoverable error');
  return <div>recovered</div>;
}

beforeEach(() => {
  vi.mocked(isElectron).mockReturnValue(false);
  vi.mocked(reportError).mockClear();
  vi.mocked(SentryRenderer.captureException).mockClear();
  // Suppress React's console.error for expected boundary catches
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('ErrorBoundary', () => {
  it('renders children when no error is thrown', () => {
    render(
      <ErrorBoundary>
        <Bomb shouldThrow={false} />
      </ErrorBoundary>
    );
    expect(screen.getByText('ok')).toBeInTheDocument();
  });

  it('renders fallback UI when a child throws', () => {
    render(
      <ErrorBoundary>
        <Bomb shouldThrow={true} />
      </ErrorBoundary>
    );
    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
  });

  it('calls reportError with source error-boundary when a child throws', () => {
    render(
      <ErrorBoundary>
        <Bomb shouldThrow={true} />
      </ErrorBoundary>
    );
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'error-boundary', message: 'test render error' })
    );
  });

  it('calls onError prop when a child throws', () => {
    const onError = vi.fn();
    render(
      <ErrorBoundary onError={onError}>
        <Bomb shouldThrow={true} />
      </ErrorBoundary>
    );
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'test render error' }),
      expect.anything()
    );
  });

  it('resets and re-renders children successfully after Try Again click', async () => {
    recoverableThrows = true;
    const user = userEvent.setup();
    render(
      <ErrorBoundary>
        <RecoverableBomb />
      </ErrorBoundary>
    );
    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
    recoverableThrows = false;
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(screen.getByText('recovered')).toBeInTheDocument();
  });

  it('renders the custom fallback prop instead of the default UI', () => {
    render(
      <ErrorBoundary fallback={<div>custom error ui</div>}>
        <Bomb shouldThrow={true} />
      </ErrorBoundary>
    );
    expect(screen.getByText('custom error ui')).toBeInTheDocument();
  });

  it('forwards the error to Sentry on Electron when a child throws', async () => {
    vi.mocked(isElectron).mockReturnValue(true);
    render(
      <ErrorBoundary>
        <Bomb shouldThrow={true} />
      </ErrorBoundary>
    );
    // captureException is called inside a void promise — flush microtasks
    await vi.waitFor(() => {
      expect(SentryRenderer.captureException).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'test render error' }),
        expect.objectContaining({ contexts: expect.objectContaining({ react: expect.anything() }) })
      );
    });
  });

  it('does NOT forward to Sentry on web (isElectron false)', async () => {
    vi.mocked(isElectron).mockReturnValue(false);
    render(
      <ErrorBoundary>
        <Bomb shouldThrow={true} />
      </ErrorBoundary>
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(SentryRenderer.captureException).not.toHaveBeenCalled();
  });
});
