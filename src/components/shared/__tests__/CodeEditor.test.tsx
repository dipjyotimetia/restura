import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  editorProps: null as {
    beforeMount: (monaco: unknown) => void;
    onMount: (editor: unknown, monaco: unknown) => void;
  } | null,
  registerGraphQLLanguage: vi.fn(),
}));

vi.mock('@monaco-editor/react', () => ({
  default: (props: typeof mocks.editorProps) => {
    mocks.editorProps = props;
    return <div data-testid="monaco-editor" />;
  },
}));

vi.mock('next-themes', () => ({ useTheme: () => ({ theme: 'dark' }) }));
vi.mock('@/lib/shared/monaco-setup', () => ({ jsonDefaults: {} }));
vi.mock('@/lib/shared/variableTokens', () => ({ findVariableTokens: () => [] }));
vi.mock('@/features/graphql/lib/monacoGraphql', () => ({
  registerGraphQLLanguage: mocks.registerGraphQLLanguage,
}));

import CodeEditor from '../CodeEditor';

describe('CodeEditor Monaco lifecycle', () => {
  beforeEach(() => {
    mocks.editorProps = null;
    mocks.registerGraphQLLanguage.mockReset();
  });

  it('registers GraphQL before mount and reports each active path model', () => {
    const firstModel = { uri: { toString: () => 'inmemory://first' }, getValue: () => '' };
    const secondModel = { uri: { toString: () => 'inmemory://second' }, getValue: () => '' };
    let model = firstModel;
    let onDidChangeModel: (() => void) | undefined;
    const editor = {
      getModel: () => model,
      updateOptions: vi.fn(),
      layout: vi.fn(),
      onDidChangeModelContent: () => ({ dispose: vi.fn() }),
      onDidChangeModel: (listener: () => void) => {
        onDidChangeModel = listener;
        return { dispose: vi.fn() };
      },
      getAction: () => undefined,
    };
    const onModelChange = vi.fn();
    const monaco = { Range: class {} };

    render(<CodeEditor value="query { ping }" language="graphql" onModelChange={onModelChange} />);

    act(() => {
      mocks.editorProps?.beforeMount(monaco);
      mocks.editorProps?.onMount(editor, monaco);
    });

    expect(mocks.registerGraphQLLanguage).toHaveBeenCalledWith(monaco);
    expect(onModelChange).toHaveBeenLastCalledWith(editor, monaco, firstModel);

    model = secondModel;
    act(() => onDidChangeModel?.());

    expect(onModelChange).toHaveBeenLastCalledWith(editor, monaco, secondModel);
  });
});
