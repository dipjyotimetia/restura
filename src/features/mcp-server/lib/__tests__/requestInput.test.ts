import { NewRequestInputSchema, RequestPatchSchema } from '@shared/mcp-server/control-tools';
import { describe, expect, it } from 'vitest';
import type { GrpcRequest, HttpRequest } from '@/types';
import { applyRequestPatch, buildRequestFromInput, toAuthConfig } from '../requestInput';

const build = (raw: unknown) => buildRequestFromInput(NewRequestInputSchema.parse(raw));

describe('buildRequestFromInput', () => {
  it('maps an http request with headers, params, body and auth', () => {
    const req = build({
      type: 'http',
      name: 'Create',
      method: 'patch',
      url: '{{base}}/x',
      headers: [{ key: 'Accept', value: 'application/json' }],
      params: [{ key: 'q', value: '1', enabled: false }],
      body: { type: 'json', content: '{}' },
      auth: { type: 'api-key', key: 'X-Key', value: '{{k}}' },
      testScript: 'rs.test("ok", () => {})',
    }) as HttpRequest;
    expect(req).toMatchObject({
      type: 'http',
      method: 'PATCH',
      url: '{{base}}/x',
      body: { type: 'json', raw: '{}' },
      auth: { type: 'api-key', apiKey: { key: 'X-Key', value: '{{k}}', in: 'header' } },
      testScript: 'rs.test("ok", () => {})',
    });
    expect(req.headers[0]).toMatchObject({ key: 'Accept', enabled: true });
    expect(req.params[0]).toMatchObject({ key: 'q', enabled: false });
    expect(req.headers[0]?.id).toBeTruthy();
  });

  it('maps graphql onto an http POST with a graphql body', () => {
    expect(
      build({ type: 'graphql', name: 'Q', url: 'u', query: '{ a }', variables: '{"x":1}' })
    ).toMatchObject({
      type: 'http',
      method: 'POST',
      body: { type: 'graphql', raw: '{ a }', graphqlVariables: '{"x":1}' },
    });
  });

  it('maps grpc, sse and mcp with their defaults', () => {
    expect(build({ type: 'grpc', name: 'g', url: 'grpc://h:1' })).toMatchObject({
      type: 'grpc',
      methodType: 'unary',
      service: '',
      method: '',
      message: '',
      metadata: [],
    });
    expect(build({ type: 'sse', name: 's', url: 'https://s' })).toMatchObject({
      type: 'sse',
      reconnectOnResume: true,
    });
    expect(build({ type: 'mcp', name: 'm', url: 'https://m' })).toMatchObject({
      type: 'mcp',
      transport: 'streamable-http',
    });
  });

  it('gives every build fresh ids', () => {
    const a = build({ type: 'http', name: 'n', url: 'u' });
    const b = build({ type: 'http', name: 'n', url: 'u' });
    expect(a.id).not.toBe(b.id);
  });
});

describe('toAuthConfig', () => {
  it('defaults to none and maps basic', () => {
    expect(toAuthConfig(undefined)).toEqual({ type: 'none' });
    expect(toAuthConfig({ type: 'basic', username: 'u', password: '{{p}}' })).toEqual({
      type: 'basic',
      basic: { username: 'u', password: '{{p}}' },
    });
  });
});

describe('applyRequestPatch', () => {
  const http = build({ type: 'http', name: 'n', url: 'u' });
  const grpc = build({ type: 'grpc', name: 'g', url: 'grpc://h' }) as GrpcRequest;
  const patch = (raw: unknown) => RequestPatchSchema.parse(raw);

  it('changes only the given fields and does not mutate the input', () => {
    const out = applyRequestPatch(http, patch({ method: 'delete', url: 'v' }));
    expect(out).toMatchObject({ ok: true, request: { method: 'DELETE', url: 'v', name: 'n' } });
    expect(http).toMatchObject({ method: 'GET', url: 'u' });
  });

  it('maps grpcMethod onto the grpc method field', () => {
    const out = applyRequestPatch(grpc, patch({ grpcMethod: 'SayHello', service: 'Greeter' }));
    expect(out).toMatchObject({ ok: true, request: { method: 'SayHello', service: 'Greeter' } });
  });

  it('refuses fields from another request type', () => {
    expect(applyRequestPatch(grpc, patch({ body: { type: 'json', content: '{}' } }))).toEqual({
      ok: false,
      error: 'Field(s) body do not apply to a grpc request.',
    });
  });

  it('refuses to overwrite auth the user configured with a flow', () => {
    const aws = { ...http, auth: { type: 'aws-signature' as const } };
    const out = applyRequestPatch(aws, patch({ auth: { type: 'none' } }));
    expect(out.ok).toBe(false);
  });
});
