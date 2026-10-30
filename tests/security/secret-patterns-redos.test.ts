import { detectUnredactedSecrets, redactBody } from '@shared/protocol/ai/redaction';
import { bodyTokenPatterns } from '@shared/protocol/secret-patterns';
import { describe, expect, it } from 'vitest';

// The secret check runs synchronously in Electron main on model-bound text, so
// no pattern may go super-linear on adversarial input.
const SIZE = 200_000;
const BUDGET_MS = 1_000;

const SHAPES: Record<string, string> = {
  'dotless eyJ run': 'eyJ'.repeat(SIZE / 3),
  'eyJ with long tail, no dots': `eyJ${'a'.repeat(SIZE)}`,
  'Bearer run': 'Bearer '.repeat(SIZE / 7),
  'key= run': 'token='.repeat(SIZE / 6),
  'sk- run': 'sk-'.repeat(SIZE / 3),
  'Authorization run': 'Authorization: '.repeat(SIZE / 15),
  'PEM header run': '-----BEGIN PRIVATE KEY-----'.repeat(SIZE / 27),
  'PEM header with no dashes tail': `-----BEGIN ${'A'.repeat(SIZE)}`,
  'X-Amz run': 'X-Amz-Signature='.repeat(SIZE / 16),
};

describe('secret patterns stay linear on adversarial input', () => {
  for (const [name, input] of Object.entries(SHAPES)) {
    it(`${name}`, () => {
      for (const re of bodyTokenPatterns()) {
        const start = performance.now();
        input.replace(re, '[REDACTED]');
        expect(performance.now() - start).toBeLessThan(BUDGET_MS);
      }
      const start = performance.now();
      detectUnredactedSecrets(input);
      redactBody(input, 'default');
      expect(performance.now() - start).toBeLessThan(BUDGET_MS * 2);
    });
  }

  it('still matches a JWT after a space, quote, equals sign or at the start', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    for (const prefix of ['', ' ', '"', "'", '=', ':', '\n', '(']) {
      expect(redactBody(`${prefix}${jwt}`, 'default')).not.toContain(
        'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV'
      );
    }
  });
});
