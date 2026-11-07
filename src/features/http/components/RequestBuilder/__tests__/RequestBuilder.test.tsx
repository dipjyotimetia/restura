import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queueAutoSend } from '@/features/http/lib/autoSend';
import { useRequestStore } from '@/store/useRequestStore';
import { useUiStore } from '@/store/useUiStore';
import type { HttpRequest } from '@/types';

type Props = Record<string, unknown>;
const captured = vi.hoisted(() => ({
  urlBar: [] as Props[],
  tabs: [] as Props[],
  codeGen: [] as Props[],
  loadTest: [] as Props[],
}));
const page = vi.hoisted(() => ({
  current: null as null | {
    httpRequest: unknown;
    isLoading: boolean;
    globalSettings: unknown;
    counts: unknown;
    handlers: Record<string, unknown>;
  },
}));

vi.mock('@/features/http/hooks/useHttpRequestPage', () => ({
  useHttpRequestPage: () => page.current,
}));
vi.mock('@/hooks/useVariableStatus', () => ({
  useVariableStatus: () => (name: string) => (name === 'base' ? 'resolved' : 'unresolved'),
}));
vi.mock('@/features/http/components/UrlBar', () => ({
  default: (props: Props) => {
    captured.urlBar.push(props);
    return (
      <div data-testid="url-bar">
        <input aria-label="url input" />
        <button type="button" onClick={props.onOpenCodeGen as () => void}>
          open code
        </button>
      </div>
    );
  },
}));
vi.mock('../RequestBuilderTabs', () => ({
  RequestBuilderTabs: (props: Props) => {
    captured.tabs.push(props);
    return <div data-testid="active-sub-tab">{String(props.activeTab)}</div>;
  },
}));
vi.mock('@/features/http/components/CodeGeneratorDialog', () => ({
  default: (props: Props) => {
    captured.codeGen.push(props);
    return (
      <div data-testid="code-gen">
        <button type="button" onClick={() => (props.onOpenChange as (o: boolean) => void)(false)}>
          close code
        </button>
      </div>
    );
  },
}));
vi.mock('@/features/load-testing/components/LoadTestDialog', () => ({
  default: (props: Props) => {
    captured.loadTest.push(props);
    return (
      <div data-testid="load-test">
        <button type="button" onClick={props.onClose as () => void}>
          close load
        </button>
      </div>
    );
  },
}));

import RequestBuilder from '../index';

const last = <T,>(arr: T[]): T => arr[arr.length - 1] as T;

const request: HttpRequest = {
  id: 'req-1',
  name: 'R',
  type: 'http',
  method: 'GET',
  url: '{{base}}/users/{{missing}}',
  headers: [],
  params: [{ id: 'p', key: 'page', value: '2', enabled: true }],
  body: { type: 'none' },
  auth: { type: 'none' },
};

function setPage(over: Partial<NonNullable<typeof page.current>> = {}) {
  const handlers = {
    sendRequest: vi.fn(),
    cancelRequest: vi.fn(),
    changeMethod: vi.fn(),
    changeUrl: vi.fn(),
    importCurl: vi.fn(),
  };
  page.current = {
    httpRequest: request,
    isLoading: false,
    globalSettings: { timeout: 1 },
    counts: { activeParams: 1, activeHeaders: 0 },
    handlers,
    ...over,
  };
  return handlers;
}

beforeEach(() => {
  useUiStore.setState({ codeGenOpen: false, loadTestOpen: false });
  useRequestStore.setState({ activeTabId: 'tab-1' });
});

afterEach(() => {
  for (const list of Object.values(captured)) list.length = 0;
  page.current = null;
});

describe('RequestBuilder', () => {
  it('renders nothing without an HTTP request', () => {
    setPage({ httpRequest: null });
    const { container } = render(<RequestBuilder />);
    expect(container).toBeEmptyDOMElement();
  });

  it('wires the URL bar with the display URL and unresolved variables', () => {
    const handlers = setPage();
    render(<RequestBuilder />);
    const bar = last(captured.urlBar);
    expect(bar.method).toBe('GET');
    expect(bar.url).toBe('{{base}}/users/{{missing}}?page=2');
    expect(bar.isLoading).toBe(false);
    expect(bar.unresolvedVariables).toEqual(['missing']);
    expect(bar.onSend).toBe(handlers.sendRequest);
    expect(bar.onCancel).toBe(handlers.cancelRequest);
    expect(bar.onPasteCurl).toBe(handlers.importCurl);

    const tabs = last(captured.tabs);
    expect(tabs.request).toBe(request);
    expect(tabs.counts).toEqual({ activeParams: 1, activeHeaders: 0 });
    expect(screen.getByTestId('active-sub-tab')).toHaveTextContent('params');
  });

  it('shows the request description when present', () => {
    setPage({ httpRequest: { ...request, description: 'Lists users' } });
    render(<RequestBuilder />);
    expect(screen.getByText('Lists users')).toHaveAttribute('title', 'Lists users');
  });

  it('switches sub-tabs with Alt+digit, except while typing in an input', () => {
    setPage();
    render(<RequestBuilder />);
    fireEvent.keyDown(window, { code: 'Digit3', altKey: true });
    expect(screen.getByTestId('active-sub-tab')).toHaveTextContent('body');

    fireEvent.keyDown(screen.getByLabelText('url input'), { code: 'Digit6', altKey: true });
    expect(screen.getByTestId('active-sub-tab')).toHaveTextContent('body');

    // Not a shortcut: no Alt.
    fireEvent.keyDown(window, { code: 'Digit2' });
    expect(screen.getByTestId('active-sub-tab')).toHaveTextContent('body');

    act(() => {
      (last(captured.tabs).onTabChange as (t: string) => void)('auth');
    });
    expect(screen.getByTestId('active-sub-tab')).toHaveTextContent('auth');
  });

  it('sends on Cmd/Ctrl+Enter and ignores a bare Enter', () => {
    const handlers = setPage();
    render(<RequestBuilder />);
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(handlers.sendRequest).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'Enter', metaKey: true });
    expect(handlers.sendRequest).toHaveBeenCalledTimes(2);
    expect(handlers.cancelRequest).not.toHaveBeenCalled();
  });

  it('cancels on Cmd/Ctrl+Enter while a request is in flight', () => {
    const handlers = setPage({ isLoading: true });
    render(<RequestBuilder />);
    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true });
    expect(handlers.cancelRequest).toHaveBeenCalledOnce();
    expect(handlers.sendRequest).not.toHaveBeenCalled();
  });

  it('consumes a queued auto-send for the active tab exactly once', () => {
    const handlers = setPage();
    queueAutoSend('tab-1');
    const { unmount } = render(<RequestBuilder />);
    expect(handlers.sendRequest).toHaveBeenCalledOnce();
    unmount();
    render(<RequestBuilder />);
    expect(handlers.sendRequest).toHaveBeenCalledOnce();
  });

  it('does not auto-send a request queued for another tab', () => {
    const handlers = setPage();
    queueAutoSend('other-tab');
    render(<RequestBuilder />);
    expect(handlers.sendRequest).not.toHaveBeenCalled();
  });

  it('opens and closes the code generator through the UI store', async () => {
    setPage();
    render(<RequestBuilder />);
    expect(screen.queryByTestId('code-gen')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'open code' }));
    expect(await screen.findByTestId('code-gen')).toBeInTheDocument();
    expect(useUiStore.getState().codeGenOpen).toBe(true);
    expect(last(captured.codeGen).request).toBe(request);

    await userEvent.click(screen.getByRole('button', { name: 'close code' }));
    expect(useUiStore.getState().codeGenOpen).toBe(false);
    expect(screen.queryByTestId('code-gen')).not.toBeInTheDocument();
  });

  it('shows the load-test dialog when opened from the store and closes it', async () => {
    setPage();
    useUiStore.setState({ loadTestOpen: true });
    render(<RequestBuilder />);
    expect(await screen.findByTestId('load-test')).toBeInTheDocument();
    expect(last(captured.loadTest).request).toBe(request);
    await userEvent.click(screen.getByRole('button', { name: 'close load' }));
    expect(useUiStore.getState().loadTestOpen).toBe(false);
  });

  it('resets the dialog flags on unmount so they cannot reopen stale', () => {
    setPage();
    useUiStore.setState({ codeGenOpen: true, loadTestOpen: true });
    const { unmount } = render(<RequestBuilder />);
    unmount();
    expect(useUiStore.getState()).toMatchObject({ codeGenOpen: false, loadTestOpen: false });
  });
});
