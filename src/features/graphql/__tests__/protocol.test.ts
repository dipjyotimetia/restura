/**
 * GraphQL transport-envelope contract. GraphQL has no dedicated proxy — it
 * rides the HTTP executor as a POST whose `body.raw` is the JSON envelope
 * `{ query, variables, operationName }`. These tests lock that contract:
 *   - variable injection preserves the envelope shape (doesn't flatten it to a
 *     string) and substitutes `{{var}}` inside query / variables / operationName;
 *   - runRequest hands the HTTP executor a POST carrying a valid envelope body.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest } from '@/types';

const executeRequestMock = vi.hoisted(() => vi.fn());
vi.mock('@/features/http/lib/requestExecutor', () => ({ executeRequest: executeRequestMock }));
vi.mock('@/store/useSettingsStore', () => ({
  useSettingsStore: { getState: () => ({ settings: {} }) },
}));

import { graphqlProtocol } from '../protocol';

function gqlRequest(raw: string): HttpRequest {
  return {
    id: 'gql-1',
    name: 'Q',
    type: 'http',
    method: 'POST',
    url: 'https://api.example.com/graphql',
    headers: [],
    params: [],
    body: { type: 'json', raw },
    auth: { type: 'none' },
  };
}

const ENVELOPE = JSON.stringify({
  query: 'query Q($id: ID!) { item(id: $id) { name } }',
  variables: { id: '{{itemId}}' },
  operationName: 'Q',
});

describe('graphqlProtocol envelope', () => {
  beforeEach(() => {
    executeRequestMock.mockReset();
    executeRequestMock.mockResolvedValue({ response: { status: 200 }, scriptResult: undefined });
  });

  it('injects variables while preserving the { query, variables, operationName } shape', () => {
    const injected = graphqlProtocol.injectVariables!(gqlRequest(ENVELOPE), {
      itemId: '42',
    }) as HttpRequest;
    const parsed = JSON.parse(injected.body.raw!) as {
      query: string;
      variables: { id: string };
      operationName: string;
    };
    expect(parsed.variables.id).toBe('42');
    expect(parsed.query).toContain('item(id: $id)');
    expect(parsed.operationName).toBe('Q');
  });

  it('creates saved GraphQL requests with a persistent GraphQL body marker', () => {
    expect((graphqlProtocol.defaultRequest() as HttpRequest).body.type).toBe('graphql');
  });

  it('falls back to plain substitution when the body is not yet valid JSON', () => {
    const partial = '{ "query": "{{q}}"'; // user mid-typing — invalid JSON
    const injected = graphqlProtocol.injectVariables!(gqlRequest(partial), {
      q: 'X',
    }) as HttpRequest;
    expect(injected.body.raw).toBe('{ "query": "X"');
  });

  it('runRequest sends a POST carrying a valid GraphQL envelope through the HTTP executor', async () => {
    const ctx = {
      signal: new AbortController().signal,
      variables: {},
      onScriptResult: vi.fn(),
    };
    await graphqlProtocol.runRequest(gqlRequest(ENVELOPE), ctx as never);

    expect(executeRequestMock).toHaveBeenCalledOnce();
    const passed = executeRequestMock.mock.calls[0]![0] as { request: HttpRequest };
    expect(passed.request.method).toBe('POST');
    const envelope = JSON.parse(passed.request.body.raw!) as Record<string, unknown>;
    expect(envelope).toHaveProperty('query');
    expect(envelope).toHaveProperty('variables');
    expect(envelope).toHaveProperty('operationName');
  });

  it('normalizes a saved GraphQL query document into the HTTP JSON envelope at execution time', async () => {
    const saved = gqlRequest('query Saved { me { id } }');
    saved.body.type = 'graphql';
    await graphqlProtocol.runRequest(saved, {
      signal: new AbortController().signal,
      variables: {},
    } as never);

    const passed = executeRequestMock.mock.calls[0]![0] as { request: HttpRequest };
    expect(passed.request.body.type).toBe('json');
    expect(JSON.parse(passed.request.body.raw!)).toEqual({
      query: 'query Saved { me { id } }',
      variables: {},
      operationName: 'Saved',
    });
  });

  it('preserves saved GraphQL variables and forwards cancellation to the HTTP executor', async () => {
    const saved = gqlRequest('query Saved($id: ID!) { me(id: $id) { id } }');
    saved.body = { type: 'graphql', raw: saved.body.raw, graphqlVariables: '{"id":"42"}' };
    const signal = new AbortController().signal;
    await graphqlProtocol.runRequest(saved, { signal, variables: {} } as never);

    const passed = executeRequestMock.mock.calls[0]![0] as {
      request: HttpRequest;
      signal: AbortSignal;
    };
    expect(JSON.parse(passed.request.body.raw!)).toEqual({
      query: 'query Saved($id: ID!) { me(id: $id) { id } }',
      variables: { id: '42' },
      operationName: 'Saved',
    });
    expect(passed.signal).toBe(signal);
  });

  it('reports a refreshed OAuth2 auth through ctx.onAuthRefreshed', async () => {
    const refreshed = { type: 'oauth2', oauth2: { accessToken: 'fresh' } };
    executeRequestMock.mockResolvedValue({
      response: { status: 200 },
      scriptResult: undefined,
      refreshedAuth: refreshed,
    });
    const onAuthRefreshed = vi.fn();
    await graphqlProtocol.runRequest(gqlRequest(ENVELOPE), {
      signal: new AbortController().signal,
      variables: {},
      onAuthRefreshed,
    } as never);

    expect(onAuthRefreshed).toHaveBeenCalledWith(refreshed);
  });

  it('hands the substituted sent body to an onSentBody protocol option', async () => {
    const sentBody = '{"query":"{ user(id: \\"1\\") { id } }","variables":{}}';
    executeRequestMock.mockResolvedValue({ response: { status: 200 }, sentBody });
    const onSentBody = vi.fn();
    await graphqlProtocol.runRequest(gqlRequest(ENVELOPE), {
      signal: new AbortController().signal,
      variables: {},
      protocolOptions: { onSentBody },
    } as never);
    expect(onSentBody).toHaveBeenCalledWith(sentBody);

    // No option, or no body → nothing to call / no crash.
    executeRequestMock.mockResolvedValue({ response: { status: 200 } });
    await graphqlProtocol.runRequest(gqlRequest(ENVELOPE), {
      signal: new AbortController().signal,
      variables: {},
      protocolOptions: { onSentBody },
    } as never);
    expect(onSentBody).toHaveBeenCalledTimes(1);
  });

  it('sends the operation selected on the saved request (#903)', async () => {
    const saved = gqlRequest('query A { a }\nquery B { b }');
    saved.body = { type: 'graphql', raw: saved.body.raw, graphqlOperationName: 'B' };
    await graphqlProtocol.runRequest(saved, {
      signal: new AbortController().signal,
      variables: {},
    } as never);

    const passed = executeRequestMock.mock.calls[0]![0] as { request: HttpRequest };
    expect(JSON.parse(passed.request.body.raw!).operationName).toBe('B');
  });

  it('leaves operationName off an anonymous saved document, like interactive Send', async () => {
    const saved = gqlRequest('{ me { id } }');
    saved.body.type = 'graphql';
    await graphqlProtocol.runRequest(saved, {
      signal: new AbortController().signal,
      variables: {},
    } as never);

    const passed = executeRequestMock.mock.calls[0]![0] as { request: HttpRequest };
    expect(JSON.parse(passed.request.body.raw!)).toEqual({ query: '{ me { id } }', variables: {} });
  });

  it('forwards ctx.secretVariables to the executor so Secret references stay opaque', async () => {
    const secretVariables = { apiKey: { kind: 'handle', id: 'handle-1' } };
    await graphqlProtocol.runRequest(gqlRequest(ENVELOPE), {
      signal: new AbortController().signal,
      variables: {},
      secretVariables,
    } as never);

    const passed = executeRequestMock.mock.calls[0]![0] as { secretVariables?: unknown };
    expect(passed.secretVariables).toEqual(secretVariables);
  });

  it('sends saved GraphQL with the GraphQL-over-HTTP Accept header', async () => {
    const saved = gqlRequest('{ me { id } }');
    saved.body.type = 'graphql';
    await graphqlProtocol.runRequest(saved, {
      signal: new AbortController().signal,
      variables: {},
    } as never);
    const passed = executeRequestMock.mock.calls[0]![0] as { request: HttpRequest };
    expect(passed.request.headers.find((h) => h.key === 'Accept')?.value).toBe(
      'application/graphql-response+json, application/json;q=0.9'
    );
  });

  it('sends a saved GET query as URL params and refuses a saved GET mutation', async () => {
    const saved = gqlRequest('query Saved($id: ID!) { me(id: $id) { id } }');
    saved.method = 'GET';
    saved.body = { type: 'graphql', raw: saved.body.raw, graphqlVariables: '{"id":"42"}' };
    const ctx = { signal: new AbortController().signal, variables: {} } as never;
    await graphqlProtocol.runRequest(saved, ctx);
    const passed = executeRequestMock.mock.calls[0]![0] as { request: HttpRequest };
    expect(passed.request.method).toBe('GET');
    expect(passed.request.body.type).toBe('none');
    expect(Object.fromEntries(passed.request.params.map((p) => [p.key, p.value]))).toEqual({
      query: 'query Saved($id: ID!) { me(id: $id) { id } }',
      variables: '{"id":"42"}',
      operationName: 'Saved',
    });

    const mutation = gqlRequest('mutation M { bump }');
    mutation.method = 'GET';
    mutation.body.type = 'graphql';
    await expect(graphqlProtocol.runRequest(mutation, ctx)).rejects.toThrow(/POST/);
  });

  it('always folds multipart responses and wires live progress only for a streaming caller', async () => {
    const ctx = { signal: new AbortController().signal, variables: {} };
    await graphqlProtocol.runRequest(gqlRequest(ENVELOPE), ctx as never);
    const plain = executeRequestMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(typeof plain.transformResponse).toBe('function');
    expect(plain.onResponseProgress).toBeUndefined();

    await graphqlProtocol.runRequest(gqlRequest(ENVELOPE), {
      ...ctx,
      stream: { onMessage: vi.fn() },
    } as never);
    const live = executeRequestMock.mock.calls[1]![0] as Record<string, unknown>;
    expect(typeof live.onResponseProgress).toBe('function');
  });

  it('runRequest rejects a non-HTTP request shape', async () => {
    const ctx = { signal: new AbortController().signal, variables: {} };
    await expect(
      graphqlProtocol.runRequest({ type: 'grpc' } as never, ctx as never)
    ).rejects.toThrow(/expects an HTTP request shape/);
  });
});
