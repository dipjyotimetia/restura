import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { protocolSecretValueSchema } from '../protocol/secret-value-schema';
import {
  coerceToInlineSecret,
  describeSecret,
  inlineSecret,
  redactSecret,
  SECRET_HANDLE_PLACEHOLDER,
  unwrapSecret,
} from './secret-ref';

const runs = { numRuns: 80 };
const bounded = fc.string({ maxLength: 48, unit: 'grapheme' });
const nonEmpty = fc.string({ minLength: 1, maxLength: 48, unit: 'grapheme' });

const handle = fc.record({
  kind: fc.constant('handle' as const),
  id: fc.string({ minLength: 1, maxLength: 128, unit: 'grapheme' }),
  label: fc.option(fc.string({ maxLength: 256, unit: 'grapheme' }), { nil: undefined }),
});

const external = fc.record({
  kind: fc.constant('external' as const),
  provider: fc.constantFrom(
    'aws-secrets-manager' as const,
    'google-secret-manager' as const,
    'azure-key-vault' as const
  ),
  profileId: nonEmpty.map((value) => value.slice(0, 128)),
  secretId: nonEmpty.map((value) => value.slice(0, 200)),
  selector: fc.option(
    nonEmpty.map((value) => value.slice(0, 128)),
    { nil: undefined }
  ),
  label: fc.option(
    nonEmpty.map((value) => value.slice(0, 128)),
    { nil: undefined }
  ),
});

function jsonRoundTrip<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe('SecretRef encoding properties', () => {
  it('handle and external refs round-trip through the shared schema and JSON', () => {
    fc.assert(
      fc.property(fc.oneof(handle, external), (value) => {
        const parsed = protocolSecretValueSchema.parse(value);
        const again = protocolSecretValueSchema.parse(jsonRoundTrip(parsed));
        expect(again).toEqual(parsed);
        if (parsed && typeof parsed === 'object' && 'kind' in parsed && parsed.kind === 'handle') {
          expect(unwrapSecret(parsed)).toBe(SECRET_HANDLE_PLACEHOLDER);
          // The placeholder is a fixed mask. An id that happens to be that
          // mask collides with it; every other id must not come back from unwrap.
          if (parsed.id !== SECRET_HANDLE_PLACEHOLDER) {
            expect(unwrapSecret(parsed)).not.toBe(parsed.id);
          }
        }
      }),
      runs
    );
  });

  it('redaction drops inline plaintext and leaves a handle opaque', () => {
    const secret = fc.stringMatching(/^[A-Za-z0-9]{8,32}$/);
    fc.assert(
      fc.property(secret, handle, (plain, ref) => {
        const inline = inlineSecret(plain);
        expect(unwrapSecret(redactSecret(inline))).toBe('');
        expect(describeSecret(inline)).not.toContain(plain);
        expect(redactSecret(ref)).toEqual(ref);
        expect(describeSecret(ref)).not.toContain(plain);
      }),
      runs
    );
  });

  it('coerceToInlineSecret is idempotent on JSON values', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const once = coerceToInlineSecret(value);
        expect(coerceToInlineSecret(once)).toEqual(once);
      }),
      runs
    );
  });

  it('does not use the placeholder as a stand-in that still carries the inline secret', () => {
    fc.assert(
      fc.property(bounded, (plain) => {
        const redacted = redactSecret(plain);
        expect(redacted).toBe('');
        expect(unwrapSecret(redacted)).toBe('');
      }),
      runs
    );
  });
});
