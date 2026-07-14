import { describe, expect, it } from 'vitest';
import { VaultGetSchema, VaultSetSchema, VaultUnsetSchema } from '../storage/vault-handler';

/**
 * Phase D — `pm.vault` key/value validation.
 *
 * The IPC handlers validate input with Zod before touching the
 * encrypted store. These tests pin down the boundaries: control chars
 * rejected, oversize rejected, normal Postman idioms accepted. A
 * regression here lets an attacker (or a buggy user script) write keys
 * that confuse downstream code (log injection, accidental UUID
 * collisions with the handle store, etc.).
 */

describe('VaultGetSchema / VaultUnsetSchema', () => {
  it('accepts a plain key', () => {
    expect(VaultGetSchema.safeParse({ key: 'TOKEN' }).success).toBe(true);
    expect(VaultGetSchema.safeParse({ key: 'STRIPE_SECRET_KEY' }).success).toBe(true);
    expect(VaultGetSchema.safeParse({ key: 'my-team.api.token' }).success).toBe(true);
  });

  it('rejects an empty key', () => {
    expect(VaultGetSchema.safeParse({ key: '' }).success).toBe(false);
  });

  it('rejects keys with control characters (NUL, newline, tab)', () => {
    // Each of these is a smuggling vector: a newline in a key could
    // confuse log readers or downstream tools that split on \n; NUL
    // breaks C-string boundaries; tab is harmless in isolation but the
    // regex deny-list catches the whole control range as a class.
    expect(VaultGetSchema.safeParse({ key: 'bad\0key' }).success).toBe(false);
    expect(VaultGetSchema.safeParse({ key: 'bad\nkey' }).success).toBe(false);
    expect(VaultGetSchema.safeParse({ key: 'bad\tkey' }).success).toBe(false);
    expect(VaultGetSchema.safeParse({ key: 'bad\rkey' }).success).toBe(false);
  });

  it('rejects an oversized key', () => {
    expect(VaultGetSchema.safeParse({ key: 'x'.repeat(257) }).success).toBe(false);
  });

  it('VaultUnsetSchema has the same rules as VaultGetSchema', () => {
    expect(VaultUnsetSchema.safeParse({ key: '' }).success).toBe(false);
    expect(VaultUnsetSchema.safeParse({ key: 'ok' }).success).toBe(true);
  });
});

describe('VaultSetSchema', () => {
  it('accepts a typical secret', () => {
    expect(VaultSetSchema.safeParse({ key: 'TOKEN', value: 'abc123' }).success).toBe(true);
  });

  it('accepts an empty value (Postman allows storing an empty string)', () => {
    expect(VaultSetSchema.safeParse({ key: 'TOKEN', value: '' }).success).toBe(true);
  });

  it('rejects a value larger than 64KB', () => {
    expect(
      VaultSetSchema.safeParse({ key: 'TOKEN', value: 'x'.repeat(64 * 1024 + 1) }).success
    ).toBe(false);
  });

  it('inherits the key restrictions', () => {
    expect(VaultSetSchema.safeParse({ key: 'bad\nkey', value: 'v' }).success).toBe(false);
    expect(VaultSetSchema.safeParse({ key: '', value: 'v' }).success).toBe(false);
  });
});
