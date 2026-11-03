/**
 * Converts agent-authored request input (validated by the shared control-tool
 * schemas) into Restura's own request shapes, and applies `update_request`
 * patches. Pure: no store access, so every mapping is unit-tested directly.
 */

import type {
  AuthInput,
  HttpBodyInput,
  KeyValueInput,
  NewRequestInput,
  RequestPatch,
} from '@shared/mcp-server/control-tools';
import { v4 as uuidv4 } from 'uuid';
import type {
  AuthConfig,
  GrpcRequest,
  HttpRequest,
  KeyValue,
  McpRequest,
  Request,
  RequestBody,
  SseRequest,
} from '@/types';

export function toKeyValues(pairs: readonly KeyValueInput[] | undefined): KeyValue[] {
  return (pairs ?? []).map((p) => ({
    id: uuidv4(),
    key: p.key,
    value: p.value,
    enabled: p.enabled ?? true,
    ...(p.description !== undefined ? { description: p.description } : {}),
  }));
}

/** Agent auth → AuthConfig. Credentials are `{{variable}}` references (schema-enforced). */
export function toAuthConfig(auth: AuthInput | undefined): AuthConfig {
  if (!auth) return { type: 'none' };
  switch (auth.type) {
    case 'none':
      return { type: 'none' };
    case 'bearer':
      return { type: 'bearer', bearer: { token: auth.token } };
    case 'basic':
      return { type: 'basic', basic: { username: auth.username, password: auth.password } };
    case 'api-key':
      return { type: 'api-key', apiKey: { key: auth.key, value: auth.value, in: auth.in } };
  }
}

export function toRequestBody(body: HttpBodyInput | undefined): RequestBody {
  if (!body || body.type === 'none') return { type: 'none' };
  return {
    type: body.type,
    ...(body.content !== undefined ? { raw: body.content } : {}),
    ...(body.type === 'graphql' && body.graphqlVariables !== undefined
      ? { graphqlVariables: body.graphqlVariables }
      : {}),
  };
}

function scripts(input: { preRequestScript?: string; testScript?: string; description?: string }) {
  return {
    ...(input.preRequestScript !== undefined ? { preRequestScript: input.preRequestScript } : {}),
    ...(input.testScript !== undefined ? { testScript: input.testScript } : {}),
  };
}

/** Build a saveable request from `create_request` input. */
export function buildRequestFromInput(input: NewRequestInput): Request {
  const id = uuidv4();
  switch (input.type) {
    case 'http': {
      const request: HttpRequest = {
        id,
        name: input.name,
        type: 'http',
        method: input.method.toUpperCase(),
        url: input.url,
        headers: toKeyValues(input.headers),
        params: toKeyValues(input.params),
        body: toRequestBody(input.body),
        auth: toAuthConfig(input.auth),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...scripts(input),
      };
      return request;
    }
    case 'graphql': {
      const request: HttpRequest = {
        id,
        name: input.name,
        type: 'http',
        method: 'POST',
        url: input.url,
        headers: toKeyValues(input.headers),
        params: [],
        body: {
          type: 'graphql',
          raw: input.query,
          ...(input.variables !== undefined ? { graphqlVariables: input.variables } : {}),
        },
        auth: toAuthConfig(input.auth),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...scripts(input),
      };
      return request;
    }
    case 'grpc': {
      const request: GrpcRequest = {
        id,
        name: input.name,
        type: 'grpc',
        methodType: input.methodType,
        url: input.url,
        service: input.service,
        method: input.method,
        metadata: toKeyValues(input.metadata),
        message: input.message ?? '',
        auth: toAuthConfig(input.auth),
        ...scripts(input),
      };
      return request;
    }
    case 'sse': {
      const request: SseRequest = {
        id,
        name: input.name,
        type: 'sse',
        url: input.url,
        headers: toKeyValues(input.headers),
        params: toKeyValues(input.params),
        auth: toAuthConfig(input.auth),
        reconnectOnResume: true,
        ...scripts(input),
      };
      return request;
    }
    case 'mcp': {
      const request: McpRequest = {
        id,
        name: input.name,
        type: 'mcp',
        url: input.url,
        transport: input.transport,
        headers: toKeyValues(input.headers),
        auth: toAuthConfig(input.auth),
        ...(input.defaultMethod !== undefined ? { defaultMethod: input.defaultMethod } : {}),
        ...(input.defaultParams !== undefined ? { defaultParams: input.defaultParams } : {}),
        ...scripts(input),
      };
      return request;
    }
  }
}

/** Patch fields each request type accepts. */
const FIELDS_BY_TYPE: Record<Request['type'], ReadonlySet<keyof RequestPatch>> = {
  http: new Set([
    'name',
    'description',
    'url',
    'method',
    'headers',
    'params',
    'body',
    'auth',
    'preRequestScript',
    'testScript',
  ]),
  grpc: new Set([
    'name',
    'url',
    'auth',
    'preRequestScript',
    'testScript',
    'service',
    'grpcMethod',
    'methodType',
    'message',
    'metadata',
  ]),
  sse: new Set(['name', 'url', 'headers', 'params', 'auth', 'preRequestScript', 'testScript']),
  mcp: new Set([
    'name',
    'url',
    'headers',
    'auth',
    'preRequestScript',
    'testScript',
    'defaultMethod',
    'defaultParams',
  ]),
};

export type PatchOutcome = { ok: true; request: Request } | { ok: false; error: string };

/**
 * Apply an `update_request` patch. Refuses fields that do not apply to the
 * request's type (rather than silently dropping them), and refuses to touch
 * auth kinds an agent could not have configured (OAuth2, AWS, …) — those
 * hold flows and credentials the user set up.
 */
export function applyRequestPatch(request: Request, patch: RequestPatch): PatchOutcome {
  const allowed = FIELDS_BY_TYPE[request.type];
  const refused = (Object.keys(patch) as Array<keyof RequestPatch>).filter(
    (key) => !allowed.has(key)
  );
  if (refused.length > 0) {
    return {
      ok: false,
      error: `Field(s) ${refused.join(', ')} do not apply to a ${request.type} request.`,
    };
  }
  if (patch.auth && !['none', 'bearer', 'basic', 'api-key'].includes(request.auth.type)) {
    return {
      ok: false,
      error: `This request uses ${request.auth.type} auth, which the user configured. Ask them to change it in Restura.`,
    };
  }

  const next = structuredClone(request) as Request & Record<string, unknown>;
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.url !== undefined) next.url = patch.url;
  if (patch.auth !== undefined) next.auth = toAuthConfig(patch.auth);
  if (patch.preRequestScript !== undefined) next.preRequestScript = patch.preRequestScript;
  if (patch.testScript !== undefined) next.testScript = patch.testScript;

  switch (next.type) {
    case 'http':
      if (patch.description !== undefined) next.description = patch.description;
      if (patch.method !== undefined) next.method = patch.method.toUpperCase();
      if (patch.headers !== undefined) next.headers = toKeyValues(patch.headers);
      if (patch.params !== undefined) next.params = toKeyValues(patch.params);
      if (patch.body !== undefined) next.body = toRequestBody(patch.body);
      break;
    case 'grpc':
      if (patch.service !== undefined) next.service = patch.service;
      if (patch.grpcMethod !== undefined) next.method = patch.grpcMethod;
      if (patch.methodType !== undefined) next.methodType = patch.methodType;
      if (patch.message !== undefined) next.message = patch.message;
      if (patch.metadata !== undefined) next.metadata = toKeyValues(patch.metadata);
      break;
    case 'sse':
      if (patch.headers !== undefined) next.headers = toKeyValues(patch.headers);
      if (patch.params !== undefined) next.params = toKeyValues(patch.params);
      break;
    case 'mcp':
      if (patch.headers !== undefined) next.headers = toKeyValues(patch.headers);
      if (patch.defaultMethod !== undefined) next.defaultMethod = patch.defaultMethod;
      if (patch.defaultParams !== undefined) next.defaultParams = patch.defaultParams;
      break;
  }
  return { ok: true, request: next };
}
