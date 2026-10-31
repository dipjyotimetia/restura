// A secret-backed variable must stay opaque in the renderer under the SAME name
// grammar the resolver core uses (ADR-0007). If the core accepted `{{my secret}}`
// but the secret matcher did not, the store would consume the token with its
// masked placeholder and main could never substitute the real value.
import {
  basicAuthReferencesSecretVariable,
  referencesSecretVariable,
  replaceSecretVariableTokenMatches,
} from '@shared/variables/secret-variable-token';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const proxied = vi.hoisted(() => vi.fn());
const platform = vi.hoisted(() => ({ electron: true }));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  session: { defaultSession: { resolveProxy: vi.fn() } },
}));
vi.mock('../../electron/main/security/secret-handle-store', () => ({
  unwrapSecretValueMain: () => 'S3CRET',
}));
vi.mock('../../electron/main/security/external-secret-providers', () => ({
  desktopExternalSecretResolver: { resolve: vi.fn() },
}));
vi.mock('@/lib/shared/transport', () => ({
  executeProxiedRequest: (...args: unknown[]) => proxied(...args),
  executeProxiedStreamingRequest: vi.fn(),
  ProxyTransportError: class ProxyTransportError extends Error {},
}));
vi.mock('@/lib/shared/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/shared/platform')>()),
  isElectron: () => platform.electron,
}));

import { SECRET_HANDLE_PLACEHOLDER } from '@shared/secrets/secret-ref';
import {
  materializeSecretVariables,
  replaceSecretVariableTokens,
} from '../../electron/main/security/secret-variable-materializer';
import { executeRequest } from '../../src/features/http/lib/requestExecutor';
import { buildActiveRequestVariableResolution } from '../../src/lib/shared/activeRequestScopes';
import { findVariableTokens } from '../../src/lib/shared/variableTokens';
import { useEnvironmentStore } from '../../src/store/useEnvironmentStore';
import { useGlobalsStore } from '../../src/store/useGlobalsStore';
import { useSettingsStore } from '../../src/store/useSettingsStore';
import type { HttpRequest, ScopedVariable } from '../../src/types';

const HANDLE = { kind: 'handle', id: 'h-secret' } as const;
const NAME = 'my secret';

function useEnvironment(variables: Partial<ScopedVariable>[]) {
  useEnvironmentStore.setState({
    activeEnvironmentId: 'env',
    environments: [
      {
        id: 'env',
        name: 'env',
        variables: variables.map((variable, index) => ({
          id: String(index),
          key: '',
          value: '',
          enabled: true,
          ...variable,
        })),
      },
    ],
  });
}

function request(overrides: Partial<HttpRequest>): HttpRequest {
  return {
    id: 'r',
    name: 'r',
    type: 'http',
    method: 'POST',
    url: 'https://api.example.com/resource',
    headers: [],
    params: [],
    body: { type: 'none' },
    auth: { type: 'none' },
    ...overrides,
  };
}

async function send(req: HttpRequest, envVars: Record<string, string> = {}) {
  proxied.mockClear();
  await executeRequest({
    request: req,
    envVars,
    secretVariables: { [NAME]: HANDLE },
    globalSettings: useSettingsStore.getState().settings,
    resolveVariables: (text) => useEnvironmentStore.getState().resolveVariables(text),
  });
  return proxied.mock.calls[0]?.[0] as {
    url: string;
    headers: Record<string, string>;
    data?: string;
    auth?: { basic?: { password?: unknown } };
  };
}

describe('secret-variable token grammar agrees with the resolver core', () => {
  const isSecret = (name: string) => name === NAME;

  for (const text of ['{{my secret}}', '{{ my secret }}', '{{\tmy secret\n}}']) {
    it(`renderer and main both see ${JSON.stringify(text)} as the secret`, () => {
      expect(findVariableTokens(text).map((token) => token.name)).toEqual([NAME]);
      expect(referencesSecretVariable(text, isSecret)).toBe(true);
      expect(replaceSecretVariableTokenMatches(text, isSecret, () => 'X')).toBe('X');
      expect(replaceSecretVariableTokens(text, { [NAME]: 'S3CRET' })).toBe('S3CRET');
    });
  }

  it('agrees with the core on names that used to be refused', () => {
    for (const name of ['a b', 'a:b', 'a/b', '$x', 'a"b']) {
      const text = `pre {{ ${name} }} post`;
      expect(findVariableTokens(text).map((token) => token.name)).toEqual([name]);
      expect(referencesSecretVariable(text, (candidate) => candidate === name)).toBe(true);
    }
  });

  it('does not treat a blank token as a reference to anything', () => {
    expect(referencesSecretVariable('{{ }}', () => true)).toBe(false);
    expect(
      replaceSecretVariableTokenMatches(
        '{{ }}',
        () => true,
        () => 'X'
      )
    ).toBe('{{ }}');
  });

  it('never resolves an inherited name in main', () => {
    expect(replaceSecretVariableTokens('{{constructor}} {{__proto__}}', { a: '1' })).toBe(
      '{{constructor}} {{__proto__}}'
    );
  });

  it('detects a spaced secret in Basic credentials', () => {
    expect(
      basicAuthReferencesSecretVariable({ username: 'u', password: '{{my secret}}' }, isSecret)
    ).toBe(true);
  });
});

describe('a secret-backed variable with a space stays opaque on the HTTP send path', () => {
  beforeEach(() => {
    platform.electron = true;
    useGlobalsStore.setState({ vars: {} });
    proxied.mockResolvedValue({ status: 200, statusText: 'OK', headers: {}, data: '', size: 0 });
    useEnvironment([{ key: NAME, value: SECRET_HANDLE_PLACEHOLDER, secretRef: HANDLE }]);
  });

  for (const token of ['{{my secret}}', '{{ my secret }}']) {
    it(`keeps ${token} out of the store and lets main materialize it`, async () => {
      const spec = await send(
        request({
          headers: [{ id: 'h', key: 'X-Key', value: token, enabled: true }],
          body: { type: 'text', raw: token },
        })
      );
      const wire = JSON.stringify(spec);
      expect(wire).not.toContain(SECRET_HANDLE_PLACEHOLDER);
      expect(wire).not.toContain('__restura_secret_');
      expect(spec.headers['X-Key']).toBe(token);
      expect(spec.data).toBe(token);

      const out = await materializeSecretVariables({
        url: spec.url,
        headers: spec.headers,
        ...(spec.data !== undefined ? { data: spec.data } : {}),
        secretVariables: { [NAME]: HANDLE },
      });
      expect(out.headers?.['X-Key']).toBe('S3CRET');
      expect(out.data).toBe('S3CRET');
    });
  }

  it('defers Basic to main rather than encoding the token or the placeholder', async () => {
    const spec = await send(
      request({
        auth: {
          type: 'basic',
          basic: { username: 'u', password: { kind: 'inline', value: '{{my secret}}' } },
        },
      })
    );
    expect(spec.headers['Authorization']).toBeUndefined();
    expect(spec.auth?.basic?.password).toEqual({ kind: 'inline', value: '{{my secret}}' });
  });

  for (const [label, order] of [
    ['alias defined first', ['alias', NAME]],
    ['secret defined first', [NAME, 'alias']],
  ] as const) {
    for (const token of ['{{alias}}', '{{ alias }}']) {
      it(`does not reveal the placeholder through a chain: ${token}, ${label}`, async () => {
        const variables: Record<string, Partial<ScopedVariable>> = {
          alias: { key: 'alias', value: '{{my secret}}' },
          [NAME]: { key: NAME, value: SECRET_HANDLE_PLACEHOLDER, secretRef: HANDLE },
        };
        useEnvironment(order.map((key) => variables[key] as Partial<ScopedVariable>));
        const spec = await send(
          request({ headers: [{ id: 'h', key: 'X-Key', value: token, enabled: true }] }),
          { alias: '{{my secret}}' }
        );
        expect(spec.headers['X-Key']).toBe('{{my secret}}');
      });
    }
  }

  it('keeps the store walk as it has always been when the request scope does not hold an alias', () => {
    // Definition order decides, as it always has; neither order produces plaintext.
    useEnvironment([
      { key: 'alias', value: '{{my secret}}' },
      { key: NAME, value: SECRET_HANDLE_PLACEHOLDER, secretRef: HANDLE },
    ]);
    expect(useEnvironmentStore.getState().resolveVariables('{{alias}}')).toBe(
      SECRET_HANDLE_PLACEHOLDER
    );
    useEnvironment([
      { key: NAME, value: SECRET_HANDLE_PLACEHOLDER, secretRef: HANDLE },
      { key: 'alias', value: '{{my secret}}' },
    ]);
    expect(useEnvironmentStore.getState().resolveVariables('{{alias}}')).toBe('{{my secret}}');
  });

  it('does not let the store pass hand main a token main would not have received', async () => {
    useEnvironment([
      { key: 'alias', value: '{{my secret}}' },
      { key: NAME, value: SECRET_HANDLE_PLACEHOLDER, secretRef: HANDLE },
    ]);
    const spec = await send(
      request({ headers: [{ id: 'h', key: 'X-Key', value: '{{next}}', enabled: true }] }),
      { alias: '{{my secret}}', next: '{{alias}}' }
    );
    expect(spec.headers['X-Key']).toBe(SECRET_HANDLE_PLACEHOLDER);
  });
});

describe('a secret-backed row whose key has surrounding whitespace', () => {
  beforeEach(() => {
    platform.electron = true;
    useGlobalsStore.setState({ vars: {} });
    proxied.mockResolvedValue({ status: 200, statusText: 'OK', headers: {}, data: '', size: 0 });
  });

  it('matches the trimmed token, so the shield and the materializer never send the mask', async () => {
    useEnvironment([{ key: ' k ', value: SECRET_HANDLE_PLACEHOLDER, secretRef: HANDLE }]);
    const { values, secretVariables } = buildActiveRequestVariableResolution();
    expect(Object.keys(secretVariables)).toEqual(['k']);
    expect(Object.keys(values)).toEqual([]);

    proxied.mockClear();
    await executeRequest({
      request: request({
        headers: [{ id: 'h', key: 'X-Key', value: '{{k}}', enabled: true }],
      }),
      envVars: values,
      secretVariables,
      globalSettings: useSettingsStore.getState().settings,
      resolveVariables: (text) => useEnvironmentStore.getState().resolveVariables(text),
    });
    const spec = proxied.mock.calls[0]?.[0] as { url: string; headers: Record<string, string> };
    expect(spec.headers['X-Key']).toBe('{{k}}');
    const out = await materializeSecretVariables({
      url: spec.url,
      headers: spec.headers,
      secretVariables,
    });
    expect(out.headers?.['X-Key']).toBe('S3CRET');
  });

  it('lets a later plain row of the same trimmed name win, with no stale key behind it', () => {
    useEnvironment([{ key: ' k ', value: 'plain' }]);
    const { values, secretVariables } = buildActiveRequestVariableResolution();
    expect(values).toEqual({ k: 'plain' });
    expect(secretVariables).toEqual({});
  });
});

describe('the shared token scanner stays linear on adversarial input', () => {
  const SIZE = 200_000;
  const BUDGET_MS = 1_000;
  const SHAPES: Record<string, string> = {
    'open braces': '{'.repeat(SIZE),
    'open pairs': '{{'.repeat(SIZE / 2),
    'open pair then spaces': `{{${' '.repeat(SIZE)}`,
    'open pair then text': `{{${'a'.repeat(SIZE)}`,
    'repeated unterminated tokens': '{{a'.repeat(SIZE / 3),
    'single close after text': `{{${'a'.repeat(SIZE)}}`,
    'blank tokens': '{{ }}'.repeat(SIZE / 5),
    'close braces': '}'.repeat(SIZE),
    'tokens with a newline': '{{a\nb}}'.repeat(SIZE / 7),
    'open pair then newlines': `{{${'\n'.repeat(SIZE)}}}`,
  };
  for (const [name, input] of Object.entries(SHAPES)) {
    it(name, () => {
      const start = performance.now();
      findVariableTokens(input);
      referencesSecretVariable(input, () => true);
      expect(performance.now() - start).toBeLessThan(BUDGET_MS);
    });
  }
});
