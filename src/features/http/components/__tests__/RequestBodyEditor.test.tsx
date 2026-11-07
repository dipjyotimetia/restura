import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RequestBody } from '@/types';

const captured = vi.hoisted(() => ({
  code: [] as Array<Record<string, unknown>>,
  graphql: [] as Array<Record<string, unknown>>,
  formData: [] as Array<Record<string, unknown>>,
  binary: [] as Array<Record<string, unknown>>,
  urlEncoded: [] as Array<Record<string, unknown>>,
}));
const activeTab = vi.hoisted(() => ({ current: null as { id: string } | null }));

vi.mock('@/components/shared/CodeEditor', () => ({
  default: (props: Record<string, unknown>) => {
    captured.code.push(props);
    return <textarea data-testid="code-editor" aria-label={String(props.ariaLabel)} />;
  },
}));
vi.mock('@/features/graphql/components/GraphQLBodyEditor', () => ({
  default: (props: Record<string, unknown>) => {
    captured.graphql.push(props);
    return (
      <button
        type="button"
        data-testid="graphql-editor"
        onClick={() => (props.onVariablesChange as (v: string) => void)('{"x":1}')}
      >
        gql
      </button>
    );
  },
}));
vi.mock('@/features/http/components/FormDataEditor', () => ({
  default: (props: Record<string, unknown>) => {
    captured.formData.push(props);
    return (
      <button
        type="button"
        data-testid="form-data-editor"
        onClick={() => (props.onChange as (items: unknown[]) => void)([])}
      >
        form
      </button>
    );
  },
}));
vi.mock('@/features/http/components/BinaryBodyPicker', () => ({
  default: (props: Record<string, unknown>) => {
    captured.binary.push(props);
    return <div data-testid="binary-picker" />;
  },
}));
vi.mock('@/features/http/components/UrlEncodedEditor', () => ({
  default: (props: Record<string, unknown>) => {
    captured.urlEncoded.push(props);
    return (
      <button
        type="button"
        data-testid="urlencoded-editor"
        onClick={() => (props.onChange as (items: unknown[]) => void)([])}
      >
        urlencoded
      </button>
    );
  },
}));
vi.mock('@/hooks/useVariableStatus', () => ({
  useVariableStatus: () => () => 'resolved',
}));
vi.mock('@/store/selectors', () => ({
  useActiveTab: () => activeTab.current,
}));

import RequestBodyEditor, { bodyEditorFills } from '../RequestBodyEditor';

const last = <T,>(arr: T[]): T => arr[arr.length - 1] as T;

function renderEditor(body: RequestBody, extra: Record<string, unknown> = {}) {
  const props = {
    body,
    onBodyTypeChange: vi.fn(),
    onBodyContentChange: vi.fn(),
    ...extra,
  };
  return { props, ...render(<RequestBodyEditor {...props} />) };
}

afterEach(() => {
  for (const list of Object.values(captured)) list.length = 0;
  activeTab.current = null;
});

describe('bodyEditorFills', () => {
  it.each([
    ['none', false],
    ['form-data', false],
    ['binary', false],
    ['json', true],
    ['xml', true],
    ['text', true],
    ['graphql', true],
    ['x-www-form-urlencoded', true],
  ] as const)('%s → %s', (type, fills) => {
    expect(bodyEditorFills(type)).toBe(fills);
  });
});

describe('RequestBodyEditor', () => {
  it('shows the empty state for a body of type none', () => {
    renderEditor({ type: 'none' });
    expect(screen.getByText('No body for this request')).toBeInTheDocument();
    expect(screen.queryByTestId('code-editor')).not.toBeInTheDocument();
  });

  it.each([
    ['json', 'json', 'JSON request body'],
    ['xml', 'xml', 'XML request body'],
    ['text', 'plaintext', 'Raw request body'],
  ] as const)('renders a %s body in the code editor', async (type, language, label) => {
    const { props } = renderEditor({ type, raw: 'payload' });
    expect(await screen.findByLabelText(label)).toBeInTheDocument();
    const code = last(captured.code);
    expect(code.language).toBe(language);
    expect(code.value).toBe('payload');
    expect(code.formatOnMount).toBe(false);
    expect(code.onChange).toBe(props.onBodyContentChange);
    // No active tab → no per-tab Monaco model path.
    expect(code).not.toHaveProperty('path');
    expect(code).not.toHaveProperty('modelOwner');
  });

  it('defaults a missing raw body to an empty string', async () => {
    renderEditor({ type: 'json' });
    await screen.findByTestId('code-editor');
    expect(last(captured.code).value).toBe('');
  });

  it('scopes the Monaco model to the active tab', async () => {
    activeTab.current = { id: 'tab-7' };
    renderEditor({ type: 'json', raw: '{}' });
    await screen.findByTestId('code-editor');
    const code = last(captured.code);
    expect(code.path).toBe('tab-tab-7-body');
    expect(code.modelOwner).toBe('tab-7');
  });

  it('renders the GraphQL editor with query, variables, url and schema', async () => {
    const onGraphQLVariablesChange = vi.fn();
    const schema = { sdl: 'type Query { a: Int }' };
    renderEditor(
      { type: 'graphql', raw: '{ a }' },
      {
        url: 'https://api.test/graphql',
        graphqlSchema: schema,
        graphqlVariables: '{"v":1}',
        onGraphQLVariablesChange,
      }
    );
    await userEvent.click(await screen.findByTestId('graphql-editor'));
    const gql = last(captured.graphql);
    expect(gql.query).toBe('{ a }');
    expect(gql.variables).toBe('{"v":1}');
    expect(gql.url).toBe('https://api.test/graphql');
    expect(gql.importedSchema).toBe(schema);
    expect(onGraphQLVariablesChange).toHaveBeenCalledWith('{"x":1}');
  });

  it('falls back to defaults for a bare GraphQL body', async () => {
    renderEditor({ type: 'graphql' });
    // The no-op variables handler must not throw.
    await userEvent.click(await screen.findByTestId('graphql-editor'));
    const gql = last(captured.graphql);
    expect(gql.query).toBe('');
    expect(gql.variables).toBe('{}');
    expect(gql.url).toBe('');
    expect(gql).not.toHaveProperty('importedSchema');
  });

  it('renders form-data fields and forwards changes', async () => {
    const onFormDataChange = vi.fn();
    const formData = [{ id: 'f', key: 'a', value: 'b', enabled: true, type: 'text' as const }];
    renderEditor({ type: 'form-data', formData }, { onFormDataChange });
    await userEvent.click(await screen.findByTestId('form-data-editor'));
    expect(last(captured.formData).items).toBe(formData);
    expect(onFormDataChange).toHaveBeenCalledWith([]);
  });

  it('gives form-data an empty list and a no-op handler when absent', async () => {
    renderEditor({ type: 'form-data' });
    await userEvent.click(await screen.findByTestId('form-data-editor'));
    expect(last(captured.formData).items).toEqual([]);
  });

  it('renders the binary picker with the base64 payload', async () => {
    const { props } = renderEditor({ type: 'binary', raw: 'AAEC' });
    await screen.findByTestId('binary-picker');
    expect(last(captured.binary).base64).toBe('AAEC');
    expect(last(captured.binary).onChange).toBe(props.onBodyContentChange);
  });

  it('passes an empty base64 string for a binary body with no data', async () => {
    renderEditor({ type: 'binary' });
    await screen.findByTestId('binary-picker');
    expect(last(captured.binary).base64).toBe('');
  });

  it('parses a legacy raw urlencoded body into editable fields', async () => {
    const onUrlEncodedChange = vi.fn();
    renderEditor({ type: 'x-www-form-urlencoded', raw: 'a=1&b=two' }, { onUrlEncodedChange });
    await userEvent.click(await screen.findByTestId('urlencoded-editor'));
    const items = last(captured.urlEncoded).items as Array<{ key: string; value: string }>;
    expect(items.map((i) => [i.key, i.value])).toEqual([
      ['a', '1'],
      ['b', 'two'],
    ]);
    expect(onUrlEncodedChange).toHaveBeenCalledWith([]);
    expect(screen.queryByTestId('code-editor')).not.toBeInTheDocument();
  });

  it('tolerates a urlencoded body without a change handler', async () => {
    renderEditor({ type: 'x-www-form-urlencoded' });
    await userEvent.click(await screen.findByTestId('urlencoded-editor'));
    expect(last(captured.urlEncoded).items).toEqual([]);
  });
});
