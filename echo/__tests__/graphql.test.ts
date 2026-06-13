// @vitest-environment node
import { describe, it, expect } from 'vitest';
import app from '../index';

interface IntrospectionResponse {
  data: {
    __schema: {
      queryType: { name: string };
      types: Array<{ name: string }>;
    };
  };
}

interface EchoResponse {
  data: {
    echo: {
      message: string;
      operation: string;
      query: string;
      variables: string | null;
      timestamp: string;
    };
  };
}

interface ErrorResponse {
  errors: Array<{ message: string }>;
  data?: unknown;
}

async function gql(body: unknown): Promise<Response> {
  return await app.request('http://localhost/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
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

  it('Missing query field → 400', async () => {
    const res = await gql({ variables: { x: 1 } });
    expect(res.status).toBe(400);
    const json = (await res.json()) as ErrorResponse;
    expect(json.errors[0]?.message).toBe('query field is required');
  });

  it('Introspection query → real schema with Query and EchoResult types', async () => {
    const res = await gql({ query: '{ __schema { queryType { name } types { name } } }' });
    expect(res.status).toBe(200);
    const json = (await res.json()) as IntrospectionResponse;
    expect(json.data.__schema.queryType.name).toBe('Query');
    const typeNames = json.data.__schema.types.map((t) => t.name);
    expect(typeNames).toContain('EchoResult');
    expect(typeNames).toContain('EchoInput');
    expect(typeNames).toContain('Mutation');
  });

  it('Query executes for real and echoes the message', async () => {
    const res = await gql({
      query: '{ echo(message: "hi") { message operation query timestamp } }',
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as EchoResponse;
    expect(json.data.echo.message).toBe('hi');
    expect(json.data.echo.operation).toBe('query');
    expect(json.data.echo.query).toContain('echo(message: "hi")');
    expect(json.data.echo.timestamp).toBeTruthy();
  });

  it('Variables are applied and echoed back as JSON', async () => {
    const res = await gql({
      query: 'query Echo($m: String!) { echo(message: $m) { message variables } }',
      variables: { m: 'from-vars' },
      operationName: 'Echo',
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as EchoResponse;
    expect(json.data.echo.message).toBe('from-vars');
    expect(JSON.parse(json.data.echo.variables ?? '{}')).toEqual({ m: 'from-vars' });
  });

  it('Mutation → operation field is mutation', async () => {
    const res = await gql({
      query: 'mutation CreateEcho { echo(input: { message: "hi" }) { message operation } }',
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as EchoResponse;
    expect(json.data.echo.operation).toBe('mutation');
    expect(json.data.echo.message).toBe('hi');
  });

  it('Unknown field → 200 with validation errors and no fabricated data', async () => {
    const res = await gql({ query: '{ nope }' });
    expect(res.status).toBe(200);
    const json = (await res.json()) as ErrorResponse;
    expect(json.errors[0]?.message).toMatch(/Cannot query field "nope"/);
    expect(json.data).toBeUndefined();
  });

  it('Missing required argument → 200 with validation errors', async () => {
    const res = await gql({ query: '{ echo { message } }' });
    expect(res.status).toBe(200);
    const json = (await res.json()) as ErrorResponse;
    expect(json.errors.length).toBeGreaterThan(0);
    expect(json.errors[0]?.message).toMatch(/argument "message".*is required/i);
  });

  it('Syntax error → 200 with parse errors', async () => {
    const res = await gql({ query: '{ echo(message: }' });
    expect(res.status).toBe(200);
    const json = (await res.json()) as ErrorResponse;
    expect(json.errors[0]?.message).toMatch(/Syntax Error/);
  });
});
