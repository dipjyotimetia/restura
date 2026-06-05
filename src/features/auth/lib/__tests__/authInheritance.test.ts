import { describe, expect, it } from 'vitest';
import { resolveEffectiveAuth, findInheritedAuth, withEffectiveAuth } from '../authInheritance';
import type { AuthConfig, Collection, HttpRequest } from '@/types';

const noneAuth: AuthConfig = { type: 'none' };
const bearerAuth: AuthConfig = { type: 'bearer', bearer: { token: 'collection-token' } };
const requestBearerAuth: AuthConfig = { type: 'bearer', bearer: { token: 'request-token' } };

const makeRequest = (id: string, auth: AuthConfig = noneAuth): HttpRequest => ({
  id,
  name: 'Test',
  type: 'http',
  method: 'GET',
  url: 'https://example.com',
  headers: [],
  params: [],
  body: { type: 'none' },
  auth,
});

const makeCollection = (requestId: string, collectionAuth?: AuthConfig): Collection => ({
  id: 'col-1',
  name: 'My Collection',
  auth: collectionAuth,
  items: [{ id: 'item-1', name: 'Request', type: 'request', request: makeRequest(requestId) }],
});

describe('resolveEffectiveAuth', () => {
  it('returns request auth when type is not none', () => {
    const result = resolveEffectiveAuth(requestBearerAuth, bearerAuth);
    expect(result).toBe(requestBearerAuth);
  });

  it('returns inherited auth when request auth is none', () => {
    const result = resolveEffectiveAuth(noneAuth, bearerAuth);
    expect(result).toBe(bearerAuth);
  });

  it('returns request auth when no inherited auth', () => {
    const result = resolveEffectiveAuth(noneAuth, undefined);
    expect(result).toBe(noneAuth);
  });
});

describe('findInheritedAuth', () => {
  it('returns collection auth for a request in the collection', () => {
    const collection = makeCollection('req-1', bearerAuth);
    const result = findInheritedAuth(collection, 'req-1');
    expect(result).toBe(bearerAuth);
  });

  it('returns undefined when request is not in collection', () => {
    const collection = makeCollection('req-1', bearerAuth);
    const result = findInheritedAuth(collection, 'req-99');
    expect(result).toBeUndefined();
  });

  it('returns undefined when collection has no auth', () => {
    const collection = makeCollection('req-1', undefined);
    const result = findInheritedAuth(collection, 'req-1');
    expect(result).toBeUndefined();
  });

  it('finds request in nested folder', () => {
    const collection: Collection = {
      id: 'col-1',
      name: 'Col',
      auth: bearerAuth,
      items: [
        {
          id: 'folder-1',
          name: 'Folder',
          type: 'folder',
          items: [
            { id: 'item-2', name: 'Nested', type: 'request', request: makeRequest('req-nested') },
          ],
        },
      ],
    };
    const result = findInheritedAuth(collection, 'req-nested');
    expect(result).toBe(bearerAuth);
  });

  it('folder auth overrides collection auth for descendants', () => {
    const folderAuth: AuthConfig = { type: 'bearer', bearer: { token: 'folder-token' } };
    const collection: Collection = {
      id: 'col-1',
      name: 'Col',
      auth: bearerAuth,
      items: [
        {
          id: 'folder-1',
          name: 'Folder',
          type: 'folder',
          auth: folderAuth,
          items: [
            { id: 'item-2', name: 'Nested', type: 'request', request: makeRequest('req-nested') },
          ],
        },
      ],
    };
    expect(findInheritedAuth(collection, 'req-nested')).toBe(folderAuth);
  });

  it("folder auth of type 'none' does not mask collection auth", () => {
    const collection: Collection = {
      id: 'col-1',
      name: 'Col',
      auth: bearerAuth,
      items: [
        {
          id: 'folder-1',
          name: 'Folder',
          type: 'folder',
          auth: noneAuth,
          items: [
            { id: 'item-2', name: 'Nested', type: 'request', request: makeRequest('req-nested') },
          ],
        },
      ],
    };
    expect(findInheritedAuth(collection, 'req-nested')).toBe(bearerAuth);
  });

  it('inner folder auth wins over outer folder auth', () => {
    const outerAuth: AuthConfig = { type: 'bearer', bearer: { token: 'outer' } };
    const innerAuth: AuthConfig = { type: 'bearer', bearer: { token: 'inner' } };
    const collection: Collection = {
      id: 'col-1',
      name: 'Col',
      auth: bearerAuth,
      items: [
        {
          id: 'outer',
          name: 'Outer',
          type: 'folder',
          auth: outerAuth,
          items: [
            {
              id: 'inner',
              name: 'Inner',
              type: 'folder',
              auth: innerAuth,
              items: [
                { id: 'item-2', name: 'Deep', type: 'request', request: makeRequest('req-deep') },
              ],
            },
          ],
        },
      ],
    };
    expect(findInheritedAuth(collection, 'req-deep')).toBe(innerAuth);
  });
});

describe('withEffectiveAuth', () => {
  it('request auth overrides collection auth', () => {
    const request = makeRequest('req-1', requestBearerAuth);
    const result = withEffectiveAuth(request, bearerAuth);
    expect(result.auth).toBe(requestBearerAuth);
  });

  it('request with none auth inherits collection bearer', () => {
    const request = makeRequest('req-1', noneAuth);
    const result = withEffectiveAuth(request, bearerAuth);
    expect(result.auth).toBe(bearerAuth);
  });

  it('leaves request unchanged when no inherited auth', () => {
    const request = makeRequest('req-1', noneAuth);
    const result = withEffectiveAuth(request, undefined);
    expect(result.auth).toBe(noneAuth);
  });
});
