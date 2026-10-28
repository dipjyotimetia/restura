import { describe, expect, it } from 'vitest';
import { exportPostmanV21 } from '../../shared/collections/postman/export-v2';
import { exportPostmanV3 } from '../../shared/collections/postman/export-v3';
import {
  countCollectionInlineSecrets,
  redactCollectionSecrets,
} from '../../shared/secrets/collection-redaction';
import type { Collection, FormDataItem, HttpRequest } from '../../shared/types';

/**
 * Q29: credential-named rows in a structured urlencoded / form-data body are
 * counted (so the include-secrets prompt fires) and blanked when secrets are
 * excluded — the same rule as headers / query params and as sidecar bodies.
 */

const rows = (): FormDataItem[] => [
  { id: '1', key: 'client_secret', value: 'CS-PLAIN', enabled: true, type: 'text' },
  { id: '2', key: 'password', value: 'PW-PLAIN', enabled: true, type: 'text' },
  { id: '3', key: 'username', value: 'ada', enabled: true, type: 'text' },
  { id: '4', key: 'secret_file', value: '', enabled: true, type: 'file', fileName: 'k.pem' },
];

function collection(type: HttpRequest['body']['type']): Collection {
  return {
    id: 'c',
    name: 'C',
    items: [
      {
        id: 'r',
        name: 'Token',
        type: 'request',
        request: {
          id: 'r',
          name: 'Token',
          type: 'http',
          method: 'POST',
          url: 'https://auth.example.com/token',
          headers: [],
          params: [],
          body: { type, formData: rows() },
          auth: { type: 'none' },
        },
      },
    ],
  };
}

const exported = (c: Collection) =>
  `${JSON.stringify(exportPostmanV21(c).collection)}\n${Object.values(exportPostmanV3(c).files).join('\n')}`;

describe('structured form-body rows follow the include-secrets choice', () => {
  for (const type of ['x-www-form-urlencoded', 'form-data'] as const) {
    it(`${type}: counted, blanked when excluded, kept when included`, () => {
      const c = collection(type);
      expect(countCollectionInlineSecrets(c)).toBe(2);
      const excluded = exported(redactCollectionSecrets(c));
      expect(excluded).not.toContain('CS-PLAIN');
      expect(excluded).not.toContain('PW-PLAIN');
      expect(excluded).toContain('ada');
      expect(excluded).toContain('client_secret');
      const included = exported(c);
      expect(included).toContain('CS-PLAIN');
      expect(included).toContain('PW-PLAIN');
      // The source collection is not mutated.
      expect((c.items[0]?.request as HttpRequest).body.formData?.[0]?.value).toBe('CS-PLAIN');
    });
  }

  it('rows left over on a non-form body are neither counted nor touched', () => {
    const c = collection('json');
    expect(countCollectionInlineSecrets(c)).toBe(0);
    const body = (redactCollectionSecrets(c).items[0]?.request as HttpRequest).body;
    expect(body.formData?.[0]?.value).toBe('CS-PLAIN');
  });
});
