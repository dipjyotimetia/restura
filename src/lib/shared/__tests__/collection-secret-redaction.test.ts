import { describe, it, expect } from 'vitest';
import {
  redactAuthConfigSecrets,
  redactCollectionSecrets,
  countCollectionInlineSecrets,
} from '../collection-secret-redaction';
import type { AuthConfig, Collection, CollectionItem, HttpRequest } from '@/types';

const request = (id: string, auth: AuthConfig): HttpRequest => ({
  id,
  name: 'R',
  type: 'http',
  method: 'GET',
  url: 'https://example.com',
  headers: [],
  params: [],
  body: { type: 'none' },
  auth,
});

const requestItem = (id: string, auth: AuthConfig): CollectionItem => ({
  id,
  name: 'R',
  type: 'request',
  request: request(`${id}-req`, auth),
});

describe('redactAuthConfigSecrets', () => {
  it('blanks plain-string secrets but keeps non-secret fields', () => {
    const out = redactAuthConfigSecrets({
      type: 'basic',
      basic: { username: 'alice', password: 'hunter2' },
    });
    expect(out.basic).toEqual({ username: 'alice', password: '' });
  });

  it('blanks inline SecretRef values', () => {
    const out = redactAuthConfigSecrets({
      type: 'bearer',
      bearer: { token: { kind: 'inline', value: 'tok-123' } },
    });
    expect(out.bearer?.token).toEqual({ kind: 'inline', value: '' });
  });

  it('preserves handle references untouched', () => {
    const handle = { kind: 'handle' as const, id: 'h-1', label: 'prod token' };
    const out = redactAuthConfigSecrets({ type: 'bearer', bearer: { token: handle } });
    expect(out.bearer?.token).toEqual(handle);
  });

  it('redacts every oauth2 secret field but keeps flow config', () => {
    const out = redactAuthConfigSecrets({
      type: 'oauth2',
      oauth2: {
        accessToken: 'at',
        refreshToken: 'rt',
        clientSecret: 'cs',
        password: 'pw',
        clientId: 'my-client',
        tokenUrl: 'https://idp/token',
      },
    });
    expect(out.oauth2).toEqual({
      accessToken: '',
      refreshToken: '',
      clientSecret: '',
      password: '',
      clientId: 'my-client',
      tokenUrl: 'https://idp/token',
    });
  });

  it('does not mutate the input', () => {
    const auth: AuthConfig = { type: 'basic', basic: { username: 'a', password: 'secret' } };
    redactAuthConfigSecrets(auth);
    expect(auth.basic?.password).toBe('secret');
  });
});

describe('redactCollectionSecrets', () => {
  const collection: Collection = {
    id: 'c1',
    name: 'C',
    auth: { type: 'bearer', bearer: { token: 'collection-token' } },
    items: [
      {
        id: 'f1',
        name: 'F',
        type: 'folder',
        auth: {
          type: 'aws-signature',
          awsSignature: { accessKey: 'AK', secretKey: 'SK', region: 'r', service: 's' },
        },
        items: [requestItem('r1', { type: 'basic', basic: { username: 'u', password: 'p' } })],
      },
      requestItem('r2', { type: 'api-key', apiKey: { key: 'X-Key', value: 'v', in: 'header' } }),
    ],
  };

  it('redacts collection, folder, and request auth across the tree', () => {
    const out = redactCollectionSecrets(collection);
    expect(out.auth?.bearer?.token).toBe('');
    const folder = out.items[0]!;
    expect(folder.auth?.awsSignature).toEqual({
      accessKey: 'AK',
      secretKey: '',
      region: 'r',
      service: 's',
    });
    expect(folder.items![0]!.request!.auth.basic?.password).toBe('');
    expect(out.items[1]!.request!.auth.apiKey?.value).toBe('');
  });

  it('does not mutate the original tree', () => {
    redactCollectionSecrets(collection);
    expect(collection.auth?.bearer?.token).toBe('collection-token');
    expect(collection.items[0]!.items![0]!.request!.auth.basic?.password).toBe('p');
  });
});

describe('countCollectionInlineSecrets', () => {
  it('counts plain-string and inline secrets, ignoring handles and empties', () => {
    const c: Collection = {
      id: 'c1',
      name: 'C',
      auth: { type: 'bearer', bearer: { token: 'tok' } }, // 1
      items: [
        requestItem('r1', {
          type: 'oauth2',
          oauth2: {
            accessToken: { kind: 'inline', value: 'at' }, // 2
            clientSecret: { kind: 'handle', id: 'h-1' }, // handle — not counted
          },
        }),
        requestItem('r2', { type: 'basic', basic: { username: 'u', password: '' } }), // empty — not counted
      ],
    };
    expect(countCollectionInlineSecrets(c)).toBe(2);
  });

  it('returns 0 for a collection with no auth anywhere', () => {
    const c: Collection = { id: 'c', name: 'C', items: [requestItem('r', { type: 'none' })] };
    expect(countCollectionInlineSecrets(c)).toBe(0);
  });
});
