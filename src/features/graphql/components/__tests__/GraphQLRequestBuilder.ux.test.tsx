import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest } from '@/types';

const mocks = vi.hoisted(() => ({
  abort: vi.fn(),
  connect: vi.fn(),
  run: vi.fn(),
}));

vi.mock('@/features/registry/useRequestRunner', () => ({
  useRequestRunner: () => ({ run: mocks.run, abort: mocks.abort }),
}));
vi.mock('@/components/shared/CodeEditor', () => ({ default: () => null }));
vi.mock('../GraphQLBodyEditor', () => ({ default: () => null }));
vi.mock('@/features/graphql/lib/subscriptionClient', () => ({
  GraphQLSubscriptionClient: class {
    connect = mocks.connect;
    disconnect = vi.fn();
  },
}));
vi.mock('sonner', () => ({
  toast: {
    dismiss: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    loading: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

import { useGraphQLSchemaStore } from '@/store/useGraphQLSchemaStore';
import { useRequestStore } from '@/store/useRequestStore';
import { useUiStore } from '@/store/useUiStore';
import GraphQLRequestBuilder from '../GraphQLRequestBuilder';

const URL = 'https://api.example/graphql';

function makeRequest(extra: Partial<HttpRequest> = {}): HttpRequest {
  return {
    id: 'req',
    name: 'GQL',
    type: 'http',
    method: 'POST',
    url: URL,
    headers: [{ id: 'h', key: 'x-team', value: 'blue', enabled: true }],
    params: [],
    body: { type: 'graphql', raw: '{ viewer { id } }', graphqlVariables: '{}' },
    auth: { type: 'none' },
    ...extra,
  };
}

const fetchSchema = vi.fn();

function seed(extra: Partial<HttpRequest> = {}, isLoading = false) {
  useRequestStore.setState({
    tabs: [{ id: 'tab', request: makeRequest(extra), isDirty: false }],
    activeTabId: 'tab',
    isLoading,
  });
}

beforeEach(() => {
  vi.mocked(toast.error).mockClear();
  mocks.abort.mockClear();
  mocks.run.mockReset();
  mocks.connect.mockReset();
  fetchSchema.mockReset().mockResolvedValue({
    success: false,
    schema: null,
    error: 'x',
    endpoint: URL,
    timestamp: 1,
  });
  useGraphQLSchemaStore.setState({ schemas: {}, loading: {}, fetchSchema });
});

afterEach(() => {
  vi.useRealTimers();
});

const failed = (error: string) => ({
  [URL]: { success: false, schema: null, error, endpoint: URL, timestamp: Date.now() },
});

describe('GraphQLRequestBuilder — schema UX', () => {
  it('explicit Refresh bypasses the cache (force)', () => {
    useGraphQLSchemaStore.setState({ schemas: failed('boom') });
    seed();
    render(<GraphQLRequestBuilder />);
    fireEvent.click(screen.getByRole('button', { name: /schema/i, pressed: false }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh schema' }));
    expect(fetchSchema).toHaveBeenCalledWith(URL, expect.objectContaining({ force: true }));
  });

  it('shows the introspection error in the explorer and a hint near the editor', () => {
    useGraphQLSchemaStore.setState({ schemas: failed('HTTP 401 Unauthorized') });
    seed();
    render(<GraphQLRequestBuilder />);
    expect(screen.getByText('Introspection failed — autocomplete off')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByRole('alert').textContent).toContain('HTTP 401 Unauthorized');
  });

  it('shows the no-schema hint with an Introspect action', () => {
    useGraphQLSchemaStore.setState({ schemas: failed('nope') });
    seed();
    render(<GraphQLRequestBuilder />);
    fireEvent.click(screen.getByRole('button', { name: 'Introspect schema' }));
    expect(fetchSchema).toHaveBeenCalledWith(URL, expect.objectContaining({ force: true }));
  });

  it('never introspects on its own: opening a tab with a URL sends nothing until Introspect is clicked', async () => {
    // Introspection goes through the real executor with the tab's auth,
    // headers, secrets and cookies, so it must be an explicit user action.
    vi.useFakeTimers();
    seed();
    render(<GraphQLRequestBuilder />);
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(fetchSchema).not.toHaveBeenCalled();
    expect(screen.getByText('No schema — autocomplete off')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Introspect schema' }));
    expect(fetchSchema).toHaveBeenCalledTimes(1);
  });

  it('does not introspect when a result is cached', async () => {
    vi.useFakeTimers();
    useGraphQLSchemaStore.setState({ schemas: failed('cached') });
    seed();
    render(<GraphQLRequestBuilder />);
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(fetchSchema).not.toHaveBeenCalled();
  });
});

describe('GraphQLRequestBuilder — send UX', () => {
  beforeEach(() => {
    useGraphQLSchemaStore.setState({ schemas: failed('none') });
  });

  it('the Send tooltip names the actual HTTP method', () => {
    seed({ method: 'GET' });
    render(<GraphQLRequestBuilder />);
    expect(screen.getByRole('button', { name: /Send GraphQL query/ }).getAttribute('title')).toBe(
      'HTTP GET'
    );
  });

  it('reports the JSON parser message for invalid variables', () => {
    seed({ body: { type: 'graphql', raw: '{ a }', graphqlVariables: '{ bad' } });
    render(<GraphQLRequestBuilder />);
    fireEvent.click(screen.getByRole('button', { name: /Send GraphQL query/ }));
    expect(toast.error).toHaveBeenCalledWith(
      'Invalid JSON in variables',
      expect.objectContaining({ description: expect.stringMatching(/JSON/) })
    );
  });

  it('Cmd/Ctrl+Enter while a query is in flight cancels it', () => {
    seed({}, true);
    render(<GraphQLRequestBuilder />);
    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true });
    expect(mocks.abort).toHaveBeenCalledWith('tab');
  });

  it('Cancel and the in-flight bar each cancel only their own tab', async () => {
    let finishA: (() => void) | undefined;
    mocks.run.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishA ??= () =>
            resolve({
              response: {
                status: 200,
                statusText: 'OK',
                headers: {},
                body: '{}',
                size: 2,
                time: 1,
              },
              durationMs: 1,
            });
        })
    );
    useRequestStore.setState({
      tabs: [
        { id: 'tab-a', request: makeRequest({ id: 'a' }), isDirty: false },
        { id: 'tab-b', request: makeRequest({ id: 'b' }), isDirty: false },
      ],
      activeTabId: 'tab-a',
      isLoading: false,
      loadingTabIds: [],
    });
    useUiStore.setState({ inFlightByTab: {} });
    render(<GraphQLRequestBuilder />);
    fireEvent.click(screen.getByRole('button', { name: /Send GraphQL query/ }));
    act(() => useRequestStore.getState().switchTab('tab-b'));
    fireEvent.click(screen.getByRole('button', { name: /Send GraphQL query/ }));
    await waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(2));

    // B's Cancel button targets B; A's in-flight bar targets A.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel GraphQL query' }));
    expect(mocks.abort).toHaveBeenLastCalledWith('tab-b');
    useUiStore.getState().inFlightByTab['tab-a']?.cancel();
    expect(mocks.abort).toHaveBeenLastCalledWith('tab-a');

    // A settling clears A's spinner and bar only.
    await act(async () => finishA?.());
    expect(useRequestStore.getState().loadingTabIds).toEqual(['tab-b']);
    expect(Object.keys(useUiStore.getState().inFlightByTab)).toEqual(['tab-b']);
  });

  it('Code opens a generator dialog with the endpoint and headers', () => {
    seed();
    render(<GraphQLRequestBuilder />);
    fireEvent.click(screen.getByRole('button', { name: 'Generate code' }));
    const dialog = screen.getByRole('dialog');
    const code = within(dialog).getByLabelText(/Generated cURL code/).textContent ?? '';
    expect(code).toContain(URL);
    expect(code).toContain('x-team: blue');
  });
});

describe('GraphQLRequestBuilder — subscription messages', () => {
  beforeEach(() => {
    useGraphQLSchemaStore.setState({ schemas: failed('none') });
  });

  it('gives the Messages tab search/filter/clear tools and error detail in the toast', async () => {
    seed({
      url: 'wss://api.example/graphql',
      body: { type: 'graphql', raw: 'subscription { tick }', graphqlVariables: '{}' },
    });
    render(<GraphQLRequestBuilder />);
    fireEvent.click(screen.getByRole('button', { name: /Subscribe/ }));
    await waitFor(() => expect(mocks.connect).toHaveBeenCalled());
    const opts = mocks.connect.mock.calls[0]?.[0];
    act(() => {
      opts.onMessage({ id: '1', type: 'data', payload: { tick: 'alpha' }, timestamp: 1 });
      opts.onMessage({ id: '2', type: 'data', payload: { tick: 'beta' }, timestamp: 2 });
    });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search messages' }), {
      target: { value: 'beta' },
    });
    expect(screen.queryByText(/alpha/)).toBeNull();
    expect(screen.getByText(/beta/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear messages' }));
    expect(screen.queryByText(/beta/)).toBeNull();

    act(() => opts.onError(new Error('socket closed: 4401 Unauthorized')));
    expect(toast.error).toHaveBeenCalledWith('Subscription error', {
      description: 'socket closed: 4401 Unauthorized',
    });
  });
});
