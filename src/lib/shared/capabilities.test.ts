import { describe, expect, it } from 'vitest';
import { CAPABILITIES } from './capabilities';

describe('storage capability claims', () => {
  it('does not advertise encrypted-at-rest web storage while web uses plaintext IndexedDB', () => {
    expect(CAPABILITIES['storage.encryptedLocal'].web).toBe(false);
    expect(CAPABILITIES['storage.encryptedLocal'].notes).toContain('plaintext IndexedDB');
    expect(CAPABILITIES['storage.osKeychain'].notes).not.toContain('encrypted IndexedDB');
  });
});
