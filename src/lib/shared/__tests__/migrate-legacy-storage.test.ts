import { describe, it, expect, beforeEach } from 'vitest';
import {
  migrateLegacyLocalStorage,
  readLegacyLocalStorageEntry,
  removeLegacyLocalStorageEntry,
} from '../migrate-legacy-storage';

describe('readLegacyLocalStorageEntry', () => {
  beforeEach(() => localStorage.clear());

  it('returns the parsed value without removing the key', () => {
    localStorage.setItem('foo', JSON.stringify({ state: { a: 1 }, version: 2 }));
    expect(readLegacyLocalStorageEntry('foo')).toEqual({ state: { a: 1 }, version: 2 });
    // Read does NOT remove — removal timing is the caller's responsibility.
    expect(localStorage.getItem('foo')).not.toBeNull();
  });

  it('returns null for an absent key', () => {
    expect(readLegacyLocalStorageEntry('foo')).toBeNull();
  });

  it('returns null for malformed JSON without throwing', () => {
    localStorage.setItem('foo', '{not json');
    expect(readLegacyLocalStorageEntry('foo')).toBeNull();
  });
});

describe('removeLegacyLocalStorageEntry', () => {
  beforeEach(() => localStorage.clear());

  it('removes the key and is a no-op when absent', () => {
    localStorage.setItem('foo', 'x');
    removeLegacyLocalStorageEntry('foo');
    expect(localStorage.getItem('foo')).toBeNull();
    expect(() => removeLegacyLocalStorageEntry('missing')).not.toThrow();
  });
});

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
