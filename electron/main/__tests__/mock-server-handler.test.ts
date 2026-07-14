import { describe, expect, it } from 'vitest';
import { expandTemplate, type MockRoute, matchRoute } from '../handlers/mock-server-handler';

const route = (over: Partial<MockRoute> & Pick<MockRoute, 'method' | 'path'>): MockRoute => ({
  status: 200,
  headers: {},
  body: '',
  ...over,
});

describe('matchRoute', () => {
  const routes: MockRoute[] = [
    route({ method: 'GET', path: '/users' }),
    route({ method: 'GET', path: '/users/:id' }),
    route({ method: 'POST', path: '/users' }),
    route({ method: '*', path: '/health' }),
  ];

  it('matches method + exact path', () => {
    expect(matchRoute(routes, 'GET', '/users')?.method).toBe('GET');
    expect(matchRoute(routes, 'POST', '/users')?.method).toBe('POST');
  });

  it('prefers an exact path over a param pattern', () => {
    // /users matches both '/users' and would not match '/users/:id'; ensure exact wins
    expect(matchRoute(routes, 'GET', '/users')?.path).toBe('/users');
  });

  it('matches :param segments', () => {
    expect(matchRoute(routes, 'GET', '/users/42')?.path).toBe('/users/:id');
  });

  it('matches wildcard method', () => {
    expect(matchRoute(routes, 'DELETE', '/health')?.path).toBe('/health');
  });

  it('returns null when nothing matches', () => {
    expect(matchRoute(routes, 'GET', '/nope')).toBeNull();
    expect(matchRoute(routes, 'PUT', '/users')).toBeNull();
  });

  it('matches a trailing wildcard', () => {
    const r = [route({ method: 'GET', path: '/static/*' })];
    expect(matchRoute(r, 'GET', '/static/js/app.js')?.path).toBe('/static/*');
  });
});

describe('expandTemplate', () => {
  it('replaces $randomUUID with a uuid', () => {
    const out = expandTemplate('{"id":"{{$randomUUID}}"}');
    expect(out).toMatch(/"id":"[0-9a-f-]{36}"/);
  });

  it('replaces $timestamp and $isoTimestamp', () => {
    expect(expandTemplate('{{$timestamp}}')).toMatch(/^\d+$/);
    expect(expandTemplate('{{$isoTimestamp}}')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('leaves untemplated bodies unchanged', () => {
    expect(expandTemplate('{"static":true}')).toBe('{"static":true}');
  });
});
