// @vitest-environment node
import { describe, expect, it } from 'vitest';
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
    // graphql v16 phrased this as `Argument "message" of required type ...`;
    // graphql v17 phrases it as `Argument "Query.echo(message:)" ... is required`.
    expect(json.errors[0]?.message).toMatch(/argument.*message.*required/i);
  });

  it('Syntax error → 200 with parse errors', async () => {
    const res = await gql({ query: '{ echo(message: }' });
    expect(res.status).toBe(200);
    const json = (await res.json()) as ErrorResponse;
    expect(json.errors[0]?.message).toMatch(/Syntax Error/);
  });
});

describe('graphqlEcho handler — GraphQL-over-HTTP GET', () => {
  it('executes a query from URL params with variables and operationName', async () => {
    const params = new URLSearchParams({
      query: 'query Echo($m: String!) { echo(message: $m) { message operation variables } }',
      variables: JSON.stringify({ m: 'via-get' }),
      operationName: 'Echo',
    });
    const res = await app.request(`http://localhost/graphql?${params.toString()}`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as EchoResponse;
    expect(json.data.echo.message).toBe('via-get');
    expect(json.data.echo.operation).toBe('query');
    expect(JSON.parse(json.data.echo.variables ?? '{}')).toEqual({ m: 'via-get' });
  });

  it('GET without a query → 400', async () => {
    const res = await app.request('http://localhost/graphql');
    expect(res.status).toBe(400);
    const json = (await res.json()) as ErrorResponse;
    expect(json.errors[0]?.message).toBe('query field is required');
  });

  it('GET with malformed variables JSON → 400', async () => {
    const res = await app.request(
      'http://localhost/graphql?query=%7B__typename%7D&variables=%7Bnope'
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as ErrorResponse;
    expect(json.errors[0]?.message).toBe('Invalid JSON in variables');
  });

  it('GET refuses a mutation (405)', async () => {
    const params = new URLSearchParams({
      query: 'mutation { echo(input: { message: "x" }) { message } }',
    });
    const res = await app.request(`http://localhost/graphql?${params.toString()}`);
    expect(res.status).toBe(405);
  });

  it('GET refuses a mutation hidden behind a leading comment', async () => {
    const params = new URLSearchParams({
      query: '# c\nmutation { echo(input: { message: "x" }) { message } }',
    });
    const res = await app.request(`http://localhost/graphql?${params.toString()}`);
    expect(res.status).toBe(405);
  });

  it('GET refuses a multi-operation document whose operationName selects the mutation', async () => {
    const document =
      'query Q { echo(message: "q") { message } } mutation M { echo(input: { message: "m" }) { message } }';
    const refused = await app.request(
      `http://localhost/graphql?${new URLSearchParams({ query: document, operationName: 'M' })}`
    );
    expect(refused.status).toBe(405);
    const allowed = await app.request(
      `http://localhost/graphql?${new URLSearchParams({ query: document, operationName: 'Q' })}`
    );
    expect(allowed.status).toBe(200);
    expect(((await allowed.json()) as EchoResponse).data.echo.message).toBe('q');
  });

  it('GET with a syntax error reports it as a GraphQL error, not a 405', async () => {
    const res = await app.request(
      `http://localhost/graphql?${new URLSearchParams({ query: '{ echo(' })}`
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as ErrorResponse).errors[0]?.message).toContain('Syntax Error');
  });
});
