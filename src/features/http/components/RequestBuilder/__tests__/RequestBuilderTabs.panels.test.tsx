import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, AuthConfig, HttpRequest } from '@/types';

type Props = Record<string, unknown>;
const captured = vi.hoisted(() => ({
  tables: [] as Props[],
  pathVars: [] as Props[],
  body: [] as Props[],
  picker: [] as Props[],
  authConfig: [] as Props[],
  scripts: [] as Props[],
  settings: [] as Props[],
}));
const inherited = vi.hoisted(() => ({ current: null as { auth: AuthConfig } | null }));
const toastError = vi.hoisted(() => vi.fn());

vi.mock('sonner', () => ({ toast: { error: toastError } }));
vi.mock('@/hooks/useVariableStatus', () => ({
  useVariableStatus: () => (name: string) => (name === 'known' ? 'resolved' : 'unresolved'),
}));
vi.mock('@/components/shared/ParamHeaderTable', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/shared/ParamHeaderTable')>()),
  ParamHeaderTable: (props: Props) => {
    captured.tables.push(props);
    return <div data-testid={`table-${String(props.itemLabel)}`} />;
  },
}));
vi.mock('@/features/http/components/RequestBuilder/PathVariablesTable', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@/features/http/components/RequestBuilder/PathVariablesTable')
  >()),
  PathVariablesTable: (props: Props) => {
    captured.pathVars.push(props);
    return <div data-testid="path-vars" />;
  },
}));
vi.mock('@/features/http/components/RequestBodyEditor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/http/components/RequestBodyEditor')>()),
  default: (props: Props) => {
    captured.body.push(props);
    return <div data-testid="body-editor" />;
  },
}));
vi.mock('@/features/auth/components/AuthTypePicker', () => ({
  AuthTypePicker: (props: Props) => {
    captured.picker.push(props);
    return <div data-testid="auth-picker" />;
  },
}));
vi.mock('@/features/auth/components/AuthConfig', () => ({
  default: (props: Props) => {
    captured.authConfig.push(props);
    return <div data-testid="auth-config" />;
  },
}));
vi.mock('@/features/auth/components/InheritedAuthHint', () => ({
  InheritedAuthHint: () => <div data-testid="inherited-hint" />,
  useInheritedAuth: () => inherited.current,
}));
vi.mock('@/features/scripts/components/ScriptsEditor', () => ({
  default: (props: Props) => {
    captured.scripts.push(props);
    return <div data-testid="scripts-editor" />;
  },
}));
vi.mock('@/features/http/components/RequestSettingsEditor', () => ({
  default: (props: Props) => {
    captured.settings.push(props);
    return <div data-testid="settings-editor" />;
  },
}));

import { RequestBuilderTabs } from '../RequestBuilderTabs';

type TabKey = 'params' | 'headers' | 'body' | 'auth' | 'scripts' | 'settings';
const last = <T,>(arr: T[]): T => arr[arr.length - 1] as T;

const base: HttpRequest = {
  id: 'req',
  name: 'R',
  type: 'http',
  method: 'POST',
  url: 'https://example.test',
  headers: [],
  params: [],
  body: { type: 'none' },
  auth: { type: 'none' },
};

function makeHandlers() {
  const fns = new Map<string, ReturnType<typeof vi.fn>>();
  const handlers = new Proxy(
    {},
    {
      get: (_t, key: string) => {
        if (!fns.has(key)) fns.set(key, vi.fn());
        return fns.get(key);
      },
    }
  );
  return { handlers: handlers as never, fn: (key: string) => handlers[key as never] as never };
}

function renderTabs(
  request: HttpRequest,
  activeTab: TabKey = 'params',
  counts = { activeParams: 0, activeHeaders: 0 }
) {
  const { handlers, fn } = makeHandlers();
  const onTabChange = vi.fn();
  const globalSettings = { timeout: 1 } as unknown as AppSettings;
  render(
    <RequestBuilderTabs
      request={request}
      activeTab={activeTab}
      onTabChange={onTabChange}
      globalSettings={globalSettings}
      counts={counts}
      handlers={handlers}
    />
  );
  return { fn: fn as (key: string) => ReturnType<typeof vi.fn>, onTabChange, globalSettings };
}

afterEach(() => {
  for (const list of Object.values(captured)) list.length = 0;
  inherited.current = null;
  toastError.mockReset();
});

describe('RequestBuilderTabs tab badges', () => {
  it('shows param and header counts on their tabs', () => {
    renderTabs(base, 'params', { activeParams: 3, activeHeaders: 2 });
    expect(screen.getByRole('tab', { name: /Params/ })).toHaveTextContent('3');
    expect(screen.getByRole('tab', { name: /Headers/ })).toHaveTextContent('2');
  });

  it('badges Scripts with Test when only a test script is set', () => {
    renderTabs({ ...base, testScript: 'pm.test()' });
    expect(screen.getByRole('tab', { name: /Scripts/ })).toHaveTextContent('Test');
    expect(screen.getByRole('tab', { name: /Scripts/ })).not.toHaveTextContent('Pre');
  });

  it.each([
    ['json', 'JSON'],
    ['form-data', 'Form'],
    ['graphql', 'GQL'],
    ['text', 'Raw'],
    ['xml', 'XML'],
    ['binary', 'Bin'],
  ] as const)('badges the Body tab for a %s body', (type, badge) => {
    renderTabs({ ...base, body: { type } });
    expect(screen.getByRole('tab', { name: /Body/ })).toHaveTextContent(badge);
  });

  it('badges the Auth tab with the request’s own auth type', () => {
    renderTabs({ ...base, auth: { type: 'aws-signature' } as HttpRequest['auth'] });
    expect(screen.getByRole('tab', { name: /Auth/ })).toHaveTextContent('AWS');
  });

  it('badges an inherited auth with an up arrow', () => {
    inherited.current = { auth: { type: 'bearer' } as AuthConfig };
    renderTabs({ ...base, auth: { type: 'none' } });
    expect(screen.getByRole('tab', { name: /Auth/ })).toHaveTextContent('↑ Bearer');
  });

  it('falls back to the raw type name for an inherited auth without a badge', () => {
    inherited.current = { auth: { type: 'none' } as AuthConfig };
    renderTabs({ ...base, auth: { type: 'none' } });
    expect(screen.getByRole('tab', { name: /Auth/ })).toHaveTextContent('↑ none');
  });

  it('reports tab clicks through onTabChange', async () => {
    const { onTabChange } = renderTabs(base);
    await userEvent.click(screen.getByRole('tab', { name: /Headers/ }));
    expect(onTabChange).toHaveBeenCalledWith('headers');
  });
});

describe('RequestBuilderTabs params panel', () => {
  const params = [
    { id: 'p1', key: 'q', value: '1', enabled: true, description: 'search' },
    { id: 'p2', key: 'x', value: '2', enabled: false },
  ];

  it('maps params to rows and routes edits to the param handlers', () => {
    const { fn } = renderTabs({ ...base, params });
    const table = last(captured.tables);
    expect(table.itemLabel).toBe('parameter');
    expect(table.layout).toBe('fill');
    expect(table.rows).toEqual([
      { id: 'p1', key: 'q', value: '1', enabled: true, description: 'search' },
      { id: 'p2', key: 'x', value: '2', enabled: false },
    ]);

    (table.onRowChange as (r: unknown) => void)({
      id: 'p1',
      enabled: false,
      key: 'k',
      value: 'v',
      description: 'd',
    });
    expect(fn('updateParam')).toHaveBeenCalledWith('p1', {
      enabled: false,
      key: 'k',
      value: 'v',
      description: 'd',
    });
    (table.onRowChange as (r: unknown) => void)({ id: 'p2', enabled: true, key: 'a', value: 'b' });
    expect(fn('updateParam')).toHaveBeenLastCalledWith('p2', {
      enabled: true,
      key: 'a',
      value: 'b',
    });

    (table.onRowRemove as (id: string) => void)('p2');
    expect(fn('removeParam')).toHaveBeenCalledWith('p2');
    (table.onAdd as (d: unknown) => void)({ key: 'n' });
    expect(fn('addParam')).toHaveBeenCalledWith({ key: 'n' });
    expect(table.onReplaceAll).toBe(fn('replaceParams'));
  });

  it('switches the params table to auto layout when the URL has path variables', () => {
    const { fn } = renderTabs({
      ...base,
      url: 'https://example.test/users/:id',
      pathVariables: [{ id: 'pv', key: 'id', value: '42', enabled: true }],
    });
    expect(last(captured.tables).layout).toBe('auto');
    const pathVars = last(captured.pathVars);
    expect((pathVars.rows as Array<{ key: string }>).map((r) => r.key)).toEqual(['id']);
    expect(pathVars.onChange).toBe(fn('replacePathVariables'));
  });
});

describe('RequestBuilderTabs headers panel', () => {
  it('routes header edits to the header handlers with suggestions', () => {
    const { fn } = renderTabs(
      { ...base, headers: [{ id: 'h1', key: 'Accept', value: '*/*', enabled: true }] },
      'headers'
    );
    const table = last(captured.tables);
    expect(table.itemLabel).toBe('header');
    expect(Array.isArray(table.keySuggestions)).toBe(true);
    expect(typeof table.valueSuggestionsFor).toBe('function');

    (table.onRowChange as (r: unknown) => void)({
      id: 'h1',
      enabled: true,
      key: 'Accept',
      value: 'application/json',
      description: 'fmt',
    });
    expect(fn('updateHeader')).toHaveBeenCalledWith('h1', {
      enabled: true,
      key: 'Accept',
      value: 'application/json',
      description: 'fmt',
    });
    (table.onRowChange as (r: unknown) => void)({ id: 'h1', enabled: false, key: 'A', value: 'B' });
    expect(fn('updateHeader')).toHaveBeenLastCalledWith('h1', {
      enabled: false,
      key: 'A',
      value: 'B',
    });
    (table.onRowRemove as (id: string) => void)('h1');
    expect(fn('removeHeader')).toHaveBeenCalledWith('h1');
    (table.onAdd as (d: unknown) => void)(undefined);
    expect(fn('addHeader')).toHaveBeenCalledWith(undefined);
    expect(table.onReplaceAll).toBe(fn('replaceHeaders'));
  });
});

describe('RequestBuilderTabs body panel', () => {
  it('omits the Content-Type label and size footer for an empty body', () => {
    renderTabs(base, 'body');
    expect(screen.queryByTestId('body-content-type')).not.toBeInTheDocument();
    expect(screen.queryByText(/\d+ B$/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Beautify/ })).not.toBeInTheDocument();
  });

  it('beautifies a valid JSON body', async () => {
    const { fn } = renderTabs({ ...base, body: { type: 'json', raw: '{"a":1}' } }, 'body');
    await userEvent.click(screen.getByRole('button', { name: /Beautify/ }));
    expect(fn('changeBodyContent')).toHaveBeenCalledWith('{\n  "a": 1\n}');
    expect(toastError).not.toHaveBeenCalled();
  });

  it('toasts instead of changing the body when the JSON is invalid', async () => {
    const { fn } = renderTabs({ ...base, body: { type: 'json', raw: '{nope' } }, 'body');
    await userEvent.click(screen.getByRole('button', { name: /Beautify/ }));
    expect(toastError).toHaveBeenCalledWith('The body isn’t valid JSON');
    expect(fn('changeBodyContent')).not.toHaveBeenCalled();
  });

  it('disables Beautify for a blank JSON body', () => {
    renderTabs({ ...base, body: { type: 'json', raw: '   ' } }, 'body');
    expect(screen.getByRole('button', { name: /Beautify/ })).toBeDisabled();
  });

  it.each([
    ['form-data', 'multipart/form-data'],
    ['x-www-form-urlencoded', 'application/x-www-form-urlencoded'],
    ['graphql', 'application/json'],
    ['text', 'text/plain'],
    ['xml', 'application/xml'],
    ['binary', 'application/octet-stream'],
  ] as const)('labels a %s body with its default Content-Type', (type, contentType) => {
    renderTabs({ ...base, body: { type } }, 'body');
    expect(screen.getByTestId('body-content-type')).toHaveTextContent(contentType);
  });

  it('ignores blank or disabled Content-Type headers and keeps the last enabled one', () => {
    renderTabs(
      {
        ...base,
        body: { type: 'xml' },
        headers: [
          { id: 'a', key: 'Content-Type', value: 'text/first', enabled: true },
          { id: 'b', key: ' content-type ', value: '   ', enabled: true },
          { id: 'c', key: 'CONTENT-TYPE', value: ' text/second ', enabled: true },
          { id: 'd', key: 'Content-Type', value: 'text/off', enabled: false },
        ],
      },
      'body'
    );
    const label = screen.getByTestId('body-content-type');
    expect(label).toHaveTextContent('text/second');
    expect(label).toHaveAttribute('title', 'Overrides the default application/xml');
  });

  it('passes the body, schema and GraphQL variables through to the editor', () => {
    const graphqlSchema = { sdl: 'type Query { a: Int }' } as NonNullable<
      HttpRequest['graphqlSchema']
    >;
    const { fn } = renderTabs(
      {
        ...base,
        url: 'https://api.test/gql',
        graphqlSchema,
        body: { type: 'graphql', raw: '{ a }', graphqlVariables: '{"v":1}' },
      },
      'body'
    );
    const editor = last(captured.body);
    expect(editor.url).toBe('https://api.test/gql');
    expect(editor.graphqlSchema).toBe(graphqlSchema);
    expect(editor.graphqlVariables).toBe('{"v":1}');
    expect(editor.onBodyContentChange).toBe(fn('changeBodyContent'));
    expect(editor.onFormDataChange).toBe(fn('changeFormData'));
    expect(editor.onUrlEncodedChange).toBe(fn('changeUrlEncoded'));
    expect(editor.onGraphQLVariablesChange).toBe(fn('changeGraphQLVariables'));
  });

  it('omits schema and GraphQL variables when the request has none', () => {
    renderTabs({ ...base, body: { type: 'json', raw: '{}' } }, 'body');
    const editor = last(captured.body);
    expect(editor).not.toHaveProperty('graphqlSchema');
    expect(editor).not.toHaveProperty('graphqlVariables');
  });

  it.each([
    ['x', '1 B'],
    ['a'.repeat(2048), '2.0 KB'],
    ['a'.repeat(3 * 1024 * 1024), '3.00 MB'],
  ])('shows the body size (%#)', (raw, size) => {
    renderTabs({ ...base, body: { type: 'text', raw } }, 'body');
    expect(screen.getByText(size)).toBeInTheDocument();
  });

  it('lists the variables a request references, flagging unresolved ones', () => {
    renderTabs(
      {
        ...base,
        url: 'https://example.test/{{known}}',
        params: [{ id: 'p', key: 'q', value: '{{inParam}}', enabled: true }],
        pathVariables: [{ id: 'pv', key: 'id', value: '{{inPath}}', enabled: true }],
        headers: [{ id: 'h', key: 'X', value: '{{inHeader}}', enabled: true }],
        body: { type: 'none' },
      },
      'body'
    );
    expect(screen.getByText('Vars')).toBeInTheDocument();
    expect(screen.getByText('{{known}}')).not.toHaveAttribute('title');
    expect(screen.getByText('{{inParam}}')).toHaveAttribute(
      'title',
      'Unresolved variable: inParam'
    );
    expect(screen.getByText('{{inPath}}')).toHaveClass('sp-variable-unresolved');
    expect(screen.getByText('{{inHeader}}')).toBeInTheDocument();
    // No body text → size reads 0 B while the variable list still shows.
    expect(screen.getByText('0 B')).toBeInTheDocument();
  });
});

describe('RequestBuilderTabs other panels', () => {
  it('renders the auth picker and config wired to changeAuth', () => {
    const auth = { type: 'bearer', bearer: { token: 't' } } as HttpRequest['auth'];
    const { fn } = renderTabs({ ...base, auth }, 'auth');
    expect(screen.getByTestId('inherited-hint')).toBeInTheDocument();
    const picker = last(captured.picker);
    expect(picker.ariaLabel).toBe('Authentication type');
    expect((picker.groups as Array<{ label: string }>).map((g) => g.label)).toEqual([
      'Common',
      'OAuth',
      'Enterprise',
    ]);
    expect(picker.onChange).toBe(fn('changeAuth'));
    expect(last(captured.authConfig).auth).toBe(auth);
  });

  it('passes scripts (defaulting to empty) to the scripts editor', () => {
    const { fn } = renderTabs({ ...base, testScript: 'pm.test()' }, 'scripts');
    const scripts = last(captured.scripts);
    expect(scripts.preRequestScript).toBe('');
    expect(scripts.testScript).toBe('pm.test()');
    expect(scripts.onPreRequestScriptChange).toBe(fn('changePreRequestScript'));
    expect(scripts.onTestScriptChange).toBe(fn('changeTestScript'));
  });

  it('passes request and global settings to the settings editor', () => {
    const { fn, globalSettings } = renderTabs(base, 'settings');
    const settings = last(captured.settings);
    expect(settings.settings).toBeUndefined();
    expect(settings.globalSettings).toBe(globalSettings);
    expect(settings.onSettingsChange).toBe(fn('changeSettings'));
    expect(settings.onToggleOverride).toBe(fn('toggleSettingsOverride'));
    expect(settings.onProxyOverrideChange).toBe(fn('changeProxyOverride'));
  });
});
