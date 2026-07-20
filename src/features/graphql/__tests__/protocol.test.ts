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
    });
    expect(passed.signal).toBe(signal);
  });

  it('runRequest rejects a non-HTTP request shape', async () => {
    const ctx = { signal: new AbortController().signal, variables: {} };
    await expect(
      graphqlProtocol.runRequest({ type: 'grpc' } as never, ctx as never)
    ).rejects.toThrow(/expects an HTTP request shape/);
  });
});
