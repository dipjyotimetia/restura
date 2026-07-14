/**
 * Structural parity between `SecretValue` (renderer) and `ProtocolSecretValue`
 * (shared/protocol/types.ts).
 *
 * The two declarations are duplicated by design — `shared/protocol/` must not
 * import from `src/` so it stays independent of the renderer source tree
 * (see CLAUDE.md). The Zod schema in `shared/protocol/secret-value-schema.ts`
 * is the single source of truth at runtime; these tests assert that every
 * shape the renderer can produce parses against the shared schema, and vice
 * versa. If a future change drifts the two declarations, these tests fail
 * and the maintainer must update both together.
 */

import {
  isProtocolSecretHandle,
  protocolSecretValueSchema,
} from '@shared/protocol/secret-value-schema';
import type { ProtocolSecretValue } from '@shared/protocol/types';
import { describe, expect, it } from 'vitest';
import {
  handleSecret,
  inlineSecret,
  type SecretValue,
  secretValueSchema,
} from '@/lib/shared/secretRef';

describe('SecretValue / ProtocolSecretValue structural parity', () => {
  it('every renderer-shaped SecretValue parses against the protocol schema', () => {
    const samples: SecretValue[] = [
      'plain-string',
      '',
      inlineSecret('hello'),
      inlineSecret(''),
      handleSecret('uuid-1'),
      handleSecret('uuid-2', 'AWS prod'),
    ];
    for (const s of samples) {
      const result = protocolSecretValueSchema.safeParse(s);
      expect(result.success).toBe(true);
    }
  });

  it('every protocol-shaped value parses against the renderer schema', () => {
    const samples: ProtocolSecretValue[] = [
      'plain-string',
      { kind: 'inline', value: 'hello' },
      { kind: 'handle', id: 'uuid-1' },
      { kind: 'handle', id: 'uuid-2', label: 'AWS prod' },
    ];
    for (const s of samples) {
      const result = secretValueSchema.safeParse(s);
      expect(result.success).toBe(true);
    }
  });

  it('handle predicate agrees on the canonical shape', () => {
    const handle = handleSecret('uuid-1', 'AWS prod');
    expect(isProtocolSecretHandle(handle)).toBe(true);
    expect(isProtocolSecretHandle(inlineSecret('hi'))).toBe(false);
    expect(isProtocolSecretHandle('plain')).toBe(false);
  });

  it('rejects the same malformed shapes on both schemas', () => {
    const bad: unknown[] = [
      42,
      null,
      undefined,
      [],
      { kind: 'inline' }, // missing value
      { kind: 'handle' }, // missing id
      { kind: 'unknown', foo: 'bar' },
    ];
    for (const v of bad) {
      expect(secretValueSchema.safeParse(v).success).toBe(false);
      expect(protocolSecretValueSchema.safeParse(v).success).toBe(false);
    }
  });
});
