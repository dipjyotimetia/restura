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
 * walks its variables in definition order, so a chain only follows forward and
 * the result deliberately depends on that order, while streaming and the CLI
 * never re-expand a user value.
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
async function sendViaExecutor(
  raw: string,
  envVars: Vars,
  storeVars: Vars = { shared: 'store-value' }
): Promise<{ data?: string }> {
  viaStore('', storeVars);
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
    store: '{{b}}',
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
    store: '{{b}}',
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

  it('walks the request scope in insertion order, so a chain only follows forward', async () => {
    expect((await sendViaExecutor('{{a}}', { a: '{{b}}', b: 'v' })).data).toBe('v');
    expect((await sendViaExecutor('{{a}}', { b: 'v', a: '{{b}}' })).data).toBe('{{b}}');
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

  it('applies globals after the environment, only to tokens still present', () => {
    useGlobalsStore.setState({ vars: { host: 'global', g: '{{host}}' } });
    expect(viaStore('{{host}}', { host: 'env' })).toBe('env');
    // The environment pass is over by the time a global's value arrives, and
    // `host` comes before `g` in the globals walk, so the token stays.
    expect(viaStore('{{g}}', { host: 'env' })).toBe('{{host}}');
    useGlobalsStore.setState({ vars: { g: '{{host}}', host: 'global' } });
    expect(viaStore('{{g}}', { host: 'env' })).toBe('global');
    // An environment value reaches globals, whatever the order.
    expect(viaStore('{{a}}', { a: '{{host}}' })).toBe('global');
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
    // Its name is not in the plain grammar, so it is text, not an unresolved variable.
    expect(out.unresolved).toEqual([]);
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

/**
 * Reach parity with the sequential loops the app has always shipped. These two
 * functions are transcribed from main (`useEnvironmentStore.resolveVariables`
 * and the executor's `resolveLocal`); the new code must give the same bytes for
 * every definition order, chain and cycle. Dynamics are left out so the output
 * is deterministic.
 */
describe('same reach as the sequential loops, for every definition order', () => {
  const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function mainStoreLoop(text: string, env: ReadonlyArray<[string, string]>, globals: Vars) {
    if (!text.includes('{{')) return text;
    let resolved = text;
    for (const [key, value] of env) {
      const regex = new RegExp(`{{\\s*${escapeRegExp(key)}\\s*}}`, 'g');
      resolved = resolved.replace(regex, () => value);
    }
    if (resolved.includes('{{')) {
      for (const [key, value] of Object.entries(globals)) {
        const regex = new RegExp(`{{\\s*${escapeRegExp(key)}\\s*}}`, 'g');
        resolved = resolved.replace(regex, () => value);
      }
    }
    return resolved;
  }

  function mainRequestLoop(text: string, envVars: Vars, env: ReadonlyArray<[string, string]>) {
    let result = text;
    for (const [key, value] of Object.entries(envVars)) {
      result = result.replace(new RegExp(`{{${escapeRegExp(key)}}}`, 'g'), () => value);
    }
    return mainStoreLoop(result, env, useGlobalsStore.getState().vars);
  }

  function permutations<T>(items: readonly T[]): T[][] {
    if (items.length <= 1) return [[...items]];
    return items.flatMap((item, index) =>
      permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
        item,
        ...rest,
      ])
    );
  }

  const SETS: ReadonlyArray<{ name: string; vars: Vars }> = [
    { name: 'chain of three', vars: { a: '{{b}}', b: '{{c}}', c: 'v' } },
    { name: 'two-cycle', vars: { a: '{{b}}', b: '{{a}}' } },
    { name: 'three-cycle', vars: { a: '{{b}}', b: '{{c}}', c: '{{a}}' } },
    { name: 'self reference', vars: { a: 'x{{a}}y', b: '{{a}}' } },
    { name: 'stored value naming a sibling', vars: { apiKey: 'k', next: '{{apiKey}}' } },
    { name: 'fan-out', vars: { a: '{{b}}-{{b}}', b: '{{c}}{{c}}', c: 'v' } },
    { name: 'a token split across a value', vars: { a: '{{', b: 'c}}', c: 'v' } },
    {
      name: 'spaced and punctuated names',
      vars: { 'my key': '{{a:b}}', 'a:b': '{{x.y}}', 'x.y': 'v' },
    },
    { name: '$ patterns stay literal', vars: { a: "$&{{b}}$1$`$'", b: '$$' } },
  ];
  const TEXTS = [
    '{{a}}',
    'p{{a}}q{{b}}r',
    '{{next}}',
    '{{my key}}',
    '{{unknown}}',
    '{{{a}}}',
    'plain',
  ];

  for (const set of SETS) {
    for (const order of permutations(Object.keys(set.vars))) {
      const env = order.map((key): [string, string] => [key, set.vars[key] as string]);

      it(`store: ${set.name}, order ${order.join(',')}`, () => {
        useGlobalsStore.setState({ vars: {} });
        for (const text of TEXTS) {
          expect(viaStore(text, Object.fromEntries(env))).toBe(mainStoreLoop(text, env, {}));
        }
      });

      it(`store then globals: ${set.name}, order ${order.join(',')}`, () => {
        const split = Math.ceil(env.length / 2);
        const globals = Object.fromEntries(env.slice(split));
        useGlobalsStore.setState({ vars: globals });
        for (const text of TEXTS) {
          expect(viaStore(text, Object.fromEntries(env.slice(0, split)))).toBe(
            mainStoreLoop(text, env.slice(0, split), globals)
          );
        }
      });

      it(`executor: ${set.name}, order ${order.join(',')}`, async () => {
        useGlobalsStore.setState({ vars: {} });
        for (const text of TEXTS) {
          const envVars = Object.fromEntries(env);
          const sent = await sendViaExecutor(text, envVars);
          expect(sent.data).toBe(mainRequestLoop(text, envVars, [['shared', 'store-value']]));
        }
      });

      it(`request scope stops short, store continues: ${set.name}, order ${order.join(',')}`, async () => {
        useGlobalsStore.setState({ vars: {} });
        // Half the keys in the request scope, the other half only in the store.
        const split = Math.ceil(env.length / 2);
        const envVars = Object.fromEntries(env.slice(0, split));
        const storeEnv = env.slice(split);
        for (const text of TEXTS) {
          const sent = await sendViaExecutor(text, envVars, Object.fromEntries(storeEnv));
          expect(sent.data).toBe(mainRequestLoop(text, envVars, storeEnv));
        }
      });
    }
  }

  it('pins the order the app has always had: an earlier key is out of reach', () => {
    useGlobalsStore.setState({ vars: {} });
    expect(viaStore('{{next}}', { apiKey: 'k', next: '{{apiKey}}' })).toBe('{{apiKey}}');
    expect(viaStore('{{next}}', { next: '{{apiKey}}', apiKey: 'k' })).toBe('k');
  });

  it('keeps padded tokens and spaced names, which the sequential store loop also matched', () => {
    useGlobalsStore.setState({ vars: {} });
    const env: Array<[string, string]> = [
      ['a', '{{ b }}'],
      ['b', 'v'],
      ['my key', 'w'],
    ];
    for (const text of ['{{ a }}', '{{\ta\n}}', '{{ my key }}']) {
      expect(viaStore(text, Object.fromEntries(env))).toBe(mainStoreLoop(text, env, {}));
    }
  });
});
