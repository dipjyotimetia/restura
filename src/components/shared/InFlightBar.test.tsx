import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRequestStore } from '@/store/useRequestStore';
import { useUiStore } from '@/store/useUiStore';
import { InFlightBar } from './InFlightBar';

describe('InFlightBar', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useRequestStore.setState({
      tabs: [
        {
          id: 'tab-1',
          isDirty: false,
          request: {
            id: 'r',
            name: 'r',
            type: 'http',
            method: 'GET',
            url: '',
            headers: [],
            params: [],
            body: { type: 'none' },
            auth: { type: 'none' },
          },
        },
      ],
      activeTabId: 'tab-1',
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    useUiStore.setState({ inFlight: null });
  });

  it('ticks the elapsed time and cancels the request in flight on this tab', () => {
    const cancel = vi.fn();
    useUiStore.setState({ inFlight: { tabId: 'tab-1', startedAt: Date.now(), cancel } });
    render(<InFlightBar />);
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.getByText(/Waiting for response/)).toHaveTextContent('1.50s');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('stays hidden when nothing is in flight or it belongs to another tab', () => {
    const { container, rerender } = render(<InFlightBar />);
    expect(container).toBeEmptyDOMElement();
    act(() => {
      useUiStore.setState({ inFlight: { tabId: 'other', startedAt: Date.now(), cancel: vi.fn() } });
    });
    rerender(<InFlightBar />);
    expect(container).toBeEmptyDOMElement();
  });
});
