import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/shared/StreamingResponseViewer', () => ({
  StreamingResponseViewer: () => <div data-testid="stream-viewer" />,
}));
vi.mock('@/components/shared/ResponseTestsPanel', () => ({
  ResponseTestsPanel: ({ result }: { result?: { tests?: unknown[] } }) => (
    <div data-testid="tests-panel">{result?.tests?.length ?? 0} tests</div>
  ),
}));
vi.mock('@/components/shared/ResponseToolbarButtons', () => ({
  LayoutToggleButton: () => null,
}));

import { useActiveStreamStore } from '@/features/http/store/useActiveStreamStore';
import { useRequestStore } from '@/store/useRequestStore';
import type { HttpRequest } from '@/types';
import { StreamingResponsePanel } from '../StreamingResponsePanel';

const request: HttpRequest = {
  id: 'r',
  name: 'Stream',
  type: 'http',
  method: 'GET',
  url: 'https://example.com/feed',
  headers: [],
  params: [],
  body: { type: 'none' },
  auth: { type: 'none' },
};

const empty: AsyncIterable<never> = {
  async *[Symbol.asyncIterator]() {},
};

function setTab(scriptResult?: unknown) {
  useRequestStore.setState({
    tabs: [{ id: 'tab1', request, isDirty: false, ...(scriptResult ? { scriptResult } : {}) }],
    activeTabId: 'tab1',
  } as never);
}

beforeEach(() => {
  useActiveStreamStore.setState({ cancels: {} });
  setTab();
});

describe('StreamingResponsePanel', () => {
  it('shows Stop only while the tab has a running stream, and Stop stops it', () => {
    const cancel = vi.fn();
    const { rerender } = render(<StreamingResponsePanel events={empty} />);
    expect(screen.queryByRole('button', { name: 'Stop stream' })).toBeNull();

    useActiveStreamStore.getState().start('tab1', cancel);
    rerender(<StreamingResponsePanel events={empty} />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop stream' }));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Stop stream' })).toBeNull();
  });

  it('badges the Tests tab with passed/total and shows the results there', () => {
    setTab({
      test: {
        logs: [],
        errors: [],
        tests: [
          { name: 'a', passed: true },
          { name: 'b', passed: false },
        ],
      },
    });
    render(<StreamingResponsePanel events={empty} />);
    expect(screen.getByTestId('stream-viewer')).toBeInTheDocument();
    expect(screen.queryByTestId('tests-panel')).toBeNull();
    const testsTab = screen.getByText('Tests');
    expect(screen.getByText('1/2')).toBeInTheDocument();
    fireEvent.click(testsTab);
    expect(screen.getByTestId('tests-panel')).toHaveTextContent('2 tests');
  });

  it('has no badge before any test has run', () => {
    render(<StreamingResponsePanel events={empty} />);
    expect(screen.queryByText(/\d+\/\d+/)).toBeNull();
  });
});
