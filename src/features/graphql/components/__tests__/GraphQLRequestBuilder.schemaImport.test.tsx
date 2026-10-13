import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { buildSchema, introspectionFromSchema } from 'graphql';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest } from '@/types';

vi.mock('@/features/registry/useRequestRunner', () => ({
  useRequestRunner: () => ({ run: vi.fn(), abort: vi.fn() }),
}));

vi.mock('@/components/shared/CodeEditor', () => ({ default: () => null }));
vi.mock('../GraphQLBodyEditor', () => ({ default: () => null }));

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
import GraphQLRequestBuilder from '../GraphQLRequestBuilder';

const SDL = 'type Query {\n  viewer: Account\n}\n\ntype Account {\n  id: ID!\n}';

function makeRequest(extra: Partial<HttpRequest> = {}): HttpRequest {
  return {
    id: 'req',
    name: 'GQL',
    type: 'http',
    method: 'POST',
    url: 'https://no-introspection.example/graphql',
    headers: [],
    params: [],
    body: { type: 'graphql', raw: '{ viewer { id } }', graphqlVariables: '{}' },
    auth: { type: 'none' },
    ...extra,
  };
}

function activeRequest(): HttpRequest {
  return useRequestStore.getState().getActiveTab()?.request as HttpRequest;
}

const fetchSchema = vi.fn();

function openLoadDialog() {
  fireEvent.click(screen.getByRole('button', { name: 'Load schema' }));
  return screen.getByRole('dialog');
}

describe('GraphQLRequestBuilder — load schema', () => {
  beforeEach(() => {
    fetchSchema.mockReset();
    useGraphQLSchemaStore.setState({ schemas: {}, loading: {}, fetchSchema });
    useRequestStore.setState({
      tabs: [{ id: 'tab', request: makeRequest(), isDirty: false }],
      activeTabId: 'tab',
      isLoading: false,
    });
  });

  it('stores pasted SDL on the request and shows it in the schema explorer', async () => {
    render(<GraphQLRequestBuilder />);
    const dialog = openLoadDialog();

    fireEvent.change(within(dialog).getByRole('textbox', { name: /schema source/i }), {
      target: { value: SDL },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Load' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(activeRequest().graphqlSchema).toMatchObject({ source: 'sdl' });
    expect(activeRequest().graphqlSchema?.sdl).toContain('type Account');

    // The explorer opens on a successful load.
    expect(screen.getByText('Account')).toBeTruthy();
    expect(screen.getByText('IMPORTED')).toBeTruthy();
  });

  it('accepts a pasted introspection JSON result', async () => {
    render(<GraphQLRequestBuilder />);
    const dialog = openLoadDialog();
    const json = JSON.stringify({ data: introspectionFromSchema(buildSchema(SDL)) });

    fireEvent.change(within(dialog).getByRole('textbox', { name: /schema source/i }), {
      target: { value: json },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Load' }));

    await waitFor(() => expect(activeRequest().graphqlSchema?.source).toBe('introspection'));
    expect(activeRequest().graphqlSchema?.sdl).toContain('viewer: Account');
  });

  it('shows the parse error and keeps the request unchanged on invalid SDL', () => {
    render(<GraphQLRequestBuilder />);
    const dialog = openLoadDialog();

    fireEvent.change(within(dialog).getByRole('textbox', { name: /schema source/i }), {
      target: { value: 'type Query { viewer( }' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Load' }));

    expect(within(dialog).getByRole('alert').textContent).toMatch(/Syntax Error.*line 1/);
    expect(activeRequest().graphqlSchema).toBeUndefined();
  });

  it('loads a .graphqls file and records its name', async () => {
    render(<GraphQLRequestBuilder />);
    const dialog = openLoadDialog();
    const file = new File([SDL], 'api.graphqls', { type: '' });

    await act(async () => {
      fireEvent.change(within(dialog).getByLabelText(/choose schema file/i), {
        target: { files: [file] },
      });
    });

    await waitFor(() => expect(activeRequest().graphqlSchema?.fileName).toBe('api.graphqls'));
    expect(activeRequest().graphqlSchema?.sdl).toContain('type Account');
  });

  it('rejects an oversized schema file before reading it', async () => {
    render(<GraphQLRequestBuilder />);
    const dialog = openLoadDialog();
    const file = new File([SDL], 'huge.graphqls', { type: '' });
    Object.defineProperty(file, 'size', { value: 20 * 1024 * 1024 + 1 });
    const read = vi.spyOn(file, 'text');

    await act(async () => {
      fireEvent.change(within(dialog).getByLabelText(/choose schema file/i), {
        target: { files: [file] },
      });
    });

    expect(within(dialog).getByRole('alert').textContent).toBe(
      'huge.graphqls: Schema is too large (max 20 MB).'
    );
    expect(read).not.toHaveBeenCalled();
    expect(activeRequest().graphqlSchema).toBeUndefined();
  });

  it('does not let Refresh replace an imported schema without confirmation', async () => {
    useRequestStore.setState({
      tabs: [
        {
          id: 'tab',
          request: makeRequest({
            graphqlSchema: { sdl: SDL, source: 'sdl', importedAt: 1 },
          }),
          isDirty: false,
        },
      ],
      activeTabId: 'tab',
    });
    render(<GraphQLRequestBuilder />);
    fireEvent.click(screen.getByRole('button', { name: /schema/i, pressed: false }));

    fireEvent.click(screen.getByRole('button', { name: 'Refresh schema' }));
    const confirm = await screen.findByRole('alertdialog');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(fetchSchema).not.toHaveBeenCalled();
    expect(activeRequest().graphqlSchema).toBeDefined();

    fetchSchema.mockResolvedValue({
      success: true,
      schema: introspectionFromSchema(buildSchema(SDL)).__schema,
      endpoint: 'https://no-introspection.example/graphql',
      timestamp: 2,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh schema' }));
    const confirmAgain = await screen.findByRole('alertdialog');
    fireEvent.click(within(confirmAgain).getByRole('button', { name: 'Replace' }));

    await waitFor(() => expect(fetchSchema).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(activeRequest().graphqlSchema).toBeUndefined());
  });

  it('keeps the imported schema and reports the error when the confirmed refresh fails', async () => {
    const imported = { sdl: SDL, source: 'sdl' as const, importedAt: 1 };
    useRequestStore.setState({
      tabs: [{ id: 'tab', request: makeRequest({ graphqlSchema: imported }), isDirty: false }],
      activeTabId: 'tab',
    });
    let resolveFetch: (value: unknown) => void = () => {};
    fetchSchema.mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      })
    );
    render(<GraphQLRequestBuilder />);
    fireEvent.click(screen.getByRole('button', { name: /schema/i, pressed: false }));

    fireEvent.click(screen.getByRole('button', { name: 'Refresh schema' }));
    const confirm = await screen.findByRole('alertdialog');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Replace' }));
    await waitFor(() => expect(fetchSchema).toHaveBeenCalledTimes(1));

    // Not cleared while introspection is in flight.
    expect(activeRequest().graphqlSchema).toEqual(imported);

    await act(async () => {
      resolveFetch({
        success: false,
        schema: null,
        error: 'Introspection is disabled',
        endpoint: 'https://no-introspection.example/graphql',
        timestamp: 2,
      });
    });

    expect(activeRequest().graphqlSchema).toEqual(imported);
    expect(screen.getByText('IMPORTED')).toBeTruthy();
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      expect.stringMatching(/kept the imported schema/i),
      expect.objectContaining({ description: 'Introspection is disabled' })
    );
  });
});
