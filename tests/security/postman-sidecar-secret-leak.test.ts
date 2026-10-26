// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { importPostmanCollection } from '../../shared/collections/postman';
import {
  countCollectionInlineSecrets,
  redactCollectionSecrets,
} from '../../shared/secrets/collection-redaction';

/**
 * ADR 0034 / #1199: the `_postman` sidecar keeps raw Postman JSON for
 * unmodelled constructs, which can include credentials. A redacted export
 * must not carry any of them, and the export-warning counter must see them.
 */
describe('Postman _postman sidecar never leaks plaintext through redaction', () => {
  const SECRETS = ['HAWK_KEY_123', 'JWT_SECRET_456', 'RESP_TOKEN_789', 'ORIG_AUTH_000'];

  const postman = {
    info: {
      name: 'Leak',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    auth: { type: 'jwt', jwt: [{ key: 'secret', value: 'JWT_SECRET_456' }] },
    item: [
      {
        name: 'R',
        request: {
          method: 'GET',
          url: 'https://api.example.com',
          auth: { type: 'hawk', hawk: [{ key: 'authKey', value: 'HAWK_KEY_123' }] },
        },
        response: [
          {
            name: 'ok',
            header: [{ key: 'Set-Cookie', value: 'sid=RESP_TOKEN_789' }],
            body: '{"token":"RESP_TOKEN_789"}',
            originalRequest: {
              header: [{ key: 'Authorization', value: 'Bearer ORIG_AUTH_000' }],
            },
          },
        ],
      },
    ],
  };

  it('imported sidecars hold the raw material (precondition)', () => {
    const { collection } = importPostmanCollection(postman);
    const text = JSON.stringify(collection);
    for (const s of SECRETS) expect(text).toContain(s);
  });

  it('redactCollectionSecrets blanks every sidecar credential', () => {
    const { collection } = importPostmanCollection(postman);
    const text = JSON.stringify(redactCollectionSecrets(collection));
    for (const s of SECRETS) expect(text).not.toContain(s);
  });

  it('countCollectionInlineSecrets sees sidecar-only credentials', () => {
    const { collection } = importPostmanCollection(postman);
    // jwt secret + hawk authKey + Set-Cookie row + originalRequest Authorization row
    expect(countCollectionInlineSecrets(collection)).toBe(4);
  });

  it('the import report never echoes sidecar contents', () => {
    const { report } = importPostmanCollection(postman);
    const text = JSON.stringify(report);
    for (const s of SECRETS) expect(text).not.toContain(s);
  });
});
