import { describe, it, expect } from 'vitest';
import type { Collection, Environment, HistoryItem, HttpRequest } from '@/types';
import { dispatchTool, postProcessResult, type McpDispatchContext } from '../dispatch';
import {
  DEFAULT_CONSENT,
  setCollectionConsent,
  setEnvironmentConsent,
  setHistoryConsent,
} from '../consent';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const httpRequest = (overrides: Partial<HttpRequest> = {}): HttpRequest => ({
  id: 'r-1',
  name: 'fetch users',
  type: 'http',
  method: 'GET',
  url: 'https://api.example.com/users',
  headers: [],
  params: [],
  body: { type: 'none' },
  auth: { type: 'none' },
  ...overrides,
});

const sampleCollection: Collection = {
  id: 'c-1',
  name: 'Public API',
  description: 'Things the agent may use',
  items: [
    {
      id: 'i-1',
      name: 'fetch users',
      type: 'request',
      request: httpRequest(),
    },
    {
      id: 'f-1',
      name: 'admin',
      type: 'folder',
      items: [
        {
          id: 'i-2',
          name: 'delete user',
          type: 'request',
          request: httpRequest({
            id: 'r-2',
            name: 'delete user',
            method: 'DELETE',
            url: 'https://api.example.com/users/{id}',
            auth: { type: 'bearer', bearer: { token: 'SUPER-SECRET-TOKEN' } },
          }),
        },
      ],
    },
  ],
};

const hiddenCollection: Collection = {
  id: 'c-hidden',
  name: 'Internal',
  items: [{ id: 'i-h', name: 'staff only', type: 'request', request: httpRequest() }],
};

const sampleEnvironment: Environment = {
  id: 'e-1',
  name: 'staging',
  variables: [
    { id: 'v-1', key: 'baseUrl', value: 'https://staging.example.com', enabled: true },
    { id: 'v-2', key: 'apiKey', value: 'plaintext-token', enabled: true, secret: true },
    { id: 'v-3', key: 'disabled', value: 'ignore me', enabled: false },
  ],
};

const sampleHistory: HistoryItem[] = [
  {
    id: 'h-1',
    request: httpRequest({ id: 'r-h1', name: 'list', url: 'https://api.example.com/list' }),
    response: {
      id: 'resp-1',
      requestId: 'r-h1',
      timestamp: 1700000000,
      status: 200,
      statusText: 'OK',
      headers: {},
      body: '[]',
      time: 80,
      size: 2,
    },
    timestamp: 1700000000,
  },
  {
    id: 'h-2',
    request: httpRequest({ id: 'r-h2', name: 'fail', url: 'https://api.example.com/fail' }),
    response: {
      id: 'resp-2',
      requestId: 'r-h2',
      timestamp: 1700001000,
      status: 500,
      statusText: 'Internal Error',
      headers: {},
      body: '',
      time: 1500,
      size: 0,
    },
    timestamp: 1700001000,
  },
];

function buildContext(overrides: Partial<McpDispatchContext> = {}): McpDispatchContext {
  // Default consent for the test suite: sample collection + sample
  // environment + history are all opted-in read-only. Individual tests
  // that need to verify the hidden-by-default behaviour pass an explicit
  // `consent: DEFAULT_CONSENT` override.
  const consent = setHistoryConsent(
    setEnvironmentConsent(
      setCollectionConsent(DEFAULT_CONSENT, sampleCollection.id, 'read-only'),
      sampleEnvironment.id,
      'read-only'
    ),
    'read-only'
  );
  return {
    collections: [sampleCollection, hiddenCollection],
    environments: [sampleEnvironment],
    history: sampleHistory,
    consent,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tool: list_collections
// ---------------------------------------------------------------------------

describe('dispatchTool — list_collections', () => {
  it('returns only collections the user has shared (default: hidden)', () => {
    const ctx = buildContext({ consent: DEFAULT_CONSENT });
    const r = dispatchTool('list_collections', {}, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.data as { collections: unknown[] }).collections).toEqual([]);
  });

  it('returns collections with read-only or full consent', () => {
    const r = dispatchTool('list_collections', {}, buildContext());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const cols = (
      r.data as { collections: Array<{ id: string; requestCount: number; executable: boolean }> }
    ).collections;
    expect(cols).toHaveLength(1);
    expect(cols[0]?.id).toBe(sampleCollection.id);
    expect(cols[0]?.requestCount).toBe(2);
    expect(cols[0]?.executable).toBe(false);
  });

  it('marks executable=true when consent level is full', () => {
    const ctx = buildContext({
      consent: setCollectionConsent(DEFAULT_CONSENT, sampleCollection.id, 'full'),
    });
    const r = dispatchTool('list_collections', {}, ctx);
    if (!r.ok) throw new Error('expected ok');
    expect(
      (r.data as { collections: Array<{ executable: boolean }> }).collections[0]?.executable
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tool: list_requests
// ---------------------------------------------------------------------------

describe('dispatchTool — list_requests', () => {
  it('refuses hidden collections', () => {
    const r = dispatchTool('list_requests', { collectionId: hiddenCollection.id }, buildContext());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/hidden from MCP agents/);
  });

  it('returns request summaries with no plaintext secrets', () => {
    const r = dispatchTool('list_requests', { collectionId: sampleCollection.id }, buildContext());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const reqs = (r.data as { requests: Array<{ name: string; authType: string }> }).requests;
    expect(reqs).toHaveLength(2);
    expect(reqs.find((r) => r.name === 'delete user')?.authType).toBe('bearer');

    // Critical: the bearer token must NOT appear anywhere in the output.
    const serialized = JSON.stringify(r.data);
    expect(serialized).not.toContain('SUPER-SECRET-TOKEN');
  });

  it('filters by folder path', () => {
    const r = dispatchTool(
      'list_requests',
      { collectionId: sampleCollection.id, folderPath: 'admin' },
      buildContext()
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const reqs = (r.data as { requests: Array<{ name: string }> }).requests;
    expect(reqs).toHaveLength(1);
    expect(reqs[0]?.name).toBe('delete user');
  });

  it('errors clearly when folder path does not exist', () => {
    const r = dispatchTool(
      'list_requests',
      { collectionId: sampleCollection.id, folderPath: 'nope' },
      buildContext()
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/Folder path not found/);
  });

  it('returns clear error for unknown collection id', () => {
    const r = dispatchTool('list_requests', { collectionId: 'bogus' }, buildContext());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/Collection not found/);
  });

  it('validates input shape', () => {
    const r = dispatchTool('list_requests', { collectionId: '' }, buildContext());
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tool: get_history
// ---------------------------------------------------------------------------

describe('dispatchTool — get_history', () => {
  it('returns recent history with the request/response summary', () => {
    const r = dispatchTool('get_history', {}, buildContext());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const entries = (r.data as { entries: Array<{ status?: number; url: string }> }).entries;
    expect(entries).toHaveLength(2);
    expect(entries[0]?.status).toBe(200);
    expect(entries[1]?.status).toBe(500);
  });

  it('respects the limit', () => {
    const r = dispatchTool('get_history', { limit: 1 }, buildContext());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.data as { entries: unknown[] }).entries).toHaveLength(1);
  });

  it('filters by url/name substring (case-insensitive)', () => {
    const r = dispatchTool('get_history', { filter: 'FAIL' }, buildContext());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const entries = (r.data as { entries: Array<{ url: string }> }).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.url).toContain('/fail');
  });

  it('rejects out-of-range limit', () => {
    const r1 = dispatchTool('get_history', { limit: 0 }, buildContext());
    const r2 = dispatchTool('get_history', { limit: 1001 }, buildContext());
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
  });

  it('refuses when history consent is hidden (default)', () => {
    const r = dispatchTool('get_history', {}, buildContext({ consent: DEFAULT_CONSENT }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/history is hidden/i);
  });

  it('returns history when historyLevel is explicitly read-only', () => {
    const ctx = buildContext({
      consent: setHistoryConsent(DEFAULT_CONSENT, 'read-only'),
    });
    const r = dispatchTool('get_history', {}, ctx);
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tool: get_environment / list_environments
// ---------------------------------------------------------------------------

describe('dispatchTool — environment tools', () => {
  it('list_environments returns id, name, variableCount', () => {
    const r = dispatchTool('list_environments', {}, buildContext());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const envs = (r.data as { environments: Array<{ id: string; variableCount: number }> })
      .environments;
    expect(envs).toHaveLength(1);
    // Two enabled variables (the `disabled` one is excluded).
    expect(envs[0]?.variableCount).toBe(2);
  });

  it('get_environment returns variables with secrets redacted', () => {
    const r = dispatchTool('get_environment', { id: sampleEnvironment.id }, buildContext());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const env = r.data as { variables: Array<{ key: string; value: string; isSecret: boolean }> };
    const byKey = new Map(env.variables.map((v) => [v.key, v]));
    expect(byKey.get('baseUrl')?.value).toBe('https://staging.example.com');
    expect(byKey.get('apiKey')?.value).toBe('(secret)');
    expect(byKey.get('apiKey')?.isSecret).toBe(true);
    expect(byKey.has('disabled')).toBe(false);

    // Critical: the plaintext value must NOT appear anywhere in the output.
    const serialized = JSON.stringify(r.data);
    expect(serialized).not.toContain('plaintext-token');
  });

  it('returns error for unknown environment id', () => {
    const r = dispatchTool('get_environment', { id: 'nope' }, buildContext());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/Environment not found/);
  });

  it('list_environments hides environments without explicit opt-in', () => {
    const r = dispatchTool('list_environments', {}, buildContext({ consent: DEFAULT_CONSENT }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.data as { environments: unknown[] }).environments).toEqual([]);
  });

  it('get_environment refuses to read a hidden environment', () => {
    const r = dispatchTool(
      'get_environment',
      { id: sampleEnvironment.id },
      buildContext({ consent: DEFAULT_CONSENT })
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/hidden from MCP agents/);
  });

  it('get_environment exposes once the environment is opted-in', () => {
    const ctx = buildContext({
      consent: setEnvironmentConsent(DEFAULT_CONSENT, sampleEnvironment.id, 'read-only'),
    });
    const r = dispatchTool('get_environment', { id: sampleEnvironment.id }, ctx);
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unknown tool / execute_request stub
// ---------------------------------------------------------------------------

describe('dispatchTool — error paths', () => {
  it('returns clear error for unknown tool name', () => {
    const r = dispatchTool('rm_dash_rf', {}, buildContext());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/Unknown tool/);
  });

  it('execute_request always refuses in v1 (deferred)', () => {
    const r = dispatchTool(
      'execute_request',
      { collectionId: sampleCollection.id, requestId: 'i-1' },
      buildContext()
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/not enabled/);
  });
});

// ---------------------------------------------------------------------------
// postProcessResult — belt-and-braces redaction
// ---------------------------------------------------------------------------

describe('postProcessResult — deep redaction', () => {
  it('wipes secret-named fields anywhere in the result tree', () => {
    const result = postProcessResult({
      ok: true,
      data: {
        nested: {
          auth: { type: 'bearer', token: 'leak-1' },
          deep: { wrapper: { secretKey: 'leak-2' } },
        },
        list: [{ password: 'leak-3' }, { ok: true }],
      },
    });
    const s = JSON.stringify(result);
    expect(s).not.toContain('leak-1');
    expect(s).not.toContain('leak-2');
    expect(s).not.toContain('leak-3');
  });

  it('passes through non-ok results unchanged', () => {
    const r = postProcessResult({ ok: false, error: 'nope' });
    expect(r).toEqual({ ok: false, error: 'nope' });
  });

  it('handles SecretRef inline by reducing value to empty string', () => {
    const result = postProcessResult({
      ok: true,
      data: { auth: { token: { kind: 'inline', value: 'plain' } } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(result.data)).not.toContain('plain');
  });

  it('handles SecretRef handle by surfacing label-only metadata', () => {
    const result = postProcessResult({
      ok: true,
      data: { auth: { token: { kind: 'handle', id: 'h-1', label: 'AWS prod' } } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const s = JSON.stringify(result.data);
    expect(s).toContain('AWS prod');
    expect(s).not.toContain('h-1');
  });
});
