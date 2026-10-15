import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const monacoMocks = vi.hoisted(() => {
  const setModelMarkers = vi.fn();
  const editor = {
    revealRangeInCenter: vi.fn(),
    setSelection: vi.fn(),
    focus: vi.fn(),
  };
  let value = '';
  const model = {
    getValue: () => value,
    isDisposed: () => false,
    onDidChangeContent: () => ({ dispose: () => {} }),
  };
  return {
    setModelMarkers,
    editor,
    model,
    setValue: (v: string) => {
      value = v;
    },
    monaco: {
      editor: { setModelMarkers },
      languages: { registerCompletionItemProvider: () => ({ dispose: () => {} }) },
    },
  };
});

vi.mock('@/components/shared/CodeEditor', async () => {
  const { useEffect } = await import('react');
  return {
    default: ({
      value,
      language,
      onModelChange,
    }: {
      value: string;
      language: string;
      onModelChange?: (e: unknown, m: unknown, model: unknown) => void;
    }) => {
      useEffect(() => {
        if (language !== 'graphql') return;
        monacoMocks.setValue(value);
        onModelChange?.(monacoMocks.editor, monacoMocks.monaco, monacoMocks.model);
      }, []);
      return null;
    },
  };
});

vi.mock('@/features/graphql/lib/completionProvider', () => ({
  registerGraphQLCompletionProvider: vi.fn(),
}));

import { parseGraphQLErrors } from '@/features/graphql/lib/graphqlErrors';
import { useGraphQLErrorStore } from '@/features/graphql/store/useGraphQLErrorStore';
import { useRequestStore } from '@/store/useRequestStore';
import GraphQLBodyEditor from '../GraphQLBodyEditor';

const QUERY = 'query {\n  user(id: "1") {\n    nme\n  }\n}';
const errors = parseGraphQLErrors({
  errors: [
    {
      message: 'Cannot query field "nme"',
      locations: [{ line: 3, column: 5 }],
      extensions: { code: 'GRAPHQL_VALIDATION_FAILED' },
    },
  ],
});

function responseMarkerCalls() {
  return monacoMocks.setModelMarkers.mock.calls.filter(
    ([, owner]) => owner === 'graphql-response-errors'
  );
}

function renderEditor(query: string) {
  return render(
    <GraphQLBodyEditor
      query={query}
      variables="{}"
      url="https://gql.example"
      onQueryChange={() => {}}
      onVariablesChange={() => {}}
    />
  );
}

describe('GraphQLBodyEditor response-error markers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useGraphQLErrorStore.setState({ byTab: {}, focus: null });
    useRequestStore.setState({
      tabs: [
        {
          id: 'tab-1',
          request: {
            id: 'r',
            name: 'r',
            type: 'http',
            method: 'POST',
            url: '',
            headers: [],
            params: [],
            body: { type: 'graphql', raw: QUERY },
            auth: { type: 'none' },
          },
          isDirty: false,
        },
      ],
      activeTabId: 'tab-1',
    });
  });

  it('marks error locations while the editor holds the sent query', async () => {
    useGraphQLErrorStore.getState().publish('tab-1', QUERY, errors);
    renderEditor(QUERY);
    await waitFor(() => expect(responseMarkerCalls().length).toBeGreaterThan(0));
    const markers = responseMarkerCalls().at(-1)?.[2];
    expect(markers).toEqual([
      expect.objectContaining({
        message: '[GRAPHQL_VALIDATION_FAILED] Cannot query field "nme"',
        startLineNumber: 3,
        startColumn: 5,
        endColumn: 8,
      }),
    ]);
  });

  it('clears the markers once the query no longer matches what was sent', async () => {
    useGraphQLErrorStore.getState().publish('tab-1', QUERY, errors);
    const { rerender } = renderEditor(QUERY);
    await waitFor(() => expect(responseMarkerCalls().length).toBeGreaterThan(0));
    rerender(
      <GraphQLBodyEditor
        query={`${QUERY} `}
        variables="{}"
        url="https://gql.example"
        onQueryChange={() => {}}
        onVariablesChange={() => {}}
      />
    );
    expect(responseMarkerCalls().at(-1)?.[2]).toEqual([]);
  });

  it('reveals and selects a location requested from an errors panel', async () => {
    renderEditor(QUERY);
    await waitFor(() => expect(responseMarkerCalls().length).toBeGreaterThan(0));
    act(() => {
      useGraphQLErrorStore.getState().focusLocation('tab-1', { line: 3, column: 5 });
    });
    const range = { startLineNumber: 3, startColumn: 5, endLineNumber: 3, endColumn: 8 };
    expect(monacoMocks.editor.revealRangeInCenter).toHaveBeenCalledWith(range);
    expect(monacoMocks.editor.setSelection).toHaveBeenCalledWith(range);
    expect(monacoMocks.editor.focus).toHaveBeenCalled();
    expect(useGraphQLErrorStore.getState().focus).toBeNull();
  });

  it('ignores focus requests for other tabs', async () => {
    renderEditor(QUERY);
    await waitFor(() => expect(responseMarkerCalls().length).toBeGreaterThan(0));
    act(() => {
      useGraphQLErrorStore.getState().focusLocation('tab-other', { line: 1, column: 1 });
    });
    expect(monacoMocks.editor.revealRangeInCenter).not.toHaveBeenCalled();
  });
});
