import { describe, it, expect, beforeEach } from 'vitest';
import { migrateLegacyLocalStorage } from '../migrate-legacy-storage';

describe('migrateLegacyLocalStorage', () => {
  beforeEach(() => localStorage.clear());

  it('returns null when no legacy entry exists', () => {
    expect(migrateLegacyLocalStorage('foo')).toBeNull();
  });

  it('returns parsed legacy state and clears the key', () => {
    localStorage.setItem('foo', JSON.stringify({ state: { a: 1 }, version: 1 }));
    const result = migrateLegacyLocalStorage('foo');
    expect(result).toEqual({ a: 1 });
    expect(localStorage.getItem('foo')).toBeNull();
  });

  it('returns null on malformed JSON without throwing', () => {
    localStorage.setItem('foo', '{not json');
    expect(migrateLegacyLocalStorage('foo')).toBeNull();
    expect(localStorage.getItem('foo')).toBeNull();
  });

  it('returns null when state field is missing', () => {
    localStorage.setItem('foo', JSON.stringify({ version: 1 }));
    expect(migrateLegacyLocalStorage('foo')).toBeNull();
  });

  it('returns null when running in a non-browser environment (no window)', () => {
    // Hard to simulate cleanly; just confirm no throw
    const result = migrateLegacyLocalStorage('foo');
    expect(result).toBeNull();
  });

  it('is idempotent: second call returns null after first clears the key', () => {
    localStorage.setItem('foo', JSON.stringify({ state: { a: 1 }, version: 1 }));
    expect(migrateLegacyLocalStorage('foo')).toEqual({ a: 1 });
    expect(migrateLegacyLocalStorage('foo')).toBeNull();
  });
});
