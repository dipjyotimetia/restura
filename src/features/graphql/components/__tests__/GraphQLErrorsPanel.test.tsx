import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseGraphQLErrors } from '@/features/graphql/lib/graphqlErrors';
import { useGraphQLErrorStore } from '@/features/graphql/store/useGraphQLErrorStore';
import { GraphQLErrorsPanel } from '../GraphQLErrorsPanel';

const errors = parseGraphQLErrors({
  data: { partial: [{ id: '1' }, null] },
  errors: [
    {
      message: 'user 9 not found',
      locations: [
        { line: 3, column: 5 },
        { line: 7, column: 2 },
      ],
      path: ['partial', 1],
      extensions: { code: 'NOT_FOUND' },
    },
    { message: 'request-level failure' },
  ],
});
const items = errors.map((error) => ({ key: String(error.index), error }));

describe('GraphQLErrorsPanel', () => {
  beforeEach(() => {
    useGraphQLErrorStore.setState({ byTab: {}, focus: null });
  });

  it('lists every error with message, code, path and locations', () => {
    render(<GraphQLErrorsPanel items={items} tabId="tab-1" onSelectPath={vi.fn()} />);
    const rows = within(screen.getByRole('list', { name: 'GraphQL errors' })).getAllByRole(
      'listitem'
    );
    expect(rows).toHaveLength(2);
    const first = rows[0]!;
    expect(within(first).getByText('user 9 not found')).toBeTruthy();
    expect(within(first).getByText('NOT_FOUND')).toBeTruthy();
    expect(within(first).getByRole('button', { name: 'Show partial[1] in response' })).toBeTruthy();
    expect(
      within(first).getByRole('button', { name: 'Go to query line 3, column 5' })
    ).toBeTruthy();
    expect(
      within(first).getByRole('button', { name: 'Go to query line 7, column 2' })
    ).toBeTruthy();
    // An error without path/locations has nothing to navigate to.
    expect(within(rows[1]!).queryByRole('button')).toBeNull();
  });

  it('clicking a path asks the host to reveal it in the response tree', () => {
    const onSelectPath = vi.fn();
    render(<GraphQLErrorsPanel items={items} tabId="tab-1" onSelectPath={onSelectPath} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show partial[1] in response' }));
    expect(onSelectPath).toHaveBeenCalledWith(items[0], ['partial', 1]);
  });

  it('clicking a location requests editor focus for the tab', () => {
    render(<GraphQLErrorsPanel items={items} tabId="tab-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Go to query line 7, column 2' }));
    expect(useGraphQLErrorStore.getState().focus).toMatchObject({
      tabId: 'tab-1',
      location: { line: 7, column: 2 },
    });
  });

  it('renders the path as plain text when there is no tree to jump to', () => {
    render(<GraphQLErrorsPanel items={items} tabId="tab-1" />);
    expect(screen.queryByRole('button', { name: /in response/ })).toBeNull();
    expect(screen.getByText('partial[1]')).toBeTruthy();
  });

  it('shows an empty state', () => {
    render(<GraphQLErrorsPanel items={[]} tabId="tab-1" />);
    expect(screen.getByText('No GraphQL errors')).toBeTruthy();
  });
});
