import { describe, it, expect } from 'vitest';
import { buildMockRoutes, extractPath } from '../mockRoutes';
import type { Collection, HistoryItem } from '@/types';

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
