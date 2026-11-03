import { describe, expect, it } from 'vitest';
import { scopedVariableSchema } from './app';
import { keyValueSchema } from './key-value';

describe('key-value schemas keep the secret flag (P2)', () => {
  const row = { id: '1', key: 'token', value: '', enabled: true, secret: true };

  it('keyValueSchema keeps `secret`', () => {
    expect(keyValueSchema.parse(row).secret).toBe(true);
  });

  it('scopedVariableSchema keeps `secret` alongside `private`', () => {
    const parsed = scopedVariableSchema.parse({ ...row, private: true });
    expect(parsed.secret).toBe(true);
    expect(parsed.private).toBe(true);
  });

  it('rejects a non-boolean `secret`', () => {
    expect(keyValueSchema.safeParse({ ...row, secret: 'yes' }).success).toBe(false);
  });
  it('accepts an explicit `secret: undefined` instead of rejecting the row', () => {
    expect(keyValueSchema.safeParse({ ...row, secret: undefined }).success).toBe(true);
  });
});
