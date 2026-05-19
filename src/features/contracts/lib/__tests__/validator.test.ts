import { describe, it, expect } from 'vitest';
import { pickMediaType, pickResponseKey, validateResponse } from '../validator';
import type { AnyOpenAPISpec, OperationMatch } from '../operationMatcher';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('pickResponseKey', () => {
  it('prefers exact match', () => {
    expect(pickResponseKey({ '200': {}, '2XX': {}, default: {} }, 200)).toBe('200');
  });
  it('falls back to class match', () => {
    expect(pickResponseKey({ '2XX': {}, default: {} }, 200)).toBe('2XX');
  });
  it('falls back to lowercase class match', () => {
    expect(pickResponseKey({ '2xx': {}, default: {} }, 200)).toBe('2xx');
  });
  it('falls back to default', () => {
    expect(pickResponseKey({ default: {} }, 200)).toBe('default');
  });
  it('returns null with no candidates', () => {
    expect(pickResponseKey({ '201': {} }, 200)).toBeNull();
  });
});

describe('pickMediaType', () => {
  it('exact', () => {
    expect(pickMediaType({ 'application/json': { x: 1 } }, 'application/json')).toEqual({ x: 1 });
  });
  it('wildcard subtype', () => {
    expect(pickMediaType({ 'application/*': { x: 2 } }, 'application/json')).toEqual({ x: 2 });
  });
  it('catch-all wildcard', () => {
    expect(pickMediaType({ '*/*': { x: 3 } }, 'application/json')).toEqual({ x: 3 });
  });
  it('case-insensitive fallback', () => {
    expect(pickMediaType({ 'Application/JSON': { x: 4 } }, 'application/json')).toEqual({ x: 4 });
  });
  it('returns null when nothing matches', () => {
    expect(pickMediaType({ 'application/xml': {} }, 'application/json')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// validateResponse — full integration with Ajv
// ---------------------------------------------------------------------------

const userSchema = {
  type: 'object',
  required: ['id', 'name'],
  properties: {
    id: { type: 'integer' },
    name: { type: 'string' },
    email: { type: 'string', format: 'email' },
  },
  additionalProperties: false,
};

// Cast through unknown — the inline test fixture's TS-inferred types
// (string instead of the literal 'object' etc.) don't satisfy the
// openapi-types unions, but the runtime shape is correct.
const spec = {
  openapi: '3.0.0',
  info: { title: 'test', version: '1' },
  paths: {
    '/users/{id}': {
      get: {
        operationId: 'getUser',
        responses: {
          '200': {
            description: 'ok',
            content: { 'application/json': { schema: userSchema } },
            headers: { 'X-Trace-Id': { required: true } },
          },
          '404': {
            description: 'not found',
            content: {
              'application/json': {
                schema: { type: 'object', required: ['error'], properties: { error: { type: 'string' } } },
              },
            },
          },
        },
      },
    },
  },
} as unknown as AnyOpenAPISpec;

const getUserMatch: OperationMatch = {
  operationId: 'getUser',
  pathTemplate: '/users/{id}',
  method: 'get',
  pathParams: { id: '42' },
  operation: spec.paths!['/users/{id}']!.get!,
};

describe('validateResponse — happy path', () => {
  it('passes a valid 200 response with required header', async () => {
    const r = await validateResponse({
      match: getUserMatch,
      spec,
      schemaDialect: 'draft-07',
      status: 200,
      headers: { 'x-trace-id': 'abc-123' },
      body: { id: 42, name: 'alice' },
      contentType: 'application/json',
    });
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.statusMatched).toBe(true);
    expect(r.matchedResponseKey).toBe('200');
  });

  it('parses string bodies as JSON', async () => {
    const r = await validateResponse({
      match: getUserMatch,
      spec,
      schemaDialect: 'draft-07',
      status: 200,
      headers: { 'x-trace-id': 'abc' },
      body: '{"id":42,"name":"alice"}',
      contentType: 'application/json',
    });
    expect(r.valid).toBe(true);
  });

  it('matches alternative status (404 with its own schema)', async () => {
    const r = await validateResponse({
      match: getUserMatch,
      spec,
      schemaDialect: 'draft-07',
      status: 404,
      headers: {},
      body: { error: 'User not found' },
      contentType: 'application/json',
    });
    expect(r.valid).toBe(true);
    expect(r.matchedResponseKey).toBe('404');
  });
});

describe('validateResponse — failures', () => {
  it('flags missing required property', async () => {
    const r = await validateResponse({
      match: getUserMatch,
      spec,
      schemaDialect: 'draft-07',
      status: 200,
      headers: { 'x-trace-id': 'abc' },
      body: { id: 42 }, // missing `name`
      contentType: 'application/json',
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.keyword === 'required')).toBe(true);
  });

  it('flags wrong type', async () => {
    const r = await validateResponse({
      match: getUserMatch,
      spec,
      schemaDialect: 'draft-07',
      status: 200,
      headers: { 'x-trace-id': 'abc' },
      body: { id: 'not-a-number', name: 'alice' },
      contentType: 'application/json',
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.keyword === 'type')).toBe(true);
    expect(r.errors[0]?.path).toContain('/id');
  });

  it('flags additional properties when additionalProperties: false', async () => {
    const r = await validateResponse({
      match: getUserMatch,
      spec,
      schemaDialect: 'draft-07',
      status: 200,
      headers: { 'x-trace-id': 'abc' },
      body: { id: 42, name: 'alice', extra: 'unexpected' },
      contentType: 'application/json',
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.keyword === 'additionalProperties')).toBe(true);
  });

  it('flags missing required response header', async () => {
    const r = await validateResponse({
      match: getUserMatch,
      spec,
      schemaDialect: 'draft-07',
      status: 200,
      headers: {}, // x-trace-id missing
      body: { id: 42, name: 'alice' },
      contentType: 'application/json',
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.keyword === 'required-header')).toBe(true);
  });

  it('flags undeclared status codes', async () => {
    const r = await validateResponse({
      match: getUserMatch,
      spec,
      schemaDialect: 'draft-07',
      status: 418, // not in the spec
      headers: { 'x-trace-id': 'abc' },
      body: { id: 42, name: 'alice' },
      contentType: 'application/json',
    });
    expect(r.valid).toBe(false);
    expect(r.statusMatched).toBe(false);
    expect(r.errors[0]?.keyword).toBe('status');
  });

  it('flags undeclared content-type', async () => {
    const r = await validateResponse({
      match: getUserMatch,
      spec,
      schemaDialect: 'draft-07',
      status: 200,
      headers: { 'x-trace-id': 'abc' },
      body: '<xml/>',
      contentType: 'application/xml',
    });
    expect(r.valid).toBe(false);
    expect(r.errors[0]?.keyword).toBe('content-type');
  });

  it('flags unparseable JSON when content-type says JSON', async () => {
    const r = await validateResponse({
      match: getUserMatch,
      spec,
      schemaDialect: 'draft-07',
      status: 200,
      headers: { 'x-trace-id': 'abc' },
      body: 'not-json{}',
      contentType: 'application/json',
    });
    expect(r.valid).toBe(false);
    expect(r.errors[0]?.keyword).toBe('json-parse');
  });
});

describe('validateResponse — edge cases', () => {
  it('passes when the operation declares no body schema', async () => {
    const noBodySpec = {
      openapi: '3.0.0',
      info: { title: 't', version: '1' },
      paths: {
        '/ping': { get: { operationId: 'ping', responses: { '204': { description: 'noContent' } } } },
      },
    } as unknown as AnyOpenAPISpec;
    const match: OperationMatch = {
      operationId: 'ping',
      pathTemplate: '/ping',
      method: 'get',
      pathParams: {},
      operation: noBodySpec.paths!['/ping']!.get!,
    };
    const r = await validateResponse({
      match,
      spec: noBodySpec,
      schemaDialect: 'draft-07',
      status: 204,
      headers: {},
      body: null,
    });
    expect(r.valid).toBe(true);
  });

  it('uses default response branch when status not declared explicitly', async () => {
    const defaultSpec = {
      openapi: '3.0.0',
      info: { title: 't', version: '1' },
      paths: {
        '/x': {
          get: {
            operationId: 'x',
            responses: {
              default: {
                description: 'any',
                content: { 'application/json': { schema: { type: 'object', required: ['ok'] } } },
              },
            },
          },
        },
      },
    } as unknown as AnyOpenAPISpec;
    const match: OperationMatch = {
      operationId: 'x',
      pathTemplate: '/x',
      method: 'get',
      pathParams: {},
      operation: defaultSpec.paths!['/x']!.get!,
    };
    const r = await validateResponse({
      match,
      spec: defaultSpec,
      schemaDialect: 'draft-07',
      status: 999,
      headers: {},
      body: { ok: true },
    });
    expect(r.valid).toBe(true);
    expect(r.matchedResponseKey).toBe('default');
  });

  it('matches XX class when exact status absent', async () => {
    const classSpec = {
      openapi: '3.0.0',
      info: { title: 't', version: '1' },
      paths: {
        '/y': {
          get: {
            operationId: 'y',
            responses: {
              '2XX': {
                description: 'any 2xx',
                content: { 'application/json': { schema: { type: 'object' } } },
              },
            },
          },
        },
      },
    } as unknown as AnyOpenAPISpec;
    const match: OperationMatch = {
      operationId: 'y',
      pathTemplate: '/y',
      method: 'get',
      pathParams: {},
      operation: classSpec.paths!['/y']!.get!,
    };
    const r = await validateResponse({
      match,
      spec: classSpec,
      schemaDialect: 'draft-07',
      status: 201,
      headers: {},
      body: {},
    });
    expect(r.matchedResponseKey).toBe('2XX');
    expect(r.valid).toBe(true);
  });
});
