import { describe, expect, it } from 'vitest';
import type { Collection, HistoryItem, OpenAPIDocument } from '@/types';
import {
  buildMockRoutes,
  buildMockRoutesFromSpec,
  extractPath,
  mergeMockRoutes,
} from '../mockRoutes';

describe('extractPath', () => {
  it('returns the pathname of an absolute URL', () => {
    expect(extractPath('https://api.example.com/users/1?x=1')).toBe('/users/1');
  });

  it('converts template variables to :param wildcards', () => {
    expect(extractPath('{{baseUrl}}/users/{{id}}')).toBe('/users/:id');
    expect(extractPath('https://api.example/users/{{userId}}/posts')).toBe('/users/:userId/posts');
  });

  it('handles bare paths', () => {
    expect(extractPath('/health')).toBe('/health');
  });
});

function httpItem(id: string, name: string, method: string, url: string) {
  return {
    id,
    name,
    type: 'request' as const,
    request: {
      id,
      name,
      type: 'http' as const,
      method: method as never,
      url,
      headers: [],
      params: [],
      body: { type: 'none' as const },
      auth: { type: 'none' } as never,
    },
  };
}

const collection: Collection = {
  id: 'c1',
  name: 'API',
  items: [
    httpItem('r1', 'Get users', 'GET', 'https://api.example/users'),
    httpItem('r2', 'Get health', 'GET', 'https://api.example/health'),
    {
      id: 'f1',
      name: 'WS',
      type: 'folder',
      items: [
        // non-HTTP should be skipped
        {
          id: 'w1',
          name: 'socket',
          type: 'request',
          request: { id: 'w1', name: 'socket', type: 'websocket', url: 'wss://x' } as never,
        },
      ],
    },
  ],
};

describe('buildMockRoutes', () => {
  it('creates a route per HTTP request and skips non-HTTP', () => {
    const routes = buildMockRoutes(collection, []);
    expect(routes).toHaveLength(2);
    expect(routes.map((r) => r.path).sort()).toEqual(['/health', '/users']);
  });

  it('stubs requests with no recorded response', () => {
    const routes = buildMockRoutes(collection, []);
    const users = routes.find((r) => r.path === '/users')!;
    expect(users.status).toBe(200);
    expect(JSON.parse(users.body)).toMatchObject({ mock: true, method: 'GET', path: '/users' });
  });

  it('replays the most recent recorded response', () => {
    const history: HistoryItem[] = [
      {
        id: 'h1',
        timestamp: 2,
        request: {
          id: 'r1',
          name: 'Get users',
          type: 'http',
          method: 'GET',
          url: 'https://api.example/users',
          headers: [],
          params: [],
          body: { type: 'none' },
          auth: { type: 'none' },
        } as never,
        response: {
          id: 'x',
          requestId: 'r1',
          status: 201,
          statusText: 'Created',
          headers: { 'content-type': 'application/json' },
          body: '[{"id":1}]',
          size: 10,
          time: 5,
          timestamp: 2,
        },
      },
    ];
    const routes = buildMockRoutes(collection, history);
    const users = routes.find((r) => r.path === '/users')!;
    expect(users.status).toBe(201);
    expect(users.body).toBe('[{"id":1}]');
    expect(users.headers['content-type']).toBe('application/json');
  });

  it('carries base64 bodyEncoding for recorded binary responses', () => {
    const history: HistoryItem[] = [
      {
        id: 'h2',
        timestamp: 3,
        request: {
          id: 'r1',
          name: 'Get users',
          type: 'http',
          method: 'GET',
          url: 'https://api.example/users',
          headers: [],
          params: [],
          body: { type: 'none' },
          auth: { type: 'none' },
        } as never,
        response: {
          id: 'y',
          requestId: 'r1',
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'image/png' },
          body: 'iVBORw0KGgo=',
          size: 8,
          time: 5,
          timestamp: 3,
          bodyEncoding: 'base64',
        },
      },
    ];
    const route = buildMockRoutes(collection, history).find((r) => r.path === '/users')!;
    expect(route.bodyEncoding).toBe('base64');
    expect(route.body).toBe('iVBORw0KGgo=');
  });
});

const spec: OpenAPIDocument = {
  openapi: '3.0.0',
  info: { title: 'Test API', version: '1.0.0' },
  paths: {
    '/users/{id}': {
      get: {
        operationId: 'getUser',
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { id: { type: 'string', format: 'uuid' }, name: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    },
    '/orders': {
      post: {
        operationId: 'createOrder',
        responses: {
          '201': { content: { 'application/json': { example: { id: 'order-1' } } } },
          // Lower 2xx should win over 201 when both present.
          '200': { content: { 'application/json': { example: { id: 'order-0' } } } },
        },
      },
      // No responses declared — should be skipped entirely.
      delete: { operationId: 'deleteOrder' },
    },
  },
};

describe('buildMockRoutesFromSpec', () => {
  it('generates a route per operation using the response schema', () => {
    const routes = buildMockRoutesFromSpec(spec);
    const user = routes.find((r) => r.path === '/users/{id}')!;
    expect(user.method).toBe('GET');
    expect(user.status).toBe(200);
    expect(user.headers['content-type']).toBe('application/json');
    expect(JSON.parse(user.body)).toEqual({
      id: '00000000-0000-0000-0000-000000000000',
      name: 'string',
    });
  });

  it('picks the lowest 2xx status and prefers a static example over schema generation', () => {
    const routes = buildMockRoutesFromSpec(spec);
    const order = routes.find((r) => r.path === '/orders')!;
    expect(order.method).toBe('POST');
    expect(order.status).toBe(200);
    expect(JSON.parse(order.body)).toEqual({ id: 'order-0' });
  });

  it('skips operations with no usable response', () => {
    const routes = buildMockRoutesFromSpec(spec);
    expect(routes.find((r) => r.method === 'DELETE')).toBeUndefined();
    expect(routes).toHaveLength(2);
  });
});

describe('mergeMockRoutes', () => {
  it('keeps history routes and adds only spec routes not already covered', () => {
    const historyRoutes = buildMockRoutes(collection, []);
    const specRoutes = buildMockRoutesFromSpec(spec);
    const merged = mergeMockRoutes(historyRoutes, specRoutes);

    expect(merged).toHaveLength(historyRoutes.length + specRoutes.length);
    expect(merged.filter((r) => r.path === '/users')).toHaveLength(1);
  });

  it('does not duplicate a route the history already covers', () => {
    const historyRoutes = buildMockRoutes(collection, []);
    // Same method+path as an existing history route — should not be added twice.
    const overlappingSpecRoutes = buildMockRoutesFromSpec({
      ...spec,
      paths: { '/users': { get: { responses: { '200': {} } } } },
    });
    const merged = mergeMockRoutes(historyRoutes, overlappingSpecRoutes);
    expect(merged.filter((r) => r.method === 'GET' && r.path === '/users')).toHaveLength(1);
    // The surviving route is the history one (real recorded/stub data), not the spec stub.
    expect(merged.find((r) => r.path === '/users')?.body).toBe(
      historyRoutes.find((r) => r.path === '/users')!.body
    );
  });

  it('dedupes a parameterized path even though history uses `:id` and the spec uses `{id}`', () => {
    const paramCollection: Collection = {
      id: 'c2',
      name: 'API',
      items: [httpItem('r3', 'Get user', 'GET', 'https://api.example/users/{{id}}')],
    };
    const historyRoutes = buildMockRoutes(paramCollection, []);
    expect(historyRoutes[0]!.path).toBe('/users/:id'); // extractPath's wildcard syntax

    const paramSpec: OpenAPIDocument = {
      ...spec,
      paths: { '/users/{id}': { get: { responses: { '200': {} } } } }, // OpenAPI's wildcard syntax
    };
    const specRoutes = buildMockRoutesFromSpec(paramSpec);
    const merged = mergeMockRoutes(historyRoutes, specRoutes);

    expect(merged.filter((r) => r.method === 'GET')).toHaveLength(1);
    expect(merged[0]).toBe(historyRoutes[0]); // history wins, spec duplicate dropped
  });
});
