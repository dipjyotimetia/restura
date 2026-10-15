import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useRequestStore } from '@/store/useRequestStore';
import type { HttpRequest, Response } from '@/types';

vi.mock('@/components/shared/CodeEditor', () => ({
  default: () => <div data-testid="code-editor" />,
}));

// Render the real JsonTree synchronously so highlights/focus are observable.
vi.mock('@/lib/shared/lazyComponent', async () => {
  const JsonTree = (await import('@/components/shared/JsonTree')).default;
  return {
    lazyComponent: (loader: () => Promise<unknown>) =>
      String(loader).includes('JsonTree') ? JsonTree : () => <div data-testid="lazy" />,
  };
});

vi.mock('@/features/ai/components/AiActionsMenu', () => ({
  AiActionsMenu: () => null,
}));

import ResponseViewer from '../ResponseViewer';

const request: HttpRequest = {
  id: 'req-gql',
  name: 'GraphQL',
  type: 'http',
  method: 'POST',
  url: 'https://graphql.example',
  headers: [],
  params: [],
  body: { type: 'graphql', raw: 'query { partial(ids: ["1", "9"]) { id } }' },
  auth: { type: 'none' },
};

const body = JSON.stringify({
  data: { partial: [{ id: '1' }, null] },
  errors: [
    {
      message: 'user 9 not found',
      locations: [{ line: 1, column: 9 }],
      path: ['partial', 1],
      extensions: { code: 'NOT_FOUND' },
    },
  ],
});

const response: Response = {
  id: 'resp-gql',
  requestId: request.id,
  status: 200,
  statusText: 'OK',
  headers: { 'content-type': 'application/json' },
  body,
  size: body.length,
  time: 5,
  timestamp: 1,
};

describe('ResponseViewer GraphQL errors', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    useRequestStore.setState({
      tabs: [{ id: 'tab-gql', request, response, isDirty: false }],
      activeTabId: 'tab-gql',
      isLoading: false,
    });
  });

  it('adds an Errors tab only for GraphQL responses', () => {
    const { unmount } = render(<ResponseViewer />);
    expect(screen.queryByRole('tab', { name: /Errors/ })).toBeNull();
    unmount();
    render(<ResponseViewer protocol="graphql" />);
    expect(screen.getByRole('tab', { name: /Errors/ })).toBeTruthy();
  });

  it('jumps from an error path to the highlighted node in the tree', () => {
    render(<ResponseViewer protocol="graphql" />);
    fireEvent.click(screen.getByRole('tab', { name: /Errors/ }));
    expect(screen.getByText('user 9 not found')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Show partial[1] in response' }));

    expect(screen.getByRole('tree', { name: 'JSON response' })).toBeTruthy();
    const flag = screen.getByRole('img', { name: 'Error: [NOT_FOUND] user 9 not found' });
    const row = flag.closest('[data-highlighted]');
    expect(row?.getAttribute('tabindex')).toBe('-1');
    expect(row?.textContent).toContain('1:');
  });

  it('leaves the Errors tab when the next response has no errors', () => {
    const { rerender } = render(<ResponseViewer protocol="graphql" />);
    fireEvent.click(screen.getByRole('tab', { name: /Errors/ }));
    useRequestStore.setState({
      tabs: [
        {
          id: 'tab-gql',
          request,
          response: { ...response, id: 'resp-ok', body: '{"data":{"partial":[]}}' },
          isDirty: false,
        },
      ],
    });
    rerender(<ResponseViewer protocol="graphql" />);
    expect(screen.queryByRole('tab', { name: /Errors/ })).toBeNull();
    expect(screen.getByRole('tab', { name: /Body/, selected: true })).toBeTruthy();
  });
});
