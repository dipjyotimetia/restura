import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const networkConsoleProps = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));
vi.mock('@/features/http/components/NetworkConsole', () => ({
  default: (props: Record<string, unknown>) => {
    networkConsoleProps.last = props;
    return <div data-testid="network-console" />;
  },
}));

import { type ConsoleEntry, useConsoleStore } from '@/store/useConsoleStore';
import ConsoleDrawer from '../ConsoleDrawer';

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);

function entry(status: number, ageMs: number, protocol: ConsoleEntry['protocol'] = 'http') {
  return {
    id: `${status}-${ageMs}-${protocol}`,
    timestamp: NOW - ageMs,
    protocol,
    request: { method: 'GET', url: 'https://x', headers: {} },
    response: {
      id: 'r',
      requestId: 'q',
      status,
      statusText: '',
      headers: {},
      body: '',
      size: 0,
      time: 1,
    },
    requestSize: 0,
  } as unknown as ConsoleEntry;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  networkConsoleProps.last = null;
  useConsoleStore.setState({ entries: [], isExpanded: false });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ConsoleDrawer collapsed summary', () => {
  it('shows a zero total and no status classes when empty', () => {
    render(<ConsoleDrawer />);
    expect(screen.getByLabelText('0 total entries')).toHaveTextContent('0');
    expect(screen.queryByText(/last:/)).toBeNull();
    expect(screen.queryByLabelText(/ok$/)).toBeNull();
  });

  it('counts ok / redirect / errored entries and shows the newest status', () => {
    useConsoleStore.setState({
      entries: [entry(201, 2_000), entry(200, 10_000), entry(302, 0), entry(404, 0), entry(0, 0)],
    });
    render(<ConsoleDrawer />);
    expect(screen.getByLabelText('5 total entries')).toBeInTheDocument();
    expect(screen.getByLabelText('2 ok')).toHaveTextContent('2 ok');
    expect(screen.getByLabelText('1 redirect')).toBeInTheDocument();
    expect(screen.getByLabelText('2 errored')).toHaveTextContent('2 err');
    expect(screen.getByText(/last:/)).toHaveTextContent('last: 201 · just now');
  });

  it('labels a network failure as ERR and omits zero classes', () => {
    useConsoleStore.setState({ entries: [entry(0, 30_000)] });
    render(<ConsoleDrawer />);
    expect(screen.getByText(/last:/)).toHaveTextContent('last: ERR · 30s ago');
    expect(screen.queryByLabelText('0 ok')).toBeNull();
    expect(screen.queryByLabelText('0 redirect')).toBeNull();
  });

  it.each([
    [5 * 60_000, '5m ago'],
    [3 * 3_600_000, '3h ago'],
    [2 * 86_400_000, '2d ago'],
  ])('formats a %ims-old last entry as "%s"', (age, label) => {
    useConsoleStore.setState({ entries: [entry(200, age)] });
    render(<ConsoleDrawer />);
    expect(screen.getByText(/last:/)).toHaveTextContent(`last: 200 · ${label}`);
  });

  it('maps gRPC status codes to HTTP-like classes', () => {
    useConsoleStore.setState({ entries: [entry(0, 0, 'grpc')] });
    render(<ConsoleDrawer />);
    expect(screen.getByLabelText('1 ok')).toBeInTheDocument();
  });

  it('expands on click into the NetworkConsole, forwarding only provided props', () => {
    const onClearScripts = vi.fn();
    const tests = [{ name: 't', passed: true }];
    const { unmount } = render(<ConsoleDrawer tests={tests} onClearScripts={onClearScripts} />);
    fireEvent.click(screen.getByRole('button', { name: /Console/ }));
    expect(useConsoleStore.getState().isExpanded).toBe(true);
    expect(screen.getByTestId('network-console')).toBeInTheDocument();
    expect(networkConsoleProps.last).toEqual({ scriptLogs: [], tests, onClearScripts });
    unmount();

    render(<ConsoleDrawer />);
    expect(networkConsoleProps.last).toEqual({ scriptLogs: [] });
  });
});
