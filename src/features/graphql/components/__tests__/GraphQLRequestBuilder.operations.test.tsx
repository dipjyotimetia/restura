import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GraphQLOperationInfo } from '@/features/graphql/lib/operationSelection';
import type { HttpRequest } from '@/types';

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
}));

vi.mock('@/features/registry/useRequestRunner', () => ({
  useRequestRunner: () => ({ run: mocks.run, abort: vi.fn() }),
}));

vi.mock('@/features/graphql/lib/subscriptionClient', () => ({
  GraphQLSubscriptionClient: class {
    connect = mocks.connect;
    disconnect = mocks.disconnect;
  },
}));

vi.mock('@/components/shared/CodeEditor', () => ({ default: () => null }));

// Stand-in body editor: exposes the picker / run-at-cursor callbacks the
// builder wires, without Monaco.
vi.mock('../GraphQLBodyEditor', async () => {
  const { listGraphQLOperations } = await import('@shared/graphql/operations');
  return {
    default: ({
      query,
      operationName,
      onSelectOperation,
      onRunAtCursor,
    }: {
      query: string;
      operationName?: string | null;
      onSelectOperation?: (op: GraphQLOperationInfo) => void;
      onRunAtCursor?: (offset: number) => void;
    }) => (
      <div>
        <span data-testid="editor-op">{operationName ?? ''}</span>
        {listGraphQLOperations(query).operations.map((op) => (
          <button key={op.start} type="button" onClick={() => onSelectOperation?.(op)}>
            pick {op.name}
          </button>
        ))}
        <button type="button" onClick={() => onRunAtCursor?.(query.indexOf('tick'))}>
          run at tick
        </button>
        <button type="button" onClick={() => onRunAtCursor?.(query.indexOf('rename'))}>
          run at rename
        </button>
      </div>
    ),
  };
});

vi.mock('sonner', () => ({
  toast: { dismiss: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

import { useRequestStore } from '@/store/useRequestStore';
import GraphQLRequestBuilder from '../GraphQLRequestBuilder';

const DOC = [
  'query GetUser($id: ID!) { user(id: $id) { id } }',
  'mutation Rename($id: ID!, $name: String!) { rename(id: $id, name: $name) { id } }',
  'subscription Ticks { tick { n } }',
].join('\n');

function seed(body: Partial<HttpRequest['body']> = {}) {
  const request: HttpRequest = {
    id: 'r',
    name: 'Ops',
    type: 'http',
    method: 'POST',
    url: 'https://graphql.example',
    headers: [],
    params: [],
    body: { type: 'graphql', raw: DOC, graphqlVariables: '{"id":"7"}', ...body },
    auth: { type: 'none' },
  };
  useRequestStore.setState({
    tabs: [{ id: 'tab', request, isDirty: false }],
    activeTabId: 'tab',
    isLoading: false,
  });
}

const storedBody = () => (useRequestStore.getState().getActiveTab()?.request as HttpRequest).body;
const sentEnvelope = () =>
  JSON.parse((mocks.run.mock.calls.at(-1)?.[0] as HttpRequest).body.raw ?? '{}') as Record<
    string,
    unknown
  >;

describe('GraphQLRequestBuilder — operation picker + transport (#903)', () => {
  beforeEach(() => {
    mocks.run.mockReset();
    mocks.run.mockResolvedValue({
      response: {
        id: 'x',
        requestId: 'r',
        status: 200,
        statusText: 'OK',
        headers: {},
        body: '{"data":{}}',
        size: 1,
        time: 1,
        timestamp: 0,
      },
    });
    mocks.connect.mockReset();
    mocks.disconnect.mockReset();
  });

  it('sends the first operation by default with its operationName', async () => {
    seed();
    render(<GraphQLRequestBuilder />);
    expect(screen.getByRole('button', { name: 'Send GraphQL query' }).textContent).toContain(
      'Run query'
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send GraphQL query' }));
    });
    expect(sentEnvelope()).toMatchObject({ operationName: 'GetUser', variables: { id: '7' } });
  });

  it('persists the picked operation, scopes variables and relabels the send button', async () => {
    seed();
    render(<GraphQLRequestBuilder />);
    fireEvent.click(screen.getByRole('button', { name: 'pick Rename' }));

    expect(storedBody().graphqlOperationName).toBe('Rename');
    expect(JSON.parse(storedBody().graphqlVariables ?? '')).toEqual({ id: '7', name: '' });
    expect(screen.getByTestId('editor-op').textContent).toBe('Rename');

    const send = screen.getByRole('button', { name: 'Send GraphQL mutation' });
    expect(send.textContent).toContain('Run mutation');
    await act(async () => {
      fireEvent.click(send);
    });
    expect(sentEnvelope()).toMatchObject({ operationName: 'Rename' });
  });

  it('routes a selected subscription over graphql-ws with its operationName', () => {
    seed({ graphqlOperationName: 'Ticks' });
    render(<GraphQLRequestBuilder />);
    expect(screen.getByText('SUB')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Subscribe/ }));
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.connect).toHaveBeenCalledWith(
      expect.objectContaining({ query: DOC, operationName: 'Ticks', protocol: 'auto' })
    );
  });

  it('tears down a live subscription when another operation is picked', () => {
    seed({ graphqlOperationName: 'Ticks' });
    render(<GraphQLRequestBuilder />);
    fireEvent.click(screen.getByRole('button', { name: /Subscribe/ }));
    // Subscribing jumps to the Messages tab; go back to the editor to pick.
    fireEvent.click(screen.getByRole('tab', { name: /^Query/ }));
    fireEvent.click(screen.getByRole('button', { name: 'pick GetUser' }));
    expect(mocks.disconnect).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Send GraphQL query' })).toBeTruthy();
  });

  it('Cmd+Enter runs the operation under the cursor on its own transport', async () => {
    seed();
    render(<GraphQLRequestBuilder />);

    fireEvent.click(screen.getByRole('button', { name: 'run at tick' }));
    expect(storedBody().graphqlOperationName).toBe('Ticks');
    expect(mocks.connect).toHaveBeenCalledWith(expect.objectContaining({ operationName: 'Ticks' }));
    expect(mocks.run).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('tab', { name: /^Query/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'run at rename' }));
    });
    expect(mocks.disconnect).toHaveBeenCalled();
    // Variables were re-scoped twice: Ticks (none) then Rename (template).
    expect(sentEnvelope()).toMatchObject({
      operationName: 'Rename',
      variables: { id: '', name: '' },
    });
  });

  it('ignores late callbacks from a torn-down subscription', () => {
    const twoSubs = `${DOC}\nsubscription Other { other { n } }`;
    seed({ raw: twoSubs, graphqlOperationName: 'Ticks' });
    render(<GraphQLRequestBuilder />);
    fireEvent.click(screen.getByRole('button', { name: /Subscribe/ }));
    const stale = mocks.connect.mock.calls[0]?.[0] as {
      onMessage: (m: { id: string; type: string; timestamp: number }) => void;
      onError: (e: unknown) => void;
    };

    // Switch to the other subscription: the first client is torn down and a
    // new one starts.
    fireEvent.click(screen.getByRole('tab', { name: /^Query/ }));
    fireEvent.click(screen.getByRole('button', { name: 'pick Other' }));
    fireEvent.click(screen.getByRole('button', { name: /Subscribe/ }));
    expect(mocks.connect).toHaveBeenCalledTimes(2);
    const disconnectsBefore = mocks.disconnect.mock.calls.length;

    act(() => {
      stale.onMessage({ id: 'late', type: 'complete', timestamp: 0 });
      stale.onError(new Error('late'));
    });

    // The live subscription is still tracked and can be torn down.
    const unsubscribe = screen.getByRole('button', { name: /Unsubscribe/ });
    fireEvent.click(unsubscribe);
    expect(mocks.disconnect.mock.calls.length).toBe(disconnectsBefore + 1);
  });
});
