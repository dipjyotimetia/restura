import { fireEvent, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// A fake Monaco: the GraphQL editor hands its (editor, monaco, model) triple to
// onModelChange on mount, so the run-at-cursor action can be observed.
const monacoFake = vi.hoisted(() => {
  const actions: Array<{ id: string; keybindings?: number[]; run: (ed: unknown) => void }> = [];
  const editor = {
    addAction: (a: (typeof actions)[number]) => {
      actions.push(a);
      return { dispose: () => {} };
    },
    getPosition: () => ({ lineNumber: 1, column: 1 }) as unknown,
    getModel: () => ({ getOffsetAt: () => 42 }) as unknown,
  };
  return {
    actions,
    editor,
    monaco: { KeyMod: { CtrlCmd: 2048 }, KeyCode: { Enter: 3 } },
    model: {},
  };
});

vi.mock('@/components/shared/CodeEditor', () => ({
  default: ({
    language,
    onModelChange,
  }: {
    language?: string;
    onModelChange?: (e: unknown, m: unknown, model: unknown) => void;
  }) => {
    useEffect(() => {
      if (language === 'graphql') {
        onModelChange?.(monacoFake.editor, monacoFake.monaco, monacoFake.model);
      }
    }, [language, onModelChange]);
    return null;
  },
}));
vi.mock('@/features/graphql/lib/completionProvider', () => ({
  registerGraphQLCompletionProvider: vi.fn(),
}));
vi.mock('@/features/graphql/lib/diagnosticsProvider', () => ({
  setupDebouncedDiagnostics: () => ({ dispose: () => {} }),
}));

import { useGraphQLSchemaStore } from '@/store/useGraphQLSchemaStore';
import GraphQLBodyEditor from '../GraphQLBodyEditor';

const MULTI = 'query A($id: ID!) { a(id: $id) }\nsubscription B($room: String!) { b(room: $room) }';

function renderEditor(props: Partial<Parameters<typeof GraphQLBodyEditor>[0]> = {}) {
  const onVariablesChange = vi.fn();
  render(
    <GraphQLBodyEditor
      query={MULTI}
      variables="{}"
      url="https://gql.example/graphql"
      onQueryChange={() => {}}
      onVariablesChange={onVariablesChange}
      {...props}
    />
  );
  return { onVariablesChange };
}

describe('GraphQLBodyEditor — operations (#903)', () => {
  beforeEach(() => {
    monacoFake.actions.length = 0;
    useGraphQLSchemaStore.setState({ schemas: {}, loading: {} });
  });

  it('renders one chip per operation with the selected one pressed', () => {
    const onSelectOperation = vi.fn();
    renderEditor({ operationName: 'B', onSelectOperation });
    const group = screen.getByRole('group', { name: 'GraphQL operations' });
    const chips = group.querySelectorAll('button');
    expect(Array.from(chips, (c) => c.textContent)).toEqual(['A', 'B']);
    expect(
      screen.getByRole('button', { name: 'B (subscription)' }).getAttribute('aria-pressed')
    ).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'A (query)' }));
    expect(onSelectOperation).toHaveBeenCalledWith(expect.objectContaining({ name: 'A' }));
  });

  it('shows no chips for a single operation or without a selection handler', () => {
    renderEditor({ query: 'query Only { a }', onSelectOperation: vi.fn() });
    renderEditor();
    expect(screen.queryByRole('group', { name: 'GraphQL operations' })).toBeNull();
  });

  it('generates the variables template for the selected operation', () => {
    const { onVariablesChange } = renderEditor({ operationName: 'B' });
    expect(JSON.parse(onVariablesChange.mock.calls[0]?.[0] as string)).toEqual({ room: '' });
  });

  it('binds Cmd/Ctrl+Enter to run the operation under the cursor', () => {
    const onRunAtCursor = vi.fn();
    renderEditor({ onRunAtCursor });
    expect(monacoFake.actions).toHaveLength(1);
    const action = monacoFake.actions[0]!;
    expect(action.keybindings).toEqual([2048 | 3]);
    action.run(monacoFake.editor);
    expect(onRunAtCursor).toHaveBeenCalledWith(42);
  });
});
