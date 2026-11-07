import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AriaLiveAnnouncerProvider, {
  type AnnouncedConnectionStatus,
  useConnectionStatusAnnouncements,
} from '../AriaLiveAnnouncer';

function Probe({ status }: { status: AnnouncedConnectionStatus }) {
  useConnectionStatusAnnouncements('WebSocket', status);
  return null;
}

describe('useConnectionStatusAnnouncements', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('announces transitions but not the initial status', () => {
    const { rerender } = render(
      <AriaLiveAnnouncerProvider>
        <Probe status="connected" />
      </AriaLiveAnnouncerProvider>
    );
    act(() => vi.advanceTimersByTime(100));
    expect(screen.getByRole('status')).toHaveTextContent('');

    rerender(
      <AriaLiveAnnouncerProvider>
        <Probe status="disconnected" />
      </AriaLiveAnnouncerProvider>
    );
    act(() => vi.advanceTimersByTime(100));
    expect(screen.getByRole('status')).toHaveTextContent('Status: WebSocket disconnected');

    rerender(
      <AriaLiveAnnouncerProvider>
        <Probe status="error" />
      </AriaLiveAnnouncerProvider>
    );
    act(() => vi.advanceTimersByTime(100));
    expect(screen.getByRole('alert')).toHaveTextContent('Error: WebSocket connection failed');
  });

  it('is a no-op outside the provider', () => {
    expect(() => render(<Probe status="connected" />)).not.toThrow();
  });
});
