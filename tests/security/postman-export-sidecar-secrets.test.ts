import { describe, expect, it } from 'vitest';
import { importPostmanCollection } from '../../shared/collections/postman';
import { exportPostmanV21 } from '../../shared/collections/postman/export-v2';
import { exportPostmanV3 } from '../../shared/collections/postman/export-v3';
import {
  countCollectionInlineSecrets,
  redactCollectionSecrets,
} from '../../shared/secrets/collection-redaction';
import type { Collection, CollectionItem } from '../../shared/types';

/**
 * #1229 review: `_postman` sidecar credentials must never reach a Postman
 * export file — neither as a keychain-handle object (id + label leak the
 * collection / request names and point at the keychain) nor as plaintext in
 * nested OAuth2 parameter rows that redaction did not look into.
 */

const SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

function hawkWithHandle(): Collection {
  const item: CollectionItem = {
    id: 'r',
    name: 'Req',
    type: 'request',
    request: {
      id: 'r',
      name: 'Req',
      type: 'http',
      method: 'GET',
      url: 'https://api.example.com/x',
      headers: [],
      params: [],
      body: { type: 'none' },
      auth: { type: 'none' },
    },
  };
  // What `convertPostmanBagToHandles` leaves behind with handle storage on.
  Object.assign(item, {
    _postman: {
      auth: {
        type: 'hawk',
        hawk: [
          { key: 'authId', value: 'id' },
          {
            key: 'authKey',
            value: { kind: 'handle', id: 'h-123', label: 'Col/Req/_postman.hawk.authKey' },
          },
        ],
      },
    },
  });
  return { id: 'c', name: 'Col', items: [item] };
}

const allText = (c: Collection) => ({
  v21: JSON.stringify(exportPostmanV21(c).collection),
  v3: Object.values(exportPostmanV3(c).files).join('\n'),
});

describe('Postman export never writes sidecar keychain handles', () => {
  for (const includeSecrets of [true, false]) {
    it(`v2.1 and v3, secrets ${includeSecrets ? 'included' : 'excluded'}`, () => {
      const source = hawkWithHandle();
      const c = includeSecrets ? source : redactCollectionSecrets(source);
      const { v21, v3 } = allText(c);
      for (const text of [v21, v3]) {
        expect(text).not.toContain('h-123');
        expect(text).not.toContain('_postman.hawk.authKey');
        expect(text).not.toContain('"kind"');
        expect(text).toContain('hawk');
      }
      expect(exportPostmanV21(c).report.entries.map((e) => e.construct)).toContain('secret-handle');
      expect(exportPostmanV3(c).report.entries.map((e) => e.construct)).toContain('secret-handle');
    });
  }
});

describe('nested OAuth2 parameter rows are redacted and counted', () => {
  const postman = {
    info: { name: 'OAuth', schema: SCHEMA },
    item: [
      {
        name: 'PKCE',
        request: {
          method: 'GET',
          url: 'https://api.example.com/x',
          auth: {
            type: 'oauth2',
            oauth2: [
              { key: 'grant_type', value: 'authorization_code_with_pkce' },
              { key: 'code_verifier', value: 'VERIFIER-PLAIN' },
              {
                key: 'tokenRequestParams',
                value: [
                  { key: 'client_assertion', value: 'ASSERT-PLAIN', send_as: 'request_body' },
                ],
              },
              {
                key: 'refreshRequestParams',
                value: [
                  { key: 'audience', value: 'api://default', send_as: 'request_body' },
                  { key: 'x-a', value: 'TYPED-SECRET', type: 'secret' },
                  { key: 'x-b', value: 'FLAGGED-SECRET', secret: true },
                  'junk',
                ],
              },
            ],
          },
        },
      },
    ],
  };

  it('counts them, so the include-secrets prompt is shown', () => {
    const { collection } = importPostmanCollection(postman);
    expect(countCollectionInlineSecrets(collection)).toBe(4);
  });

  it('"exclude secrets" blanks them in v2.1 and v3 exports; benign rows survive', () => {
    const { collection } = importPostmanCollection(postman);
    const { v21, v3 } = allText(redactCollectionSecrets(collection));
    for (const text of [v21, v3]) {
      expect(text).not.toContain('VERIFIER-PLAIN');
      expect(text).not.toContain('ASSERT-PLAIN');
      expect(text).not.toContain('TYPED-SECRET');
      expect(text).not.toContain('FLAGGED-SECRET');
      expect(text).toContain('client_assertion');
      expect(text).toContain('api://default');
    }
  });
});
