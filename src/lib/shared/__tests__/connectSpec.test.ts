import { beforeEach, describe, expect, it } from 'vitest';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useGlobalsStore } from '@/store/useGlobalsStore';
import { useRequestStore } from '@/store/useRequestStore';
import type {
  AuthConfig,
  Collection,
  CollectionItem,
  GrpcRequest,
  McpRequest,
  SseRequest,
} from '@/types';
import {
  createConnectScope,
  previewConnectText,
  resolveGrpcReflectionConnect,
  resolveMcpConnect,
  resolveSseConnect,
  resolveWebSocketConnect,
} from '../connectSpec';

const kv = (key: string, value: string, enabled = true) => ({
  id: `${key}-id`,
  key,
  value,
  enabled,
});

function sse(overrides: Partial<SseRequest> = {}): SseRequest {
  return {
    id: 'req-1',
    name: 'S',
    type: 'sse',
    url: 'https://{{host}}/events',
    headers: [],
    params: [],
    auth: { type: 'none' },
    ...overrides,
  };
}

function mcp(overrides: Partial<McpRequest> = {}): McpRequest {
  return {
    id: 'req-1',
    name: 'M',
    type: 'mcp',
    url: 'https://{{host}}/mcp',
    transport: 'streamable-http',
    headers: [],
    auth: { type: 'none' },
    ...overrides,
  };
}

function seed(
  request: SseRequest | McpRequest,
  collection: Partial<Collection> = {},
  folderExtra: Partial<CollectionItem> = {},
  requestExtra: object = {}
) {
  const folder: CollectionItem = {
    id: 'folder-1',
    name: 'Folder',
    type: 'folder',
    variables: [{ id: 'fv', key: 'folderVar', value: 'from-folder', enabled: true }],
    items: [{ id: 'req-1', name: 'R', type: 'request', request, ...requestExtra }],
    ...folderExtra,
  };
  useCollectionStore.setState({
    collections: [
      {
        id: 'c1',
        name: 'Col',
        items: [folder],
        variables: [{ id: 'cv', key: 'host', value: 'col.example.com', enabled: true }],
        ...collection,
      },
    ],
  });
  useRequestStore.getState().openTab(request, { savedRequestId: 'req-1' });
}

describe('connectSpec', () => {
  beforeEach(() => {
    useEnvironmentStore.setState({ environments: [], activeEnvironmentId: null });
    useGlobalsStore.setState({ vars: {} });
    useCollectionStore.setState({ collections: [] });
    useRequestStore.setState({ tabs: [], activeTabId: null });
    localStorage.clear();
  });

  describe('Variable scope', () => {
    it('resolves collection and folder variables in an SSE url, header and param', () => {
      const request = sse({
        headers: [kv('X-Folder', '{{folderVar}}')],
        params: [kv('q', '{{folderVar}}')],
      });
      seed(request);
      expect(resolveSseConnect(request)).toMatchObject({
        ok: true,
        url: 'https://col.example.com/events?q=from-folder',
        headers: { 'X-Folder': 'from-folder' },
      });
      // The stored template is untouched.
      expect(request.url).toBe('https://{{host}}/events');
    });

    it('resolves collection variables in a WebSocket url and handshake headers', () => {
      seed(sse());
      expect(
        resolveWebSocketConnect({
          url: 'wss://{{host}}/ws',
          headers: [kv('X-Tenant', '{{folderVar}}'), kv('Off', '{{folderVar}}', false)],
        })
      ).toEqual({
        ok: true,
        url: 'wss://col.example.com/ws',
        headers: { 'X-Tenant': 'from-folder' },
      });
    });

    it('resolves collection variables in an MCP url and headers', () => {
      const request = mcp({ headers: [kv('X-F', '{{folderVar}}')] });
      seed(request);
      expect(resolveMcpConnect(request, createConnectScope(), false)).toMatchObject({
        ok: true,
        url: 'https://col.example.com/mcp',
        headers: { 'X-F': 'from-folder' },
      });
    });

    it('resolves collection variables in the gRPC reflection endpoint', () => {
      seed(sse());
      expect(resolveGrpcReflectionConnect('https://{{host}}:443')).toEqual({
        ok: true,
        url: 'https://col.example.com:443',
      });
    });

    it('previews text without refusing', () => {
      seed(sse());
      expect(previewConnectText('{{host}}')).toBe('col.example.com');
    });
  });

  describe('SSE auth', () => {
    const bearer: AuthConfig = { type: 'bearer', bearer: { token: 'folder-token' } };

    it('inherits folder auth when the request has none', () => {
      const request = sse();
      seed(request, {}, { auth: bearer });
      expect(resolveSseConnect(request)).toMatchObject({
        ok: true,
        headers: { Authorization: 'Bearer folder-token' },
      });
    });

    it('lets the request own auth win over inherited auth', () => {
      const request = sse({ auth: { type: 'bearer', bearer: { token: 'own' } } });
      seed(request, {}, { auth: bearer });
      expect(resolveSseConnect(request)).toMatchObject({
        headers: { Authorization: 'Bearer own' },
      });
    });

    it('refuses when the Postman send guard blocks the request', () => {
      const request = sse();
      seed(request, {}, { auth: bearer }, { _postman: { noauth: true } });
      const spec = resolveSseConnect(request);
      expect(spec.ok).toBe(false);
    });

    it('no-ops sign-at-wire auth types', () => {
      const request = sse({
        auth: { type: 'wsse', wsse: { username: 'u', password: 'p' } } as AuthConfig,
      });
      seed(request);
      expect(resolveSseConnect(request)).toMatchObject({ ok: true, headers: {} });
    });
  });

  describe('gRPC reflection', () => {
    it('sends the call metadata resolved with the full scope', () => {
      seed(sse());
      const grpc = {
        id: 'req-1',
        name: 'G',
        type: 'grpc',
        url: 'https://{{host}}',
        service: '',
        method: '',
        methodType: 'unary',
        metadata: [kv('x-f', '{{folderVar}}')],
        message: '',
        auth: { type: 'none' },
      } as unknown as GrpcRequest;
      expect(resolveGrpcReflectionConnect(grpc.url, grpc, { inheritAuth: true })).toMatchObject({
        ok: true,
        url: 'https://col.example.com',
        credentials: { metadata: { 'x-f': 'from-folder' } },
      });
    });
  });

  describe('refusals', () => {
    it('turns a thrown resolver error into a refusal', () => {
      seed(sse());
      const scope = {
        ...createConnectScope(),
        resolveVariables: () => {
          throw new Error('boom');
        },
      };
      expect(resolveWebSocketConnect({ url: 'wss://x', headers: [] }, scope)).toEqual({
        ok: false,
        error: 'Could not resolve the connection: boom',
      });
      expect(resolveSseConnect(sse(), scope).ok).toBe(false);
      expect(resolveMcpConnect(mcp(), scope, false).ok).toBe(false);
      expect(resolveGrpcReflectionConnect('https://x', undefined, {}, scope).ok).toBe(false);
      expect(previewConnectText('{{a}}', scope)).toBe('{{a}}');
    });

    it('refuses a field that still references a desktop secret handle, without leaking it', () => {
      const request = sse({ headers: [kv('X-Key', '{{vault}}')] });
      seed(request, {
        variables: [
          {
            id: 'sv',
            key: 'vault',
            value: '',
            enabled: true,
            secretRef: { kind: 'handle', id: 'handle-1' },
          } as never,
        ],
      });
      const spec = resolveSseConnect(request);
      expect(spec.ok).toBe(false);
      expect(JSON.stringify(spec)).not.toContain('handle-1');
    });
  });
  describe('credentials', () => {
    const vaultVar = {
      id: 'sv',
      key: 'vault',
      value: '',
      enabled: true,
      secretRef: { kind: 'handle', id: 'handle-1' },
    } as never;
    const grpc = (extra: object = {}) =>
      ({
        id: 'req-1',
        name: 'G',
        type: 'grpc',
        url: 'https://g.example.com',
        service: '',
        method: '',
        methodType: 'unary',
        metadata: [],
        message: '',
        auth: { type: 'none' },
        ...extra,
      }) as unknown as GrpcRequest;

    it('SSE: a Basic password variable resolves before encoding', () => {
      const request = sse({
        auth: { type: 'basic', basic: { username: 'u', password: '{{host}}' } },
      });
      seed(request);
      expect(resolveSseConnect(request)).toMatchObject({
        ok: true,
        headers: { Authorization: `Basic ${btoa('u:col.example.com')}` },
      });
    });

    it('SSE: refuses a secret variable inside a Basic password', () => {
      const request = sse({
        auth: { type: 'basic', basic: { username: 'u', password: '{{vault}}' } },
      });
      seed(request, { variables: [vaultVar] });
      expect(resolveSseConnect(request).ok).toBe(false);
    });

    it('SSE: refuses a credential only Electron main could apply, not connect anonymously', () => {
      const auth: AuthConfig = {
        type: 'bearer',
        bearer: { token: { kind: 'handle', id: 'handle-1' } },
      } as never;
      const own = sse({ auth });
      seed(own);
      expect(resolveSseConnect(own).ok).toBe(false);
      const inheriting = sse();
      seed(inheriting, {}, { auth });
      expect(resolveSseConnect(inheriting).ok).toBe(false);
    });

    it('reflection: inherited auth goes only on an explicit discover', () => {
      const request = grpc();
      seed(request as never, {}, { auth: { type: 'bearer', bearer: { token: 'folder-token' } } });
      const silent = resolveGrpcReflectionConnect(request.url, request, { inheritAuth: false });
      expect(JSON.stringify(silent)).not.toContain('folder-token');
      const explicit = resolveGrpcReflectionConnect(request.url, request, { inheritAuth: true });
      expect(JSON.stringify(explicit)).toContain('folder-token');
    });

    it('reflection: own auth still goes on a silent discover, with variables resolved', () => {
      const request = grpc({ auth: { type: 'bearer', bearer: { token: '{{host}}' } } });
      seed(request as never);
      const spec = resolveGrpcReflectionConnect(request.url, request, { inheritAuth: false });
      expect(JSON.stringify(spec)).toContain('Bearer col.example.com');
    });

    it('reflection: refuses a secret variable in auth instead of sending the literal token', () => {
      const request = grpc({ auth: { type: 'bearer', bearer: { token: '{{vault}}' } } });
      seed(request as never, { variables: [vaultVar] });
      const spec = resolveGrpcReflectionConnect(request.url, request, { inheritAuth: true });
      expect(spec.ok).toBe(false);
      expect(JSON.stringify(spec)).not.toContain('{{vault}}');
    });

    it('leaves header names as written, matching the CLI', () => {
      const request = sse({ headers: [kv('X-{{host}}', 'v')] });
      seed(request);
      expect(resolveSseConnect(request)).toMatchObject({
        ok: true,
        headers: { 'X-{{host}}': 'v' },
      });
    });
  });
  describe('secret variables', () => {
    const plainSecret = { id: 'ps', key: 'sec', value: 'PLAINTEXT', enabled: true, secret: true };
    const alias = { id: 'al', key: 'alias', value: '{{sec}}', enabled: true };

    it('refuses a secret reached through another variable, naming the field', () => {
      const request = sse({ url: 'https://x.example.com/{{alias}}' });
      seed(request, { variables: [plainSecret, alias] as never });
      const spec = resolveSseConnect(request);
      expect(spec.ok).toBe(false);
      expect(JSON.stringify(spec)).toContain('URL');
      expect(JSON.stringify(spec)).not.toContain('PLAINTEXT');
    });

    it('still resolves a secret written directly in the field', () => {
      const request = sse({ url: 'https://x.example.com/{{sec}}' });
      seed(request, { variables: [plainSecret] as never });
      expect(resolveSseConnect(request)).toMatchObject({
        ok: true,
        url: 'https://x.example.com/PLAINTEXT',
      });
    });

    it('refuses the same alias on WebSocket and MCP', () => {
      const request = sse({ url: 'https://x.example.com' });
      seed(request, { variables: [plainSecret, alias] as never });
      expect(resolveWebSocketConnect({ url: 'wss://x/{{alias}}', headers: [] }).ok).toBe(false);
      const mcp = {
        id: 'req-1',
        type: 'mcp',
        url: 'https://x/{{alias}}',
        transport: 'streamable-http',
        headers: [],
        auth: { type: 'none' },
      } as unknown as McpRequest;
      expect(resolveMcpConnect(mcp).ok).toBe(false);
    });
  });

  describe('SSE cross-origin header strip', () => {
    const apiKey = (key: string): AuthConfig =>
      ({ type: 'api-key', apiKey: { key, value: 'v', in: 'header' } }) as AuthConfig;

    it('names an auth-added header, including an inherited one', () => {
      const own = sse({ auth: apiKey('X-Own') });
      seed(own);
      expect(resolveSseConnect(own)).toMatchObject({ ok: true, stripOnOriginChange: ['X-Own'] });
      const inheriting = sse();
      seed(inheriting, {}, { auth: apiKey('X-Folder') });
      expect(resolveSseConnect(inheriting)).toMatchObject({
        ok: true,
        stripOnOriginChange: ['X-Folder'],
      });
    });

    it('names the header as sent when its name is a variable', () => {
      const request = sse({ auth: apiKey('X-{{host}}') });
      seed(request);
      expect(resolveSseConnect(request)).toMatchObject({
        ok: true,
        stripOnOriginChange: ['X-col.example.com'],
      });
    });
  });
});
