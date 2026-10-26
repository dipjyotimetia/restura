import { describe, expect, it } from 'vitest';
import type { Collection } from '../../types';
import { countCollectionInlineSecrets, redactCollectionSecrets } from '../collection-redaction';

/** A collection with one request item whose sidecar is `bag`. */
function withBag(bag: Record<string, unknown>): Collection {
  return {
    id: 'c',
    name: 'C',
    items: [{ id: 'r', name: 'R', type: 'folder', items: [], _postman: bag }],
  } as unknown as Collection;
}

describe('_postman saved-response originalRequest: every URL / header shape', () => {
  const bag = {
    response: [
      {
        name: 'string url + string headers',
        header: 'X-Api-Key: HDR_STRING_SECRET\nContent-Type: text/plain',
        originalRequest: {
          url: 'https://STR_USER:STR_PASS@api.example.com/a?api_key=STR_QUERY_SECRET&page=2',
          header: { Authorization: 'Bearer HDR_MAP_SECRET', Accept: 'application/json' },
        },
      },
      {
        name: 'structured url with raw + auth',
        originalRequest: {
          url: {
            raw: 'https://RAW_USER:RAW_PASS@api.example.com/b?access_token=RAW_QUERY_SECRET',
            auth: { user: 'u', password: 'URL_AUTH_PASS' },
            query: [{ key: 'access_token', value: 'RAW_QUERY_SECRET' }],
          },
        },
      },
      // Postman allows `originalRequest` to be a bare URL string.
      { name: 'bare string request', originalRequest: 'https://x.example.com/?token=BARE_SECRET' },
    ],
  };
  const SECRETS = [
    'HDR_STRING_SECRET',
    'STR_USER',
    'STR_PASS',
    'STR_QUERY_SECRET',
    'HDR_MAP_SECRET',
    'RAW_USER',
    'RAW_PASS',
    'RAW_QUERY_SECRET',
    'URL_AUTH_PASS',
    'BARE_SECRET',
  ];

  it('blanks userinfo, credential query params and every header form', () => {
    const text = JSON.stringify(redactCollectionSecrets(withBag(bag)));
    for (const s of SECRETS) expect(text).not.toContain(s);
    // Non-secret parts survive.
    for (const keep of ['page=2', 'text/plain', 'application/json', 'api.example.com/b']) {
      expect(text).toContain(keep);
    }
  });

  it('counts exactly what redaction blanks', () => {
    // string header 1 + userinfo 1 + api_key 1 + map Authorization 1
    // + raw userinfo 1 + raw access_token 1 + url.auth password 1 + query row 1
    // + bare token 1 = 9
    expect(countCollectionInlineSecrets(withBag(bag))).toBe(9);
    expect(countCollectionInlineSecrets(redactCollectionSecrets(withBag(bag)))).toBe(0);
  });
});

describe('_postman auth params: non-string values under secret keys', () => {
  const bag = {
    auth: {
      type: 'hawk',
      hawk: [
        { key: 'authKey', value: 12345 },
        { key: 'secret', value: { nested: 'OBJ_SECRET' } },
        { key: 'algorithm', value: 'sha256' },
      ],
    },
  };

  it('are blanked and counted', () => {
    const c = withBag(bag);
    expect(countCollectionInlineSecrets(c)).toBe(2);
    const text = JSON.stringify(redactCollectionSecrets(c));
    expect(text).not.toContain('12345');
    expect(text).not.toContain('OBJ_SECRET');
    expect(text).toContain('sha256');
  });
});

describe('_postman auth with prototype-named types', () => {
  it.each(['constructor', '__proto__', 'toString'])(
    '%s is treated as an inert unsupported block',
    (type) => {
      const c = withBag({ auth: JSON.parse(`{"type":"${type}"}`) });
      expect(() => countCollectionInlineSecrets(c)).not.toThrow();
      expect(() => redactCollectionSecrets(c)).not.toThrow();
    }
  );
});

type Bag = { _postman?: Record<string, unknown> };

function fixture(): Collection {
  return {
    id: 'c',
    name: 'C',
    _postman: {
      auth: { type: 'jwt', jwt: [{ key: 'secret', value: 'jwt-root-secret' }] },
    },
    items: [
      {
        id: 'f',
        name: 'F',
        type: 'folder',
        _postman: {
          auth: {
            type: 'edgegrid',
            edgegrid: [
              { key: 'accessToken', value: 'eg-access' },
              { key: 'clientSecret', value: 'eg-secret' },
            ],
          },
        },
        items: [
          {
            id: 'r',
            name: 'R',
            type: 'request',
            _postman: {
              // v2.0 object-map auth params.
              auth: { type: 'hawk', hawk: { authId: 'id', authKey: 'hawk-key' } },
              variable: [
                { key: 'apiToken', value: 'var-secret' },
                { key: 'plain', value: 'keep-me' },
                { key: 'x', value: 'typed-secret', type: 'secret' },
              ],
              response: [
                {
                  name: 'ok',
                  header: [
                    { key: 'Set-Cookie', value: 'session=abc' },
                    { key: 'Content-Type', value: 'application/json' },
                  ],
                  cookie: [{ name: 'session', value: 'abc' }],
                  body: '{"access_token":"resp-token"}',
                  originalRequest: {
                    header: [{ key: 'Authorization', value: 'Bearer orig-token' }],
                    auth: { type: 'bearer', bearer: [{ key: 'token', value: 'orig-bearer' }] },
                  },
                },
              ],
            },
            request: {
              id: 'r',
              name: 'R',
              type: 'http',
              method: 'GET',
              url: 'https://api.example.com',
              headers: [],
              params: [],
              body: { type: 'none' },
              auth: { type: 'none' },
            },
          },
        ],
      },
    ],
  } as unknown as Collection;
}

describe('_postman sidecar redaction', () => {
  it('blanks every credential carried in _postman bags (root, folder, request)', () => {
    const redacted = redactCollectionSecrets(fixture());
    const text = JSON.stringify(redacted);
    for (const secret of [
      'jwt-root-secret',
      'eg-access',
      'eg-secret',
      'hawk-key',
      'var-secret',
      'typed-secret',
      'session=abc',
      'resp-token',
      'orig-token',
      'orig-bearer',
    ]) {
      expect(text).not.toContain(secret);
    }
    // Shape survives: non-secret rows and keys are kept.
    expect(text).toContain('keep-me');
    expect(text).toContain('application/json');
    const req = (redacted.items[0]!.items![0] as Bag)._postman!;
    expect((req.auth as { type: string }).type).toBe('hawk');
  });

  it('does not mutate the original collection', () => {
    const original = fixture();
    redactCollectionSecrets(original);
    expect(JSON.stringify(original)).toContain('hawk-key');
  });

  it('counts plaintext secrets that live only in _postman bags', () => {
    // root jwt (1) + edgegrid (2) + hawk authId + authKey (2; `authId` matches the
    // shared credential-name heuristic) + secret vars (2) + response Set-Cookie
    // header (1) + cookie (1) + response body (1; blanked by redaction too)
    // + originalRequest Authorization (1) + bearer (1) = 12
    expect(countCollectionInlineSecrets(fixture())).toBe(12);
  });

  it('does not double-count auth that the typed model already holds', () => {
    const c = {
      id: 'c',
      name: 'C',
      items: [
        {
          id: 'r',
          name: 'R',
          type: 'request',
          // PKCE approximation: the typed oauth2 block already counts clientSecret.
          _postman: {
            auth: { type: 'oauth2', oauth2: [{ key: 'clientSecret', value: 'cs' }] },
          },
          request: {
            id: 'r',
            name: 'R',
            type: 'http',
            method: 'GET',
            url: 'https://x',
            headers: [],
            params: [],
            body: { type: 'none' },
            auth: { type: 'oauth2', oauth2: { accessToken: '', clientSecret: 'cs' } },
          },
        },
      ],
    } as unknown as Collection;
    expect(countCollectionInlineSecrets(c)).toBe(1);
    expect(JSON.stringify(redactCollectionSecrets(c))).not.toContain('"cs"');
  });
});
