import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest, Response } from '@/types';

const runnerMocks = vi.hoisted(() => ({
  run: vi.fn(),
}));

vi.mock('@/features/registry/useRequestRunner', () => ({
  useRequestRunner: () => ({ run: runnerMocks.run, abort: vi.fn() }),
}));

vi.mock('@/components/shared/CodeEditor', () => ({
  default: () => <div data-testid="code-editor" />,
}));

vi.mock('../GraphQLBodyEditor', () => ({
  default: () => <div data-testid="graphql-body-editor" />,
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

import { useRequestStore } from '@/store/useRequestStore';
import GraphQLRequestBuilder from '../GraphQLRequestBuilder';

function makeRequest(id: string, name: string): HttpRequest {
  return {
    id,
    name,
    type: 'http',
    method: 'POST',
    url: 'https://graphql.example',
    headers: [],
    params: [],
    body: {
      type: 'graphql',
      raw: 'query Ping { ping }',
      graphqlVariables: '{}',
    },
    auth: { type: 'none' },
  };
}

function makeResponse(requestId: string): Response {
  return {
    id: `response-${requestId}`,
    requestId,
    status: 200,
    statusText: 'OK',
    headers: {},
    body: '{"data":{"ping":"pong"}}',
    size: 24,
    time: 12,
    timestamp: Date.now(),
  };
}

describe('GraphQLRequestBuilder request completion routing', () => {
  beforeEach(() => {
    runnerMocks.run.mockReset();
    useRequestStore.setState({
      tabs: [
        { id: 'tab-origin', request: makeRequest('request-origin', 'Origin'), isDirty: false },
        { id: 'tab-other', request: makeRequest('request-other', 'Other'), isDirty: false },
      ],
      activeTabId: 'tab-origin',
      isLoading: false,
    });
  });

  it('writes a delayed response to the tab that started the request', async () => {
    const response = makeResponse('request-origin');
    let resolveRun: ((result: { response: Response; durationMs: number }) => void) | undefined;
    runnerMocks.run.mockReturnValue(
      new Promise((resolve) => {
        resolveRun = resolve;
      })
    );
    render(<GraphQLRequestBuilder />);

    fireEvent.click(screen.getByRole('button', { name: 'Send GraphQL query' }));
    act(() => {
      useRequestStore.getState().switchTab('tab-other');
    });
    await act(async () => {
      resolveRun?.({ response, durationMs: 12 });
    });

    const state = useRequestStore.getState();
    expect(state.tabs.find((tab) => tab.id === 'tab-origin')?.response).toEqual(response);
    expect(state.tabs.find((tab) => tab.id === 'tab-other')?.response).toBeUndefined();
  });
});
