import { describe, expect, it } from 'vitest';
import {
  basicAuthReferencesSecretVariable,
  referencesSecretVariable,
  replaceSecretVariableTokenMatches,
} from './secret-variable-token';

const isSecret = (name: string) => name === 'pw';

describe('secret-variable token grammar', () => {
  it('matches exact and whitespace-padded tokens', () => {
    expect(referencesSecretVariable('{{pw}}', isSecret)).toBe(true);
    expect(referencesSecretVariable('a {{ pw }} b', isSecret)).toBe(true);
    expect(referencesSecretVariable('{{other}} {{ pwx }}', isSecret)).toBe(false);
  });

  it('replaces only secret tokens and hands back the original token text', () => {
    expect(
      replaceSecretVariableTokenMatches(
        '{{ pw }}:{{pw}}:{{user}}',
        isSecret,
        (name, token) => `<${name}|${token}>`
      )
    ).toBe('<pw|{{ pw }}>:<pw|{{pw}}>:{{user}}');
  });

  it('detects Basic credentials referencing a secret and tolerates missing fields', () => {
    expect(
      basicAuthReferencesSecretVariable({ username: 'u', password: '{{ pw }}' }, isSecret)
    ).toBe(true);
    expect(
      basicAuthReferencesSecretVariable(
        { username: 'u', password: { kind: 'inline', value: '{{pw}}' } },
        isSecret
      )
    ).toBe(true);
    expect(
      basicAuthReferencesSecretVariable({ password: { kind: 'handle', id: 'h' } }, isSecret)
    ).toBe(false);
    expect(basicAuthReferencesSecretVariable({}, isSecret)).toBe(false);
    expect(basicAuthReferencesSecretVariable(undefined, isSecret)).toBe(false);
  });

  it('is safe to call repeatedly (no shared lastIndex state)', () => {
    for (let i = 0; i < 3; i++) expect(referencesSecretVariable('{{pw}}', isSecret)).toBe(true);
  });
});
