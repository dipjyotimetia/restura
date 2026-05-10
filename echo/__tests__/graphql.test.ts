// @vitest-environment node
import { describe, it, expect } from 'vitest';
import app from '../index';

interface IntrospectionResponse {
  data: {
    __schema: {
      queryType: { name: string };
      mutationType: { name: string };
      subscriptionType: null;
      types: Array<{ kind: string; name: string }>;
      directives: unknown[];
    };
  };
}

interface EchoResponse {
  data: {
    echo: {
      operation: string;
      query: string;
      variables: unknown;
      operationName: string | null;
      timestamp: string;
    };
  };
}

interface ErrorResponse {
  errors: Array<{ message: string }>;
}

describe('graphqlEcho handler', () => {
  it('OPTIONS /graphql → 204', async () => {
    const res = await app.request('http://localhost/graphql', {
      method: 'OPTIONS',
    });
    expect(res.status).toBe(204);
  });

  it('Non-JSON content-type → 400 with error message', async () => {
    const res = await app.request('http://localhost/graphql', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{ "query": "{ echo { operation } }" }',
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as ErrorResponse;
    expect(json.errors[0]?.message).toBe('Content-Type must be application/json');
  });

  it('Invalid JSON body → 400 with error message', async () => {
    const res = await app.request('http://localhost/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not valid json',
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as ErrorResponse;
    expect(json.errors[0]?.message).toBe('Invalid JSON body');
  });

  it('Introspection query → valid response with __schema', async () => {
    const res = await app.request('http://localhost/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ __schema { queryType { name } } }' }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as IntrospectionResponse;
    expect(json.data.__schema.queryType.name).toBe('Query');
    expect(Array.isArray(json.data.__schema.types)).toBe(true);
    expect(json.data.__schema.types.length).toBeGreaterThan(0);
  });

  it('Echo query → echo response with operation=query', async () => {
    const res = await app.request('http://localhost/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ echo { operation } }', variables: { x: 1 } }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as EchoResponse;
    expect(json.data.echo.operation).toBe('query');
    expect(json.data.echo.query).toBe('{ echo { operation } }');
  });

  it('Echo mutation → operation field is mutation', async () => {
    const res = await app.request('http://localhost/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: 'mutation CreateEcho { echo(input: { message: "hi" }) { operation } }',
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as EchoResponse;
    expect(json.data.echo.operation).toBe('mutation');
  });
});
