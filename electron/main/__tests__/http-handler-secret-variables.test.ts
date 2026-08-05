import { describe, expect, it } from 'vitest';
import { materializeSecretVariables } from '../security/secret-variable-materializer';

describe('materializeSecretVariables', () => {
  it('resolves opaque values only at the Electron wire boundary', async () => {
    const materialized = await materializeSecretVariables({
      method: 'POST',
      url: 'https://{{host}}/v1',
      headers: { Authorization: 'Bearer {{token}}' },
      data: '{"token":"{{token}}"}',
      secretVariables: {
        host: { kind: 'inline', value: 'api.example' },
        token: { kind: 'inline', value: 'desktop-secret' },
      },
    });

    expect(materialized.url).toBe('https://api.example/v1');
    expect(materialized.headers).toEqual({ Authorization: 'Bearer desktop-secret' });
    expect(materialized.data).toBe('{"token":"desktop-secret"}');
    expect(materialized.secretVariables).toBeUndefined();
  });
});
