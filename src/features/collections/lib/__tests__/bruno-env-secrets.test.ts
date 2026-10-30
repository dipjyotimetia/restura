import { describe, expect, it, vi } from 'vitest';

// Bruno's .bru grammar gives `vars:secret` rows no value today, but the
// parser's JSON shape (`variables[].value` + `secret`) can carry one. Pin
// that the policy strips it whatever the parser emits (#1231).
vi.mock('../bruno-lang', () => ({
  loadBrunoLang: async () => ({
    bruToJsonV2: () => ({}),
    bruToEnvJsonV2: () => ({
      variables: [
        { name: 'HOST', value: 'https://dev.example.com', enabled: true, secret: false },
        { name: 'SECRET_TOKEN', value: 'tok-abc-123', enabled: true, secret: true },
      ],
    }),
  }),
}));

import { importBrunoCollection } from '../importers';

const source = {
  kind: 'directory' as const,
  entries: [{ relativePath: 'environments/dev.bru', content: '<mocked>' }],
};

describe('importBrunoCollection environment secret values (#1231)', () => {
  it('drops a parsed secret value by default', async () => {
    const result = await importBrunoCollection(source);
    expect(result.environments![0]!.variables.map((v) => [v.key, v.value, v.secret])).toEqual([
      ['HOST', 'https://dev.example.com', undefined],
      ['SECRET_TOKEN', '', true],
    ]);
    expect(JSON.stringify(result)).not.toContain('tok-abc-123');
  });

  it('keeps it with keepSecretValues: true', async () => {
    const result = await importBrunoCollection(source, { keepSecretValues: true });
    expect(result.environments![0]!.variables[1]).toMatchObject({
      key: 'SECRET_TOKEN',
      value: 'tok-abc-123',
      secret: true,
    });
  });
});
