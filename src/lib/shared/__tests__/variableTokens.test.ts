import { describe, expect, it } from 'vitest';
import { buildKnownNames } from '../variableScopes';
import { tokenDisplayStatus } from '../variableTokens';

describe('tokenDisplayStatus', () => {
  const unknown = () => 'unresolved' as const;
  const known = () => 'resolved' as const;

  it('a known variable is known, whatever its name', () => {
    expect(tokenDisplayStatus('my key', known)).toBe('resolved');
    expect(tokenDisplayStatus('#if a', known)).toBe('resolved');
  });

  it('an unknown name is unresolved only in the plain grammar', () => {
    expect(tokenDisplayStatus('missing', unknown)).toBe('unresolved');
    expect(tokenDisplayStatus('$nope', unknown)).toBe('unresolved');
    for (const name of ['#if a', '/if', 'u | upper', '"k":1', 'my key']) {
      expect(tokenDisplayStatus(name, unknown)).toBe('plain');
    }
  });

  it('with no classifier, only plain-grammar names are variables', () => {
    expect(tokenDisplayStatus('baseUrl')).toBe('resolved');
    expect(tokenDisplayStatus('#if a')).toBe('plain');
  });
});

describe('buildKnownNames', () => {
  it('knows a row by the trimmed name its token uses', () => {
    const names = buildKnownNames({
      env: [{ id: '1', key: ' my key ', value: 'v', enabled: true }],
    });
    expect(names.has('my key')).toBe(true);
  });
});
