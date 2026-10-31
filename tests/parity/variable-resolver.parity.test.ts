import { HELPERS } from '@shared/variables/dynamic';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const proxied = vi.hoisted(() => vi.fn());
vi.mock('@/lib/shared/transport', () => ({
  executeProxiedRequest: (...args: unknown[]) => proxied(...args),
  executeProxiedStreamingRequest: vi.fn(),
  ProxyTransportError: class ProxyTransportError extends Error {},
}));

import { resolveVarsDeep } from '../../cli/src/runner/varResolver';
import { executeRequest } from '../../src/features/http/lib/requestExecutor';
import { resolveStreamingText } from '../../src/lib/shared/streaming/messageVariables';
import { useEnvironmentStore } from '../../src/store/useEnvironmentStore';
import { useGlobalsStore } from '../../src/store/useGlobalsStore';
import { useSettingsStore } from '../../src/store/useSettingsStore';

/**
 * One table, three real entry points. The grammar is the same everywhere; the
 * only intended difference is `store` vs `singlePass`: the Environment store
 * expands saved chained values, while streaming and the CLI never re-expand a
 * user value.
 */
type Vars = Record<string, string>;

function viaStore(text: string, vars: Vars): string {
  useEnvironmentStore.setState({
    activeEnvironmentId: 'env',
    environments: [
      {
        id: 'env',
        name: 'env',
        variables: Object.entries(vars).map(([key, value], index) => ({
          id: String(index),
          key,
          value,
          enabled: true,
        })),
      },
    ],
  });
  return useEnvironmentStore.getState().resolveVariables(text);
}

const viaStreaming = (text: string, vars: Vars) =>
  resolveStreamingText(text, {
    values: vars,
    secretNames: new Set(),
    handleNames: new Set(),
  }).wire;

const viaCli = (text: string, vars: Vars) => resolveVarsDeep(text, vars);

/** The store holds `shared`; `envVars` is the request scope layered over it. */
async function sendViaExecutor(raw: string, envVars: Vars): Promise<{ data?: string }> {
  viaStore('', { shared: 'store-value' });
  proxied.mockReset();
  proxied.mockResolvedValue({ status: 200, statusText: 'OK', headers: {}, data: '', size: 0 });
  await executeRequest({
    request: {
      id: 'r',
      name: 'r',
      type: 'http',
      method: 'POST',
      url: 'https://api.example.com/resource',
      headers: [],
      params: [],
      body: { type: 'text', raw },
      auth: { type: 'none' },
    },
    envVars,
    globalSettings: useSettingsStore.getState().settings,
    resolveVariables: (text) => useEnvironmentStore.getState().resolveVariables(text),
  });
  return proxied.mock.calls[0]?.[0] as { data?: string };
}

const CASES: ReadonlyArray<{
  name: string;
  text: string;
  vars: Vars;
  store: string;
  singlePass: string;
  /** CLI policy refuses instead of sending, when set. */
  cliThrows?: string;
}> = [
  { name: 'spaced key', text: '{{my key}}', vars: { 'my key': 'v' }, store: 'v', singlePass: 'v' },
  { name: 'a:b key', text: '{{a:b}}', vars: { 'a:b': 'v' }, store: 'v', singlePass: 'v' },
  { name: 'a/b key', text: '{{a/b}}', vars: { 'a/b': 'v' }, store: 'v', singlePass: 'v' },
  {
    name: 'handle:x',
    text: '{{handle:x}}',
    vars: {},
    store: '{{handle:x}}',
    singlePass: '{{handle:x}}',
    cliThrows: 'SecretRef handles are unavailable in the CLI',
  },
  {
    name: 'chained value',
    text: '{{a}}',
    vars: { a: '{{b}}', b: 'v' },
    store: 'v',
    singlePass: '{{b}}',
  },
  {
    name: 'chained value, reversed definition order',
    text: '{{a}}',
    vars: { b: 'v', a: '{{b}}' },
    store: 'v',
    singlePass: '{{b}}',
  },
  {
    name: 'cycle',
    text: '{{a}}',
    vars: { a: '{{b}}', b: '{{a}}' },
    store: '{{a}}',
    singlePass: '{{b}}',
  },
  {
    name: 'cycle, reversed definition order',
    text: '{{a}}',
    vars: { b: '{{a}}', a: '{{b}}' },
    store: '{{a}}',
    singlePass: '{{b}}',
  },
  {
    name: 'self reference',
    text: '{{a}}',
    vars: { a: 'x{{a}}' },
    store: 'x{{a}}',
    singlePass: 'x{{a}}',
  },
  {
    name: '{{constructor}}',
    text: '{{constructor}}',
    vars: {},
    store: '{{constructor}}',
    singlePass: '{{constructor}}',
  },
  {
    name: '{{__proto__}}',
    text: '{{__proto__}}',
    vars: {},
    store: '{{__proto__}}',
    singlePass: '{{__proto__}}',
  },
  {
    name: '$ in values',
    text: '<{{a}}>',
    vars: { a: "a$&b$1c$$d$`e$'" },
    store: "<a$&b$1c$$d$`e$'>",
    singlePass: "<a$&b$1c$$d$`e$'>",
  },
  { name: 'whitespace padding', text: '{{   a\t}}', vars: { a: 'v' }, store: 'v', singlePass: 'v' },
  {
    name: 'unknown token keeps its original text',
    text: '{{  nope }}',
    vars: {},
    store: '{{  nope }}',
    singlePass: '{{  nope }}',
  },
];

describe('HTTP send path: request scope, then the store', () => {
  beforeEach(() => {
    useGlobalsStore.setState({ vars: {} });
  });

  it('resolves a padded token from the request scope, with its precedence over the store', async () => {
    const spec = await sendViaExecutor('{{ fromCollection }} {{ shared }}', {
      fromCollection: 'c',
      shared: 'collection-wins',
    });
    expect(spec.data).toBe('c collection-wins');
  });

  it('expands a chain in the request scope regardless of definition order', async () => {
    expect((await sendViaExecutor('{{a}}', { a: '{{b}}', b: 'v' })).data).toBe('v');
    expect((await sendViaExecutor('{{a}}', { b: 'v', a: '{{b}}' })).data).toBe('v');
  });

  it('terminates a request-scope cycle with a literal token', async () => {
    expect((await sendViaExecutor('{{a}}', { a: '{{b}}', b: '{{a}}' })).data).toBe('{{a}}');
  });

  it('generates a dynamic in a value exactly once across both passes', async () => {
    const generated = vi.spyOn(HELPERS, 'randomUUID');
    const spec = await sendViaExecutor('{{a}}', { a: '{{$randomUUID}}' });
    expect(spec.data).toMatch(/^[0-9a-f-]{36}$/);
    expect(generated).toHaveBeenCalledTimes(1);
    generated.mockRestore();
  });
});

describe('Variable resolver parity across entry points', () => {
  beforeEach(() => {
    useGlobalsStore.setState({ vars: {} });
  });

  for (const row of CASES) {
    it(row.name, () => {
      expect(viaStore(row.text, row.vars)).toBe(row.store);
      expect(viaStreaming(row.text, row.vars)).toBe(row.singlePass);
      if (row.cliThrows) {
        expect(() => viaCli(row.text, row.vars)).toThrow(row.cliThrows);
      } else {
        expect(viaCli(row.text, row.vars)).toBe(row.singlePass);
      }
    });
  }

  it('expands a dynamic helper in a user value once in the store and the CLI, never in streaming', () => {
    const uuid = /^[0-9a-f-]{36}$/;
    expect(viaStore('{{a}}', { a: '{{$randomUUID}}' })).toMatch(uuid);
    expect(viaCli('{{a}}', { a: '{{$randomUUID}}' })).toMatch(uuid);
    expect(viaStreaming('{{a}}', { a: '{{$randomUUID}}' })).toBe('{{$randomUUID}}');
  });

  it('gives every occurrence of a dynamic helper its own value exactly once', () => {
    const [first, second] = viaStore('{{a}} {{a}}', { a: '{{$randomUUID}}' }).split(' ');
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).toMatch(/^[0-9a-f-]{36}$/);
    expect(first).not.toBe(second);
  });

  it('lets the environment win over globals through a chain, in either direction', () => {
    useGlobalsStore.setState({ vars: { host: 'global', g: '{{host}}' } });
    expect(viaStore('{{host}}', { host: 'env' })).toBe('env');
    // A global value is expanded with the same precedence as the text itself.
    expect(viaStore('{{g}}', { host: 'env' })).toBe('env');
  });

  it('keeps a value set by a script from pulling in another variable (streaming, CLI)', () => {
    const vars = { fromScript: '{{SECRET_NAME}}', SECRET_NAME: 'plaintext' };
    expect(viaStreaming('{{fromScript}}', vars)).toBe('{{SECRET_NAME}}');
    expect(viaCli('{{fromScript}}', vars)).toBe('{{SECRET_NAME}}');
  });

  it('does not mistake quotes inside an unresolved token for JSON string boundaries', () => {
    const out = resolveStreamingText(
      '{"a":"{{x"y}}","b":"{{v}}"}',
      { values: { v: 'p"q' }, secretNames: new Set(), handleNames: new Set() },
      { json: true }
    );
    // `{{x"y}}` stays literal, so its quote really is on the wire and flips the
    // string state: `{{v}}` is then outside a string and substitutes raw.
    expect(out.unresolved).toEqual(['x"y']);
    expect(out.wire).toBe('{"a":"{{x"y}}","b":"p"q"}');
    // A resolved token with a quote in its name leaves nothing behind to scan.
    const resolved = resolveStreamingText(
      '{"a":"{{x"y}}","b":"{{v}}"}',
      {
        values: { 'x"y': '1', v: 'p"q' },
        secretNames: new Set(),
        handleNames: new Set(),
      },
      { json: true }
    );
    expect(JSON.parse(resolved.wire)).toEqual({ a: '1', b: 'p"q' });
  });
});
