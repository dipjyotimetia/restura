import { describe, expect, it } from 'vitest';
import { requestOf } from '../../tests/helpers/requestOf';
import type { HttpRequest } from '../types';
import { ocToInternal } from './to-internal';

/**
 * OC form parts are rows like headers/params: a row written without `enabled`
 * is enabled (the `kvToInternal` convention). The send rule
 * (`shared/protocol/request-spec.ts`) sends only truthy-`enabled` rows, so a
 * part left as written would be silently dropped by the app (B19).
 */
function importBody(body: unknown): HttpRequest['body'] {
  const c = ocToInternal({
    opencollection: '1.0.0',
    info: { name: 'Forms' },
    items: [
      {
        info: { name: 'Upload', type: 'http' },
        http: { method: 'POST', url: 'https://api.example.test/u', body },
      },
    ],
  } as never);
  return (requestOf(c.items[0]) as HttpRequest).body;
}

describe('ocToInternal form rows', () => {
  it('multipart parts without `enabled` convert to enabled rows; explicit false stays disabled', () => {
    const body = importBody({
      multipartForm: {
        parts: [
          { key: 'a', value: '1', type: 'text' },
          { key: 'b', value: '2', type: 'text', enabled: false },
          { key: 'c', value: '3', type: 'text', enabled: true },
        ],
      },
    });
    expect(body.type).toBe('form-data');
    expect(body.formData?.map((r) => [r.key, r.value, r.enabled])).toEqual([
      ['a', '1', true],
      ['b', '2', false],
      ['c', '3', true],
    ]);
  });

  it('url-encoded parts without `enabled` convert to enabled rows', () => {
    const body = importBody({ formUrlEncoded: { parts: [{ key: 'q', value: 'x' }] } });
    expect(body.type).toBe('x-www-form-urlencoded');
    expect(body.formData?.[0]).toMatchObject({ key: 'q', value: 'x', enabled: true });
  });
});
