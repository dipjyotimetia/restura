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
      expect(resolveSseConnect(request)).toEqual({
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
      expect(resolveGrpcReflectionConnect(grpc.url, grpc)).toMatchObject({
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
      expect(resolveGrpcReflectionConnect('https://x', undefined, scope).ok).toBe(false);
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
});
