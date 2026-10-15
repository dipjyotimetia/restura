import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest, Response } from '@/types';

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  toastError: vi.fn(),
  connect: vi.fn(),
}));

vi.mock('@/features/registry/useRequestRunner', () => ({
  useRequestRunner: () => ({ run: mocks.run, abort: vi.fn() }),
}));
vi.mock('@/components/shared/CodeEditor', () => ({ default: () => null }));
vi.mock('../GraphQLBodyEditor', () => ({ default: () => <div data-testid="query-editor" /> }));
vi.mock('../GraphQLSubscriptionErrors', () => ({ GraphQLSubscriptionErrors: () => null }));
vi.mock('@/features/graphql/lib/subscriptionClient', () => ({
  GraphQLSubscriptionClient: class {
    connect = mocks.connect;
    disconnect = vi.fn();
  },
}));
vi.mock('sonner', () => ({
  toast: {
    dismiss: vi.fn(),
    error: mocks.toastError,
    info: vi.fn(),
    loading: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

import { useGraphQLErrorStore } from '@/features/graphql/store/useGraphQLErrorStore';
import { useRequestStore } from '@/store/useRequestStore';
import GraphQLRequestBuilder from '../GraphQLRequestBuilder';

function request(raw: string): HttpRequest {
  return {
    id: 'req',
    name: 'GQL',
    type: 'http',
    method: 'POST',
    url: 'https://graphql.example',
    headers: [],
    params: [],
    body: { type: 'graphql', raw, graphqlVariables: '{}' },
    auth: { type: 'none' },
  };
}

const errorBody = JSON.stringify({
  data: null,
  errors: [
    { message: 'first', locations: [{ line: 1, column: 3 }], extensions: { code: 'A' } },
    { message: 'second' },
  ],
});

function response(body: string): Response {
  return {
    id: 'resp',
    requestId: 'req',
    status: 200,
    statusText: 'OK',
    headers: {},
    body,
    size: body.length,
    time: 1,
    timestamp: 1,
  };
}

function setRequest(raw: string) {
  useRequestStore.setState({
    tabs: [{ id: 'tab-1', request: request(raw), isDirty: false }],
    activeTabId: 'tab-1',
    isLoading: false,
  });
}

describe('GraphQLRequestBuilder error routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useGraphQLErrorStore.setState({ byTab: {}, focus: null });
  });

  it('publishes errors for the sent query and points the toast at the Errors tab', async () => {
    setRequest('{ boom }');
    mocks.run.mockResolvedValueOnce({ response: response(errorBody) });
    render(<GraphQLRequestBuilder />);

    fireEvent.click(screen.getByRole('button', { name: 'Send GraphQL query' }));
    await screen.findByRole('button', { name: 'Send GraphQL query' });

    const snapshot = useGraphQLErrorStore.getState().byTab['tab-1'];
    expect(snapshot?.query).toBe('{ boom }');
    expect(snapshot?.errors.map((e) => e.message)).toEqual(['first', 'second']);
    expect(mocks.toastError).toHaveBeenCalledWith('GraphQL returned 2 errors', {
      description: 'See the Errors tab in the response panel.',
    });
  });

  it('clears stale errors when a later send succeeds', async () => {
    setRequest('{ ok }');
    useGraphQLErrorStore
      .getState()
      .publish('tab-1', '{ ok }', [{ index: 0, message: 'old', locations: [], path: null }]);
    mocks.run.mockResolvedValueOnce({ response: response('{"data":{"ok":true}}') });
    render(<GraphQLRequestBuilder />);

    fireEvent.click(screen.getByRole('button', { name: 'Send GraphQL query' }));
    await screen.findByRole('button', { name: 'Send GraphQL query' });

    expect(useGraphQLErrorStore.getState().byTab['tab-1']).toBeUndefined();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('publishes errors carried by subscription next payloads', () => {
    const query = 'subscription { tick }';
    setRequest(query);
    render(<GraphQLRequestBuilder />);
    fireEvent.click(screen.getByRole('button', { name: /Subscribe/ }));

    const { onMessage } = mocks.connect.mock.calls[0]![0] as {
      onMessage: (m: unknown) => void;
    };
    act(() => {
      onMessage({ id: 'm1', type: 'data', timestamp: 1, payload: { data: { tick: 1 } } });
    });
    expect(useGraphQLErrorStore.getState().byTab['tab-1']).toBeUndefined();
    act(() => {
      onMessage({
        id: 'm2',
        type: 'data',
        timestamp: 2,
        payload: { data: null, errors: [{ message: 'tick failed', path: ['tick'] }] },
      });
    });
    expect(useGraphQLErrorStore.getState().byTab['tab-1']).toMatchObject({
      query,
      errors: [{ message: 'tick failed', path: ['tick'] }],
    });
  });

  it('switches to the query editor when an errors panel requests a location', () => {
    setRequest('{ a }');
    render(<GraphQLRequestBuilder />);
    fireEvent.click(screen.getByRole('tab', { name: /Headers/ }));
    expect(screen.queryByTestId('query-editor')).toBeNull();
    act(() => {
      useGraphQLErrorStore.getState().focusLocation('tab-1', { line: 1, column: 1 });
    });
    expect(screen.getByTestId('query-editor')).toBeTruthy();
  });
});
