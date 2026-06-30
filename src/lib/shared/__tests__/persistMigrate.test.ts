import { describe, expect, it } from 'vitest';
import { passthroughMigrate } from '../persistMigrate';

describe('passthroughMigrate', () => {
  it('returns the persisted state unchanged (same reference)', () => {
    const state = { connections: { a: 1 }, activeConnectionId: 'a' };
    expect(passthroughMigrate(state)).toBe(state);
  });

  it('passes null/undefined through (first-run / empty persistence)', () => {
    expect(passthroughMigrate(null)).toBeNull();
    expect(passthroughMigrate(undefined)).toBeUndefined();
  });
});
