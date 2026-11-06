import { describe, expect, it } from 'vitest';
import { exportPostmanV3 } from '../../shared/collections/postman/export-v3';
import {
  countCollectionInlineSecrets,
  redactCollectionSecrets,
} from '../../shared/secrets/collection-redaction';
import type { Collection, HttpRequest, KeyValue } from '../../shared/types';

/**
 * Path variable rows follow the same secret rule as headers and query params:
 * a `secret: true` row or a credential-named row is counted (so the
 * include-secrets prompt fires) and blanked when secrets are excluded.
 */
const pathVariables = (): KeyValue[] => [
  { id: '1', key: 'token', value: 'TOKEN-PLAIN', enabled: true },
  { id: '2', key: 'tenant', value: 'SECRET-FLAGGED', enabled: true, secret: true },
  { id: '3', key: 'id', value: '42', enabled: true },
];

function collection(): Collection {
  const request: HttpRequest = {
    id: 'r',
    name: 'Hook',
    type: 'http',
    method: 'POST',
    url: 'https://api.example.com/hooks/:tenant/:token/:id',
    headers: [],
    params: [],
    pathVariables: pathVariables(),
    body: { type: 'none' },
    auth: { type: 'none' },
  };
  return { id: 'c', name: 'C', items: [{ id: 'r', name: 'Hook', type: 'request', request }] };
}

describe('path variable rows are secret slots', () => {
  it('counts secret-flagged and credential-named rows', () => {
    expect(countCollectionInlineSecrets(collection())).toBe(2);
  });

  it('blanks them on redaction and keeps the others', () => {
    const text = JSON.stringify(redactCollectionSecrets(collection()));
    expect(text).not.toContain('TOKEN-PLAIN');
    expect(text).not.toContain('SECRET-FLAGGED');
    expect(text).toContain('"42"');
  });

  it('a redacted Postman v3 export carries no path variable secret', () => {
    const exported = JSON.stringify(exportPostmanV3(redactCollectionSecrets(collection())));
    expect(exported).not.toContain('TOKEN-PLAIN');
    expect(exported).not.toContain('SECRET-FLAGGED');
  });
});
