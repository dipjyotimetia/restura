import { act, render, renderHook, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AriaLiveAnnouncerProvider, {
  type AnnouncedConnectionStatus,
  useAnnouncer,
  useConnectionStatusAnnouncements,
  useRequestAnnouncements,
} from '../AriaLiveAnnouncer';

const wrapper = ({ children }: { children: ReactNode }) => (
  <AriaLiveAnnouncerProvider>{children}</AriaLiveAnnouncerProvider>
);

function settle(): void {
  act(() => vi.advanceTimersByTime(100));
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('useAnnouncer', () => {
  it('throws outside the provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => renderHook(() => useAnnouncer())).toThrow(
      'useAnnouncer must be used within AriaLiveAnnouncerProvider'
    );
    spy.mockRestore();
  });

  it('routes polite and assertive messages to their own live regions', () => {
    const { result } = renderHook(() => useAnnouncer(), { wrapper });
    act(() => result.current.announce('saved'));
    settle();
    expect(screen.getByRole('status')).toHaveTextContent('saved');
    expect(screen.getByRole('alert')).toHaveTextContent('');
    act(() => result.current.announce('boom', 'assertive'));
    settle();
    expect(screen.getByRole('alert')).toHaveTextContent('boom');
  });

  it('re-announces an identical message by clearing first', () => {
    const { result } = renderHook(() => useAnnouncer(), { wrapper });
    act(() => result.current.announceSuccess('done'));
    settle();
    act(() => result.current.announceSuccess('done'));
    expect(screen.getByRole('status')).toHaveTextContent('');
    settle();
    expect(screen.getByRole('status')).toHaveTextContent('done');
  });
});

describe('useRequestAnnouncements', () => {
  function setup() {
    return renderHook(() => useRequestAnnouncements(), { wrapper }).result;
  }

  it('announces a sent request politely', () => {
    const r = setup();
    act(() => r.current.announceRequestSent());
    settle();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Status: Request sent, waiting for response'
    );
  });

  it('announces a 2xx as success', () => {
    const r = setup();
    act(() => r.current.announceRequestComplete(201, 42));
    settle();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Request completed successfully with status 201 in 42 milliseconds'
    );
  });

  it('announces a 4xx/5xx assertively as a failure', () => {
    const r = setup();
    act(() => r.current.announceRequestComplete(503, 7));
    settle();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Error: Request failed with status 503 in 7 milliseconds'
    );
  });

  it('announces a 3xx as a neutral status', () => {
    const r = setup();
    act(() => r.current.announceRequestComplete(304, 3));
    settle();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Status: Request completed with status 304 in 3 milliseconds'
    );
  });

  it('announces a transport failure assertively', () => {
    const r = setup();
    act(() => r.current.announceRequestFailed('ECONNREFUSED'));
    settle();
    expect(screen.getByRole('alert')).toHaveTextContent('Error: Request failed: ECONNREFUSED');
  });
});

describe('useConnectionStatusAnnouncements transitions', () => {
  function Probe({ status }: { status: AnnouncedConnectionStatus | undefined }) {
    useConnectionStatusAnnouncements('MQTT', status);
    return null;
  }
  const at = (status: AnnouncedConnectionStatus | undefined) => (
    <AriaLiveAnnouncerProvider>
      <Probe status={status} />
    </AriaLiveAnnouncerProvider>
  );

  it('announces connected and reconnecting, and disconnect after reconnecting', () => {
    const { rerender } = render(at('connecting'));
    rerender(at('connected'));
    settle();
    expect(screen.getByRole('status')).toHaveTextContent('MQTT connected');
    rerender(at('reconnecting'));
    settle();
    expect(screen.getByRole('status')).toHaveTextContent('Status: MQTT reconnecting');
    rerender(at('idle'));
    settle();
    expect(screen.getByRole('status')).toHaveTextContent('Status: MQTT disconnected');
  });

  it('stays silent for a disconnect that never connected, and for undefined', () => {
    const { rerender } = render(at('connecting'));
    rerender(at('disconnected'));
    settle();
    expect(screen.getByRole('status')).toHaveTextContent('');
    rerender(at(undefined));
    settle();
    rerender(at('connecting'));
    settle();
    expect(screen.getByRole('status')).toHaveTextContent('');
    expect(screen.getByRole('alert')).toHaveTextContent('');
  });
});
