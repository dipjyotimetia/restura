import { describe, it, expect } from 'vitest';
import { importPostmanCollection } from '../importers/postman';
import type { PostmanCollection, HttpRequest } from '@/types';

function asHttp(item: { request?: unknown }): HttpRequest {
  return item.request as HttpRequest;
}

describe('importPostmanCollection — OAuth2 full preservation', () => {
  it('preserves all OAuth2 flow fields from a Postman collection', async () => {
    const postmanData: PostmanCollection = {
      info: {
        name: 'OAuth2 Test',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
      item: [
        {
          name: 'OAuth2 Request',
          request: {
            method: 'GET',
            url: 'https://api.example.com/me',
            header: [],
            auth: {
              type: 'oauth2',
              oauth2: [
                { key: 'accessToken', value: 'tok-1234', type: 'string' },
                { key: 'tokenType', value: 'Bearer', type: 'string' },
                { key: 'grant_type', value: 'authorization_code_with_pkce', type: 'string' },
                { key: 'clientId', value: 'cid-abc', type: 'string' },
                { key: 'clientSecret', value: 'csec-xyz', type: 'string' },
                { key: 'authUrl', value: 'https://auth.example.com/authorize', type: 'string' },
                { key: 'accessTokenUrl', value: 'https://auth.example.com/token', type: 'string' },
                { key: 'scope', value: 'read write', type: 'string' },
                { key: 'redirect_uri', value: 'https://app.example.com/callback', type: 'string' },
              ],
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PostmanCollection type is loose
          } as any,
        },
      ],
    };

    const collection = await importPostmanCollection(postmanData);
    const req = asHttp(collection.items[0]!);

    expect(req.auth?.type).toBe('oauth2');
    const o = req.auth?.oauth2;
    expect(o?.accessToken).toBe('tok-1234');
    expect(o?.tokenType).toBe('Bearer');
    // PKCE collapses to plain authorization_code in our model
    expect(o?.grantType).toBe('authorization_code');
    expect(o?.clientId).toBe('cid-abc');
    expect(o?.clientSecret).toBe('csec-xyz');
    expect(o?.authorizationUrl).toBe('https://auth.example.com/authorize');
    expect(o?.tokenUrl).toBe('https://auth.example.com/token');
    expect(o?.scope).toBe('read write');
    expect(o?.redirectUri).toBe('https://app.example.com/callback');
  });

  it('maps grant_type=client_credentials correctly', async () => {
    const postmanData: PostmanCollection = {
      info: {
        name: 'Client Credentials',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
      item: [
        {
          name: 'CC Request',
          request: {
            method: 'POST',
            url: 'https://api.example.com/widgets',
            auth: {
              type: 'oauth2',
              oauth2: [
                { key: 'accessToken', value: '', type: 'string' },
                { key: 'grant_type', value: 'client_credentials', type: 'string' },
                { key: 'clientId', value: 'cid', type: 'string' },
              ],
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
        },
      ],
    };
    const collection = await importPostmanCollection(postmanData);
    const o = asHttp(collection.items[0]!).auth?.oauth2;
    expect(o?.grantType).toBe('client_credentials');
    expect(o?.clientId).toBe('cid');
  });

  it('maps grant_type=password_credentials to "password" and pulls credentials', async () => {
    const postmanData: PostmanCollection = {
      info: {
        name: 'Password Grant',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
      item: [
        {
          name: 'PW Request',
          request: {
            method: 'GET',
            url: 'https://api.example.com/me',
            auth: {
              type: 'oauth2',
              oauth2: [
                { key: 'accessToken', value: '', type: 'string' },
                { key: 'grant_type', value: 'password_credentials', type: 'string' },
                { key: 'username', value: 'alice', type: 'string' },
                { key: 'password', value: 'sek', type: 'string' },
              ],
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
        },
      ],
    };
    const collection = await importPostmanCollection(postmanData);
    const o = asHttp(collection.items[0]!).auth?.oauth2;
    expect(o?.grantType).toBe('password');
    expect(o?.username).toBe('alice');
    expect(o?.password).toBe('sek');
  });

  it('drops grant_type=implicit (Restura does not model implicit flow)', async () => {
    const postmanData: PostmanCollection = {
      info: {
        name: 'Implicit',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
      item: [
        {
          name: 'Imp Request',
          request: {
            method: 'GET',
            url: 'https://api.example.com/me',
            auth: {
              type: 'oauth2',
              oauth2: [
                { key: 'accessToken', value: 'tok', type: 'string' },
                { key: 'grant_type', value: 'implicit', type: 'string' },
              ],
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
        },
      ],
    };
    const collection = await importPostmanCollection(postmanData);
    const o = asHttp(collection.items[0]!).auth?.oauth2;
    // grantType should not be set when Postman uses implicit
    expect(o?.grantType).toBeUndefined();
    expect(o?.accessToken).toBe('tok');
  });

  it('strips undefined fields from the resulting oauth2 object', async () => {
    const postmanData: PostmanCollection = {
      info: {
        name: 'Sparse',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
      item: [
        {
          name: 'Sparse Request',
          request: {
            method: 'GET',
            url: 'https://api.example.com/me',
            auth: {
              type: 'oauth2',
              oauth2: [{ key: 'accessToken', value: 'tok', type: 'string' }],
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
        },
      ],
    };
    const collection = await importPostmanCollection(postmanData);
    const o = asHttp(collection.items[0]!).auth?.oauth2;
    expect(o).toBeDefined();
    // Only accessToken should be present; other keys must not exist as `undefined`
    expect(Object.prototype.hasOwnProperty.call(o, 'clientId')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(o, 'tokenUrl')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(o, 'scope')).toBe(false);
    expect(o?.accessToken).toBe('tok');
  });
});
