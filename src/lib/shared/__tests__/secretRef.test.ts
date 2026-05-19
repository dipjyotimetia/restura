import { describe, it, expect } from 'vitest';
import {
  SECRET_HANDLE_PLACEHOLDER,
  assertSecretValue,
  describeSecret,
  handleSecret,
  inlineSecret,
  isInlineSecretRef,
  isSecretHandle,
  redactSecret,
  unwrapSecret,
} from '../secretRef';

describe('secretRef — predicates', () => {
  it('isSecretHandle distinguishes handles from inline / strings', () => {
    expect(isSecretHandle({ kind: 'handle', id: '00000000-0000-4000-8000-000000000000' })).toBe(true);
    expect(isSecretHandle({ kind: 'inline', value: 'x' })).toBe(false);
    expect(isSecretHandle('plain')).toBe(false);
  });

  it('isInlineSecretRef distinguishes wrapped inline from plain strings', () => {
    expect(isInlineSecretRef({ kind: 'inline', value: 'x' })).toBe(true);
    expect(isInlineSecretRef({ kind: 'handle', id: 'abc' })).toBe(false);
    expect(isInlineSecretRef('plain')).toBe(false);
  });
});

describe('secretRef — unwrapSecret (renderer-safe)', () => {
  it('returns plain strings verbatim', () => {
    expect(unwrapSecret('abc')).toBe('abc');
    expect(unwrapSecret('')).toBe('');
  });

  it('returns inline values verbatim', () => {
    expect(unwrapSecret(inlineSecret('xyz'))).toBe('xyz');
  });

  it('returns the masked placeholder for handles — never plaintext', () => {
    expect(unwrapSecret(handleSecret('id-1', 'AWS prod'))).toBe(SECRET_HANDLE_PLACEHOLDER);
    expect(unwrapSecret(handleSecret('id-2'))).toBe(SECRET_HANDLE_PLACEHOLDER);
  });

  it('handles undefined input', () => {
    expect(unwrapSecret(undefined)).toBe('');
  });
});

describe('secretRef — describeSecret', () => {
  it('summarises strings without revealing them', () => {
    expect(describeSecret('hello')).toBe(SECRET_HANDLE_PLACEHOLDER);
    expect(describeSecret('')).toBe('(empty)');
  });

  it('summarises handles with the label when present', () => {
    expect(describeSecret(handleSecret('00000000-0000-4000-8000-000000000000', 'AWS prod'))).toBe('Handle: AWS prod');
  });

  it('summarises handles with id prefix when no label', () => {
    const s = describeSecret(handleSecret('abc12345-1111-1111-1111-111111111111'));
    expect(s).toMatch(/^Handle: abc12345/);
  });

  it('handles undefined', () => {
    expect(describeSecret(undefined)).toBe('(empty)');
  });
});

describe('secretRef — redactSecret (for export / logging)', () => {
  it('reduces plain strings to empty', () => {
    expect(redactSecret('plaintext')).toBe('');
  });

  it('reduces inline refs to empty inline (shape-preserving)', () => {
    expect(redactSecret({ kind: 'inline', value: 'plaintext' })).toEqual({ kind: 'inline', value: '' });
  });

  it('passes handles through unchanged (they are already opaque)', () => {
    const handle = handleSecret('id-1', 'AWS prod');
    expect(redactSecret(handle)).toBe(handle);
  });

  it('handles undefined', () => {
    expect(redactSecret(undefined)).toBe('');
  });
});

describe('secretRef — assertSecretValue', () => {
  it('accepts strings', () => {
    expect(() => assertSecretValue('hi', 'pw')).not.toThrow();
  });

  it('accepts inline refs', () => {
    expect(() => assertSecretValue({ kind: 'inline', value: 'x' }, 'pw')).not.toThrow();
  });

  it('accepts handle refs', () => {
    expect(() => assertSecretValue({ kind: 'handle', id: 'id-1' }, 'pw')).not.toThrow();
  });

  it('rejects numbers, nulls, arrays, malformed objects', () => {
    expect(() => assertSecretValue(42, 'pw')).toThrow(/expected string or SecretRef/);
    expect(() => assertSecretValue(null, 'pw')).toThrow();
    expect(() => assertSecretValue([], 'pw')).toThrow();
    expect(() => assertSecretValue({ kind: 'inline' }, 'pw')).toThrow();
    expect(() => assertSecretValue({ kind: 'handle' }, 'pw')).toThrow();
    expect(() => assertSecretValue({ kind: 'rogue', id: 'x' }, 'pw')).toThrow();
  });
});

describe('secretRef — constructors', () => {
  it('inlineSecret wraps a string', () => {
    expect(inlineSecret('hi')).toEqual({ kind: 'inline', value: 'hi' });
  });

  it('handleSecret with label', () => {
    expect(handleSecret('id-1', 'AWS')).toEqual({ kind: 'handle', id: 'id-1', label: 'AWS' });
  });

  it('handleSecret without label omits the field (no `undefined`)', () => {
    expect(handleSecret('id-1')).toEqual({ kind: 'handle', id: 'id-1' });
  });
});
